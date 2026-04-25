---
name: ship-execute
description: "Execute the current sprint by running tasks in waves with strict test-driven development (write tests first, then code). Supports solo, subagent, and team execution modes. Use when the user wants to start building, execute sprint tasks, run a specific task, apply a hotfix, or resume execution after a break."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, Agent, AskUserQuestion, TeamCreate, TeamDelete, TaskCreate, TaskUpdate, TaskGet, TaskList, SendMessage]
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

**Paths.** All Shipyard file ops use the absolute SHIPYARD_DATA prefix from the context block (no `~`, `$HOME`, or shell variables). Bash is for project test commands, git, and `shipyard-data with-lock sprint -- <cmd>` only — never for reading or writing Shipyard state. **Never use `echo`, `printf`, or shell redirects (`>`) to write state files** — use the Write tool, which is auto-approved for SHIPYARD_DATA and avoids permission prompts. A PreToolUse hook will block Bash redirects to SHIPYARD_DATA paths. When passing paths into spawned Agent prompts, substitute the literal SHIPYARD_DATA path.

## Input

$ARGUMENTS

## Session Guard Cleanup

**First action — planning-session mutex check:** Use the Read tool on `<SHIPYARD_DATA>/.active-session.json` (substitute the literal SHIPYARD_DATA path from the context block above). Then decide:

- **File does not exist** → no planning session active. Skip to "Execution Lock" below.
- **File exists.** Parse the JSON and check:
  1. If `cleared` is set OR `skill` is `null` → previous planning session ended cleanly. Use the Write tool to overwrite the file with `{"skill": null, "cleared": "<iso-timestamp>"}` (idempotent — keeps the soft-delete sentinel). Skip to "Execution Lock" below.
  2. If `started` is more than 2 hours old → stale lock from a crashed planning session. Print "(recovered stale planning lock from `/{previous skill}` started {N}h ago)" to the user, use Write to overwrite with the cleared sentinel, then proceed.
  3. Otherwise → **HARD BLOCK.** A planning session is active and execution cannot start until it ends:
  ```
  ⛔ Planning session active — cannot start execution.
    Skill:   /{skill from file}
    Topic:   {topic from file}
    Started: {started from file}

  Finish or pause the planning session first, then run /ship-execute.
  If the planning session crashed or was closed:
    Run /ship-status — it will offer to clear the stale lock.
  ```
  Print this message as the entire response and STOP — do not load any context, do not call any other tools.

This prevents the failure mode where a discussion is in progress in one terminal and execution gets started in another, which would trip the session-guard hook on every Edit.

## Execution Lock

**Before starting work**, check for concurrent execution:

1. Use the Read tool to read `<SHIPYARD_DATA>/.active-execution.json` (substitute SHIPYARD_DATA from the context block). Parse the JSON. If `cleared` is not set AND `started` is less than 2 hours ago:
   ```
   ⛔ BLOCKED: Another execution session is active.
     Skill: [skill name]
     Started: [timestamp]

   Concurrent execution causes git conflicts, duplicate commits, and corrupted state.
   Use the existing session, or /clear then /ship-execute to resume there.
   If the other session crashed or was closed: /ship-status (will ask to clear the lock)
   ```
   **Hard block — do not proceed. Do not offer an override.** Stop immediately.

2. If no lock exists, the lock has `cleared` set, or the lock is stale (>2 hours) → use the Write tool to overwrite `<SHIPYARD_DATA>/.active-execution.json` with:
   ```json
   {
     "skill": "ship-execute",
     "sprint": "[sprint ID]",
     "wave": "[current wave]",
     "started": "[ISO date]",
     "tracks_compaction_pressure": true,
     "compaction_count": 0
   }
   ```
   The `tracks_compaction_pressure` flag opts this lock into the context-pressure counter managed by the PostCompact hook. The counter lives on the lock object itself — when the lock is cleared, the counter dies with it, so there is no separate reset step and no cross-skill leakage. See `references/context-pressure.md` for the full contract.

3. **On sprint completion or pause** (HANDOFF.md written), use the Write tool to overwrite `<SHIPYARD_DATA>/.active-execution.json` with `{"skill": null, "cleared": "<iso-timestamp>"}`. (Soft-delete sentinel — session-guard treats `skill: null` as inactive, and because the counter was a field on the old lock object it vanishes with the overwrite.)

## Detect Mode

- `--task T001` → Execute single task only
- `--hotfix B-HOT-001` → Hotfix mode (branch from main, bypass sprint)
- `--mode solo|subagent|team` → Override execution mode
- `--fast` → Fast mode: sets `Fast mode: yes` in builder prompts when `--fast` is used; builders write tests but skip all test execution (deferred to wave boundary). REFACTOR loop and wave-scoped tests are skipped.
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

## Operating Principles

- **LSP first.** Use LSP (`documentSymbol`, `goToDefinition`, `findReferences`, `hover`) before Grep/Read for all code navigation. Fall back silently if LSP is unavailable. Pass this to builder subagents. Full strategy: `references/lsp-strategy.md`.
- **Stay lean as orchestrator** (~10-15% context). Pass file paths to subagents, not contents. State lives in PROGRESS.md / HANDOFF.md, not conversation. Spot-check results before trusting them. Full guide: `references/context-management.md`.
- **Git strategy.** Work on the user's current branch — no sprint branches, no pushes. Solo commits directly; subagent/team mode uses per-task or per-feature worktrees that rebase back at wave/feature end. Worktrees branch from current local HEAD. Atomic commits per task. Full strategy: `references/git-strategy.md`.
- **Live capture.** Wrap verification commands you'll want to re-inspect with `shipyard-logcap run <name> --max-size <S> --max-files <N> -- <command>` — tees output to a rotating temp file. Skip when the command already file-backs its output. Decision table for bounds: `references/live-capture.md`.
- **Communication.** Blocker reports and decisions use the 3-layer pattern (one-liner / context / options); keep under 100 words; always recommend a default. Full guide: `references/communication-design.md`.

## FULL SPRINT Execution

**CRITICAL: Execute the ENTIRE sprint to completion.** Do not pause between waves to ask the user if they want to continue. Do not suggest re-invoking `/ship-execute`. Do not suggest `/clear` between waves. Execute wave after wave until all tasks are done, then report sprint completion. The only reasons to stop mid-sprint are: (1) an unresolvable blocker requiring user input (AskUserQuestion), (2) a structural deviation requiring user decision (Rule 4), or (3) the user explicitly says "pause" or "stop".

### Step 0: Worktree Salvage (always runs first)

**Before anything else**, check for leftover worktrees from a previous session. This applies to ALL modes (solo, subagent, team) — any mode can leave behind worktrees with uncommitted work after a crash, quota exhaustion, or killed session.

**First, prune stale git worktree metadata** — if the user manually deleted a worktree directory (e.g., `rm -rf`), git's internal `.git/worktrees/<name>/` administrative dir lingers, and the next `git worktree add` for that name fails with "already exists". This is two lines to defend against and free:

```bash
git worktree prune
```

`git worktree prune` is a portable git subcommand and works identically on macOS, Linux, and Windows. It only removes administrative metadata for worktree directories that no longer exist on disk — it never touches your actual worktrees, your branches, or your commits.

Then list current worktrees:

```bash
git worktree list
```

If the listing shows no `shipyard/wt-*` paths, **skip to Step 1**. Otherwise, salvage each one as described below.

**Check for stale heartbeat files** before salvaging worktrees. Read all files in `<SHIPYARD_DATA>/agents/`. For each `.heartbeat` file found, parse and report:
```
Stale heartbeats from crashed session:
  T003: last activity Edit on src/auth.ts at 2026-04-14T10:23:00+00:00
  T004: last activity Bash at 2026-04-14T10:24:12+00:00
```
This tells you what the crashed agents were doing when the session died — useful context for understanding whether salvaged work is complete or mid-edit. Delete all heartbeat files after reporting.

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

### Step 1.5: Execution Readiness Check (first wave only)

On a fresh sprint start (case 3 above — no tasks done yet), present a readiness check before writing any code. Skip this step on resume and crash recovery (cases 1 and 2).

Output the readiness check as text:

**READINESS CHECK**
- Branch: `[current branch]` — [matches SPRINT.md / mismatch warning / ⚠️ ON WORKTREE BRANCH]
- Uncommitted changes: [none / list of changed files]
- Execution mode: [solo / subagent / team]
- Worktree probe: [pass / fail / skipped (solo mode)]
- Total: [N] tasks across [M] waves
- Teammates: [N feature tracks, M concurrent (max `max_parallel_agents`), K queued] (team mode only)

If current branch starts with `shipyard/wt-`, add a prominent warning:
```
⚠️  WORKTREE BRANCH DETECTED: You are on [branch name], not the working branch.
    This is likely a leftover from a previous session. Shipyard will switch to [working branch] before spawning agents.
    If this is intentional, confirm to proceed.
```

**Worktree probe** (subagent/team mode only — skip for solo):

Before asking the user, verify worktree creation works end-to-end. This catches hook failures while user interaction is expected, instead of mid-execution when it would block autonomous flow.

Spawn a minimal Agent with `isolation: worktree` and prompt: "Run `git branch --show-current` and report the branch name. Do nothing else."

Check the result:
- Branch starts with `shipyard/wt-` → **pass**. Clean up: `git worktree remove <path> && git branch -D shipyard/wt-probe` from the repo root.
- Branch is `main` or doesn't start with `shipyard/wt-` → **fail**. The `isolation: worktree` mechanism is broken (Claude Code bug — the platform sometimes silently ignores the isolation flag). Report in the readiness check:
  ```
  Worktree probe: FAIL — worktree created on [branch] instead of shipyard/wt-*
    Claude Code's isolation: worktree is not working. Falling back to manual worktree creation.
    Subagent mode will still run with full isolation — worktrees are created via git CLI instead.
  ```
  Clean up the probe worktree. **Set `manual_worktrees = true` for the rest of this sprint.** This flag changes how subagent mode spawns agents — see "Subagent Mode" below.

**WAVE 1** — what runs first:
- [task IDs + titles + effort]
- Execution: [sequential / parallel]
- Estimated: [token/time projections if available]

**BASELINE TESTS** — current test state before any changes:
- [pass/fail/not-run — from pre-flight or quick check]

**RISKS FROM PLANNING** (carried from SPRINT.md):
- [top 2-3 risks with mitigations]

**HOW TO PAUSE**: Type "pause" at any time to save progress and stop cleanly. If the session ends abruptly (crash, quota, closed terminal), run `/ship-execute` again — it will recover automatically and salvage any in-flight work.

Then use `AskUserQuestion` with options (2-4 options, use multi-select where choices aren't mutually exclusive):
- **Begin execution (Recommended)** — start Wave 1
- **Adjust** — change execution mode, reorder tasks, or fix pre-conditions
- **Abort** — don't start, fix issues first

### Step 2: Execute Waves

**Capture session tag (per wave).** Before spawning builders for a wave, use the Write tool to create/overwrite `<SHIPYARD_DATA>/.active-logcap-session` with a single line containing `<sprint-id>-wave-<N>` (e.g., `sprint-007-wave-2`). This is the file that `shipyard-logcap` reads to decide which session directory new captures land in — writing it here means every logcap invocation from any skill, subagent, or hook during this wave automatically groups into one folder without needing an env var.

**Why the file and not an env var:** each Bash tool call in Claude Code spawns a fresh shell, so shell-level exports of the session variable do NOT propagate to the next invocation or to subagents. The file sentinel at `<SHIPYARD_DATA>/.active-logcap-session` is the only mechanism that works cross-process, cross-subagent, and cross-hook. `shipyard-logcap` reads it internally (resolution order: env var → file → per-day fallback) so neither you nor the builder needs to know about it after this single write.

**Clearing the session** is optional — if you don't overwrite the file at wave boundaries, the next wave will inherit the prior wave's session name until a new write lands. Best practice: overwrite at the start of every wave with the new `<sprint-id>-wave-<N+1>` value so `shipyard-logcap list` shows a clean wave-by-wave layout. At sprint completion, overwrite with `<sprint-id>-complete` so any post-sprint verification (ship-review runs) lands in its own folder.

For each wave (starting from current):

**ALWAYS delegate task execution to subagents.** Every task runs in a fresh context window — this keeps the orchestrator lean and prevents context degradation across waves. The mode determines parallelism, not whether subagents are used.

#### Solo Mode (1-3 tasks per wave)
Spawn subagents **sequentially** — one task at a time, same branch (no worktree isolation needed since tasks run one after another).

#### Subagent Mode (4-10 tasks per wave)
Spawn subagents **in parallel** — up to `execution.max_parallel_agents` from config at a time (default 3, hard ceiling 4). If a wave has more tasks than the cap, **batch them**: spawn the first N, wait for all N to return and run post-subagent checks, then spawn the next batch from the updated HEAD. This prevents the quality degradation observed when 6-7 agents run simultaneously (Sprint 001/002 anti-pattern: agents hit context limits or return early without committing).

**If `manual_worktrees = true`** (probe failed — `isolation: worktree` is broken):

Create worktrees manually before spawning, same pattern as team-mode (bug #37549 workaround). Serialize creation to avoid git lock contention:
```bash
# For each task in the wave, create a worktree from the working branch:
CURRENT_SHA=$(git rev-parse HEAD)
git worktree add -b shipyard/wt-TASK_ID .claude/worktrees/TASK_ID "$CURRENT_SHA"
```
Then spawn agents **without** `isolation: worktree` and pass the worktree path in the prompt. See the modified subagent prompt below.

#### Team Mode (10+ tasks)
Spawn persistent teammates per feature track using Agent Teams. Each teammate works through all tasks in its feature — more efficient than per-task subagents for features with 3+ tasks. **Max `execution.max_parallel_agents` concurrent teammates** (default 3, hard ceiling 4) — additional feature tracks are queued and spawned as earlier ones complete.
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

#### Task Kind Routing (REQUIRED before every dispatch)

Before spawning any agent for a task, read the task file frontmatter and check `kind:`. The dispatch path depends on the kind — getting this wrong is how the silent-pass bug happens.

- **`kind: feature`** or **absent** → standard `shipyard-builder` dispatch below (this is the path the rest of this section documents).
- **`kind: operational`** → **DO NOT spawn the builder.** Follow the full protocol in `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/operational-tasks.md`. That file defines how to resolve `verify_command`, dispatch `shipyard-test-runner` via `shipyard-logcap`, run the fix-findings loop, and gate "done" on captured output. The post-subagent gate at the end of this step also has an operational-specific branch — see Step 2 Post-Subagent below.
- **`kind: research`** → **DO NOT spawn the builder.** Follow the full protocol in `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/research-tasks.md`. Research tasks dispatch to `shipyard-researcher` in task-driven mode (the agent has `Write` scoped to `<SHIPYARD_DATA>/research/` for exactly this purpose). The dispatcher gates done on a populated `research_output:` field pointing at a non-empty findings doc with at least one `### Finding` section. Post-subagent gate for research tasks is Step 2 "Post-Subagent" steps 9–11 below.

**Why this matters.** The silent-pass failure mode — `/ship-execute` marking "run E2E suite and fix findings" tasks done without running any tests — is the exact bug introduced when operational tasks hit the builder. The builder has no Red step for an operational task, exits clean on an empty tree, and the "Before Exiting" check passes trivially. This routing split is the primary fix. The `shipyard-builder` agent ALSO has a Step 0 HARD STOP that refuses any task with `kind: operational` — but that's defense in depth. The first line of defense is this router.

**Note — builders may write IDEA files during task execution.** As part of their process (step 10, CAPTURE DEFERRED UNKNOWNS), builders are allowed to write up to 3 `IDEA-*` files to `<SHIPYARD_DATA>/spec/ideas/` for deferred unknowns and scope-adjacent rot discovered while building. These are staged and committed atomically with the task's implementation, so they survive (or roll back) with it. IDEAs written during execution surface in `/ship-sprint`'s carry-over scan and `/ship-backlog`'s IDEAS section on subsequent planning cycles — this is the idea-capture chain that prevents observations from vanishing at session end. See `agents/shipyard-builder.md` → "Capture Deferred Unknowns" for the rules, caps, and frontmatter template.

#### Subagent Prompt (solo + subagent modes — kind: feature only)

The `shipyard-builder` agent body is the canonical contract — branch verification, TDD cycle, Rules section, Deviation Rules, When Blocked, and Before Exiting are all defined there. The orchestrator only passes task-specific dispatch info; the agent body carries the rest.

```
For each task in the wave, spawn Agent with:
  name: "builder-[TASK_ID]"
  subagent_type: shipyard:shipyard-builder
  isolation: worktree  (subagent mode, probe passed) or omit (solo mode or manual_worktrees)
  prompt: |
    Mode: task
    Task: [TASK_ID]
    Working branch: [branch from SPRINT.md frontmatter]
    Data dir: [literal SHIPYARD_DATA path from context block]

    Reading list:
    - [SHIPYARD_DATA]/spec/tasks/[TASK_ID]-*.md (your task spec)
    - [SHIPYARD_DATA]/spec/features/[FEATURE_ID]-*.md (parent feature; also read each path listed in its `references:` frontmatter)
    - [SHIPYARD_DATA]/codebase-context.md
    - .claude/rules/*.md (ALL project rules, not just shipyard-*)

    Read Technical Notes in task and feature files first — they contain research findings (URLs, patterns, gotchas) from sprint planning. WebFetch listed URLs for details. WebSearch unknowns.

    Fast mode: [yes if --fast was passed, else no]

    Your job: write tests (RED) + write implementation (GREEN) + commit. In normal mode: run logcap at RED and GREEN phases. In fast mode: skip test execution. REFACTOR, MUTATE, and VERIFY run at the wave boundary.

    COMMIT REQUIRED: You MUST `git add -A && git commit` before returning.
    A SubagentStop hook will block your exit if uncommitted changes exist.
    Include your commit hash in your final message.

    Everything else — branch verification, TDD cycle, rules, exit protocol — follows your agent body. Do not deviate.
```

**If `manual_worktrees = true`**, add `Worktree path:` to the prompt header (the builder agent keys off this field to enter manual worktree mode — see its "Startup: Branch Verification" section):
```
    Task: [TASK_ID]
    Working branch: [branch from SPRINT.md frontmatter]
    Worktree path: [absolute path to .claude/worktrees/TASK_ID]
    Data dir: [literal SHIPYARD_DATA path from context block]
```

#### Post-Subagent (all modes)
Spot-check each subagent before merging. The check differs by task kind — read the task file's `kind:` field first.

**For `kind: feature` tasks:**
1. Verify key files exist (ls the implementation + test files)
2. Verify git commits present (`git log --grep="TASK_ID"` in worktree)
3. **Item completeness check**: if the task's Technical Notes lists discrete items (e.g., "migrate these 8 calls", "add these 5 endpoints"), grep the diff for each item. Count how many were actually addressed vs how many were listed. If <100% → flag as incomplete, don't merge, re-spawn builder with the missing items listed explicitly
4. **If no commits found — salvage and re-dispatch** (do NOT just flag as failed):
   a. Check worktree for uncommitted changes: `git -C <worktree> status --porcelain`
   b. **If dirty tree** (uncommitted work exists):
      - Salvage with two sequential Bash calls (not `&&` — portability):
        ```
        git -C <worktree> add -A
        ```
        ```
        git -C <worktree> commit -m "wip(TASK_ID): salvaged by orchestrator"
        ```
      - Emit event: `builder_salvaged` with `task=TASK_ID`
      - Re-dispatch a NEW builder subagent into the SAME worktree:
        ```
        Agent(subagent_type: shipyard:shipyard-builder, prompt: |
          Task: [TASK_ID]  (CONTINUATION — previous builder exited early)
          Working branch: [branch from SPRINT.md]
          Worktree path: [absolute path to existing worktree]
          Data dir: [SHIPYARD_DATA]

          A previous builder started this task but exited without completing.
          Their partial work has been salvaged as a WIP commit on this branch.
          Review what was done (git log, git diff HEAD~1), identify what
          remains, complete the work, run tests, and commit properly.

          COMMIT REQUIRED before returning.)
        ```
      - **Max 1 re-dispatch per task** (track in a local set). If the continuation
        builder also fails → update task `status: needs-attention`, emit
        `builder_redispatch_failed` event, log to PROGRESS.md deviations table,
        and continue to next task. Do NOT AskUserQuestion mid-wave — that blocks
        the entire wave. The `needs-attention` status surfaces in `/ship-status`
        and the next `/ship-sprint` carry-over scan.
   c. **If clean tree** (no commits AND no uncommitted work):
      - The builder did nothing. Update task `status: approved` (reset to
        pre-dispatch state) so it gets picked up by the next sprint or re-run.
      - Emit event: `builder_no_work` with `task=TASK_ID`
      - Clean up the empty worktree.
      - Log deviation in PROGRESS.md.
5. **If commits found but key files missing** (partial implementation):
   - Same re-dispatch flow as 4b, but skip the salvage step (work is already
     committed). Prompt the continuation builder with the specific missing
     files from the spot-check.

6. **Task completion verification** (task-level spec check) — spawn `shipyard-review-spec` for this single task to catch obvious acceptance-scenario gaps before the wave-level VERIFY. Skip for tasks with effort: S (trivial tasks don't warrant the overhead). Max 3 iterations: if gaps found, re-dispatch the builder with the specific gap list; if gaps persist after the cap, log as `needs-attention` and proceed to merge.

7. **Merge** — once mechanical checks pass (commits, files, item completeness, spec check), proceed to merge the worktree branch onto the working branch. Full wave-wide acceptance-scenario verification happens in the VERIFY pass (Step 4). Merging early lets the wave-level REFACTOR+MUTATE+VERIFY builder see all tasks together.

**For `kind: operational` tasks:**
5. Verify the task file now has a non-empty `verify_output:` field. If missing or empty → emit `operational_task_bogus_pass` with `reason=missing_verify_output` and do NOT mark done.
6. Verify the capture exists and is non-empty. Using the name from `verify_output:`, resolve its path via `shipyard-logcap path <name>` and check byte count (for example, via `shipyard-logcap tail <name> | wc -c`). If the file is missing or zero-byte → emit `operational_task_bogus_pass` with `reason=empty_capture` or `capture_file_missing` and do NOT mark done.
7. Verify the final `verify_history` entry on the task file has `exit: 0`. If the last attempt exited non-zero, the task is not done regardless of what the dispatcher wrote — emit `operational_task_bogus_pass` with `reason=final_history_not_green`.
8. A task that fails any of 5–7 is re-dispatched through the operational loop (if under iteration budget) or escalated (Step 5 of `references/operational-tasks.md`).

**For `kind: research` tasks:**
9. Verify the task file now has a non-empty `research_output:` field. If missing or empty → emit `research_task_bogus_pass` with `reason=missing_research_output` and do NOT mark done.
10. Resolve the path: either literal absolute path, or relative-to-research-dir (join `<SHIPYARD_DATA>/research/` + value). Use `Read` to confirm the file exists and is not empty. Missing → `research_task_bogus_pass` with `reason=output_file_missing`. Empty or nearly empty (no substantive body) → `reason=empty_findings_doc`.
11. Verify the doc has at least one `### Finding` section (use Grep with pattern `^### Finding`). Zero matches → `research_task_bogus_pass` with `reason=no_findings_reported`. The Findings Doc Template requires at least one numbered finding; a zero-finding doc is a stub and does not satisfy the task.
12. **Write-scope enforcement.** The researcher has the `Write` tool but is contractually scoped to the single findings doc at the dispatch path. Run the porcelain check: working tree must be byte-identical to the pre-dispatch snapshot, and `<SHIPYARD_DATA>/research/` must differ by exactly one file (the expected findings doc). Any other write → emit `research_out_of_scope_write` with the list of unexpectedly modified files and escalate directly (do NOT retry — retrying produces another out-of-scope write). The full protocol is in `references/research-tasks.md` Post-Subagent gate check #5.
13. A task that fails 9–11 is re-dispatched through the research protocol (Step 3 failure path of `references/research-tasks.md`, single retry allowed only for transient failures) or escalated (Step 4 of that file). A task that fails 12 is escalated without retry.

**This is the last line of defense** against silent-pass regression across all three kinds. Even if the router drifts, the builder guard drifts, and the operational/research dispatchers drift, these checks catch the exact failure modes: operational tasks marked done without captured command output, research tasks marked done without a substantive findings doc.

**Heartbeat check (subagent and team modes only)** — after the kind-specific checks above, read the agent's heartbeat file at `<SHIPYARD_DATA>/agents/<TASK_ID>.heartbeat` (or `<FEATURE_ID>.heartbeat` in team mode). **Skip in solo mode** — solo agents run without worktree isolation, so no heartbeat file is written (the hook infers agent identity from the worktree CWD path).
- **File exists:** parse the `ts` and `tool` fields.
  - If the last heartbeat was >5 minutes before the agent returned → log warning to PROGRESS.md deviations: "Agent <TASK_ID> was idle for N minutes before returning (last tool: `<tool>` on `<target>`)"
  - If re-dispatching a fixer, pass heartbeat context in the prompt: "Previous builder's last activity was `<tool>` on `<target>` at `<ts>` — it may have been stuck there."
- **No file** → the agent may have failed before making any tool call (API error on first turn, hook failure, etc.). Proceed to the existing salvage flow — the absence itself is diagnostic.
- **Delete the heartbeat file** after processing (prevents stale data from confusing the next wave).

Rebase and merge verified worktree branches back to the working branch (subagent/team mode — feature tasks only; operational tasks run on the working branch without worktrees).

### Step 3: Per-Task Execution (RED → GREEN)

Each task is a small, focused unit of work: **write tests → write implementation → commit**. In fast mode (`--fast`), builders write tests but skip all test execution — tests are deferred to the wave boundary. In normal mode, builders run logcap captures at RED (`<TASK_ID>-red`) and GREEN (`<TASK_ID>-green`) phases. REFACTOR, MUTATE, and VERIFY all happen in Step 4.

**Read the full cycle details:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/tdd-cycle.md`

Per-task summary:
1. **READ SPEC** → understand what to build
2. **READ CODEBASE** → check existing patterns
3. **PLAN** → decide approach
4. **RED** → write tests that would fail; run via logcap (normal mode) or skip run (fast mode)
5. **GREEN** → implement; run tests via logcap (normal mode) or skip run (fast mode)
6. **COMPLETENESS CHECK** → if Technical Notes lists discrete items, grep to confirm every one was addressed
7. **COMMIT** → `feat(TASK_ID): [description]`, update task status to `done`

Key rules:
- Tests MUST be written before implementation
- Fast mode defers test execution; normal mode runs tests at task level via logcap
- Commit format: `feat(TASK_ID): [description]`
- Update task file status to `done` after each task
- Log session progress in PROGRESS.md (blockers, deviations — NOT task completion status)

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
- **Clean branch check** — run `git status --porcelain` on the orchestrator's branch. The orchestrator's branch must be clean before starting the next wave. Legitimate changes (PROGRESS.md, task status updates) → commit as `chore(shipyard): wave [N] state update`. Unexpected changes (source files) → AskUserQuestion: "Unexpected uncommitted changes after Wave [N] merge: [file list]. Commit as-is, stash, or investigate? Recommended: investigate."
- **Update PROGRESS.md** — set frontmatter `current_wave` to the next wave number. This is the resume checkpoint after auto-compaction. If a write could race with another writer (recovery flows, parallel review fixers), wrap it in `shipyard-data with-lock sprint -- <command>`.
- **Delegate WAVE-SCOPED build to a test subagent** — if `build_commands.scoped` is configured, run a scoped build for the modules touched by this wave's tasks before running tests. If `build_commands.scoped` is not configured but `build_commands.full` is, run the full build (some projects don't support scoped builds). If neither is configured, skip — the project either doesn't need a build step or tests handle compilation implicitly.
  ```
  Build wave [N] modules.
  Command: shipyard-logcap run wave-[N]-build -- <BUILD_SCOPED_COMMAND> [module paths]
  Return: PASS or FAIL with first error.
  ```
  If the scoped build fails → do NOT proceed. Spawn a `shipyard:shipyard-builder` subagent to fix build errors first.
- **Wave REFACTOR + MUTATE** — spawn a single `shipyard-builder` in wave-refactor mode. This is the first time tests run this wave — the builder sees ALL tasks' combined code, runs the REFACTOR pass (cross-task deduplication, naming, helpers), and runs the MUTATE pass (verify tests catch key mutations):
  ```
  Agent(subagent_type: shipyard:shipyard-builder,
        prompt: |
    Mode: wave-refactor
    Wave: [N]
    Working branch: [branch from SPRINT.md]
    Wave files: [combined list of source + test files from ALL wave tasks' Technical Notes]
    Data dir: [literal SHIPYARD_DATA path]

    COMMIT REQUIRED if any changes were made. Include commit hash in your reply.
  )
  ```
  Collect the wave files by reading each task's Technical Notes `files-to-modify` list plus the test files committed by builders (from `git log --name-only --pretty=""` on task commits).

  If the wave-refactor builder fails or returns without a commit → log the gap in PROGRESS.md deviations and proceed. REFACTOR/MUTATE failure is not a wave blocker; the code is correct (GREEN passed), just unpolished.

- **REFACTOR LOOP** (standard mode only) — after the wave-refactor builder returns, measure test state and fix any failures with up to 2 additional builder iterations. Full algorithm: `references/refactor-loop.md`.

  Summary: spawn the extended `shipyard-test-runner` (returns a `## Structured Result` block with a `failing_tests` list). If all pass, proceed. If any fail, spawn up to 2 more fix-focused wave-refactor builders (iterations 2–3), re-measuring after each via the test-runner. Stuck = same failing test names as the previous iteration. Cap = 3 total iterations. On loop exhaustion or stuck, write iteration history to PROGRESS.md deviations and proceed — REFACTOR loop failure is not a wave blocker.

  Logcap session names: `wave-[N]-refactor` (iteration 1), `wave-[N]-refactor-iter-2`, `wave-[N]-refactor-iter-3`.

  **Fast mode:** skip wave-scoped tests entirely and the REFACTOR loop — proceed directly to VERIFY.

- **Wave VERIFY** — spawn `shipyard-review-spec` to check all wave tasks' acceptance scenarios against the now-merged and refactored implementation:
  ```
  Agent(subagent_type: shipyard:shipyard-review-spec,
        model: haiku,
        prompt: |
    Wave [N] acceptance check — all tasks together.

    For each task below, verify every acceptance scenario is implemented and tested:
    [list each TASK_ID with its task file path and feature file path]

    Diff: git diff $(git merge-base HEAD [main-branch])...HEAD

    Return a consolidated checklist:
      TASK_ID ✓/✗ scenario — pass or specific gap

    If all pass → "PASS: Wave [N] — [N] scenarios across [M] tasks all satisfied"
    If gaps → list them. Do NOT suggest fixes.
  )
  ```
  - **If PASS** → proceed.
  - **If gaps found** → re-dispatch the relevant task builders to fill the gaps (max 1 re-dispatch per task). Pass the specific gap list in the prompt. If gaps persist after 1 re-dispatch → update affected tasks to `needs-attention`, emit `wave_verify_gap` event, log to PROGRESS.md deviations, and proceed. Gaps surface in `/ship-review`.
- Check for structural gaps (acceptance scenario with no implementation path at all)
- If gaps found → create patch tasks, add to next wave
- If blockers → report and attempt swap-in
- Create worktrees for next wave from updated working branch HEAD
- **Report progress and continue immediately** — do NOT stop or ask the user. Output a compact wave status line:
  ```
  Wave [N]/[M] ✓  [████████░░░░░░░░] [done]/[total] tasks  •  tests [pass/fail]  •  → Wave [N+1]
  ```
  Progress bar: 16 chars wide, `█` filled, `░` empty, `done_pct = total_done / total_sprint * 100`. If gaps were found this wave, append ` • [N] gaps → patch tasks`. If pace is slowing relative to earlier waves, append ` • pace slowing`. If wave-scoped tests failed and a fixer was spawned, append ` • tests fixed`. (Type "pause" to stop.)

  **Auto-continue to the next wave without pausing.** The orchestrator stays lean (~10-15% context) by delegating to subagents. Do not suggest `/clear`, do not suggest re-invoking `/ship-execute`, do not ask "do you want to continue?" — just proceed to the next wave.

  **Context pressure detection:** At each wave boundary, use the Read tool on `<SHIPYARD_DATA>/.active-execution.json` (substitute SHIPYARD_DATA from the context block). Parse the JSON and read the `compaction_count` field. Treat a missing field as `0`. Thresholds (calibrated for long-running execution; see `references/context-pressure.md` for current model-context assumptions — Opus is 1M GA, Sonnet is 200K GA):
  - **count ≤ 3** → note it in passing, continue normally
  - **count = 4** → warn in wave report: "⚠ Context summarised 4 times — working memory is degrading. One more compaction will trigger an auto-pause recommendation."
  - **count ≥ 5** → **auto-pause at this wave boundary.** Use the Write tool to write HANDOFF.md, then use Write to overwrite `<SHIPYARD_DATA>/.active-execution.json` with `{"skill": null, "cleared": "<iso-timestamp>"}` (soft-delete sentinel — clears the lock AND the counter in one write), and tell the user:
    ```
    ⚠ Auto-pausing at wave boundary — conversation history has been reconstructed 5 times this sprint.
    Working memory is degrading. Progress saved.
    Run: /clear then /ship-execute (resumes from Wave [N+1] with a fresh window)
    ```
    The pause is a quality decision, not a quota decision. Each auto-compaction is a lossy summarisation; by count 5 Claude is operating on a summary-of-a-summary-of-a-summary and starting to make things up. A fresh window restores full working memory. (On Opus 1M sessions you also have plenty of token runway left at this point; on Sonnet 200K sessions the runway is shorter, but the fidelity argument is the same.)

  The counter is a field on the execution lock itself, managed by the PostCompact hook and gated by the lock's `tracks_compaction_pressure` flag. No separate reset step — the counter lives and dies with the lock. Full contract in `references/context-pressure.md`.

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

**5a. Full build + full test suite**
- **Full build first** — if `build_commands.full` is configured, delegate a full project build to a `shipyard:shipyard-test-runner` subagent. This is the first time the entire project builds together after all waves merged — catches cross-module compilation errors that scoped wave builds missed.
  ```
  Run the full project build.
  Command: shipyard-logcap run sprint-build -- <BUILD_FULL_COMMAND>
  Return: PASS or FAIL with first error.
  ```
  If the full build fails → spawn a `shipyard:shipyard-builder` subagent to fix build errors before running tests. If `build_commands.full` is not configured, skip to tests.
- **Full test suite** — spawn a single `Agent` with `subagent_type: shipyard:shipyard-test-runner` (no `isolation: worktree`) following the multi-tier pattern in `references/test-delegation.md`. Pass it `test_commands.unit`, `test_commands.integration`, and `test_commands.e2e` from config. It runs all three sequentially and returns a combined summary (one line per tier). This is the only time the entire test suite runs. Act on the summary — do NOT run tests directly in this session.
- If regression failures: do NOT fix code or lint errors directly. Spawn a `shipyard:shipyard-builder` subagent (no worktree) with the failure summary and instructions to fix all failures. At sprint level the branch owns all errors — do not scope to the diff. Verify a new commit exists after it returns. Re-run the test subagent to confirm clean before proceeding.

**5b. Finalize**
- Delete `<SHIPYARD_DATA>/agents/` directory if it exists (heartbeat cleanup — clean slate for next sprint)
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

Single-task mode follows the same structure: builder writes tests + implementation (no test execution), then the wave REFACTOR+MUTATE+VERIFY sequence runs for the single-task wave.

---

## HOTFIX Mode (--hotfix)

1. Read bug file (B-HOT-NNN)
2. Verify the user is on the branch they want the hotfix applied to (AskUserQuestion if unclear)
3. Execute TDD cycle (must include regression test)
4. Commit: `fix(B-HOT-NNN): [description]`
5. Report: "Hotfix ready. Review with /ship-review --hotfix B-HOT-NNN"

Shipyard does not create branches, merge, or push for hotfixes — the user handles their own git workflow. Hotfix does NOT affect sprint state or velocity.

Hotfix mode always runs tests at task level — the regression test is the whole point of a hotfix. The `--fast` flag is ignored in hotfix mode — tests always run to verify the regression is caught.

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
- If stuck after 7+ iterations → **escalate to debug mode**: use the Write tool to create a debug session file at `<SHIPYARD_DATA>/debug/[task-id].md` with the symptoms, what was tried, and what was eliminated. Then AskUserQuestion:

  "Builder is stuck on [task] after [N] attempts. I've started a debug session to investigate systematically.

  1. Debug now — investigate with /ship-debug --resume
  2. Skip task — move to next unblocked task, come back later
  3. Ask for help — describe the problem so I can assist

  Recommended: 1 — systematic investigation beats repeated attempts"

This also applies when the orchestrator spawns a builder to fix integration test failures and the fix doesn't work after 2 attempts — escalate to debug instead of spawning another builder.

## Pause / Resume

Claude Code's `--continue` restores conversation history, but it doesn't know project-level state (which wave, which task, what was happening). Shipyard bridges this gap with a handoff file.

### On Pause (user says "pause", "stop", "break", or session is ending)

Use the Write tool to write `<SHIPYARD_DATA>/sprints/current/HANDOFF.md`:
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
refactor_loop:               # only present if paused mid-REFACTOR loop
  wave: [wave number]
  current_iteration: [1|2|3]
  failing_tests: ["TestName", ...]
  iteration_history:
    - iteration: 1
      failing_tests: ["TestA", "TestB", "TestC"]
    - iteration: 2
      failing_tests: ["TestA", "TestB"]
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

When `/ship-execute` runs and `<SHIPYARD_DATA>/sprints/current/HANDOFF.md` exists (use Read to check):

**Note:** Step 0 (worktree salvage) has already run before reaching this point. All leftover worktrees have been salvaged and merged onto the working branch. New worktrees will branch from this consolidated state.

1. Read HANDOFF.md — know exactly where we left off
2. **Accumulate paused time:** If HANDOFF.md frontmatter has a `paused_at` value (non-null), compute `paused_minutes = round((now - paused_at) / 60)` where `now` is the current time and `paused_at` is the ISO 8601 timestamp from HANDOFF.md. Add `paused_minutes` to `total_paused_minutes` in SPRINT.md frontmatter (if `total_paused_minutes` is absent or null, treat it as 0 before adding). Then clear `paused_at` from HANDOFF.md (set it to null).
3. Read PROGRESS.md — verify completed tasks match
4. Check git branch — ensure we're on the right branch
5. **REFACTOR loop resume:** If HANDOFF.md frontmatter contains `refactor_loop` (non-null), the session was paused mid-REFACTOR loop. Reconstruct loop state from it: `current_iteration` is where the loop stopped, `failing_tests` is the last known failure set, `iteration_history` has the per-iteration record. Continue the loop from `current_iteration + 1` — do NOT restart from iteration 1. See `references/refactor-loop.md` for the algorithm. If `current_iteration` is already 3 (cap reached but pause happened before PROGRESS.md write): write the deviation entry and proceed to VERIFY.
6. If team mode: `TeamCreate(team_name)` (previous session's team is gone). Create new worktrees from the working branch HEAD (which now includes all salvaged work from Step 0). Re-spawn teammates using the session resume prompt from team-mode.md. Use `teammates` field from HANDOFF.md for which feature tracks need re-spawning (max 4 concurrent — restore the queue from `queued_tracks` field). Previous teammate sessions are always dead after a session break — always re-spawn.
7. Delete HANDOFF.md (it's consumed)
8. Continue from the next step documented in handoff

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

- NEVER skip TDD — fast mode defers test execution to the wave boundary; TDD is not skipped, execution is deferred, not skipped. Per-task builders write tests before implementation; REFACTOR/MUTATE/VERIFY run at the wave boundary.
- NEVER modify test assertions to pass. Fix the implementation.
- NEVER build beyond acceptance criteria.
- ALWAYS commit atomically per task.
- ALWAYS update task file status to `done` after completing each task.
- Log session activity in PROGRESS.md (blockers, deviations, session notes).
- NEVER fix test failures, lint errors, or code bugs directly in this session. Always spawn a `shipyard:shipyard-builder` subagent to fix them.
- Delegate bugs, missing criticals, and blockers to a builder subagent. Ask for architectural changes.
- If in doubt → AskUserQuestion.
