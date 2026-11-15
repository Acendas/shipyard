---
name: dispatching-task-loop
description: Dispatch a fresh-context feature task subagent.
disable-model-invocation: true
---

# Dispatching the Task Loop

**Render before asking.** Render the decision context as chat text before any AskUserQuestion (rules printed at startup under SHIPYARD_STARTUP_RULES).

The subagent does the loop (so false attempts never accumulate in the orchestrator's context); the orchestrator does the gate.

## Goal-mode default

This loop is /goal-shaped at the task level: "work until the acceptance probe passes." There is no flag, no opt-in — the subagent's internal cycle and iteration cap (5) ARE the /goal semantics. The subagent must not return `STATUS: COMPLETE` until the probe passes, nor `STATUS: BLOCKED` before exhausting reasonable attempts.

Probe failures inside the iteration cap stay inside the subagent. The user sees only the final structured return summarized by the caller. Do not forward subagent preamble, epilogue, or incidental commentary.

The subagent emits a `task_loop_iteration` event per iteration (`shipyard-data events emit task_loop_iteration task=<id> iteration=<N> probe_exit=<code> --data-dir {{data_dir}}`) so `/ship-status` can render the trajectory. **Always pass `--data-dir {{data_dir}}`** — a builder worktree can hash to a different project data dir than the orchestrator's.

## When to Invoke

Read and follow this playbook from a command skill (`ship-execute`: sprint waves, `--task`, `--hotfix`) per step. Not for `kind: research` (read and follow `dispatching-research-task` instead) or `kind: operational` (read and follow `dispatching-operational-task` instead) — those have different deliverables.

**Queue-mode note.** When `/ship-execute` is running the flat worker queue, this file is a source for builder discipline, return fields, and gate rules only. The queued leaf worker is already the spawned Agent; do not call this wrapper from inside that worker and do not spawn another builder Agent from a worker.

**Inputs the orchestrator must supply:**

- `task_id` — e.g., `T-042`
- `task_file_path` — absolute path under `<SHIPYARD_DATA>/spec/steps/`
- `feature_file_path` — absolute path under `<SHIPYARD_DATA>/spec/stories/` (or null for hotfix)
- `working_branch` — git branch name for the sprint
- `acceptance_probe` — the smoke command from the task frontmatter (required; if missing, halt and surface to the user — the task is unauthorable without one)
- `data_dir` — literal `<SHIPYARD_DATA>` path
- `base_ref` — the git ref the subagent's work forks from (the working-branch HEAD at dispatch, or the worktree base). The subagent's step-6 anti-stub self-scan diffs `git diff {{base_ref}}...HEAD` against it; without bounds the scan has nothing to compare.
- `ui` — `on` when the step's story has `ui: true` (E005): the brief carries `UI: on` plus the approved design snapshot path (`spec/designs/<S###>-v<n>.<ext>`, from the story's `design:` block) and the screen URL (story Interface or `ui.base_url`), and the builder runs the render-and-look loop after its probe. `off` (default) omits the lines.
- `isolation` — `on` or `off`. `on` (the default) dispatches with `isolation: "worktree"`; `off` (solo, or `--isolation false` / `execution.isolation: none`) omits the arg and the builder runs in-place on the working branch. The value is surfaced to the builder as the `Isolation:` brief line, which gates its branch self-check (`shipyard/wt-*` when on, working-branch when off). Off is sequential-only — never dispatch it in parallel.
- `worktree_path` — informational only. With `isolation: "worktree"` Claude Code owns worktree creation and sets the subagent's cwd; this value (when non-null) is passed to the subagent purely so it can name its own checkout in logs. Null when isolation is off. The orchestrator never pre-creates a worktree — see the Integration Notes.
- `sprint_id` — sprint ID for event-log scoping (the `id:` from `SPRINT.md` frontmatter)
- `wave_number` — wave number for event-log scoping (current value of cursor `wave_number`)
- `dispatch_mode` — `sync` or `background`. `sync` = today's behavior, orchestrator parses Agent return value. `background` = orchestrator dispatches via `Agent(run_in_background: true)` and recovers the structured return from `.shipyard-events.jsonl` + capture file. Default `sync` for backward compatibility.
- `data_impl_guide` — the literal path to `project-files/references/data-implementation-guide.md`, included in the brief ONLY if this task touches the database (migrations, schema/DDL, SQL/ORM queries, repositories, indexes). Omit entirely for non-DB tasks
- `quality_standards_digest` — the literal path to `project-files/references/code-quality-standards.md`, included in the brief ONLY for `effort: M|L|XL` tasks; omit entirely for `effort: S`. Same effort gate as `dispatching-code-review`'s post-task review site.
- `Model:` / `Effort:` / `Attempt:` brief lines (attribution) — the resolved `models.build` model, the resolved effort, and the dispatch attempt (1, or 2 on the single redispatch). Include each line ONLY when its value is known; the builder passes them as `model=` `effort=` `attempt=` on its `subagent_completed` emit so the event carries them (S010 AC-1).

## Dispatching the Builder

The builder methodology lives in the registered agent `agents/shipyard-disciplined-builder.md`; do not re-inline it here.

**IDEA capture allocates through the CLI, not a guess.** The agent body requires every IDEA id to come from `shipyard-data next-id ideas --data-dir {{data_dir}}`, never `ls`-and-guess — parallel builders in a wave would otherwise collide on the same `IDEA-<n>`.

**Model + effort (resolved by CLI, enforced at spawn).** Resolve every step at its own dispatch — a model is never carried over from another step, and a hook refuses a builder spawned on a model other than the one its step is routed to. Run `shipyard-data resolve-model build --subject <step_id>` — it prints one line `model=<m> effort=<e> tier=<t> attempt=0 ladder=ok [routed=<tier>:<effort>]` from config.md and, with `routing.rules: true` (default, E004), from the step's own kind, effort and latest `risk_scored` level (rules-first routing: a risk level or a role can only raise the tier; `routed=` names what the rules chose). Record the decision once per dispatch with `shipyard-data route --step <step_id> --role build` (it logs `route_decided` with inputs and reasons; `resolve-model` itself stays a pure read). Legacy wording: `resolve-model build` without `--subject` still works and prints `model=<m> effort=<e>` (an empty value means OMIT that field on the Agent call so the subagent inherits; `inherit` is already normalized to empty). Never derive either from config.md prose and never hardcode a model literal. If the step file declares `effort: S`, use role `build_trivial` instead. This applies to BOTH dispatch modes below — the sync and the `run_in_background: true` Agent call. Then log it: `shipyard-data events emit dispatch_model_resolved role=build model=<m or inherit> effort=<e or inherit> skill=<this skill>` — the wrapper logs, the resolver stays silent, and a logging failure never blocks the dispatch.

**Plugin-relative paths are resolved here, not in the agent.** `${CLAUDE_PLUGIN_ROOT}` is not verified to expand inside a registered agent's body — resolve `data_impl_guide` and `quality_standards_digest` (each only when gated in) to literal paths before including them in the brief.

Dispatch:

```
Agent(
  subagent_type: "shipyard:shipyard-disciplined-builder",
  model: <model= from resolve-model, or omit if empty>,
  effort: <effort= from resolve-model, or omit if empty>,
  isolation: "worktree",   // ONLY when isolation is on; OMIT this line entirely when isolation is off (solo, or forced off by --isolation false / execution.isolation: none) — the builder then runs in-place on the working branch
  run_in_background: <true for wave dispatch, false for --task/--hotfix>,
  prompt: "
    Task ID:          {{task_id}}
    Working branch:    {{working_branch}}
    Isolation:         {{on if dispatched with isolation: "worktree", else off}}
    UI:                {{on when the story has ui: true, else omit this and the next two lines}}
    Design snapshot:   {{<SHIPYARD_DATA>/spec/designs/<S###>-v<n>.<ext>}}
    Screen URL:        {{url the step's screen renders at, or omit}}
    Worktree path:     {{worktree_path_or_none}}
    Base ref:          {{base_ref}}
    Data dir:          {{data_dir}}
    Step file:         {{task_file_path}}
    Story file:      {{feature_file_path_or_omit}}
    Acceptance probe:  {{acceptance_probe}}
    Sprint ID:         {{sprint_id}}
    Wave number:       {{wave_number}}
    {{data_impl_guide path, if this task touches the database — otherwise omit}}
    {{quality_standards_digest path, if effort M|L|XL — otherwise omit}}
  "
)
```

## Orchestrator-Side Parsing and Gating

After the Agent call returns, parse the reply. Ignore `TRACK_NOTES_FOR_NEXT_TASK:` unless this task-loop invocation was nested under `shipyard-track-coordinator`; the track coordinator consumes that optional field itself. In normal `/ship-execute` task dispatch, it is not user-facing and must not be forwarded as commentary.

1. **Find the `STATUS:` line.** If neither `STATUS: COMPLETE` nor `STATUS: BLOCKED` is present → contract violation; treat as `STATUS: BLOCKED` with reason `contract violation: no STATUS line`.

1a. **Silent return.** The Agent return is present but no `STATUS:` line appears, or the body is empty/whitespace. Treat this as its own outcome, distinct from COMPLETE/BLOCKED: emit `shipyard-data events emit task_dispatch_returned pipeline=ship-execute sprint=<sprint_id> wave=<wave_number> task=<task_id> status=needs-attention reason=silent_return` and re-dispatch ONCE with the same brief. If the re-dispatch is also silent, stop re-dispatching — run `shipyard-data step set-status <id> needs-attention --reason "silent_return"` and surface it as a `STATUS: BLOCKED`-shaped ask instead of looping.

2. **If `STATUS: COMPLETE`:**
   - Extract `COMMIT: <sha>`. Run `git cat-file -e <sha>` (or equivalent) to confirm the sha exists in the worktree's git history. If not → contract violation.
   - Extract `PROBE_EXIT: 0`. Anything else → violation.
   - Extract `PROBE_OUTPUT_TAIL:` block. Must be ≥1 non-blank line. Empty tail → violation.
   - Run `shipyard-data scan-stubs <base>..<sha>` (the anti-stub-scan spec's runtime, see `anti-stub-scan/SKILL.md`). Exit 3 → re-dispatch with the printed findings inline (`Your diff still contains stubs at: <list>; fix them and re-probe`). Exit 0 → continue (MEDIUM/LOW findings, if any, go in the wave's progress report per the spec's action rules).
   - The same scan flags a **weakened test** (`test-number-changed`, `test-assertion-removed`, `test-file-deleted`; exit code unaffected). For each one, check the step's spec: if it does not ask for that change, send it back to the builder that wrote it (warm fix: "restore `<file>:<line>` and meet the check, or return BLOCKED `check_needs_owner`") and log `execute_decision source=rule decision="restored a loosened check"`. A loosened check is never accepted by the orchestrator; only the owner lowers a bar (parked for the sprint review).
   - All checks pass → **accept the return with the bundled CLI choke point**: `shipyard-data step accept-return <task_id> sprint=<sprint_id> wave=<wave_number> commit=<sha> role=builder model=<resolved models.build, omit if unset> effort=<resolved effort, omit if unset> attempt=<dispatch attempt: 1 unless redispatched, then 2> --data-dir {{data_dir}}`. Pass `tokens=<n>` ONLY if you actually read the transcript (otherwise omit it; see token-usage-visibility-probe). This single command pins `shipyard/keep-<task_id>` via `anchor-commit`, emits `task_dispatch_returned status=complete commit_sha=<sha>` with the REAL task id and sha, and marks the task `done` in CLI-owned frontmatter. Pass `--data-dir {{data_dir}}` — the orchestrator already holds the literal data dir it dispatched in the brief, so there's no reason to let the acceptance path re-resolve it (and re-resolution is exactly what can diverge when the orchestrator is itself running in a user worktree). Never emit completion with empty/placeholder fields: the terminal gate keys off `task=<id> status=complete`. After acceptance, log the probe tail to the wave's progress.

3. **If `STATUS: BLOCKED`:**
   - **Unattended sprints do not ask.** When the caller is `/ship-execute` with `execution.unattended: true` (the default), every "AskUserQuestion" / "surface to the user" below means the caller's decision ladder instead: already decided → rule → one think-tier consult → advisor → park the step (`shipyard-data step set-status <id> needs-attention --reason "<ESCALATION_CODE>"`) and carry on; the sprint review reports it. A question is asked only in attended runs (`execution.unattended: false`) and in task or hotfix mode.
   - **Read `ESCALATION_CODE:` first.** For every route below that ends in AskUserQuestion: render the `ESCALATION_CODE`, the `REASON:` paragraph verbatim, and any supporting evidence (probe tail, hook investigation result) as chat text before the ask. The subagent return exists only in this context — packing the reason into AskUserQuestion question/option strings does not count as showing it. If present, route directly:
     - `isolation_failure` → the `WorktreeCreate` hook didn't place the subagent on a `shipyard/wt-*` branch. Do NOT redispatch blind — investigate the hook (`using-worktrees` "When Things Go Wrong"). Surface to the user via AskUserQuestion.
     - `misrouted_kind` → the task is operational/research and was sent to the wrong dispatcher. Re-route to `dispatching-operational-task` / `dispatching-research-task`; do not redispatch here.
     - `design_ambiguity` → AskUserQuestion with the REASON; never auto-redispatch.
     - `verify_flaky` → emit `verify_flaky_suspected` event with the probe output; surface to user with a `bisect-flaky` recommendation.
     - `spec_coverage_gap` → surface to `/ship-spec` / user; do not advance the task.
     - `external_dependency_unreachable` → AskUserQuestion with infrastructure investigation hint; do not auto-retry.
     - `check_needs_owner` → the builder could not meet an existing check without loosening it. Never lower the bar and never redispatch with permission to: `shipyard-data step set-status <id> needs-attention --reason "check_needs_owner: <check> needs <value>, work reaches <value>"`, log `execute_decision source=parked`, continue. The owner decides at the sprint review.
     - `spec_disagrees` → the builder believes the scenario, not the code, is wrong (`SPEC_FIX: <AC id>: …`). One of them is a bug and both are fixed in the same change: decide with the ladder which side is right. If the scenario is wrong and the fix does not change what the owner asked for (a stale number, a wrong name, an ending that cannot happen), edit the scenario in the story, add a Decision Log line, log `execute_decision`, and redispatch the step once with the corrected scenario. If it changes what the owner asked for, it is `design_ambiguity`. If the code is wrong, redispatch with that verdict.
     - `dispatch_loop_repeated` → `shipyard-data step set-status <id> needs-attention --reason "dispatch_loop_repeated"` immediately; skip the single-redispatch rule below.
   - **If no ESCALATION_CODE**, fall back to prose routing: read `REASON:`. If it indicates a routing / context error (e.g., "feature spec missing", "no test command configured"), surface to the user via AskUserQuestion. Do not auto-redispatch — that loops on a structural blocker.
   - If the reason indicates an implementation difficulty (e.g., "the existing API doesn't expose what the spec needs"), apply the **single redispatch rule**: redispatch ONCE with the prior reason inlined as `Previous attempt blocked at: <reason>; please retry with this context`. If the second attempt also returns BLOCKED, run `shipyard-data step set-status <id> needs-attention --reason "persistent_failure"` (PROGRESS.md auto-renders from it) and continue to the next task. Do NOT redispatch a third time on the same task within one wave — that's the failure mode the cap exists to prevent.
   - Whenever a task settles as blocked/needs-attention, emit its return event so the wave gate (invariant 1) sees a return for every dispatched task: `shipyard-data events emit task_dispatch_returned pipeline=ship-execute sprint=<sprint_id> wave=<wave_number> task=<task_id> status=blocked escalation_code=<code-or-empty> --data-dir {{data_dir}}`. No `commit_sha` and no anchor for a blocked task — there is no verified commit to pin. Pass `--data-dir {{data_dir}}` here too, same reason as the complete-path emit above.

3-warm. **Warm fix before a cold redispatch (SendMessage, 4.5).** When the failure is a list of concrete findings against work the builder finished — an orchestrator gate miss (stub scan, a missing `// AC-<n>` marker, a probe tail), wave or story spec-review FINDINGS, a gap-analysis patch small enough to belong to that step — and the builder that wrote it is still reachable (its name is in `shipyard-data agents live`), send the findings to **that same agent** with `SendMessage` instead of spawning a new one: it already holds the step, the code and the test context, so the fix costs a fraction of a cold start. Message shape: the findings verbatim, the scenario ids, "fix these in your worktree/branch, re-run your probe, write a fresh return, reply COMPLETE or BLOCKED". Emit `dispatch_attempt` exactly as in 3a (a warm fix is an attempt, with `mode=warm`), keep the agent in the ledger until this reply is accepted, then stop it. A finished builder resumes with its full history when messaged; one that was `TaskStop`ped cannot (the message is refused), which is why builders are stopped at their wave's gate and not before. Go cold (3a: a fresh agent one tier up) when the agent is gone or was stopped, when the return was `STATUS: BLOCKED` or silent (it could not do the work — the same context will not help), or when the warm fix itself fails. Either way the cap holds: two attempts, never a third. **Only before the merge:** once the step's branch is merged at the wave boundary its worktree is gone, so a finding against merged work (wave verify, a story review) is a patch step with its own worktree and probe, never a message to the old builder. **Same probe:** a warm fix or a redispatch re-runs the step's own `acceptance_probe:` unchanged; never write another probe for it, and never accept a return whose probe did not pass.

3a. **Record the dispatch attempt, then step up the model on redispatch.** At each genuine failed attempt — an orchestrator gate failure (sha/probe/tail/stub-scan), a `STATUS: BLOCKED` return, or a spec-verify failure — emit `shipyard-data events emit dispatch_attempt pipeline=ship-execute sprint=<sprint_id> wave=<wave_number> subject=<task_id> --data-dir {{data_dir}}` BEFORE redispatching. Do NOT emit it for a silent return, a crash, or a queue re-claim (those are not model failures; the ladder reads the event log, not the queue `attempt` field). Then redispatch with `shipyard-data resolve-model build --subject <task_id>` (it reads the event count and steps up a single tier): **one dispatch per rung, light → build → think, from the rung the step started on**. A step routed to the light tier (Haiku: size S, straightforward) therefore gets up to three dispatches, one that started on build two, one on think one. When the line says `ladder=exhausted` (exit 3) the step is parked `needs-attention`; nothing is dispatched past think. **A light-tier builder gets no warm retry for a failed gate** (probe, sha, stub scan, weakened test): the cheap model had its try, so climb a rung with the failure inlined; review findings on work that passed its gates still go back warm. This ladder is independent of the consult cap.

4. Apply `verifying-completion`'s Iron Law before flipping the task to `done`: "subagent said COMPLETE" is not evidence; the sha check, probe output, and anti-stub-clean check are.

## Background dispatch

When this playbook is followed with `dispatch_mode: background`, the dispatch shape changes from synchronous to asynchronous:

**Sync mode (default):** the same `Agent(...)` call without `run_in_background`; the orchestrator parses the return inline and runs the gate. It does NOT re-run the probe — the worktree's environment isn't reconstructable pre-merge; the subagent's captured exit code is authoritative, and the CLI refuses to record COMPLETE if non-zero.

**Background mode:**
1. Orchestrator calls `Agent(subagent_type: "shipyard:shipyard-disciplined-builder", model: <model= from resolve-model — omit if empty>, effort: <effort= from resolve-model, or omit if empty>, run_in_background: true, name: "builder-<task_id>", prompt: <brief>)`. Returns immediately with a task handle.
2. Orchestrator writes the cursor with `stage: wave_<N>_waiting` and adds `task_id`, `agent_name: "builder-<task_id>"`, and the returned `agent_handle` to the `pending_subagents` list. Arms a Monitor on the event log for `subagent_completed` events. Exits.
3. The subagent runs through its internal cycle in the background. At the end:
   - Persists the structured return via `shipyard-data task-return ... --data-dir {{data_dir}}`, which writes `{{data_dir}}/sprints/current/.subagent-returns/{{task_id}}.json` (Cycle step 8). The subagent MUST pass `--data-dir {{data_dir}}` from the brief rather than letting the CLI re-resolve — its own worktree can hash to a different project data dir than the one the orchestrator is watching, which is exactly the gap that stalls `wave_<N>_waiting` on a completed task the orchestrator never sees.
   - Emits `subagent_completed` event with task / status / commit_sha / probe_exit_code / capture_file fields, `capture_file` pointing at the `.json` (Cycle step 9).
   - Returns the inline structured response (Cycle step 10); no orchestrator iteration reads it in background mode.
4. The Monitor armed by step 2 wakes /goal the moment the event lands in the log.
5. On the next /goal iteration, the orchestrator (ship-execute under `stage: wave_<N>_waiting`) sees the event, reads the `.json` capture file referenced in `capture_file=`, parses the structured contract from there, and runs the SAME orchestrator-side gate (sha exists via `git cat-file -e` + `probe_exit_code === 0` in the `.json` + non-empty output tail + anti-stub-scan). Removes `task_id` from `pending_subagents`. When `pending_subagents` is empty for the wave, advances cursor to `wave_<N>_boundary`.

**Key invariants preserved across both modes:**
- The structured-return contract is identical (STATUS / COMMIT / PROBE_EXIT / PROBE_OUTPUT_TAIL).
- The orchestrator-side gate is identical (sha `cat-file` + `probe_exit_code === 0` from the capture + non-empty output tail + anti-stub-scan). Neither mode re-runs the probe — the captured exit code is authoritative, and `shipyard-data task-return` already refused to record COMPLETE with a non-zero exit.
- The Iron Laws inside the agent body are identical.

The only difference is who reads the return: the spawning iteration (sync) or a future iteration via event-log + capture file (background).

**Mode choice:** background for wave dispatch and sprint-end test-fix redispatch (`sprint_tests_fix_iter_<K>`); sync for `--task`, `--hotfix`, and manual one-shot redispatch.

**Failure modes specific to background mode:**

1. **Subagent dies without emitting the event.** The capture file may also be absent. The orchestrator's `wave_<N>_recovery` handler watches per-task spawned_at timestamps. **Presume dead only when all three hold:** `now - spawned_at > max_execution_minutes` (default 60, configurable via task frontmatter) AND no `subagent_completed` event AND no recent `task_loop_iteration` event for that task. A live-but-slow builder still emits `task_loop_iteration` per cycle, so a recent one means "working, not dead" — do not reap it.

   On presumed-dead, run the **timeout salvage protocol** (this skill owns the contract; `/ship-execute`'s waiting handler defers to it):
   1. **TaskStop the background agent handle** for that task — use `agent_handle` from `pending_subagents` when available, otherwise use deterministic `agent_name` (`builder-<task_id>`). A presumed-dead subagent may still be a running zombie holding its worktree; stopping it first prevents a late write racing the salvage.
   2. **Salvage the worktree branch WITHOUT merging it.** The builder may have committed real work before dying, but it never passed the gate, so it must not reach the working branch. Anchor the branch tip so the commits survive teardown, then force-remove: `shipyard-data anchor-commit <task_id> <branch-tip-sha> --data-dir {{data_dir}}` (salvage only; do not use `step accept-return`, which would falsely mark an ungated/dead task done) → `git worktree remove --force .claude/worktrees/<id>` → `git branch -D shipyard/wt-<id>` (the `-D` is safe here precisely because the commits are already anchored; this is the one place `-D` is correct — teardown of *integrated* branches still uses `-d`).
   3. `shipyard-data step set-status <id> needs-attention --reason "presumed_dead"` (PROGRESS.md auto-renders), advance. Also emit `task_dispatch_returned status=blocked --data-dir {{data_dir}}` so the wave gate (invariant 1) sees a return for the task.

2. **Capture `.json` missing but event present.** Contract violation — orchestrator treats as BLOCKED and follows the single-redispatch rule.

3. **Event present but malformed (missing fields).** Contract violation — orchestrator treats as BLOCKED. The `shipyard-data events emit` CLI enforces key=value parsing so this should be rare.

4. **Event-log order differs from dispatch order.** The orchestrator matches events by the `task=` field, not by order on disk.


## Integration Notes

- **Worktree mode (isolation on).** Pass `isolation: "worktree"` on the Agent call — for isolated dispatch this is the ONLY path (see `using-worktrees`). Claude Code creates the worktree, fires the `WorktreeCreate` hook (which owns the `shipyard/wt-*` branch), and sets the subagent's cwd. Never pre-create the worktree with `git worktree add` — that bypasses the hook's branch naming and `worktree.baseRef` handling. `worktree_path` in the brief is informational only.
- **In-place mode (isolation off).** When the caller resolved isolation to off (solo, or `--isolation false` / `execution.isolation: none`), OMIT the `isolation:` argument entirely and pass `worktree_path` as null. The builder runs on the working branch in the orchestrator's checkout, sequentially — so this path must never be dispatched in parallel (no per-task `shipyard/wt-*` branch exists for the wave-integration gate to rebase). The builder's `shipyard/wt-*` branch self-check is skipped in this mode; commits land directly on the working branch and the integration gate is vacuously satisfied.
- **Test execution is deferred by default.** Tasks write tests but do NOT run them — scoped tests run at the wave boundary, full suite at sprint completion. The acceptance probe is the only check that runs inside the task.
- **Hotfix is the one exception** that DOES run tests at task level. Its regression-test cycle (Red → Green → Revert → Red → Restore → Green) needs the test actually run; a deferred suite can't prove it catches the bug.
