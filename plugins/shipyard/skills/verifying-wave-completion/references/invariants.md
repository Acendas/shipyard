# Wave-Completion Invariants — Detailed Reference

Six invariants, each with PASS / RECOVERABLE / ESCALATE verdicts. Recovery actions per RECOVERABLE state are bounded by the wakeup budget passed to the skill (default 3 wakeups at 180s — see `../../dispatching-operational-task/references/schedule-wakeup-discipline.md`).

The deterministic primitives that back these checks live in the `shipyard-context` CLI — using them instead of inline git/jq prose makes the verdicts script-verifiable.

## Invariant 1 — All dispatched builders returned a structured contract

**What it checks.** For each task ID in `task_ids`, the event log contains at least one structured-return event (`task_loop_iteration` for in-progress proof of life, `task_dispatch_returned` for the final return) since `wave_base_sha`.

**Primitive.**

```text
shipyard-context scan-events --tail 500 task_loop_iteration task_dispatch_returned
```

Parse the JSONL output; group by `task` field; for each expected task ID, confirm at least one event present.

**Verdicts.**

- **PASS** — every expected task ID has a return event.
- **RECOVERABLE** — one or more task IDs have no return event (subagent died mid-flight, orchestrator timed out). Recovery: dispatch a fresh `dispatching-task-loop` for each missing task with `continuation_note: "previous attempt did not return"`.
- **ESCALATE** — all builders missing returns despite multiple wakeups; structural problem with subagent dispatch. Halt.

## Invariant 2 — Every claimed commit_sha exists in git

**What it checks.** For each task with a `task_dispatch_returned` event carrying `status="complete"`, extract `commit_sha` and confirm it's reachable from `wave_head_sha`.

**Primitive.**

```text
shipyard-context check-commit-exists <sha>
# exit 0 = sha exists; stdout = resolved sha
# exit 1 = sha missing; stdout = "missing"
```

For range membership (sha must be in `wave_base_sha..wave_head_sha`), additionally run `git merge-base --is-ancestor <sha> <wave_head_sha>` and `! git merge-base --is-ancestor <sha> <wave_base_sha>`.

**Verdicts.**

- **PASS** — every claimed commit exists in `wave_base_sha..wave_head_sha`.
- **RECOVERABLE** — one or more commits absent (subagent's worktree was cleaned before merge-back; merge-back missed a commit). Recovery: re-dispatch the affected task.
- **ESCALATE** — repeated commit-disappearance across recovery attempts indicates a worktree-merge regression. Halt.

## Invariant 3 — Wave-boundary verify-probe passes

**What it checks.** `wave_probe_exit_code == 0` AND `wave_probe_capture` is non-empty AND its last 50 lines show a real verdict line (not just startup noise).

**Primitive.** Direct Read on the capture file plus the exit code parameter. There's no separate CLI primitive — the check is just file inspection.

Flake detection: if exit code is non-zero with a failure pattern matching common-flake signatures (timeout, "intermittent", retry-then-pass), dispatch a fresh `dispatching-operational-task` to re-run the same verify command. If the second run passes AND its failure pattern differs from the first, treat as flaky.

**Verdicts.**

- **PASS** — exit 0 + non-empty capture + visible verdict.
- **RECOVERABLE** — non-zero exit with a recognized flake signature. Recovery: re-run the verify command via `dispatching-operational-task`. If second run passes, emit `wave_check_flake_suspected` (per the event catalog) and mark this invariant PASS for advancement purposes.
- **ESCALATE** — non-zero on second run. The regression is real.

## Invariant 4 — Wave-task-complete events for every task

**What it checks.** For each task in `task_ids`, the event log contains a `task_loop_completed` event (kind:feature) or `operational_task_completed` event (kind:operational) since `wave_base_sha`.

**Primitive.**

```text
shipyard-context scan-events --tail 500 task_loop_completed operational_task_completed
```

**Verdicts.**

- **PASS** — every task has a completion event.
- **RECOVERABLE** — a task has a `task_dispatch_returned` with `status="complete"` but no completion event (the subagent forgot to emit). Recovery: the orchestrator emits the missing event itself, marked `recovered=true`, with the structured-return payload. Self-healing — emit and advance.
- **ESCALATE** — completion event absent AND structured return absent — task never finished. Re-dispatch.

## Invariant 5 — No silent-failure or loop-detected markers in window

**What it checks.** No events of type `silent_failure`, `loop_detected`, `operational_task_bogus_pass`, or `anti_stub_finding` in the wave's event-log window.

**Primitive.**

```text
shipyard-context scan-events --tail 500 silent_failure loop_detected operational_task_bogus_pass anti_stub_finding
```

Filter the output to events with timestamps after `wave_base_sha`'s corresponding wave-start event.

**Verdicts.**

- **PASS** — no markers in the window.
- **RECOVERABLE** — a marker with a `task_id` that's still in flight (race: marker emitted while subagent was finishing). Recovery: re-check after the next ScheduleWakeup; the in-flight task will have settled by then.
- **ESCALATE** — one or more confirmed markers tied to completed tasks. Do NOT advance the wave. Surface marker details to the user via AskUserQuestion.

## Invariant 6 — No uncommitted state in any builder worktree

**What it checks.** No `shipyard/wt-*` worktree has uncommitted changes after the wave-boundary cleanup ran.

**Primitive.**

```text
shipyard-context check-dirty-worktrees
# stdout = one absolute path per dirty shipyard/wt-* worktree
# empty stdout = all clean
# exit 0 always — output is the result
```

**Verdicts.**

- **PASS** — no leftover worktrees, or leftover worktrees have clean trees.
- **RECOVERABLE** — uncommitted state matching a recognized salvage pattern (next session's Step 0 worktree-salvage handles it). Recovery: emit `wave_check_worktree_leftover` and proceed; the next session recovers.
- **ESCALATE** — uncommitted state that looks like in-flight work, not stale salvage. Halt and surface.

## Aggregation

After running all six invariants, aggregate:

```text
All PASS                 → emit wave_check_passed; return STATUS: COMPLETE.
Any ESCALATE             → emit wave_check_escalated; return STATUS: ESCALATED.
Otherwise (RECOVERABLE)  → dispatch each invariant's recovery action;
                           emit wave_check_recoverable;
                           ScheduleWakeup, re-enter the skill.
```

After `wakeup_budget` exhausted with RECOVERABLE still outstanding: emit `wave_check_escalated` with `reason: "exhausted_wakeup_budget"`, return ESCALATED.
