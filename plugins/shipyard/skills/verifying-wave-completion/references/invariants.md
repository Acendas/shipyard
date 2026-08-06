# Wave-Completion Invariants — Detailed Reference

Six invariants, each with PASS / RECOVERABLE / ESCALATE verdicts. Recovery actions per RECOVERABLE state are bounded by the wakeup budget passed to the skill (default 3 wakeups at 180s — see `../../dispatching-operational-task/references/schedule-wakeup-discipline.md`).

The deterministic primitives that back these checks live in the `shipyard-context` CLI — using them instead of inline git/jq prose makes the verdicts script-verifiable.

## Invariant 1 — All dispatched builders returned a structured contract

**What it checks.** For each task ID in `task_ids`, the event log contains at least one structured-return event (`task_loop_iteration` for in-progress proof of life, `task_dispatch_returned` for the final return) since `wave_base_sha`.

**Primitive.**

```text
shipyard-context scan-events --tail 500 task_loop_iteration task_dispatch_returned
```

Parse the JSONL output; group by `task` field; for each expected task ID, confirm at least one event present.

**Verdicts.**

- **PASS** — every expected task ID has a return event.
- **RECOVERABLE** — one or more task IDs have no return event (subagent died mid-flight, orchestrator timed out). Recovery: dispatch a fresh `dispatching-task-loop` for each missing task with `continuation_note: "previous attempt did not return"`.
- **ESCALATE** — all builders missing returns despite multiple wakeups; structural problem with subagent dispatch. Halt.

## Invariant 2 — Every claimed commit is integrated, none orphaned

**What it checks.** Every task that returned `status="complete"` had its commit (a) integrated into the working branch and (b) never left dangling. This is verified through the wave-integration gate rather than a raw `commit_sha ∈ wave_base..wave_head` test: the wave-boundary integration *rebases* worktree branches, which rewrites the returned SHA, so the original SHA is legitimately NOT an ancestor of `wave_head` after a clean integration. Checking the raw SHA would false-positive a re-dispatch on already-integrated work — and miss the real failure (a torn-down worktree whose commit never merged), which is what the v2.8 incident hit.

**Primitive.**

```text
# Evidence the pre-teardown gate passed for this wave (emitted by ship-execute Step 4 item 1):
shipyard-context scan-events --tail 500 wave_integration_verified wave_integration_failed
# Fresh cross-check — Check B still holds post-teardown via the shipyard/keep-* anchors:
shipyard-data verify-wave-integrated   # exit 0 = clean; exit 3 = un-integrated or dangling
```

`verify-wave-integrated` proves, over git ground truth (never the unreliable `worktreeBranch` field): every live `shipyard/wt-*` branch is merged into the working branch, AND every `COMPLETE` subagent-return commit is reachable from the working branch, a live worktree branch, or its `shipyard/keep-*` anchor. The `task_commit_anchored` ref written at dispatch-return is what keeps a rebased or torn-down commit reachable.

**Verdicts.**

- **PASS** — a `wave_integration_verified` event exists for this wave AND a fresh `verify-wave-integrated` exits 0.
- **RECOVERABLE** — `verify-wave-integrated` exits 3 naming an un-integrated `shipyard/wt-*` branch (the merge-back didn't run for it). Recovery: rebase + ff-merge the named branch, re-run the gate. If a return SHA is dangling but its task is still in flight, re-check after the next wakeup.
- **ESCALATE** — `verify-wave-integrated` reports a dangling return commit reachable from nothing tracked (lost work — the v2.8 orphaning symptom), or repeated un-integrated branches across recovery attempts. Halt and surface the task / SHA list.

## Invariant 3 — Wave-boundary verify-probe passes

**What it checks.** `wave_probe_exit_code == 0` AND `wave_probe_capture` is non-empty AND its last 50 lines show a real verdict line (not just startup noise).

**Primitive.** Direct Read on the capture file plus the exit code parameter. There's no separate CLI primitive — the check is just file inspection.

Flake detection: if exit code is non-zero with a failure pattern matching common-flake signatures (timeout, "intermittent", retry-then-pass), dispatch a fresh `dispatching-operational-task` to re-run the same verify command. If the second run passes AND its failure pattern differs from the first, treat as flaky.

**Verdicts.**

- **PASS** — exit 0 + non-empty capture + visible verdict.
- **RECOVERABLE** — non-zero exit with a recognized flake signature. Recovery: re-run the verify command via `dispatching-operational-task`. If second run passes, emit `wave_check_flake_suspected` (per the event catalog) and mark this invariant PASS for advancement purposes.
- **ESCALATE** — non-zero on second run. The regression is real.

## Invariant 4 — Gate-recorded completion for every task

**What it checks.** For each task in `task_ids`, the event log contains a `task_dispatch_returned` event with `status="complete"` (kind:feature — emitted by the orchestrator gate in `dispatching-task-loop` after sha verify + anti-stub-scan pass) or an `operational_task_completed` event (kind:operational) since `wave_base_sha`. This is the record that the *orchestrator gate* ran and accepted the return — not merely that the builder claimed completion. (No `task_loop_completed` event exists; nothing emits it.)

**A parked task counts as settled, not missing.** A task with a `task_blocked` event (or `task_dispatch_returned status=blocked`) exhausted its redispatch budget and was deliberately handed to review — that is a legitimate wave outcome. Invariant 4 requires every task to be *settled*, not every task to *complete*; do not treat a parked task as a missing completion and do not re-dispatch it here.

**Primitive.**

```text
shipyard-context scan-events --tail 500 task_dispatch_returned task_blocked subagent_completed operational_task_completed
```

**Verdicts.**

- **PASS** — every task is settled: a gate-recorded completion event, OR a `task_blocked` / `task_dispatch_returned status=blocked` parking record.
- **RECOVERABLE** — a task has a builder-side `subagent_completed` event with `status=complete` (and its `.subagent-returns/<task>.json` exists) but no `task_dispatch_returned` — the orchestrator gate never ran on the return (e.g., a crashed recovery tick). Recovery: run the orchestrator gate now on the `.json` (per `dispatching-task-loop`'s "Orchestrator-Side Parsing and Gating": sha verify, anti-stub-scan, anchor-commit), then emit `task_dispatch_returned … recovered=true`. Self-healing — gate, emit, advance.
- **ESCALATE** — no gate record AND no builder-side return (`subagent_completed` / `.json` both absent) — task never finished. Re-dispatch.

## Invariant 5 — No silent-failure or loop-detected markers in window

**What it checks.** No events of type `silent_failure`, `loop_detected`, `operational_task_bogus_pass`, or `anti_stub_finding` in the wave's event-log window.

**Primitive.**

```text
shipyard-context scan-events --tail 500 silent_failure loop_detected operational_task_bogus_pass anti_stub_finding
```

Filter the output to events with timestamps after `wave_base_sha`'s corresponding wave-start event.

**Verdicts.**

- **PASS** — no markers in the window.
- **RECOVERABLE** — a marker with a `task_id` that's still in flight (race: marker emitted while subagent was finishing). Recovery: re-check after the next ScheduleWakeup; the in-flight task will have settled by then.
- **ESCALATE** — one or more confirmed markers tied to completed tasks. Do NOT advance the wave. Render each confirmed marker (event type, task_id, and payload fields) as chat text, then AskUserQuestion — `scan-events` output is a tool result the user never saw.

## Invariant 6 — No un-integrated or uncommitted builder worktree

**What it checks.** After the wave-boundary integration + teardown: (a) no `shipyard/wt-*` worktree branch still carries commits not in the working branch, and (b) no surviving `shipyard/wt-*` worktree has uncommitted changes. Part (a) is the orphaning guard — a worktree torn down before its branch merged is exactly how the v2.8 incident lost six commits; part (b) is the original dirty-tree check. **(c) In-place mode (isolation off):** there are no `shipyard/wt-*` worktrees, so (a)/(b) pass vacuously — but the shared working tree can still carry a failed builder's residue. When the wave ran with isolation off, ALSO assert `shipyard-context check-dirty-tree` is empty; a dirty main tree is a real leftover the wt-scoped check cannot see.

**Primitive.**

```text
shipyard-data verify-wave-integrated     # part (a): every live wt branch merged; exit 3 lists offenders
shipyard-context check-dirty-worktrees   # part (b): one path per dirty shipyard/wt-* worktree; empty = clean
shipyard-context check-dirty-tree        # part (c), isolation-off only: porcelain of the main working tree; empty = clean
```

Invariants 2 and 6 share the `verify-wave-integrated` primitive — run it once and read its verdict for both: Check A (worktree branches merged) feeds invariant 6(a), Check B (no dangling return commit) feeds invariant 2.

**Verdicts.**

- **PASS** — `verify-wave-integrated` exits 0 (or vacuously passes because the worktrees were already torn down past a recorded `wave_integration_verified` event) AND `check-dirty-worktrees` is empty AND (isolation off) `check-dirty-tree` is empty.
- **RECOVERABLE** — uncommitted state matching a recognized salvage pattern (next session's Step 0 worktree-salvage handles it). Recovery: emit `wave_check_worktree_leftover` and proceed; the next session recovers.
- **ESCALATE** — an un-integrated worktree branch (Check A fail), or uncommitted state that looks like in-flight work rather than stale salvage. Halt and surface.

## Aggregation

After running all six invariants, aggregate:

```text
All PASS                 → emit wave_check_passed; return STATUS: COMPLETE.
Any ESCALATE             → emit wave_check_escalated; return STATUS: ESCALATED.
Otherwise (RECOVERABLE)  → dispatch each invariant's recovery action;
                           emit wave_check_recoverable;
                           ScheduleWakeup, re-enter the skill.
```

After `wakeup_budget` exhausted with RECOVERABLE still outstanding: emit `wave_check_escalated` with `reason: "exhausted_wakeup_budget"`, return ESCALATED.
