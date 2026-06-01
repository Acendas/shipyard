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
- Extract the probe command from the gate description or linked test_commands key
- Invoke `shipyard:dispatching-operational-task` with the probe command
- Capture the result (exit code, output tail)
- Update gate `Status`: `pass` (exit 0) or `fail` (exit non-zero)

### 3. Process Tool Gates

For each gate with `Verification: tool`:
- The tool reference is stored in the gate row
- Invoke `shipyard:dispatching-operational-task` with the tool command
- Capture and update Status same as probe gates

### 4. Collect Manual Gates

Manual gates cannot be auto-verified. Collect them into a checklist to present in Stage 5 (Demo to User). Do not attempt to verify them here.

### 5. Write Results Back

Use Edit to update QUALITY-GATE.md `Status` column for each processed gate:
- `pending` → `pass` or `fail` for probe/tool gates
- Manual gates remain `pending` until Stage 5

### 6. Gate Failure Handling

- **Probe/tool gate FAIL**: Create a patch task using the same gap-classification logic as Stage 4. The patch task's `acceptance_probe` is the gate's probe command. Route through `dispatching-task-loop`.
- **Manual gate**: Deferred to Stage 5 human checklist. No action here.
- **>50% of probe/tool gates fail**: AskUserQuestion: "Over half the quality gates failed ([N] of [M]). Continue review or abort? (continue — address in Stage 4 / abort — fix gates first)"
- **All gates pass**: Proceed to next stage. Emit event: `quality_gates_passed sprint=<id> standing=<n> sprint_specific=<n> integration=<n>`

## Cursor Write

On completion, write to REVIEW-CURSOR.md:
- If UI features exist: `stage: visual`, `terminal: false`, `next_action: "Run Stage 2 visual verification"`
- If no UI features: `stage: goal_verify`, `terminal: false`, `next_action: "Run Stage 3 goal verification"`

Emit: `pipeline_tick_completed pipeline=ship-review sprint=<id> stage=quality_gates outcome=advanced next_stage=<next>`

## Event Log

Emit structured events for observability:
```
shipyard-data events emit quality_gate_result gate_id=SG-1 type=standing verification=probe status=pass
shipyard-data events emit quality_gate_result gate_id=SSG-2 type=sprint_specific verification=manual status=pending
shipyard-data events emit quality_gates_completed sprint=<id> passed=N failed=N manual_pending=N
```
