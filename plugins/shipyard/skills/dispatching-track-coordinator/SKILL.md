---
name: dispatching-track-coordinator
description: Dispatch a track coordinator for one feature track.
disable-model-invocation: true
---

# Dispatching a Track Coordinator

**Render before asking.** Before any AskUserQuestion, render the decision context as assistant chat text. Content that exists only in a Read result, a subagent/Agent return, or the question/option strings **does not count as rendered** (the UI shows a compact card) — restate it in chat first.

This is how a wave dispatches ONE feature track under `execution_mode: track` (`references/track-mode.md`) — the per-track analog of what `dispatching-task-loop` is for a single task. Main partitions a wave into tracks, decides the cross-track concurrency cap, and runs wave-boundary integration; none of that lives here. This skill owns exactly one thing: dispatching one track coordinator, parsing its return, and reconciling redispatch-or-park for that one track's tasks.

**Why a coordinator, and why it changes nothing about verification.** The coordinator dispatches `shipyard-disciplined-builder` unchanged, one task at a time, in an isolated worktree per task — same one-task-one-worktree-one-branch-one-commit-one-return shape `dispatching-task-loop` already uses. Its only addition is a running TRACK NOTES block it prepends to each successive builder's brief, so interfaces/decisions/gotchas from earlier tasks in the track reach later ones. It has no `Bash`, `Write`, or `Edit` tool, so it cannot call `shipyard-data`, cannot commit, and cannot forge a completion record — every nested builder still writes its own `.subagent-returns/<task_id>.json` and emits `subagent_completed` directly into the shared event log, exactly as it does without a coordinator in the picture. **The per-task gate below is unchanged from `dispatching-task-loop` — this skill does not redefine it, only adds a track-level bookkeeping layer on top.**

## When to Invoke

Read and follow this playbook once per track, from the command-skill wave-dispatch path, when `execution_mode` resolves to `track` for a wave. How a wave is partitioned into tracks, the cross-track concurrency cap, and wave-boundary integration are owned by the calling command skill (`ship-execute` Step 2 and `references/track-mode.md`) — not here.

## Inputs

- `track_id` — a stable identifier for the track (its parent feature ID, e.g. `F007`)
- `feature_file_path` — the track's parent feature spec
- `tasks` — the track's ordered, dependency-sorted task list: `{task_id, task_file_path, acceptance_probe, data_impl_guide_or_omit, quality_standards_digest_or_omit}` per entry. **Resolve `task_file_path` here, not in the coordinator** — task files are slug-suffixed (`<TASK_ID>-<slug>.md`), and the coordinator's allowlist has no `Glob`/`Bash` to discover that filename from a bare task ID; the same resolution the calling command skill already does before dispatching to `dispatching-task-loop` for solo/subagent tasks. Per-task gating is otherwise unchanged from `dispatching-task-loop`'s own Inputs — `data_impl_guide` only if that task touches the database, `quality_standards_digest` only for `effort: M|L|XL`.
- `sibling_track_names` — the deterministic names (`track-<other_track_id>`) of this wave's OTHER track coordinators, for the coordinator's Interface Change broadcast. Omit or pass an empty list for a wave with only one track.
- `working_branch`, `base_ref`, `data_dir`, `sprint_id`, `wave_number` — same meaning as in `dispatching-task-loop`
- `build_model` — the resolved `models.build` value, or the literal instruction to omit, resolved by the caller exactly as `dispatching-task-loop`'s own "Model tier (build)" step does. Resolve this once here; the coordinator only relays it — it has no `Bash` to read `config.md` itself, and neither does any builder it dispatches.

**Plugin-relative paths are resolved here, not in the agent.** Resolve `data_impl_guide`/`quality_standards_digest` per task, and `build_model`, to literal values before composing the brief below.

## Dispatching the Coordinator

The coordinator's methodology (the six governing rules, the sequential per-task cycle, the TRACK NOTES protocol, the sibling interface-change broadcast, the Required Return Shape) lives in the registered agent `agents/shipyard-track-coordinator.md` — read it once if you need to know exactly what it does; do not re-inline it here.

Dispatch:

```
Agent(
  subagent_type: "shipyard:shipyard-track-coordinator",
  name: "track-{{track_id}}",
  model: <build_model value, or omit>,
  isolation: "worktree",
  run_in_background: true,
  prompt: "
    Track ID:              {{track_id}}
    Feature file:          {{feature_file_path}}
    Tasks (ordered):       {{tasks — task_id, task_file_path, acceptance_probe, per-task guide paths}}
    Sibling track names:   {{sibling_track_names, csv or 'none'}}
    Working branch:        {{working_branch}}
    Base ref:              {{base_ref}}
    Data dir:              {{data_dir}}
    Sprint ID:             {{sprint_id}}
    Wave number:           {{wave_number}}
    Build model:           {{build_model, or 'omit — inherit session model'}}
  "
)
```

`isolation: "worktree"` gives the coordinator the `Agent` sub-delegation it needs (it costs it the shared task list, which is fine — the checklist is shell-side only). `run_in_background: true` lets main dispatch several tracks in parallel and continue; the standard background-agent-completion notification delivers the coordinator's own final STATUS block when it finishes — no separate polling is needed for that.

Nested builders still emit `subagent_completed` straight into the shared event log per task, same as always — main's existing wave-level Monitor (armed on that event) keeps working unmodified, independent of whether the coordinator itself has reported yet.

## Orchestrator-Side Parsing and Gating

Parse the coordinator's final reply (from the background-completion notification, or the direct return if dispatched synchronously for a single-track wave):

1. **Silent return.** No `STATUS:` line, or an empty/whitespace body. This is its own outcome, distinct from COMPLETE/PARTIAL/BLOCKED — see "Silent Return (Track Level)" below.
2. **`STATUS: COMPLETE`:**
   - Extract `TRACK_ID:` and `COMPLETED_TASKS:`. Confirm the csv names every task ID from this track's original `tasks` input — a short list is itself a contract violation (the coordinator is not authoritative over which tasks actually happened); treat it the same as a `STATUS: PARTIAL` violation below rather than trusting it.
   - For every task ID in `COMPLETED_TASKS`, run the exact same orchestrator-side gate `dispatching-task-loop` already defines: read `.subagent-returns/<task_id>.json`, confirm the commit sha exists (`git cat-file -e`), `probe_exit_code === 0`, a non-empty output tail, and an anti-stub-scan pass — then call `shipyard-data task accept-return <task_id> sprint=<sprint_id> wave=<wave_number> commit=<sha> --data-dir {{data_dir}}` to anchor, emit `task_dispatch_returned status=complete`, and mark the task done. This is unchanged, task by task; nothing about it moves into the coordinator.
   - Log the coordinator's final `TRACK_NOTES:` block to the wave's progress report — useful narrative context even after the track finishes.
3. **`STATUS: PARTIAL`:**
   - Extract `COMPLETED_TASKS:` and `BLOCKED_TASKS:`. Confirm the two csvs together account for every task ID in this track's original `tasks` input — a task missing from both is a contract violation (treat the whole return as untrustworthy: fall back to the reconciliation procedure in "Silent Return (Track Level)" below, since it's the same "trust the shared data dir, not the coordinator's claim" recipe).
   - Gate every entry in `COMPLETED_TASKS:` exactly as in step 2.
   - For **each** task ID in `BLOCKED_TASKS:`, render the coordinator's `REASON:` (and any per-task `BLOCKED:`/`IDLE:` message already received via SendMessage — see "Handling an Interim SendMessage" below) as chat text, then apply `dispatching-task-loop`'s own single-redispatch rule to that task directly — read and follow that playbook for just this one task (a direct `Agent(subagent_type: "shipyard:shipyard-disciplined-builder", ...)` dispatch, not a fresh coordinator; every task in a track is independently buildable by design, so there is no "resume the rest of the track" step here).
     - Redispatch clears the gate → anchor/mark done as in step 2.
     - Redispatch also fails the gate or comes back `BLOCKED` → `shipyard-data task set-status <id> needs-attention --reason "track_task_blocked"`, and surface via AskUserQuestion rather than looping further on that task.
4. **`STATUS: BLOCKED`:**
   - Render the coordinator's `TRACK_ID:`, `REMAINING_TASKS:`, and `REASON:` verbatim as chat text, then AskUserQuestion.
   - If the `REASON:` reads as a structural `Agent`-dispatch or allowlist failure (matches the agent's own "detect a structural dispatch failure early" language), treat this as a platform-capability finding, not a one-off task problem: fall back to dispatching every task in `REMAINING_TASKS` directly via `dispatching-task-loop` (no coordinator) for the rest of this wave, and flag loudly that track-shaped dispatch is unavailable this session. A live occurrence of this branch means the `Agent`/`SendMessage` allowlist grants this agent's `tools:` line was relying on have not actually been verified against the running platform — treat it as a signal to re-run the coordinator's own smoke-dispatch verification (a trivial standalone dispatch confirming it can call `Agent` and reach `SendMessage`) before trusting track mode again this session.

## Silent Return (Track Level)

The coordinator's own Agent return is present but has no `STATUS:` line, or the body is empty/whitespace:

1. Emit `shipyard-data events emit track_dispatch_returned pipeline=ship-execute sprint=<sprint_id> wave=<wave_number> track=<track_id> status=needs-attention reason=silent_return`.
2. **Reconcile against ground truth before assuming anything is lost.** Nested builders write `.subagent-returns/<task_id>.json` directly into the shared data dir, independent of the coordinator (see "Why a coordinator" above) — a silent coordinator does not erase work that already landed. For every `task_id` in this track's original `tasks` input, check whether `.subagent-returns/<task_id>.json` exists:
   - If it exists: gate and reconcile it exactly as step 2 of "Orchestrator-Side Parsing and Gating" above (sha/probe/anti-stub/anchor/`task_dispatch_returned`/mark done).
   - If it does not exist: the task is genuinely unresolved.
3. **Re-dispatch ONCE.** Spin up a fresh track coordinator scoped ONLY to the genuinely-unresolved task IDs from step 2 (same `sibling_track_names` as the original; seed its TRACK NOTES empty — the silent coordinator's accumulated notes are unrecoverable, an accepted, logged degradation, not silently pretended away).
4. **If the second coordinator ALSO returns silently:** stop re-dispatching. Run `shipyard-data task set-status <id> needs-attention --reason "silent_return"` for every still-unresolved task_id, and surface it as a `STATUS: BLOCKED`-shaped ask (render the situation as chat text first) instead of looping — the same terminal shape `dispatching-task-loop` and `dispatching-code-review` both use for their own silent-return cases.

## Handling an Interim SendMessage

A track coordinator may send an advisory `SendMessage(to: "main", ...)` before its own final return lands — either a per-task `"BLOCKED: <task_id> — <reason>"` message (sent the moment a task blocks, per the agent's Cycle step 4) or a track-level `"IDLE: all tasks in <track_id> are blocked"` message (sent once, if nothing in the track ever completed). SendMessage delivery is asynchronous, so either can arrive before or after the coordinator's background-completion notification.

Render either as chat text as soon as it arrives — this is where a blocked task's reason first becomes visible, ahead of the coordinator's final report. Do **not** act on it alone (redispatch, park, or ask) until the coordinator's own `STATUS: PARTIAL` (or `STATUS: COMPLETE`, if the block later cleared through some other path — it won't, but don't assume) return lands and "Orchestrator-Side Parsing and Gating" step 3 runs; the interim message doesn't carry `COMPLETED_TASKS`/`BLOCKED_TASKS`/`TRACK_NOTES`, so acting on it alone risks racing the authoritative return.

**Interface-change messages do not come to main.** Per the coordinator's own contract, a changed shared interface is broadcast directly to sibling track coordinators (`sibling_track_names`), not to main — main has nothing to parse or react to for that message class.

## Failure Modes This Contract Catches

1. **A coordinator claiming a track complete when it isn't.** It has no `Bash`/`Write`, so it cannot write `.subagent-returns/` or a commit itself — the per-task gate (unchanged) still runs against what nested builders actually wrote, independent of the coordinator's own claim.
2. **A builder returning a fake sha inside a track.** Caught by the exact same `git cat-file -e` check `dispatching-task-loop` already runs — nothing about this check moved or weakened.
3. **A coordinator going silent mid-track.** The silent-return gate above reconciles against `.subagent-returns/` before assuming anything is lost, then redispatches once (scoped to only what's genuinely unresolved), then parks — never loops indefinitely.
4. **The platform not actually granting `Agent` to this allowlist.** The agent's own first-dispatch structural-failure detection (with a `ToolSearch` retry) surfaces this as a distinguishable `STATUS: BLOCKED`, so this skill can fall back to dispatching builders directly instead of silently limping along with a coordinator that can never sub-delegate.
5. **One blocked task stalling an entire track.** The coordinator never halts on a single block — it reports and continues, so a track with 4 independent tasks and 1 blocker still lands the other 3 without waiting on main to intervene mid-track.
6. **A short `COMPLETED_TASKS`/`BLOCKED_TASKS` csv silently dropping a task.** Both gating paths (steps 2 and 3 above) require the two csvs to jointly account for every task in the track's `tasks` input; a gap falls back to the same ground-truth reconciliation the silent-return path uses, rather than trusting the coordinator's count.

## Pairing With Other Skills

- **`dispatching-task-loop`** is reused twice here: unchanged, as what the coordinator itself dispatches for every task; and directly, at this skill's own level, for the single-task redispatch on any entry in `BLOCKED_TASKS`.
- **`using-worktrees`** — the coordinator is dispatched with `isolation: "worktree"`, same contract as any other isolated Agent call.
- Wave-level track partitioning, the cross-track concurrency cap, and wave-boundary integration are **out of scope here** — owned by the calling command skill, matching the same division of labor `dispatching-task-loop` already has with its own callers.

## Bottom Line

- One dispatch per track to the registered `shipyard-track-coordinator` agent, which sequentially dispatches `shipyard-disciplined-builder` unchanged, one task at a time, and never halts the whole track over a single blocked task.
- The per-task verification spine is completely unchanged: sha exists, probe exit 0, non-empty tail, anti-stub-scan, `task accept-return` anchoring + `task_dispatch_returned` — run here exactly as `dispatching-task-loop` already runs it.
- The coordinator cannot forge a return (no `Bash`/`Write`/`Edit`) and never gates on its own claim — main verifies every task independently, off the shared data dir, whether or not the coordinator ever reports.
- Interface changes go coordinator-to-sibling directly; blockers go coordinator-to-main; neither is authoritative until the coordinator's own final STATUS block (or the silent-return reconciliation) confirms it.
- Silent-return gate at the track level: reconcile against `.subagent-returns/` first, redispatch once (scoped to only what's genuinely unresolved), then park and surface — never loop.
