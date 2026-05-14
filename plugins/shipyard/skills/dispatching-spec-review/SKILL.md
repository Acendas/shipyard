---
name: dispatching-spec-review
description: Dispatch a fresh-context spec review subagent.
disable-model-invocation: true
---

# Dispatching a Spec Review

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

## The Subagent Prompt Template

Dispatch via `Agent(subagent_type: "general-purpose", prompt: <template>)`. Read-only role.

```text
You are conducting a spec compliance review for a Shipyard {{scope}}.

# Scope

{{scope_specific_intro}}

Scope:        {{scope}}                  (task | wave | feature | sprint)
Target IDs:   {{target_ids}}
Base ref:     {{base_ref}}
Head ref:     {{head_ref}}
Data dir:     {{data_dir}}

# Reading list

Read these BEFORE forming any opinion:

For each target ID, read its spec file:
  - Tasks:    {{data_dir}}/spec/tasks/<TASK_ID>-*.md
  - Features: {{data_dir}}/spec/features/<FEATURE_ID>-*.md
              + each path listed in the feature's `references:` frontmatter
For wave/sprint scope, also read:
  - {{data_dir}}/sprints/current/SPRINT.md (wave structure, included tasks)
  - {{data_dir}}/sprints/current/PROGRESS.md (deviations log)

Read the diff:
  $ git diff {{base_ref}}..{{head_ref}}

# Your Job

For each acceptance criterion in scope:

1. Identify it in the spec file (numbered list under "Acceptance Criteria" or
   equivalent section).
2. Locate the code that implements it. Use Grep / Read against the diff and the
   touched files. Trace from the spec's described observable to the code that
   produces it.
3. Verify a test exercises it. Find the test file; read the assertions; confirm
   they actually test the AC, not a watered-down version.
4. Classify the AC:
   - **MET** — implementation present, test asserts the right behavior.
   - **PARTIAL** — implementation present but the test is weak (no edge case,
     wrong assertion shape, or asserts on a stub).
   - **MISSING** — no implementation, or implementation doesn't reach the
     described observable.
   - **OVER-BUILT** — extra functionality landed that the spec did NOT request.
     This is its own finding class — over-building is a scope violation.

# The Iron Law for Reviewers

You may not return STATUS: PASS unless EVERY AC in scope is MET. PARTIAL,
MISSING, or OVER-BUILT findings → STATUS: FINDINGS.

You may not approve based on:
  - "Looks like the test would catch it"
  - "The code resembles the spec"
  - "The reviewer scanned the diff and it seems right"
  - "Most ACs are clearly met"

You may only approve based on:
  - The test file imports the implementation, and the assertion encodes the AC.
  - The implementation's flow from input to observable maps to the AC.
  - The acceptance probe (if defined for this scope) runs and exits 0.

If you can't verify an AC because the spec is ambiguous, surface it as a
PARTIAL with reason "spec ambiguous: <which part>" — do not silently MET it.

# READ-ONLY

You may NOT:
  - Edit any file.
  - Run `git commit`, `git rebase`, or any state-mutating git command.
  - Spawn other subagents.
  - Mark task statuses (the orchestrator does that based on your return).

You MAY:
  - Read files (skill body, source, tests, specs).
  - Run read-only git (log, diff, blame, show).
  - Run the acceptance probe if scope includes one — but only if the probe is
    explicitly listed in the task's `acceptance_probe:` field. Capture exit
    code + last 20 lines.

# Required Return Shape

Your reply MUST contain these lines, exactly, on their own lines:

    STATUS: PASS                                  (only when ALL ACs MET)
    FINDINGS: 0
    SCOPE: {{scope}}
    TARGETS: <comma-separated target_ids>

OR:

    STATUS: FINDINGS
    FINDINGS: <integer count>
    SCOPE: {{scope}}
    TARGETS: <comma-separated target_ids>
    -----
    [<TASK_ID>][<MET|PARTIAL|MISSING|OVER-BUILT>] AC <N>: <one-line summary>
      file: <path>:<line> (or "no implementation found")
      test: <path>:<line> (or "no test found")
      reason: <one paragraph>
    [<TASK_ID>][<...>] AC <N>: ...
    (repeat per finding)

OR, if you cannot complete the review (genuinely blocked):

    STATUS: BLOCKED
    REASON: <one paragraph, plain text>

Begin.
```

## Orchestrator-Side Action Rules

1. **`STATUS: PASS`** — record it; allow the calling skill to advance (mark task done, approve feature, etc.).

2. **`STATUS: FINDINGS`** — parse the per-finding block. Two sub-rules:

   - **Any MISSING or critical PARTIAL** (test asserts a stub) → re-dispatch the corresponding task via `dispatching-task-loop` with the findings inlined: *"Spec review found gaps: <list>; please re-implement and re-probe."* Single redispatch per task per wave (consistent with `dispatching-task-loop`'s rule). If a second pass still has findings → mark task `needs-attention`, log to PROGRESS.md, continue.
   - **Only OVER-BUILT findings** → flag in PROGRESS.md deviations table; do NOT auto-revert (the user may want to keep extras). `/ship-review` surfaces these for explicit user decision.

3. **`STATUS: BLOCKED`** — surface to user via AskUserQuestion. Likely causes: spec missing, target IDs invalid, diff range malformed. None of these are recoverable by retry.

4. **Always invoke `verifying-completion` mentally** before flipping a task to done based on PASS — the Iron Law applies at the orchestrator boundary.

## Read-Only Contract Enforcement

Even though the prompt forbids edits, the orchestrator should verify:

1. After the subagent returns, check `git status --porcelain`. If non-empty → contract violation; the subagent edited despite being told not to. Treat as `STATUS: BLOCKED` and surface.
2. Verify no new commits exist (`git rev-parse HEAD` matches `head_ref` from the inputs). If different → violation.

These checks are cheap and catch the rare model rationalization ("I'll just fix this small thing while I'm here").

## Pairing With Other Skills

- **`dispatching-task-loop`** is invoked by the orchestrator if MISSING/PARTIAL findings demand re-implementation. The findings string is passed in the task-loop prompt as additional context.
- **`running-acceptance-probe`** may be invoked by the spec reviewer (per the prompt) to validate a probe-defined AC. Same probe contract, just a read-only execution.
- **`anti-stub-scan`** is a *structural* stub check; this skill is the *semantic* spec-vs-code check. They complement: anti-stub catches "the function body is `pass`"; spec-review catches "the function exists but doesn't satisfy AC #3."

## Bottom Line

- Read-only subagent that maps ACs to code + tests.
- PASS only when every AC is MET. PARTIAL, MISSING, OVER-BUILT → FINDINGS.
- Structured per-finding return; orchestrator decides re-dispatch vs flag vs block.
- One redispatch per task per wave; then `needs-attention`.
- The 5th of 14 capability skills overall; replaces `shipyard-review-spec` agent.
