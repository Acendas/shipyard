# Code Review Orchestration

**Status:** This reference is superseded by the **`shipyard:dispatching-code-review`** capability skill. See `skills/dispatching-code-review/SKILL.md` for the full contract.

## What this reference used to cover

Stage 0 of `/ship-review` ran six specialized scanner agents in parallel — `shipyard:shipyard-review-security`, `-bugs`, `-silent-failures`, `-patterns`, `-tests`, `-spec` — and conditionally a `shipyard:shipyard-investigator` for high-stakes findings. This file documented the parallel orchestration, per-scanner inputs, and merge process.

## What replaces it in 2.0

The six scanners collapse into one capability skill with a `concerns` array (per F-27):

- `shipyard:dispatching-code-review` covers `security`, `bugs`, `silent-failures`, `patterns`, `tests`, and optional `observability`. Caller picks the subset; the prompt activates only those sections.
- `shipyard:dispatching-spec-review` covers spec compliance separately (different semantic — "did we deliver?" vs "is the delivery any good?").
- The investigator role is no longer a registered agent; high-stakes investigation happens inside the relevant capability skill's loop or via a one-off `general-purpose` dispatch with the investigation prompt inlined.

## Parallel dispatch for high-stakes reviews

For release-bound changes or large diffs touching auth/payments/data, `/ship-review` may invoke `dispatching-code-review` multiple times in parallel with non-overlapping `concerns` arrays:

- Subagent A: `concerns: ["security"]`
- Subagent B: `concerns: ["bugs", "silent-failures"]`
- Subagent C: `concerns: ["patterns", "tests"]`

Each runs in its own context window for genuine concurrent depth. Results merge orchestrator-side. This is a tradeoff — more tokens for better depth — and is opt-in.

## Confidence threshold

Findings at confidence ≥ 80 block; 60–80 advisory; security ≥ 90 auto-redispatches via `dispatching-task-loop`. See `skills/dispatching-code-review/SKILL.md` for the full action rules.

## Migration

Any caller previously orchestrating the six review-* scanners individually should now invoke `shipyard:dispatching-code-review` once with the appropriate `concerns` array. Spec-compliance work goes through `shipyard:dispatching-spec-review`.

This file is scheduled for full deletion in Sprint 4 per F-43; it remains as a thin redirect during the transition window.
