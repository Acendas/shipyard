---
name: ship-review
description: "Run multi-agent review, retrospective, and release."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, Agent, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskStop, SendMessage, Skill, Workflow]
model: opus
effort: low
argument-hint: "[feature ID] [--demo] [--hotfix ID] [--retro-only] [--skip-retro] [--skip-code-review] [--single-tick]"
---

# Shipyard: Review & Verification

Verify completed work against spec; get approval.

## Context

!`shipyard-context review-context`

**The pipeline cursor, PROGRESS.md, and HANDOFF.md are CLI-owned — the model never writes them.** A PreToolUse hook DENIES any Write/Edit targeting `REVIEW-CURSOR.md`, `PROGRESS.md`, or `HANDOFF.md`. The only writer is the `shipyard-data cursor` CLI, which runs the terminal-evidence gate (exit 3 with reasons on failure) and prints the tick/terminal marker lines itself (stop marker guaranteed LAST). So: advance a tick with `shipyard-data cursor advance review <stage> [k=v ...] [--note "<narrative>"]`; do NOT emit `pipeline_tick_completed`/`pipeline_terminal` yourself and do NOT print your own `▶ TICK COMPLETE`/`▶ CYCLE COMPLETE` markers — echo the CLI's output as the final lines of the tick. SPRINT.md frontmatter is mutated via `shipyard-data sprint set <key> <value>` (never a model Edit). Verdict files (`verify/<F>-verdict.md`) and other narrative artifacts stay model Writes. Use the Write tool for those.

**Render before asking.** Follow SHIPYARD_STARTUP_RULES and SHIPYARD_ONBOARDING_INSTRUCTION from startup.

**Quiet by default.** Between user-input gates, work quietly: one-line stage transition markers, compact status lines, and one-line background-dispatch banners only. Self-looping stages run silently to convergence with a one-line result. Render full results only at a gate or terminal summary; subagent returns are internal contracts: parse the structured fields, never paste them. **No running commentary** ("Now I'll…", "Let me…"). Full doctrine: `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md` § "Interim Communication: Quiet by Default".

**Goal driver contract.** `/goal` is the only autonomous liveness driver for this command. It may re-enter `/ship-review` until the Shipyard cursor reaches terminal, paused, or escalated state. `/goal` is never state authority; the review cursor, event log, queue ledger, verification ledger, and artifacts are. Never invoke `/goal` from a spawned Agent, and never create a nested goal when this command is already running inside an active goal. A goal tick runs the same stage handler as a direct invocation, advances the cursor, and stops/continues only according to the CLI-owned cursor result.

**Flat-worker contract.** `/ship-review` is the sole orchestrator. It may spawn scanner/fixer/critic/gap agents directly, but those agents are leaf workers: they claim at most one queued item via `shipyard-data queue claim`, write the required artifact, call `shipyard-data queue complete|fail`, and return only item id, status, and artifact path. A worker must never spawn another agent, invoke `/goal`, own cursor advancement, or decide review completion. Completion is proven by queue state plus artifacts, not Agent notification delivery.

**Capability-skill playbooks.** Where a step says *"follow the `X` playbook"* or "dispatch `X`", X is a capability skill — **Read** `${CLAUDE_PLUGIN_ROOT}/skills/<X>/SKILL.md` and execute it inline; never hand it to the `Skill` tool (capability skills are `disable-model-invocation: true`, so `Skill` refuses them). Substantial analysis/labor dispatches use registered Shipyard agents through their wrapper skills; `general-purpose` is allowed only for tiny one-shot prompts with an explicit local justification.

## Input

$ARGUMENTS

## Detect Mode

- Feature ID (S001) → Review specific feature
- `--demo` → Include interactive demo (open browser, fill forms)
- `--hotfix S001` → Fast-track hotfix review
- `--retro-only` → Skip review, run only the retrospective- `--skip-retro` → After approval, skip the retrospective and go directly to release planning/archive.
- No args → Review all completed tasks in current sprint, then run retrospective
- No active sprint and no feature ID (sprint already archived: `current/` directory is empty or absent of `SPRINT.md`) → **No-op terminal path.** Run `shipyard-data cursor noop review sprint=<last-known-or-unknown> reason=sprint_already_archived` and echo its output. Exit cleanly without invoking AskUserQuestion.

---

## Cursor + Per-Tick Advance

`/ship-review` is a multi-stage goal-driven pipeline. Each invocation uses cursor state from the bundled `shipyard-context review-context` block (`SHIPYARD_CURSOR_*` fields), dispatches to the matching stage handler, then advances the cursor for the next tick via the CLI. Full cursor schema, stage map, terminal protocol, event vocabulary, and stuck-detection rules live in `references/pipeline-cursor.md`.

**Cursor read at entry.** Begin every invocation with:

1. Use the `SHIPYARD_CURSOR_*` fields from `shipyard-context review-context`; do not Read or parse `REVIEW-CURSOR.md` directly. If cursor state must be refreshed mid-invocation, run `shipyard-context cursor-state review`.
   - **`SHIPYARD_CURSOR_PRESENT=true` and `SHIPYARD_CURSOR_TERMINAL=true`**: run `shipyard-data cursor noop review sprint=<id> reason=cursor_already_terminal`, echo its output, exit.
   - **`SHIPYARD_CURSOR_PRESENT=true` and `SHIPYARD_CURSOR_STATUS=paused`** (a pause-before-ask stage is awaiting a user answer): **paused is goal-inert.** `/goal` must NEVER resume it — a goal tick can't answer the pending question. Run `shipyard-data cursor noop review sprint=<id>`, echo its output (it emits `pipeline_terminal outcome=noop reason=awaiting_user_paused`, prints the pause note + resume hint + stop marker), and STOP. Only when the user is explicitly re-engaging this invocation (they answered the pending question, or asked to continue) run `shipyard-data cursor resume review` and dispatch to `SHIPYARD_CURSOR_STAGE`.
   - **`SHIPYARD_CURSOR_PRESENT=true` and `SHIPYARD_CURSOR_TERMINAL=false`** (and not paused): dispatch to the handler for `SHIPYARD_CURSOR_STAGE` (per the stage map in `references/pipeline-cursor.md`). (`pipeline_tick_started`/`pipeline_tick_completed` are CLI-emitted on every advance — no manual event emits.)
   - **`SHIPYARD_CURSOR_PRESENT=false`**: fresh start. Dispatch to the preflight handler; the handler's `cursor advance` call materializes the cursor (and emits the tick events).

2. **No-op terminal sweep (MANDATORY — load-bearing for goal safety).** Even if step 1 read a non-terminal cursor (or no cursor at all), verify the sprint is actually alive by checking BOTH conditions:
   - cursor exists with `terminal: true` (already covered in step 1; re-checking here is belt-and-braces)
   - There is no active sprint in `<SHIPYARD_DATA>/sprints/current/` (already archived — `current/` directory empty or absent of SPRINT.md)

   **`SPRINT.md` `status: completed` is NOT a no-op condition.** `/ship-execute` sets it when execution finishes — that is exactly the state `/ship-review` exists to review. Treating it as "already done" made every freshly executed sprint un-reviewable (sprint-003: all 10 features unreviewed). Only an archived sprint or a terminal review cursor means review is done.

   If EITHER of the two conditions holds AND no feature ID was passed as an argument, run the no-op terminal path via a single CLI call:
   - Run `shipyard-data cursor noop review sprint=<id-or-unknown> reason=sprint_already_archived`. This does the whole sweep in-process: emits `pipeline_terminal outcome=noop` FIRST, runs repeated-noop detection, prints the hard `⛔ REPEATED NOOP …` marker on the second noop for the same sprint/reason, and prints the stop marker as the final line. Echo its output.

   Exit cleanly without invoking AskUserQuestion. NEVER skip this sweep.

3. After the chosen stage's handler returns, advance the cursor for tick N+1 (or for terminal exit) with `shipyard-data cursor advance review <next-stage> [k=v ...] [--note "..."]` (terminal stages use `advance review terminal|terminal_issues|terminal_changes`, or `cursor escalate review reason=<r>` for a mid-stage escalation). The CLI emits the `pipeline_tick_completed`/`pipeline_terminal` event atomically with the cursor write and prints the marker text.

The marker text it prints is load-bearing — `/goal` reads `CYCLE COMPLETE` + `/goal should stop` as the structural signal to stop, and the CLI guarantees that marker is the LAST line.

**Agent hygiene (load-bearing, CLI-gated, 4.5).** An agent is kept exactly as long as work can still come back to it. A fixer whose batch may get follow-up findings stays until the validation that covers it passes (findings go back to it with `SendMessage`; a stopped agent cannot be resumed); every scanner, reviewer, critic and analyst is stopped the moment its return is read: `TaskStop` it (a "not running" error just means it already ended on its own), then `shipyard-data agents stopped <name>`. Record agents spawned outside the worker queue with `shipyard-data agents spawned <name> --step <id>`. Before the approval ask and before the terminal advance run `shipyard-data agents check`; the terminal advance refuses while any agent this cycle spawned is unaccounted for. Name agents after their work (`review-security`, `fix-batch-2`).

**Pause before every blocking ask (load-bearing rule): a tick never exits with a pending question and no stop marker.** At every stage that blocks on `AskUserQuestion` for user input — `demo_user` (Stage 5 approval), `retro_decision` (run/skip retro), `retro_step_2` (retro discussion), `release_step_1` (release plan) — run `shipyard-data cursor pause review --note "awaiting user: <what>"` **before** invoking `AskUserQuestion`. The pause writes `status: paused` and prints the stop marker, so if the tick is torn down the persisted state is `paused` and `/goal` stops instead of re-running the stage and re-asking the same question. On the user's answer, run `shipyard-data cursor resume review`, then proceed with the stage handler. (pause keeps the current stage; resume returns to it.)

**Goal vs single-tick dispatch.** The same skill body serves both callers:

- **Goal-driven invocation:** run the current stage handler and advance the cursor. `/goal` re-enters this command until a terminal/paused/escalated marker tells it to stop.
- **`--single-tick`:** run exactly one handler, advance the cursor, echo the marker, and stop.

### Self-looping stages: stuck detection

Two stages can self-loop until they converge by data: `code_review_iter_N` (Stage 0 — scanner clean signal) and `gap_analysis` (Stages 4 + 4.5 — checklist stable signal). There is no arbitrary iteration cap; convergence is data-driven. Stuck detection works as follows:

- `stuck_counter` is CLI-owned: a self-loop `cursor advance` auto-increments it and auto-emits `pipeline_stuck` at ≥5; at `hard_ceiling` the CLI refuses the advance and directs to `cursor escalate`. Your only job: pass `stuck_counter=0` when the self-loop made real progress (for `code_review_iter_N`, the (must_fix, should_fix) tuple changed; for `gap_analysis`, the gap list changed set-wise).
- **Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-autofix.md` § Stuck warning and follow it for the ≥5 protocol (every self-looping stage, including legacy `code_review_iter_N`).
- `hard_ceiling: 50` is the absolute safety stop. If a self-loop stage reaches `iteration: 50`, run `shipyard-data cursor escalate review reason=hard_ceiling_stage_<id>` (terminal escalation from the current stage — sets `status: escalated`, `terminal: true`, emits `pipeline_terminal outcome=escalated`, prints the stop marker), echo its output, and halt.

---

### Compaction Recovery

If you lose context mid-review (e.g., after auto-compaction):

0. **Call `TaskList()` first.** If `[review-NNN] <stage>` tasks exist from the stage checklist (below), the last non-`completed` task names a candidate resume stage. **Confirm against the cursor before acting on it** (step 1) — the tasks are a mirror, not authority; if tasks and cursor disagree, the cursor wins.
1. **Cursor is authoritative.** Use the `SHIPYARD_CURSOR_*` fields from the entry context or refresh with `shipyard-context cursor-state review`. `SHIPYARD_CURSOR_STAGE` tells you exactly where to resume; verdict files are the secondary cross-check. PROGRESS.md is a rendered artifact (auto-regenerated from the event log on every cursor write) — never reconcile against it as if it were authoritative state, and never Write or Edit it.
2. Use Glob `<SHIPYARD_DATA>/verify/*-verdict.md` to find existing verdict files — these features are already reviewed
3. Read SPRINT.md — get the list of features to review
4. Skip features with verdict files where `complete: true`. If a verdict has `complete: false`, that review was interrupted — re-run the pipeline for that feature
5. **Staleness check**: read the feature spec file to find its `tasks:` list, then read each step file's Technical Notes for source file paths. If the most recent commit touching those source/test files (`git log -1 --format=%ci -- [paths]`) is newer than the verdict's `reviewed_at`, re-run the review — code has changed since the verdict was written
6. Resume the review pipeline from the cursor's `stage:` and the first feature without a valid verdict
7. For sprint-level review: aggregate results from verdict files when presenting the summary

Do not re-run the full test suite for features that already have valid (complete + fresh) verdict files.

---

## Review Pipeline

**Sprint review by default (4.6).** `/ship-execute` owns the quality work — spec review, gap analysis, code review and their fixes happen there, per story. When that is on record (`execution.code_review` on, and `shipyard-data story-review check` shows every sprint story settled with a code-review result) this command is the **sprint review**: it builds the review pack (evidence with before/after, numbers, decisions made without asking, what was not done or found-and-left and why, what went badly, proposed action items, what is next) and asks the owner once. **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/sprint-review.md` — stages `preflight → review_pack → demo_user → process_approved → retro → release → archive`. The scan-and-fix stages below (Stage 0a to 4.8) are the fallback for a sprint executed before 4.6, `execution.code_review: false`, `--hotfix` and single-story reviews.

### Stage Task Checklist (created at preflight)

On a fresh start (preflight, no existing cursor), `TaskCreate` one task per stage this invocation's mode will actually run — a per-STAGE mirror of pipeline progress, not a per-finding/per-criterion/per-gate list. Subject prefix **`[review-NNN] <stage>`** (NNN = sprint id; not `/ship-execute`'s `[sprint-NNN] Wave K` or `/ship-sprint`'s `[sprint-plan] Step N`). Create all of them in one batch.

Self-looping stages (`review_fix_wave_N`, legacy `code_review_iter_N`, `gap_analysis`) get **ONE** task each ("Stage 0c: Review Fix Waves", "Stage 4: Gap Analysis") — never one task per iteration.

Pick the stage set by mode:

| Mode | Stage tasks created |
|---|---|
| Default (full review, no flags) | preflight, Stage 0a: Review Scan (review_scan), Stage 0b: Review Fix Plan (review_plan), Stage 0c: Review Fix Waves (review_fix_wave_N), Stage 0d: Review Validation (review_validation), Stage 0.5: Simplify (simplify), Stage 1a: Tests (tests), Stage 1b: Spec Review (spec_review), Stage 1.5: Quality Gates (quality_gates), Stage 2: Visual (visual), Stage 3: Goal Verify (goal_verify), Stage 4: Gap Analysis (gap_analysis), Stage 4.6: Critic (critic), Stage 4.7: Final Pass (final_pass), Stage 4.8: User-Flow Verification (demo_probe), Stage 5: Demo & Approval (demo_user), Retro Decision (retro_decision), optional Retro Step 1-4 (retro_step_1..4), Release Step 1-3 (release_step_1..3), Wrap Up (terminal) |
| `--skip-code-review` | same as default minus Stage 0a-0d (review_scan, review_plan, review_fix_wave_N, review_validation), legacy Stage 0 (code_review_iter_N), and Stage 0.5 (simplify) — jumps preflight → tests |
| `--skip-retro` | same as default minus Retro Decision and Retro Step 1-4 — after approved Stage 6, jumps directly to Release Step 1 |
| `--retro-only` | Retro Step 1-4, Release Step 1-3, Wrap Up only (no review stages) |
| `--hotfix ID` | single task `[review-NNN] Hotfix Review` — the hotfix path doesn't tick through the cursor's per-stage graph |

`TaskUpdate` a stage task → `in_progress` when that stage's handler starts; → `completed` **only when the cursor actually advances past it** (i.e., the `shipyard-data cursor advance review <next_stage>` call for that transition succeeds) — never on a subagent/agent return's claim that the stage is done. A stage that pauses (`demo_user`, `retro_step_2`, `release_step_1` — any stage that runs `cursor pause` before an `AskUserQuestion`) or escalates: leave its task `in_progress` (visible, mid-flight) rather than marking it completed. A stage this mode's table above doesn't include (e.g. Stage 0 under `--skip-code-review`) is marked `completed` with `skipped: <reason>` in the description at creation time — never deleted silently.

**Guardrail (load-bearing): the stage task list is a progress surface and a recovery anchor, NEVER authority.** Do not gate any behavior on TaskList state, do not cite task status as evidence a stage ran, and never mark a stage task completed before the cursor advances past it. The review cursor, CODE-REVIEW.md/QUALITY-GATE.md, and the event log remain the record; the tasks are the user-visible mirror.

### Pre-flight: Branch Check (stage_id: preflight)

On a fresh start, create the cursor first: `shipyard-data cursor advance review preflight --note "Review preflight"` (a later stage is refused while no cursor exists). Then verify we're on the working branch from SPRINT.md frontmatter:

1. Read `branch` from SPRINT.md frontmatter
2. `git branch --show-current` — if not on the expected branch, `git checkout [branch]`

- **Cursor advance**: on success, on the sprint-review path run `shipyard-data cursor advance review review_pack --note "Sprint review: build the review pack"`; on the fallback path run `shipyard-data cursor advance review review_scan --note "Run Stage 0a batched scanner wave"` (or `... tests` if `--skip-code-review`, or `... retro_step_1` if `--retro-only`). With `--single-tick`, exit after the advance; otherwise `/goal` may re-enter for the next stage.

**Anti-improvisation assertion (fallback path).** Unless the sprint-review path applies (the code review is on record from `/ship-execute`), Stage 0 (multi-agent code review) MUST run whenever `/ship-review` is invoked WITHOUT one of `--skip-code-review`, `--hotfix`, or `--retro-only`. The sprint's frontmatter `status:` field (`completed`, `in-progress`, `approved`, …) DOES NOT affect this — code review runs on the diff regardless of how upstream pipelines have annotated the sprint. If Stage 0 genuinely cannot run on this invocation (e.g., the diff is empty because the working branch matches the base), emit a structured `stage_0_skipped reason=<short reason>` event via `shipyard-data events emit ...` and continue to `stage: tests`. Do NOT improvise a `notes:` field in the cursor body to justify skipping stages — structured claims live in the event log (schema: `references/pipeline-cursor.md`).

---

For each feature/task being reviewed:

### Stage 0a: Batched Review Scan (stage_id: review_scan)

Skip if `--skip-code-review` is passed or reviewing a hotfix. **Do not skip based on sprint frontmatter status** — see the anti-improvisation assertion in the Preflight section.

Run a read-only scanner wave before tests and spec compliance. Dispatch the scanner surfaces in parallel when the platform allows it:

- code review via `dispatching-code-review`; **Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/code-review-orchestration.md`
- spec compliance via `dispatching-spec-review`
- test-gap and acceptance-probe coverage from sprint/spec artifacts
- quality-gate manifest gaps from `QUALITY-GATE.md`
- user-flow/demo probe risk from each feature's `user_flow_probe`
- build/config drift from configured verification commands and the verify ledger

Each scanner return is normalized into `<SHIPYARD_DATA>/sprints/current/REVIEW-FINDINGS.json`. Use the Write tool for this artifact. The JSON must be an array or `{ "findings": [...] }`; each finding includes `id`, `title`, `severity`, `files`, `required_validation`, `confidence`, and `source`. Do not fix anything in this stage. Emit `shipyard-data events emit review_scan_completed sprint=<id> findings=<N> scanners=<N>`.

- **Cursor advance**: run `shipyard-data cursor advance review review_plan --note "Cluster review findings into fix batches"`.

### Stage 0b: Review Fix Planning (stage_id: review_plan)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-fix.md` § Stage 0b and follow it.

### Stage 0c: Review Fix Waves (stage_id: review_fix_wave_N)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-fix.md` § Stage 0c and follow it.

### Stage 0d: Review Validation Ladder (stage_id: review_validation)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-fix.md` § Stage 0d and follow it.

### Legacy Stage 0: Code Review Loop (stage_id: code_review_iter_N)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-fix.md` § Legacy Stage 0 and follow it (and `references/scanner-dispatch.md`). Only when config.md says `review.workflow: true`: `references/workflow-fanout.md` (read-only fan-out as a Workflow; the CLI stays the ledger).

### Stage 0.5: Code Simplification (stage_id: simplify)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-fix.md` § Stage 0.5 and follow it (and `references/scanner-dispatch.md`).

### Stage 1: Run Tests & Spec Verification (stage_id: tests, then spec_review)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-verify.md` § Stage 1 and follow it.

### Stage 1.5: Quality Gate Enforcement (stage_id: `quality_gates`)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-verify.md` § Stage 1.5 and follow it (it reads `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/quality-gate-enforcement.md`). On any gate FAIL, **Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-autofix.md` § Auto-fix before asking and follow it before dispatching a fixer.

### Stage 2: Visual Verification (stage_id: visual) (UI tasks)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-verify.md` § Stage 2 and follow it.

### Stage 3: Did We Actually Achieve the Goal? (stage_id: goal_verify)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-verify.md` § Stage 3 and follow it.

### Stage 4: Surface Gap Analysis (stage_id: gap_analysis, part 1)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-approval.md` § Stage 4 and follow it.

### Stage 4.5: Quality Gate (stage_id: gap_analysis, part 2) (self-review loop)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-approval.md` § Stage 4.5 and follow it.

### Stage 4.6: Critic Challenge (stage_id: critic)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-approval.md` § Stage 4.6 and follow it. The critic prompt template lives in `references/critic-prompt.md`.

### Stage 4.7: Final Review Pass (stage_id: final_pass)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-approval.md` § Stage 4.7 and follow it.

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

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-approval.md` § Stage 4.8 and follow it.

### Stage 5: Demo to User (stage_id: demo_user)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-approval.md` § Stage 5 and follow it.

### Stage 6: Process Decision (stage_id: process_approved | process_issues | process_changes)

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-stages-approval.md` § Stage 6 and follow it.

- **Cursor advance**: on `process_approved` → run `shipyard-data cursor advance review retro_decision --note "Ask whether to run retrospective"` and echo its output, unless `--skip-retro` was passed; with `--skip-retro`, run `shipyard-data cursor advance review release_step_1 --note "Skip retrospective by explicit user flag; present release plan"` and echo its output. On `process_issues` → run `shipyard-data cursor advance review terminal_issues outcome=issues reason=user_flagged_issues`. On `process_changes` → run `shipyard-data cursor advance review terminal_changes outcome=changes reason=user_requested_changes`. The CLI emits the terminal event and prints the stop marker as the final line.

- **Terminal-gate enforcement.** The two **escalation** terminal advances — `terminal_changes` and `terminal_issues` — run the terminal-evidence gate in-process inside `shipyard-data cursor advance`. The advance is refused (exit 3, reasons printed) unless: (1) `pipeline_tick_completed pipeline=ship-review stage=demo_user` is in the event log (proving the user-approval step ran); **and** (2) at least one `patch_step_created` or `story_created` event was emitted in this review window (this is why process_issues/process_changes MUST emit those events — see Stage 6 in `references/review-stages-approval.md`; those non-cursor events are still emitted via `shipyard-data events emit`). If the advance exits 3, fix the missing evidence (or escalate) — do NOT try to Write the cursor directly, the hook denies it. **The approved-success path does NOT run a gated `terminal_approved` advance** — it archives the sprint (rotating `current/` away) and the terminal advance emits `pipeline_terminal outcome=approved`, so the gate's `terminal_approved` branch (per-feature approve-verdict enforcement in `bin/terminal-gate.mjs`) is a **defensive path the current flow doesn't exercise**; the approve-verdicts and the user-approval gate are enforced upstream (per-feature `verify/<F>-verdict.md` files + the demo_user tick). Run `shipyard-context terminal-gate ship-review` to inspect what would block a terminal advance right now.

## Hotfix Review

Fast-track for hotfixes:
1. Check regression test exists and passes
2. Check fix addresses the bug report
3. No full demo — just test verification
4. Report as a statement, not a question — Shipyard never merges or pushes (see Rules): *"Hotfix S### verified (regression test red→green). Merge when ready — Shipyard doesn't touch your branches."*

---

## Sprint Retrospective (stage_id: retro_decision | retro_step_1 | retro_step_2 | retro_step_3 | retro_step_4)

Read `references/retro-and-release.md` § Sprint Retrospective and follow it for the RETROSPECTIVE path: the `retro_decision` run/skip gate, the four retro steps with their `shipyard-data cursor advance review` calls, `RETRO-DATA.md` compaction recovery, and Shipyard Plugin Issue Detection. `--retro-only` runs only this path; `--skip-retro` goes straight to release.

---

## Release

Read `references/retro-and-release.md` § Release and follow it for the RELEASE path: release plan approval (`release_step_1`), release record (`release_step_2`), archive (`release_step_3`). Shipyard never creates git tags, pushes, or creates GitHub releases.

### Wrap Up (stage_id: terminal | archive)

The skip-release path (`stage: archive`) and the full-release path (after `release_step_3`) both converge here. 
<!-- AC-8 -->
On the skip-release path (`stage: archive`), first run `shipyard-data archive-sprint sprint-NNN --via-review` (the full-release path already archived at `release_step_3`). Then run the terminal protocol:

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
  /ship-discuss IDEA-NNN — promote retro action-item IDEAs
  (tip: /clear first for a fresh context window)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

2. Run `shipyard-data cursor advance review terminal outcome=success reason=cycle_complete --note "Pipeline complete — no further work."`. The CLI emits `pipeline_terminal outcome=success` and prints `▶ CYCLE COMPLETE — pipeline terminal. /goal should stop.` Echo its output so that marker is the FINAL line of your response. (When `archive-sprint` already rotated `current/` away, the CLI's post-archive terminal seam applies: evidence gate over the event log, terminal event emitted, `cursor: (archived) → terminal …` printed, and NO cursor file written — deliberately, so no stale terminal cursor haunts the next sprint.)

The stop marker is load-bearing and **must be the final line**. The CLI guarantees the marker is last as long as you echo its output after the banner and print nothing further.

---

## Rules

- NEVER approve without running tests; an unverified approval ships unknown breakage. Auto-verify is mandatory.
- NEVER skip user approval; release is the user's call. The user must explicitly approve.
- Retro runs automatically after sprint approval unless the user explicitly passes `--skip-retro`.
- Shipyard does not create git tags, push, or create GitHub releases — the user handles that.
