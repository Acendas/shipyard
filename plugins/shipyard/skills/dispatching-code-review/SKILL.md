---
name: dispatching-code-review
description: Dispatch a fresh-context code review subagent.
disable-model-invocation: true
---

# Dispatching a Code Review

**Render before asking.** Before any AskUserQuestion, render the decision context as assistant chat text. Content that exists only in a Read result, a subagent/Agent return, or the question/option strings **does not count as rendered** (the UI shows a compact card) — restate it in chat first.

The companion to `dispatching-spec-review`. Spec review answers *"is what was asked delivered?"*; code review answers *"is what was delivered any good?"*. Same fresh-context subagent pattern, different concern set.

## When to Invoke

| Caller | Scope | Trigger |
|---|---|---|
| `/ship-execute` post-task gate | One task | Optional — fires only when `effort: M\|L\|XL`; effort: S skips both spec and code review |
| `/ship-execute` wave VERIFY | Wave-level diff | Optional — fires when wave touched security-relevant, financial-domain, **or database/persistence** code (migrations, schema, queries, repositories) |
| `/ship-review` | Sprint or feature | **Required** before user approval |
| `/ship-quick` | Single-change diff | Optional flag (`--review`) |

Code review is more expensive than spec review (broader concern surface). `/ship-review` runs it mandatorily before approval; the post-task path remains optional and gated on effort.

## Inputs

- `scope` — `"task" | "wave" | "feature" | "sprint"`
- `target_ids` — list of task / feature IDs (or null when scope is sprint).
- `base_ref` / `head_ref` — diff range.
- `concerns` — subset of `["security", "bugs", "silent-failures", "patterns", "tests", "observability", "data"]`. Default: all. The **`data`** concern **auto-gates** — it produces findings only when the diff touches persistence (migrations, schema, SQL/ORM, repositories, indexes) and no-ops otherwise, so including it by default is free. Caller can narrow (e.g., `["security", "bugs"]` for a wave that didn't touch tests), but **whenever the diff touches the database, `data` MUST be among the concerns** (it is, under the default). In parallel-split dispatch (see `ship-review/references/code-review-orchestration.md`), assign `data` to exactly one subagent so it isn't dropped or duplicated.
- `data_dir` — literal `<SHIPYARD_DATA>` path.
- `project_rules_path` — `.claude/rules/*.md` paths so the patterns scanner has the project's conventions. Shipyard does not inject its own rules into `.claude/rules/`; only project-authored rules pass through here.
- `quality_standards_path` — the literal path to `project-files/references/code-quality-standards.md`. Always resolved and included, not gated further here — code review is itself effort-gated at the caller (fires only for `effort: M|L|XL` at the post-task site; unconditionally at `/ship-review`), so by the time this skill dispatches, the digest is always in scope. Not narrowed by `concerns` — each of the six general concerns points back at its own `§<concern> ▸ Verify` half regardless of which subset is active.

## Dispatching the Reviewer

The reviewer methodology (all seven concern definitions, confidence threshold, the read-only contract, the Required Return Shape) lives in the registered agent `agents/shipyard-code-reviewer.md` — read it once if you need to know exactly what it does; do not re-inline it here.

**Model tier (think).** Read `models.think` from config.md — the invoking command skill's `!` context block, or a Read of `<SHIPYARD_DATA>/config.md`. If the value is non-empty, pass `model: <value>` in the Agent call; if empty or absent, OMIT the `model:` field entirely so the subagent inherits the session model. Never hardcode a model literal. Applies to every dispatch, including each subagent of the parallel-split variant below.

**Effort tier (think).** Read `agent_effort.think` from config.md; default `high`. If the value is non-empty, pass `effort: <value>` in the Agent call; if empty or absent, OMIT `effort:` so the subagent inherits the runtime default. Applies to every dispatch, including each subagent of the parallel-split variant below.

**Plugin-relative paths are resolved here, not in the agent.** `${CLAUDE_PLUGIN_ROOT}` is not verified to expand inside a registered agent's body — resolve the data-implementation guide path (when the `data` concern is gated in) and `quality_standards_path` (always) to literal paths before including them in the brief.

Dispatch:

```
Agent(
  subagent_type: "shipyard:shipyard-code-reviewer",
  model: <models.think value, or omit>,
  effort: <agent_effort.think value, or omit>,
  prompt: "
    Scope:              {{scope}}
    Target IDs:          {{target_ids}}
    Base ref:            {{base_ref}}
    Head ref:            {{head_ref}}
    Concerns:            {{concerns_csv}}
    Data dir:            {{data_dir}}
    Project rules:       {{project_rules_path}}
    Quality standards:   {{quality_standards_path}}
    {{data_impl_guide path, if `data` concern is gated in — otherwise omit}}
  "
)
```

## Orchestrator-Side Action Rules

The reviewer's return always carries `STATUS:`, `SCOPE:`, and `TARGETS:`; a `FINDINGS:` count (0 on CLEAN, an integer on FINDINGS) and, on FINDINGS, an `ADVISORY:` count for the 60–80 band, accompany the per-finding block.

1. **`STATUS: CLEAN`** → record; advance.

2. **`STATUS: FINDINGS`**:

   - **High-confidence security findings** (`concern: security`, confidence ≥ 90) → block. Re-dispatch `dispatching-task-loop` with the security findings inlined: *"Code review found security issues that must be fixed: <list>; re-implement and re-probe."*
   - **Other ≥ 80 findings in `/ship-review`** → auto-fix by default through the Stage 0 code-review loop. The reviewer does not ask the user whether to fix routine bugs, tests, silent failures, pattern violations, observability gaps, or data defects; those are the review pipeline's job. Render findings only at user gates or terminal escalation. AskUserQuestion is reserved for severe/risky cases where an automatic fix would require a product decision, destructive migration, credential/security-policy choice, large dependency/platform change, or accepting a known defect.
   - **Other ≥ 80 findings outside `/ship-review`** → present in the calling skill's report. 'Present' means the full finding blocks (file:line, snippet, reason) rendered as chat text before any per-finding decision ask — findings that exist only in this skill's return are not presented. The post-task path can auto-redispatch the task once for high-density findings (≥ 3) but stops there to avoid loop-on-quality.
   - **Advisory (60–80)** → log to PROGRESS.md deviations; no auto-action.

3. **`STATUS: BLOCKED`** → quote the subagent's `REASON:` paragraph verbatim as chat text (it exists only in the Agent return — content in a subagent return or in the question/option strings does not count as shown), then AskUserQuestion. Likely: diff is too large, spec missing, project rules path bad.

4. **Silent return** — the Agent return is present but no `STATUS:` line appears, or the body is empty/whitespace. Treat this as its own outcome, distinct from CLEAN/FINDINGS/BLOCKED: emit `shipyard-data events emit code_review_dispatch_returned scope=<scope> targets=<target_ids> status=needs-attention reason=silent_return` and re-dispatch ONCE with the same brief. If the re-dispatch is also silent, stop re-dispatching and surface it as a `STATUS: BLOCKED`-shaped ask instead of looping.

5. **Read-only enforcement** — same as `dispatching-spec-review`: post-return `git status --porcelain` + HEAD ref check. Any drift is a contract violation → treat as `STATUS: BLOCKED` and surface.

## Parallel Dispatch For High-Stakes Reviews

For high-stakes reviews (release-bound, large diff, payments/auth/data), `/ship-review` may dispatch this skill multiple times in parallel with non-overlapping `concerns` arrays — each subagent gets its own context window, scanning is genuinely parallel. The trade is more tokens for better depth on each concern. Assign the `data` concern to exactly one split (see Inputs above) — it must never be dropped or duplicated across splits.

## Pairing With Other Skills

- **`dispatching-spec-review`** runs before this — spec compliance is "did we deliver"; code review is "is the delivery any good." Both must pass for `/ship-review` approval.
- **`dispatching-task-loop`** is re-dispatched when high-confidence findings demand re-implementation.
- **`anti-stub-scan`** is structural; this skill is contextual / semantic. Both run on the diff but ask different questions.
- **`running-acceptance-probe`** is orthogonal — code review doesn't run probes; spec review may.

## Bottom Line

- One dispatch to the registered `shipyard-code-reviewer` agent, seven concern domains (the seventh, `data`, auto-gates on persistence-touching diffs).
- Read-only; structured findings; confidence ≥ 80 to block.
- Security ≥ 90 auto-redispatches; `/ship-review` auto-fixes all routine ≥80 findings and asks only for severe/risky product decisions or true BLOCKED outcomes.
- Silent-return gate: one re-dispatch, then surface as BLOCKED rather than loop.
- Post-return git-status check enforces the read-only contract.
