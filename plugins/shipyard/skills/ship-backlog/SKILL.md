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
- **NEVER dispatch a subagent (Agent/Explore/Task) for the board or for a story's details.** What a subagent gathers never lands in this context. The board comes from one CLI call; a single story's details come from one Read.
- **Render before asking.** The board is printed by the CLI and shown first: `shipyard-data backlog board`, written into the chat as it is, BEFORE the first AskUserQuestion (see "The board comes first"). Do not read every story file to build a board by hand. The ask at the end of the board is the ONLY entry into the interactive loop. Follow SHIPYARD_STARTUP_RULES and SHIPYARD_ONBOARDING_INSTRUCTION from startup.
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

### The board comes first, in every mode

**Step 1, always, before anything else and before any question:** run `shipyard-data backlog board` and write its whole output in the chat as it is, inside a code block, from the `BOARD ·` line to the `end of board` line. Add one line under it with what you recommend, end the message with the line `Question follows.` and end your turn there. Shipyard gives the turn straight back, and only then you ask. (A question sent in the same message as the board is refused, because the hook cannot yet see that message.)

- The CLI builds the board: the sprint, the backlog in rank order grouped by epic, what is not scored yet, proposed stories, and the ideas waiting for a decision. Do not read story, epic or idea files to build it, and do not rebuild, reorder, shorten or summarise it.
- A tool result is not seen by the person. Only your own text is. So the board is your first message, and a one-line summary may come after it, never instead of it.
- The card hook refuses a `/ship-backlog` question while the board is not in the chat.
- The numbers in brackets run across all sections; the person can answer with a number or an id.
- After a change (approve, rank, archive, a grooming decision), run it again and print the new board.

### No arguments → Show backlog

Print the board (Step 1). Then:

- **Backlog and proposed are both empty** → add one line, `Nothing to groom. Refine an idea with /ship-discuss IDEA-NNN, or capture one with /ship-discuss <one-liner>.`, and STOP. No question: a board with nothing to groom has no next step to pick.
- **Backlog empty, proposed stories waiting** → offer to approve them. Before any approval option, read each candidate story and write its approval contract in the chat: title, story points, RICE parts, one plain line per acceptance criterion (its id and what a person would see, in a few everyday words; `shipyard-data story acs <id>` lists them), never the Given/When/Then text, the `user_flow_probe` kind and its command or steps word for word, assumptions, unresolved items. A title and a score are not enough to approve on. Then one card: "Approve these and add them to the backlog?" (yes / pick / discuss first). **yes** → `shipyard-data story set-status <id> approved` for each, then one `shipyard-data backlog add <ids...>`. **pick** → the person names the ids. **discuss first** → suggest `/ship-discuss <id>` for the first one.
- **Otherwise** → one card: "Pick a number for details, or: groom / rank / approve [ids] / done".

**Drill-down** (the person picked a number or typed an id): read that one story and show its summary: the user story, how many acceptance scenarios, points, RICE parts, epic, what it waits for, status, age. Then one card: "reprioritize / split / archive / kill / approve / back / done". After an action, print the board again.

**An idea was picked:** ideas have no score and nothing to groom. Say: "Ideas are refined with `/ship-discuss IDEA-NNN`." and show the board's question again.

The loop ends when the person says "done".

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

For each ID provided, first Read the feature and render the same approval contract required by `/ship-discuss`: one plain line per acceptance criterion (its id and what a person would see, in a few everyday words; `shipyard-data story acs <id>` lists them), never the Given/When/Then text; `user_flow_probe` kind plus command/steps verbatim, assumptions, unresolved items, and known `skip-with-reason` gaps. Then AskUserQuestion for approval. Only after approval, run `shipyard-data story set-status F00N approved` (the CLI verifies `status: proposed` and refuses otherwise, naming the actual status). Then run one `shipyard-data backlog add <IDs>` call for all of them together — the CLI inserts each in RICE-sorted position and dedupes.

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
- **The order is the owner's.** One list, ordered by what a delay costs (who is hurt by a week's wait, how much, how soon). Place an item with `shipyard-data backlog move <id> --top | --above <id> | --below <id> | --to <n> --why "<what a delay costs>"`: the reason is kept and shown as "why here". After the first placement nothing re-sorts the list by score, and a new story waits at the bottom until it is placed. RICE only gives the first sort of a list nobody has ordered yet (`backlog rank`, which refuses once the owner has ordered it). When grooming, ask about the top items first and record each answer as a move with its reason
- **Releases are fix versions.** The board opens with the planned releases (`RELEASES`). What ships in one: `shipyard-data version show <name>`. Put an item in a release, or move it: `shipyard-data version set <version> <id> [--reason "<why the forecast changed>"]` (a move always says why). Never hand-edit `fix_version`, and never make an epic stand for a release
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
