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

!`shipyard-context view config`
!`shipyard-context view codebase 30`
!`shipyard-context list quick-tasks`

**Paths.** All file ops use the absolute SHIPYARD_DATA prefix from the context block. No `~`, `$HOME`, or shell variables in `file_path`. No bash invocation of `shipyard-data` or `shipyard-context` — use Read / Grep / Glob.

## Input

$ARGUMENTS

## Session Guard Cleanup

**First action — planning-session mutex check:** Use the Read tool on `<SHIPYARD_DATA>/.active-session.json` (substitute the literal SHIPYARD_DATA path from the context block above). Then decide:

- **File does not exist** → no planning session active. Skip to "Execution Lock Check" below.
- **File exists.** Parse the JSON and check:
  1. If `cleared` is set OR `skill` is `null` → previous planning session ended cleanly. Use Write to overwrite the file with `{"skill": null, "cleared": "<iso-timestamp>"}` (idempotent — the soft-delete sentinel ensures `session-guard` treats it as inactive). Skip to "Execution Lock Check" below.
  2. If `started` is more than 2 hours old → stale lock from a crashed planning session. Print "(recovered stale planning lock from `/{previous skill}` started {N}h ago)", use Write to overwrite with the cleared sentinel, then proceed.
  3. Otherwise → **HARD BLOCK.** A planning session is active and quick tasks cannot start until it ends:
  ```
  ⛔ Planning session active — cannot start a quick task.
    Skill:   /{skill from file}
    Topic:   {topic from file}
    Started: {started from file}

  Finish or pause the planning session first, then run /ship-quick.
  If the planning session crashed: /ship-status (will offer to clear the stale lock)
  ```
  Print this message as the entire response and STOP.

This prevents the failure mode where a discussion is in progress and `/ship-quick` would otherwise trip the session-guard hook on every Edit. Quick tasks are implementing work — they need a clear runway.

## Execution Lock Check

**Before starting work**, check for concurrent execution:

1. Use the Read tool to read `<SHIPYARD_DATA>/.active-execution.json`. If the file exists, parse the JSON and check `cleared` (sentinel marker) and `started` timestamp. If `cleared` is not set AND `started` is less than 2 hours ago:
   ```
   ⛔ BLOCKED: Another execution session is active.
     Skill: [skill name]
     Started: [timestamp]

   Concurrent execution causes git conflicts, duplicate commits, and corrupted state.
   Finish or pause the active session first, then run /ship-quick.
   If the other session crashed or was closed: /ship-status (will ask to clear the lock)
   ```
   **Hard block — do not proceed. Do not offer an override.** Stop immediately.

2. If no lock exists, the lock has `cleared` set, or the lock is stale (>2 hours) → use the Write tool to overwrite `<SHIPYARD_DATA>/.active-execution.json` with:
   ```json
   {
     "skill": "ship-quick",
     "task": "[task description]",
     "started": "[ISO date]"
   }
   ```

3. **On completion**, use the Write tool to overwrite `<SHIPYARD_DATA>/.active-execution.json` with `{"skill": null, "cleared": "<iso-timestamp>"}` (soft-delete sentinel).

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
# <SHIPYARD_DATA>/spec/tasks/Q-NNN-[slug].md
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
