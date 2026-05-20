---
name: ship-sprint
description: "Plan a new sprint or cancel an active one."
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

**Paths.** All Shipyard file ops use the absolute SHIPYARD_DATA prefix from the context block (no `~`, `$HOME`, or shell variables). Shipyard binaries you may invoke from Bash: `shipyard-data archive-sprint <id>` and `shipyard-data init-sprint <id>` (Step 11.1). **Never use `echo`, `printf`, or shell redirects (`>`) to write state files** — use the Write tool for arbitrary frontmatter (auto-approved for SHIPYARD_DATA) or the `init-sprint` CLI for SPRINT.md / PROGRESS.md creation (template-canonical). When passing paths into spawned Agent prompts, substitute the literal SHIPYARD_DATA path.

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

This file is the active-skill mutex (see the `acquiring-skill-lock` capability skill). Any other Shipyard skill entering will see the held lock and refuse. The mutex is advisory — no hook physically blocks tool calls — so the discipline is yours: if you find yourself wanting to write implementation code, STOP. Planning is for decomposing the work, not building it.

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

See `references/carry-over-scan.md` for the full scan procedure (six scan locations: open bugs, blocked tasks, carried-over ideas with recency filter, in-progress features, silent-pass suspects, needs-attention escalations), the canonical display block, and the disposition prompt (all / pick / skip).

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

These projections help the user answer "Do I have enough time?" and "Will I exhaust my token quota?".

Then AskUserQuestion: "Which features for this sprint? (list IDs, or 'suggested' to accept)"

### Step 3: Research Before Planning

Apply the planning checklists from `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/planning-checklists.md` throughout Steps 3-9 (Definition of Ready, cross-cutting concerns, risk register, MoSCoW, three-point estimation, test strategy).

**Delegate per-feature research to `general-purpose` subagents in sprint-analyst mode — one per selected feature, all spawned in parallel** (single message, N tool calls). Each analyst returns a structured `SPRINT ANALYST REPORT`.

See `references/sprint-analyst-report.md` for the full analyst-dispatch prompt template and report schema. Use the analyst output directly in Step 4 task decomposition. If a report flags low-confidence findings, the orchestrator validates them inline (LSP first, then Grep / WebSearch).

### Step 3.5: Rules Compliance Check

Verify selected features comply with current project rules — rules may have been added or updated AFTER features were discussed. See `references/spec-validation.md` § "Step 3.5" for the contradiction-detection process and the per-violation AskUserQuestion options (update spec / send back to discuss / override rule / remove scenario). Features sent back to discuss are removed from this sprint's selection.

### Step 3.55: Terminology Alignment Check

Verify spec language matches what the codebase actually calls things. See `references/spec-validation.md` § "Step 3.55" for term-extraction, codebase search, mismatch-table format, and the per-mismatch AskUserQuestion (update spec / update code / keep both). Skip on greenfield. Update feature files with resolved terminology before decomposing tasks.

### Step 3.6: Definition of Ready Gate

Before decomposing, verify each feature is ready. Run the DoR checks, Cross-Cutting Concerns Audit, and Knowledge Gap Assessment from `planning-checklists.md`. See `references/spec-validation.md` § "Step 3.6" for details and the auto-generate-SME-skill subagent dispatch prompt for clustered knowledge gaps.

### Step 3.7: Surface Implementation Decisions

After research, identify every point where there's a meaningful choice — don't silently pick one. For each decision point: output an explanation with options/tradeoffs/recommendation, then AskUserQuestion with numbered choices. If research can't resolve the decision, offer a POC spike (options: spike it / pick one / defer).

See `references/implementation-decisions.md` for the full catalogue of decision-point types, the explanation/AskUserQuestion templates, the POC spike subagent dispatch (`isolation: "worktree"`, throwaway), and Decision Log recording. Write findings into each task file's `## Technical Notes` after Step 4 creates them — do not echo the template back into conversation.

### Step 3.75: Simplification Opportunity Scan

Now that research has identified libraries, patterns, and utilities this sprint will introduce, scan the codebase for simplification opportunities. See `references/implementation-decisions.md` § "Step 3.75" and the full protocol at `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/simplification-scan.md`.

Skip if no selected feature introduces new libraries/utilities/patterns. Routing: trivial → extend existing task; small → new cleanup task in final wave; medium/large → IDEA file. Scope guard: trivial+small ≤ 20% of sprint capacity. Then AskUserQuestion: "Apply these simplification opportunities? (all / pick / skip)".

### Step 4: Decompose Tasks (5-stage protocol)

See `references/wave-decomposition.md` § "Step 4" for the full 5-stage protocol (Stage 1 map AC → drafts; Stage 2 walking-skeleton foundation → Wave 1; Stage 3 run drafts through 9 splitting patterns; Stage 4 write Red step + author acceptance probe via `shipyard:authoring-acceptance-probe` capability skill + write task file; Stage 5 effort assignment using S/M/L 8/80 rule).

Always include cleanup as explicit tasks. **Do not write task files until Stage 4.** Read `references/task-decomposition-patterns.md` first.

After all stages: populate `## Technical Notes` per task using the template in `references/task-tech-notes-template.md`. Run the INVEST output check (Independent, Testable). Apply the Task Kinds taxonomy (`feature` / `operational` / `research`) — see `references/task-kinds.md`. Run the **kind auto-classifier** for operational signals; on a hit, AskUserQuestion: *"This task looks operational… Classify as `kind: operational` with `verify_command: [inferred]`? (yes, operational / no, it's a feature task / no, research)"* — recommended option first. Apply the **task size guard**: split anything with >8 discrete items.

If a task is estimated `effort: L` and you're uncertain, AskUserQuestion: *"This task is estimated L (1-2 days). Could it split into [specific suggestions]? (split / no, it's cohesive)"*.

### Step 5: Build Task Dependency Graph

Build the dependency graph from task file frontmatter. Do NOT duplicate task data into SPRINT.md — the sprint file only stores task IDs grouped by wave. (Detail: `references/wave-decomposition.md` § "Step 5".)

### Step 6: Find the Bottleneck

Identify the longest chain of dependent tasks (the critical path).

### Step 7: Wave Assignment

Group tasks into waves: Wave 1 = no dependencies, Wave N = depends only on earlier waves. Tasks within a wave have NO dependencies on each other. Each wave completes fully before the next starts. Mark which waves can run in parallel. (Detail: `references/wave-decomposition.md` § "Step 7".)

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

Before presenting the plan, review your own output. Re-read each task file and the sprint draft against a 21-check table covering files-to-modify, architecture, dependency integrity, prescriptive strategy, cleanup, no-cycles, AC clarity, effort, critical path, wave/dep alignment, test strategy, cross-cutting, risks, MoSCoW, PERT, kind-specific required fields (`verify_command`, `research_scope`, `First failing test:`), no nested operational loops, no "and"-titles in feature tasks, and Technical Notes deliverable → task mapping.

See `references/spec-validation.md` § "Step 9.5" for the full 21-row checklist with fail criteria. **Check 21 (Technical Notes → task mapping)** is load-bearing: a feature's Technical Notes section can name concrete artifacts that never become anyone's deliverable — F002's "Author must write a Playwright spec covering the demo-schema golden path" was such an artifact in the v2.5.0 confedit incident; the sprint shipped with `tests/e2e/` empty because no task owned the deliverable. Iterate up to 3 times, fixing failures and re-running. **Hold the table in mind across iterations — emit only per-iteration deltas (which checks fixed, which remain). Do not re-print the table on each pass.** Flag any remaining gaps in the sprint plan summary as "Planning gaps — review during execution". Then proceed to Step 9.7.

### Step 9.7: Adversarial Critique

After the self-review quality gate passes, spawn the critic agent to challenge the plan from angles the self-review doesn't cover. **Determine stakes level:** `high` if sprint has 10+ tasks, total story_points >= 20, any feature touches auth/payments/data, or critical path has 4+ tasks; `standard` otherwise.

See `references/spec-validation.md` § "Step 9.7" for the full critic dispatch prompt and the findings-processing rules (PRIORITY_ACTIONS, TASK_GAPS, WAVE_CONFLICTS, ESTIMATE_RISKS, ASSUMPTION_RISKS). For RECONSIDER verdicts on implementation decisions, AskUserQuestion with both options + critic's reasoning + your recommendation. **Do NOT re-run the critic after fixes.** One round only.

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

**RISKS** — from the risk register: risk, likelihood, impact, mitigation
**DECISIONS MADE** — from Step 3.7: key implementation choices and reasoning
**QUALITY GATE RESULTS** — from Step 9.5: all checks passed, or flagged gaps

Then use `AskUserQuestion` for approval:
- **Approve (Recommended)** — create the sprint and proceed to Step 11
- **Refine** — give feedback on specific tasks/waves, iterate
- **Cancel** — cancel the sprint draft (sets `status: cancelled` in SPRINT-DRAFT.md and task files, clears `tasks:` arrays in feature frontmatter; the soft-deleted record stays in place)

### Step 11: Create Sprint (after approval)

If approved:

1. Use Edit to set `status: superseded` in SPRINT-DRAFT.md frontmatter (the soft-deleted record stays in place; physical removal is manual for now — do not physically delete). Run `shipyard-data init-sprint <sprint-id>` (Bash) to atomically create SPRINT.md and PROGRESS.md from the canonical templates at `project-files/templates/`. **Do not Write SPRINT.md or PROGRESS.md from memory** — schema drift between an improvised file and the canonical template is the cause of `/ship-review` "state inconsistent" alarms. The CLI substitutes `id:` and `created:` only; everything else stays at template defaults and gets filled in via Edit below.
2. Use Edit on SPRINT.md to fill the frontmatter (`goal`, `capacity`, `features`, `execution_mode`) and body sections (Goal, Waves, Critical Path, Risks, Swap Log) from the approved plan.
3. Update feature statuses to `in-progress` in feature frontmatter.
4. Remove pulled feature IDs from BACKLOG.md.
5. **Record working branch** — capture the user's current branch: `git branch --show-current`. Use Edit to write `branch: <current branch>` into SPRINT.md frontmatter. Shipyard works on whatever branch the user is already on — it does not create sprint branches.

**Clean up active-skill mutex:** Use the Write tool to overwrite `<SHIPYARD_DATA>/.active-session.json` with `{"skill": null, "cleared": "<iso-timestamp>"}` (soft-delete sentinel — the mutex pattern treats `skill: null` as inactive). Planning is complete.

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
