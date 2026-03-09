---
name: ship-backlog
description: "View, groom, and manage the prioritized backlog sorted by RICE score. Use when the user wants to see the backlog, reprioritize features, run a grooming session, clean up stale items, declare backlog bankruptcy, or decide what to work on next."
allowed-tools: [Read, Write, Edit, Grep, Glob, AskUserQuestion, EnterPlanMode, ExitPlanMode]
model: sonnet
effort: medium
argument-hint: "[groom|rank|approve|bankruptcy]"
---

# Shipyard: Backlog Manager

Manage the prioritized backlog. Default sort is by RICE score (Reach x Impact x Confidence / Effort — higher means more valuable).

**Data model**: BACKLOG.md is an **ordered index of feature IDs**. All feature data (title, RICE, points, status, complexity) is read from feature files on display. Never duplicate feature data into BACKLOG.md. See `.claude/rules/shipyard-data-model.md`.

## Context

!`shipyard-context path`

!`shipyard-context head backlog/BACKLOG.md 50 NO_BACKLOG`
!`shipyard-context head config.md 50 NO_CONFIG`
!`shipyard-context head memory/metrics.md 20 NO_METRICS`

**Data path: use the SHIPYARD_DATA path from context above. For Read/Write/Edit tools, use the full literal path (e.g., `/Users/x/.claude/plugins/data/shipyard/projects/abc123/...`). NEVER use `~` or `$HOME` in file_path — always start with `/`. For Bash: `SD=$(shipyard-data)` then `$SD/...`. Shell variables like `$SD` do NOT work in Read/Write/Edit file_path — only literal paths. NEVER hardcode or guess paths.**

## Input

$ARGUMENTS

### Compaction Recovery

If you lose context mid-session (e.g., after auto-compaction):

1. Check `last_groomed` in BACKLOG.md frontmatter — if today, a grooming session was in progress
2. Read BACKLOG.md for current rank order to identify where the session left off
3. AskUserQuestion: "A grooming session was interrupted. What was the last item you reviewed? (provide a feature ID, or type 'restart' to start over)"
4. Resume from the next item after the one the user identifies

For bankruptcy: check if any feature files have status `deferred` with today's date — those were already processed. Resume with remaining items.

## Behavior

### No arguments → Show backlog

Read BACKLOG.md for the ordered list of feature IDs. If BACKLOG.md doesn't exist or contains no IDs:

1. Scan `$(shipyard-data)/spec/features/` for features with `status: proposed`
2. If proposed features exist → show them and offer to approve:
   ```
   Backlog is empty, but [N] proposed features are waiting for approval:

     F003 — Card Payments (proposed, 8 pts, RICE 24.0)
     F007 — Notifications (proposed, 5 pts, RICE 18.2)

   Approve all and add to backlog? (yes / pick / discuss first)
   ```
   - **yes** → set all to `approved`, add IDs to BACKLOG.md sorted by RICE
   - **pick** → AskUserQuestion with numbered list, user picks which to approve
   - **discuss first** → suggest `/ship-discuss [ID]` for the top one
3. If no proposed features either → AskUserQuestion: "The backlog is empty and no features are proposed. Run /ship-discuss to define features."

**CRITICAL:** Always resolve data path via `$(shipyard-data)`. Never hardcode paths or look in other worktrees.

For each ID, read the feature file to get live data (title, RICE, points, status, epic, updated date). Also scan `$(shipyard-data)/spec/epics/` to build the epic index. Also read `$(shipyard-data)/sprints/current/SPRINT.md` to identify which features are in the active sprint.

**Display in three sections — sprint first, then backlog, then proposed:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 BOARD — [Project Name]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 IN SPRINT (Sprint [NNN] — [goal])
  [1] F001 — [title]       | [N]/[M] tasks done | [pts] pts
  [2] F005 — [title]       | [N]/[M] tasks done | [pts] pts
  Sprint: [done pts]/[total pts] | Wave [N]/[M]

 BACKLOG (sorted by RICE — ready to pull)
  [3] F009 — [title]       | RICE 32.1 | 8 pts | E001
  [4] F011 — [title]       | RICE 28.4 | 5 pts | E002
  [5] F004 — [title]       | RICE 24.0 | 13 pts | E001 | ⚠️ 75d stale
  Capacity: ~20 pts/sprint | Next sprint fits: F009 + F011 = 13 pts

 PROPOSED (approve to add to backlog)
  [6] F016 — [title]       | RICE 12.0 | 3 pts
  [7] F017 — [title]       | RICE  9.5 | 8 pts

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If no active sprint, omit the IN SPRINT section.
If no proposed features, omit the PROPOSED section.

Then start the **interactive loop** — AskUserQuestion:

"Pick a number for details, or: 'groom' / 'rank' / 'approve [IDs]' / 'done'"

**Drill-down** — when user picks a number:
- Show the feature's full summary: user story, acceptance criteria count, points, RICE breakdown, epic, dependencies, status, age
- Then AskUserQuestion: "Actions: 'reprioritize' / 'split' / 'archive' / 'kill' / 'approve' / 'back' / 'done'"
- After action, return to the board view (refreshed)

**The browse loop continues until the user says "done".** Each redisplay reads fresh data. User can jump directly by typing a feature ID (e.g., "F003") from any level.

Within each section, features are sorted by RICE descending. The overall rank numbers (1, 2, 3...) span all sections for easy picking.

**Important:** Only group by epics that exist in `$(shipyard-data)/spec/epics/` and are referenced by the feature's `epic:` frontmatter field. Do NOT invent categories or group by keywords in titles. If ALL features in a section share the same epic, show it as a header. If mixed, show epic as a column.

This board is generated on-the-fly — it's never stored in BACKLOG.md.

### `groom` → Interactive grooming session

Walk through each backlog item one at a time. For each item:
1. Read the feature file
2. **Display the feature summary as text output before asking for a decision:**
   ```
   ── F004: Bulk Fee Import ──────────────────
   RICE: 24.0 | Points: 13 | Complexity: high
   Status: approved | Age: 75 days | Last discussed: 2026-01-15
   Story: As an admin, I want to import fees from CSV...
   Scenarios: 4 (happy path, validation, duplicates, partial)
   ─────────────────────────────────────────────
   ```
3. Then AskUserQuestion: "Keep / Reprioritize / Split / Archive / Kill?"
   - **Keep** — no changes
   - **Reprioritize** — update RICE scores **in the feature file frontmatter** (ask which dimension changed)
   - **Split** — break into smaller features (create new feature files, archive original)
   - **Archive** — update status to `deferred` in feature frontmatter, remove ID from BACKLOG.md
   - **Kill** — update status to `rejected` in feature frontmatter, remove ID from BACKLOG.md

Also run health checks:
- **Stale items** (>60 days since `updated` in feature frontmatter) → force decision
- **Zombie stories** (planned in 2+ sprints but never completed) → force a decision: commit to finishing or remove
- **Oversize items** (>13 points) → suggest splitting
- **Epic health** — after grooming individual features, report per-epic:
  - Epics with all features done/released → "E001 is complete — archive it?"
  - Epics with mixed status (some done, some stale) → "E002 has 2 done features and 1 stale (90d). Groom the stale one or archive the epic?"
  - Epics with only 1 feature → "E003 has only 1 feature. Does it need to be an epic, or just a standalone feature?"
  - Features without an epic → "3 ungrouped features. Assign to an existing epic or create a new one? (assign / leave ungrouped)"

### Grooming Summary — Plan Mode

After walking through all items, **enter plan mode** (`EnterPlanMode`) to present the grooming results before committing changes. Grooming can reprioritize, split, archive, or kill features — the user should see the full picture before changes are finalized.

The plan should include:

**CHANGES MADE**
- Reprioritized: [IDs with old → new RICE]
- Split: [original ID → new IDs]
- Archived: [IDs with reasons]
- Killed: [IDs with reasons]
- Kept as-is: [count]

**NEW BACKLOG ORDER** (top 10, sorted by RICE):
- [rank] [ID] — [title] | RICE [score] | [pts] pts

**EPIC HEALTH** (if applicable):
- [epic health observations from the grooming checks above]

**STALE ITEMS RESOLVED**: [count]
**ZOMBIES RESOLVED**: [count]

**Exit plan mode** (`ExitPlanMode`) — triggers built-in approval flow:
- **Approve** → write all changes to feature files and BACKLOG.md
- **Adjust** → user modifies specific decisions, iterate
- **Cancel** → discard all grooming changes, BACKLOG.md unchanged

**Important:** Feature file changes (RICE updates, status changes, splits) are staged during the grooming walkthrough but only written to disk after approval. If the user cancels, nothing changes.

Update BACKLOG.md rank order after grooming approval.
Record `last_groomed: [today]` in BACKLOG.md frontmatter.

### `rank` → Re-sort by RICE

Read each feature file to get current RICE scores. Re-sort BACKLOG.md IDs by RICE descending.
Report any items where RICE components are missing in the feature frontmatter.

### `bankruptcy` → Backlog bankruptcy

When backlog is overwhelmingly large (50+ items) or consistently ignored:

1. Read all feature files for backlog items, partition into **Keep** and **Archive** groups
2. **Display both lists before asking for confirmation:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 BACKLOG BANKRUPTCY — [N] total items
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 KEEP ([M] items)
  These survive — approved, RICE > 20, or dependency blockers:
  - F009: Maintenance Requests (RICE 32.1, approved)
  - F011: Payment Reminders (RICE 28.4, approved)

 ARCHIVE ([K] items)
  These get archived — low RICE, proposed, stale:
  - F022: Email Digest (RICE 4.2, proposed, 90d stale)
  - F031: Dark Mode (RICE 2.1, proposed, 120d stale)
  [... full list ...]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

3. AskUserQuestion: "Archive [K] items and keep [M]? (yes / adjust / cancel)"
4. If confirmed:
   - Update status to `deferred` in each archived feature's frontmatter
   - Move feature files to `$(shipyard-data)/spec/archive/`
   - Rebuild BACKLOG.md with survivor IDs only
   - Report: "Archived [K] items. [M] remain."

### `approve [IDs]` → Approve proposed features into backlog

For each ID provided:
1. Read the feature file, verify `status: proposed`
2. Update status to `approved` in feature frontmatter
3. Add ID to BACKLOG.md in RICE-sorted position

If no IDs provided, show all proposed features and AskUserQuestion to pick.

Report: "Approved [N] features into backlog: [IDs]. Run /ship-sprint to plan a sprint."

### `archive` → Archive completed items

Run this periodically (or during grooming) to keep BACKLOG.md lean:

1. Read each feature file referenced in BACKLOG.md, find items with status `done`, `deployed`, `released`, or `rejected`
2. Remove their IDs from BACKLOG.md
3. Report: "Removed [N] completed items from backlog."

**Auto-trigger:** If BACKLOG.md has more than 50 IDs during any backlog operation, run archival automatically before proceeding.

## Rules

- RICE formula: (Reach × Impact × Confidence%) / Effort
- Default sort: RICE descending
- Overrides allowed — add reasoning in BACKLOG.md Overrides section
- Stale threshold: configurable in config.md (default: 60 days warning, 120 days critical)
- Never auto-delete — archive preserves history
- **All data modifications go to feature files** — BACKLOG.md only stores ID order and override reasoning

## Next Up (after grooming or viewing)

```
▶ NEXT UP: Build something
  /ship-sprint — plan a sprint with the top-ranked features
  /ship-discuss [ID] — refine a feature before pulling it in
  (tip: /clear first for a fresh context window)
```
