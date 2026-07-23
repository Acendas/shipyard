---
name: ship-spec
description: "View, search, and manage the product spec."
allowed-tools: [Read, Write, Edit, Grep, Glob, AskUserQuestion, "Bash(shipyard-context:*)", "Bash(shipyard-data:*)"]
argument-hint: "[feature/epic ID] or [search term] or [subcommand]"
---

# Shipyard: Spec Manager

Browse, search, and manage the product specification.

## Context

!`shipyard-context path`

!`shipyard-context spec-counts`

**Paths.** All file ops use the absolute SHIPYARD_DATA prefix from the context block. No `~`, `$HOME`, or shell variables in `file_path`. Bash is for `shipyard-context` (reads) and `shipyard-data feature|backlog|idea ...` (state mutations) ONLY — no other shell. **Never use `echo`/`printf`/shell redirects to write state files** — use the Write tool (auto-approved for SHIPYARD_DATA). Never hand-Edit feature-file frontmatter or BACKLOG.md IDs/`last_groomed` — those are CLI-owned (`feature set`, `feature set-status`, `backlog add|remove|rank|set`). Feature/epic bodies and the BACKLOG.md Overrides section remain Edit-tool surface.

**Render before asking.** Before every AskUserQuestion, render the decision context — the scenarios, concrete examples, tradeoffs, and any verbatim content being approved — as chat text; the tool call then carries only the short question and option labels. A bare AskUserQuestion with no rendered context above it is a bug (the window is too small to carry a real decision). Content that exists only in a Read result, a subagent/Agent return, a dossier file, or the question/option strings themselves does not count as rendered (the UI shows a compact card) — restate it as assistant chat text immediately above the ask.

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

Read the feature's `tasks:` array, read each task file for status/effort. Also use Grep with `pattern: ^feature: F<NNN>$`, `path: <SHIPYARD_DATA>/spec/bugs`, `glob: B*.md`, `output_mode: files_with_matches` to find related bugs, then Read each. Map acceptance scenarios to test coverage by checking if each Given/When/Then has a corresponding test (from review verdicts if available).

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

Reference files live in `<SHIPYARD_DATA>/spec/references/`. They hold full technical content (API contracts, schemas, flows, config specs) and are part of the spec — never skip them.

After showing detail, AskUserQuestion: "What next? (back / edit / related features / done)"

### Search term → Find matches
If argument doesn't match an ID pattern or a known subcommand, search across all spec files:
- Search file names and frontmatter titles
- Search file content for the term
- **Also search `<SHIPYARD_DATA>/spec/references/`** via Grep with `path: <SHIPYARD_DATA>/spec/references` — technical docs are part of the spec
- Present matching files with relevant excerpts

### Subcommands

`/ship-spec ideas` — List all captured ideas pending discussion.
  1. Use Glob with `pattern: <SHIPYARD_DATA>/spec/ideas/IDEA-*.md` to enumerate idea files, then Read each.
  2. For each, read frontmatter: `id`, `title`, `created`, `status`, and first line of body as description. Skip files where `status: graduated` (they were already promoted to features).
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

`/ship-spec status F001 approved` — Change feature F001 status to approved. Run `shipyard-data feature set-status F001 approved`. On exit 3 (illegal transition), print the CLI's valid-next-states list as chat text, then AskUserQuestion: "F001 is [current status]. Valid next states: [list from the CLI's error]. Which would you like?"

`/ship-spec move F001 E002` — Move feature F001 to epic E002. Run `shipyard-data feature set F001 epic=E002` (the CLI verifies E002 exists under `spec/epics/` before writing).

`/ship-spec archive F001` — Archive feature: run `shipyard-data feature set-status F001 deferred` (do NOT physically move the file — the soft-deleted record stays in place; physical removal is manual for now). The CLI removes F001's ID from BACKLOG.md automatically as part of the status change — no separate BACKLOG.md edit needed.

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
     - If no feature ID provided (auto-match mode below), also check: does the document describe functionality that already exists in the codebase? Use Grep for key terms from the doc against `<SHIPYARD_DATA>/codebase-context.md` and against feature files matching `status: done|deployed|released` (use Grep with `pattern: ^status: (done|deployed|released)`, `glob: F*.md`, `path: <SHIPYARD_DATA>/spec/features`, `output_mode: files_with_matches`, then Read each). If a match is found, warn before creating a new feature for already-built work.
  3. Infer a slug from the filename (e.g., `spec/docs/payment-flow.md` → `payment-flow`).
  4. Use the Write tool to create `<SHIPYARD_DATA>/spec/references/F001-<slug>.md`:
     - If the source file has no YAML frontmatter: prepend `---\nfeature: F001\nsource: <original-path>\n---\n` then the full content.
     - If the source file already has YAML frontmatter (starts with `---`): merge `feature: F001` and `source: <original-path>` into the existing frontmatter block rather than prepending a second one.
  5. Run `shipyard-data feature add-ref F001 <SHIPYARD_DATA>/spec/references/F001-<slug>.md` to add the full path to F001's `references:` array (the CLI dedupes — re-absorbing the same path is a no-op).
  6. **External reference detection:** If the absorbed document mentions issue keys matching common patterns (`[A-Z]+-\d+` for Jira/Linear, `#\d+` for GitHub/GitLab), offer to add them via AskUserQuestion: "Document references [KEY]. Link it to this feature? (yes / no)" — on yes, run `shipyard-data feature add-external-ref F001 [KEY]`.
  7. Confirm: "Absorbed [filename] → <SHIPYARD_DATA>/spec/references/F001-<slug>.md and linked to F001."
  If F001 doesn't exist yet, AskUserQuestion: "F001 not found. Create it first with /ship-discuss, then absorb."

`/ship-spec absorb <path>` (no feature ID) — Absorb an external document and auto-match or create a feature for it.
  1. Read the file at `<path>` in full.
  2. **Completion check** — scan the document's content against existing features:
     - Check features with `status: done|deployed|released` — does this doc describe something already shipped?
     - Read `<SHIPYARD_DATA>/codebase-context.md` and Grep it for key terms from the document — does this describe existing functionality?
     - If match found: "This document describes [feature/functionality] which is already [status]. Skip, or absorb as reference to [matched feature]? (skip / absorb as ref / create new — this is NEW work)"
  3. From the title/content, find the best matching existing feature (grep for similar titles).
  4. Render the match evidence as chat text first — the document's title/one-line gist and the matched feature line (ID — title — why it matches). The document Read and the title-grep results don't count as shown.
  5. AskUserQuestion: "This looks like it belongs to [F001: Payment Processor]. Absorb there, or create a new feature? (F001 / new / [other ID])"
  6. Proceed with the `absorb F001 <path>` flow above, substituting the chosen feature ID for F001.

`/ship-spec refs F001` — List all reference files linked to F001 with their sizes and a one-line summary of each.

`/ship-spec sync` — Sync completed features back to the user's product spec.

  Shipyard's spec is the working set (what's being planned/built). The user's product spec is the source of truth (what the product IS). After features ship, the product spec should reflect them. This command bridges that gap.

  **Step 1: Find the user's product spec**
  - Read `<SHIPYARD_DATA>/codebase-context.md` → check `## Existing Specs` section for indexed doc paths
  - If no indexed specs → AskUserQuestion: "Where is your product spec? Provide a path or directory (e.g., `docs/spec/`, `SPEC.md`, `docs/product/`)"
  - Run `shipyard-data config set product-spec-path <path>` to cache it in `<SHIPYARD_DATA>/config.md` for future syncs

  **Step 2: Find syncable features**
  - Use Glob `<SHIPYARD_DATA>/spec/features/F*.md` to enumerate feature files, then Read each and check `synced_at` vs `updated` in frontmatter to find features changed since last sync
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
  For each feature, generate a patch sized to its status. Patches are distilled into the user's doc format and style — never a verbatim copy of the Shipyard feature file. Update existing sections in place; draft new sections to match the surrounding tone.

  | Status | Sync content | Marking |
  |---|---|---|
  | done / deployed / released | Acceptance criteria that passed, API contracts, data model, configuration (from feature file + references), flows and state machines | Complete / shipped |
  | proposed / approved (with acceptance criteria) | User story and scope, acceptance criteria, key Decision Log entries, dependencies and constraints | Planned / upcoming + "Defined in Shipyard — subject to change during implementation" |
  | in-progress | Everything from "approved" above, plus current progress (N/M tasks done), sprint-planning decisions, and any scope changes from the original discussion | In-progress |

  **Re-sync** (feature changed since last sync): diff the feature file against the last-synced version. Only update sections that changed — don't rewrite the entire entry. If acceptance criteria changed, note `Updated [date] — [what changed]`.

  **Step 5: Present sync patches**
  Output all sync patches as text:

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

  Then use `AskUserQuestion` for approval:
  - **Apply sync (Recommended)** — apply patches to the user's spec files, then run `shipyard-data feature set F00N synced_at=<today's date>` for each synced feature
  - **Edit** — adjust specific patches, then re-approve
  - **Skip** — don't sync, features remain unsynced for next time

  **External references:** Preserve `external_refs` during sync — never overwrite or clear. When generating sync output, include external refs so the user's session knows which external issues to update.

`/ship-spec sync F001` — Sync a specific feature by Shipyard ID. Runs the same Steps 1-5 above but scoped to one feature. After syncing to the user's product spec, also push to external systems:

  **External system push (opportunistic):** If the feature has `external_refs` and the session has matching MCP tools (Jira, GitHub, Linear, etc.):
  1. For each external ref, check if a write tool is available (e.g., `jira_update_issue`, `jira_add_comment`, `update_issue`, `add_issue_comment`)
  2. If a comment tool exists: post a sync comment to the external issue:
     ```
     Shipyard sync — F001: [title]
     Status: [status]
     Acceptance criteria: [N] scenarios ([M] met)
     Sprint: [sprint-id or "not yet planned"]
     ```
  3. If a status-update tool exists and the feature is `done`/`deployed`/`released`: offer to transition the external issue too. AskUserQuestion: "F001 is [status]. Update SYS-123 status in your tracker? (yes / no)"
  4. If no write tools available: skip silently — the sync output already includes external refs for the user to act on manually.

`/ship-spec sync SYS-123` — Sync by external issue key. Resolves the key to a Shipyard feature by grepping `external_refs` across all feature files, then runs the `sync F001` flow above.

  - Grep `<SHIPYARD_DATA>/spec/features/F*.md` for the literal string `SYS-123` in frontmatter `external_refs` arrays
  - If exactly one feature matches → sync it
  - If multiple features match → AskUserQuestion: "SYS-123 is linked to [F001: Title] and [F005: Title]. Sync which? (F001 / F005 / both)"
  - If no feature matches → "No Shipyard feature is linked to SYS-123. Run `/ship-discuss SYS-123` to create one, or `/ship-spec absorb F001 SYS-123` to link it to an existing feature."

`/ship-spec sync --dry-run` — Show what would be synced without making changes. Includes external system actions that would be taken.

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

Any transition not listed here is invalid — explain why and suggest the correct path. This matches the canonical state machine in `${CLAUDE_PLUGIN_ROOT}/project-files/rules/shipyard-data-model.md` (rules live in the plugin in 2.0, no longer copied into `.claude/rules/`). **Canonical source: `bin/spec-lifecycle.mjs`** — `shipyard-data feature set-status` enforces this graph; the diagram above is documentation, not the authority.

When changing status, run `shipyard-data feature set-status <FID> <status>` (single source of truth is the CLI-written feature file frontmatter). Do NOT update status in BACKLOG.md or SPRINT.md — those are generated views.

## Rules

- Read-only by default. Only modify files when an explicit subcommand is used.
- Status changes go through `shipyard-data feature set-status` — it validates the transition against `spec-lifecycle.mjs` and refuses illegal ones with the valid next states.
- When archiving, run `shipyard-data feature set-status <FID> deferred`. Do NOT physically move files — physical removal is manual; the soft-delete keeps history queryable. The CLI removes the ID from BACKLOG.md automatically as part of the same call — no separate edit needed.
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
