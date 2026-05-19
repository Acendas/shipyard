---
name: ship-review
description: "Run multi-agent review, retrospective, and release."
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
- No active sprint and no feature ID (sprint already archived: `current/` directory is empty or absent of `SPRINT.md`) → **No-op terminal path.** Emit `shipyard-data events emit pipeline_terminal pipeline=ship-review sprint=<last-known-or-unknown> outcome=noop reason=sprint_already_archived` and print the terminal marker: `▶ CYCLE COMPLETE — sprint already complete and archived. /loop should stop.` Exit cleanly without invoking AskUserQuestion. (This is the exact path that fired the original /loop bug — there was no terminal signal so /loop kept scheduling wakeups against an archived sprint.)

---

## Cursor + Per-Tick Advance

`/ship-review` is a multi-stage pipeline. To make it `/loop`-friendly, each invocation reads a persistent cursor at `<SHIPYARD_DATA>/sprints/current/REVIEW-CURSOR.md`, dispatches to the matching stage handler, writes the cursor for the next tick, and emits structured events. Full cursor schema, stage map, terminal protocol, event vocabulary, and stuck-detection rules live in `references/pipeline-cursor.md` — read it before changing the cursor surface.

**Cursor read at entry.** Begin every invocation with:

1. Read `<SHIPYARD_DATA>/sprints/current/REVIEW-CURSOR.md` (use the Read tool).
   - **If the file exists and `terminal: true`**: print the terminal marker (`▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.`), emit `shipyard-data events emit pipeline_terminal pipeline=ship-review sprint=<id> outcome=noop reason=cursor_already_terminal`, exit.
   - **If the file exists and `terminal: false`**: emit `shipyard-data events emit pipeline_tick_started pipeline=ship-review sprint=<id> stage=<cursor.stage> iteration=<cursor.iteration> loop_owner=<owner>`, then dispatch to the handler for `cursor.stage` (per the stage map in `references/pipeline-cursor.md`).
   - **If the file does NOT exist**: fresh start. Set `stage: preflight`, `iteration: 1`, `terminal: false`, `status: in_progress`. Emit `pipeline_tick_started`. Dispatch to the preflight handler.

2. After the chosen stage's handler returns, use the Write tool to write the cursor for tick N+1 (or for terminal exit). Emit `pipeline_tick_completed` (advancing or self-looping) or `pipeline_terminal` (terminal stage). Print the appropriate marker text.

The cursor write uses the Write tool against the literal SHIPYARD_DATA path (auto-approved by the PreToolUse hook). The marker text is load-bearing — `/loop` drivers (and the loop-driving model) read `CYCLE COMPLETE` + `/loop should stop` as the structural signal to refrain from scheduling another wakeup.

**Direct invocation vs /loop driver.** The same skill body serves both callers:

- **Direct invocation** (user runs `/ship-review` or `/ship-review F-NNN` from the prompt): after a handler returns, if the next stage is non-terminal AND non-blocking (no `AskUserQuestion` required AND no expensive long-running operation), the dispatcher MAY chain into it within the same invocation. Bound the chain by an approximate wall-clock budget of **~3 minutes** per invocation to keep ticks responsive and interruptible.
- **`/loop` driver** (the invocation is one tick of a `/loop` schedule): each tick is exactly one handler. After writing the cursor and emitting `pipeline_tick_completed`, exit. The chain-within-invocation logic is suppressed when `loop_owner == "/loop"`. The next `/loop` wakeup picks up from the cursor's `stage:`.

**`loop_owner` detection.** Determine the caller by reading the most recent `pipeline_tick_completed` event from `<SHIPYARD_DATA>/.shipyard-events.jsonl` (a 30-minute lookback window): if its `next_stage` matches the current cursor's `stage` AND its timestamp is within the last 30 minutes, treat the current invocation as a `/loop` re-entry and set `loop_owner: "/loop"`. Otherwise treat as a direct user invocation (`loop_owner: "user"`). A user explicitly passing `--single-tick` forces `/loop` semantics — this is the override for "I want one tick now and that's it."

### Self-looping stages: stuck detection

Two stages can self-loop until they converge by data: `code_review_iter_N` (Stage 0 — scanner clean signal) and `gap_analysis` (Stages 4 + 4.5 — checklist stable signal). There is no arbitrary iteration cap; convergence is data-driven. Stuck detection works as follows:

- Each self-loop tick increments `stuck_counter:` if state did NOT change since the previous tick. For `code_review_iter_N`, state = the (must_fix, should_fix) tuple from the most recent scanner pass. For `gap_analysis`, state = the gap list (set-equal).
- If `stuck_counter >= 5` (5 ticks without state change), emit `shipyard-data events emit pipeline_stuck pipeline=ship-review sprint=<id> stage=<id> iterations=<N> reason=no-state-change` AND surface a non-blocking one-line warning in the user-facing text: `⚠ Stage [X] has run [N] times without state change. /ship-status to inspect; consider manual intervention.` The loop keeps running — the warning is informational.
- Reset `stuck_counter` to 0 on the first tick where state changes.
- `hard_ceiling: 50` is the absolute safety stop. If a self-loop stage reaches `iteration: 50`, write `status: escalated`, `terminal: true`, emit `pipeline_terminal pipeline=ship-review outcome=escalated reason=hard_ceiling_stage_<id>`, and halt. In practice the 5-tick warning surfaces intervention long before the ceiling is reached; the ceiling exists only as a backstop against a runaway loop with broken state-change detection.

---

### Compaction Recovery

If you lose context mid-review (e.g., after auto-compaction):

1. **Cursor is authoritative.** Read `<SHIPYARD_DATA>/sprints/current/REVIEW-CURSOR.md` first. The `stage:` field tells you exactly where to resume; PROGRESS.md and verdict files are confirmatory only.
2. Use Glob `<SHIPYARD_DATA>/verify/*-verdict.md` to find existing verdict files — these features are already reviewed
3. Read SPRINT.md — get the list of features to review
4. Skip features with verdict files where `complete: true`. If a verdict has `complete: false`, that review was interrupted — re-run the pipeline for that feature
5. **Staleness check**: read the feature spec file to find its `tasks:` list, then read each task file's Technical Notes for source file paths. If the most recent commit touching those source/test files (`git log -1 --format=%ci -- [paths]`) is newer than the verdict's `reviewed_at`, re-run the review — code has changed since the verdict was written
6. Resume the review pipeline from the cursor's `stage:` and the first feature without a valid verdict
7. For sprint-level review: aggregate results from verdict files when presenting the summary

Do not re-run the full test suite for features that already have valid (complete + fresh) verdict files.

---

## Review Pipeline

### Pre-flight: Branch Check (stage_id: preflight)

Verify we're on the working branch from SPRINT.md frontmatter:

1. Read `branch` from SPRINT.md frontmatter
2. `git branch --show-current` — if not on the expected branch, `git checkout [branch]`

This ensures review and any patch fixes happen on the correct branch.

- **Cursor write**: on success, write `stage: code_review_iter_1` (or `stage: tests` if `--skip-code-review`, or `stage: retro_step_1` if `--retro-only`), `iteration: 1`, `terminal: false`, `next_action: "Run Stage 0 code review iteration 1"`. When `loop_owner == "/loop"`: emit `pipeline_tick_completed pipeline=ship-review sprint=<id> stage=preflight outcome=advanced next_stage=<next>` and print `▶ TICK COMPLETE — pipeline at stage [next_stage]. /loop continues.` then exit. When direct invocation: chain into the next stage's handler (subject to the ~3-minute wall-clock budget).

---

For each feature/task being reviewed:

### Stage 0: Code Review Loop (stage_id: code_review_iter_N) (sprint completion)

Skip if `--skip-code-review` is passed or reviewing a hotfix.

Run the multi-agent code review on the sprint's diff before tests and spec compliance — 6 parallel scanners + an opus investigator (orchestration logic in `references/code-review-orchestration.md`) catch bugs, security issues, silent failures, and pattern violations, then the `shipyard:dispatching-task-loop` fixer addresses must-fix and should-fix items.

**Goal-mode default — run until scanners come back clean.** This loop is /goal-shaped: keep dispatching the fixer against the residual findings without user interruption. Loop until the scanners report zero must-fix items. There is no arbitrary iteration cap — convergence is data-driven. Do NOT pause mid-loop to ask the user whether to keep going — that pre-empts the convergence signal. Emit a structured `code_review_iteration` event per pass via `shipyard-data events emit code_review_iteration sprint=<id> iteration=<N> must_fix=<count> should_fix=<count>` so the user (and `/ship-status`) can see the loop's trajectory without a prompt.

**Stuck detection (replaces the prior hard iteration limit):** `pipeline_stuck` warns when `stuck_counter >= 5` (5 consecutive ticks with no change in the (must_fix, should_fix) tuple) — non-blocking, the loop keeps running. The absolute safety stop is `hard_ceiling: 50` iterations; in practice the 5-tick stuck warning surfaces intervention much sooner. See the "Self-looping stages" section above for the full protocol.

**At hard ceiling only** (`iteration == 50`): emit `shipyard-data events emit code_review_escalated sprint=<id> must_fix_remaining=<count> should_fix_remaining=<count>`, write `B-CR-*` bugs for the residual findings, write the cursor with `status: escalated`, `terminal: true`, and surface ONCE via AskUserQuestion: *"Code review hit its hard ceiling of 50 iterations with [N] must-fix items remaining. (a) write B-CR bugs and proceed to demo, (b) hand back without demo so I can investigate manually."* Recommended: (a). Out-of-scope scanner findings become IDEAs (see Stage 4 protocol). Full mechanics — checkpoint tags, fixer parameters, PROGRESS.md table format, scope guard — in `references/scanner-dispatch.md`.

- **Cursor write**: on iteration completing with `must_fix > 0`: write `stage: code_review_iter_<N+1>`, increment `iteration`, update `stuck_counter` (increment if state unchanged, reset to 0 if changed), `terminal: false`, `next_action: "Re-scan after fixer iteration <N+1>"`. Emit `pipeline_tick_completed outcome=self_loop next_stage=code_review_iter_<N+1>` and print `▶ TICK COMPLETE — pipeline at stage [code_review_iter_<N+1>]. /loop continues.` On iteration completing with `must_fix == 0 && should_fix == 0`: advance to `stage: simplify`, emit `pipeline_tick_completed outcome=advanced next_stage=simplify`. On hard ceiling (`iteration == 50`): emit `pipeline_terminal outcome=escalated reason=hard_ceiling_stage_code_review_iter` and print `▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.`

### Stage 0.5: Code Simplification (stage_id: simplify)

Skip if `--skip-code-review` is passed (same gate as Stage 0).

After Stage 0 exits clean, spawn the `code-simplifier:code-simplifier` agent against the sprint diff to clean up quick patches the fixer may have introduced. Scope-guarded to sprint-diff files only — reverts via `git reset --hard HEAD~1` if the simplifier touches unexpected files. Mechanics in `references/scanner-dispatch.md`.

- **Cursor write**: on completion (success or logged-and-continue), write `stage: tests`, `terminal: false`, `next_action: "Run Stage 1a full test suite via dispatching-operational-task"`. When `loop_owner == "/loop"`: emit `pipeline_tick_completed outcome=advanced next_stage=tests` and print `▶ TICK COMPLETE — pipeline at stage [tests]. /loop continues.` then exit. Direct invocation: chain into the next stage.

### Stage 1: Run Tests & Spec Verification (stage_id: tests, then spec_review)

**1a. Run all tests** — invoke the **`shipyard:dispatching-operational-task` capability skill** to avoid polluting the review context with raw test output. Pass `verify_command` resolved to each tier from `<SHIPYARD_DATA>/config.md` (`test_commands.unit`, `test_commands.integration`, `test_commands.e2e`); the capability skill captures output to `<SHIPYARD_DATA>/captures/` and returns the structured verdict (PASS/FAIL counts in `LAST_LINES:`). One operational dispatch per tier, or one combined dispatch if your project supports a single command. Use the returned verdicts for Stages 3–5 — do not re-run tests yourself.

- **Cursor write (after 1a)**: write `stage: spec_review`, `terminal: false`, `next_action: "Run Stage 1b spec review per feature"`. When `loop_owner == "/loop"`: emit `pipeline_tick_completed outcome=advanced next_stage=spec_review` and print `▶ TICK COMPLETE — pipeline at stage [spec_review]. /loop continues.` then exit. Direct invocation: chain.

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

- **Cursor write (after 1b)**: write `stage: visual` if any feature has UI components, else `stage: goal_verify`, `terminal: false`, `next_action: "Run Stage 2 visual verification"` (or `"Run Stage 3 goal verification"`). When `loop_owner == "/loop"`: emit `pipeline_tick_completed outcome=advanced next_stage=<next>` and print `▶ TICK COMPLETE — pipeline at stage [next_stage]. /loop continues.` then exit. Direct invocation: chain.

### Stage 2: Visual Verification (stage_id: visual) (UI tasks)

If the feature has UI components:
1. Ensure dev server is running (auto-start if needed)
2. Run end-to-end tests with screenshot capture
3. Screenshots at 3 viewports: mobile (375px), tablet (768px), desktop (1024px)
4. Use the Write tool to save to `<SHIPYARD_DATA>/verify/[feature-id]/`

**Live-capture the dev server and E2E runs.** Anything you run here to observe behavior (dev server startup logs, E2E runner output, `curl` sanity checks against the running app) goes through `shipyard-logcap run <name> --max-size <S> --max-files <N> -- <command>` unless the command already writes its own log file. Review re-runs are the most expensive kind — Opus-level reasoning burning tokens on output you already saw. If the first run surfaces something you want to inspect more closely, `shipyard-logcap grep` the existing capture with a different pattern **before** re-running the thing. Full guide and decision table for picking bounds: `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/live-capture.md`.

- **Cursor write**: write `stage: goal_verify`, `terminal: false`, `next_action: "Run Stage 3 goal verification"`. When `loop_owner == "/loop"`: emit `pipeline_tick_completed outcome=advanced next_stage=goal_verify` and print `▶ TICK COMPLETE — pipeline at stage [goal_verify]. /loop continues.` then exit. Direct invocation: chain.

### Stage 3: Did We Actually Achieve the Goal? (stage_id: goal_verify)

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

- **Cursor write**: write `stage: gap_analysis`, `terminal: false`, `next_action: "Run Stages 4 + 4.5 surface-gap + self-review"`. When `loop_owner == "/loop"`: emit `pipeline_tick_completed outcome=advanced next_stage=gap_analysis` and print `▶ TICK COMPLETE — pipeline at stage [gap_analysis]. /loop continues.` then exit. Direct invocation: chain.

### Stage 4: Surface Gap Analysis (stage_id: gap_analysis, part 1)

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

### Stage 4.5: Quality Gate (stage_id: gap_analysis, part 2) (self-review loop)

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

Iterate the checklist against your findings. If any check reveals a missed gap, add it to the gap list and re-run. **There is no arbitrary iteration cap** — loop until the checklist stabilizes (no new gaps added in a pass). Stuck detection: `pipeline_stuck` warns when `stuck_counter >= 5` (5 ticks with the same gap-list set), non-blocking, the loop keeps running. Hard ceiling: `hard_ceiling: 50` is the absolute safety stop — in practice the 5-tick warning surfaces intervention much sooner. See the "Self-looping stages" section near the top for the protocol. **Hold the table in mind across iterations — emit only per-iteration deltas (which gaps were added). Do not re-print the table on each pass.** Proceed to verdict (`stage: critic`) when the checklist stabilizes.

- **Cursor write**: on iteration completing with a non-empty gap-list delta: write `stage: gap_analysis`, increment `iteration`, update `stuck_counter` (increment if gap-list set unchanged, reset if changed), `terminal: false`, `next_action: "Re-run self-review iteration <N+1>"`. Emit `pipeline_tick_completed outcome=self_loop next_stage=gap_analysis` and print `▶ TICK COMPLETE — pipeline at stage [gap_analysis]. /loop continues.` On iteration completing with the gap-list stable: advance to `stage: critic`, emit `pipeline_tick_completed outcome=advanced next_stage=critic`. On hard ceiling: emit `pipeline_terminal outcome=escalated reason=hard_ceiling_stage_gap_analysis`.

### Stage 4.6: Critic Challenge (stage_id: critic)

After the self-review loop stabilizes, dispatch a **`general-purpose`** subagent in critic mode to challenge the review findings. The critic reads the feature spec, implementation, and the review's results to find what the reviewer missed — blind spots, false positives, and false negatives. Anti-sycophancy + pre-mortem framing; read-only.

The full subagent prompt template (with `<SHIPYARD_DATA>`, `[FEATURE_ID]`, stakes, and findings substitutions) and the consumption protocol live in `references/critic-prompt.md`. The critic returns a structured `STATUS: CHALLENGES` or `STATUS: NO_CHALLENGES` report — Stage 4.7 processes the findings with one surgical pass.

- **Cursor write**: write `stage: final_pass`, `terminal: false`, `next_action: "Run Stage 4.7 final pass on critic findings"`. When `loop_owner == "/loop"`: emit `pipeline_tick_completed outcome=advanced next_stage=final_pass` and print `▶ TICK COMPLETE — pipeline at stage [final_pass]. /loop continues.` then exit. Direct invocation: chain.

### Stage 4.7: Final Review Pass (stage_id: final_pass)

Process the critic's findings with **one** targeted pass — no iteration loop:

1. For each FAIL or HIGH-risk finding from the critic: verify it by checking the code/tests directly
2. If the critic identified a real blind spot → add it to the gap list with classification (simple/complex)
3. If the critic flagged a false positive in the review (something marked ✅ that isn't actually working) → downgrade it and add to gaps
4. If the critic's finding is itself a false positive (the review was correct) → discard it

Do not re-run the full review pipeline. This is a surgical pass on the critic's specific findings only. Update the gap counts and classifications, then proceed to the verdict.

- **Cursor write**: write `stage: verdict`, `terminal: false`, `next_action: "Write verdict file"`. When `loop_owner == "/loop"`: emit `pipeline_tick_completed outcome=advanced next_stage=verdict` and print `▶ TICK COMPLETE — pipeline at stage [verdict]. /loop continues.` then exit. Direct invocation: chain.

### Checkpoint: Write Verdict (stage_id: verdict)

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

- **Cursor write**: write `stage: demo_probe`, `terminal: false`, `next_action: "Run Stage 4.8 demo probe per feature"`. When `loop_owner == "/loop"`: emit `pipeline_tick_completed outcome=advanced next_stage=demo_probe` and print `▶ TICK COMPLETE — pipeline at stage [demo_probe]. /loop continues.` then exit. Direct invocation: chain.

### Stage 4.8: Demo-Path Verification (stage_id: demo_probe)

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

- **Cursor write**: on all probes PASS (or skip-with-reason): write `stage: demo_user`, `terminal: false`, `next_action: "Present results, AskUserQuestion approval"`. Emit `pipeline_tick_completed outcome=advanced next_stage=demo_user` and print `▶ TICK COMPLETE — pipeline at stage [demo_user]. /loop continues.` On any FAIL/TIMEOUT: handler routes to AskUserQuestion (blocking) — write the cursor with `stage: demo_probe`, `status: paused`, `next_action: "Awaiting user decision on demo failure"` before invoking AskUserQuestion.

### Stage 5: Demo to User (stage_id: demo_user)

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

- **Cursor write**: after the user answers, write `stage: process_approved` / `process_issues` / `process_changes` based on the answer, `terminal: false`, `next_action: "Process Stage 6 decision branch"`. Emit `pipeline_tick_completed outcome=advanced next_stage=<branch>` and print `▶ TICK COMPLETE — pipeline at stage [<branch>]. /loop continues.`

### Stage 6: Process Decision (stage_id: process_approved | process_issues | process_changes)

Based on the approval:
- **Approved** → Update feature statuses to `done` in feature frontmatter. Proceed to Sprint Retrospective (below).
- **Issues found** → Create bug entries via /ship-bug logic. Feature status → `approved` (not `in-progress` — it needs re-planning). Add feature ID back to BACKLOG.md so the next `/ship-sprint` picks it up.
- **Needs changes** → Update spec with new criteria. Create patch tasks. Feature status → `approved`, add ID back to BACKLOG.md. Show:
  ```
  ▶ NEXT UP: Fix the gaps and re-verify
    /ship-execute --task [patch task ID]
    (tip: /clear first for a fresh context window)
  ```

- **Cursor write**: on `process_approved` → write `stage: retro_step_1`, `terminal: false`. Emit `pipeline_tick_completed outcome=advanced next_stage=retro_step_1`. On `process_issues` → write `stage: terminal_issues`, `status: escalated`, `terminal: true`, emit `pipeline_terminal outcome=issues reason=user_flagged_issues` and print `▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.` On `process_changes` → write `stage: terminal_changes`, `status: escalated`, `terminal: true`, emit `pipeline_terminal outcome=changes reason=user_requested_changes` and print the terminal marker.

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

### Retro Step 1: Gather Data (stage_id: retro_step_1)
Compute planned-vs-delivered, velocity, carry-over, bugs, blocked time, swaps, patch tasks, estimate accuracy, throughput from SPRINT.md + task/feature files. Write to `RETRO-DATA.md` (`step: data_gathered`) and present the summary block.

- **Cursor write**: write `stage: retro_step_2`, `terminal: false`, `next_action: "Facilitate retro discussion (3× AskUserQuestion)"`. When `loop_owner == "/loop"`: emit `pipeline_tick_completed outcome=advanced next_stage=retro_step_2` and print `▶ TICK COMPLETE — pipeline at stage [retro_step_2]. /loop continues.` then exit. Direct invocation: chain.

### Retro Step 2: Facilitate Discussion (stage_id: retro_step_2)
Three sequential AskUserQuestion calls — lead each with the data-driven observation, then ask:
1. **What went well?**
2. **What didn't go well?**
3. **What should we change?**

Append responses to `RETRO-DATA.md` under `## Team Feedback`. Update frontmatter: `step: feedback_collected`.

- **Cursor write**: after all three AskUserQuestion responses are collected: write `stage: retro_step_3`, `terminal: false`, `next_action: "Create IDEA action items"`. Emit `pipeline_tick_completed outcome=advanced next_stage=retro_step_3` and print `▶ TICK COMPLETE — pipeline at stage [retro_step_3]. /loop continues.`

### Retro Step 3: Create Action Items (stage_id: retro_step_3)
For each actionable improvement, allocate an ID via `shipyard-data next-id ideas` (never `ls`-and-guess) and Write `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` with `source: retro/<sprint-id>` (slash form — matches the carry-over scan regex). Update `RETRO-DATA.md`: `step: action_items_created`.

- **Cursor write**: write `stage: retro_step_4`, `terminal: false`, `next_action: "Update metrics"`. When `loop_owner == "/loop"`: emit `pipeline_tick_completed outcome=advanced next_stage=retro_step_4` and print `▶ TICK COMPLETE — pipeline at stage [retro_step_4]. /loop continues.` then exit. Direct invocation: chain.

### Retro Step 4: Update Metrics (stage_id: retro_step_4)
Append velocity, carry-over rate, bug rate, estimate accuracy, anti-pattern flags to `<SHIPYARD_DATA>/memory/metrics.md` (quarterly rollover at 300 lines). Save key insights to memory.

- **Cursor write**: write `stage: release_step_1`, `terminal: false`, `next_action: "Present release plan, AskUserQuestion approval"`. When `loop_owner == "/loop"`: emit `pipeline_tick_completed outcome=advanced next_stage=release_step_1` and print `▶ TICK COMPLETE — pipeline at stage [release_step_1]. /loop continues.` then exit. Direct invocation: chain.

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

### Release Step 1: Present Release Plan (stage_id: release_step_1)
Read all `status: done` features from this sprint. Output the release plan as text — CHANGELOG block, STATUS CHANGES, RETRO HIGHLIGHTS, FILES WRITTEN. Release is the most irreversible action in the workflow; surface everything before confirming.

Then use `AskUserQuestion` for approval:
- **Release (Recommended)** — proceed to Release Step 2 (write everything)
- **Edit changelog** — adjust changelog text, then re-approve
- **Skip release** — skip release record, still archive sprint

- **Cursor write**: on **Release** → write `stage: release_step_2`, `terminal: false`. Emit `pipeline_tick_completed outcome=advanced next_stage=release_step_2` and print `▶ TICK COMPLETE — pipeline at stage [release_step_2]. /loop continues.` On **Skip release** → write `stage: archive`, `terminal: false`. Emit `pipeline_tick_completed outcome=advanced next_stage=archive`. On **Edit changelog** → write `stage: release_step_1`, increment `iteration`, `next_action: "Re-present after changelog edit"`. Emit `pipeline_tick_completed outcome=self_loop next_stage=release_step_1`.

### Release Step 2: Write Release Record (stage_id: release_step_2)
Update feature frontmatter (`status: released`, `released_at: [date]`) and prepend the new entry to `CHANGELOG.md` in the **project root** (not plugin data — this is a project deliverable that belongs in git).

- **Cursor write**: write `stage: release_step_3`, `terminal: false`. When `loop_owner == "/loop"`: emit `pipeline_tick_completed outcome=advanced next_stage=release_step_3` and print `▶ TICK COMPLETE — pipeline at stage [release_step_3]. /loop continues.` then exit. Direct invocation: chain.

### Release Step 3: Archive Sprint (stage_id: release_step_3)
Run `shipyard-data archive-sprint sprint-NNN` from Bash. This atomically renames `current/` → `sprint-NNN/` and recreates an empty `current/`. Do NOT synthesize raw `cp`/`mv`/`mkdir` against the plugin data dir — they're not portable and not atomic.

- **Cursor write**: the archive operation rotates `current/` so the cursor file goes with it. Advance to `stage: terminal` semantically — the next handler runs the terminal wrap-up against the now-archived sprint context.

### Final: Run Status
After archiving, run `/ship-status` to give the user a clean project health snapshot and auto-fix any state issues before the next cycle.

### Wrap Up (stage_id: terminal | archive)

The skip-release path (`stage: archive`) and the full-release path (after `release_step_3`) both converge here. Run the terminal protocol:

1. Emit the terminal event: `shipyard-data events emit pipeline_terminal pipeline=ship-review sprint=<id> outcome=success reason=cycle_complete`.
2. Use the Write tool to write the cursor with `terminal: true`, `status: complete`, `stage: terminal`, `next_action: "Pipeline complete — no further work."` (Note: the cursor file may already have rotated into the archived sprint directory after `archive-sprint`; if the new `current/` is empty, skip the cursor write — the terminal event is the canonical signal.)
3. Print the sprint-complete banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPRINT [NNN] COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Review: [N] features verified, [M] gaps patched
 Retro: [velocity] pts | [throughput] pts/hr | [N] improvements captured
 Release: changelog written to CHANGELOG.md (project root, appended)

▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.

▶ NEXT UP: Start the next cycle
  /ship-discuss — explore new features
  /ship-sprint — plan next sprint (if backlog has approved features)
  (tip: /clear first for a fresh context window)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

The marker line `▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.` is load-bearing — `/loop` drivers read it as the structural signal to refrain from scheduling another wakeup.

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
