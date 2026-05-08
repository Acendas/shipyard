# Code Review Orchestration

The full contract for code review dispatch lives in the **`shipyard:dispatching-code-review`** capability skill. See `skills/dispatching-code-review/SKILL.md`.

## Quick summary

`/ship-review` Stage 0 runs code review on the sprint's diff via `dispatching-code-review`. The capability skill takes a `concerns` array and activates only the requested concern sections in its prompt:

- `security`, `bugs`, `silent-failures`, `patterns`, `tests`, optional `observability`.

`shipyard:dispatching-spec-review` handles spec compliance separately ("did we deliver what was specified?" vs "is the delivery any good?").

## Parallel dispatch for high-stakes reviews

For release-bound changes or large diffs touching auth/payments/data, `/ship-review` may invoke `dispatching-code-review` multiple times in parallel with non-overlapping `concerns` arrays:

- Subagent A: `concerns: ["security"]`
- Subagent B: `concerns: ["bugs", "silent-failures"]`
- Subagent C: `concerns: ["patterns", "tests"]`

Each runs in its own context window for concurrent depth. Results merge orchestrator-side. More tokens for better depth — opt-in.

## Confidence threshold

Findings at confidence ≥ 80 block; 60–80 advisory; security ≥ 90 auto-redispatches via `dispatching-task-loop`. See `skills/dispatching-code-review/SKILL.md` for the full action rules.
