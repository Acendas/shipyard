# Task dispatch: kind routing, per-task dispatch, post-subagent gate, per-task cycle, redispatch, blocked and deviation handling

## Task Kind Routing (REQUIRED before every dispatch)

Read the step file frontmatter and check `kind:`.

- **`kind: feature`** or **absent** → standard feature-builder work item (documented below). Main reads `dispatching-task-loop` once to copy its builder discipline and gate requirements into the worker brief; the worker does not call that capability skill.
- **`kind: operational`** → follow the `dispatching-operational-task` playbook (owns verify_command resolution, run+capture, bounded fix loop from `operational_tasks.max_iterations`, and the orchestrator-side gate: verify_output populated, capture non-empty, final exit:0, LAST_LINES match).
- **`kind: research`** → follow the `dispatching-research-task` playbook (owns the Write-scope HARD GATE, the Findings Doc Template, and the orchestrator-side gate: file exists + ≥1 `### Finding` section + porcelain-clean).

The worker brief must include the same kind refusal rules as `dispatching-task-loop` (an operational task sent to the feature builder passes silently).

**Builders may write IDEA files during task execution** — up to 3 `IDEA-*` files to `<SHIPYARD_DATA>/spec/ideas/` for deferred unknowns / scope-adjacent rot, committed atomically with the task. The capture rules are inlined in `dispatching-task-loop`'s prompt template.

## Per-task dispatch (solo + task modes — kind: feature only)

For each feature task, main constructs one queued work item and one leaf-worker prompt from the `dispatching-task-loop` playbook. Read that playbook for the builder discipline, the structured-return contract, the orchestrator-side gate (sha verify + PROBE_EXIT:0 check + anti-stub-scan), the iteration cap, and the single-redispatch rule, then inline the relevant requirements into the worker prompt. Do NOT route the worker through `dispatching-task-loop` or any other wrapper skill; the worker is already the spawned Agent.

Parameters:

| Parameter | Value |
|---|---|
| `task_id` | e.g., `T-042` |
| `task_file_path` | `<SHIPYARD_DATA>/spec/steps/[TASK_ID]-*.md` (literal SHIPYARD_DATA path) |
| `feature_file_path` | `<SHIPYARD_DATA>/spec/stories/[FEATURE_ID]-*.md`, or null for hotfix |
| `working_branch` | `branch:` from SPRINT.md frontmatter |
| `acceptance_probe` | `acceptance_probe:` from task frontmatter (HALT and surface to user if missing — task is unauthorable without one) |
| `data_dir` | literal SHIPYARD_DATA path |
| `isolation` | `on` or `off` — the resolved isolation decision (Step 2: flag > `execution.isolation` > default `worktree`). `on` → spawn with `isolation: "worktree"`; `off` → omit the arg, run in-place sequentially. Surfaced to the worker as the `Isolation:` brief line so its branch self-check knows which branch to expect. |
| `worktree_path` | null whenever isolation is off (solo, or `task`/`track` coerced off by `--isolation false` / `execution.isolation: none`); absolute worktree path when isolation is on in task mode (track mode's nested per-task dispatch uses this same contract via the track coordinator — see `references/track-mode.md` — rather than being called directly from this table) |
| `sprint_id` | `id:` from SPRINT.md frontmatter |
| `wave_number` | current wave number from the cursor |
| `dispatch_mode` | `queue` for wave-dispatch and sprint-test-fix-redispatch; `sync` for `--task`/`--hotfix` |

When isolation is on, each task-mode leaf worker is spawned with `isolation: "worktree"` (per `using-worktrees`); when isolation is off — solo, or `task`/`track` coerced off by `--isolation false` / `execution.isolation: none` — the worker is spawned with **no** `isolation:` argument and runs in-place on the working branch, sequentially. The worker writes a structured JSON artifact (`task`, `status`, `commit_sha`, `probe_exit_code`, `output_tail`, `capture_file`, `escalation_code`) at the queue item's `expected_artifact` path (relative paths resolve under `<SHIPYARD_DATA>/sprints/current/`) and reports it through `shipyard-data queue complete|fail` with the same `--pipeline` and `--stage` used for claim. The queue CLI refuses completion when the artifact is missing, not JSON, for a different task, missing required fields, carries a missing/relative `capture_file`, or does not match `expected_artifact`. **Do not parse freeform Agent output.**

Capabilities whose rules are inlined into the worker brief: `dispatching-task-loop` (builder discipline and return contract), `verifying-completion`, `tdd-cycle`, `running-acceptance-probe`, `anti-stub-scan`, `using-worktrees`.

**Background dispatch.** Queue items own task assignment; workers own execution. Spawn leaf workers with deterministic names and queue claim prompts, record worker ids in `pending_subagents`, and advance `→ wave_<N>_waiting`. Each worker records its structured result with one command, `shipyard-data task-return`, which writes the artifact and closes its queue item (`queue fail` only when it could not start). The queue ledger and result artifacts are authority; Agent notification delivery is advisory only.

The orchestrator never reads the Agent tool's return value in queue mode — the structured-return contract is preserved via the result artifact path recorded in the queue item (read it as JSON; never regex for `STATUS:` lines).

Wrap each subagent-dispatching stage (`wave_<N>_dispatch`, `wave_<N>_redispatch_iter_<K>`, `sprint_tests_fix_iter_<K>`) with the live-progress streamer so `task_loop_iteration` events surface in chat. Pattern: [references/live-streaming.md](references/live-streaming.md).

## Post-Subagent gate (all modes)

Most kind-specific gating lives inside the dispatching-* skills (sha verify, PROBE_EXIT:0 check, anti-stub-scan, exit-0 + capture checks, findings-doc + porcelain checks). Orchestrator-side checks are minimal:

- **`kind: feature`:** verify key files exist + commits present (`git log --grep="TASK_ID"`); **item completeness** — if Technical Notes lists discrete items (e.g., "migrate 8 calls"), grep the diff for each, <100% covered → re-dispatch with the missing list as `continuation_note`; **no-commits salvage** — dirty worktree → WIP-commit + re-dispatch with a continuation note, clean worktree (did nothing) → `shipyard-data step set-status <id> approved`; single re-dispatch per task per wave, persistent failure → `shipyard-data step set-status <id> needs-attention --reason "salvage_failed"`; **in-place clean-tree gate (isolation off only)** — after each COMPLETE task, run `shipyard-context check-dirty-tree`; non-empty means the builder left the in-place working tree dirty (partial edits that would bleed into the next sequential task). WIP-commit the residue onto the working branch (`git add -A && git commit -m "wip(<TASK_ID>): salvage in-place residue"`) before dispatching the next task — never start the next in-place task on a dirty tree. (In worktree mode this is a no-op: each builder's tree is its own worktree, covered by `check-dirty-worktrees`.); **effort-gated single-task spec check** — for `effort: M|L|XL`, follow the `dispatching-spec-review` playbook `scope: "task"` (skip `effort: S`); **merge** — rebase + ff-merge the worktree branch, remove worktree, delete merged branch.
- **`kind: operational`** / **`kind: research`:** the capability skill's gate is authoritative; record the verdict and advance.

**→ `wave_<N>_waiting`** (queue mode) — see `references/pipeline-wave.md` § Wave waiting handler. In sync mode (`--task`/`--hotfix` only) there is no wave: `--task` all COMPLETE → `terminal_single_task`, `--hotfix` all COMPLETE → `terminal_hotfix`; any BLOCKED or failed gate → stay in `single_task`/`hotfix` (their only edge is the matching terminal stage; `wave_<N>_redispatch_iter_*` is unreachable here), redispatch the builder once from that stage, and if it is still BLOCKED mark the task `needs-attention`, then `cursor escalate execute reason=task_needs_attention` (never success — mode-task.md / mode-hotfix.md § Parked).

## Step 3: Per-Task Execution (implementation only)

Each task: **write tests → write implementation → run acceptance probe → commit**. Tasks do NOT execute the test suite — wave-scoped tests run at the wave boundary (Step 4), the full suite at sprint completion (Step 5). The per-task acceptance probe is the only check that fires inside the task. Full cycle: `tdd-cycle` (canonical Iron Law + Red→Green→Refactor); `dispatching-task-loop` inlines the same Iron Law into every subagent prompt.

1. **READ SPEC** → what to build. 2. **READ CODEBASE** → existing patterns. 3. **PLAN**. 4. **RED** → write failing tests (do NOT run them). 5. **GREEN** → implement; trust the test contract. 6. **PROBE** → run `acceptance_probe:` (single command, exit 0 + observable output). 7. **COMPLETENESS** → if Technical Notes lists discrete items, grep to confirm each. 8. **COMMIT** → `feat(TASK_ID): [description]`, set task `status: done`.

Do not Write/Edit PROGRESS.md — emit events (`task_blocked`, `task_status_changed`, `patch_step_created`, `wave_check_passed`, …) and cursor CLI rendering keeps it current.

## wave_N_redispatch_iter handler (stage_id: wave_N_redispatch_iter_K, K∈{1})

Entered from `wave_<N>_recovery`, `wave_<N>_verify` (FINDINGS), the sync `--task`/`--hotfix` gate, and `wave_<N>_waiting` crash recovery. Every entry names its cause: `shipyard-data cursor advance execute wave_<N>_redispatch_iter_1 iteration=<n+1> --trigger <value>` with `verify_findings` (wave spec review FINDINGS), `blocked` (BLOCKED return or escalation), `gate_failure` (failed verify-wave-integrated, probe or anti-stub gate or invariant), `recovery` (crash, stale, presumed-dead or queue-reconcile paths). Never guess; omitted, the tick logs `trigger_missing`. The graph allows entry only from `wave_<N>_dispatch`, `wave_<N>_recovery` and `wave_<N>_verify` (no `--force`); `recovery` from a mid-wave cursor (`wave_<N>_waiting`, `wave_<N>_boundary`) needs `--force`: `... --trigger recovery --force`.

1. **Before routing to `wave_<N>_redispatch_iter_1`**, emit `dispatch_attempt subject=<task>` per `dispatching-task-loop` step 3a for each gate-failed/BLOCKED task — never for silent returns, crashes or queue re-claims — and resolve the redispatch model with `shipyard-data resolve-model build --subject <task>`.
2. **Dispatch.** Redispatch is a SYNC dispatch, single attempt (`iteration=<n+1>`): one re-dispatch per task per wave via `dispatching-task-loop`, with the missing-item list, spec-review findings or failing-test list as `continuation_note`.
3. **Gate.** Same orchestrator-side gate as `wave_<N>_recovery` (`shipyard-data step accept-return`).
4. **Exit.** → `wave_<N>_boundary`; a task that still fails → `needs-attention`, surfaced to `/ship-review`; a persistent BLOCKED return → Loop Detection & Debug Escalation below.

## Blocked Task Handling

1. **Self-resolve** — a workaround within scope (< 5 min); any code change goes through `dispatching-task-loop`, never a hand-edit here.
2. **Escalate** — render the blocker as chat text first (task ID, the BLOCKED return's reason, `escalation_code`, and output tail — subagent-return content does not count as shown until printed), then the Unattended decision ladder (SKILL.md): consult the think tier, take a medium/high-confidence recommendation, else park via `cursor escalate`; an `AskUserQuestion` with blocker details + options only when `execution.unattended: false`.
3. **Swap-in** — skip the blocked task, pull the next unblocked task from the wave.
4. **Park** (still blocked at wave boundary) — `shipyard-data step set-status <PID> blocked --reason "<short>"` (writes `blocked_reason` + `blocked_since` atomically and auto-emits `task_blocked task=<id> reason=<reason>` — do NOT also emit it yourself, the CLI is the sole emitter); then `shipyard-data story set-status <SID> approved` followed by `shipyard-data backlog add <SID>` (so it survives sprint archival and surfaces in the next `/ship-sprint`). The auto-emitted `task_blocked` event is the terminal gate's parking evidence, so a parked task does not block sprint completion; it hands off to /ship-review. Do not Write/Edit PROGRESS.md; the render hook regenerates it.

## Loop Detection & Debug Escalation

Loop detection lives inside `dispatching-task-loop`'s subagent context — its own iteration cap (5 internal iterations) plus the structured `STATUS: BLOCKED` return surface stuck tasks without per-Edit hook overhead.

When the orchestrator sees `STATUS: BLOCKED` after the single re-dispatch budget (or recurring `BLOCKED` across waves on the same task), escalate to debug mode: write `<SHIPYARD_DATA>/debug/[task-id].md` with the collected BLOCKED reasons.

Before parking (or, with `execution.unattended: false`, before an AskUserQuestion), if the BLOCKED return's `escalation_code` has no matching entry in `dispatching-task-loop`'s escalation-code routing (an uncovered blocker), follow the `escalating-to-thinker` playbook (trigger: `uncovered_blocked`, subject: the task ID). It checks the per-sprint consult cap and returns a recommendation to execute through normal paths; only if it declines, returns low confidence, or its recommendation also fails do you park the step (`cursor escalate execute reason=<code>`; unattended) or fall through to AskUserQuestion (attended). A documented escalation-code path always runs first. Render the collected BLOCKED reasons (and the consult's DIAGNOSIS if one ran) as chat text above the ask — the debug file and subagent returns are not visible to the user until printed. Then:

> *"Task [TASK_ID] hit its dispatch budget after [N] BLOCKED returns. I've started a debug session.*
> *1. Debug now — `/ship-debug --resume`*
> *2. Skip task — move to next unblocked task*
> *3. Describe the problem — I'll help directly*
> *Recommended: 1."*

## Deviation Rules

| Category | Examples | Action |
|---|---|---|
| **Bug / Missing Critical / Blocker** | runtime errors, missing null checks, missing auth, broken imports | allocate the id (`shipyard-data next-id steps`), **write `spec/steps/<id>-<slug>.md` FIRST**, then follow the `dispatching-task-loop` playbook with that `task_file_path`; only after the file exists, emit `patch_step_created task_id=<id> feature=<feature> source=execute-deviation` |
| **Structural** | new DB table, new service, different design pattern | render the deviation as chat text (what the plan said, what was found, why the structure differs), then the Unattended decision ladder: consult the think tier (`escalating-to-thinker`), take a medium/high-confidence recommendation and log `execute_decision source=consult`, else `cursor escalate execute reason=structural_deviation` — `AskUserQuestion` only when `execution.unattended: false` |

**Patch-task budget (deferral guard).** Before emitting a `patch_step_created source=execute-deviation` event, run `shipyard-data patch-budget` (the CLI counts this sprint's `patch_step_created` events and computes the cap: the larger of `execution.max_patch_tasks` and `execution.patch_steps_per_story` × the sprint's stories — never count from memory). On exit 3 (nothing left), stop auto-creating patch steps and decide with the Unattended decision ladder: one think-tier consult on keep patching / re-plan / cut scope, log `execute_decision source=consult`, and park what is cut with `cursor escalate execute reason=patch_budget` (it is reported at the sprint review). `AskUserQuestion` only when `execution.unattended: false` — render the accumulated patch list as chat text first.

**The orchestrator never writes, edits, or fixes code directly.** Always delegate.
