---
name: ship-review
description: "Run multi-agent code review (security, bugs, silent failures, patterns, tests, spec) plus spec verification, retrospective, and release. Auto-fixes findings until clean. Use when the user wants to review completed work, verify a feature, see a demo, check if tests pass, approve sprint results, run a retro, analyze velocity, or wrap up a sprint."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode]
model: opus
effort: high
argument-hint: "[feature ID] [--demo] [--hotfix ID] [--retro-only] [--skip-code-review]"
---

# Shipyard: Review & Verification

Verify completed work against spec. Auto-test, screenshot, demo to user, get approval.

## Context

!`shipyard-context path`

!`shipyard-context head config.md 50 NO_CONFIG`
!`shipyard-context head sprints/current/SPRINT.md 80 NO_SPRINT`
!`shipyard-context head sprints/current/PROGRESS.md 50 NO_PROGRESS`
!`shipyard-context head memory/metrics.md 50 NO_METRICS`

**Data path: use the SHIPYARD_DATA path from context above. For Read/Write/Edit tools, use the full literal path (e.g., `/Users/x/.claude/plugins/data/shipyard/projects/abc123/...`). NEVER use `~` or `$HOME` in file_path — always start with `/`. For Bash: `SD=$(shipyard-data)` then `$SD/...`. Shell variables like `$SD` do NOT work in Read/Write/Edit file_path — only literal paths. NEVER hardcode or guess paths.**

## Input

$ARGUMENTS

## Detect Mode

- Feature ID (F001) → Review specific feature
- `--demo` → Include interactive demo (open browser, fill forms)
- `--hotfix B-HOT-001` → Fast-track hotfix review
- `--retro-only` → Skip review, run only the retrospective (for cancelled sprints or re-running retro)
- No args → Review all completed tasks in current sprint, then run retrospective
- No active sprint and no feature ID → AskUserQuestion: "No active sprint found. Which feature would you like to review? (provide a feature ID, or run /ship-sprint first)"

---

### Compaction Recovery

If you lose context mid-review (e.g., after auto-compaction):

1. Check `$(shipyard-data)/verify/` for existing `*-verdict.md` files — these features are already reviewed
2. Read SPRINT.md — get the list of features to review
3. Skip features with verdict files where `complete: true`. If a verdict has `complete: false`, that review was interrupted — re-run the pipeline for that feature
4. **Staleness check**: read the feature spec file to find its `tasks:` list, then read each task file's Technical Notes for source file paths. If the most recent commit touching those source/test files (`git log -1 --format=%ci -- [paths]`) is newer than the verdict's `reviewed_at`, re-run the review — code has changed since the verdict was written
5. Resume the review pipeline from the first feature without a valid verdict
6. For sprint-level review: aggregate results from verdict files when presenting the summary

Do not re-run the full test suite for features that already have valid (complete + fresh) verdict files.

---

## Review Pipeline

### Pre-flight: Branch Check

Verify we're on the working branch from SPRINT.md frontmatter:

1. Read `branch` from SPRINT.md frontmatter
2. `git branch --show-current` — if not on the expected branch, `git checkout [branch]`

This ensures review and any patch fixes happen on the correct branch.

---

For each feature/task being reviewed:

### Stage 0: Code Review Loop (sprint completion)

**Skip this stage if `--skip-code-review` is passed, or if reviewing a hotfix.**

Before verifying tests and spec compliance, run the multi-agent code review on the sprint's diff. This catches bugs, security issues, silent failures, and pattern violations BEFORE the user sees demo results, and auto-fixes findings until the code is clean.

The code review uses 6 specialized scanners in parallel + an opus investigator for deep dives. Full orchestration logic is in `references/code-review-orchestration.md` — read that file at the start of this stage and follow its steps.

**Iteration cycle:**

1. **Checkpoint** — Before any fixes, create a rollback point:
   ```bash
   git tag pre-code-review-$(date +%s)
   ```

2. **Run the orchestration** — Follow `references/code-review-orchestration.md` end to end:
   - Phase 1 (Setup): resolve diff range, get changed file list, categorize files
   - Phase 2 (Wave 1): spawn all 6 specialized scanners IN A SINGLE MESSAGE (parallel)
   - Phase 3 (Aggregate & dedupe): merge findings, sort by severity/confidence
   - Phase 4 (Wave 2): conditional `shipyard:shipyard-investigator` deep dives for high-stakes findings
   - Phase 5 (Final report): write `$(shipyard-data)/sprints/current/CODE-REVIEW.md` with VERDICT, COUNTS, and ---ACTIONABLE--- sections

   First iteration uses: `git diff $(git merge-base HEAD <main_branch>)...HEAD`
   Subsequent iterations use the cumulative delta: `git diff <pre-code-review-tag>..HEAD`

3. **Evaluate the verdict:**
   - Zero must-fix and zero should-fix → **clean pass**, proceed to Stage 1
   - Only consider items → **acceptable**, proceed to Stage 1
   - Must-fix or should-fix exist → log counts to PROGRESS.md immediately, then check diminishing returns, then **spawn fixer**

   Append the iteration's counts to the Code Review table in PROGRESS.md before proceeding.

4. **Diminishing returns check** — Skip on iteration 1. On iteration 2+, read the previous count from PROGRESS.md:
   - Count decreased → improvement, continue fixing
   - Count unchanged or increased → fixes are introducing new issues. AskUserQuestion: "Code review isn't converging — [N] must-fix issues remain after [iteration] fix attempts. Proceed to demo with current state, or investigate manually? (proceed / investigate)"

5. **Fix** — Spawn `Agent` with `subagent_type: shipyard:shipyard-builder` (no worktree, works on the working branch):
   ```
   Address code review findings.
   Read $(shipyard-data)/sprints/current/CODE-REVIEW.md — skip everything above ---ACTIONABLE---.
   Fix all M (must-fix) and S (should-fix) items listed below the separator.
   Each finding is one line: [file:line] — [category] — [description]. Fix: [suggestion].
   Follow TDD — update or add tests for any bug fixes.
   Commit fixes: refactor: address code review (iteration N)
   ```

   After fixer returns, verify a new commit exists. If no commit → reset to checkpoint: `git reset --hard $(git tag --list 'pre-code-review-*' --sort=-creatordate | head -1)`. Flag iteration as failed, don't count toward cap.

6. **Repeat** — Go back to step 2 (orchestration). Max 3 iterations.

**Exit conditions:**
- **Clean pass** — zero must-fix and zero should-fix → proceed to Stage 1
- **Only consider items remain** → proceed to Stage 1
- **Diminishing returns failed** → AskUserQuestion immediately
- **3 iterations reached** — For remaining must-fix items, create bug files at `$(shipyard-data)/spec/bugs/B-CR-[slug].md` so they surface in the next sprint. Then AskUserQuestion: "Code review ran 3 iterations. [N] items remain — tracked as [bug IDs]. Proceed to demo, or keep fixing?"

**Cleanup:** After exiting (any condition), delete the checkpoint tag:
```bash
git tag --list 'pre-code-review-*' | xargs -I {} git tag -d {}
```

Log each iteration in PROGRESS.md:
```
## Code Review
| Iteration | Must-fix | Should-fix | Consider | Action |
| 1         | 3        | 5          | 2        | Fixer addressed 8 findings |
| 2         | 0        | 1          | 2        | Fixer addressed 1 finding |
| 3         | 0        | 0          | 2        | Clean — proceeding |
```

### Stage 1: Run Tests & Spec Verification

**1a. Run all tests** — delegate to a `shipyard:shipyard-test-runner` subagent to avoid polluting the review context with raw test output:
- Spawn `Agent` with `subagent_type: shipyard:shipyard-test-runner` and prompt: "Run the full test suite: unit (`test_commands.unit`), integration (`test_commands.integration`), and end-to-end (`test_commands.e2e`) from `$(shipyard-data)/config.md`. If specific commands aren't configured, fall back to `testing_framework` field. Return the structured summary."
- Use the returned summary (PASS/FAIL counts) for Stage 3-5 — do not re-run tests yourself.

**1b. Spec review via specialized scanner** — Before spawning, read the feature file's `references:` frontmatter array and collect any paths listed there. Then spawn `Agent` with `subagent_type: shipyard:shipyard-review-spec`:

If there are reference files:
```
Run a spec review on feature [FEATURE_ID].
Mode: spec review
Feature spec: $(shipyard-data)/spec/features/[FEATURE_ID]-*.md
Reference files: $(shipyard-data)/spec/references/F001-api.md, $(shipyard-data)/spec/references/F001-schema.md
Task files: $(shipyard-data)/spec/tasks/ (filter by feature: [FEATURE_ID])
Implementation files: <git diff --name-only $(git merge-base HEAD <main_branch>)...HEAD>
```

If there are no reference files, omit the `Reference files:` line entirely.

The spec scanner is single-responsibility (model: sonnet, fresh 200k context). It maps every acceptance scenario to code, flags gaps and over-building, and returns findings in the standard format. Security, bugs, silent failures, patterns, and tests are NOT its job — those were already covered in Stage 0's wave-1 scan.

Use the scanner's findings in Stages 3-5.

### Stage 2: Visual Verification (UI tasks)

If the feature has UI components:
1. Ensure dev server is running (auto-start if needed)
2. Run end-to-end tests with screenshot capture
3. Screenshots at 3 viewports: mobile (375px), tablet (768px), desktop (1024px)
4. Save to `$(shipyard-data)/verify/[feature-id]/`

**Live-capture the dev server and E2E runs.** Anything you run here to observe behavior (dev server startup logs, E2E runner output, `curl` sanity checks against the running app) goes through `shipyard-logcap run <name> --max-size <S> --max-files <N> -- <command>` unless the command already writes its own log file. Review re-runs are the most expensive kind — Opus-level reasoning burning tokens on output you already saw. If the first run surfaces something you want to inspect more closely, `shipyard-logcap grep` the existing capture with a different pattern **before** re-running the thing. Full guide and decision table for picking bounds: `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/live-capture.md`.

### Stage 3: Did We Actually Achieve the Goal?

Tests passing is necessary but not sufficient. A component can pass its own tests but never be imported anywhere. This stage checks whether the *feature actually works end-to-end*, not just whether individual tasks completed.

For each feature, answer three questions:

**1. Observable Truths** — What must be TRUE for the feature to work?
Derive 3-7 behaviors from the acceptance scenarios. Verify each by running the app or checking code paths.
```
Example for F001 (Email Login):
  ✅ User can submit email + password → verified via E2E
  ✅ Invalid credentials show error → verified via E2E
  ✅ 5 failed attempts trigger rate limit → verified via integration test
  ❌ Session persists across page reload → no test, no implementation found
```

**2. Required Artifacts** — What files/components must EXIST?
Check each artifact is substantive (not a stub, placeholder, or TODO):
```
  ✅ src/app/login/page.tsx — 142 lines, renders form
  ✅ src/lib/auth.ts — 89 lines, handles auth logic
  ⚠️ src/middleware.ts — exists but auth check is commented out (STUB)
```

**3. Wiring Check** — Are the pieces actually CONNECTED?
Grep for imports/usage to verify component A actually calls component B:
```
  ✅ login/page.tsx imports auth.ts → confirmed
  ✅ middleware.ts imported in next.config → confirmed
  ❌ auth.ts → database client → no import found (ORPHANED)
```

**Verdicts per artifact:**
| Exists | Has real code | Connected | What it means |
|--------|--------------|-----------|---------------|
| Yes | Yes | Yes | ✅ Good to go |
| Yes | Yes | No | ⚠️ Built but nothing uses it yet |
| Yes | No | — | ⚠️ Placeholder — needs real implementation |
| No | — | — | ❌ Not built yet |

Any item that isn't "Good to go" → flag as a gap.

### Stage 4: Surface Gap Analysis

Additionally detect:
- **Untested scenarios** — acceptance scenarios without end-to-end tests
- **Missing edge cases** — empty states, error states, loading states
- **Accessibility gaps** — missing screen reader labels, keyboard navigation, contrast
- **Security concerns** — hardcoded values, missing input validation
- **Anti-patterns** — TODO comments, console.log left in, empty catch blocks

For each gap, classify:
- **Simple** (missing test, TODO left in, missing validation) → patch task for builder
- **Complex** (feature doesn't work but tests pass, wiring broken, behavior contradicts spec) → start a debug session instead of a blind patch. Create `$(shipyard-data)/debug/[feature-id]-[gap].md` with the symptoms and evidence from the review.

### Stage 4.5: Quality Gate (self-review loop)

Before writing the verdict, review your own review. Re-read the feature spec and your findings:

| # | Check | Fail criteria |
|---|---|---|
| 1 | **Every acceptance scenario has a test** | A Given/When/Then scenario exists in spec but no corresponding test found |
| 2 | **Every test maps to a scenario** | Tests exist that don't trace to any acceptance scenario (over-building or orphan) |
| 3 | **Goal verification is complete** | Observable truths list has items not checked |
| 4 | **Wiring verified** | Components built but not connected — no integration path tested |
| 5 | **Edge cases covered** | Only happy path tested — error states, empty states, boundary conditions missing |
| 6 | **No implementation gaps** | Feature file describes behavior that isn't implemented at all |
| 7 | **No spec gaps** | Implementation exists that isn't described in the spec (scope creep) |
| 8 | **Cleanup completed** | Task Technical Notes listed cleanup items that weren't addressed |
| 9 | **Security basics** | Auth/validation/input sanitization specified in spec but not verified |
| 10 | **Anti-patterns clean** | TODOs, console.log, empty catches still present in sprint diff |

**Iteration loop:**
1. Run the checklist against your findings
2. If any check reveals a gap you missed → add it to the gap list
3. Re-run checklist on updated findings
4. Max 3 iterations. If the review itself keeps finding new gaps, that's a signal — flag to user: "Review found [N] gaps across [M] iterations — this feature may need another pass before approval."

Only proceed to verdict when the checklist stabilizes (no new gaps found) or max iterations reached.

### Stage 4.6: Critic Challenge

After the self-review loop stabilizes, spawn the critic agent to challenge the review findings. The critic reads the feature spec, implementation, and the review's results to find what the reviewer missed.

Spawn `Agent` with `subagent_type: shipyard:shipyard-critic`:

```
Critique this review's findings for feature [FEATURE_ID].
Mode: review-critique
Stakes: [standard or high — match the feature's complexity]
Artifact paths:
  - Feature spec: $(shipyard-data)/spec/features/[FEATURE_ID]-*.md
  - Task files: $(shipyard-data)/spec/tasks/ (filter by feature: [FEATURE_ID])
Codebase context path: $(shipyard-data)/codebase-context.md
Project rules path: .claude/rules/**/*.md

Review findings to challenge:
  - Observable truths: [list from Stage 3]
  - Wiring check: [results from Stage 3]
  - Gaps found: [gap list from Stage 4]
  - Self-review iterations: [N] (stabilized / hit max)
```

The critic returns a structured report with blind spots, false positives/negatives, and priority actions.

### Stage 4.7: Final Review Pass

Process the critic's findings with **one** targeted pass — no iteration loop:

1. For each FAIL or HIGH-risk finding from the critic: verify it by checking the code/tests directly
2. If the critic identified a real blind spot → add it to the gap list with classification (simple/complex)
3. If the critic flagged a false positive in the review (something marked ✅ that isn't actually working) → downgrade it and add to gaps
4. If the critic's finding is itself a false positive (the review was correct) → discard it

Do not re-run the full review pipeline. This is a surgical pass on the critic's specific findings only. Update the gap counts and classifications, then proceed to the verdict.

### Checkpoint: Write Verdict

Write `$(shipyard-data)/verify/[feature-ID]-verdict.md` with structured results:

```yaml
---
feature: [ID]
reviewed_at: [ISO date]
complete: false
tests: pass|fail
coverage: [N]%
goal_verified: [N]/[M]
wiring: [N]/[M]
gaps_found: [N]
recommendation: approve|issues|changes
---
```

Body: test summary, goal verification results (observable truths, artifacts, wiring), and gap list. After Stage 5 (Demo) completes, update the verdict: set `complete: true`. This file persists as a review artifact — no cleanup needed. Incomplete verdicts (from interrupted sessions) are re-entered at the review pipeline.

### Stage 5: Demo to User — Plan Mode

After all features are reviewed and verdicts written, **enter plan mode** (`EnterPlanMode`) to present the complete review results for approval.

The plan should include:

**Per-feature summary** — for each feature:
- Tests: pass/fail counts (unit, integration, E2E)
- Coverage: % vs threshold
- TDD compliance: tests committed before implementation?
- Goal verification: N/M observable truths confirmed
- Wiring: N/M artifacts connected
- Gaps found: count and brief descriptions
- Screenshots: location if UI feature

**Sprint aggregate** (if reviewing whole sprint):
- Features: N complete, M with issues
- Total tests: passed/failed
- Average coverage
- Gaps found across all features
- Tests-first violations

**Recommended action** per feature:
- ✅ Approve — all checks passed
- ⚠️ Issues — minor gaps, suggest patch tasks
- ❌ Needs changes — significant gaps, needs rework

**Exit plan mode** (`ExitPlanMode`) — triggers built-in approval flow:
- **Approve** → update feature statuses to `done`, proceed to Sprint Retrospective
- **Refine** → user gives feedback on specific features, iterate
- **Fix first** → create patch tasks, show: "/ship-execute --task [patch task ID]"

### Stage 6: Process Decision

Based on the plan mode approval:
- **Approved** → Update feature statuses to `done` in feature frontmatter. Proceed to Sprint Retrospective (below).
- **Issues found** → Create bug entries via /ship-bug logic. Feature status → `approved` (not `in-progress` — it needs re-planning). Add feature ID back to BACKLOG.md so the next `/ship-sprint` picks it up.
- **Needs changes** → Update spec with new criteria. Create patch tasks. Feature status → `approved`, add ID back to BACKLOG.md. Show:
  ```
  ▶ NEXT UP: Fix the gaps and re-verify
    /ship-execute --task [patch task ID]
    (tip: /clear first for a fresh context window)
  ```

## Hotfix Review

Fast-track for hotfixes:
1. Check regression test exists and passes
2. Check fix addresses the bug report
3. No full demo — just test verification
4. AskUserQuestion: "Hotfix B-HOT-NNN verified. Merge to [main_branch from config]?"

---

## Sprint Retrospective

After sprint approval (or when `--retro-only` is passed), run the retrospective. This analyzes what happened, captures learnings, and creates improvement items.

If `--retro-only` with a sprint ID (e.g., `--retro-only sprint-003`), read that sprint's archived files from `$(shipyard-data)/sprints/sprint-NNN/` instead of `current/`.

### Retro Compaction Recovery

If you lose context mid-retro:
1. Check for `RETRO-DATA.md` in the sprint directory
2. Read frontmatter `step` field: `data_gathered` → skip to Retro Step 2, `feedback_collected` → skip to Retro Step 3, `action_items_created` → skip to Retro Step 4
3. If no RETRO-DATA.md → start from Retro Step 1

### Retro Step 1: Gather Data

Compute from source files (read SPRINT.md for task IDs, then read each task file for status/effort, and each feature file for points):
- **Planned vs delivered** — count task files with `status: done` vs total tasks
- **Velocity** — sum story points from completed features
- **Carry-over** — tasks not finished (and why)
- **Bugs found** — filter by `found_during` matching sprint ID
- **Blocked time** — total time tasks spent blocked
- **Swaps** — mid-sprint scope changes
- **Patch tasks** — gaps found during review
- **Estimate accuracy** — planned effort vs actual per task
- **Token accuracy** — compare `token_estimate` from feature frontmatter (planned) against actual if available. Note: actual token usage isn't automatically tracked (Claude Code doesn't expose per-session token counts). Record as "estimated: NNK" for now. As actual data becomes available from billing/usage, it can be fed back to improve estimates.

**Throughput computation:**
1. Read `started_at`, `completed_at`, `total_paused_minutes` from SPRINT.md frontmatter
2. If both timestamps present:
   - `active_minutes` = elapsed - paused
   - If `active_minutes > 0`: compute `pts_per_hour`, append to metrics.md
   - If `active_minutes <= 0`: warn about incomplete timing data
3. If timestamps missing: omit throughput

Write computed data to `RETRO-DATA.md` (frontmatter: `step: data_gathered`). Present summary:

```
SPRINT [NNN] RETROSPECTIVE

Planned: [N] tasks ([M] pts) across [W] waves
Delivered: [N] tasks ([M] pts)
Carry-over: [N] tasks ([M] pts)
Velocity: [N] pts (previous: [M] pts)
Throughput: X.X pts/hr (M.M hrs active)
Bugs: [N] | Blocked incidents: [N]
Estimate accuracy: [avg]% (range: [min]%-[max]%)
```

### Retro Step 2: Facilitate Discussion

Three sequential AskUserQuestion calls (explain context first, then ask):

1. **What went well?** — lead with data-driven observations, then ask for user's perspective
2. **What didn't go well?** — lead with flagged issues, then ask
3. **What should we change?** — lead with suggested improvements, then ask

Append responses to RETRO-DATA.md under `## Team Feedback`. Update frontmatter: `step: feedback_collected`.

### Retro Step 3: Create Action Items

For each actionable improvement, create an idea file:
```yaml
# $(shipyard-data)/spec/ideas/IDEA-NNN-[slug].md
---
id: IDEA-NNN
title: "[improvement]"
type: improvement
status: proposed
source: retro-sprint-NNN
story_points: [estimate]
created: [today]
---
```

Update RETRO-DATA.md: `step: action_items_created`, `ideas_created: [IDEA-NNN, ...]`.

### Retro Step 4: Update Metrics

1. **Update metrics** — append to `$(shipyard-data)/memory/metrics.md`: velocity, carry-over rate, bug rate, estimate accuracy, anti-pattern flags
2. **Quarterly rollover** — if metrics.md exceeds 300 lines, archive older data to `metrics-[quarter].md`
3. **Save to memory** — key retro insights that persist across sessions

### Anti-Pattern Detection

During retro, flag:
- **Overloading** — planned >120% of capacity
- **Over-building** — tasks 2x+ estimate without scope change
- **Estimation gaps** — estimates consistently off by >50%
- **Zombie stories** — same items in 2+ sprints, never completed
- **Scope creep** — too many mid-sprint swaps

Present as observations, not judgments.

---

## Release

After retro completes, generate the release record. This is a changelog + status tracker — Shipyard does not create git tags, push, or create GitHub releases.

### Release Step 1: Present Release Plan — Plan Mode

Read all feature files with `status: done` from this sprint. Generate the full release picture.

**Enter plan mode** (`EnterPlanMode`) to present the release plan for approval. The release is the most irreversible action in the workflow — status changes, archiving, and changelog are hard to undo.

The plan should include:

**CHANGELOG** — what ships:
```
 FEATURES
  - F001: [title] — [one-line description from spec]
  - F005: [title] — [one-line description from spec]

 BUG FIXES
  - B001: [title]
```

**STATUS CHANGES** — what moves:
- Features: [IDs] status `done` → `released`, `released_at: [date]`
- Sprint: archived to `$(shipyard-data)/sprints/sprint-NNN/`

**RETRO HIGHLIGHTS** — key numbers from the retro (if just completed):
- Velocity, throughput, estimate accuracy
- Action items created

**FILES WRITTEN** — what changes on disk:
- CHANGELOG.md in project root (prepended)
- Feature file frontmatter updates
- Sprint directory archived

**Exit plan mode** (`ExitPlanMode`) — triggers built-in approval flow:
- **Approve** → proceed to Release Step 2 (write everything)
- **Edit** → user adjusts changelog text, then re-approve
- **Skip** → skip release record, still archive sprint

### Release Step 2: Write Release Record

1. Update feature statuses to `released` in feature file frontmatter
2. Record in each feature's frontmatter: `released_at: [date]`
3. Append changelog to `CHANGELOG.md` in the **project root** (not plugin data). If the file doesn't exist, create it. Prepend the new entry at the top (newest first). This is a project deliverable that belongs in git.

### Release Step 3: Archive Sprint

Move `$(shipyard-data)/sprints/current/*` → `$(shipyard-data)/sprints/sprint-NNN/`, clear `current/`.

### Final: Run Status

After archiving, run the `/ship-status` validation and dashboard to give the user a clean project health snapshot. This catches any state issues from the sprint and auto-fixes them before the next cycle.

### Wrap Up

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPRINT [NNN] COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Review: [N] features verified, [M] gaps patched
 Retro: [velocity] pts | [throughput] pts/hr | [N] improvements captured
 Release: changelog written to CHANGELOG.md (project root, appended)

▶ NEXT UP: Start the next cycle
  /ship-discuss — explore new features
  /ship-sprint — plan next sprint (if backlog has approved features)
  (tip: /clear first for a fresh context window)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Rules

- NEVER approve without running tests. Auto-verify is mandatory.
- NEVER skip user approval. The user must explicitly approve.
- Present screenshots inline when possible (Claude can read images).
- If dev server isn't running, start it. If database needs seeding, seed it.
- Make it effortless for the user to test — provide everything they need.
- Retro is NOT optional — it runs automatically after sprint approval.
- Action items from retro become idea files — promote via `/ship-discuss IDEA-NNN`.
- Shipyard does not create git tags, push, or create GitHub releases — the user handles that.
