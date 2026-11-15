---
name: ship-spec
description: "View, search, and manage the product spec."
allowed-tools: [Read, Write, Edit, Grep, Glob, AskUserQuestion, "Bash(shipyard-context:*)", "Bash(shipyard-data:*)"]
argument-hint: "[feature/epic ID] or [search term] or [subcommand]"
---

# Shipyard: Spec Manager

Browse, search, and manage the product specification.

## Context

!`shipyard-context spec-context`

**Shell.** Bash is for `shipyard-context` (reads) and `shipyard-data feature|backlog|idea ...` (state mutations) ONLY — no other shell. Never hand-Edit story-file frontmatter or BACKLOG.md IDs/`last_groomed` — those are CLI-owned (`story set`, `story set-status`, `backlog add|remove|rank|set`). Feature/epic bodies and the BACKLOG.md Overrides section remain Edit-tool surface.

**Render before asking.** Follow SHIPYARD_STARTUP_RULES and SHIPYARD_ONBOARDING_INSTRUCTION from startup.

## Input

$ARGUMENTS

## Behavior

### No arguments → Interactive Spec Browser

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
  [3] S007: [title] — [status] | [pts] pts
  [4] S012: [title] — [status] | [pts] pts

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
  [1] S001: [title] — released | 8 pts
      Tasks: ✅ 4/4 done
  [2] S003: [title] — done | 8 pts
      Tasks: ✅ 3/3 done
  [3] S005: [title] — in-progress | 8 pts
      Tasks: [██░░░] 2/5 done | P012 blocked
  [4] S009: [title] — approved | 5 pts
      Tasks: not yet decomposed
  [5] S011: [title] — proposed | 1 pts
      Tasks: —

 Points: 24/30 done | 8 in-progress | 6 not started
 Scenarios: [N] total | [N] tested | [N] untested

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

For each feature, read its `tasks:` array, then read each step file to count `status: done` vs total. Show a mini progress bar for in-progress features. Flag blocked tasks inline.

AskUserQuestion: "Pick a number for feature detail, or: 'back' / 'done'"

**Level 3: Feature Detail** (user picked a feature)

Show the full feature spec: user story, acceptance criteria, NFRs, failure modes, technical notes, dependencies, decision log.

**Progress section** (at the top, before spec content):
```
 PROGRESS: S005 — [title]
 Status: in-progress | 8 pts | Sprint sprint-005, Wave 2
 Tasks: [████░░░░░░] 40% | 2/5 done, 1 blocked, 2 pending
   ✅ P010: Setup auth middleware (done)
   ✅ P011: Login endpoint (done)
   ⛔ P012: Token refresh (blocked — API key not provisioned)
   ⬜ P013: Logout endpoint (pending)
   ⬜ P014: Session persistence (pending)
 Scenarios: 4/6 covered by tests
```

Read the feature's `tasks:` array, read each step file for status/effort. Also use Grep with `pattern: ^feature: F<NNN>$`, `path: <SHIPYARD_DATA>/spec`, `glob: {stories,bugs}/[SB]*.md`, `output_mode: files_with_matches` to find related bugs, then Read each. Map acceptance scenarios to test coverage by checking if each Given/When/Then has a corresponding test (from review verdicts if available).

Also show linked items:
- References: list with one-line summary
- Bugs: any bugs linked to this feature with status
- Dependencies: features this depends on, with their status (highlights blockers)

AskUserQuestion: "Pick: [task ID] / [ref] / 'edit' / 'back' / 'done'"

**Level 4: Task/Reference Detail** (user picked a task or reference)

Show full content. Then: "back / done"

The browse loop continues until the user says "done"; each level reads fresh data from files (not cached); typing an ID (e.g., "S003") jumps directly to it from any level.

### ID argument → Show full detail (including references)
If the argument is a feature ID (S001), epic ID (E001), task ID (P001), bug ID (B001 or S001), or idea ID (IDEA-001):

1. Read and display the main file content.
2. Check the `references:` array in frontmatter.
3. For each file listed in `references:`, read and display it below the main content with a clear separator:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REFERENCE: [filename]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[full content of reference file]
```

Reference files live in `<SHIPYARD_DATA>/spec/references/`. They are part of the spec — never skip them.

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
  2. For each, read frontmatter: `id`, `title`, `created` (fallback: legacy `captured`), `status`, and first line of body as description. Skip files whose `status:` is `promoted` (legacy `graduated`; already promoted to a story or epic), `rejected` (triaged out) or `parked`.
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

`/ship-spec status S001 approved` — Change feature S001 status to approved. Approval is special: before running the CLI, Read the feature and render the full approval contract as chat text — every Given/When/Then acceptance scenario verbatim, `user_flow_probe` kind plus command/steps verbatim, assumptions, unresolved items, and known `skip-with-reason` gaps — then AskUserQuestion for approval. Only after approval, run `shipyard-data story set-status S001 approved`. On exit 3 (illegal transition), print the CLI's valid-next-states list as chat text, then AskUserQuestion: "S001 is [current status]. Valid next states: [list from the CLI's error]. Which would you like?" For non-approval statuses, run `shipyard-data story set-status <id> <status>` directly after rendering the current status and target.

`/ship-spec move S001 E002` — Move feature S001 to epic E002. Run `shipyard-data story set S001 epic=E002` (the CLI verifies E002 exists under `spec/epics/` before writing).

`/ship-spec archive S001` — Archive feature: run `shipyard-data story set-status S001 deferred` (do NOT physically move the file — the soft-deleted record stays in place; physical removal is manual for now). The CLI removes S001's ID from BACKLOG.md automatically as part of the status change — no separate BACKLOG.md edit needed.

`/ship-spec diff S001` — Show change history for S001 (git log for the file)

`/ship-spec absorb S001 <path>` — Pull an external document into the spec as a reference file linked to S001.
  1. Read the file at `<path>` in full — do NOT summarize or truncate.
  2. **Completion check** — before absorbing, determine if this document describes work that's already done:
     - Read the story file (S001). If `status` is `done`, `deployed`, or `released`:
       ```
       ⚠ S001 ([title]) is already [status]. Absorbing into a completed feature
       adds to the working set without creating new work.
       Options:
       1. Absorb as reference — link it for documentation purposes only
       2. Skip — this feature is done, no need to absorb
       3. Create new feature — the doc describes NEW work beyond what was shipped
       ```
       AskUserQuestion with the options above.
     - If no feature ID provided (auto-match mode below), also check: does the document describe functionality that already exists in the codebase? Use Grep for key terms from the doc against `<SHIPYARD_DATA>/codebase-context.md` and against story files matching `status: done|deployed|released` (use Grep with `pattern: ^status: (done|deployed|released)`, `glob: {stories,features}/[SF]*.md`, `path: <SHIPYARD_DATA>/spec` (glob `{stories,features}/[SF]*.md`), `output_mode: files_with_matches`, then Read each). If a match is found, warn before creating a new feature for already-built work.
  3. Infer a slug from the filename (e.g., `spec/docs/payment-flow.md` → `payment-flow`).
  4. Use the Write tool to create `<SHIPYARD_DATA>/spec/references/S001-<slug>.md`:
     - If the source file has no YAML frontmatter: prepend `---\nfeature: S001\nsource: <original-path>\n---\n` then the full content.
     - If the source file already has YAML frontmatter (starts with `---`): merge `feature: S001` and `source: <original-path>` into the existing frontmatter block rather than prepending a second one.
  5. Run `shipyard-data story add-ref S001 <SHIPYARD_DATA>/spec/references/S001-<slug>.md` to add the full path to S001's `references:` array (the CLI dedupes — re-absorbing the same path is a no-op).
  6. **External reference detection:** If the absorbed document mentions issue keys matching common patterns (`[A-Z]+-\d+` for Jira/Linear, `#\d+` for GitHub/GitLab), offer to add them via AskUserQuestion: "Document references [KEY]. Link it to this feature? (yes / no)" — on yes, run `shipyard-data story add-external-ref S001 [KEY]`.
  7. Confirm: "Absorbed [filename] → <SHIPYARD_DATA>/spec/references/S001-<slug>.md and linked to S001."
  If S001 doesn't exist yet, AskUserQuestion: "S001 not found. Create it first with /ship-discuss, then absorb."

`/ship-spec absorb <path>` (no feature ID) — Absorb an external document and auto-match or create a feature for it.
  1. Read the file at `<path>` in full.
  2. **Completion check** — scan the document's content against existing features:
     - Check features with `status: done|deployed|released` — does this doc describe something already shipped?
     - Read `<SHIPYARD_DATA>/codebase-context.md` and Grep it for key terms from the document — does this describe existing functionality?
     - If match found: "This document describes [feature/functionality] which is already [status]. Skip, or absorb as reference to [matched feature]? (skip / absorb as ref / create new — this is NEW work)"
  3. From the title/content, find the best matching existing feature (grep for similar titles).
  4. Render the match evidence as chat text first — the document's title/one-line gist and the matched feature line (ID — title — why it matches). The document Read and the title-grep results don't count as shown.
  5. AskUserQuestion: "This looks like it belongs to [S001: Payment Processor]. Absorb there, or create a new feature? (S001 / new / [other ID])"
  6. Proceed with the `absorb S001 <path>` flow above, substituting the chosen feature ID for S001.

`/ship-spec refs S001` — List all reference files linked to S001 with their sizes and a one-line summary of each.

`/ship-spec sync` — Sync completed features back to the user's product spec.

  **Step 1: Find the user's product spec**
  - Read `<SHIPYARD_DATA>/codebase-context.md` → check `## Existing Specs` section for indexed doc paths
  - If no indexed specs → AskUserQuestion: "Where is your product spec? Provide a path or directory (e.g., `docs/spec/`, `SPEC.md`, `docs/product/`)"
  - Run `shipyard-data config set product-spec-path <path>` to cache it in `<SHIPYARD_DATA>/config.md` for future syncs

  **Step 2: Find syncable features**
  - Use Glob `<SHIPYARD_DATA>/spec/{stories,features}/[SF]*.md` to enumerate story files, then Read each and check `synced_at` vs `updated` in frontmatter to find features changed since last sync
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
      S003: Password Reset (released, last synced: never)
      S005: Refunds (done, last synced: 2026-03-01, updated since)

    DECIDED (scope & decisions — not yet built):
      S009: Maintenance Requests (approved, discussed 2026-03-28)
      S012: Third-Party Auth (proposed, 6 acceptance scenarios defined)

    IN PROGRESS (partial — what's decided + current state):
      S008: Email Notifications (in-progress, 3/5 tasks done)
    ```
  - AskUserQuestion: "Sync all, or pick specific features/groups? (all / shipped only / decided only / pick [IDs])"

  **Step 3: Analyze the user's spec structure**
  - Read the product spec files to understand their format, heading structure, section organization
  - Identify where each unsynced feature belongs:
    - Match by epic → section mapping (if the product spec is organized by domain/area)
    - Match by title/content similarity
    - If no obvious match → note as "new section needed"

  **Step 4: Generate sync patches**
  For each feature, generate a patch sized to its status. Patches are distilled into the user's doc format and style — never a verbatim copy of the Shipyard story file. Update existing sections in place; draft new sections to match the surrounding tone.

  | Status | Sync content | Marking |
  |---|---|---|
  | done / deployed / released | Acceptance criteria that passed, API contracts, data model, configuration (from story file + references), flows and state machines | Complete / shipped |
  | proposed / approved (with acceptance criteria) | User story and scope, acceptance criteria, key Decision Log entries, dependencies and constraints | Planned / upcoming + "Defined in Shipyard — subject to change during implementation" |
  | in-progress | Everything from "approved" above, plus current progress (N/M tasks done), sprint-planning decisions, and any scope changes from the original discussion | In-progress |

  **Re-sync** (feature changed since last sync): diff the story file against the last-synced version. Only update sections that changed — don't rewrite the entire entry. If acceptance criteria changed, note `Updated [date] — [what changed]`.

  **Step 5: Present sync patches**
  Output all sync patches as text:

  ```
  SPEC SYNC — [N] features to sync

  SHIPPED:
  [user-spec-file-1.md]:
    Update section "Authentication" — add password reset flow (S003, released)
    Update section "Payments" — add refund handling (S005, done)

  DECIDED:
  [user-spec-file-2.md]:
    New section "Notifications" — email notifications scope & criteria (S007, approved)
    Note: "Defined in Shipyard — subject to change during implementation"

  IN PROGRESS:
  [user-spec-file-1.md]:
    Update section "Auth" — add third-party auth progress (S012, 3/5 tasks done)

  RE-SYNCED (changed since last sync):
  [user-spec-file-1.md]:
    Update section "Payments" — acceptance criteria updated for S005

  Features synced: S003, S005, S007, S012
  ```

  Then use `AskUserQuestion` for approval:
  - **Apply sync (Recommended)** — apply patches to the user's spec files, then run `shipyard-data story set F00N synced_at=<today's date>` for each synced feature
  - **Edit** — adjust specific patches, then re-approve
  - **Skip** — don't sync, features remain unsynced for next time

  **External references:** Preserve `external_refs` during sync — never overwrite or clear. When generating sync output, include external refs so the user's session knows which external issues to update.

`/ship-spec sync S001` — Sync a specific feature by Shipyard ID. Runs the same Steps 1-5 above but scoped to one feature. After syncing to the user's product spec, also push to external systems:

  **External system push (opportunistic):** If the feature has `external_refs` and the session has matching MCP tools (Jira, GitHub, Linear, etc.):
  1. For each external ref, check if a write tool is available (e.g., `jira_update_issue`, `jira_add_comment`, `update_issue`, `add_issue_comment`)
  2. If a comment tool exists: post a sync comment to the external issue:
     ```
     Shipyard sync — S001: [title]
     Status: [status]
     Acceptance criteria: [N] scenarios ([M] met)
     Sprint: [sprint-id or "not yet planned"]
     ```
  3. If a status-update tool exists and the feature is `done`/`deployed`/`released`: offer to transition the external issue too. AskUserQuestion: "S001 is [status]. Update SYS-123 status in your tracker? (yes / no)"
  4. If no write tools available: skip silently — the sync output already includes external refs for the user to act on manually.

`/ship-spec sync SYS-123` — Sync by external issue key. Resolves the key to a Shipyard feature by grepping `external_refs` across all story files, then runs the `sync S001` flow above.

  - Grep `<SHIPYARD_DATA>/spec/{stories,features}/[SF]*.md` for the literal string `SYS-123` in frontmatter `external_refs` arrays
  - If exactly one feature matches → sync it
  - If multiple features match → AskUserQuestion: "SYS-123 is linked to [S001: Title] and [S005: Title]. Sync which? (S001 / S005 / both)"
  - If no feature matches → "No Shipyard feature is linked to SYS-123. Run `/ship-discuss SYS-123` to create one, or `/ship-spec absorb S001 SYS-123` to link it to an existing feature."

`/ship-spec sync --dry-run` — Show what would be synced without making changes. Includes external system actions that would be taken.

## Valid Status Transitions

Stories (`type: feature` or `type: bug`) follow this lifecycle. Only the transitions shown are valid. The other entities have their own graphs, all CLI-enforced (`bin/spec-lifecycle.mjs`): ideas `captured → assessing → promoted | rejected | parked` (`shipyard-data idea set-status … promoted --to <S###|E###>`), epics `decided → refined → in-progress → done` (`shipyard-data epic set-status`), tasks `open → in-progress → done | dropped` (`shipyard-data task set-status`), steps keep the builder allowlist (`shipyard-data step set-status`).

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

Any transition not listed here is invalid — explain why and suggest the correct path. This matches the canonical state machine in `${CLAUDE_PLUGIN_ROOT}/project-files/rules/shipyard-data-model.md` (rules live in the plugin in 2.0, no longer copied into `.claude/rules/`). **Canonical source: `bin/spec-lifecycle.mjs`** — `shipyard-data story set-status` enforces this graph; the diagram above is documentation, not the authority.

When changing status, run `shipyard-data story set-status <SID> <status>` (single source of truth is the CLI-written story file frontmatter). Do NOT update status in BACKLOG.md or SPRINT.md — those are generated views.

## Rules

- Read-only by default. Only modify files when an explicit subcommand is used.
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
