---
name: verifying-completion
description: Verify completion claims with evidence before commit.
disable-model-invocation: true
---

# Verifying Completion

A task is "done" only when its acceptance is observable — right now, in this turn, with output you read. Internal confidence, prior runs, and "it should work" are not evidence.

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

No completion claim is permitted unless the verification command ran in this message. Period.

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
- Status transitions in any tracked artifact (step file, sprint file, action items file)
