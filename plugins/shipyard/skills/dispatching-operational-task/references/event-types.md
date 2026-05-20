# Shipyard Event-Log Catalog

The structured event log at `<SHIPYARD_DATA>/.shipyard-events.jsonl` is Shipyard's machine-readable observability surface. Hooks and skills emit events via `shipyard-data events emit <type> [k=v ...]`; readers consume via `shipyard-context scan-events --tail N <type1> [type2 ...]`, `shipyard-context diagnose`, or direct Read/Grep on the JSONL file.

This catalog is the single source of truth for event types. When emitting an event from a skill, use a name from this catalog or extend the catalog first — drift between skills is what this doc exists to prevent.

## Canonical envelope

Every event is one JSON line with at minimum these fields:

```jsonc
{
  "type": "<event_type>",     // from the catalog below
  "timestamp": "<ISO 8601>",  // set by shipyard-data events emit
  // ... type-specific fields (always native JSON types — numbers as numbers,
  //     booleans as booleans, so jq can filter without re-parsing)
}
```

The `events emit` CLI handles timestamp injection and JSON-encoding of `k=v` arguments (`count=3` becomes `"count":3`, `sprint="S001"` becomes `"sprint":"S001"`).

## Catalog

Grouped by emitter. Within each group, listed alphabetically.

### Emitted by `dispatching-task-loop` (subagent context)

| Event type | When | Fields | Consumers |
|---|---|---|---|
| `task_loop_iteration` | Each internal iteration of the per-task /goal loop | `task` (str), `iteration` (int), `probe_exit` (int) | `/ship-status` (trajectory render), `verifying-wave-completion` (invariant 1) |
| `task_loop_completed` | Subagent returns `STATUS: COMPLETE` | `task` (str), `commit_sha` (str), `iterations_run` (int) | `verifying-wave-completion` (invariant 4), `evaluating-sprint-complete` (invariant 1) |
| `task_dispatch_returned` | Orchestrator records the structured return regardless of status | `task` (str), `status` ("complete" \| "blocked"), `escalation_code` (str \| null) | `verifying-wave-completion` (invariant 1) |

### Emitted by `dispatching-operational-task` (subagent context)

| Event type | When | Fields | Consumers |
|---|---|---|---|
| `operational_iteration` | Each Phase 1+2 cycle | `task` (str), `iteration` (int), `exit` (int), `findings` (int) | `/ship-status` |
| `operational_task_completed` | Subagent returns `STATUS: COMPLETE` with exit:0 capture | `task` (str), `verify_output` (str), `iterations_run` (int) | `verifying-wave-completion` (invariant 4), `evaluating-sprint-complete` (invariant 1) |
| `operational_task_bogus_pass` | Orchestrator-side gate catches false-pass — capture missing, empty, or non-zero | `task` (str), `reason` (str) | `evaluating-sprint-complete` (invariant 5) |

### Emitted by `/ship-review`

| Event type | When | Fields | Consumers |
|---|---|---|---|
| `code_review_iteration` | Each pass of the Stage 0 multi-scanner + fixer loop | `sprint` (str), `iteration` (int), `must_fix` (int), `should_fix` (int) | `/ship-status` |
| `code_review_escalated` | Iteration cap hit with residual must-fix items | `sprint` (str), `residual_must_fix` (int) | User-visible via AskUserQuestion |
| `stage_0_skipped` | Stage 0 cannot run for a documented reason (empty diff, explicit flag) | `sprint` (str), `reason` (str) | Terminal-gate diagnostic; retro |
| `patch_task_created` | Stage 4 / Stage 6 files a patch task for the user to pick up | `sprint` (str), `task_id` (str), `feature` (str), `source` (str) | Terminal-gate (review path: terminal_changes / terminal_issues require ≥1) |
| `bug_created` | `/ship-review` Stage 6 records an in-scope bug entry | `sprint` (str), `bug_id` (str), `feature` (str) | Terminal-gate (same as patch_task_created) |

### Emitted by `verifying-wave-completion`

| Event type | When | Fields | Consumers |
|---|---|---|---|
| `wave_check_started` | At entry | `wave` (int), `task_ids` (array), `base_sha` (str), `head_sha` (str) | `/ship-status` |
| `wave_check_iteration` | Per recovery iteration | `wave` (int), `iteration` (int), `invariants_pass` (array), `invariants_recoverable` (array), `invariants_escalate` (array) | `/ship-status` |
| `wave_check_passed` | All six invariants green | `wave` (int), `iterations_run` (int) | `/ship-execute` (resume protocol, last-clean-checkpoint), `evaluating-sprint-complete` (invariant 5 — absence of escalated) |
| `wave_check_recoverable` | One or more invariants RECOVERABLE; iterating | `wave` (int), `iteration` (int), `invariant` (int), `recovery_action` (str) | `/ship-status` |
| `wave_check_escalated` | Halting; un-recoverable invariant or budget exhausted | `wave` (int), `invariant` (int), `reason` (str) | `evaluating-sprint-complete` (invariant 5) |
| `wave_check_flake_suspected` | Invariant 3 second-run differs from first | `wave` (int), `first_capture` (str), `second_capture` (str) | Retro / `/ship-review` |
| `wave_check_worktree_leftover` | Invariant 6 stale worktree | `wave` (int), `worktree_path` (str) | Next-session worktree salvage |

### Emitted by `evaluating-sprint-complete`

| Event type | When | Fields | Consumers |
|---|---|---|---|
| `sprint_complete_check_started` | At entry | `sprint_id` (str), `base_sha` (str), `head_sha` (str) | `/ship-status` |
| `sprint_complete_passed` | All seven invariants green | `sprint_id` (str) | `/ship-execute` step 4 (flips sprint to `completed`) |
| `sprint_complete_failed` | Any invariant red | `sprint_id` (str), `invariants_failed` (array) | User-visible via AskUserQuestion |

### Emitted by `/ship-execute`

| Event type | When | Fields | Consumers |
|---|---|---|---|
| `sprint_goal_preflight_failed` | Any /goal pre-flight gate refuses entry | `gate` (str), `sprint` (str) | User-visible halt message |
| `verify_flaky_suspected` | Subagent returns `ESCALATION_CODE: verify_flaky` | `task` (str), `probe_output_first` (str), `probe_output_second` (str) | `bisect-flaky`-style narrowing, retro |
| `pipeline_tick_completed` | Each pipeline-cursor stage transition completes a tick | `pipeline` (str — "ship-execute" or "ship-review"), `sprint` (str), `stage` (str — current stage_id), `outcome` (str — "advanced" \| "self_loop"), `next_stage` (str) | Terminal-gate (execute: requires per-wave `wave_<N>_gate` ticks; review: requires `demo_user` tick) |
| `pipeline_terminal` | Pipeline writes its terminal cursor (success or escalated) | `pipeline` (str), `sprint` (str), `outcome` (str — "success" \| "issues" \| "changes" \| "escalated"), `reason` (str) | Loop-stop signal; retro |
| `acceptance_probe_completed` | After every probe invocation (per-task or per-feature) by `running-acceptance-probe`'s caller | `feature` (str, optional — set for demo probes), `task` (str, optional — set for task probes), `probe_type` ("task" \| "demo"), `exit_code` (int), `verdict` ("PASS" \| "FAIL" \| "TIMEOUT" \| "ERROR"), `skipped` (bool, optional, true for `skip-with-reason`) | `evaluating-sprint-complete` Invariant 8; `/ship-review` Stage 4.8 skip-if-already-passed preflight |

### Emitted by hooks (`auto-approve-data`, `worktree-branch`)

| Event type | When | Fields | Consumers |
|---|---|---|---|
| `silent_failure` | Anti-stub-scan or similar guard catches a swallowed error | `task` (str), `pattern` (str) | `evaluating-sprint-complete` (invariant 5), `verifying-wave-completion` (invariant 5) |
| `loop_detected` | Edit-loop / repeated-fix detector trips | `task` (str), `pattern_count` (int) | Same as above |
| `anti_stub_finding` | Anti-stub-scan finds a stub in claimed-complete diff | `task` (str), `file` (str), `line` (int), `confidence` (number) | Same as above |

## Extending the catalog

When adding a new event type:

1. Pick a name that mirrors an existing pattern (`<area>_<verb>` is the convention — `wave_check_passed`, `task_loop_iteration`, not generic verbs).
2. List it here with emitter, fields, and consumers.
3. If multiple skills will emit the same type (rare — usually each event has one emitter), document why.
4. Numbers and booleans must pass through as native JSON types via the `events emit` CLI's `k=v` parsing, not as strings.
5. Update consumers — if a new event would be useful to `/ship-status`, add a render line for it.

## Querying

Three ways to read the log:

```bash
# Tail filtered to specific types (the canonical primitive used by verifying-* skills).
shipyard-context scan-events --tail 200 wave_check_passed wave_check_escalated

# Full diagnostic dump (used in bug reports).
shipyard-context diagnose

# Raw file (when ad-hoc queries are needed; `jq` works because fields are native JSON).
jq -c 'select(.type == "task_loop_iteration") | {task, iteration, probe_exit}' \
  <SHIPYARD_DATA>/.shipyard-events.jsonl
```

The file is capped at 5000 lines / 1 MB via the `shipyard-data events emit` write path — old entries rotate out. Long-lived consumers should not rely on events older than ~1 day on an active project.
