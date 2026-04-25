# TDD Cycle Reference

The complete TDD cycle for every task. Fast mode (`--fast`) defers Phase 1 test execution to the wave boundary — TDD structure is preserved, only the timing of test runs changes.

## Two-Phase TDD Structure

Shipyard splits the TDD cycle across two execution phases. Each phase is a distinct builder invocation.

**Phase 1 — Per-task (RED → GREEN):** Each task builder's unit of work. Goal: get to a committed, test-passing implementation. Fast, focused, runs in parallel across tasks.

**Phase 2 — Wave-level (REFACTOR → MUTATE → VERIFY):** One builder invocation per wave, runs after all tasks are merged. Sees the full combined implementation. Handles cross-task concerns that individual builders can't see.

### Three-Tier Test Execution Strategy

| Tier | When | What Runs | Why |
|------|------|-----------|-----|
| **Task** | Phase 1 (RED/GREEN per task) | Only tests for the current task | Fast feedback, save tokens |
| **Wave** | Phase 2 (REFACTOR+MUTATE+VERIFY) + wave-scoped test runner | Scoped tests for wave files + cross-task mutation verification | Catch cross-task breakage; verify test quality across the combined implementation |
| **Regression** | Sprint completion / before release | Full build + full test suite (unit + integration + E2E) | Nothing is broken anywhere |

### How to scope tests for your task

During steps 4–7 below, run only the tests you wrote or that directly test the feature:

1. **By file path** — run test files in the same directory/module as the implementation
2. **By pattern** — use the `test_commands.scoped` command from config (e.g., `vitest run --testPathPattern auth`, `pytest -k "test_auth"`)
3. **By tag/describe block** — if the framework supports tags, scope to the feature's test tag

The goal: during a task, you should never wait for unrelated tests to run. Only run what matters for the code you're touching.

## Ownership Tracking (Preventing "Not My Code" After Compaction)

After several auto-compactions, you lose memory of files you wrote earlier in the session. A test you wrote 40 minutes ago fails, and you think "not my code." But it IS your code.

### The Problem

Auto-compaction clears old tool outputs. After 3-4 compactions during a long feature, you have no conversation memory of writing `auth.test.ts`. When it breaks, you dismiss it as pre-existing. But you wrote it. This wastes time and breaks TDD.

### The Solution: Git Is the Source of Truth

Before dismissing ANY test failure, check git:

```bash
# Shows all files added/modified on this branch vs main
git diff --name-only $(git merge-base HEAD main)...HEAD
```

If the failing test file appears in that output → **it was written or modified as part of this sprint's work. It's YOUR responsibility. Fix it.**

For more granular per-task ownership (especially in solo mode where all tasks share one branch):

```bash
# Shows which commit introduced/last modified a specific file
git log --oneline --diff-filter=AM -- path/to/failing.test.ts
```

If the commit message contains a task ID from the current sprint (T001, T002, etc.) → it's sprint work. Fix it.

### The Ownership Rule

**This is a hard rule. Context loss is not an excuse for abandoning your own tests.**

When a test fails during execution:

1. **Run git check** — `git diff --name-only $(git merge-base HEAD main)...HEAD | grep "test file path"`
2. **If file is on this branch** → it's YOUR code, fix the implementation (not the test)
3. **If file is NOT on this branch** → it's genuinely pre-existing. Log it as a deviation and continue.
4. **If in doubt** — `git log --oneline -- path/to/file` will show you exactly when and why the file was created

### Why This Works Across Compaction

Git history lives on disk. It doesn't care about context windows. Even after 10 compactions, `git diff` gives you the same answer. The conversation may forget, but git never forgets.

## Phase 1: Per-Task Cycle (RED → GREEN)

### 1. READ SPEC
- Read task file: `<SHIPYARD_DATA>/spec/tasks/[TASK_ID]-*.md`
- Read parent feature file for acceptance scenarios
- Read codebase context for relevant patterns

### 2. READ CODEBASE
- Identify existing files to modify
- Understand imports, patterns, conventions

### 3. PLAN
- Decide approach
- Identify test boundaries (unit, integration, E2E)

### 4. RED — Write Tests
- Unit tests for pure logic
- Integration tests for boundaries
- E2E test stubs from acceptance scenarios
- Write tests that would fail if run against an empty implementation
- **Normal mode:** run `shipyard-logcap run <TASK_ID>-red -- <scoped command>` to confirm they fail. If they pass when they should fail → tests aren't exercising the right code; fix before continuing.
- **Fast mode (`--fast`):** Do NOT run them — tests are deferred to the wave boundary.

### 5. GREEN — Implement
- Write minimum code to satisfy the acceptance scenarios
- Use the tests you just wrote as your specification
- Build bottom-up: data → domain → presentation
- **Normal mode:** run `shipyard-logcap run <TASK_ID>-green -- <scoped command>` to confirm they pass. If they fail → fix the implementation, not the tests.
- **Fast mode (`--fast`):** Do NOT run tests — trust your implementation against the test contract you wrote.

### 6. COMPLETENESS CHECK
- If Technical Notes lists discrete items (migrations, endpoints, config entries), grep for each and count how many were addressed
- If any are missing → fix before committing
- This is NOT a full scenario review — that happens in Phase 2 VERIFY

### 7. COMMIT
- Stage test files AND implementation files
- One atomic commit per task: `feat(TASK_ID): description`
- Update task status to `done`

---

## Phase 2: Wave-Level Cycle (REFACTOR → MUTATE → VERIFY)

Runs at the wave boundary, AFTER all tasks are merged to the working branch. One builder invocation per wave. The builder sees all tasks' combined code and runs as `Mode: wave-refactor`.

### REFACTOR (wave-level)
- Identify cross-task duplication — two tasks may have independently written the same helper
- Extract shared utilities, improve naming, remove dead code
- Run wave-scoped tests after: `shipyard-logcap run wave-N-refactor -- <scoped-test-command>`
- Tests MUST pass. If they fail → fix the refactoring.

### MUTATE (wave-level)
- For each task's key conditional or boundary check:
  1. Temporarily flip it
  2. Run: `shipyard-logcap run wave-N-mutate-TASK_ID -- <scoped-test-command>`
  3. At least one test MUST catch the mutation
  4. If none catch it → flag the gap (reported back to orchestrator — test coverage gap surfaced in `/ship-review`)
  5. Restore before moving to next task
- Commit refactor changes: `refactor(wave-N): cross-task refactor and mutation verified`

### VERIFY (wave-level)
- Separate `shipyard-review-spec` agent, runs after the wave-refactor builder returns
- Checks all wave tasks' acceptance scenarios against the now-merged + refactored implementation
- Returns pass/fail per scenario
- Gaps trigger a builder re-dispatch (max 1 per task); persistent gaps become `needs-attention`

### VISUAL VERIFY (UI tasks only — part of Phase 1, per task)
- Screenshot at mobile (375px), tablet (768px), desktop (1024px)
- Check layout, content, interactive states
- Save to `<SHIPYARD_DATA>/verify/`

### 10. LEARN (after struggle only)

If the on-commit hook prints "LEARNING OPPORTUNITY" (meaning you edited a file 5+ times before getting it right), capture what you learned. This is automatic — the hook detects it and suggests a domain.

Append to the appropriate file in `.claude/rules/learnings/<domain>.md`. Create the file if it doesn't exist. The hook suggests a domain based on file paths (auth, api, data, ui, testing, styling, state, config, logic, general).

**Each learnings rule file must have path-scoped frontmatter** so it only loads when the agent touches relevant files:

```markdown
---
paths: ["src/auth/**/*", "lib/auth/**/*", "app/**/login/**/*"]
---
# Learnings: Auth

### Server-side client required for Server Components
**Symptom:** "Cannot use client in server component" error
**Cause:** Imported browser client instead of server client
**Fix:** Use the server-side client variant in server components
```

**Rules for learnings files:**
- One file per domain — `auth.md`, `api.md`, `data.md`, `ui.md`, `testing.md`, `styling.md`, `state.md`, `config.md`, `logic.md`, `general.md`
- `paths:` scoped to files where the learning is relevant — auth learnings load when editing auth code, not CSS
- Each entry: 3 lines max (Symptom / Cause / Fix). Be specific, not generic.
- These auto-load via Claude Code's rules system — no manual reading needed

**Why rules, not a single file:** A single `learnings.md` becomes a context bomb as it grows. Path-scoped rule files mean only relevant learnings load for the code you're actually touching. Auth learnings don't waste context when you're writing CSS.

**Consolidation:** If a learnings file exceeds 100 lines (~30 entries), consolidate related entries. Five entries about "wrong import path for X" become one entry: "Always import X from Y, not Z." `/ship-status` checks learnings file sizes and flags ones needing consolidation.

## Non-Negotiable Rules

- NEVER skip TDD. No exceptions. RED before GREEN, every task.
- NEVER modify test assertions to pass. Fix the implementation.
- NEVER build beyond acceptance criteria.
- NEVER dismiss a test failure as "pre-existing" without checking git first. Run `git diff --name-only $(git merge-base HEAD main)...HEAD` — if the file is on this branch, it's yours.
- ALWAYS commit atomically per task (Phase 1 commit: `feat(TASK_ID): description`).
- NEVER do REFACTOR or MUTATE inside a per-task builder. Those are Phase 2 wave-boundary operations.
- ALWAYS update task status to `done` after committing.
- If in doubt → AskUserQuestion.

## Test Naming Convention

`should [expected behavior] when [condition]`

Examples:
- `should return error when password is empty`
- `should redirect to dashboard when login succeeds`
- `should show rate limit message when 5 failed attempts`

## Mock Rules

- Mock external dependencies only (APIs, databases, third-party services)
- Never mock your own code
- Never mock internals

## Coverage Thresholds

| Domain | Minimum |
|--------|---------|
| Auth, payments, security | 95% |
| Business logic, domain | 90% |
| Server actions, API | 85% |
| UI components | 80% |
| Utilities, helpers | 80% |
