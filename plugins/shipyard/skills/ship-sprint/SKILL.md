---
name: ship-sprint
description: "Plan a new sprint — break features into tasks, find the critical path, and group tasks into waves for parallel execution. Or cancel an active sprint. Use when the user wants to start a sprint, plan work, pull features from backlog into a sprint, cancel a running sprint, or organize tasks into execution waves."
allowed-tools: [Read, Write, Edit, Grep, Glob, LSP, Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode, WebSearch, WebFetch]
model: opus
effort: high
argument-hint: "[--cancel]"
---

# Shipyard: Sprint Planning

Plan a new sprint by pulling features from the backlog and decomposing into waves.

## Context

!`shipyard-context path`
!`shipyard-context head config.md 50 NO_CONFIG`
!`shipyard-context head backlog/BACKLOG.md 50 NO_BACKLOG`
!`shipyard-context head sprints/current/SPRINT.md 30 NO_ACTIVE_SPRINT`
!`shipyard-context head memory/metrics.md 20 NO_METRICS`
!`shipyard-context head codebase-context.md 30 "No codebase context"`

**Data path: use the SHIPYARD_DATA path from context above. For Read/Write/Edit tools, use the full literal path (e.g., `/Users/x/.claude/plugins/data/shipyard/projects/abc123/...`). NEVER use `~` or `$HOME` in file_path — always start with `/`. For Bash: `SD=$(shipyard-data)` then `$SD/...`. Shell variables like `$SD` do NOT work in Read/Write/Edit file_path — only literal paths. NEVER hardcode or guess paths.**

## Input

$ARGUMENTS

## Session Guard

**First action before anything else:** Write `.active-session.json` to the SHIPYARD_DATA directory (use the full literal path from context above — e.g., `/Users/x/.claude/plugins/data/shipyard/projects/abc123/.active-session.json`). This prevents post-compaction implementation drift:

```json
{
  "skill": "ship-sprint",
  "topic": "sprint planning",
  "started": "[ISO date]"
}
```

This file activates a PreToolUse hook that blocks source code writes during planning. If you find yourself wanting to write implementation code, STOP — you are planning, not executing.

## Detect Mode

- If `--cancel` → CANCEL mode
- If active sprint exists and is not complete:
  Read current sprint state — features, tasks per wave, progress (`current_wave` from PROGRESS.md), remaining capacity (capacity minus completed story points).

  AskUserQuestion: "Sprint [ID] is active ([N]/[M] tasks done, wave [W], [X] pts remaining of [Y] capacity). What would you like to do? (add features / cancel and replan / finish current first)"

  - **add features** → EXTEND mode
  - **cancel and replan** → CANCEL mode, then PLAN mode
  - **finish current first** → abort, suggest `/ship-execute`

- If completed sprint exists in `current/` (status: `completed` but not archived):
  Show what was found:
  ```
  Found completed sprint [ID] that wasn't archived:
    Features: [list with statuses]
    Branch: [branch name] — [merged/unmerged]
    Velocity recorded: [yes/no]
  ```

  Handle cleanup transparently:
  1. If velocity not recorded → record it now (sum story_points from done features, write to metrics.md)
  2. Archive: move `$(shipyard-data)/sprints/current/*` → `$(shipyard-data)/sprints/sprint-NNN/`
  3. Report: "Archived sprint [ID]. Velocity: [N] pts recorded."
  4. Then proceed to PLAN mode

- Otherwise → PLAN mode

---

### Compaction Recovery

If you lose context mid-planning (e.g., after auto-compaction):

1. Check for `$(shipyard-data)/sprints/current/SPRINT-DRAFT.md`
   - If draft exists, check staleness: read `created` from frontmatter. If the draft is from a previous session (more than a few hours old) → AskUserQuestion: "A sprint draft from [date] exists with features [list]. Resume it, or delete and start fresh? (resume / start fresh)"
   - If current/resumed → load it, skip to Step 10 (Present Plan and Confirm)
2. If no draft, check `$(shipyard-data)/spec/tasks/` for recently-created task files with `status: approved`
   - Group by parent feature (each task has `feature:` in frontmatter)
   - **Verify completeness**: confirm all selected features have at least one task file. If any features have no tasks, those were not yet decomposed — fall through to branch 3 (restart from Step 1) rather than presenting an incomplete plan
   - These are the features selected in Step 2, decomposed in Step 4
   - Re-derive wave structure from task dependency fields (Steps 5-9)
   - Write SPRINT-DRAFT.md, proceed to Step 10
3. If no draft and no new task files → planning hadn't progressed past Step 3; restart from Step 1

The draft captures the full sprint plan (waves, critical path, execution mode). Task files capture the decomposition. Between these two, full state reconstructs from files.

---

## PLAN Mode

**Communication design:** Follow the 3-layer explanation pattern and hard targets from `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md` for all user-facing questions. Frame velocity as what's achievable, not limiting: "Based on past sprints, you can comfortably deliver ~20 points" not "Your velocity limits you to 20 points." When capacity is exceeded, name the tradeoff: "Ambitious (proceed, risk overrun)" vs "Focused (drop F-005, clean finish)" vs "Flexible (you pick what to drop)."

### Step 1: Determine Capacity

Read velocity from `$(shipyard-data)/memory/metrics.md` (loaded in context above). Look for `Velocity: N pts` lines from prior sprints. If multiple sprints exist, average the last 3 for a rolling velocity.

Also scan metrics.md for `Throughput:` lines (format: `Throughput: X.X pts/hr (N pts in M.M hrs active)  # Sprint NNN`). Extract the float value before `pts/hr` from each line. Average the last 3 values (or all available if fewer than 3 exist) → `avg_throughput`. If no `Throughput:` lines exist, `avg_throughput` is null.

If velocity data exists → AskUserQuestion: "Based on past sprints, you typically complete ~[N] points. Adjust? (accept / set new capacity)"
If no velocity data (first sprint or metrics empty) → AskUserQuestion: "No prior velocity data. How many story points for this sprint? (default: 20 for solo dev)"

If the user provides a new capacity value, use that figure for the rest of this planning session (feature selection, capacity warnings, etc.). AskUserQuestion: "Save [N] points as the new default velocity in config.md? (yes / no, just this sprint)"

### Step 1.5: Carry-Over Scan

Before selecting features, scan for unfinished work from previous cycles. These items take priority over new features — they represent commitments already made.

**Scan these locations:**

1. **Open bugs** — `$(shipyard-data)/spec/bugs/` for files with `status: open` or `status: investigating`. Read each to get title, severity, source (sprint ID, code review, integration test).
2. **Blocked tasks** — `$(shipyard-data)/spec/tasks/` for files with `status: blocked`. Read each to get title, parent feature, blocked reason.
3. **Retro action items** — `$(shipyard-data)/spec/ideas/` for files with `source: retro-*`. These are improvements the team committed to during retrospectives.
4. **In-progress features** — `$(shipyard-data)/spec/features/` for files with `status: in-progress` that are NOT in an active sprint. These were started but not completed/approved in a previous sprint.

**Display carry-over work before the feature list (if any exists):**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 CARRY-OVER (from previous sprints)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 BUGS ([N] open)
  B-CR-001 — Missing null check in auth middleware (code review, must-fix)
  B-INT-002 — Payment webhook timeout (integration test failure)

 BLOCKED TASKS ([N])
  T045 — OAuth token refresh (blocked: API key not provisioned)
    Parent: F012 — Third-Party Auth

 RETRO ITEMS ([N])
  IDEA-042 — Add request tracing headers (retro-sprint-005)
  IDEA-043 — Reduce test flakiness in CI (retro-sprint-005)

 INCOMPLETE FEATURES ([N])
  F008 — Email Notifications (in-progress, 3/5 tasks done)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then AskUserQuestion: "Found [N] carry-over items from previous sprints. Include all in this sprint, pick specific items, or skip to new features? (all / pick / skip)"

- **all** → include all carry-over items, deduct their points from capacity before selecting new features
- **pick** → user selects which carry-over items to include
- **skip** → proceed to new features only (carry-over items stay for next sprint)

For bugs: create tasks from bug files (if not already decomposed). For blocked tasks: re-add to wave structure after verifying blocker is resolved. For retro items: run through a quick inline discuss (no full `/ship-discuss` — just confirm scope and create a task). For incomplete features: re-decompose remaining tasks only.

### Step 2: Select Features

Read BACKLOG.md (which contains only feature IDs and rank order). For each ID, read the feature file to get title, RICE, points, status, complexity.

If no approved features exist in the backlog and no carry-over items were selected → AskUserQuestion: "No approved features in the backlog. Would you like to: (1) run /ship-discuss to define features, (2) run /ship-backlog to groom existing items, or (3) pull a specific feature ID?"

**Display the actual features with real data before asking the user to choose.** Never ask "which features?" without showing them first.

Output the feature list as formatted text:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 AVAILABLE FEATURES (sorted by RICE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 1. F009 — Maintenance Requests
    Points: 8 | RICE: 32.1 | Complexity: medium

 2. F011 — Payment Reminders
    Points: 5 | RICE: 28.4 | Complexity: low

 3. F004 — Bulk Fee Import
    Points: 13 | RICE: 24.0 | Complexity: high

 Capacity: ~20 pts (from velocity)
 Suggested: F009 + F011 = 13 pts (7 pts room)

 PROJECTIONS
 ⏱ Time:   ~1.6 hrs (8.2 pts/hr avg, last 3 sprints)
 🎟 Tokens: ~650K estimated (F009: ~250K, F011: ~400K)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Projection display rules:**

**Time projection:**
- Read `avg_throughput` from metrics.md (average pts/hr from last 3 sprints)
- If available: `Time: ~M.M hrs (X.X pts/hr avg, last N sprints)` — computed as `selected_pts / avg_throughput`
- If not available (first sprint): `Time: unknown (will appear after first sprint completes)`

**Token projection:**
- Sum `token_estimate` from each selected feature file's frontmatter
- Show per-feature breakdown and total: `Tokens: ~NNK estimated (F001: ~250K, F002: ~400K)`
- If `token_estimate` is 0 on any feature, note: `Tokens: partially estimated — F003 has no token estimate yet`

**As features are selected and total points change**, update both projections:
```
Selected: 13 pts | ~1.6 hrs | ~650K tokens
```

These projections help the user answer:
1. **"Do I have enough time?"** — compare projected hours against available time
2. **"Will I exhaust my token quota?"** — compare projected tokens against API limits/plan allowance

Then AskUserQuestion: "Which features for this sprint? (list IDs, or 'suggested' to accept)"

### Step 3: Research Before Planning

**Read the full planning checklists:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/planning-checklists.md` — contains Definition of Ready gate, cross-cutting concerns audit, knowledge gap assessment, risk register, MoSCoW classification, SOLID/12-Factor/CAP checks, three-point estimation, reference class forecasting, and test strategy template. Apply these throughout Steps 3-9.

Before breaking features into tasks, research how to build each one well. Start by reading what ship-discuss already found, then go deeper into implementation specifics.

**For each selected feature:**

**Internal research (first)** — **use LSP first** (`documentSymbol`, `findReferences`, `goToDefinition`, `hover`) for all code navigation. It's faster and uses fewer tokens than reading whole files. Fall back to Grep/Read if LSP isn't available. See `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/lsp-strategy.md`.
- Read the feature file fully — Technical Notes, and also Interface, Data Model, Configuration, Flows, Error Handling sections if present
- Check `references:` in the feature's frontmatter — each entry is a full relative path (e.g., `$(shipyard-data)/spec/references/F001-api.md`). Read each listed file directly for full API contracts, schemas, and protocol specs. This is where the detailed technical content lives.
- Identify patterns already in use — how similar things are built in this project
- Check shared utilities, components, or services that can be reused (don't hand-roll what exists)
- **Scan project tools** — check what the user already has set up:
  - `.claude/skills/` — any custom skills? (e.g., `/deploy`, `/test-e2e`, `/lint`). These might be relevant to task execution or could be referenced in task Technical Notes.
  - `.claude/agents/` — any custom agents? These could be leveraged during execution instead of building from scratch.
  - `.claude/rules/` — read ALL project rules (not just `shipyard-*`). These contain architecture constraints, naming conventions, banned patterns, and domain vocabulary that tasks MUST respect. Flag any rules that specifically affect this feature.
  - `CLAUDE.md` — project-level instructions that may constrain how the feature is built
  - `.claude/rules/learnings/` — past learnings that apply to this feature's domain

**Architecture impact analysis (second)** — map the system layers this feature touches:
- Trace the request/data flow end-to-end: which layers are involved? (UI → API → service → data → external)
- For each layer: what files/modules need to change? What's the blast radius?
- What are the system boundaries? Where does this feature cross a boundary? (e.g., crossing from client to server, from one service to another, from app code to infrastructure)
- What are the dependencies — both upstream (what this feature needs to exist first) and downstream (what depends on code we're changing)?
- Are there shared interfaces, contracts, or schemas that other parts of the system rely on? Changing these has wider impact.
- What's the data flow? New tables, new fields on existing tables, new API endpoints, new events/messages?
- Are there cross-cutting concerns? (auth, logging, caching, rate limiting, i18n) Which ones does this feature need to integrate with?
- Draw the picture: which boxes in the architecture does this feature touch and how do they connect?

**Implementation strategy (third)** — figure out how to get from current state to target state safely:
- What existing code needs to change? Is it a clean addition, a refactor, or a migration?
- If touching existing code: what refactoring methodology applies? (Strangler Fig, Branch by Abstraction, Parallel Change, Extract-Replace, etc.)
- What's the incremental delivery path? Can we ship intermediate steps that are independently valuable?
- What design principles apply? (SOLID, separation of concerns, dependency inversion, etc. — only cite what's specifically relevant, not a generic list)
- What should we NOT do? (anti-patterns for this specific domain/stack — e.g., "don't modify the ORM schema directly, use migrations")
- What's the rollback story if something goes wrong mid-implementation?

**External research (fourth)**:
- WebSearch: implementation best practices for the specific tech stack (include year for currency, e.g. "Next.js 15 auth middleware 2026")
- WebSearch: common pitfalls for this domain (security, performance, edge cases)
- WebSearch: refactoring/migration patterns if touching existing code (e.g. "strangler fig pattern [framework] 2026")
- WebFetch: library docs for URLs found in the feature's Technical Notes

### Step 3.5: Rules Compliance Check

Before anything else, verify selected features comply with current project rules. Rules may have been added or updated AFTER features were discussed — specs can be stale.

**Process:**
1. Read ALL project rules: glob `.claude/rules/project-*.md` and `.claude/rules/learnings/*.md`
2. For each selected feature, read its acceptance criteria and Technical Notes
3. Check for contradictions — does any acceptance scenario violate a rule?

**Common contradictions:**
- Feature spec says "poll every N minutes" but rules say "event-driven first"
- Feature spec says "store in local file" but rules say "use database for persistent state"
- Feature spec assumes a pattern that learnings say to avoid
- Feature spec uses terminology that doesn't match domain vocabulary in rules

**For each violation found:**

Output the explanation (what the spec says, what the rule says, why they conflict), then AskUserQuestion:

```
F010 Scenario 4 contradicts .claude/rules/event-driven-first.md:
  Spec says: "periodic 1hr health check"
  Rule says: "prefer event-driven push over polling"

1. Update spec — rewrite the scenario to comply (I'll update the feature file now)
2. Send back to discuss — this feature needs rethinking (/ship-discuss F010)
3. Override rule — the spec is intentionally different here (document why in decision log)
4. Remove scenario — it's no longer needed

Recommended: 1 — the spec predates the rule, update to match current architecture
```

After resolving all violations, proceed. Features sent back to discuss are removed from this sprint's selection.

### Step 3.55: Terminology Alignment Check

Verify that the language in feature specs matches what the codebase actually calls things. Mismatched terminology causes builders to create duplicate code, use wrong APIs, or implement against the wrong abstractions.

**Process:**

1. **Extract key terms from each feature spec** — entity names, API endpoints, component names, state names, event names, database table/column names mentioned in acceptance criteria, data model, or interface sections

2. **Search the codebase for each term** — Grep for the exact name and common variants (camelCase, snake_case, PascalCase, plural/singular):
   - Does this entity/component/table exist in code?
   - What is it actually called? (the spec might say "user" but code says "account", spec says "notification" but code says "alert")
   - Are there naming convention differences? (spec says "payment_status" but code enum is `PaymentState`)

3. **Check domain vocabulary** — if `.claude/rules/project-*.md` defines a domain vocabulary (term mappings, canonical names), verify spec terms match

4. **Report mismatches:**
   ```
   TERMINOLOGY MISMATCHES — F009: Maintenance Requests

   Spec says          Code uses           Where in code
   ─────────────────────────────────────────────────────
   "tenant"           "organization"      src/models/Organization.ts
   "maintenance_req"  "service_request"   src/api/serviceRequests.ts
   "submitted"        "pending"           src/types/RequestStatus.ts
   "admin"            "manager"           src/auth/roles.ts
   ```

   For each mismatch, AskUserQuestion:
   ```
   1. Update spec — use the code's terminology (recommended for existing entities)
   2. Update code — rename to match the spec (only if the spec term is better)
   3. Keep both — they're different concepts despite similar names (document the distinction)
   ```

5. **Update feature files** with resolved terminology before decomposing tasks. This prevents builders from creating `Tenant` models when `Organization` already exists.

Skip this step if the codebase is empty (greenfield project — no existing terms to conflict with).

### Step 3.6: Definition of Ready Gate


Before decomposing, verify each feature is ready. Run the Definition of Ready checks from `planning-checklists.md`. If any feature fails → send back to `/ship-discuss` or resolve now.

Also run the **Cross-Cutting Concerns Audit** from the checklists — for each feature, check auth, logging, caching, rate limiting, analytics, feature flags, background jobs, notifications, search, migration, config. Record what's needed in task Technical Notes.

Run the **Knowledge Gap Assessment** — flag tasks in unfamiliar domains, add research time to estimates.

**Auto-generate SME skills for knowledge gaps:** If knowledge gaps cluster around a specific technology that has no existing skill in `.claude/skills/` (e.g., multiple tasks need OAuth patterns but no `/oauth-expert` skill exists), silently spawn `shipyard:shipyard-skill-writer` for that specific technology. The agent generates the skill without user interaction. Report in the sprint plan output: "Generated /[tech]-expert skill to fill knowledge gap."

### Step 3.7: Surface Implementation Decisions

After research, identify every point where there's a meaningful choice — don't silently pick one and move on. Common decision points:

- **Library/framework choice** — "Use Zustand vs Redux vs Jotai for state management"
- **Architecture approach** — "Server components vs client components for this page"
- **Data modeling** — "Separate table vs JSON column for this data"
- **API design** — "REST vs GraphQL vs tRPC for this endpoint"
- **Migration strategy** — "Big bang vs incremental strangler fig"
- **Build vs buy** — "Hand-roll auth vs use Auth.js vs use Clerk"

For each decision point:

1. **Output explanation** (plain text) — describe the options, tradeoffs, what the codebase already uses, what research found, and your recommendation with reasoning
2. **AskUserQuestion** — short summary with numbered choices and your recommendation

```
State management approach for F001:

1. Library A — already used in the project, team knows it, well-documented
2. Library B — newer, less boilerplate, but no team experience
3. Custom solution — full control, but more code and maintenance

Recommended: 1 — already a dependency, aligns with existing patterns in the codebase
```

**If research can't resolve the decision** — offer a POC spike:

```
I can't confidently recommend an approach here. Want me to spike it?

1. Spike it — I'll build a minimal POC in a worktree to test [option A] vs [option B] (takes ~5-10 min, throwaway code)
2. Pick one — go with [your recommendation] and course-correct during execution if needed
3. Defer — park this feature and plan the rest of the sprint

Recommended: 1 — the risk of picking wrong is high enough to justify a quick spike
```

**POC spike flow (if user chooses spike):**
1. Spawn a `shipyard:shipyard-builder` subagent with `isolation: worktree`
2. Prompt: "Build a minimal proof-of-concept to test [specific question]. No tests needed, no production quality. Just prove whether [approach] works. Report: what worked, what didn't, any gotchas, your recommendation."
3. Builder works in a throwaway worktree — no commits to the user's branch
4. Read the builder's findings
5. Present findings to user with updated recommendation
6. AskUserQuestion with the revised choices
7. Record decision in the feature's Decision Log: "POC spike: tested [approach], found [result], chose [decision]"
8. Worktree is automatically cleaned up (throwaway)

The POC takes minutes, not hours. It answers "will this work?" with evidence instead of guessing.

**If no meaningful choices exist** (the codebase already uses a framework, there's only one sensible approach, or the feature is straightforward) — skip this step for that feature and note in Technical Notes: "No implementation decisions — approach follows existing patterns."

**Record all decisions** in the feature file's `## Decision Log` with date and reasoning. These decisions flow into task Technical Notes so the builder knows what was decided and why.

**Write findings to each task file `## Technical Notes`** (after Step 4 creates task files):

```markdown
## Technical Notes

### Implementation Context

**Architecture**
- Layers touched: [e.g., UI → API → service → DB]
- Blast radius: [what else could break if this changes]
- Boundaries crossed: [e.g., client/server, service/service]
- Shared contracts affected: [interfaces, schemas, APIs that other code depends on]

**Files to modify**
- [exact path] — [what changes needed]

**Patterns to follow**
- [file path] — [what to mirror] (confidence: HIGH)

**Strategy**
- [refactoring/migration approach if touching existing code — e.g., "Extract interface first, then swap implementation"]
- [incremental steps — what can be shipped independently]
- [rollback plan — what to revert if this fails]

**Principles**
- [specific design principles that apply — e.g., "Depend on the abstraction (PaymentProvider), not the implementation (Stripe)"]

**Don't do**
- [anti-pattern for this specific context] — [why and what to do instead]

**Don't hand-roll**
- [problem] → use [existing library/utility] instead (confidence: HIGH)

**Docs & references**
- [URL] — [what to read, specific section] (confidence: HIGH/MEDIUM)

**Gotchas**
- [common mistake] — [how to avoid] (confidence: HIGH/MEDIUM/LOW)

**Cleanup**
- [dead code, unused imports, deprecated patterns, stale config to remove after this task]
- [temporary scaffolding from this task that must be removed later]
- [feature flags, TODO comments, or migration shims to clean up post-release]

**Code snippets**
- [exact code pattern to follow — copy-paste ready, with placeholders marked as `<PLACEHOLDER>`]
- [second pattern if multiple files need similar changes]

**Verification steps**
- [ ] [specific check: "run X, expect Y"]
- [ ] [specific check: "open Z, verify W is visible"]
- [ ] [acceptance scenario Given/When/Then mapped to exact test assertion]

**Expected output**
- [what the task produces when done — e.g., "new file at src/lib/auth.ts with createSession() exported"]
- [observable behavior — e.g., "POST /api/login returns 200 with { token, expiresAt } on valid credentials"]
```

Confidence levels: **HIGH** = verified in official docs or codebase. **MEDIUM** = multiple sources agree but not officially verified. **LOW** = single source or AI knowledge only.

Be prescriptive: "Use X" not "Consider X or Y". The builder needs decisions, not options.

Task specs should be executable — a builder should be able to follow them mechanically without re-reading the feature file. Include enough detail that the builder's thinking time is near zero. If the builder has to guess, the spec is incomplete.

### Step 3.75: Simplification Opportunity Scan

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/simplification-scan.md`

Now that research has identified the libraries, patterns, and utilities this sprint will introduce, scan the codebase for simplification opportunities. This is more concrete than the discuss-time scan because implementation decisions have been made and files-to-modify are identified.

**Skip if:** no selected feature introduces new libraries, shared utilities, or patterns (purely additive features with no reusable infrastructure).

**Process:**
1. For each selected feature, extract from research findings and decision log:
   - New libraries being added (from Step 3.7 decisions)
   - New utilities/helpers being created (from architecture analysis)
   - New patterns being introduced (from implementation strategy)
2. Run the 5 detection strategies from the protocol against the codebase
3. Also check existing IDEA files from `$(shipyard-data)/spec/ideas/` with `source: "simplification-scan"` — a previous `/ship-discuss` may have already found opportunities for features now entering the sprint. Re-evaluate those: are they still valid? Can any be promoted to sprint tasks now?

**Routing at sprint time:**

| Effort | Route | Action |
|---|---|---|
| **Trivial** (< 15 min, < 5 files) | Extend existing task | Add to the relevant task's Technical Notes under **Cleanup** |
| **Small** (< 1 hr, < 10 files) | New cleanup task | Create a task in the final wave with dependency on the feature task that introduces the new thing |
| **Medium/Large** | IDEA file | Create or keep existing IDEA file for backlog |

**Scope guard:** Total effort of trivial + small items MUST NOT exceed 20% of sprint capacity. Excess → demote to IDEA files.

Present findings using the protocol's format and AskUserQuestion: "Apply these simplification opportunities? (all / pick / skip)"

- **all** → extend tasks, create cleanup tasks, create/keep IDEA files
- **pick** → user selects
- **skip** → note in sprint draft: "Simplification scan ran, opportunities deferred"

### Step 4: Decompose Tasks (informed by research)

During decomposition, always include cleanup as explicit tasks — not afterthoughts. If the architecture analysis found dead code, deprecated patterns, stale config, temporary scaffolding, or migration shims that need removing, create dedicated cleanup tasks. These go in the final wave (after implementation is verified) so they don't block feature work but don't get forgotten either.

For each selected feature, read its spec file and:
1. Check the feature's `tasks:` array in frontmatter ��� are tasks already defined?
2. If not, break into atomic tasks and create task files in `$(shipyard-data)/spec/tasks/TNNN-[slug].md` with frontmatter: id, title, feature (parent ID), status, effort (S/M/L), dependencies
3. Update the feature's `tasks:` array with the new task IDs
4. Task files are the **single source of truth** for task data — title, effort, status, dependencies all live there
5. **Populate `## Technical Notes` in each task file** using findings from Steps 3–3.5: architecture impact, files to modify, implementation strategy, decisions from the Decision Log, patterns to follow, gotchas, cleanup items. Use the template format defined above. Every task must have Technical Notes — the builder reads these before writing any code.

**Task size guard:** A single builder agent has limited context. Tasks with many discrete items (migrations, endpoints, config entries, etc.) MUST be split so no single task has more than **8 discrete items** to implement. For example, "migrate 24 ConfigLoader calls" becomes 3 tasks of 8 each, not one task of 24. The builder will lose items past ~10 and silently mark the task done. Count the items in Technical Notes — if >8, split the task. Each sub-task should list its specific items in an explicit checklist in Technical Notes so the builder can verify completeness.

### Step 5: Build Task Dependency Graph

Build the dependency graph from task files. Read each task file's frontmatter to determine which tasks depend on which. Do NOT duplicate task data into SPRINT.md — the sprint file only stores task IDs grouped by wave.

### Step 6: Find the Bottleneck

Identify the longest chain of dependent tasks (the critical path). If any of these tasks are delayed, the whole sprint is delayed.

### Step 7: Wave Assignment

Waves are groups of tasks that can run together. Tasks in the same wave don't depend on each other, so they can run in parallel. Each wave finishes before the next one starts.

Group tasks into waves:
- Wave 1: tasks with no dependencies (these start first)
- Wave 2: tasks that depend only on wave 1 tasks
- Wave N: tasks that depend only on earlier wave tasks

Rules:
- Tasks within a wave have NO dependencies on each other
- Each wave completes fully before the next starts
- Mark which waves can run in parallel (multiple subagents)

### Step 8: Determine Execution Mode

Based on total tasks and wave structure:
- 1-3 tasks → Solo mode
- 4-10 tasks → Subagent mode
- 10+ tasks → Team mode (if team_size > solo in config)

### Step 9: Prepare Sprint Plan

Generate next sprint ID (sprint-NNN). Compute the full plan in memory:
- SPRINT.md content: sprint goal, capacity, wave structure (task IDs only), critical path, execution mode
- PROGRESS.md content: empty current wave tracker and session log

Write `$(shipyard-data)/sprints/current/SPRINT-DRAFT.md` as a compaction checkpoint:

```yaml
---
id: sprint-NNN
status: draft
goal: [sprint goal]
capacity: [N] pts
features: [F001, F005]
execution_mode: [solo|subagent|team]
created: [ISO date]
---
```

Body: wave structure (task IDs per wave), critical path, risk register. This is NOT the approved sprint — it's recoverable state. The user must still approve before the sprint is created. Step 11 overwrites this with the approved SPRINT.md.

Include a `## Risks` section derived from: critical path tasks, external deps, knowledge gaps, spec uncertainty, and technical debt (format from `planning-checklists.md`).

### Step 9.5: Quality Gate (self-review loop)

Before presenting the plan, review your own output. Re-read each task file and the sprint draft, checking:

| # | Check | Fail criteria |
|---|---|---|
| 1 | **Every task has files-to-modify identified** | Architecture section empty or says "TBD" |
| 2 | **Architecture layers mapped per task** | No layers/blast radius/boundaries listed |
| 3 | **No task depends on something undefined** | Dependency references a task ID that doesn't exist |
| 4 | **Implementation strategy is prescriptive** | "Consider X or Y" instead of "Use X" |
| 5 | **Cleanup tasks captured** | Architecture analysis found dead code/deprecated patterns but no cleanup task exists |
| 6 | **No circular dependencies** | Task A → B → C → A |
| 7 | **Every task has clear acceptance criteria** | Task description is vague ("implement feature") without specific deliverable |
| 8 | **Effort estimates present** | Any task has no S/M/L effort |
| 9 | **Critical path makes sense** | Bottleneck task has no clear reason for being the bottleneck |
| 10 | **Wave assignment respects dependencies** | A task appears in the same wave as a task it depends on |
| 11 | **Test strategy present** | Any task has no Test Strategy section |
| 12 | **Cross-cutting concerns addressed** | Feature needs auth/logging/caching but no task covers it |
| 13 | **Risk register populated** | Sprint has critical-path or external deps but no risks section |
| 14 | **MoSCoW classified** | Acceptance criteria not tagged MUST/SHOULD/COULD/WON'T |
| 15 | **PERT estimates for uncertain tasks** | High-uncertainty task has single-point estimate only |

**Iteration loop:**
1. Run the checklist against each task file and the sprint draft
2. If any check fails → fix it (update task files, recompute waves if needed)
3. Re-run checklist
4. Max 3 iterations. If gaps remain → flag them in the sprint plan summary as "Planning gaps — review during execution"

Only proceed to Step 9.7 when the checklist passes or max iterations reached.

### Step 9.7: Adversarial Critique

After the self-review quality gate passes, spawn the critic agent to challenge the sprint plan from angles the self-review doesn't cover — implicit assumptions in Technical Notes, estimate realism, wave conflict risks, and rollback gaps.

**Determine stakes level:**
- `high` if: sprint has 10+ tasks, total story_points >= 20, any feature touches auth/payments/data, or critical path has 4+ tasks
- `standard` otherwise

**Spawn the critic:**
```
subagent_type: shipyard:shipyard-critic
```

Prompt the critic with:
- Mode: `sprint-critique`
- Stakes: `[standard|high]`
- Artifact paths: SPRINT-DRAFT.md path + all task file paths (full paths from `$(shipyard-data)/spec/tasks/`)
- Also include feature spec paths (the critic needs to verify tasks cover all acceptance scenarios)
- Codebase context path: `$(shipyard-data)/codebase-context.md`
- Project rules: `.claude/rules/project-*.md`

**Process the critic's findings:**

1. Read the `PRIORITY ACTIONS` section — these are mandatory fixes
2. For each FAIL item and HIGH-risk assumption:
   - Task completeness gaps → create missing tasks, update wave structure
   - Wave conflict risks → re-assign tasks to different waves
   - Estimate realism concerns → adjust effort estimates, potentially split tasks
   - Technical Notes gaps → add missing implementation detail
   - Dependency chain risks → add mitigation to risk register
   - If requires user judgment → collect into a single AskUserQuestion with the critic's evidence and your recommendation
3. For CONCERN items: note them in the `## Risks` section of SPRINT-DRAFT.md as "Critic flagged — [summary]. Mitigation: [your plan]" or fix if quick
4. For RECONSIDER verdicts from Pass 3 (steel-man challenges on implementation decisions): AskUserQuestion with both options and the critic's reasoning, plus your recommendation
5. If fixes changed the wave structure, re-verify no circular dependencies and no same-wave dependency violations

**Do NOT re-run the critic after fixes.** One round only. Address what you can, ask the user about the rest, and proceed.

### Step 10: Present Plan in Plan Mode

**Enter plan mode** (`EnterPlanMode`) to present the complete sprint plan. SPRINT-DRAFT.md and task files are already written as compaction checkpoints — no statuses change and no features move from backlog until the user approves.

The plan should include:

**SPRINT [NNN] — [Goal]**
- Features: list with IDs and titles
- Tasks: [N] across [M] waves
- Critical path: [T001 → T003 → T007]
- Execution mode: solo/subagent/team

**PROJECTIONS**
- Time: ~M.M hrs (X.X pts/hr avg from past sprints)
- Tokens: ~NNNK estimated (per-feature breakdown)

**WAVE BREAKDOWN** — show as a visual timeline followed by per-wave detail:
```
  Wave 1  ████████░░░░░░░░░░░░  T001, T002           (8 pts)
  Wave 2  ░░░░░░░░████████░░░░  T003, T004, T005     (12 pts)
  Wave 3  ░░░░░░░░░░░░░░░░████  T006                 (5 pts)
```
Then for each wave: task IDs + titles, execution (sequential/parallel), dependencies satisfied by previous waves.

**DEPENDENCY GRAPH** — if tasks have cross-wave dependencies, show a DAG:
```
  T001 ─┬─▶ T003 ─▶ T006
        │
  T002 ─┘   T004
             T005
```

**RISKS** — from the risk register:
- Risk, likelihood, impact, mitigation

**DECISIONS MADE** — from Step 3.7:
- Key implementation choices and reasoning

**QUALITY GATE RESULTS** — from Step 9.5:
- All checks passed, or flagged gaps

**Exit plan mode** (`ExitPlanMode`) — triggers the built-in approval flow:
- **Approve** → proceed to Step 11 (create sprint)
- **Refine** → user gives feedback, iterate on specific tasks/waves
- **Cancel** → delete SPRINT-DRAFT.md, delete task files created in Step 4, clear `tasks:` arrays in feature frontmatter

### Step 11: Create Sprint (after approval)

If approved:

1. Delete SPRINT-DRAFT.md (superseded by the approved SPRINT.md). Write SPRINT.md and PROGRESS.md
2. Update feature statuses to `in-progress` in feature frontmatter
3. Remove pulled feature IDs from BACKLOG.md
4. **Record working branch** — capture the user's current branch: `git branch --show-current`. Write `branch: <current branch>` to SPRINT.md frontmatter. Shipyard works on whatever branch the user is already on — it does not create sprint branches.

**Clean up session guard:** Delete `$(shipyard-data)/.active-session.json` — planning is complete.

Then show:
```
▶ NEXT UP: Start building
  /ship-execute
  (tip: /clear first for a fresh context window)
```

---

## EXTEND Mode (add features to active sprint)

Add features to an in-progress sprint without cancelling. This is a mid-sprint scope extension.

### Step E1: Show Current Sprint + Available Features

Display side by side:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 CURRENT SPRINT [NNN]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Progress: Wave [W] of [M] | [N]/[T] tasks done
 Capacity: [used]/[total] pts ([remaining] pts remaining)

 Current features:
   F007 — Auth Login (3/4 tasks done)
   F009 — Maintenance (0/3 tasks done)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 AVAILABLE TO ADD (from backlog, sorted by RICE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 1. F011 — Payment Reminders
    Points: 5 | RICE: 28.4 | Fits remaining capacity: yes

 2. F004 — Bulk Fee Import
    Points: 13 | RICE: 24.0 | Fits remaining capacity: no (8 pts over)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

AskUserQuestion: "Which features to add? (list IDs)"

### Step E2: Capacity Check

Sum new points + existing used points. If over capacity by >10%:
AskUserQuestion: "Adding [features] puts sprint at [N]/[M] pts ([X]% over capacity). Proceed anyway, or drop something? (proceed / drop [ID] from sprint / cancel)"

### Step E3: Decompose New Features

Same as PLAN mode Steps 3-4: research each new feature, create task files, update feature `tasks:` arrays.

### Step E4: Slot Into Waves

New tasks go into the wave structure:
1. Read current wave from PROGRESS.md (`current_wave`)
2. Tasks with no dependencies on existing work → add to the current wave (if it hasn't started) or the next wave
3. Tasks that depend on in-progress work → add to the wave after their dependency completes
4. Tasks that depend on each other → chain into sequential waves as normal

Never reorder or modify already-completed waves. Only add to the current wave (if unstarted tasks exist) or append new waves.

### Step E5: Update Sprint Files

1. Add new task IDs to SPRINT.md wave structure
2. Update SPRINT.md frontmatter: add new feature IDs to `features:`, update capacity used
3. Update feature statuses to `in-progress` in feature frontmatter
4. Remove new feature IDs from BACKLOG.md
5. Log in SPRINT.md swap log: `| [date] | [added IDs] | — | Mid-sprint extension |`

Then show:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPRINT UPDATED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Added: [feature list]
 New tasks: [N] across [M] waves
 Capacity: [used]/[total] pts

 Updated wave structure:
   Wave 1: ✅ done
   Wave 2: [existing + new task IDs] (current)
   Wave 3: [new task IDs] (added)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▶ NEXT UP: Continue building
  /ship-execute
  (tip: /clear first for a fresh context window)
```

---

## CANCEL Mode

1. AskUserQuestion: "Why are you cancelling this sprint? (This feeds the retro.)"
2. For each task in the sprint:
   - **Done tasks** → keep commits, status stays `done`
   - **In-progress tasks** → commit work-in-progress with `wip(cancel):` prefix, update status to `approved` in task file frontmatter, update parent **feature** status to `approved` in feature frontmatter, add feature ID back to BACKLOG.md
   - **Not started tasks** → update status to `approved` in task file frontmatter, update parent **feature** status to `approved` in feature frontmatter, add feature ID back to BACKLOG.md
   - For all cancelled features (not done): clear the `tasks:` array in feature frontmatter so the next sprint planning re-decomposes them fresh
3. Sprint status → `cancelled`
4. Git cleanup:
   - Any uncommitted work is committed as WIP
   - Clean up any isolated working copies (worktrees)
   - Stay on current branch (user handles branch switching)
5. Move sprint files to `$(shipyard-data)/sprints/sprint-NNN/` (archive)
6. Clear `$(shipyard-data)/sprints/current/`
7. Report: "Sprint cancelled. [N] tasks done (kept), [M] returned to backlog."

## Rules

- Capacity is a hard constraint. If selected features exceed capacity by >10% → AskUserQuestion: "Selected features total [N] pts, which exceeds capacity ([M] pts) by [X]%. Proceed anyway, or drop a feature? (proceed / drop [ID] / adjust capacity)"
- Check cross-feature dependencies — if F009 depends on F001 which isn't done → AskUserQuestion: "[Feature] depends on [dependency] which isn't done yet. Include [dependency] in this sprint, defer [feature], or proceed anyway? (include / defer / proceed)"
- Circular dependencies → reject, explain why.
- Never auto-carry-over from previous sprint — user must explicitly re-select.
- When input is ambiguous or unclear → AskUserQuestion with options and your recommendation.
