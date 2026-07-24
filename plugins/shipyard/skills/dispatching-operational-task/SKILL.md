---
name: dispatching-operational-task
description: Dispatch a Shipyard operational task subagent.
disable-model-invocation: true
---

# Dispatching an Operational Task

**Render before asking.** Before any AskUserQuestion, render the decision context as assistant chat text. Content that exists only in a Read result, a subagent/Agent return, or the question/option strings **does not count as rendered** (the UI shows a compact card) — restate it in chat first.

A `kind: operational` task is one whose deliverable is **a successful run of a named command**, captured to disk so the orchestrator and `/ship-review` can verify it actually happened. Examples: "Run the full E2E suite and fix findings until green," "Run the security audit and fix HIGH issues," "Bring the linter to zero errors."

Operational tasks have no Red step, no acceptance probe (the command itself is the gate), and no atomic feature commit (fixes commit as they go). Mis-routing this through `dispatching-task-loop` is the silent-pass bug — the feature builder has no work to do (no Red, tests already exist), exits clean on an empty tree, and the "Before Exiting" gate trivially passes. Route here.

## Goal-mode default

This skill is /goal-shaped at the operational-task level: "run until the verify command exits 0." The Phase 1 (run+capture) → Phase 2 (fix-findings) → Phase 1 cycle is the /goal loop. It runs `max_iterations` (default 3 from config) times before returning `STATUS: BLOCKED` — there is no flag, no opt-in, no user prompt mid-loop. The cap is the only escape; otherwise the subagent stays inside the loop until the verify command exits 0. (This loop runs synchronously via Monitor; for the broader `/goal`-loop pacing discipline shared with the ScheduleWakeup-driven wave/sprint verifiers, see `references/schedule-wakeup-discipline.md`.)

The orchestrator does not surface mid-loop to the user. The subagent absorbs every fix attempt, every re-run, every patch-task filing. Only the final structured return — `STATUS: COMPLETE` with `verify_output:` populated and the last capture's exit:0, or `STATUS: BLOCKED` with the failing-tail summary — reaches the orchestrator.

Emit a `operational_iteration` event from inside the subagent per cycle (`shipyard-data events emit operational_iteration task=<id> iteration=<N> exit=<code> findings=<count>`) so a user inspecting `/ship-status` or the event log mid-run can see the loop converging without re-reading the capture file. (The events this skill emits and the broader pipeline event vocabulary are cataloged in `references/event-types.md`.)

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
2. Run the command via **Monitor** so progress and failures stream to the orchestrator/user as notifications instead of arriving as one blob at the end. The capture file remains the source of truth for the structured return.

   **Exit-code propagation — sentinel-file pattern.** A naive `<verify> | tee | grep` is broken in two ways: grep returning 1 on no-match would falsely flag a clean green run as failed, and `|| true` to suppress that swallows the *verify's* failure too. `set -o pipefail` plus `${PIPESTATUS[0]}` doesn't save you either — `|| true` resets PIPESTATUS by the time you read it. The robust pattern writes the verify's exit code to a sentinel file inside the subshell, BEFORE the pipe:

   ```
   Monitor(
     command: "( (<verify_command>); echo $? > <SHIPYARD_DATA>/captures/<task_id>/run-<N>.exit ) 2>&1 | tee <SHIPYARD_DATA>/captures/<task_id>/run-<N>.log | grep -E --line-buffered '<filter-pattern>' || true",
     description: "<task_id> verify run <N>",
     timeout_ms: 1800000
   )
   ```

   The inner `(<verify_command>)` matters: if verify itself contains `exit`, that `exit` only terminates the inner subshell. The outer shell then runs `echo $?` against the inner's exit code and writes the sentinel. Without the inner subshell, a verify like `printf '...'; exit 2` would terminate the surrounding subshell before the echo ran, and the sentinel file would never appear.

   After Monitor returns, Read `run-<N>.exit` for the authoritative exit code. The `|| true` on the grep is fine here — grep's exit no longer matters because the sentinel is the source of truth. Works under `bash`, `sh`, `dash`, `zsh` without shell-option assumptions.

   `<N>` is the iteration number, starting at 1.

   `<N>` is the iteration number, starting at 1.

   **Filter pattern — must cover progress AND failure.** Silence is not success. The alternation must include at least one progress marker (so a healthy run produces events) AND at least one failure signature (so a crash, hang, or non-zero exit produces events). A regex that catches only `PASS` is *exactly* the silent-crashloop case the rule exists to prevent.

   - Progress tokens (pick at least one per runner): `PASS`, `passed`, `✓`, `Tests:`, `Suites:`, `Ran [0-9]+`, `\\[OK\\]`.
   - Failure tokens (pick at least one): `FAIL`, `failed`, `✗`, `Traceback`, `Error`, `FAILED`, `assert`, `Killed`, `OOM`, `Segmentation fault`, `panic:`, `\\[ERR\\]`.

   When in doubt, broaden the filter — extra events are recoverable; a silent crashloop is not.

   **Notification budget.** Each filtered line is a notification = a turn cost. Aim for ~50 notifications per run. For suites with hundreds of tests, prefer summary-line filters (`Tests:|Suites:|Ran [0-9]+|^FAIL `) over per-case PASS/FAIL — the summary still surfaces final state plus any individual failure. Per-runner suggestions in `references/monitor-filters.md`.

3. After Monitor exits, Read `run-<N>.exit` for the authoritative exit code. Read the capture file from disk (the file is the authoritative artifact; Monitor notifications are ephemeral). Take the last 20 lines for `LAST_LINES`.
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

## Dispatching the Operational Task

The operational-task methodology (the three Iron Laws, The Loop — Monitor +
sentinel-file exit-code propagation + the progress-AND-failure filter
contract + notification budget, `task append-verify`, and the Required
Return Shape) lives in the registered agent
`agents/shipyard-operational-task.md` — read it once if you need to know
exactly what it does; do not re-inline it here. The sentinel/filter recipe
now lives only in the agent body; `references/monitor-filters.md` is passed
as a path in the brief for runner-specific recipes.

**Model tier (build).** Read `models.build` from config.md — the invoking command skill's `!` context block, or a Read of `<SHIPYARD_DATA>/config.md`. If the value is non-empty, pass `model: <value>` in the Agent call; if empty or absent, OMIT the `model:` field entirely so the subagent inherits the session model. Never hardcode a model literal.

Dispatch:

```
Agent(
  subagent_type: "shipyard:shipyard-operational-task",
  model: <models.build value, or omit>,
  prompt: "
    Task ID:                {{task_id}}
    Task file:               {{task_file_path}}
    Verify command:          {{verify_command_resolved}}
    Working branch:          {{working_branch}}
    Data dir:                {{data_dir}}
    Max iterations:          {{max_iterations}}
    Max patch tasks (scope): {{max_patch_tasks}}
    Monitor filters ref:     {{data_dir or plugin path}}/references/monitor-filters.md
  "
)
```

The subagent's `STATUS: COMPLETE` return carries `VERIFY_OUTPUT:`,
`FINAL_EXIT: 0`, `ITERATIONS_RUN:`, `PATCH_TASKS_FILED:`, and `LAST_LINES:`; a
`STATUS: BLOCKED` return may carry an `ESCALATION_CODE:` (one of
`verify_flaky | external_dependency_unreachable | spec_coverage_gap |
dispatch_loop_repeated`) plus `REASON:`, `VERIFY_OUTPUT:`, `FINAL_EXIT:`, and
`ITERATIONS_RUN:`. The gate below is what turns those claimed fields into
verified ones — it never trusts the subagent's numbers directly.

## Orchestrator-Side Gate (the second silent-pass killer)

Before flipping the operational task to `done`:

1. **Find the `STATUS:` line.** Missing → contract violation; treat as BLOCKED.

   **Silent return** — the Agent return is present but no `STATUS:` line appears, or the body is empty/whitespace. Treat this as its own outcome, distinct from COMPLETE/BLOCKED: `shipyard-data task set-status <id> needs-attention --reason "silent_return"`, emit `operational_task_bogus_pass reason=silent_return`, and re-dispatch ONCE with the same brief. If the re-dispatch is also silent, stop re-dispatching and surface it as a `STATUS: BLOCKED`-shaped ask instead of looping.

2. **If `STATUS: COMPLETE`:**

   a. **Verify the task file's `verify_output:` field is now populated** with the path returned. Missing or empty → emit `operational_task_bogus_pass` with `reason=missing_verify_output`. Do NOT mark done.

   b. **Verify the capture file exists at that path AND is non-empty.** Use `Read` and check size. Missing/empty → `operational_task_bogus_pass` with `reason=capture_file_missing` or `reason=empty_capture`.

   c. **Verify the final `verify_history` entry has `exit: 0`.** If the last attempt exited non-zero, the task is not done regardless of what the subagent claims — emit `operational_task_bogus_pass` with `reason=final_history_not_green`.

   d. **Verify `LAST_LINES:` content matches the tail of the capture file** (sanity check that the subagent didn't fabricate). If divergent → contract violation.

   e. All checks pass → mark task `done`. Note the `PATCH_TASKS_FILED` count in PROGRESS.md so the user knows new tasks materialized.

3. **If `STATUS: BLOCKED`:** render the `REASON:` and the failing capture tail (last ~20 lines) as chat text — a tail read via the Read tool exists only in context and does not count as shown — then AskUserQuestion. Likely options:
   - User fixes manually and re-runs the task
   - Defer to next sprint
   - Mark `xfail` with explicit reason (rare; document in task file)

## Heads-up: Three Anti-Patterns to Catch

The combination of (Iron Law in prompt) + (orchestrator-side gate) catches:

1. **Subagent claims done without running** (no capture file, or capture is from a previous run): gate steps a/b/c catch all variants.
2. **Subagent disables failing tests instead of fixing**: gate steps b/c don't catch this directly — `dispatching-code-review` (test concern) does, ideally dispatched at sprint-completion. Operational tasks intrinsically can fall to this if not paired with code-review.
3. **Subagent fabricates a green capture**: gate step d (`LAST_LINES:` vs file tail) catches divergence.

## Note on logcap

The `shipyard-logcap` CLI is not required for the basic capture path — plain `tee` to a deterministic path under `<SHIPYARD_DATA>/captures/` is enough for typical operational tasks. logcap is preferable for rotation, grouping, or line-boundary-safe streaming on long-running processes.

## Pairing With Other Skills

- **Routing.** The calling command skill (`/ship-execute`) decides `kind: operational` vs feature vs research BEFORE dispatching. This skill assumes the choice was operational.
- **`verifying-completion`** at the orchestrator boundary: STATUS: COMPLETE alone isn't evidence; the verify_output + capture-file + final exit:0 + LAST_LINES match are.
- **`acquiring-skill-lock`** is held by the calling command skill; this skill doesn't acquire its own.
- **`anti-stub-scan`** does NOT run on operational tasks — there's no acceptance probe diff to scan; the verify command is the gate.
- **`dispatching-task-loop`** is dispatched separately if a Phase 2 finding requires significant new code (rare; usually fixes are local).

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
