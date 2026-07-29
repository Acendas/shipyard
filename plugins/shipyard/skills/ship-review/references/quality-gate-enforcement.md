# Stage 1.5: Quality Gate Enforcement

After tests and spec review (Stage 1), before visual verification (Stage 2), dispatch verification tasks per quality gate from the sprint's manifest.

## When to Run

- After Stage 1b (spec review) completes
- Before Stage 2 (visual verification)
- **Skip if** `<SHIPYARD_DATA>/sprints/current/QUALITY-GATE.md` does not exist or both sections are empty

## Procedure

### 1. Read Manifest

Read `<SHIPYARD_DATA>/sprints/current/QUALITY-GATE.md`. Parse:
- Standing Gates table
- Sprint-Specific Gates table
- Integration Gates table (if present)

Collect all gates with `Status: pending`.

### 2. Process Probe Gates

For each gate with `Verification: probe`:
- Extract the probe command from the gate description or linked test_commands key.
- **Satisfied by evidence, when the gate names a `test_commands.<tier>` key.** A gate whose command is one of `test_commands.unit`/`.integration`/`.e2e` (the same tiers Stage 1a and `/ship-execute`'s `sprint_full_tests` stage already run against this exact commit) does NOT need a third execution. Run `shipyard-data verify check --key test_commands.<tier> --command "<resolved command>"` FIRST:
  - **Exit 0 (FRESH)** — satisfied by evidence. Do not dispatch anything for this gate. Write `Status: pass` with an **Evidence** entry (see "Write Results Back") naming the tree-id prefix, the recorded capture path, and which stage produced it (Stage 1a or `/ship-execute`'s `sprint_full_tests`).
  - **Exit 3 (STALE)** — no reusable proof; dispatch as below, same as any other probe gate.
- **Otherwise** (a gate-specific probe command with no `test_commands` key match — there is no other producer whose evidence could apply): follow the `dispatching-operational-task` playbook with the probe command directly, no ledger lookup.
- On a fresh dispatch: capture the result (exit code, output tail). If it names a `test_commands.<tier>` key and passes, run `shipyard-data verify record --key test_commands.<tier> --command "<resolved command>" --exit 0 --capture <capture path>` so a later gate, tick, or the release gate can reuse it.
- Update gate `Status`: `pass` (exit 0) or `fail` (exit non-zero).

### 3. Process Tool Gates

For each gate with `Verification: tool`:
- The tool reference is stored in the gate row.
- **Same satisfied-by-evidence path as probe gates** when the tool reference matches a `test_commands.<tier>` key — `verify check` first, satisfied on FRESH, dispatch + `verify record` on STALE.
- **Otherwise**, follow the `dispatching-operational-task` playbook with the tool command directly, no ledger lookup.
- Capture and update Status same as probe gates.

### 4. Collect Manual Gates

Manual gates cannot be auto-verified. Collect them into a checklist to present in Stage 5 (Demo to User). Do not attempt to verify them here.

### 5. Write Results Back

Use Edit to update QUALITY-GATE.md `Status` column for each processed gate, and populate a new **Evidence** column (append `| Evidence |` to the header and a separator cell to every existing row the first time this runs against a manifest generated before this column existed — `/ship-sprint`'s generator does not emit it, Stage 1.5 is the sole writer):

- `pending` → `pass` or `fail` for probe/tool gates.
- **Satisfied by evidence** (ledger FRESH, no dispatch happened): `Evidence: tree=<12-char prefix> capture=<recorded capture path> via=<producing stage — "Stage 1a" or "/ship-execute sprint_full_tests">`.
- **Freshly dispatched** (ledger STALE, or no `test_commands` key to check against): `Evidence: capture=<this dispatch's capture path> via=quality_gates`.
- Manual gates remain `pending` until Stage 5; leave `Evidence` blank.

**Never drop a gate row, satisfied-by-evidence or not.** An absent row is indistinguishable from a gate that was never evaluated — this is what keeps the audit trail richer than before rather than thinner: every gate now carries both a Status AND the Evidence that produced it, where previously the evidence (which run, which capture) existed only in that run's transient tool output and vanished once the tick ended.

### 6. Gate Failure Handling

- **Probe/tool gate FAIL**: Create a patch task using the same gap-classification logic as Stage 4. The patch task's `acceptance_probe` is the gate's probe command. Route through `dispatching-task-loop`.
- **Manual gate**: Deferred to Stage 5 human checklist. No action here.
- **>50% of probe/tool gates fail**: Render the per-gate results as chat text first (gate ID, type, command, pass/fail — the QUALITY-GATE.md content and operational-task returns do not count as shown until printed), then AskUserQuestion: "Over half the quality gates failed ([N] of [M]). Continue review or abort? (continue — address in Stage 4 / abort — fix gates first)"
- **All gates pass**: Proceed to next stage. Emit event: `quality_gates_passed sprint=<id> standing=<n> sprint_specific=<n> integration=<n>`

## Cursor Advance

On completion, advance the CLI-owned cursor (never Write REVIEW-CURSOR.md directly — the PreToolUse hook denies it; the CLI emits `pipeline_tick_completed` and prints the tick marker):
- If UI features exist: `shipyard-data cursor advance review visual --note "Run Stage 2 visual verification"`
- If no UI features: `shipyard-data cursor advance review goal_verify --note "Run Stage 3 goal verification"`

Echo the CLI's output as the final lines of the tick.

## Event Log

Emit structured events for observability:
```
shipyard-data events emit quality_gate_result gate_id=SG-1 gate_type=standing verification=probe status=pass
shipyard-data events emit quality_gate_result gate_id=SSG-2 gate_type=sprint_specific verification=manual status=pending
shipyard-data events emit quality_gate_result gate_id=SG-3 gate_type=standing verification=probe status=pass satisfied_by=evidence
shipyard-data events emit quality_gates_completed sprint=<id> passed=N failed=N manual_pending=N
```

A gate satisfied by ledger evidence rather than a fresh dispatch adds `satisfied_by=evidence` to its `quality_gate_result` event — this is what lets `/ship-status` and the audit trail distinguish "we verified this again" from "we reused a still-fresh proof" without re-reading QUALITY-GATE.md's Evidence column.
> `type` is reserved by the event emitter for the positional event type (here
> `quality_gate_result`). Passing `type=<value>` as a field is preserved under
> `type_field` and never overrides the event type — use a distinct key like
> `gate_type=` for the gate classification.
