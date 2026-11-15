---
name: ship-backlog
description: "View and groom the Shipyard backlog."
allowed-tools: [Read, Write, Edit, Grep, Glob, AskUserQuestion, "Bash(shipyard-context:*)", "Bash(shipyard-data:*)"]
argument-hint: "[groom|rank|approve|bankruptcy]"
model: sonnet
---

# Shipyard: Backlog Manager

Manage the prioritized backlog. Default sort is by RICE score (Reach x Impact x Confidence / Effort — higher means more valuable).

**Data model**: BACKLOG.md is an **ordered index of feature IDs**. All feature data (title, RICE, points, status, complexity) is read from story files on display. Never duplicate feature data into BACKLOG.md. See `${CLAUDE_PLUGIN_ROOT}/project-files/rules/shipyard-data-model.md` (rules live in the plugin in 2.0).

## Context

!`shipyard-context backlog-context`

**Shell.** Bash is for `shipyard-context` (reads) and `shipyard-data feature|backlog|idea ...` (state mutations) ONLY — no other shell. Never hand-Edit story-file frontmatter or BACKLOG.md IDs/`last_groomed` — those are CLI-owned (`story set`, `story set-status`, `backlog add|remove|rank|set`). Feature/epic bodies and the BACKLOG.md Overrides section remain Edit-tool surface.

**Execution rules (load-bearing):**
- **Do every read yourself with Read/Grep/Glob. NEVER dispatch a subagent (Agent/Explore/Task) to gather board data.** Data gathered in a subagent never lands in this context, and the board cannot be rendered from data you do not hold.
- **Render before asking.** Render the full board as text output BEFORE the first AskUserQuestion. The ask at the end of the board is the ONLY entry into the interactive loop. Follow SHIPYARD_STARTUP_RULES and SHIPYARD_ONBOARDING_INSTRUCTION from startup.
- **Quiet by default.** The board and the drill-down/grooming summaries ARE the render-before-ask content — render those in full. But between them, work quietly: read story files, stage grooming decisions, and run `shipyard-data` mutations without narrating each read or each staged change. Surface a one-line result after a batch of mutations (`→ Applied: 3 reprioritized, 1 archived`), not a play-by-play. **No running commentary** ("Now I'll read S004…", "Let me check the next one…"). Full doctrine: `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md` § "Interim Communication: Quiet by Default".

## Input

$ARGUMENTS

### Compaction Recovery

If you lose context mid-session (e.g., after auto-compaction):

1. Check `last_groomed` in BACKLOG.md frontmatter — if today, a grooming session was in progress
2. Read BACKLOG.md for current rank order to identify where the session left off
3. Render the current rank order (ID — title, top 15) as chat text first — the BACKLOG.md Read alone does not count as shown; the user can't name where they left off without seeing the list.
4. AskUserQuestion: "A grooming session was interrupted. What was the last item you reviewed? (provide a feature ID, or type 'restart' to start over)"
5. Resume from the next item after the one the user identifies

For bankruptcy: check if any story files have status `deferred` with today's date — those were already processed. Resume with remaining items.

## Behavior

### No arguments → Show backlog

Read BACKLOG.md for the ordered list of feature IDs. If BACKLOG.md doesn't exist or contains no IDs:

1. Use the Grep tool with `pattern: ^status: proposed`, `path: <SHIPYARD_DATA>/spec`, `glob: {stories,features}/[SF]*.md`, `output_mode: files_with_matches` to find proposed features. Then Read each returned file for title, RICE, points.
2. If proposed features exist → show them and offer to approve. Before any approval option, render each candidate's full approval contract as chat text: title, story points, RICE components, every Given/When/Then acceptance scenario verbatim, `user_flow_probe` kind plus command/steps verbatim, assumptions, unresolved items, and known `skip-with-reason` gaps. A title/RICE list alone is not approval-grade context.
   ```
   Backlog is empty, but [N] proposed features are waiting for approval:

     S003 — Card Payments (proposed, 8 pts, RICE 24.0)
     S007 — Notifications (proposed, 5 pts, RICE 18.2)

   Approve all and add to backlog? (yes / pick / discuss first)
   ```
   - **yes** → only after the approval contract above is rendered for every selected ID, run `shipyard-data story set-status F00N approved`, then one `shipyard-data backlog add S003 S007 ...` call for all of them together (the CLI inserts each in RICE-sorted position)
   - **pick** → AskUserQuestion with numbered list, user picks which to approve
   - **discuss first** → suggest `/ship-discuss [ID]` for the top one
3. If no proposed features either → print the board (ideas included) and one line — `Nothing to groom. Refine an idea with /ship-discuss IDEA-NNN, or capture one with /ship-discuss <one-liner>.` — and STOP. No AskUserQuestion: a board with nothing groomable has no decision in it.

**CRITICAL:** Always resolve paths via the literal SHIPYARD_DATA prefix from the context block above. Never hardcode paths or look in other worktrees.

For each ID, use the Read tool on `<SHIPYARD_DATA>/spec/stories/F<NNN>-*.md` (Glob first if you need to discover the slug) to get live data (title, RICE, points, status, epic, updated date). Also use Glob `<SHIPYARD_DATA>/spec/epics/E*.md` then Read each to build the epic index. Also Read `<SHIPYARD_DATA>/sprints/current/SPRINT.md` to identify which features are in the active sprint.

**Also load ideas.** Use Glob `<SHIPYARD_DATA>/spec/ideas/IDEA-*.md` to enumerate ideas, then Read each one. Filter out any idea whose `status:` is `promoted` (legacy `graduated`; already promoted to a story or epic), `rejected` (triaged out) or `parked`. The remaining ideas form the pool for the IDEAS section below. Sort by `created:` descending (fallback: legacy `captured:`; newest first).

**Display in four sections — sprint first, then backlog, then proposed, then ideas:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 BOARD — [Project Name]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 IN SPRINT (Sprint [NNN] — [goal])
  [1] S001 — [title]       | [N]/[M] tasks done | [pts] pts
  [2] S005 — [title]       | [N]/[M] tasks done | [pts] pts
  Sprint: [done pts]/[total pts] | Wave [N]/[M]

 BACKLOG (grouped by epic, sorted by RICE — ready to pull)
  E001 — [epic title]
   [3] S009 — [title]      | RICE 32.1 | 8 pts
   [4] S004 — [title]      | RICE 24.0 | 13 pts | ⚠️ 75d stale
  E002 — [epic title]
   [5] S011 — [title]      | RICE 28.4 | 5 pts
  (no epic)
   [6] S014 — [title]      | RICE 18.0 | 3 pts
  Capacity: ~20 pts/sprint | Next sprint fits: S009 + S011 = 13 pts

 PROPOSED (approve to add to backlog)
  E003 — [epic title]
   [7] S016 — [title]      | RICE 12.0 | 3 pts
  (no epic)
   [8] S017 — [title]      | RICE  9.5 | 8 pts

 IDEAS (captured observations — refine via /ship-discuss IDEA-NNN)
  [8]  IDEA-045 — Swallowed exception in logging wrapper (review-gap/sprint-006)
  [9]  IDEA-044 — Evaluate argon2id vs bcrypt (execute/sprint-006)
  [10] IDEA-043 — Reduce test flakiness in CI (retro/sprint-005)
  [11] IDEA-042 — Add request tracing headers (retro/sprint-005)
  [12] IDEA-038 — Deferred auth cleanup from P009 (execute/sprint-004)
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
If no ideas (after filtering promoted/graduated, rejected and parked), omit the IDEAS section.

**IDEAS section pagination (cap at 10):** to keep the board scannable on long-running projects, show only the **5 newest + 5 oldest** undispositioned ideas (not promoted, rejected or parked). If the total count exceeds 10, add a `— (N more) —` separator row between the two halves and a `+ N more — run /ship-discuss (no args) to triage all ideas` footer line at the bottom. This gives the user recent activity at the top and long-tail items at the bottom without making the board a multi-screen scroll. The parenthesised suffix is each idea's source tag.

**No drill-down for ideas in the main interactive loop.** Ideas don't have RICE scores, story points, or groomable fields — they're pre-features. If the user picks an idea number, print: "Ideas are refined via `/ship-discuss IDEA-NNN`. Run that to graduate the idea into a proper feature with acceptance criteria and story points." Do NOT invoke the drill-down code path that features use.

Print the complete board first. If the BACKLOG and PROPOSED sections are both empty (only sprint items and/or ideas), end with the one-line pointer above and STOP — there is nothing to groom and no loop to enter. Otherwise, only after the board text is emitted, in the same turn, start the **interactive loop** — AskUserQuestion:

"Pick a number for details, or: 'groom' / 'rank' / 'approve [IDs]' / 'done'"

**Drill-down** — when user picks a number:
- Show the feature's full summary: user story, acceptance criteria count, points, RICE breakdown, epic, dependencies, status, age
- Then AskUserQuestion: "Actions: 'reprioritize' / 'split' / 'archive' / 'kill' / 'approve' / 'back' / 'done'"
- After action, return to the board view (refreshed)

The loop continues until the user says "done"; typing a feature ID jumps directly to it.

The overall rank numbers (1, 2, 3...) span all sections for easy picking.

**ALWAYS group by epic within the BACKLOG and PROPOSED sections.** Under each section, render one epic header per epic (`E001 — [epic title]`), with that epic's features listed beneath it sorted by RICE descending. Order the epic groups by their highest-RICE feature (descending), so the most valuable group is on top. Features with no `epic:` frontmatter go under a final `(no epic)` group. Never fall back to a flat list or an epic column — the grouped layout renders even when a section has only one epic or a single feature.

Only group by epics that exist in `<SHIPYARD_DATA>/spec/epics/` (verify via Glob) and are referenced by the feature's `epic:` frontmatter field. Do NOT invent categories or group by keywords in titles — a feature whose `epic:` names a nonexistent epic file goes under `(no epic)` with a `⚠️ epic E0NN missing` note.

### `groom` → Interactive grooming session

Walk through each backlog item one at a time. For each item:
1. Read the story file
2. **Display the feature summary as text output before asking for a decision:**
   ```
   ── S004: Bulk Fee Import ──────────────────
   RICE: 24.0 | Points: 13 | Complexity: high
   Status: approved | Age: 75 days | Last discussed: 2026-01-15
   Story: As an admin, I want to import fees from CSV...
   Scenarios: 4 (happy path, validation, duplicates, partial)
   ─────────────────────────────────────────────
   ```
3. Then AskUserQuestion: "Keep / Reprioritize / Split / Archive / Kill?"
   - **Keep** — no changes
   - **Reprioritize** — update RICE component fields via `shipyard-data story set` (ask which dimension changed; the CLI refreshes cached `rice_score`)
   - **Split** — break into smaller features (create new story files, archive original)
   - **Archive** — status to `deferred` (removes from backlog automatically)
   - **Kill** — status to `rejected` (removes from backlog automatically)
   - **Already done** (an idea): `shipyard-data idea set-status <IDEA-id> landed` — it was fixed or built, so it is neither promoted nor rejected. An idea fixed by a named step in a sprint is landed automatically when that sprint is archived.

Also run health checks:
- **Stale items** (>60 days since `updated` in story frontmatter) → force decision
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
- **Apply changes (Recommended)** — write all changes to story files and BACKLOG.md
- **Adjust** — modify specific decisions, iterate
- **Cancel** — discard all grooming changes, BACKLOG.md unchanged

**Important:** Grooming decisions (RICE updates, status changes, splits) are staged in-conversation during the walkthrough — do NOT run any `shipyard-data` mutation until the user approves the summary above. If the user cancels, nothing changes; no CLI command has run yet.

**On approval, apply staged decisions in this order:**
1. For each reprioritization, run `shipyard-data story set F00N rice_reach=... rice_impact=... rice_confidence=... rice_effort=...` (whichever dimensions changed).
2. For each archive/kill, run `shipyard-data story set-status F00N deferred` or `rejected` — this auto-removes the ID from BACKLOG.md, so no separate removal step is needed.
3. Run `shipyard-data backlog rank` to re-sort the survivors by live RICE (relay its missing-RICE report if any).
4. Run `shipyard-data backlog set last_groomed today`.

### `rank` → Re-sort by RICE

Run `shipyard-data backlog rank`; relay its missing-RICE report (items sunk to the bottom because a feature is missing `rice_reach`/`rice_impact`/`rice_confidence`/`rice_effort`).

### `bankruptcy` → Backlog bankruptcy

When backlog is overwhelmingly large (50+ items) or consistently ignored:

1. Read all story files for backlog items, partition into **Keep** and **Archive** groups
2. **Display both lists before asking for confirmation:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 BACKLOG BANKRUPTCY — [N] total items
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 KEEP ([M] items)
  These survive — approved, RICE > 20, or dependency blockers:
  - S009: Maintenance Requests (RICE 32.1, approved)
  - S011: Payment Reminders (RICE 28.4, approved)

 ARCHIVE ([K] items)
  These get archived — low RICE, proposed, stale:
  - S022: Email Digest (RICE 4.2, proposed, 90d stale)
  - S031: Dark Mode (RICE 2.1, proposed, 120d stale)
  [... full list ...]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

3. AskUserQuestion: "Archive [K] items and keep [M]? (yes / adjust / cancel)"
4. If confirmed (staged decisions apply only now, not before):
   - For each archived ID, run `shipyard-data story set-status F00N deferred` (in place — does not move or delete the file; deferred story files persist on disk, there is no automatic reaper). This auto-removes the ID from BACKLOG.md as part of the same call.
   - Run `shipyard-data backlog rank` to re-sort the survivors.
   - Report: "Archived [K] items. [M] remain."

### `approve [IDs]` → Approve proposed features into backlog

For each ID provided, first Read the feature and render the same approval contract required by `/ship-discuss`: full Given/When/Then acceptance scenarios verbatim, `user_flow_probe` kind plus command/steps verbatim, assumptions, unresolved items, and known `skip-with-reason` gaps. Then AskUserQuestion for approval. Only after approval, run `shipyard-data story set-status F00N approved` (the CLI verifies `status: proposed` and refuses otherwise, naming the actual status). Then run one `shipyard-data backlog add <IDs>` call for all of them together — the CLI inserts each in RICE-sorted position and dedupes.

If no IDs provided, render every proposed feature (ID — title | RICE | pts) as chat text, then AskUserQuestion to pick. Feature data sitting in Read results or in the option labels does not count as rendered.

Report: "Approved [N] features into backlog: [IDs]. Run /ship-sprint to plan a sprint."

### `archive` → Archive completed items

Run this periodically (or during grooming) to keep BACKLOG.md lean:

1. Read each story file referenced in BACKLOG.md, find items with status `done`, `deployed`, `released`, or `rejected`
2. Run `shipyard-data backlog remove <IDs>` for the matched IDs
3. Report: "Removed [N] completed items from backlog."

**Auto-trigger:** If BACKLOG.md has more than 50 IDs during any backlog operation, run archival automatically before proceeding.

## Rules

- RICE formula: (Reach × Impact × Confidence%) / Effort
- Default sort: RICE descending
- Overrides allowed — add reasoning in BACKLOG.md Overrides section
- Stale threshold: configurable in config.md (default: 60 days warning, 120 days critical)
- Never auto-delete — archive preserves history
- **All data modifications go to story files** — BACKLOG.md only stores ID order and override reasoning

## Next Up (after grooming or viewing)

```
▶ NEXT UP: Build something
  /ship-sprint — plan a sprint with the top-ranked features
  /ship-discuss [ID] — refine a feature before pulling it in
  (tip: /clear first for a fresh context window)
```
