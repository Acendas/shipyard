# Read-only review fan-out as a Workflow (F033, opt-in)

`review.workflow: true` in config.md lets two read-only fan-outs run through Claude Code's `Workflow` tool instead of one `Agent` call per reviewer: the Stage 0a scanner wave (`/ship-review`) and the per-story spec review + gap analysis pair (`/ship-execute` Step 4 item 3b). Nothing else: **builders never run in a workflow** (AC-5) — worktree isolation inside workflows is unprobed and a lost build is not a lost review.

## Rules that do not bend

1. **Opt-in only (AC-1).** Default `false`. The Workflow tool's own rule is explicit user opt-in; this config key is the user's standing instruction, and this reference is the skill instruction that authorizes the call. Never call `Workflow` when the key is off.
2. **The CLI is the ledger (AC-3).** A workflow's return value is transient (resume is same-session only, by `runId`; a dead session loses it). So every result is written down the same way the plain dispatch writes it, immediately: scanner findings → `<SHIPYARD_DATA>/sprints/current/REVIEW-FINDINGS.json` + `shipyard-data events emit review_scan_recorded source=workflow findings=<n>`; per-story outcomes → `shipyard-data story-review record …`. A workflow that dies after writing nothing lost nothing that was recorded; the next tick simply re-dispatches.
3. **Fallback is the current dispatch (AC-4).** If the `Workflow` tool is not in this session's tool list, if the call is refused, or if it returns `null`/throws, run the same reviewers through the regular playbooks (`dispatching-code-review`, `dispatching-spec-review`, `dispatching-gap-analysis`) — same prompts, same gates, same records. Say so in one line; never retry the workflow in a loop.
4. **Read-only agents only.** Use the registered read-only agent types (`agentType: "shipyard:shipyard-code-reviewer"`, `"shipyard:shipyard-spec-reviewer"`, `"shipyard:shipyard-gap-analyst"`) so each agent carries its own read-only contract. Resolve model/effort through `shipyard-data resolve-model think` as the playbooks do, and pass them as `model`/`effort` (omit when empty).

## The two shipped workflows (4.5)

The scripts ship with the plugin under `workflows/` and are called **by name** — never paste or rewrite a script. A probe on Claude Code 2.1.323 (2026-11-13) confirmed that a plugin-shipped workflow resolves as `<plugin>:<name>`, receives `args`, returns schema-validated output and can use the plugin's own agent types.

| Workflow | Call | Returns |
|---|---|---|
| `shipyard:review-scan` (Stage 0a scanner wave, `/ship-review`) | `Workflow({ name: "shipyard:review-scan", args: { dimensions: [...], target_ids: [...], base_ref, head_ref, data_dir, model?, effort? } })` | `{ findings: [...], dropped: [<dimension>, ...] }` |
| `shipyard:story-review` (per-story spec review then gap analysis, `/ship-execute` Step 4 item 3b, several stories in one wave) | `Workflow({ name: "shipyard:story-review", args: { stories: [...], base_ref, head_ref, data_dir, model?, effort? } })` | `[{ story, spec, gaps }, ...]` |

`args` are real JSON values, not a string; `model`/`effort` come from `shipyard-data resolve-model think` and are omitted when empty.

**After `review-scan` returns:** assign stable ids (`R001…`), write REVIEW-FINDINGS.json, emit `review_scan_recorded source=workflow findings=<n> dropped=<n>`, re-run any dropped dimension through `dispatching-code-review`, then continue with `shipyard-data review plan` exactly as the plain path does.

**After `story-review` returns:** for each `{story, spec, gaps}`: `shipyard-data story-review record <story> --verdict <approve when spec.status is PASS and gaps is empty, else changes> --spec <PASS|FINDINGS> --gaps <gaps.length> --head <HEAD>`; a story missing from the result (agent skipped or died) goes through the plain `dispatching-spec-review` + `dispatching-gap-analysis` playbooks instead. Findings take the normal disposition path.

## Probe record (AC-4 "probe resume behavior")

Per the Workflow authoring reference shipped with Claude Code 2.1.323: scripts persist under the session directory; `Workflow({scriptPath, resumeFromRunId})` replays the unchanged `agent()` prefix from cache and is **same-session only**; `Date.now()`/`Math.random()` are unavailable in scripts; agents are capped at ~16 concurrent, 1000 per run. Those limits are why the CLI, not the workflow, is the ledger, and why opt-in stays off by default.
