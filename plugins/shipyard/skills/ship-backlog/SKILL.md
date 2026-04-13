---
name: ship-backlog
description: "View, groom, and manage the prioritized backlog sorted by RICE score. Use when the user wants to see the backlog, reprioritize features, run a grooming session, clean up stale items, declare backlog bankruptcy, or decide what to work on next."
allowed-tools: [Read, Write, Edit, Grep, Glob, AskUserQuestion, "Bash(shipyard-context:*)"]
model: sonnet
effort: medium
argument-hint: "[groom|rank|approve|bankruptcy]"
---

# Shipyard: Backlog Manager

Manage the prioritized backlog. Default sort is by RICE score (Reach x Impact x Confidence / Effort — higher means more valuable).

**Data model**: BACKLOG.md is an **ordered index of feature IDs**. All feature data (title, RICE, points, status, complexity) is read from feature files on display. Never duplicate feature data into BACKLOG.md. See `.claude/rules/shipyard-data-model.md`.

## Context

!`shipyard-context path`

!`shipyard-context view backlog`
!`shipyard-context view config`
!`shipyard-context view metrics`

**Paths.** All file ops use the absolute SHIPYARD_DATA prefix from the context block. No `~`, `$HOME`, or shell variables in `file_path`. No bash invocation of `shipyard-data` or `shipyard-context` — use Read / Grep / Glob.

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

1. Use the Grep tool with `pattern: ^status: proposed`, `path: <SHIPYARD_DATA>/spec/features`, `glob: F*.md`, `output_mode: files_with_matches` to find proposed features. Then Read each returned file for title, RICE, points.
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

**CRITICAL:** Always resolve paths via the literal SHIPYARD_DATA prefix from the context block above. Never hardcode paths or look in other worktrees.

For each ID, use the Read tool on `<SHIPYARD_DATA>/spec/features/F<NNN>-*.md` (Glob first if you need to discover the slug) to get live data (title, RICE, points, status, epic, updated date). Also use Glob `<SHIPYARD_DATA>/spec/epics/E*.md` then Read each to build the epic index. Also Read `<SHIPYARD_DATA>/sprints/current/SPRINT.md` to identify which features are in the active sprint.

**Also load ideas.** Use Glob `<SHIPYARD_DATA>/spec/ideas/IDEA-*.md` to enumerate ideas, then Read each one. Filter out any idea whose `status:` is `graduated` (already promoted to a feature) or `rejected` (triaged out). The remaining ideas form the pool for the IDEAS section below. Sort by `created:` descending (newest first).

**Display in four sections — sprint first, then backlog, then proposed, then ideas:**

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

 IDEAS (captured observations — refine via /ship-discuss IDEA-NNN)
  [8]  IDEA-045 — Swallowed exception in logging wrapper (review-gap/sprint-006)
  [9]  IDEA-044 — Evaluate argon2id vs bcrypt (execute/sprint-006)
  [10] IDEA-043 — Reduce test flakiness in CI (retro/sprint-005)
  [11] IDEA-042 — Add request tracing headers (retro/sprint-005)
  [12] IDEA-038 — Deferred auth cleanup from T009 (execute/sprint-004)
  — (5 more) —
  [13] IDEA-012 — Investigate Redis vs Postgres LISTEN/NOTIFY (capture)
  [14] IDEA-011 — Drop legacy config.v1 loader (retro/sprint-002)
  [15] IDEA-010 — Stale session cleanup job (execute/sprint-002)
  [16] IDEA-008 — Replace regex date parser (capture)
  [17] IDEA-006 — Extract pricing service (capture)
  + 14 more — run /ship-discuss (no args) to triage all ideas

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If no active sprint, omit the IN SPRINT section.
If no proposed features, omit the PROPOSED section.
If no ideas (after filtering graduated + rejected), omit the IDEAS section.

**IDEAS section pagination (cap at 10):** to keep the board scannable on long-running projects, show only the **5 newest + 5 oldest** non-graduated/non-rejected ideas. If the total count exceeds 10, add a `— (N more) —` separator row between the two halves and a `+ N more — run /ship-discuss (no args) to triage all ideas` footer line at the bottom. This gives the user recent activity at the top and long-tail items at the bottom without making the board a multi-screen scroll. The source-tag suffix in parentheses (e.g., `review-gap/sprint-006`) tells the user at a glance where each idea came from — retro items look distinct from execute-time captures.

**No drill-down for ideas in the main interactive loop.** Ideas don't have RICE scores, story points, or groomable fields — they're pre-features. If the user picks an idea number, print: "Ideas are refined via `/ship-discuss IDEA-NNN`. Run that to graduate the idea into a proper feature with acceptance criteria and story points." Do NOT invoke the drill-down code path that features use.

Then start the **interactive loop** — AskUserQuestion:

"Pick a number for details, or: 'groom' / 'rank' / 'approve [IDs]' / 'done'"

**Drill-down** — when user picks a number:
- Show the feature's full summary: user story, acceptance criteria count, points, RICE breakdown, epic, dependencies, status, age
- Then AskUserQuestion: "Actions: 'reprioritize' / 'split' / 'archive' / 'kill' / 'approve' / 'back' / 'done'"
- After action, return to the board view (refreshed)

**The browse loop continues until the user says "done".** Each redisplay reads fresh data. User can jump directly by typing a feature ID (e.g., "F003") from any level.

Within each section, features are sorted by RICE descending. The overall rank numbers (1, 2, 3...) span all sections for easy picking.

**Important:** Only group by epics that exist in `<SHIPYARD_DATA>/spec/epics/` (verify via Glob) and are referenced by the feature's `epic:` frontmatter field. Do NOT invent categories or group by keywords in titles. If ALL features in a section share the same epic, show it as a header. If mixed, show epic as a column.

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

### Grooming Summary

After walking through all items, present the grooming results as text before committing changes. Grooming can reprioritize, split, archive, or kill features — the user should see the full picture before changes are finalized.

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

Then use `AskUserQuestion` for approval:
- **Apply changes (Recommended)** — write all changes to feature files and BACKLOG.md
- **Adjust** — modify specific decisions, iterate
- **Cancel** — discard all grooming changes, BACKLOG.md unchanged

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
   - Use the Edit tool to set `status: deferred` in each archived feature's frontmatter (in place — do not move or delete the file). The `reap-obsolete` housekeeping subcommand will physically reap them after the retention period.
   - Rebuild BACKLOG.md with survivor IDs only (use Edit on `<SHIPYARD_DATA>/spec/BACKLOG.md`).
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
