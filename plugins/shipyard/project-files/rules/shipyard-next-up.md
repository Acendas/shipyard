---
alwaysApply: true
---

# Next Up Format (Context Clearing at Workflow Boundaries)

Every Shipyard skill that completes a major workflow MUST end with a "Next Up" block. This serves two purposes:
1. Tells the user exactly what to do next
2. Recommends `/clear` before the next command for a fresh context window

## Why Clear Between Skills

Each major Shipyard skill (discuss, sprint, execute, review, retro, release) is a distinct workflow that uses significant context. Planning context is useless during execution. Execution context is useless during review. Clearing between them gives each skill a fresh 200k token budget to work with.

State is preserved in `$(shipyard-data)/` files (PROGRESS.md, HANDOFF.md, spec files, config). Clearing is always safe.

## Standard Format

After completing a workflow, always end with:

```
▶ NEXT UP: [action description]
  /ship-[command] [args if any]
  (tip: /clear first for a fresh context window)
```

## Transition Map

| After completing... | Next Up |
|---------------------|---------|
| `/ship-init` | `/ship-discuss` to define features |
| `/ship-discuss` (feature approved) | `/ship-sprint` to plan a sprint, or `/ship-discuss` for more features |
| `/ship-sprint` | `/ship-execute` to start building |
| `/ship-execute` (sprint done) | `/ship-review` to verify work + retrospective |
| `/ship-review` (approved + retro + released) | `/ship-discuss` for new features, or `/ship-sprint` to plan next sprint |
| `/ship-debug` (resolved) | Resume what you were doing before the bug |

**Important:** Shipyard does not manage branch merging or pushing. The user handles their own git workflow (merge, squash, PR, push) outside of Shipyard.

## When NOT to Suggest Clear

- Mid-conversation in `/ship-discuss` (still talking)
- Between tasks within a wave in `/ship-execute` (still executing)
- During interactive review in `/ship-review` (still demoing)
- Any time the user is in a conversational flow

Only suggest clear at **natural stopping points** — when one workflow is complete and the next one is a different type of work.
