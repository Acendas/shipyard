# Pipeline Cursor — REVIEW-CURSOR.md

The cursor records where `/ship-review` is in its multi-stage pipeline so that:

1. **`/goal` can re-enter one bounded stage at a time.**
2. **`--single-tick` can run one deterministic handler for testing/debugging.**
3. **Compaction recovery is structural.** The cursor's `stage:` field is authoritative; PROGRESS.md, verdicts, queue state, and artifacts are confirmatory/evidence surfaces.

## CLI-Owned Cursor

Never Read, Write, or Edit the cursor file directly from a skill body. Use `shipyard-context review-context` at entry or `shipyard-context cursor-state review` mid-session. The single writer is:

```
shipyard-data cursor advance review <stage> [k=v ...] [--note "<narrative>"]
```

The CLI validates the transition against `bin/pipeline-stages.mjs`, runs the stale-cycle guard and terminal-evidence gate, appends the pipeline event, rewrites the cursor atomically, re-renders PROGRESS.md, and prints the tick/terminal marker. Terminal markers are structurally final.

Settable `k=v` fields: `sprint`, `iteration`, `status`, `next_action`, `stuck_counter`, `hard_ceiling`. Event-only: `outcome=`, `reason=`.

Companions:

- `shipyard-data cursor set review k=v [...]` — field-only update; no transition, gates, or events.
- `shipyard-data cursor resume review` — flips an escalated/paused cursor back to `in_progress` at the same stage.
- `shipyard-data cursor pause review --note "<resume context>"` — `status: paused`, keeps the stage, and stops `/goal`.
- `shipyard-data cursor escalate review reason=<short>` — terminal escalation from any stage; not a success claim.
- `shipyard-data cursor noop review [sprint=<id>]` — idempotent no-work/awaiting-user sweep. Emits `pipeline_terminal outcome=noop` first, then repeated-noop detection.

## Frontmatter Schema

```yaml
---
pipeline: ship-review
sprint: sprint-001
stage: review_fix_wave_2
iteration: 2
last_advance_at: 2026-05-18T17:58:00Z
status: in_progress
next_action: "Dispatch review fix wave 2"
terminal: false
stuck_counter: 0
hard_ceiling: 50
---
```

## Stage Map

The graph is enforced by `bin/pipeline-stages.mjs`.

| stage | What runs | On success → | On issue → |
|---|---|---|---|
| `preflight` | branch check, mode detection | `review_scan`, `tests`, or `retro_step_1` | escalate |
| `review_scan` | read-only scanner wave, write REVIEW-FINDINGS.json | `review_plan` | escalate |
| `review_plan` | deterministic planner + queue enqueue | `review_fix_wave_1` or `review_validation` | escalate |
| `review_fix_wave_N` | flat fixer workers claim queued batches | next fix wave or `review_validation` | self-loop/requeue/escalate |
| `review_validation` | per-batch evidence, targeted probes, final build/test via ledger | `simplify` | `review_scan` |
| `code_review_iter_N` | legacy resume route only | `simplify` | self-loop |
| `simplify` | diff simplifier | `tests` | `tests` |
| `tests` | full suite | `spec_review` | self-loop |
| `spec_review` | spec review | `quality_gates`, `visual`, or `goal_verify` | gaps carried forward |
| `quality_gates` | standing gates | `visual` or `goal_verify` | gaps carried forward |
| `visual` | screenshot/visual verification | `goal_verify` | continue |
| `goal_verify` | observable goal verification | `gap_analysis` | gaps carried forward |
| `gap_analysis` | gap/self-review analysis | `critic` | self-loop |
| `critic` | critic agent | `final_pass` | `final_pass` |
| `final_pass` | process critic findings | `verdict` | `verdict` |
| `verdict` | write verdict artifacts | `demo_probe` | `demo_probe` |
| `demo_probe` | verify user-flow probes | `demo_user` | pause/escalate |
| `demo_user` | approval AskUserQuestion | `process_approved`, `process_issues`, or `process_changes` | pause |
| `process_approved` | feature statuses to done | `retro_decision` or `release_step_1` | — |
| `process_issues` | create bugs | `terminal_issues` | — |
| `process_changes` | create patch tasks | `terminal_changes` | — |
| `retro_decision` | retro choice | `retro_step_1` or `release_step_1` | pause |
| `retro_step_N` | retrospective | next retro step or `release_step_1` | pause |
| `release_step_N` | release/archive flow | next release step, `archive`, or `terminal` | pause/escalate |
| `archive` | archive without release | `terminal` | escalate |
| `terminal*` | terminal outcomes | — | — |

## Terminal Protocol

Run:

```
shipyard-data cursor advance review <terminal-stage> reason=<short>
```

The CLI verifies terminal evidence, emits `pipeline_terminal`, writes the terminal cursor, and prints `▶ CYCLE COMPLETE — pipeline terminal. /goal should stop.` as the final line. Echo the CLI output and print nothing after it.

`release_step_3`/`archive` run `archive-sprint` before terminal advance. If `current/` has already rotated away, a terminal advance with no cursor records the terminal event and writes no cursor file.

## Mid-Pipeline Tick Exit

For non-terminal stages:

```
shipyard-data cursor advance review <next-stage> next_action="<one line>" --note "<tick narrative>"
```

The CLI emits `pipeline_tick_completed`, auto-emits `pipeline_tick_started`, and prints `▶ TICK COMPLETE — stage <stage>. /goal continues.`. Echo it as the final line.

## Self-Looping Stages

`review_fix_wave_N`, legacy `code_review_iter_N`, `gap_analysis`, `tests`, and `release_step_1` are self-looping. `stuck_counter` is CLI-owned: self-loop advances auto-increment it unless `stuck_counter=0` is passed after real progress. At `stuck_counter >= 5`, the CLI emits `pipeline_stuck`; at `hard_ceiling`, it refuses further self-loops and directs to `cursor escalate`.

## No-Op Terminal

When `/ship-review` is invoked after archive or against a terminal/paused/escalated cursor:

```
shipyard-data cursor noop review sprint=<id-if-known>
```

The CLI emits `pipeline_terminal outcome=noop` first; emitting it is mandatory because it is the audit trace for an already complete or already archived invocation. A second noop for the same sprint/reason emits `pipeline_repeated_noop_detected` and prints `⛔ REPEATED NOOP …`. Paused/escalated noops print the resume hint; `/goal` must stop.

## Event Vocabulary

| Event name | Fields | Emitted by |
|---|---|---|
| `pipeline_tick_started` | `pipeline`, `sprint`, `stage`, `iteration` | CLI |
| `pipeline_tick_completed` | `pipeline`, `sprint`, `stage`, `outcome`, `next_stage` | CLI |
| `pipeline_terminal` | `pipeline`, `sprint`, `outcome`, `reason` | CLI |
| `pipeline_repeated_noop_detected` | `pipeline`, `sprint`, `noop_count` | CLI |
| `pipeline_paused` | `pipeline`, `sprint`, `stage` | CLI |
| `pipeline_stuck` | `pipeline`, `sprint`, `stage`, `iterations`, `reason` | CLI |
| `pipeline_resumed` | `pipeline`, `sprint`, `stage`, `from_status` | CLI |

Review-specific artifacts (`REVIEW-FINDINGS.json`, `REVIEW-FIX-PLAN.json`, worker result JSON, verdicts, captures) are the evidence surfaces used by stages and gates.
