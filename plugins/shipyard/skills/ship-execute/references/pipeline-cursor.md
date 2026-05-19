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
---
```

Body (one paragraph max):

> Free-form narrative of the last tick's outcome — what wave/tasks ran, what was decided, what the next tick should focus on. Read by the next tick's handler at entry. Keep under ~200 words.

## Stage map for ship-execute

| stage | What runs | On success → | On dirty / issue → |
|---|---|---|---|
| `preflight` | Lock acquisition, /goal-mode preflight gates, git repo check, status check (Check 1–7 silent) | `salvage` | escalate via AskUserQuestion |
| `salvage` | Step 0 — worktree salvage from interrupted sessions | `load` | escalate |
| `load` | Step 1 — load sprint plan, detect session type (fresh / resume / crash recovery) | `readiness` (fresh) or `wave_N_dispatch` (resume / recovery) | — |
| `readiness` | Step 1.5 — readiness check + AskUserQuestion (fresh-start only) | `wave_1_dispatch` | abort |
| `wave_N_dispatch` | Step 2 — dispatch all tasks in wave N via `dispatching-task-loop` / `dispatching-operational-task` / `dispatching-research-task` per kind; wait for all to return | `wave_N_boundary` | `wave_N_redispatch_iter_K` for any `BLOCKED` returns |
| `wave_N_redispatch_iter_K` | Single-redispatch rule per task; K ∈ {1} | `wave_N_boundary` | `wave_N_needs_attention` (after K=1, mark needs-attention and continue) |
| `wave_N_boundary` | Step 4 (1–3) — rebase, ff-merge worktree branches, clean orchestrator branch, update PROGRESS.md `current_wave` | `wave_N_build` | escalate |
| `wave_N_build` | Step 4 (4) — wave-scoped build via `dispatching-operational-task` | `wave_N_refactor` | `wave_N_build_fix_iter_K` (bounded by capability skill's cap) |
| `wave_N_refactor` | Step 4 (5) — wave REFACTOR + MUTATE | `wave_N_tests` | log + continue (not a wave blocker) |
| `wave_N_tests` | Step 4 (6) — wave-scoped tests | `wave_N_verify` | `wave_N_tests_fix_iter_K` (single re-dispatch) |
| `wave_N_verify` | Step 4 (7) — `dispatching-spec-review` scope=wave | `wave_N_gate` | `wave_N_redispatch_iter_K` (per failing task, bounded) |
| `wave_N_gate` | Step 4 (8) — `verifying-wave-completion` (internal ScheduleWakeup state machine, budget 3) | `wave_N+1_dispatch` (if more waves) OR `sprint_full_build` (if last wave) | escalate via AskUserQuestion |
| `sprint_full_build` | Step 5 (1) — full build via `dispatching-operational-task` | `sprint_full_tests` | escalate |
| `sprint_full_tests` | Step 5 (2) — full suite | `sprint_complete_gate` | `sprint_tests_fix_iter_K` |
| `sprint_complete_gate` | Step 5 (3) — `evaluating-sprint-complete` (seven invariants; invariant 7 expected FAIL pre-review by design) | `terminal_handoff_to_review` | escalate (specific invariant failure surfaces details) |
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
3. Print the literal marker: **`▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.`**
4. For `terminal_handoff_to_review` specifically, also print: **`▶ NEXT UP: /ship-review (tip: /clear first for a fresh window)`** — this is the existing handoff message, kept after the terminal marker.
5. Do not call `ScheduleWakeup` for the next tick.

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

## No-op terminal: already-completed sprint

When `/ship-execute` is invoked and:
- The cursor exists with `terminal: true`, OR
- SPRINT.md frontmatter has `status: completed`, OR
- There is no active sprint in `current/` (already archived)

Treat as idempotent no-op:

1. Skip the cursor write (or write a transient terminal cursor if `current/` still exists).
2. Emit: `shipyard-data events emit pipeline_terminal pipeline=ship-execute sprint=<id> outcome=noop reason=sprint_already_complete`
3. Print: **`▶ CYCLE COMPLETE — sprint already complete. /loop should stop.`**
4. Exit cleanly.

## Event vocabulary

| Event name | Fields | Emit when |
|---|---|---|
| `pipeline_tick_started` | `pipeline=ship-execute`, `sprint=<id>`, `stage=<id>`, `wave=<N>`, `iteration=<N>`, `loop_owner=<owner>` | At tick entry, after reading the cursor |
| `pipeline_tick_completed` | + `outcome=advanced|self_loop|escalated`, `next_stage=<id>` | At tick exit, before writing the cursor |
| `pipeline_terminal` | + `outcome=success|noop|escalated`, `reason=<short>` | When `terminal: true` is being written |
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

Same as ship-review. Direct invocation chains handlers within a single invocation up to a ~3-minute wall-clock budget; `/loop` driver runs one handler per tick. Detection via the most recent `pipeline_tick_completed` event in `.shipyard-events.jsonl`: within 30 minutes + matching `next_stage` → `/loop` re-entry. Override via `--single-tick`.

## Interplay with verifying-wave-completion

`verifying-wave-completion` runs inside the `wave_N_gate` stage. Its internal ScheduleWakeup loop (budget 3, 180s warm-cache delay) handles RECOVERABLE invariants without exposing them to the outer pipeline cursor. From the cursor's perspective, `wave_N_gate` is one tick — it either returns `STATUS: COMPLETE` (cursor advances to next wave / sprint completion) or `STATUS: ESCALATED` (cursor sets `status: escalated`, surfaces to AskUserQuestion, does not advance).

This nested structure is intentional: micro-recovery for known invariant misses stays inside the wave gate; macro-flow across waves and stages stays in the outer cursor. Two layers, two pacers, no double-loop.
