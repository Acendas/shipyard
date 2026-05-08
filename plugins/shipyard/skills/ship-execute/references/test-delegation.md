# Test Delegation

**Status:** This reference is superseded by the **`shipyard:dispatching-operational-task`** capability skill. See `skills/dispatching-operational-task/SKILL.md` for the full contract.

## What this reference used to cover

Running tests inline in the orchestrator pollutes its context with hundreds of lines of raw test output and accelerates auto-compaction. This reference described a `shipyard-test-runner` registered agent that captured output via `shipyard-logcap` and returned a structured summary.

## What replaces it in 2.0

`dispatching-operational-task` encodes the same behavior as a capability skill:

- Dispatched via `subagent_type: "general-purpose"` (no registered agent — addresses CC-1's customer report).
- Captures stdout+stderr via plain `tee` to `<SHIPYARD_DATA>/captures/<task_id>/run-<N>.log`. No `shipyard-logcap` dependency for the basic path.
- Two-phase loop: run + capture (Phase 1), then fix-findings if exit ≠ 0 (Phase 2), bounded by `max_iterations` (default 3).
- Orchestrator-side gate verifies `verify_output:` populated, capture file exists and non-empty, and the final `verify_history` entry has `exit: 0`. The `LAST_LINES:` content is matched against the capture-file tail to catch fabrication.

## Migration

Any caller previously dispatching `shipyard:shipyard-test-runner` should now invoke `shipyard:dispatching-operational-task` with `verify_command` resolved to the test command (e.g., `test_commands.unit` from config). One operational dispatch per tier; the orchestrator parses the structured verdict.

This file is scheduled for full deletion in Sprint 4 per F-43; it remains as a thin redirect during the transition window so that older references resolving this path don't 404.
