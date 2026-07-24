---
name: dispatching-spec-review
description: Dispatch a fresh-context spec review subagent.
disable-model-invocation: true
---

# Dispatching a Spec Review

**Render before asking.** Before any AskUserQuestion, render the decision context as assistant chat text. Content that exists only in a Read result, a subagent/Agent return, or the question/option strings **does not count as rendered** (the UI shows a compact card) — restate it in chat first.

Sends a fresh-context subagent to compare what the spec requires against what the diff delivers. The subagent reads, reasons, and reports — it does not edit code or commit. The orchestrator uses the structured findings to decide whether to mark a task done, request fixes, or block approval.

## When to Invoke

| Caller | Scope | Trigger |
|---|---|---|
| `/ship-execute` post-task gate | One task | After `dispatching-task-loop` returns `STATUS: COMPLETE` and anti-stub-scan is clean — final compliance check before marking task done |
| `/ship-execute` wave VERIFY | All tasks in a wave | After wave-boundary REFACTOR — confirms wave-level acceptance scenarios all hold |
| `/ship-review` | Sprint or feature | Full audit before user approval |
| Manual / ad-hoc | Single feature | When the user asks "did we actually deliver F-007?" |

Skip this skill for tasks marked `effort: S` (trivial) — overhead exceeds value. The post-task gate explicitly bypasses for S tasks per `/ship-execute`'s spec-check rule.

## Inputs

- `scope` — `"task" | "wave" | "feature" | "sprint"`. Determines which spec files and which diff range.
- `target_ids` — list of task IDs (scope=task), feature IDs (scope=feature), or null for wave/sprint (those are inferred from sprint state).
- `base_ref` — git ref the diff started from. For wave: the working branch HEAD before wave kickoff. For sprint: the sprint's base ref.
- `head_ref` — current HEAD (or the sprint's working branch HEAD).
- `data_dir` — literal `<SHIPYARD_DATA>` path.

## Dispatching the Reviewer

The reviewer methodology (AC classification, the Iron Law, the read-only contract, the Required Return Shape) lives in the registered agent `agents/shipyard-spec-reviewer.md` — read it once if you need to know exactly what it does; do not re-inline it here.

**Model tier (think).** Read `models.think` from config.md — the invoking command skill's `!` context block, or a Read of `<SHIPYARD_DATA>/config.md`. If the value is non-empty, pass `model: <value>` in the Agent call; if empty or absent, OMIT the `model:` field entirely so the subagent inherits the session model. Never hardcode a model literal.

**Plugin-relative paths are resolved here, not in the agent.** `${CLAUDE_PLUGIN_ROOT}` is not verified to expand inside a registered agent's body — resolve any plugin-relative reference path (e.g. the data-implementation guide) to a literal path before including it in the brief.

Dispatch:

```
Agent(
  subagent_type: "shipyard:shipyard-spec-reviewer",
  model: <models.think value, or omit>,
  prompt: "
    Scope:        {{scope}}                  (task | wave | feature | sprint)
    Target IDs:   {{target_ids}}
    Base ref:     {{base_ref}}
    Head ref:     {{head_ref}}
    Data dir:     {{data_dir}}
    {{scope_specific_intro}}
    {{data_impl_guide path, if gated on a DB-touching diff — otherwise omit}}
  "
)
```

## Orchestrator-Side Action Rules

The reviewer's return always carries `STATUS:`, `SCOPE:`, and `TARGETS:`; a `FINDINGS:` count (0 on PASS, an integer on FINDINGS) accompanies the per-finding block.

1. **`STATUS: PASS`** — record it; allow the calling skill to advance (mark task done, approve feature, etc.).

2. **`STATUS: FINDINGS`** — parse the per-finding block. Two sub-rules:

   - **Any MISSING or critical PARTIAL** (test asserts a stub) → re-dispatch the corresponding task via `dispatching-task-loop` with the findings inlined: *"Spec review found gaps: <list>; please re-implement and re-probe."* Single redispatch per task per wave (consistent with `dispatching-task-loop`'s rule). If a second pass still has findings → `shipyard-data task set-status <id> needs-attention --reason "spec_review_findings_persist"`, log to PROGRESS.md, continue.
   - **Only OVER-BUILT findings** → flag in PROGRESS.md deviations table; do NOT auto-revert (the user may want to keep extras). `/ship-review` surfaces these for explicit user decision.

3. **`STATUS: BLOCKED`** — quote the subagent's `REASON:` paragraph verbatim as chat text before the ask (it lives only in the Agent return; return content and question/option strings do not count as rendered), then AskUserQuestion. Likely causes: spec missing, target IDs invalid, diff range malformed. None of these are recoverable by retry.

4. **Always apply `verifying-completion`'s Iron Law as a mental check** before flipping a task to done based on PASS — the Iron Law applies at the orchestrator boundary.

5. **Silent return** — the Agent return is present but no `STATUS:` line appears, or the body is empty/whitespace. Treat this as distinct from all three documented outcomes above: `shipyard-data task set-status <id> needs-attention --reason "silent_return"`, emit an event, and re-dispatch once with the same brief. If the re-dispatch is also silent, stop re-dispatching and surface it as a `STATUS: BLOCKED`-shaped ask instead of looping.

## Read-Only Contract Enforcement

Even though the prompt forbids edits, the orchestrator should verify:

1. After the subagent returns, check `git status --porcelain`. If non-empty → contract violation; the subagent edited despite being told not to. Treat as `STATUS: BLOCKED` and surface.
2. Verify no new commits exist (`git rev-parse HEAD` matches `head_ref` from the inputs). If different → violation.

These checks are cheap and catch the rare model rationalization ("I'll just fix this small thing while I'm here").

## Pairing With Other Skills

- **`dispatching-task-loop`** is re-dispatched by the orchestrator if MISSING/PARTIAL findings demand re-implementation. The findings string is passed in the task-loop prompt as additional context.
- **`running-acceptance-probe`** may be followed by the spec reviewer (per the prompt) to validate a probe-defined AC. Same probe contract, just a read-only execution.
- **`anti-stub-scan`** is a *structural* stub check; this skill is the *semantic* spec-vs-code check. They complement: anti-stub catches "the function body is `pass`"; spec-review catches "the function exists but doesn't satisfy AC #3."

## Bottom Line

- Read-only subagent that maps ACs to code + tests.
- PASS only when every AC is MET. PARTIAL, MISSING, OVER-BUILT → FINDINGS.
- Structured per-finding return; orchestrator decides re-dispatch vs flag vs block.
- One redispatch per task per wave; then `needs-attention`.
- The 5th of 14 capability skills overall; replaces `shipyard-review-spec` agent.
