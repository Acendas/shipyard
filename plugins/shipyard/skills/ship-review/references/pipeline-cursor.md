# Pipeline Cursor — REVIEW-CURSOR.md

The cursor records where `/ship-review` is in its multi-stage pipeline so that:

1. **A `/loop` driver can advance one stage per tick.** Each invocation reads the cursor, dispatches to the matching stage handler, advances the cursor for the next tick, and exits with an explicit terminal signal when the pipeline is done.
2. **A direct user invocation runs end-to-end as a chain.** Same skill, same dispatch table — when not driven by `/loop`, handlers chain until a user-input gate (AskUserQuestion) or the terminal stage.
3. **Compaction recovery is structural.** The cursor's `stage:` field is authoritative; PROGRESS.md / verdict files are confirmatory.

## The cursor is CLI-owned (v2.9.0)

**Never Read, Write, or Edit the cursor file directly from a skill body.** The `auto-approve-data` PreToolUse hook denies model Writes/Edits to `REVIEW-CURSOR.md` (and `EXECUTE-CURSOR.md`, `PROGRESS.md`, `HANDOFF.md`); reads go through `shipyard-context review-context` at entry or `shipyard-context cursor-state review` mid-session so the shared CLI parser owns cursor frontmatter shape. The single writer is:

```
shipyard-data cursor advance review <stage> [k=v ...] [--note "<narrative>"]
```

One atomic call validates the transition against the stage graph (`bin/pipeline-stages.mjs`), runs the loop-leak guard + terminal-evidence gate in-process, appends the pipeline event, rewrites the cursor, re-renders PROGRESS.md, and prints the tick/terminal marker (stop marker structurally the final line). **Exit 3 = refused** with reasons on stderr — fix the missing evidence or use `cursor escalate` / `cursor noop`; `--force` skips only the transition-graph check, never the evidence gates.

**Cron-cleanup reminder is CLI-printed.** At any resting state (`cursor pause` / `escalate` / `noop` / terminal `advance`), the CLI checks the event log for an armed `pipeline_loop_bootstrap_fallback` cron and prints a reminder line when one exists. The skill's job is simply: act on that reminder line whenever it's printed — `CronList` + `CronDelete` any cron targeting the pipeline. No manual event-log scan needed.

Settable `k=v` fields: `sprint`, `iteration`, `loop_owner`, `status`, `next_action`, `stuck_counter`, `hard_ceiling`. Event-only: `outcome=`, `reason=`. Unset fields carry forward; `iteration` derives from stage names like `code_review_iter_2`. `--note` sets the free-form narrative body.

Companions:

- `shipyard-data cursor set review k=v [...]` — field-only update (e.g. the bootstrap sentinel): no transition, no gates, no events.
- `shipyard-data cursor resume review` — flips an escalated/paused cursor back to `in_progress` at the same stage (emits `pipeline_resumed`); the documented recovery from `status: escalated`.
- `shipyard-data cursor bootstrap-check review` — the auto-loop eligibility computation as one JSON line; sets the `auto_loop_attempted` sentinel itself when eligible.
- `shipyard-data cursor pause review --note "<resume context>"` — `status: paused`, keeps the stage. Replaces HANDOFF.md (retired).
- `shipyard-data cursor escalate review reason=<short>` — terminal escalation from any stage (e.g. `reason=hard_ceiling_stage_<id>`). Not a claim of success → bypasses the evidence gate by design.
- `shipyard-data cursor noop review [sprint=<id>]` — the idempotent no-work sweep. Picks the reason itself from cursor state: `sprint_already_archived` (no live sprint), `cursor_already_terminal` (terminal cursor), or `awaiting_user_paused` / `awaiting_user_escalated` (a paused/escalated cursor awaiting the user). Emits `pipeline_terminal outcome=noop` FIRST, then repeat-leak detection. It NEVER resumes — a paused/escalated sprint is not complete, and resume is a user decision (`cursor resume`); a repeat wakeup against the same halted sprint trips the ⛔ leak alarm pointing at resume.

**Anti-improvisation rule (v2.6.0, still load-bearing).** The `--note` body is free-form narrative ONLY. Do not invent structured `notes:` claims that future ticks might parse as authoritative state — particularly claims that justify skipping documented stages. Structured claims live in the event log (`shipyard-data events emit stage_0_skipped reason=<r>`), and stage skipping is allowed only via documented CLI flags (`--skip-code-review`, `--hotfix`, `--retro-only`). The v2.5.0 confedit incident is why: an improvised cursor-body claim let the model self-grant a skip that has no code path. (The transition graph now also structurally rejects stage jumps the flags don't produce.)

## Cursor location and lifetime

`<SHIPYARD_DATA>/sprints/current/REVIEW-CURSOR.md`

Lifetime is one review cycle. Created by the first `cursor advance review preflight` (the only entry stage), advanced after every stage transition, archived with `current/` when the sprint is archived.

## Frontmatter schema (rendered by the CLI — read-only reference)

```yaml
---
pipeline: ship-review
sprint: sprint-001                       # or feature ID for --feature mode
stage: code_review_iter_2                # required; see stage map below
iteration: 2                             # within-stage counter for self-looping stages
last_advance_at: 2026-05-18T17:58:00Z    # set by the CLI
loop_owner: "/loop"                      # or "user" or null
status: in_progress                      # in_progress | complete | escalated | paused
next_action: "Re-scan after fixer iteration 2 committed"
terminal: false
stuck_counter: 0
hard_ceiling: 50
---
```

## Stage map for ship-review

The graph below is what `cursor advance` enforces (source of truth: `bin/pipeline-stages.mjs`).

| stage | What runs | On success → | On dirty / issue → |
|---|---|---|---|
| `preflight` | Branch check, mode detection (sprint vs feature vs hotfix vs retro-only) | `code_review_iter_1` (or `tests` if `--skip-code-review`, or `retro_step_1` if `--retro-only`) | escalate via AskUserQuestion |
| `code_review_iter_N` | One Stage 0 iteration (seven concern domains), write CODE-REVIEW.md, dispatch fixer if dirty | `simplify` (if `must_fix == 0 && should_fix == 0`) | `code_review_iter_N+1` (self-loop; see stuck detection) |
| `simplify` | Stage 0.5 — simplifier subagent on sprint diff | `tests` | `tests` (log + continue) |
| `tests` | Stage 1a — full suite via `dispatching-operational-task` | `spec_review` | `tests` (self-loop after fixer, bounded by the operational task's cap) |
| `spec_review` | Stage 1b — `dispatching-spec-review` per feature | `quality_gates` (or straight to `visual`/`goal_verify` when no standing gates) | `goal_verify` (FINDINGS carry into gap analysis) |
| `quality_gates` | Stage 1.5 — standing quality gates from config | `visual` (if any UI tasks) or `goal_verify` | `goal_verify` (log + continue) |
| `visual` | Stage 2 — screenshots at three viewports | `goal_verify` | `goal_verify` (log + continue) |
| `goal_verify` | Stage 3 — observable truths, artifacts, wiring per feature | `gap_analysis` | `gap_analysis` (gaps carry forward) |
| `gap_analysis` | Stages 4 + 4.5 self-review checklist | `critic` (when checklist stabilizes) | `gap_analysis` (self-loop) |
| `critic` | Stage 4.6 — critic subagent | `final_pass` | `final_pass` |
| `final_pass` | Stage 4.7 — surgical pass on critic findings | `verdict` | `verdict` |
| `verdict` | Write `verify/[feature-id]-verdict.md` (model-authored — verdicts stay Write) | `demo_probe` | `demo_probe` |
| `demo_probe` | Stage 4.8 — verify each feature's `user_flow_probe` | `demo_user` | escalate (FAIL/TIMEOUT) |
| `demo_user` | Stage 5 — present results + AskUserQuestion approval (pause-before-ask; manual gates batched into one call) | `process_approved` / `process_issues` / `process_changes` | (pause → waits for user → resume) |
| `process_approved` | Stage 6 — update feature statuses to `done` | `retro_decision` (or `release_step_1` if `--skip-retro`) | — |
| `process_issues` | Stage 6 — create bug entries, feature → `approved` | `terminal_issues` | — |
| `process_changes` | Stage 6 — update spec, create patch tasks | `terminal_changes` | — |
| `retro_decision` | Ask whether to run or skip the retrospective (pause-before-ask) | `retro_step_1` (Run retro) / `release_step_1` (Skip retro) | (pause → waits for user → resume) |
| `retro_step_1` → `retro_step_2` → `retro_step_3` → `retro_step_4` | Retro (data → discussion → IDEA items → metrics); `retro_step_2` is pause-before-ask with all three prompts in ONE AskUserQuestion call | next retro step, then `release_step_1` | `retro_step_2`: pause → waits for user → resume |
| `release_step_1` | Present release plan + AskUserQuestion (pause-before-ask; load-bearing approval) | `release_step_2` (Release) / `archive` (Skip) / `release_step_1` (Edit — self-loop) | (pause → waits for user → resume) |
| `release_step_2` | Update feature frontmatter, prepend CHANGELOG.md | `release_step_3` | — |
| `release_step_3` | `shipyard-data archive-sprint sprint-NNN` | `terminal` | escalate |
| `archive` | Skip-release path — archive-sprint | `terminal` | escalate |
| `terminal` | Success terminal | — | — |
| `terminal_issues` | Escalated terminal, outcome=issues | — | — |
| `terminal_changes` | Escalated terminal, outcome=changes | — | — |

## Terminal protocol

When a tick reaches a terminal stage (`terminal`, `terminal_issues`, `terminal_changes`):

1. Run `shipyard-data cursor advance review <terminal-stage> reason=<short>`. The CLI verifies the evidence (all terminals: a `pipeline_tick_completed stage=demo_user` tick exists; `terminal_issues`/`terminal_changes`: at least one `patch_task_created` or `bug_created` event), emits `pipeline_terminal` with the stage-appropriate outcome (`success` / `issues` / `changes`), writes the terminal cursor, and prints **`▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.`** as the final line.
2. **Echo the CLI's output as the final lines.** Any "what to do next" hint (`/ship-discuss`, `/ship-sprint`) prints BEFORE running the terminal advance, never after — nothing follows the stop marker (v2.8.2 rule, CLI-enforced for its own output; the skill must not append).
3. Do not call `ScheduleWakeup` for the next tick.
4. **Cron-fallback cleanup.** If this cycle emitted `pipeline_loop_bootstrap_fallback`, `CronList` + `CronDelete` any cron whose prompt targets `/shipyard:ship-review`.

Note: `release_step_3`/`archive` run `archive-sprint` BEFORE the terminal advance, which rotates `current/` away. The no-cursor terminal advance is handled first-class (v3.4.0): `shipyard-data cursor advance review terminal reason=cycle_complete` on an absent cursor runs the terminal-evidence gate over the (persistent) event log, emits the canonical `pipeline_terminal` event, prints `cursor: (archived) → terminal …` plus the stop marker, and **writes no cursor file** — deliberately, so no stale terminal cursor is planted into the freshly-recreated empty `current/` (which would no-op the next sprint and false-trip the leak alarm). So the flow is simply: run `archive-sprint`, then `cursor advance review terminal … reason=cycle_complete`. Do NOT fall back to `cursor noop` or `--force` here — the plain terminal advance handles the seam.

## Mid-pipeline tick exit (non-terminal)

One call: `shipyard-data cursor advance review <next-stage> next_action="<one line>" --note "<tick narrative>"`. The CLI emits `pipeline_tick_completed` and prints `▶ TICK COMPLETE — stage [X]. /loop continues.` Echo it as the final line; the `/loop` driver reads it and continues.

## Self-looping stages: stuck detection

`code_review_iter_N`, `gap_analysis`, `tests`, and `release_step_1` are the self-looping stages. Convergence is data-driven (scanners clean, checklist stable) — no arbitrary iteration cap. `stuck_counter` is CLI-owned: self-loop advances auto-increment it (pass `stuck_counter=0` when the loop made real progress), the CLI auto-emits `pipeline_stuck` when `stuck_counter >= 5` (5 ticks without progress), and at `hard_ceiling` it refuses the advance (exit 3) directing to `cursor escalate`. On the ≥5 warning, surface:

> `⚠ Stage [X] has run [N] times without state change. /ship-status to inspect; consider manual intervention.`

The warning is non-blocking. `hard_ceiling: 50` is the absolute stop — the CLI refuses further self-loops there; run `shipyard-data cursor escalate review reason=hard_ceiling_stage_<id>`.

## No-op terminal: already-archived sprint

When `/ship-review` is invoked, the cursor does NOT exist, AND there is no active sprint in `current/` (already archived):

1. Run **`shipyard-data cursor noop review sprint=<archived-id-if-known>`** (default `reason=sprint_already_archived`, or `cursor_already_terminal` when a terminal cursor exists) and echo its output. The CLI emits `pipeline_terminal outcome=noop` FIRST (non-optional — a silent no-op leaves no audit trace, which is what hid the original leak), runs the repeat-leak scan itself, and on the 2nd no-op for the same sprint emits `pipeline_loop_leak_detected` and prints the hard `⛔ LOOP LEAK …` marker; otherwise the stop marker.
2. **Cron-fallback cleanup** as above (the CLI prints the reminder line). Never call `ScheduleWakeup` on the no-op path.

**Paused / escalated is the same no-op sweep.** A wakeup that finds `status: paused` (a pause-before-ask stage awaiting a user answer) or `status: escalated` runs the identical `cursor noop review` — the CLI emits `outcome=noop reason=awaiting_user_paused` / `awaiting_user_escalated`, prints the pause note + resume hint + stop marker, and on a repeat wakeup screams the ⛔ leak alarm pointing at `cursor resume`. The sprint is NOT complete; a wakeup never resumes it.

**Structural backstop.** A leaked wakeup that tries to "fresh start" anyway is blocked twice: the PreToolUse hook denies model cursor writes, and `cursor advance` runs the loop-leak guard — a non-terminal review advance with no `current/SPRINT.md` exits 3. (A legit review tick on a `status: completed`, not-yet-archived sprint still passes — only the archived case is a review leak.)

## Event vocabulary

| Event name | Fields | Emitted by |
|---|---|---|
| `pipeline_tick_started` | `pipeline=ship-review`, `sprint=<id>`, `stage=<id>`, `iteration=<N>`, `loop_owner=<owner>` | **CLI**, on every non-terminal `cursor advance` (no manual emit) |
| `pipeline_tick_completed` | + `outcome=advanced\|self_loop`, `next_stage=<id>` | **CLI**, on every non-terminal `cursor advance` |
| `pipeline_terminal` | + `outcome=success\|issues\|changes\|noop\|escalated`, `reason=<short>` | **CLI**, on terminal `cursor advance` / `escalate` / `noop` |
| `pipeline_loop_leak_detected` | `pipeline=ship-review`, `sprint=<id>`, `noop_count=<N>` | **CLI**, inside `cursor noop` on a repeat no-op |
| `pipeline_paused` | `pipeline=ship-review`, `sprint=<id>`, `stage=<id>` | **CLI**, on `cursor pause` |
| `pipeline_stuck` | + `stage=<id>`, `iterations=<N>`, `reason=re-entry-without-progress\|hard-ceiling` | **CLI**, when an auto-counted self-loop hits ≥5 (and at the ceiling refusal) |
| `pipeline_resumed` | `pipeline=ship-review`, `sprint=<id>`, `stage=<id>`, `from_status=<escalated\|paused>` | **CLI**, on `cursor resume` |
| `pipeline_loop_bootstrap_eligible` | `pipeline=ship-review`, `sprint=<id>`, `stage=<id>` | **CLI**, inside `cursor bootstrap-check` when eligible |
| `code_review_iteration` | + `must_fix=<N>`, `should_fix=<N>` | Skill, via `events emit`, when a Stage 0 iteration completes |
| `code_review_escalated` | + `must_fix_remaining=<N>` | Skill, via `events emit`, at the hard ceiling |

Use these names verbatim — they're consumed by `/ship-status`, `shipyard-context diagnose`, and external observers.

## Cursor read at entry (skill body recipe)

```
1. Use `SHIPYARD_CURSOR_*` fields from `shipyard-context review-context` (or refresh with `shipyard-context cursor-state review`). Do not Read or parse REVIEW-CURSOR.md directly.
   - `SHIPYARD_CURSOR_PRESENT=true`, `SHIPYARD_CURSOR_TERMINAL=true` → run `shipyard-data cursor noop review`, echo output, exit. (On a `status: escalated` terminal the CLI prints the resume hint instead of a noop — the sprint is NOT complete; after the cause is fixed, `cursor resume review` re-opens it.)
   - `SHIPYARD_CURSOR_PRESENT=true`, `SHIPYARD_CURSOR_STATUS=paused` → **wakeup-inert.** A pause-before-ask stage is
     awaiting a user answer; a `/loop` wakeup cannot answer it. Run
     `shipyard-data cursor noop review` (emits `pipeline_terminal outcome=noop
     reason=awaiting_user_paused`, prints the pause note + resume hint + stop
     marker; a repeat wakeup trips the ⛔ leak alarm pointing at resume), echo,
     exit. Resume (`shipyard-data cursor resume review`, then dispatch to the
     `SHIPYARD_CURSOR_STAGE` handler) only on explicit user re-engagement — never a wakeup's.
   - `SHIPYARD_CURSOR_PRESENT=true`, non-terminal (and not paused) → dispatch to `SHIPYARD_CURSOR_STAGE` (tick events are CLI-emitted).
   - `SHIPYARD_CURSOR_PRESENT=false` and current/ has a live sprint → fresh start: first advance targets `preflight`.
   - `SHIPYARD_CURSOR_PRESENT=false` and no live sprint → the no-op path above.

2. After the stage handler returns, advance via `shipyard-data cursor advance`
   (or `pause` / `escalate`). Echo the CLI's marker output as the final lines.
```

## Direct invocation vs /loop driver

The same skill body serves both callers:

- **Direct invocation**: after a handler returns, if the next stage is non-terminal AND non-blocking, the dispatcher MAY chain into it within the same invocation, bounded by ~10 minutes wall-clock.
- **/loop driver**: each tick is exactly one handler; exit after the `cursor advance`.

Detect the caller via the most recent `pipeline_tick_completed` event: emitted within the last **5 minutes** (v3.4.0, was 30) with `next_stage` matching the current cursor's `stage` → `/loop` re-entry. The heuristic is CLI-owned (centralized in `cursor bootstrap-check`); the cursor's own `loop_owner` field wins when set. `--single-tick` forces /loop semantics.
