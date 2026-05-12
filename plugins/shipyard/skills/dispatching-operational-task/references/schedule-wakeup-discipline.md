# ScheduleWakeup Discipline

Any skill that schedules a wakeup (the wave-completion verifier, long-probe pollers, deferred re-checks, any caller of the `ScheduleWakeup` tool) picks its delay against the **5-minute prompt-cache TTL**. Sleeping past 300s burns the entire conversation context on the next read — slower and more expensive than reasoning about the sleep length up front.

## Picking `delaySeconds`

| Delay window | When to use | Why |
|---|---|---|
| 60–270s | Watching a build, polling for state about to change, immediately-following verify-run | Cache stays warm; no per-wake re-read cost |
| 1200s–3600s | Genuinely idle; nothing to check sooner than ~20 min; long-running CI or external job | Pay the cache miss once, amortize across one long wait |

**Don't pick 300s.** Worst-of-both — pay the cache miss without amortizing it. If tempted to "wait 5 minutes," drop to 270s (cache stays warm) or commit to 1200s+ (one miss buys a long wait).

For dispatch loops with no specific external signal to watch, default to **1200–1800s** (20–30 min) per wake. Three wakeups at 270s burns no cache and gives ~13 minutes of active watching; three wakeups at 1800s buys ~90 minutes of idle waiting. Pick the shape that matches what's actually being waited on, not a round-number minute.

The `delaySeconds` argument to `ScheduleWakeup` is clamped to `[60, 3600]` by the runtime, so no caller-side clamping is needed — but pick within that range deliberately.

## Writing the `reason` field

The `reason` field on the wakeup goes to telemetry and is shown to the user. Make it specific (`"polling wave-3 verify probe"`, not `"waiting"`) so the user can interrupt cleanly if a delay surprises them.

## Pattern: budgeted-recovery loop

When a capability skill needs N recovery attempts before escalating (the wave-completion verifier is the canonical example), the natural shape is:

```text
wakeup_budget = 3        # cap on attempts before escalation
wakeup_delay  = 180      # warm-cache window per wakeup

Iteration 0: run the check now (no wake).
For 1..wakeup_budget:
  if check passed → return COMPLETE.
  ScheduleWakeup(delaySeconds: wakeup_delay, reason: "<specific>", prompt: re-enter).
After wakeup_budget exhausted: emit *_check_escalated event, return ESCALATED.
```

Three iterations at 180s costs no cache misses and gives 9 minutes of recovery time — long enough for most state to settle (a stuck builder, a slow merge-back), short enough that the user doesn't notice the delay if they're actively at the keyboard.

If the signal being waited on is genuinely slow (>20 min CI runs, external dependency that takes minutes to recover), prefer a **single** 1800s wakeup over multiple shorter ones. Pay the cache miss once.

## Pattern: heartbeat events

A user checking on a running /goal sprint via `/ship-status` should see life signs. If your skill polls via ScheduleWakeup, emit a heartbeat event per wake (`shipyard-data events emit <skill>_iteration ...`) so the event-log surface shows the loop is still running and not silently stuck.

The event-log catalog (`event-types.md` in this references directory) documents the canonical event names per skill — use those, don't invent new ones inline.
