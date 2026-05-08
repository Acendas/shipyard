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

## Acquire Locks

Invoke the **`shipyard:acquiring-skill-lock` capability skill** to (a) check the planning-session lock at `<SHIPYARD_DATA>/.active-session.json` and HARD-BLOCK if a discussion is in progress in another session, and (b) acquire `<SHIPYARD_DATA>/.active-execution.json` with the lock JSON shape including `session_id` (CC-7). The capability skill handles cleared-sentinel detection, 2h-stale recovery, and the cross-skill mutual exclusion.

If the planning lock is held by a live different session, print the HARD BLOCK message from the capability skill's contract and STOP — do not load any further context.

3. **On sprint completion or pause** (HANDOFF.md written), use the Write tool to overwrite `<SHIPYARD_DATA>/.active-execution.json` with `{"skill": null, "cleared": "<iso-timestamp>"}`. (Soft-delete sentinel.)

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

Anthropic's stale-worktree cleanup (per `cleanupPeriodDays`) handles worktrees with NO uncommitted changes / NO untracked files / NO unpushed commits at session start automatically. Step 0 only handles the cases Anthropic's sweep skips. Heartbeat-file recovery (pre-2.0) is gone with the agent-heartbeat hook deletion.

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

The worktree-creation probe and `manual_worktrees=true` fallback are gone (F-35). `using-worktrees` capability skill encodes the trust-the-platform model; `dispatching-task-loop`'s HARD STOP catches genuinely-broken isolation.

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
| `fast_mode` | `true` if `--fast` was passed, else `false` |

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

### Step 3: Per-Task Execution (RED → GREEN)

Each task is a small, focused unit of work: **write tests → write implementation → commit**. In fast mode (`--fast`), builders write tests but skip all test execution — tests are deferred to the wave boundary. In normal mode, builders run logcap captures at RED (`<TASK_ID>-red`) and GREEN (`<TASK_ID>-green`) phases. REFACTOR, MUTATE, and VERIFY all happen in Step 4.

**Read the full cycle details** in the `shipyard:tdd-cycle` capability skill — the canonical Iron Law and Red→Green→Refactor contract. The `dispatching-task-loop` capability skill inlines the same Iron Law into every subagent prompt.

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

### Step 4: Wave Boundary Check

Between waves:

1. **Rebase + ff-merge** task branches one at a time, in order. For each `shipyard/wt-*` branch: `git rebase <working-branch>` → `git checkout <working-branch>` → `git merge --ff-only` → `git worktree remove` → `git branch -d`. Conflicts → AskUserQuestion with details; never fall back to a regular merge (creates fork lines).
2. **Clean orchestrator branch.** `git status --porcelain` must be empty after all merges. Legitimate state changes (PROGRESS.md, task status) → commit `chore(shipyard): wave [N] state update`. Unexpected source-file changes → AskUserQuestion.
3. **Update PROGRESS.md** `current_wave: <next>`. Wrap in `shipyard-data with-lock sprint --` if a parallel writer is possible (recovery, review fixers).
4. **Wave-scoped build** (if `build_commands.scoped` or `build_commands.full` configured): invoke `shipyard:dispatching-operational-task` with the build command. Failure → re-dispatch the same capability skill to drive a bounded fix loop.
5. **Wave REFACTOR + MUTATE**: dispatch a `general-purpose` subagent with an inline wave-refactor prompt (read the combined wave diff, dedupe + rename + add helpers, run a small mutation check, commit if changes). Not a wave blocker — failure logs to PROGRESS.md and advances.
6. **Wave-scoped tests + single fix iteration** (standard mode only): invoke `shipyard:dispatching-operational-task` with the test command. Failure → ONE re-dispatch via `shipyard:dispatching-task-loop` with the failing-test list as `continuation_note`. Persistent failure logs to PROGRESS.md and advances. **Fast mode skips this step.**
7. **Wave VERIFY**: invoke `shipyard:dispatching-spec-review` with `scope: "wave"`, `target_ids: [task_ids]`, `base_ref` (pre-wave HEAD), `head_ref` (current HEAD). FINDINGS → single re-dispatch per task via `dispatching-task-loop`; persistent gaps → `needs-attention` and surface to `/ship-review`.
8. **Report and continue** — emit a one-line wave status (`Wave [N]/[M] ✓ [████░░░░] [done]/[total] tasks • → Wave [N+1]`). **Do NOT pause, do NOT suggest `/clear`, do NOT ask "continue?"** — auto-advance.
9. **Context pressure: warn-only.** If `<SHIPYARD_DATA>/.active-execution.json`'s `compaction_count` ≥ 4, append `⚠ Context summarised N times — consider /clear then /ship-execute`. The pre-2.0 auto-pause-at-5 logic is gone (F-40); the PostCompact hook is gone (F-3). Counter survives as informational only.

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
3. **Finalize**: update SPRINT.md frontmatter (`status: completed`, `completed_at: <ISO>`). Features stay `in-progress` — only `/ship-review` transitions them to `done`. Report:

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

The pre-2.0 orchestrator-side "5+ edits same file without commit" detection (loop-detect hook) is gone (F-42). Loop detection now lives inside `dispatching-task-loop`'s subagent context — the subagent's own iteration cap (5 internal iterations) plus the structured `STATUS: BLOCKED` return surface stuck tasks without per-Edit hook overhead.

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

## Deviation Rules

| Category | Examples | Action |
|---|---|---|
| **Bug / Missing Critical / Blocker** | runtime errors, missing null checks, missing auth, broken imports | invoke `shipyard:dispatching-task-loop` with a patch task; log to PROGRESS.md `## Deviations` |
| **Structural** | new DB table, new service, different design pattern | `AskUserQuestion` before proceeding |

**The orchestrator never writes, edits, or fixes code directly.** Always delegate.

## Rules

- NEVER skip TDD. Fast mode defers test *execution* to the wave boundary; the test-first discipline is unchanged.
- NEVER modify test assertions to pass — fix the implementation.
- NEVER build beyond acceptance criteria.
- ALWAYS commit atomically per task; update task `status: done` after each.
- Log blockers / deviations / session notes in PROGRESS.md.
- NEVER fix test failures, lint errors, or bugs directly in this session — invoke `shipyard:dispatching-task-loop` (code) or `shipyard:dispatching-operational-task` (command-shaped) to delegate.
- Architectural changes → `AskUserQuestion`.
- If in doubt → `AskUserQuestion`.
