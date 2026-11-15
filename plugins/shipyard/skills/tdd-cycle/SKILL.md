---
name: tdd-cycle
description: Enforce the Red-Green-Refactor TDD cycle.
disable-model-invocation: true
---

# TDD Cycle

Write the test first. Watch it fail. Write minimum code to pass. Then refactor.

**Core principle:** If you didn't watch the test fail, you don't know if it tests the right thing.

**Violating the letter of the rules is violating the spirit of the rules.**

## When This Applies

**Always:**
- Sprint task implementation (`kind: feature`)
- Bug fix and hotfix work
- Land-now tasks (`/ship-execute --task T###`) that touch production code — the ported land-now guarantees: baseline green before touching, test first, green after refactor with no test-file edits, one focused commit
- Refactors that change observable behavior

**Hard exceptions** (still follow the spirit; check with the user before deviating):
- `kind: research` tasks — no code commit; output is a findings doc
- `kind: operational` tasks — deliverable is captured run output, not new test+code
- Throwaway prototypes the user explicitly marked as such
- Generated code (the generator should have its own tests)
- Pure config files

If you find yourself thinking "skip TDD just this once" for any other reason — stop. That is rationalization. Apply the cycle.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

If you wrote code before the test:

- **Delete it.** Start over from the test.
- Don't keep it as "reference" — subconscious work-backwards from it is hard to avoid.
- Don't "adapt" it while writing the test.
- Don't peek at it.
- Implement fresh from the test you just wrote.

Period.

## The Cycle

```
RED → GREEN → REFACTOR → repeat
```

### RED — Write a failing test

1. **Read the acceptance scenarios** in the step file's `## Acceptance Criteria` and the parent feature's `## Technical Notes`. The test must exercise at least one scenario.
2. **Write the test.** Place it in the correct test file with proper imports and assertions. The assertion should encode the *behavior* the scenario describes, not the implementation.
3. **Run the test.** Watch it fail.
   - **Fail must be for the right reason.** "ImportError: module not found" or "function not defined" is the expected failure mode for a fresh feature. A pass on the first run means the test isn't testing what you think — fix the test before proceeding.
   - Per `ship-execute`'s wave-boundary policy, test *execution* defers to the wave boundary (scoped) and sprint completion (full) — but the test still gets written first. The deferred-execution policy never excuses skipping the *write-test-before-code* discipline. The per-task acceptance probe runs inside the task and is the wiring-proof signal; the deferred suite is the unit-level proof.
4. **Capture the failure output** (the last 10 lines and exit code). You'll paste this into the commit body.

### GREEN — Make it pass with the minimum code

1. **Write the smallest implementation** that makes the test pass. No extras. No "while I'm here." No early generalization.
2. **Run the test.** Watch it pass.
3. **If the test still fails:** fix the *implementation*, not the test. The test is the contract; the implementation must satisfy it.
4. **Capture the pass output** (last 10 lines, exit code).

### REFACTOR — Clean up while green

1. **With tests green**, improve names, deduplicate, remove dead code.
2. **Run the test after every refactor.** If a refactor turns the test red, you broke behavior — revert the refactor or fix the implementation.
3. Stop when the code is clear, not when it's "perfect." Spec compliance > polish.

In Shipyard, REFACTOR also runs at the **wave boundary** across all merged tasks (`ship-execute` Step 4) — wave-level cross-task deduplication. Per-task refactor is local; wave refactor is global. Skipping REFACTOR for one task is fine, but never let a half-baked test design persist to the wave boundary (wave refactor reworks code, not a test that tests nothing).

## Forbidden Moves

| You may not | Because |
|---|---|
| Modify a test assertion to make it pass | Tests encode the spec. Modifying them defeats the contract. |
| Skip the RED phase ("I know it would fail") | You don't know — the test might pass against existing code, hiding a duplicate. |
| Commit a `// TODO: implement` stub | Stubs are false greens. The anti-stub-scan capability flags these. |
| Commit code without running its tests in this turn | See `verifying-completion` Iron Law — applies here. |
| Build beyond the failing test | Acceptance > extras. Save extras for the next task or an IDEA-* file. |
| Use a `pass`-body / `throw new Error("not implemented")` to make a different test pass | That's a stub, not an implementation. |
| Disable a failing test to "fix later" | If it has to be skipped, mark it `xfail` with a reason and a removal date. |

## Patterns

**Fresh feature with one scenario:**
```
Read scenarios → write test for scenario 1 → run (FAIL: function undefined)
Write min impl → run (PASS) → refactor (rename helper) → run (PASS) → commit
```

**Bug fix with regression test:**
```
Reproduce bug locally → write test that captures the failure → run (FAIL with bug symptom)
Apply fix → run (PASS) → revert fix → run (FAIL again — confirms test catches THIS bug)
Restore fix → run (PASS) → commit
```

The Red-Green-Revert-Red-Restore-Green cycle is non-optional for hotfixes. A regression test that doesn't fail without the fix is not a regression test.

**Multi-scenario task (typical Shipyard task):**
```
For each scenario in Acceptance Criteria (in order):
  RED: write test → run (FAIL right reason) → capture
  GREEN: minimal code → run (PASS) → capture
After all scenarios green:
  REFACTOR (local): dedupe, rename, remove dead → run (PASS each step)
COMMIT atomically: tests + impl + IDEA-* (if any from step 8 of builder process)
```

## Test Economy (one proof per behaviour)

Red-Green says *when* a test is written; **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/tdd-cycle/references/test-economy.md` for *which* tests may exist. The short form: start from the behaviour, not the code; every test proves a scenario the spec promises, written from the spec before reading the code, at the scenario's level tag and nowhere else — `@e2e` (the journey through real wiring, fakes only at the true edges) by default, `@component` only for a fault, race or timing the journey cannot stage, `@unit` only for a many-valued rule as one table; scenarios that share a `Given` share one test (grouped assertions, a journey, or a table), each `Then` still its own labelled assertion; interaction-only, wiring and coverage-padding tests are banned; if deleting the production line would not turn the test red, delete the test; `@e2e` asserts every outcome channel by value and compares rendered output against golden files; when you touch a feature, migrate its tests to this shape in the same change. A suite that grows with every task is the cost this rule exists to stop.

## Integration With Other Capabilities

- **`verifying-completion`** runs at the boundary of "is this task done?" — TDD provides the evidence (test pass + probe pass) that completion needs.
- **`running-acceptance-probe`** is run after green to demonstrate end-to-end wiring; tests alone don't prove integration.
- **`anti-stub-scan`** runs on the diff before commit — second-line defense against stubs that satisfy a weak test.
- **`shipyard-disciplined-builder`** (the builder agent `dispatching-task-loop` dispatches) inlines this skill's Iron Law in its prompt; the builder's loop only exits when probe passes AND no stubs remain.
