# Track Mode Protocol

**Status: experimental fallback path.** Flat top-level queue orchestration is
the default Shipyard execution model. Use this protocol only when the user
explicitly requests `--mode track` or a sprint declares `execution_mode: track`,
and only after accepting the nested-Agent platform risk documented here. If
any Agent ownership/completion behavior is ambiguous, main falls back to flat
queued workers; do not continue with nested dispatch.

Track Mode dispatches a **wave-scoped track coordinator** per feature track. Each coordinator sequentially dispatches **nested per-task builders** — one `Agent(isolation: "worktree")` call per task, using `shipyard-disciplined-builder` **unchanged**: one worktree, one branch, one commit, one `task-return`. This supersedes the old Agent-Teams-based "Team Mode" (shared task list + mailbox); `team` is the alias that still selects this shape (see the vocabulary table in `ship-execute/SKILL.md` Step 2).

```
main shell (Sonnet) ── partitions wave into tracks
                    ── SERIAL integration, SOLE authority
                    ── owns the Task* checklist (mirror only)
  ├─ track coordinator A (isolated, NEVER commits)  ── wave-scoped, dispatches sequentially
  │     ├─ Agent(isolation:"worktree") task 1  → wt-1, ONE commit, task-return
  │     ├─ Agent(isolation:"worktree") task 2  → wt-2, ONE commit, task-return
  │     └─ SendMessage → main  (blockers, interface changes only)
  ├─ track coordinator B  (parallel)
  └─ track coordinator C
  ← boundary: rebase each shipyard/wt-* → verify-wave-integrated → teardown
```

**Track coordinators get worktree isolation.** Main passes `isolation: "worktree"` on every coordinator `Agent(...)` call — there is no reason to withhold it (unlike the old Team Mode, coordinators are a genuine Shipyard dispatch, not an Agent-Teams teammate, so nothing about `#37549` applies to them). A coordinator's own worktree/branch never advances (it never commits — see "The coordinator never commits, never writes" below), so it needs no merge step of its own; it still needs cleanup at the wave boundary (see "Wave Boundary Protocol").

## Concurrency Cap

Concurrency is **two-level**, not a flat agent count: each track runs one coordinator plus, at most, one active builder at a time (dispatch within a track is sequential — see below). So live agents ≈ **2 × tracks**. The ceiling is **`execution.max_agents`** (default 100 agents alive at once, coordinators and builders counted together, enforced by the agent hook), so at most `max_agents / 2` tracks run at the same time.

If a sprint has more feature tracks than that:
1. Sort feature tracks by wave priority (earlier-wave tasks first).
2. Spawn coordinators in that order until the agent hook refuses one (`execution.max_agents` reached).
3. As each coordinator finishes its track's wave tasks, spawn the next queued track's coordinator in its place.
4. Fewer tracks than the cap → spawn them all, no queuing needed.

## Feature Track Mapping

Before spawning coordinators, group this wave's tasks by parent feature:

1. Read wave task IDs from SPRINT.md.
2. For each task, read the step file's `feature:` field.
3. Group into feature tracks: `{S001: [P001, P002, P003], S005: [P004, P005]}`.
4. One coordinator per feature track, **for this wave only** — see "Wave-scoped, not sprint-persistent" below.
5. Cross-feature dependencies are handled by wave ordering — tasks with cross-feature deps land in later waves, same as subagent mode.

A feature with only 1 task in this wave still gets its own coordinator (simpler than special-casing) — or, if the wave has exactly one track with one task, plain solo/subagent dispatch is cheaper; that choice is Step 2's dispatch-shape decision, not this file's concern.

## The Track Coordinator Contract

The registered agent `agents/shipyard-track-coordinator.md` and its wrapper `skills/dispatching-track-coordinator/SKILL.md` own the dispatch mechanics (the `Agent(...)` call shape, model-tier resolution, the coordinator's structured-return parse, and the `silent_return` outcome) — this section documents the protocol they implement, not a duplicate spec. Read those before changing coordinator behavior.

**A coordinator never commits, and never writes at all — and it is wave-scoped, not sprint-persistent.**

- The `WorktreeCreate` hook pins a coordinator's branch to spawn-time HEAD. Within one wave, every nested builder it spawns forks from that same base (a nested child forks from its **spawning agent's HEAD**, not from a sibling task's branch) — so the superset-branch hazard a flat track agent would create never arises.
- This holds **only within one wave**. At the wave boundary the working branch advances (rebase + ff-merge, `ship-execute` Step 4) while a coordinator's own HEAD never does. A coordinator surviving into wave N+1 would fork its builders from the **stale wave-N base**, silently dropping everything wave N merged — forking from a stale base drops earlier waves' commits. **Therefore: spawn coordinators fresh at `wave_<N>_dispatch` and let them finish at the wave boundary; wave N+1 always gets fresh coordinators off the updated working branch.** Do not re-spawn a coordinator across a wave boundary and do not carry a coordinator's identity or context forward into the next wave — there is no "continuing teammate" concept here.
- **Never writes**, not merely never commits: because a nested builder forks from a sha, any uncommitted file sitting in a coordinator's own worktree propagates nowhere and is destroyed at teardown. The coordinator's `tools:` allowlist (`Read, ToolSearch, Agent, SendMessage` — no `Bash`, no `Write`, no `Edit`) makes this structural rather than a rule to remember: with no write tool, there is no uncommitted work to lose.

**The allowlist also keeps a coordinator from certifying anything:** with no `Bash` it cannot run `shipyard-data task-return`, so every return is written from inside that task's own nested builder. `TaskStop` is not in the allowlist either; it is ownership-scoped and would be inert (see Liveness).

**TRACK NOTES.** Every nested builder is a fresh context, so the coordinator keeps a short running block across its track's tasks this wave (interfaces introduced or renamed, decisions, gotchas, files touched), sourced from each builder's return text and probe tail, and prepends it to every later builder's brief in the track.

### What "sequential" gives you — and does not

**Dispatch within a track is sequential**, one nested builder at a time: it bounds the nested budget at `2 × tracks` and lets a coordinator brief task 2 with the interface decisions task 1 made. It gives no git-level visibility: every nested builder forks from the same wave-start base, and task 1's commit stays on its own `shipyard/wt-*` branch until the wave-boundary rebase and ff-merge (`ship-execute` Step 4 / `references/git-strategy.md`). Tasks in a track must therefore stay independently buildable against their own probe. If task 2 genuinely needs task 1's code, that is a wave-decomposition problem: surface it to main via the Blocker Protocol.

## Coordinator Brief (what main passes to `dispatching-track-coordinator`)

| Parameter | Value |
|---|---|
| `track_id` | the feature ID, e.g. `S007` |
| `tasks` | this wave's tasks belonging to the track, in dependency order — one entry each: `{task_id, task_file_path, acceptance_probe, …}`. **`task_file_path` is resolved by the caller, never by the coordinator** — step files are slug-suffixed (`<TASK_ID>-<slug>.md`) and the coordinator's allowlist has no `Glob`/`Bash` to discover that filename from a bare ID. This is the same resolution the caller already performs before dispatching `dispatching-task-loop` for a solo/task-mode task. See `dispatching-track-coordinator`'s Inputs for the full per-entry shape. |
| `sibling_track_names` | the deterministic names of this wave's other track coordinators (for the Interface Change Protocol) |
| `working_branch` | `branch:` from SPRINT.md frontmatter |
| `base_ref` | the working-branch HEAD at wave-dispatch time — passed through unchanged to every nested builder this coordinator spawns |
| `data_dir` | literal `<SHIPYARD_DATA>` path |
| `sprint_id` | `id:` from SPRINT.md frontmatter |
| `wave_number` | current wave number from the cursor |

**Model resolution.** Main runs `shipyard-data resolve-model coordinator` (coordinator dispatch) and `shipyard-data resolve-model build` / `build_trivial` (builder values passed in the brief), each printing `model=<m> effort=<e>`. `coordinator_model` (the `model=` from `resolve-model coordinator`) is used only for the coordinator's own dispatch; the build model is a separate value relayed as a string, verbatim — the coordinator never resolves or edits it; an empty value means omit the field.

Dispatch, one call per track, wave-scoped only:

```
Agent(subagent_type: "shipyard:shipyard-track-coordinator",
      name: "track-{{track_id}}",
      isolation: "worktree",
      run_in_background: true,
      model: <coordinator_model: model= from `resolve-model coordinator`, or omit>,
      effort: <effort= from `resolve-model coordinator`, or omit>,
      prompt: <coordinator brief above>)
```

Deterministic naming (`track-<FEATURE_ID>`) is load-bearing, not cosmetic — it is what lets main address, and later stop, a coordinator or its grandchildren by name (see Liveness below).

## Nested Builder Dispatch (inside the coordinator)

For each task in its `tasks` list, in order, the coordinator dispatches exactly what `dispatching-task-loop`'s "Dispatching the Builder" section specifies — same subagent, same inputs, same structured-return contract:

```
Agent(subagent_type: "shipyard:shipyard-disciplined-builder",
      name: "builder-{{task_id}}",
      isolation: "worktree",
      run_in_background: false,
      model: <model= from `resolve-model build`, relayed as a string, or omit>,
      effort: <effort= from `resolve-model build_trivial` for effort:S, else `resolve-model build`; omit if empty>,
      prompt: <task brief — task_id, working_branch, base_ref, data_dir,
               task_file_path, feature_file_path, acceptance_probe,
               sprint_id, wave_number, plus the running TRACK NOTES block>)
```

`run_in_background: false` is deliberate here (unlike main's own wave-dispatch calls, which use `true`) — the coordinator needs the builder's return synchronously so it can fold the result into TRACK NOTES before deciding the next task. This does not change how main learns of task completion: the nested builder still runs `shipyard-data task-return` and emits `subagent_completed` (Cycle steps 8–9, unchanged) as part of its own work, before it returns text to the coordinator, so main's Monitor on the shared event log sees each task land in near-real time regardless of whether the coordinator's own call is foreground or background. See "Main's Monitoring Loop" below — this is `dispatching-task-loop`'s "Key invariants preserved across both modes" applied one layer down.

The coordinator's constrained toolset (`Read, ToolSearch, Agent, SendMessage`, no `Bash`) is sufficient for this: every `shipyard-data` CLI call happens inside the nested builder's own fresh context (which keeps full `Read, Write, Edit, Bash, Grep, Glob, LSP`), never in the coordinator's.

Deterministic naming (`builder-<TASK_ID>`) applies here too, for the same reason.

## Within-Track Autonomy

- A nested builder MUST NOT spawn its own subagents. Shipyard allows at most
  one nesting layer in this experimental mode: main → coordinator → builder.
  The default production path is still zero nesting: main → worker.
- **Never cross tracks.** A coordinator must not dispatch, edit, or claim another track's task — track boundaries are main's concurrency control, not a suggestion.
- Dependency ordering and the wave boundary are always authoritative over a coordinator's own sequencing: a coordinator does not dispatch a same-track task ahead of a dependency it hasn't seen complete, and a coordinator does not attempt to run past the wave it was spawned for (see "wave-scoped, not sprint-persistent" above — there is no next-wave hand-off to wait for; the coordinator simply finishes).

## Interface Change Protocol

When a completed builder's return (or probe output tail) reveals a shared type, API endpoint, schema, or public interface changed, the coordinator broadcasts it to every sibling track coordinator this wave — by name, one `SendMessage` per sibling (there is no broadcast recipient in the real API; `sibling_track_names` from the brief is what makes this possible):

```
SendMessage(to: "track-S005",
            message: "INTERFACE CHANGE: <file>:<symbol> — <what changed>",
            summary: "Interface change in <file>")
```

Repeat once per name in `sibling_track_names`. This lets other tracks' NEXT nested-builder brief account for the change before it becomes a wave-boundary merge conflict. `SendMessage` is async (queued for delivery at the recipient's next tool round) — never gate on a reply; this is advisory, not a rendezvous.

## Blocker Protocol

If a coordinator cannot proceed on a task (after the builder itself already tried and returned `STATUS: BLOCKED`; the coordinator does not invent blockers on its own):

```
SendMessage(to: "main",
            message: "BLOCKED: <TASK_ID> — <reason>",
            summary: "Task <TASK_ID> blocked")
```

Then move to the next unblocked task in the track (don't wait). If no unblocked tasks remain in the track:

```
SendMessage(to: "main",
            message: "IDLE: all remaining tasks in <track_id> are blocked",
            summary: "Track <track_id> idle")
```

`to: "main"` is valid here because coordinators are always spawned with `run_in_background: true` (`SendMessage`'s `to: "main"` recipient is documented as background-subagents-only).

## Main's Monitoring Loop

Main keeps two structures: a per-track handle/timeout list (`{track_id, coordinator_name, spawned_at, max_execution_minutes}`, where the budget is the sum of the track's task budgets, default 60 min each) for track-level liveness, and the per-task `pending_subagents` list reconciled against `subagent_completed` events as in `ship-execute/references/pipeline-wave.md`'s wave-waiting handler, which `wave_N_recovery` reads.

**Per-task wake is the persistent `Monitor` on `<SHIPYARD_DATA>/.shipyard-events.jsonl`** filtered for `subagent_completed`, as in subagent mode, not the coordinator's once-per-track completion notification: nested builders emit that event per task regardless of which coordinator dispatched them.

**The verification spine is unchanged.** Every task — solo, bare subagent, or nested under a track coordinator — exits through `task-return` → main's orchestrator-side gate (sha `cat-file` + `probe_exit_code === 0` + non-empty tail + anti-stub-scan) → `anchor-commit` → `task_dispatch_returned`. A coordinator cannot self-certify (see "The Track Coordinator Contract" above) and a nested builder cannot self-certify (it has no `TaskUpdate` in its isolated context — the only way it can claim completion is through the CLI, which refuses a false COMPLETE). **A track cannot self-certify either way.**

## Liveness

No heartbeat file exists (the hook was retired in 2.0). Live signals are `task_loop_iteration` and `subagent_completed` events; presume a task dead only when elapsed time exceeds its budget AND there is neither a `subagent_completed` nor a recent `task_loop_iteration` event.

`TaskStop` is ownership-scoped, so a coordinator cannot stop its children; main does it by name (`builder-<TASK_ID>`, `track-<FEATURE_ID>`), before any salvage, on a genuine timeout. Stopping a grandchild main never spawned is best-effort: when in doubt, wait for natural termination (the builder's 5-iteration cap) instead of force-stop-and-redispatch.

## Track / Coordinator Failure Recovery

On a track timeout (no progress beyond the track's summed budget and no recent per-task evidence):

1. Gate every return in `<SHIPYARD_DATA>/sprints/current/.subagent-returns/` for the track's tasks exactly as `wave_N_recovery` does (sha `cat-file` + `probe_exit_code === 0` + non-empty tail + anti-stub-scan, then `anchor-commit` + `task_dispatch_returned`).
2. Redispatch only tasks with no valid return, via a replacement coordinator or directly as in subagent mode; never resume the dead coordinator.
3. If the presumed-dead coordinator's builder is still live, redispatch yields two builders and a `shipyard/wt-*` name collision (Claude Code #51596). Try `TaskStop("builder-<TASK_ID>")` first, and when ambiguous prefer waiting and anchoring over force-removing a possibly-live worktree.

## Wave Boundary Protocol

1. **Nested builder integration is unchanged from subagent mode.** Every task's `shipyard/wt-*` branch — regardless of which track's coordinator dispatched it — integrates through the same `ship-execute` Step 4 sequence: rebase + ff-merge each GATE-PASSED task's branch onto the working branch, one at a time in task-ID order, THEN `shipyard-data verify-wave-integrated`, THEN teardown. See `references/git-strategy.md`. Track mode adds no separate integration step for task branches.
2. **Confirm every track coordinator for this wave has actually finished** before running the integration gate — check each coordinator's background-completion status (or its handle in the per-track list). A coordinator that has cleared its full dead-track timeout is a dead-track case (above); resolve that first. A coordinator that has dispatched every task in its `tasks` list but hasn't yet returned (still short of the dead-track timeout) gets one best-effort nudge before falling back to a wait:
   ```
   SendMessage(to: "track-{{track_id}}",
               message: {type: "shutdown_request", reason: "wave boundary — no remaining tasks"})
   ```
   This is advisory (the coordinator may already be gone, in which case the message simply goes undelivered) — it is not a required handshake, and main does not block the wave boundary waiting for a response. If the coordinator is still genuinely unresponsive once the dead-track timeout is reached, main `TaskStop`s it directly by name (`track-{{track_id}}`) — this is a direct spawn, so ownership is never in question here, unlike the grandchild-builder case above.
3. **Clean up each coordinator's own worktree.** A coordinator's branch never advances (it never commits), so it is trivially merged (`git branch -d` succeeds — there is nothing to lose). Remove it like any other stale worktree; `shipyard-data clean-worktrees` sweeps these along with everything else. Do this only after step 2 confirms the coordinator itself is no longer running — `git worktree remove` on a still-live coordinator's path races it.
4. **Spawn queued track coordinators**, if any tracks were queued behind the concurrency cap, into the freed slots.
5. **Next wave gets fresh coordinators.** Nothing about a track coordinator carries forward past its wave — wave N+1's coordinators are new dispatches off the post-integration working branch, per "wave-scoped, not sprint-persistent" above. There is no `WAVE SYNC` message to send a continuing coordinator, because there is no continuing coordinator.
6. **Delegate integration tests** to a test subagent on the working branch, same as subagent mode.

## Sprint End Teardown

After the final wave: confirm no coordinator is running, run `shipyard-data verify-wave-integrated` once more, then continue to Step 5 (SKILL.md § Step 5 plus `references/pipeline-sprint-complete.md`: sprint refactor, full build, full test suite, user-flow probes, sprint-complete gate — Shipyard opens no PR). Coordinators never outlive their wave, so there is no shutdown handshake.

## Pause / Resume

Coordinators are wave-scoped, so a resumed sprint dispatches fresh coordinators for its pending tracks (mid-wave after Step 0 salvage, or at the next wave). Task and track status comes from step files and the event log, never from a prior coordinator.
