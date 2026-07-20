# Live progress streaming (wrap the dispatch)

`dispatching-task-loop`'s subagents emit `task_loop_iteration` events per iteration from inside their own contexts. By default the orchestrator does NOT surface that mid-loop work, leaving the user with minutes of silence per wave while subagents churn. To close the gap, wrap each wave's per-task dispatch with a backgrounded `tail -f` on the event log and attach `Monitor` so events surface in the user's chat as they fire.

Immediately before dispatching the first task of the wave:

```
# Start the live-progress streamer. Captures events appended during this wave's dispatch.
bg = Bash(
    run_in_background: true,
    command: "tail -f -n 0 <SHIPYARD_DATA>/.shipyard-events.jsonl | "
             "grep --line-buffered -E '(task_loop_iteration|subagent_dispatched|subagent_returned|wave_check_passed|wave_check_failed)'"
)
Monitor(bg.task_id)   # each matching JSONL line surfaces as a notification
```

After the wave's dispatch returns (all task verdicts collected):

```
TaskStop(bg.task_id)  # ends the tail-f and the Monitor together
```

Apply this wrap at every stage that dispatches subagents: `wave_<N>_dispatch`, `wave_<N>_redispatch_iter_<K>`, and `sprint_tests_fix_iter_<K>`.

Skip stages without subagent dispatch (preflight, salvage, load, readiness, boundary, refactor, tests, verify, gate). The `verify` and `tests` stages already have their own Monitor wired via `dispatching-operational-task` for stream-vs-capture verify runs (commit `de5c0c8`) — do not double-wrap.

The streamer is cheap: `tail -f -n 0` starts at EOF (no historical replay), `grep --line-buffered` flushes line-by-line, JSONL events are tens of bytes each. Negligible per tick.
