# Operational Task Dispatch Protocol

This reference defines how `ship-execute` runs `kind: operational` tasks. Operational tasks are fundamentally different from `kind: feature` tasks: their deliverable IS running a command and responding to its output, not writing code and committing it. Operational tasks go to `shipyard-test-runner`, NOT to `shipyard-builder`. Follow this contract whenever you dispatch a task whose `kind:` frontmatter is `operational`.

Read `skills/ship-sprint/references/task-kinds.md` first if you're new to the three-kind taxonomy.

## The silent-pass failure mode (why this exists)

Before the `kind:` field existed, every task was implicitly "write code → atomic commit." When a user filed a task like "run the full E2E suite and fix findings," Shipyard routed it to the builder. The builder:

1. Read the task, saw no implementation target.
2. Hit its "Never run the full suite during TDD" rule — the rule won, the suite was not run.
3. Had no code to write, no commit to produce.
4. Hit the "Before Exiting" gate (`git status --porcelain` clean) — passed trivially on an empty tree.
5. Returned to the orchestrator as "complete."

The task was marked done. No tests ran. The user had no idea until `ship-review`'s Stage 3 Wiring Check caught it later. On carry-over, the *same thing happened again* because nothing flagged the task class.

This dispatch path is the fix. It routes operational tasks to a different agent, gates "done" on captured command output instead of a clean tree, and emits diagnostic events so a recurrence is self-diagnosing.

## When to use this protocol

Use this protocol **when and only when** the task file frontmatter has `kind: operational`. Read the task file BEFORE spawning any agent. Do not guess the kind from the task title — users file operational tasks with titles like "fix E2E findings" that look feature-shaped.

- `kind: feature` or absent → standard builder dispatch (see parent SKILL.md Step 3)
- `kind: operational` → follow this file
- `kind: research` → follow `references/research-tasks.md` (dispatches to `shipyard-researcher`; parallel structure to this file)

## Step 1 — Resolve `verify_command`

Read `verify_command:` from the task frontmatter. Two forms:

**Literal command** (contains a space or shell metacharacters):
```yaml
verify_command: "npm run test:e2e -- --headed"
```
Use as-is.

**Config reference** (dotted path into `<SHIPYARD_DATA>/config.md`):
```yaml
verify_command: test_commands.e2e
```
Resolve by reading `config.md` and walking the dotted path. Example: `test_commands.e2e` resolves to whatever is set under the `e2e:` key inside the `test_commands:` YAML block. If the resolved value is empty or missing, HARD FAIL — do not guess. Emit `operational_task_config_missing` and return to the orchestrator with:
```
⛔ verify_command unresolved: "<dotted path>"
  Task: <TASK_ID>
  Config path <SHIPYARD_DATA>/config.md has no value at <dotted path>.
  Fix: set the command in config.md, or replace the task's verify_command with a literal.
```

**Why the config indirection exists.** If three operational tasks all reference `test_commands.e2e`, renaming the E2E runner updates every task at once. Literal commands are for one-offs that won't be reused.

## Step 2 — Dispatch to `shipyard-test-runner`

Spawn the test-runner with `shipyard-logcap run` wrapping the command, so the output is captured to a file the orchestrator can inspect after the agent returns. Name the capture after the task and attempt:

```
Capture name: <TASK_ID>-verify-iter<N>   (N = current iteration, starting at 1)
```

**Emit the start event** from the orchestrator's context block (skill-body, not the agent):
```
!`shipyard-data events emit operational_task_verify_started task=<TASK_ID> command=<resolved-command> iteration=<N>`
```

**Spawn the agent:**
```
subagent_type: shipyard:shipyard-test-runner
isolation: omit (operational tasks run on the current branch — they do not modify code)
prompt: |
  Task: <TASK_ID> (kind: operational)
  Verify command: <resolved-command>
  Capture name: <TASK_ID>-verify-iter<N>
  Iteration: <N> of <max_iterations>

  Run the verify command via shipyard-logcap so all output is captured:
    shipyard-logcap run <TASK_ID>-verify-iter<N> -- <resolved-command>

  On completion, return a structured summary:
    - exit_code: <int>
    - capture_name: <TASK_ID>-verify-iter<N>
    - duration_seconds: <float>
    - findings: [<list of specific failures, one per line, extracted from the capture>]
    - findings_count: <int>

  Do NOT modify any files. Do NOT create commits. Your job is to run the command
  and report what happened — nothing else. The orchestrator will decide what to do
  with the findings.
```

**Why no worktree isolation.** Operational tasks are read-only with respect to the working tree — they run a command, capture output, and return a summary. Isolation adds worktree creation/teardown overhead for no benefit, and the capture lives under `$TMPDIR/shipyard/` which is project-scoped anyway.

## Step 3 — Parse the result

The test-runner returns. Read its summary.

**If `exit_code == 0`:**

1. Confirm the capture is non-empty (belt-and-braces — a broken test-runner reporting exit 0 on an empty capture is exactly the failure mode this protocol exists to prevent):
   ```bash
   # pseudocode, exact command depends on shipyard-logcap output
   CAPTURE_BYTES=$(shipyard-logcap path <capture-name> | xargs wc -c | awk '{print $1}')
   ```
   If `CAPTURE_BYTES == 0` → **do NOT mark done**. Emit `operational_task_bogus_pass` with `reason=empty_capture` and escalate (see Step 5). The command claimed success but produced nothing — treat as a failure that needs investigation.

2. Write the success state to the task file frontmatter:
   ```yaml
   verify_output: <capture-name>        # logcap name, not a literal path — portable across worktrees
   status: done
   ```
   **Also append to `verify_history`:**
   ```yaml
   verify_history:
     - attempt: <N>
       at: <current ISO timestamp, UTC>
       exit: 0
       capture: <capture-name>
       findings: 0
   ```

3. Emit the success event:
   ```
   !`shipyard-data events emit operational_task_passed task=<TASK_ID> capture=<capture-name> iteration=<N>`
   ```

4. Done. Move on to the next task in the wave.

**If `exit_code != 0`:**

1. Append a failure entry to `verify_history` (same shape, `exit: <non-zero>`, `findings: <count>`).

2. Emit:
   ```
   !`shipyard-data events emit operational_task_findings_detected task=<TASK_ID> iteration=<N> findings=<count>`
   ```

3. Proceed to Step 4 — fix-findings loop.

## Step 4 — Fix-findings loop (inline sub-wave dispatch)

Operational tasks that fail verify almost always produce a list of concrete findings (failing tests, lint violations, audit hits, benchmark regressions). The dispatcher's job is to convert each finding into a `kind: feature` patch task, dispatch builders for them inline, and then re-run verify.

**This section is load-bearing. Follow the mechanical steps literally — do not improvise.** The whole point of formalizing this loop is that "Claude decides how to fix findings" was the failure mode that let the silent-pass bug exist in the first place. You are Claude, reading this reference, and the instructions below are prescriptive.

### Budget

Read `operational_tasks.max_iterations` from `<SHIPYARD_DATA>/config.md` (default `3`) and the task's `verify_max_iterations` frontmatter override if present. Read `operational_tasks.max_patch_tasks` (default `5`). Track two counters across the loop:
- `iteration` — starts at `1` (the first failed verify), increments after each full re-verify cycle.
- `cumulative_patch_count` — total patch tasks created so far across all iterations.

**Counter unit semantics (pin this down before writing eval tests):** `iteration` counts the *verify runs* that have failed. `max_iterations: 3` means *at most 3 verify attempts total* — the initial verify (which triggered the loop) plus up to 2 re-verifies. After the third failure the loop escalates at the decision tree below. This is the "tight" interpretation — prefer escalating sooner over looping longer, because the user can always manually re-dispatch. Do not off-by-one this: `iteration > max_iterations` in the decision tree is the post-increment check against this budget.

### Per-iteration protocol

#### 1. Classify findings (the actionable vs non-actionable split)

The `shipyard-test-runner` agent returned a structured summary including a `findings:` list. Each item is a single-line string describing one failure. For each finding, judge actionability against this decision table:

| Finding shape | Classification | Rationale |
|---|---|---|
| Failed assertion in a test file (`expected X got Y`) | **actionable** | Builder can fix the impl or the test |
| Lint violation (`ESLint: no-unused-vars at src/foo.ts:42`) | **actionable** | Builder can edit the file |
| Type error (`Property 'X' does not exist on type 'Y'`) | **actionable** | Builder can fix the type |
| Audit hit with a known patch (`critical vulnerability in pkg X, fixed in >=2.3.1`) | **actionable** | Builder can bump the version |
| Performance regression (`query Q slower than baseline by 45%`) | **actionable if fix is localized** — otherwise escalate |
| "Database is down" / "External API returned 500" / credentials missing | **non-actionable** | Infrastructure issue, not a code fix |
| "Network timeout" / "rate limited" | **non-actionable** (transient) | Retry, don't patch |
| Flaky test with no reproducible signal | **non-actionable** | Patch would mask, not fix |

Maintain two lists:
- `actionable_findings` — gets patch tasks in step 2
- `non_actionable_findings` — goes straight into the Step 5 escalation message if the loop terminates

If **all** findings are non-actionable, skip steps 2–4 entirely and jump to Step 5 (escalate immediately — the loop cannot make progress).

#### 2. Compute patch task IDs

Each patch task needs a unique ID that encodes the parent, iteration, and finding index. Pattern:

```
<PARENT_TASK_ID>-p<iteration><letter>
```

Where `<letter>` is `a`, `b`, `c`, …, `z` for findings 1–26 within the current iteration. Examples:
- Parent `T07`, iteration 1, three findings → `T07-p1a`, `T07-p1b`, `T07-p1c`
- Parent `T19`, iteration 2, one finding → `T19-p2a`

**If a single iteration has more than 26 actionable findings**, you are past the 5-patch-task cap anyway — escalate immediately with reason `patch_task_cap_exceeded` (Step 5). Do not wrap around to `aa`/`ab` — the loop has degenerated.

#### 3. Create the patch task file via the Write tool

For each actionable finding, use the **Write tool directly** (not `shipyard-data` CLI — there is no "create task" subcommand, and patch tasks don't need one). Target path:

```
<SHIPYARD_DATA>/spec/tasks/<PATCH_ID>-<slug>.md
```

Where `<slug>` is a lowercase-kebab-case summary of the finding (≤5 words — e.g., `t07-p1a-fix-null-auth-check.md`).

Use this literal frontmatter template, substituting the bracketed sections with real values:

```yaml
---
id: <PATCH_ID>
title: "Patch: <finding text, one-line summary>"
type: task
kind: feature
feature: <parent task's `feature:` field, inherited verbatim>
parent_operational: <PARENT_TASK_ID>
status: approved
effort: S
dependencies: []
created: <current ISO date, YYYY-MM-DD>
---

## What

Fix: <finding text verbatim>

## Acceptance Criteria

Re-running the parent operational task's verify_command (`<resolved verify_command from parent>`) must no longer report this finding.

## Technical Notes

Auto-generated by operational fix-findings loop for <PARENT_TASK_ID>, iteration <N>.
Parent task file: <path to parent task file>
Finding source: <capture name, e.g. T07-verify-iter1>
Finding text: <verbatim finding line>
```

**Hard rule — patch tasks MUST be `kind: feature`.** Recursion is forbidden. If a finding's fix is *itself* operational ("run the schema linter after this"), do NOT spawn a nested operational task. Instead, either (a) widen the current task's `verify_command` to cover both checks, or (b) leave the finding unfixed and surface it at escalation. This dispatcher MUST reject any patch task whose resolved `kind:` is not `feature`.

Increment `cumulative_patch_count` for each patch task written. If it exceeds `operational_tasks.max_patch_tasks` mid-iteration, stop writing new patch files immediately and jump to Step 5 with reason `patch_task_cap_exceeded`.

#### 4. Dispatch patch task builders — serial, solo mode, no worktrees

For each patch task written in step 3, spawn the builder **sequentially** (serial — not parallel). Parallel dispatch would race on the working branch and produce overlapping commits. Serial dispatch is the correct choice even if it's slower, because the operational dispatcher is itself running on the working branch without a worktree, and the wave graph in SPRINT.md is stable precisely because patch tasks are hidden from it.

For each patch task:
```
Agent({
  subagent_type: "shipyard:shipyard-builder",
  description: "Patch <PATCH_ID> for operational task <PARENT_TASK_ID>",
  prompt: "Task: <PATCH_ID>\nTask file: <SHIPYARD_DATA>/spec/tasks/<PATCH_ID>-<slug>.md\nWorking branch: <branch from SPRINT.md>\nData dir: <SHIPYARD_DATA>\n\nThis is a patch task created by the operational fix-findings loop for <PARENT_TASK_ID>. Follow your standard TDD cycle for the finding described in the task file.\n\nEverything else — branch verification, TDD cycle, rules, exit protocol — follows your agent body. Do not deviate."
})
```

**Important — no `isolation: worktree` parameter.** Omit it. Patch tasks commit directly to the working branch because the operational dispatcher lives on the working branch. Adding worktree isolation here would require cross-worktree merging and break the "operational runs on working branch" design.

Wait for each builder to return before starting the next. If a builder fails (returns an error, or the task it was spawned for ends up with `status: blocked` in its file), record the failure and continue with the next patch task — do not abort the iteration. The re-verify step will catch whether the failure matters.

#### 5. Re-run verify

After all patch task builders have returned:
1. Capture the current `actionable_findings` list as `previous_findings` (used by the decision tree below to detect finding-reappeared-after-fix).
2. Increment `iteration` by 1.
3. Go back to Step 2 of the overall protocol (dispatch `shipyard-test-runner` with a new capture name — `<PARENT_TASK_ID>-verify-iter<iteration>`).
4. When the test-runner returns, re-evaluate using the decision tree below.

#### 6. Loop termination decision tree

Apply this decision tree after each re-verify, in order. The first condition that matches wins:

```
after each re-verify (let "current_findings" = actionable findings from this attempt):

  if exit_code == 0:
    → SUCCESS. Jump to Step 3 success path of the overall protocol.

  else if iteration > max_iterations:
    → ESCALATE (Step 5), reason = "iteration_budget_exhausted"

  else if cumulative_patch_count > max_patch_tasks:
    → ESCALATE (Step 5), reason = "patch_task_cap_exceeded"

  else if (current_findings ∩ previous_findings) is non-empty:
    → ESCALATE (Step 5), reason = "finding_reappeared_after_fix"
       The builder claimed to fix a finding that showed up again. Looping
       further won't help — there's a deeper bug the builder can't see.

  else if all current_findings are non-actionable:
    → ESCALATE (Step 5), reason = "only_non_actionable_findings_remain"

  else:
    → CONTINUE. Go back to step 1 of the per-iteration protocol with
       the new findings. Do NOT reset counters.
```

The termination reasons are the values you pass to Step 5's `operational_task_escalated` event. Use them verbatim — `shipyard-data events grep operational_task_escalated` becomes a self-describing diagnostic surface.

#### 7. Patch task lifecycle after loop completes

Patch task files remain on disk as an audit trail after the loop ends (success or escalation). They are NOT added to SPRINT.md's wave structure, so they don't show up in sprint progress reports, but they persist under `<SHIPYARD_DATA>/spec/tasks/` so a future investigator can see what the loop tried. Each patch task file ends up with:
- `status: done` if its builder succeeded (committed the fix)
- `status: blocked` if its builder returned a blocker
- `status: approved` (unchanged from creation) if its builder was never dispatched (e.g., early escalation)

The `parent_operational:` frontmatter field is the breadcrumb back to the parent task. A future `shipyard-data` query could list all patches for a given operational task with `Grep -l "parent_operational: T07"`.

**Do not delete patch task files** as part of loop cleanup. The "clutter under spec/tasks/" is worth the diagnostic value — when the next sprint's carry-over scan surfaces a `needs-attention` parent, the patches are the evidence of what was tried.

## Step 5 — Escalation

When the loop terminates without success, do NOT mark the task done. Instead:

1. Append a final `verify_history` entry with `escalated: true` and the termination reason.
2. Set `status: needs-attention` on the task file. This status is recognized by `ship-sprint`'s carry-over scan (Step 1.5, check #6) and will surface on the next planning cycle for user decision — the user sees the last 3 `verify_history` entries and the escalation reason and explicitly chooses what to do next. Do NOT mark the task `blocked` — `blocked` is reserved for "waiting on an external dependency" and has different carry-over semantics. `needs-attention` means "tried and failed; needs human decision."
3. Emit `operational_task_escalated` with the termination reason and total iterations used.
4. Surface to the user via AskUserQuestion:
   ```
   Operational task <TASK_ID> did not converge after <N> iterations
   (<M> patch tasks created, <F> findings remaining).

   Reason: <termination reason>

   Options:
     1. Open a debug session — I'll create <SHIPYARD_DATA>/debug/<TASK_ID>.md with
        the full capture history so you can dig in manually.
     2. Promote the remaining findings into a new sprint as individual feature tasks.
     3. Mark this task accepted-with-known-issues and move on (NOT recommended for
        security or correctness verifies).
   ```
5. Based on the user's choice, either spawn a debug session, add findings to the backlog, or mark the task with an `accepted_issues:` list.

## Post-Subagent gate (for operational tasks)

This extends the parent SKILL.md Step 2 "Post-Subagent" spot-check. After the operational dispatch loop completes, before considering the task truly done, verify:

1. Task file has `verify_output:` field (not empty string, not commented out).
2. `shipyard-logcap path <verify_output>` returns an existing path.
3. That path has non-zero byte count.
4. The final `verify_history` entry has `exit: 0`.

If any of those fail, the task is NOT done regardless of what the dispatcher said. Emit `operational_task_bogus_pass` with the specific reason (`missing_verify_output`, `capture_file_missing`, `empty_capture`, `final_history_not_green`) and re-enter the loop or escalate.

This is the **last line of defense** against silent-pass regression. Even if every other check above drifted and broke, this gate catches the specific failure mode: a task marked done without captured evidence of a passing run.

## Event taxonomy (emitted by this protocol)

| Event | When | Fields |
|---|---|---|
| `operational_task_verify_started` | Step 2, before spawning test-runner | `task`, `command`, `iteration` |
| `operational_task_passed` | Step 3, after success path gate | `task`, `capture`, `iteration` |
| `operational_task_findings_detected` | Step 3, after non-zero exit | `task`, `iteration`, `findings` |
| `operational_task_bogus_pass` | Post-subagent gate catches missing/empty capture | `task`, `reason` |
| `operational_task_config_missing` | Step 1, config-key resolution fails | `task`, `verify_command` |
| `operational_task_escalated` | Step 5, loop termination without success | `task`, `reason`, `iterations` |

These are structured events (JSON lines in `.shipyard-events.jsonl`). A missing `operational_task_passed` for a task whose status is `done` is diagnostic gold: it means the task was marked done by some path other than this protocol, which is the silent-pass signature. `shipyard-context diagnose` surfaces this class automatically.

## What NOT to do

- **Do not spawn `shipyard-builder` for an operational task.** The builder has a HARD STOP guard (Step 0 of its process) and will refuse — if you somehow bypass it and dispatch anyway, the builder exits clean on an empty tree and you're back in the silent-pass bug.
- **Do not write `verify_output:` to the task file by hand**, from a skill body, or from an agent body. It is set by this protocol after the post-subagent gate passes. A hand-written `verify_output` defeats the entire integrity chain.
- **Do not skip the capture-bytes check on success.** An empty capture with exit 0 is the exact shape of the failure mode this protocol exists to prevent. A broken test runner (flaky CI, credentials missing, network down) can exit 0 without running anything.
- **Do not grow the sprint silently.** If the fix-findings loop spawns more than `max_patch_tasks`, stop and escalate. The user asked for a verify + some inline fixes, not a sprint replan.
- **Do not nest operational tasks.** Patch tasks created by this protocol MUST be `kind: feature`. If the fix is itself operational, escalate to the user.
