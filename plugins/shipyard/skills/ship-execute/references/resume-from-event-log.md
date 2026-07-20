# Resume from Event Log (/goal-mode crash recovery)

A user-initiated pause sets the cursor to `status: paused` (see the Pause/Resume section in SKILL.md). A /goal-mode interruption — Esc mid-loop, escalation halt, budget exhaustion, session crash without a clean pause — leaves no explicit resume note. The event log at `<SHIPYARD_DATA>/.shipyard-events.jsonl` is the source of truth instead.

When `/ship-execute` re-enters with a non-paused cursor (or none) but a non-empty event log, run this protocol.

## Protocol

1. **Find the last clean wave checkpoint.** Read the event log tail. The most recent `wave_check_passed` event names the last wave that completed all six wave-completion invariants. Anything after that is suspect.

   ```text
   shipyard-context scan-events --tail 1000 wave_check_passed
   ```

   The last line of output is the canonical checkpoint. If no `wave_check_passed` events exist (sprint hasn't completed a wave yet), the resume is "re-enter from wave 1, treat every task as suspect."

2. **Find the last task that landed.** The most recent `task_dispatch_returned` (with `status=complete`) / `operational_task_completed` event tells you the last task whose return the orchestrator gate accepted.

   ```text
   shipyard-context scan-events --tail 1000 task_dispatch_returned operational_task_completed
   ```

3. **Cross-check the registry.** Read SPRINT.md + each task file. Any task `status: done` AFTER the last completion event in the log is suspect — the registry can lie (manual edit, partial write); the event log is append-only and authoritative.

   For each suspect task, prefer the event log's verdict. If a task is `status: done` in the registry but has no `task_dispatch_returned status=complete` event in the log, treat it as not-done for resume purposes — but first check for a builder-side `subagent_completed status=complete` event plus its `.subagent-returns/<task>.json`: if those exist, the work is done and only the gate record is missing, so run the orchestrator gate on the `.json` (per `dispatching-task-loop`) instead of re-dispatching the whole task.

4. **Verify the last-clean-wave invariants.** Invoke `verifying-wave-completion` for the wave the event log says completed last, with `wakeup_budget: 0` (verify-only, no retry). If `STATUS: ESCALATED`, do NOT resume — surface the failed invariant to the user; manual intervention required.

   This step matters: the event log can record `wave_check_passed` correctly but the underlying state may have drifted (worktrees re-modified, registry hand-edited). The verifier re-checks the invariants against current state.

5. **Re-dispatch incomplete tasks in the current wave.** For each task in the current wave (the wave AFTER the last `wave_check_passed`) without a `task_dispatch_returned status=complete` event — and without a gateable `subagent_completed` + `.json` return per step 3 — re-dispatch via `dispatching-task-loop` with `continuation_note: "previous attempt did not return; resumed from event log"`. **Skip tasks already parked:** a task with a `task_blocked` (or `task_dispatch_returned status=blocked`) event settled deliberately on its prior run and was handed to review — do not re-dispatch it, or resume will loop on a task the pipeline already gave up on.

6. **Continue from there.** Once the current wave is finished re-dispatching, normal wave-boundary check + completion gate runs, and execution proceeds.

## Why this beats "resume from PROGRESS.md"

PROGRESS.md is for humans; the event log is for machines. /goal-mode resume reads the machine surface specifically because:

- **PROGRESS.md is mutable by hand** — a user (or a previous session) might have edited it to reflect *intended* state. The event log records *actual* state at the moment events happened.
- **PROGRESS.md is summary-shaped** — "Wave 2 in progress, 3 of 5 tasks done." The event log carries the actual task IDs and structured data needed to identify the missing tasks.
- **PROGRESS.md doesn't capture failure modes** — the event log carries silent-failure markers, escalations, and the specific reason an interruption happened. Resume can match the recovery action to the failure shape.

PROGRESS.md is still the right surface for the user to glance at — *"where are we in the sprint?"* — and it stays current because the renderer regenerates it from the event log on every cursor write (no one writes it by hand). It just isn't the right surface for crash-recovery state reconstruction.

## When the event log is empty or corrupted

If the event log is empty (never initialized) OR malformed (cannot be parsed line-by-line as JSON), refuse to resume from event log. Possible causes:

- `/ship-init` never ran or was interrupted before the log was created.
- A non-atomic write left the log truncated.
- The plugin data dir was manually edited.

In any of these cases, fall back to:

1. Run `/ship-status --repair` to verify the project state matches SPRINT.md.
2. If state is consistent, re-enter `/ship-execute` from the start of the current wave (per the existing Compaction Recovery protocol).
3. If state is inconsistent, halt and surface to the user — manual intervention required.

## Interaction with a paused cursor

When the cursor is `status: paused` AND the event log is non-empty, the paused cursor takes precedence — its `stage:` and body note capture user-intent for the pause (which the event log doesn't). The event log is the fallback when the cursor was not cleanly paused (`status: in_progress` after a crash).

A clean shutdown should always `shipyard-data cursor pause execute --note …`. The event-log resume is for the cases where shutdown wasn't clean.
