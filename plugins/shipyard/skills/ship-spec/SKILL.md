---
name: ship-spec
description: "View, browse, search, and manage the product specification. Use when the user wants to see the spec, look up a feature or epic by ID, search for something in the spec, change a feature status, move features between epics, archive spec items, or absorb an external document into the spec."
allowed-tools: [Read, Write, Edit, Grep, Glob, AskUserQuestion, EnterPlanMode, ExitPlanMode]
model: sonnet
effort: medium
argument-hint: "[feature/epic ID] or [search term] or [subcommand]"
---

# Shipyard: Spec Manager

Browse, search, and manage the product specification.

## Context

!`shipyard-context path`

!`shipyard-context spec-counts`

**Data path: use the SHIPYARD_DATA path from context above. For Read/Write/Edit tools, use the full literal path (e.g., `/Users/x/.claude/plugins/data/shipyard/projects/abc123/...`). NEVER use `~` or `$HOME` in file_path — always start with `/`. For Bash: `SD=$(shipyard-data)` then `$SD/...`. Shell variables like `$SD` do NOT work in Read/Write/Edit file_path — only literal paths. NEVER hardcode or guess paths.**

## Input

$ARGUMENTS

## Behavior

### No arguments → Interactive Spec Browser

Start an interactive browsing session. Show the top level and let the user drill down.

**Level 1: Spec Overview**

Read all spec files and present:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPEC — [Project Name]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 EPICS
  [1] E001: [title]
      [████████░░] 80% | 4/5 features done | 24/30 pts
  [2] E002: [title]
      [███░░░░░░░] 30% | 1/3 features done | 5/18 pts

 UNGROUPED FEATURES
  [3] F007: [title] — [status] | [pts] pts
  [4] F012: [title] — [status] | [pts] pts

 COMPLETION
  Overall: [████████░░] [N]% | [done pts]/[total pts] story points
  By status: [N] proposed → [N] approved → [N] in-progress → [N] done → [N] released
  Bugs: [N] open | Ideas: [N] pending

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Completion % computation:**
- Per epic: sum `story_points` from features with `status: done|deployed|released` / sum all feature `story_points` in the epic
- Overall: sum `story_points` from ALL features with `status: done|deployed|released` / sum ALL feature `story_points`
- Progress bars: 10 chars wide, `█` for complete, `░` for remaining

AskUserQuestion: "Pick a number to drill down, or: 'bugs' / 'ideas' / 'search [term]' / 'done'"

**Level 2: Epic Detail** (user picked an epic)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 EPIC: E001 — [title]
 [████████░░] 80% complete | 24/30 pts
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 [description]

 FEATURES
  [1] F001: [title] — released | 8 pts
      Tasks: ✅ 4/4 done
  [2] F003: [title] — done | 8 pts
      Tasks: ✅ 3/3 done
  [3] F005: [title] — in-progress | 8 pts
      Tasks: [██░░░] 2/5 done | T012 blocked
  [4] F009: [title] — approved | 5 pts
      Tasks: not yet decomposed
  [5] F011: [title] — proposed | 1 pts
      Tasks: —

 Points: 24/30 done | 8 in-progress | 6 not started
 Scenarios: [N] total | [N] tested | [N] untested

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

For each feature, read its `tasks:` array, then read each task file to count `status: done` vs total. Show a mini progress bar for in-progress features. Flag blocked tasks inline.

AskUserQuestion: "Pick a number for feature detail, or: 'back' / 'done'"

**Level 3: Feature Detail** (user picked a feature)

Show the full feature spec: user story, acceptance criteria, NFRs, failure modes, technical notes, dependencies, decision log.

**Progress section** (at the top, before spec content):
```
 PROGRESS: F005 — [title]
 Status: in-progress | 8 pts | Sprint sprint-005, Wave 2
 Tasks: [████░░░░░░] 40% | 2/5 done, 1 blocked, 2 pending
   ✅ T010: Setup auth middleware (done)
   ✅ T011: Login endpoint (done)
   ⛔ T012: Token refresh (blocked — API key not provisioned)
   ⬜ T013: Logout endpoint (pending)
   ⬜ T014: Session persistence (pending)
 Scenarios: 4/6 covered by tests
```

Read the feature's `tasks:` array, read each task file for status/effort. Also scan `$(shipyard-data)/spec/bugs/` for bugs with `feature:` matching this ID. Map acceptance scenarios to test coverage by checking if each Given/When/Then has a corresponding test (from review verdicts if available).

Also show linked items:
- References: list with one-line summary
- Bugs: any bugs linked to this feature with status
- Dependencies: features this depends on, with their status (highlights blockers)

AskUserQuestion: "Pick: [task ID] / [ref] / 'edit' / 'back' / 'done'"

**Level 4: Task/Reference Detail** (user picked a task or reference)

Show full content. Then: "back / done"

**The browse loop continues until the user says "done".** Each level reads fresh data from files (not cached). The user can jump directly at any time by typing an ID (e.g., "F003" skips to that feature from any level).

### ID argument → Show full detail (including references)
If the argument is a feature ID (F001), epic ID (E001), task ID (T001), bug ID (B001 or B-HOT-001), or idea ID (IDEA-001):

1. Read and display the main file content.
2. Check the `references:` array in frontmatter.
3. For each file listed in `references:`, read and display it below the main content with a clear separator:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REFERENCE: [filename]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[full content of reference file]
```

Reference files live in `$(shipyard-data)/spec/references/`. They hold full technical content (API contracts, schemas, flows, config specs) and are part of the spec — never skip them.

After showing detail, AskUserQuestion: "What next? (back / edit / related features / done)"

### Search term → Find matches
If argument doesn't match an ID pattern or a known subcommand, search across all spec files:
- Search file names and frontmatter titles
- Search file content for the term
- **Also search `$(shipyard-data)/spec/references/`** — technical docs are part of the spec
- Present matching files with relevant excerpts

### Subcommands

`/ship-spec ideas` — List all captured ideas pending discussion.
  1. Read all files in `$(shipyard-data)/spec/ideas/`.
  2. For each, read frontmatter: `id`, `title`, `created`, and first line of body as description.
  3. Display as a scannable list:

```
IDEAS — [N] pending discussion

  IDEA-001 — [title]
             [first line of description, if any]
             Captured: [date]

  IDEA-002 — [title]
             ...

▶ To flesh out an idea: /ship-discuss IDEA-001
```

  If no ideas exist: "No ideas captured yet. Run /ship-discuss with a quick one-liner to capture one."

`/ship-spec status F001 approved` — Change feature F001 status to approved

`/ship-spec move F001 E002` — Move feature F001 to epic E002

`/ship-spec archive F001` — Archive feature (move to spec/archive/)

`/ship-spec diff F001` — Show change history for F001 (git log for the file)

`/ship-spec absorb F001 <path>` — Pull an external document into the spec as a reference file linked to F001.
  1. Read the file at `<path>` in full — do NOT summarize or truncate.
  2. **Completion check** — before absorbing, determine if this document describes work that's already done:
     - Read the feature file (F001). If `status` is `done`, `deployed`, or `released`:
       ```
       ⚠ F001 ([title]) is already [status]. Absorbing into a completed feature
       adds to the working set without creating new work.
       Options:
       1. Absorb as reference — link it for documentation purposes only
       2. Skip — this feature is done, no need to absorb
       3. Create new feature — the doc describes NEW work beyond what was shipped
       ```
       AskUserQuestion with the options above.
     - If no feature ID provided (auto-match mode below), also check: does the document describe functionality that already exists in the codebase? Grep for key terms from the doc in `$(shipyard-data)/codebase-context.md` and in features with `status: done|deployed|released`. If a match is found, warn before creating a new feature for already-built work.
  3. Infer a slug from the filename (e.g., `spec/docs/payment-flow.md` → `payment-flow`).
  4. Write to `$(shipyard-data)/spec/references/F001-<slug>.md`:
     - If the source file has no YAML frontmatter: prepend `---\nfeature: F001\nsource: <original-path>\n---\n` then the full content.
     - If the source file already has YAML frontmatter (starts with `---`): merge `feature: F001` and `source: <original-path>` into the existing frontmatter block rather than prepending a second one.
  5. Add the full path `$(shipyard-data)/spec/references/F001-<slug>.md` to the `references:` array in F001's frontmatter. Always store full relative paths, not bare filenames.
  6. Confirm: "Absorbed [filename] → $(shipyard-data)/spec/references/F001-<slug>.md and linked to F001."
  If F001 doesn't exist yet, AskUserQuestion: "F001 not found. Create it first with /ship-discuss, then absorb."

`/ship-spec absorb <path>` (no feature ID) — Absorb an external document and auto-match or create a feature for it.
  1. Read the file at `<path>` in full.
  2. **Completion check** — scan the document's content against existing features:
     - Check features with `status: done|deployed|released` — does this doc describe something already shipped?
     - Check `$(shipyard-data)/codebase-context.md` — does this describe existing functionality?
     - If match found: "This document describes [feature/functionality] which is already [status]. Skip, or absorb as reference to [matched feature]? (skip / absorb as ref / create new — this is NEW work)"
  3. From the title/content, find the best matching existing feature (grep for similar titles).
  4. AskUserQuestion: "This looks like it belongs to [F001: Payment Processor]. Absorb there, or create a new feature? (F001 / new / [other ID])"
  5. Proceed with the `absorb F001 <path>` flow above, substituting the chosen feature ID for F001.

`/ship-spec refs F001` — List all reference files linked to F001 with their sizes and a one-line summary of each.

`/ship-spec sync` — Sync completed features back to the user's product spec.

  Shipyard's spec is the working set (what's being planned/built). The user's product spec is the source of truth (what the product IS). After features ship, the product spec should reflect them. This command bridges that gap.

  **Step 1: Find the user's product spec**
  - Read `$(shipyard-data)/codebase-context.md` → check `## Existing Specs` section for indexed doc paths
  - If no indexed specs → AskUserQuestion: "Where is your product spec? Provide a path or directory (e.g., `docs/spec/`, `SPEC.md`, `docs/product/`)"
  - Cache the path in `$(shipyard-data)/config.md` under `product_spec_path:` for future syncs

  **Step 2: Find syncable features**
  - Scan `$(shipyard-data)/spec/features/` for features that have changed since last sync
  - A feature is syncable if:
    - It has no `synced_at:` in frontmatter (never synced), OR
    - Its `updated:` date is newer than `synced_at:` (changed since last sync)
  - Group by what changed:

  | Status | What to sync |
  |---|---|
  | `proposed` with acceptance criteria | Decisions, scope, acceptance criteria from discussion |
  | `approved` | Above + RICE estimates, technical approach, dependencies |
  | `in-progress` | Above + task breakdown, implementation decisions, progress |
  | `done/deployed/released` | Above + final outcome, what shipped, API contracts |

  - Display grouped:
    ```
    Syncable features:

    SHIPPED (full sync — what was built):
      F003: Password Reset (released, last synced: never)
      F005: Refunds (done, last synced: 2026-03-01, updated since)

    DECIDED (scope & decisions — not yet built):
      F009: Maintenance Requests (approved, discussed 2026-03-28)
      F012: Third-Party Auth (proposed, 6 acceptance scenarios defined)

    IN PROGRESS (partial — what's decided + current state):
      F008: Email Notifications (in-progress, 3/5 tasks done)
    ```
  - AskUserQuestion: "Sync all, or pick specific features/groups? (all / shipped only / decided only / pick [IDs])"

  **Step 3: Analyze the user's spec structure**
  - Read the product spec files to understand their format, heading structure, section organization
  - Identify where each unsynced feature belongs:
    - Match by epic → section mapping (if the product spec is organized by domain/area)
    - Match by title/content similarity
    - If no obvious match → note as "new section needed"

  **Step 4: Generate sync patches**
  For each selected feature, generate patches appropriate to its status:

  **Shipped features** (done/deployed/released) — sync the outcome:
  - Acceptance criteria that passed (the definitive behavior)
  - API contracts, data model, configuration (from feature file + references)
  - Flows and state machines (from feature file)
  - Mark as complete/shipped in the product spec

  **Decided features** (proposed/approved with acceptance criteria) — sync the decisions:
  - User story and scope (what was decided to build)
  - Acceptance criteria (the agreed behavior — may change during implementation)
  - Key decisions from the Decision Log (why this approach, what was rejected)
  - Dependencies and constraints identified
  - Mark as planned/upcoming in the product spec
  - Add a note: "Defined in Shipyard — subject to change during implementation"

  **In-progress features** — sync decisions + current state:
  - Everything from "decided" above
  - Current progress (N/M tasks done)
  - Implementation decisions made during sprint planning
  - Any scope changes from the original discussion
  - Mark as in-progress in the product spec

  **Re-syncing** (feature changed since last sync):
  - Diff the feature file against what was synced last time
  - Only update sections that changed — don't rewrite the entire entry
  - If acceptance criteria changed, note: "Updated [date] — [what changed]"

  For ALL sync types:
  - NOT a copy of the Shipyard feature file — distill into the user's doc format and style
  - For existing sections: update with new/changed content
  - For new sections: draft content matching the surrounding doc style

  **Step 5: Present in plan mode**
  Enter plan mode (`EnterPlanMode`) and present all sync patches:

  ```
  SPEC SYNC — [N] features to sync

  SHIPPED:
  [user-spec-file-1.md]:
    Update section "Authentication" — add password reset flow (F003, released)
    Update section "Payments" — add refund handling (F005, done)

  DECIDED:
  [user-spec-file-2.md]:
    New section "Notifications" — email notifications scope & criteria (F007, approved)
    Note: "Defined in Shipyard — subject to change during implementation"

  IN PROGRESS:
  [user-spec-file-1.md]:
    Update section "Auth" — add third-party auth progress (F012, 3/5 tasks done)

  RE-SYNCED (changed since last sync):
  [user-spec-file-1.md]:
    Update section "Payments" — acceptance criteria updated for F005

  Features synced: F003, F005, F007, F012
  ```

  Exit plan mode (`ExitPlanMode`):
  - **Approve** → apply patches to the user's spec files, set `synced_at: [date]` in each feature's frontmatter
  - **Edit** → user adjusts specific patches, then re-approve
  - **Skip** → don't sync, features remain unsynced for next time

`/ship-spec sync F001` — Sync a specific feature only.

`/ship-spec sync --dry-run` — Show what would be synced without making changes.

## Valid Status Transitions

Features follow this lifecycle. Only the transitions shown are valid:

```
proposed → approved → in-progress → done → deployed → released
    ↓         ↓            ↓
 deferred  deferred     approved
    ↓                 (back to backlog)
 rejected

deferred → proposed (revisit)
```

- **proposed** → approved (ready to build), deferred (park it), or rejected (kill it)
- **approved** → in-progress (pulled into a sprint) or deferred (park it)
- **in-progress** → done (work complete) or approved (pulled from sprint, back to backlog)
- **done** → deployed (behind a feature flag) or released (shipped to users)
- **deployed** → released (feature flag removed)
- **deferred** → proposed (revisit later)

Any transition not listed here is invalid — explain why and suggest the correct path. This matches the canonical state machine in `.claude/rules/shipyard-data-model.md`.

When changing status, update it **in the feature file frontmatter** (single source of truth). Do NOT update status in BACKLOG.md or SPRINT.md — those are generated views.

## Rules

- **CRITICAL: All Shipyard data lives at `$(shipyard-data)/`.** Always resolve the path by running `shipyard-data` in Bash. NEVER hardcode paths like `.shipyard/` or guess absolute paths. NEVER look for Shipyard data in other worktrees or directories. When you need to read spec files, run: `SPEC=$(shipyard-data)/spec` then use `$SPEC/features/`, `$SPEC/epics/`, etc.
- Read-only by default. Only modify files when an explicit subcommand is used.
- When changing status, validate the transition is legal using the state machine above.
- When archiving, move file to `$(shipyard-data)/spec/archive/` and remove the ID from BACKLOG.md (if present).
- For status changes that remove from backlog (approved → deferred), remove the ID from BACKLOG.md. No other data needs updating — BACKLOG.md only stores IDs.
- **Always use AskUserQuestion when clarification is needed:**
  - ID not found → AskUserQuestion: "[ID] doesn't exist. Did you mean [closest match]? Or provide the correct ID."
  - Ambiguous search returns multiple matches → AskUserQuestion: "Found [N] matches: [list]. Which one?"
  - Invalid status transition → AskUserQuestion: "[current] → [requested] isn't valid. Valid transitions from [current]: [list]. Which would you like?"
  - Subcommand unclear or missing required argument → AskUserQuestion with usage hint and options.

## Next Up (after status change or archive)

```
▶ NEXT UP: Continue working
  /ship-sprint — plan a sprint (if features are now approved)
  /ship-backlog — groom the backlog
  /ship-status — check current state
  (tip: /clear first for a fresh context window)
```
