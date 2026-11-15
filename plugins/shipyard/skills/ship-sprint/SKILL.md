---
name: ship-sprint
description: "Plan a new sprint or cancel an active one."
allowed-tools: [Read, Write, Edit, Grep, Glob, LSP, Agent, AskUserQuestion, WebSearch, WebFetch, TaskCreate, TaskUpdate, TaskList, "Bash(shipyard-context:*)", "Bash(shipyard-data:*)"]
model: opus
effort: low
argument-hint: "[--cancel] [--hours <n> | --until <time>]"
---

# Shipyard: Sprint Planning

Plan a new sprint by pulling features from the backlog and decomposing into waves.

## Context

!`shipyard-context sprint-planning`

**Shell.** Shipyard binaries you may invoke from Bash: `shipyard-data archive-sprint <id>`, `shipyard-data metrics ...`, `shipyard-data init-sprint <id>` (Step 12), `shipyard-data draft set-sprint-status ...`, `shipyard-data sprint set <key> <value>` and `shipyard-data sprint check` (Step 12). Run commands bare from the project root. SPRINT.md and PROGRESS.md are created by the `init-sprint` CLI; **SPRINT.md frontmatter is thereafter mutated only via `shipyard-data sprint set`, never a hand Edit** (hand-editing frontmatter is the corruption class that welds keys together). **PROGRESS.md and the pipeline cursors are CLI/render-owned — the model never writes them** (a PreToolUse hook denies such writes). Metrics are CLI-owned: `memory/metrics.json` is authoritative and `memory/metrics.md` is generated; never Write/Edit either metrics file by hand. Use the Write tool for arbitrary *narrative* artifacts (story files, step files, SPRINT-DRAFT.md); the SPRINT.md *body* (Goal, `### Wave N`, Critical Path, Risks, Swap Log) stays a model Edit on the CLI-created file.

**Render before asking.** Follow SHIPYARD_STARTUP_RULES and SHIPYARD_ONBOARDING_INSTRUCTION from startup.

**Quiet by default.** Between user-input gates work quietly; render feature lists, wave breakdowns, and quality-gate results in full only at a gate (render-before-ask). **No running commentary** ("Now I'll…", "Let me…"). Doctrine: `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md` § "Interim Communication: Quiet by Default".

**Capability-skill playbooks.** Where a step says *"follow the `X` playbook"* or "dispatch `X`", X is a capability skill — **Read** `${CLAUDE_PLUGIN_ROOT}/skills/<X>/SKILL.md` and execute it inline; never hand it to the `Skill` tool (capability skills are `disable-model-invocation: true`, so `Skill` refuses them).

## Input

$ARGUMENTS

## Session Mutex Check

**Absolute first context action — before mode detection, before any manual reads.** The `shipyard-context sprint-planning` pre-exec block above acquires the planning lock and returns the planning context bundle in one CLI call. If that context contains `SHIPYARD_LOCK_ACQUIRED=false`, echo the `SHIPYARD_LOCK_BLOCKED:` `⛔` block text verbatim as the entire response and STOP — do not continue with any other instructions, do not call any other tools. If it contains `SHIPYARD_LOCK_NOTICE:`, echo that stale/corrupt-lock recovery line once, then proceed. Do not run a separate lock-acquire call; the bundled context command already did it (see the `acquiring-skill-lock` capability skill for the full contract — locks are CLI-owned; never Read or Write either lock file by hand).

## Detect Mode

- If `--cancel` → CANCEL mode
- `--hours <n>` / `--until <ISO time | HH:MM>` → an optional TIME budget for PLAN mode (points stay the default). Carry the flag verbatim into Step 1's `shipyard-data capacity` call; never convert hours to points yourself. Both flags, or a time flag plus a points answer, is a usage error the CLI reports — relay it and ask the user to pick one.
- If the context has `SHIPYARD_NEXT_SPRINT_READY=<id>` → an approved sprint is waiting and nothing is running: **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/draft-ahead.md` § "Promote".
- If the context has `SHIPYARD_SPRINT_PLAN_MODE=draft-ahead` (a sprint is running or waiting for its review; planning is never blocked by it):
  Read current sprint state — stories, steps per wave, progress, remaining capacity. Write one short summary in chat, then ask one question:

  - **Draft the next sprint (Recommended)** → PLAN mode, drafted ahead: **Read and follow** `references/draft-ahead.md` § "Draft ahead" on top of PLAN mode. The running sprint is not touched.
  - **Add stories to the running sprint** → EXTEND mode. Offer only when `SHIPYARD_RUNNING_BESIDE` names neither `ship-execute` nor `ship-review`.
  - **Cancel it and replan** → CANCEL mode, then PLAN mode. Same condition.
  - **Wait** → stop; suggest `/ship-execute` or `/ship-review`.

- If completed sprint exists in `current/` (status: `completed` but not archived):
  Show what was found:
  ```
  Found completed sprint [ID] that wasn't archived:
    Features: [list with statuses]
    Branch: [branch name] — [merged/unmerged]
    Velocity recorded: [yes/no]
  ```

  Handle cleanup transparently:
  1. Archive by running `shipyard-data archive-sprint sprint-NNN` from Bash (substitute the real sprint ID). This atomically records velocity from delivered features, renames `<SHIPYARD_DATA>/sprints/current/` → `<SHIPYARD_DATA>/sprints/sprint-NNN/`, and recreates an empty `current/`. Do NOT synthesize raw `cp`/`mv`/`mkdir` commands against the plugin data dir — they're not portable and not atomic.
  <!-- AC-6 -->
  If `archive-sprint` exits non-zero (the CLI refuses a completed sprint that `/ship-review` never processed), show the CLI's reason, tell the user review is pending, and AskUserQuestion: **Run /ship-review first (Recommended)** → stop and tell the user to run `/ship-review`; **Archive anyway** → run `shipyard-data archive-sprint sprint-NNN --unreviewed`.
  2. Report: "Archived sprint [ID]. Velocity recorded for the next sprint."
  3. Then proceed to PLAN mode

- Otherwise → PLAN mode

---

## PLAN Mode

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/plan-mode.md` and `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/plan-shared-steps.md` then follow.

**Read** `references/quality-manifest.md`; on-demand (inline fallback, final step-file write): `references/task-decomposition-patterns.md`, `references/task-kinds.md`, `references/task-tech-notes-template.md`. Also: `references/carry-over-scan.md`, `references/implementation-decisions.md`, `references/planning-checklists.md`, `references/spec-validation.md`, `references/sprint-analyst-report.md`, `references/wave-decomposition.md`.

---

## EXTEND Mode (add features to active sprint)

Add features to an in-progress sprint without cancelling.

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/extend-mode.md` and `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/plan-shared-steps.md` then follow.

---

## CANCEL Mode

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/cancel-mode.md` and follow it.
