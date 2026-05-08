# Operational Tasks

**Status:** This reference is superseded by the **`shipyard:dispatching-operational-task`** capability skill. See `skills/dispatching-operational-task/SKILL.md` for the full contract.

## What this reference used to cover

Pre-2.0, ship-execute embedded the full operational-task dispatch protocol here: how to resolve `verify_command` (literal or `test_commands.e2e`-style config-key reference), how to capture output via `shipyard-logcap`, how to parse findings into in-scope fixes vs out-of-scope patch tasks (capped at `operational_tasks.max_patch_tasks`), the iteration budget (`operational_tasks.max_iterations`, default 3), and the post-subagent gate (verify_output populated, capture file non-empty, final exit:0).

## What replaces it in 2.0

The `shipyard:dispatching-operational-task` capability skill encodes the same protocol with these structural improvements:

- Dispatched via `subagent_type: "general-purpose"` (no registered `shipyard-test-runner` agent — addresses CC-1).
- Plain `tee` to `<SHIPYARD_DATA>/captures/<task_id>/run-<N>.log`. No `shipyard-logcap` dependency on the basic path.
- Three Iron Laws inlined in the subagent prompt: NO COMPLETION CLAIM WITHOUT exit-0 CAPTURE; NO STUB FIXES (xfail-without-reason, swallowed errors); NO SCOPE CREEP.
- Orchestrator-side gate adds a `LAST_LINES:`-vs-capture-file-tail check that catches subagent fabrication.

## Migration

Any caller previously reading "Step N of references/operational-tasks.md" should now read the corresponding section of `skills/dispatching-operational-task/SKILL.md`. Routing decisions (kind: feature vs operational vs research) still live in ship-execute's per-task dispatch step.

This file is scheduled for full deletion in a future cleanup; it remains as a thin redirect during the transition window so external docs and skill references resolving here don't 404.
