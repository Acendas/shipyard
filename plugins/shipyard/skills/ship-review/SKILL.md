---
name: ship-review
description: "Run multi-agent review, retrospective, and release."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, Agent, Skill, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, ScheduleWakeup, CronCreate, CronList, CronDelete]
model: opus
effort: medium
argument-hint: "[feature ID] [--demo] [--hotfix ID] [--retro-only] [--skip-retro] [--skip-code-review] [--single-tick]"
---

# Shipyard: Review & Verification

Verify completed work against spec. Auto-test, screenshot, demo to user, get approval.

## Context

!`shipyard-context review-context`

**Onboarding gate.** If the bundled context contains `SHIPYARD_ONBOARDING_REQUIRED=true`, run the exact `SHIPYARD_ONBOARDING_COMMAND` once with Bash, report the CLI output to the user, and STOP. Do not infer setup state by reading or writing Shipyard state files; onboarding decisions are CLI-owned.

**Paths.** All Shipyard file ops use the absolute SHIPYARD_DATA prefix from the context block (no `~`, `$HOME`, or shell variables). Bash is for project tests, git, and the `shipyard-data` CLI (cursor/sprint mutations + `archive-sprint`). **Never `cd` into the data directory before running `shipyard-data` commands** — they resolve the data directory internally via git and env vars; `cd`-ing into a non-git directory breaks the resolver. **Never use `echo`, `printf`, or shell redirects (`>`) to write state files.**

**The pipeline cursor, PROGRESS.md, and HANDOFF.md are CLI-owned — the model never writes them.** A PreToolUse hook DENIES any Write/Edit targeting `REVIEW-CURSOR.md`, `PROGRESS.md`, or `HANDOFF.md`. The only writer is the `shipyard-data cursor` CLI, which validates the stage transition against the stage graph, runs the terminal-evidence gate + loop-leak guard in-process (exit 3 with reasons on failure), appends the pipeline event atomically with the cursor write, re-renders PROGRESS.md, and prints the tick/terminal marker lines itself (stop marker guaranteed LAST). So: advance a tick with `shipyard-data cursor advance review <stage> [k=v ...] [--note "<narrative>"]`; do NOT emit `pipeline_tick_completed`/`pipeline_terminal` yourself and do NOT print your own `▶ TICK COMPLETE`/`▶ CYCLE COMPLETE` markers — echo the CLI's output as the final lines of the tick. SPRINT.md frontmatter is mutated via `shipyard-data sprint set <key> <value>` (never a model Edit). Verdict files (`verify/<F>-verdict.md`) and other narrative artifacts stay model Writes. Use the Write tool (auto-approved for SHIPYARD_DATA) for those. When passing paths into spawned Agent prompts, substitute the literal SHIPYARD_DATA path.

**Render before asking.** Before every AskUserQuestion, render the decision context — the scenarios, concrete examples, tradeoffs, and any verbatim content being approved — as chat text; the tool call then carries only the short question and option labels. A bare AskUserQuestion with no rendered context above it is a bug (the window is too small to carry a real decision). Content that exists only in a Read result, a subagent/Agent return, a dossier file, or the question/option strings themselves **does not count as rendered** (the UI shows a compact card) — restate it as assistant chat text immediately above the ask.

**Auto-fix before asking.** `/ship-review` is expected to repair review findings, not ask the user whether routine findings should be fixed. For must-fix code-review findings, spec gaps, quality-gate probe failures, user-flow FAILs, simple in-scope gaps, and critic-confirmed blind spots: dispatch the appropriate fixer (`dispatching-task-loop` or `dispatching-operational-task`) and re-check. AskUserQuestion only for load-bearing approval gates or genuinely severe/risky cases: destructive migration, irreversible data change, credential/security-policy choice, large dependency/platform change, ambiguous product/spec decision, accepting a known defect, BLOCKED tool/agent state, or hard-ceiling escalation. If the fix is merely tedious, expensive, or spans multiple files, create/dispatch patch work; do not ask for permission just because findings exist.

**Quiet by default.** Between user-input gates, work quietly — run scanners, tests, and gap analysis without narrating each stage. Only three things reach the chat outside a gate: a one-line transition marker per stage, the compact per-stage status lines, and a one-line banner when launching or receiving a background dispatch (code-review loop, gap-analysis agent, critic). The self-looping stages (code-review loop, gap-analysis / self-review) run silently to convergence — surface only a one-line result, never a per-iteration narration or a re-printed checklist. Review results, verdicts, and gate summaries are rendered in full ONLY at a gate (render-before-ask — Stage 5 demo, retro, release) or a terminal summary. **No running commentary** ("Now I'll…", "Let me…", explaining a no-input step). Full doctrine: `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md` § "Interim Communication: Quiet by Default".

**Capability-skill playbooks.** Where a step says *"follow the `X` playbook"* or "dispatch `X`", X is a capability skill — **Read** `${CLAUDE_PLUGIN_ROOT}/skills/<X>/SKILL.md` and execute it inline; never hand it to the `Skill` tool (capability skills are `disable-model-invocation: true`, so `Skill` refuses them). The only skill loaded via the `Skill` tool is `loop`. Substantial analysis/labor dispatches use registered Shipyard agents through their wrapper skills; `general-purpose` is allowed only for tiny one-shot prompts with an explicit local justification.

## Input

$ARGUMENTS

## Detect Mode

- Feature ID (F001) → Review specific feature
- `--demo` → Include interactive demo (open browser, fill forms)
- `--hotfix B-HOT-001` → Fast-track hotfix review
- `--retro-only` → Skip review, run only the retrospective (for cancelled sprints or re-running retro)
- `--skip-retro` → After approval, skip the retrospective and go directly to release planning/archive. This is explicit user intent, not a default shortcut.
- No args → Review all completed tasks in current sprint, then run retrospective
- No active sprint and no feature ID (sprint already archived: `current/` directory is empty or absent of `SPRINT.md`) → **No-op terminal path.** Run `shipyard-data cursor noop review sprint=<last-known-or-unknown> reason=sprint_already_archived` and echo its output (it emits `pipeline_terminal outcome=noop`, runs repeat-leak detection, and prints the stop marker as the final line). Exit cleanly without invoking AskUserQuestion. (This is the exact path that fired the original /loop bug — there was no terminal signal so /loop kept scheduling wakeups against an archived sprint.)

---

## Cursor + Per-Tick Advance

`/ship-review` is a multi-stage pipeline. To make it `/loop`-friendly, each invocation uses cursor state from the bundled `shipyard-context review-context` block (`SHIPYARD_CURSOR_*` fields), dispatches to the matching stage handler, then advances the cursor for the next tick via the CLI. Full cursor schema, stage map, terminal protocol, event vocabulary, and stuck-detection rules live in `references/pipeline-cursor.md` — read it before changing the cursor surface.

**Cursor read at entry.** Begin every invocation with:

1. Use the `SHIPYARD_CURSOR_*` fields from `shipyard-context review-context`; do not Read or parse `REVIEW-CURSOR.md` directly. If cursor state must be refreshed mid-invocation, run `shipyard-context cursor-state review`.
   - **`SHIPYARD_CURSOR_PRESENT=true` and `SHIPYARD_CURSOR_TERMINAL=true`**: run `shipyard-data cursor noop review sprint=<id> reason=cursor_already_terminal`, echo its output, exit.
   - **`SHIPYARD_CURSOR_PRESENT=true` and `SHIPYARD_CURSOR_STATUS=paused`** (a pause-before-ask stage is awaiting a user answer): **paused is wakeup-inert.** A `/loop` wakeup must NEVER resume it — a wakeup can't answer the pending question. Run `shipyard-data cursor noop review sprint=<id>`, echo its output (it emits `pipeline_terminal outcome=noop reason=awaiting_user_paused`, prints the pause note + resume hint + stop marker; a 2nd wakeup against the same paused sprint trips the ⛔ leak alarm pointing at `cursor resume`), and STOP. Only when the user is explicitly re-engaging this invocation (they answered the pending question, or asked to continue) run `shipyard-data cursor resume review` and dispatch to `SHIPYARD_CURSOR_STAGE`.
   - **`SHIPYARD_CURSOR_PRESENT=true` and `SHIPYARD_CURSOR_TERMINAL=false`** (and not paused): dispatch to the handler for `SHIPYARD_CURSOR_STAGE` (per the stage map in `references/pipeline-cursor.md`). (`pipeline_tick_started`/`pipeline_tick_completed` are CLI-emitted on every advance — no manual event emits.)
   - **`SHIPYARD_CURSOR_PRESENT=false`**: fresh start. Dispatch to the preflight handler; the handler's `cursor advance` call materializes the cursor (and emits the tick events).

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

**Pause before every blocking ask (load-bearing rule): a tick never exits with a pending question and no stop marker.** At every stage that blocks on `AskUserQuestion` for user input — `demo_user` (Stage 5 approval), `retro_decision` (run/skip retro), `retro_step_2` (retro discussion), `release_step_1` (release plan) — run `shipyard-data cursor pause review --note "awaiting user: <what>"` **before** invoking `AskUserQuestion`. The pause writes `status: paused` and prints the stop marker, so if the tick is torn down (context loss, or the `/loop` driver treating the ask as end-of-tick) the persisted state is `paused` and the next wakeup no-ops instead of re-running the stage and re-asking the same question every wakeup. On the user's answer, run `shipyard-data cursor resume review`, then proceed with the stage handler. The Stage 4.8 FAIL path already does exactly this (Stage 4.8) — it's the pattern to mirror. (pause keeps the current stage; resume returns to it — no stage-graph change is involved.)

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
- If `stuck_counter >= 5` (5 ticks without state change): for `code_review_iter_N` (the fixer has stalled with an unchanged must-fix set), FIRST follow the `escalating-to-thinker` playbook (trigger: `repeated_fix_failure`, subject: `code_review_iter`) — a think-tier consult may diagnose why the fixer isn't converging and recommend a normal-path unstick. Then, whether or not the consult ran (it may be capped), emit `shipyard-data events emit pipeline_stuck pipeline=ship-review sprint=<id> stage=<id> iterations=<N> reason=no-state-change` AND surface a non-blocking one-line warning in the user-facing text: `⚠ Stage [X] has run [N] times without state change. /ship-status to inspect; consider manual intervention.` The loop keeps running — the warning is informational.
- `hard_ceiling: 50` is the absolute safety stop. If a self-loop stage reaches `iteration: 50`, run `shipyard-data cursor escalate review reason=hard_ceiling_stage_<id>` (terminal escalation from the current stage — sets `status: escalated`, `terminal: true`, emits `pipeline_terminal outcome=escalated`, prints the stop marker), echo its output, and halt. In practice the 5-tick warning surfaces intervention long before the ceiling is reached; the ceiling exists only as a backstop against a runaway loop with broken state-change detection.

---

### Compaction Recovery

If you lose context mid-review (e.g., after auto-compaction):

0. **Call `TaskList()` first.** If `[review-NNN] <stage>` tasks exist from the stage checklist (below), the last non-`completed` task names a candidate resume stage — a structured position anchor. **Confirm against the cursor before acting on it** (step 1) — the tasks are a mirror, not authority; if tasks and cursor disagree, the cursor wins.
1. **Cursor is authoritative.** Use the `SHIPYARD_CURSOR_*` fields from the entry context or refresh with `shipyard-context cursor-state review`. `SHIPYARD_CURSOR_STAGE` tells you exactly where to resume; verdict files are the secondary cross-check. PROGRESS.md is a rendered artifact (auto-regenerated from the event log on every cursor write) — never reconcile against it as if it were authoritative state, and never Write or Edit it.
2. Use Glob `<SHIPYARD_DATA>/verify/*-verdict.md` to find existing verdict files — these features are already reviewed
3. Read SPRINT.md — get the list of features to review
4. Skip features with verdict files where `complete: true`. If a verdict has `complete: false`, that review was interrupted — re-run the pipeline for that feature
5. **Staleness check**: read the feature spec file to find its `tasks:` list, then read each task file's Technical Notes for source file paths. If the most recent commit touching those source/test files (`git log -1 --format=%ci -- [paths]`) is newer than the verdict's `reviewed_at`, re-run the review — code has changed since the verdict was written
6. Resume the review pipeline from the cursor's `stage:` and the first feature without a valid verdict
7. For sprint-level review: aggregate results from verdict files when presenting the summary

Do not re-run the full test suite for features that already have valid (complete + fresh) verdict files.

---

## Review Pipeline

### Stage Task Checklist (created at preflight)

On a fresh start (preflight, no existing cursor), `TaskCreate` one task per stage this invocation's mode will actually run — a high-level, per-STAGE mirror of pipeline progress, not a per-finding/per-criterion/per-gate list (those live in CODE-REVIEW.md, QUALITY-GATE.md, the review cursor, and the event log — the hardened, authoritative state). Subject prefix **`[review-NNN] <stage>`** (NNN = sprint id) — distinct from `/ship-execute`'s `[sprint-NNN] Wave K`, `/ship-sprint`'s `[sprint-plan] Step N`, and track-mode build tasks. Create all of them in one batch.

Self-looping stages (`code_review_iter_N`, `gap_analysis`) get **ONE** task each ("Stage 0: Code Review", "Stage 4: Gap Analysis") — never one task per iteration; iteration churn belongs in the event log, not the task list.

Pick the stage set by mode:

| Mode | Stage tasks created |
|---|---|
| Default (full review, no flags) | preflight, Stage 0: Code Review (code_review_iter_N), Stage 0.5: Simplify (simplify), Stage 1a: Tests (tests), Stage 1b: Spec Review (spec_review), Stage 1.5: Quality Gates (quality_gates), Stage 2: Visual (visual), Stage 3: Goal Verify (goal_verify), Stage 4: Gap Analysis (gap_analysis), Stage 4.6: Critic (critic), Stage 4.7: Final Pass (final_pass), Stage 4.8: User-Flow Verification (demo_probe), Stage 5: Demo & Approval (demo_user), Retro Decision (retro_decision), optional Retro Step 1-4 (retro_step_1..4), Release Step 1-3 (release_step_1..3), Wrap Up (terminal) |
| `--skip-code-review` | same as default minus Stage 0 (code_review_iter_N) and Stage 0.5 (simplify) — jumps preflight → tests |
| `--skip-retro` | same as default minus Retro Decision and Retro Step 1-4 — after approved Stage 6, jumps directly to Release Step 1 |
| `--retro-only` | Retro Step 1-4, Release Step 1-3, Wrap Up only (no review stages) |
| `--hotfix ID` | single task `[review-NNN] Hotfix Review` — the hotfix path doesn't tick through the cursor's per-stage graph |

`TaskUpdate` a stage task → `in_progress` when that stage's handler starts; → `completed` **only when the cursor actually advances past it** (i.e., the `shipyard-data cursor advance review <next_stage>` call for that transition succeeds) — never on a subagent/agent return's claim that the stage is done. A stage that pauses (`demo_user`, `retro_step_2`, `release_step_1` — any stage that runs `cursor pause` before an `AskUserQuestion`) or escalates: leave its task `in_progress` (visible, mid-flight) rather than marking it completed. A stage this mode's table above doesn't include (e.g. Stage 0 under `--skip-code-review`) is marked `completed` with `skipped: <reason>` in the description at creation time — never deleted silently.

**Guardrail (load-bearing): the stage task list is a progress surface and a recovery anchor, NEVER authority.** Do not gate any behavior on TaskList state, do not cite task status as evidence a stage ran, and never mark a stage task completed before the cursor advances past it. The review cursor, CODE-REVIEW.md/QUALITY-GATE.md, and the event log remain the record; the tasks are the user-visible mirror.

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

Run the multi-agent code review on the sprint's diff before tests and spec compliance — a fresh-context code-review subagent scans seven concern domains (security, bugs, silent-failures, patterns, tests, observability, data; orchestration logic in `references/code-review-orchestration.md`, optional parallel-split for high-stakes diffs), then the `dispatching-task-loop` fixer addresses must-fix and should-fix items.

**Goal-mode default — run until scanners come back clean.** This loop is /goal-shaped: keep dispatching the fixer against the residual findings without user interruption. Loop until the scanners report zero must-fix items. There is no arbitrary iteration cap — convergence is data-driven. Do NOT pause mid-loop to ask the user whether to keep going — that pre-empts the convergence signal. Emit a structured `code_review_iteration` event per pass via `shipyard-data events emit code_review_iteration sprint=<id> iteration=<N> must_fix=<count> should_fix=<count>` so the user (and `/ship-status`) can see the loop's trajectory without a prompt.

**Stuck detection (replaces the prior hard iteration limit):** `pipeline_stuck` warns when `stuck_counter >= 5` (5 consecutive ticks with no change in the (must_fix, should_fix) tuple) — non-blocking, the loop keeps running. The absolute safety stop is `hard_ceiling: 50` iterations; in practice the 5-tick stuck warning surfaces intervention much sooner. See the "Self-looping stages" section above for the full protocol.

**Severe/risky exception.** A scanner finding can interrupt the auto-fix loop only when fixing it would require a decision outside the code-review remit: destructive migration, irreversible data rewrite, credential/security-policy choice, large dependency/platform change, ambiguous product/spec tradeoff, or knowingly shipping a degraded behavior. Render that decision context as chat text, then ask once. Ordinary must-fix findings stay in the loop.

**At hard ceiling only** (`iteration == 50`): emit `shipyard-data events emit code_review_escalated sprint=<id> must_fix_remaining=<count> should_fix_remaining=<count>`, write `B-CR-*` bugs for the residual findings, run `shipyard-data cursor escalate review reason=hard_ceiling_stage_code_review_iter` (sets `status: escalated`, `terminal: true`, prints the stop marker), render the residual must-fix findings (title + file:line each, from CODE-REVIEW.md — file content does not count as shown until printed) as chat text, then surface ONCE via AskUserQuestion: *"Code review hit its hard ceiling of 50 iterations with [N] must-fix items remaining. (a) write B-CR bugs and proceed to demo, (b) hand back without demo so I can investigate manually."* Recommended: (a). Out-of-scope scanner findings become IDEAs (see Stage 4 protocol). Full mechanics — checkpoint tags, fixer parameters, event-log trajectory, scope guard — in `references/scanner-dispatch.md`.

- **Cursor advance**: on iteration completing with `must_fix > 0`: dispatch the fixer, then run `shipyard-data cursor advance review code_review_iter_<N+1> iteration=<N+1> stuck_counter=<n> --note "Re-scan after fixer iteration <N+1>"` (pass `stuck_counter=0` only when the (must_fix, should_fix) tuple changed — otherwise the CLI auto-increments). Do not ask merely because findings remain. On iteration completing with `must_fix == 0 && should_fix == 0`: run `shipyard-data cursor advance review simplify`. On hard ceiling (`iteration == 50`) or severe/risky exception only: `shipyard-data cursor escalate review reason=hard_ceiling_stage_code_review_iter` or pause-before-ask with the rendered decision context (see the hard-ceiling bullet above).

### Stage 0.5: Code Simplification (stage_id: simplify)

Skip if `--skip-code-review` is passed (same gate as Stage 0).

After Stage 0 exits clean, spawn a general-purpose simplifier subagent (inline prompt — no external-plugin dependency) against the sprint diff to clean up quick patches the fixer may have introduced. **Model tier (build)** — pass `model: <models.build>` from config if non-empty, else OMIT `model:` (inherit session model); never hardcode a literal. Scope-guarded to sprint-diff files only — reverts via `git reset --hard HEAD~1` if the simplifier touches unexpected files. Mechanics (including the model rule) in `references/scanner-dispatch.md`.

- **Cursor advance**: on completion (success or logged-and-continue), run `shipyard-data cursor advance review tests --note "Run Stage 1a full test suite via dispatching-operational-task"`.

### Stage 1: Run Tests & Spec Verification (stage_id: tests, then spec_review)

**1a. Run all tests — check-first against the verification ledger.** `/ship-execute` already ran these exact tiers against this exact commit before handing off to review (measured cost of blindly re-running them: 7m 9s on one customer project). For each tier configured in `<SHIPYARD_DATA>/config.md` (`test_commands.unit`, `test_commands.integration`, `test_commands.e2e`), resolve the literal command string first, then run `shipyard-data verify check --key test_commands.<tier> --command "<resolved command>"` BEFORE dispatching anything:

- **Exit 0 (FRESH)** — a clean pass for this exact command is already recorded against the current working tree (same `git rev-parse HEAD^{tree}`, recorded with a clean porcelain status, within TTL, capture file intact). Skip dispatching this tier entirely — reuse the recorded exit code + capture path as this tier's verdict for Stages 3–5.
- **Exit 3 (STALE)** — no fresh proof exists (never recorded, tree changed, TTL expired, capture missing, or any other unevaluable condition — the ledger fails safe to STALE, never to a skip). Run it exactly as before: follow the **`dispatching-operational-task` playbook**; the capability skill captures output to `<SHIPYARD_DATA>/captures/` and returns the structured verdict (PASS/FAIL counts in `LAST_LINES:`). On the tier passing (exit 0), run `shipyard-data verify record --key test_commands.<tier> --command "<same resolved command>" --exit 0 --capture <capture path>` so a later check (a subsequent tick, or the release-approval gate) can reuse it.

One operational dispatch per stale tier, or one combined dispatch if your project supports a single command (check/record that combined command under one key, e.g. `test_commands.all`, instead of per-tier).

**This is never a blanket skip.** Stage 0 (code-review fixer) and Stage 0.5 (simplifier) run before Stage 1a and both commit whenever they find something to fix — so on any review that found something, the working tree has changed since `/ship-execute` recorded its tiers, and `verify check` correctly reports STALE (the recorded tree-id no longer matches `HEAD^{tree}`) — that re-run is intended behavior, not a bug to work around. On a clean review (nothing for Stage 0/0.5 to fix), the tree is unchanged and every tier reports FRESH.

**Render the decision as chat text** — a skip the user can't see is indistinguishable from a stage that silently didn't run. One line per tier, naming which were skipped (with the evidence: tree-id prefix + when recorded) and which ran (with why: dirty tree since fixer commit, no prior record, TTL expired, etc.):

```
→ Stage 1a: unit SKIPPED (fresh — tree a3f9c21…, recorded 4m ago)
→ Stage 1a: integration SKIPPED (fresh — tree a3f9c21…, recorded 4m ago)
→ Stage 1a: e2e RAN (stale — working tree changed since recording) → PASS
```

Use the returned or reused verdicts for Stages 3–5 either way — do not run a tier a second time in this invocation.

- **Cursor advance (after 1a)**: run `shipyard-data cursor advance review spec_review --note "Run Stage 1b spec review per feature"`.

**1b. Spec review via specialized scanner** — follow the **`dispatching-spec-review` playbook** with `scope: "feature"` and `target_ids: [FEATURE_ID]`. The capability skill:

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

Read `<SHIPYARD_DATA>/sprints/current/QUALITY-GATE.md`. For each probe/tool gate, dispatch via `dispatching-operational-task`. Collect manual gates into a checklist for Stage 5. Write results back to QUALITY-GATE.md. If >50% of gates fail, render the per-gate results (gate, verification type, pass/fail) as chat text, then AskUserQuestion: continue or abort.

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

**Dispatch the analytical body via `dispatching-gap-analysis` (per gap_analysis tick).** The surface-gap detection below AND the Stage 4.5 10-check self-review are reasoning-heavy read-only analysis — follow the `dispatching-gap-analysis` playbook so this substantial prompt goes through the registered `shipyard-gap-analyst` agent, not a hand-rolled generic subagent. The reviewer shell keeps everything with a side effect: the cursor advance, the `stuck_counter` computation, the gap→persistence-target actions (patch task / debug session / IDEA file / inline-fix dispatch in the classification tree below), and all user-facing surfacing. The agent only analyzes and returns.

Pass to the capability skill: the sprint's feature and task file paths (under `<SHIPYARD_DATA>/spec/`), the verdict-relevant evidence paths gathered so far (Stage 1 test-output captures, Stage 1b spec-review findings, Stage 3 goal-verification results as recorded), the literal SHIPYARD_DATA path, `base_ref`, `head_ref`, `scope`, and target feature IDs. The playbook handles the think-tier model rule, read-only contract, silent-return re-dispatch, and structured `STATUS: CLEAN|GAPS|BLOCKED` parsing.

The shell then acts on the returned gap list using the classification tree below (Stage 4) and drives the Stage 4.5 loop: it computes `stuck_counter` (set-equal on the gap list), advances the cursor, and re-dispatches `dispatching-gap-analysis` on the next `gap_analysis` tick when the gap list is still changing. If the dispatch returns BLOCKED twice or violates read-only, surface that BLOCKED state; do not invent an inline generic-agent fallback.

Additionally detect:
- **Untested scenarios** — acceptance scenarios without end-to-end tests
- **Missing edge cases** — empty states, error states, loading states
- **Accessibility gaps** — missing screen reader labels, keyboard navigation, contrast
- **Security concerns** — hardcoded values, missing input validation
- **Anti-patterns** — TODO comments, console.log left in, empty catch blocks

For each gap, classify into one of four destinations — this is a decision tree, not a menu, and the classification determines which persistence target the gap lands in:

- **Existing-code one-line / template defect** (v2.6.0) → **inline-fix** via `dispatching-task-loop` with a synthetic patch task. Mirrors Stage 0's auto-fix pattern. Boundary criteria: fix is ≤5 lines of diff, touches files already on the working branch, needs no new dependencies/modules/test scaffolding, and the regression test either exists or can be written in ≤30 lines. Concrete shape: a missing prop on an existing component, a faulty `cloneElement` in an existing template, a forgotten `await`, a missing null guard with an existing test that already exercises the path. After the synthetic task lands its commit, re-enter Stage 4 once (`gap_analysis_iter_<N+1>`) on the patched diff — the gap should no longer appear. If the boundary check is uncertain or the inline fix introduces a new gap, fall through to the **patch task** classification below; the asymmetric cost (missed inline-fix is one extra task dispatch, wrong inline-fix is a bad commit landing without user approval) biases toward safety. Emit `patch_task_created task_id=<id> feature=<F> source=review-inline-fix` for traceability.
- **Simple and in-scope, new functionality** (missing test for this feature, missing endpoint, missing widget, TODO left in this feature's files, missing validation on this feature's inputs) → **patch task + auto-dispatch**. Use the existing patch-task creation flow, then immediately follow `dispatching-task-loop` for that patch task in the same review cycle. After the task lands, re-enter `gap_analysis` on the patched diff. Do not defer to Stage 5's `Fix first` branch unless the patch task returns BLOCKED, hits a severe/risky exception, or cannot be verified.
- **Complex and in-scope** (feature doesn't work but tests pass, wiring broken within this feature, behavior contradicts this feature's spec) → **debug/patch task + auto-dispatch when bounded**. Use the Write tool to create `<SHIPYARD_DATA>/debug/[feature-id]-[gap].md` with the symptoms and evidence from the review, then create and dispatch a patch task when the acceptance probe can be stated. Ask only when the gap requires a product/spec decision or an unsafe migration rather than implementation.
- **Out-of-scope** (real defect or smell that isn't in the feature being reviewed — e.g., while reviewing the payments feature, the scanner flagged a race condition in the auth middleware) → **IDEA file**. Capture the observation as an idea so it doesn't vanish, without polluting the current feature's review. See "Capture Out-of-Scope Gaps as IDEAs" below.

**Capture Out-of-Scope Gaps as IDEAs.** Out-of-scope gaps are real defects but don't belong in the current feature's patch-task list or debug session. Allocate an ID via `shipyard-data next-id ideas` (never `ls`-and-guess), then Write `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` with `source: review-gap/<sprint-id>`, `found_during: surface-gap-stage-4` (or `code-review-stage-0`), and `feature_reviewed: <feature-id>`. **Hard cap: 5 per stage** (Stage 0 and Stage 4 budgets are independent); on overflow, write one `overflow: true` summary IDEA. **Hard rule — out-of-scope only:** in-scope must-fix → `B-CR-*` bugs, in-scope complex → debug session, in-scope simple → patch task. Full IDEA frontmatter schema, capture-vs-skip criteria, and frontmatter template in `references/scanner-dispatch.md`.

### Stage 4.5: Quality Gate (stage_id: gap_analysis, part 2) (self-review loop)

**The 10-check evaluation itself runs inside the Stage 4 gap-analysis agent** (dispatched above) — the agent applies this table to its findings and returns the per-check results alongside the gap list. The **shell** owns the loop control: it reads the returned results, updates the gap list, computes `stuck_counter`, advances the cursor, and decides whether to re-dispatch (gap list still changing) or proceed to `stage: critic` (gap list stable). On dispatch failure, surface the wrapper's BLOCKED outcome rather than evaluating the table in a hand-rolled generic subagent.

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

Iterate the checklist against your findings. If any check reveals a missed gap, add it to the gap list and re-run. **There is no arbitrary iteration cap** — loop until the checklist stabilizes (no new gaps added in a pass). Stuck detection: `pipeline_stuck` warns when `stuck_counter >= 5` (5 ticks with the same gap-list set), non-blocking, the loop keeps running. Hard ceiling: `hard_ceiling: 50` is the absolute safety stop — in practice the 5-tick warning surfaces intervention much sooner. See the "Self-looping stages" section near the top for the protocol. **Run this loop quietly (quiet-by-default § self-looping stages) — do NOT narrate each pass or re-print the table. Surface at most a one-line result** (`→ Gap analysis: N gaps, converged`); the gaps ride into the verdict file and the Stage 5 summary. Proceed to verdict (`stage: critic`) when the checklist stabilizes.

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

**Critic deadlock.** If the critic's verdicts contradict the review's conclusions (e.g., the critic insists a ✅ is broken while direct verification says it holds, or vice versa) and a single reconciliation pass over the disputed items does NOT resolve which is right, follow the `escalating-to-thinker` playbook (trigger: `critic_deadlock`, subject: the feature ID / disputed finding) before recording a verdict — a think-tier consult breaks the tie with a fresh reading. Only if it declines (cap reached), returns low confidence, or its recommendation also fails do you surface the contradiction to the user — render each disputed finding as chat text first (the review's claim, the critic's counter-claim, and the direct-verification evidence; critic/agent returns do not count as shown until printed) — via AskUserQuestion. Do not silently pick a side.

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

- **Cursor advance**: run `shipyard-data cursor advance review demo_probe --note "Run Stage 4.8 user-flow verification per feature"`.

### Stage 4.8: User-Flow Verification (stage_id: demo_probe)

**v2.6.0 sequencing change.** `/ship-execute` now runs the user-flow probes at its `sprint_demo_probes` stage (Step 5 item 3), before flipping SPRINT.md to `status: completed`. By the time `/ship-review` reaches this stage, they have usually already passed. This stage's job is to **re-verify on freshly-checked-out HEAD** as a sanity check (defends against "passed during execute, broken at merge" race conditions), with a skip-if-already-passed preflight to keep review fast on the happy path.

(The stage id and ledger key stay `demo_probe` / `demo_probe.<FID>` — they are internal identifiers in the stage graph and the verify ledger, and renaming them would strand any in-flight cursor and invalidate every recorded entry. The user-facing field is `user_flow_probe:`.)

**Preflight — ledger predicate, not event-window (fixes 5.2).** The old preflight scanned the event log for `acceptance_probe_completed feature=<F> probe_type=demo exit_code=0` "within the sprint window" — no sha, no tree, no timestamp-vs-HEAD comparison. That was unsound: Stage 0 (code-review fixer) and Stage 0.5 (simplifier) commit BEFORE this stage runs, so a probe that passed in `/ship-execute` could be skipped here even though the fixer has since rewritten the code it exercised — exactly the "passed during execute, broken at merge" gap this stage exists to catch.

For each feature in scope, resolve its `user_flow_probe:` and run `shipyard-data verify check --key demo_probe.<FID> --command "<probe.command, or the skip/manual marker>"`:

- **Exit 0 (FRESH)** — the probe already passed against this exact working tree, clean, recently (recorded by `/ship-execute`'s `sprint_demo_probes` stage, or by an earlier Stage 4.8 tick in this same review). Skip re-running it for this feature.
- **Exit 3 (STALE)** — tree changed since the last pass (e.g. Stage 0/0.5 committed a fix touching this feature), or it never ran, or the record expired/is missing. Run the full sequence below for this feature.

Render the per-feature skip/run decision as chat text (same form as Stage 1a — a skip the user can't see is indistinguishable from a stage that silently didn't run). If every feature in scope comes back FRESH, emit `stage_4_8_skipped reason=already_passed_in_execute` and advance straight to `stage: demo_user` — still fast on the genuine happy path, now for a sound reason instead of an event-presence guess. Otherwise, run the full sequence below only for the features that came back STALE.

For each feature whose probe wasn't already verified:

1. Read the feature's frontmatter `user_flow_probe:` (legacy scalar `demo_probe:` reads as `kind: auto`).
2. **If it is missing**: this is a planning-gate escape, not a decision for this stage — `/ship-sprint` refuses to plan a feature without one and `/ship-execute` Step 0 re-checks it. Refuse to advance to Stage 5, name the feature, and point at `/ship-discuss [F-NNN]` to author one. Do not offer to skip: a probe authored after the work shipped is a rubber stamp.
3. **If `user_flow_probe: skip-with-reason`** with a `user_flow_probe_skip_reason` populated: include the reason in the per-feature summary (Stage 5) as a known limitation — this means no proof of any kind exists. Allow approval to proceed.
4. **`kind: auto`**: follow the **`running-acceptance-probe` playbook** with `probe_command: <probe.command>`, `cwd: <repo root>`, `timeout_seconds: 120`. The capability skill runs the probe in a fresh shell and returns the structured verdict.
5. **`kind: assisted` / `manual`**: a human already confirmed this during execute. Check for `user_flow_probe_confirmed feature=<F> verdict=pass` whose `commit` is an ancestor of HEAD (`git merge-base --is-ancestor`). **Ancestor → PASS, carried forward into the Stage 5 summary with the confirmer and commit; do not re-ask.** Re-asking a person to re-walk a flow they already confirmed against unchanged code is the interrupt this stage must not add. **Not an ancestor** (Stage 0/0.5 rewrote the code since) → render `probe.steps` verbatim as chat text, `shipyard-data cursor pause review --note "user_flow_probe re-confirmation for <F>"`, then ask for a fresh verdict and record it via `shipyard-data feature record-proof <F> verdict=… confirmed-by=… commit=<HEAD>`.
6. For `auto`, emit `acceptance_probe_completed feature=<F> probe_type=demo exit_code=<n>` to the event log via `shipyard-data events emit ...` and include the verdict in the Stage 5 per-feature summary (PROGRESS.md auto-renders the verdict from the event):
   - **PASS** → ✅ User flow verified (last 5 lines of output captured below); run `shipyard-data verify record --key demo_probe.<FID> --command "<probe.command>" --exit 0 --capture <capture path>` so a later tick, or a resumed review, reuses this proof instead of re-running the probe.
   - **FAIL** → ❌ User flow failed; the probe doesn't exit 0 against the merged feature
   - **TIMEOUT** → ⚠ Demo exceeded 120s; probe is too broad — split or narrow it
   - **ERROR** → ⚠ Demo couldn't run; probe definition is wrong (likely missing dependency or misconfigured command)

**Approval gate.** A feature with a FAIL or TIMEOUT verdict cannot be approved. The reviewer must first re-dispatch task-loops to fix the cross-task wiring, then re-run this stage. Only flag the feature as `needs-attention` or ask the user when the fix is blocked, severe/risky, or requires a product/spec decision. ERROR verdicts are different: render the probe command and its error output (from the probe return — not shown until printed) as chat text, then route through AskUserQuestion only when the probe definition itself needs user/product clarification; otherwise create and dispatch a probe-fix patch task.

This is the per-feature counterpart to per-task acceptance probes. Together they form the reliability ladder:

```
per-task acceptance_probe    →  unit-level wiring proof (dispatching-task-loop gate)
per-feature user_flow_probe  →  cross-task proof it works FOR A USER (this stage)
sprint-level full test suite →  regression / integration proof (Stage 1)
```

Mid-tier failures (passing tasks, failing demo) are exactly the bug class the customer-reported "review rubber-stamps stubs" complaint described — the task tests passed against properly wired code, but the cross-task user flow was broken because nobody ever ran it end-to-end.

- **Cursor advance**: on all probes PASS (or skip-with-reason): run `shipyard-data cursor advance review demo_user --note "Present results, AskUserQuestion approval"` and echo its output. On any FAIL/TIMEOUT: create/dispatch the appropriate patch task or task-loop fix, then self-loop/re-enter `demo_probe`; do not ask just because the probe failed. On BLOCKED, severe/risky, or user/product-decision cases only, run `shipyard-data cursor pause review --note "Awaiting user decision on demo failure"` (keeps `stage: demo_probe`, sets `status: paused`) before invoking AskUserQuestion.

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
- **Manual verification checklist** — render the full manual-gate checklist (each gate's description and what to verify) as chat text first — question/option strings render as a compact card and do not count as showing the gates; then batch ALL manual gates into a **single** `AskUserQuestion` call (each gate is one question: "[Gate description]. Verified? — yes / no / not applicable"), up to 4 questions per call; paginate into a second call only on overflow (>4 gates). Do NOT drip one gate per call. If there are few gates, fold them in as extra questions of the approval call below rather than making a separate call. Review cannot auto-approve if manual gates remain unverified.

**Recommended action** per feature:
- ✅ Approve — all checks passed
- ⚠️ Issues — only unresolved non-blocking gaps remain after auto-fix attempts
- ❌ Needs changes — severe/risky, blocked, or product-decision gaps remain after auto-fix attempts

**Pause before the approval ask** (per the pause-before-ask rule above): run `shipyard-data cursor pause review --note "awaiting user: sprint approval decision"` before invoking `AskUserQuestion`. Then use `AskUserQuestion` for approval (this approval is load-bearing — NEVER skip user approval; batch the manual-gate questions above into this same call when there are few of them):
- **Approve (Recommended)** — update feature statuses to `done`, proceed to Sprint Retrospective
- **Refine** — give feedback on specific features, iterate
- **Fix first** — only for findings that auto-fix could not safely resolve; create patch tasks, show: "/ship-execute --task [patch task ID]"

On the user's answer, run `shipyard-data cursor resume review`, then advance:

- **Cursor advance**: after the user answers, run `shipyard-data cursor advance review process_approved` (or `... process_issues` / `... process_changes` per the answer) with `--note "Process Stage 6 decision branch"` and echo its output.

### Stage 6: Process Decision (stage_id: process_approved | process_issues | process_changes)

Based on the approval:
- **Approved** → `shipyard-data feature set-status <FID> done`. Proceed to Retro Decision (below), unless `--skip-retro` was passed; then proceed directly to Release Step 1.
- **Issues found** → Create bug entries via /ship-bug logic. **Emit `bug_created` per bug** (`shipyard-data events emit bug_created bug=<id>`) — the terminal gate requires at least one such event in the review window before it will allow the `terminal_issues` cursor write (clause 3 below). `shipyard-data feature set-status <FID> approved` (not `in-progress` — it needs re-planning) followed by `shipyard-data backlog add <FID>` so the next `/ship-sprint` picks it up.
- **Needs changes** → Update spec with new criteria. Create patch tasks — **write each `spec/tasks/<id>-<slug>.md` file first**, then **emit `patch_task_created` per task** (`shipyard-data events emit patch_task_created task=<id>`). Order matters: a `patch_task_created` event for an id with no task file leaves a dangling reference that ship-status validation, this review's evidence check, and the next sprint's carry-over scan all trip over (`shipyard-data doctor` flags it). The terminal gate requires the event before allowing the `terminal_changes` cursor write (clause 3 below). `shipyard-data feature set-status <FID> approved` followed by `shipyard-data backlog add <FID>`. Show:
  ```
  ▶ NEXT UP: Fix the gaps and re-verify
    /ship-execute --task [patch task ID]
    (tip: /clear first for a fresh context window)
  ```

- **Cursor advance**: on `process_approved` → run `shipyard-data cursor advance review retro_decision --note "Ask whether to run retrospective"` and echo its output, unless `--skip-retro` was passed; with `--skip-retro`, run `shipyard-data cursor advance review release_step_1 --note "Skip retrospective by explicit user flag; present release plan"` and echo its output. On `process_issues` → run `shipyard-data cursor advance review terminal_issues outcome=issues reason=user_flagged_issues`. On `process_changes` → run `shipyard-data cursor advance review terminal_changes outcome=changes reason=user_requested_changes`. The CLI emits the terminal event and prints the stop marker as the final line.

- **Terminal-gate enforcement (v2.6.0).** The two **escalation** terminal advances — `terminal_changes` and `terminal_issues` — run the terminal-evidence gate in-process inside `shipyard-data cursor advance`. The advance is refused (exit 3, reasons printed) unless: (1) `pipeline_tick_completed pipeline=ship-review stage=demo_user` is in the event log (proving the user-approval step ran); **and** (2) at least one `patch_task_created` or `bug_created` event was emitted in this review window (this is why process_issues/process_changes MUST emit those events — see Stage 6 above; those non-cursor events are still emitted via `shipyard-data events emit`). If the advance exits 3, fix the missing evidence (or escalate) — do NOT try to Write the cursor directly, the hook denies it. **The approved-success path does NOT run a gated `terminal_approved` advance** — it archives the sprint (rotating `current/` away) and the terminal advance emits `pipeline_terminal outcome=approved`, so the gate's `terminal_approved` branch (per-feature approve-verdict enforcement in `bin/terminal-gate.mjs`) is a **defensive path the current flow doesn't exercise**; the approve-verdicts and the user-approval gate are enforced upstream (per-feature `verify/<F>-verdict.md` files + the demo_user tick). Run `shipyard-context terminal-gate ship-review` to inspect what would block a terminal advance right now.

## Hotfix Review

Fast-track for hotfixes:
1. Check regression test exists and passes
2. Check fix addresses the bug report
3. No full demo — just test verification
4. Report as a statement, not a question — Shipyard never merges or pushes (see Rules), so asking permission for an action it won't perform is misleading: *"Hotfix B-HOT-NNN verified (regression test red→green). Merge when ready — Shipyard doesn't touch your branches."*

---

## Sprint Retrospective

After sprint approval (or when `--retro-only` is passed), run the retrospective only when the user chooses it at Retro Decision, unless `--retro-only` was passed. `--skip-retro` bypasses this decision and goes directly to release planning. This analyzes what happened, captures learnings, and creates improvement items. If `--retro-only` with a sprint ID, Read that sprint's archived files from `<SHIPYARD_DATA>/sprints/sprint-NNN/` instead of `current/`.

### Retro Decision (stage_id: retro_decision)
Present a short data-derived prompt: sprint size, patch-task count, review iterations, any salvage/timeout/plugin issue signals, and whether this looks like a high-learning sprint. Pause before asking: run `shipyard-data cursor pause review --note "awaiting user: retro decision"` before `AskUserQuestion`. Ask one question only:
- **Run retro (Recommended when high-learning signals exist)** — run Retro Step 1, then ask retro questions in Step 2.
- **Skip retro** — skip Retro Step 1-4 and proceed to Release Step 1.

On the user's answer, run `shipyard-data cursor resume review`, then advance: **Run retro** → `shipyard-data cursor advance review retro_step_1 --note "Gather retrospective data"`; **Skip retro** → `shipyard-data cursor advance review release_step_1 --note "Retrospective skipped by user decision; present release plan"`. Echo the CLI output. Do not ask the three retro questions unless the user chose **Run retro**.

The retro runs in four steps with compaction recovery via `RETRO-DATA.md`'s `step` frontmatter field. Full mechanics — data-gathering source files, throughput computation, IDEA allocation/frontmatter, metrics rollover, anti-pattern flags — in `references/retro-and-release.md`.

**Agentic retrospective quality bar.** Shipyard is an agentic one-shot build framework, so the retro must not become a ceremonial meeting simulator. Step 1 is the primary artifact: derive facts from event logs, cursor history, task files, verification ledger reuse, patch-task count, blocker/salvage events, repeated build/test dispatches, and review findings. Step 2 asks the user only for judgment that cannot be inferred from data. Step 3 creates at most five IDEAs, only when the action would change future Shipyard behavior, sprint planning, quality gates, or project defaults; duplicate, vague, or one-off observations stay in `RETRO-DATA.md` as notes. Classify every candidate as `project`, `process`, or `shipyard-framework`; `shipyard-framework` issues follow the plugin issue detection rule below and do not enter the user's project backlog.

### Retro Step 1: Gather Data (stage_id: retro_step_1)
Compute planned-vs-delivered, velocity, carry-over, bugs, blocked time, swaps, patch tasks, estimate accuracy, throughput from SPRINT.md + task/feature files. Also compute agentic delivery signals: build/test rerun count, verification-ledger reuse count, code-review iterations, gap-analysis iterations, patch tasks created during review, user-flow probe failures, timeout/salvage events, and Shipyard plugin issue candidates. Write to `RETRO-DATA.md` (`step: data_gathered`) and present the summary block.

- **Cursor advance**: run `shipyard-data cursor advance review retro_step_2 --note "Facilitate retro discussion (one bulk AskUserQuestion)"`.

### Retro Step 2: Facilitate Discussion (stage_id: retro_step_2)
Pause before asking (per the pause-before-ask rule): run `shipyard-data cursor pause review --note "awaiting user: retro discussion"` before the `AskUserQuestion`. Render the observations as chat text first — the RETRO-DATA.md summary block, the flagged issues, and the suggested improvements (RETRO-DATA.md content and question strings do not count as shown) — then ask all three in ONE call. Then ask all three in **ONE** `AskUserQuestion` call (three questions), each led by its data-driven observation and each with a cheap exit ("'skip' is fine"):
1. **What went well?** — lead with what the data shows went well.
2. **What didn't go well?** — lead with the flagged issues.
3. **What should we change next sprint?** — lead with the suggested improvements.

On the user's answers, run `shipyard-data cursor resume review`, append responses to `RETRO-DATA.md` under `## Team Feedback`, and update frontmatter: `step: feedback_collected`.

- **Cursor advance**: after the answers are collected, run `shipyard-data cursor advance review retro_step_3 --note "Create IDEA action items"` and echo its output.

### Retro Step 3: Create Action Items (stage_id: retro_step_3)
For each actionable improvement, allocate an ID via `shipyard-data next-id ideas` (never `ls`-and-guess) and Write `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` with `source: retro/<sprint-id>` (slash form — matches the carry-over scan regex). Cap this at 5 IDEAs per retrospective and require each IDEA to name the trigger metric or event evidence from `RETRO-DATA.md`; otherwise leave it as a retro note. Update `RETRO-DATA.md`: `step: action_items_created`.

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
Read all `status: done` features from this sprint. Output the release plan as text — CHANGELOG block, STATUS CHANGES, RETRO HIGHLIGHTS when available, FILES WRITTEN. If `--skip-retro` was passed or no `RETRO-DATA.md` exists, write `RETRO HIGHLIGHTS: skipped by explicit user flag` instead of inventing metrics. Release is the most irreversible action in the workflow; surface everything before confirming.

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
- Retro runs automatically after sprint approval unless the user explicitly passes `--skip-retro`; never infer a skip from impatience, sprint size, or a clean review.
- Action items from retro become idea files — promote via `/ship-discuss IDEA-NNN`.
- Shipyard does not create git tags, push, or create GitHub releases — the user handles that.
