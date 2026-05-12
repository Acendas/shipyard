---
name: ship-execute
description: "Execute the current sprint in test-first waves, with solo, subagent, or team modes."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, Agent, AskUserQuestion, Monitor, TeamCreate, TeamDelete, TaskCreate, TaskUpdate, TaskGet, TaskList, SendMessage]
effort: medium
argument-hint: "[--task ID] [--hotfix ID] [--mode solo|subagent|team]"
---

# Shipyard: Sprint Execution

Execute sprint tasks following the wave plan. Every task follows Red → Green → Refactor → Mutate.

## Context

!`shipyard-context path`

!`shipyard-context view config`
!`shipyard-context view sprint 80`
!`shipyard-context view sprint-progress`
!`shipyard-context view codebase`

**Paths.** All Shipyard file ops use the absolute SHIPYARD_DATA prefix from the context block (no `~`, `$HOME`, or shell variables). Bash is for project test commands, git, and `shipyard-data with-lock sprint -- <cmd>` only — never for reading or writing Shipyard state. **Never use `echo`, `printf`, or shell redirects (`>`) to write state files** — use the Write tool, which is auto-approved for SHIPYARD_DATA and avoids permission prompts. When passing paths into spawned Agent prompts, substitute the literal SHIPYARD_DATA path.

## Input

$ARGUMENTS

## Acquire Locks

Invoke the **`shipyard:acquiring-skill-lock` capability skill** to (a) check the planning-session lock at `<SHIPYARD_DATA>/.active-session.json` and HARD-BLOCK if a discussion is in progress in another session, and (b) acquire `<SHIPYARD_DATA>/.active-execution.json` with the lock JSON shape including `session_id`. The capability skill handles cleared-sentinel detection, 2h-stale recovery, and the cross-skill mutual exclusion.

If the planning lock is held by a live different session, print the HARD BLOCK message from the capability skill's contract and STOP — do not load any further context.

3. **On sprint completion or pause** (HANDOFF.md written), use the Write tool to overwrite `<SHIPYARD_DATA>/.active-execution.json` with `{"skill": null, "cleared": "<iso-timestamp>"}`. (Soft-delete sentinel.)

## Detect Mode

- `--task T001` → Execute single task only
- `--hotfix B-HOT-001` → Hotfix mode (branch from main, bypass sprint)
- `--mode solo|subagent|team` → Override execution mode
- No args → Execute full sprint from current wave

---

## Pre-flight: Status Check

Before doing anything else, run the `/ship-status` validation silently (Check 1–7 from ship-status). This catches stale state, tasks marked done without commits, broken references, and schema issues BEFORE spending tokens on execution. Auto-fix what can be fixed. If critical issues remain (e.g., sprint references non-existent tasks), report and stop — don't execute on broken state.

## Pre-flight: /goal-mode Gates

`/ship-execute` runs /goal-shaped by default — sprint-start to sprint-done without per-wave hand-off, halting only on documented escalation contracts. Seven pre-flight gates refuse entry when a known-ambiguous condition exists, so /goal never compounds a structural problem. Skip on `--task` and `--hotfix` modes.

Run each gate in order. First failure emits `sprint_goal_preflight_failed` (`shipyard-data events emit sprint_goal_preflight_failed gate=<name> sprint=<id>`) and halts with an actionable message. Do NOT proceed in degraded /goal mode.

The gate names, structural checks, rationale, and actionable-fix copy per gate live in [references/goal-mode-preflight.md](references/goal-mode-preflight.md). Read that file when implementing the pre-flight phase.

## Pre-flight: Git Repository Check

Before spawning any agents, verify git is ready (builder agents use worktree isolation):

1. `git rev-parse --git-dir 2>/dev/null` — if this fails, not a git repo
2. `git log -1 2>/dev/null` — if this fails, no commits exist
3. `git status --porcelain 2>/dev/null` — if this shows uncommitted changes, worktrees won't have them.

   **First**, output as plain text: explain that uncommitted changes exist, that worktree agents start from the last commit, and what the options are with tradeoffs.

   **Then**, invoke AskUserQuestion with:
   "Uncommitted changes detected. Worktree agents won't see them.

   1. Commit now — save as 'wip: pre-sprint' (amend later)
   2. Stash — save, run sprint clean, restore after
   3. Continue — changes don't affect sprint tasks

   Recommended: 1"

If checks 1-2 fail → run `git init` (if needed), then `git add -A && git commit -m "chore: initial commit"`. Worktree isolation requires at least one commit.

**DO NOT check if the project is a worktree. DO NOT fall back to solo mode because of worktrees.** The WorktreeCreate hook handles all worktree scenarios including nested worktrees by creating them from the parent repo. Always use the execution mode determined by task count (solo/subagent/team), never downgrade because of git worktree state.

## Operating Principles

- **LSP first.** Use LSP (`documentSymbol`, `goToDefinition`, `findReferences`, `hover`) before Grep/Read for all code navigation. Fall back silently if LSP is unavailable. Pass this to builder subagents. Full strategy: `references/lsp-strategy.md`.
- **Stay lean as orchestrator** (~10-15% context). Pass file paths to subagents, not contents. State lives in PROGRESS.md / HANDOFF.md, not conversation. Spot-check results before trusting them. Full guide: `references/context-management.md`.
- **Git strategy.** Work on the user's current branch — no sprint branches, no pushes. Solo commits directly; subagent/team mode uses per-task or per-feature worktrees that rebase back at wave/feature end. Worktrees branch from current local HEAD. Atomic commits per task. Full strategy: `references/git-strategy.md`.
- **Output capture.** Test/build/E2E commands and other verification runs are dispatched via `shipyard:dispatching-operational-task`, which captures stdout+stderr to `<SHIPYARD_DATA>/captures/<task_id>/run-<N>.log` via plain `tee`. No `shipyard-logcap` dependency. Don't run verification commands directly in this session — delegate.
- **Communication.** Blocker reports and decisions use the 3-layer pattern (one-liner / context / options); keep under 100 words; always recommend a default. Full guide: `references/communication-design.md`.

## FULL SPRINT Execution

**CRITICAL: Execute the ENTIRE sprint to completion.** Do not pause between waves to ask the user if they want to continue. Do not suggest re-invoking `/ship-execute`. Do not suggest `/clear` between waves. Execute wave after wave until all tasks are done, then report sprint completion. The only reasons to stop mid-sprint are: (1) an unresolvable blocker requiring user input (AskUserQuestion), (2) a structural deviation requiring user decision (Rule 4), or (3) the user explicitly says "pause" or "stop".

### Step 0: Worktree Salvage (always runs first)

Run `git worktree prune` (portable across macOS/Linux/Windows; only removes admin metadata for already-deleted directories), then `git worktree list`. If no `shipyard/wt-*` paths appear, skip to Step 1.

Otherwise, for each leftover `shipyard/wt-*` worktree:

1. **Salvage uncommitted work** if present: `git -C <worktree> add -A` then `git -C <worktree> commit -m "wip(TASK_ID): salvage from interrupted session"`. Task ID is the branch suffix.
2. **Rebase + ff-merge** the worktree branch onto the working branch. Conflicts → keep the branch; note `"shipyard/wt-X has conflicts — manual merge needed"` in PROGRESS.md and skip the merge.
3. **Remove the worktree** (`git worktree remove`) and delete merged branches.
4. **Update task status** — done if a real commit landed, in-progress for WIP-only salvages, approved (re-execute) if nothing to salvage, blocked for conflicts.

Anthropic's stale-worktree cleanup (per `cleanupPeriodDays`) handles worktrees with NO uncommitted changes / NO untracked files / NO unpushed commits at session start automatically. Step 0 only handles the cases Anthropic's sweep skips.

The working branch now contains all recoverable work. New worktrees created in Step 2 branch from this consolidated state.

### Step 1: Load Sprint Plan

Read SPRINT.md — get wave structure (task IDs grouped by wave), critical path, execution mode.
Read PROGRESS.md — get current wave number, blockers, session log.
For each task ID in the current wave, read its task file to get title, effort, status, dependencies, parent feature.

**Detect session type — fresh start vs resume vs crash recovery:**

1. **HANDOFF.md exists** → **Graceful resume.** Previous session paused cleanly. Follow the On Resume flow (see Pause/Resume section below). (Worktrees already salvaged in Step 0.)

2. **No HANDOFF.md, but PROGRESS.md shows tasks done OR Step 0 salvaged work** → **Crash recovery.** Previous session died without writing HANDOFF.md (quota, crash, kill). Worktree salvage already happened in Step 0 — proceed to resume execution from the current wave.

3. **No HANDOFF.md, no tasks done, Step 0 found no worktrees** → **Fresh start.** First execution of this sprint.
   - Record the user's current branch: `git branch --show-current` → this is the working branch for the entire sprint
   - Write `branch: <current branch>` to SPRINT.md frontmatter if not already set

**Record sprint start time (idempotent):** Read SPRINT.md frontmatter. If `started_at` is null or absent, write `started_at: <current ISO 8601 timestamp>` to SPRINT.md frontmatter. If `started_at` already has a value, leave it unchanged — this must never overwrite an existing timestamp so that resuming a paused sprint does not reset the clock.

### Step 1.5: Execution Readiness Check (fresh-start only)

On fresh sprint start, present a compact readiness check before any code is written. Skip on resume / crash recovery.

```
READINESS CHECK
  Branch: <current> [matches SPRINT.md? mismatch / ⚠️ on shipyard/wt-* branch]
  Uncommitted: <none | list>
  Mode: <solo | subagent | team>
  Tasks: N across M waves
  Wave 1: <task IDs + titles + effort>
  Baseline tests: <pass | fail | not-run>
  Risks: <top 2-3 from SPRINT.md>
HOW TO PAUSE: type "pause" any time.
```

If the current branch starts with `shipyard/wt-*`, add: *"⚠️ Worktree branch detected — Shipyard will switch to <working branch> before spawning agents."*

Then `AskUserQuestion`: Begin execution (Recommended) / Adjust / Abort.

The `using-worktrees` capability skill encodes the trust-the-platform model; `dispatching-task-loop`'s HARD STOP catches genuinely-broken isolation.

### Step 2: Execute Waves

For each wave (starting from current):

**ALWAYS delegate task execution to subagents.** Every task runs in a fresh context window — this keeps the orchestrator lean and prevents context degradation across waves. The mode determines parallelism, not whether subagents are used.

#### Solo Mode (1-3 tasks per wave)
Spawn subagents **sequentially** — one task at a time, same branch (no worktree isolation needed since tasks run one after another).

#### Subagent Mode (4-10 tasks per wave)
Spawn subagents **in parallel** — up to `execution.max_parallel_agents` from config at a time (default 3, hard ceiling 4). If a wave has more tasks than the cap, **batch them**: spawn the first N, wait for all N to return and run post-subagent checks, then spawn the next batch from the updated HEAD. This prevents the quality degradation observed when 6-7 agents run simultaneously (Sprint 001/002 anti-pattern: agents hit context limits or return early without committing).

#### Team Mode (10+ tasks)
Spawn persistent teammates per feature track using Agent Teams. Each teammate works through all tasks in its feature — more efficient than per-task subagents for features with 3+ tasks. **Max `execution.max_parallel_agents` concurrent teammates** (default 3, hard ceiling 4) — additional feature tracks are queued and spawned as earlier ones complete.
**Read the full protocol** in `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/team-mode.md`. (Team-mode workarounds for Anthropic's then-buggy worktree-isolation are mostly obsolete — the file is on track for retirement once Anthropic's native Agent Teams worktree isolation is GA. Keep using `general-purpose` + `team_name` per the `using-worktrees` capability skill until then.)

#### Pre-spawn Branch Check (subagent AND team mode)

Before spawning any worktree agents, verify the orchestrator is on the expected working branch:
```bash
git branch --show-current
```
Read `branch` from SPRINT.md frontmatter.

**If on a `shipyard/wt-*` branch** → the orchestrator is running inside a leftover worktree or the user checked out a worktree branch in the main repo. This is dangerous — new worktrees would branch from the wrong commit. Fix: `git checkout <sprint working branch>` before proceeding. Report: "WARNING: Orchestrator was on worktree branch [name], switched to [working branch]."

**If branch doesn't match SPRINT.md** → `git checkout <branch>` before proceeding.

The WorktreeCreate hook branches worktrees from the current local branch. If the orchestrator is on the wrong branch, all worktrees will branch from the wrong place.

#### Task Kind Routing (REQUIRED before every dispatch)

Before spawning any agent for a task, read the task file frontmatter and check `kind:`. The dispatch path depends on the kind — getting this wrong is how the silent-pass bug happens.

- **`kind: feature`** or **absent** → standard `shipyard-builder` dispatch below (this is the path the rest of this section documents).
- **`kind: operational`** → invoke `shipyard:dispatching-operational-task` capability skill. It owns the verify_command resolution, the run+capture phase, the bounded fix-findings loop (cap from `operational_tasks.max_iterations`), and the orchestrator-side gate (verify_output populated, capture file non-empty, final exit:0, LAST_LINES match).
- **`kind: research`** → invoke `shipyard:dispatching-research-task` capability skill. It owns the Write-scope HARD GATE (one findings doc), the Findings Doc Template, and the orchestrator-side gate (file exists + ≥1 `### Finding` section + porcelain-clean).

**Why this matters.** The silent-pass failure mode — `/ship-execute` marking "run E2E suite and fix findings" tasks done without running any tests — is the exact bug introduced when operational tasks hit the builder. The builder has no Red step for an operational task, exits clean on an empty tree, and the "Before Exiting" check passes trivially. This routing split is the primary fix. The `shipyard-builder` agent ALSO has a Step 0 HARD STOP that refuses any task with `kind: operational` — but that's defense in depth. The first line of defense is this router.

**Note — builders may write IDEA files during task execution.** Up to 3 `IDEA-*` files to `<SHIPYARD_DATA>/spec/ideas/` for deferred unknowns and scope-adjacent rot discovered while building. Committed atomically with the task. IDEAs surface in `/ship-sprint`'s carry-over scan and `/ship-backlog`'s IDEAS section. The capture-deferred-unknowns rules are inlined in `dispatching-task-loop`'s subagent prompt template.

#### Per-task dispatch (solo + subagent modes — kind: feature only)

For each task in the wave, **invoke the `shipyard:dispatching-task-loop` capability skill** — do NOT construct an Agent dispatch inline. The capability skill owns the prompt template (with the three Iron Laws inlined), the structured-return contract, the orchestrator-side gate (sha verification + probe re-execution + anti-stub-scan), the iteration cap, and the single-redispatch rule.

Pass these parameters to `dispatching-task-loop`:

| Parameter | Value |
|---|---|
| `task_id` | The task ID, e.g., `T-042` |
| `task_file_path` | `<SHIPYARD_DATA>/spec/tasks/[TASK_ID]-*.md` (use the absolute literal SHIPYARD_DATA path) |
| `feature_file_path` | `<SHIPYARD_DATA>/spec/features/[FEATURE_ID]-*.md` for the parent feature, or null for hotfix |
| `working_branch` | `branch:` field from SPRINT.md frontmatter |
| `acceptance_probe` | `acceptance_probe:` from the task's frontmatter (HALT and surface to user if missing — task is unauthorable without one) |
| `data_dir` | Literal SHIPYARD_DATA path |
| `worktree_path` | null in solo mode; absolute worktree path in subagent/team mode |

In **subagent/team mode**, the capability skill internally dispatches with `isolation: "worktree"` (per `using-worktrees` — Anthropic's stable primitive). In **solo mode**, no isolation. The skill handles both transparently.

The skill returns a structured verdict (`STATUS: COMPLETE` + `COMMIT: <sha>` + `PROBE_OUTPUT_TAIL` after orchestrator-side verification, or `STATUS: BLOCKED` with reason). Use the verdict to mark the task done, log progress, or escalate. **Do not parse subagent output yourself** — the capability skill has already validated it.

Capabilities used per task: `shipyard:dispatching-task-loop` (which internally uses `shipyard:verifying-completion`, `shipyard:tdd-cycle`, `shipyard:running-acceptance-probe`, `shipyard:anti-stub-scan`, and `shipyard:using-worktrees`).

#### Post-Subagent gate (all modes)

Most kind-specific gating already lives inside the dispatching-* capability skills (sha verification, probe re-execution, anti-stub-scan, exit-0 + capture checks, findings doc + porcelain checks). Orchestrator-side checks are intentionally minimal:

**For `kind: feature`** (post `dispatching-task-loop` return):
- Verify key files exist + commits present (`git log --grep="TASK_ID"` in the worktree).
- **Item completeness check**: if Technical Notes lists discrete items (e.g., "migrate 8 calls"), grep the diff for each. <100% covered → re-dispatch with the missing list as `continuation_note`.
- **No-commits salvage**: if the worktree has dirty changes, WIP-commit and re-dispatch via `dispatching-task-loop` with a continuation note. If the worktree is clean (subagent did nothing), reset task `status: approved`. Single re-dispatch per task per wave; persistent failure → `status: needs-attention`, log to PROGRESS.md, advance.
- **Effort-gated single-task spec check**: for `effort: M|L|XL`, invoke `dispatching-spec-review` with `scope: "task"` to catch obvious AC gaps before merge. Skip `effort: S` (overhead exceeds value).
- **Merge**: rebase + ff-merge the worktree branch; remove worktree; delete the merged branch.

**For `kind: operational`** (post `dispatching-operational-task` return):
- The capability skill's gate (verify_output populated + capture non-empty + final exit:0 + LAST_LINES match) is authoritative. Orchestrator just records the verdict and advances.

**For `kind: research`** (post `dispatching-research-task` return):
- Same pattern: capability skill's gate (file exists + ≥1 `### Finding` + porcelain clean) is authoritative.

This is the last line of defense against silent-pass regression. Capability-skill gates plus these orchestrator-side checks together cover the failure modes: false completion, stub commits, missing capture, missing findings doc, out-of-scope writes.

### Step 3: Per-Task Execution (implementation only)

Each task is a small, focused unit of work: **write tests → write implementation → run acceptance probe → commit**. Tasks do NOT execute the test suite — test execution is deferred. Wave-scoped tests run at the wave boundary (Step 4); the full suite runs at sprint completion (Step 5). The per-task acceptance probe is the only check that fires inside the task.

**Read the full cycle details** in the `shipyard:tdd-cycle` capability skill — the canonical Iron Law and Red→Green→Refactor contract. The `dispatching-task-loop` capability skill inlines the same Iron Law into every subagent prompt.

Per-task summary:
1. **READ SPEC** → understand what to build
2. **READ CODEBASE** → check existing patterns
3. **PLAN** → decide approach
4. **RED** → write tests that would fail (do NOT run them — wave boundary executes tests)
5. **GREEN** → implement; trust the test contract you just wrote
6. **PROBE** → run the task's `acceptance_probe:` (single command, exit 0 + observable output)
7. **COMPLETENESS CHECK** → if Technical Notes lists discrete items, grep to confirm every one was addressed
8. **COMMIT** → `feat(TASK_ID): [description]`, update task status to `done`

Key rules:
- Tests MUST be written before implementation. Test *execution* is deferred to wave/sprint boundaries; the test-first discipline is unchanged.
- The acceptance probe is the only thing run inside the task — it proves the wiring works without running the suite.
- Commit format: `feat(TASK_ID): [description]`. Update task file status to `done` after each.
- Log session progress in PROGRESS.md (blockers, deviations — NOT task completion status).

### Step 4: Wave Boundary Check

Between waves:

1. **Rebase + ff-merge** task branches one at a time, in order. For each `shipyard/wt-*` branch: `git rebase <working-branch>` → `git checkout <working-branch>` → `git merge --ff-only` → `git worktree remove` → `git branch -d`. Conflicts → AskUserQuestion with details; never fall back to a regular merge (creates fork lines).
2. **Clean orchestrator branch.** `git status --porcelain` must be empty after all merges. Legitimate state changes (PROGRESS.md, task status) → commit `chore(shipyard): wave [N] state update`. Unexpected source-file changes → AskUserQuestion.
3. **Update PROGRESS.md** `current_wave: <next>`. Wrap in `shipyard-data with-lock sprint --` if a parallel writer is possible (recovery, review fixers).
4. **Wave-scoped build** (if `build_commands.scoped` or `build_commands.full` configured): invoke `shipyard:dispatching-operational-task` with the build command. Failure → re-dispatch the same capability skill to drive a bounded fix loop.
5. **Wave REFACTOR + MUTATE**: dispatch a `general-purpose` subagent with an inline wave-refactor prompt (read the combined wave diff, dedupe + rename + add helpers, run a small mutation check, commit if changes). Not a wave blocker — failure logs to PROGRESS.md and advances.
6. **Wave-scoped tests + single fix iteration**: invoke `shipyard:dispatching-operational-task` with `test_commands.scoped` (or `test_commands.unit` if no scoped variant). This is the first time tests run for the wave's merged code. The operational task runs the suite via Monitor, so progress and failures stream to the user as the wave-scoped run proceeds — no waiting on a single end-of-run blob. Failure → ONE re-dispatch via `shipyard:dispatching-task-loop` with the failing-test list as `continuation_note`. Persistent failure logs to PROGRESS.md and advances.
7. **Wave VERIFY**: invoke `shipyard:dispatching-spec-review` with `scope: "wave"`, `target_ids: [task_ids]`, `base_ref` (pre-wave HEAD), `head_ref` (current HEAD). FINDINGS → single re-dispatch per task via `dispatching-task-loop`; persistent gaps → `needs-attention` and surface to `/ship-review`.
8. **Wave COMPLETION GATE**: invoke `shipyard:verifying-wave-completion` with `wave_number`, `task_ids`, `data_dir`, `working_branch`, `wave_base_sha`, `wave_head_sha`, `wave_probe_capture`, `wave_probe_exit_code`. The capability skill runs the six-invariant composite check (all builders returned structured contracts, every commit_sha exists, wave-probe passes with non-empty capture, completion events emitted, no silent-failure markers in window, no uncommitted worktree state) with ScheduleWakeup-based recovery for RECOVERABLE misses and structured escalation otherwise. `STATUS: ESCALATED` → AskUserQuestion with the `REASON:` text; do NOT advance the wave counter. `STATUS: COMPLETE` → proceed to step 9.
9. **Report and continue** — emit a one-line wave status (`Wave [N]/[M] ✓ [████░░░░] [done]/[total] tasks • → Wave [N+1]`). **Do NOT pause, do NOT suggest `/clear`, do NOT ask "continue?"** — auto-advance.
10. **Context pressure: warn-only.** If `<SHIPYARD_DATA>/.active-execution.json`'s `compaction_count` ≥ 4, append `⚠ Context summarised N times — consider /clear then /ship-execute`. The counter is informational; never auto-pause.

### Compaction Recovery

If you're unsure which wave you're on or what's been completed (e.g., after auto-compaction cleared earlier context):

1. Read PROGRESS.md — `current_wave` in frontmatter tells you which wave to execute next
2. Read SPRINT.md — get the wave structure (which task IDs are in each wave)
3. For task IDs in waves ≤ `current_wave - 1`, read task files — confirm `status: done`
4. For task IDs in wave `current_wave`, read task files — check which are `done` vs remaining
5. Check git branch — `git branch --show-current` to confirm you're on the working branch (from SPRINT.md `branch` field). If not → `git checkout <branch>` before spawning any worktree agents.
6. Resume execution from the first non-done task in `current_wave`

This takes ~5 tool calls and recovers full state from files. Do not rely on conversation memory for wave/task state — files are the source of truth.

### Step 5: Sprint Completion

When all waves done:

1. **Full build** (if `build_commands.full` configured): invoke `shipyard:dispatching-operational-task` with that command. Catches cross-module compilation errors scoped wave builds missed. Failure → AskUserQuestion.
2. **Full test suite**: invoke `shipyard:dispatching-operational-task` per tier (unit / integration / e2e) or combined. Persistent failure after the capability skill's iteration cap → re-dispatch via `shipyard:dispatching-task-loop` per failing cluster. Sprint-level branch owns all errors.
3. **Sprint-complete predicate**: invoke `shipyard:evaluating-sprint-complete` with `sprint_id`, `data_dir`, `working_branch`, `sprint_base_sha` (from SPRINT.md frontmatter), `sprint_head_sha` (current HEAD), `sprint_verify_capture` (from step 2), `sprint_verify_exit_code` (from step 2), `review_verdict_path` (null at this stage; `/ship-review` will run after). The skill runs the seven-invariant composite gate. `STATUS: INCOMPLETE` → halt with the failing invariant list via AskUserQuestion; do NOT mark sprint complete. `STATUS: COMPLETE` → proceed to step 4. Invariant 7 (review-verdict-clean) is expected to FAIL at this stage because review hasn't run yet — that's by design; the user runs `/ship-review` next, then re-invokes the predicate. The pre-`/ship-review` invocation here surfaces invariants 1–6 (commits, sprint-verify, spec-done, no-orphan-AC, no-silent-markers, clean-worktrees) before burning review time on a sprint that isn't shippable for structural reasons.
4. **Finalize**: update SPRINT.md frontmatter (`status: completed`, `completed_at: <ISO>`). Features stay `in-progress` — only `/ship-review` transitions them to `done`. Report:

```
Sprint complete. [N]/[M] tasks done. Full suite: [pass/fail].
▶ NEXT UP: /ship-review (tip: /clear first for a fresh window)
```

---

## SINGLE TASK Mode (--task)

Execute just one task following the TDD cycle above. Useful for:
- Picking up a specific blocked task after unblocking
- Re-executing a failed task
- Running a patch task

Single-task mode follows the same structure: builder writes tests + implementation (no test execution), then the wave REFACTOR+MUTATE+VERIFY sequence runs for the single-task wave.

---

## HOTFIX Mode (--hotfix)

1. Read bug file (B-HOT-NNN)
2. Verify the user is on the branch they want the hotfix applied to (AskUserQuestion if unclear)
3. Execute TDD cycle (must include regression test)
4. Commit: `fix(B-HOT-NNN): [description]`
5. Report: "Hotfix ready. Review with /ship-review --hotfix B-HOT-NNN"

Shipyard does not create branches, merge, or push for hotfixes — the user handles their own git workflow. Hotfix does NOT affect sprint state or velocity.

Hotfix mode is the one exception that DOES run tests at task level — the regression test is the whole point of a hotfix, and you need to see it go red→green→still-red-after-revert→green to prove the fix actually catches the bug. Sprint tasks never run tests at task level (deferred to wave boundary); hotfix tasks always do.

---

## Blocked Task Handling

If a task can't proceed:

1. **Self-resolve** — try workaround within scope (< 5 min)
2. **Escalate** — AskUserQuestion with blocker details + options
3. **Swap-in** — skip blocked task, pull next unblocked task from wave
4. **Park** — if still blocked at wave boundary:
   - Update the task file's frontmatter: `status: blocked`, add `blocked_reason: "[reason]"` and `blocked_since: "[ISO date]"`
   - Update the parent feature's status back to `approved` in feature frontmatter
   - Add the parent feature ID back to BACKLOG.md (so it's visible in next sprint planning)
   - This ensures blocked tasks survive sprint archival and are surfaced by the next `/ship-sprint`

Track in PROGRESS.md:
```
| Task | Reason | Since | Escalation |
```

## Loop Detection & Debug Escalation

Loop detection lives inside `dispatching-task-loop`'s subagent context — the subagent's own iteration cap (5 internal iterations) plus the structured `STATUS: BLOCKED` return surface stuck tasks without per-Edit hook overhead.

When the orchestrator sees `STATUS: BLOCKED` after the single re-dispatch budget (or recurring `BLOCKED` across waves on the same task), escalate to debug mode: write `<SHIPYARD_DATA>/debug/[task-id].md` with the BLOCKED reasons collected, then `AskUserQuestion`:

> *"Task [TASK_ID] hit its dispatch budget after [N] BLOCKED returns. I've started a debug session.*
> *1. Debug now — `/ship-debug --resume`*
> *2. Skip task — move to next unblocked task*
> *3. Describe the problem — I'll help directly*
> *Recommended: 1."*

## Pause / Resume

Claude Code's `--continue` restores conversation history but not project state (which wave, which task). Shipyard bridges with HANDOFF.md.

**On pause** (user says "pause"/"stop"/"break", or session ending): Write `<SHIPYARD_DATA>/sprints/current/HANDOFF.md` with frontmatter `paused_at` / `wave` / `task` / `mode` / `branch` (plus `team_name` / `teammates` / `queued_tracks` in team mode), then sections `## Completed This Session`, `## In Progress`, `## Blocked`, `## Next Steps`, `## Decisions Made`.

**On resume** (HANDOFF.md exists): (1) Read HANDOFF.md, (2) accumulate `paused_minutes` into SPRINT.md's `total_paused_minutes` then clear `paused_at`, (3) verify PROGRESS.md matches, (4) confirm git branch, (5) team mode only — `TeamCreate` + re-spawn teammates from the `teammates` field (previous teammates are always dead after a session break), (6) delete HANDOFF.md, (7) continue from the documented next step.

Step 0 (worktree salvage) has already run before reaching On Resume. Works alongside `claude --continue`.

## Resume-from-event-log (/goal-mode crash recovery)

A user-initiated pause writes HANDOFF.md (above). A /goal-mode interruption (Esc mid-loop, escalation halt, budget exhaustion, session crash without HANDOFF.md) leaves no hand-written artifact — the event log is the source of truth instead.

When `/ship-execute` re-enters without HANDOFF.md but with a non-empty `<SHIPYARD_DATA>/.shipyard-events.jsonl`, follow the protocol in [references/resume-from-event-log.md](references/resume-from-event-log.md). Short shape: scan the log for the last `wave_check_passed`, cross-check the registry, re-verify the last-clean-wave invariants with `wakeup_budget: 0`, re-dispatch incomplete tasks in the current wave, advance. PROGRESS.md is for humans; the event log is for machines — this protocol reads the machine surface.

If the event log is empty or corrupted, refuse to resume — re-run `/ship-status --repair` first.

## Deviation Rules

| Category | Examples | Action |
|---|---|---|
| **Bug / Missing Critical / Blocker** | runtime errors, missing null checks, missing auth, broken imports | invoke `shipyard:dispatching-task-loop` with a patch task; log to PROGRESS.md `## Deviations` |
| **Structural** | new DB table, new service, different design pattern | `AskUserQuestion` before proceeding |

**The orchestrator never writes, edits, or fixes code directly.** Always delegate.

## Rules

- NEVER skip TDD. Test *execution* is deferred to wave/sprint boundaries; the test-first discipline is unchanged. Tasks write tests before implementation; scoped tests run at the wave boundary; the full suite runs at sprint completion. Hotfix is the one exception (always runs tests at task level).
- NEVER modify test assertions to pass — fix the implementation.
- NEVER build beyond acceptance criteria.
- ALWAYS commit atomically per task; update task `status: done` after each.
- Log blockers / deviations / session notes in PROGRESS.md.
- NEVER fix test failures, lint errors, or bugs directly in this session — invoke `shipyard:dispatching-task-loop` (code) or `shipyard:dispatching-operational-task` (command-shaped) to delegate.
- Architectural changes → `AskUserQuestion`.
- If in doubt → `AskUserQuestion`.
