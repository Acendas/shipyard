# Resume from Event Log (/goal-mode crash recovery)

A user-initiated pause sets the cursor to `status: paused` (see `pipeline-wave.md` § Recovery & resume, Pause / resume row). A /goal-mode interruption — Esc mid-loop, escalation halt, budget exhaustion, session crash without a clean pause — leaves no explicit resume note. The event log at `<SHIPYARD_DATA>/.shipyard-events.jsonl` is the source of truth instead.

When `/ship-execute` re-enters with a non-paused cursor (or none) but a non-empty event log, run this protocol.

## Protocol

1. **Find the last clean wave checkpoint.** Read the event log tail. The most recent `wave_check_passed` event names the last wave that completed all six wave-completion invariants. Anything after that is suspect.

   ```text
   shipyard-context scan-events --tail 1000 wave_check_passed
   ```

   The last line is the checkpoint; with none, re-enter from wave 1 and treat every task as suspect.

2. **Find the last task that landed.** The most recent `task_dispatch_returned` (with `status=complete`) / `operational_task_completed` event tells you the last task whose return the orchestrator gate accepted.

   ```text
   shipyard-context scan-events --tail 1000 task_dispatch_returned operational_task_completed
   ```

3. **Cross-check the registry.** Read SPRINT.md + each step file. Any task `status: done` AFTER the last completion event in the log is suspect — the registry can lie (manual edit, partial write); the event log is append-only and authoritative.

   For each suspect task, prefer the event log's verdict. If a task is `status: done` in the registry but has no `task_dispatch_returned status=complete` event in the log, treat it as not-done for resume purposes — but first check for a builder-side `subagent_completed status=complete` event plus its `.subagent-returns/<task>.json`: if those exist, the work is done and only the gate record is missing, so run the orchestrator gate on the `.json` (per `dispatching-task-loop`) instead of re-dispatching the whole task.

4. **Verify the last-clean-wave invariants.** Follow the `verifying-wave-completion` playbook for the wave the event log says completed last, with `wakeup_budget: 0` (verify-only, no retry). If `STATUS: ESCALATED`, do NOT resume — surface the failed invariant to the user; manual intervention required.

5. **Re-dispatch incomplete tasks in the current wave.** For each task in the current wave (the wave AFTER the last `wave_check_passed`) without a `task_dispatch_returned status=complete` event — and without a gateable `subagent_completed` + `.json` return per step 3 — re-dispatch via `dispatching-task-loop` (entering `wave_<N>_redispatch_iter_1` with `--trigger recovery --force` per the task-dispatch.md handler) with `continuation_note: "previous attempt did not return; resumed from event log"`. **Skip tasks already parked:** a task with a `task_blocked` (or `task_dispatch_returned status=blocked`) event settled deliberately on its prior run and was handed to review — do not re-dispatch it, or resume will loop on a task the pipeline already gave up on.

6. **Continue.** The normal wave-boundary check and completion gate run next.

## When the event log is empty or corrupted

If the event log is empty (never initialized) OR malformed (cannot be parsed line-by-line as JSON), refuse to resume from event log. Fall back to:

1. Run `/ship-status --repair` to verify the project state matches SPRINT.md.
2. If state is consistent, re-enter `/ship-execute` from the start of the current wave (per the Compaction recovery row of `pipeline-wave.md` § Recovery & resume).
3. If state is inconsistent, halt and surface to the user — manual intervention required.

## Interaction with a paused cursor

A paused cursor wins over a non-empty event log: its `stage:` and note record user intent the log lacks. The log is the fallback for an unclean stop (`status: in_progress` after a crash).
