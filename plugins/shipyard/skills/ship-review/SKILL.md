---
name: ship-review
description: "Run multi-agent code review (security, bugs, silent failures, patterns, tests, spec) plus spec verification, retrospective, and release. Auto-fixes findings until clean. Use when the user wants to review completed work, verify a feature, see a demo, check if tests pass, approve sprint results, run a retro, analyze velocity, or wrap up a sprint."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, Agent, AskUserQuestion]
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

Run the multi-agent code review on the sprint's diff before tests and spec compliance — 6 parallel scanners + an opus investigator (orchestration logic in `references/code-review-orchestration.md`) catch bugs, security issues, silent failures, and pattern violations, then the `shipyard:dispatching-task-loop` fixer addresses must-fix and should-fix items. Iterate up to 3 times with diminishing-returns AskUserQuestion at iteration 2+: *"Code review isn't converging — [N] must-fix issues remain after [iteration] fix attempts. Proceed to demo with current state, or investigate manually?"* On exit-with-remaining-must-fix after 3 iterations, write `B-CR-*` bugs and AskUserQuestion whether to proceed to demo. Out-of-scope scanner findings become IDEAs (see Stage 4 protocol). Full mechanics — checkpoint tags, fixer parameters, PROGRESS.md table format, scope guard — in `references/scanner-dispatch.md`.

### Stage 0.5: Code Simplification

Skip if `--skip-code-review` is passed (same gate as Stage 0).

After Stage 0 exits clean, spawn the `code-simplifier:code-simplifier` agent against the sprint diff to clean up quick patches the fixer may have introduced. Scope-guarded to sprint-diff files only — reverts via `git reset --hard HEAD~1` if the simplifier touches unexpected files. Mechanics in `references/scanner-dispatch.md`.

### Stage 1: Run Tests & Spec Verification

**1a. Run all tests** — invoke the **`shipyard:dispatching-operational-task` capability skill** to avoid polluting the review context with raw test output. Pass `verify_command` resolved to each tier from `<SHIPYARD_DATA>/config.md` (`test_commands.unit`, `test_commands.integration`, `test_commands.e2e`); the capability skill captures output to `<SHIPYARD_DATA>/captures/` and returns the structured verdict (PASS/FAIL counts in `LAST_LINES:`). One operational dispatch per tier, or one combined dispatch if your project supports a single command. Use the returned verdicts for Stages 3–5 — do not re-run tests yourself.

**1b. Spec review via specialized scanner** — invoke the **`shipyard:dispatching-spec-review` capability skill** with `scope: "feature"` and `target_ids: [FEATURE_ID]`. The capability skill:

- Reads the feature spec at `<SHIPYARD_DATA>/spec/features/[FEATURE_ID]-*.md` and each path listed in its `references:` frontmatter array (skill body handles the conditional inclusion automatically — no need to construct two prompt variants).
- Reads the related task files filtered by feature.
- Reads the diff (`base_ref` = sprint base, `head_ref` = current HEAD).
- Maps every acceptance criterion to code, classifies as MET/PARTIAL/MISSING/OVER-BUILT, and returns structured findings.
- Enforces read-only via post-return `git status --porcelain` check.

Pass to the capability skill:

| Parameter | Value |
|---|---|
| `scope` | `"feature"` |
| `target_ids` | `[FEATURE_ID]` |
| `base_ref` | `git merge-base HEAD <main_branch>` |
| `head_ref` | Current HEAD |
| `data_dir` | Literal SHIPYARD_DATA path |

Use the capability skill's structured findings (`STATUS: PASS` or `STATUS: FINDINGS` with classification) in Stages 3–5. Security, bugs, silent failures, patterns, and tests are NOT this skill's job — those went through `dispatching-code-review` in Stage 0.

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

**Capture Out-of-Scope Gaps as IDEAs.** Out-of-scope gaps are real defects but don't belong in the current feature's patch-task list or debug session. Allocate an ID via `shipyard-data next-id ideas` (never `ls`-and-guess), then Write `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` with `source: review-gap/<sprint-id>`, `found_during: surface-gap-stage-4` (or `code-review-stage-0`), and `feature_reviewed: <feature-id>`. **Hard cap: 5 per stage** (Stage 0 and Stage 4 budgets are independent); on overflow, write one `overflow: true` summary IDEA. **Hard rule — out-of-scope only:** in-scope must-fix → `B-CR-*` bugs, in-scope complex → debug session, in-scope simple → patch task. Full IDEA frontmatter schema, capture-vs-skip criteria, and frontmatter template in `references/scanner-dispatch.md`.

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

After the self-review loop stabilizes, dispatch a **`general-purpose`** subagent in critic mode to challenge the review findings. The critic reads the feature spec, implementation, and the review's results to find what the reviewer missed. No registered Shipyard agent — this is an inline prompt template, since the critic role is specialized to ship-review and not reused elsewhere.

Substitute the literal SHIPYARD_DATA path for `<SHIPYARD_DATA>` before spawning:

```
Agent(subagent_type: "general-purpose", prompt: |

You are an adversarial critic reviewing the conclusions of a feature
review. Your job is to find what the reviewer missed: blind spots, false
positives (things marked ✅ that aren't actually working), and false
negatives (gaps the reviewer didn't surface).

Apply anti-sycophancy: do not agree with the review's conclusions just
because they sound reasonable. Pre-mortem the feature: imagine it shipped
and broke in production — what was the failure mode?

Feature: [FEATURE_ID]
Mode: review-critique
Stakes: [standard or high — match the feature's complexity]

Read these files:
  - Feature spec: <SHIPYARD_DATA>/spec/features/[FEATURE_ID]-*.md
  - Task files: <SHIPYARD_DATA>/spec/tasks/ (filter by feature: [FEATURE_ID])
  - Codebase context: <SHIPYARD_DATA>/codebase-context.md
  - Project rules: .claude/rules/**/*.md

Review findings to challenge:
  - Observable truths: [list from Stage 3]
  - Wiring check: [results from Stage 3]
  - Gaps found: [gap list from Stage 4]
  - Self-review iterations: [N] (stabilized / hit max)

Return:
  STATUS: CHALLENGES
  BLIND_SPOTS: <list with file:line citations where possible>
  FALSE_POSITIVES: <items the reviewer marked ✅ that you have evidence are broken>
  FALSE_NEGATIVES: <items the reviewer flagged as gaps that are actually fine>
  PRIORITY_ACTIONS: <ordered list of what should be addressed before approval>

If you genuinely have no challenges:
  STATUS: NO_CHALLENGES
  REASON: <one paragraph confirming you considered each adversarial angle>

You are READ-ONLY: no edits, no commits, no spawning subagents. You may
Read, Grep, Glob, run read-only git, and run static analysis as a check.
)
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

### Stage 4.8: Demo-Path Verification

Before advancing to user approval, **run each feature's `demo_probe` end-to-end** to prove the cross-task wiring actually works. This catches the failure mode where every per-task probe passed in isolation but the feature's user-facing flow doesn't compose.

For each feature in scope:

1. Read the feature's frontmatter `demo_probe:` field.
2. **If `demo_probe` is missing**: refuse to advance to Stage 5. Surface to user via AskUserQuestion: *"Feature [F-NNN] has no `demo_probe`. Approval is gated on a feature-level smoke test that exercises the cross-task user flow. (a) author one now via /ship-discuss [F-NNN], (b) skip with explicit reason, (c) abort review."* Recommended: (a).
3. **If `demo_probe: skip-with-reason`** with a `demo_probe_skip_reason` populated: include the reason in the per-feature summary (Stage 5) as a known limitation. Allow approval to proceed.
4. **Otherwise**: invoke the **`shipyard:running-acceptance-probe` capability skill** with `probe_command: <feature.demo_probe>`, `cwd: <repo root>`, `timeout_seconds: 120`. The capability skill runs the probe in a fresh shell and returns the structured verdict.
5. Record the verdict in PROGRESS.md's review table and include it in the Stage 5 per-feature summary:
   - **PASS** → ✅ Demo verified (last 5 lines of output captured below)
   - **FAIL** → ❌ Demo failed; demo probe doesn't exit 0 against the merged feature
   - **TIMEOUT** → ⚠ Demo exceeded 120s; probe is too broad — split or narrow it
   - **ERROR** → ⚠ Demo couldn't run; probe definition is wrong (likely missing dependency or misconfigured command)

**Approval gate.** A feature with a FAIL or TIMEOUT verdict cannot be approved. The reviewer must either (a) re-dispatch task-loops to fix the cross-task wiring, or (b) flag the feature as `needs-attention` and defer approval to a future review pass. ERROR verdicts route through AskUserQuestion to fix the probe definition.

This is the per-feature counterpart to per-task acceptance probes. Together they form the reliability ladder:

```
per-task acceptance_probe   →  unit-level wiring proof (dispatching-task-loop gate)
per-feature demo_probe       →  cross-task user-flow proof (this stage)
sprint-level full test suite →  regression / integration proof (Stage 1)
```

Mid-tier failures (passing tasks, failing demo) are exactly the bug class the customer-reported "review rubber-stamps stubs" complaint described — the task tests passed against properly wired code, but the cross-task user flow was broken because nobody ever ran it end-to-end.

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

After sprint approval (or when `--retro-only` is passed), run the retrospective. This analyzes what happened, captures learnings, and creates improvement items. If `--retro-only` with a sprint ID, Read that sprint's archived files from `<SHIPYARD_DATA>/sprints/sprint-NNN/` instead of `current/`.

The retro runs in four steps with compaction recovery via `RETRO-DATA.md`'s `step` frontmatter field. Full mechanics — data-gathering source files, throughput computation, IDEA allocation/frontmatter, metrics rollover, anti-pattern flags — in `references/retro-and-release.md`.

### Retro Step 1: Gather Data
Compute planned-vs-delivered, velocity, carry-over, bugs, blocked time, swaps, patch tasks, estimate accuracy, throughput from SPRINT.md + task/feature files. Write to `RETRO-DATA.md` (`step: data_gathered`) and present the summary block.

### Retro Step 2: Facilitate Discussion
Three sequential AskUserQuestion calls — lead each with the data-driven observation, then ask:
1. **What went well?**
2. **What didn't go well?**
3. **What should we change?**

Append responses to `RETRO-DATA.md` under `## Team Feedback`. Update frontmatter: `step: feedback_collected`.

### Retro Step 3: Create Action Items
For each actionable improvement, allocate an ID via `shipyard-data next-id ideas` (never `ls`-and-guess) and Write `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` with `source: retro/<sprint-id>` (slash form — matches the carry-over scan regex). Update `RETRO-DATA.md`: `step: action_items_created`.

### Retro Step 4: Update Metrics
Append velocity, carry-over rate, bug rate, estimate accuracy, anti-pattern flags to `<SHIPYARD_DATA>/memory/metrics.md` (quarterly rollover at 300 lines). Save key insights to memory.

### Shipyard Plugin Issue Detection

Some retro findings are **Shipyard plugin problems**, not user project problems — worktree isolation failures, agent early returns, SubagentStop hook misfires, salvage loops, broken hooks, silent-pass regressions, context pressure false positives, etc. These should be reported upstream so the Shipyard maintainers can fix them for everyone.

**How to detect:** If a deviation, anti-pattern, or "what didn't go well" item references any of these:
- Claude Code bug numbers (`#29110`, `#37549`, `#39973`, etc.)
- Shipyard hook names (`auto-approve-data`, `worktree-branch`, `plugin-data-breadcrumb`)
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

After retro completes, generate the release record. This is a changelog + status tracker — Shipyard does not create git tags, push, or create GitHub releases. Full mechanics — release-plan output format, frontmatter writes, archive command, status dashboard — in `references/retro-and-release.md`.

### Release Step 1: Present Release Plan
Read all `status: done` features from this sprint. Output the release plan as text — CHANGELOG block, STATUS CHANGES, RETRO HIGHLIGHTS, FILES WRITTEN. Release is the most irreversible action in the workflow; surface everything before confirming.

Then use `AskUserQuestion` for approval:
- **Release (Recommended)** — proceed to Release Step 2 (write everything)
- **Edit changelog** — adjust changelog text, then re-approve
- **Skip release** — skip release record, still archive sprint

### Release Step 2: Write Release Record
Update feature frontmatter (`status: released`, `released_at: [date]`) and prepend the new entry to `CHANGELOG.md` in the **project root** (not plugin data — this is a project deliverable that belongs in git).

### Release Step 3: Archive Sprint
Run `shipyard-data archive-sprint sprint-NNN` from Bash. This atomically renames `current/` → `sprint-NNN/` and recreates an empty `current/`. Do NOT synthesize raw `cp`/`mv`/`mkdir` against the plugin data dir — they're not portable and not atomic.

### Final: Run Status
After archiving, run `/ship-status` to give the user a clean project health snapshot and auto-fix any state issues before the next cycle.

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
