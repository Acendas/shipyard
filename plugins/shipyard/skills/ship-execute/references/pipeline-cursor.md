# Pipeline Cursor — EXECUTE-CURSOR.md

The cursor records where `/ship-execute` is in its multi-wave pipeline so that:

1. **A `/loop` driver can advance one stage per tick.** Each invocation reads the cursor, dispatches to the matching stage handler, writes the cursor for the next tick, and exits with an explicit terminal signal when the sprint is complete.
2. **A direct user invocation runs end-to-end as a chain.** Same skill, same dispatch table — when not driven by `/loop`, handlers chain through until a user-input gate (AskUserQuestion) or the terminal stage. Ctrl-C interruption persists the cursor; next invocation resumes from the documented stage.
3. **Compaction recovery is structural.** The cursor's `stage:` field is authoritative; PROGRESS.md is confirmatory.

Coexists with HANDOFF.md: the cursor is for automatic per-tick advance; HANDOFF.md is for the user-initiated explicit pause with a hand-written note. Both can be present; HANDOFF.md takes precedence on resume only because the user wrote it deliberately.

## Cursor location and lifetime

`<SHIPYARD_DATA>/sprints/current/EXECUTE-CURSOR.md`

Lifetime is one sprint. Written on entry (if absent), updated after every stage transition, archived along with `current/` when the sprint completes.

## Frontmatter schema

```yaml
---
pipeline: ship-execute
sprint: sprint-001
stage: wave_2_dispatch                   # required; see stage map below
wave_number: 2                           # current wave index (when applicable)
iteration: 1                             # within-stage counter for self-looping stages
last_advance_at: 2026-05-18T17:58:00Z    # ISO 8601
loop_owner: "/loop"                      # or "user" or null
status: in_progress                      # in_progress | complete | escalated | paused
next_action: "Dispatch tasks T-007, T-008, T-009 in parallel"
terminal: false
stuck_counter: 0
hard_ceiling: 50
mode: subagent                           # solo | subagent | team
working_branch: main                     # from SPRINT.md frontmatter
auto_loop_attempted: true                # v2.3.0+ auto-loop bootstrap sentinel
pending_subagents:                       # v2.5.0+ background-dispatch tracking
  - task_id: T-007
    spawned_at: 2026-05-18T17:58:12Z
    max_execution_minutes: 60
  - task_id: T-008
    spawned_at: 2026-05-18T17:58:12Z
    max_execution_minutes: 60
---
```

**`pending_subagents` field semantics (v2.5.0+).** Populated when entering `wave_<N>_waiting` (background-dispatch mode). Each entry tracks one in-flight subagent. The `wave_<N>_waiting` handler drains entries as their `subagent_completed` events arrive in `.shipyard-events.jsonl`. When the list is empty, the cursor advances to `wave_<N>_recovery` for orchestrator-side gate verification. `max_execution_minutes` defaults to 60; override per task via `max_execution_minutes:` in the task's frontmatter. On expiry without an event, the task is marked `needs-attention` and removed from the list. Absent or empty in sync-mode (`--task`/`--hotfix`) cursors and in v2.4.0-or-older cursors — backward-compatible.

Body (one paragraph max):

> Free-form narrative of the last tick's outcome — what wave/tasks ran, what was decided, what the next tick should focus on. Read by the next tick's handler at entry. Keep under ~200 words.

## Stage map for ship-execute

| stage | What runs | On success → | On dirty / issue → |
|---|---|---|---|
| `preflight` | Lock acquisition, /goal-mode preflight gates, git repo check, status check (Check 1–7 silent) | `salvage` | escalate via AskUserQuestion |
| `salvage` | Step 0 — worktree salvage from interrupted sessions | `load` | escalate |
| `load` | Step 1 — load sprint plan, detect session type (fresh / resume / crash recovery) | `readiness` (fresh) or `wave_N_dispatch` (resume / recovery) | — |
| `readiness` | Step 1.5 — readiness check + AskUserQuestion (fresh-start only) | `wave_1_dispatch` | abort |
| `wave_N_dispatch` | Step 2 — dispatch all tasks in wave N. **Background mode (default v2.5.0+)**: spawn each `dispatching-task-loop` via `Agent(run_in_background: true)`, populate `pending_subagents`, arm Monitor on event log → `wave_N_waiting`. **Sync mode (`--task`/`--hotfix`)**: spawn synchronously, wait for all to return → `wave_N_boundary` (success) or `wave_N_redispatch_iter_K` (any BLOCKED) | `wave_N_waiting` (bg) / `wave_N_boundary` (sync) | `wave_N_redispatch_iter_K` for any `BLOCKED` returns (sync) |
| `wave_N_waiting` | v2.5.0+ — re-entered by each `/loop` tick while subagents run in background. Reads `.shipyard-events.jsonl` for `subagent_completed` events; drains `pending_subagents` as they arrive. Timeouts move tasks to `needs-attention`. | `wave_N_recovery` (when `pending_subagents` empty) | re-enter `wave_N_waiting` (partial), or `wave_N_recovery` (all done/timed-out) |
| `wave_N_recovery` | v2.5.0+ — reads each completed subagent's capture file, runs orchestrator-side gate (sha verify + probe re-execution + anti-stub-scan), aggregates verdicts. | `wave_N_boundary` (all clean) | `wave_N_redispatch_iter_K` (any BLOCKED or gate failure) |
| `wave_N_redispatch_iter_K` | Single-redispatch rule per task; K ∈ {1}. Redispatch is always SYNC (not background) — only one task, no parallelism win. | `wave_N_boundary` | `wave_N_boundary` (after K=1, mark the task `status: needs-attention` as a side effect and continue — there is no `needs_attention` stage) |
| `wave_N_boundary` | Step 4 (1–3) — rebase, ff-merge worktree branches, clean orchestrator branch, update PROGRESS.md `current_wave` | `wave_N_build` | escalate |
| `wave_N_build` | Step 4 (4) — wave-scoped build via `dispatching-operational-task` | `wave_N_refactor` | `wave_N_build_fix_iter_K` (bounded by capability skill's cap) |
| `wave_N_refactor` | Step 4 (5) — wave REFACTOR + MUTATE | `wave_N_tests` | log + continue (not a wave blocker) |
| `wave_N_tests` | Step 4 (6) — wave-scoped tests | `wave_N_verify` | `wave_N_tests_fix_iter_K` (single re-dispatch) |
| `wave_N_verify` | Step 4 (7) — `dispatching-spec-review` scope=wave | `wave_N_gate` | `wave_N_redispatch_iter_K` (per failing task, bounded) |
| `wave_N_gate` | Step 4 (8) — `verifying-wave-completion` (internal ScheduleWakeup state machine, budget 3) | `wave_N+1_dispatch` (if more waves) OR `sprint_full_build` (if last wave) | escalate via AskUserQuestion |
| `sprint_full_build` | Step 5 (1) — full build via `dispatching-operational-task` | `sprint_full_tests` | escalate |
| `sprint_full_tests` | Step 5 (2) — full suite | `sprint_demo_probes` | `sprint_tests_fix_iter_K` |
| `sprint_demo_probes` | Step 5 (3) — cross-task demo-probe re-verify on freshly-checked-out HEAD (skip-if-already-passed preflight) | `sprint_complete_gate` | escalate (demo probe failed) |
| `sprint_complete_gate` | Step 5 (4) — `evaluating-sprint-complete` (eight invariants; invariant 7 expected FAIL pre-review by design) | `terminal_handoff_to_review` | escalate (specific invariant failure surfaces details) |
| `terminal_handoff_to_review` | Mark SPRINT.md `status: completed`, `completed_at: <ISO>`; print "Sprint complete. /ship-review next." | — | — |

`hotfix` and `single_task` modes bypass the stage map:

| stage | What runs | On success → | On dirty / issue → |
|---|---|---|---|
| `hotfix` | Hotfix mode end-to-end (regression TDD cycle) | `terminal_hotfix` | escalate |
| `single_task` | `--task` mode: one task + wave REFACTOR+MUTATE+VERIFY for that single-task wave | `terminal_single_task` | escalate |
| `terminal_hotfix` | Print "Hotfix ready. Review with /ship-review --hotfix B-HOT-NNN" | — | — |
| `terminal_single_task` | Print "Task complete." | — | — |

## Terminal signal protocol

When a tick reaches a terminal stage (`terminal_handoff_to_review`, `terminal_hotfix`, `terminal_single_task`):

1. Write the cursor with `terminal: true`, `status: complete`, `next_action: "Sprint complete — handoff to /ship-review"` (or the analogous message).
2. Emit: `shipyard-data events emit pipeline_terminal pipeline=ship-execute sprint=<id> outcome=<success|escalated> reason=<short>`
3. **For `terminal_handoff_to_review` specifically, print the NEXT-UP handoff hint FIRST**, framed as a NEW, separately-started cycle — never as a continuation of this loop: **`▶ NEXT UP: /ship-review — a SEPARATE cycle you start yourself (tip: /clear first for a fresh window).`**
4. Print the literal stop marker as the **FINAL** line: **`▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.`**
5. Do not call `ScheduleWakeup` for the next tick, and at `terminal_handoff_to_review` do NOT chain into `/ship-review` within this invocation — the execute `/loop` ends here; `/ship-review` is the user's to start.
6. **Cron-fallback cleanup.** If this cycle emitted `pipeline_loop_bootstrap_fallback` (the `/loop`-went-silent path created a one-shot `*/2 * * * *` cron firing `/shipyard:ship-execute`), call `CronList` and `CronDelete` any cron whose prompt targets `/shipyard:ship-execute` before exiting. Skip when no fallback was emitted.

**Why the stop marker must be the LAST line (v2.8.2 — load-bearing).** The loop-driving model reads the LAST line as its continue-or-stop signal, so the `/loop should stop` marker **MUST be the final line**. Pre-v2.8.2 the order was inverted — `▶ NEXT UP: /ship-review` printed *after* the stop marker, so the driver's last-read line said "next up: review," which an over-eager driver reads as "keep going." Because the loop's prompt is hardwired to `/shipyard:ship-execute`, "keep going" re-fired execute against the now-completed/archived sprint — a leaked wakeup that fired "out of nowhere" after the user thought the cycle was done. Keep the NEXT-UP hint *before* the stop marker; `/ship-review` is a separate cycle the user starts, not a continuation of this loop.

## Mid-pipeline tick exit (non-terminal)

When a tick advances to a non-terminal next stage:

1. Write the cursor with the new `stage:`, incremented `last_advance_at:`, `terminal: false`, `next_action:`.
2. Emit: `shipyard-data events emit pipeline_tick_completed pipeline=ship-execute sprint=<id> stage=<previous> outcome=advanced next_stage=<new>`
3. Print: **`▶ TICK COMPLETE — wave [N]/[M], stage [X], next: [Z]. /loop continues.`**

## Self-looping stages: stuck detection

The only self-looping stages in ship-execute are `wave_N_redispatch_iter_K`, `wave_N_build_fix_iter_K`, `wave_N_tests_fix_iter_K`, and `sprint_tests_fix_iter_K`. Each has a `K` bound from the existing single-redispatch rule (K=1 is the cap; after K=1 the failing task moves to `needs-attention`). The wave gate (`wave_N_gate`) self-loops internally via `verifying-wave-completion`'s own ScheduleWakeup pattern (budget 3) — that machinery stays unchanged; the outer cursor sees a single `wave_N_gate` tick that either advances or escalates.

Because all self-loops are bounded by their capability-skill caps, the cursor-level `stuck_counter` mostly serves as a defense-in-depth observation:

- If a `wave_N_*` stage runs twice with `iteration: 1, 1` (re-entry without K increment), emit `pipeline_stuck pipeline=ship-execute wave=<N> stage=<X>` and surface a warning. This catches re-dispatch logic that fails to advance the iteration counter.
- `hard_ceiling: 50` is the absolute safety stop. Same semantics as ship-review.

## No-op terminal: already-completed sprint (+ loop-leak self-detection)

When `/ship-execute` is invoked and:
- The cursor exists with `terminal: true`, OR
- SPRINT.md frontmatter has `status: completed`, OR
- There is no active sprint in `current/` (already archived)

Treat as idempotent no-op:

1. **Emit the no-op terminal event FIRST — this is non-optional.** `shipyard-data events emit pipeline_terminal pipeline=ship-execute sprint=<id> outcome=noop reason=<sprint_already_complete | cursor_already_terminal>`. Emitting is mandatory, not best-effort: skipping it is exactly what made the original leak *invisible* — in the affected project the no-op terminal event had never once fired across the entire audit log, so a leaked wakeup left no trace and nobody could see the `/loop` was still alive. Always emit first, then (optionally) skip the cursor write (or write a transient terminal cursor if `current/` still exists).
2. **Repeat-leak check.** Before printing the stop marker, scan the recent event log for a PRIOR no-op terminal for this same sprint: `shipyard-context scan-events --tail 50 pipeline_terminal`, and count the lines carrying `outcome=noop` for this `sprint=<id>` (the line you just emitted in step 1 is included).
   - **First no-op** (count == 1): print **`▶ CYCLE COMPLETE — sprint already complete. /loop should stop.`** and exit.
   - **Repeat no-op** (count ≥ 2): the loop-driver IGNORED the earlier stop — this is a leaked wakeup firing `/shipyard:ship-execute` against a dead sprint. Emit `shipyard-data events emit pipeline_loop_leak_detected pipeline=ship-execute sprint=<id> noop_count=<N>` and print the HARD marker: **`⛔ LOOP LEAK — /loop is still firing /shipyard:ship-execute against an already-complete sprint (<N> no-op wakeups). It is NOT self-stopping. There is no further work — cancel this /loop now and do NOT schedule another wakeup.`** Then exit.
3. **Cron-fallback cleanup.** If this cycle emitted `pipeline_loop_bootstrap_fallback`, call `CronList` and `CronDelete` any cron whose prompt targets `/shipyard:ship-execute` before exiting — a one-shot fallback must not fire after terminal. Skip when no fallback was emitted.
4. Never call `ScheduleWakeup` on the no-op path, regardless of count.

**Structural backstop (you cannot route around this).** Even if a leaked wakeup ignores this sweep and tries to "fresh start," the `auto-approve-data.mjs` PreToolUse hook (`evaluateLoopLeakGuard`) **denies** any non-terminal EXECUTE-CURSOR write when there is no live sprint (`current/SPRINT.md` absent, or `status: completed`). So a phantom sprint start is impossible at the write layer — the correct response to a no-op is always: emit, mark stop, exit.

## Event vocabulary

| Event name | Fields | Emit when |
|---|---|---|
| `pipeline_tick_started` | `pipeline=ship-execute`, `sprint=<id>`, `stage=<id>`, `wave=<N>`, `iteration=<N>`, `loop_owner=<owner>` | At tick entry, after reading the cursor |
| `pipeline_tick_completed` | + `outcome=advanced|self_loop|escalated`, `next_stage=<id>` | At tick exit, before writing the cursor |
| `pipeline_terminal` | + `outcome=success|noop|escalated`, `reason=<short>` | When `terminal: true` is being written |
| `pipeline_loop_leak_detected` | `pipeline=ship-execute`, `sprint=<id>`, `noop_count=<N>` | On the no-op terminal path when a PRIOR no-op terminal for the same sprint already exists (a leaked wakeup that ignored the earlier stop) |
| `pipeline_stuck` | + `stage=<id>`, `wave=<N>`, `iterations=<N>`, `reason=re-entry-without-progress` | When `stuck_counter >= 5` |

Existing per-wave / per-task / sprint-completion events (`wave_check_passed`, `wave_check_escalated`, `task_loop_iteration`, `task_loop_completed`, `sprint_complete_passed`, etc.) continue to emit as documented elsewhere; the cursor-level events are additive.

## Cursor read at entry (skill body recipe)

Every ship-execute invocation begins with:

```
1. Acquire locks (existing `acquiring-skill-lock` capability skill).

2. Read <SHIPYARD_DATA>/sprints/current/EXECUTE-CURSOR.md (use the Read tool).
   - If file exists and `terminal: true`: print the terminal marker, emit
     pipeline_terminal with outcome=noop reason=cursor_already_terminal, exit.
   - If file exists and `terminal: false`: dispatch to the handler for the
     stage in the `stage:` field. Emit pipeline_tick_started first.
   - If file does NOT exist AND HANDOFF.md does NOT exist: fresh start.
     Set stage=preflight, iteration=1, terminal=false, status=in_progress.
     Emit pipeline_tick_started.
   - If file does NOT exist AND HANDOFF.md DOES exist: graceful resume from
     HANDOFF.md (existing path); after HANDOFF.md is consumed and deleted,
     write a cursor at the documented wave_N_dispatch stage.

3. After the chosen stage's handler returns, write the cursor for tick N+1
   (or for terminal exit). Emit pipeline_tick_completed (or pipeline_terminal).
   Print the appropriate marker text.
```

The cursor write is via the Write tool (auto-approved for SHIPYARD_DATA). Use the literal absolute path from `shipyard-context path`.

## Direct invocation vs /loop driver

Same as ship-review. Direct invocation chains handlers within a single invocation up to a ~10-minute wall-clock budget; `/loop` driver runs one handler per tick. Detection via the most recent `pipeline_tick_completed` event in `.shipyard-events.jsonl`: within 30 minutes + matching `next_stage` → `/loop` re-entry. Override via `--single-tick`.

## Interplay with verifying-wave-completion

`verifying-wave-completion` runs inside the `wave_N_gate` stage. Its internal ScheduleWakeup loop (budget 3, 180s warm-cache delay) handles RECOVERABLE invariants without exposing them to the outer pipeline cursor. From the cursor's perspective, `wave_N_gate` is one tick — it either returns `STATUS: COMPLETE` (cursor advances to next wave / sprint completion) or `STATUS: ESCALATED` (cursor sets `status: escalated`, surfaces to AskUserQuestion, does not advance).

This nested structure is intentional: micro-recovery for known invariant misses stays inside the wave gate; macro-flow across waves and stages stays in the outer cursor. Two layers, two pacers, no double-loop.
