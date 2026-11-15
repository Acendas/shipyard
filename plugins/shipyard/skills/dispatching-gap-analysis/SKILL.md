---
name: dispatching-gap-analysis
description: Dispatch a review gap-analysis subagent.
disable-model-invocation: true
---

# Dispatching Gap Analysis

Runs `/ship-review` Stage 4 + Stage 4.5 as a fresh-context registered agent.
The agent reads specs, delivered-code evidence, test captures, spec-review
findings, and goal-verification results, then returns a structured gap list and
the 10-check self-review result. The orchestrator owns all side effects:
classification actions, cursor advances, stuck-counter computation, task/IDEA
creation, user-facing surfacing, and read-only enforcement.

## Inputs

- `scope` — `"feature" | "sprint"`
- `target_ids` — feature IDs, or null when scope is sprint.
- `base_ref` / `head_ref` — diff range.
- `data_dir` — literal `<SHIPYARD_DATA>` path.
- `sprint_spec_paths` — feature/task/reference paths under `<SHIPYARD_DATA>/spec/`.
- `evidence_paths` — Stage 1 test captures, Stage 1b spec-review findings, and
  Stage 3 goal-verification artifacts gathered so far.

## Dispatching the Analyst

The gap-analysis methodology, classification boundaries, read-only contract,
and Required Return Shape live in the registered agent
`agents/shipyard-gap-analyst.md` — read it once if you need to know exactly
what it does; do not re-inline it here.

**Model + effort (resolved by CLI).** Run `shipyard-data resolve-model think` — it prints one line `model=<m> effort=<e>` from config.md (an empty value means OMIT that field on the Agent call so the subagent inherits; `inherit` is already normalized to empty). Never derive either from config.md prose and never hardcode a model literal. Then log it: `shipyard-data events emit dispatch_model_resolved role=think model=<m or inherit> effort=<e or inherit> skill=<this skill>` — the wrapper logs, the resolver stays silent, and a logging failure never blocks the dispatch.

Dispatch:

```
Agent(
  subagent_type: "shipyard:shipyard-gap-analyst",
  model: <model= from resolve-model, or omit if empty>,
  effort: <effort= from resolve-model, or omit if empty>,
  prompt: "
    Scope:              {{scope}}
    Target IDs:          {{target_ids}}
    Base ref:            {{base_ref}}
    Head ref:            {{head_ref}}
    Data dir:            {{data_dir}}
    Sprint/spec paths:   {{sprint_spec_paths}}
    Evidence paths:      {{evidence_paths}}
  "
)
```

## Orchestrator-Side Action Rules

The analyst return always carries `STATUS:`, `SCOPE:`, `TARGETS:`, `GAP_COUNT:`,
and `CHECKS:` unless it is BLOCKED.

1. **`STATUS: CLEAN`** — record the clean result and let `/ship-review` advance
   to `stage: critic`.

2. **`STATUS: GAPS`** — parse the per-gap block. `/ship-review` applies its
   classification tree: `inline-fix` and `patch-task` route to
   `dispatching-task-loop`, `debug-session` routes to the debug path, and
   `out-of-scope-idea` becomes an IDEA. The wrapper does not perform those
   side effects itself; the command skill owns them.

3. **`STATUS: BLOCKED`** — quote the `REASON:` paragraph as chat text before
   any ask. Do not invent a hand-rolled fallback; the failure is not recoverable that way.

4. **Silent return** — the Agent return is present but no `STATUS:` line
   appears, or the body is empty/whitespace. Treat this as a distinct outcome:
   emit `shipyard-data events emit gap_analysis_dispatch_returned scope=<scope>
   targets=<target_ids> status=needs-attention reason=silent_return` and
   re-dispatch ONCE with the same brief. If the re-dispatch is also silent,
   stop re-dispatching and surface it as a `STATUS: BLOCKED`-shaped ask rather
   than looping.

5. **Read-only enforcement** — post-return `git status --porcelain` + HEAD ref
   check. Any drift is a contract violation; treat as `STATUS: BLOCKED` and
   surface it. Do not continue with a possibly-mutated worktree.

## Pairing With `/ship-review`

`/ship-review` owns convergence. It compares the returned gap-list set with the
previous tick, passes `stuck_counter=0` only when the set changed, advances
`gap_analysis` for another tick while gaps are changing, and advances to
`critic` when the list stabilizes.
