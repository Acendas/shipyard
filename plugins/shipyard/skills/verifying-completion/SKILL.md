---
name: verifying-completion
description: Use whenever you are about to claim a task is done, a fix works, tests pass, a spec is satisfied, or a sprint is complete — before any commit, transition, or status flip. Requires running the verification command in this turn and reading its output before any success claim. Evidence before claims, always.
disable-model-invocation: true
---

# Verifying Completion

A task is "done" only when its acceptance is observable — right now, in this turn, with output you read. Internal confidence, prior runs, and "it should work" are not evidence.

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you have not run the verification command in this message, you cannot claim it passes. Period.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Gate Function

Before flipping a task to `done`, marking a sprint complete, approving a feature, or asserting any "X works" / "tests pass" / "fixed" / "ready" — run this gate:

```
1. IDENTIFY: What command, in this exact moment, proves the claim?
2. RUN:      Execute the FULL command from a clean state (fresh shell, fresh build).
3. READ:     Read the FULL output. Capture exit code. Count failures.
4. VERIFY:   Does the output literally confirm the claim?
                YES → state the claim WITH the evidence inline (last 10 lines + exit).
                NO  → state actual status with the evidence; do NOT claim done.
5. ONLY THEN: Make the claim or flip the marker.

Skipping any step = lying, not verifying.
```

## Claim → Evidence Map

| Claim | Required evidence | Insufficient |
|---|---|---|
| Tests pass | Test command output: `0 failed`, exit 0, run in this turn | "Last run was green" / "should pass" |
| Fix works | Acceptance probe exit 0 with observable output proving wiring | "Code looks right" / "compile clean" |
| Bug fixed | The original failing test or repro now passes; ran in this turn | "Code changed; assumed fixed" |
| Build succeeds | Build command exit 0 in this turn | Linter passing / "no syntax errors" |
| Linter clean | Lint command output: `0 errors` in this turn | Partial check / extrapolation |
| Regression test added | Red→Green→Revert→Red→Restore→Green cycle observed | "Test passes once" |
| Subagent completed task | Subagent's structured return AND `git log` shows commit AND probe ran | Subagent reply alone |
| Acceptance scenario implemented | Scenario maps to a passing test case AND the demo path runs end-to-end | Code resembles the scenario |
| Sprint complete | All tasks `done` AND full test suite passed in this turn AND review verdict captured | Each task individually green at its own time |
| Spec compliance | Each acceptance criterion has a probe/test result in this turn | "Reviewer scanned the diff" |

## Red Flags — Stop Immediately

If any of these are true, you are about to claim done without verification:

- Using "should", "probably", "looks like", "seems to"
- Expressing satisfaction before running the check ("Great!", "Perfect!", "Done!")
- About to commit, push, or transition status without running the verifier in this turn
- Trusting a subagent's return claim without confirming via `git log` and the captured probe output
- Marking a checkbox `[x]` based on the previous iteration's evidence
- Thinking "just this once" or "the test is flaky anyway"
- Tired and wanting work over

When you notice any of these, **stop, run the verifier, then proceed with real evidence**.

## Rationalization Prevention

| Excuse you will be tempted by | The actual rule |
|---|---|
| "Should work now" | RUN the verifier. Read the output. |
| "I'm confident in the change" | Confidence is not evidence. |
| "Just this once" | No exceptions. The rule has no carve-outs. |
| "The linter passed" | Linter ≠ build ≠ tests ≠ acceptance probe. |
| "Subagent reported success" | Verify independently: `git log`, probe output, file existence. |
| "The probe is the same as last time" | Ran-this-turn = evidence. Last turn's run = stale. |
| "Partial check is enough" | Partial proves nothing about the whole. |
| "I'm tired" | Exhaustion is not an excuse for false claims. |
| "Different words so the rule doesn't apply" | Spirit over letter. Any implication of completion triggers the rule. |

## Patterns to Apply

**Per-task acceptance probe (Shipyard task loop):**
```
✓ Run probe → exit 0 with last-N lines pasted into commit body → state "task done"
✗ "Tests passed earlier" → claim → flip [x]
```

**TDD Red→Green:**
```
✓ Write test → run (FAIL with expected message) → write code → run (PASS) → claim
✗ "Test passes" without observing the FAIL phase → no evidence the test exercises the right code
```

**Subagent return:**
```
✓ Subagent returns STATUS: COMPLETE + COMMIT: <sha> + PROBE_OUTPUT_TAIL → orchestrator
   verifies the sha exists in git AND the probe output matches what the task required.
✗ Subagent says "done" → orchestrator marks done.
```

**Wave/sprint roll-up:**
```
✓ Each task's evidence captured at task time → wave boundary re-runs scoped tests in this
   turn → sprint completion runs full suite in this turn → claim.
✗ "Wave 1 was green, wave 2 was green, so sprint must be green."
```

**Code review approval:**
```
✓ Reviewer runs the demo path probe in this turn AND maps each acceptance criterion to a
   pass signal AND checks the diff for stubs → approval with evidence inline.
✗ Reviewer reads the diff and reasons it should work → approval.
```

## When to Apply

**Always before:**
- Any variation of success / completion / "ready" / "done" / "fixed" / "passing" claims
- Flipping a task `status` to `done`, a feature to `done`, a sprint to `completed`
- Committing with a `feat:` / `fix:` / `chore:` message that asserts completion
- Marking `[x]` on any progress checkbox or action item
- Approving in `/ship-review`
- Returning `STATUS: COMPLETE` from a subagent
- Any user-facing message implying the work is finished

**The rule applies to:**
- Exact phrases ("tests pass", "fixed", "done")
- Paraphrases ("everything looks good", "all green", "ready to ship")
- Implications ("wrapping up Wave 2")
- Status transitions in any tracked artifact (task file, sprint file, action items file)

## Why This Matters

False completion is the #1 reliability failure in agentic development. Every false-done claim costs you: (1) trust with the user, (2) hours of "I thought this was done" rework, (3) production incidents when the gap surfaces under load.

The Iron Law is the cheapest insurance: one extra command run per claim, no infrastructure, no scanners, no enforcement code. It works because the model can reason about its own output but cannot fabricate a fresh shell exit code it didn't actually run.

## The Bottom Line

**No shortcuts. No exceptions. No "just this once."**

Run the command. Read the output. THEN claim.

This is non-negotiable.
