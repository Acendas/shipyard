---
name: dispatching-task-loop
description: Use to execute one Shipyard task (kind:feature, hotfix, or quick) via a fresh-context subagent that loops internally until its acceptance probe passes. The orchestrator's context grows by ~200 tokens per task instead of ~10,000. Pairs verifying-completion + tdd-cycle + acquiring-skill-lock with a structured return contract that makes false completion structurally hard.
disable-model-invocation: true
---

# Dispatching the Task Loop

This is how Shipyard executes one task without burning the orchestrator's context window. The subagent does the loop; the orchestrator does the gate.

**Why this exists.** Ralph Loop's reliability is structural — the loop refuses to exit until completion is real. But Ralph runs *in your session*, so every false attempt accumulates in your context. By the fifth iteration, you're operating on a summary of a summary. We move the loop into a subagent: the subagent absorbs every iteration's reasoning, false attempts, and tool calls; when it returns, only a structured summary lands in the orchestrator.

## When to Invoke

Invoke this capability skill from a command skill (`ship-execute`, `ship-quick`, `ship-bug`, hotfix path) per task. Not for `kind: research` (use `dispatching-research-task`) or `kind: operational` (use `dispatching-operational-task`) — those have different deliverables.

**Inputs the orchestrator must supply:**

- `task_id` — e.g., `T-042`
- `task_file_path` — absolute path under `<SHIPYARD_DATA>/spec/tasks/`
- `feature_file_path` — absolute path under `<SHIPYARD_DATA>/spec/features/` (or null for hotfix)
- `working_branch` — git branch name for the sprint
- `acceptance_probe` — the smoke command from the task frontmatter (required; if missing, halt and surface to the user — the task is unauthorable without one)
- `data_dir` — literal `<SHIPYARD_DATA>` path
- `worktree_path` — only when worktree-isolating (subagent/team mode); else null

## The Subagent Prompt Template

Dispatch via `Agent(subagent_type: "general-purpose", prompt: <the template below, parameterized>)`. Shipyard does not use registered agents — the dispatch is always `general-purpose` with the template inlined.

The orchestrator constructs the prompt from this template. Each `{{placeholder}}` is replaced literally. The template is intentionally written *as if it were the subagent's full instructions*, because it is.

```text
You are executing one Shipyard sprint task in an isolated subagent context.

# Task

ID: {{task_id}}
Working branch: {{working_branch}}
Worktree path: {{worktree_path_or_none}}
Data dir: {{data_dir}}

Reading list (read these files before doing anything else):
- {{task_file_path}}                         (your task spec — frontmatter + acceptance criteria)
- {{feature_file_path_or_skip}}              (parent feature spec — Technical Notes, references)
- {{data_dir}}/codebase-context.md           (project conventions, tech stack)

# The Iron Laws You Must Follow

These three rules are non-negotiable. Treat them as the most important content in this prompt.

1. **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**
   Write the test. Run it. Watch it fail. Then write the implementation. If you wrote
   code before the test, delete it and start over — do not "adapt" pre-written code.

2. **NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.**
   You may not return STATUS: COMPLETE until you have, in this subagent session,
   run the acceptance probe below and observed exit 0 with output that demonstrates
   the wiring works end-to-end. "Tests pass" is not enough. The probe must run.

3. **NO STUBS IN CODE YOU CLAIM IS COMPLETE.**
   No `pass`, `throw new Error("not implemented")`, `TODO`, lone `return null` from
   "implementations", or commented-out call sites. If you cannot finish, return
   STATUS: BLOCKED — do not pretend with a stub.

If you find yourself rationalizing past any of these ("just this once", "the test
already covers it", "I'll fix it after commit"), stop. That is the failure mode this
contract exists to prevent.

# The Cycle

Loop until the acceptance probe passes AND no stubs remain. Do not exit otherwise.

1. **Read** the task spec, parent feature, codebase-context. Identify the acceptance
   criteria and the Technical Notes (URLs, gotchas, files-to-modify).
2. **Write tests (RED)** that exercise each acceptance scenario. Place them in the
   correct test files with proper imports and assertions. Do NOT execute them — test
   *execution* is deferred (scoped tests run at the wave boundary, full suite at
   sprint completion). Your acceptance probe (step 4) is the only check that runs
   inside this task.
3. **Write implementation (GREEN)** — minimum code to satisfy the test contract you
   just wrote. Trust the assertions; the wave boundary will execute them.
4. **Run the acceptance probe** to demonstrate wiring works end-to-end:
       PROBE: {{acceptance_probe}}
   The probe is your authoritative signal. Capture exit code and the last 20 lines
   of output verbatim.
5. **If probe exit ≠ 0:** reflect on the output. What does the failure tell you about
   what's actually wired? Fix it. Re-run the probe. Loop.
6. **If probe passes:** scan your own diff for stubs (the rules above). If any stub
   remains, fix it and re-probe. Otherwise commit.
7. **Commit atomically:** `feat({{task_id}}): <one-line>` with the probe output tail
   in the commit body.
8. **Return** the structured response below.

You may iterate as many times as needed within this subagent. Your context is yours
to spend; the orchestrator only sees your final return.

# Iteration cap

If after **5 internal iterations** the probe still fails, return STATUS: BLOCKED with
a one-paragraph reason describing what you tried and what blocks completion. Do not
loop indefinitely — give the orchestrator the chance to redirect.

# Required Return Shape

When you return, your reply MUST contain these lines, exactly, on their own lines, in
this order. Anything else around them is fine but the orchestrator parses these:

    STATUS: COMPLETE
    COMMIT: <full git sha of your final commit>
    PROBE_EXIT: 0
    PROBE_OUTPUT_TAIL:
    <last 20 lines of probe output, verbatim, no truncation marker>

OR, if blocked:

    STATUS: BLOCKED
    REASON: <one paragraph, plain text, what you tried and what's stuck>

Any other shape is treated as a violation. STATUS: COMPLETE without a valid sha,
without PROBE_EXIT: 0, or without PROBE_OUTPUT_TAIL is a violation. The orchestrator
will redispatch you with the violation noted.

Begin.
```

## Orchestrator-Side Parsing and Gating

After the Agent call returns, parse the reply:

1. **Find the `STATUS:` line.** If neither `STATUS: COMPLETE` nor `STATUS: BLOCKED` is present → contract violation; treat as `STATUS: BLOCKED` with reason `contract violation: no STATUS line`.

2. **If `STATUS: COMPLETE`:**
   - Extract `COMMIT: <sha>`. Run `git cat-file -e <sha>` (or equivalent) to confirm the sha exists in the worktree's git history. If not → contract violation.
   - Extract `PROBE_EXIT: 0`. Anything else → violation.
   - Extract `PROBE_OUTPUT_TAIL:` block. Must be ≥1 non-blank line. Empty tail → violation.
   - Run the orchestrator-side **anti-stub-scan** capability skill on the diff `<base>..<sha>`. If it reports any finding above the confidence threshold → re-dispatch with the findings inline (`Your diff still contains stubs at: <list>; fix them and re-probe`).
   - All checks pass → mark task `done`, log the probe tail to the wave's progress.

3. **If `STATUS: BLOCKED`:**
   - Read `REASON:`. If the reason indicates a routing / context error (e.g., "feature spec missing", "no test command configured"), surface to the user via AskUserQuestion. Do not auto-redispatch — that loops on a structural blocker.
   - If the reason indicates an implementation difficulty (e.g., "the existing API doesn't expose what the spec needs"), apply the **single redispatch rule**: redispatch ONCE with the prior reason inlined as `Previous attempt blocked at: <reason>; please retry with this context`. If the second attempt also returns BLOCKED, mark the task `needs-attention`, log to PROGRESS.md deviations, and continue to the next task. Do NOT redispatch a third time on the same task within one wave — that's the failure mode the cap exists to prevent.

4. **Always invoke `verifying-completion` mentally** before flipping the task to `done`. The Iron Law applies at the orchestrator boundary too: "subagent said COMPLETE" is not by itself evidence; the sha-existence check, probe-output presence, and anti-stub-clean check are.

## Why This Beats Per-Iteration Stop Hooks

| Property | Stop-hook loop (Ralph) | Subagent loop (this skill) |
|---|---|---|
| Reliability gate | Promise must be true to exit | Probe + structured return + sha verification |
| Context bloat | Accumulates in user session | Discarded with subagent context |
| Concurrency | One loop per session | N parallel loops via parallel Agent calls |
| Survives `/clear` | State file | State file (sprint progress) |
| Implementation surface | Stop hook script + state file | One skill + general-purpose dispatch |
| User can interrupt | Yes (Esc) | Yes (Esc on parent) |

The subagent's exit contract is the same Iron Law as Ralph's promise — but at the subagent boundary, not the session boundary.

## Integration Notes

- **Worktree mode.** When `worktree_path` is non-null, the orchestrator pre-creates the worktree (`git worktree add` from the working branch's HEAD). The subagent's `cd` is implicit because the orchestrator passes the worktree path; the subagent operates from there. With Anthropic's `isolation: worktree` fix, you may pass `isolation: "worktree"` directly on the Agent call instead — both work; pre-creation is more explicit.
- **Test execution is deferred by default.** Tasks write tests but do NOT run them — scoped tests run at the wave boundary, full suite at sprint completion. The acceptance probe is the only check that runs inside the task; it's the wiring proof, the deferred suite is the unit-level proof. This is the only mode of operation; there's no opt-in flag.
- **Hotfix is the one exception** that DOES run tests at task level. The regression-test cycle (Red → Green → Revert → Red → Restore → Green) requires watching the test go through the full red-green-red-green motion — a deferred suite can't prove a regression test catches the specific bug. Hotfix dispatches inline this discipline; sprint dispatches don't.

## Failure Modes the Contract Catches

1. **False completion via stub.** Subagent writes `def foo(): pass`, test asserts `foo()` returns None, both pass. Probe runs against `foo()` and observes nothing happened end-to-end. STATUS: BLOCKED or, if subagent lies about probe pass, anti-stub-scan catches the stub.
2. **False completion via test that doesn't exercise the code.** Subagent's test imports the wrong module. Probe runs, observes the wiring isn't there, exits non-zero. Loop continues.
3. **Subagent self-certifies without running the probe.** Probe output absent or empty → contract violation → redispatch.
4. **Subagent returns a fake commit sha.** `git cat-file -e <sha>` fails → contract violation.

The structured return contract makes each of these structurally observable from the orchestrator side. There is no "subagent said it was done so it's done" path.

## Bottom Line

- One task → one subagent → one loop → one structured return.
- Iron Laws inside the prompt; sha verification + probe-output + anti-stub scan outside.
- Five internal iterations max, then BLOCKED. One redispatch max, then needs-attention.
- The orchestrator stays at ~10–15% context across an entire sprint.
