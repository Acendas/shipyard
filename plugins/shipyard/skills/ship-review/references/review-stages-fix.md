# Review stages: fix planning, fix waves, validation, simplification

Moved verbatim from SKILL.md; cursor, stage order and gates stay there.

## Stage 0b: Review Fix Planning

Run the deterministic planner:

```
shipyard-data review plan <SHIPYARD_DATA>/sprints/current/REVIEW-FINDINGS.json --out <SHIPYARD_DATA>/sprints/current/REVIEW-FIX-PLAN.json
```

Read the generated plan. It contains `batches`, `waves`, and a `validation_ladder`. This CLI-owned clustering is the batching authority; do not regroup findings by hand. A clean plan (`counts.findings_actionable == 0`) skips directly to `review_validation`. Otherwise, dispatch the first wave. Emit `shipyard-data events emit review_fix_plan_written sprint=<id> batches=<N> waves=<N>`.

Enqueue the fix batches immediately after writing the plan:

```
shipyard-data queue enqueue --pipeline ship-review --stage review_fix_wave --input <SHIPYARD_DATA>/sprints/current/REVIEW-FIX-PLAN.json
```

The queue maps each batch into its concrete `review_fix_wave_<N>` stage from the plan's `waves`. The queue is the dispatch authority for Stage 0c; do not maintain a second hand-written pending-batches list in cursor prose.

- **Cursor advance**: clean plan → `shipyard-data cursor advance review review_validation --note "No actionable review fix batches"`; dirty plan → `shipyard-data cursor advance review review_fix_wave_1 iteration=1 --note "Dispatch review fix wave 1"`.

## Stage 0c: Review Fix Waves

Read `<SHIPYARD_DATA>/sprints/current/REVIEW-FIX-PLAN.json`. Before dispatching, run:

```
shipyard-data queue requeue-stale --pipeline ship-review --stage review_fix_wave_<N>
shipyard-data queue list --pipeline ship-review --stage review_fix_wave_<N>
```

Spawn one fixer worker per batch (the agent hook holds the `execution.max_agents` limit, default 100 alive at once). **Model + effort (fixer):** Run `shipyard-data resolve-model fixer` — it prints exactly one line `model=<m> effort=<e>`; pass each value as a string on the Agent call and OMIT any field whose value is empty (inherit). Never hardcode a model literal or re-derive the tier from config.md by hand. Log it once: `shipyard-data events emit dispatch_model_resolved role=<role> model=<model or inherit> effort=<effort>` (a logging failure never blocks the dispatch). Each worker claims exactly one batch:

```
Agent(
      subagent_type: "general-purpose",
      model: <model= from resolve-model fixer; omit if empty>,
      effort: <effort= from resolve-model fixer; omit if empty>,
      prompt: <single review-fix worker prompt below>)
```

```
shipyard-data queue claim --pipeline ship-review --stage review_fix_wave_<N> --worker <worker-id>
```

If `claimed=false`, the worker exits. If `claimed=true`, the worker fixes only that batch directly in this worker context, writes the expected result artifact, then calls `shipyard-data queue complete <batch-id> --pipeline ship-review --stage review_fix_wave_<N> --worker <worker-id> --result <absolute-artifact-path>` or `shipyard-data queue fail <batch-id> --pipeline ship-review --stage review_fix_wave_<N> --worker <worker-id> --reason "<short reason>"`. The worker returns only batch id, status, and artifact path. It must not spawn another Agent, invoke `/goal`, or call a capability skill as a nested dispatcher.

Each claimed batch uses the same structured gate shape as `dispatching-task-loop`, but no nested Agent dispatch:

- `task_id`: the batch id, e.g. `review-fix-1`
- finding ids: the batch's `findings`
- file scope: the batch's `files`
- acceptance probes: the batch's `required_probes`
- continuation note: "Fix all findings in this review batch, commit once, and run the listed per-batch probes before returning."

The batch fixer must commit once per batch and write a JSON result artifact containing at least `batch_id`, `status`, `commit_sha`, `probe_exit_code`, `output_tail`, and `capture_file` at the queue item's `expected_artifact` path (relative paths resolve under `<SHIPYARD_DATA>/sprints/current/`). `queue complete` refuses malformed, mismatched, misplaced, or missing-capture artifacts and records `artifact_status` from the JSON. Stage 0c accepts only `artifact_status: COMPLETE`; `artifact_status: BLOCKED` is a valid returned contract but remains a blocked batch. Do not run the full build/test suite after each batch; only run the batch's required probes. Emit `shipyard-data events emit review_fix_batch_returned sprint=<id> batch=<id> wave=<N> status=<complete|blocked> commit_sha=<sha>`.

**Severe/risky exception.** Pause-before-ask only when a batch would require a destructive migration, irreversible data rewrite, credential/security-policy choice, large dependency/platform change, ambiguous product/spec tradeoff, or knowingly shipping a degraded behavior. Ordinary multi-file or tedious fixes stay in the batch wave.

**Stuck detection:** `review_fix_wave_N` self-loops only when at least one batch could not be accepted and a redispatch is possible. Pass `stuck_counter=0` when the blocked set changed; otherwise let the CLI increment. At `stuck_counter >= 5`, **Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-autofix.md` § Stuck warning and follow it (the non-blocking stuck warning protocol). At the hard ceiling, run `shipyard-data cursor escalate review reason=hard_ceiling_stage_review_fix_wave`.

- **Cursor advance**: more queue items remain in later waves → `shipyard-data cursor advance review review_fix_wave_<N+1> iteration=<N+1> stuck_counter=0 --note "Dispatch review fix wave <N+1>"`; all queued fix batches are `complete` with `artifact_status: COMPLETE` → `shipyard-data cursor advance review review_validation --note "Run review validation ladder"`. Any `artifact_status: BLOCKED`, failed, or non-idempotent stale queue item that cannot be safely requeued escalates instead of advancing. For a non-idempotent stale queue item, run `queue retry-stale` only when replay is explicitly safe; otherwise run `queue park-stale` with the reason and escalate.

## Stage 0d: Review Validation Ladder

Read `REVIEW-FIX-PLAN.json`. Validate in layers:

1. Per-batch probes were already run by each accepted fixer; verify the return evidence and capture paths.
2. Run each command in `validation_ladder.wave_boundary` once, not per finding.
3. Run the full build/test commands only once here, unless the verify ledger proves a fresh pass for the exact current tree. Use `shipyard-data verify check` before dispatching and `shipyard-data verify record` after a pass.
4. Re-run the scanner wave only if validation fails or a fixer touched files outside its batch scope.

Emit `shipyard-data events emit review_validation_completed sprint=<id> targeted=<N> final=<N> status=<pass|fail>`.

- **Cursor advance**: pass → `shipyard-data cursor advance review simplify --note "Run Stage 0.5 simplification"`; fail → `shipyard-data cursor advance review review_scan stuck_counter=0 --note "Re-scan after validation failure"`.

## Legacy Stage 0: Code Review Loop

This route remains legal for resuming older cursors and for compatibility with installed data from earlier versions. Fresh full reviews use `review_scan → review_plan → review_fix_wave_N → review_validation` instead. When resuming `code_review_iter_N`, follow the legacy mechanics in `references/scanner-dispatch.md`, including `code_review_iteration` and `code_review_escalated` events.

## Stage 0.5: Code Simplification

Skip if `--skip-code-review` is passed (same gate as Stage 0).

After Stage 0 exits clean, spawn a general-purpose simplifier subagent (inline prompt — no external-plugin dependency) against the sprint diff to clean up quick patches the fixer may have introduced. **Model + effort (simplifier):** Run `shipyard-data resolve-model simplifier` — it prints exactly one line `model=<m> effort=<e>`; pass each value as a string on the Agent call and OMIT any field whose value is empty (inherit). Never hardcode a model literal or re-derive the tier from config.md by hand. Log it once: `shipyard-data events emit dispatch_model_resolved role=<role> model=<model or inherit> effort=<effort>` (a logging failure never blocks the dispatch). Scope-guarded to sprint-diff files only — reverts via `git reset --hard HEAD~1` if the simplifier touches unexpected files. Mechanics (including the model and effort rules) in `references/scanner-dispatch.md`.

- **Cursor advance**: on completion (success or logged-and-continue), run `shipyard-data cursor advance review tests --note "Run Stage 1a full test suite via dispatching-operational-task"`.
