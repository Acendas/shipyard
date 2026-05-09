---
name: tdd-cycle
description: Use when implementing any sprint task, bug fix, hotfix, or quick change that produces production code. Enforces Red → Green → Refactor with the Iron Law of watching the test fail before writing implementation. The contract every Shipyard builder follows; pairs with verifying-completion at task-done time.
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
- `/ship-quick` changes that touch production code
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

1. **Read the acceptance scenarios** in the task file's `## Acceptance Criteria` and the parent feature's `## Technical Notes`. The test must exercise at least one scenario.
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

In Shipyard, REFACTOR also runs at the **wave boundary** across all merged tasks (`ship-execute` Step 4) — wave-level cross-task deduplication. Per-task refactor is local; wave refactor is global.

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

## Integration With Other Capabilities

- **`verifying-completion`** runs at the boundary of "is this task done?" — TDD provides the evidence (test pass + probe pass) that completion needs.
- **`running-acceptance-probe`** is invoked after green to demonstrate end-to-end wiring; tests alone don't prove integration.
- **`anti-stub-scan`** runs on the diff before commit — second-line defense against stubs that satisfy a weak test.
- **`dispatching-task-loop`** invokes this skill inside the subagent prompt; the subagent's loop only exits when probe passes AND no stubs remain.

## Why This Discipline

- **Skipping RED produces tests that don't test anything.** The model writes a test that mirrors the implementation it just wrote — same assumptions, same blind spots.
- **Skipping GREEN-runs produces stubs.** Code "should work" is the most common false-completion vector in agentic development.
- **Skipping REFACTOR is fine for one task** — wave-level refactor catches it. But never let a half-baked test design persist to the wave boundary.

## The Bottom Line

**Test first. Watch it fail. Make it pass. Refactor. Verify with `verifying-completion`.**

If the test passes on the first run, you don't have a test — you have a fixture. Fix it.

If the implementation works without ever running the test, you have hope, not evidence. Run it.

Non-negotiable.
