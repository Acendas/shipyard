# Resume from Event Log (/goal-mode crash recovery)

A user-initiated pause writes HANDOFF.md (see the Pause/Resume section in SKILL.md). A /goal-mode interruption — Esc mid-loop, escalation halt, budget exhaustion, session crash without HANDOFF.md — leaves no hand-written artifact. The event log at `<SHIPYARD_DATA>/.shipyard-events.jsonl` is the source of truth instead.

When `/ship-execute` re-enters without HANDOFF.md but with a non-empty event log, run this protocol.

## Protocol

1. **Find the last clean wave checkpoint.** Read the event log tail. The most recent `wave_check_passed` event names the last wave that completed all six wave-completion invariants. Anything after that is suspect.

   ```text
   shipyard-context scan-events --tail 1000 wave_check_passed
   ```

   The last line of output is the canonical checkpoint. If no `wave_check_passed` events exist (sprint hasn't completed a wave yet), the resume is "re-enter from wave 1, treat every task as suspect."

2. **Find the last task that landed.** The most recent `task_loop_completed` / `operational_task_completed` event tells you the last task whose subagent returned cleanly.

   ```text
   shipyard-context scan-events --tail 1000 task_loop_completed operational_task_completed
   ```

3. **Cross-check the registry.** Read SPRINT.md + each task file. Any task `status: done` AFTER the last completion event in the log is suspect — the registry can lie (manual edit, partial write); the event log is append-only and authoritative.

   For each suspect task, prefer the event log's verdict. If a task is `status: done` in the registry but has no `task_loop_completed` event in the log, treat it as not-done for resume purposes.

4. **Verify the last-clean-wave invariants.** Invoke `verifying-wave-completion` for the wave the event log says completed last, with `wakeup_budget: 0` (verify-only, no retry). If `STATUS: ESCALATED`, do NOT resume — surface the failed invariant to the user; manual intervention required.

   This step matters: the event log can record `wave_check_passed` correctly but the underlying state may have drifted (worktrees re-modified, registry hand-edited). The verifier re-checks the invariants against current state.

5. **Re-dispatch incomplete tasks in the current wave.** For each task in the current wave (the wave AFTER the last `wave_check_passed`) without a `task_loop_completed` event, re-dispatch via `dispatching-task-loop` with `continuation_note: "previous attempt did not return; resumed from event log"`.

6. **Continue from there.** Once the current wave is finished re-dispatching, normal wave-boundary check + completion gate runs, and execution proceeds.

## Why this beats "resume from PROGRESS.md"

PROGRESS.md is for humans; the event log is for machines. /goal-mode resume reads the machine surface specifically because:

- **PROGRESS.md is mutable by hand** — a user (or a previous session) might have edited it to reflect *intended* state. The event log records *actual* state at the moment events happened.
- **PROGRESS.md is summary-shaped** — "Wave 2 in progress, 3 of 5 tasks done." The event log carries the actual task IDs and structured data needed to identify the missing tasks.
- **PROGRESS.md doesn't capture failure modes** — the event log carries silent-failure markers, escalations, and the specific reason an interruption happened. Resume can match the recovery action to the failure shape.

PROGRESS.md is still the right surface for the user to glance at — *"where are we in the sprint?"* — and for the orchestrator to update with human-readable status during normal flow. It just isn't the right surface for crash-recovery state reconstruction.

## When the event log is empty or corrupted

If the event log is empty (never initialized) OR malformed (cannot be parsed line-by-line as JSON), refuse to resume from event log. Possible causes:

- `/ship-init` never ran or was interrupted before the log was created.
- A non-atomic write left the log truncated.
- The plugin data dir was manually edited.

In any of these cases, fall back to:

1. Run `/ship-status --repair` to verify the project state matches SPRINT.md.
2. If state is consistent, re-enter `/ship-execute` from the start of the current wave (per the existing Compaction Recovery protocol).
3. If state is inconsistent, halt and surface to the user — manual intervention required.

## Interaction with HANDOFF.md

When both HANDOFF.md exists AND the event log is non-empty, HANDOFF.md takes precedence — it captures user-intent for the pause (which the event log doesn't). The event log is the fallback when HANDOFF.md is missing.

A clean shutdown should always write HANDOFF.md. The event-log resume is for the cases where shutdown wasn't clean.
