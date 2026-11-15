# Retro and Release — stage procedure and mechanics

Loaded by SKILL.md for the RETROSPECTIVE and RELEASE paths; the pause-before-ask rule, `## Rules` and Wrap Up stay in SKILL.md and still apply.

## Sprint Retrospective

After sprint approval (or when `--retro-only` is passed), the retrospective runs by default — it is data-derived and costs the user nothing; `--skip-retro` goes directly to release planning. There is no "run a retro?" question (4.4): Retro Decision is a decide-and-inform tick. If `--retro-only` with a sprint ID, Read that sprint's archived files from `<SHIPYARD_DATA>/sprints/sprint-NNN/` instead of `current/`.

### Retro Decision (stage_id: retro_decision)
Print one line — `Retro: running (sprint size, patch tasks, review iterations, <n> decisions made for you)` — and advance: `shipyard-data cursor advance review retro_step_1 --note "Gather retrospective data"`. With `--skip-retro`: `shipyard-data cursor advance review release_step_1 --note "Retrospective skipped (--skip-retro); present release plan"`. No `AskUserQuestion` here. Echo the CLI output. Do not ask the three retro questions unless `execution.unattended: false` (see Step 2) or the user choe **Run retro**.

The retro runs in four steps with compaction recovery via `RETRO-DATA.md`'s `step` frontmatter field.

**Agentic retrospective quality bar.** Step 1 is the primary artifact: derive facts from event logs, cursor history, step files, verification ledger reuse, patch-task count, blocker/salvage events, repeated build/test dispatches, and review findings. Step 2 asks the user only for judgment that cannot be inferred from data. Step 3 creates at most five IDEAs, only when the action would change future Shipyard behavior, sprint planning, quality gates, or project defaults; duplicate, vague, or one-off observations stay in `RETRO-DATA.md` as notes. Classify every candidate as `project`, `process`, or `shipyard-framework`; `shipyard-framework` issues follow the plugin issue detection rule below and do not enter the user's project backlog.

### Retro Compaction Recovery

If you lose context mid-retro:
1. Check for `RETRO-DATA.md` in the sprint directory
2. Read frontmatter `step` field: `data_gathered` → skip to Retro Step 2, `feedback_collected` → skip to Retro Step 3, `action_items_created` → skip to Retro Step 4
3. If no RETRO-DATA.md → start from Retro Step 1

### Retro Step 1: Gather Data (stage_id: retro_step_1)
Compute planned-vs-delivered, velocity, carry-over, bugs, blocked time, swaps, patch tasks, estimate accuracy, throughput from SPRINT.md + task/story files. Write to `RETRO-DATA.md` (`step: data_gathered`) and present the summary block.

Compute from source files (read SPRINT.md for task IDs, then read each step file for status/effort, and each story file for points):
- **Planned vs delivered** — count step files with `status: done` vs total tasks
- **Velocity** — sum story points from completed features
- **Carry-over** — tasks not finished (and why)
- **Bugs found** — filter by `found_during` matching sprint ID
- **Blocked time** — total time tasks spent blocked
- **Swaps** — mid-sprint scope changes
- **Patch tasks** — gaps found during review
- **Estimate accuracy** — planned effort vs actual per task
- **Token accuracy** — compare `token_estimate` from story frontmatter (planned) against actual if available. Actual token usage isn't tracked; record as "estimated: NNK".
- **Agentic delivery signals** — build/test rerun count, verification-ledger reuse count, code-review iterations, gap-analysis iterations, patch tasks created during review, user-flow probe failures, timeout/salvage events, and Shipyard plugin issue candidates.

**Throughput (display only, never recorded here):**
1. Read `started_at`, `completed_at`, `total_paused_minutes` from SPRINT.md frontmatter
2. If both timestamps present: `active_minutes` = elapsed - paused; if `active_minutes > 0` show `pts_per_hour` in the summary block as wall-clock throughput, labeled "wall-clock minus declared pauses"; if `active_minutes <= 0` warn about incomplete timing data
3. If timestamps missing: omit throughput
4. The RECORDED rate (`throughput.recent`) is written once, by `shipyard-data archive-sprint`, from the event log's active time — `record-retro` refuses a `throughput=` field. The two figures differ by design (undeclared idle time is excluded from the recorded one).

Summary block:

```
SPRINT [NNN] RETROSPECTIVE

Planned: [N] tasks ([M] pts) across [W] waves
Delivered: [N] tasks ([M] pts)
Carry-over: [N] tasks ([M] pts)
Velocity: [N] pts (previous: [M] pts)
Throughput: X.X pts/hr (M.M hrs active)
Bugs: [N] | Blocked incidents: [N]
Estimate accuracy: [avg]% (range: [min]%-[max]%)
```

- **Cursor advance**: run `shipyard-data cursor advance review retro_step_2 --note "Facilitate retro discussion (one bulk AskUserQuestion)"`.

### Retro Step 2: Facilitate Discussion (stage_id: retro_step_2)
**Default (`execution.unattended: true`): no question.** Render the observations as chat text — the RETRO-DATA.md summary block, the flagged issues, the suggested improvements, and the **Decisions made for you** table (every `execute_decision` of the sprint) — then write the three answers yourself from the data under `## Team Feedback` (`went well` / `didn't go well` / `change next sprint`, each marked `source: data-derived`), set `step: feedback_collected`, and continue; the user amends by typing (`retro: …`) at any point, and the answers are re-rendered at release. Only when `execution.unattended: false`: pause before asking (per the pause-before-ask rule): run `shipyard-data cursor pause review --note "awaiting user: retro discussion"` before the `AskUserQuestion`. Render the observations as chat text first — the RETRO-DATA.md summary block, the flagged issues, and the suggested improvements (RETRO-DATA.md content and question strings do not count as shown) — then ask all three in **ONE** `AskUserQuestion` call (three questions), each led by its data-driven observation and each with a cheap exit ("'skip' is fine"):
1. **What went well?** — lead with what the data shows went well.
2. **What didn't go well?** — lead with the flagged issues.
3. **What should we change next sprint?** — lead with the suggested improvements.

On the user's answers, run `shipyard-data cursor resume review`, append responses to `RETRO-DATA.md` under `## Team Feedback`, and update frontmatter: `step: feedback_collected`.

- **Cursor advance**: after the answers are collected, run `shipyard-data cursor advance review retro_step_3 --note "Create IDEA action items"` and echo its output.

### Retro Step 3: Create Action Items (stage_id: retro_step_3)
For each actionable improvement, allocate an ID via `shipyard-data next-id ideas` (never `ls`-and-guess) and Write `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` with `source: retro/<sprint-id>` (slash form — matches the carry-over scan regex). Cap this at 5 IDEAs per retrospective and require each IDEA to name the trigger metric or event evidence from `RETRO-DATA.md`; otherwise leave it as a retro note. Update `RETRO-DATA.md`: `step: action_items_created`, `ideas_created: [IDEA-<id>, ...]`.

**Allocate the ID.** Run `shipyard-data next-id ideas` — the CLI returns a zero-padded 3-digit string (e.g., `042`). Use it as `IDEA-042` in the filename and the `id` frontmatter field. **Do NOT `ls spec/ideas/` and pick a number manually** — parallel sessions would race. It never refuses on backlog size — a `WARNING — N undispositioned idea(s) at/over cap` line still returns a valid id on stdout, and the cap is enforced at sprint-open instead (`/ship-sprint` Step 0.5).

**Write the file** via the Write tool at `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` with this frontmatter:
```yaml
---
id: IDEA-<id>
title: "[improvement]"
type: improvement
status: proposed
source: retro/<sprint-id>
story_points: [estimate]
created: [today]
---
```

**Source-tag format.** `source: retro/<sprint-id>` (slash-separated origin, e.g., `retro/sprint-007`) is required so the carry-over scan's regex `^source: (execute|review-gap|retro)/` matches; the legacy hyphen form `retro-sprint-NNN` is still read, but new IDEAs use the slash form.

- **Cursor advance**: run `shipyard-data cursor advance review retro_step_4 --note "Update metrics"`.

### Retro Step 4: Update Metrics (stage_id: retro_step_4)
Metrics are CLI-owned: `memory/metrics.json` is authoritative and `memory/metrics.md` is generated. Do not Write/Edit either file. Run `shipyard-data metrics record-retro sprint=<sprint-NNN> carry_over="<summary>" bug_rate="<summary>" estimate_accuracy="<summary>" flags="<csv_or_none>"`. Never pass `throughput=` — the CLI refuses it: `archive-sprint` records delivered velocity AND points per hour (from the event log) exactly once before rotating `current/`, which keeps the next `/ship-sprint` capacity and rate lookups deterministic. Save key insights to memory.

- **Bounded retention** — the CLI keeps only the last 10 detailed sprint records and cumulative all-time count/total/min/max/average; do not create quarterly metrics archives by hand.

- **Cursor advance**: run `shipyard-data cursor advance review release_step_1 --note "Present release plan, AskUserQuestion approval"`.

### Anti-Pattern Detection

During retro, flag:
- **Overloading** — planned >120% of capacity
- **Over-building** — tasks 2x+ estimate without scope change
- **Estimation gaps** — estimates consistently off by >50%
- **Zombie stories** — same items in 2+ sprints, never completed
- **Scope creep** — too many mid-sprint swaps

Present as observations, not judgments.

### Shipyard Plugin Issue Detection

Some retro findings are **Shipyard plugin problems**, not user project problems — worktree isolation failures, agent early returns, SubagentStop hook misfires, salvage loops, broken hooks, silent-pass regressions, context pressure false positives, etc.

**How to detect:** If a deviation, anti-pattern, or "what didn't go well" item references any of these:
- Claude Code bug numbers (`#29110`, `#37549`, `#39973`, etc.)
- Shipyard hook names (`auto-approve-data`, `worktree-branch`, `plugin-data-breadcrumb`)
- Shipyard internal state (`.active-execution.json`, `.compaction-count`, `.shipyard-events.jsonl`)
- Agent dispatch failures (builder early return, builder salvaged, spec-check not converging)
- Worktree branch issues (CWD drift, wrong branch, worktree probe failures)

Then it's a Shipyard issue, not a project issue. **Do NOT create an IDEA file** — the user's project backlog is not the place for plugin bugs. Write it down with the CLI, one call per problem:

```
shipyard-data plugin-issue add --title "<the problem in one line>" --detail "<what happened, with the evidence>" --sprint <sprint id>
```

It saves the problem in the project's data folder and prints one line. **Show that line as it is and add nothing to it.** Nothing is sent anywhere: reporting is the owner's action, and no closing summary may say that an issue was "sent", "filed" or "reported". Do not ask a question about it; continue the retro.

---

## Release

After retro completes, generate the release record. This is a changelog + status tracker — Shipyard does not create git tags, push, or create GitHub releases.

### Release Step 1: Present Release Plan (stage_id: release_step_1)
Read all `status: done` features from this sprint. Output the release plan as text — CHANGELOG block, STATUS CHANGES, RETRO HIGHLIGHTS when available, FILES WRITTEN. If `--skip-retro` was passed or no `RETRO-DATA.md` exists, write `RETRO HIGHLIGHTS: skipped by explicit user flag` instead of inventing metrics.

Output the release plan as text:

**CHANGELOG** — what ships:
```
 FEATURES
  - S001: [title] — [one-line description from spec]
  - S005: [title] — [one-line description from spec]

 BUG FIXES
  - B001: [title]
```

**STATUS CHANGES** — what moves:
- Features: [IDs] status `done` → `released`, `released_at: [date]`
- Sprint: archived to `<SHIPYARD_DATA>/sprints/sprint-NNN/`

**RETRO HIGHLIGHTS** — key numbers from the retro (if just completed):
- Velocity, throughput, estimate accuracy
- Action items created

**FILES WRITTEN** — what changes on disk:
- CHANGELOG.md in project root (prepended)
- Story file frontmatter updates
- Sprint directory archived

Pause before asking (per the pause-before-ask rule): run `shipyard-data cursor pause review --note "awaiting user: release approval"` before the `AskUserQuestion`. This approval is load-bearing (most irreversible action) — never skip it. Then use `AskUserQuestion` for approval:
- **Release (Recommended)** — proceed to Release Step 2 (write everything, commit `CHANGELOG.md`)
- **Edit changelog** — adjust changelog text, then re-approve
- **Skip release** — skip release record, still archive sprint

On the user's answer, run `shipyard-data cursor resume review`, then advance:

- **Cursor advance**: on **Release** → run `shipyard-data cursor advance review release_step_2`. On **Skip release** → run `shipyard-data cursor advance review archive`. On **Edit changelog** → run `shipyard-data cursor advance review release_step_1 iteration=<N+1> --note "Re-present after changelog edit"` (self-tick). Echo the CLI output in each case.

### Release Step 2: Write Release Record (stage_id: release_step_2)
Update story frontmatter (`shipyard-data story set-status <S###> released` — `done → released` is a legal transition, and the CLI writes `released_at` itself). Commit, by path, every project file this review wrote (the owner's answers recorded in a design doc): `archive-sprint --via-review` is refused while a file that became dirty during the review is uncommitted. Then prepend the new entry to `CHANGELOG.md` in the **project root** (not plugin data — this is a project deliverable that belongs in git).

Create `CHANGELOG.md` if absent; newest entry first. Then commit exactly that file — `git add CHANGELOG.md && git commit -m "docs(changelog): sprint-NNN"` — the user approved the release one question ago, and an uncommitted changelog is what the next `/ship-execute` readiness step would otherwise find dirty.

- **Cursor advance**: run `shipyard-data cursor advance review release_step_3`.

### Release Step 3: Archive Sprint (stage_id: release_step_3)
The archive finishes the cycle's state itself (4.6): each sprint story still in-progress becomes `done` when its verdict recommends approve, or goes back to the backlog as `approved` when it was not finished; epics follow their stories; backlog rows for closed work are removed — report the `sprint_story_finalized` lines it logs. Run `shipyard-data archive-sprint sprint-NNN --via-review` from Bash (`--via-review` marks this as review's own archive, skipping the unreviewed-sprint gate). This atomically renames `current/` → `sprint-NNN/` and recreates an empty `current/`. Do NOT synthesize raw `cp`/`mv`/`mkdir` against the plugin data dir — they're not portable and not atomic.

- **Cursor advance**: the archive operation rotates `current/` so the cursor file goes with it — that is by design, and the wrap-up below runs the terminal advance against the *absent* cursor. The CLI handles this seam first-class: a terminal advance with no cursor runs the terminal-evidence gate against the (persistent) event log, emits the canonical `pipeline_terminal` event, and **writes no cursor** — it prints `cursor: (archived) → terminal …` plus the stop marker. Writing a terminal cursor into the freshly-recreated empty `current/` would plant a stale terminal cursor that no-ops the NEXT sprint and false-trips the leak alarm; the event, not a cursor file, is the terminal signal here.
