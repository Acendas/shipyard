---
name: evaluating-sprint-complete
description: Use at sprint-boundary in /ship-execute to confirm the seven-invariant sprint-complete predicate holds across all waves.
disable-model-invocation: true
---

# Evaluating Sprint Complete

A sprint is complete only when seven invariants hold simultaneously. This skill is the gate `/ship-execute` runs after the last wave-completion verifier passes and before declaring the sprint shippable. It composes the wave-level guarantees into the sprint-level guarantee.

## When to Invoke

`/ship-execute` Step 5 (Sprint Completion) calls this skill after:

- The full-suite test command exits 0.
- The sprint-boundary verify-probe has completed and its capture is on disk.
- `/ship-review`'s Stage 0 multi-agent scanner pipeline has been invoked and converged (or escalated cleanly).

Other entry points:

- `/ship-review` may invoke this skill at the beginning of a sprint review as a fast pre-flight ("is this sprint actually done before I bother running the full review?").
- Manual invocation when a user wants to spot-check sprint completeness before declaring shippable.

## Inputs

- `sprint_id` — e.g., `sprint-003`
- `data_dir` — literal `<SHIPYARD_DATA>` path
- `working_branch` — git branch
- `sprint_base_sha` — working-branch HEAD when the sprint started (from SPRINT.md frontmatter `base_sha` or computed via `git merge-base`)
- `sprint_head_sha` — current HEAD
- `sprint_verify_capture` — path to the sprint-boundary verify-probe capture
- `sprint_verify_exit_code` — exit code from sprint-boundary verify
- `review_verdict_path` — path to the latest `/ship-review` verdict file (or null if review hasn't run)

## The Seven Invariants — Summary Table

Detailed per-invariant logic and primitives live in [references/invariants.md](references/invariants.md). Read that when implementing the skill; the summary below is for orientation.

| # | Invariant | Primitive |
|---|---|---|
| 1 | Every task has a commit_sha that exists AND is in `sprint_base_sha..sprint_head_sha` | `shipyard-context check-commit-exists` + `git merge-base --is-ancestor` |
| 2 | Sprint-boundary verify-probe exits 0 with non-empty capture | Read `sprint_verify_capture` + exit code param |
| 3 | Every linked spec item is `status: done` (or `released`) | Read feature frontmatter |
| 4 | Spec coverage shows no orphan AC for this sprint's slice | Search diff + linked-task probes for AC mapping |
| 5 | No silent-failure / loop-detected / bogus-pass / anti-stub / wave-escalated markers in window | `shipyard-context scan-events --tail 2000 silent_failure loop_detected operational_task_bogus_pass anti_stub_finding wave_check_escalated` |
| 6 | No uncommitted state in any `shipyard/wt-*` worktree | `shipyard-context check-dirty-worktrees` |
| 7 | Code-review verdict recommends approve or issues (not changes) | Read `review_verdict_path` frontmatter |

Invariant 7 is expected to FAIL on the first `/ship-execute` Step 5 invocation because `/ship-review` runs after — that's by design. The pre-review call surfaces invariants 1–6 before burning review time on a structurally incomplete sprint.

## The Predicate Aggregation

Evaluate all seven invariants in order (the caller can pass `short_circuit: true` to stop at the first FAIL, but the default is full evaluation so the caller sees the complete picture):

```text
Run invariants 1..7.
Aggregate:
  All PASS         → emit sprint_complete_passed; return STATUS: COMPLETE.
  Any FAIL         → emit sprint_complete_failed with the failing invariant list;
                     return STATUS: INCOMPLETE with per-invariant detail.
```

This skill does NOT do recovery. Unlike `verifying-wave-completion` (which tries to self-heal at the wave boundary), sprint-complete failure halts cleanly — recovery is the user's call at this layer.

## Required Return Shape

The orchestrator parses these lines exactly:

```
STATUS: COMPLETE
SPRINT: <sprint_id>
INVARIANTS_PASSED: 1,2,3,4,5,6,7
```

OR:

```
STATUS: INCOMPLETE
SPRINT: <sprint_id>
INVARIANTS_FAILED: <comma-separated list>
DETAILS:
  invariant_1: <one-line summary if failed>
  invariant_2: <...>
  ...
```

Concrete examples of both return shapes live in [examples/](examples/).

## Event Log Emissions

The events this skill emits and their fields are catalogued in [event-types.md](../dispatching-operational-task/references/event-types.md) under "Emitted by `evaluating-sprint-complete`". Use names from the catalog rather than inventing variants inline.

## Integration With Other Skills

- **Routing.** `/ship-execute` Step 5 invokes this skill as the final gate before flipping the sprint to `status: completed`. STATUS: INCOMPLETE halts the sprint — the user sees the failing invariants and decides next action.
- **`verifying-wave-completion`** is the wave-level analog. The two compose: wave-completion guards advance-past-a-wave; sprint-complete guards declare-sprint-done.
- **`verifying-completion`** is the per-claim Iron Law (don't claim done without running the verifier). This skill IS the sprint-level verifier.
- **`/ship-review`** runs before this skill in the natural flow — review verdict is invariant 7's input.

## Why This Skill Exists

The wave-completion verifier catches wave-level silent-advance. But "every wave passed its own gate" doesn't imply "the sprint is shippable":

1. Wave-level checks don't verify feature `status: done` (waves don't deliver complete features).
2. Wave-level checks don't verify spec coverage for the sprint's slice (AC orphans accumulate across waves).
3. Wave-level checks don't verify the sprint-boundary probe (broader than wave-probe — full suite + integration).
4. Wave-level checks don't verify review-pipeline completion (review runs at sprint level only).

This skill closes those gaps. Without it, sprint-level `/goal` would advance past the last wave straight to "sprint complete" with the same blind spots that wave-level `/goal` had before `verifying-wave-completion` shipped.

## Bottom Line

- Seven invariants. All PASS for sprint-complete. See [references/invariants.md](references/invariants.md) for detail.
- No recovery — fail cleanly with per-invariant detail. User decides next action.
- `/ship-execute` Step 5 runs this AFTER existing full-suite test and review pipeline.
- Composes with `verifying-wave-completion`: wave-level guards wave-to-wave; sprint-level guards declare-done.
