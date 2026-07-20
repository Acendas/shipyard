# Pipeline Cursor — EXECUTE-CURSOR.md

The cursor records where `/ship-execute` is in its multi-wave pipeline so that:

1. **A `/loop` driver can advance one stage per tick.** Each invocation reads the cursor, dispatches to the matching stage handler, advances the cursor for the next tick, and exits with an explicit terminal signal when the sprint is complete.
2. **A direct user invocation runs end-to-end as a chain.** Same skill, same dispatch table — when not driven by `/loop`, handlers chain through until a user-input gate (AskUserQuestion) or the terminal stage. Ctrl-C interruption persists the cursor; next invocation resumes from the documented stage.
3. **Compaction recovery is structural.** The cursor's `stage:` field is authoritative; PROGRESS.md is confirmatory.

## The cursor is CLI-owned (v2.9.0)

**Never Write or Edit the cursor file.** The `auto-approve-data` PreToolUse hook denies any model Write/Edit to `EXECUTE-CURSOR.md`, `REVIEW-CURSOR.md`, `PROGRESS.md`, or `HANDOFF.md`. The single writer is `shipyard-data cursor`, which does in one atomic call what the pre-2.9 protocol asked the model to do in three:

```
shipyard-data cursor advance execute <stage> [k=v ...] [--note "<narrative>"]
```

1. Validates the stage transition against the machine-readable stage graph (`bin/pipeline-stages.mjs`, derived from the stage map below).
2. Runs the **loop-leak guard** and the **terminal-evidence gate** in-process — the same checks the v2.6.0/v2.8.2 hook enforced, now unavoidable at the only write path.
3. Appends the pipeline event (`pipeline_tick_completed` for non-terminal, `pipeline_terminal` for terminal stages) — the cursor and the event log can no longer disagree.
4. Atomically rewrites the cursor and re-renders PROGRESS.md.
5. Prints the tick/terminal marker. For terminals the stop marker is structurally the **final line** (the v2.8.2 handoff-seam rule, now enforced by construction).

**Exit 3 means refused**, with reasons on stderr: illegal transition, missing terminal evidence, or a loop-leak (no live sprint). Do not retry blindly — fix the missing evidence, or use `cursor escalate` / `cursor noop`. `--force` skips only the transition-graph validation (deliberate crash recovery); the evidence gates always run.

Settable `k=v` fields: `sprint`, `wave_number`, `iteration`, `loop_owner`, `status`, `next_action`, `mode`, `working_branch`, `stuck_counter`, `hard_ceiling`, `auto_loop_attempted`, `pending_subagents=<JSON array>`. Event-only: `outcome=`, `reason=`. Unset fields carry forward from the existing cursor; `wave_number`/`iteration` derive from the stage name automatically. `--note` sets the free-form narrative body (one paragraph, <200 words — what the last tick did, what the next should focus on).

The other subcommands:

- `shipyard-data cursor set execute k=v [...] [--note "…"]` — **field-only** update: no stage transition, no graph traversal, no gates, no tick events. Use it to set a frontmatter field without pretending to advance (the pre-v3.1 "same-stage advance just to set the sentinel" recipe was an illegal transition on every non-self-looping stage and polluted the log with a phantom tick). `stage` and `terminal` are not settable here.
- `shipyard-data cursor resume execute` — flips an **escalated or paused** cursor back to `status: in_progress` at the same recorded stage (`stuck_counter` reset, emits `pipeline_resumed`); refuses a complete terminal. This is the recovery path after fixing an escalation cause or picking up a pause.
- `shipyard-data cursor bootstrap-check execute` — the CLI-owned auto-loop eligibility computation. Prints `{"loop_owner":"/loop"|"user","eligible":<bool>,"reason":"…"}` and, when eligible, sets `auto_loop_attempted: true` itself and emits `pipeline_loop_bootstrap_eligible`. Replaces the entire model-side eligibility heuristic.
- `shipyard-data cursor pause execute --note "<why paused / resume context>"` — keeps the stage, sets `status: paused`, note becomes the cursor body, clears the execution lock. **This replaces HANDOFF.md** (retired in v2.9.0): one resume source, the paused cursor.
- `shipyard-data cursor escalate execute reason=<short>` — terminal escalation from any stage (`terminal: true`, `status: escalated`, emits `pipeline_terminal outcome=escalated`). Escalation is not a claim of success, so it bypasses the evidence gate by design. Resumable afterward via `cursor resume execute`.
- `shipyard-data cursor noop execute [sprint=<id>]` — the idempotent already-complete sweep (see below), and also the **wakeup-inert** sweep for a halted-but-recoverable cursor. On an **escalated** or **paused** terminal it does NOT treat the sprint as complete: it emits `pipeline_terminal outcome=noop reason=awaiting_user_escalated` / `reason=awaiting_user_paused`, prints the escalation/pause note + the "resume is a USER decision (`shipyard-data cursor resume execute`)" hint + the stop marker, and a 2nd wakeup against the same halted sprint trips the ⛔ leak alarm pointing at resume. A wakeup must NEVER auto-resume — resume is the user's call. When the cursor is genuinely complete/absent it prints the normal already-complete marker instead.

## Cursor location and lifetime

`<SHIPYARD_DATA>/sprints/current/EXECUTE-CURSOR.md`

Lifetime is one sprint. Created by the first `cursor advance execute preflight` (fresh start must be an entry stage: `preflight`, `hotfix`, or `single_task`), advanced after every stage transition, archived along with `current/` when the sprint completes.

## Frontmatter schema (rendered by the CLI — read-only reference)

```yaml
---
pipeline: ship-execute
sprint: sprint-001
stage: wave_2_dispatch                   # required; see stage map below
wave_number: 2                           # current wave index (when applicable)
iteration: 1                             # within-stage counter for self-looping stages
last_advance_at: 2026-05-18T17:58:00Z    # ISO 8601 — set by the CLI
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
---
```

**`pending_subagents` semantics (v2.5.0+).** Populated when entering `wave_<N>_waiting` (background-dispatch mode) via `pending_subagents='[{"task_id":"T-007",...}]'`. The `wave_<N>_waiting` handler drains entries as their `subagent_completed` events arrive in `.shipyard-events.jsonl` and passes the shrunken JSON on the next `cursor advance`. When empty, advance to `wave_<N>_recovery`. `max_execution_minutes` defaults to 60. On expiry without an event, mark the task `needs-attention` and remove it from the list.

## Stage map for ship-execute

The graph below is what `cursor advance` enforces (source of truth: `bin/pipeline-stages.mjs`).

| stage | What runs | On success → | On dirty / issue → |
|---|---|---|---|
| `preflight` | Lock acquisition, /goal-mode preflight gates, git repo check, status check (Check 1–7 silent) | `salvage` | escalate via AskUserQuestion |
| `salvage` | Step 0 — worktree salvage from interrupted sessions | `load` | escalate |
| `load` | Step 1 — load sprint plan, detect session type (fresh / resume / crash recovery) | `readiness` (fresh) or `wave_N_dispatch` (resume / recovery) | — |
| `readiness` | Step 1.5 — readiness check + AskUserQuestion (fresh-start only) | `wave_1_dispatch` | abort |
| `wave_N_dispatch` | Step 2 — dispatch all tasks in wave N. **Background mode (default v2.5.0+)**: spawn each `dispatching-task-loop` via `Agent(run_in_background: true)`, populate `pending_subagents`, arm Monitor on event log → `wave_N_waiting`. **Sync mode (`--task`/`--hotfix`)**: spawn synchronously, wait for all to return → `wave_N_boundary` (success) or `wave_N_redispatch_iter_K` (any BLOCKED) | `wave_N_waiting` (bg) / `wave_N_boundary` (sync) | `wave_N_redispatch_iter_K` for any `BLOCKED` returns (sync) |
| `wave_N_waiting` | v2.5.0+ — re-entered by each `/loop` tick while subagents run in background (self-loops). Reads `.shipyard-events.jsonl` for `subagent_completed` events; drains `pending_subagents`. Timeouts move tasks to `needs-attention`. | `wave_N_recovery` (when `pending_subagents` empty) | re-enter `wave_N_waiting` (partial) |
| `wave_N_recovery` | v2.5.0+ — reads each completed subagent's capture file, runs orchestrator-side gate (sha verify + probe-evidence validation + anti-stub-scan), aggregates verdicts. | `wave_N_boundary` (all clean) | `wave_N_redispatch_iter_K` (any BLOCKED or gate failure) |
| `wave_N_redispatch_iter_K` | Single-redispatch rule per task; K ∈ {1}. Redispatch is always SYNC. | `wave_N_boundary` | `wave_N_boundary` (after K=1, mark the task `status: needs-attention` and continue) |
| `wave_N_boundary` | Step 4 (1–3) — rebase, integration gate, ff-merge worktree branches, clean orchestrator branch | `wave_N_build` | escalate |
| `wave_N_build` | Step 4 (4) — wave-scoped build via `dispatching-operational-task` | `wave_N_refactor` | `wave_N_build_fix_iter_K` |
| `wave_N_refactor` | Step 4 (5) — wave REFACTOR + MUTATE | `wave_N_tests` | log + continue (not a wave blocker) |
| `wave_N_tests` | Step 4 (6) — wave-scoped tests | `wave_N_verify` | `wave_N_tests_fix_iter_K` |
| `wave_N_verify` | Step 4 (7) — `dispatching-spec-review` scope=wave | `wave_N_gate` | `wave_N_redispatch_iter_K` (per failing task, bounded) |
| `wave_N_gate` | Step 4 (8) — `verifying-wave-completion` (internal ScheduleWakeup state machine, budget 3) | `wave_N+1_dispatch` (wave must advance by exactly 1) OR `sprint_full_build` (last wave) | escalate via AskUserQuestion |
| `sprint_full_build` | Step 5 (1) — full build | `sprint_full_tests` | escalate |
| `sprint_full_tests` | Step 5 (2) — full suite | `sprint_demo_probes` | `sprint_tests_fix_iter_K` |
| `sprint_demo_probes` | Step 5 (3) — cross-task demo-probe re-verify on fresh HEAD | `sprint_complete_gate` | escalate (demo probe failed) |
| `sprint_complete_gate` | Step 5 (4) — `evaluating-sprint-complete` (eight invariants) | `terminal_handoff_to_review` | escalate |
| `terminal_handoff_to_review` | `sprint set status completed` + `sprint set completed_at <ISO>`; the CLI prints the handoff banner | — | — |

`hotfix` and `single_task` modes bypass the stage map (both are valid entry stages):

| stage | What runs | On success → |
|---|---|---|
| `hotfix` | Hotfix mode end-to-end (regression TDD cycle) | `terminal_hotfix` |
| `single_task` | `--task` mode: one task + wave REFACTOR+MUTATE+VERIFY | `terminal_single_task` |

## Terminal protocol

When a tick reaches a terminal stage:

1. For `terminal_handoff_to_review`: first flip the sprint lifecycle via `shipyard-data sprint set status completed` and `shipyard-data sprint set completed_at <ISO>`.
2. Run `shipyard-data cursor advance execute <terminal-stage> reason=<short>`. The CLI verifies the evidence chain (per-wave gate ticks, per-task evidence, `sprint_complete_passed`), emits `pipeline_terminal`, writes the terminal cursor, and prints the banner. **Per-task evidence accepts parked tasks:** a task with `task_dispatch_returned status=complete` satisfies its slot, and so does a *parked* task with a `task_blocked` event (or `task_dispatch_returned status=blocked`) — a sprint with needs-attention tasks CAN terminate and hand them to /ship-review. Only a task with NO evidence at all blocks the terminal — for `terminal_handoff_to_review` that is the `▶ NEXT UP: /ship-review …` hint followed by **`▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.`** as the structurally final line.
3. **Echo the CLI's marker lines as the final lines of user-facing output.** Do not print your own markers, do not add anything after the stop marker, and do NOT chain into `/ship-review` — it is a separate cycle the user starts.
4. Do not call `ScheduleWakeup` for the next tick.
5. **Cron-fallback cleanup.** If this cycle emitted `pipeline_loop_bootstrap_fallback`, call `CronList` and `CronDelete` any cron whose prompt targets `/shipyard:ship-execute` before exiting.

**Why the stop marker must be the LAST line (v2.8.2 — load-bearing).** The loop-driving model reads the LAST line as its continue-or-stop signal. Pre-v2.8.2 the NEXT-UP hint printed after the marker and a leaked wakeup re-fired execute against a completed sprint. The CLI now owns the ordering, so a skill body can't regress it — but the rule extends to the skill's own output: nothing prints after the CLI's stop marker.

## Mid-pipeline tick exit (non-terminal)

One call: `shipyard-data cursor advance execute <next-stage> next_action="<one line>" --note "<tick narrative>"`. The CLI emits `pipeline_tick_completed` (with `outcome=advanced` or `self_loop`) and prints `▶ TICK COMPLETE — wave [N], stage [X]. /loop continues.` Echo that as the final line. For a `wave_N_waiting` self-loop the tick marker also carries a "suggest next wakeup in 300s" pacing hint the `/loop` driver honors, so polling for background subagents doesn't hot-spin.

**Post-archive terminal seam.** A terminal advance run when there is NO cursor in `current/` (the sprint was already archived out from under a leaked wakeup) emits the terminal event + markers and writes nothing — there is no cursor to rewrite. This is the CLI's belt to the no-op sweep's suspenders.

## Self-looping stages: stuck detection

The only self-looping stages are `wave_N_waiting` and the bounded `*_fix_iter_K` / `wave_N_redispatch_iter_K` families (K caps from the capability skills). `stuck_counter` is **CLI-owned**: a same-stage self-loop advance **auto-increments** it (forgetting counts as stuck — the safe direction). Pass `stuck_counter=0` explicitly when the self-loop made real progress; a stage change always resets to 0. `wave_N_waiting` is exempt — polling with no new event is its normal state, so it carries the counter without incrementing (its stuck protection is the per-task timeout machinery). At `stuck_counter >= 5` the CLI emits `pipeline_stuck` and surfaces a warning (observational; the pipeline keeps running). At the `hard_ceiling: 50` self-loop safety stop the CLI **REFUSES** the advance (exit 3) and directs you to `shipyard-data cursor escalate execute reason=hard_ceiling_stage_<id>`.

## No-op terminal: already-completed sprint

When `/ship-execute` is invoked and the cursor is already `terminal: true`, OR SPRINT.md has `status: completed`, OR there is no active sprint in `current/`:

1. Run **`shipyard-data cursor noop execute sprint=<id-if-known>`** (default `reason=sprint_already_complete`, or `cursor_already_terminal` when a terminal cursor exists) and echo its output. The CLI emits `pipeline_terminal outcome=noop` FIRST (non-optional — a silent no-op is what made the v2.8.2 leak invisible), performs the repeat-leak scan itself, and on the 2nd no-op for the same sprint emits `pipeline_loop_leak_detected` and prints the hard `⛔ LOOP LEAK …` marker; otherwise it prints the stop marker.
2. **Cron-fallback cleanup** as in the terminal protocol. `cursor pause` / `escalate` / `noop` / terminal-advance each read the event log and print a cron-cleanup reminder line themselves when a `pipeline_loop_bootstrap_fallback` cron was armed (the reminder is computed from the LOG, not conversation memory) — act on it whenever printed.
3. Never call `ScheduleWakeup` on the no-op path.

**Structural backstop (you cannot route around this).** A leaked wakeup that tries to "fresh start" anyway hits two walls: the PreToolUse hook denies any model write to the cursor file, and `cursor advance` itself runs the loop-leak guard — a non-terminal advance with no live sprint exits 3.

## Event vocabulary

| Event name | Fields | Emitted by |
|---|---|---|
| `pipeline_tick_started` | `pipeline=ship-execute`, `sprint=<id>`, `stage=<id>`, `iteration=<N>`, `loop_owner=<owner>` | **CLI**, auto-emitted for the new stage on every non-terminal `cursor advance` (the model never emits it) |
| `pipeline_tick_completed` | + `outcome=advanced\|self_loop`, `next_stage=<id>`, `wave=<N>` | **CLI**, on every non-terminal `cursor advance` |
| `pipeline_terminal` | + `outcome=success\|noop\|escalated`, `reason=<short>` | **CLI**, on terminal `cursor advance` / `escalate` / `noop` |
| `pipeline_loop_leak_detected` | `pipeline=ship-execute`, `sprint=<id>`, `noop_count=<N>` | **CLI**, inside `cursor noop` on a repeat no-op |
| `pipeline_loop_bootstrap_eligible` | `pipeline=ship-execute`, `sprint=<id>`, `stage=<id>` | **CLI**, inside `cursor bootstrap-check` when it reports `eligible: true` |
| `pipeline_resumed` | `pipeline=ship-execute`, `sprint=<id>`, `stage=<id>`, `from_status=<escalated\|paused>` | **CLI**, on `cursor resume` |
| `pipeline_paused` | `pipeline=ship-execute`, `sprint=<id>`, `stage=<id>` | **CLI**, on `cursor pause` |
| `pipeline_stuck` | + `stage=<id>`, `wave=<N>`, `iterations=<N>`, `reason=re-entry-without-progress` | **CLI**, on a self-loop `cursor advance` at `stuck_counter >= 5` |

Existing per-wave / per-task / sprint-completion events (`wave_check_passed`, `task_dispatch_returned`, `sprint_complete_passed`, etc.) continue to be emitted via `events emit` as documented elsewhere — they are the evidence the terminal gate verifies.

## Cursor read at entry (skill body recipe)

```
1. Acquire locks (existing `acquiring-skill-lock` capability skill).

2. Read <SHIPYARD_DATA>/sprints/current/EXECUTE-CURSOR.md (Read tool — reads are fine).
   - `terminal: true`, `status: escalated` → a recoverable halt, NOT complete:
     run `shipyard-data cursor noop execute` (it prints the resume hint, no noop
     emit / no leak alarm), tell the user to fix the cause and
     `shipyard-data cursor resume execute`, exit.
   - `terminal: true` (any other status) → run `shipyard-data cursor noop execute`,
     echo output, exit.
   - `status: paused` → WAKEUP-INERT: a bare `/loop` wakeup runs
     `shipyard-data cursor noop execute` (emits
     `pipeline_terminal outcome=noop reason=awaiting_user_paused`, prints the
     pause note + resume hint + stop marker) and STOPS — never auto-resumes.
     Resume via `shipyard-data cursor resume execute` ONLY on an explicit
     user resume/continue; then the body note is the resume context and you
     dispatch to the handler for the `stage:` field.
   - Exists, non-terminal, in_progress → dispatch to the `stage:` handler.
   - Does NOT exist → fresh start: the first advance must target an entry
     stage (`preflight`, `hotfix`, `single_task`).

3. After the stage handler returns, advance via `shipyard-data cursor advance`
   (or `pause` / `escalate` / terminal advance). Echo the CLI's marker output
   as the final lines. The CLI auto-emits pipeline_tick_started for the new
   stage on every advance — the model never emits it.
```

## Direct invocation vs /loop driver

Same as ship-review. Direct invocation chains handlers within a single invocation up to a ~10-minute wall-clock budget; `/loop` driver runs one handler per tick. Detection is CLI-owned (`cursor bootstrap-check`) via the most recent `pipeline_tick_completed` event in `.shipyard-events.jsonl`: within a **5-minute** tick-recency window + matching `next_stage` → `/loop` re-entry (a staler tick reads as a dead loop, so the cron fallback re-arms and a Ctrl-C misclassification self-heals within 5 minutes). Override via `--single-tick`.

## Interplay with verifying-wave-completion

`verifying-wave-completion` runs inside the `wave_N_gate` stage. Its internal ScheduleWakeup loop (budget 3, 180s warm-cache delay) handles RECOVERABLE invariants without exposing them to the outer pipeline cursor. From the cursor's perspective, `wave_N_gate` is one tick — it either returns `STATUS: COMPLETE` (advance to next wave / sprint completion) or `STATUS: ESCALATED` (`cursor escalate`, surface via AskUserQuestion). Two layers, two pacers, no double-loop.
