---
paths: ["src/**/*", "app/**/*", "lib/**/*"]
---

# Task Execution Rules

When executing sprint tasks:

## Mandatory Process
1. **Read task spec first** — understand the acceptance criteria (Given/When/Then) before writing any code.
2. **Read codebase context** — check existing patterns, imports, conventions in `$(shipyard-data)/codebase-context.md` and memory.
3. **Follow TDD** — Red → Green → Refactor → Mutate → Visual Verify (if UI).
4. **Atomic commits** — one commit per task. Message format: `feat(TASK_ID): description` or `fix(TASK_ID): description`.
5. **Update progress** — after each task, update `$(shipyard-data)/sprints/current/PROGRESS.md`.

## Never Assume, Always Ask
- When spec is ambiguous → AskUserQuestion with options and your recommendation.
- When implementation has multiple valid approaches → AskUserQuestion.
- When a decision affects architecture → AskUserQuestion. Never make architectural decisions silently.

## What NOT to Ask About
- Code style → read CLAUDE.md and .claude/rules/
- Technology choices → read spec technical notes and $(shipyard-data)/config.md
- Previously made decisions → read feature decision log and memory

## Scope Discipline
- If it's not in the acceptance criteria, don't build it.
- If you discover a gap, create a patch task — don't expand the current task.
- If the task takes >2x the estimate, pause and reassess — don't over-build.

## Blocked Tasks
- Try to self-resolve within task scope (< 5 min).
- If blocked, immediately AskUserQuestion with: what's blocking, what you tried, options.
- While waiting, move to next unblocked task if available.
