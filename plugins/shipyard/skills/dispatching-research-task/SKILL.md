---
name: dispatching-research-task
description: Dispatch a Shipyard research task subagent.
disable-model-invocation: true
---

# Dispatching a Research Task

**Render before asking.** Before any AskUserQuestion, render the decision context as assistant chat text. Content that exists only in a Read result, a subagent/Agent return, or the question/option strings **does not count as rendered** (the UI shows a compact card) — restate it in chat first.

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

## Dispatching the Researcher

The researcher methodology (the write-scope hard gate, the reading list, the
findings-doc template, when-to-stop, and the Required Return Shape) lives in
the registered agent `agents/shipyard-researcher.md` — read it once if you
need to know exactly what it does; do not re-inline it here.

**Model tier (build).** Read `models.build` from config.md — the invoking command skill's `!` context block, or a Read of `<SHIPYARD_DATA>/config.md`. If the value is non-empty, pass `model: <value>` in the Agent call; if empty or absent, OMIT the `model:` field entirely so the subagent inherits the session model. Never hardcode a model literal.

Dispatch:

```
Agent(
  subagent_type: "shipyard:shipyard-researcher",
  model: <models.build value, or omit>,
  prompt: "
    Task ID:         {{task_id}}
    Task file:       {{task_file_path}}
    Parent feature:  {{parent_feature_path_or_skip}}
    Data dir:        {{data_dir}}
    Findings dir:    {{findings_dir}}
    Expected output: {{findings_dir}}/{{expected_findings_filename}}
  "
)
```

Note: this subagent has a `Write` scope contractually limited to ONE file in
`<SHIPYARD_DATA>/research/`. Any write outside that path is a contract
violation, caught by the orchestrator-side gate below.

## Orchestrator-Side Gate (the silent-pass killer)

The reviewer's `STATUS: COMPLETE` return also carries `OUTPUT_PATH:`,
`FINDINGS_COUNT:`, and `TLDR:` — the gate below is what turns those claimed
fields into verified ones (`FINDINGS_COUNT:` is not trusted directly; step c
re-derives it via Grep).

After the Agent call returns, before flipping the task to `done`:

1. **Find the `STATUS:` line.** Missing or invalid → contract violation; treat as `STATUS: BLOCKED` with reason `contract violation: no STATUS line`.

   **Silent return** — the Agent return is present but no `STATUS:` line appears, or the body is empty/whitespace. Treat this as its own outcome, distinct from COMPLETE/BLOCKED: `shipyard-data task set-status <id> needs-attention --reason "silent_return"`, emit `research_task_bogus_pass reason=silent_return`, and re-dispatch ONCE with the same brief. If the re-dispatch is also silent, stop re-dispatching and surface it as a `STATUS: BLOCKED`-shaped ask instead of looping.

2. **If `STATUS: COMPLETE`:**

   a. **Verify the output file exists at `OUTPUT_PATH`.** Use `Read`. Missing → emit `research_task_bogus_pass` event with `reason=output_file_missing`. Do NOT mark done.

   b. **Verify the file is non-empty** (substantive body, not just frontmatter). Empty / nearly empty → `research_task_bogus_pass` with `reason=empty_findings_doc`.

   c. **Verify at least one `### Finding` section** exists (Grep for `^### Finding`). Zero matches → `research_task_bogus_pass` with `reason=no_findings_reported`.

   d. **Write-scope porcelain check** (the hard gate that catches subagents that "helpfully" edit code while researching):
      - Snapshot the working tree's status before dispatch (or rely on a clean tree).
      - After return, run `git status --porcelain` and `git diff --name-only`. The ONLY new/modified file should be the expected `OUTPUT_PATH` (relative to repo root if findings_dir is in-tree; or no in-tree changes if findings_dir is in `<SHIPYARD_DATA>` outside repo).
      - Any other write → emit `research_out_of_scope_write` event with the unexpectedly modified files (keep this emit — it carries the modified-files list, which the generic task-status event doesn't capture). Escalate directly via AskUserQuestion — first render the modified-files list (from `git status --porcelain`) as chat text; git output and the event payload exist only in context and do not count as shown to the user. Do NOT retry — retrying produces another out-of-scope write. Run `shipyard-data task set-status <id> needs-attention --reason "out_of_scope_write"` to move the task.

   e. **Update the task file's `research_output:` field** with the relative path to `OUTPUT_PATH` (relative to `findings_dir`). The task is now done.

3. **If `STATUS: BLOCKED`:** read `REASON:`. If recoverable (transient — e.g., network error during WebFetch), single redispatch is allowed. If structural (e.g., "no public benchmarks for the library"), quote the subagent's `REASON:` verbatim as chat text (subagent-return content does not count as rendered), then AskUserQuestion — possibly the answer is to spawn a new task that includes a measurement step.

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
