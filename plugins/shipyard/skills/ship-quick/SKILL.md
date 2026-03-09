---
name: ship-quick
description: "Execute a one-off task with Shipyard guarantees (tests first, one focused commit) outside of sprint planning. Use when the user wants to do a small self-contained change, a quick fix, a refactor, or any task that doesn't warrant full sprint planning but should still follow quality standards."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, AskUserQuestion]
model: sonnet
effort: medium
argument-hint: "[task description]"
---

# Shipyard: Quick Task

Execute a one-off task outside of sprint planning but with Shipyard's guarantees (write tests first, one focused commit per change, spec compliance).

## Context

!`shipyard-context path`

!`shipyard-context head config.md 50 NO_CONFIG`
!`shipyard-context head codebase-context.md 30 "No codebase context"`
!`shipyard-context ls-sort "spec/tasks/Q-*.md" "No quick tasks yet"`

**Data path: use the SHIPYARD_DATA path from context above. For Read/Write/Edit tools, use the full literal path (e.g., `/Users/x/.claude/plugins/data/shipyard/projects/abc123/...`). NEVER use `~` or `$HOME` in file_path — always start with `/`. For Bash: `SD=$(shipyard-data)` then `$SD/...`. Shell variables like `$SD` do NOT work in Read/Write/Edit file_path — only literal paths. NEVER hardcode or guess paths.**

## Input

$ARGUMENTS

## Session Guard Cleanup

**First action:** Delete `.active-session.json` from the SHIPYARD_DATA directory (use the full literal path from context above) if it exists — quick tasks are implementing work and the session guard should not block code writes.

## Execution Lock Check

**Before starting work**, check for concurrent execution:

1. Read `$(shipyard-data)/.active-execution.json` — if it exists and is less than 2 hours old:
   ```
   ⛔ BLOCKED: Another execution session is active.
     Skill: [skill name]
     Started: [timestamp]

   Concurrent execution causes git conflicts, duplicate commits, and corrupted state.
   Finish or pause the active session first, then run /ship-quick.
   If the other session crashed or was closed: /ship-status (will ask to clear the lock)
   ```
   **Hard block — do not proceed. Do not offer an override.** Stop immediately.

2. If no lock exists or lock is stale (>2 hours) → write `$(shipyard-data)/.active-execution.json`:
   ```json
   {
     "skill": "ship-quick",
     "task": "[task description]",
     "started": "[ISO date]"
   }
   ```

3. **On completion**, delete `$(shipyard-data)/.active-execution.json`.

## Process

### Step 1: Understand

If no arguments or vague input → AskUserQuestion: "What's the quick task? Describe the change you'd like to make."

Parse the user's task description. Determine:
- Is this a bug fix? → AskUserQuestion: "This sounds like a bug fix. Use /ship-bug instead? (yes / no, it's a quick task)"
- Is this a new feature? → AskUserQuestion: "This sounds like a new feature. Use /ship-discuss instead? (yes / no, it's a quick task)"
- Is this a small, self-contained change? → proceed

### Step 2: Quick Spec

Create a minimal task file:
```yaml
# $(shipyard-data)/spec/tasks/Q-NNN-[slug].md
---
id: Q-NNN
title: "[title]"
type: quick-task
status: in-progress
created: [today]
---

## What
[Task description]

## Acceptance Criteria
[Inferred from description — brief Given/When/Then if applicable]
```

### Step 3: Execute with TDD

Follow the standard TDD cycle:
1. Write failing test (if the task is testable)
2. Implement
3. Refactor
4. Mutate-verify (if tests written)
5. Commit: `chore(Q-NNN): [description]`

### Step 4: Update Status

Mark task as done. Report:
```
✓ Quick task done: Q-NNN — [title]
  Commit: [hash]
  Tests: [passed/skipped]
```

## Rules

- Quick tasks still follow TDD when applicable
- Use `chore()` for refactors/improvements, `fix()` for corrections (not `feat()` — these aren't planned features)
- If the task grows beyond "quick" (>30 min, >3 files) → AskUserQuestion: "This task is growing beyond quick scope ([N] files touched). Continue here, or create a proper feature with /ship-discuss? (continue / promote to feature)"
- Don't skip tests just because it's a "quick" task
- When the task description is ambiguous or multiple approaches exist → AskUserQuestion with options and your recommendation

## Next Up (after task complete)

Check if there's an active sprint and suggest accordingly:

If mid-sprint:
```
▶ NEXT UP: Continue the sprint
  /ship-execute — pick up the next sprint task
  (tip: /clear first for a fresh context window)
```

If no active sprint:
```
▶ NEXT UP: See what's next
  /ship-status — check project status
  (tip: /clear first for a fresh context window)
```
