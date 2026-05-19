---
name: ship-execute
description: "Execute the current sprint in test-first waves."
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
- `--single-tick` → Force one-tick-per-invocation (for direct invocation testing of /loop semantics)
- No args → Execute full sprint from current wave

---

## Cursor + Per-Tick Advance

`/ship-execute` is /loop-friendly: every invocation reads a persistent **pipeline cursor**, dispatches to the matching stage handler, and writes the cursor for the next tick. Full schema, stage map, terminal protocol, event vocabulary, and stuck-detection thresholds live in [references/pipeline-cursor.md](references/pipeline-cursor.md) — read it before changing any of the per-tick wiring.

**Cursor location.** `<SHIPYARD_DATA>/sprints/current/EXECUTE-CURSOR.md`. One file per sprint. Written on entry (if absent), updated after every stage transition, archived along with `current/` when the sprint completes.

**Cursor read at entry (the canonical recipe — do this before any other work besides locks):**

1. Acquire locks (the `Acquire Locks` section below).
2. Use the Read tool to read `<SHIPYARD_DATA>/sprints/current/EXECUTE-CURSOR.md`.
   - **Cursor exists and `terminal: true`** → emit `shipyard-data events emit pipeline_terminal pipeline=ship-execute sprint=<id> outcome=noop reason=cursor_already_terminal`, print `▶ CYCLE COMPLETE — sprint already complete. /loop should stop.`, exit cleanly.
   - **Cursor exists and `terminal: false`** → emit `shipyard-data events emit pipeline_tick_started pipeline=ship-execute sprint=<id> stage=<stage> wave=<N> iteration=<N> loop_owner=<owner>` and dispatch to the handler for the `stage:` field.
   - **Cursor absent AND HANDOFF.md absent** → fresh start. Set `stage: preflight`, `iteration: 1`, `terminal: false`, `status: in_progress`, emit `pipeline_tick_started`, begin from Pre-flight.
   - **Cursor absent AND HANDOFF.md present** → graceful resume from HANDOFF.md (existing path). After HANDOFF.md is consumed and deleted, write the cursor at the documented `wave_N_dispatch` stage and continue.
3. **No-op terminal sweep (MANDATORY — load-bearing for /loop safety).** Even if the cursor passed step 2 as non-terminal, verify the sprint is actually alive by checking all THREE conditions from the No-op terminal section below:
   - cursor exists with `terminal: true` (already covered in step 2; re-checking here is belt-and-braces)
   - `<SHIPYARD_DATA>/sprints/current/SPRINT.md` frontmatter has `status: completed`
   - There is no active sprint in `<SHIPYARD_DATA>/sprints/current/` (already archived — no SPRINT.md present)

   If ANY of these hold: emit `shipyard-data events emit pipeline_terminal pipeline=ship-execute sprint=<id> outcome=noop reason=sprint_already_complete`, print `▶ CYCLE COMPLETE — sprint already complete. /loop should stop.`, exit cleanly. NEVER skip this sweep — it is the exact protection that closed the original `/loop` wakeup-leak bug. The auto-loop bootstrap in step 4 explicitly depends on this sweep having run with no exit triggered.
4. **Auto-loop bootstrap check** (described in detail below). PRECONDITION: step 3 must have completed without exit. If the user invoked directly and the eligibility conditions hold, write the sentinel + call `Skill(skill: "loop", ...)` + return. The bootstrap path short-circuits the rest of this recipe — `/loop` will re-fire `/shipyard:ship-execute` immediately and that re-entry does the real work.
5. After the chosen stage's handler returns, write the cursor for tick N+1 (or write the terminal cursor on a terminal stage). Emit `pipeline_tick_completed` (or `pipeline_terminal`). Print the appropriate marker.

The cursor write is via the Write tool — auto-approved for SHIPYARD_DATA paths. Use the literal absolute path from `shipyard-context path`.

**No-op terminal: already-completed sprint.** When `/ship-execute` is invoked and any of: cursor exists with `terminal: true`, SPRINT.md frontmatter has `status: completed`, or there is no active sprint in `current/` (already archived) — emit `shipyard-data events emit pipeline_terminal pipeline=ship-execute sprint=<id> outcome=noop reason=sprint_already_complete`, print `▶ CYCLE COMPLETE — sprint already complete. /loop should stop.`, exit cleanly. This is the exact path that closed the original `/loop` wakeup-leak bug — never skip the emit + marker on the no-op branch.

**loop_owner detection.** Read the last `pipeline_tick_completed` event from `<SHIPYARD_DATA>/.shipyard-events.jsonl`. If the most recent matching event is within the last 30 minutes AND its `next_stage` matches the cursor's current `stage:`, set `loop_owner: "/loop"`. Otherwise `loop_owner: "user"`. The `--single-tick` argument forces `loop_owner: "/loop"` semantics regardless of detection (used for testing per-tick behavior from a direct invocation).

**Auto-loop bootstrap (run AFTER loop_owner detection AND the no-op terminal sweep, BEFORE the dispatch contract).** When a user invokes `/ship-execute` directly, this skill self-bootstraps the `/loop` driver so the user never needs to type `/loop` themselves. Eligibility (ALL must hold — checked in this order so the cheapest predicates fail-fast):

- `loop_owner == "user"` (no `/loop` already driving — checked above).
- Mode is not `--task` and not `--hotfix` (those are single-tick by design).
- Cursor exists and `terminal: false`.
- Cursor's `auto_loop_attempted` field is not `true`.
- **Sprint-liveness re-check (defense in depth):** `<SHIPYARD_DATA>/sprints/current/SPRINT.md` exists AND its frontmatter `status` is NOT `completed`. The recipe step 3 sweep should have already exited if either is false — this re-check guards against a refactor that moves the sweep, since bootstrapping against a dead sprint is the exact precondition for the v2.2.0 wakeup-leak regression. If this re-check fires, emit `pipeline_terminal pipeline=ship-execute sprint=<id> outcome=noop reason=sprint_dead_at_bootstrap` and print the standard `▶ CYCLE COMPLETE — sprint already complete. /loop should stop.` marker, then exit. Never bootstrap `/loop` against a dead sprint.

When eligible, in this exact order:

1. Use the Write tool to update the cursor: preserve every existing field, set `auto_loop_attempted: true`. This MUST land before the `Skill(loop, ...)` call — `/loop` fires its iteration 1 immediately and re-enters this skill, and that re-entry must see the sentinel so it skips this block and proceeds to real work.
2. Emit `shipyard-data events emit pipeline_loop_bootstrap pipeline=ship-execute sprint=<id> via=auto`.
3. Invoke `Skill(skill: "loop", args: "/shipyard:ship-execute")`. `/loop` will set up dynamic-mode self-pacing AND immediately fire `/shipyard:ship-execute` as iteration 1. The re-entry sees `auto_loop_attempted: true`, skips this bootstrap, and does the current tick's actual stage work. `/loop`'s pacer then schedules subsequent ticks via `ScheduleWakeup`.
4. Return from this outer invocation as soon as the `Skill` call returns. Do NOT do tick work in this outer frame — the re-entry owns it. Print the one-line marker `▶ AUTO-LOOP STARTED — /shipyard:ship-execute is now driven by /loop. Subsequent waves will fire automatically.` so the user sees what happened.

When not eligible, skip the bootstrap block entirely and proceed to the dispatch contract below.

**Sentinel cleanup.** When writing a terminal cursor (`terminal: true`, regardless of outcome — success, escalated, aborted), do NOT carry `auto_loop_attempted` forward. The next sprint's first `/ship-execute` re-evaluates eligibility from scratch. The `current/` archive at sprint completion drops the cursor along with the rest of sprint state, so this is mostly a belt-and-braces rule.

**Fallback if `/loop` goes silent.** If a tick re-enters with `loop_owner == "user"` AND `auto_loop_attempted == true` AND the last `pipeline_tick_completed` event from this pipeline is older than 5 minutes (i.e., `/loop` accepted the bootstrap but stopped firing), call `CronCreate(cron: "*/2 * * * *", prompt: "/shipyard:ship-execute", recurring: false)` to nudge the next tick, then proceed with this tick's work. Emit `shipyard-data events emit pipeline_loop_bootstrap_fallback pipeline=ship-execute sprint=<id> method=cron reason=loop_silent`. This path exists for resilience; in normal operation `/loop` keeps firing and the fallback never triggers.

**Direct invocation vs /loop driver — the dispatch contract.**

- **`loop_owner: "user"` (direct invocation):** the handler for the current stage runs, and on success it CHAINS into the next stage's handler within the same invocation. Continue chaining until either a user-input gate (AskUserQuestion), the terminal stage, or a ~10-minute wall-clock budget is exhausted. The FULL SPRINT Execution mandate below (sprint-start to sprint-done without per-wave hand-off) is the direct-invocation behavior — do not change it.
- **`loop_owner: "/loop"`:** the handler for the current stage runs, writes the cursor for the next stage, emits `pipeline_tick_completed`, prints the tick marker, and exits. /loop schedules the next wakeup; the next tick re-enters this skill and reads the cursor again. One stage per tick.

Both paths share the SAME stage handlers and the SAME cursor. The only difference is whether the skill chains within an invocation or exits between stages.

**Coexistence with HANDOFF.md.** The cursor is for automatic per-tick advance; HANDOFF.md is for the user-initiated explicit pause with a hand-written note. Both can coexist on disk. **On resume, HANDOFF.md takes precedence** because the user wrote it deliberately. After HANDOFF.md is consumed and deleted, write a cursor at the documented stage and continue. Compaction-recovery reads the cursor first (authoritative `stage:` field); HANDOFF.md only triggers when the user explicitly paused.

### Self-looping stages: stuck detection

The within-stage iteration caps stay as-is — `dispatching-task-loop`'s single-redispatch rule per task and `dispatching-operational-task`'s `operational_tasks.max_iterations` cap handle micro-flake. Self-looping stages in this skill are `wave_N_redispatch_iter_K`, `wave_N_build_fix_iter_K`, `wave_N_tests_fix_iter_K`, and `sprint_tests_fix_iter_K`; each `K` is bounded at 1 by the existing single-redispatch rule, after which the failing task moves to `needs-attention`. The `wave_N_gate` stage self-loops INTERNALLY via `verifying-wave-completion`'s own ScheduleWakeup pattern (budget 3) — outer cursor sees `wave_N_gate` as a single tick that either advances or escalates.

The outer-cursor `stuck_counter:` is defense-in-depth, not the primary cap:

- Increment `stuck_counter` whenever a stage is re-entered with the same `wave_number` AND the same `iteration` (re-dispatch logic failed to advance the counter).
- At `stuck_counter >= 5`, emit `shipyard-data events emit pipeline_stuck pipeline=ship-execute wave=<N> stage=<X> reason=re-entry-without-progress` and surface a warning in the tick output. The pipeline keeps running; this is observational.
- At `iteration: 50` (the `hard_ceiling: 50` safety stop), write `terminal: true`, emit `shipyard-data events emit pipeline_terminal pipeline=ship-execute sprint=<id> outcome=escalated reason=hard_ceiling`, print the terminal marker, halt.
- Reset `stuck_counter` to `0` on any tick that advances `stage` or `wave_number`.

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

### Step 0: Worktree Salvage (stage_id: salvage) (always runs first)

Run `git worktree prune` (portable across macOS/Linux/Windows; only removes admin metadata for already-deleted directories), then `git worktree list`. If no `shipyard/wt-*` paths appear, skip to Step 1.

Otherwise, for each leftover `shipyard/wt-*` worktree:

1. **Salvage uncommitted work** if present: `git -C <worktree> add -A` then `git -C <worktree> commit -m "wip(TASK_ID): salvage from interrupted session"`. Task ID is the branch suffix.
2. **Rebase + ff-merge** the worktree branch onto the working branch. Conflicts → keep the branch; note `"shipyard/wt-X has conflicts — manual merge needed"` in PROGRESS.md and skip the merge.
3. **Remove the worktree** (`git worktree remove`) and delete merged branches.
4. **Update task status** — done if a real commit landed, in-progress for WIP-only salvages, approved (re-execute) if nothing to salvage, blocked for conflicts.

Anthropic's stale-worktree cleanup (per `cleanupPeriodDays`) handles worktrees with NO uncommitted changes / NO untracked files / NO unpushed commits at session start automatically. Step 0 only handles the cases Anthropic's sweep skips.

The working branch now contains all recoverable work. New worktrees created in Step 2 branch from this consolidated state.

**Cursor write (stage_id: salvage).** On success, write the cursor with `stage: load`, increment `last_advance_at`, reset `stuck_counter: 0`. Under `loop_owner: "/loop"`: emit `shipyard-data events emit pipeline_tick_completed pipeline=ship-execute sprint=<id> stage=salvage outcome=advanced next_stage=load`, print `▶ TICK COMPLETE — pre-load, stage salvage, next: load. /loop continues.`, exit. Under `loop_owner: "user"`: chain into Step 1.

### Step 1: Load Sprint Plan (stage_id: load)

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

**Cursor write (stage_id: load).** Determine next stage from session type: fresh start → `readiness`; resume / crash recovery → `wave_<current_wave>_dispatch`. Write the cursor with the determined next stage. Under `/loop`: emit `pipeline_tick_completed pipeline=ship-execute sprint=<id> stage=load outcome=advanced next_stage=<next>`, print `▶ TICK COMPLETE — load complete, next: <next stage>. /loop continues.`, exit. Under direct: chain into Step 1.5 (fresh) or Step 2 (resume).

### Step 1.5: Execution Readiness Check (stage_id: readiness) (fresh-start only)

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

**Cursor write (stage_id: readiness).** On AskUserQuestion = "Begin execution", write the cursor with `stage: wave_1_dispatch`, `wave_number: 1`, `iteration: 1`. Under `/loop`: emit `pipeline_tick_completed pipeline=ship-execute sprint=<id> stage=readiness outcome=advanced next_stage=wave_1_dispatch`, print `▶ TICK COMPLETE — readiness approved, next: wave_1_dispatch. /loop continues.`, exit. Under direct: chain into Step 2. On "Abort": write the cursor with `terminal: true`, `status: escalated`, emit `pipeline_terminal pipeline=ship-execute sprint=<id> outcome=escalated reason=readiness_aborted`, print the terminal marker, halt.

### Step 2: Execute Waves (stage_id: wave_N_dispatch)

Per-wave stage IDs are `wave_<N>_dispatch` for the dispatch tick and `wave_<N>_redispatch_iter_<K>` for the single per-task re-dispatch tick (K ∈ {1}). Each wave then transitions through `wave_<N>_boundary` → `wave_<N>_build` → `wave_<N>_refactor` → `wave_<N>_tests` → `wave_<N>_verify` → `wave_<N>_gate` in Step 4. After the last wave's gate, the cursor advances to `sprint_full_build` (Step 5).

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

#### Live progress streaming (wrap the dispatch)

`dispatching-task-loop`'s subagents already emit `task_loop_iteration` events per iteration (`shipyard-data events emit task_loop_iteration task=<id> iteration=<N> probe_exit=<code>`) from inside their own contexts — see `dispatching-task-loop/SKILL.md`. By default the orchestrator does NOT surface mid-loop work, leaving the user with a long silence (minutes per wave) while subagents churn. To close that gap, wrap each wave's per-task dispatch with a backgrounded `tail -f` on the event log and attach `Monitor` so events surface in the user's chat as they fire.

Pattern, immediately before dispatching the first task of the wave:

```
# Start the live-progress streamer. Captures events appended to the log during this wave's dispatch.
bg = Bash(
    run_in_background: true,
    command: "tail -f -n 0 <SHIPYARD_DATA>/.shipyard-events.jsonl | "
             "grep --line-buffered -E '(task_loop_iteration|subagent_dispatched|subagent_returned|wave_check_passed|wave_check_failed)'"
)
Monitor(bg.task_id)   # each matching JSONL line surfaces as a notification
```

After the wave's dispatch returns (all task verdicts collected):

```
TaskStop(bg.task_id)  # ends the tail-f and the Monitor together
```

Apply this wrap at every stage that dispatches subagents:

- `wave_<N>_dispatch`
- `wave_<N>_redispatch_iter_<K>`
- `sprint_tests_fix_iter_<K>` (sprint-level test-fix re-dispatch)

Skip for stages without subagent dispatch (preflight, salvage, load, readiness, boundary, refactor, tests, verify, gate). The `verify` and `tests` stages already have their own Monitor wired via `dispatching-operational-task` for stream-vs-capture verify runs (commit `de5c0c8`) — do not double-wrap.

The streamer is cheap: `tail -f -n 0` starts at EOF (no historical replay), `grep --line-buffered` flushes line-by-line, the JSONL events are tens of bytes each. Negligible per tick.

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
| `sprint_id` | `id:` from SPRINT.md frontmatter — used by the subagent to scope its `subagent_completed` event |
| `wave_number` | Current wave number from the cursor — used by the subagent to scope its `subagent_completed` event |
| `dispatch_mode` | `background` for wave-dispatch and sprint-test-fix-redispatch stages; `sync` for `--task`/`--hotfix` modes. **See "Background dispatch" below.** |

In **subagent/team mode**, the capability skill internally dispatches with `isolation: "worktree"` (per `using-worktrees` — Anthropic's stable primitive). In **solo mode**, no isolation. The skill handles both transparently.

**Background dispatch (the default for wave-dispatch in v2.5.0+).**

When `dispatch_mode: background`, the orchestrator does NOT block waiting for the subagent's structured return. Instead:

1. The Agent call uses `run_in_background: true`. Returns immediately with a task handle.
2. The orchestrator writes the cursor with `stage: wave_<N>_waiting`, populates `pending_subagents: [{ task_id, spawned_at, max_execution_minutes }]` (one entry per spawned subagent), arms a persistent Monitor on `<SHIPYARD_DATA>/.shipyard-events.jsonl` filtered for `subagent_completed` events with matching `sprint=` and `wave=`.
3. The orchestrator exits. The current `/loop` iteration ends.
4. Each subagent runs its internal Cycle in the background. As its final actions (per the `dispatching-task-loop` contract), it writes the full structured return to `<SHIPYARD_DATA>/sprints/current/.subagent-returns/<task_id>.txt` and emits the `subagent_completed` event.
5. The Monitor armed in step 2 fires `<task-notification>` envelopes to `/loop` each time a `subagent_completed` event lands. `/loop` wakes the moment any matching event arrives, regardless of the fallback `ScheduleWakeup` delay.
6. On the next `/loop` iteration, the orchestrator reads the cursor at `stage: wave_<N>_waiting`, dispatches to the `wave_<N>_recovery` handler (see Step 4 below), which reads each task's capture file, runs the orchestrator-side gate (sha verify + probe re-execution + anti-stub-scan), removes completed task_ids from `pending_subagents`, and either advances to `wave_<N>_boundary` (all done + all gates pass) or to `wave_<N>_redispatch_iter_1` (any BLOCKED or any gate failure).

The orchestrator never reads the Agent tool's return value in background mode. The structured-return contract is preserved via the capture file; the wake signal is the event log.

The skill returns a structured verdict (`STATUS: COMPLETE` + `COMMIT: <sha>` + `PROBE_OUTPUT_TAIL` after orchestrator-side verification, or `STATUS: BLOCKED` with reason) — in **sync mode** this comes from the Agent's return value, in **background mode** it's reconstructed from the capture file referenced in the `subagent_completed` event. The downstream gate logic and re-dispatch rule are identical in both modes. **Do not parse subagent output yourself** — the capability skill (or the capture file in background mode) has already validated it.

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

**Cursor write (stage_id: wave_N_dispatch) — background mode (default).** After spawning all subagents in the background, write the cursor with `stage: wave_<N>_waiting`, populated `pending_subagents` list (one entry per dispatched task: `{ task_id, spawned_at: <iso>, max_execution_minutes: <from task frontmatter or 60 default> }`), arm the Monitor on the event log filtered for `subagent_completed pipeline=ship-execute sprint=<id> wave=<N>`. Emit `wave_<N>_dispatched_bg pipeline=ship-execute sprint=<id> wave=<N> task_ids=<csv>` and `pipeline_tick_completed pipeline=ship-execute sprint=<id> stage=wave_<N>_dispatch outcome=advanced next_stage=wave_<N>_waiting`. Print `▶ TICK COMPLETE — wave <N>/<M> dispatched (background), waiting on [<task_ids>]. /loop continues.`, exit. The next `/loop` iteration that fires (Monitor-driven or fallback-timer-driven) reads the cursor at `wave_<N>_waiting` and routes to the recovery handler below.

**Cursor write (stage_id: wave_N_dispatch) — sync mode (`--task`/`--hotfix` only).** On all dispatched tasks returning `STATUS: COMPLETE`: write the cursor with `stage: wave_<N>_boundary`. On any `STATUS: BLOCKED` returns: write the cursor with `stage: wave_<N>_redispatch_iter_1`, increment `iteration`. After the single re-dispatch attempt (still BLOCKED): mark the task `status: needs-attention`, write the cursor with `stage: wave_<N>_boundary`, log to PROGRESS.md, continue. Under `/loop`: emit `pipeline_tick_completed pipeline=ship-execute sprint=<id> stage=wave_<N>_dispatch outcome=advanced next_stage=<next>`, print `▶ TICK COMPLETE — wave <N>/<M>, stage wave_<N>_dispatch, next: <next>. /loop continues.`, exit. Under direct: chain into Step 4 (boundary) or the re-dispatch handler.

#### Wave waiting handler (stage_id: wave_N_waiting)

When `/loop` re-enters with `cursor.stage == wave_<N>_waiting`:

1. **Read the event log.** Use Read on `<SHIPYARD_DATA>/.shipyard-events.jsonl`. Filter (with Grep or in-process) for `subagent_completed pipeline=ship-execute sprint=<cursor.sprint_id> wave=<N>` events. Build a map of `task_id → event payload`.
2. **Match against `pending_subagents`.** Each entry in `pending_subagents` either:
   - Has a matching event in the map → mark as COMPLETED, queue for gate-verification in step 4.
   - Has no matching event AND `now - spawned_at < max_execution_minutes` → still in flight, leave in `pending_subagents`.
   - Has no matching event AND `now - spawned_at >= max_execution_minutes` → TIMED OUT. Mark task `status: needs-attention`, log to PROGRESS.md ("task TIMED OUT in background dispatch after N minutes; no `subagent_completed` event emitted"), remove from `pending_subagents`, emit `subagent_timeout pipeline=ship-execute sprint=<id> wave=<N> task=<id> minutes=<N>` event, advance past this task.
3. **If `pending_subagents` is still non-empty after step 2** (some subagents still in flight, none timed out): re-write the cursor with `stage: wave_<N>_waiting` (unchanged), update the pending list to remove TIMED OUT entries if any. Emit `pipeline_tick_completed pipeline=ship-execute sprint=<id> stage=wave_<N>_waiting outcome=partial pending=<csv>`, print `▶ TICK COMPLETE — wave <N>/<M>, still waiting on [<task_ids>]. /loop continues.`, exit. The Monitor remains armed (or re-arm if absent).
4. **If `pending_subagents` is now empty** (all subagents accounted for via completion or timeout): advance to `stage: wave_<N>_recovery` so the next tick runs the orchestrator gate. Disarm the Monitor (TaskStop on the armed Bash task). Emit `pipeline_tick_completed ... next_stage=wave_<N>_recovery`. Continue to the recovery handler (chain under direct invocation; exit and re-enter under /loop).

#### Wave recovery handler (stage_id: wave_N_recovery)

When all subagents have completed (or timed out) for the wave, this handler reads their capture files and runs the orchestrator-side gate:

1. **For each completed subagent**, read the capture file referenced in the `subagent_completed` event (`capture_file=<path>` field). The file should contain the same structured-return text the subagent would have returned inline in sync mode (STATUS / COMMIT / PROBE_EXIT / PROBE_OUTPUT_TAIL).
2. **Run the orchestrator-side gate** per task (sha cat-file verify, probe re-execution per `tdd-cycle`, anti-stub-scan on the diff). This is the IDENTICAL logic that runs in sync mode at the end of `dispatching-task-loop` — moved to the recovery handler because in background mode the gate runs on a different iteration than the dispatch.
3. **Decide cursor next-stage based on aggregate results:**
   - All tasks `STATUS: COMPLETE` + all gates pass → `stage: wave_<N>_boundary`.
   - Any task `STATUS: BLOCKED` or any gate fails → `stage: wave_<N>_redispatch_iter_1`, increment `iteration`. The redispatch is itself a sync dispatch (single attempt; doesn't go back through background).
   - Any task TIMED OUT in the waiting handler is already marked `needs-attention` — no re-dispatch for those.
4. **Write the cursor** + emit `pipeline_tick_completed ... next_stage=<chosen>` + print the tick marker + exit (under /loop) or chain (under direct).

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

### Step 4: Wave Boundary Check (stage_ids: wave_N_boundary → wave_N_build → wave_N_refactor → wave_N_tests → wave_N_verify → wave_N_gate)

Each numbered item below maps to a distinct stage ID; the cursor advances stage-by-stage through this sequence within a single wave. Under `/loop`, each item is its own tick. Under direct invocation, items chain.

Between waves:

1. **Rebase + ff-merge** task branches one at a time, in order. For each `shipyard/wt-*` branch: `git rebase <working-branch>` → `git checkout <working-branch>` → `git merge --ff-only` → `git worktree remove` → `git branch -d`. Conflicts → AskUserQuestion with details; never fall back to a regular merge (creates fork lines).
2. **Clean orchestrator branch.** `git status --porcelain` must be empty after all merges. Legitimate state changes (PROGRESS.md, task status) → commit `chore(shipyard): wave [N] state update`. Unexpected source-file changes → AskUserQuestion.
3. **Update PROGRESS.md** `current_wave: <next>`. Wrap in `shipyard-data with-lock sprint --` if a parallel writer is possible (recovery, review fixers).
4. **Wave-scoped build** (if `build_commands.scoped` or `build_commands.full` configured): invoke `shipyard:dispatching-operational-task` with the build command. Failure → re-dispatch the same capability skill to drive a bounded fix loop.
5. **Wave REFACTOR + MUTATE**: dispatch a `general-purpose` subagent with an inline wave-refactor prompt (read the combined wave diff, dedupe + rename + add helpers, run a small mutation check, commit if changes). Not a wave blocker — failure logs to PROGRESS.md and advances.
6. **Wave-scoped tests + single fix iteration**: invoke `shipyard:dispatching-operational-task` with `test_commands.scoped` (or `test_commands.unit` if no scoped variant). This is the first time tests run for the wave's merged code. The operational task runs the suite via Monitor, so progress and failures stream to the user as the wave-scoped run proceeds — no waiting on a single end-of-run blob. Failure → ONE re-dispatch via `shipyard:dispatching-task-loop` with the failing-test list as `continuation_note`. Persistent failure logs to PROGRESS.md and advances.
7. **Wave VERIFY**: invoke `shipyard:dispatching-spec-review` with `scope: "wave"`, `target_ids: [task_ids]`, `base_ref` (pre-wave HEAD), `head_ref` (current HEAD). FINDINGS → single re-dispatch per task via `dispatching-task-loop`; persistent gaps → `needs-attention` and surface to `/ship-review`.
8. **Wave COMPLETION GATE (stage_id: wave_N_gate)**: invoke `shipyard:verifying-wave-completion` with `wave_number`, `task_ids`, `data_dir`, `working_branch`, `wave_base_sha`, `wave_head_sha`, `wave_probe_capture`, `wave_probe_exit_code`. The capability skill runs the six-invariant composite check (all builders returned structured contracts, every commit_sha exists, wave-probe passes with non-empty capture, completion events emitted, no silent-failure markers in window, no uncommitted worktree state) with ScheduleWakeup-based recovery for RECOVERABLE misses and structured escalation otherwise.

   **Nested-loop note — the outer cursor must NOT duplicate this loop.** `verifying-wave-completion` has its OWN internal ScheduleWakeup state machine (budget 3, 180s warm-cache delay) that handles recoverable invariant misses inside this single tick. From the outer pipeline cursor's perspective, `wave_N_gate` is ONE tick that either returns `STATUS: COMPLETE` (cursor advances to `wave_<N+1>_dispatch` or `sprint_full_build`) or `STATUS: ESCALATED` (cursor sets `status: escalated`, surfaces to AskUserQuestion, does not advance). Two layers, two pacers, no double-loop: micro-recovery stays inside the wave gate; macro-flow stays in the outer cursor.

   `STATUS: ESCALATED` → AskUserQuestion with the `REASON:` text; do NOT advance the wave counter. `STATUS: COMPLETE` → proceed to step 9.

9. **Report and continue** — emit a one-line wave status (`Wave [N]/[M] ✓ [████░░░░] [done]/[total] tasks • → Wave [N+1]`). **Under direct invocation:** do NOT pause, do NOT suggest `/clear`, do NOT ask "continue?" — auto-advance into the next wave's Step 2 dispatch. **Under `/loop`:** write the cursor with `stage: wave_<N+1>_dispatch` (or `stage: sprint_full_build` if `N == M`), increment `wave_number`, reset `iteration: 1`, reset `stuck_counter: 0`; emit `shipyard-data events emit pipeline_tick_completed pipeline=ship-execute sprint=<id> stage=wave_<N>_gate outcome=advanced next_stage=<next>`; print `▶ TICK COMPLETE — wave <N>/<M>, stage wave_<N>_gate, next: <next>. /loop continues.`; exit.

10. **Context pressure: warn-only.** If `<SHIPYARD_DATA>/.active-execution.json`'s `compaction_count` ≥ 4, append `⚠ Context summarised N times — consider /clear then /ship-execute`. The counter is informational; never auto-pause.

**Cursor write summary for Step 4 items 1–7.** Each numbered item maps to a stage:
- Items 1–3 → `stage: wave_<N>_boundary` (rebase + ff-merge + PROGRESS.md update). On success → `wave_<N>_build`.
- Item 4 → `stage: wave_<N>_build`. On success → `wave_<N>_refactor`. On failure → `wave_<N>_build_fix_iter_1` (bounded by `dispatching-operational-task`'s cap).
- Item 5 → `stage: wave_<N>_refactor`. On success or log-and-continue → `wave_<N>_tests` (refactor is never a wave blocker).
- Item 6 → `stage: wave_<N>_tests`. On success → `wave_<N>_verify`. On failure → `wave_<N>_tests_fix_iter_1` (single re-dispatch via `dispatching-task-loop`).
- Item 7 → `stage: wave_<N>_verify`. On success → `wave_<N>_gate`. FINDINGS → `wave_<N>_redispatch_iter_1` per failing task.

Under `/loop`, each item writes its own cursor + emits `pipeline_tick_completed` + prints the tick marker + exits. Under direct invocation, items chain through within the ~10-minute wall-clock budget; on budget exhaustion, write the cursor at the next pending stage and exit so the next invocation resumes cleanly.

### Compaction Recovery

If you're unsure which wave you're on or what's been completed (e.g., after auto-compaction cleared earlier context):

1. **Read EXECUTE-CURSOR.md FIRST.** The cursor's `stage:` field is authoritative — it tells you exactly which stage was running when context was cleared. PROGRESS.md and SPRINT.md are confirmatory only. Dispatch to the cursor's stage handler and resume.
2. **If the cursor is absent**, fall back to the file-based recovery:
   - Read PROGRESS.md — `current_wave` in frontmatter tells you which wave to execute next
   - Read SPRINT.md — get the wave structure (which task IDs are in each wave)
   - For task IDs in waves ≤ `current_wave - 1`, read task files — confirm `status: done`
   - For task IDs in wave `current_wave`, read task files — check which are `done` vs remaining
   - Check git branch — `git branch --show-current` to confirm you're on the working branch (from SPRINT.md `branch` field). If not → `git checkout <branch>` before spawning any worktree agents.
   - Resume execution from the first non-done task in `current_wave`, then write a fresh cursor at the appropriate `wave_<N>_dispatch` stage so subsequent ticks have a cursor to read.
3. **If the cursor is present but corrupted** (unparseable YAML frontmatter, missing required fields), refuse to resume. Halt with: "EXECUTE-CURSOR.md is corrupted. Run `/ship-status --repair` to rebuild from the event log before continuing." Do NOT guess from PROGRESS.md when a corrupted cursor exists — the divergence between cursor and registry needs explicit reconciliation.

This takes ~5 tool calls and recovers full state from files. Do not rely on conversation memory for wave/task state — files are the source of truth, with the cursor as the authoritative top of the stack.

### Step 5: Sprint Completion (stage_ids: sprint_full_build → sprint_full_tests → sprint_complete_gate → terminal_handoff_to_review)

When all waves done:

1. **Full build (stage_id: sprint_full_build)** (if `build_commands.full` configured): invoke `shipyard:dispatching-operational-task` with that command. Catches cross-module compilation errors scoped wave builds missed. Failure → AskUserQuestion. On success — under `/loop`: write the cursor with `stage: sprint_full_tests`, emit `pipeline_tick_completed pipeline=ship-execute sprint=<id> stage=sprint_full_build outcome=advanced next_stage=sprint_full_tests`, print `▶ TICK COMPLETE — sprint full build clean, next: sprint_full_tests. /loop continues.`, exit. Under direct: chain into step 2.
2. **Full test suite (stage_id: sprint_full_tests)**: invoke `shipyard:dispatching-operational-task` per tier (unit / integration / e2e) or combined. Persistent failure after the capability skill's iteration cap → re-dispatch via `shipyard:dispatching-task-loop` per failing cluster (stage `sprint_tests_fix_iter_1`, K bounded at 1). Sprint-level branch owns all errors. On success — under `/loop`: write the cursor with `stage: sprint_complete_gate`, emit `pipeline_tick_completed`, print `▶ TICK COMPLETE — sprint tests pass, next: sprint_complete_gate. /loop continues.`, exit. Under direct: chain into step 3.
3. **Sprint-complete predicate (stage_id: sprint_complete_gate)**: invoke `shipyard:evaluating-sprint-complete` with `sprint_id`, `data_dir`, `working_branch`, `sprint_base_sha` (from SPRINT.md frontmatter), `sprint_head_sha` (current HEAD), `sprint_verify_capture` (from step 2), `sprint_verify_exit_code` (from step 2), `review_verdict_path` (null at this stage; `/ship-review` will run after). The skill runs the seven-invariant composite gate. `STATUS: INCOMPLETE` → halt with the failing invariant list via AskUserQuestion; do NOT mark sprint complete. `STATUS: COMPLETE` → proceed to step 4. Invariant 7 (review-verdict-clean) is expected to FAIL at this stage because review hasn't run yet — that's by design; the user runs `/ship-review` next, then re-invokes the predicate. The pre-`/ship-review` invocation here surfaces invariants 1–6 (commits, sprint-verify, spec-done, no-orphan-AC, no-silent-markers, clean-worktrees) before burning review time on a sprint that isn't shippable for structural reasons.
4. **Finalize and emit terminal signal (stage_id: terminal_handoff_to_review)**: update SPRINT.md frontmatter (`status: completed`, `completed_at: <ISO>`). Features stay `in-progress` — only `/ship-review` transitions them to `done`. Then execute the terminal protocol in this exact order:

   a. **Write the terminal cursor.** Use the Write tool to overwrite `<SHIPYARD_DATA>/sprints/current/EXECUTE-CURSOR.md` with `terminal: true`, `status: complete`, `stage: terminal_handoff_to_review`, `next_action: "Sprint complete — handoff to /ship-review"`, updated `last_advance_at`.

   b. **Emit the terminal event.** `shipyard-data events emit pipeline_terminal pipeline=ship-execute sprint=<id> outcome=success reason=sprint_complete`.

   c. **Print the sprint-complete report:**

   ```
   Sprint complete. [N]/[M] tasks done. Full suite: [pass/fail].
   ▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.
   ▶ NEXT UP: /ship-review (tip: /clear first for a fresh window)
   ```

   The `▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.` marker is load-bearing: the looping model reads it as the terminal signal and stops scheduling wakeups. Do NOT call `ScheduleWakeup` after writing the terminal cursor. The existing `▶ NEXT UP: /ship-review` line stays — it's the handoff hint for the user, printed AFTER the cycle-complete marker so the order is "loop stops, then humans know what to do next."

---

## SINGLE TASK Mode (--task) (stage_id: single_task → terminal_single_task)

Execute just one task following the TDD cycle above. Useful for:
- Picking up a specific blocked task after unblocking
- Re-executing a failed task
- Running a patch task

Single-task mode follows the same structure: builder writes tests + implementation (no test execution), then the wave REFACTOR+MUTATE+VERIFY sequence runs for the single-task wave.

**Terminal protocol (stage_id: terminal_single_task).** On completion: write the cursor with `terminal: true`, `status: complete`, `stage: terminal_single_task`, `next_action: "Task complete"`. Emit `shipyard-data events emit pipeline_terminal pipeline=ship-execute sprint=<id> outcome=success reason=task_complete`. Print:

```
Task complete.
▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.
```

---

## HOTFIX Mode (--hotfix) (stage_id: hotfix → terminal_hotfix)

1. Read bug file (B-HOT-NNN)
2. Verify the user is on the branch they want the hotfix applied to (AskUserQuestion if unclear)
3. Execute TDD cycle (must include regression test)
4. Commit: `fix(B-HOT-NNN): [description]`
5. **Terminal protocol (stage_id: terminal_hotfix).** Write the cursor with `terminal: true`, `status: complete`, `stage: terminal_hotfix`, `next_action: "Hotfix ready — handoff to /ship-review --hotfix"`. Emit `shipyard-data events emit pipeline_terminal pipeline=ship-execute sprint=<id> outcome=success reason=hotfix_ready`. Print:

   ```
   Hotfix ready. Review with /ship-review --hotfix B-HOT-NNN
   ▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.
   ```

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

Claude Code's `--continue` restores conversation history but not project state (which wave, which task). Shipyard bridges with HANDOFF.md AND with the EXECUTE-CURSOR.md cursor. They serve different purposes:

- **EXECUTE-CURSOR.md** — automatic per-tick cursor. Written by every stage transition, read at every invocation entry. The authoritative `stage:` field is what compaction-recovery and `/loop`-driven resume read.
- **HANDOFF.md** — explicit user pause with a hand-written note. Written only when the user says "pause"/"stop"/"break" (or the session is ending) and a human-readable handoff is wanted for the next session.

Both can coexist on disk. **On resume, HANDOFF.md takes precedence over the cursor** — because the user wrote HANDOFF.md deliberately, it represents their explicit intent for what tick N+1 should focus on, whereas the cursor only captures the last-known automatic state. After HANDOFF.md is consumed and deleted, write a fresh cursor at the documented next stage (typically `wave_<N>_dispatch`) so subsequent automatic ticks have a cursor to read.

**On pause** (user says "pause"/"stop"/"break", or session ending): Write `<SHIPYARD_DATA>/sprints/current/HANDOFF.md` with frontmatter `paused_at` / `wave` / `task` / `mode` / `branch` (plus `team_name` / `teammates` / `queued_tracks` in team mode), then sections `## Completed This Session`, `## In Progress`, `## Blocked`, `## Next Steps`, `## Decisions Made`. Also write the cursor with `status: paused`, `terminal: false`, `next_action: "Resume from HANDOFF.md"` so the `/loop` driver sees a non-terminal cursor and the next invocation reads HANDOFF.md first.

**On resume** (HANDOFF.md exists): (1) Read HANDOFF.md, (2) accumulate `paused_minutes` into SPRINT.md's `total_paused_minutes` then clear `paused_at`, (3) verify PROGRESS.md matches, (4) confirm git branch, (5) team mode only — `TeamCreate` + re-spawn teammates from the `teammates` field (previous teammates are always dead after a session break), (6) delete HANDOFF.md, (7) write a fresh cursor at the documented next stage, (8) continue from the documented next step.

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
