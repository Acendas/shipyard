---
name: ship-execute
description: "Execute the current sprint in test-first waves."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, Agent, AskUserQuestion, Monitor, TaskCreate, TaskUpdate, TaskList, TaskStop, SendMessage, Workflow]
model: opus
effort: low
argument-hint: "[--task ID] [--hotfix ID] [--mode solo|task|track] [--single-tick]"
---

# Shipyard: Sprint Execution

Execute sprint tasks following the wave plan. Every task follows Red → Green → Refactor → Mutate.

## Context

!`shipyard-context sprint-execution`

**Shell.** Bash is for project test commands, git, and `shipyard-data` CLI calls; use the Write tool only for the non-cursor data-dir files it still owns.

**Render before asking.** Follow SHIPYARD_STARTUP_RULES and SHIPYARD_ONBOARDING_INSTRUCTION from startup.

**Quiet by default.** Between user-input gates, work quietly. Only three things reach the chat outside a gate: one progress line per boundary (stage / wave; one builder or reviewer finishing is not a boundary and gets no line) made of a few words plus the wave/progress bar on the same line (`Wave 2 merged  [████████░░░░] 6/9 steps · you: not needed until the review (3 checks)` — the last part is the output of `shipyard-data sprint needs-you`, printed as it is, so the person always knows whether and when they are needed), and a one-line banner when launching or receiving long-running background work. Findings and analysis are rendered in full ONLY at a gate (render-before-ask) or a terminal summary — between gates they collapse to a one-line result. Subagent returns are internal contracts: parse the structured fields, never paste preamble/epilogue/freeform commentary. **No running commentary.** Full doctrine: `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md` § "Interim Communication: Quiet by Default".

**Deterministic state.** The pipeline cursor (`EXECUTE-CURSOR.md`), `PROGRESS.md`, and SPRINT.md frontmatter are NOT written by the model — a PreToolUse hook DENIES any Write/Edit targeting them. The only writers are the `shipyard-data` CLI subcommands:

- **Cursor** — `shipyard-context sprint-execution` reads the cursor through the shared CLI parser and emits `SHIPYARD_CURSOR_*` fields; `shipyard-context cursor-state execute` is the mid-session re-read surface. Mutations go through `shipyard-data cursor advance|set|resume|pause|escalate|noop execute …`. See the tick-exit contract below and [references/pipeline-cursor.md](references/pipeline-cursor.md) for the full schema, stage map, and event vocabulary.
- **SPRINT.md frontmatter** — `shipyard-data sprint set <key> <value>` (typed atomic mutation; wave-body narrative stays model-authored).
- **PROGRESS.md** — never written by anyone but the renderer; emit events and it stays current.

Non-cursor narrative events (`task_dispatch_returned`, `wave_check_passed`, `subagent_completed`, `sprint_complete_passed`, `task_blocked`, …) are emitted via `shipyard-data events emit <type> …`. The CLI auto-emits the pipeline-lifecycle events (`pipeline_tick_started`, `pipeline_tick_completed`, `pipeline_terminal`) itself on every `cursor advance` — the model never emits those.

**Goal driver contract.** `/goal` is the only autonomous liveness driver for this command. It may re-enter `/ship-execute` until the Shipyard cursor reaches terminal, paused, or escalated state. `/goal` is never state authority; the cursor, event log, queue ledger, verification ledger, and artifacts are. Never invoke `/goal` from a spawned Agent, and never create a nested goal when this command is already running inside an active goal. A goal tick runs the same stage handler as a direct invocation, advances the cursor, and stops/continues only according to the CLI-owned cursor result.

**Flat-worker contract.** `/ship-execute` is the sole orchestrator. It may spawn builder/test/recovery agents directly, but those agents are leaf workers: they claim at most one queued item via `shipyard-data queue claim`, record the result with `shipyard-data task-return` (it writes the artifact and closes the queue item), and return only task id, status, and artifact path. A worker must never spawn another agent, invoke `/goal`, own cursor advancement, or decide wave completion. Completion is proven by queue state plus artifacts, not Agent notification delivery.

**Capability-skill playbooks — how to "follow" one (read this once).** Steps below say *"follow the `X` playbook"* where X is a **capability skill** (`dispatching-task-loop`, `dispatching-operational-task`, `dispatching-spec-review`, `verifying-wave-completion`, `evaluating-sprint-complete`, `running-acceptance-probe`, `escalating-to-thinker`, `acquiring-skill-lock`, …). Following one means: **Read** `${CLAUDE_PLUGIN_ROOT}/skills/<X>/SKILL.md` and execute the procedure it documents inline — construct the `Agent` dispatch it specifies and run its orchestrator-side gate. It does **NOT** mean the `Skill` tool: capability skills are `disable-model-invocation: true`, so handing one to `Skill` is refused by the platform and burns a tick.

## Input

$ARGUMENTS

## Detect Mode

- `--task P001` (a sprint step) or `--task T001` (a land-now task filed by `/ship-discuss`) → Execute that one unit only (sync, single-tick); `references/mode-task.md` decides the shape from the record. Only for land-now and hotfix runs: `references/verification-capture.md` (logcap capture discipline).
- `--hotfix S001` → Hotfix mode (branch from main, bypass sprint; sync, single-tick)
- `--mode solo|task|track` → Force the dispatch shape for every wave, overriding the per-wave track-grouping decision (Step 2). Aliases `subagent` (= `task`) and `team` (= `track`) are still accepted. A declared/forced mode is always honored — see Step 2's governance rule; it is never silently downgraded, and never re-confirmed by asking.
- `--isolation true|false` → Force whether builders run in git-worktree isolation for this invocation, overriding `execution.isolation` in config.md (default `worktree`). Accepts either vocabulary — `true`/`worktree`/`on` all mean isolate, `false`/`none`/`off` all mean in-place (resolved via `shipyard-data resolve-isolation --flag <value>`). `--isolation false` runs **sequentially in-place on the working branch** (no worktrees); it forces the `solo` dispatch shape and, combined with `--mode task|track`, coerces to sequential with a one-line note (no-isolation is sequential-only — see Step 2's Isolation resolution rule).
- `--single-tick` → Force one stage only for deterministic testing/debugging; otherwise `/goal` may continue re-entering until terminal/paused/escalated
- No args → Execute full sprint from current wave

**`--task` / `--hotfix` guard.** If `EXECUTE-CURSOR.md` exists and is **non-terminal** (a sprint is live), REFUSE both modes: print *"A sprint is active (stage `<stage>`). Finish or pause it (`shipyard-data cursor pause execute --note …`) before running --task/--hotfix"* and STOP. If it exists and is **terminal but still in `current/`** (execute done, `/ship-review` pending — the sprint isn't archived yet), also REFUSE: print *"A sprint is active (stage `<stage>`). Finish or pause it before running --task/--hotfix — the terminal execute cursor is still in current/; finish /ship-review (which archives the sprint) first."* and STOP. Never `--force` through either.

## Acquire Locks

The `shipyard-context sprint-execution` pre-exec block above acquires the execution lock and returns the execution context bundle in one CLI call, including `SHIPYARD_SPRINT_ID=<id-or-unknown>`. If that context contains `SHIPYARD_LOCK_ACQUIRED=false`, echo the `SHIPYARD_LOCK_BLOCKED:` `⛔` block text verbatim as the entire response and STOP — do not load any further context, do not call other tools. The bundled command's cross-lock guard HARD-BLOCKS `ship-sprint` and other planning work, but allows the narrow `ship-discuss` + `ship-execute` pair so discussion can author future/backlog work while execution owns the active sprint. If stdout includes `SHIPYARD_LOCK_CROSS_ALLOWED=ship-discuss+ship-execute`, proceed normally; `/ship-discuss` is responsible for treating active-sprint specs/tasks as read-only. The lock path also handles cleared-sentinel detection, 2h-stale recovery, and corrupt-JSON recovery — echo any `SHIPYARD_LOCK_NOTICE:` line, then proceed. Do not run a separate lock-acquire call; the bundled context command already did it.

The execution lock's resting-state release is automatic: `cursor advance` (terminal), `cursor pause`, `cursor escalate`, and `cursor noop` all call `shipyard-data lock release execution --force` internally (via `bin/skill-lock.mjs`) as part of the same cursor write. Do not run `lock release` by hand on those paths. Manual release is only needed on an ABNORMAL exit that never reaches one of those four cursor calls (e.g. the skill errors out before writing any cursor state at all) — in that rare case, run `shipyard-data lock release execution --skill ship-execute` before ending the turn.

---

## Cursor + Per-Tick Advance

`/ship-execute` is goal-driven: every invocation reads a persistent **pipeline cursor**, dispatches to the matching stage handler, and advances the cursor for the next tick. Full schema, stage map, terminal protocol, and event vocabulary live in [references/pipeline-cursor.md](references/pipeline-cursor.md).

**Starting the run: plain or `/goal` (both run to the end).** A plain `/ship-execute` executes the whole sprint in one go — stage after stage, wave after wave — and stops only at a terminal, paused or escalated marker (the "Execute the ENTIRE sprint" rule below; the earlier text that said a plain invocation stops after one stage was wrong and contradicted it). `/goal` is the sturdier driver for a long sprint, and only the user can start it: Claude Code re-enters after every turn until the condition holds, it does not judge the condition while builders or a background test run are still working, and a turn that ends early or a compaction costs nothing because the cursor is the state. The condition has to be visible in the output, which is what the CLI's last line is for — recommend exactly: `/goal run /ship-execute until its last line says CYCLE COMPLETE`. `--single-tick` forces one stage for debugging.

**Cursor location.** `<SHIPYARD_DATA>/sprints/current/EXECUTE-CURSOR.md`. One file per sprint, written only by `shipyard-data cursor`, archived with `current/` when the sprint completes.

### Tick-exit contract (applies at EVERY stage)

After a stage handler succeeds, advance the cursor with a single call:

```
shipyard-data cursor advance execute <next-stage> [k=v ...] [--note "<tick narrative>"]
```

The CLI validates the transition against the stage graph, runs the stale-cycle guard + terminal-evidence gate in-process, appends `pipeline_tick_completed` (or `pipeline_terminal`), auto-emits the new stage's `pipeline_tick_started`, re-renders PROGRESS.md, and prints the marker (for terminals the `/goal should stop` marker is guaranteed the FINAL line). **Echo the CLI's stdout as the final lines of your tick output** — never emit the pipeline-lifecycle events yourself and never print your own markers. With `--single-tick`, exit after echoing; otherwise `/goal` owns re-entry. Because of this contract, each stage below states only its `→ <next-stage>` target plus any stage-specific `k=v`.

**A non-terminal advance's marker tells `/goal` to continue.** The normal marker is `▶ TICK COMPLETE — ... /goal continues.`. Terminal, pause, and escalation markers tell `/goal` to stop.

On a `cursor advance` **exit 3 (refused)**, do NOT retry blindly — read the reasons on stderr, fix the missing evidence (re-run the stage that emits it) or escalate. `--force` skips only transition-graph validation for crash recovery; it never skips the evidence gates.

**Agent hygiene (load-bearing, CLI-gated, 4.5).** An agent is kept exactly as long as work can still come back to it, and no longer. **Builders** stay resumable until their wave's gate: a finished builder costs nothing while idle, and spec-verify or story-review findings on its step go back to it as a warm fix (`dispatching-task-loop` § 3-warm) — a builder you `TaskStop` can no longer be resumed (the platform refuses the message), so do not stop it at accept-return. **Everyone else** (spec reviewer, gap analyst, code reviewer, operational runner, refactor pass, a parked or dead builder) is stopped the moment its return is read: `TaskStop` it (a "not running" error just means it already ended on its own), then `shipyard-data agents stopped <name> [--reason done|dead]`. At `wave_<N>_gate`, once the gate passes, stop every wave-N builder the same way — `cursor advance` out of the gate refuses while a wave-N agent is still live. Record agents you spawn outside the worker queue with `shipyard-data agents spawned <name> --step <id> --wave <N>` (queue workers are recorded by their claim, wave included). The terminal advance refuses while any agent this cycle spawned is unaccounted for (`shipyard-data agents check` shows who), so a finished sprint never leaves builders or reviewers for the owner to find. Name agents after their work (`builder-<step>`, `spec-review-<story>`), never `worker-3`: the name is the address for `SendMessage` and the label the owner sees.

**Tickets in a tracker.** The build asks nothing about them and sends nothing: a story is not done until the sprint review closes it. Sprint planning told the tickets their stories are in the sprint; the review tells them the outcome (`skills/ship-discuss/references/tracker-sync.md` § 3).

**Unattended execution (load-bearing, hook-enforced, `execution.unattended: true` by default).** `/ship-execute` runs the sprint to completion without asking the user anything after the readiness step (a PreToolUse hook denies `AskUserQuestion` in the session running the sprint once builders have started; a paused cursor may ask, and every pause is reported at the review as a planning gap) — a question in the middle of execute means `/ship-discuss` or `/ship-sprint` left a gap, and the fix is there, not a prompt here. Anything a stage would have asked goes through the **decision ladder** instead:

0. **Already decided.** Check the record before anything else: SPRINT.md's Risks / decisions rows, the story's Decision Log, and the project's own decision log. A call the approved plan already names (e.g. a Risks row "layout check rejects the arc → extend the checker with flush zones") is applied as written and logged `source=rule decision="per approved plan: …"` — it is not asked again, even when a project rule says "ask before loosening a check": the owner answered when they approved the plan.
1. **Rule.** A defect found during the sprint (spec-review or gap-analysis finding, failing wave VERIFY, failing probe, design drift) is fixed **in this sprint** as a patch step (`patch_step_created`, same wave or a new one) while `shipyard-data patch-budget` exits 0 — the CLI counts the steps and computes the cap (it grows with the sprint's stories); never count by hand or take the number from a config comment. On exit 3 the budget is spent: decide with the next rungs; the fix also folds the behavior into the story's acceptance criteria/Interface so the spec stops drifting. Only a `severity: low` finding (cosmetic, no acceptance scenario or approved design touched) may become a bug story on the backlog (`--via bug_story`) or an accepted gap (`--via accepted`). A probe or checklist that does not cover every acceptance scenario is extended by the same patch step. The same rule covers what builders capture: before a wave's gate closes, triage every idea captured since the sprint started — `shipyard-data idea triage <IDEA-id> --kind defect|improvement|question [--severity low|medium|high] [--fixed-by <step>] [--reason "..."]`. A defect above low severity gets a patch step now and names it with `--fixed-by`; the wave-gate exit and the terminal refuse an untriaged idea or a defect with no fix step (CLI-enforced). A readiness-time decision stays at readiness (one ask max, before any builder runs).
2. **Quick decision (light tier).** When the call is *bounded* — the options are already written down (in the plan, a rule, a finding or a CLI message) and the only question is which one applies — run `shipyard-data decide --question "<what must be decided>" --option "A=<text>" --option "B=<text>" [--facts-file <path with the relevant lines>] --stage <stage_id> --subject <id>`. The CLI asks the light model with a forced answer shape (about four seconds, no agent to spawn or stop) and takes only a high-confidence choice: exit 0 is the decision, already logged as `execute_decision source=quick`; exit 3 means go on to the consult. Never for an open question (design, structure, a cause to find), never to pick something that is not on the list, never to loosen a check. Not counted against the consult cap.
3. **Consult.** Otherwise follow the `escalating-to-thinker` playbook (one think-tier consult, counted against `escalation.max_consults_per_sprint`); a recommendation with medium or high confidence is taken as the decision.
4. **Advisor (last resort).** If the consult declined, came back low-confidence, hit its cap, or its recommendation failed, and Claude Code's advisor is enabled for this session (the user ran `/advisor <model>`; a call shows `Advising…` in the transcript), consult the advisor: it reads this whole conversation, including the consult's answer, and its guidance is the decision (log `source=advisor`). It is the last decision-maker on the ladder — nothing is parked while the advisor can still decide.
5. **Park.** Only when every step above is exhausted (or the advisor is off, unavailable or declines): `shipyard-data cursor escalate execute reason=<code>` and move on to work that does not depend on it — never an inline `AskUserQuestion`.

**Stray changes are set aside, never discarded and never left for the owner.** After a read-only agent (reviewer, analyst, critic) returns, and before any wave gate, `shipyard-data stray list` must be clean. If it shows a tracked file changed that no step committed, run `shipyard-data stray set-aside --reason "<agent> ran <command>"`: the change goes into a git stash, the tree is clean again and nothing is lost. Log it (`execute_decision source=rule`) and name the stash at the review. Never `git checkout`/`git restore` a file to undo it, and never run a command for an agent that was refused it.

Every ladder decision is logged — `shipyard-data events emit execute_decision stage=<stage_id> subject=<id> source=rule|quick|consult|advisor|parked decision="<what>" rationale="<why>"` — and `/ship-review` renders them as **Decisions made for you** at the approval ask and in the retro, which is where the user weighs in. A human check that a story's probe asks for (`user_flow_probe.kind: assisted|manual`) is not a stop either: execute records it as pending and `/ship-review` Stage 5 collects the confirmation. With `execution.unattended: false` the pre-4.4 behavior applies — a tick NEVER exits with a pending question and no marker: a stage that must block on `AskUserQuestion` first runs `shipyard-data cursor pause execute --note "<question pending: …>"`, which sets the resume surface and prints the stop marker (wired at `sprint_full_build`, `sprint_demo_probes`, and the readiness anomaly prompt).

`stuck_counter` is CLI-owned: a same-stage self-loop advance auto-increments it (pass `stuck_counter=0` explicitly when the self-loop made real progress; `wave_N_waiting` is exempt — it never auto-increments). At `stuck_counter >= 5` the CLI emits `pipeline_stuck`; at the `hard_ceiling: 50` self-loop safety stop the CLI REFUSES the advance and directs you to `cursor escalate execute reason=hard_ceiling_stage_<id>`.

### Cursor read at entry (the canonical recipe — before any other work besides locks)

1. Acquire locks (above).
2. Use the `SHIPYARD_CURSOR_*` fields from the bundled `shipyard-context sprint-execution` block. Do not Read or parse `EXECUTE-CURSOR.md` directly; if cursor state must be refreshed mid-invocation, run `shipyard-context cursor-state execute`.
   - **`SHIPYARD_CURSOR_TERMINAL=true`, `SHIPYARD_CURSOR_STATUS=escalated`** → an escalated (recoverable) halt, NOT a completed sprint. Run `shipyard-data cursor noop execute` (the CLI detects the escalated terminal, does NOT emit a noop or arm the leak alarm, and prints the resume hint); echo it. Tell the user the sprint is resumable via `shipyard-data cursor resume execute` once the cause is fixed, then STOP.
   - **`SHIPYARD_CURSOR_TERMINAL=true`** (any other status) → a leaked wakeup against a finished cycle. Run the No-op sweep below and exit.
   - **`SHIPYARD_CURSOR_STATUS=paused`** → **goal-inert.** `/goal` must NEVER auto-resume a paused sprint — pause is a deliberate user stop, and only the user un-pauses it. Run `shipyard-data cursor noop execute` (the CLI emits `pipeline_terminal outcome=noop reason=awaiting_user_paused`, prints the pause note + the "resume is a USER decision (`shipyard-data cursor resume execute`)" hint + the stop marker; a repeated noop against the same paused sprint trips the repeated-noop warning), echo it, and STOP. Run `shipyard-data cursor resume execute` (flips to `in_progress` at the recorded stage, then dispatch to `SHIPYARD_CURSOR_STAGE` using `SHIPYARD_CURSOR_NOTE` as resume context) ONLY when the user explicitly asked to resume — invoked `/ship-execute` saying resume/continue, or answered a surfaced question. (See "Recovery & resume".)
   - **`SHIPYARD_CURSOR_PRESENT=true`, `SHIPYARD_CURSOR_TERMINAL=false`, `SHIPYARD_CURSOR_STATUS=in_progress`** → dispatch to the handler for `SHIPYARD_CURSOR_STAGE`.
   - **`SHIPYARD_CURSOR_PRESENT=false`** → fresh start. Begin at Pre-flight; the first `shipyard-data cursor advance execute preflight` creates the cursor.
3. **No-op terminal sweep (MANDATORY — load-bearing for goal safety).** Even if step 2 passed as non-terminal, verify the sprint is alive against all THREE conditions below. If ANY hold, run the sweep and exit. NEVER skip it. The CLI's in-process stale-cycle guard also refuses a non-terminal advance when there is no live sprint.
4. Run the chosen stage's handler, then advance per the tick-exit contract. After compaction, first re-Read the reference for the current cursor stage (`salvage`/`load` → `references/pipeline-start.md`; `readiness` → `references/pipeline-readiness.md`; `wave_N_*` and resume triage → `references/pipeline-wave.md`; dispatch, redispatch, blocked → `references/task-dispatch.md`; `sprint_refactor` through `sprint_complete_gate` → `references/pipeline-sprint-complete.md`); for `wave_N_dispatch`, `wave_N_gate`, `sprint_complete_gate` and any resume tick also re-Read `references/pipeline-start.md` § Step 1 checklist rules; the cursor's `stage:` is authoritative, never conversation memory.

### No-op terminal: already-completed sprint (+ repeated-noop self-detection)

Trigger when the cursor is `terminal: true`, OR SPRINT.md frontmatter has `status: completed`, OR there is no active sprint in `current/` (already archived):

1. Run `shipyard-data cursor noop execute [sprint=<id>] [reason=<sprint_already_complete|cursor_already_terminal>]` and echo its output. The CLI emits `pipeline_terminal outcome=noop` FIRST, runs repeated-noop detection, and on the 2nd noop for the same sprint/reason emits `pipeline_repeated_noop_detected` and prints the hard `⛔ REPEATED NOOP …` marker; otherwise it prints `▶ CYCLE COMPLETE — sprint already complete. /goal should stop.`

### Goal vs Single-Tick Dispatch Contract

- **Goal-driven invocation:** run the current stage handler and advance the cursor. `/goal` re-enters this command until a terminal/paused/escalated marker tells it to stop.
- **`--single-tick`:** run exactly one handler, advance the cursor, echo the marker, and stop. This is for deterministic testing/debugging.

### Pause is a cursor state

A user-initiated pause is `shipyard-data cursor pause execute --note "<why / resume context>"` — the CLI sets `status: paused`, keeps the current `stage:`, stores the note as the cursor body, and clears the execution lock. HANDOFF.md is retired; the paused cursor is the single resume surface.

---

## Pre-flight (stage_id: preflight)

Fresh start creates the cursor here; run these gates, then advance to `salvage`. Skip the /goal-mode gates on `--task`/`--hotfix`.

1. **Status check.** Run `shipyard-data doctor` — the incremental, watermark-gated integrity scan (phantom/nested project dirs, dangling patch-task refs, and frontmatter/registry-schema drift on `spec/` files touched since the last clean run). Pass `--full` only when a full sweep is explicitly warranted (e.g. after a schema-version bump) — the default incremental pass is what makes this cheap every sprint. Then, bounded by the current sprint only (not the whole registry): for each task ID in SPRINT.md's wave bodies, confirm `spec/steps/<id>-*.md` exists. Anything auto-fixable that requires a code or spec change is delegated (never hand-edited here); if critical issues remain (an unfixable doctor finding, or a sprint task referencing a non-existent step file), report and stop.
2. **Pre-flight gates.** `/ship-execute` runs /goal-shaped by default. Eight pre-flight gates refuse entry on a known-ambiguous condition. Run each in order; first failure emits `shipyard-data events emit sprint_goal_preflight_failed gate=<name> sprint=<id>` and halts with an actionable message. Gate names, checks, rationale, and fix copy: [references/goal-mode-preflight.md](references/goal-mode-preflight.md).

   **`every_feature_has_user_flow_probe` runs in EVERY mode, including `--task` and `--hotfix`** — the other seven skip on those. Run it as a CLI gate: `shipyard-data story check-probes <all SPRINT.md feature IDs>` (exit 3 = fail, names the offenders); do not re-derive it by reading each frontmatter in-model. It is the same `check-probes` verb `/ship-discuss` Finalize and `/ship-sprint` Check 24 call, so the three stages agree by construction.
3. **Git repository check.** Builder agents use worktree isolation, so verify git is ready:
   - `git rev-parse --git-dir` — fails → not a git repo.
   - `git log -1` — fails → no commits.
   - `git status --porcelain` — note a dirty tree but do NOT ask here. The readiness anomaly prompt (Step 1.5) owns the Commit/Stash/Continue decision so a fresh start asks at most once, and never when the tree is clean.
   - If the repo/commit checks fail → `git init` (if needed) then `git add -A && git commit -m "chore: initial commit"`. Worktree isolation requires at least one commit.

   **DO NOT check if the project is a worktree. DO NOT fall back to solo mode because of worktrees.** The WorktreeCreate hook handles all worktree scenarios (including nested) by creating them from the parent repo. Use the mode determined by task count; never downgrade for git worktree state.

**→ `salvage`** (`shipyard-data cursor advance execute salvage`).

## Operating Principles

- **This shell runs on Sonnet and does NO thinking.** Its job is checklist execution: read the cursor, run the stage handler, make CLI calls, read the event log, keep dispatch bookkeeping. It does NOT diagnose, weigh tradeoffs, or interpret ambiguity. EVERY judgment call escalates to the think tier via `escalating-to-thinker` — there is no silent absorption of ambiguity. Recovery-path ambiguity, an exit-3 whose reason has no documented remediation, and a bug-vs-structural deviation call are all escalation triggers (Step 4, `references/task-dispatch.md`), not things this shell decides. User decisions still go to AskUserQuestion; structural gates still always outrank a consult recommendation.
- **LSP first.** Use LSP (`documentSymbol`, `goToDefinition`, `findReferences`, `hover`) before Grep/Read for all code navigation; fall back silently if unavailable. Pass this to builder subagents. Full strategy: `references/lsp-strategy.md`.
- **Stay lean as orchestrator** (~10-15% context). Pass file paths to subagents, not contents. State lives in the cursor / PROGRESS.md / the event log, not conversation. Spot-check results before trusting them. Full guide: `references/context-management.md`.
- **Git strategy.** Work on the user's current branch — no sprint branches, no pushes. Solo commits on the working branch, no isolation. Task mode dispatches one worktree per task, rebased back at wave end. Track mode nests the same per-task worktrees under a wave-scoped track coordinator (own worktree, but it never commits) — every task still gets its own worktree, branch, and commit. Worktrees branch from current local HEAD. Atomic commits per task. Full strategy: `references/git-strategy.md`; forced `track` runs only: `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/track-mode.md`.
- **Output capture.** Test/build/E2E verification runs are dispatched via `dispatching-operational-task`, which captures stdout+stderr through `shipyard-logcap run <task_id>-run-<N> --filter ... --exit-file <SHIPYARD_DATA>/captures/<task_id>/run-<N>.exit`. The task's `verify_output:` is the absolute path returned by `shipyard-logcap path <task_id>-run-<N>`. Don't run verification commands directly in this session — delegate.
- **Communication.** Quiet by default (above). Blocker reports and decisions (at a gate) use the 3-layer pattern (a 15-second summary first, then show it with a table or a real example, detail only if needed); plain words; always recommend a default. Full guide: `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md`.

## FULL SPRINT Execution

**CRITICAL: Execute the ENTIRE sprint to completion.** Do not pause between waves to ask whether to continue, do not suggest re-invoking `/ship-execute`, do not suggest `/clear` between waves. Execute wave after wave until all tasks are done, then report completion. The only reasons to stop mid-sprint: (1) the decision ladder parked something (`cursor escalate`, never a chat question while unattended), (2) a structural deviation the ladder could not decide (Deviation Rules, `references/task-dispatch.md`), or (3) the user explicitly says "pause"/"stop".

### Step 0: Worktree Salvage (stage_id: salvage) (always runs first)

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/pipeline-start.md` § Step 0.

### Step 1: Load Sprint Plan (stage_id: load)

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/pipeline-start.md` § Step 1.

### Step 1.5: Execution Readiness Check (stage_id: readiness) (fresh-start only)

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/pipeline-readiness.md`.

### Step 2: Execute Waves (stage_id: wave_N_dispatch)

Per-wave stage IDs: `wave_<N>_dispatch`, `wave_<N>_redispatch_iter_<K>` (K∈{1}), then `wave_<N>_boundary` → `_build` → `_refactor` → `_tests` → `_verify` → `_gate` (Step 4). After the last wave's gate → `sprint_refactor` (or `sprint_full_build` under `refactor_scope: wave`) (Step 5).

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/pipeline-wave.md` § Step 2; per-task dispatch, task-kind routing and the post-subagent gate are in `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/task-dispatch.md`. Live progress streaming: `references/live-streaming.md`. Routing: `wave_<N>_dispatch` → `wave_<N>_waiting` → `wave_<N>_recovery` → `wave_<N>_boundary`, or any BLOCKED / gate failure → `wave_<N>_redispatch_iter_1 iteration=<n+1>`. **Overlap (`execution.overlap_waves: true`, default):** `wave_<N>_boundary` → `wave_<N+1>_dispatch` (builders start from the merged HEAD) → `wave_<N>_build … wave_<N>_gate` (N's trailing lane runs while they work) → `wave_<N+1>_waiting`; details in `references/pipeline-wave.md` Step 4 items 3 and 9.

### Step 3: Per-Task Execution (implementation only)

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/task-dispatch.md` — Step 3, the `wave_N_redispatch_iter` handler, Blocked Task Handling, Loop Detection & Debug Escalation, Deviation Rules.

### Step 4: Wave Boundary Check (stage_ids: wave_N_boundary → _build → _refactor → _tests → _verify → _gate)

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/pipeline-wave.md` § Step 4.

### Recovery & resume

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/pipeline-wave.md` § Recovery & resume on any resume or after compaction (crash path: `references/resume-from-event-log.md`).

### Step 5: Sprint Completion (stage_ids: sprint_refactor → sprint_full_build → sprint_full_tests → sprint_demo_probes → sprint_complete_gate → terminal_handoff_to_review)

When all waves are done:

0-4. **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/pipeline-sprint-complete.md` § Step 5 items 0-4; item 4 hands to item 5.

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

      The CLI runs the terminal-evidence gate before writing: it refuses (exit 3, missing-signals list) unless the event log contains (1) `pipeline_tick_completed pipeline=ship-execute stage=wave_<N>_gate` for every wave, (2) `task_dispatch_returned pipeline=ship-execute status=complete task=<id>` for every task — a **parked** task with a `task_blocked` event or `task_dispatch_returned status=blocked` satisfies its slot, so a sprint with needs-attention tasks CAN terminate and hand them to /ship-review; only a task with NO evidence blocks — and (3) `sprint_complete_passed`. On exit 3, re-run the missing stage to emit the evidence, then re-advance. The gate does NOT fire for `status: escalated`/`paused`. Preview with `shipyard-context terminal-gate ship-execute`. On success the CLI appends `pipeline_terminal outcome=success reason=sprint_complete`, re-renders PROGRESS.md, and prints `▶ NEXT UP: /ship-review …` followed by `▶ CYCLE COMPLETE — pipeline terminal. /goal should stop.` as the FINAL line. Echo the CLI output verbatim.

      `/goal` reads the LAST line as its continue-or-stop signal, so the stop marker MUST be the final line. NEXT UP is framed as a SEPARATE cycle you start yourself. Do NOT print your own NEXT-UP line after the CLI output, and do NOT chain into `/ship-review`.

---

## SINGLE TASK Mode (--task) (stage_id: single_task → terminal_single_task)

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/mode-task.md`.

---

## HOTFIX Mode (--hotfix) (stage_id: hotfix → terminal_hotfix)

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/mode-hotfix.md`.


---

## Rules

- NEVER skip TDD, because tests written after code only confirm it. Test *execution* is deferred to wave/sprint boundaries; the test-first discipline is unchanged. Hotfix is the one exception (always runs tests at task level).
- NEVER modify test assertions to pass; they are the spec, so fix the implementation.
- NEVER build beyond acceptance criteria; unspecced work is unreviewed scope.
- ALWAYS commit atomically per task; update task `status: done` after each.
- Surface blockers / deviations / session notes by emitting events (`task_blocked`, `patch_step_created`, `task_status_changed`, …) — PROGRESS.md auto-renders. Never Write or Edit PROGRESS.md.
- NEVER fix test failures, lint errors, or bugs directly in this session (it bypasses the gates) — follow the `dispatching-task-loop` playbook (code) or `dispatching-operational-task` (command-shaped) to delegate.
- Architectural changes → the Unattended decision ladder (consult → decide, else park); an inline `AskUserQuestion` only when `execution.unattended: false`. Before any other ask, run the confidence gate + kill-list from `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/question-design.md`: derive what's derivable, decide-and-inform HIGH-tier two-way-door calls (one-line "Going with X — [why]"), and only genuinely MEDIUM/LOW decisions reach `AskUserQuestion`. "If in doubt, ask" is retired — if in doubt, resolve the doubt first.
