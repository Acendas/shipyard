---
name: dispatching-task-loop
description: Dispatch a fresh-context feature task subagent.
disable-model-invocation: true
---

# Dispatching the Task Loop

**Render before asking.** Before any AskUserQuestion, render the decision context as assistant chat text. Content that exists only in a Read result, a subagent/Agent return, or the question/option strings **does not count as rendered** (the UI shows a compact card) — restate it in chat first.

This is how Shipyard executes one task without burning the orchestrator's context window. The subagent does the loop; the orchestrator does the gate.

**Why this exists.** A self-checking loop's reliability is structural — the loop refuses to exit until completion is real. But running that loop in the orchestrator session means every false attempt accumulates in the orchestrator's context. By the fifth iteration, the orchestrator is operating on a summary of a summary. Move the loop into a subagent instead: the subagent absorbs every iteration's reasoning, false attempts, and tool calls; when it returns, only a structured summary lands in the orchestrator.

## Goal-mode default

This loop is /goal-shaped at the task level: "work until the acceptance probe passes." There is no flag, no opt-in — the subagent's internal cycle and iteration cap (5) ARE the /goal semantics. The cap exists so the orchestrator can redirect on genuinely stuck tasks (one redispatch via the orchestrator-side rule, then `needs-attention`), not so the subagent can give up early. The subagent must not return `STATUS: COMPLETE` until the probe passes; it must not return `STATUS: BLOCKED` before exhausting reasonable attempts.

The orchestrator does NOT surface mid-loop to the user. Probe failures inside the iteration cap stay inside the subagent context. The user sees only the final structured return: COMPLETE with evidence, or BLOCKED with a one-paragraph reason after the cap. This is the trade /goal makes — silence between dispatch and result, with the structured return contract guaranteeing no silent false completion.

The subagent emits a `task_loop_iteration` event per iteration (`shipyard-data events emit task_loop_iteration task=<id> iteration=<N> probe_exit=<code> --data-dir {{data_dir}}`) so `/ship-status` can render the trajectory without re-reading the subagent's transcript. The event log is the user's window into a running /goal loop. **Always pass `--data-dir {{data_dir}}`** — the subagent runs inside a builder worktree that can hash to a different project data dir than the orchestrator when the orchestrator itself is running in a user worktree of the same repo; the literal path from the brief sidesteps re-resolution entirely.

## When to Invoke

Read and follow this playbook from a command skill (`ship-execute`, `ship-quick`, `ship-bug`, hotfix path) per task. Not for `kind: research` (read and follow `dispatching-research-task` instead) or `kind: operational` (read and follow `dispatching-operational-task` instead) — those have different deliverables.

**Inputs the orchestrator must supply:**

- `task_id` — e.g., `T-042`
- `task_file_path` — absolute path under `<SHIPYARD_DATA>/spec/tasks/`
- `feature_file_path` — absolute path under `<SHIPYARD_DATA>/spec/features/` (or null for hotfix)
- `working_branch` — git branch name for the sprint
- `acceptance_probe` — the smoke command from the task frontmatter (required; if missing, halt and surface to the user — the task is unauthorable without one)
- `data_dir` — literal `<SHIPYARD_DATA>` path
- `base_ref` — the git ref the subagent's work forks from (the working-branch HEAD at dispatch, or the worktree base). The subagent's step-6 anti-stub self-scan diffs `git diff {{base_ref}}...HEAD` against it; without bounds the scan has nothing to compare.
- `worktree_path` — informational only. With `isolation: "worktree"` Claude Code owns worktree creation and sets the subagent's cwd; this value (when non-null) is passed to the subagent purely so it can name its own checkout in logs. The orchestrator never pre-creates a worktree — see the Integration Notes.
- `sprint_id` — sprint ID for event-log scoping (the `id:` from `SPRINT.md` frontmatter)
- `wave_number` — wave number for event-log scoping (current value of cursor `wave_number`)
- `dispatch_mode` — `sync` or `background`. `sync` = today's behavior, orchestrator parses Agent return value. `background` = orchestrator dispatches via `Agent(run_in_background: true)` and recovers the structured return from `.shipyard-events.jsonl` + capture file. Default `sync` for backward compatibility.
- `data_impl_guide` — the literal path to `project-files/references/data-implementation-guide.md`, included in the brief ONLY if this task touches the database (migrations, schema/DDL, SQL/ORM queries, repositories, indexes). Omit entirely for non-DB tasks — same significance-gating discipline as everywhere else this guide is consulted.
- `quality_standards_digest` — the literal path to `project-files/references/code-quality-standards.md`, included in the brief ONLY for `effort: M|L|XL` tasks; omit entirely for `effort: S`. **Effort-gate site (v3.13.0):** this mirrors the existing "effort: S skips both spec and code review" gate `dispatching-code-review`'s own When-to-Invoke table already applies at the post-task review site, and the same threshold `/ship-execute`'s post-task gate uses for its effort-gated single-task spec check — a trivial task that will never be reviewed against these dimensions doesn't need the digest in its brief either. The orchestrator already reads task effort from the task file before dispatch, so resolving this input here (alongside `data_impl_guide`) needs no new read.

## Dispatching the Builder

The builder methodology (environment rules, worktree self-check, kind refusal, IDEA capture, cross-platform ban-list, reading list, the three Iron Laws, The Cycle, iteration cap, Required Return Shape) lives in the registered agent `agents/shipyard-disciplined-builder.md` — read it once if you need to know exactly what it does; do not re-inline it here.

**IDEA capture allocates through the CLI, not a guess.** The builder's brief already carries `data_dir` (below), and the agent body requires every IDEA id it writes to come from `shipyard-data next-id ideas --data-dir {{data_dir}}` — never `ls`-and-guess. This matters more here than anywhere else IDEA files get written: this dispatcher is the one that runs N-way in parallel per wave, so a builder that guesses an id races every sibling builder in the same wave doing the same thing, and two `IDEA-<n>` files silently collide (last writer wins on any downstream keyed read).

**Model tier (build).** Read `models.build` from config.md — the invoking command skill's `!` context block, or a Read of `<SHIPYARD_DATA>/config.md`. If the value is non-empty, pass `model: <value>` in the Agent call; if empty or absent, OMIT the `model:` field entirely so the subagent inherits the session model. Never hardcode a model literal. This applies to BOTH dispatch modes below — the sync `Agent(...)` call and the `Agent(run_in_background: true, ...)` call carry the same `model:` rule.

**Plugin-relative paths are resolved here, not in the agent.** `${CLAUDE_PLUGIN_ROOT}` is not verified to expand inside a registered agent's body — resolve `data_impl_guide` and `quality_standards_digest` (each only when gated in) to literal paths before including them in the brief.

Dispatch:

```
Agent(
  subagent_type: "shipyard:shipyard-disciplined-builder",
  model: <models.build value, or omit>,
  isolation: "worktree",
  run_in_background: <true for wave dispatch, false for --task/--hotfix>,
  prompt: "
    Task ID:          {{task_id}}
    Working branch:    {{working_branch}}
    Worktree path:     {{worktree_path_or_none}}
    Base ref:          {{base_ref}}
    Data dir:          {{data_dir}}
    Task file:         {{task_file_path}}
    Feature file:      {{feature_file_path_or_omit}}
    Acceptance probe:  {{acceptance_probe}}
    Sprint ID:         {{sprint_id}}
    Wave number:       {{wave_number}}
    {{data_impl_guide path, if this task touches the database — otherwise omit}}
    {{quality_standards_digest path, if effort M|L|XL — otherwise omit}}
  "
)
```

## Orchestrator-Side Parsing and Gating

After the Agent call returns, parse the reply:

1. **Find the `STATUS:` line.** If neither `STATUS: COMPLETE` nor `STATUS: BLOCKED` is present → contract violation; treat as `STATUS: BLOCKED` with reason `contract violation: no STATUS line`.

1a. **Silent return.** The Agent return is present but no `STATUS:` line appears, or the body is empty/whitespace. Treat this as its own outcome, distinct from COMPLETE/BLOCKED: emit `shipyard-data events emit task_dispatch_returned pipeline=ship-execute sprint=<sprint_id> wave=<wave_number> task=<task_id> status=needs-attention reason=silent_return` and re-dispatch ONCE with the same brief. If the re-dispatch is also silent, stop re-dispatching — run `shipyard-data task set-status <id> needs-attention --reason "silent_return"` and surface it as a `STATUS: BLOCKED`-shaped ask instead of looping.

2. **If `STATUS: COMPLETE`:**
   - Extract `COMMIT: <sha>`. Run `git cat-file -e <sha>` (or equivalent) to confirm the sha exists in the worktree's git history. If not → contract violation.
   - Extract `PROBE_EXIT: 0`. Anything else → violation.
   - Extract `PROBE_OUTPUT_TAIL:` block. Must be ≥1 non-blank line. Empty tail → violation.
   - Run `shipyard-data scan-stubs <base>..<sha>` (the anti-stub-scan spec's runtime, see `anti-stub-scan/SKILL.md`). Exit 3 → re-dispatch with the printed findings inline (`Your diff still contains stubs at: <list>; fix them and re-probe`). Exit 0 → continue (MEDIUM/LOW findings, if any, go in the wave's progress report per the spec's action rules).
   - All checks pass → **anchor the commit and record the return BEFORE marking done** (both run regardless of sync vs background mode — this is the single orchestrator choke point). Pass `--data-dir {{data_dir}}` on both calls below — the orchestrator already holds the literal data dir it dispatched in the brief, so there's no reason to let either call re-resolve it (and re-resolution is exactly what can diverge when the orchestrator is itself running in a user worktree):
     - `shipyard-data anchor-commit <task_id> <sha> --data-dir {{data_dir}}` — pins a `shipyard/keep-<task_id>` ref to the verified commit. Insurance: from this moment the commit survives worktree teardown, rebase, and Claude Code worktree-name collisions (#51596), independent of whether `worktreeBranch` ever came back defined. It is also what lets `verify-wave-integrated` tell "integrated" apart from "orphaned."
     - `shipyard-data events emit task_dispatch_returned pipeline=ship-execute sprint=<sprint_id> wave=<wave_number> task=<task_id> status=complete commit_sha=<sha> --data-dir {{data_dir}}` — record the return with the REAL task id and sha. Never emit this with empty/placeholder fields: null `task`/`commit_sha` is what made the v2.8 audit log blind to which commit belonged to which task, and the terminal gate keys off `task=<id> status=complete`.
     - Then mark task `done` and log the probe tail to the wave's progress.

3. **If `STATUS: BLOCKED`:**
   - **Read `ESCALATION_CODE:` first.** For every route below that ends in AskUserQuestion: render the `ESCALATION_CODE`, the `REASON:` paragraph verbatim, and any supporting evidence (probe tail, hook investigation result) as chat text before the ask. The subagent return exists only in this context — packing the reason into AskUserQuestion question/option strings does not count as showing it. If present, route directly:
     - `isolation_failure` → the `WorktreeCreate` hook didn't place the subagent on a `shipyard/wt-*` branch. Do NOT redispatch blind — investigate the hook (`using-worktrees` "When Things Go Wrong"). Surface to the user via AskUserQuestion.
     - `misrouted_kind` → the task is operational/research and was sent to the wrong dispatcher. Re-route to `dispatching-operational-task` / `dispatching-research-task`; do not redispatch here.
     - `design_ambiguity` → AskUserQuestion with the REASON; never auto-redispatch.
     - `verify_flaky` → emit `verify_flaky_suspected` event with the probe output; surface to user with a `bisect-flaky` recommendation.
     - `spec_coverage_gap` → surface to `/ship-spec` / user; do not advance the task.
     - `external_dependency_unreachable` → AskUserQuestion with infrastructure investigation hint; do not auto-retry.
     - `dispatch_loop_repeated` → `shipyard-data task set-status <id> needs-attention --reason "dispatch_loop_repeated"` immediately; skip the single-redispatch rule below.
   - **If no ESCALATION_CODE**, fall back to prose routing: read `REASON:`. If it indicates a routing / context error (e.g., "feature spec missing", "no test command configured"), surface to the user via AskUserQuestion. Do not auto-redispatch — that loops on a structural blocker.
   - If the reason indicates an implementation difficulty (e.g., "the existing API doesn't expose what the spec needs"), apply the **single redispatch rule**: redispatch ONCE with the prior reason inlined as `Previous attempt blocked at: <reason>; please retry with this context`. If the second attempt also returns BLOCKED, run `shipyard-data task set-status <id> needs-attention --reason "persistent_failure"` (PROGRESS.md auto-renders from it) and continue to the next task. Do NOT redispatch a third time on the same task within one wave — that's the failure mode the cap exists to prevent.
   - Whenever a task settles as blocked/needs-attention, emit its return event so the wave gate (invariant 1) sees a return for every dispatched task: `shipyard-data events emit task_dispatch_returned pipeline=ship-execute sprint=<sprint_id> wave=<wave_number> task=<task_id> status=blocked escalation_code=<code-or-empty> --data-dir {{data_dir}}`. No `commit_sha` and no anchor for a blocked task — there is no verified commit to pin. Pass `--data-dir {{data_dir}}` here too, same reason as the complete-path emit above.

4. **Always apply `verifying-completion`'s Iron Law as a mental check** before flipping the task to `done`. The Iron Law applies at the orchestrator boundary too: "subagent said COMPLETE" is not by itself evidence; the sha-existence check, probe-output presence, and anti-stub-clean check are.

## Background dispatch (v2.5.0+)

When this playbook is followed with `dispatch_mode: background`, the dispatch shape changes from synchronous to asynchronous:

**Sync mode (default, today's behavior):**
1. Orchestrator calls `Agent(subagent_type: "shipyard:shipyard-disciplined-builder", prompt: <brief>)`.
2. Agent blocks the orchestrator's iteration until the subagent returns.
3. Orchestrator reads the Agent's return value, parses the structured contract inline, runs the gate (sha exists via `git cat-file -e` + `PROBE_EXIT: 0` + non-empty `PROBE_OUTPUT_TAIL` + anti-stub-scan on the diff), advances. The orchestrator does NOT re-run the probe — pre-merge, the worktree's environment isn't reconstructable in the orchestrator context; the probe's authoritative signal is the exit code the subagent captured, which the CLI already refused to record as COMPLETE if non-zero.

**Background mode (v2.5.0+):**
1. Orchestrator calls `Agent(subagent_type: "shipyard:shipyard-disciplined-builder", run_in_background: true, prompt: <brief>)`. Returns immediately with a task handle.
2. Orchestrator writes the cursor with `stage: wave_<N>_waiting` and adds `task_id` to `pending_subagents` list. Arms a Monitor on the event log for `subagent_completed` events. Exits.
3. The subagent runs through its internal cycle in the background. At the end:
   - Persists the structured return via `shipyard-data task-return ... --data-dir {{data_dir}}`, which writes `{{data_dir}}/sprints/current/.subagent-returns/{{task_id}}.json` (Cycle step 8). The subagent MUST pass `--data-dir {{data_dir}}` from the brief rather than letting the CLI re-resolve — its own worktree can hash to a different project data dir than the one the orchestrator is watching, which is exactly the gap that stalls `wave_<N>_waiting` on a completed task the orchestrator never sees.
   - Emits `subagent_completed` event with task / status / commit_sha / probe_exit_code / capture_file fields, `capture_file` pointing at the `.json` (Cycle step 9).
   - Returns the inline structured response (Cycle step 10) — for sync-mode parity, but no orchestrator iteration reads it in background mode.
4. The Monitor armed by step 2 wakes /loop the moment the event lands in the log.
5. On the next /loop iteration, the orchestrator (ship-execute under `stage: wave_<N>_waiting`) sees the event, reads the `.json` capture file referenced in `capture_file=`, parses the structured contract from there, and runs the SAME orchestrator-side gate (sha exists via `git cat-file -e` + `probe_exit_code === 0` in the `.json` + non-empty output tail + anti-stub-scan). Removes `task_id` from `pending_subagents`. When `pending_subagents` is empty for the wave, advances cursor to `wave_<N>_boundary`.

**Key invariants preserved across both modes:**
- The structured-return contract is identical (STATUS / COMMIT / PROBE_EXIT / PROBE_OUTPUT_TAIL).
- The orchestrator-side gate is identical (sha `cat-file` + `probe_exit_code === 0` from the capture + non-empty output tail + anti-stub-scan). Neither mode re-runs the probe — the captured exit code is authoritative, and `shipyard-data task-return` already refused to record COMPLETE with a non-zero exit.
- The Iron Laws inside the agent body are identical.

The ONLY difference is **who reads the return**: the spawning iteration (sync) or a future iteration via event-log + capture file (background). This means background mode can be flipped on per-call without changing the agent body or the gate logic.

**When to use background mode:**
- Wave dispatch in `/ship-execute` (the primary use case — eliminates the 5–10 min wall-clock per wave from blocking the orchestrator iteration).
- Sprint-end test-fix re-dispatch (`sprint_tests_fix_iter_<K>`).

**When to use sync mode:**
- Single-task mode (`/ship-execute --task <id>`) — there's only one task, no parallelism win.
- Hotfix mode (`/ship-execute --hotfix`) — same reason.
- Manual one-shot redispatch outside the normal pipeline.

**Failure modes specific to background mode:**

1. **Subagent dies without emitting the event.** The capture file may also be absent. The orchestrator's `wave_<N>_recovery` handler watches per-task spawned_at timestamps. **Presume dead only when all three hold:** `now - spawned_at > max_execution_minutes` (default 60, configurable via task frontmatter) AND no `subagent_completed` event AND no recent `task_loop_iteration` event for that task. A live-but-slow builder still emits `task_loop_iteration` per cycle, so a recent one means "working, not dead" — do not reap it.

   On presumed-dead, run the **timeout salvage protocol** (this skill owns the contract; `/ship-execute`'s waiting handler defers to it):
   1. **TaskStop the background agent handle** for that task — a presumed-dead subagent may still be a running zombie holding its worktree; stopping it first prevents a late write racing the salvage.
   2. **Salvage the worktree branch WITHOUT merging it.** The builder may have committed real work before dying, but it never passed the gate, so it must not reach the working branch. Anchor the branch tip so the commits survive teardown, then force-remove: `shipyard-data anchor-commit <task_id> <branch-tip-sha> --data-dir {{data_dir}}` (pins `shipyard/keep-<task_id>`; `--data-dir` because this is an orchestrator-side call that must land in the SAME data dir the wave is tracked in, not wherever the dead subagent's worktree would resolve to) → `git worktree remove --force .claude/worktrees/<id>` → `git branch -D shipyard/wt-<id>` (the `-D` is safe here precisely because the commits are already anchored; this is the one place `-D` is correct — teardown of *integrated* branches still uses `-d`).
   3. `shipyard-data task set-status <id> needs-attention --reason "presumed_dead"` (PROGRESS.md auto-renders), advance. Also emit `task_dispatch_returned status=blocked --data-dir {{data_dir}}` so the wave gate (invariant 1) sees a return for the task.

2. **Capture `.json` missing but event present.** Contract violation — orchestrator treats as BLOCKED and follows the single-redispatch rule.

3. **Event present but malformed (missing fields).** Contract violation — orchestrator treats as BLOCKED. The `shipyard-data events emit` CLI enforces key=value parsing so this should be rare.

4. **Multiple subagents writing the event log concurrently.** `shipyard-data events emit` uses file locking (see `bin/_hook_lib.mjs`) so concurrent appends serialize correctly. Order on disk may not match dispatch order; orchestrator matches by `task=` field, not by order.

## Why This Beats Per-Iteration Stop Hooks

| Property | Stop-hook loop (Ralph) | Subagent loop (this skill) |
|---|---|---|
| Reliability gate | Promise must be true to exit | Probe + structured return + sha verification |
| Context bloat | Accumulates in user session | Discarded with subagent context |
| Concurrency | One loop per session | N parallel loops via parallel Agent calls |
| Survives `/clear` | State file | State file (sprint progress) |
| Implementation surface | Stop hook script + state file | One skill + registered agent dispatch |
| User can interrupt | Yes (Esc) | Yes (Esc on parent) |

The subagent's exit contract is the same Iron Law as Ralph's promise — but at the subagent boundary, not the session boundary.

## Integration Notes

- **Worktree mode.** Pass `isolation: "worktree"` on the Agent call — this is the ONLY path (see `using-worktrees`). Claude Code creates the worktree, fires the `WorktreeCreate` hook (which owns the `shipyard/wt-*` branch), and sets the subagent's cwd. Never pre-create the worktree with `git worktree add` — that bypasses the hook's branch naming and the `worktree.baseRef` handling, and it is what the agent's branch self-check exists to catch. `worktree_path` in the brief is informational only.
- **Test execution is deferred by default.** Tasks write tests but do NOT run them — scoped tests run at the wave boundary, full suite at sprint completion. The acceptance probe is the only check that runs inside the task; it's the wiring proof, the deferred suite is the unit-level proof. This is the only mode of operation; there's no opt-in flag.
- **Hotfix is the one exception** that DOES run tests at task level. The regression-test cycle (Red → Green → Revert → Red → Restore → Green) requires watching the test go through the full red-green-red-green motion — a deferred suite can't prove a regression test catches the specific bug. Hotfix dispatches inline this discipline; sprint dispatches don't.

## Failure Modes the Contract Catches

1. **False completion via stub.** Subagent writes `def foo(): pass`, test asserts `foo()` returns None, both pass. Probe runs against `foo()` and observes nothing happened end-to-end. STATUS: BLOCKED or, if subagent lies about probe pass, anti-stub-scan catches the stub.
2. **False completion via test that doesn't exercise the code.** Subagent's test imports the wrong module. Probe runs, observes the wiring isn't there, exits non-zero. Loop continues.
3. **Subagent self-certifies without running the probe.** Probe output absent or empty → contract violation → redispatch.
4. **Subagent returns a fake commit sha.** `git cat-file -e <sha>` fails → contract violation.
5. **Subagent goes silent.** No `STATUS:` line at all, or an empty body → the silent_return gate (step 1a above) catches it, re-dispatches once, then parks as `needs-attention`.

The structured return contract makes each of these structurally observable from the orchestrator side. There is no "subagent said it was done so it's done" path.

## Bottom Line

- One task → one registered-agent dispatch → one loop → one structured return.
- Iron Laws inside the agent body; sha verification + probe-output + anti-stub scan + silent-return gate outside, in this wrapper.
- Five internal iterations max, then BLOCKED. One redispatch max, then needs-attention.
- The orchestrator stays at ~10–15% context across an entire sprint.
