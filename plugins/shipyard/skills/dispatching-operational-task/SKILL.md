---
name: dispatching-operational-task
description: Use to execute one Shipyard task with kind:operational — run a verification command (E2E suite, lint sweep, security scan, build), capture output verbatim, then fix findings in a bounded sub-loop until the verify command exits 0. Different deliverable shape than feature or research tasks.
disable-model-invocation: true
---

# Dispatching an Operational Task

A `kind: operational` task is one whose deliverable is **a successful run of a named command**, captured to disk so the orchestrator and `/ship-review` can verify it actually happened. Examples: "Run the full E2E suite and fix findings until green," "Run the security audit and fix HIGH issues," "Bring the linter to zero errors."

Operational tasks have no Red step, no acceptance probe (the command itself is the gate), and no atomic feature commit (fixes commit as they go). Mis-routing this through `dispatching-task-loop` is the silent-pass bug — the feature builder has no work to do (no Red, tests already exist), exits clean on an empty tree, and the "Before Exiting" gate trivially passes. Route here.

## When to Invoke

`/ship-execute` calls this skill when a task's frontmatter has `kind: operational`. Other entry points:

- `/ship-review` may invoke this for the wave-level "run full suite" check (though normally `/ship-execute`'s sprint-completion step handles that).
- Manual invocation when a user wants Shipyard to drive a fix-findings loop on an ad-hoc basis.

## Inputs

- `task_id` — e.g., `O-007` (operational tasks conventionally use `O-` prefix).
- `task_file_path` — absolute path under `<SHIPYARD_DATA>/spec/tasks/`.
- `verify_command` — resolved command. Either a literal command or a config-key reference like `test_commands.e2e` (resolved to the literal command from `<SHIPYARD_DATA>/config.md`).
- `data_dir` — literal `<SHIPYARD_DATA>` path.
- `working_branch` — git branch.
- `worktree_path` — null for operational (works on working branch directly; operational changes don't isolate well).
- `max_iterations` — fix-findings loop cap. Default 3 from `config.md` `operational_tasks.max_iterations`.
- `max_patch_tasks` — scope-creep guard for findings that spawn new tasks. Default 5.

## Two-Phase Flow

Operational tasks run in two phases inside the subagent's loop:

### Phase 1 — Run + Capture

1. Resolve the verify command (handle `test_commands.e2e` style indirection).
2. Run the command via **Monitor** so progress and failures stream to the orchestrator/user as notifications instead of arriving as one blob at the end. The capture file remains the source of truth for the structured return:
   ```
   Monitor(
     command: "(<verify_command>) 2>&1 | tee <SHIPYARD_DATA>/captures/<task_id>/run-<N>.log | grep -E --line-buffered '<filter-pattern>'",
     description: "<task_id> verify run <N>",
     timeout_ms: <bounded; default 1800000 (30m), cap 3600000>
   )
   ```
   `<N>` is the iteration number, starting at 1. Monitor exits when the verify command exits; the exit code Monitor reports IS the verify command's exit code (the tee/grep tail does not mask it because we wrap the verify in `(…)` and pipe explicitly — but verify the exit propagates by reading the capture's last line if in doubt).

   **Filter pattern — must cover both progress and failure modes.** Silence is not success. Author the regex so a crash, a hang, or an unexpected non-zero exit produces *some* event the user can see. Concretely, the alternation should include:
   - At least one progress marker the runner emits per file/case (e.g., `PASS|FAIL|✓|✗`, `passed|failed|skipped`, `\\[OK\\]|\\[ERR\\]`).
   - Failure signatures the agent would act on: `Traceback|Error|FAILED|assert|Killed|OOM|Segmentation fault|panic:|exit code [^0]`.
   - For test runners specifically: also include `Tests:|Suites:|Ran [0-9]+|^FAIL `-style summary lines so a green run still produces a final event.

   When in doubt, broaden the filter — extra events are recoverable; a silent crashloop is not.

3. After Monitor exits, capture its reported exit code AND read the capture file from disk (the file is the authoritative artifact; Monitor notifications are ephemeral). Take the last 20 lines for `LAST_LINES`.
4. Append to the task's `verify_history:` frontmatter:
   ```yaml
   verify_history:
     - iteration: 1
       command: "<resolved command>"
       exit: <code>
       capture: "captures/<task_id>/run-1.log"
       at: "<ISO timestamp>"
   ```

### Phase 2 — Fix-Findings Loop

If exit was non-zero, parse the capture for findings (the subagent reads the captured output; format depends on the tool). For each finding:

- **In-scope** (relates to recent work, fixes a real failure): apply a fix in-place. Commit atomically: `fix(<task_id>): <one-line>`.
- **Out-of-scope** (pre-existing, unrelated to this task's intent): file as a bug task (idea file under `<SHIPYARD_DATA>/spec/ideas/` if not yet a task; or a `B-*` bug if it warrants a sprint slot). Cap at `max_patch_tasks` to prevent scope creep.

After fixes commit, re-run Phase 1 (iteration N+1). Loop until exit 0 or `max_iterations` reached.

## The Subagent Prompt Template

Dispatch via `Agent(subagent_type: "general-purpose", prompt: <template>)`.

```text
You are executing one Shipyard operational task. Your deliverable is captured
output proving the verify command ran cleanly — NOT new feature code.

# Task

ID: {{task_id}}
Task file: {{task_file_path}}
Verify command: {{verify_command_resolved}}
Working branch: {{working_branch}}
Data dir: {{data_dir}}
Max iterations: {{max_iterations}}
Max patch tasks (scope guard): {{max_patch_tasks}}

# Reading list

  - {{task_file_path}} — task scope, what counts as "fixed"
  - {{data_dir}}/codebase-context.md — project conventions
  - {{data_dir}}/config.md — test command resolution if needed

# The Iron Laws You Must Follow

1. **NO COMPLETION CLAIM WITHOUT exit-0 CAPTURE.** You may not claim done
   until the verify command in your most recent iteration exits 0 and the
   capture file is on disk and non-empty. "It probably passes now" is not
   evidence — run it again.

2. **NO STUB FIXES.** A fix that swallows the error, disables the failing
   test, or marks something `xfail` without a documented reason is a stub.
   Fix root causes. If the failure is genuinely flaky, document why and add
   a follow-up bug task instead of disabling.

3. **NO SCOPE CREEP.** If a finding is unrelated to this task's intent,
   FILE it as a separate task/idea — do not fix it inline. The {{max_patch_tasks}}
   cap exists to keep operational tasks bounded.

# The Loop

1. **Run + capture (stream via Monitor).** Run the verify command via the
   Monitor tool so progress and failures land as events while the run is in
   flight. Tee output to a stable capture path; the file remains the
   authoritative artifact.

       Monitor(
         command: "({{verify_command_resolved}}) 2>&1 | tee {{data_dir}}/captures/{{task_id}}/run-<iteration>.log | grep -E --line-buffered '<filter>'",
         description: "{{task_id}} verify run <iteration>",
         timeout_ms: 1800000
       )

   The `<filter>` regex MUST match BOTH progress markers (so a healthy run
   still produces events) AND failure signatures (so a crash, hang, or
   non-zero exit produces events). Silence is not success. Suggested base:

       PASS|FAIL|✓|✗|passed|failed|skipped|Tests:|Suites:|Ran [0-9]+|Traceback|Error|FAILED|assert|Killed|OOM|Segmentation fault|panic:|exit code [^0]

   Tighten or extend per the runner in use; when in doubt, broaden it. After
   Monitor exits, take its reported exit code as the verify command's exit
   code, and Read the capture file from disk to extract the LAST_LINES tail.

   For very short verify commands (under ~10 seconds total), plain blocking
   Bash with tee is fine — Monitor's overhead isn't worth it for sub-second
   feedback. The threshold is whether streaming progress would meaningfully
   help the user or orchestrator know the run is still alive.

2. **Update task frontmatter.** Append the iteration to verify_history:
       verify_history:
         - iteration: <N>
           command: "<resolved command>"
           exit: <code>
           capture: "captures/{{task_id}}/run-<N>.log"
           at: "<ISO timestamp>"

3. **If exit == 0:** stop. Set verify_output: pointing at the latest capture.
   Return STATUS: COMPLETE.

4. **If exit ≠ 0:** parse the capture. For each finding:
   - In-scope → fix it; commit atomically as `fix({{task_id}}): <one-line>`.
   - Out-of-scope → file as a bug or idea (cap at {{max_patch_tasks}});
     do NOT fix inline.

5. **Increment iteration.** Loop to step 1. Cap at {{max_iterations}};
   beyond cap, return STATUS: BLOCKED with the latest capture's failure
   summary.

# Required Return Shape

Your reply MUST contain these lines, exactly:

    STATUS: COMPLETE
    VERIFY_OUTPUT: captures/{{task_id}}/run-<final-N>.log
    FINAL_EXIT: 0
    ITERATIONS_RUN: <integer>
    PATCH_TASKS_FILED: <integer>
    LAST_LINES:
    <last 20 lines of the final capture, verbatim>

OR:

    STATUS: BLOCKED
    REASON: <one paragraph: what's still failing and why>
    VERIFY_OUTPUT: captures/{{task_id}}/run-<final-N>.log
    FINAL_EXIT: <non-zero>
    ITERATIONS_RUN: <integer>

Begin.
```

## Orchestrator-Side Gate (the second silent-pass killer)

Before flipping the operational task to `done`:

1. **Find the `STATUS:` line.** Missing → contract violation; treat as BLOCKED.

2. **If `STATUS: COMPLETE`:**

   a. **Verify the task file's `verify_output:` field is now populated** with the path returned. Missing or empty → emit `operational_task_bogus_pass` with `reason=missing_verify_output`. Do NOT mark done.

   b. **Verify the capture file exists at that path AND is non-empty.** Use `Read` and check size. Missing/empty → `operational_task_bogus_pass` with `reason=capture_file_missing` or `reason=empty_capture`.

   c. **Verify the final `verify_history` entry has `exit: 0`.** If the last attempt exited non-zero, the task is not done regardless of what the subagent claims — emit `operational_task_bogus_pass` with `reason=final_history_not_green`.

   d. **Verify `LAST_LINES:` content matches the tail of the capture file** (sanity check that the subagent didn't fabricate). If divergent → contract violation.

   e. All checks pass → mark task `done`. Note the `PATCH_TASKS_FILED` count in PROGRESS.md so the user knows new tasks materialized.

3. **If `STATUS: BLOCKED`:** read the failing tail; surface to user via AskUserQuestion. Likely options:
   - User fixes manually and re-runs the task
   - Defer to next sprint
   - Mark `xfail` with explicit reason (rare; document in task file)

## Heads-up: Three Anti-Patterns to Catch

The combination of (Iron Law in prompt) + (orchestrator-side gate) catches:

1. **Subagent claims done without running** (no capture file, or capture is from a previous run): gate steps a/b/c catch all variants.
2. **Subagent disables failing tests instead of fixing**: gate steps b/c don't catch this directly — `dispatching-code-review` (test concern) does, ideally invoked at sprint-completion. Operational tasks intrinsically can fall to this if not paired with code-review.
3. **Subagent fabricates a green capture**: gate step d (`LAST_LINES:` vs file tail) catches divergence.

## Note on logcap

The `shipyard-logcap` CLI is not required for the basic capture path — plain `tee` to a deterministic path under `<SHIPYARD_DATA>/captures/` is enough for typical operational tasks. logcap is preferable when you need rotation, grouping, or line-boundary-safe streaming for long-running processes.

## Pairing With Other Skills

- **Routing.** The calling command skill (`/ship-execute`) decides `kind: operational` vs feature vs research BEFORE dispatching. This skill assumes the choice was operational.
- **`verifying-completion`** at the orchestrator boundary: STATUS: COMPLETE alone isn't evidence; the verify_output + capture-file + final exit:0 + LAST_LINES match are.
- **`acquiring-skill-lock`** is held by the calling command skill; this skill doesn't acquire its own.
- **`anti-stub-scan`** does NOT run on operational tasks — there's no acceptance probe diff to scan; the verify command is the gate.
- **`dispatching-task-loop`** is invoked separately if a Phase 2 finding requires significant new code (rare; usually fixes are local).

## Why This Skill Exists Separately

Operational tasks are inherently iterative (Phase 2 fix-findings is a sub-loop) and their deliverable is a *log file*, not a *commit*. Folding this into `dispatching-task-loop` would either:
- Weaken task-loop's "atomic commit per task" rule (operational tasks have many small fix commits), or
- Force operational fixes through the probe contract (operational tasks have no probe — the verify command IS the probe), or
- Silently mis-route operational work through the feature path (the silent-pass bug).

Splitting it out keeps task-loop strict and makes the operational path explicit (verify_command → run/capture → fix-loop → exit-0 evidence).

## Bottom Line

- Run the verify command, capture verbatim, fix findings, loop until exit 0.
- Subagent's deliverable is the capture file, not a commit.
- Orchestrator-side gate: verify_output populated + capture exists + last entry exit:0 + LAST_LINES match.
- Bounded by max_iterations (default 3) and max_patch_tasks (default 5).
- Replaces references/operational-tasks.md and shipyard-test-runner agent.
- 12th of 14 capability skills.
