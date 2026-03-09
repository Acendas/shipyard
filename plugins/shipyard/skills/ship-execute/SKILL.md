---
name: ship-execute
description: "Execute the current sprint by running tasks in waves with strict test-driven development (write tests first, then code). Supports solo, subagent, and team execution modes. Use when the user wants to start building, execute sprint tasks, run a specific task, apply a hotfix, or resume execution after a break."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode, TeamCreate, TeamDelete, TaskCreate, TaskUpdate, TaskGet, TaskList, SendMessage]
model: sonnet
effort: medium
argument-hint: "[--task ID] [--hotfix ID] [--mode solo|subagent|team]"
---

# Shipyard: Sprint Execution

Execute sprint tasks following the wave plan. Every task follows Red → Green → Refactor → Mutate.

## Context

!`shipyard-context path`

!`shipyard-context head config.md 50 NO_CONFIG`
!`shipyard-context head sprints/current/SPRINT.md 80 NO_SPRINT`
!`shipyard-context head sprints/current/PROGRESS.md 50 NO_PROGRESS`
!`shipyard-context head codebase-context.md 50 "No codebase context"`

**Data path: use the SHIPYARD_DATA path from context above. For Read/Write/Edit tools, use the full literal path (e.g., `/Users/x/.claude/plugins/data/shipyard/projects/abc123/...`). NEVER use `~` or `$HOME` in file_path — always start with `/`. For Bash: `SD=$(shipyard-data)` then `$SD/...`. Shell variables like `$SD` do NOT work in Read/Write/Edit file_path — only literal paths. NEVER hardcode or guess paths.**

## Input

$ARGUMENTS

## Session Guard Cleanup

**First action:** Delete `.active-session.json` from the SHIPYARD_DATA directory (use the full literal path from context above) if it exists — execution is an implementing skill and the session guard should not block code writes.

## Execution Lock

**Before starting work**, check for concurrent execution:

1. Read `$(shipyard-data)/.active-execution.json` — if it exists and is less than 2 hours old:
   ```
   ⛔ BLOCKED: Another execution session is active.
     Skill: [skill name]
     Started: [timestamp]

   Concurrent execution causes git conflicts, duplicate commits, and corrupted state.
   Use the existing session, or /clear then /ship-execute to resume there.
   If the other session crashed or was closed: /ship-status (will ask to clear the lock)
   ```
   **Hard block — do not proceed. Do not offer an override.** Stop immediately.

2. If no lock exists or lock is stale (>2 hours) → write `$(shipyard-data)/.active-execution.json`:
   ```json
   {
     "skill": "ship-execute",
     "sprint": "[sprint ID]",
     "wave": "[current wave]",
     "started": "[ISO date]"
   }
   ```
   Also delete `$(shipyard-data)/.compaction-count` if it exists — reset the counter for this session.

3. **On sprint completion or pause** (HANDOFF.md written), delete both `$(shipyard-data)/.active-execution.json` and `$(shipyard-data)/.compaction-count`.

## Detect Mode

- `--task T001` → Execute single task only
- `--hotfix B-HOT-001` → Hotfix mode (branch from main, bypass sprint)
- `--mode solo|subagent|team` → Override execution mode
- No args → Execute full sprint from current wave

---

## Pre-flight: Status Check

Before doing anything else, run the `/ship-status` validation silently (Check 1–7 from ship-status). This catches stale state, tasks marked done without commits, broken references, and schema issues BEFORE spending tokens on execution. Auto-fix what can be fixed. If critical issues remain (e.g., sprint references non-existent tasks), report and stop — don't execute on broken state.

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

## LSP-First Code Intelligence

**Read the full strategy:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/lsp-strategy.md`

Summary: Use LSP before Grep/Read for all code navigation — `documentSymbol` to understand file structure, `goToDefinition` to find sources, `findReferences` for impact, `hover` for types. LSP returns precise results in one call; Grep/Read scans files consuming far more tokens. If LSP isn't available, fall back silently. Pass this principle to builder subagents in their spawn prompts.

## Context Management

**Read the full guidelines:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/context-management.md`

Summary: Stay lean as orchestrator (~10-15% context). Pass file paths to subagents, not contents. State lives in files (PROGRESS.md, HANDOFF.md), not conversation. Spot-check subagent results before trusting them.

## Git Strategy

**Read the full strategy:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/git-strategy.md`

Summary:
- Shipyard works on whatever branch the user is already on — no sprint branches
- Shipyard never pushes — the user pushes when ready
- Solo: commit directly on the user's current branch
- Subagent: each task gets its own worktree branch, rebases back to user's branch at wave end
- Team: each feature gets its own worktree branch, rebases back at feature completion
- Worktrees branch from the user's current local branch (via WorktreeCreate hook, not `origin/HEAD`)
- Atomic commits per task, following the project's commit convention

## FULL SPRINT Execution

**Communication design:** When reporting blockers or asking decisions, use the 3-layer pattern from `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md` — one-liner (what's blocked), context (why + impact), options (max 2–3 with named tradeoffs). Keep blocker messages under 100 words. Always recommend a default.

**CRITICAL: Execute the ENTIRE sprint to completion.** Do not pause between waves to ask the user if they want to continue. Do not suggest re-invoking `/ship-execute`. Do not suggest `/clear` between waves. Execute wave after wave until all tasks are done, then report sprint completion. The only reasons to stop mid-sprint are: (1) an unresolvable blocker requiring user input (AskUserQuestion), (2) a structural deviation requiring user decision (Rule 4), or (3) the user explicitly says "pause" or "stop".

### Step 0: Worktree Salvage (always runs first)

**Before anything else**, check for leftover worktrees from a previous session. This applies to ALL modes (solo, subagent, team) — any mode can leave behind worktrees with uncommitted work after a crash, quota exhaustion, or killed session.

```bash
git worktree list | grep 'shipyard/wt-'
```

**If no `shipyard/wt-*` worktrees exist → skip to Step 1.**

If worktrees exist, salvage all of them before proceeding:

**A. Inventory worktrees**
```bash
git worktree list
git branch --list 'shipyard/wt-*'
```
For each `shipyard/wt-*` worktree, check its state:
```bash
# Uncommitted changes?
git -C <worktree-path> status --porcelain
# Commits ahead of working branch?
git log <working-branch>..<worktree-branch> --oneline
```

**B. Salvage uncommitted changes (do this FIRST for every worktree)**
If the worktree has uncommitted changes (modified/new files):
- Commit them as WIP: `git -C <worktree-path> add -A && git -C <worktree-path> commit -m "wip(TASK_ID): salvage from interrupted session"`
- Identify the task ID from the branch name (`shipyard/wt-TASK_ID-slug` or `shipyard/wt-FEATURE_ID-slug`)

**C. Merge salvaged work onto the working branch**
For each worktree branch that has commits ahead of the working branch (including the WIP commit from step B):
- Rebase onto the working branch: `git rebase <working-branch> <worktree-branch>`
- If rebase succeeds → merge with `git merge --ff-only <worktree-branch>`
- If rebase has conflicts → keep the branch, note it: "Branch `shipyard/wt-[name]` has conflicts — manual merge needed"

**D. Clean up worktrees**
After salvaging, remove all worktrees and delete merged branches:
```bash
git worktree remove <path>
git branch -d <branch>  # only if merged
```

**E. Update task statuses**
- Tasks with complete commits salvaged (non-WIP) → `status: done`
- Tasks with WIP salvaged → `status: in-progress` (builder will re-run but finds salvaged code already in place)
- Tasks with nothing to salvage → reset `status: approved` (re-execute from scratch)
- Tasks with conflict branches → `status: blocked`, note the branch name in `blocked_reason`

**F. Report**
```
Worktree salvage:
  Salvaged: T003 (2 commits merged), T004 (WIP committed + merged)
  Conflicts: T005 (branch kept — manual merge needed)
  Lost: T006 (no commits, no changes — will re-execute)
```

**The working branch now contains all recoverable work. New worktrees created in Step 2 will branch from this consolidated state.**

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

### Step 1.5: Execution Readiness — Plan Mode (first wave only)

On a fresh sprint start (case 3 above — no tasks done yet), present a readiness check before writing any code. Skip this step on resume and crash recovery (cases 1 and 2).

**Enter plan mode** (`EnterPlanMode`) and present:

**READINESS CHECK**
- Branch: `[current branch]` — [matches SPRINT.md / mismatch warning / ⚠️ ON WORKTREE BRANCH]
- Uncommitted changes: [none / list of changed files]
- Execution mode: [solo / subagent / team]
- Worktree probe: [pass / fail / skipped (solo mode)]
- Total: [N] tasks across [M] waves
- Teammates: [N feature tracks, M concurrent (max 4), K queued] (team mode only)

If current branch starts with `shipyard/wt-`, add a prominent warning:
```
⚠️  WORKTREE BRANCH DETECTED: You are on [branch name], not the working branch.
    This is likely a leftover from a previous session. Shipyard will switch to [working branch] before spawning agents.
    If this is intentional, confirm to proceed.
```

**Worktree probe** (subagent/team mode only — skip for solo):

Before presenting the plan, verify worktree creation works end-to-end. This catches hook failures during plan mode when user interaction is expected, instead of mid-execution when it would block autonomous flow.

```bash
# Create a throwaway worktree to test the hook
# The WorktreeCreate hook should fire and create a shipyard/wt-probe branch
```
Spawn a minimal Agent with `isolation: worktree` and prompt: "Run `git branch --show-current` and report the branch name. Do nothing else."

Check the result:
- Branch starts with `shipyard/wt-` → **pass**. Clean up: `git worktree remove <path> && git branch -D shipyard/wt-probe` from the repo root.
- Branch is `main` or doesn't start with `shipyard/wt-` → **fail**. The WorktreeCreate hook is not firing. Report in the readiness check:
  ```
  Worktree probe: FAIL — worktree created on [branch] instead of shipyard/wt-*
    The WorktreeCreate hook may not be registered or is failing silently.
    Builders would commit directly to your branch, bypassing rebase/review.
    Fix: check hook registration, or switch to solo mode for this sprint.
  ```
  Clean up the probe worktree. The user sees this during plan approval and can fix it or switch to solo mode before execution begins.

**WAVE 1** — what runs first:
- [task IDs + titles + effort]
- Execution: [sequential / parallel]
- Estimated: [token/time projections if available]

**BASELINE TESTS** — current test state before any changes:
- [pass/fail/not-run — from pre-flight or quick check]

**RISKS FROM PLANNING** (carried from SPRINT.md):
- [top 2-3 risks with mitigations]

**HOW TO PAUSE**: Type "pause" at any time to save progress and stop cleanly. If the session ends abruptly (crash, quota, closed terminal), run `/ship-execute` again — it will recover automatically and salvage any in-flight work.

**Exit plan mode** (`ExitPlanMode`) — triggers built-in approval flow:
- **Approve** → begin Wave 1 execution
- **Adjust** → user changes execution mode, reorders tasks, or fixes pre-conditions
- **Abort** → don't start, user fixes issues first

### Step 2: Execute Waves

For each wave (starting from current):

**ALWAYS delegate task execution to subagents.** Every task runs in a fresh context window — this keeps the orchestrator lean and prevents context degradation across waves. The mode determines parallelism, not whether subagents are used.

#### Solo Mode (1-3 tasks per wave)
Spawn subagents **sequentially** — one task at a time, same branch (no worktree isolation needed since tasks run one after another).

#### Subagent Mode (4-10 tasks per wave)
Spawn subagents **in parallel** — one per task, each in an isolated worktree.

#### Team Mode (10+ tasks)
Spawn persistent teammates per feature track using Agent Teams. Each teammate works through all tasks in its feature — more efficient than per-task subagents for features with 3+ tasks. **Max 4 concurrent teammates** — additional feature tracks are queued and spawned as earlier ones complete.
**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/team-mode.md`

#### Pre-spawn Branch Check (subagent AND team mode)

Before spawning any worktree agents, verify the orchestrator is on the expected working branch:
```bash
git branch --show-current
```
Read `branch` from SPRINT.md frontmatter.

**If on a `shipyard/wt-*` branch** → the orchestrator is running inside a leftover worktree or the user checked out a worktree branch in the main repo. This is dangerous — new worktrees would branch from the wrong commit. Fix: `git checkout <sprint working branch>` before proceeding. Report: "WARNING: Orchestrator was on worktree branch [name], switched to [working branch]."

**If branch doesn't match SPRINT.md** → `git checkout <branch>` before proceeding.

The WorktreeCreate hook branches worktrees from the current local branch. If the orchestrator is on the wrong branch, all worktrees will branch from the wrong place.

#### Subagent Prompt (solo + subagent modes)
```
For each task in the wave, spawn Agent with:
  subagent_type: shipyard:shipyard-builder
  isolation: worktree  (subagent mode) or omit (solo mode)
  prompt: |
    You are a Shipyard builder executing task [TASK_ID].

    Working branch: [branch from SPRINT.md frontmatter]

    **MANDATORY FIRST ACTION — before reading any files or writing any code:**
    ```bash
    git branch --show-current
    git log --oneline -3
    ```
    Check your branch:
    - If current branch starts with `shipyard/wt-` → you're in a worktree. STAY on this branch. Do NOT checkout the working branch.
    - If current branch matches the working branch → you're in solo mode. Correct.
    - If neither → HARD STOP. The worktree hook failed. Do NOT checkout the working branch — that bypasses rebase/review. Do NOT write any code. Report back: "WORKTREE BRANCH FAILURE — task not started. Actual branch: [name]".

    Read these files for context:
    - $(shipyard-data)/spec/tasks/[TASK_ID]-*.md (your task spec)
    - $(shipyard-data)/spec/features/[FEATURE_ID]-*.md (parent feature — read fully, then check its `references:` frontmatter array and read each listed path in `$(shipyard-data)/spec/references/`; these hold full API contracts, schemas, and protocol specs you must implement against)
    - $(shipyard-data)/codebase-context.md (codebase patterns)
    - .claude/rules/ (ALL project rules — not just shipyard-*. These contain architecture constraints, naming conventions, banned patterns you must follow)

    Read Technical Notes in task and feature files — they contain research
    findings (URLs, patterns, gotchas, confidence levels) from sprint planning.
    Follow them. If a URL is listed, WebFetch it for implementation details.
    If you hit an unknown not covered by the research, WebSearch it.

    Follow the test-driven development (TDD) cycle strictly:
    1. RED: Write failing tests matching acceptance scenarios. Run only those tests.
    2. GREEN: Write minimum code to pass. Run only your tests.
    3. REFACTOR: Clean up, your tests still pass.
    4. MUTATE: Flip a key line, verify your test catches it.
    5. VERIFY: Re-read acceptance scenarios from task spec. For each: confirm implementation genuinely satisfies it (not just tests pass). Check artifacts are connected (imports, routes, wiring). If any gap → fix before committing.
    6. COMMIT: feat([TASK_ID]): [description]

    **Test scoping:** Only run task-tier tests (unit + tests you wrote for this task).
    Never run integration tests or the full suite — those run at wave boundaries
    and sprint completion, not during individual task work. Scope by file path,
    pattern, or describe block.

    Rules: Never skip TDD (tests first, always). Never modify assertions to pass. Never build beyond what was asked for. Never run the full test suite — only tests for your task.
    If blocked: AskUserQuestion with the blocker details — do not guess.

    ## Inline Rules (path-scoped rules don't load in subagents — Claude Code bug #32906)

    **Execution rules:**
    - Read task spec first, understand acceptance criteria before writing code
    - Atomic commits per task — one commit, one task
    - Update task file status to `done` after committing
    - Never assume — if the spec is ambiguous, AskUserQuestion
    - Scope discipline: no scope creep, no gold-plating, no bonus features

    **TDD rules:**
    - Write failing tests BEFORE implementation (Red phase)
    - Never modify test assertions to make them pass — fix the implementation
    - Mutation testing after GREEN: flip a key conditional, verify test catches it
    - Only mock external dependencies — never mock internal modules
    - Every acceptance scenario in the spec maps to at least one test
    - Test naming: describe the behavior, not the implementation

    ## Before Exiting (MANDATORY — prevents data loss)

    Before returning results, ensure no uncommitted work exists:
    ```bash
    git status --porcelain
    ```
    If changes exist: `git add -A && git commit -m "wip([TASK_ID]): partial progress"`
    If commit fails: `git stash` as fallback.
    Claude Code deletes worktree directories when agents exit — uncommitted work is permanently lost.
```

#### Post-Subagent (all modes)
Spot-check each subagent before merging:
1. Verify key files exist (ls the implementation + test files)
2. Verify git commits present (git log --grep="TASK_ID" in worktree)
3. **Item completeness check**: if the task's Technical Notes lists discrete items (e.g., "migrate these 8 calls", "add these 5 endpoints"), grep the diff for each item. Count how many were actually addressed vs how many were listed. If <100% → flag as incomplete, don't merge, re-spawn builder with the missing items listed explicitly
4. If no commits or missing files → flag as failed, don't merge

Rebase and merge verified worktree branches back to the working branch (subagent/team mode).

### Step 3: Per-Task Execution (THE TDD CYCLE)

For every task, regardless of mode, follow the TDD cycle — write the test first, then the code to make it pass:

**Read the full cycle details:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/tdd-cycle.md`

Summary:
1. **READ SPEC** → understand what to build
2. **READ CODEBASE** → check existing patterns
3. **PLAN** → decide approach
4. **RED** → write a failing test (it should fail because the feature doesn't exist yet)
5. **GREEN** → write the minimum code to make the test pass
6. **REFACTOR** → clean up without changing behavior
7. **MUTATE** → deliberately break a key line to verify the test catches it
8. **VISUAL VERIFY** → for UI tasks, take screenshots
9. **COMMIT** → save the work

Key rules:
- Tests MUST be written before implementation (Red first)
- Tests MUST fail before implementation exists
- Mutation: flip a key line — at least one test must catch it
- Commit format: `feat(TASK_ID): [description]`
- Update task file status to `done` after each task (single source of truth for task status)
- Log session progress in PROGRESS.md (session notes, blockers, deviations — NOT task completion status)

### Step 4: Wave Boundary Check (between groups of tasks)

Between waves (each wave is a group of tasks that ran together):
- **Rebase and merge** task branches one at a time, sequentially (even though tasks ran in parallel):
  ```bash
  # For each completed worktree branch, IN ORDER:
  git rebase <working-branch> <task-branch>    # replay task commits onto current HEAD
  git checkout <working-branch>
  git merge --ff-only <task-branch>             # fast-forward (always works after rebase)
  git worktree remove <worktree-path>           # clean up worktree
  git branch -d <task-branch>                   # delete task branch
  # Now HEAD has moved forward — next rebase starts from here
  ```
  If rebase has conflicts → AskUserQuestion with conflict details. Do NOT fall back to regular merge — that creates fork lines in the git graph. Resolve conflicts or skip the task.
- After all branches merged, verify no stale worktree branches remain: `git worktree list` and `git branch --list shipyard/wt-*` — clean up any leftovers
- **Clean branch check** — run `git status --porcelain` on the orchestrator's branch. If there are uncommitted changes (modified, untracked, or staged files), something went wrong during the merge process. Commit any legitimate changes (e.g., PROGRESS.md, task file status updates) with `chore(shipyard): wave [N] state update`. If unexpected changes exist (source files that shouldn't have been modified by the orchestrator), AskUserQuestion: "Unexpected uncommitted changes found after Wave [N] merge: [file list]. These shouldn't be here — the orchestrator doesn't write source code. Commit as-is, stash, or investigate? (commit / stash / investigate). Recommended: investigate." **The orchestrator's branch must be clean before starting the next wave.**
- **Update PROGRESS.md** — set frontmatter `current_wave` to the next wave number. This is the orchestrator's checkpoint — if context is lost to auto-compaction, this field tells you where to resume.
- **Delegate INTEGRATION tests to a test subagent** — spawn an `Agent` with `subagent_type: shipyard:shipyard-test-runner` (no `isolation: worktree`) following the pattern in `references/test-delegation.md`. Pass it the `test_commands.integration` command from config (or scoped by sprint feature paths). Receive back a structured summary (PASS/FAIL/SKIP). Act on the summary — do NOT run tests directly in this session.
- **If integration tests FAIL** → do NOT fix code or lint errors directly. Spawn a `shipyard:shipyard-builder` subagent (no worktree) with the failure summary and this instruction: "Fix the failing tests. Read git.main_branch from $(shipyard-data)/config.md. Run `git diff $(git merge-base HEAD [main_branch])...HEAD --name-only` to identify in-scope files. Only fix errors in files that appear in that diff — pre-existing errors in files outside the diff are not your responsibility." After the builder returns, rerun integration tests (spawn test subagent again) to confirm fixes resolved the failures. If still failing → **create a bug file** at `$(shipyard-data)/spec/bugs/B-INT-[slug].md` with the failure details, test output, and attempted fix summary. Then escalate to user via AskUserQuestion with the failure details and bug ID. The bug file ensures the issue is tracked and surfaced in the next sprint planning.
- Verify all tasks in completed wave satisfy their acceptance criteria
- Check for gaps (acceptance scenario without implementation)
- If gaps found → create patch tasks, add to next wave
- If blockers → report and attempt swap-in
- Create worktrees for next wave from updated working branch HEAD
- **Report progress and continue immediately** — do NOT stop or ask the user. Output a prominent wave status banner that shows progress and projection:
  ```
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   WAVE [N] COMPLETE
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   Tasks:  [done]/[total wave] merged | [total done]/[total sprint] overall
   Tests:  integration [pass/fail] ([N] passed, [M] failed)
   Gaps:   [N found → patch tasks created | none]

   Progress: [████████░░░░░░░░] [X]% complete ([done]/[total] tasks)
   Waves:    [N]/[M] done — [remaining] waves left
   Velocity: ~[N] tasks/wave

   → Continuing to Wave [N+1] — [task count] tasks
   (type "pause" to save progress and stop)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ```

  Build the progress bar: `done_pct = (total_done / total_sprint) * 100`. Use `█` for filled, `░` for empty, 16 chars wide. Velocity is `total_done / waves_completed`. If velocity data suggests remaining waves will take more than the completed ones, note: "pace slowing" or "on track".

  **Auto-continue to the next wave without pausing.** The orchestrator stays lean (~10-15% context) by delegating to subagents. Do not suggest `/clear`, do not suggest re-invoking `/ship-execute`, do not ask "do you want to continue?" — just proceed to the next wave.

  **Context pressure detection:** At each wave boundary, check `$(shipyard-data)/.compaction-count`:
  ```bash
  cat $(shipyard-data)/.compaction-count 2>/dev/null
  ```
  - **count = 1** → note it, continue normally
  - **count = 2** → warn in wave report: "⚠ Context pressure building — will auto-pause after this wave if another compaction fires"
  - **count >= 3** → **auto-pause immediately.** Write HANDOFF.md, delete the compaction counter, and tell the user:
    ```
    ⚠ Auto-pausing — 3 compactions detected, session is running hot.
    Progress saved. Run: /clear then /ship-execute (resumes from Wave [N+1])
    ```
    This pre-empts quota exhaustion by pausing while there's still enough context to write a clean handoff.

  The compaction counter is tracked by the PostCompact hook and reset when execution starts (delete `.compaction-count` in the execution lock step).

### Compaction Recovery

If you're unsure which wave you're on or what's been completed (e.g., after auto-compaction cleared earlier context):

1. Read PROGRESS.md — `current_wave` in frontmatter tells you which wave to execute next
2. Read SPRINT.md — get the wave structure (which task IDs are in each wave)
3. For task IDs in waves ≤ `current_wave - 1`, read task files — confirm `status: done`
4. For task IDs in wave `current_wave`, read task files — check which are `done` vs remaining
5. Check git branch — `git branch --show-current` to confirm you're on the working branch (from SPRINT.md `branch` field). If not → `git checkout <branch>` before spawning any worktree agents.
6. Resume execution from the first non-done task in `current_wave`

This takes ~5 tool calls and recovers full state from files. Do not rely on conversation memory for wave/task state — files are the source of truth.

### Step 5: Sprint Completion (final check)

When all waves done:

**5a. Full test suite**
- **Delegate the full test suite to a test subagent** — spawn a single `Agent` with `subagent_type: shipyard:shipyard-test-runner` (no `isolation: worktree`) following the multi-tier pattern in `references/test-delegation.md`. Pass it `test_commands.unit`, `test_commands.integration`, and `test_commands.e2e` from config. It runs all three sequentially and returns a combined summary (one line per tier). This is the only time the entire suite runs. Act on the summary — do NOT run tests directly in this session.
- If regression failures: do NOT fix code or lint errors directly. Spawn a `shipyard:shipyard-builder` subagent (no worktree) with the failure summary and instructions to fix all failures. At sprint level the branch owns all errors — do not scope to the diff. Verify a new commit exists after it returns. Re-run the test subagent to confirm clean before proceeding.

**5b. Code review loop (sprint completion)**

A review-fix loop that runs entirely via subagents — the orchestrator only routes reports, never reads implementation files or fixes code itself.

**Iteration cycle:**

1. **Checkpoint** — Before any fixes, create a rollback point:
   ```bash
   git tag pre-code-review-$(date +%s)
   ```
   If the fixer crashes or leaves partial state, reset to this tag.

2. **Review** — Spawn `Agent` with `subagent_type: shipyard:shipyard-reviewer` (no worktree):

   First iteration:
   ```
   Run a code review on this sprint's changes.
   Mode: code review
   Diff command: git diff $(git merge-base HEAD [main_branch])...HEAD
   (substitute [main_branch] with git.main_branch from config)
   Read project conventions from: .claude/rules/ and $(shipyard-data)/codebase-context.md
   ```
   Subsequent iterations (cumulative delta — uses checkpoint tag from step 1):
   ```
   Run a code review on the fixes applied since sprint completion.
   Mode: code review
   Diff command: git diff pre-code-review-<tag>..HEAD
   Do NOT re-read project conventions — focus only on whether the previous findings were fixed correctly and whether the fixes introduced new issues.
   ```
   The reviewer runs three focused passes:
   - **Pass 1: Bugs, security & silent failures** — logic errors, injection risks, swallowed errors, empty catch blocks, missing error propagation
   - **Pass 2: Patterns, quality & duplication** — convention violations, copy-paste, dead code, naming
   - **Pass 3: Test coverage & resilience** — behavioral coverage of critical paths, edge cases, error paths

   Uses **confidence-based filtering** (0-100 scale, only reports ≥80). Returns a structured report as its response.

3. **Persist & evaluate** — The reviewer's response starts with `VERDICT:` and `COUNTS:` on the first two lines, followed by `---ACTIONABLE---` and findings. The orchestrator:
   - Writes the full response to `$(shipyard-data)/sprints/current/CODE-REVIEW.md` (one Write call)
   - Parses the VERDICT and COUNTS lines from the agent response. Note: the full reviewer response is in the orchestrator's context via the Agent tool return — the compact output format minimizes this cost but doesn't eliminate it. No additional Read call is needed.
   - Zero must-fix and zero should-fix → **clean pass**, proceed to 5c
   - Only consider items → **acceptable**, proceed to 5c
   - Must-fix or should-fix exist → log counts to PROGRESS.md immediately (compaction checkpoint), then check diminishing returns, then **spawn fixer**

   Append the current iteration's counts to the Code Review table in PROGRESS.md before proceeding. This persists the baseline for the diminishing returns check — if compaction fires between iterations, the prior count survives in PROGRESS.md.

4. **Diminishing returns check** — Skip on iteration 1 (no baseline exists). On iteration 2+, read the previous iteration's must-fix count from the PROGRESS.md Code Review table:
   - Count decreased → improvement, continue fixing
   - Count unchanged or increased → fixes are introducing new issues. AskUserQuestion immediately: "Code review isn't converging — [N] must-fix issues remain after [iteration] fix attempts. The fixes may be introducing new problems. Proceed to PR with current state, or investigate manually? (proceed / investigate)"

5. **Fix** — Spawn `Agent` with `subagent_type: shipyard:shipyard-builder` (no worktree — works on the working branch directly):
   ```
   Address code review findings.
   Read $(shipyard-data)/sprints/current/CODE-REVIEW.md — skip everything above ---ACTIONABLE---.
   Fix all M (must-fix) and S (should-fix) items listed below the separator.
   Each finding is one line: [file:line] — [category] — [description]. Fix: [suggestion].
   Follow TDD — update or add tests for any bug fixes.
   Commit fixes: refactor: address code review (iteration N)
   ```
   The fixer reads only the actionable section — no confidence scores, no consider items, no test coverage prose. Minimal input tokens.

   After fixer returns, verify a new commit exists (`git log -1 --format=%s` should contain "address code review"). If no commit → fixer crashed or stalled. **Reset to checkpoint**: `git reset --hard $(git tag --list 'pre-code-review-*' --sort=-creatordate | head -1)` (the tag from step 1). Flag iteration as failed, don't count toward cap.

6. **Repeat** — Go back to step 2 (review). Max 3 iterations.

**Exit conditions:**
- **Clean pass** — zero must-fix and zero should-fix → proceed to 5c
- **Only consider items remain** → proceed to 5c
- **Diminishing returns failed** — must-fix count didn't decrease → AskUserQuestion immediately (don't burn remaining iterations)
- **3 iterations reached** — For any remaining must-fix items, create bug files at `$(shipyard-data)/spec/bugs/B-CR-[slug].md` with the finding details from CODE-REVIEW.md (file, line, category, description). This ensures unresolved code review issues are tracked and surfaced in the next sprint. Then AskUserQuestion: "Code review ran 3 iterations: [summary per iteration]. [N] items remain — tracked as [bug IDs]. Proceed to PR anyway, or keep fixing? (proceed / fix specific items / fix all)"

**Cleanup:** After exiting the review loop (any exit condition), delete the checkpoint tag:
```bash
git tag --list 'pre-code-review-*' | xargs -I {} git tag -d {}
```

**Context cost to orchestrator:** ~3-4 tool calls per iteration (checkpoint, spawn reviewer, write report, spawn fixer). The reviewer's compact output format (VERDICT + COUNTS + one-line-per-finding) minimizes the tool return size, but the full response does land in the orchestrator's context. No source code file reads, no code edits, no test runs by the orchestrator itself. Keep the reviewer output concise — the fewer findings, the less context pressure per iteration.

Log each iteration in PROGRESS.md:
```
## Code Review
| Iteration | Must-fix | Should-fix | Consider | Action |
| 1         | 3        | 5          | 2        | Fixer addressed 8 findings |
| 2         | 0        | 1          | 2        | Fixer addressed 1 finding |
| 3         | 0        | 0          | 2        | Clean — proceeding |
```

**5c. Finalize**
- Update SPRINT.md frontmatter: `status: completed` and `completed_at: <current ISO 8601 timestamp>` (write both in the same edit)
- Features remain `in-progress` — only `/ship-review` transitions features to `done` after user approval
- Report:

```
Sprint complete. [N]/[M] tasks done. Full test suite: [pass/fail]. Code review: [N] issues fixed.

▶ NEXT UP: Review and wrap up the sprint
  /ship-review — verify work, retro, release, and archive
  (tip: /clear first for a fresh context window)
```

---

## SINGLE TASK Mode (--task)

Execute just one task following the TDD cycle above. Useful for:
- Picking up a specific blocked task after unblocking
- Re-executing a failed task
- Running a patch task

---

## HOTFIX Mode (--hotfix)

1. Read bug file (B-HOT-NNN)
2. Verify the user is on the branch they want the hotfix applied to (AskUserQuestion if unclear)
3. Execute TDD cycle (must include regression test)
4. Commit: `fix(B-HOT-NNN): [description]`
5. Report: "Hotfix ready. Review with /ship-review --hotfix B-HOT-NNN"

Shipyard does not create branches, merge, or push for hotfixes — the user handles their own git workflow. Hotfix does NOT affect sprint state or velocity.

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

If the same file is edited 5+ times without a commit:
- Pause and reassess approach
- Re-read the spec
- Consider simplifying
- If stuck after 7+ iterations → **escalate to debug mode**: create a debug session file (`$(shipyard-data)/debug/[task-id].md`) with the symptoms, what was tried, and what was eliminated. Then AskUserQuestion:

  "Builder is stuck on [task] after [N] attempts. I've started a debug session to investigate systematically.

  1. Debug now — investigate with /ship-debug --resume
  2. Skip task — move to next unblocked task, come back later
  3. Ask for help — describe the problem so I can assist

  Recommended: 1 — systematic investigation beats repeated attempts"

This also applies when the orchestrator spawns a builder to fix integration test failures or code review findings and the fix doesn't work after 2 attempts — escalate to debug instead of spawning another builder.

## Pause / Resume

Claude Code's `--continue` restores conversation history, but it doesn't know project-level state (which wave, which task, what was happening). Shipyard bridges this gap with a handoff file.

### On Pause (user says "pause", "stop", "break", or session is ending)

Write `$(shipyard-data)/sprints/current/HANDOFF.md`:
```markdown
---
paused_at: [ISO timestamp]
wave: [current wave number]
task: [current task ID or "between tasks"]
mode: [solo|subagent|team]
branch: [current git branch]
team_name: sprint-NNN        # (team mode only)
teammates: [teammate-F001, teammate-F005]  # (team mode only) active teammates at pause
queued_tracks: [F003, F007]  # (team mode only) feature tracks waiting to be spawned
---
# Execution Handoff

## Completed This Session
- [list of tasks completed]

## In Progress
- [task ID]: [what was being done, what's left]

## Blocked
- [any blocked tasks with reasons]

## Next Steps
1. [exact next action to take]
2. [then what]

## Decisions Made
- [any decisions during this session that affect future work]
```

### On Resume

When `/ship-execute` runs and `$(shipyard-data)/sprints/current/HANDOFF.md` exists:

**Note:** Step 0 (worktree salvage) has already run before reaching this point. All leftover worktrees have been salvaged and merged onto the working branch. New worktrees will branch from this consolidated state.

1. Read HANDOFF.md — know exactly where we left off
2. **Accumulate paused time:** If HANDOFF.md frontmatter has a `paused_at` value (non-null), compute `paused_minutes = round((now - paused_at) / 60)` where `now` is the current time and `paused_at` is the ISO 8601 timestamp from HANDOFF.md. Add `paused_minutes` to `total_paused_minutes` in SPRINT.md frontmatter (if `total_paused_minutes` is absent or null, treat it as 0 before adding). Then clear `paused_at` from HANDOFF.md (set it to null).
3. Read PROGRESS.md — verify completed tasks match
4. Check git branch — ensure we're on the right branch
5. If team mode: `TeamCreate(team_name)` (previous session's team is gone). Create new worktrees from the working branch HEAD (which now includes all salvaged work from Step 0). Re-spawn teammates using the session resume prompt from team-mode.md. Use `teammates` field from HANDOFF.md for which feature tracks need re-spawning (max 4 concurrent — restore the queue from `queued_tracks` field). Previous teammate sessions are always dead after a session break — always re-spawn.
6. Delete HANDOFF.md (it's consumed)
7. Continue from the next step documented in handoff

This works alongside `claude --continue` — the session history gives conversation context, HANDOFF.md gives project state context.

## Deviation Rules

When execution diverges from the plan, apply these rules to decide whether to auto-fix or ask the user:

| Category | Examples | Action |
|----------|----------|--------|
| **Bug** | Broken behavior, runtime error, security vulnerability | Delegate to builder subagent, note in PROGRESS.md |
| **Missing Critical** | Missing error handling, validation, auth check, cross-origin policy | Delegate to builder subagent, note in PROGRESS.md |
| **Blocker** | Missing dependency, broken import, missing env var | Delegate to builder subagent, note in PROGRESS.md |
| **Structural** | New database table, new service, different design pattern | AskUserQuestion before proceeding |

The key distinction: if the fix is obvious and contained (a bug, a missing null check, a lint error), spawn a `shipyard:shipyard-builder` subagent to fix it. If the fix changes the shape of the system (new table, different API design), the user needs to decide.

**The orchestrator never writes, edits, or fixes code directly — not for bugs, not for test failures, not for lint errors.** Always spawn a builder subagent.

When auto-fixing, log in PROGRESS.md:
```
## Deviations
| Task | Type | What Changed | Why |
| T002 | Bug | Added null check in service.ts | Runtime error on empty input |
| T003 | Missing Critical | Added rate limit to API route | No rate limiting existed |
```

## Rules

- NEVER skip TDD. No exceptions.
- NEVER modify test assertions to pass. Fix the implementation.
- NEVER build beyond acceptance criteria.
- ALWAYS commit atomically per task.
- ALWAYS update task file status to `done` after completing each task.
- Log session activity in PROGRESS.md (blockers, deviations, session notes).
- NEVER fix test failures, lint errors, or code bugs directly in this session. Always spawn a `shipyard:shipyard-builder` subagent to fix them.
- Delegate bugs, missing criticals, and blockers to a builder subagent. Ask for architectural changes.
- If in doubt → AskUserQuestion.
