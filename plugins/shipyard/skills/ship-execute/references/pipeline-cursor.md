# Pipeline Cursor — EXECUTE-CURSOR.md

The cursor records where `/ship-execute` is in its multi-wave pipeline so that:

1. **`/goal` can re-enter one bounded stage at a time.** Each invocation reads the cursor, dispatches the matching handler, advances the cursor, and exits with an explicit marker.
2. **Single-tick/debug invocations are deterministic.** `--single-tick` runs one handler and stops after the cursor advance.
3. **Compaction recovery is structural.** The cursor's `stage:` field is authoritative; PROGRESS.md is confirmatory.

## CLI-Owned Cursor

Never Read, Write, or Edit the cursor file directly from a skill body. Use `shipyard-context sprint-execution` at entry or `shipyard-context cursor-state execute` mid-session. The single writer is:

```
shipyard-data cursor advance execute <stage> [k=v ...] [--note "<narrative>"]
```

The CLI validates the transition against `bin/pipeline-stages.mjs`, runs the stale-cycle guard and terminal-evidence gate, appends the pipeline event, rewrites the cursor atomically, re-renders PROGRESS.md, and prints the tick/terminal marker. Terminal markers are structurally final.

Exit 3 means refused: illegal transition, missing terminal evidence, stale-cycle guard, or hard ceiling. Do not retry blindly; fix the missing evidence, `cursor escalate`, or `cursor noop`.

Settable `k=v` fields: `sprint`, `wave_number`, `iteration`, `status`, `next_action`, `mode`, `working_branch`, `stuck_counter`, `hard_ceiling`, `pending_subagents=<JSON array>`. Event-only: `outcome=`, `reason=`.

Other subcommands:

- `shipyard-data cursor set execute k=v [...] [--note "…"]` — field-only update; no transition, gates, or events.
- `shipyard-data cursor resume execute` — flips an escalated or paused cursor back to `status: in_progress` at the same recorded stage.
- `shipyard-data cursor pause execute --note "<why paused / resume context>"` — keeps the stage, sets `status: paused`, clears the execution lock, and stops `/goal`.
- `shipyard-data cursor escalate execute reason=<short>` — terminal escalation from any stage; bypasses success evidence because it is not a success claim.
- `shipyard-data cursor noop execute [sprint=<id>]` — idempotent already-complete or awaiting-user sweep. It emits `pipeline_terminal outcome=noop` first, then repeated-noop detection.

## Frontmatter Schema

```yaml
---
pipeline: ship-execute
sprint: sprint-001
stage: wave_2_dispatch
wave_number: 2
iteration: 1
last_advance_at: 2026-05-18T17:58:00Z
status: in_progress
next_action: "Dispatch tasks T-007, T-008, T-009"
terminal: false
stuck_counter: 0
hard_ceiling: 50
mode: task
working_branch: main
pending_subagents:
  - task_id: T-007
    worker_id: builder-T-007
    spawned_at: 2026-05-18T17:58:12Z
    max_execution_minutes: 60
---
```

`pending_subagents` is a progress mirror for wave waiting/recovery. Queue ledger and result artifacts are authority. An advance into `wave_N_dispatch` replaces the list; `wave_N_waiting` self-loops carry it forward.

## Stage Map

The graph is enforced by `bin/pipeline-stages.mjs`.

| stage | What runs | On success → | On issue → |
|---|---|---|---|
| `preflight` | locks, goal-mode gates, git/status checks | `salvage` | escalate |
| `salvage` | worktree salvage | `load` | escalate |
| `load` | load sprint plan / resume state | `readiness` or `wave_N_dispatch` | — |
| `readiness` | readiness check + possible AskUserQuestion | `wave_1_dispatch` | pause/escalate |
| `wave_N_dispatch` | enqueue wave tasks and spawn flat queue workers | `wave_N_waiting` or `wave_N_boundary` | `wave_N_redispatch_iter_K` |
| `wave_N_waiting` | reconcile queue/events/artifacts for background workers | `wave_N_recovery` | self-loop |
| `wave_N_recovery` | gate worker artifacts and aggregate verdicts | `wave_N_boundary` | `wave_N_redispatch_iter_K` |
| `wave_N_redispatch_iter_K` | single redispatch per task | `wave_N_boundary` | mark needs-attention, continue |
| `wave_N_boundary` | rebase, integration, ff-merge, cleanup | `wave_N_build` | escalate |
| `wave_N_build` | wave build | `wave_N_refactor` | `wave_N_build_fix_iter_K` |
| `wave_N_refactor` | refactor/mutate pass | `wave_N_tests` | log + continue |
| `wave_N_tests` | wave tests | `wave_N_verify` | `wave_N_tests_fix_iter_K` |
| `wave_N_verify` | spec review scope=wave | `wave_N_gate` | `wave_N_redispatch_iter_K` |
| `wave_N_gate` | `verifying-wave-completion` evidence gate | next wave or `sprint_full_build` | escalate |
| `sprint_full_build` | full build | `sprint_full_tests` | pause/escalate |
| `sprint_full_tests` | full suite | `sprint_demo_probes` | `sprint_tests_fix_iter_K` |
| `sprint_demo_probes` | user-flow probes | `sprint_complete_gate` | pause/escalate |
| `sprint_complete_gate` | sprint complete predicate | `terminal_handoff_to_review` | escalate |
| `terminal_handoff_to_review` | status completed + handoff marker | — | — |

`hotfix` and `single_task` are valid entry stages and terminate at `terminal_hotfix` / `terminal_single_task`.

## Terminal Protocol

Before `terminal_handoff_to_review`, set sprint status and completion timestamp through `shipyard-data sprint set`. Then run:

```
shipyard-data cursor advance execute terminal_handoff_to_review outcome=success reason=sprint_complete
```

The CLI verifies terminal evidence, emits `pipeline_terminal`, writes the terminal cursor, prints `▶ NEXT UP: /ship-review …`, then prints `▶ CYCLE COMPLETE — pipeline terminal. /goal should stop.` as the final line. Echo the CLI output verbatim and print nothing after it.

Do not chain into `/ship-review`; review is a separate cycle.

## Mid-Pipeline Tick Exit

For non-terminal stages:

```
shipyard-data cursor advance execute <next-stage> next_action="<one line>" --note "<tick narrative>"
```

The CLI emits `pipeline_tick_completed`, auto-emits `pipeline_tick_started` for the new stage, and prints `▶ TICK COMPLETE — ... /goal continues.`. Echo it as the final line.

For `wave_N_waiting`, the marker may include a bounded-wait hint for background workers. Queue state and artifacts decide completion; notifications are advisory.

## Self-Looping Stages

Self-loop advances are bounded by the CLI. `stuck_counter` auto-increments on self-looping stages unless the caller passes `stuck_counter=0` after real progress; `wave_N_waiting` is exempt while workers are still proving liveness. At `stuck_counter >= 5`, the CLI emits `pipeline_stuck`. At `hard_ceiling: 50`, the CLI refuses further self-loops and directs to `cursor escalate`.

## No-Op Terminal

When `/ship-execute` is invoked and the cursor is already terminal, SPRINT.md is `status: completed`, or there is no active sprint:

```
shipyard-data cursor noop execute sprint=<id-if-known>
```

The CLI emits `pipeline_terminal outcome=noop` first; emitting it is mandatory because it is the audit trace for an already complete or already archived invocation. A second noop for the same sprint/reason emits `pipeline_repeated_noop_detected` and prints `⛔ REPEATED NOOP …`. Otherwise it prints `▶ CYCLE COMPLETE — sprint already complete. /goal should stop.`

## Event Vocabulary

| Event name | Fields | Emitted by |
|---|---|---|
| `pipeline_tick_started` | `pipeline`, `sprint`, `stage`, `iteration` | CLI |
| `pipeline_tick_completed` | `pipeline`, `sprint`, `stage`, `outcome`, `next_stage`, `wave` | CLI |
| `pipeline_terminal` | `pipeline`, `sprint`, `outcome`, `reason` | CLI |
| `pipeline_repeated_noop_detected` | `pipeline`, `sprint`, `noop_count` | CLI |
| `pipeline_resumed` | `pipeline`, `sprint`, `stage`, `from_status` | CLI |
| `pipeline_paused` | `pipeline`, `sprint`, `stage` | CLI |
| `pipeline_stuck` | `pipeline`, `sprint`, `stage`, `iterations`, `reason` | CLI |

Existing wave/task/sprint evidence events continue to be emitted by the relevant stage handlers and are verified by the terminal gate.

## Entry Recipe

1. Acquire locks through the bundled `shipyard-context sprint-execution`.
2. Use `SHIPYARD_CURSOR_*` fields. Do not parse cursor files by hand.
3. If terminal, paused, escalated, completed, or archived, run `cursor noop` and stop.
4. Otherwise dispatch the handler for `SHIPYARD_CURSOR_STAGE`, or start fresh at `preflight`.
5. Advance, pause, escalate, or terminal-advance through `shipyard-data cursor`.

`/goal` is the only autonomous re-entry driver. `--single-tick` runs one handler and stops.
