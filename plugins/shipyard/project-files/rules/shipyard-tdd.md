---
paths: ["src/**/*", "app/**/*", "lib/**/*", "test/**/*", "tests/**/*", "__tests__/**/*", "spec/**/*.test.*", "spec/**/*.spec.*"]
---

# TDD Rules (Loaded When Agent Reads Source Files)

These rules are non-negotiable during task execution:

1. **Write failing tests BEFORE implementation** — no implementation code before a failing test exists.
2. **Never modify assertions to pass** — if a test fails, fix the implementation, not the test. The only exception: the test itself has a bug (wrong assertion logic).
3. **Mutation testing after Green** — mutate a key line of implementation (flip conditional, change value). At least one test must catch it. If none do, add edge case tests.
4. **Mock external dependencies only** — never mock your own code. Mock APIs, databases, third-party services.
5. **Test naming** — `should [expected behavior] when [condition]` (e.g., `should return error when password is empty`).
6. **Bottom-up build order** — data layer → domain logic → server actions/API → UI components. Write tests at each layer before moving up.
7. **Every acceptance scenario maps to at least one test** — unit for logic, integration for boundaries, E2E for full flows.
8. **Commit includes both test and implementation** — never commit implementation without its tests.
9. **Git ownership before dismissing failures** — before calling any test failure "pre-existing" or "not my code", run `git diff --name-only $(git merge-base HEAD main)...HEAD`. If the failing test file is on this branch, YOU own it — fix the implementation, not the test. Auto-compaction may wipe your memory of writing it, but git never forgets.
