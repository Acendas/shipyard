---
name: ship-bug
description: "Report a bug or production issue with minimal ceremony. Creates a spec entry and optional fix task. Use when the user reports something broken, a defect, unexpected behavior, a regression, or needs to file a hotfix for production. Also use for --hotfix emergency production issues."
allowed-tools: [Read, Write, Edit, Grep, Glob, AskUserQuestion]
model: sonnet
effort: low
argument-hint: "[bug description] or --hotfix [description]"
---

# Shipyard: Report Bug

Create a minimal bug report. The spec already describes correct behavior — bugs are deviations from it.

## Context

!`shipyard-context path`

!`shipyard-context count spec/bugs`
!`shipyard-context head sprints/current/SPRINT.md 10 NO_SPRINT`

**Data path: use the SHIPYARD_DATA path from context above. For Read/Write/Edit tools, use the full literal path (e.g., `/Users/x/.claude/plugins/data/shipyard/projects/abc123/...`). NEVER use `~` or `$HOME` in file_path — always start with `/`. For Bash: `SD=$(shipyard-data)` then `$SD/...`. Shell variables like `$SD` do NOT work in Read/Write/Edit file_path — only literal paths. NEVER hardcode or guess paths.**

## Input

$ARGUMENTS

## Detect Mode

- No input → AskUserQuestion: "What's broken? Describe the bug you're seeing."
- If input contains `--hotfix` → HOTFIX mode (production emergency)
- Otherwise → NORMAL mode

---

## NORMAL Mode

1. **Generate ID** — Next available BNNN (B001, B002, etc.)

2. **Try to match feature** — Search spec features for the area this bug relates to.
   If ambiguous with multiple plausible matches, use AskUserQuestion: "Which feature does this bug relate to?" Otherwise, best-guess the match and note it.

3. **Create bug file** — `$(shipyard-data)/spec/bugs/BNNN-[slug].md`:

```yaml
---
id: BNNN
title: "[title]"
type: bug
feature: [matched feature ID or "unknown"]
task: ""
severity: [infer from description: critical|high|medium|low]
hotfix: false
status: open
found_during: [current sprint ID or "manual report"]
created: [today]
---

# [Title]

## Bug
[Description from user]

## Steps to Reproduce
[Infer from description. If unclear, write "To be determined" — don't ask, keep it fast]

## Expected (from spec)
[Pull from the matched feature's acceptance criteria if possible]

## Actual
[What the user described happening]
```

4. **Confirm:**
```
✓ Bug reported: BNNN — [title] (severity: [level])
  Feature: [ID] — [feature title]
  Fix options:
    - Urgent: /ship-bug --hotfix [description] to re-file as hotfix, then /ship-execute --hotfix B-HOT-NNN
    - Sprint fix: create a fix task in the current sprint
    - Backlog: defer to next sprint planning
```

---

## HOTFIX Mode

1. **Generate ID** — B-HOT-NNN format

2. **Create bug file** with `severity: critical` and `hotfix: true` in frontmatter

3. **Auto-start debug session** — create `$(shipyard-data)/debug/B-HOT-NNN.md` with symptoms from the bug report. This ensures systematic investigation instead of guessing at fixes.

4. **Confirm with urgency:**
```
🚨 HOTFIX: B-HOT-NNN — [title]
  Debug session started: $(shipyard-data)/debug/B-HOT-NNN.md
  Investigating now — /ship-debug --resume to continue if interrupted
```

Then immediately begin the debug investigation (Step 3 of ship-debug: form hypothesis → test → record → repeat). When root cause is found, fix with TDD (regression test first), commit as `fix(B-HOT-NNN): [description]`.

## Rules

- **Be fast.** Bug reporting should take seconds.
- **Infer severity** from keywords: "broken", "can't", "crash" → high/critical. "Wrong color", "typo" → low.
- **Don't ask unnecessary questions.** Capture what you have, refine later.
- **Link to spec** — if you find the related feature, pull its acceptance criteria as the "Expected" section.

## Next Up (after bug filed)

Suggest the right path based on severity:

For **critical/hotfix** bugs:
```
▶ NEXT UP: Fix it now (bypasses sprint planning)
  /ship-execute --hotfix B-HOT-NNN
  (tip: /clear first for a fresh context window)
```

For **high** severity bugs in an active sprint:
```
▶ NEXT UP: Add to the current sprint
  /ship-execute (the bug will be picked up as a patch task)
  (tip: /clear first for a fresh context window)
```

For **medium/low** severity bugs:
```
▶ NEXT UP: Plan the fix in the next sprint
  /ship-sprint (the bug will show up as a candidate)
  (tip: /clear first for a fresh context window)
```
