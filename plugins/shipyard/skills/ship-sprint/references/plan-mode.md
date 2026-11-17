**Communication design:** Follow the 3-layer explanation pattern and hard targets from `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md` for all user-facing questions. Frame velocity as what's achievable, not limiting: "Based on past sprints, you can comfortably deliver ~20 points" not "Your velocity limits you to 20 points." When capacity is exceeded, name the tradeoff: "Ambitious (proceed, risk overrun)" vs "Focused (drop F-005, clean finish)" vs "Flexible (you pick what to drop)."

### Step 0: Create the Step Checklist (task list)

On entering PLAN mode, `TaskCreate` one task per step so the user can watch the plan take shape and no step gets silently skipped:

| # | Subject |
|---|---------|
| 1 | Step 0.5: Idea Backlog Gate |
| 2 | Step 1: Determine Capacity |
| 3 | Step 1.5: Carry-Over Scan |
| 4 | Step 2: Select Features |
| 5 | Step 3: Research Before Planning |
| 6 | Step 3.5: Rules Compliance Check |
| 7 | Step 3.55: Terminology Alignment Check |
| 8 | Step 3.6: Definition of Ready Gate |
| 9 | Step 3.7: Surface Implementation Decisions |
| 10 | Step 3.75: Simplification Scan |
| 11 | Step 4: Decompose Tasks (5-stage protocol) |
| 12 | Step 5: Build Task Dependency Graph |
| 13 | Step 6: Find the Bottleneck |
| 14 | Step 7: Wave Assignment |
| 15 | Step 8: Determine Execution Mode |
| 16 | Step 9: Prepare Sprint Plan |
| 17 | Step 9.5: Quality Gate (self-review loop) |
| 18 | Step 9.7: Adversarial Critique |
| 19 | Step 10: Generate Quality Gate Manifest |
| 20 | Step 11: Present Sprint Plan |
| 21 | Step 12: Create Sprint (after approval) |

Create all 21 in one batch (subjects prefixed with a plan slug, e.g. `[sprint-plan] Step 7: Wave Assignment`). `TaskUpdate` to `in_progress` when a step starts, `completed` when it ends. A legitimately-skipped step (nothing to carry over, no data-model concern) is marked `completed` with `skipped: <reason>` in the description — never deleted silently.

**Guardrail (load-bearing): the task list is a progress surface and a recovery anchor, NEVER authority.** Do not gate any behavior on TaskList state, do not cite task status as evidence a step ran, and never mark a step's task completed before its file artifacts exist (step files, SPRINT-DRAFT.md, the manifest). SPRINT-DRAFT.md, the step files, and the event log remain the record; tasks are the user-visible mirror. (Note: /ship-execute track mode also uses the task system for *build* tasks — the `[sprint-plan] Step N:` subject prefix keeps the planning checklist distinguishable.)

### Step 0.4: Start from consistent state (4.6)

Run `shipyard-data reconcile --fix` before anything else and say what it repaired in one line (`→ State: carried 2 unfinished stories back to the backlog, 3 epics updated`), or nothing when it prints `state is consistent`. It repairs what a previous cycle left behind — a story still in-progress that no sprint holds, an epic behind its stories, a cursor left in `sprints/current/` with no sprint, backlog rows for closed work — so planning never trips over stale state. A repair that fails (exit 1) is shown verbatim and planning stops there.

### Step 0.5: Idea Backlog Gate

Run `shipyard-data check-idea-backlog`. **Exit 0 → proceed to Step 1 silently** (do not report a passing gate). **Exit 3 → the undispositioned idea backlog is over cap and you must stop before spending any planning work.**

**Step 0.8: Test setup (4.0).** Run `shipyard-data infra apply` (while another sprint is running, drafting ahead: `shipyard-data infra check` only, and apply when this sprint is promoted). It sets what the project's own test tool already supports (a failed-only run, an affected-tests run, a keep-going flag) and, when the rest has to be built once and the whole suite takes a minute or more, files one land-now task. Say nothing when it changed nothing. When it set something, show those lines. When a task is filed or still open, say it in one line now and put it first under the plan's NEXT UP (`/ship-execute --task T###`, before the sprint): every wave boundary of the sprint is faster once it is built. Not a question.

**Step 0.7: Risk profile (E004, lazy capture).** Run `shipyard-data risk profile status`. `present` → continue silently. `missing` → one short capture, at most three asks, before any planning work: (1) "What must never happen in this product?" — the user names harms in their own words ("a user is charged twice", "a ticket stays valid after a refund"); (2) for each, a severity (`low|medium|high|critical`) and the areas it lives in (paths, tables, endpoints, stories; globs are fine); (3) the checks that must exist before such a change ships. Record each with `shipyard-data risk profile add-harm --name "<harm>" --severity <s> [--paths g,g] [--tables t,t] [--endpoints e,e] [--stories S###] [--check "..."]...` — never by hand (the file is CLI-owned). "Floors only" is a valid answer: the baseline floors (auth, secrets, migrations, payments = high; deploy, dependency manifests = medium) apply with or without a profile, and the capture is offered again next sprint. Named harms seed acceptance probes and negative tests in Step 4; `shipyard-data risk score` reads the profile at every per-story review.

This gate exists because capture is deliberately unblockable: `next-id ideas` always allocates, so builders and reviewers never lose a finding to a full backlog. The cost of that is paid here — at the one moment where an ungroomed backlog is genuinely a decision to defer rather than a bookkeeping lag.

On exit 3, echo the CLI's stderr text, then AskUserQuestion with exactly three options:

1. **Groom now** (recommended) — stop planning and hand off to `/ship-backlog`. Most over-cap backlogs are dominated by ideas that are already stale, duplicated, or fixed; a grooming pass usually clears the cap in one sitting.
2. **Raise the cap** — run `shipyard-data config set max-undispositioned-ideas <n>`. The honest choice when the project genuinely runs a large idea pool and the old number was wrong.
3. **Accept and plan anyway** — run `shipyard-data events emit idea_backlog_accepted count=<current count>` (take the count from the CLI's message), then proceed. The event covers the backlog only while it stays at or below that count, so this is a one-time acknowledgement, not a permanent bypass.

**Never emit `idea_backlog_accepted` without the user picking option 3.** It is the logged escape hatch, not a way past a gate you found inconvenient.

### Step 1: Determine Capacity

Run `shipyard-data capacity` (add `--hours <n>` or `--until <time>` verbatim when the user passed one) and print its `Capacity`, `Fit`, `Calibration` and `Budget` lines as chat text. The CLI is the one source of these numbers: capacity is the rolling mean of the last 3 FINISHED sprints (completed, not cancelled) from `velocity.recent`; the calibration line names n, min, max and whether a MEASURED points-per-hour rate exists (recorded by `archive-sprint` from the event log). Do not read metrics.json/metrics.md yourself to derive capacity or a rate, and never convert hours to points in prose.

- **Time budget** (`--hours`/`--until`): the `Budget` line already says `from measured rate (N sprints)` or `your assumed rate, not measured` (`execution.assumed_points_per_hour`). When it says no rate exists, the CLI has fallen back to points — tell the user in one line and plan by points. A past `--until`, a non-positive `--hours`, or both flags is a CLI usage error (exit 2): relay it and ask the user to pick one budget.
- Use `budget_points=` (when present) as the capacity for this sprint; otherwise `capacity_points=`.

**Decide-and-inform when velocity data exists** (evidence converges, two-way door — capacity is re-litigated at feature selection and by the >10% overage rule, so it's never a one-way commit). State the CLI's line and proceed — do NOT ask:

```
Capacity ~[N] pts (rolling velocity, last 3 finished sprints) — say 'change' to adjust.
```

If the user says 'change', take the new figure for the rest of this session. **First sprint / no velocity data** is not a question either: use `execution.default_capacity` (config.md, default 20) and say so — `Capacity ~20 pts (no finished sprints yet; execution.default_capacity) — say 'change' to adjust.` The number is re-litigated by feature selection and the >10% overage rule, and real velocity replaces it after the first archive. Never ask to "save as default": the capacity is never persisted from here.

### Step 1.5: Carry-Over Scan

Before selecting features, scan for unfinished work from previous cycles. These items take priority over new features — they represent commitments already made.

See `references/carry-over-scan.md` for the full scan procedure (six scan locations: open bugs, blocked tasks, carried-over ideas with recency filter, in-progress features, silent-pass suspects, needs-attention escalations), the canonical display block, and the disposition prompt (all / pick / skip).

### Step 2: Select Features

Read BACKLOG.md (which contains only feature IDs and rank order). For each ID, read the story file to get title, RICE, points, status, complexity.

If no approved features exist in the backlog and no carry-over items were selected → AskUserQuestion: "No approved features in the backlog. Would you like to: (1) run /ship-discuss to define features, (2) run /ship-backlog to groom existing items, or (3) pull a specific feature ID?"

**The backlog's order is the selection order.** Suggest stories from the top of the backlog down, as `shipyard-data backlog board` lists them, until the capacity is used; when the list is in the owner's order, show each story's "why here" line. Leaving out a story that is higher than one you suggest is said in one line, with the reason (it waits on something, it does not fit).

**Releases first.** When `shipyard-data version list` shows planned versions, the suggested selection comes from the nearest one that still has open work, and each story's line names its fix version. Suggesting a story from a later release while the nearest still has open work is said in one line, with the reason.

**Display the actual features with real data before asking the user to choose.** Never ask "which features?" without showing them first.

**Say what is left out, and why.** When the selection comes from a release, print the `For a sprint:` lines of `shipyard-data version show <name>` as they are (ready, in a sprint, not ready and why, closed and why) above the options. After the choice, name in one line each ready story of that release that this sprint does not take and where it stays (its place on the backlog). A person who gave eleven tickets and sees six in the sprint must not have to ask where the other five went.

**Fit line is CLI output.** Once a suggested selection exists, run `shipyard-data capacity --points <suggested total>` and print its `Fit` and `Calibration` lines verbatim under the suggestion (the calibration line is never omitted when a fit is stated). Below 3 finished sprints the CLI prints the honest range and no percentage; print that instead. Repeat the call whenever the selection changes.

Output the feature list as formatted text:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 AVAILABLE FEATURES (sorted by RICE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 1. S009 — Maintenance Requests
    Points: 8 | RICE: 32.1 | Complexity: medium

 2. S011 — Payment Reminders
    Points: 5 | RICE: 28.4 | Complexity: low

 3. S004 — Bulk Fee Import
    Points: 13 | RICE: 24.0 | Complexity: high

 Capacity: ~20 pts (from velocity)
 Suggested: S009 + S011 = 13 pts (7 pts room)
 Fit: 13 pts fits at 67% — 2 of the last 3 finished sprints delivered at least 13 pts (range 5 to 41)
 Calibration: n=3 finished sprints (completed, not cancelled), min 5, max 41, average 21.3 pts; measured rate 8.2 pts/hr over 3 sprints

 PROJECTIONS
 ⏱ Time:   ~1.6 hrs (8.2 pts/hr avg, last 3 sprints)
 🎟 Tokens: ~650K estimated (S009: ~250K, S011: ~400K)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Projection display rules:**

**Time projection:**
- Read `avg_throughput` from metrics.json when present, falling back to metrics.md (average pts/hr from last 3 sprints)
- If available: `Time: ~M.M hrs (X.X pts/hr avg, last N sprints)` — computed as `selected_pts / avg_throughput`
- If not available (first sprint): `Time: unknown (will appear after first sprint completes)`

**Token projection:**
- Sum `token_estimate` from each selected story file's frontmatter
- Show per-feature breakdown and total: `Tokens: ~NNK estimated (S001: ~250K, S002: ~400K)`
- If `token_estimate` is 0 on any feature, note: `Tokens: partially estimated — S003 has no token estimate yet`

**As features are selected and total points change**, update both projections:
```
Selected: 13 pts | ~1.6 hrs | ~650K tokens
```

These projections help the user answer "Do I have enough time?" and "Will I exhaust my token quota?".

**Decide-and-inform when the choice is forced:** if every approved backlog story (plus carry-over) fits within capacity, select them all and state it in one line (`Selected: S002 — the only approved story, 3 of 20 pts`) — there is nothing to choose. Ask only when the approved set exceeds capacity or a dependency/ordering choice is real: AskUserQuestion: "Which features for this sprint? (list IDs, or 'suggested' to accept)"

### Steps 3-7 (shared)

Run the shared steps here (`references/plan-shared-steps.md`, loaded above): Step 3 through Step 3.75, Steps 4-7, and the Rules.

### Step 8: Determine Execution Mode

From the widest wave, never from the step count (4.19): `shipyard-data sprint plan-score --draft` prints `recommended_mode` in its JSON.
- Any wave with two or more steps → **Task mode** (they run at the same time, each in its own worktree). A sprint of three independent one-step stories is three builders at once, not three in a row.
- Every wave has exactly one step → **Solo mode** (nothing could run in parallel, so no worktree is needed).
- The project builds in place by choice (`execution.isolation: none`) → Solo mode, whatever the width.

The CLI refuses `solo` over a wide wave when the story enters the sprint.

**Track mode is OPT-IN and is never auto-selected.** Choose it only when the user explicitly asks, via `--mode track` or a hand-set `execution_mode: track`. Track mode delivers **no additional build throughput** over Task mode — both shapes build a whole wave at once, under the same `execution.max_agents` limit — while costing one extra agent per track (a coordinator plus its active builder, ≈ `2 × tracks` live agents). What it buys is informed briefs (the TRACK NOTES block carried into each successive builder) and centralised per-track triage: real, but unproven until a soak demonstrates it. When a wave has a track (that wave's tasks sharing a parent feature — group by each task's `feature:` frontmatter) of 2+ tasks, you may mention in one line that track mode is available and what it would buy — then default to Task.

### Step 9: Prepare Sprint Plan

Generate next sprint ID (sprint-NNN). Compute the full plan in memory:
- SPRINT.md content: sprint goal, capacity, wave structure (task IDs only), critical path, execution mode
- PROGRESS.md content: empty current wave tracker and session log

Use the Write tool to write `<SHIPYARD_DATA>/sprints/current/SPRINT-DRAFT.md` as a compaction checkpoint:

```yaml
---
id: sprint-NNN
status: draft
goal: [sprint goal]
capacity: [N] pts
features: [S001, S005]
execution_mode: [solo|task|track]
created: [ISO date]
---
```

Body: wave structure (task IDs per wave), critical path, risk register. This is NOT the approved sprint — it's recoverable state. The user must still approve before the sprint is created. Step 12 overwrites this with the approved SPRINT.md.

Include a `## Risks` section derived from: critical path tasks, external deps, knowledge gaps, spec uncertainty, and technical debt (format from `planning-checklists.md`).

### Step 9.5: Quality Gate (self-review loop)

Before presenting the plan, review your own output. Re-read each step file and the sprint draft against a 24-check table covering files-to-modify, architecture, dependency integrity, prescriptive strategy, cleanup, no-cycles, AC clarity, effort, critical path, wave/dep alignment, wave size (no wave exceeds its applicable width cap — `execution.max_tasks_per_wave`, or `execution.max_tasks_per_wave_merged` for an intact independent layer; wider layers split along track boundaries), test strategy, cross-cutting, risks, MoSCoW, PERT, kind-specific required fields (`verify_command`, `research_scope`, `First failing test:`), no nested operational loops, no "and"-titles in feature tasks, Technical Notes deliverable → task mapping, data-model decomposition (gated — data features only), and `user_flow_probe` coverage for every in-scope feature.

See `references/spec-validation.md` § "Step 9.5" for the full 24-row checklist with fail criteria. **Check 21 (Technical Notes → task mapping)** is load-bearing: a feature's Technical Notes section can name concrete artifacts (e.g. "Author must write a Playwright spec covering the golden path") that never become anyone's deliverable, so the sprint ships with that artifact missing. **Check 24 (`user_flow_probe`) is a hard CLI gate, not an eyeball:** run `shipyard-data story check-probes <all in-scope feature IDs>` — a non-zero exit names features with no user-facing proof and is a **planning blocker**, not a deferrable "gap". Route those to `/ship-discuss <feature-id>` and re-run until it exits 0. Iterate the rest up to 3 times, fixing failures and re-running. **The self-review is a no-input loop — run it quietly: do NOT narrate each pass or print the table. Surface only a one-line result** (`→ Quality gate: passed` or `→ Quality gate: N gaps flagged`); the gaps themselves ride into the Step 11 plan summary as "Planning gaps — review during execution" — **except a Check 24 failure, which halts planning rather than riding along as a gap.** **Check 25 (`design check`, E005) is the same kind of gate for UI stories:** `shipyard-data design check <in-scope story IDs>` must exit 0 — a `MISSING`/`DRIFTED` design is a planning blocker routed to `/ship-discuss <story-id>`, never a gap. Then proceed to Step 9.7.

### Step 9.7: Adversarial Critique

After the self-review quality gate passes, spawn the critics to challenge the plan from angles the self-review doesn't cover: **one critic per story group, all in one message** (the groups the decomposition used; one group → one critic). **Determine stakes level:** `high` if sprint has 10+ tasks, total story_points >= 20, any feature touches auth/payments/data, or critical path has 4+ tasks; `standard` otherwise.

See `references/spec-validation.md` § "Step 9.7" for the full critic dispatch prompt and the findings-processing rules (the critic emits PRIORITY_ACTIONS, TASK_GAPS, WAVE_CONFLICTS, ESTIMATE_RISKS, ASSUMPTION_RISKS — process each by fix-shape, routing genuine scope/priority calls and load-bearing assumptions through AskUserQuestion). **Do NOT re-run the critic after fixes.** One round only.

### Step 10: Generate Quality Gate Manifest

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/quality-manifest.md`

Generate `<SHIPYARD_DATA>/sprints/current/QUALITY-GATE.md` from two sources: Standing Gates (from `config.md` `quality_gates.standing`) and Sprint-Specific Gates (from sprint features' E2E AC categories, deduplicated across features). Add Integration Gates for any epic integration AC referencing this sprint's features.

**Skip if:** config has no standing gates AND no selected feature has E2E AC AND no epic integration AC reference this sprint's features.

### Step 11: Present Sprint Plan

Output the complete sprint plan as text. SPRINT-DRAFT.md and step files are already written as compaction checkpoints — no statuses change and no features move from backlog until the user approves.

**SPRINT [NNN] — [Goal]**
- Features: list with IDs and titles
- Tasks: [N] across [M] waves
- Critical path: [P001 → P003 → P007]
- Execution mode: solo/task/track

**PROJECTIONS**
- Time: ~M.M hrs (X.X pts/hr avg from past sprints)
- Tokens: ~NNNK estimated (per-feature breakdown)

**WAVE BREAKDOWN** — show as a visual timeline followed by per-wave detail:
```
  Wave 1  ████████░░░░░░░░░░░░  P001, P002           (8 pts)
  Wave 2  ░░░░░░░░████████░░░░  P003, P004, P005     (12 pts)
  Wave 3  ░░░░░░░░░░░░░░░░████  P006                 (5 pts)
```
Then for each wave: task IDs + titles, execution (sequential/parallel), dependencies satisfied by previous waves.

**DEPENDENCY GRAPH** — if tasks have cross-wave dependencies, show a DAG:
```
  P001 ─┬─▶ P003 ─▶ P006
        │
  P002 ─┘   P004
             P005
```

**RISKS** — from the risk register: risk, likelihood, impact, mitigation
**DECISIONS MADE** — from Step 3.7: key implementation choices and reasoning
**ASSUMPTIONS MADE** — every HIGH-tier decide-and-inform from the planning-decisions round (the `ASSUMED:` Decision Log entries), listed with "flag any to change before approval". This is the single audit point for everything the gate decided without asking.
**QUALITY GATE RESULTS** — from Step 9.5: all checks passed, or flagged gaps

**QUALITY GATES** (if QUALITY-GATE.md was generated):
- Standing: [N] gates ([M] probe, [K] manual)
- Sprint-specific: [N] gates from [M] E2E categories
- Integration: [N] gates from epic seams

Then use `AskUserQuestion` for approval:
- **Approve (Recommended)** — create the sprint and proceed to Step 12
- **Refine** — give feedback on specific tasks/waves, iterate
- **Cancel** — cancel the sprint draft via CLI: `shipyard-data draft set-sprint-status cancelled --data-dir <SHIPYARD_DATA>`, then `shipyard-data step set-status <PID> needs-attention --reason "sprint_draft_cancelled"` for created step files and `shipyard-data story clear-steps <SID>` for affected story frontmatter; the soft-deleted draft record stays in place.

Capacity is never persisted from planning (velocity comes from `archive-sprint`), so this call carries the approval question only — one question, one round.

**Say what the sprint needs from the person, and settle the start items in this same approval (4.0).** Above the approval ask, show the `you:` line from `shipyard-data sprint plan-score --draft`. When it lists things at the start, add one question on its own card before the approval: **"Can you do these right when the sprint starts?"** — Yes (Recommended) / Not this sprint. On "Not this sprint", take the stories that depend on those steps out of the plan (they stay approved in the backlog) and score the plan again; never leave a start item in a sprint whose owner said they cannot do it, because it would park halfway and take its dependants with it. The owner may also move an item between start and end; write their choice into the step (`needs_person:`) and re-run the score.

**Pre-clear owner-gated changes in this same approval (4.5).** `/ship-execute` runs unattended, so anything the project's own rules reserve for the owner must be answered here, not mid-run. While decomposing, list every planned step that will have to change a rule, check, band, threshold or approved design that the project's instructions gate on the owner ("never loosen a check without asking", "ask before changing X"). Render them as a short table above the approval ask — step, what changes, the recommended resolution — and record each approved one as a row in SPRINT.md's Risks/decisions table in the form `<situation> → <resolution>`. Execute's decision ladder applies those rows without asking (step 0). A step whose owner-gated change was not pre-cleared here is a planning defect.

### Step 12: Create Sprint (after approval)

If approved:

1. Run `shipyard-data draft set-sprint-status superseded --data-dir <SHIPYARD_DATA>` to set `status: superseded` in SPRINT-DRAFT.md frontmatter (the soft-deleted record stays in place; physical removal is manual for now — do not physically delete). Run `shipyard-data init-sprint <sprint-id> --data-dir <SHIPYARD_DATA>` (Bash) to atomically create SPRINT.md and PROGRESS.md from the canonical templates at `project-files/templates/`. The `--data-dir` flag bypasses the git-based resolver — use it with the literal SHIPYARD_DATA path from the context block. **If init-sprint fails, STOP and surface the error to the user — do NOT fall back to Write.** Writing SPRINT.md or PROGRESS.md from memory causes schema drift (missing `started_at: null` comments, wrong default `status`, extra sections not in the template) that breaks downstream invariants. The CLI substitutes `id:` and `created:` only; everything else stays at template defaults and gets filled in via `shipyard-data sprint set` (frontmatter) and a model Edit of the body, below.
2. Fill SPRINT.md from the approved plan in two parts:
   - **Frontmatter fields** — set each via `shipyard-data sprint set <key> <value>` (typed atomic frontmatter mutation): `sprint set goal "<goal>"`, `sprint set capacity <N>`, `sprint set features "<S001,S005>"`, `sprint set execution_mode <solo|task|track>`. Do NOT Edit SPRINT.md frontmatter by hand — hand-edits are the corruption class that welds frontmatter keys together; the CLI merges atomically.
   - **Body sections** — the narrative body (Goal, `### Wave N` sections, Critical Path, Risks, Swap Log) stays a model Edit on SPRINT.md. After writing the wave body, run `shipyard-data sprint check` to validate the `### Wave N` structure parses. If it exits 3, fix the wave formatting and re-run until it passes — the terminal gate parses this structure later, so unparseable waves would block sprint completion.
3. Update feature statuses to `in-progress` in story frontmatter.
4. Remove pulled feature IDs from BACKLOG.md.
5. **Record working branch** — capture the user's current branch: `git branch --show-current`. Set it via `shipyard-data sprint set branch <current branch>` (not a hand Edit of SPRINT.md frontmatter). Shipyard works on whatever branch the user is already on — it does not create sprint branches.

**Tell the tracker, when stories are linked to tickets.** Run `shipyard-data tracker plan --since <when this planning began>`. When it prints rows, **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/tracker-sync.md` § 3: the tickets learn that their stories are in this sprint (status, sprint, points, fix version). Show the plan and ask (or, with `tracker_sync: auto`, send and report), then `shipyard-data tracker decided --sync applied|later|none`. The lock release below is refused until that is recorded.

**Stop your helpers, then clean up the mutex:** `TaskStop` every named analyst or critic this run started (a hook records it; `lock release` refuses, exit 3, while one is still listed), then run `shipyard-data lock release planning --skill ship-sprint` (soft-delete sentinel — CLI-owned, never a hand Write). Planning is complete.

Then show:
```
▶ NEXT UP: Start building
  /ship-execute
  Long sprint, walk away: /goal run /ship-execute until its last line says CYCLE COMPLETE
  (tip: /clear first for a fresh context window)
```

---

### Compaction Recovery

If you lose context mid-planning (e.g., after auto-compaction):

0. **Call `TaskList()` first.** If the step-checklist tasks from PLAN mode Step 0 are present, the last `in_progress` (or first non-`completed`) task names the step to resume — a structured position anchor. Confirm against the file evidence below before resuming (tasks are a mirror, not authority; if tasks and files disagree, the files win).

1. Run `shipyard-context draft-state sprint` to inspect the draft checkpoint state, then use the Read tool on `<SHIPYARD_DATA>/sprints/current/SPRINT-DRAFT.md` for the narrative plan body only (substitute the literal SHIPYARD_DATA path).
   - If draft exists, check staleness: read `created` from frontmatter. If the draft is from a previous session (more than a few hours old) → AskUserQuestion with options labeled by their content, never abstract keep/discard verbs: **"Resume the draft with [S009, S011]"** / **"Discard it and replan from the backlog"** (choosing discard overwrites the existing draft). Naming the features makes the choice concrete.
   - If current/resumed → load it, skip to Step 11 (Present Plan and Confirm)
   - If "start fresh" → use the Write tool to overwrite SPRINT-DRAFT.md with the new draft content (no separate delete step needed; Write replaces).
2. If no draft, use Grep with `pattern: ^status: approved`, `path: <SHIPYARD_DATA>/spec`, `glob: {steps,tasks}/[PT]*.md`, `output_mode: files_with_matches` to find recently-created step files
   - Group by parent feature (each task has `feature:` in frontmatter)
   - **Verify completeness**: confirm all selected features have at least one step file. If any features have no tasks, those were not yet decomposed — fall through to branch 3 (restart from Step 1) rather than presenting an incomplete plan
   - These are the features selected in Step 2, decomposed in Step 4
   - Re-derive wave structure from task dependency fields (Steps 5-9)
   - Write SPRINT-DRAFT.md, proceed to Step 10
3. If no draft and no new step files → planning hadn't progressed past Step 3; restart from Step 1

The draft captures the full sprint plan (waves, critical path, execution mode). Step files capture the decomposition. Between these two, full state reconstructs from files.
