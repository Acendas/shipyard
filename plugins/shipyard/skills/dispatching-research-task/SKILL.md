---
name: dispatching-research-task
description: Dispatch a Shipyard research task subagent.
disable-model-invocation: true
---

# Dispatching a Research Task

A `kind: research` task answers a question. Its deliverable is a markdown findings doc, not code. The subagent reads (codebase, web, docs), reasons, and writes a single output file. Wrong dispatch → silent-pass bug: feature builders have no Red step for a research-shaped task and exit clean on an empty tree, satisfying the "Before Exiting" gate trivially. Route here.

## When to Invoke

`/ship-execute` calls this skill when a task's frontmatter has `kind: research`. Other entry points:

- `/ship-discuss` may invoke this for an inline technical investigation during feature shaping ("which JWT library should we use?").
- `/ship-sprint` may invoke this during planning when a feature can't be specced without a design tradeoff analysis.

Per the action items, the routing decision (`kind: feature` vs `operational` vs `research`) lives in the calling command skill. This skill assumes the routing already chose research.

## Inputs

- `task_id` — e.g., `R-013` (research tasks conventionally use `R-` prefix, but any ID works).
- `task_file_path` — absolute path under `<SHIPYARD_DATA>/spec/tasks/`.
- `parent_feature_path` — absolute path or null.
- `data_dir` — literal `<SHIPYARD_DATA>` path.
- `findings_dir` — `<SHIPYARD_DATA>/research/` (computed; the only writable area).
- `expected_findings_filename` — derived from task ID + slug, e.g., `R-013-jwt-library-evaluation.md`.

## The Subagent Prompt Template

Dispatch via `Agent(subagent_type: "general-purpose", prompt: <template>)`. Note: this subagent has a `Write` scope contractually limited to ONE file in `<SHIPYARD_DATA>/research/`. Any write outside that path is a contract violation.

```text
You are conducting a Shipyard research task. Your deliverable is ONE markdown
findings doc — no code, no commits, no infrastructure changes.

# Task

ID: {{task_id}}
Task file: {{task_file_path}}
Parent feature: {{parent_feature_path_or_none}}
Data dir: {{data_dir}}
Findings dir: {{findings_dir}}
Expected output file: {{findings_dir}}/{{expected_findings_filename}}

# Reading list

Read these BEFORE writing anything:

  - {{task_file_path}} — the research question and what's expected
  - {{parent_feature_path_or_skip}} — feature context if applicable
  - {{data_dir}}/codebase-context.md — project conventions, tech stack
  - Any URLs / paths the task's Technical Notes references — WebFetch them

# Your Job

Investigate the question. Produce a structured findings doc with at least one
concrete recommendation backed by evidence. Tradeoffs > prescriptions.

# Write Scope (HARD GATE)

You may Write EXACTLY ONE FILE: {{findings_dir}}/{{expected_findings_filename}}

You may NOT:
  - Write anywhere else in the repo.
  - Edit existing source files.
  - Run `git commit`, `git rebase`, or any state-mutating git command.
  - Modify the task file directly (the orchestrator updates research_output:
    based on the path you wrote).
  - Spawn other subagents.

Any write outside the expected output path will be detected by the
orchestrator's post-return porcelain check and trigger a research_out_of_scope_write
escalation. Do NOT attempt this even if you think it would be helpful.

You MAY:
  - Read freely (codebase, docs, the task file).
  - Run read-only git (log, diff, blame, show) and read-only shell (ls, grep,
    find — for codebase pattern scans).
  - Use WebFetch / WebSearch for external research.
  - Iterate on the findings doc as you investigate (multiple Writes to the
    SAME file are fine; the orchestrator only checks final state).

# Findings Doc Template

The output file MUST follow this structure. The orchestrator's gate verifies
at least one `### Finding` section exists; missing → research_task_bogus_pass.

    ---
    task_id: {{task_id}}
    completed_at: <ISO 8601>
    sources_consulted:
      - <URL or file path>
      - <URL or file path>
    ---

    # Research: <one-line restatement of the question>

    ## TL;DR

    <2-3 sentences: the headline conclusion the user can act on without reading
    the rest>

    ## Context

    <Why this question exists, what triggered it, what's at stake.>

    ### Finding 1: <one-line headline>

    **Claim.** <The thing you're asserting.>
    **Evidence.** <Specific URLs, code refs, benchmarks, or doc citations.>
    **Confidence.** HIGH | MEDIUM | LOW
    **Tradeoff.** <What does picking this give up?>

    ### Finding 2: <one-line headline>

    (same shape)

    ## Recommendation

    <Pick one or rank the options. Be explicit about the tradeoff. "It depends"
    is rarely a useful recommendation; if it depends, on what, and what's the
    decision matrix?>

    ## Open Questions

    <Anything that surfaced during research but couldn't be resolved in scope.
    Will surface in the next /ship-sprint as new tasks if substantive.>

# When to Stop

Stop when you can write a confident TL;DR and at least one Finding with HIGH
or MEDIUM confidence and a clear tradeoff. Don't pad the doc with low-value
findings to look thorough.

If after a reasonable investigation (≤ 30 min of search/read time) you cannot
form a recommendation, return STATUS: BLOCKED with a note about what's missing
(e.g., "the chosen library has no public benchmarks; recommend a 1-day spike
task to measure under our load").

# Required Return Shape

Your reply MUST contain these lines, exactly:

    STATUS: COMPLETE
    OUTPUT_PATH: {{findings_dir}}/{{expected_findings_filename}}
    FINDINGS_COUNT: <integer ≥ 1>
    TLDR: <1-3 sentences from the doc, verbatim>

OR:

    STATUS: BLOCKED
    REASON: <one paragraph>

Begin.
```

## Orchestrator-Side Gate (the silent-pass killer)

After the Agent call returns, before flipping the task to `done`:

1. **Find the `STATUS:` line.** Missing or invalid → contract violation; treat as `STATUS: BLOCKED` with reason `contract violation: no STATUS line`.

2. **If `STATUS: COMPLETE`:**

   a. **Verify the output file exists at `OUTPUT_PATH`.** Use `Read`. Missing → emit `research_task_bogus_pass` event with `reason=output_file_missing`. Do NOT mark done.

   b. **Verify the file is non-empty** (substantive body, not just frontmatter). Empty / nearly empty → `research_task_bogus_pass` with `reason=empty_findings_doc`.

   c. **Verify at least one `### Finding` section** exists (Grep for `^### Finding`). Zero matches → `research_task_bogus_pass` with `reason=no_findings_reported`.

   d. **Write-scope porcelain check** (the hard gate that catches subagents that "helpfully" edit code while researching):
      - Snapshot the working tree's status before dispatch (or rely on a clean tree).
      - After return, run `git status --porcelain` and `git diff --name-only`. The ONLY new/modified file should be the expected `OUTPUT_PATH` (relative to repo root if findings_dir is in-tree; or no in-tree changes if findings_dir is in `<SHIPYARD_DATA>` outside repo).
      - Any other write → emit `research_out_of_scope_write` event with the unexpectedly modified files. Escalate directly via AskUserQuestion. Do NOT retry — retrying produces another out-of-scope write. The task moves to `needs-attention`.

   e. **Update the task file's `research_output:` field** with the relative path to `OUTPUT_PATH` (relative to `findings_dir`). The task is now done.

3. **If `STATUS: BLOCKED`:** read `REASON:`. If recoverable (transient — e.g., network error during WebFetch), single redispatch is allowed. If structural (e.g., "no public benchmarks for the library"), surface to user via AskUserQuestion — possibly the answer is to spawn a new task that includes a measurement step.

## Pairing With Other Skills

- **Routing.** The calling command skill (typically `/ship-execute`) decides `kind: feature` vs `operational` vs `research` BEFORE dispatching. This skill assumes the choice was research.
- **`verifying-completion`** applies at the orchestrator boundary: STATUS: COMPLETE alone is not evidence; the file existence + non-empty + ≥1 Finding + porcelain-clean checks are.
- **`acquiring-skill-lock`** is held by the calling command skill; this skill doesn't acquire its own.
- **`anti-stub-scan`** does NOT run on research tasks — there's no diff to scan.

## Why This Skill Exists Separately

Research tasks have a fundamentally different shape from feature tasks: no Red step, no commit, no probe, no test. Trying to shoehorn them through `dispatching-task-loop` would either weaken that loop's contract (probe optional, commit optional) or silently mis-route research as feature work.

Splitting it out keeps `dispatching-task-loop` strict (probe + commit always required) and makes the research path explicit (single-file write scope + Findings template).

## Bottom Line

- Subagent has Write scoped to ONE findings doc; nothing else.
- Output validates: file exists, non-empty, ≥ 1 `### Finding`.
- Porcelain check catches helpful-but-out-of-scope edits.
- Different shape from feature tasks; don't fold it back in.
- 11th of 14 capability skills.
