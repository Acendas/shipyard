---
name: anti-stub-scan
description: Use after a subagent returns STATUS:COMPLETE and before flipping a task to done — scans the diff for stub patterns (empty bodies, NotImplementedError, lone return-null implementations, TODO markers, commented-out call sites). Second-line defense behind dispatching-task-loop's prompt-level Iron Laws. Returns structured findings the orchestrator re-dispatches against.
disable-model-invocation: true
---

# Anti-Stub Scan

A diff scanner that flags code claimed as complete but not actually wired. Runs on the orchestrator side after `dispatching-task-loop` returns. Findings re-dispatch the subagent with the specific lines listed.

**Why both this AND the prompt-level Iron Law?** The Iron Law (`NO STUBS IN CODE YOU CLAIM IS COMPLETE`) lives in the subagent's prompt and works most of the time. This scanner is the second line: when the subagent rationalizes past the rule, the orchestrator catches the stub before flipping the task to done. Belt and suspenders.

## When to Invoke

From the orchestrator side:

1. After `dispatching-task-loop` returns `STATUS: COMPLETE`.
2. Before marking the task `status: done` in its task file.
3. Before merging the worktree branch back to the working branch.

Do NOT invoke during the subagent's own loop — the prompt-level Iron Law is the in-loop check.

## Inputs

- `base_ref` — git ref / sha that this task's commit branched from (typically the working branch HEAD before the wave started).
- `head_ref` — the subagent's commit sha (from `COMMIT:` in its return).
- `language` — primary language(s) detected in the diff (informs which patterns to apply).

The scan operates on the *diff* (`base_ref..head_ref`), not on the whole codebase. Untouched files are not scanned — the subagent is responsible only for what it added or changed.

## Stub Patterns

Each pattern has a confidence (HIGH / MEDIUM / LOW) and a language scope. Findings at HIGH confidence block done; MEDIUM go in the report and require a re-dispatch decision; LOW are advisory.

### Empty implementations (HIGH confidence)

| Pattern | Languages | Notes |
|---|---|---|
| Function body is exactly `pass` | Python | Excluded: protocols, abstract methods, type stubs |
| Function body is exactly `...` (ellipsis only) | Python | Same exclusions |
| Function body is exactly `{}` (empty block) on a non-interface | TS, JS, Java, C#, Go, Rust | Empty body where signature implies behavior |
| Method is decorated `@abstractmethod` but added in this diff to a class the spec says implements something | Python | Concrete class shouldn't gain abstract methods |

### Explicit not-implemented markers (HIGH confidence)

| Pattern | Languages |
|---|---|
| `raise NotImplementedError(...)` in code claimed complete | Python |
| `throw new Error("not implemented")` (or `not_implemented`, `unimplemented`, case-insensitive) | TS, JS, Java |
| `unimplemented!()`, `todo!()` macros | Rust |
| `panic("...not implemented...")` | Go |
| `fatalError("not implemented")` | Swift |

### Lone return-null implementations (MEDIUM confidence)

A function whose entire body is one statement returning a falsy/empty value where the spec required real output. Patterns:

- `return null;` / `return undefined;` / `return None`
- `return ""` / `return []` / `return {}` / `return false`
- `return 0` (only flag if the function name implies non-zero return — e.g., `getCount`, `computeTotal`)

These are MEDIUM because legitimate stubs exist (e.g., a `noop` function, a default-handler that returns null intentionally). Surface them; let the orchestrator decide whether to re-dispatch.

### TODO / FIXME / XXX markers (HIGH confidence on added lines, LOW on touched lines)

Scan diff added lines for:
- `TODO`, `FIXME`, `XXX`, `HACK` (case-insensitive, word boundaries)
- `@todo`, `# todo`, `// todo`

If the subagent ADDED a TODO/FIXME marker in code claimed complete, that's a HIGH-confidence stub indicator — the subagent itself is admitting the work is incomplete. If the marker existed in code the subagent merely touched (e.g., reformatted), it's LOW confidence.

### Commented-out call sites (MEDIUM confidence)

A call site to the new function/method was added but commented out. Pattern: a `+` line in the diff containing the new symbol's name inside a comment (`// foo()`, `# foo()`, `/* foo() */`). This indicates the wiring exists in source but is disabled — false-completion vector.

### Untouched export / public-API lists (MEDIUM confidence)

If the spec's Acceptance Criteria say "expose `<symbol>` from `<module>`" and the diff doesn't include the corresponding `index.ts` / `__init__.py` / `mod.rs` change, flag it. Pattern: spec mentions a module's public API and the diff doesn't touch the export file for that module.

This requires the orchestrator to pass acceptance criteria text alongside the diff range — surface as MEDIUM with the specific symbol name.

### Tests that don't exercise new code (MEDIUM confidence)

Pattern: a test was added (file ends in `.test.ts`, `_test.py`, etc.) but greps of the diff show no production code was added in the same commit. Either the subagent forgot to add the implementation or the test stubbed itself. Confirm by checking that the test file's imports include at least one symbol from a non-test file added in this diff.

## Explicit Opt-Out Marker

Legitimate stubs exist (early scaffolding, intentional `NotImplementedError` for an abstract base, a `pass` placeholder for a future task in a multi-task feature). For these, the subagent may add a comment marker on the line above the stub:

```python
# shipyard:placeholder reason=base-class-for-T-045
def execute(self):
    raise NotImplementedError
```

```ts
// shipyard:placeholder reason=stub-for-future-task-T-099
export function fooBar(): void {
  throw new Error("not implemented");
}
```

**Format:** `<comment-syntax> shipyard:placeholder reason=<short-reason>` on the line immediately preceding the stub (or the line preceding the function declaration).

When the scanner sees this marker on the line above a flagged stub, it downgrades the finding to LOW (advisory only, no block, no re-dispatch). The reason is logged so future review (`/ship-review`) can audit whether the placeholder was ever filled in.

If the subagent uses this marker, it MUST also include the reason. A bare `shipyard:placeholder` with no `reason=` is treated as if absent (the marker is for the orchestrator + reviewer; the reason is the documentation).

## Output Shape

The scanner returns a structured finding list. Each finding:

```
{
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "pattern": "empty-body" | "not-implemented-marker" | "lone-return-null" | "todo-marker" | "commented-call-site" | "missing-export" | "test-no-impl",
  "file": "<relative path>",
  "line": <1-based line number>,
  "snippet": "<the offending line, trimmed to 120 chars>",
  "placeholder_marker": null | "<the reason string, if marker present>"
}
```

The orchestrator aggregates findings:

- **Any HIGH-confidence finding without a `placeholder_marker`** → block. Re-dispatch the subagent with the findings list inline:
  ```
  Your diff was claimed complete but contains stubs the contract forbids:
    {file}:{line}: {pattern} — {snippet}
    {file}:{line}: {pattern} — {snippet}
  Fix these and re-probe. Same task ID, same worktree.
  ```
- **MEDIUM findings only** → present them in the wave's progress report. The orchestrator may re-dispatch (one extra iteration) at its discretion or surface to the user.
- **LOW findings** → log in PROGRESS.md deviations; no action.

## Re-Dispatch Rules

The single-redispatch rule from `dispatching-task-loop` still applies: at most one extra iteration per task per wave. If the second pass also produces HIGH findings, mark the task `needs-attention` and continue. Do NOT loop indefinitely on stub-fix.

## Implementation Notes for the Orchestrator

The scan itself runs in the orchestrator's session via `Bash` calls to `git diff` + standard text tools (`grep -nE`, `awk`), or via a dedicated `shipyard-data scan-stubs` subcommand if extracted later. For the first cut, inline `Bash` is fine — the patterns are small and language-detection is by file extension.

A reference implementation outline (orchestrator-side, in skill prose):

1. `git diff --name-only {base}..{head}` → list of changed files.
2. For each file, classify by extension; pick the relevant pattern set.
3. `git diff -U0 {base}..{head} -- {file}` → unified diff with no context.
4. Walk the `+` lines; apply patterns; for each match, look at the line immediately above (in the unified diff) for `shipyard:placeholder reason=` to compute the placeholder marker.
5. Aggregate findings into the JSON shape above.
6. Apply the action rules.

Keep the implementation simple. If a pattern is hard to express (e.g., AST-level "function body is just pass"), drop the precision and accept that some legitimate code triggers MEDIUM — better than an over-engineered scanner that drifts.

## What This Replaces

- The implicit assumption in the old `shipyard-builder` agent that the agent's "Before Exiting" checks would catch stubs. They didn't reliably — that's why this exists.
- Some of the work `shipyard-review-spec` did during ship-review (catching missing implementations); that scanner can now focus on acceptance-criteria mapping while this one handles structural stub detection.

## What This Does NOT Replace

- **The Iron Law in the subagent prompt.** Most stubs never make it past the prompt-level rule. This scanner exists for the exceptions. If you find yourself relying on this scanner instead of the prompt rule, the prompt rule isn't doing its job — fix the prompt, don't lean harder on the scanner.
- **`/ship-review` spec compliance.** That's about acceptance-criteria → code mapping, not structural stubs.

## Bottom Line

- Run after subagent return; before marking done.
- HIGH findings without placeholder marker → re-dispatch.
- MEDIUM → orchestrator's call.
- LOW → log only.
- Single redispatch per task per wave; then `needs-attention`.
- Belt-and-suspenders, not the primary defense.
