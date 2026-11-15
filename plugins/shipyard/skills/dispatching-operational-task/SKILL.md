---
name: dispatching-operational-task
description: Dispatch a Shipyard operational task subagent.
disable-model-invocation: true
---

# Dispatching an Operational Task

**Render before asking.** Render the decision context as chat text before any AskUserQuestion (rules printed at startup under SHIPYARD_STARTUP_RULES).

A `kind: operational` task is one whose deliverable is **a successful run of a named command**, captured to disk so the orchestrator and `/ship-review` can verify it actually happened.

Operational tasks have no Red step, no acceptance probe (the command itself is the gate), and no atomic feature commit (fixes commit as they go). Route here, never through `dispatching-task-loop`: the feature builder would exit clean on an empty tree and the gate would pass silently.

## Goal-mode default

This skill is /goal-shaped at the operational-task level: "run until the verify command exits 0." The Phase 1 (run+capture) → Phase 2 (fix-findings) → Phase 1 cycle is the /goal loop. It runs `max_iterations` (default 3 from config) times before returning `STATUS: BLOCKED` — the cap is the only escape, with no user prompt mid-loop. (Pacing shared with the ScheduleWakeup-driven verifiers: `references/schedule-wakeup-discipline.md`.)

Only the final structured return (`STATUS: COMPLETE` with `verify_output:` populated, or `STATUS: BLOCKED` with the failing-tail summary) reaches the orchestrator. The caller summarizes that contract; it does not forward subagent preamble, epilogue, or incidental commentary.

Emit a `operational_iteration` event from inside the subagent per cycle (`shipyard-data events emit operational_iteration task=<id> iteration=<N> exit=<code> findings=<count>`) (event catalog: `references/event-types.md`).

## When to Invoke

`/ship-execute` calls this skill when a task's frontmatter has `kind: operational`. Other entry points:

- `/ship-review` may invoke this for the wave-level "run full suite" check (though normally `/ship-execute`'s sprint-completion step handles that).
- Manual invocation when a user wants Shipyard to drive a fix-findings loop on an ad-hoc basis.

## Inputs

- `task_id` — e.g., `O-007` (operational tasks conventionally use `O-` prefix).
- `task_file_path` — absolute path under `<SHIPYARD_DATA>/spec/steps/`.
- `verify_command` — resolved command. Either a literal command or a config-key reference like `test_commands.e2e` (resolved to the literal command from `<SHIPYARD_DATA>/config.md`).
- `rerun_failed_command` — optional, resolved from `test_commands.rerun_failed` in `config.md` at the same time as `verify_command`. When present, this literal command narrows *interim* Phase-2 re-runs to previously-failing tests (see "Failed-Only Rerun" below). Empty/absent → the loop's behavior is byte-identical to before this feature existed — full command, every iteration.
- `data_dir` — literal `<SHIPYARD_DATA>` path.
- `working_branch` — git branch.
- `worktree_path` — null for operational (works on working branch directly; operational changes don't isolate well).
- `max_iterations` — fix-findings loop cap. Default 3 from `config.md` `operational_tasks.max_iterations`.
- `max_patch_tasks` — scope-creep guard for findings that spawn new tasks. Default 5.

## Two-Phase Flow

Operational tasks run in two phases inside the subagent's loop:

### Phase 1 — Run + Capture

1. Resolve the verify command (handle `test_commands.e2e` style indirection). Resolve `test_commands.rerun_failed` from the same config file at the same time, if present — used unmodified for interim narrowed re-runs (see "Failed-Only Rerun" below). Shipyard never edits, infers, or substitutes into this command; it is run verbatim exactly as configured.
2. Run the command via **Monitor** so progress and failures stream to the orchestrator/user as notifications instead of arriving as one blob at the end. The capture file remains the source of truth for the structured return.

   **Use `shipyard-logcap`, not raw `tee`.** Logcap is the single capture primitive: it records the full stdout+stderr stream, narrows only the live Monitor view with `--filter`, writes the wrapped command's exit to `--exit-file`, rotates without splitting log lines, and returns the wrapped command's exit code. Do not recreate this with `tee | grep`.

   ```
   Monitor(
     command: "shipyard-logcap run <task_id>-run-<N> --filter '<filter-pattern>' --exit-file <SHIPYARD_DATA>/captures/<task_id>/run-<N>.exit -- <verify_command>",
     description: "<task_id> verify run <N>",
     timeout_ms: 1800000
   )
   ```

   **Evidence before a second run (4.0).** When `verify_command` was resolved from a `test_commands.*` config key, add `--reuse` after the run name (`shipyard-logcap run <task_id>-run-<N> --reuse --filter …`). If that exact command already passed on this exact code, logcap prints `PROVEN, not run again`, writes exit 0 and returns at once; treat that as a green run. Every green run records its own proof, so nothing has to be recorded by hand. Never add `--reuse` to a step's own command (a deploy, a device run, anything whose point is its side effect).

   If `<verify_command>` is too shell-complex to pass safely as argv, write a newline-delimited argv file and use `shipyard-logcap run <task_id>-run-<N> ... --cmd-file <path>` instead. Do not pipe `shipyard-logcap run` into `grep` or `tail`; `--filter` is the live view, while the capture file stays raw.

   After Monitor returns, Read `run-<N>.exit` for the authoritative exit code. Then run `shipyard-logcap path <task_id>-run-<N>` and use that absolute capture path for `verify_history.capture`, `VERIFY_OUTPUT`, and `accept-operational capture=...`.

   `<N>` is the iteration number, starting at 1.

   **Filter pattern — must cover progress AND failure.** Silence is not success. The alternation must include at least one progress marker (so a healthy run produces events) AND at least one failure signature (so a crash, hang, or non-zero exit produces events). A regex that catches only `PASS` is *exactly* the silent-crashloop case the rule exists to prevent.

   - Progress tokens (pick at least one per runner): `PASS`, `passed`, `✓`, `Tests:`, `Suites:`, `Ran [0-9]+`, `\\[OK\\]`.
   - Failure tokens (pick at least one): `FAIL`, `failed`, `✗`, `Traceback`, `Error`, `FAILED`, `assert`, `Killed`, `OOM`, `Segmentation fault`, `panic:`, `\\[ERR\\]`.

   **Notification budget.** Aim for ~50 notifications per run (each is a turn cost); prefer summary-line filters over per-case lines. Per-runner recipes: `references/monitor-filters.md`.

3. After Monitor exits, Read `run-<N>.exit` for the authoritative exit code. Resolve the capture path with `shipyard-logcap path <task_id>-run-<N>` and Read that file from disk (the file is the authoritative artifact; Monitor notifications are ephemeral). Take the last 20 lines for `LAST_LINES`.
4. Append to the task's `verify_history:` frontmatter:
   ```yaml
   verify_history:
     - iteration: 1
       command: "<resolved command>"
       exit: <code>
        capture: "<absolute path from shipyard-logcap path <task_id>-run-1>"
       at: "<ISO timestamp>"
   ```

### Phase 2 — Fix-Findings Loop

If exit was non-zero, parse the capture for findings (the subagent reads the captured output; format depends on the tool). For each finding:

- **In-scope** (relates to recent work, fixes a real failure): apply a fix in-place. Commit atomically: `fix(<task_id>): <one-line>`.
- **Out-of-scope** (pre-existing, unrelated to this task's intent): file as a bug task (idea file under `<SHIPYARD_DATA>/spec/ideas/` if not yet a task; or a `B-*` bug if it warrants a sprint slot). Cap at `max_patch_tasks` to prevent scope creep.

After fixes commit, decide the next iteration's command:

- **The final iteration (`iteration == max_iterations`) always runs the FULL verify command.** It is reserved as the mandatory closing proof — see "Failed-Only Rerun" immediately below. Never narrow the last attempt.
- **Every earlier iteration** runs the narrowed `rerun_failed_command` when one is configured and the previous run had failures; otherwise it runs the FULL command — today's unchanged behavior when `rerun_failed` is unset.

Loop until a **FULL** run exits 0, or `max_iterations` is reached.

### Failed-Only Rerun (config-driven narrowing)

`test_commands.rerun_failed` in `config.md` lets iterations 2 through `max_iterations - 1` re-run only the failing subset instead.

**How it's used — config-driven, never inferred.** Shipyard does not parse failure output to build a test-name filter, and it never guesses a runner's flags. `rerun_failed` is a complete, literal, runnable command (populated by onboarding/config or hand-edited by the user) that the loop runs verbatim on a narrowing iteration. Runners with a failed-only mode keep their own last-failure state on disk, so running the command *verbatim* right after the prior iteration is sufficient; no argument substitution is needed or attempted.

Where a runner has no failed-only mode, leave `rerun_failed` unset — the loop re-runs the full command every iteration.

**A narrowed green run is never the recorded proof.** Exit 0 on a `rerun_failed` run only means the previously-failing subset now passes — it says nothing about the rest of the suite, and it must never be reported as `STATUS: COMPLETE` or written to `verify_output` as the final answer. When a narrowed run exits 0, the loop does not stop: the very next run is forced to be the FULL command regardless of where that falls in the iteration budget, and *that* full run's exit code is the real verdict. The last iteration is reserved for a FULL run so the loop can't be exhausted without full-suite proof; a narrowed pass recorded as full is a false green.

## Dispatching the Operational Task

The operational-task methodology (Iron Laws, loop, `step append-verify`, Required Return Shape) lives in the registered agent `agents/shipyard-operational-task.md`; do not re-inline it here. `references/monitor-filters.md` is passed as a path in the brief for runner-specific recipes.

**Model + effort (resolved by CLI).** Run `shipyard-data resolve-model operational` — it prints one line `model=<m> effort=<e>` from config.md (an empty value means OMIT that field on the Agent call so the subagent inherits; `inherit` is already normalized to empty). Never derive either from config.md prose and never hardcode a model literal. For redispatch/fix iterations after a failed command, run `shipyard-data resolve-model operational_fix` instead (use its effort). Then log it: `shipyard-data events emit dispatch_model_resolved role=operational model=<m or inherit> effort=<e or inherit> skill=<this skill>` — the wrapper logs, the resolver stays silent, and a logging failure never blocks the dispatch.

Dispatch:

```
Agent(
  subagent_type: "shipyard:shipyard-operational-task",
  model: <model= from resolve-model, or omit if empty>,
  effort: <effort= from resolve-model, or omit if empty>,
  prompt: "
    Task ID:                {{task_id}}
    Step file:               {{task_file_path}}
    Verify command:          {{verify_command_resolved}}
    Rerun-failed command:    {{rerun_failed_command_resolved, or omit if unset}}
    Working branch:          {{working_branch}}
    Data dir:                {{data_dir}}
    Max iterations:          {{max_iterations}}
    Max patch tasks (scope): {{max_patch_tasks}}
    Monitor filters ref:     {{data_dir or plugin path}}/references/monitor-filters.md
  "
)
```

The return carries `VERIFY_OUTPUT:`, `FINAL_EXIT:`, `ITERATIONS_RUN:`, `PATCH_TASKS_FILED:`, `LAST_LINES:`. A `STATUS: BLOCKED` return may carry an `ESCALATION_CODE:` (one of
`verify_flaky | external_dependency_unreachable | spec_coverage_gap |
dispatch_loop_repeated`). The gate below verifies the claimed fields; it never trusts the subagent's numbers.

## Orchestrator-Side Gate (the second silent-pass killer)

Before flipping the operational task to `done`:

1. **Find the `STATUS:` line.** Missing → contract violation; treat as BLOCKED.

   **Silent return** — the Agent return is present but no `STATUS:` line appears, or the body is empty/whitespace. Treat this as its own outcome, distinct from COMPLETE/BLOCKED: `shipyard-data step set-status <id> needs-attention --reason "silent_return"`, emit `operational_task_bogus_pass reason=silent_return`, and re-dispatch ONCE with the same brief. If the re-dispatch is also silent, stop re-dispatching and surface it as a `STATUS: BLOCKED`-shaped ask instead of looping.

2. **If `STATUS: COMPLETE`:**

   a. **Verify the step file's `verify_output:` field is now populated** with the path returned. Missing or empty → emit `operational_task_bogus_pass` with `reason=missing_verify_output`. Do NOT mark done.

   b. **Verify the capture file exists at that path AND is non-empty.** Use `Read` and check size. Missing/empty → `operational_task_bogus_pass` with `reason=capture_file_missing` or `reason=empty_capture`.

   c. **Verify the final `verify_history` entry has `exit: 0`.** If the last attempt exited non-zero, the task is not done regardless of what the subagent claims — emit `operational_task_bogus_pass` with `reason=final_history_not_green`.

   d. **Verify `LAST_LINES:` content matches the tail of the capture file** (sanity check that the subagent didn't fabricate). If divergent → contract violation.

   e. All checks pass → run `shipyard-data step accept-operational <id> sprint=<sprint_id> wave=<wave_number> capture=<verify_output_path> iterations=<iterations_run> role=operational model=<resolved model, omit if unset> effort=<resolved effort, omit if unset> attempt=<dispatch attempt, 1 unless redispatched> --data-dir {{data_dir}}`. This bundled CLI command marks the task `done`, emits `operational_task_completed`, and emits `task_dispatch_returned status=complete kind=operational commit_sha=<current HEAD sha>`. The second event is the terminal-gate evidence shared with feature tasks; do not skip it just because no builder worktree was involved. Note the `PATCH_TASKS_FILED` count in PROGRESS.md so the user knows new tasks materialized.

3. **If `STATUS: BLOCKED`:** render the `REASON:` and the failing capture tail (last ~20 lines) as chat text — a tail read via the Read tool exists only in context and does not count as shown — then AskUserQuestion. Likely options:
   - User fixes manually and re-runs the task
   - Defer to next sprint
   - Mark `xfail` with explicit reason (rare; document in step file)

## Logcap Is Required

Operational verification runs use `shipyard-logcap`. A raw `tee` path would split the capture contract and bypass logcap. The single path: `Monitor` streams `shipyard-logcap run --filter ... --exit-file ...`, `shipyard-logcap path` resolves the capture artifact, and the orchestrator gate verifies that artifact.

## Pairing With Other Skills

- **Routing.** The calling command skill (`/ship-execute`) decides `kind: operational` vs feature vs research BEFORE dispatching. This skill assumes the choice was operational.
- **`verifying-completion`** at the orchestrator boundary: STATUS: COMPLETE alone isn't evidence; the verify_output + capture-file + final exit:0 + LAST_LINES match are.
- **`acquiring-skill-lock`** is held by the calling command skill; this skill doesn't acquire its own.
- **`anti-stub-scan`** does NOT run on operational tasks — there's no acceptance probe diff to scan; the verify command is the gate.
- **`dispatching-code-review`** (test concern) is the backstop for a subagent that disables failing tests instead of fixing them (gate steps b/c do not catch this), ideally dispatched at sprint-completion.
- **`dispatching-task-loop`** is dispatched separately if a Phase 2 finding requires significant new code (rare; usually fixes are local).
