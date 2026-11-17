---
name: ship-discuss
description: "Route any new work: capture, refine, land now, hotfix."
allowed-tools: [Read, Write, Edit, Grep, Glob, LSP, Agent, AskUserQuestion, WebSearch, WebFetch, TaskCreate, TaskUpdate, TaskList, "Bash(shipyard-context:*)", "Bash(shipyard-data:*)"]
model: opus
effort: low
argument-hint: "[topic | S### | E### | IDEA-### | issue key | --idea <text> | --hotfix <text> | --chain <ids> | --pull <JQL|my-sprint>] [--think <model>]"
---

# Shipyard: Discuss — the single front door

Every piece of new work enters here: a thought to capture, a story to refine, a tiny change to land now, or a production hotfix. You classify, the CLI ladder proposes a lane, the user confirms in one keypress.

## Context

!`shipyard-context discuss-context`

**Quiet by default.** Outside a user-input round only a one-line phase marker, a compact ASCII block, and a one-line deep-dive banner reach the chat; render findings in full only when they feed an imminent AskUserQuestion. **No running commentary** ("Now I'll research…"). Full doctrine: `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md` § "Interim Communication: Quiet by Default".

**Capability-skill playbooks.** Where a step says *"follow the `X` playbook"* or "dispatch `X`", X is a capability skill — **Read** `${CLAUDE_PLUGIN_ROOT}/skills/<X>/SKILL.md` and execute it inline; never hand it to the `Skill` tool (capability skills are `disable-model-invocation: true`, so `Skill` refuses them).

## Input

$ARGUMENTS

**`--think <model>` override (this invocation only).** If `$ARGUMENTS` contains `--think <value>`, validate `<value>` as one of `{fable, opus, sonnet, haiku}` (versioned `claude-*` ids are not accepted: the Agent tool takes tier names only). Valid → strip `--think <value>` from the arguments before mode detection and remember it as `think_override` for the rest of this session; every think-tier dispatch below (the design deep-dive, the critic) passes it via `shipyard-data resolve-model think --override <think_override>` instead of reading `models.think` from config.md. Invalid value (anything else) → print one line ("`--think <value>` isn't a recognized model — ignoring, using the configured think tier") and fall back to `models.think` as normal; do not block on it or ask a follow-up question. No config.md mutation — this never persists past the current invocation. On first dispatch that actually uses the override, emit `shipyard-data events emit think_override_used model=<think_override>` (once per session, not once per dispatch).

## Session Mutex Check

**Absolute first context action — before mode detection, before any manual reads.** The `shipyard-context discuss-context` pre-exec block above acquires the discuss lock (it stops a second discussion, never planning or a sprint) and returns the discussion context bundle in one CLI call. If that context contains `SHIPYARD_LOCK_ACQUIRED=false`: when the input is `--idea …`, `--hotfix …`, or a free-text input the ladder routes to **capture** or **hotfix**, continue **lock-free** (those lanes write only new records — `references/lanes.md` § Locks — and must never wait on planning; do not release a lock you do not hold at the end). For every other input echo the `SHIPYARD_LOCK_BLOCKED:` `⛔` block text verbatim as the entire response and STOP — do not continue with any other instructions, do not call any other tools. If it contains `SHIPYARD_LOCK_NOTICE:`, echo that stale/corrupt-lock recovery line once, then proceed (see the `acquiring-skill-lock` capability skill for the full contract — locks are CLI-owned, never Read or Write either lock file by hand).

**Running beside other commands (4.17).** A discussion is never blocked by sprint planning or by a running sprint; the lock only stops a second `/ship-discuss`. The context names what is running (`SHIPYARD_RUNNING_BESIDE=ship-execute,ship-sprint`) and what belongs to a sprint (`SHIPYARD_READONLY_STORIES=S001,S002`: the running sprint's stories and those of a sprint that is approved and waiting). Continue in **future-work mode**:
- Every story in `SHIPYARD_READONLY_STORIES`, its steps, and everything under `<SHIPYARD_DATA>/sprints/current/` and `<SHIPYARD_DATA>/sprints/next/` is read-only for the whole invocation. Take the list from the context; do not rebuild it.
- Safe: create new IDEAs, discuss new features, write future feature specs, graduate an idea into a new feature, and add future approved features to BACKLOG.md. `/ship-execute` has already snapshotted its active sprint; backlog additions do not enter the running sprint.
- Unsafe: editing active-sprint feature specs, active-sprint step files, SPRINT.md, PROGRESS.md, cursors, task statuses, or acceptance/user-flow probes for features in the running sprint. If the user asks for one, refuse the edit and offer to capture a follow-up IDEA or bug for the next sprint.
- EPIC/refine flows that would cascade into an active-sprint feature must skip those files and surface them as deferred follow-ups. Never silently mutate a feature that `/ship-execute` may be reading or verifying.

## Load Context

The `shipyard-context discuss-context` block is the only startup context call. It returns SHIPYARD_DATA, config, codebase context, epics, features, and, when concurrent execution is allowed, the active sprint summary. Use the returned SHIPYARD_DATA path literally; do not rerun those commands before mode detection.

## Detect Mode

Auto-route ONLY on unambiguous inputs. Heuristic classifications must be confirmed with the user before proceeding — wrong-mode-by-default is a high-impact failure (CAPTURE mode demotes a meaty idea to a stub without acceptance criteria; NEW mode interrogates a brainstorm the user wanted to stash). See the per-input rules below.

**Unambiguous (auto-route, no confirmation needed):**

- If an active discuss queue exists (`SHIPYARD_DISCUSS_QUEUE_ACTIVE=true` in the context block) → **CHAINED mode** resumes at the recorded position (see below), whatever else the input says, unless the input is `--idea`/`--hotfix`.
- If input starts with `--hotfix ` → **HOTFIX lane**: **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/bug-lane.md` § Hotfix lane (minimal `type: bug` story with `lane: hotfix`, debug session, hand-off to `/ship-execute --hotfix S###`; runs lock-free).
- If input starts with `--chain ` → **CHAINED mode** over the listed ids (see below).
- If input starts with `--pull ` → **PULL mode**: bulk-import tickets (coarse ones as ideas that keep their link, the rest as unrefined stories; see below).
- If the input **names a release or version**, or hands over **several tickets or a ticket export** (a CSV, a list of keys) → **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/less-backlog.md` first: the release becomes a fix version (`shipyard-data version add`), each coarse ticket an idea with its link (`shipyard-data tracker pull --csv|--input`; stories, bugs and tasks come in as themselves, linked the same way), and only what is next is refined into an epic and broken down. Then carry on in the mode the rest of the input calls for.
- If input starts with `--idea ` → **IDEA-CAPTURE mode** (see below). Strip the `--idea` prefix; the rest is the idea description. This is a fast-path: capture immediately, no depth offer, no ceremony. Example: `/ship-discuss --idea webhook retry with exponential backoff`.
- If input is an **epic ID** (E001) → **EPIC mode** (refine epic scope, cascade changes to features)
- If input is an **idea ID** (IDEA-NNN) → **IDEA mode** (refine the idea into an epic, then break the epic down — see below)
- If input is a **feature ID** (S001) → **REFINE mode** (load existing, gather updates)
- If input matches an **external issue key** pattern (`[A-Z]+-\d+` but NOT a Shipyard ID like S001/E001/P001/IDEA-NNN) → **EXTERNAL mode**. Fetch context from the user's session MCP tools and seed a NEW mode discussion. See `references/external-issue-fetch.md` for the full protocol. Examples: `JIRA-123`, `SYS-456`, `ENG-789`.
- If input is a **triage phrase** — exact phrase match against: "anything requires discussion", "anything requires discussion?", "what's open", "what needs discussion", "what needs attention", "what's pending", "what needs refinement", "anything else", "discuss anything", "what else", "any ideas", "any ideas to discuss", "what ideas" → **TRIAGE mode** (see below)
- If no input → AskUserQuestion: "What would you like to discuss?"

**Everything else goes through the ceremony ladder (F023).** Free text is never routed by a model heuristic alone. **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/lanes.md`: classify the five ladder inputs in one line, call `shipyard-data route-intake …`, render the proposal, confirm the lane in ONE AskUserQuestion (proposed lane first and recommended; the other three lanes as the alternatives — plus **EPIC** when the input reads as a whole product area), record the answer with `route-intake --confirm`, then route: **capture** → CAPTURE mode below; **refine** → NEW mode below with the ladder's `refine_rounds` as the question budget (a bug follows `references/bug-lane.md` § Refining a bug inside those rounds); **land-now** → `references/lanes.md` § Step L3 (file a `T###` task, hand off to `/ship-execute --task`); **hotfix** → `references/bug-lane.md` § Hotfix lane; **EPIC** → EPIC mode below. Wrong-lane-by-default is the failure this guards against: CAPTURE demotes a meaty idea to a stub, NEW interrogates a brainstorm — so the confirmation is never skipped, and a `refine` proposal still opens with "say 'just stash it' to capture as an IDEA instead" as a live veto.

### TRIAGE Mode: Surface what needs discussion

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/triage-mode.md` (list proposed features and unfinished ideas, then jump to REFINE or IDEA mode).

---

### IDEA-CAPTURE Mode: Instant Idea Stash (`--idea`)

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/idea-capture-mode.md` (zero-friction stash: no questions, no depth offer, release the mutex, exit).

---

### Compaction Recovery

If you lose context mid-discussion (e.g., after auto-compaction), **after compaction re-Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/compaction-recovery.md` **and the reference for the current mode** before continuing.

0. **Call `TaskList()` first.** If the phase-checklist tasks from NEW mode Phase 0 are present, the last `in_progress` (or first non-`completed`) task names the phase to resume — use it as the structured position anchor, then confirm against the file evidence below before resuming (the tasks are a mirror, not authority; if tasks and files disagree, the files win).

Then follow steps 1-3 in `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/compaction-recovery.md` (research-draft topic check, story-file status check, interrupted-discussion fallback). Research findings are the most expensive state to lose — the research draft preserves them.

---

### CHAINED Mode: Refine a queue of items (F026)

Entered from `--chain <id,id,...>`, from TRIAGE ("all" / several picks), or automatically when `SHIPYARD_DISCUSS_QUEUE_ACTIVE=true`. **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/chained-mode.md` (CLI-owned queue via `shipyard-data discuss-queue`, one item at a time with only the queue state and the decisions-so-far note as context, stop/skip/defer at every ask, cadence summaries, atomic per-item finalize).

---

### PULL Mode: Import tickets in bulk (F027)

Entered from `--pull "<JQL>"` or `--pull my-sprint`. **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/tracker-pull.md` (discover the tracker tool, normalize, `shipyard-data tracker pull`, imported stories are unrefined until refined here — usually through CHAINED mode).

---

## CAPTURE Mode: Quick Idea (zero ceremony)

When the ladder chose **capture** (or the user said 'just stash it'): **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/capture-mode.md` (create the IDEA file, then offer depth).

---

## EPIC Mode: Discuss at Epic Level

When the input is an epic ID (E001) or the user confirmed EPIC at the ladder gate.

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/epic-mode.md` (EP1-EP7; EP7 cross-feature integration AC: `references/epic-integration-ac.md`).

---

## IDEA Mode: Convert Idea to Feature

When the input is an idea ID (IDEA-NNN): **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/idea-mode.md` (load the idea, seed NEW mode, graduate inside Phase 6).

---

## NEW Mode: Refine a story (feature or bug)
**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/new-mode.md` for Phases 0 through 4.97 (checklist, deep-dive, Phases 1-4.97). Phases 5 and 6 follow below.

**Phase references (Read when new-mode.md reaches the phase):** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-1-research.md`, `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-1-5b-challenge.md`, `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md`, `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/viability-and-scope-drift.md`, `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-3-write-spec.md`, `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/impact-analysis.md`, `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-e2e-validation.md`, `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/simplification-scan.md`, `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/backlog-reeval.md` and `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-quality-and-critique.md`.

### Phase 5: Spec Approval Gate (NOT an Implementation Plan)

**UI stories (E005, optional DESIGN stage):** when the story changes what a user sees, after the acceptance criteria settle and before Phase 3 writes the spec, **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/design-stage.md` (prototype within the repo's components and tokens, stable element ids, snapshot into the data dir, sign-off through `shipyard-data design approve` — never a hand-written `design:` block; a change after sign-off is a new version). The decision is recorded by the CLI and gating: `shipyard-data story set-status approved` refuses a `ui: true` story that has neither `design approve` nor `design waive --reason` on record, so offer the stage exactly once (one `AskUserQuestion`: design it now / already have one / waive with a reason) and record the answer — never skip it silently (the 4.3 walkthrough did, and `/ship-sprint` Check 25 sent the user back here). A waiver keeps the manual look-and-feel probe.

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-finalize.md` § "Phase 5: Spec Approval Gate" (past-tense summary sections, one plain line per acceptance criterion, SCOPE-DRIFT DIFF, render-before-ask, the single approval card, asked last through the question list). It is shared by NEW, REFINE, EPIC and IDEA-graduated runs. On **Reject**, leave features at `status: proposed`, run `shipyard-data lock release planning --skill ship-discuss` as the last action and stop; keep the lock only for nonterminal **Refine** paths.

### Phase 6: Finalize (only on Approve)

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-finalize.md` § "Phase 6: Finalize" (steps 0-6, the `check-probes` gate, the REFINE-mode differences). Run the steps in order; the active-skill mutex stays active until the very last step.

Terminal step (stays here): **Stop your helpers first.** Every named agent this run started (deep-dive, critic, researcher) is stopped as soon as its result is in — `TaskStop <name>`; a hook records it — because a finished helper otherwise sits in the agent list until someone asks what it is. `lock release` refuses (exit 3, names them) while one is still listed. **Last action — after everything in phase-finalize.md has flushed:** run `shipyard-data lock release planning --skill ship-discuss` (soft-delete sentinel — CLI-owned, never a hand Write). After this step, do **not** continue with any tool calls — the discussion is done. If the user wants to build the feature, they will run `/ship-sprint` in a new session.

---

## REFINE Mode: Update Existing Feature

When the input is a feature ID (S001): **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/refine-mode.md` (Steps 0-5).

**REFINE phase references (Read when refine-mode.md reaches the step):** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-1-5b-challenge.md`, `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md`, `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/viability-and-scope-drift.md`, `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/impact-analysis.md` and `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-finalize.md`.

---

## Rules

**How to ask is governed by `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/question-design.md`** — the confidence gate, the ten-rule rulebook, the kill-list, and the bulk-ask discipline. The rules below are the load-bearing summary; that file is the authority.

- **Use AskUserQuestion — never plain text for questions.** AskUserQuestion is a tool call that suspends execution and waits for user input. Plain text output does not pause — the model will continue without user input. Every question that requires an answer must use AskUserQuestion.
- **Render before asking.** Follow SHIPYARD_STARTUP_RULES and SHIPYARD_ONBOARDING_INSTRUCTION from startup.
- **Confidence gate before every question (replaces "never assume").** Score each pending decision on evidence convergence and reversibility. **HIGH** (evidence converges AND two-way door) → **decide, inform in one line ("Going with X — [why]. say 'change' to override"), and log as `ASSUMED:`** — do NOT ask. Only **MEDIUM** and **LOW** items reach AskUserQuestion. **One-way doors and user-value questions (who it's for, whether it's worth building) are never HIGH** — they always ask; the Phase 2 viability echo stays mandatory.
- **Always recommend.** Every question to the user must include your recommendation. Never ask "A or B?" without saying which you'd pick and why. Options are outcomes with tradeoffs, not mechanisms (rulebook Q4).
- **Don't ask what the record already answers — check the kill-list.** Before every AskUserQuestion call, run the kill-list in `question-design.md` (derivable from code/config, derivable from the spec dir, restating the user's own words, universal-yes questions, framework-vocabulary questions, hypothetical-opinion questions, two-way-door minutiae, questions whose answer won't change the spec, derivable-by-analysis judgments like story points/RICE/estimates, and process/orchestration mechanics like whether to wait for background work). If it's on the list, STATE what you found or decide-and-log instead.
- **Questions are asynchronous and come from the question list (4.20).** In NEW mode (and an idea graduating into it) research runs in the background and adds questions as it finds them; you add yours to the same list; the person gets one card at a time and never waits for research. No rounds. The list holds the budget: past it, the smaller questions become one table and one card. `references/async-questions.md` is the loop.
- **A release is a fix version, never an epic.** An epic is one capability a user would name. "The v4.2.0 release", a client, a phase or a date is a version: `shipyard-data version add`, then `version set <version> <ids>`. Every epic, story, task and idea written here gets its `fix_version` that way when the release is known (`references/less-backlog.md`).
- **Research looks where the project says its knowledge lives, and only when the work needs it.** The context line `SHIPYARD_SOURCES` lists the places the owner named for this project (`shipyard-data sources list`), each with what it holds. For a piece of work, look in the ones that could hold something about it, then outside. A place the project did not name is not searched for it, whatever connectors this session has, and nobody is asked to sign in or connect anything. When the owner was never asked, they are asked once (`shipyard-data sources suggest`). Where it looked is recorded per named source: searched, not needed, or out of reach (`shipyard-data discuss-questions sources`); a claimed search is checked against the calls counted; a source marked "always" is left out only on the owner's word. A project that names none owes no record (`references/phase-1-research.md` steps 2b and 2c).
- **Tickets for new work, and a sync at the end.** When the person gave ticket links and research finds work no ticket covers, say so and offer to create the tickets (or hand over a ready list); when the discussion is done, show what differs from the tracker and ask to sync. For every kind of record: ideas, epics, stories, bugs, tasks. `references/tracker-sync.md`; the answer is recorded (`shipyard-data tracker decided …`) before the lock can be released.
- **A discussion does not stop halfway.** When one story waits on a fact only the person has, carry the others through critic, approval and finalize; ask what only they can decide as a card, never as a plain-text "want that?" at the end of a turn. A turn that ends while this session still holds the discuss lock, with no card on its way and no background research running, is handed back once by the Stop hook. To stop on purpose: `shipyard-data discuss-questions pause`, then release the lock.
- **A discussion never edits the project.** It writes specs, ideas and tasks in the data folder; the write hook refuses a project file. A small change is filed as a task for `/ship-execute --task`.
- **Record everything.** Every decision, "let's not do that" and "maybe later" goes in the decision log.

## Next Up

After a land-now hand-off: `/ship-execute --task T###`. After a hotfix: `/ship-execute --hotfix S###`. When stories are approved and added to the backlog, end with:
```
▶ NEXT UP: Plan a sprint to build these features
  /ship-sprint
  (tip: /clear first for a fresh context window)
```
