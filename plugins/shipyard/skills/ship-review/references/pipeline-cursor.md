# Pipeline Cursor — REVIEW-CURSOR.md

The cursor records where `/ship-review` is in its multi-stage pipeline so that:

1. **A `/loop` driver can advance one stage per tick.** Each invocation reads the cursor, dispatches to the matching stage handler, writes the cursor for the next tick, and exits with an explicit terminal signal when the pipeline is done. The next `/loop` wakeup sees `terminal: true` and stops scheduling itself.
2. **A direct user invocation runs end-to-end as a chain.** Same skill, same dispatch table — when not driven by `/loop`, handlers chain until a user-input gate (AskUserQuestion) or the terminal stage. Ctrl-C interruption persists the cursor; next invocation resumes from the documented stage.
3. **Compaction recovery is structural.** The cursor's `stage:` field is authoritative; PROGRESS.md / verdict files are confirmatory.

## Cursor location and lifetime

`<SHIPYARD_DATA>/sprints/current/REVIEW-CURSOR.md`

Lifetime is one review cycle. Written on entry (if absent), updated after every stage transition, deleted automatically when the sprint is archived (the `current/` directory rotates to `sprint-NNN/`, so the cursor goes with it as a historical artifact).

## Frontmatter schema

```yaml
---
pipeline: ship-review
sprint: sprint-001                       # or feature ID for --feature mode
stage: code_review_iter_2                # required; see stage map below
iteration: 2                             # within-stage counter for self-looping stages
last_advance_at: 2026-05-18T17:58:00Z    # ISO 8601 — when the previous tick wrote this cursor
loop_owner: "/loop"                      # or "user" or null — who is driving
status: in_progress                      # in_progress | complete | escalated | paused
next_action: "Re-scan after fixer iteration 2 committed"   # human-readable, one line
terminal: false                          # true → pipeline finished; /loop must stop
stuck_counter: 0                         # increments when a self-looping stage runs without state change
hard_ceiling: 50                         # max ticks any single stage may self-loop (safety; never reached in practice)
---
```

Body (one paragraph max):

> Free-form narrative of the last tick's outcome — what ran, what was decided, what the next tick should focus on. Read by the next tick's handler at entry. Keep under ~200 words; this is for hand-off, not history.

## Stage map for ship-review

| stage | What runs | On success → | On dirty / issue → |
|---|---|---|---|
| `preflight` | Branch check (SPRINT.md `branch:` vs current), mode detection (sprint vs feature vs hotfix vs retro-only) | `code_review_iter_1` (or `tests` if `--skip-code-review`, or `retro_step_1` if `--retro-only`) | escalate via AskUserQuestion |
| `code_review_iter_N` | One Stage 0 iteration: orchestrate 6 scanners, write CODE-REVIEW.md, dispatch fixer if dirty | `simplify` (if `must_fix == 0 && should_fix == 0`) | `code_review_iter_N+1` (no cap — see stuck detection) |
| `simplify` | Stage 0.5 — code-simplifier agent on sprint diff | `tests` | `tests` (log + continue) |
| `tests` | Stage 1a — full suite via `shipyard:dispatching-operational-task` | `spec_review` | `tests` (re-run after fixer) — bounded by operational task's own cap |
| `spec_review` | Stage 1b — `shipyard:dispatching-spec-review` per feature | `visual` (if any UI tasks) or `goal_verify` | `goal_verify` (FINDINGS carry into gap analysis) |
| `visual` | Stage 2 — screenshots at three viewports | `goal_verify` | `goal_verify` (log + continue) |
| `goal_verify` | Stage 3 — observable truths, artifacts, wiring per feature | `gap_analysis` | `gap_analysis` (gaps carry forward) |
| `gap_analysis` | Stages 4 + 4.5 self-review checklist | `critic` (when checklist stabilizes) | `gap_analysis` (self-loop — see stuck detection) |
| `critic` | Stage 4.6 — general-purpose subagent in critic mode | `final_pass` | `final_pass` |
| `final_pass` | Stage 4.7 — surgical pass on critic findings | `verdict` | `verdict` |
| `verdict` | Write `<SHIPYARD_DATA>/verify/[feature-id]-verdict.md` (one per feature reviewed) | `demo_probe` | `demo_probe` |
| `demo_probe` | Stage 4.8 — run each feature's `demo_probe` | `demo_user` | escalate (FAIL/TIMEOUT) via AskUserQuestion |
| `demo_user` | Stage 5 — present results + AskUserQuestion approval | `process_approved` / `process_issues` / `process_changes` | (waits for user) |
| `process_approved` | Stage 6 — update feature statuses to `done` | `retro_step_1` | — |
| `process_issues` | Stage 6 — create bug entries, feature → `approved` | `terminal_issues` | — |
| `process_changes` | Stage 6 — update spec, create patch tasks | `terminal_changes` | — |
| `retro_step_1` | Retro Step 1 — gather data, write RETRO-DATA.md | `retro_step_2` | — |
| `retro_step_2` | Retro Step 2 — facilitate discussion (3× AskUserQuestion) | `retro_step_3` | (waits for user) |
| `retro_step_3` | Retro Step 3 — create IDEA action items | `retro_step_4` | — |
| `retro_step_4` | Retro Step 4 — update metrics | `release_step_1` | — |
| `release_step_1` | Release Step 1 — present release plan + AskUserQuestion | `release_step_2` (Release) / `archive` (Skip) / `release_step_1` (Edit) | (waits for user) |
| `release_step_2` | Release Step 2 — update feature frontmatter, prepend CHANGELOG.md | `release_step_3` | — |
| `release_step_3` | Release Step 3 — `shipyard-data archive-sprint sprint-NNN` | `terminal` | escalate |
| `archive` | Skip-release path — `shipyard-data archive-sprint sprint-NNN` | `terminal` | escalate |
| `terminal` | Print wrap-up banner, set `terminal: true`, emit `pipeline_terminal` | — | — |
| `terminal_issues` | Like `terminal` but `status: escalated`, outcome=issues | — | — |
| `terminal_changes` | Like `terminal` but `status: escalated`, outcome=changes | — | — |

## Terminal signal protocol

When a tick reaches a terminal stage (`terminal`, `terminal_issues`, `terminal_changes`):

1. Write the cursor with `terminal: true`, `status: complete` (or `escalated`), `next_action: "Pipeline complete — no further work."`
2. Emit the structured event: `shipyard-data events emit pipeline_terminal pipeline=ship-review sprint=<id> outcome=<success|issues|changes|escalated> reason=<short>`
3. Print the literal marker in the final user-facing output: **`▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.`**
4. Do not call `ScheduleWakeup` for the next tick.

The marker text is load-bearing: the `/loop` driver model reads it (alongside the event) and refrains from scheduling another wakeup. The cursor's `terminal: true` is the machine signal; the marker is the human + model echo.

## Mid-pipeline tick exit (non-terminal)

When a tick advances to a non-terminal next stage:

1. Write the cursor with the new `stage:`, incremented `last_advance_at:`, `terminal: false`, `next_action:` describing what tick N+1 should do.
2. Emit: `shipyard-data events emit pipeline_tick_completed pipeline=ship-review sprint=<id> stage=<previous> outcome=advanced next_stage=<new>`
3. Print: **`▶ TICK COMPLETE — pipeline at stage [X], next: [Z]. /loop continues.`**

The `/loop` driver reads `terminal: false` and continues with another `ScheduleWakeup`.

## Self-looping stages: stuck detection

`code_review_iter_N` and `gap_analysis` are the two stages that can self-loop until they converge. There is no arbitrary iteration cap — convergence is data-driven (scanners clean, checklist stable). To detect a stuck loop:

- Each self-loop tick increments `stuck_counter:` if state did NOT change since last tick (e.g., same must-fix count, same gap list).
- If `stuck_counter >= 5`, emit `shipyard-data events emit pipeline_stuck pipeline=ship-review sprint=<id> stage=<id> iterations=<N> reason=<no-state-change>` AND surface a one-line warning in the tick's user-facing text:

  > `⚠ Stage [X] has run [N] times without state change. /ship-status to inspect; consider manual intervention.`

- The warning is non-blocking. The loop keeps running. Reset `stuck_counter` to 0 on the first tick where state changes.
- `hard_ceiling: 50` is the absolute safety stop. If `iteration: 50` is reached on a self-loop stage, write `status: escalated`, `terminal: true`, emit `pipeline_terminal pipeline=ship-review outcome=escalated reason=hard_ceiling_stage_<id>`, and halt. This is a backstop against a runaway loop with broken state-change detection — in practice the warning at 5 should already have surfaced intervention.

## No-op terminal: already-archived sprint

When `/ship-review` is invoked and the cursor does NOT exist AND there is no active sprint in `current/` (sprint already archived):

1. Treat this as an idempotent no-op.
2. Write a transient terminal cursor (or skip the cursor write entirely if no `current/` dir exists).
3. Emit: `shipyard-data events emit pipeline_terminal pipeline=ship-review sprint=<archived-id-if-known> outcome=noop reason=sprint_already_archived`
4. Print: **`▶ CYCLE COMPLETE — sprint already complete and archived. /loop should stop.`**
5. Exit cleanly.

This is the exact path that fired in the original /loop bug report: sprint-001 archived, /loop fires wakeup, ship-review re-enters, sees archived state, exits — but historically the exit had no terminal marker. With the marker, the /loop driver sees the signal and stops scheduling.

## Event vocabulary

| Event name | Fields | Emit when |
|---|---|---|
| `pipeline_tick_started` | `pipeline=ship-review`, `sprint=<id>`, `stage=<id>`, `iteration=<N>`, `loop_owner=<owner>` | At tick entry, after reading the cursor |
| `pipeline_tick_completed` | + `outcome=advanced|self_loop|escalated`, `next_stage=<id>` | At tick exit, before writing the cursor |
| `pipeline_terminal` | + `outcome=success|issues|changes|noop|escalated`, `reason=<short>` | When `terminal: true` is being written |
| `pipeline_stuck` | + `stage=<id>`, `iterations=<N>`, `reason=no-state-change` | When `stuck_counter >= 5` |
| `code_review_iteration` | + `must_fix=<N>`, `should_fix=<N>` | Stage 0 iteration completes (existing event; preserve) |
| `code_review_escalated` | + `must_fix_remaining=<N>` | When `code_review_iter_N` hits hard ceiling (replaces the prior 3-iteration cap escalation) |

Use these names verbatim — they're consumed by `/ship-status`, `shipyard-context diagnose`, and any external observers tailing the event log.

## Cursor read at entry (skill body recipe)

Every ship-review invocation begins with:

```
1. Read <SHIPYARD_DATA>/sprints/current/REVIEW-CURSOR.md (use the Read tool).
   - If file exists and `terminal: true`: print the terminal marker, emit
     pipeline_terminal with outcome=noop reason=cursor_already_terminal, exit.
   - If file exists and `terminal: false`: dispatch to the handler for the
     stage in the `stage:` field. Emit pipeline_tick_started first.
   - If file does NOT exist: fresh start. Set stage=preflight, iteration=1,
     terminal=false, status=in_progress. Emit pipeline_tick_started.

2. After the chosen stage's handler returns, write the cursor for tick N+1
   (or for terminal exit). Emit pipeline_tick_completed (or pipeline_terminal).
   Print the appropriate marker text.
```

The cursor write is via the Write tool (auto-approved for SHIPYARD_DATA). Use the literal absolute path from `shipyard-context path`.

## Direct invocation vs /loop driver

The same skill body serves both callers:

- **Direct invocation** (user runs `/ship-review` or `/ship-review F-NNN`): after a handler returns, if the next stage is non-terminal AND non-blocking (no AskUserQuestion required AND no expensive operation), the dispatcher MAY chain into it within the same invocation, bounded by a wall-clock budget of approximately 3 minutes per invocation. This preserves the "user runs `/ship-review` and it does as much as it can" UX.
- **/loop driver**: each tick is exactly one handler. The dispatcher exits after writing the cursor and emitting `pipeline_tick_completed`. The chain-within-invocation logic is suppressed when `loop_owner == "/loop"`.

Detect the caller by checking whether the invocation is inside a `/loop` re-entry. The most reliable signal: read the immediately-preceding `pipeline_tick_completed` event from `.shipyard-events.jsonl`; if it was emitted within the last 30 minutes and `next_stage` matches the current cursor's `stage`, treat as `/loop` re-entry. Otherwise treat as direct invocation. (A user explicitly passing `--single-tick` forces /loop semantics; this is the override.)
