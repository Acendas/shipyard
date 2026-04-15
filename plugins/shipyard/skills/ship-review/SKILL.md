---
name: ship-review
description: "Run multi-agent code review (security, bugs, silent failures, patterns, tests, spec) plus spec verification, retrospective, and release. Auto-fixes findings until clean. Use when the user wants to review completed work, verify a feature, see a demo, check if tests pass, approve sprint results, run a retro, analyze velocity, or wrap up a sprint."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, Agent, AskUserQuestion]
model: opus
effort: high
argument-hint: "[feature ID] [--demo] [--hotfix ID] [--retro-only] [--skip-code-review]"
---

# Shipyard: Review & Verification

Verify completed work against spec. Auto-test, screenshot, demo to user, get approval.

## Context

!`shipyard-context path`

!`shipyard-context view config`
!`shipyard-context view sprint 80`
!`shipyard-context view sprint-progress`
!`shipyard-context view metrics 50`

**Paths.** All Shipyard file ops use the absolute SHIPYARD_DATA prefix from the context block (no `~`, `$HOME`, or shell variables). Bash is for project tests, git, and `shipyard-data archive-sprint <id>` (Release stage) only — never for reading or writing Shipyard state. **Never use `echo`, `printf`, or shell redirects (`>`) to write state files** — use the Write tool, which is auto-approved for SHIPYARD_DATA and avoids permission prompts. When passing paths into spawned Agent prompts, substitute the literal SHIPYARD_DATA path.

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

1. Use Glob `<SHIPYARD_DATA>/verify/*-verdict.md` to find existing verdict files — these features are already reviewed
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

Skip if `--skip-code-review` is passed or reviewing a hotfix.

Run the multi-agent code review on the sprint's diff before tests and spec compliance — it catches bugs, security issues, silent failures, and pattern violations and auto-fixes them. The orchestration logic (6 parallel scanners + an opus investigator) lives in `references/code-review-orchestration.md`. Read that at the start of this stage.

Per iteration (max 3):

1. **Checkpoint.** `git tag pre-code-review-$(date +%s)` — rollback point for failed fix iterations.
2. **Orchestrate.** Follow the reference end-to-end. Iteration 1 uses `git diff $(git merge-base HEAD <main_branch>)...HEAD`; iteration 2+ uses the cumulative delta `git diff <pre-code-review-tag>..HEAD`. Phase 5 writes `<SHIPYARD_DATA>/sprints/current/CODE-REVIEW.md` with VERDICT / COUNTS / ---ACTIONABLE--- sections.
3. **Evaluate.** Append counts to the Code Review table in PROGRESS.md. Zero must-fix + zero should-fix → clean pass, proceed to Stage 1. Only consider items → acceptable, proceed to Stage 1. Must-fix or should-fix → continue.
4. **Diminishing returns** (iteration 2+). Read the previous count from PROGRESS.md. If unchanged or increased, AskUserQuestion: "Code review isn't converging — [N] must-fix issues remain after [iteration] fix attempts. Proceed to demo with current state, or investigate manually?"
5. **Fix.** Spawn `Agent` with `subagent_type: shipyard:shipyard-builder` (no worktree, works on the working branch). Substitute the literal SHIPYARD_DATA path before spawning:
   ```
   Address code review findings.
   Read <SHIPYARD_DATA>/sprints/current/CODE-REVIEW.md — skip everything above ---ACTIONABLE---.
   Fix all M (must-fix) and S (should-fix) items below the separator.
   Each finding: [file:line] — [category] — [description]. Fix: [suggestion].
   Follow TDD. Commit: refactor: address code review (iteration N)
   ```
   After the fixer returns, verify a new commit exists. If none → `git reset --hard $(git tag --list 'pre-code-review-*' --sort=-creatordate | head -1)` and flag the iteration as failed (don't count toward the cap).
6. **Repeat** from step 2.

**Exit:** clean pass → Stage 1. 3 iterations reached with remaining must-fix → use Write to create `<SHIPYARD_DATA>/spec/bugs/B-CR-[slug].md` per finding so they surface in the next sprint, then AskUserQuestion whether to proceed to demo. After exit, delete checkpoint tags: `git tag --list 'pre-code-review-*' | xargs -I {} git tag -d {}`.

**Out-of-scope findings in Stage 0 code review.** If any scanner surfaces a concrete defect that is real but *outside the sprint's diff scope* (e.g., while reviewing the auth feature's diff, the silent-failures scanner flagged a swallowed exception in a helper that wasn't touched by the sprint), capture it as an IDEA — not a `B-CR-*` bug. The B-CR bugs are for in-scope code-review findings that need fixing before this sprint ships; out-of-scope findings are for the next sprint's planning to consider. See Stage 4's "Capture Out-of-Scope Gaps as IDEAs" section for the full protocol — it applies to Stage 0 findings too, with `found_during: code-review-stage-0` in the frontmatter instead of `surface-gap-stage-4`. Hard cap: 5 per stage (enforced separately from Stage 4's cap — Stage 0 and Stage 4 have independent budgets).

Log each iteration in PROGRESS.md:
```
## Code Review
| Iteration | Must-fix | Should-fix | Consider | Action |
| 1         | 3        | 5          | 2        | Fixer addressed 8 findings |
| 2         | 0        | 1          | 2        | Fixer addressed 1 finding |
| 3         | 0        | 0          | 2        | Clean — proceeding |
```

### Stage 0.5: Code Simplification

Skip if `--skip-code-review` is passed (same gate as Stage 0).

After the code review loop exits clean, run a simplification pass on the sprint's changed code. The code review fixer may have introduced quick patches; this pass cleans them up for clarity, consistency, and reuse before tests and demo.

1. Get the sprint diff file list:
   ```bash
   git diff --name-only $(git merge-base HEAD <main_branch>)...HEAD
   ```
2. Spawn the simplifier agent:
   ```
   Agent(subagent_type: code-simplifier:code-simplifier, prompt: |
     Review and simplify the following files that were changed in this sprint.
     Focus on: reducing unnecessary complexity, eliminating redundant code,
     improving naming, consolidating related logic, and applying project
     conventions from CLAUDE.md. Preserve all functionality.

     Changed files:
     [list from step 1]

     Commit your changes as: refactor: simplify sprint code)
   ```
3. Verify a commit exists after the agent returns. If no commit → the simplifier found nothing to improve (clean pass).
4. Log in PROGRESS.md: `Simplification: [N files touched | no changes needed]`

**Scope guard:** The simplifier only touches files in the sprint diff. It must not modify files outside the diff scope. If the agent's commit touches unexpected files, revert with `git reset --hard HEAD~1` and proceed without simplification.

### Stage 1: Run Tests & Spec Verification

**1a. Run all tests** — delegate to a `shipyard:shipyard-test-runner` subagent to avoid polluting the review context with raw test output:
- Substitute the literal SHIPYARD_DATA path for `<SHIPYARD_DATA>` in the prompt below, then spawn `Agent` with `subagent_type: shipyard:shipyard-test-runner` and prompt: "Run the full test suite: unit (`test_commands.unit`), integration (`test_commands.integration`), and end-to-end (`test_commands.e2e`) read from `<SHIPYARD_DATA>/config.md`. If specific commands aren't configured, fall back to `testing_framework` field. Return the structured summary."
- Use the returned summary (PASS/FAIL counts) for Stage 3-5 — do not re-run tests yourself.

**1b. Spec review via specialized scanner** — Before spawning, read the feature file's `references:` frontmatter array and collect any paths listed there. Then spawn `Agent` with `subagent_type: shipyard:shipyard-review-spec`:

If there are reference files (substitute the literal SHIPYARD_DATA path for `<SHIPYARD_DATA>` before spawning):
```
Run a spec review on feature [FEATURE_ID].
Mode: spec review
Feature spec: <SHIPYARD_DATA>/spec/features/[FEATURE_ID]-*.md
Reference files: <SHIPYARD_DATA>/spec/references/F001-api.md, <SHIPYARD_DATA>/spec/references/F001-schema.md
Task files: <SHIPYARD_DATA>/spec/tasks/ (filter by feature: [FEATURE_ID])
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
4. Use the Write tool to save to `<SHIPYARD_DATA>/verify/[feature-id]/`

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

**4. Operational Task Evidence Check** — For any task in this feature with `kind: operational`, the standard Wiring Check is useless: operational tasks produce no code artifacts to import-check. They need a different verdict based on captured command output instead.

For each `kind: operational` task in the feature:
```
  ✅ T007 — verify_output: T007-verify-iter2, 8412 bytes, last exit: 0
  ❌ T012 — verify_output: absent (SILENT-PASS: task marked done without running command)
  ⚠️ T019 — verify_output: T019-verify-iter1, 0 bytes (capture empty — broken runner?)
```

Check each operational task:
1. Task file has `verify_output:` field populated (not empty string, not commented out). Missing → **SILENT-PASS**, the exact failure mode the operational dispatch path exists to prevent.
2. `shipyard-logcap path <verify_output>` resolves to an existing file. Missing file → **capture lost**, needs re-run.
3. Byte count is non-zero. Zero bytes → **broken runner**, the command reported success but produced no output.
4. Final `verify_history` entry has `exit: 0`. Non-zero → task shouldn't be done at all.

Any operational task that fails any of these is a **critical gap** — automatically upgraded to must-fix regardless of what the acceptance criteria say, because the task's deliverable was running a command and we have no evidence the command ran. If you find a silent-pass, also recommend the user add the task to `ship-sprint`'s carry-over scan (Step 1.5, check #5) as a safety net for the next sprint.

### Stage 4: Surface Gap Analysis

Additionally detect:
- **Untested scenarios** — acceptance scenarios without end-to-end tests
- **Missing edge cases** — empty states, error states, loading states
- **Accessibility gaps** — missing screen reader labels, keyboard navigation, contrast
- **Security concerns** — hardcoded values, missing input validation
- **Anti-patterns** — TODO comments, console.log left in, empty catch blocks

For each gap, classify into one of three destinations — this is a decision tree, not a menu, and the classification determines which persistence target the gap lands in:

- **Simple and in-scope** (missing test for this feature, TODO left in this feature's files, missing validation on this feature's inputs) → **patch task** for builder. Use the existing patch-task creation flow.
- **Complex and in-scope** (feature doesn't work but tests pass, wiring broken within this feature, behavior contradicts this feature's spec) → **debug session**. Use the Write tool to create `<SHIPYARD_DATA>/debug/[feature-id]-[gap].md` with the symptoms and evidence from the review.
- **Out-of-scope** (real defect or smell that isn't in the feature being reviewed — e.g., while reviewing the payments feature, the scanner flagged a race condition in the auth middleware) → **IDEA file**. Capture the observation as an idea so it doesn't vanish, without polluting the current feature's review. See "Capture Out-of-Scope Gaps as IDEAs" below.

**Capture Out-of-Scope Gaps as IDEAs.**

Out-of-scope gaps are real defects — they deserve tracking — but they don't belong in the current feature's patch-task list (which would blow up sprint scope) or the debug session (which is feature-specific). The existing destinations (`bugs/`, `debug/`, patch tasks) are all scope-locked to the thing being reviewed. IDEAs are the overflow valve for "real but not now."

**Hard cap: 5 IDEAs per review stage** (5 for Stage 0 code-review findings, 5 for Stage 4 gap findings — 10 total per review run). If you have more than 5 out-of-scope findings in a stage, write exactly ONE summary IDEA with `overflow: true` in the frontmatter and a bulleted list of the additional items in the body. Why 5? Same reasoning as the builder's 3-per-task cap — idea farms are how signal gets drowned in noise.

**When to capture vs when to let it go:**

- **Capture** — concrete defects, latent bugs, architectural smells with a specific citation (file:line), security concerns that aren't in the current feature's threat model, deprecated API usage, silent failure modes.
- **Do NOT capture** — style preferences, "this could be cleaner", "I would have designed this differently", refactor wishes without a concrete defect, things already tracked in bugs/ or debug/ sessions (would duplicate), gaps that are actually in-scope for the feature being reviewed.

**How to capture** (mechanical):

1. Allocate an ID atomically: run `shipyard-data next-id ideas` — returns a zero-padded 3-digit string (e.g., `042`). **Do NOT `ls` and guess** — parallel reviewers would race.

2. Write the IDEA file via the Write tool at `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` (slug is lowercase-kebab-case, ≤5 words):
   ```yaml
   ---
   id: IDEA-<id>
   title: "<one-line observation>"
   type: gap
   status: proposed
   source: review-gap/<sprint-id>
   found_during: surface-gap-stage-4     # or code-review-stage-0
   feature_reviewed: <feature-id>        # the feature you were reviewing when you found this
   created: <current ISO date>
   ---

   ## Observation

   <2–3 sentences: what you found, where (file:line), why it's a real defect, not a preference>

   ## Evidence

   - File: <path:line>
   - Pattern: <what the scanner / review flagged>
   - Severity estimate: low | medium | high
   - Why out-of-scope: <why this doesn't belong in the current feature's patch tasks>
   ```

3. Repeat up to 5 per stage. On overflow, collapse to one `overflow: true` IDEA.

**Hard rule — out-of-scope only.** In-scope must-fix items still become bugs (`B-CR-*.md` in Stage 0). Complex in-scope issues still become debug sessions. Simple in-scope issues still become patch tasks. IDEAs are EXCLUSIVELY for observations that are real but belong to a different feature, a different sprint, or a future cleanup pass. Violating this rule floods the IDEA backlog with bugs masquerading as ideas and makes `/ship-discuss` unusable.

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

Iterate the checklist against your findings. If any check reveals a missed gap, add it to the gap list and re-run. Max 3 iterations; if it keeps finding new gaps, flag: "Review found [N] gaps across [M] iterations — this feature may need another pass before approval." **Hold the table in mind across iterations — emit only per-iteration deltas (which gaps were added). Do not re-print the table on each pass.** Proceed to verdict when the checklist stabilizes or max iterations reached.

### Stage 4.6: Critic Challenge

After the self-review loop stabilizes, spawn the critic agent to challenge the review findings. The critic reads the feature spec, implementation, and the review's results to find what the reviewer missed.

Spawn `Agent` with `subagent_type: shipyard:shipyard-critic`:

Substitute the literal SHIPYARD_DATA path for `<SHIPYARD_DATA>` before spawning:
```
Critique this review's findings for feature [FEATURE_ID].
Mode: review-critique
Stakes: [standard or high — match the feature's complexity]
Artifact paths:
  - Feature spec: <SHIPYARD_DATA>/spec/features/[FEATURE_ID]-*.md
  - Task files: <SHIPYARD_DATA>/spec/tasks/ (filter by feature: [FEATURE_ID])
Codebase context path: <SHIPYARD_DATA>/codebase-context.md
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

Use the Write tool to write `<SHIPYARD_DATA>/verify/[feature-ID]-verdict.md` with structured results:

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

### Stage 5: Demo to User

After all features are reviewed and verdicts written, present the complete review results as text.

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

Then use `AskUserQuestion` for approval:
- **Approve (Recommended)** — update feature statuses to `done`, proceed to Sprint Retrospective
- **Refine** — give feedback on specific features, iterate
- **Fix first** — create patch tasks, show: "/ship-execute --task [patch task ID]"

### Stage 6: Process Decision

Based on the approval:
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

If `--retro-only` with a sprint ID (e.g., `--retro-only sprint-003`), Read that sprint's archived files from `<SHIPYARD_DATA>/sprints/sprint-NNN/` instead of `current/`.

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

For each actionable improvement, allocate an ID atomically and write an idea file.

**Allocate the ID.** Run `shipyard-data next-id ideas` — the CLI returns a zero-padded 3-digit string (e.g., `042`). Use it as `IDEA-042` in the filename and the `id` frontmatter field. **Do NOT `ls spec/ideas/` and pick a number manually** — parallel sessions would race and clobber each other. The allocator is the only safe way to pick an idea ID.

**Write the file** via the Write tool at `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` with this frontmatter:
```yaml
---
id: IDEA-<id>
title: "[improvement]"
type: improvement
status: proposed
source: retro/<sprint-id>
story_points: [estimate]
created: [today]
---
```

**Source-tag format.** `source: retro/<sprint-id>` (slash-separated origin, e.g., `retro/sprint-007`) is the new convention — it mirrors `execute/<sprint-id>` and `review-gap/<sprint-id>` so the carry-over scan can grep with a single regex `^source: (execute|review-gap|retro)/`. The old `retro-sprint-NNN` format (hyphen-separated) is still recognized by readers for backwards compatibility with IDEAs created before this change, but new IDEAs must use the slash form.

Update RETRO-DATA.md: `step: action_items_created`, `ideas_created: [IDEA-<id>, ...]`.

### Retro Step 4: Update Metrics

1. **Update metrics** — Read `<SHIPYARD_DATA>/memory/metrics.md`, then use Write to overwrite with the previous content plus appended new entries: velocity, carry-over rate, bug rate, estimate accuracy, anti-pattern flags
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

### Shipyard Plugin Issue Detection

Some retro findings are **Shipyard plugin problems**, not user project problems — worktree isolation failures, agent early returns, SubagentStop hook misfires, salvage loops, broken hooks, silent-pass regressions, context pressure false positives, etc. These should be reported upstream so the Shipyard maintainers can fix them for everyone.

**How to detect:** If a deviation, anti-pattern, or "what didn't go well" item references any of these:
- Claude Code bug numbers (`#29110`, `#37549`, `#39973`, etc.)
- Shipyard hook names (`subagent-stop`, `auto-approve-data`, `session-guard`, `worktree-branch`, etc.)
- Shipyard internal state (`.active-execution.json`, `.compaction-count`, `.shipyard-events.jsonl`)
- Agent dispatch failures (builder early return, builder salvaged, spec-check not converging)
- Worktree branch issues (CWD drift, wrong branch, worktree probe failures)

Then it's a Shipyard issue, not a project issue. **Do NOT create an IDEA file** — the user's project backlog is not the place for plugin bugs. Instead, surface it directly:

```
This looks like a Shipyard plugin issue, not a problem with your code.
Please report it so the maintainers can fix it:
  https://github.com/acendas/shipyard/issues
Include the output of: shipyard-context diagnose
```

Use `AskUserQuestion` to offer:
- **Report issue (Recommended)** — user will file at github.com/acendas/shipyard/issues
- **Skip** — acknowledged, move on

---

## Release

After retro completes, generate the release record. This is a changelog + status tracker — Shipyard does not create git tags, push, or create GitHub releases.

### Release Step 1: Present Release Plan

Read all feature files with `status: done` from this sprint. Generate the full release picture. The release is the most irreversible action in the workflow — status changes, archiving, and changelog are hard to undo.

Output the release plan as text:

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
- Sprint: archived to `<SHIPYARD_DATA>/sprints/sprint-NNN/`

**RETRO HIGHLIGHTS** — key numbers from the retro (if just completed):
- Velocity, throughput, estimate accuracy
- Action items created

**FILES WRITTEN** — what changes on disk:
- CHANGELOG.md in project root (prepended)
- Feature file frontmatter updates
- Sprint directory archived

Then use `AskUserQuestion` for approval:
- **Release (Recommended)** — proceed to Release Step 2 (write everything)
- **Edit changelog** — adjust changelog text, then re-approve
- **Skip release** — skip release record, still archive sprint

### Release Step 2: Write Release Record

1. Update feature statuses to `released` in feature file frontmatter
2. Record in each feature's frontmatter: `released_at: [date]`
3. Append changelog to `CHANGELOG.md` in the **project root** (not plugin data). If the file doesn't exist, create it. Prepend the new entry at the top (newest first). This is a project deliverable that belongs in git.

### Release Step 3: Archive Sprint

Run `shipyard-data archive-sprint sprint-NNN` from Bash (substitute the real sprint ID). This atomically renames `<SHIPYARD_DATA>/sprints/current/` → `<SHIPYARD_DATA>/sprints/sprint-NNN/` and recreates an empty `current/` for the next cycle. Do NOT synthesize raw `cp`/`mv`/`mkdir` against the plugin data dir — those are not portable and not atomic. `shipyard-data archive-sprint` is the only Shipyard binary you need to invoke from Bash, and it works because this skill has generic `Bash` allowed.

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
