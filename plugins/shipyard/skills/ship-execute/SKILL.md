---
name: ship-execute
description: "Execute the current sprint in test-first waves."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, Agent, AskUserQuestion, Monitor, TaskCreate, TaskUpdate, TaskList, TaskStop, SendMessage]
model: sonnet
effort: low
argument-hint: "[--task ID] [--hotfix ID] [--mode solo|subagent|team] [--single-tick]"
---

# Shipyard: Sprint Execution

Execute sprint tasks following the wave plan. Every task follows Red → Green → Refactor → Mutate.

## Context

!`shipyard-context path`

!`shipyard-context view config`
!`shipyard-context view sprint 80`
!`shipyard-context view sprint-progress`
!`shipyard-context view codebase`

**Paths.** All Shipyard file ops use the absolute SHIPYARD_DATA prefix from the context block (no `~`, `$HOME`, or shell variables). Bash is for project test commands, git, and `shipyard-data` CLI calls. **Never `cd` into the data directory before running `shipyard-data`** — the CLIs resolve the data directory internally via git and env vars, and `cd`-ing into a non-git directory breaks the resolver. **Never use `echo`, `printf`, or shell redirects (`>`) to write state files** — use the Write tool for the non-cursor data-dir files it still owns (auto-approved for SHIPYARD_DATA). When passing paths into spawned Agent prompts, substitute the literal SHIPYARD_DATA path.

**Render before asking.** Before every AskUserQuestion, render the decision context — the scenarios, concrete examples, tradeoffs, and any verbatim content being approved — as chat text; the tool call then carries only the short question and option labels. A bare AskUserQuestion with no rendered context above it is a bug (the window is too small to carry a real decision). Rendered means printed as assistant chat text in THIS response — content that only exists in a Read result, a subagent/Agent return, a capture file, an event-log entry, or the AskUserQuestion question/option strings does not count as rendered (the UI shows a compact card).

**Deterministic state (v2.9.0).** The pipeline cursor (`EXECUTE-CURSOR.md`), `PROGRESS.md`, and SPRINT.md frontmatter are NOT written by the model — a PreToolUse hook DENIES any Write/Edit targeting them. The only writers are the `shipyard-data` CLI subcommands:

- **Cursor** — `shipyard-data cursor advance|set|resume|pause|escalate|noop execute …`. See the tick-exit contract below and [references/pipeline-cursor.md](references/pipeline-cursor.md) for the full schema, stage map, and event vocabulary. Read that reference before changing any per-tick wiring.
- **SPRINT.md frontmatter** — `shipyard-data sprint set <key> <value>` (typed atomic mutation; wave-body narrative stays model-authored).
- **PROGRESS.md** — never written by anyone but the renderer; emit events and it stays current.

Non-cursor narrative events (`task_dispatch_returned`, `wave_check_passed`, `subagent_completed`, `sprint_complete_passed`, `task_blocked`, …) are emitted via `shipyard-data events emit <type> …`. The CLI auto-emits the pipeline-lifecycle events (`pipeline_tick_started`, `pipeline_tick_completed`, `pipeline_terminal`) itself on every `cursor advance` — the model never emits those.

## Input

$ARGUMENTS

## Detect Mode

- `--task T001` → Execute single task only (sync, single-tick)
- `--hotfix B-HOT-001` → Hotfix mode (branch from main, bypass sprint; sync, single-tick)
- `--mode solo|subagent|team` → Force the dispatch shape for every wave, overriding the per-wave env-gate + track-grouping decision (Step 2). Team forced with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` unset falls back to Subagent with a one-line note.
- `--single-tick` → Force one-tick-per-invocation (direct-invocation testing of /loop semantics)
- No args → Execute full sprint from current wave

**`--task` / `--hotfix` guard.** If `EXECUTE-CURSOR.md` exists and is **non-terminal** (a sprint is live), REFUSE both modes: print *"A sprint is active (stage `<stage>`). Finish or pause it (`shipyard-data cursor pause execute --note …`) before running --task/--hotfix"* and STOP. If it exists and is **terminal but still in `current/`** (execute done, `/ship-review` pending — the sprint isn't archived yet), also REFUSE: print *"A sprint is active (stage `<stage>`). Finish or pause it before running --task/--hotfix — the terminal execute cursor is still in current/; finish /ship-review (which archives the sprint) first."* and STOP. Never `--force` through either. These modes write their own cursor and would clobber the sprint cursor.

## Acquire Locks

Run `shipyard-data lock acquire execution --skill ship-execute --sprint <id>` (see the `shipyard:acquiring-skill-lock` capability skill for the full contract). Exit 0 → proceed. Exit 3 → echo the `⛔` block text from stderr verbatim as the entire response and STOP — do not load any further context, do not call other tools. The CLI's own cross-lock guard checks the planning lock in the same call (HARD-BLOCKing if a discussion is in progress in another session), handles cleared-sentinel detection, 2h-stale recovery, and corrupt-JSON recovery — echo any recovery note the CLI prints on stderr, then proceed.

The execution lock's resting-state release is automatic: `cursor advance` (terminal), `cursor pause`, `cursor escalate`, and `cursor noop` all call `shipyard-data lock release execution --force` internally (via `bin/skill-lock.mjs`) as part of the same cursor write. Do not run `lock release` by hand on those paths. Manual release is only needed on an ABNORMAL exit that never reaches one of those four cursor calls (e.g. the skill errors out before writing any cursor state at all) — in that rare case, run `shipyard-data lock release execution --skill ship-execute` before ending the turn.

---

## Cursor + Per-Tick Advance

`/ship-execute` is /loop-friendly: every invocation reads a persistent **pipeline cursor**, dispatches to the matching stage handler, and advances the cursor for the next tick. Full schema, stage map, terminal protocol, and event vocabulary live in [references/pipeline-cursor.md](references/pipeline-cursor.md).

**Cursor location.** `<SHIPYARD_DATA>/sprints/current/EXECUTE-CURSOR.md`. One file per sprint, written only by `shipyard-data cursor`, archived with `current/` when the sprint completes.

### Tick-exit contract (applies at EVERY stage)

After a stage handler succeeds, advance the cursor with a single call:

```
shipyard-data cursor advance execute <next-stage> [k=v ...] [--note "<tick narrative>"]
```

The CLI validates the transition against the stage graph, runs the loop-leak guard + terminal-evidence gate in-process, appends `pipeline_tick_completed` (or `pipeline_terminal`), auto-emits the new stage's `pipeline_tick_started`, re-renders PROGRESS.md, and prints the marker (for terminals the `/loop should stop` marker is guaranteed the FINAL line). **Echo the CLI's stdout as the final lines of your tick output** — never emit the pipeline-lifecycle events yourself and never print your own markers. Under `loop_owner: "/loop"`, exit after echoing; under direct invocation, chain into the next handler. Because of this contract, each stage below states only its `→ <next-stage>` target plus any stage-specific `k=v`.

On a `cursor advance` **exit 3 (refused)**, do NOT retry blindly — read the reasons on stderr, fix the missing evidence (re-run the stage that emits it) or escalate. `--force` skips only transition-graph validation for crash recovery; it never skips the evidence gates.

**Pause-before-blocking-ask (load-bearing).** A tick NEVER exits with a pending question and no marker — a /loop wakeup would otherwise re-run the whole stage and re-ask. So any stage that must block on `AskUserQuestion` first runs `shipyard-data cursor pause execute --note "<question pending: …>"`, which sets the resume surface and prints the stop marker. Already wired at `sprint_full_build`, `sprint_demo_probes`, and the readiness anomaly prompt.

**Cron cleanup is CLI-prompted.** `cursor pause` / `escalate` / `noop` / terminal-advance each read the event log and print a cron-cleanup reminder line when a `pipeline_loop_bootstrap_fallback` cron was armed. Act on that reminder whenever the CLI prints it — on ANY rest path (terminal, pause, escalate, noop): `CronList` + `CronDelete` any cron whose prompt targets `/shipyard:ship-execute`. Don't compute cron state from conversation memory.

`stuck_counter` is CLI-owned: a same-stage self-loop advance auto-increments it (pass `stuck_counter=0` explicitly when the self-loop made real progress; `wave_N_waiting` is exempt — it never auto-increments). At `stuck_counter >= 5` the CLI emits `pipeline_stuck`; at the `hard_ceiling: 50` self-loop safety stop the CLI REFUSES the advance and directs you to `cursor escalate execute reason=hard_ceiling_stage_<id>`.

### Cursor read at entry (the canonical recipe — before any other work besides locks)

1. Acquire locks (above).
2. Read `<SHIPYARD_DATA>/sprints/current/EXECUTE-CURSOR.md` with the Read tool.
   - **`terminal: true`, `status: escalated`** → an escalated (recoverable) halt, NOT a completed sprint. Run `shipyard-data cursor noop execute` (the CLI detects the escalated terminal, does NOT emit a noop or arm the leak alarm, and prints the resume hint); echo it. Tell the user the sprint is resumable via `shipyard-data cursor resume execute` once the cause is fixed, then STOP.
   - **`terminal: true`** (any other status) → a leaked wakeup against a finished cycle. Run the No-op sweep below and exit.
   - **`status: paused`** → **wakeup-inert.** A `/loop` wakeup must NEVER auto-resume a paused sprint — pause is a deliberate user stop, and only the user un-pauses it. Run `shipyard-data cursor noop execute` (the CLI emits `pipeline_terminal outcome=noop reason=awaiting_user_paused`, prints the pause note + the "resume is a USER decision (`shipyard-data cursor resume execute`)" hint + the stop marker; a 2nd wakeup against the same paused sprint trips the ⛔ leak alarm pointing at resume), echo it, and STOP. Run `shipyard-data cursor resume execute` (flips to `in_progress` at the recorded stage, then dispatch to that handler using the body note as resume context) ONLY when the user explicitly asked to resume — invoked `/ship-execute` saying resume/continue, or answered a surfaced question. (See "Recovery & resume".)
   - **`terminal: false`, `status: in_progress`** → dispatch to the handler for the `stage:` field.
   - **Cursor absent** → fresh start. Begin at Pre-flight; the first `shipyard-data cursor advance execute preflight` creates the cursor.
3. **No-op terminal sweep (MANDATORY — load-bearing for /loop safety).** Even if step 2 passed as non-terminal, verify the sprint is alive against all THREE conditions below. If ANY hold, run the sweep and exit. NEVER skip it — this is the exact protection that closed the original `/loop` wakeup-leak bug, and the auto-loop bootstrap in step 4 depends on it having run with no exit. (Belt-and-suspenders with the CLI's in-process loop-leak guard, which refuses a non-terminal advance when there is no live sprint.)
4. **Auto-loop bootstrap check** (below). PRECONDITION: step 3 completed without exit.
5. Run the chosen stage's handler, then advance per the tick-exit contract.

### No-op terminal: already-completed sprint (+ loop-leak self-detection)

Trigger when the cursor is `terminal: true`, OR SPRINT.md frontmatter has `status: completed`, OR there is no active sprint in `current/` (already archived):

1. Run `shipyard-data cursor noop execute [sprint=<id>] [reason=<sprint_already_complete|cursor_already_terminal>]` and echo its output. The CLI emits `pipeline_terminal outcome=noop` FIRST (non-optional — a silent no-op is what made the original leak invisible), runs the repeat-leak scan itself, and on the 2nd no-op for the same dead sprint emits `pipeline_loop_leak_detected` and prints the hard `⛔ LOOP LEAK …` marker; otherwise it prints `▶ CYCLE COMPLETE — sprint already complete. /loop should stop.`
2. **Cron-fallback cleanup:** act on the CLI's printed cron-cleanup reminder — `CronList` + `CronDelete` any cron whose prompt targets `/shipyard:ship-execute`. Never call `ScheduleWakeup` on the no-op path.

### Auto-loop bootstrap (run AFTER the no-op terminal sweep, BEFORE dispatch)

When a user invokes `/ship-execute` directly, this skill self-bootstraps the `/loop` driver so the user never types `/loop`. The eligibility computation is entirely CLI-owned:

1. Run `shipyard-data cursor bootstrap-check execute`. It prints `{"loop_owner":"/loop"|"user","eligible":<bool>,"reason":"..."}` — evaluating loop-owner (tick-recency), mode, cursor liveness, the `auto_loop_attempted` sentinel, and the sprint-liveness re-check (the v2.2.0 wakeup-leak precondition: it never reports eligible for a dead/absent/completed sprint). When it returns `eligible: true` it also sets `auto_loop_attempted: true` on the cursor itself and emits `pipeline_loop_bootstrap_eligible`.
2. **If `eligible: true`:** emit `shipyard-data events emit pipeline_loop_bootstrap pipeline=ship-execute sprint=<id> via=auto`, then invoke `Skill(skill: "loop", args: "/shipyard:ship-execute")`, then print `▶ AUTO-LOOP STARTED — /shipyard:ship-execute is now driven by /loop. Subsequent waves will fire automatically.` and RETURN. `/loop` immediately fires iteration 1, which re-enters this skill; that re-entry sees `auto_loop_attempted: true` (bootstrap-check reports `eligible: false`) and does the real stage work. Do NOT do tick work in this outer frame.
3. **If `eligible: false`:** proceed with this tick.

The `auto_loop_attempted` sentinel is per-sprint: the next sprint does not carry `auto_loop_attempted` forward — the `current/` archive drops the cursor at sprint completion, so the next sprint's first `/ship-execute` re-evaluates eligibility from scratch.

**Fallback if `/loop` goes silent.** The `loop_owner` heuristic uses a **5-minute** tick-recency window (a stale tick reads as a dead loop), so this fallback self-heals a silent loop — and a Ctrl-C misclassification — within 5 minutes. If bootstrap-check reports `loop_owner: "user"` yet `auto_loop_attempted` is already set AND the last `pipeline_tick_completed` for this pipeline is older than that window (loop accepted the bootstrap but stopped firing), call `CronCreate(cron: "*/2 * * * *", prompt: "/shipyard:ship-execute", recurring: false)` to nudge the next tick, then proceed. Emit `shipyard-data events emit pipeline_loop_bootstrap_fallback pipeline=ship-execute sprint=<id> method=cron reason=loop_silent`. Normal operation never triggers this.

### Direct invocation vs /loop driver — the dispatch contract

- **`loop_owner: "user"` (direct):** the current stage handler runs and CHAINS into the next stage within the same invocation, until a user-input gate (AskUserQuestion), the terminal stage, or a ~10-minute wall-clock budget is exhausted. On budget exhaustion, advance to the next pending stage and exit so the next invocation resumes cleanly. This is the FULL SPRINT mandate below (sprint-start to sprint-done without per-wave hand-off).
- **`loop_owner: "/loop"`:** one stage per tick — run the handler, advance the cursor, echo the marker, exit. /loop schedules the next wakeup and the next tick re-reads the cursor.

Both share the same stage handlers and the same cursor; the only difference is chain-vs-exit between stages.

### Pause is a cursor state (v2.9.0). HANDOFF.md is retired

A user-initiated pause is `shipyard-data cursor pause execute --note "<why / resume context>"` — the CLI sets `status: paused`, keeps the current `stage:`, stores the note as the cursor body, and clears the execution lock. There is no second hand-written artifact (the old HANDOFF.md) to reconcile — the paused cursor is the single authoritative resume surface.

---

## Pre-flight (stage_id: preflight)

Fresh start creates the cursor here; run these gates, then advance to `salvage`. Skip the /goal-mode gates on `--task`/`--hotfix`.

1. **Status check.** Run the `/ship-status` validation silently (Check 1–7). This catches stale state, tasks marked done without commits, broken references, and schema issues before spending tokens. Anything auto-fixable that requires a code or spec change is delegated (never hand-edited here); if critical issues remain (e.g., sprint references non-existent tasks), report and stop.
2. **/goal-mode gates.** `/ship-execute` runs /goal-shaped by default (sprint-start to sprint-done, halting only on documented escalation contracts). Seven pre-flight gates refuse entry when a known-ambiguous condition exists so /goal never compounds a structural problem. Run each in order; first failure emits `shipyard-data events emit sprint_goal_preflight_failed gate=<name> sprint=<id>` and halts with an actionable message. Gate names, checks, rationale, and fix copy: [references/goal-mode-preflight.md](references/goal-mode-preflight.md).
3. **Git repository check.** Builder agents use worktree isolation, so verify git is ready:
   - `git rev-parse --git-dir` — fails → not a git repo.
   - `git log -1` — fails → no commits.
   - `git status --porcelain` — note a dirty tree but do NOT ask here. The readiness anomaly prompt (Step 1.5) owns the Commit/Stash/Continue decision so a fresh start asks at most once, and never when the tree is clean.
   - If the repo/commit checks fail → `git init` (if needed) then `git add -A && git commit -m "chore: initial commit"`. Worktree isolation requires at least one commit.

   **DO NOT check if the project is a worktree. DO NOT fall back to solo mode because of worktrees.** The WorktreeCreate hook handles all worktree scenarios (including nested) by creating them from the parent repo. Use the mode determined by task count; never downgrade for git worktree state.

**→ `salvage`** (`shipyard-data cursor advance execute salvage`).

## Operating Principles

- **This shell runs on Sonnet and does NO thinking.** Its job is checklist execution: read the cursor, run the stage handler, make CLI calls, read the event log, keep dispatch bookkeeping. It does NOT diagnose, weigh tradeoffs, or interpret ambiguity. EVERY judgment call escalates to the think tier via `shipyard:escalating-to-thinker` — there is no silent absorption of ambiguity. Recovery-path ambiguity, an exit-3 whose reason has no documented remediation, and a bug-vs-structural deviation call are all escalation triggers (below), not things this shell decides. User decisions still go to AskUserQuestion; structural gates still always outrank a consult recommendation.
- **LSP first.** Use LSP (`documentSymbol`, `goToDefinition`, `findReferences`, `hover`) before Grep/Read for all code navigation; fall back silently if unavailable. Pass this to builder subagents. Full strategy: `references/lsp-strategy.md`.
- **Stay lean as orchestrator** (~10-15% context). Pass file paths to subagents, not contents. State lives in the cursor / PROGRESS.md / the event log, not conversation. Spot-check results before trusting them. Full guide: `references/context-management.md`.
- **Git strategy.** Work on the user's current branch — no sprint branches, no pushes. Solo commits directly; subagent mode uses per-task worktrees that rebase back at wave end (the only shape with worktree isolation); team mode has NO worktrees — teammates share the working tree and commit directly to the working branch, partitioned by disjoint file sets. Worktrees branch from current local HEAD. Atomic commits per task. Full strategy: `references/git-strategy.md`.
- **Output capture.** Test/build/E2E verification runs are dispatched via `shipyard:dispatching-operational-task`, which captures stdout+stderr to `<SHIPYARD_DATA>/captures/<task_id>/run-<N>.log` via plain `tee` (no `shipyard-logcap` dependency). Don't run verification commands directly in this session — delegate.
- **Communication.** Blocker reports and decisions use the 3-layer pattern (one-liner / context / options); keep under 100 words; always recommend a default. Full guide: `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md`.

## FULL SPRINT Execution

**CRITICAL: Execute the ENTIRE sprint to completion.** Do not pause between waves to ask whether to continue, do not suggest re-invoking `/ship-execute`, do not suggest `/clear` between waves. Execute wave after wave until all tasks are done, then report completion. The only reasons to stop mid-sprint: (1) an unresolvable blocker needing user input (AskUserQuestion), (2) a structural deviation needing a user decision (Deviation Rules), or (3) the user explicitly says "pause"/"stop".

### Step 0: Worktree Salvage (stage_id: salvage) (always runs first)

**First:** `shipyard-data clean-worktrees` — removes worktrees whose branches are already merged or whose remote tracking is `[gone]`, plus orphaned `shipyard/wt-*` branches with no worktree directory. This catches orphans from prior crashed sprints where wave-boundary cleanup never ran.

**Also:** `shipyard-data ensure-worktree-baseref` — sets `worktree.baseRef: "head"` in the project's `.claude/settings.json` (idempotent atomic JSON read-merge-write that preserves every other key — never a model hand-edit, which is the corruption class that welded `status: done` + `effort: M` into `status: doneeffort: M`). Verifying it every sprint is self-healing and independent of `/ship-init`. It is the backstop for when the `WorktreeCreate` hook does not fire (native creation would otherwise fork from `origin/<default>` and drop earlier waves' local commits).

**Then:** `git worktree list`. If no `shipyard/wt-*` paths remain, skip to Step 1. Otherwise, for each leftover `shipyard/wt-*` worktree (unmerged — the merged ones were cleaned above):

1. **Salvage uncommitted work** if present: `git -C <worktree> add -A` then `git -C <worktree> commit -m "wip(TASK_ID): salvage from interrupted session"`. Task ID is the branch suffix.
2. **Rebase + ff-merge** the branch onto the working branch. Conflicts → keep the branch and skip the merge; the task-status update in step 4 (`blocked`) is what emits `task_blocked` — do not also emit it here.
3. **Remove the worktree** (`git worktree remove`) and delete merged branches.
4. **Update task status** via `shipyard-data task set-status <id> <status>`: `done` if a real commit landed, `in-progress` for WIP-only salvages, `approved` (re-execute) if nothing to salvage, `blocked --reason "shipyard/wt-X has conflicts — manual merge needed"` for conflicts (this auto-emits `task_blocked`, satisfying the terminal gate's parking evidence — no separate emit needed).

Anthropic's stale-worktree cleanup (per `cleanupPeriodDays`) handles worktrees with no uncommitted changes / no untracked files / no unpushed commits automatically; Step 0 covers only the cases that sweep skips. The working branch now contains all recoverable work; new worktrees in Step 2 branch from this consolidated state.

**→ `load`** (`stuck_counter=0`).

### Step 1: Load Sprint Plan (stage_id: load)

Read SPRINT.md (wave structure — task IDs grouped by wave, critical path, execution mode) and PROGRESS.md (current wave, blockers, session log). For each task ID in the current wave, read its task file (title, effort, status, dependencies, parent feature).

**Detect session type:**

1. **`status: paused` cursor** → graceful resume (see "Recovery & resume"). Worktrees already salvaged in Step 0.
2. **No paused cursor, but PROGRESS.md shows tasks done OR Step 0 salvaged work** → crash recovery. Resume from the current wave.
3. **No paused cursor, no tasks done, Step 0 found no worktrees** → fresh start. Record the working branch: `git branch --show-current`, then `shipyard-data sprint set branch <current branch>` if not set.

**Record sprint start time (idempotent):** if SPRINT.md `started_at` is null/absent, `shipyard-data sprint set started_at <ISO 8601>`. If already set, leave it — resuming a pause must never reset the clock.

**Create the wave task checklist (fresh start only, mirror only).** Once the wave structure is known (parsed above from SPRINT.md `### Wave N` bodies), `TaskCreate` one task per wave plus two bookends — preflight/load and sprint-complete — in one batch, subject-prefixed `[sprint-<id>] ` to keep this checklist distinguishable from `/ship-sprint`'s `[sprint-plan] Step N:` planning checklist and from team-mode's per-teammate build tasks:

| Subject |
|---|
| `[sprint-<id>] Preflight & Load` |
| `[sprint-<id>] Wave 1: <n> tasks` |
| `[sprint-<id>] Wave 2: <n> tasks` |
| … one per wave … |
| `[sprint-<id>] Sprint Complete & Demo Probes` |

Mark the Preflight & Load task `completed` immediately (this step just ran it). On resume/crash-recovery, do NOT recreate — check `TaskList()` first; if this sprint's tasks already exist, leave them as-is (a wave already `in_progress`/`completed` reflects prior progress).

**Update on wave transitions, gated.** `TaskUpdate` a wave task → `in_progress` when that wave's `wave_<N>_dispatch` stage fires; → `completed` **only after** `shipyard-data verify-wave-integrated` passes AND the cursor advances past that wave's `wave_<N>_gate` (Step 4 item 9's `→ wave_<N+1>_dispatch` advance). Never mark a wave task `completed` on a builder's return claim alone. A wave that parks a task (`needs-attention`) or escalates: leave its task `in_progress` (visible, not silently dropped) — do not mark it completed. Mark `[sprint-<id>] Sprint Complete & Demo Probes` `completed` only after `sprint_complete_gate` (Step 5.4) passes.

**Guardrail (load-bearing): the wave task list is a progress surface and a recovery anchor, NEVER authority.** Do not gate any behavior on TaskList state, do not cite task status as evidence a wave ran, and never mark a wave task completed before `verify-wave-integrated` passes. The cursor, PROGRESS.md, and the event log remain the record; the tasks are the user-visible mirror.

**→ `readiness`** (fresh) or **`wave_<current_wave>_dispatch`** (resume / crash recovery).

### Step 1.5: Execution Readiness Check (stage_id: readiness) (fresh-start only)

State a compact READINESS banner before any code is written, then advance straight to `wave_1_dispatch` — **invoking `/ship-execute` IS the consent to execute**, so a clean fresh start never asks "Begin?". Skip entirely on resume / crash recovery.

```
STARTING sprint-NNN: N tasks / M waves, <solo|subagent|team> mode, baseline tests <pass|fail|not-run>.
  Branch: <current> [matches SPRINT.md branch]
  Wave 1: <task IDs + titles + effort>
  Risks: <top 2-3 from SPRINT.md>
Type "pause" any time to stop.
```

**Anomaly prompt (the ONLY ask on a fresh start — one ask max, zero when clean).** For each firing condition, render its evidence as chat text before the ask — the failing baseline test tail, the two branch names, the leftover `shipyard/wt-*` branch name, or the `git status --porcelain` listing. Evidence sitting in a Bash result the user never saw does not count; the option labels carry only the choice. Fire a single `AskUserQuestion` iff ANY of these hold; otherwise advance without asking:

- **Baseline tests FAIL** — a red baseline muddies every wave's signal. Option: **Investigate** (Recommended) / Proceed anyway.
- **Current branch ≠ SPRINT.md `branch:`** — new worktrees would fork from the wrong commit. Option: **Switch to <working branch>** (Recommended) / stay.
- **A leftover `shipyard/wt-*` branch is checked out** — add *"⚠️ WORKTREE BRANCH DETECTED — Shipyard will switch to <working branch> before spawning agents."* Option: **Switch to <working branch>** (Recommended).
- **Dirty working tree** (`git status --porcelain` non-empty) — worktree agents start from the last commit, so uncommitted changes won't reach them. Option: **Commit now** ('wip: pre-sprint', Recommended) / Stash / Continue.

Merge all firing conditions into ONE prompt (one question item per condition, each with its recommended default above). **If a /loop driver owns this tick, run `shipyard-data cursor pause execute --note "readiness anomaly: <which>"` BEFORE the AskUserQuestion** (pause-before-blocking-ask — a wakeup can't re-run readiness and re-ask; the pause note is the resume surface). The `using-worktrees` capability skill encodes the trust-the-platform model; `dispatching-task-loop`'s HARD STOP catches genuinely-broken isolation.

**→ `wave_1_dispatch`** (`wave_number=1 iteration=1`) when clean, or after the anomaly prompt resolves toward proceeding. If the user aborts from the anomaly prompt: `shipyard-data cursor escalate execute reason=readiness_anomaly_aborted`; echo and halt.

### Step 2: Execute Waves (stage_id: wave_N_dispatch)

Per-wave stage IDs: `wave_<N>_dispatch`, `wave_<N>_redispatch_iter_<K>` (K∈{1}), then `wave_<N>_boundary` → `_build` → `_refactor` → `_tests` → `_verify` → `_gate` (Step 4). After the last wave's gate → `sprint_full_build` (Step 5).

**ALWAYS delegate task execution to subagents** — every task runs in a fresh context window, keeping the orchestrator lean. The dispatch shape determines parallelism and delegation depth, not whether subagents are used.

**Dispatch shape (decided per wave):**

Decide by an env-gate plus track grouping — never by raw task count alone, and never by probing for a `TeamCreate` tool (that tool doesn't exist; Agent Teams are implicit — a team auto-creates on the first teammate spawn that carries a `team_name`, and `team_name` is otherwise ignored). A "track" is the set of this wave's tasks that share a parent feature (read each task's `feature:` frontmatter field to group them).

- **Subagent is the DEFAULT for build waves.** Worktree-per-task isolation plus branch-based integration (`verify-wave-integrated`) is the only dispatch shape that preserves both, and builds are exactly where that matters. Dispatch **parallel**, up to `execution.max_parallel_agents` at a time (default 3, hard ceiling 4); more tasks than the cap → **batch**: spawn N, await + run post-subagent checks, then spawn the next batch from updated HEAD. Prevents the quality degradation seen when 6-7 agents run at once.
- **Solo** for a single task, or a wave whose tasks are all trivial (no shared track worth the teammate-spawn overhead) — subagents dispatched **sequentially** on the same branch, no worktree isolation needed.
- **Team is opt-in, experimental, and for partitioned coordination — not a build default.** Agent Teams are gated on `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` being set in this session's environment; teammates do **not** get worktree isolation by design (Claude Code #37549 — teams isolate by file-ownership partition, not by directory), so there are no per-task `wt-*` branches and `verify-wave-integrated`'s branch-merge check is inert in team mode. Reserve Team mode for coordination-heavy, file-partitioned work where that tradeoff is acceptable, not as the blanket build-path replacement. Full protocol: `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/team-mode.md`.
- **`--mode` always forces** the shape named, overriding the env-gate/track-grouping decision above.
- **Team forced but unavailable** (`--mode team` with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` unset) → fall back to Subagent shape and report it: "Team mode requested but Agent Teams isn't enabled in this session (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` not set) — running as Subagent instead."

#### Pre-spawn Branch Check (subagent AND team mode)

Before spawning any worktree agents, verify the orchestrator's branch: `git branch --show-current`, and read `branch` from SPRINT.md frontmatter.

- **On a `shipyard/wt-*` branch** → the orchestrator is inside a leftover worktree or the user checked out a worktree branch; new worktrees would branch from the wrong commit. `git checkout <sprint working branch>` first. Report: "WARNING: Orchestrator was on worktree branch [name], switched to [working branch]."
- **Branch doesn't match SPRINT.md** → `git checkout <branch>` first.

The WorktreeCreate hook branches worktrees from the current local branch — a wrong orchestrator branch forks every worktree from the wrong place.

#### Task Kind Routing (REQUIRED before every dispatch)

Read the task file frontmatter and check `kind:` — the dispatch path depends on it; getting this wrong is how the silent-pass bug happens.

- **`kind: feature`** or **absent** → standard feature-builder dispatch via `shipyard:dispatching-task-loop` (documented below).
- **`kind: operational`** → invoke `shipyard:dispatching-operational-task` (owns verify_command resolution, run+capture, bounded fix loop from `operational_tasks.max_iterations`, and the orchestrator-side gate: verify_output populated, capture non-empty, final exit:0, LAST_LINES match).
- **`kind: research`** → invoke `shipyard:dispatching-research-task` (owns the Write-scope HARD GATE, the Findings Doc Template, and the orchestrator-side gate: file exists + ≥1 `### Finding` section + porcelain-clean).

**Why this matters.** The silent-pass failure mode — marking "run E2E suite and fix findings" tasks done without running any tests — is the exact bug when operational tasks hit the feature builder: no Red step, clean exit on an empty tree, trivial "Before Exiting" pass. This router is the primary fix; `dispatching-task-loop`'s Step 0 HARD STOP (refuse any `kind: operational`) is defense in depth.

**Builders may write IDEA files during task execution** — up to 3 `IDEA-*` files to `<SHIPYARD_DATA>/spec/ideas/` for deferred unknowns / scope-adjacent rot, committed atomically with the task. IDEAs surface in `/ship-sprint`'s carry-over scan and `/ship-backlog`. The capture rules are inlined in `dispatching-task-loop`'s prompt template.

#### Per-task dispatch (solo + subagent modes — kind: feature only)

For each task, **invoke `shipyard:dispatching-task-loop`** — do NOT construct an Agent dispatch inline. That skill owns the prompt template (three Iron Laws inlined), the structured-return contract, the orchestrator-side gate (sha verify + PROBE_EXIT:0 check + anti-stub-scan), the iteration cap, and the single-redispatch rule.

Parameters:

| Parameter | Value |
|---|---|
| `task_id` | e.g., `T-042` |
| `task_file_path` | `<SHIPYARD_DATA>/spec/tasks/[TASK_ID]-*.md` (literal SHIPYARD_DATA path) |
| `feature_file_path` | `<SHIPYARD_DATA>/spec/features/[FEATURE_ID]-*.md`, or null for hotfix |
| `working_branch` | `branch:` from SPRINT.md frontmatter |
| `acceptance_probe` | `acceptance_probe:` from task frontmatter (HALT and surface to user if missing — task is unauthorable without one) |
| `data_dir` | literal SHIPYARD_DATA path |
| `worktree_path` | null in solo mode; absolute worktree path in subagent/team mode |
| `sprint_id` | `id:` from SPRINT.md frontmatter |
| `wave_number` | current wave number from the cursor |
| `dispatch_mode` | `background` for wave-dispatch and sprint-test-fix-redispatch; `sync` for `--task`/`--hotfix` |

In subagent/team mode the capability skill dispatches with `isolation: "worktree"` (per `using-worktrees`); in solo mode, no isolation. It handles both transparently, and returns a structured verdict (`STATUS: COMPLETE` + `COMMIT: <sha>` + `PROBE_OUTPUT_TAIL` after orchestrator-side verification, or `STATUS: BLOCKED`). **Do not parse subagent output yourself.**

Capabilities used per task: `shipyard:dispatching-task-loop` (internally `shipyard:verifying-completion`, `shipyard:tdd-cycle`, `shipyard:running-acceptance-probe`, `shipyard:anti-stub-scan`, `shipyard:using-worktrees`).

**Background dispatch (the default for wave-dispatch in v2.5.0+).** `dispatching-task-loop` owns the full background mechanics; the orchestrator's part: the Agent call uses `run_in_background: true` and returns a task handle immediately (record it — the timeout path needs it to `TaskStop` a zombie); then emit `shipyard-data events emit wave_<N>_dispatched_bg pipeline=ship-execute sprint=<id> wave=<N> task_ids=<csv>` and advance `→ wave_<N>_waiting` with `pending_subagents='[…]'` (one entry per spawned task: `{"task_id","spawned_at":<iso>,"max_execution_minutes":<task frontmatter or 60>}`), and arms a persistent Monitor on `<SHIPYARD_DATA>/.shipyard-events.jsonl` filtered for `subagent_completed pipeline=ship-execute sprint=<id> wave=<N>`; then exit. Each subagent runs its Cycle in the background and, per the `dispatching-task-loop` contract, records its structured return via `shipyard-data task-return` — which writes `<SHIPYARD_DATA>/sprints/current/.subagent-returns/<task_id>.json` (keys: `task`, `status`, `commit_sha`, `probe_exit_code`, `escalation_code`, `output_tail`) — and emits `subagent_completed` whose `capture_file=` points at that `.json`; the Monitor then fires a `<task-notification>` to `/loop`, which wakes and reads `stage: wave_<N>_waiting`.

The orchestrator never reads the Agent tool's return value in background mode — the structured-return contract is preserved via the `.json` capture file (read it as JSON; never regex for `STATUS:` lines), and the wake signal is the event log.

Wrap each subagent-dispatching stage (`wave_<N>_dispatch`, `wave_<N>_redispatch_iter_<K>`, `sprint_tests_fix_iter_<K>`) with the live-progress streamer so subagent `task_loop_iteration` events surface in the user's chat during the otherwise-silent minutes. Pattern: [references/live-streaming.md](references/live-streaming.md).

#### Post-Subagent gate (all modes)

Most kind-specific gating lives inside the dispatching-* skills (sha verify, PROBE_EXIT:0 check, anti-stub-scan, exit-0 + capture checks, findings-doc + porcelain checks). Orchestrator-side checks are minimal:

- **`kind: feature`:** verify key files exist + commits present (`git log --grep="TASK_ID"`); **item completeness** — if Technical Notes lists discrete items (e.g., "migrate 8 calls"), grep the diff for each, <100% covered → re-dispatch with the missing list as `continuation_note`; **no-commits salvage** — dirty worktree → WIP-commit + re-dispatch with a continuation note, clean worktree (did nothing) → `shipyard-data task set-status <id> approved`; single re-dispatch per task per wave, persistent failure → `shipyard-data task set-status <id> needs-attention --reason "salvage_failed"`; **effort-gated single-task spec check** — for `effort: M|L|XL`, invoke `dispatching-spec-review` `scope: "task"` (skip `effort: S`); **merge** — rebase + ff-merge the worktree branch, remove worktree, delete merged branch.
- **`kind: operational`** / **`kind: research`:** the capability skill's gate is authoritative; record the verdict and advance.

**→ `wave_<N>_waiting`** (background) — see the waiting handler. In sync mode (`--task`/`--hotfix` only): all COMPLETE → `wave_<N>_boundary`; any BLOCKED → `wave_<N>_redispatch_iter_1 iteration=<n+1>`.

#### Wave waiting handler (stage_id: wave_N_waiting)

When `/loop` re-enters at `wave_<N>_waiting`:

1. **Read the event log** (`<SHIPYARD_DATA>/.shipyard-events.jsonl`). Filter for `subagent_completed pipeline=ship-execute sprint=<cursor.sprint_id> wave=<N>`; build `task_id → event`.
2. **Match against `pending_subagents`.** Each entry:
   - Has a matching event → COMPLETED; queue for gate-verification in `wave_<N>_recovery`.
   - No event AND `now - spawned_at < max_execution_minutes` → still in flight; leave it.
   - No event AND `now - spawned_at >= max_execution_minutes` → **before declaring TIMED OUT, check for a recent `task_loop_iteration` event for that task** (a live slow builder is not dead — leave it in `pending_subagents` to extend). Only on genuine timeout (no recent iteration): `TaskStop` the task's background Agent handle so a zombie can't keep committing, `shipyard-data task set-status <id> needs-attention --reason "timed_out"`, remove from `pending_subagents`, emit `shipyard-data events emit subagent_timeout pipeline=ship-execute sprint=<id> wave=<N> task=<id> minutes=<N>` (keep this emit — it carries the timeout duration, which the generic task-status event doesn't capture).
3. **`pending_subagents` still non-empty** → advance `→ wave_<N>_waiting` with the pending list minus timed-out entries (same-stage self-loop). Echo and exit; the Monitor stays armed (re-arm if absent).
4. **`pending_subagents` empty** → advance `→ wave_<N>_recovery`; disarm the Monitor (`TaskStop` the armed Bash task).

#### Wave recovery handler (stage_id: wave_N_recovery)

Reads each subagent's capture file and runs the orchestrator-side gate:

1. **For each COMPLETED subagent**, read the `.json` capture referenced by the `subagent_completed` event's `capture_file=<path>` field — the record written by `shipyard-data task-return` (keys `task`, `status` COMPLETE|BLOCKED, `commit_sha`, `probe_exit_code`, `escalation_code`, `output_tail`), NOT the freeform STATUS/COMMIT text of an inline return. The CLI already refused any COMPLETE record with a non-zero probe exit, so a well-formed `.json` is trustworthy on that axis; a missing or unparseable `.json` is a contract violation (treat as BLOCKED). Never regex for `STATUS:` lines.
2. **Run the orchestrator-side gate per task from the `.json` fields** — follow `dispatching-task-loop`'s "Orchestrator-Side Parsing and Gating" section verbatim: sha `cat-file` verify, PROBE_EXIT:0 check, non-empty output tail, anti-stub-scan on the diff, and on pass `shipyard-data anchor-commit <task> <sha>` (pins `shipyard/keep-<task>` so the commit survives teardown/rebase) + emit `shipyard-data events emit task_dispatch_returned pipeline=ship-execute task=<id> status=complete commit_sha=<sha>` BEFORE marking done; on BLOCKED, the escalation-code routing + the blocked-return `task_dispatch_returned status=blocked` emit. That section is the single orchestrator choke point — the same orchestrator-side gate that runs in sync mode — in both modes; this handler exists only because in background mode the gate runs a different iteration than the dispatch, so do not fork its logic. Missing the anchor + emit reopens the v2.8 orphan vector and starves the terminal gate.
3. **Decide next stage:** all COMPLETE + all gates pass → `wave_<N>_boundary`; any BLOCKED or gate failure → `wave_<N>_redispatch_iter_1 iteration=<n+1>` (redispatch is a SYNC dispatch, single attempt); TIMED-OUT tasks are already `needs-attention` (no re-dispatch).

### Step 3: Per-Task Execution (implementation only)

Each task: **write tests → write implementation → run acceptance probe → commit**. Tasks do NOT execute the test suite — wave-scoped tests run at the wave boundary (Step 4), the full suite at sprint completion (Step 5). The per-task acceptance probe is the only check that fires inside the task. Full cycle: `shipyard:tdd-cycle` (canonical Iron Law + Red→Green→Refactor); `dispatching-task-loop` inlines the same Iron Law into every subagent prompt.

1. **READ SPEC** → what to build. 2. **READ CODEBASE** → existing patterns. 3. **PLAN**. 4. **RED** → write failing tests (do NOT run them). 5. **GREEN** → implement; trust the test contract. 6. **PROBE** → run `acceptance_probe:` (single command, exit 0 + observable output). 7. **COMPLETENESS** → if Technical Notes lists discrete items, grep to confirm each. 8. **COMMIT** → `feat(TASK_ID): [description]`, set task `status: done`.

Tests are always written before implementation; only test *execution* is deferred. Do not Write/Edit PROGRESS.md — emit events (`task_blocked`, `task_status_changed`, `patch_task_created`, `wave_check_passed`, …) and the render-progress hook keeps it current.

### Step 4: Wave Boundary Check (stage_ids: wave_N_boundary → _build → _refactor → _tests → _verify → _gate)

Each numbered item is its own stage; the cursor advances stage-by-stage. Under `/loop` each is one tick; under direct invocation they chain.

1. **Rebase + ff-merge, then gate, then tear down — in that order.** Integrate first, verify integration, then remove worktrees. Tearing a worktree down before its branch is merged is exactly what orphaned six verified task commits in the v2.8 incident.
   a. **Integrate each `shipyard/wt-*` branch of a GATE-PASSED task**, one at a time in task-ID order: `git rebase <working-branch>` → `git checkout <working-branch>` → `git merge --ff-only`. **Do NOT remove the worktree yet.** Conflicts → render the conflict as chat text first (branch name, conflicting file list, the relevant `git status` lines — git output you read is not shown to the user until you print it), then AskUserQuestion; never fall back to a regular merge (creates fork lines). **A parked task's branch (timed-out / persistent-BLOCKED, marked `needs-attention`) is NOT merged** — salvage it instead: `shipyard-data anchor-commit <task> <sha-of-branch-tip>` → `git worktree remove --force <path>` → `git branch -D shipyard/wt-<name>` (safe: anchored), so `verify-wave-integrated` Check A passes without merging unverified work.
   b. **Gate before teardown:** `shipyard-data verify-wave-integrated`. Over git ground truth (never the unreliable `worktreeBranch` field) it proves every live `shipyard/wt-*` branch is merged into the working branch AND no `COMPLETE` return commit is dangling. Exit 0 → it emits `wave_integration_verified`; proceed to (c). **Exit 3 → HARD STOP:** do NOT remove any worktree (work is safe on the `shipyard/wt-*` branches + `shipyard/keep-*` anchors). Integrate the named branches and re-run the gate once; if that one documented remediation doesn't clear it, invoke `shipyard:escalating-to-thinker` (trigger: `integration_gate`, subject: the wave / named branches); only if it declines, returns low confidence, or its recommendation also fails, render the gate's stderr output — the named un-integrated branches and dangling commits — verbatim as chat text, then AskUserQuestion. CLI output you saw in a Bash result does not count as shown until echoed.
   c. **Tear down only past the gate:** per merged branch, `git worktree remove` → `git branch -d shipyard/wt-<id>` (`-d`, never `-D`: refuses an unmerged branch — the final backstop). Then `shipyard-data clean-worktrees` as a sweep.
2. **Clean orchestrator branch.** `git status --porcelain` must be empty after merges. Legitimate state changes (task status frontmatter) → commit `chore(shipyard): wave [N] state update`. Unexpected source-file changes → print the `git status --porcelain` listing of the unexpected files as chat text, then AskUserQuestion. Never include manual PROGRESS.md edits.
3. **Emit `wave_check_passed wave=<N>`** — the structural signal the wave completed cleanly. PROGRESS.md's `current_wave` updates on the next cursor write. **→ `wave_<N>_build`.**
4. **Wave-scoped build (stage_id: wave_N_build)** — if `build_commands.scoped`/`.full` configured, invoke `shipyard:dispatching-operational-task`; failure → re-dispatch it for a bounded fix loop (`→ wave_<N>_build_fix_iter_1`). **If unconfigured, still advance as a pass-through tick** (the graph has no skip edges). **→ `wave_<N>_refactor`.**
5. **Wave REFACTOR + MUTATE (stage_id: wave_N_refactor)** — dispatch a `general-purpose` subagent with an inline wave-refactor prompt (read the combined wave diff, dedupe + rename + add helpers, run a small mutation check, commit if changes). **Model tier (build):** pass `model: <models.build>` from the `!` context / `<SHIPYARD_DATA>/config.md` if non-empty, else OMIT `model:` (inherit session model); never hardcode a literal. Not a wave blocker — on failure emit `task_status_changed type=refactor_failed` and advance. **→ `wave_<N>_tests`.**
6. **Wave-scoped tests + single fix (stage_id: wave_N_tests)** — invoke `shipyard:dispatching-operational-task` with `test_commands.scoped` (or `.unit` if no scoped variant). First time tests run for the wave's merged code; the operational task streams progress/failures via Monitor. Failure → ONE re-dispatch via `shipyard:dispatching-task-loop` with the failing-test list as `continuation_note` (`→ wave_<N>_tests_fix_iter_1`); persistent failure emits `task_status_changed type=wave_tests_failed` and advances. **→ `wave_<N>_verify`.**
7. **Wave VERIFY (stage_id: wave_N_verify)** — invoke `shipyard:dispatching-spec-review` `scope: "wave"`, `target_ids: [task_ids]`, `base_ref` (pre-wave HEAD), `head_ref` (current HEAD). FINDINGS → single re-dispatch per task via `dispatching-task-loop` (`→ wave_<N>_redispatch_iter_1`); persistent gaps → `needs-attention` and surface to `/ship-review`. **→ `wave_<N>_gate`.**
8. **Wave COMPLETION GATE (stage_id: wave_N_gate)** — invoke `shipyard:verifying-wave-completion` with `wave_number`, `task_ids`, `data_dir`, `working_branch`, `wave_base_sha`, `wave_head_sha`, `wave_probe_capture`, `wave_probe_exit_code`. It runs the six-invariant composite check with ScheduleWakeup-based recovery for RECOVERABLE misses and structured escalation otherwise.

   **Nested-loop note — the outer cursor must NOT duplicate this loop.** `verifying-wave-completion` has its OWN internal ScheduleWakeup state machine (budget 3, 180s warm-cache delay). From the outer cursor's view, `wave_N_gate` is ONE tick that either returns `STATUS: COMPLETE` (advance) or `STATUS: ESCALATED` (`cursor escalate`, AskUserQuestion, do not advance). Two layers, two pacers, no double-loop.

9. **Report and continue** — emit `Wave [N]/[M] ✓ [████░░░░] [done]/[total] tasks • → Wave [N+1]`. Under direct invocation: auto-advance into the next wave's dispatch (no pause, no `/clear`, no "continue?"). **→ `wave_<N+1>_dispatch`** (`wave_number=<N+1> iteration=1 stuck_counter=0`), or **`sprint_full_build`** (`stuck_counter=0`) if `N == M`.

### Recovery & resume

Files are the source of truth — never rely on conversation memory for wave/task state. **Call `TaskList()` first** as a structured position anchor: if `[sprint-<id>] Wave N:` tasks exist, the last non-`completed` one names the wave likely in flight. Confirm against the cursor + event log before trusting it — if they disagree, the cursor, PROGRESS.md, and the event log win (the task list is a mirror, never authority). Then triage by cursor state:

| Situation | Signal | Action |
|---|---|---|
| **Compaction recovery** | context cleared mid-run; cursor present | The cursor's `stage:` is authoritative — dispatch to that handler and resume. Absent cursor → rebuild from PROGRESS.md `current_wave` + task-file `status`, confirm `git branch`, resume from the first non-done task, then `cursor advance execute wave_<N>_dispatch --force` (a mid-wave stage is never an entry stage, so recovery always needs `--force`). Corrupted cursor (unparseable YAML / missing fields) → refuse: *"EXECUTE-CURSOR.md is corrupted. Run `/ship-status --repair` first."* |
| **Pause / resume** | `status: paused` | **Wakeup-inert** — a bare `/loop` wakeup runs `cursor noop execute` and STOPS (never auto-resumes; resume is a USER decision). Resume ONLY on an explicit user resume/continue: read the paused cursor's `stage:` + body note, confirm `git branch` matches SPRINT.md `branch`; team mode only, re-spawn teammates from the note (previous teammates are dead after a session break — the first re-spawn carrying `team_name` implicitly recreates the team); then `shipyard-data cursor resume execute` (flips `status` back to `in_progress` at the recorded stage) and continue from that stage. |
| **/goal-mode crash** | `status: in_progress`, no clean pause | The event log is the source of truth. Follow [references/resume-from-event-log.md](references/resume-from-event-log.md): scan for the last `wave_check_passed`, cross-check the registry, re-verify last-clean-wave invariants with `wakeup_budget: 0`, re-dispatch incomplete tasks, advance. Empty/corrupted log → refuse, run `/ship-status --repair`. |
| **Crash during `wave_N_waiting`** | cursor at `wave_N_waiting` from a prior session | The background agents died with that session — do NOT wait out their timeouts. Route the still-pending tasks straight to re-dispatch (`wave_<N>_redispatch_iter_1`); Step 0 salvage already recovered any worktree commits they committed. |

Step 0 (worktree salvage) has already run before any resume path. Works alongside `claude --continue`, which restores conversation but not project state — the cursor bridges the gap. HANDOFF.md is retired (v2.9.0): the paused cursor is the single resume surface, superseding the old second file. Paused-duration accounting (`total_paused_minutes`) is not carried in v2.9.0; the pause note is the record of when/why.

### Step 5: Sprint Completion (stage_ids: sprint_full_build → sprint_full_tests → sprint_demo_probes → sprint_complete_gate → terminal_handoff_to_review)

When all waves are done:

1. **Full build (stage_id: sprint_full_build)** — if `build_commands.full` configured, invoke `shipyard:dispatching-operational-task` (catches cross-module compilation errors scoped builds missed). If unconfigured, advance as a pass-through tick. Failure → `shipyard-data cursor pause execute --note "sprint_full_build failed: <why>"` BEFORE AskUserQuestion (so a /loop wakeup can't re-run the whole build and re-ask), then AskUserQuestion. Render the failure evidence first — the failing command and the capture file's error tail — as chat text; content in the capture file or the operational-task return does not count as shown until printed. **→ `sprint_full_tests`.**
2. **Full test suite (stage_id: sprint_full_tests)** — invoke `shipyard:dispatching-operational-task` per tier (unit/integration/e2e) or combined. This is the only time the entire suite runs. Persistent failure after the cap → re-dispatch via `shipyard:dispatching-task-loop` per failing cluster (`→ sprint_tests_fix_iter_1`, K bounded at 1). **→ `sprint_demo_probes`.**
3. **Per-feature demo probes (stage_id: sprint_demo_probes)** — the cross-task user-flow proof; catches "all unit tests pass but the integrated feature doesn't work" (the confedit failure mode that motivated this stage in v2.6.0). Read SPRINT.md `features:`. For each feature:
   - **`demo_probe` absent** → `shipyard-data cursor pause execute --note "demo_probe missing for <F>"` BEFORE AskUserQuestion: *"Feature [F-NNN] has no `demo_probe`. (a) author one via /ship-discuss [F-NNN], (b) skip with explicit reason, (c) abort completion."* Recommended (a). Do NOT advance until populated.
   - **`demo_probe: skip-with-reason`** with populated `demo_probe_skip_reason` → emit `acceptance_probe_completed feature=<F> probe_type=demo exit_code=0 skipped=true reason=<short>` and continue (Invariant 8: PASS-with-warning).
   - **Otherwise** → invoke `shipyard:running-acceptance-probe` (`probe_command: <feature.demo_probe>`, `cwd: <working branch checkout>`, `timeout_seconds: 120`), then emit `acceptance_probe_completed feature=<F> probe_type=demo exit_code=<n> verdict=<PASS|FAIL|TIMEOUT|ERROR>`.
   - **FAIL/TIMEOUT/ERROR** → render the probe command and its output tail (from the probe return) as chat text first — the probe result exists only in the capability skill's return until you print it. `shipyard-data cursor pause execute --note "demo_probe <verdict> for <F>"` BEFORE AskUserQuestion: *"Feature [F-NNN] demo_probe returned [verdict]. (a) investigate via /ship-debug [F-NNN], (b) abort and re-execute failing tasks, (c) override with `skip-with-reason` (recorded; review will flag)."* Do NOT proceed unless (c) with justification or the probe passes on retry.
   - All PASS (or skip-with-reason) → **→ `sprint_complete_gate`.**
4. **Sprint-complete predicate (stage_id: sprint_complete_gate)** — invoke `shipyard:evaluating-sprint-complete` with `sprint_id`, `data_dir`, `working_branch`, `sprint_base_sha`, `sprint_head_sha` (current HEAD), `sprint_verify_capture` + `sprint_verify_exit_code` (from step 2), `demo_probe_event_window_start` (SPRINT.md `started_at`), `review_verdict_path: null`. It runs the eight-invariant gate. `STATUS: INCOMPLETE` → print the failing-invariant list (each invariant + why it failed, from the gate's return) as chat text, then escalate via AskUserQuestion — the list must appear in chat, not only in the question/option strings. `STATUS: COMPLETE` → step 5. Invariant 7 (review-verdict-clean) is expected to FAIL here (review hasn't run) — by design; Invariant 8 (demo probes) MUST pass (step 3 just ran it). **→ `terminal_handoff_to_review`.**
5. **Finalize and emit terminal signal (stage_id: terminal_handoff_to_review)** — `shipyard-data sprint set status completed` then `shipyard-data sprint set completed_at <ISO>` (features stay `in-progress`; only `/ship-review` transitions them to `done`). Then, in this exact order:

   a. **Print the narrative line first** (free-form; MUST precede the CLI banner so the stop marker stays last):

   ```
   Sprint complete. [N]/[M] tasks done. Full suite: [pass/fail].
   ```

   b. **Advance to the terminal stage — the CLI enforces the gate, emits the event, prints the banner:**

   ```
   shipyard-data cursor advance execute terminal_handoff_to_review status=complete \
       outcome=success reason=sprint_complete \
       next_action="Sprint complete — handoff to /ship-review"
   ```

      The CLI runs the terminal-evidence gate before writing: it refuses (exit 3, missing-signals list) unless the event log contains (1) `pipeline_tick_completed pipeline=ship-execute stage=wave_<N>_gate` for every wave, (2) `task_dispatch_returned pipeline=ship-execute status=complete task=<id>` for every task — a **parked** task with a `task_blocked` event or `task_dispatch_returned status=blocked` satisfies its slot, so a sprint with needs-attention tasks CAN terminate and hand them to /ship-review; only a task with NO evidence blocks — and (3) `sprint_complete_passed`. On exit 3, re-run the missing stage to emit the evidence, then re-advance. The gate does NOT fire for `status: escalated`/`paused`. Preview with `shipyard-context terminal-gate ship-execute`. On success the CLI appends `pipeline_terminal outcome=success reason=sprint_complete`, re-renders PROGRESS.md, and prints `▶ NEXT UP: /ship-review …` followed by `▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.` as the FINAL line. Echo the CLI output verbatim.

      The loop-driving model reads the LAST line as its continue-or-stop signal, so the stop marker MUST be the final line — a `NEXT UP` line after it reads as "keep going." NEXT UP is framed as a SEPARATE cycle you start yourself. Do NOT call `ScheduleWakeup`, do NOT print your own NEXT-UP line after the CLI output, and do NOT chain into `/ship-review` — the execute `/loop` ends here; `/ship-review` is a separate cycle the user starts deliberately.

   c. **Cron-fallback cleanup.** Act on the CLI's printed cron-cleanup reminder — `CronList` + `CronDelete` any cron whose prompt targets `/shipyard:ship-execute`. The CLI only prints the reminder when a `pipeline_loop_bootstrap_fallback` cron was armed, so the happy path is silent.

---

## SINGLE TASK Mode (--task) (stage_id: single_task → terminal_single_task)

Execute one task following the TDD cycle above — for picking up a specific unblocked task, re-executing a failed task, or running a patch task. Same structure: builder writes tests + implementation (no test execution), then the wave REFACTOR+MUTATE+VERIFY sequence runs for the single-task wave.

**Terminal (stage_id: terminal_single_task).** Print `Task complete.` first, then `shipyard-data cursor advance execute terminal_single_task status=complete outcome=success reason=task_complete next_action="Task complete"`. The CLI appends `pipeline_terminal`, re-renders PROGRESS.md, and prints the `▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.` marker as the final line; echo it.

---

## HOTFIX Mode (--hotfix) (stage_id: hotfix → terminal_hotfix)

1. Read bug file (B-HOT-NNN). 2. **Derive the target branch** — default to the bug file's `branch:` frontmatter, else the current checkout. AskUserQuestion ONLY when both exist and disagree. 3. Execute TDD cycle (must include regression test). 4. Commit `fix(B-HOT-NNN): [description]`. 5. **Terminal (stage_id: terminal_hotfix).** Print `Hotfix ready. Review with /ship-review --hotfix B-HOT-NNN` first, then `shipyard-data cursor advance execute terminal_hotfix status=complete outcome=success reason=hotfix_ready next_action="Hotfix ready — handoff to /ship-review --hotfix"`. The CLI appends `pipeline_terminal`, re-renders PROGRESS.md, prints the `▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.` marker as the final line; echo it.

Shipyard does not create branches, merge, or push for hotfixes — the user handles their own git workflow. Hotfix does NOT affect sprint state or velocity. Hotfix is the one exception that DOES run tests at task level — the regression test is the whole point, and you need red→green→still-red-after-revert→green to prove the fix catches the bug.

---

## Blocked Task Handling

1. **Self-resolve** — a workaround within scope (< 5 min); any code change goes through `shipyard:dispatching-task-loop`, never a hand-edit here.
2. **Escalate** — render the blocker as chat text first (task ID, the BLOCKED return's reason, `escalation_code`, and output tail — subagent-return content does not count as shown until printed), then AskUserQuestion with blocker details + options.
3. **Swap-in** — skip the blocked task, pull the next unblocked task from the wave.
4. **Park** (still blocked at wave boundary) — `shipyard-data task set-status <TID> blocked --reason "<short>"` (writes `blocked_reason` + `blocked_since` atomically and auto-emits `task_blocked task=<id> reason=<reason>` — do NOT also emit it yourself, the CLI is the sole emitter); then `shipyard-data feature set-status <FID> approved` followed by `shipyard-data backlog add <FID>` (so it survives sprint archival and surfaces in the next `/ship-sprint`). The auto-emitted `task_blocked` event is the terminal gate's parking evidence, so a parked task does not block sprint completion; it hands off to /ship-review. Do not Write/Edit PROGRESS.md; the render hook regenerates it.

## Loop Detection & Debug Escalation

Loop detection lives inside `dispatching-task-loop`'s subagent context — its own iteration cap (5 internal iterations) plus the structured `STATUS: BLOCKED` return surface stuck tasks without per-Edit hook overhead.

When the orchestrator sees `STATUS: BLOCKED` after the single re-dispatch budget (or recurring `BLOCKED` across waves on the same task), escalate to debug mode: write `<SHIPYARD_DATA>/debug/[task-id].md` with the collected BLOCKED reasons.

Before falling to AskUserQuestion, if the BLOCKED return's `escalation_code` has no matching entry in `dispatching-task-loop`'s escalation-code routing (an uncovered blocker), invoke `shipyard:escalating-to-thinker` (trigger: `uncovered_blocked`, subject: the task ID). It checks the per-sprint consult cap and returns a recommendation to execute through normal paths; only if it declines, returns low confidence, or its recommendation also fails do you fall through to AskUserQuestion. A documented escalation-code path always runs first. Render the collected BLOCKED reasons (and the consult's DIAGNOSIS if one ran) as chat text above the ask — the debug file and subagent returns are not visible to the user until printed. Then:

> *"Task [TASK_ID] hit its dispatch budget after [N] BLOCKED returns. I've started a debug session.*
> *1. Debug now — `/ship-debug --resume`*
> *2. Skip task — move to next unblocked task*
> *3. Describe the problem — I'll help directly*
> *Recommended: 1."*

## Deviation Rules

| Category | Examples | Action |
|---|---|---|
| **Bug / Missing Critical / Blocker** | runtime errors, missing null checks, missing auth, broken imports | allocate the id (`shipyard-data next-id tasks`), **write `spec/tasks/<id>-<slug>.md` FIRST**, then invoke `shipyard:dispatching-task-loop` with that `task_file_path`; only after the file exists, emit `patch_task_created task_id=<id> feature=<feature> source=execute-deviation` |
| **Structural** | new DB table, new service, different design pattern | render the deviation as chat text (what the plan said, what was found, why the structure differs), then `AskUserQuestion` before proceeding |

**The orchestrator never writes, edits, or fixes code directly.** Always delegate.

## Rules

- NEVER skip TDD. Test *execution* is deferred to wave/sprint boundaries; the test-first discipline is unchanged. Hotfix is the one exception (always runs tests at task level).
- NEVER modify test assertions to pass — fix the implementation.
- NEVER build beyond acceptance criteria.
- ALWAYS commit atomically per task; update task `status: done` after each.
- Surface blockers / deviations / session notes by emitting events (`task_blocked`, `patch_task_created`, `task_status_changed`, …) — PROGRESS.md auto-renders. Never Write or Edit PROGRESS.md.
- NEVER fix test failures, lint errors, or bugs directly in this session — invoke `shipyard:dispatching-task-loop` (code) or `shipyard:dispatching-operational-task` (command-shaped) to delegate.
- Architectural changes → `AskUserQuestion`. Before any other ask, run the confidence gate + kill-list from `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/question-design.md`: derive what's derivable, decide-and-inform HIGH-tier two-way-door calls (one-line "Going with X — [why]"), and only genuinely MEDIUM/LOW decisions reach `AskUserQuestion`. "If in doubt, ask" is retired — if in doubt, resolve the doubt first.
