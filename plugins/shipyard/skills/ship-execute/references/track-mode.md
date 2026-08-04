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

## Why nesting, not flat track agents

Shipyard's verification spine — `.subagent-returns/<task>.json`, `anchor-commit`, `task_dispatch_returned`, `pending_subagents`, the single-redispatch rule, `shipyard-disciplined-builder`'s single-`COMMIT:` return contract — is per-task at every layer. A flat track agent that commits several tasks itself would fight all of that at once (many tasks on one branch, one commit history, no per-task anchor). Nesting keeps **one task = one worktree = one branch = one commit = one return = one anchor**, so the entire incident-hardened spine applies unchanged regardless of whether a task was dispatched solo, as a bare subagent, or nested under a track coordinator.

## Concurrency Cap

Concurrency is **two-level**, not a flat agent count: each track runs one coordinator plus, at most, one active builder at a time (dispatch within a track is sequential — see below). So live agents ≈ **2 × tracks**. Cap on **`execution.max_parallel_agents` tracks** (read from config, default 3, hard ceiling 4) — at the default cap this reaches 6 live agents, which is the range Sprint 001/002 showed degrading (agents returning early or hitting context limits), so do not raise the track cap without re-deriving this budget.

If a sprint has more feature tracks than the cap:
1. Sort feature tracks by wave priority (earlier-wave tasks first).
2. Spawn the first `max_parallel_agents` tracks' coordinators as the initial batch.
3. As each coordinator finishes its track's wave tasks, spawn the next queued track's coordinator in its place.
4. Fewer tracks than the cap → spawn them all, no queuing needed.

## Feature Track Mapping

Before spawning coordinators, group this wave's tasks by parent feature:

1. Read wave task IDs from SPRINT.md.
2. For each task, read the task file's `feature:` field.
3. Group into feature tracks: `{F001: [T001, T002, T003], F005: [T004, T005]}`.
4. One coordinator per feature track, **for this wave only** — see "Wave-scoped, not sprint-persistent" below.
5. Cross-feature dependencies are handled by wave ordering — tasks with cross-feature deps land in later waves, same as subagent mode.

A feature with only 1 task in this wave still gets its own coordinator (simpler than special-casing) — or, if the wave has exactly one track with one task, plain solo/subagent dispatch is cheaper; that choice is Step 2's dispatch-shape decision, not this file's concern.

## The Track Coordinator Contract

The registered agent `agents/shipyard-track-coordinator.md` and its wrapper `skills/dispatching-track-coordinator/SKILL.md` own the dispatch mechanics (the `Agent(...)` call shape, model-tier resolution, the coordinator's structured-return parse, and the `silent_return` outcome) — this section documents the protocol they implement, not a duplicate spec. Read those before changing coordinator behavior.

**A coordinator never commits, and never writes at all — and it is wave-scoped, not sprint-persistent.**

- The `WorktreeCreate` hook pins a coordinator's branch to spawn-time HEAD. Within one wave, every nested builder it spawns forks from that same base (a nested child forks from its **spawning agent's HEAD**, not from a sibling task's branch) — so the superset-branch hazard a flat track agent would create never arises.
- This holds **only within one wave**. At the wave boundary the working branch advances (rebase + ff-merge, `ship-execute` Step 4) while a coordinator's own HEAD never does. A coordinator surviving into wave N+1 would fork its builders from the **stale wave-N base**, silently dropping everything wave N merged — the same symptom as the v2.8.x root cause #4 (forking from a stale base drops earlier waves' commits), just reached via a stale parent HEAD instead of a stale `worktree.baseRef`. **Therefore: spawn coordinators fresh at `wave_<N>_dispatch` and let them finish at the wave boundary; wave N+1 always gets fresh coordinators off the updated working branch.** Do not re-spawn a coordinator across a wave boundary and do not carry a coordinator's identity or context forward into the next wave — there is no "continuing teammate" concept here.
- **Never writes**, not merely never commits: because a nested builder forks from a sha, any uncommitted file sitting in a coordinator's own worktree propagates nowhere and is destroyed at teardown. The coordinator's `tools:` allowlist (`Read, ToolSearch, Agent, SendMessage` — no `Bash`, no `Write`, no `Edit`) makes this structural rather than a rule to remember: with no write tool, there is no uncommitted work to lose.

**A coordinator has nothing legitimate to certify — and the allowlist is what makes that structural, not just a stated rule.** A coordinator with `Bash` could forge a `task-return` record for a real (but never-verified) commit sha it can see on a sibling's branch (branch visibility is shared, per the platform's `git-common-dir`), and every downstream check — `cat-file -e`, `probe_exit_code === 0`, non-empty tail, anti-stub-scan — would pass on that forged record, because forging a return needs a real commit, not real verification. Dropping `Bash`/`Write`/`Edit` from the coordinator's tools closes this: it cannot invoke `shipyard-data` at all, so every task's return is written only from inside that task's own nested builder context, which is where the actual gate-worthy evidence lives. `TaskStop` is deliberately **not** in the allowlist either — it would be inert there, because `TaskStop` is ownership-scoped and a coordinator cannot stop the builders it spawned (see Liveness below). Zombie-stopping is main's job, by name.

**The coordinator's persistence produces one concrete artifact: TRACK NOTES.** Because every nested builder is a fresh context, whatever a coordinator learns from task 1's return reaches task 2's *builder* only if the coordinator deliberately writes it into task 2's brief. So the coordinator keeps a short running **TRACK NOTES** block across its track's tasks this wave — interfaces introduced or renamed, decisions taken, gotchas hit, files touched — sourced from each builder's return text (the free-form part of the reply beyond the parsed `STATUS:`/`COMMIT:`/`PROBE_OUTPUT_TAIL:` lines) and from the probe output tail. It prepends that block to every subsequent builder's brief in its track. This is the specific thing that makes "persistent track context" a real deliverable instead of an extra agent that buys nothing but triage centralization — and it is deliberately testable: a coordinator that never updates its notes across two or more tasks is failing this contract.

### What "sequential" gives you — and does not

**Dispatch within a track is sequential**, one nested builder at a time, never two in flight under the same coordinator. This is deliberate for two reasons, and only one of them is about code:

1. **Concurrency and context discipline** — bounds each track to one active builder, keeping the nested budget at `2 × tracks` (see Concurrency Cap).
2. **Informed sequencing via TRACK NOTES** — a coordinator that has seen task 1's outcome can brief task 2's builder with the naming/interface decisions task 1 actually made, instead of task 2 guessing independently and conflicting at merge time.

**It does NOT give a later task git-level visibility into an earlier sibling task's code.** Every nested builder in a track forks from the **same wave-start base** (the coordinator's own fixed HEAD, per F10) — task 1's commit lives only on task 1's own `shipyard/wt-*` branch until the wave-boundary rebase/merge, and the coordinator has no `Bash`/`Write` to advance its own checkout to include it. So a task 2 that requires task 1's actual code to be present (e.g., importing a function task 1 just created) will not find it in its worktree. Tasks assigned to the same track must stay independently buildable and testable against their own acceptance probe — same task-independence discipline subagent-mode waves already require. "Sequential" orders and informs; it does not chain commits. Real code integration across every task in the wave — same track or not — happens once, at the wave boundary (rebase + ff-merge onto the working branch, `ship-execute` Step 4 / `references/git-strategy.md`).

If a coordinator judges that two tasks in its track are more coupled than that (task 2 genuinely cannot be specified without task 1's code, not just its outcome), that is a wave-decomposition problem, not something the coordinator should route around — surface it to main via the Blocker Protocol rather than improvising.

## Coordinator Brief (what main passes to `dispatching-track-coordinator`)

| Parameter | Value |
|---|---|
| `track_id` | the feature ID, e.g. `F007` |
| `tasks` | this wave's tasks belonging to the track, in dependency order — one entry each: `{task_id, task_file_path, acceptance_probe, …}`. **`task_file_path` is resolved by the caller, never by the coordinator** — task files are slug-suffixed (`<TASK_ID>-<slug>.md`) and the coordinator's allowlist has no `Glob`/`Bash` to discover that filename from a bare ID. This is the same resolution the caller already performs before dispatching `dispatching-task-loop` for a solo/task-mode task. See `dispatching-track-coordinator`'s Inputs for the full per-entry shape. |
| `sibling_track_names` | the deterministic names of this wave's other track coordinators (for the Interface Change Protocol) |
| `working_branch` | `branch:` from SPRINT.md frontmatter |
| `base_ref` | the working-branch HEAD at wave-dispatch time — passed through unchanged to every nested builder this coordinator spawns |
| `data_dir` | literal `<SHIPYARD_DATA>` path |
| `sprint_id` | `id:` from SPRINT.md frontmatter |
| `wave_number` | current wave number from the cursor |

Dispatch, one call per track, wave-scoped only:

```
Agent(subagent_type: "shipyard:shipyard-track-coordinator",
      name: "track-{{track_id}}",
      isolation: "worktree",
      run_in_background: true,
      model: <models.build value, or omit>,
      effort: <agent_effort.coordinator value, or omit>,
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
      model: <models.build value, or omit>,
      effort: <agent_effort.build_trivial for effort:S, else agent_effort.build; omit if empty>,
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
SendMessage(to: "track-F005",
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

**Two structures, not one re-key** — main's direct children this wave are tracks, but the existing per-task gate reconciliation still runs off per-task evidence, so both structures are maintained simultaneously:

1. **Per-track handle/timeout list** (new) — main's own children: one entry per spawned coordinator, `{"track_id", "coordinator_name", "spawned_at", "max_execution_minutes"}`. Because dispatch within a track is sequential, `max_execution_minutes` for a track is the **sum** over its tasks' individual budgets (default 60 min each unless the task frontmatter overrides it) — not a flat per-agent timeout. This list is for **track-level** liveness only: is the coordinator (or whichever builder it's currently running) still making progress at all.
2. **Per-task pending list** (`pending_subagents`, unchanged from subagent mode) — one entry per task in the wave, across every track, reconciled against `subagent_completed` events exactly as `ship-execute/SKILL.md`'s wave-waiting handler already does. This is the list the orchestrator-side gate (`wave_N_recovery`) reads from.

**Per-task wake survives intact.** The primary wake signal is NOT the coordinator's own background-completion notification (which fires once per track, when the whole track's sequence of tasks is done) — it is the same persistent `Monitor` on `<SHIPYARD_DATA>/.shipyard-events.jsonl` filtered for `subagent_completed`, armed exactly as in subagent mode. Nested builders are `shipyard-disciplined-builder` unchanged, so they still emit that event per task into the shared log the moment each task lands, regardless of which coordinator dispatched them or whether that coordinator's own call was foreground. Main learns of each task landing exactly as it does today — this is not degraded by the extra coordinator layer, and should not be "fixed."

**The verification spine is unchanged.** Every task — solo, bare subagent, or nested under a track coordinator — exits through `task-return` → main's orchestrator-side gate (sha `cat-file` + `probe_exit_code === 0` + non-empty tail + anti-stub-scan) → `anchor-commit` → `task_dispatch_returned`. A coordinator cannot self-certify (see "The Track Coordinator Contract" above) and a nested builder cannot self-certify (it has no `TaskUpdate` in its isolated context — the only way it can claim completion is through the CLI, which refuses a false COMPLETE). **A track cannot self-certify either way.**

## Liveness — no heartbeat file

There is no heartbeat apparatus. Nothing in the current plugin writes `<SHIPYARD_DATA>/agents/<id>.heartbeat` — the `agent-heartbeat` hook that used to write it was retired in the 2.0 overhaul, so a heartbeat-file check would spuriously fire "crash recovery" on every healthy coordinator's first monitoring pass. Live signals instead:

- `task_loop_iteration` events (a live-but-slow builder emits one per internal cycle — evidence of "working," not "dead").
- `subagent_completed` events (a task genuinely finished).
- `dispatching-task-loop`'s existing timeout rule, applied per task: presume dead only when elapsed time exceeds the budget AND there is no `subagent_completed` event AND no recent `task_loop_iteration` event.

**`TaskStop` is ownership-scoped — a coordinator cannot stop its own children.** A coordinator that tries to `TaskStop` a builder it spawned is refused ("Task <id> is owned by <other>; agent <coordinator> cannot stop it"). Zombie-stopping is therefore **main's job, not the coordinator's**, done **by deterministic name**:

- Nested builders are named `builder-<TASK_ID>` and track coordinators `track-<FEATURE_ID>` (both established at dispatch — see above). Agent names register session-wide and resolve across nesting levels, so main can address, and `TaskStop`, an agent it never directly spawned, purely by name — no agentId handoff through the coordinator is needed.
- On a genuine per-task timeout (the rule above), main runs `TaskStop("builder-<TASK_ID>")` before any salvage, exactly as subagent mode already does for its own direct dispatches — this prevents a late write from a zombie racing the salvage.
- A **positive stop of a still-live grandchild is not fully proven** — treat `TaskStop` on a builder main never spawned as best-effort, not a guarantee. Prefer waiting for natural termination (builders self-terminate under their own 5-iteration cap) over aggressive force-stop-and-redispatch when in doubt.

## Track / Coordinator Failure Recovery

On a **track timeout** (the per-track handle/timeout list shows no progress for longer than that track's summed budget, and no recent per-task evidence for its remaining tasks):

1. Read `<SHIPYARD_DATA>/sprints/current/.subagent-returns/` for every task ID belonging to that track. Gate whatever landed exactly as `wave_N_recovery` already does for any other task (sha `cat-file` + `probe_exit_code === 0` + non-empty tail + anti-stub-scan → `anchor-commit` + `task_dispatch_returned`).
2. Redispatch the remainder — the tasks in the track with no valid return at all. A fresh dispatch (either a replacement coordinator for the remaining tasks, or main dispatching them directly the way subagent mode would) is fine; do not attempt to resume the dead coordinator.
3. **Open hazard: an orphan that is still live.** If the presumed-dead coordinator's current builder is not actually dead, redispatching its task yields two builders on the same task and a `shipyard/wt-*` branch-name collision (Claude Code #51596 territory). Main *can* address a grandchild builder by name (the ownership check clears for main even though it never spawned that builder directly), so a best-effort `TaskStop("builder-<TASK_ID>")` before redispatch is reasonable defense — but a positive stop of a genuinely live target is not proven, so **prefer waiting and anchoring over force-removing a possibly-live builder's worktree** when the situation is ambiguous.
4. Nested builders orphaned by a dead coordinator keep their commits on their own `shipyard/wt-*` branches regardless — if they completed and returned before the coordinator died, they are already anchored and gated by step 1; nothing about the coordinator's death loses that work.

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

After the final wave completes: confirm no track coordinator is still running (step 2 above, one more time), run `shipyard-data verify-wave-integrated` one final time, then continue to Step 5 in `ship-execute/SKILL.md` (full test suite, PR, sprint report). There is no team/session-wide shutdown handshake to run — coordinators are already gone by the time the final wave's boundary protocol finished, because they never persist past their own wave.

## Pause / Resume

Because coordinators are wave-scoped, a paused-and-resumed sprint never re-spawns a coordinator by identity or from a note — any resume point is either mid-wave (Step 0 salvage already recovered any worktree commits from that wave's tasks; the resumed wave simply re-dispatches fresh coordinators for its still-pending tracks) or between waves (the next wave dispatches fresh coordinators as normal). Task and track status reconstructs from task files + the event log, the same recovery source subagent mode already uses — never from a prior coordinator's identity or memory, since none survives a session break in any case.
