---
name: verifying-wave-completion
description: Use after every wave dispatch in /ship-execute to confirm the wave is fully complete across six invariants — not just that the wave-scoped probe passed.
disable-model-invocation: true
---

# Verifying Wave Completion

A passing wave-scoped probe is necessary but not sufficient. The wave is fully complete only when six invariants hold simultaneously. This capability skill runs that composite check after the existing wave-boundary steps (rebase + ff-merge, wave-scoped build, REFACTOR + MUTATE, wave-scoped tests, wave VERIFY) and gates advance-to-next-wave on the result.

The check exists because the structured return contract makes false completion structurally hard at the *subagent* boundary, but the *wave* boundary is one level up — and pre-this-skill, the only gate there was a single probe pass. A flaky test, a dropped commit, or a subagent that exited mid-flight without writing its completion event could all slip through.

## When to Invoke

`/ship-execute` Step 4 calls this skill as the final gate before advancing the wave counter, AFTER the existing in-line checks have all reported green. Job: confirm the composite picture matches the per-step verdicts.

Other entry points:

- `/ship-review` Stage 1 (sprint-level) may invoke this as a per-wave audit when re-running review on an archived sprint.
- Manual invocation when a user wants to confirm a specific wave is truly complete before advancing.

## Inputs

- `wave_number` — e.g., `2`
- `task_ids` — list of task IDs dispatched in this wave, e.g., `["T-042", "T-043", "T-044"]`
- `data_dir` — literal `<SHIPYARD_DATA>` path
- `working_branch` — git branch
- `wave_base_sha` — working-branch HEAD BEFORE the wave started (set by `/ship-execute` at wave entry)
- `wave_head_sha` — working-branch HEAD AFTER the wave's merges (set after the rebase + ff-merge step)
- `wave_probe_capture` — path to the wave-scoped test capture file
- `wave_probe_exit_code` — exit code from the wave-scoped test run
- `wakeup_budget` — number of recovery wakeups before escalation. Default `3`.
- `wakeup_delay_seconds` — delay per wakeup. Default `180` (warm-cache window — see [schedule-wakeup-discipline.md](../dispatching-operational-task/references/schedule-wakeup-discipline.md)).

## The Six Invariants — Summary Table

Detailed per-invariant logic, primitives, and recovery actions live in [references/invariants.md](references/invariants.md). Read that when implementing the skill; the summary below is for orientation.

| # | Invariant | Primitive | Recovery shape |
|---|---|---|---|
| 1 | All dispatched builders returned a structured contract | `shipyard-context scan-events --tail 500 task_loop_iteration task_dispatch_returned` | Re-dispatch tasks missing a return event |
| 2 | Every claimed commit_sha exists in git AND is in `wave_base_sha..wave_head_sha` | `shipyard-context check-commit-exists <sha>` + `git merge-base --is-ancestor` | Re-dispatch the affected task |
| 3 | Wave-boundary verify-probe exits 0 with non-empty capture showing a real verdict | Read `wave_probe_capture` + the exit code parameter | Re-run via `dispatching-operational-task`; if second run passes with different failure signature, treat as flaky |
| 4 | Event log shows wave-task-complete events for every task | `shipyard-context scan-events --tail 500 task_loop_completed operational_task_completed` | Self-heal: orchestrator emits the missing event with `recovered=true` |
| 5 | No silent-failure markers in the wave's event-log window | `shipyard-context scan-events --tail 500 silent_failure loop_detected operational_task_bogus_pass anti_stub_finding` | None — confirmed marker tied to a complete task always ESCALATES |
| 6 | No uncommitted state across any `shipyard/wt-*` worktree | `shipyard-context check-dirty-worktrees` | None for in-flight-looking work — ESCALATE; stale-salvage pattern self-heals |

## The Loop

```text
Iteration 0:
  Run invariants 1..6 in order.
  Aggregate verdict:
    All PASS         → emit wave_check_passed; return STATUS: COMPLETE.
    Any ESCALATE     → emit wave_check_escalated; return STATUS: ESCALATED with details.
    Otherwise RECOVERABLE:
      Dispatch the recovery action for each RECOVERABLE invariant.
      Emit wave_check_recoverable with the per-invariant detail.

For iteration 1..wakeup_budget:
  ScheduleWakeup(delaySeconds: wakeup_delay_seconds, reason: "wave-<N> check retry <iter>", prompt: <re-enter this skill>).
  On wake: re-run invariants 1..6.
  Same aggregation; if PASS, return COMPLETE; if any ESCALATE, return ESCALATED.

If wakeup_budget exhausted with RECOVERABLE still outstanding:
  Emit wave_check_escalated with reason: "exhausted_wakeup_budget".
  Return STATUS: ESCALATED.
```

The cache-TTL rules for picking `wakeup_delay_seconds` are documented in [schedule-wakeup-discipline.md](../dispatching-operational-task/references/schedule-wakeup-discipline.md). Default 180s sits in the warm-cache window — three wakeups burn no cache and give ~9 minutes of recovery time.

## Required Return Shape

The orchestrator parses these lines exactly:

```
STATUS: COMPLETE
WAVE: <wave_number>
INVARIANTS_PASSED: <comma-separated list, e.g., 1,2,3,4,5,6>
ITERATIONS_RUN: <integer>
```

OR:

```
STATUS: ESCALATED
WAVE: <wave_number>
INVARIANTS_FAILED: <comma-separated list>
REASON: <one paragraph: what's still broken and why>
ITERATIONS_RUN: <integer>
RECOVERABLE_INVARIANTS: <list of invariants the skill attempted to recover from>
```

The orchestrator does NOT re-verify the skill's verdict — this skill IS the gate. Its structured return is authoritative for advancing past the wave.

Concrete examples of both return shapes live in [examples/](examples/).

## Event Log Emissions

The events this skill emits and their fields are catalogued in [event-types.md](../dispatching-operational-task/references/event-types.md) under "Emitted by `verifying-wave-completion`". Use names from the catalog rather than inventing variants inline.

## Integration With Other Skills

- **Routing.** `/ship-execute` Step 4 invokes this skill as the final gate before advancing the wave counter. `STATUS: ESCALATED` → AskUserQuestion with the `REASON:` text.
- **`verifying-completion`** is the per-task / per-claim Iron Law. This skill is the wave-level analog — same idea (evidence before claims) at the next layer up.
- **`dispatching-task-loop`** is invoked by this skill's recovery actions when invariants 1, 2, or 4 produce a RECOVERABLE verdict tied to a specific task. Single re-dispatch per task per wave (same rule that lives in `dispatching-task-loop`'s orchestrator gate).
- **`dispatching-operational-task`** is invoked for invariant 3 flake detection (re-run the wave-scoped test command in a fresh dispatch).
- **`acquiring-skill-lock`** is held by the calling command skill; this skill doesn't acquire its own.

## Why This Skill Exists

Pre-this-skill, `/ship-execute` Step 4 advanced the wave counter as soon as the wave-scoped test command exited 0. Six failure modes could slip through:

1. Builder mid-flight death — subagent crashes, orchestrator timeouts.
2. Commit propagation drops — `COMMIT: <sha>` returned but the merge-back didn't include that sha.
3. Flaky pass on first run — wave-scoped test happens to pass once; subsequent runs would fail.
4. Missing completion event — subagent succeeded but didn't emit `task_loop_completed`.
5. Silent-failure marker ignored — anti-stub-scan emitted a finding but no skill checked for it.
6. Stale worktree leftover — merge-back missed a worktree; its branch is orphaned.

The six-invariant gate makes each structurally observable at the wave boundary, when recovery is cheapest. Catching a missing commit one wave later means re-running tests on top of subsequent work; catching it immediately means a clean re-dispatch.

## Bottom Line

- After existing wave-boundary checks pass, run six invariants — see [references/invariants.md](references/invariants.md) for the detail.
- RECOVERABLE → automatic recovery dispatch + ScheduleWakeup (default 180s, warm-cache window).
- ESCALATE → halt, AskUserQuestion with reason. Don't advance the wave counter.
- All PASS → wave_check_passed event, advance.
- Wakeup budget default 3; cap exhaustion is itself an escalation.
