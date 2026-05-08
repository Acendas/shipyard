# Research Tasks

**Status:** This reference is superseded by the **`shipyard:dispatching-research-task`** capability skill. See `skills/dispatching-research-task/SKILL.md` for the full contract.

## What this reference used to cover

Pre-2.0, ship-execute embedded the full research-task dispatch protocol here: derivation of the `<TASK_ID>-<slug>.md` output filename, the Write-scope-by-contract guarantee for `shipyard-researcher` (Write tool scoped to a single findings doc under `<SHIPYARD_DATA>/research/`), the Findings Doc Template (TL;DR, Context, ≥1 `### Finding` section with Claim/Evidence/Confidence/Tradeoff fields, Recommendation, Open Questions), and the post-subagent gate (file exists + non-empty + ≥1 Finding + porcelain check).

## What replaces it in 2.0

The `shipyard:dispatching-research-task` capability skill encodes the same protocol with these structural improvements:

- Dispatched via `subagent_type: "general-purpose"` (no registered `shipyard-researcher` agent — addresses CC-1). Write scope is a contract in the prompt + a porcelain gate post-return; no per-agent `tools:` allowlist needed.
- HARD GATE prose at the top of the subagent's prompt explicitly forbidding any write outside the expected output path.
- Orchestrator-side gate emits structured events (`research_task_bogus_pass` with reason codes, `research_out_of_scope_write`) for diagnostic-loud failures.

## Migration

Any caller previously reading "Step 3 of references/research-tasks.md" should now read the corresponding section of `skills/dispatching-research-task/SKILL.md`. Routing decisions still live in ship-execute's per-task dispatch step.

This file is scheduled for full deletion in a future cleanup; it remains as a thin redirect during the transition window.
