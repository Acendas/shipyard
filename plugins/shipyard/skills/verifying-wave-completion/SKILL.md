---
name: verifying-wave-completion
description: Verify wave completion across six invariants.
disable-model-invocation: true
---

# Verifying Wave Completion

**Render before asking.** Render the decision context as chat text before any AskUserQuestion (rules printed at startup under SHIPYARD_STARTUP_RULES).

A passing wave-scoped probe is necessary but not sufficient. The wave is fully complete only when six invariants hold simultaneously. This capability skill runs that composite check after the existing wave-boundary steps (rebase + ff-merge, wave-scoped build, REFACTOR + MUTATE, wave-scoped tests, wave VERIFY) and gates advance-to-next-wave on the result.

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

## The Six Invariants

Per-invariant checks, primitives and recovery actions are in [references/invariants.md](references/invariants.md); read it before running the skill.

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

Default 180s sits in the warm-cache window (rules in [schedule-wakeup-discipline.md](../dispatching-operational-task/references/schedule-wakeup-discipline.md)).

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

- **Routing.** `/ship-execute` Step 4 invokes this skill as the final gate before advancing the wave counter. `STATUS: ESCALATED` → render the `REASON:` text and the failing invariant's evidence (event names, task ids, branch names) as chat text, then AskUserQuestion. The skill return and event-log reads are context-only and do not count as shown, nor does packing the reason into the question string.
- **`verifying-completion`** is the per-task / per-claim Iron Law. This skill is the wave-level analog — same idea (evidence before claims) at the next layer up.
- **`dispatching-task-loop`** is re-dispatched by this skill's recovery actions when invariants 1, 2, or 4 produce a RECOVERABLE verdict tied to a specific task. Single re-dispatch per task per wave (same rule that lives in `dispatching-task-loop`'s orchestrator gate).
- **`dispatching-operational-task`** is dispatched for invariant 3 flake detection (re-run the wave-scoped test command in a fresh dispatch).
- **`acquiring-skill-lock`** is held by the calling command skill; this skill doesn't acquire its own.
