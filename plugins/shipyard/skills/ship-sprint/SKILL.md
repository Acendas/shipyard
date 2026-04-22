---
name: ship-sprint
description: "Plan a new sprint — break features into tasks, find the critical path, and group tasks into waves for parallel execution. Or cancel an active sprint. Use when the user wants to start a sprint, plan work, pull features from backlog into a sprint, cancel a running sprint, or organize tasks into execution waves."
allowed-tools: [Read, Write, Edit, Grep, Glob, LSP, Agent, AskUserQuestion, WebSearch, WebFetch, "Bash(shipyard-context:*)", "Bash(shipyard-data:*)"]
effort: high
argument-hint: "[--cancel]"
---

# Shipyard: Sprint Planning

Plan a new sprint by pulling features from the backlog and decomposing into waves.

## Context

!`shipyard-context path`
!`shipyard-context view config`
!`shipyard-context view backlog`
!`shipyard-context view sprint`
!`shipyard-context view metrics`
!`shipyard-context view codebase 30`

**Paths.** All Shipyard file ops use the absolute SHIPYARD_DATA prefix from the context block (no `~`, `$HOME`, or shell variables). The only Shipyard binary you may invoke from Bash is `shipyard-data archive-sprint <id>`. **Never use `echo`, `printf`, or shell redirects (`>`) to write state files** — use the Write tool, which is auto-approved for SHIPYARD_DATA and avoids permission prompts. When passing paths into spawned Agent prompts, substitute the literal SHIPYARD_DATA path.

## Input

$ARGUMENTS

## Session Mutex Check

**Absolute first action — before reading any context, before mode detection, before anything.** Use the Read tool on `<SHIPYARD_DATA>/.active-session.json` (substitute the literal SHIPYARD_DATA path from the context block above). Then decide:

- **File does not exist** → no other planning session is active. Proceed to "Session Guard" below.
- **File exists.** Parse the JSON and check three fields:
  1. If `cleared` is set OR `skill` is `null` → previous session ended cleanly (soft-delete sentinel). Proceed.
  2. If `started` timestamp is more than 2 hours old → stale lock (probably a crashed session). Print one line to the user: "(recovered stale lock from `/{previous skill}` started {N}h ago)". Proceed.
  3. Otherwise → **HARD BLOCK.** Another planning session is active. Print this message as the entire response and STOP — do not continue with any other instructions, do not load any context, do not call any other tools:

  ```
  ⛔ Another planning session is active.
    Skill:   /{skill from file}
    Topic:   {topic from file}
    Started: {started from file}

  Concurrent planning sessions can corrupt the backlog and allocate
  duplicate task IDs. Finish or pause the active session first.

  If the other session crashed or was closed:
    Run /ship-status — it will offer to clear the stale lock.
  ```

This is a Read+Write mutex. There is a small theoretical race window between the Read and the Write below, but in practice two human-typed `/ship-sprint` invocations cannot collide within milliseconds.

## Session Guard

**Second action — only if the mutex check above said proceed:** Use the Write tool to write `.active-session.json` to the SHIPYARD_DATA directory (use the full literal path from the context block — e.g., `/Users/x/.claude/plugins/data/shipyard/projects/abc123/.active-session.json`). This both claims the mutex (overwriting any stale or cleared marker) AND prevents post-compaction implementation drift:

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
  2. Archive by running `shipyard-data archive-sprint sprint-NNN` from Bash (substitute the real sprint ID). This atomically renames `<SHIPYARD_DATA>/sprints/current/` → `<SHIPYARD_DATA>/sprints/sprint-NNN/` and recreates an empty `current/`. Do NOT synthesize raw `cp`/`mv`/`mkdir` commands against the plugin data dir — they're not portable and not atomic. The `shipyard-data archive-sprint` invocation works because this skill has `Bash(shipyard-data:*)` in its allowlist.
  3. Report: "Archived sprint [ID]. Velocity: [N] pts recorded."
  4. Then proceed to PLAN mode

- Otherwise → PLAN mode

---

### Compaction Recovery

If you lose context mid-planning (e.g., after auto-compaction):

1. Use the Read tool on `<SHIPYARD_DATA>/sprints/current/SPRINT-DRAFT.md` (substitute the literal SHIPYARD_DATA path).
   - If draft exists, check staleness: read `created` from frontmatter. If the draft is from a previous session (more than a few hours old) → AskUserQuestion: "A sprint draft from [date] exists with features [list]. Resume it, or start fresh (the existing draft will be overwritten)? (resume / start fresh)"
   - If current/resumed → load it, skip to Step 10 (Present Plan and Confirm)
   - If "start fresh" → use the Write tool to overwrite SPRINT-DRAFT.md with the new draft content (no separate delete step needed; Write replaces).
2. If no draft, use Grep with `pattern: ^status: approved`, `path: <SHIPYARD_DATA>/spec/tasks`, `glob: T*.md`, `output_mode: files_with_matches` to find recently-created task files
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

Use the Read tool on `<SHIPYARD_DATA>/memory/metrics.md` (also loaded in context above). Look for `Velocity: N pts` lines from prior sprints. If multiple sprints exist, average the last 3 for a rolling velocity.

Also scan metrics.md for `Throughput:` lines (format: `Throughput: X.X pts/hr (N pts in M.M hrs active)  # Sprint NNN`). Extract the float value before `pts/hr` from each line. Average the last 3 values (or all available if fewer than 3 exist) → `avg_throughput`. If no `Throughput:` lines exist, `avg_throughput` is null.

If velocity data exists → AskUserQuestion: "Based on past sprints, you typically complete ~[N] points. Adjust? (accept / set new capacity)"
If no velocity data (first sprint or metrics empty) → AskUserQuestion: "No prior velocity data. How many story points for this sprint? (default: 20 for solo dev)"

If the user provides a new capacity value, use that figure for the rest of this planning session (feature selection, capacity warnings, etc.). AskUserQuestion: "Save [N] points as the new default velocity in config.md? (yes / no, just this sprint)"

### Step 1.5: Carry-Over Scan

Before selecting features, scan for unfinished work from previous cycles. These items take priority over new features — they represent commitments already made.

**Scan these locations:**

1. **Open bugs** — Use Grep with `pattern: ^status: (open|investigating)`, `path: <SHIPYARD_DATA>/spec/bugs`, `glob: B*.md`, `output_mode: files_with_matches`. Read each match to get title, severity, source (sprint ID, code review, integration test).
2. **Blocked tasks** — Use Grep with `pattern: ^status: blocked`, `path: <SHIPYARD_DATA>/spec/tasks`, `glob: T*.md`, `output_mode: files_with_matches`. Read each match to get title, parent feature, blocked reason.
3. **Carried-over ideas** (retro, execute, review-gap) — Use Grep with `pattern: ^source: (execute|review-gap|retro)[-/]`, `path: <SHIPYARD_DATA>/spec/ideas`, `glob: IDEA-*.md`, `output_mode: files_with_matches`. The pattern matches three idea origins:
   - **`source: retro/<sprint-id>`** — improvements the team committed to during retrospectives (new slash-separated form) OR `source: retro-sprint-<NNN>` (legacy hyphen-separated form, still recognized for backwards compatibility with IDEAs created before the source-tag convention change)
   - **`source: execute/<sprint-id>`** — deferred unknowns captured by builders during task execution (step 10 of the builder's process — see `agents/shipyard-builder.md` → "Capture Deferred Unknowns")
   - **`source: review-gap/<sprint-id>`** — out-of-scope findings captured during `/ship-review` Stage 0 or Stage 4 (see `skills/ship-review/SKILL.md` → "Capture Out-of-Scope Gaps as IDEAs")

   **Recency filter (important — prevents flooding):** over 10+ sprints a project accumulates many ideas, and showing all of them in every planning session is unusable. For each match, Read the frontmatter and keep the idea ONLY if either:
   - its `source:` field references one of the **last 2 sprint IDs** (the previous sprint or the one before it), OR
   - its `created:` date is within the **last 14 days**

   Everything else stays reachable via `/ship-discuss` triage mode but doesn't clutter sprint planning.

   **Display cap:** show at most **8 ideas** across all three origins combined, grouped by origin. If there are more than 8 after the recency filter, show the 8 newest and add a `+N more — see /ship-discuss triage for full list` footer line. Group by origin so retro items stay visually distinct from execute/review-gap discoveries.

   **Why these three origins specifically:** they are the three writer paths — retro writes at sprint end, execute writes during task work, review-gap writes during out-of-scope findings detection. If a new writer path is added later (e.g., `debug/`, `hotfix/`), it must be added to this regex explicitly — do NOT widen to `^source: ` wildcard, because `source: "inline capture"` from ship-discuss's CAPTURE mode should NOT auto-carry (the user just captured it; they'll discuss it next via triage, not immediately re-surface it in sprint planning).
4. **In-progress features** — Use Grep with `pattern: ^status: in-progress`, `path: <SHIPYARD_DATA>/spec/features`, `glob: F*.md`, `output_mode: files_with_matches`. Filter to features NOT in an active sprint (read SPRINT.md to find current sprint feature IDs). These were started but not completed/approved in a previous sprint.
5. **Silent-pass suspects** — Use Grep with `pattern: ^kind: operational`, `path: <SHIPYARD_DATA>/spec/tasks`, `glob: T*.md`, `output_mode: files_with_matches`. For each match, Read the frontmatter and check two conditions: (a) `status: done` AND `verify_output:` field is absent or empty, OR (b) `verify_history:` exists but the most recent entry has `exit: <non-zero>` or `escalated: true`. These are operational tasks that were *marked done* in a prior sprint without captured evidence of a passing run — the exact silent-pass failure mode. Surface them under their own heading: **"PREVIOUSLY MARKED DONE WITHOUT EVIDENCE — re-verify?"**. The user should decide: re-run verify now (add as an operational carry-over task), promote findings to a new sprint, or accept-with-known-issues. Never silently re-mark these as approved and carry them into the new sprint untouched — the whole point of this scan is to break the deterministic recurrence of the silent-pass bug.
6. **Needs-attention tasks (prior sprint escalation)** — Use Grep with `pattern: ^status: needs-attention`, `path: <SHIPYARD_DATA>/spec/tasks`, `glob: T*.md`, `output_mode: files_with_matches`. These are tasks that a prior sprint's operational fix-findings loop or research dispatcher escalated — the loop ran, produced a full audit trail in `verify_history` or `research_history`, but did not converge. Distinct from silent-pass (no evidence) and blocked (waiting on a dependency): needs-attention tasks have *tried and failed*, and the user has enough information in the history to make a decision. For each match, Read the frontmatter and extract the last 3 `verify_history` entries (or `research_history` for `kind: research`) plus the escalation reason from the final entry. Surface under the heading **"⚠ NEEDS ATTENTION — prior sprint escalation"**. Do NOT auto-carry into the new sprint — the user must explicitly choose: open a debug session, re-plan findings as individual feature tasks, re-scope the research, or accept with known issues.

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

 CARRIED-OVER IDEAS ([N]/[TOTAL] — grouped by origin; recency filter: last 2 sprints or 14 days)
  retro/
    IDEA-042 — Add request tracing headers (retro/sprint-005)
    IDEA-043 — Reduce test flakiness in CI (retro/sprint-005)
  execute/
    IDEA-044 — Evaluate argon2id vs bcrypt (execute/sprint-006, from T012)
  review-gap/
    IDEA-045 — Swallowed exception in logging wrapper (review-gap/sprint-006, auth.ts:87)
  + 3 more — see /ship-discuss triage for full list

 INCOMPLETE FEATURES ([N])
  F008 — Email Notifications (in-progress, 3/5 tasks done)

 ⚠ PREVIOUSLY MARKED DONE WITHOUT EVIDENCE ([N]) — re-verify?
  T007 — Run E2E suite and fix findings (kind: operational, no verify_output)
    Last sprint: sprint-012. This is the silent-pass failure mode —
    the task was marked done but no command output was captured.

 ⚠ NEEDS ATTENTION ([N]) — from prior sprint escalation
  T007 — Run E2E suite and fix findings (kind: operational)
    Escalated: iteration_budget_exhausted (after 3 iterations, 4 patch tasks)
    Last 3 attempts:
      iter 1 — 3 findings, fixed (T007-p1a, T007-p1b, T007-p1c)
      iter 2 — 2 findings, fixed (T007-p2a, T007-p2b)
      iter 3 — 2 findings reappeared after fix — gave up
    Options: /ship-debug T007 | re-plan findings as tasks | accept with issues

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

Apply the planning checklists from `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/planning-checklists.md` throughout Steps 3-9 (Definition of Ready, cross-cutting concerns, risk register, MoSCoW, three-point estimation, test strategy).

**Delegate per-feature research to `shipyard-sprint-analyst` subagents — one per selected feature, all spawned in parallel** (single message, N tool calls). Each analyst loads its feature file + references + relevant codebase context + project rules and returns a structured `SPRINT ANALYST REPORT`. You hold N reports (~2k each), not N feature trees + their references + all rules.

```
For each selected feature, spawn Agent with:
  subagent_type: shipyard:shipyard-sprint-analyst
  prompt: |
    Feature ID: F<NNN>
    Feature path: <SHIPYARD_DATA>/spec/features/F<NNN>-*.md
    Codebase context: <SHIPYARD_DATA>/codebase-context.md
    Project rules glob: .claude/rules/project-*.md and .claude/rules/learnings/*.md

    Apply your full process and return your structured report.
```

The reports cover: architecture impact, files to modify, patterns to follow, reuse opportunities, strategy (clean addition / refactor / migration with named pattern), principles, anti-patterns, risks/gotchas, external docs. Use them directly in Step 4 task decomposition — the analyst's output drops into the task Technical Notes template with minimal rework.

**If a report flags low-confidence findings**, the orchestrator validates them inline before relying on them — use LSP first (`documentSymbol`, `findReferences`, `goToDefinition`) for code navigation, then Grep / WebSearch as fallback. The analysts already use LSP in their own runs; this is a final spot-check pass at the orchestrator level.

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

**Write findings to each task file `## Technical Notes`** (after Step 4 creates task files). The full template lives in `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/task-tech-notes-template.md` — Read it once at the start of Step 4, then fill it in per task and Write directly to the task file. **Do not echo the template back into conversation.** Task specs must be executable: a builder follows them mechanically without re-reading the feature file.

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
3. Also check existing IDEA files: use Grep with `pattern: ^source: "?simplification-scan`, `path: <SHIPYARD_DATA>/spec/ideas`, `glob: IDEA-*.md`, `output_mode: files_with_matches` — a previous `/ship-discuss` may have already found opportunities for features now entering the sprint. Re-evaluate those: are they still valid? Can any be promoted to sprint tasks now?

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
2. If not, break into atomic tasks and use the Write tool to create task files at `<SHIPYARD_DATA>/spec/tasks/TNNN-[slug].md` with frontmatter: `id`, `title`, `feature` (parent ID), `status`, `effort` (S/M/L), `dependencies`, **`kind`** (see Task Kinds below), **`verify_command`** (required when `kind: operational`)
3. Update the feature's `tasks:` array with the new task IDs
4. Task files are the **single source of truth** for task data — title, effort, status, dependencies all live there
5. **Populate `## Technical Notes` in each task file** using findings from Steps 3–3.5: architecture impact, files to modify, implementation strategy, decisions from the Decision Log, patterns to follow, gotchas, cleanup items. Use the template format defined above. Every task must have Technical Notes — the builder reads these before writing any code.

**Task Kinds.** Every task has a `kind:` field that tells the executor *which agent runs it* and *what "done" means*. See `references/task-kinds.md` for the full taxonomy. Summary:
- **`kind: feature`** (default) — task writes new code or modifies existing code. Follows the TDD cycle (Red → Green → Refactor). Dispatched to `shipyard-builder`. Done = atomic commit containing impl + tests. This is the implicit default if `kind:` is absent.
- **`kind: operational`** — task's deliverable IS running a command and responding to its output. Examples: "run the full E2E suite and fix findings", "run `npm audit` and patch vulnerabilities", "benchmark the query planner and investigate regressions". **Requires `verify_command:`** — either a literal shell command or a config-key reference like `test_commands.e2e`. Dispatched to `shipyard-test-runner` (NOT the builder) because operational tasks have no Red step and no code commit. Done = `verify_output:` field populated pointing at a non-empty `shipyard-logcap` capture from a passing run.
- **`kind: research`** — task's deliverable is written findings / a decision doc; no code expected. Dispatched to `shipyard-researcher`. (Execution path for research kind is out of scope for the initial operational-task fix; plan for it but treat as feature-parity until operational path is stable.)

**Why this matters.** The silent-pass failure mode — task marked done without tests actually running — happens when an operational-shaped task is routed to the builder, which exits clean on an empty tree because there's no code for it to write. The `kind:` field is the load-bearing signal that prevents this.

**Kind auto-classifier.** Before writing each task file, scan the task description for operational signals — they are easy to miss by eye and the classifier is how users surface them. Signal phrases (case-insensitive):
- `run the … tests`, `run the full suite`, `run all …`
- `audit`, `scan for`, `check for` (when used as a command, not as a metaphor)
- `benchmark`, `measure`, `profile`
- `verify` / `validate` when the verification IS the deliverable (not "implement X and verify it works")
- `investigate` when the investigation is command-driven (e.g., re-run a flaky test N times)

When a signal fires, **do NOT auto-assign `kind: operational` silently.** Use AskUserQuestion: *"This task looks operational (its deliverable is running a command and responding to output, not writing code). Classify as `kind: operational` with `verify_command: [inferred]`? (yes, operational / no, it's a feature task / no, research)"* — because misclassification in either direction is costly (silent-pass for false-negative; wrong agent dispatched for false-positive). Make the recommended option first in the AskUserQuestion list. If confirmed operational and the `verify_command` is not obvious from the task description, prompt the user for it with examples from their `config.md` test_commands block.

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

Use the Write tool to write `<SHIPYARD_DATA>/sprints/current/SPRINT-DRAFT.md` as a compaction checkpoint:

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
| 16 | **Every `kind: operational` task has a non-empty `verify_command`** | Operational task missing `verify_command` → rejected at DoR. Without this the executor has no command to run and will either crash or (worse) fall back to marking the task done. See `references/task-kinds.md`. |
| 17 | **No `kind: operational` task is nested inside another operational loop** | Patch tasks created by the fix-findings loop MUST be `kind: feature`. Operational → operational recursion is forbidden. |
| 18 | **Every `kind: research` task has a non-empty `research_scope`** | Research task missing `research_scope` → rejected at DoR. Without it the researcher has no question to investigate and will fail loud at dispatch (`research_scope_missing` event). See `references/task-kinds.md`. |

Iterate the checklist against task files and the sprint draft, fixing failures (update task files, recompute waves) and re-running. Max 3 iterations. **Hold the table in mind across iterations — emit only per-iteration deltas (which checks fixed, which remain). Do not re-print the table on each pass.** Flag any remaining gaps in the sprint plan summary as "Planning gaps — review during execution". Then proceed to Step 9.7.

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
- Artifact paths: SPRINT-DRAFT.md path + all task file paths (full paths from `<SHIPYARD_DATA>/spec/tasks/`)
- Also include feature spec paths (the critic needs to verify tasks cover all acceptance scenarios)
- Codebase context path: `<SHIPYARD_DATA>/codebase-context.md`
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

### Step 10: Present Sprint Plan

Output the complete sprint plan as text. SPRINT-DRAFT.md and task files are already written as compaction checkpoints — no statuses change and no features move from backlog until the user approves.

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

Then use `AskUserQuestion` for approval:
- **Approve (Recommended)** — create the sprint and proceed to Step 11
- **Refine** — give feedback on specific tasks/waves, iterate
- **Cancel** — cancel the sprint draft (sets `status: cancelled` in SPRINT-DRAFT.md and task files, clears `tasks:` arrays in feature frontmatter; `reap-obsolete` housekeeping reaps later)

### Step 11: Create Sprint (after approval)

If approved:

1. Use Edit to set `status: superseded` in SPRINT-DRAFT.md frontmatter (the `reap-obsolete` housekeeping reaps it later — do not physically delete). Use Write to create SPRINT.md and PROGRESS.md.
2. Update feature statuses to `in-progress` in feature frontmatter
3. Remove pulled feature IDs from BACKLOG.md
4. **Record working branch** — capture the user's current branch: `git branch --show-current`. Write `branch: <current branch>` to SPRINT.md frontmatter. Shipyard works on whatever branch the user is already on — it does not create sprint branches.

**Clean up session guard:** Use the Write tool to overwrite `<SHIPYARD_DATA>/.active-session.json` with `{"skill": null, "cleared": "<iso-timestamp>"}` (soft-delete sentinel — `session-guard` treats `skill: null` as inactive). Planning is complete.

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
5. Archive the cancelled sprint: run `shipyard-data archive-sprint sprint-NNN` (substitute the real sprint ID). This atomically renames `current/` → `sprint-NNN/` and recreates an empty `current/` in a single allowlisted call. Do NOT fall back to raw `cp`/`mv`/`mkdir` against the data dir — those prompt for permission because the plugin data dir is outside the project root.
6. Report: "Sprint cancelled. [N] tasks done (kept), [M] returned to backlog."

## Rules

- Capacity is a hard constraint. If selected features exceed capacity by >10% → AskUserQuestion: "Selected features total [N] pts, which exceeds capacity ([M] pts) by [X]%. Proceed anyway, or drop a feature? (proceed / drop [ID] / adjust capacity)"
- Check cross-feature dependencies — if F009 depends on F001 which isn't done → AskUserQuestion: "[Feature] depends on [dependency] which isn't done yet. Include [dependency] in this sprint, defer [feature], or proceed anyway? (include / defer / proceed)"
- Circular dependencies → reject, explain why.
- Never auto-carry-over from previous sprint — user must explicitly re-select.
- When input is ambiguous or unclear → AskUserQuestion with options and your recommendation.
