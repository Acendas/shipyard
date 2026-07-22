---
name: ship-review
description: "Run multi-agent review, retrospective, and release."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, Agent, AskUserQuestion]
model: opus
effort: medium
argument-hint: "[feature ID] [--demo] [--hotfix ID] [--retro-only] [--skip-code-review] [--single-tick]"
---

# Shipyard: Review & Verification

Verify completed work against spec. Auto-test, screenshot, demo to user, get approval.

## Context

!`shipyard-context path`

!`shipyard-context view config`
!`shipyard-context view sprint 80`
!`shipyard-context view sprint-progress`
!`shipyard-context view metrics 50`

**Paths.** All Shipyard file ops use the absolute SHIPYARD_DATA prefix from the context block (no `~`, `$HOME`, or shell variables). Bash is for project tests, git, and the `shipyard-data` CLI (cursor/sprint mutations + `archive-sprint`). **Never `cd` into the data directory before running `shipyard-data` commands** — they resolve the data directory internally via git and env vars; `cd`-ing into a non-git directory breaks the resolver. **Never use `echo`, `printf`, or shell redirects (`>`) to write state files.**

**The pipeline cursor, PROGRESS.md, and HANDOFF.md are CLI-owned — the model never writes them.** A PreToolUse hook DENIES any Write/Edit targeting `REVIEW-CURSOR.md`, `PROGRESS.md`, or `HANDOFF.md`. The only writer is the `shipyard-data cursor` CLI, which validates the stage transition against the stage graph, runs the terminal-evidence gate + loop-leak guard in-process (exit 3 with reasons on failure), appends the pipeline event atomically with the cursor write, re-renders PROGRESS.md, and prints the tick/terminal marker lines itself (stop marker guaranteed LAST). So: advance a tick with `shipyard-data cursor advance review <stage> [k=v ...] [--note "<narrative>"]`; do NOT emit `pipeline_tick_completed`/`pipeline_terminal` yourself and do NOT print your own `▶ TICK COMPLETE`/`▶ CYCLE COMPLETE` markers — echo the CLI's output as the final lines of the tick. SPRINT.md frontmatter is mutated via `shipyard-data sprint set <key> <value>` (never a model Edit). Verdict files (`verify/<F>-verdict.md`) and other narrative artifacts stay model Writes. Use the Write tool (auto-approved for SHIPYARD_DATA) for those. When passing paths into spawned Agent prompts, substitute the literal SHIPYARD_DATA path.

**Render before asking.** Before every AskUserQuestion, render the decision context — the scenarios, concrete examples, tradeoffs, and any verbatim content being approved — as chat text; the tool call then carries only the short question and option labels. A bare AskUserQuestion with no rendered context above it is a bug (the window is too small to carry a real decision).

## Input

$ARGUMENTS

## Detect Mode

- Feature ID (F001) → Review specific feature
- `--demo` → Include interactive demo (open browser, fill forms)
- `--hotfix B-HOT-001` → Fast-track hotfix review
- `--retro-only` → Skip review, run only the retrospective (for cancelled sprints or re-running retro)
- No args → Review all completed tasks in current sprint, then run retrospective
- No active sprint and no feature ID (sprint already archived: `current/` directory is empty or absent of `SPRINT.md`) → **No-op terminal path.** Run `shipyard-data cursor noop review sprint=<last-known-or-unknown> reason=sprint_already_archived` and echo its output (it emits `pipeline_terminal outcome=noop`, runs repeat-leak detection, and prints the stop marker as the final line). Exit cleanly without invoking AskUserQuestion. (This is the exact path that fired the original /loop bug — there was no terminal signal so /loop kept scheduling wakeups against an archived sprint.)

---

## Cursor + Per-Tick Advance

`/ship-review` is a multi-stage pipeline. To make it `/loop`-friendly, each invocation reads a persistent cursor at `<SHIPYARD_DATA>/sprints/current/REVIEW-CURSOR.md`, dispatches to the matching stage handler, then advances the cursor for the next tick via the CLI. Full cursor schema, stage map, terminal protocol, event vocabulary, and stuck-detection rules live in `references/pipeline-cursor.md` — read it before changing the cursor surface.

**Cursor read at entry.** Begin every invocation with:

1. Read `<SHIPYARD_DATA>/sprints/current/REVIEW-CURSOR.md` (use the Read tool — reads are unchanged; only writes are CLI-owned).
   - **If the file exists and `terminal: true`**: run `shipyard-data cursor noop review sprint=<id> reason=cursor_already_terminal`, echo its output, exit.
   - **If the file exists and `status: paused`** (a pause-before-ask stage is awaiting a user answer): **paused is wakeup-inert.** A `/loop` wakeup must NEVER resume it — a wakeup can't answer the pending question. Run `shipyard-data cursor noop review sprint=<id>`, echo its output (it emits `pipeline_terminal outcome=noop reason=awaiting_user_paused`, prints the pause note + resume hint + stop marker; a 2nd wakeup against the same paused sprint trips the ⛔ leak alarm pointing at `cursor resume`), and STOP. Only when the user is explicitly re-engaging this invocation (they answered the pending question, or asked to continue) run `shipyard-data cursor resume review` and dispatch to `cursor.stage`.
   - **If the file exists and `terminal: false`** (and not paused): dispatch to the handler for `cursor.stage` (per the stage map in `references/pipeline-cursor.md`). (`pipeline_tick_started`/`pipeline_tick_completed` are CLI-emitted on every advance — no manual event emits.)
   - **If the file does NOT exist**: fresh start. Dispatch to the preflight handler; the handler's `cursor advance` call materializes the cursor (and emits the tick events).

2. **No-op terminal sweep (MANDATORY — load-bearing for /loop safety).** Even if step 1 read a non-terminal cursor (or no cursor at all), verify the sprint is actually alive by checking all THREE conditions:
   - cursor exists with `terminal: true` (already covered in step 1; re-checking here is belt-and-braces)
   - `<SHIPYARD_DATA>/sprints/current/SPRINT.md` frontmatter has `status: completed`
   - There is no active sprint in `<SHIPYARD_DATA>/sprints/current/` (already archived — `current/` directory empty or absent of SPRINT.md)

   If ANY of these hold AND no feature ID was passed as an argument, run the no-op terminal path via a single CLI call:
   - Run `shipyard-data cursor noop review sprint=<id-or-unknown> reason=sprint_already_archived`. This does the whole sweep in-process: emits `pipeline_terminal outcome=noop` FIRST (non-optional — skipping it is what made the original leak invisible in the audit log), runs the repeat-leak detection (a 2nd no-op for the same dead sprint emits `pipeline_loop_leak_detected` + prints the `⛔ LOOP LEAK …` marker), and prints the stop marker as the final line. Echo its output.
   - **Cron-fallback cleanup:** `cursor noop` (like `pause`/`escalate`/terminal `advance`) prints a cron-cleanup reminder line itself when the event log shows an armed `pipeline_loop_bootstrap_fallback` cron. Act on that reminder line whenever it's printed: `CronList` + `CronDelete` any cron whose prompt targets `/shipyard:ship-review`.

   Exit cleanly without invoking AskUserQuestion. NEVER skip this sweep — it is the exact protection that closed the original `/loop` wakeup-leak bug. The auto-loop bootstrap below explicitly depends on this sweep having run with no exit triggered. Full protocol in `references/pipeline-cursor.md`.

3. After the chosen stage's handler returns, advance the cursor for tick N+1 (or for terminal exit) with `shipyard-data cursor advance review <next-stage> [k=v ...] [--note "..."]` (terminal stages use `advance review terminal|terminal_issues|terminal_changes`, or `cursor escalate review reason=<r>` for a mid-stage escalation). The CLI emits the `pipeline_tick_completed`/`pipeline_terminal` event atomically with the cursor write and prints the marker text.

The CLI is the single cursor writer (auto-approved; a direct model Write to the cursor is DENIED by the hook). The marker text it prints is load-bearing — `/loop` drivers (and the loop-driving model) read `CYCLE COMPLETE` + `/loop should stop` as the structural signal to refrain from scheduling another wakeup, and the CLI guarantees that marker is the LAST line.

**Pause before every blocking ask (load-bearing rule): a tick never exits with a pending question and no stop marker.** At every stage that blocks on `AskUserQuestion` for user input — `demo_user` (Stage 5 approval), `retro_step_2` (retro discussion), `release_step_1` (release plan) — run `shipyard-data cursor pause review --note "awaiting user: <what>"` **before** invoking `AskUserQuestion`. The pause writes `status: paused` and prints the stop marker, so if the tick is torn down (context loss, or the `/loop` driver treating the ask as end-of-tick) the persisted state is `paused` and the next wakeup no-ops instead of re-running the stage and re-asking the same question every wakeup. On the user's answer, run `shipyard-data cursor resume review`, then proceed with the stage handler. The `demo_probe` FAIL path already does exactly this (Stage 4.8) — it's the pattern to mirror. (pause keeps the current stage; resume returns to it — no stage-graph change is involved.)

**Direct invocation vs /loop driver.** The same skill body serves both callers:

- **Direct invocation** (user runs `/ship-review` or `/ship-review F-NNN` from the prompt): after a handler returns, if the next stage is non-terminal AND non-blocking (no `AskUserQuestion` required AND no expensive long-running operation), the dispatcher MAY chain into it within the same invocation. Bound the chain by an approximate wall-clock budget of **~10 minutes** per invocation to keep ticks responsive and interruptible.
- **`/loop` driver** (the invocation is one tick of a `/loop` schedule): each tick is exactly one handler. After the handler's `shipyard-data cursor advance` returns (it emits `pipeline_tick_completed` and prints the marker), exit. The chain-within-invocation logic is suppressed when `loop_owner == "/loop"`. The next `/loop` wakeup picks up from the cursor's `stage:`.

**`loop_owner` detection.** The heuristic is CLI-owned (centralized in `shipyard-data cursor bootstrap-check` so it can be fixed in one place): the most recent `pipeline_tick_completed` event whose `next_stage` matches the current cursor's `stage` AND whose timestamp is **within the last 5 minutes** (v3.4.0, was 30) marks this invocation as a `/loop` re-entry (`loop_owner: "/loop"`); otherwise it's a direct user invocation (`loop_owner: "user"`). The cursor's own `loop_owner` field wins when set. A live `/loop` ticks well inside 5 minutes; the tighter window means an abandoned session doesn't masquerade as a live loop for half an hour (which would one-tick-stall the pipeline and disarm the cron fallback, which requires `loop_owner=user`). A user explicitly passing `--single-tick` forces `/loop` semantics — the override for "I want one tick now and that's it."

**Auto-loop bootstrap.** When a user invokes `/ship-review` directly (not `--retro-only` — single-pass retro never loops), run `shipyard-data cursor bootstrap-check review`. The CLI evaluates everything (loop-owner detection, cursor non-terminal, sentinel not set, sprint liveness) and prints one JSON line; when `eligible: true` it has already set the `auto_loop_attempted` sentinel on the cursor. Then:

- `eligible: true` → emit `shipyard-data events emit pipeline_loop_bootstrap pipeline=ship-review sprint=<id> via=auto`, invoke `Skill(skill: "loop", args: "/shipyard:ship-review")`, print `▶ AUTO-LOOP STARTED — /shipyard:ship-review is now driven by /loop. Subsequent stages will fire automatically.`, and return — the /loop re-entry owns the tick work.
- `eligible: false` → proceed with this tick (the JSON's `reason` says why; a `reason` naming a dead sprint means the no-op sweep should already have exited).

**Fallback if `/loop` goes silent.** If a tick re-enters with `loop_owner == "user"` AND `auto_loop_attempted == true` AND the last `pipeline_tick_completed` event from this pipeline is older than 5 minutes (i.e., `/loop` accepted the bootstrap but stopped firing), call `CronCreate(cron: "*/2 * * * *", prompt: "/shipyard:ship-review", recurring: false)` to nudge the next tick, then proceed with this tick's work. Emit `shipyard-data events emit pipeline_loop_bootstrap_fallback pipeline=ship-review sprint=<id> method=cron reason=loop_silent`. This path exists for resilience; in normal operation `/loop` keeps firing and the fallback never triggers.

### Self-looping stages: stuck detection

Two stages can self-loop until they converge by data: `code_review_iter_N` (Stage 0 — scanner clean signal) and `gap_analysis` (Stages 4 + 4.5 — checklist stable signal). There is no arbitrary iteration cap; convergence is data-driven. Stuck detection works as follows:

- `stuck_counter` is CLI-owned: a self-loop `cursor advance` auto-increments it and auto-emits `pipeline_stuck` at ≥5; at `hard_ceiling` the CLI refuses the advance and directs to `cursor escalate`. Your only job: pass `stuck_counter=0` when the self-loop made real progress (for `code_review_iter_N`, the (must_fix, should_fix) tuple changed; for `gap_analysis`, the gap list changed set-wise).
- If `stuck_counter >= 5` (5 ticks without state change): for `code_review_iter_N` (the fixer has stalled with an unchanged must-fix set), FIRST invoke the `shipyard:escalating-to-thinker` capability skill (trigger: `repeated_fix_failure`, subject: `code_review_iter`) — a think-tier consult may diagnose why the fixer isn't converging and recommend a normal-path unstick. Then, whether or not the consult ran (it may be capped), emit `shipyard-data events emit pipeline_stuck pipeline=ship-review sprint=<id> stage=<id> iterations=<N> reason=no-state-change` AND surface a non-blocking one-line warning in the user-facing text: `⚠ Stage [X] has run [N] times without state change. /ship-status to inspect; consider manual intervention.` The loop keeps running — the warning is informational.
- `hard_ceiling: 50` is the absolute safety stop. If a self-loop stage reaches `iteration: 50`, run `shipyard-data cursor escalate review reason=hard_ceiling_stage_<id>` (terminal escalation from the current stage — sets `status: escalated`, `terminal: true`, emits `pipeline_terminal outcome=escalated`, prints the stop marker), echo its output, and halt. In practice the 5-tick warning surfaces intervention long before the ceiling is reached; the ceiling exists only as a backstop against a runaway loop with broken state-change detection.

---

### Compaction Recovery

If you lose context mid-review (e.g., after auto-compaction):

1. **Cursor is authoritative.** Read `<SHIPYARD_DATA>/sprints/current/REVIEW-CURSOR.md` first. The `stage:` field tells you exactly where to resume; verdict files are the secondary cross-check. PROGRESS.md is a rendered artifact (auto-regenerated from the event log on every cursor write) — never reconcile against it as if it were authoritative state, and never Write or Edit it.
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

- **Cursor advance**: on success, run `shipyard-data cursor advance review code_review_iter_1` (or `... tests` if `--skip-code-review`, or `... retro_step_1` if `--retro-only`) with `iteration=1 --note "Run Stage 0 code review iteration 1"`. When `loop_owner == "/loop"`: exit after the advance. When direct invocation: chain into the next stage's handler (subject to the ~10-minute wall-clock budget).

**Anti-improvisation assertion (v2.6.0).** Stage 0 (multi-agent code review) MUST run whenever `/ship-review` is invoked WITHOUT one of `--skip-code-review`, `--hotfix`, or `--retro-only`. The sprint's frontmatter `status:` field (`completed`, `in-progress`, `approved`, …) DOES NOT affect this — code review runs on the diff regardless of how upstream pipelines have annotated the sprint. If Stage 0 genuinely cannot run on this invocation (e.g., the diff is empty because the working branch matches the base), emit a structured `stage_0_skipped reason=<short reason>` event via `shipyard-data events emit ...` and continue to `stage: tests`. Do NOT improvise a `notes:` field in the cursor body to justify skipping stages — the cursor body is free-form narrative per the schema in `references/pipeline-cursor.md`, and structured claims about which stages ran or didn't run live in the event log, not in cursor prose. **Why this is load-bearing:** in the v2.5.0 confedit incident, the review-side model wrote `"Running review pipeline directly with --skip-code-review semantics (Stages 0/0.5/4.6/4.7 deferred — not run)"` into the cursor body to justify skipping Stage 0 because the sprint had `status: completed`. There is no documented code path for that decision; the model invented it. With Stage 0 skipped, three real defects (T-P001 missing `liveValidate`, T-P002 `aria-describedby` clone, T-P003 missing Playwright spec) were filed as manual patch tasks instead of being auto-fixed by the Stage 0 → `dispatching-task-loop` pipeline.

---

For each feature/task being reviewed:

### Stage 0: Code Review Loop (stage_id: code_review_iter_N) (sprint completion)

Skip if `--skip-code-review` is passed or reviewing a hotfix. **Do not skip based on sprint frontmatter status** — see the anti-improvisation assertion in the Preflight section.

Run the multi-agent code review on the sprint's diff before tests and spec compliance — a fresh-context code-review subagent scans seven concern domains (security, bugs, silent-failures, patterns, tests, observability, data; orchestration logic in `references/code-review-orchestration.md`, optional parallel-split for high-stakes diffs), then the `shipyard:dispatching-task-loop` fixer addresses must-fix and should-fix items.

**Goal-mode default — run until scanners come back clean.** This loop is /goal-shaped: keep dispatching the fixer against the residual findings without user interruption. Loop until the scanners report zero must-fix items. There is no arbitrary iteration cap — convergence is data-driven. Do NOT pause mid-loop to ask the user whether to keep going — that pre-empts the convergence signal. Emit a structured `code_review_iteration` event per pass via `shipyard-data events emit code_review_iteration sprint=<id> iteration=<N> must_fix=<count> should_fix=<count>` so the user (and `/ship-status`) can see the loop's trajectory without a prompt.

**Stuck detection (replaces the prior hard iteration limit):** `pipeline_stuck` warns when `stuck_counter >= 5` (5 consecutive ticks with no change in the (must_fix, should_fix) tuple) — non-blocking, the loop keeps running. The absolute safety stop is `hard_ceiling: 50` iterations; in practice the 5-tick stuck warning surfaces intervention much sooner. See the "Self-looping stages" section above for the full protocol.

**At hard ceiling only** (`iteration == 50`): emit `shipyard-data events emit code_review_escalated sprint=<id> must_fix_remaining=<count> should_fix_remaining=<count>`, write `B-CR-*` bugs for the residual findings, run `shipyard-data cursor escalate review reason=hard_ceiling_stage_code_review_iter` (sets `status: escalated`, `terminal: true`, prints the stop marker), and surface ONCE via AskUserQuestion: *"Code review hit its hard ceiling of 50 iterations with [N] must-fix items remaining. (a) write B-CR bugs and proceed to demo, (b) hand back without demo so I can investigate manually."* Recommended: (a). Out-of-scope scanner findings become IDEAs (see Stage 4 protocol). Full mechanics — checkpoint tags, fixer parameters, event-log trajectory, scope guard — in `references/scanner-dispatch.md`.

- **Cursor advance**: on iteration completing with `must_fix > 0`: run `shipyard-data cursor advance review code_review_iter_<N+1> iteration=<N+1> stuck_counter=<n> --note "Re-scan after fixer iteration <N+1>"` (pass `stuck_counter=0` only when the (must_fix, should_fix) tuple changed — otherwise the CLI auto-increments). On iteration completing with `must_fix == 0 && should_fix == 0`: run `shipyard-data cursor advance review simplify`. On hard ceiling (`iteration == 50`): `shipyard-data cursor escalate review reason=hard_ceiling_stage_code_review_iter` (see the hard-ceiling bullet above).

### Stage 0.5: Code Simplification (stage_id: simplify)

Skip if `--skip-code-review` is passed (same gate as Stage 0).

After Stage 0 exits clean, spawn a general-purpose simplifier subagent (inline prompt — no external-plugin dependency) against the sprint diff to clean up quick patches the fixer may have introduced. **Model tier (build)** — pass `model: <models.build>` from config if non-empty, else OMIT `model:` (inherit session model); never hardcode a literal. Scope-guarded to sprint-diff files only — reverts via `git reset --hard HEAD~1` if the simplifier touches unexpected files. Mechanics (including the model rule) in `references/scanner-dispatch.md`.

- **Cursor advance**: on completion (success or logged-and-continue), run `shipyard-data cursor advance review tests --note "Run Stage 1a full test suite via dispatching-operational-task"`.

### Stage 1: Run Tests & Spec Verification (stage_id: tests, then spec_review)

**1a. Run all tests** — invoke the **`shipyard:dispatching-operational-task` capability skill** to avoid polluting the review context with raw test output. Pass `verify_command` resolved to each tier from `<SHIPYARD_DATA>/config.md` (`test_commands.unit`, `test_commands.integration`, `test_commands.e2e`); the capability skill captures output to `<SHIPYARD_DATA>/captures/` and returns the structured verdict (PASS/FAIL counts in `LAST_LINES:`). One operational dispatch per tier, or one combined dispatch if your project supports a single command. Use the returned verdicts for Stages 3–5 — do not re-run tests yourself.

- **Cursor advance (after 1a)**: run `shipyard-data cursor advance review spec_review --note "Run Stage 1b spec review per feature"`.

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

- **Cursor advance (after 1b)**: run `shipyard-data cursor advance review quality_gates --note "Run Stage 1.5 quality gate enforcement"`.

### Stage 1.5: Quality Gate Enforcement (stage_id: `quality_gates`)

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/quality-gate-enforcement.md`

Read `<SHIPYARD_DATA>/sprints/current/QUALITY-GATE.md`. For each probe/tool gate, dispatch via `shipyard:dispatching-operational-task`. Collect manual gates into a checklist for Stage 5. Write results back to QUALITY-GATE.md. If >50% of gates fail, AskUserQuestion: continue or abort.

**Skip if:** QUALITY-GATE.md doesn't exist or is empty.

- **Cursor advance**: on completion, run `shipyard-data cursor advance review visual` (or `... goal_verify` if no UI) and echo its output.

### Stage 2: Visual Verification (stage_id: visual) (UI tasks)

If the feature has UI components:
1. Ensure dev server is running (auto-start if needed)
2. Run end-to-end tests with screenshot capture
3. Screenshots at 3 viewports: mobile (375px), tablet (768px), desktop (1024px)
4. Use the Write tool to save to `<SHIPYARD_DATA>/verify/[feature-id]/`

**Live-capture the dev server and E2E runs.** Anything you run here to observe behavior (dev server startup logs, E2E runner output, `curl` sanity checks against the running app) goes through `shipyard-logcap run <name> --max-size <S> --max-files <N> -- <command>` unless the command already writes its own log file. Review re-runs are the most expensive kind — Opus-level reasoning burning tokens on output you already saw. If the first run surfaces something you want to inspect more closely, `shipyard-logcap grep` the existing capture with a different pattern **before** re-running the thing. For bound-picking guidance, see the logcap usage notes in `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/context-management.md`.

- **Cursor advance**: run `shipyard-data cursor advance review goal_verify --note "Run Stage 3 goal verification"`.

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

- **Cursor advance**: run `shipyard-data cursor advance review gap_analysis --note "Run Stages 4 + 4.5 surface-gap + self-review"`.

### Stage 4: Surface Gap Analysis (stage_id: gap_analysis, part 1)

**Dispatch the analytical body to a think-tier gap-analysis agent (per gap_analysis tick).** The surface-gap detection below AND the Stage 4.5 10-check self-review are reasoning-heavy read-only analysis — dispatch them as **ONE** agent so the reviewer shell doesn't hold every feature spec, the full diff, and all test/spec-review evidence in context while it reasons. The shell keeps everything with a side effect: the cursor advance, the `stuck_counter` computation, the gap→persistence-target actions (patch task / debug session / IDEA file / inline-fix dispatch in the classification tree below), and all user-facing surfacing. The agent only analyzes and returns.

**Model tier (think)** — read `models.think` from `<SHIPYARD_DATA>/config.md` (the context block above already carries config, or Read it). If non-empty, pass `model: <value>` on the `Agent(...)` call; if empty or absent, OMIT `model:` so the agent inherits the session model. Never hardcode a literal.

Dispatch a single `Agent(subagent_type: "general-purpose", model: <models.think — omit if empty>)` with a prompt that inlines: the sprint's feature and task file paths (under `<SHIPYARD_DATA>/spec/`), the verdict-relevant evidence paths gathered so far (Stage 1 test-output captures, Stage 1b spec-review findings, Stage 3 goal-verification results as recorded), the literal SHIPYARD_DATA path, and the Stage 4.5 10-check self-review table (inline it or point the agent at this section). The agent is **READ-ONLY analysis** — no writes, no commits, enforced by a post-return `git status --porcelain` check. It returns: (1) the structured gap list (each gap with a proposed classification — inline-fix / patch task / debug session / out-of-scope IDEA), and (2) the per-check results of the 10-check self-review table.

The shell then acts on the returned gap list using the classification tree below (Stage 4) and drives the Stage 4.5 loop: it computes `stuck_counter` (set-equal on the gap list), advances the cursor, and re-dispatches the agent on the next `gap_analysis` tick when the gap list is still changing. **Fallback.** On dispatch failure, run the Stage 4 + 4.5 analysis inline in the shell as before.

Additionally detect:
- **Untested scenarios** — acceptance scenarios without end-to-end tests
- **Missing edge cases** — empty states, error states, loading states
- **Accessibility gaps** — missing screen reader labels, keyboard navigation, contrast
- **Security concerns** — hardcoded values, missing input validation
- **Anti-patterns** — TODO comments, console.log left in, empty catch blocks

For each gap, classify into one of four destinations — this is a decision tree, not a menu, and the classification determines which persistence target the gap lands in:

- **Existing-code one-line / template defect** (v2.6.0) → **inline-fix** via `dispatching-task-loop` with a synthetic patch task. Mirrors Stage 0's auto-fix pattern. Boundary criteria: fix is ≤5 lines of diff, touches files already on the working branch, needs no new dependencies/modules/test scaffolding, and the regression test either exists or can be written in ≤30 lines. Concrete shape: a missing prop on an existing component, a faulty `cloneElement` in an existing template, a forgotten `await`, a missing null guard with an existing test that already exercises the path. After the synthetic task lands its commit, re-enter Stage 4 once (`gap_analysis_iter_<N+1>`) on the patched diff — the gap should no longer appear. If the boundary check is uncertain or the inline fix introduces a new gap, fall through to the **patch task** classification below; the asymmetric cost (missed inline-fix is one extra `/ship-execute --task` invocation, wrong inline-fix is a bad commit landing without user approval) biases toward safety. Emit `patch_task_created task_id=<id> feature=<F> source=review-inline-fix` for traceability.
- **Simple and in-scope, new functionality** (missing test for this feature, missing endpoint, missing widget, TODO left in this feature's files, missing validation on this feature's inputs) → **patch task** for builder. Use the existing patch-task creation flow. Hand off to the user via Stage 5's `Fix first` branch ("run `/ship-execute --task <id>`").
- **Complex and in-scope** (feature doesn't work but tests pass, wiring broken within this feature, behavior contradicts this feature's spec) → **debug session**. Use the Write tool to create `<SHIPYARD_DATA>/debug/[feature-id]-[gap].md` with the symptoms and evidence from the review.
- **Out-of-scope** (real defect or smell that isn't in the feature being reviewed — e.g., while reviewing the payments feature, the scanner flagged a race condition in the auth middleware) → **IDEA file**. Capture the observation as an idea so it doesn't vanish, without polluting the current feature's review. See "Capture Out-of-Scope Gaps as IDEAs" below.

**Capture Out-of-Scope Gaps as IDEAs.** Out-of-scope gaps are real defects but don't belong in the current feature's patch-task list or debug session. Allocate an ID via `shipyard-data next-id ideas` (never `ls`-and-guess), then Write `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` with `source: review-gap/<sprint-id>`, `found_during: surface-gap-stage-4` (or `code-review-stage-0`), and `feature_reviewed: <feature-id>`. **Hard cap: 5 per stage** (Stage 0 and Stage 4 budgets are independent); on overflow, write one `overflow: true` summary IDEA. **Hard rule — out-of-scope only:** in-scope must-fix → `B-CR-*` bugs, in-scope complex → debug session, in-scope simple → patch task. Full IDEA frontmatter schema, capture-vs-skip criteria, and frontmatter template in `references/scanner-dispatch.md`.

### Stage 4.5: Quality Gate (stage_id: gap_analysis, part 2) (self-review loop)

**The 10-check evaluation itself runs inside the Stage 4 gap-analysis agent** (dispatched above) — the agent applies this table to its findings and returns the per-check results alongside the gap list. The **shell** owns the loop control: it reads the returned results, updates the gap list, computes `stuck_counter`, advances the cursor, and decides whether to re-dispatch (gap list still changing) or proceed to `stage: critic` (gap list stable). On dispatch failure the shell evaluates the table inline.

Before writing the verdict, the self-review re-reads the feature spec and the findings against this table:

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

- **Cursor advance**: on iteration completing with a non-empty gap-list delta: run `shipyard-data cursor advance review gap_analysis iteration=<N+1> stuck_counter=<n> --note "Re-run self-review iteration <N+1>"` (pass `stuck_counter=0` only when the gap-list set changed — otherwise the CLI auto-increments). On iteration completing with the gap-list stable: run `shipyard-data cursor advance review critic`. On hard ceiling: `shipyard-data cursor escalate review reason=hard_ceiling_stage_gap_analysis`.

### Stage 4.6: Critic Challenge (stage_id: critic)

After the self-review loop stabilizes, dispatch a **`general-purpose`** subagent in critic mode to challenge the review findings. The critic reads the feature spec, implementation, and the review's results to find what the reviewer missed — blind spots, false positives, and false negatives. Anti-sycophancy + pre-mortem framing; read-only. **Model tier (think)** — pass `model: <models.think>` from config if non-empty, else OMIT `model:` (inherit session model); never hardcode a literal.

The full subagent prompt template (with `<SHIPYARD_DATA>`, `[FEATURE_ID]`, stakes, and findings substitutions) and the consumption protocol live in `references/critic-prompt.md`. The critic returns a structured `STATUS: CHALLENGES` or `STATUS: NO_CHALLENGES` report — Stage 4.7 processes the findings with one surgical pass.

- **Cursor advance**: run `shipyard-data cursor advance review final_pass --note "Run Stage 4.7 final pass on critic findings"`.

### Stage 4.7: Final Review Pass (stage_id: final_pass)

Process the critic's findings with **one** targeted pass — no iteration loop:

1. For each FAIL or HIGH-risk finding from the critic: verify it by checking the code/tests directly
2. If the critic identified a real blind spot → add it to the gap list with classification (simple/complex)
3. If the critic flagged a false positive in the review (something marked ✅ that isn't actually working) → downgrade it and add to gaps
4. If the critic's finding is itself a false positive (the review was correct) → discard it

Do not re-run the full review pipeline. This is a surgical pass on the critic's specific findings only. Update the gap counts and classifications, then proceed to the verdict.

**Critic deadlock.** If the critic's verdicts contradict the review's conclusions (e.g., the critic insists a ✅ is broken while direct verification says it holds, or vice versa) and a single reconciliation pass over the disputed items does NOT resolve which is right, invoke the `shipyard:escalating-to-thinker` capability skill (trigger: `critic_deadlock`, subject: the feature ID / disputed finding) before recording a verdict — a think-tier consult breaks the tie with a fresh reading. Only if it declines (cap reached), returns low confidence, or its recommendation also fails do you surface the contradiction to the user via AskUserQuestion. Do not silently pick a side.

- **Cursor advance**: run `shipyard-data cursor advance review verdict --note "Write verdict file"`.

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

- **Cursor advance**: run `shipyard-data cursor advance review demo_probe --note "Run Stage 4.8 demo probe per feature"`.

### Stage 4.8: Demo-Path Verification (stage_id: demo_probe)

**v2.6.0 sequencing change.** `/ship-execute` now runs demo_probes at its `sprint_demo_probes` stage (Step 5 item 3), before flipping SPRINT.md to `status: completed`. By the time `/ship-review` reaches this stage, the demo probes have usually already passed. This stage's job is to **re-verify on freshly-checked-out HEAD** as a sanity check (defends against "passed during execute, broken at merge" race conditions), with a skip-if-already-passed preflight to keep review fast on the happy path.

**Preflight.** Scan the event log for `acceptance_probe_completed feature=<F> probe_type=demo exit_code=0` per feature within the sprint window. If every feature in scope has a passing event, emit `stage_4_8_skipped reason=already_passed_in_execute` and advance straight to `stage: demo_user` — no need to re-run probes that just passed. Otherwise (some feature's probe wasn't run in execute, OR the user is reviewing a sprint that pre-dates v2.6.0), run the full sequence below.

For each feature whose probe wasn't already verified:

1. Read the feature's frontmatter `demo_probe:` field.
2. **If `demo_probe` is missing**: refuse to advance to Stage 5. Surface to user via AskUserQuestion: *"Feature [F-NNN] has no `demo_probe`. Approval is gated on a feature-level smoke test that exercises the cross-task user flow. (a) author one now via /ship-discuss [F-NNN], (b) skip with explicit reason, (c) abort review."* Recommended: (a).
3. **If `demo_probe: skip-with-reason`** with a `demo_probe_skip_reason` populated: include the reason in the per-feature summary (Stage 5) as a known limitation. Allow approval to proceed.
4. **Otherwise**: invoke the **`shipyard:running-acceptance-probe` capability skill** with `probe_command: <feature.demo_probe>`, `cwd: <repo root>`, `timeout_seconds: 120`. The capability skill runs the probe in a fresh shell and returns the structured verdict.
5. Emit `acceptance_probe_completed feature=<F> probe_type=demo exit_code=<n>` to the event log via `shipyard-data events emit ...` and include the verdict in the Stage 5 per-feature summary (PROGRESS.md auto-renders the verdict from the event):
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

- **Cursor advance**: on all probes PASS (or skip-with-reason): run `shipyard-data cursor advance review demo_user --note "Present results, AskUserQuestion approval"` and echo its output. On any FAIL/TIMEOUT: handler routes to AskUserQuestion (blocking) — run `shipyard-data cursor pause review --note "Awaiting user decision on demo failure"` (keeps `stage: demo_probe`, sets `status: paused`) before invoking AskUserQuestion.

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

**Quality Gate Results** (if QUALITY-GATE.md exists):
- Standing gates: [N] pass / [M] fail
- Sprint-specific gates: [N] pass / [M] fail
- Integration gates: [N] pass / [M] fail
- **Manual verification checklist** — batch ALL manual gates into a **single** `AskUserQuestion` call (each gate is one question: "[Gate description]. Verified? — yes / no / not applicable"), up to 4 questions per call; paginate into a second call only on overflow (>4 gates). Do NOT drip one gate per call. If there are few gates, fold them in as extra questions of the approval call below rather than making a separate call. Review cannot auto-approve if manual gates remain unverified.

**Recommended action** per feature:
- ✅ Approve — all checks passed
- ⚠️ Issues — minor gaps, suggest patch tasks
- ❌ Needs changes — significant gaps, needs rework

**Pause before the approval ask** (per the pause-before-ask rule above): run `shipyard-data cursor pause review --note "awaiting user: sprint approval decision"` before invoking `AskUserQuestion`. Then use `AskUserQuestion` for approval (this approval is load-bearing — NEVER skip user approval; batch the manual-gate questions above into this same call when there are few of them):
- **Approve (Recommended)** — update feature statuses to `done`, proceed to Sprint Retrospective
- **Refine** — give feedback on specific features, iterate
- **Fix first** — create patch tasks, show: "/ship-execute --task [patch task ID]"

On the user's answer, run `shipyard-data cursor resume review`, then advance:

- **Cursor advance**: after the user answers, run `shipyard-data cursor advance review process_approved` (or `... process_issues` / `... process_changes` per the answer) with `--note "Process Stage 6 decision branch"` and echo its output.

### Stage 6: Process Decision (stage_id: process_approved | process_issues | process_changes)

Based on the approval:
- **Approved** → `shipyard-data feature set-status <FID> done`. Proceed to Sprint Retrospective (below).
- **Issues found** → Create bug entries via /ship-bug logic. **Emit `bug_created` per bug** (`shipyard-data events emit bug_created bug=<id>`) — the terminal gate requires at least one such event in the review window before it will allow the `terminal_issues` cursor write (clause 3 below). `shipyard-data feature set-status <FID> approved` (not `in-progress` — it needs re-planning) followed by `shipyard-data backlog add <FID>` so the next `/ship-sprint` picks it up.
- **Needs changes** → Update spec with new criteria. Create patch tasks — **write each `spec/tasks/<id>-<slug>.md` file first**, then **emit `patch_task_created` per task** (`shipyard-data events emit patch_task_created task=<id>`). Order matters: a `patch_task_created` event for an id with no task file leaves a dangling reference that ship-status validation, this review's evidence check, and the next sprint's carry-over scan all trip over (`shipyard-data doctor` flags it). The terminal gate requires the event before allowing the `terminal_changes` cursor write (clause 3 below). `shipyard-data feature set-status <FID> approved` followed by `shipyard-data backlog add <FID>`. Show:
  ```
  ▶ NEXT UP: Fix the gaps and re-verify
    /ship-execute --task [patch task ID]
    (tip: /clear first for a fresh context window)
  ```

- **Cursor advance**: on `process_approved` → run `shipyard-data cursor advance review retro_step_1` and echo its output. On `process_issues` → run `shipyard-data cursor advance review terminal_issues outcome=issues reason=user_flagged_issues`. On `process_changes` → run `shipyard-data cursor advance review terminal_changes outcome=changes reason=user_requested_changes`. The CLI emits the terminal event and prints the stop marker as the final line.

- **Terminal-gate enforcement (v2.6.0).** The two **escalation** terminal advances — `terminal_changes` and `terminal_issues` — run the terminal-evidence gate in-process inside `shipyard-data cursor advance`. The advance is refused (exit 3, reasons printed) unless: (1) `pipeline_tick_completed pipeline=ship-review stage=demo_user` is in the event log (proving the user-approval step ran); **and** (2) at least one `patch_task_created` or `bug_created` event was emitted in this review window (this is why process_issues/process_changes MUST emit those events — see Stage 6 above; those non-cursor events are still emitted via `shipyard-data events emit`). If the advance exits 3, fix the missing evidence (or escalate) — do NOT try to Write the cursor directly, the hook denies it. **The approved-success path does NOT run a gated `terminal_approved` advance** — it archives the sprint (rotating `current/` away) and the terminal advance emits `pipeline_terminal outcome=approved`, so the gate's `terminal_approved` branch (per-feature approve-verdict enforcement in `bin/terminal-gate.mjs`) is a **defensive path the current flow doesn't exercise**; the approve-verdicts and the user-approval gate are enforced upstream (per-feature `verify/<F>-verdict.md` files + the demo_user tick). Run `shipyard-context terminal-gate ship-review` to inspect what would block a terminal advance right now.

## Hotfix Review

Fast-track for hotfixes:
1. Check regression test exists and passes
2. Check fix addresses the bug report
3. No full demo — just test verification
4. Report as a statement, not a question — Shipyard never merges or pushes (see Rules), so asking permission for an action it won't perform is misleading: *"Hotfix B-HOT-NNN verified (regression test red→green). Merge when ready — Shipyard doesn't touch your branches."*

---

## Sprint Retrospective

After sprint approval (or when `--retro-only` is passed), run the retrospective. This analyzes what happened, captures learnings, and creates improvement items. If `--retro-only` with a sprint ID, Read that sprint's archived files from `<SHIPYARD_DATA>/sprints/sprint-NNN/` instead of `current/`.

The retro runs in four steps with compaction recovery via `RETRO-DATA.md`'s `step` frontmatter field. Full mechanics — data-gathering source files, throughput computation, IDEA allocation/frontmatter, metrics rollover, anti-pattern flags — in `references/retro-and-release.md`.

### Retro Step 1: Gather Data (stage_id: retro_step_1)
Compute planned-vs-delivered, velocity, carry-over, bugs, blocked time, swaps, patch tasks, estimate accuracy, throughput from SPRINT.md + task/feature files. Write to `RETRO-DATA.md` (`step: data_gathered`) and present the summary block.

- **Cursor advance**: run `shipyard-data cursor advance review retro_step_2 --note "Facilitate retro discussion (one bulk AskUserQuestion)"`.

### Retro Step 2: Facilitate Discussion (stage_id: retro_step_2)
Pause before asking (per the pause-before-ask rule): run `shipyard-data cursor pause review --note "awaiting user: retro discussion"` before the `AskUserQuestion`. Then ask all three in **ONE** `AskUserQuestion` call (three questions), each led by its data-driven observation and each with a cheap exit ("'skip' is fine"):
1. **What went well?** — lead with what the data shows went well.
2. **What didn't go well?** — lead with the flagged issues.
3. **What should we change next sprint?** — lead with the suggested improvements.

On the user's answers, run `shipyard-data cursor resume review`, append responses to `RETRO-DATA.md` under `## Team Feedback`, and update frontmatter: `step: feedback_collected`.

- **Cursor advance**: after the answers are collected, run `shipyard-data cursor advance review retro_step_3 --note "Create IDEA action items"` and echo its output.

### Retro Step 3: Create Action Items (stage_id: retro_step_3)
For each actionable improvement, allocate an ID via `shipyard-data next-id ideas` (never `ls`-and-guess) and Write `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` with `source: retro/<sprint-id>` (slash form — matches the carry-over scan regex). Update `RETRO-DATA.md`: `step: action_items_created`.

- **Cursor advance**: run `shipyard-data cursor advance review retro_step_4 --note "Update metrics"`.

### Retro Step 4: Update Metrics (stage_id: retro_step_4)
Append velocity, carry-over rate, bug rate, estimate accuracy, anti-pattern flags to `<SHIPYARD_DATA>/memory/metrics.md` (quarterly rollover at 300 lines). Save key insights to memory.

- **Cursor advance**: run `shipyard-data cursor advance review release_step_1 --note "Present release plan, AskUserQuestion approval"`.

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

Print this as plain text and continue the retro — do not `AskUserQuestion`. Both a "report" and a "skip" answer land in the same place (the retro continues either way), so a blocking question here buys nothing; surfacing the report-it block above is the whole job.

---

## Release

After retro completes, generate the release record. This is a changelog + status tracker — Shipyard does not create git tags, push, or create GitHub releases. Full mechanics — release-plan output format, frontmatter writes, archive command, status dashboard — in `references/retro-and-release.md`.

### Release Step 1: Present Release Plan (stage_id: release_step_1)
Read all `status: done` features from this sprint. Output the release plan as text — CHANGELOG block, STATUS CHANGES, RETRO HIGHLIGHTS, FILES WRITTEN. Release is the most irreversible action in the workflow; surface everything before confirming.

Pause before asking (per the pause-before-ask rule): run `shipyard-data cursor pause review --note "awaiting user: release approval"` before the `AskUserQuestion`. This approval is load-bearing (most irreversible action) — never skip it. Then use `AskUserQuestion` for approval:
- **Release (Recommended)** — proceed to Release Step 2 (write everything)
- **Edit changelog** — adjust changelog text, then re-approve
- **Skip release** — skip release record, still archive sprint

On the user's answer, run `shipyard-data cursor resume review`, then advance:

- **Cursor advance**: on **Release** → run `shipyard-data cursor advance review release_step_2`. On **Skip release** → run `shipyard-data cursor advance review archive`. On **Edit changelog** → run `shipyard-data cursor advance review release_step_1 iteration=<N+1> --note "Re-present after changelog edit"` (self-tick). Echo the CLI output in each case.

### Release Step 2: Write Release Record (stage_id: release_step_2)
Update feature frontmatter (`status: released`, `released_at: [date]`) and prepend the new entry to `CHANGELOG.md` in the **project root** (not plugin data — this is a project deliverable that belongs in git).

- **Cursor advance**: run `shipyard-data cursor advance review release_step_3`.

### Release Step 3: Archive Sprint (stage_id: release_step_3)
Run `shipyard-data archive-sprint sprint-NNN` from Bash. This atomically renames `current/` → `sprint-NNN/` and recreates an empty `current/`. Do NOT synthesize raw `cp`/`mv`/`mkdir` against the plugin data dir — they're not portable and not atomic.

- **Cursor advance**: the archive operation rotates `current/` so the cursor file goes with it — that is by design, and the wrap-up below runs the terminal advance against the *absent* cursor. The CLI handles this seam first-class (v3.4.0): a terminal advance with no cursor runs the terminal-evidence gate against the (persistent) event log, emits the canonical `pipeline_terminal` event, and **writes no cursor** — it prints `cursor: (archived) → terminal …` plus the stop marker. Writing a terminal cursor into the freshly-recreated empty `current/` would plant a stale terminal cursor that no-ops the NEXT sprint and false-trips the leak alarm; the event, not a cursor file, is the terminal signal here.

### Final: Run Status
After archiving, run `/ship-status` to give the user a clean project health snapshot and auto-fix any state issues before the next cycle.

### Wrap Up (stage_id: terminal | archive)

The skip-release path (`stage: archive`) and the full-release path (after `release_step_3`) both converge here. Run the terminal protocol:

1. Print the sprint-complete banner (everything EXCEPT the stop marker — the marker is the CLI's job and must land last):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPRINT [NNN] COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Review: [N] features verified, [M] gaps patched
 Retro: [velocity] pts | [throughput] pts/hr | [N] improvements captured
 Release: changelog written to CHANGELOG.md (project root, appended)

▶ NEXT UP: Start the next cycle (a SEPARATE cycle you start yourself)
  /ship-discuss — explore new features
  /ship-sprint — plan next sprint (if backlog has approved features)
  (tip: /clear first for a fresh context window)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

2. Run `shipyard-data cursor advance review terminal outcome=success reason=cycle_complete --note "Pipeline complete — no further work."`. The CLI emits `pipeline_terminal outcome=success` and prints `▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.` Echo its output so that marker is the FINAL line of your response. (When `archive-sprint` already rotated `current/` away, the CLI's post-archive terminal seam applies: evidence gate over the event log, terminal event emitted, `cursor: (archived) → terminal …` printed, and NO cursor file written — deliberately, so no stale terminal cursor haunts the next sprint.)

The stop marker is load-bearing and **must be the final line** — `/loop` drivers read the LAST line as the structural continue-or-stop signal, so the NEXT-UP hint (printed in step 1) comes BEFORE it, never after (the v2.8.2 ordering fix; a `NEXT UP` line printed last reads as "keep going" to an over-eager driver). The CLI guarantees the marker is last as long as you echo its output after the banner and print nothing further. The terminal `advance` also prints a cron-cleanup reminder line when an armed `pipeline_loop_bootstrap_fallback` cron exists — act on it whenever printed: `CronList` + `CronDelete` any cron whose prompt targets `/shipyard:ship-review`.

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
