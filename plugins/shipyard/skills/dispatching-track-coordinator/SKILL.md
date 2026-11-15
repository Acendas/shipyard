---
name: dispatching-track-coordinator
description: Dispatch a track coordinator for one feature track.
disable-model-invocation: true
---

# Dispatching a Track Coordinator

**Render before asking.** Render the decision context as chat text before any AskUserQuestion (rules printed at startup under SHIPYARD_STARTUP_RULES).

This is how a wave dispatches ONE feature track under `execution_mode: track` (`references/track-mode.md`) — the per-track analog of what `dispatching-task-loop` is for a single task. Main partitions a wave into tracks, decides the cross-track concurrency cap, and runs wave-boundary integration; none of that lives here. This skill owns exactly one thing: dispatching one track coordinator, parsing its return, and reconciling redispatch-or-park for that one track's tasks.

**A coordinator changes nothing about verification.** It dispatches `shipyard-disciplined-builder` unchanged, one task at a time in an isolated worktree, adding only a TRACK NOTES block to each successive brief. It has no `Bash`, `Write`, or `Edit`, so it cannot commit or forge a completion record — every nested builder still writes its own `.subagent-returns/<task_id>.json` and emits `subagent_completed` into the shared event log. **The per-task gate below is unchanged from `dispatching-task-loop`; this skill only adds track-level bookkeeping.**

## When to Invoke

Read and follow this playbook once per track, from the command-skill wave-dispatch path, when `execution_mode` resolves to `track` for a wave. How a wave is partitioned into tracks, the cross-track concurrency cap, and wave-boundary integration are owned by the calling command skill (`ship-execute` Step 2 and `references/track-mode.md`) — not here.

## Inputs

- `track_id` — a stable identifier for the track (its parent feature ID, e.g. `S007`)
- `feature_file_path` — the track's parent feature spec
- `tasks` — the track's ordered, dependency-sorted task list: `{task_id, task_file_path, acceptance_probe, data_impl_guide_or_omit, quality_standards_digest_or_omit}` per entry. **Resolve `task_file_path` here, not in the coordinator** — step files are slug-suffixed (`<TASK_ID>-<slug>.md`), and the coordinator's allowlist has no `Glob`/`Bash` to discover that filename from a bare task ID; the same resolution the calling command skill already does before dispatching to `dispatching-task-loop` for solo/subagent tasks. Per-task gating is otherwise unchanged from `dispatching-task-loop`'s own Inputs — `data_impl_guide` only if that task touches the database, `quality_standards_digest` only for `effort: M|L|XL`.
- `sibling_track_names` — the deterministic names (`track-<other_track_id>`) of this wave's OTHER track coordinators, for the coordinator's Interface Change broadcast. Omit or pass an empty list for a wave with only one track.
- `working_branch`, `base_ref`, `data_dir`, `sprint_id`, `wave_number` — same meaning as in `dispatching-task-loop`
- `build_model` — the model string from `shipyard-data resolve-model build` (`model=<m>`; empty means the literal instruction to omit). **Nested relay:** the OUTER wrapper (this skill, in the main session) resolves it exactly once — via `shipyard-data resolve-model build`, and emits `dispatch_model_resolved role=build model=<m or inherit> effort=<e or inherit>` there (the wrapper logs; the resolver stays silent; a logging failure never blocks the dispatch). The coordinator only relays that string to each nested builder — it has no `Bash`, so it cannot run `resolve-model` or read `config.md`, and neither does any builder it dispatches. The release gate reads that the model was *resolved* (the event, off the shared log), not that a coordinator *ran* a resolution.
- `coordinator_model` — the `model=` value from `shipyard-data resolve-model coordinator` (light tier; falls back to the resolved build value when `models.light` is unset; empty means omit). Used ONLY for this coordinator's own `Agent(model:)`; it is a separate resolution from `build_model`, which the coordinator never uses for itself. Main emits `dispatch_model_resolved role=coordinator ...` alongside the build one.
- `coordinator_effort` — the `effort=` value from `shipyard-data resolve-model coordinator` (empty means omit), resolved by the caller.
- `build_effort` / `build_trivial_effort` — the `effort=` values from `shipyard-data resolve-model build` and `resolve-model build_trivial` (empty means omit), resolved by the caller and relayed per task by the coordinator; it has no `Bash` to resolve them itself.

**Plugin-relative paths are resolved here, not in the agent.** Resolve `data_impl_guide`/`quality_standards_digest` per task, and `build_model`, to literal values before composing the brief below.

## Dispatching the Coordinator

The coordinator's methodology lives in the registered agent `agents/shipyard-track-coordinator.md`; do not re-inline it here.

Dispatch:

```
Agent(
  subagent_type: "shipyard:shipyard-track-coordinator",
  name: "track-{{track_id}}",
  model: <coordinator_model value, or omit>,
  effort: <coordinator_effort value, or omit>,
  isolation: "worktree",
  run_in_background: true,
  prompt: "
    Track ID:              {{track_id}}
    Story file:          {{feature_file_path}}
    Tasks (ordered):       {{tasks — task_id, task_file_path, acceptance_probe, per-task guide paths}}
    Sibling track names:   {{sibling_track_names, csv or 'none'}}
    Working branch:        {{working_branch}}
    Base ref:              {{base_ref}}
    Data dir:              {{data_dir}}
    Sprint ID:             {{sprint_id}}
    Wave number:           {{wave_number}}
    Build model:           {{build_model, or 'omit — inherit session model'}}
    Coordinator effort:    {{coordinator_effort, or 'omit — inherit runtime default'}}
    Build effort:          {{build_effort, or 'omit — inherit runtime default'}}
    Trivial build effort:  {{build_trivial_effort, or 'omit — inherit runtime default'}}
  "
)
```

`isolation: "worktree"` gives the coordinator the `Agent` sub-delegation it needs. `run_in_background: true` lets main dispatch several tracks in parallel; the background-completion notification delivers the coordinator's final STATUS block. Nested builders still emit `subagent_completed` per task, so main's wave-level Monitor is unaffected.

## Orchestrator-Side Parsing and Gating

Parse the coordinator's final reply (from the background-completion notification, or the direct return if dispatched synchronously for a single-track wave):

1. **Silent return.** No `STATUS:` line, or an empty/whitespace body. This is its own outcome, distinct from COMPLETE/PARTIAL/BLOCKED — see "Silent Return (Track Level)" below.
2. **`STATUS: COMPLETE`:**
   - Extract `TRACK_ID:` and `COMPLETED_TASKS:`. Confirm the csv names every task ID from this track's original `tasks` input — a short list is itself a contract violation (the coordinator is not authoritative over which tasks actually happened); treat it the same as a `STATUS: PARTIAL` violation below rather than trusting it.
   - For every task ID in `COMPLETED_TASKS`, run the exact same orchestrator-side gate `dispatching-task-loop` already defines: read `.subagent-returns/<task_id>.json`, confirm the commit sha exists (`git cat-file -e`), `probe_exit_code === 0`, a non-empty output tail, and an anti-stub-scan pass — then call `shipyard-data step accept-return <task_id> sprint=<sprint_id> wave=<wave_number> commit=<sha> --data-dir {{data_dir}}` to anchor, emit `task_dispatch_returned status=complete`, and mark the task done. This is unchanged, task by task; nothing about it moves into the coordinator.
   - Log the coordinator's final `TRACK_NOTES:` block to the wave's progress report — useful narrative context even after the track finishes.
3. **`STATUS: PARTIAL`:**
   - Extract `COMPLETED_TASKS:` and `BLOCKED_TASKS:`. Confirm the two csvs together account for every task ID in this track's original `tasks` input — a task missing from both is a contract violation (treat the whole return as untrustworthy: fall back to the reconciliation procedure in "Silent Return (Track Level)" below, since it's the same "trust the shared data dir, not the coordinator's claim" recipe).
   - Gate every entry in `COMPLETED_TASKS:` exactly as in step 2.
   - For **each** task ID in `BLOCKED_TASKS:`, render the coordinator's `REASON:` (and any per-task `BLOCKED:`/`IDLE:` message already received via SendMessage — see "Handling an Interim SendMessage" below) as chat text, then apply `dispatching-task-loop`'s own single-redispatch rule to that task directly — read and follow that playbook for just this one task (a direct `Agent(subagent_type: "shipyard:shipyard-disciplined-builder", ...)` dispatch, not a fresh coordinator; every task in a track is independently buildable by design, so there is no "resume the rest of the track" step here).
     - Redispatch clears the gate → anchor/mark done as in step 2.
     - Redispatch also fails the gate or comes back `BLOCKED` → `shipyard-data step set-status <id> needs-attention --reason "track_task_blocked"`, and surface via AskUserQuestion rather than looping further on that task.
4. **`STATUS: BLOCKED`:**
   - Render the coordinator's `TRACK_ID:`, `REMAINING_TASKS:`, and `REASON:` verbatim as chat text, then AskUserQuestion.
   - If the `REASON:` reads as a structural `Agent`-dispatch or allowlist failure (matches the agent's own "detect a structural dispatch failure early" language), treat this as a platform-capability finding, not a one-off task problem: fall back to dispatching every task in `REMAINING_TASKS` directly via `dispatching-task-loop` (no coordinator) for the rest of this wave, and flag loudly that track-shaped dispatch is unavailable this session. Re-run the coordinator's smoke-dispatch verification (a trivial dispatch confirming it can call `Agent` and reach `SendMessage`) before trusting track mode again this session.

## Silent Return (Track Level)

The coordinator's own Agent return is present but has no `STATUS:` line, or the body is empty/whitespace:

1. Emit `shipyard-data events emit track_dispatch_returned pipeline=ship-execute sprint=<sprint_id> wave=<wave_number> track=<track_id> status=needs-attention reason=silent_return`.
2. **Reconcile against ground truth before assuming anything is lost.** Nested builders write `.subagent-returns/<task_id>.json` directly into the shared data dir, independent of the coordinator (see the "A coordinator changes nothing about verification" paragraph above) — a silent coordinator does not erase work that already landed. For every `task_id` in this track's original `tasks` input, check whether `.subagent-returns/<task_id>.json` exists:
   - If it exists: gate and reconcile it exactly as step 2 of "Orchestrator-Side Parsing and Gating" above (sha/probe/anti-stub/anchor/`task_dispatch_returned`/mark done).
   - If it does not exist: the task is genuinely unresolved.
3. **Re-dispatch ONCE.** Spin up a fresh track coordinator scoped ONLY to the genuinely-unresolved task IDs from step 2 (same `sibling_track_names` as the original; seed its TRACK NOTES empty — the silent coordinator's accumulated notes are unrecoverable, an accepted, logged degradation, not silently pretended away).
4. **If the second coordinator ALSO returns silently:** stop re-dispatching. Run `shipyard-data step set-status <id> needs-attention --reason "silent_return"` for every still-unresolved task_id, and surface it as a `STATUS: BLOCKED`-shaped ask (render the situation as chat text first) instead of looping — the same terminal shape `dispatching-task-loop` and `dispatching-code-review` both use for their own silent-return cases.

## Handling an Interim SendMessage

A track coordinator may send an advisory `SendMessage(to: "main", ...)` before its own final return lands — either a per-task `"BLOCKED: <task_id> — <reason>"` message (sent the moment a task blocks, per the agent's Cycle step 4) or a track-level `"IDLE: all tasks in <track_id> are blocked"` message (sent once, if nothing in the track ever completed). Delivery is asynchronous, so either can arrive before or after the completion notification.

Render either as chat text on arrival. Do **not** act on it alone (redispatch, park, or ask) until the coordinator's own final return lands and "Orchestrator-Side Parsing and Gating" runs — the interim message carries no `COMPLETED_TASKS`/`BLOCKED_TASKS`/`TRACK_NOTES`, so acting on it races the authoritative return.

**Interface-change messages do not come to main.** Per the coordinator's own contract, a changed shared interface is broadcast directly to sibling track coordinators (`sibling_track_names`), not to main — main has nothing to parse or react to for that message class.

## Pairing With Other Skills

- **`dispatching-task-loop`** is reused twice here: unchanged, as what the coordinator itself dispatches for every task; and directly, at this skill's own level, for the single-task redispatch on any entry in `BLOCKED_TASKS`.
- **`using-worktrees`** — the coordinator is dispatched with `isolation: "worktree"`, same contract as any other isolated Agent call.
- Wave-level track partitioning, the cross-track concurrency cap, and wave-boundary integration are **out of scope here** — owned by the calling command skill, matching the same division of labor `dispatching-task-loop` already has with its own callers.
