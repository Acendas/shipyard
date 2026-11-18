---
name: ship-status
description: "Show the Shipyard project dashboard and next steps."
allowed-tools: [Read, Write, Edit, Grep, Glob, AskUserQuestion, "Bash(shipyard-context:*)", "Bash(shipyard-data:*)"]
argument-hint: "[sprint|backlog|health|spec|diagnose]"
model: haiku
---

# Shipyard Status Dashboard

Read all project state, validate it, auto-fix issues, and present a clear dashboard.

## Context

!`shipyard-context diagnose`
!`shipyard-context status-dashboard`

**Shell.** Bash is for `shipyard-context` (reads), the onboarding command surfaced by context, and `shipyard-data lock status|release`, `shipyard-data reconcile [--fix]` (state drift left by an ended cycle: run it, apply `--fix`, and report what it repaired under STATE) plus `shipyard-data metrics regenerate` (CLI-owned housekeeping — see Check 6/7) ONLY — no other `shipyard-data` subcommand and no other shell. Use the Write tool for the reconcile-log and sentinel files this skill maintains. Metrics are CLI-owned: `memory/metrics.json` is authoritative and `memory/metrics.md` is generated; never Write/Edit either metrics file. **`/ship-status` consumes pipeline cursor, PROGRESS.md, and SPRINT.md summaries from `shipyard-context status-dashboard`; it never writes them and never parses cursor frontmatter itself** (the PreToolUse hook denies model writes to those; the `shipyard-data`/`shipyard-context` CLIs are their only state interface). HANDOFF.md is retired — a paused pipeline is a cursor with `status: paused`. The two skill-mutex lock files (`.active-session.json`, `.active-execution.json`) are CLI-owned too — this skill never hand-Writes them, only `shipyard-data lock status` (read) / `lock release ... --force` (clear).

**Render before asking.** Follow SHIPYARD_STARTUP_RULES and SHIPYARD_ONBOARDING_INSTRUCTION from startup. When `SHIPYARD_ONBOARDING_REQUIRED=true`, run `SHIPYARD_ONBOARDING_COMMAND` immediately and render the dashboard from the result — it writes only Shipyard's own `config.md` and is reversible, so it is never something to ask about first ("say the word" on an empty dashboard is the blind first impression this rule exists to prevent).

## Input

$ARGUMENTS

If arguments specify a section (sprint, backlog, health, spec, diagnose), show only that section in detail.
If no arguments, show the full dashboard.

**diagnose section** — when invoked as `/ship-status diagnose`, print only the resolver diagnostic block from the context above (SHIPYARD_DATA, PROJECT_ROOT, PROJECT_HASH, env vars, .auto-approve.log tail). Include a one-line interpretation note: if `AUTO_APPROVE_LOG=(does not exist)` the auto-approve hook has never fired for this project; if `CLAUDE_PLUGIN_DATA=(unset)` the resolver is using its discovery probe or legacy fallback.

**Pipeline cursors.** `/ship-status` uses the `SHIPYARD_EXECUTE_CURSOR_*` and `SHIPYARD_REVIEW_CURSOR_*` fields from `shipyard-context status-dashboard` and renders their state in the PIPELINE section of the dashboard (see Step 2). Do not Read or parse `EXECUTE-CURSOR.md` / `REVIEW-CURSOR.md` directly; cursor reads and writes are CLI-owned. Each cursor records where its pipeline (`ship-execute` or `ship-review`) is in the multi-stage flow, whether it's terminal, and whether stuck detection has fired. Schema details live in `<repo>/plugins/shipyard/skills/ship-execute/references/pipeline-cursor.md` and the matching ship-review reference.

---

## Step 1: Validate & Auto-Fix (silent)

Before showing the dashboard, run health checks and fix what can be fixed automatically. Do NOT prompt the user for each fix — just fix it and report what was fixed at the bottom of the dashboard.

### Check 1: Frontmatter Schema (incremental, CLI-backed)

Run `shipyard-data doctor` (read-only). It applies the schema rules incrementally, so no whole-tree sweep: it tracks a watermark (`<SHIPYARD_DATA>/.doctor-watermark.json`, `{lastCleanAt, schemaVersion}`) and only re-validates files whose mtime is newer than the last fully-clean run. It falls back to a full sweep when the watermark is absent, corrupted, or from a different `schemaVersion` (a rule-set change invalidates prior clean claims); pass `--full` to force one (e.g. after a manual bulk edit under `spec/`). The watermark only advances past a zero-finding scan, so an unfixed file never ages out of a later check.

`doctor` validates these fields:

**Story files** — required: `id` (F+digits), `title` (non-empty), `type` (feature), `epic` (string), `status` (proposed|approved|in-progress|done|deployed|released|deferred|rejected), `story_points` (≥0), `complexity` (low|medium|high|""), `token_estimate` (≥0), `rice_reach` (0-10), `rice_impact` (0-3), `rice_confidence` (0-100), `rice_effort` (>0), `rice_score` (≥0, cached derived value), `dependencies` (list), `references` (list), `tasks` (list), `created` (date)

**Step files** — required: `id` (T+digits), `title` (non-empty), `feature` (valid feature ID), `status` (pending|in-progress|done|blocked|needs-attention), `effort` (S|M|L), `dependencies` (list). The `needs-attention` status is set by the operational fix-findings loop or the research dispatcher when escalation triggers — it means "prior attempt produced a full audit trail but the task did not converge; needs a human decision." Distinct from `blocked` (waiting on an external dependency). See `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/task-kinds.md` for the escalation semantics.

**Bug files** — required: `id` (B+digits), `title`, `status`, `severity`

**Idea files** — required: `id` (IDEA+digits), `title`, `status`

**Epic files** — required: `id` (E+digits), `title`, `status`

`doctor`'s output names, per finding, the `kind` (features/tasks/bugs/ideas/epics), the `file`, and the `problem` (missing/empty required field, invalid status, malformed id) — it does NOT auto-fix.

**Auto-fix:** for each finding whose field has a safe default (`dependencies: []`, `references: []`, `tasks: []`), Edit that specific file named in the finding — never re-Glob-and-Read the whole tree to locate it, `doctor` already named the file. **Log unfixable issues** (wrong type, invalid status, malformed id) exactly as before.

### Check 2: ID & Reference Integrity

- Duplicate IDs → log as error (can't auto-fix — user must rename)
- Broken dependency refs → remove invalid IDs from `dependencies:` array
- Feature references non-existent epic → clear `epic:` field
- Task references non-existent feature → log as error
- Bidirectional dependency mismatch → add missing back-reference

### Check 3: Backlog Consistency

- IDs pointing to done/released/in-progress features → remove from BACKLOG.md
- IDs pointing to non-existent files → remove from BACKLOG.md
- Old multi-column format → migrate to ID-only format
- Rank order doesn't match RICE → re-sort (unless override reasoning exists)

### Check 4: Sprint Consistency

- Task IDs not matching real files → remove from SPRINT.md
- Wave assignments violating dependencies → log as error
- SPRINT.md has old data columns → migrate to ID-only format

### Check 5: Git Alignment

Skip if not a git repo. Otherwise:
- Features marked `done` without commits → log as warning
- Features marked `released` without tags → log as warning

### Check 6: File Hygiene

State files use the soft-delete sentinel pattern: overwrite with a "cleared" marker rather than physically deleting. The relevant hooks treat the sentinel as inactive.

- Empty spec files → surface as a repair recommendation; do not hand-Edit frontmatter. Spec frontmatter mutations must go through typed `shipyard-data feature|idea|task|draft ...` commands.
- Orphan step files (not in any feature's `tasks:` array) → log as warning
- Epic files with `features:` arrays → remove the array (membership is derived)
- Stale autonomous-driver state from older plugin versions → surface as dead state only; do not preserve or restart it. Command skills are driven by their CLI cursor state and `/goal`, not a legacy loop state file.
- Stale `<SHIPYARD_DATA>/.compaction-count` file (legacy) → harmless dead state from an older plugin version; ignore it (no longer written or read). Do not shell out to `rm` — `/ship-status` never invokes generic shell commands against the data dir (see Paths rule above); `shipyard-data lock ...` is the one sanctioned exception.
- **Skill-mutex locks** — run `shipyard-data lock status` to read all three locks in one call (`planning` for `/ship-sprint`, `execution` for execute/review/debug, `discuss` for `/ship-discuss`; different commands never block each other, 4.17); never Read/parse the raw JSON by hand and never hand-Write either file (both are CLI-owned — see Paths rule above). The CLI's own 2-hour stale threshold applies to both locks uniformly (the old 24h-for-planning / 2h-for-execution split is gone — one constant, defined once in `bin/skill-lock.mjs`). `lock status` reports each lock's `state` as one of `free | released | stale | mine | held`. Render:
  - **`state: "stale"`** (any kind) → run `shipyard-data lock release <planning|execution|discuss> --force` automatically, no AskUserQuestion — matches the old auto-clear-when-stale behavior for planning, and extends the same auto-clear to a stale execution lock (previously execution never auto-cleared even when stale).
  - **Execution, `state: "held"` or `"mine"`** (fresh) → show it in the dashboard and AskUserQuestion: "Execution lock found ([skill], started [time]). Still running? (yes, leave it / no, clear it)". On "no, clear it" → run `shipyard-data lock release execution --force`.
  - **Planning or discuss, `state: "held"` or `"mine"`** (fresh) → informational only in this check (surfaced elsewhere in the dashboard's pipeline/state sections) — do not auto-clear or ask here; a live planning session ending normally releases its own lock.
  - `state: "free"` or `"released"` → nothing to report.

### Check 7a: Pipeline Cursor Health

Use the cursor fields emitted by `shipyard-context status-dashboard` (`SHIPYARD_EXECUTE_CURSOR_*`, `SHIPYARD_REVIEW_CURSOR_*`). The CLI parser has already normalized the frontmatter into fields:

- Required fields present: `pipeline`, `sprint`, `stage`, `iteration`, `last_advance_at`, `status`, `terminal`, `stuck_counter`, `hard_ceiling`.
- `terminal` is a boolean; `iteration` and `stuck_counter` are non-negative integers; `hard_ceiling` is 50 by default.
- `last_advance_at` is an ISO 8601 timestamp.

Detection rules:

- **Stale cursor** — `last_advance_at` older than 2 hours and `terminal: false` and `status: in_progress`: surface a warning in the STATE section. Do NOT auto-clear; the user may be debugging or paused. (`/ship-status` only reads and surfaces state — it never emits events; the pipeline itself emits `pipeline_stuck`.)
- **Terminal stale** — `terminal: true` cursors left in `current/` after sprint archival should not exist (archive rotates `current/` to `sprint-NNN/`). If a `terminal: true` cursor sits in `current/` AND SPRINT.md is missing or `status: completed`, this is reconciliation drift; surface a warning.
- **Corrupted frontmatter** — refuse to render PIPELINE section; surface "PIPELINE cursor unreadable, run /ship-status --repair" warning.

### Check 7: File Size Health

- `metrics.md` > 80 lines or missing while `metrics.json` exists → run `shipyard-data metrics regenerate`. The CLI rewrites the generated markdown summary from the bounded JSON ledger; do not roll, truncate, Write, or Edit metrics files by hand.
- `BACKLOG.md` > 200 lines → surface it, do not mutate it (`/ship-status` is read-only and BACKLOG.md IDs are CLI-owned — `shipyard-data backlog remove/rank`, not a hand-Edit): "BACKLOG.md over 200 lines — run `/ship-backlog archive`."
- `reconcile-log.md` > 200 lines → Read it, then use Write to overwrite with the last 10 entries.

**All fixes are silent.** The dashboard shows a summary line at the bottom: "Auto-fixed: N items" with a brief list. Only AskUserQuestion for destructive ambiguous issues — and render the conflicting records as chat text first (the duplicate IDs with both file paths, or the task ID and the missing feature it references) before asking. Validation findings sitting in Read results don't count as shown.

---

## Step 2: Show Dashboard

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SHIPYARD STATUS — [Project Name]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 PRODUCT
  Overall: [████████░░] [N]% | [done pts]/[total pts] story points shipped
  Epics:
    E001: [title]  [████████░░] 80% | 24/30 pts
    E002: [title]  [███░░░░░░░] 30% | 5/18 pts
  Pipeline: [N] proposed → [N] approved → [N] in-progress → [N] done → [N] released
  Bugs: [N] open | Ideas: [N] pending

 SPRINT ([id] — [goal])
  Status: [status] (day [N] of ~[M])
  Progress: [████████░░] [done pts]/[total pts] pts | [done]/[total] tasks
  Waves: [current wave] of [M]
    Wave 1: ✅ [N] tasks done
    Wave 2: [██░░░] 2/5 tasks | P012 blocked
    Wave 3: ⬜ [N] tasks pending
  Critical path: [P001 → P003 → P007] — [on track / delayed by P003]
  Blocked: [N] ([task IDs + reasons])
  Time: ~[N]hrs elapsed | ~[M]hrs remaining (at [X] pts/hr)

 PIPELINE (per-tick cursor state)
  Execute: stage=<stage_id> wave=<N>/<M> iter=<I> status=<status> terminal=<bool> last=<ISO>
    next: <next_action one-liner from cursor body>
    ⚠ stuck_counter=<N> (since <ISO>) — pipeline_stuck has fired   [only if applicable]
  Review:  stage=<stage_id> iter=<I> status=<status> terminal=<bool> last=<ISO>
    next: <next_action one-liner from cursor body>
    ⚠ stuck_counter=<N> — review pipeline_stuck has fired   [only if applicable]
  (omit either line if its cursor file doesn't exist; render "PIPELINE: no active cursors" if both absent)

 QUICK RUNS   [only when the context has SHIPYARD_QUICK_RUN or SHIPYARD_QUICK_RUNS]
  <run> — <open at <stage> | built, not merged yet> — branch <name>
  (inside a run, say so first: "This is quick run <run> on branch <name>; the regular project is on your other branches.")

 CARRY-OVER (from previous sprints)
  [N] open bugs | [N] blocked tasks | [N] retro items | [N] incomplete features
  (details: /ship-sprint will show these before feature selection)

 BACKLOG
  Ready to pull: [N] features ([total pts] pts) — next: [top feature by RICE]
  Proposed: [N] features awaiting approval
  ⚠️ Stale: [N] items haven't been touched in 60+ days
  ⚠️ Zombie stories: [N] items planned in multiple sprints

 HEALTH
  Velocity: [N] pts/sprint (avg last 3) — trend: [↑/↓/→]
  Throughput: [N] pts/hr — trend: [↑/↓/→]
  Carry-over rate: [N]% — trend: [↑/↓/→]
  Bug rate: [N] bugs/feature
  Estimate accuracy: [N]% (planned vs actual)
  ⚠️ [Any anti-pattern flags]

 STATE
  ✅ All checks passed (or: ⚠️ [N] issues auto-fixed, [M] need attention)
  [Brief list of what was fixed, if any]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 NEXT ACTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 → [Most important thing to do right now]
   [Specific command or action to take]
```

## Next Action Priority

Determine the single most important action:
1. **PIPELINE-TERMINAL** — EXECUTE-CURSOR or REVIEW-CURSOR has `terminal: true` AND `current/` not yet archived → "Pipeline complete; /goal should stop. Run /ship-review (or /ship-discuss) for the next cycle."
2. **PIPELINE-STUCK** — A cursor has `stuck_counter >= 5` or pipeline_stuck event in last 24h → "Stage [X] of [pipeline] hasn't progressed in [N] ticks. Inspect: /ship-status diagnose."
3. **PIPELINE-IN-FLIGHT** — A cursor exists with `terminal: false` and `last_advance_at` < 30 min ago → "Pipeline [pipeline] is mid-tick at [stage]. Next: [next_action]."
4. **RESUME** — EXECUTE-CURSOR.md has `status: paused` → "Run /ship-execute to resume from [stage] ([cursor note])"
5. **DEBUG** — active debug sessions → "Run /ship-debug --resume"
6. **BLOCKER** — blocked task needs human input → "Unblock [task]: [reason]"
7. **REVIEW** — completed work waiting for approval → "Run /ship-review"
8. **EXECUTE** — sprint has unstarted tasks → "Run /ship-execute"
9. **PLAN** — approved features but no sprint → "Run /ship-sprint"
10. **DISCUSS** — proposed features need refinement → "Run /ship-discuss [ID]"
11. **GROOM** — backlog health issues → "Run /ship-backlog groom"
12. **IDLE** — nothing pending → "Run /ship-discuss to explore new features"

## Rules

- Compute ALL metrics from **source files** (story files, step files) — never from aggregate views
- Never guess or use placeholder numbers
- If a section has no data, say so briefly — don't show empty tables
- Always end with NEXT ACTION
- Append fixes to `<SHIPYARD_DATA>/reconcile-log.md` (use Read to get current contents, then Write back with the appended line — one line per fix with date)

## Detailed Views

### /ship-status sprint

Per-feature progress within the sprint, then per-wave task breakdown:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPRINT [NNN] — [goal]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 FEATURES
  S001: [title]  [████████░░] 4/5 tasks | 8 pts
  S005: [title]  [██████████] 3/3 tasks | 5 pts ✅

 WAVES
  Wave 1: ✅ complete
    ✅ P001: [title] (S) — feat(P001): [commit msg]
    ✅ P002: [title] (M) — feat(P002): [commit msg]

  Wave 2: in-progress
    ✅ P003: [title] (M) — feat(P003): [commit msg]
    🔄 P004: [title] (L) — in-progress
    ⛔ P005: [title] (S) — blocked: [reason]

  Wave 3: pending
    ⬜ P006: [title] (M) — depends on P004
    ⬜ P007: [title] (S)

 CRITICAL PATH: P001 → P003 → P004 → P006
   Status: delayed at P004 (in-progress longer than estimate)

 TIMING
  Started: [date] | Elapsed: [N]hrs active
  Throughput: [N] pts/hr this sprint
  ETA: ~[M]hrs remaining ([remaining pts] pts at current rate)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### /ship-status backlog
Full ranked backlog with RICE scores, epic grouping, staleness flags, proposed features.

### /ship-status health

Velocity and throughput trends across last 5 sprints:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 HEALTH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 VELOCITY (pts/sprint)
  sprint-001: ████████░░  16 pts
  sprint-002: ██████████  20 pts
  sprint-003: █████████░  18 pts
  sprint-004: ██████████  21 pts
  sprint-005: ████████░░  17 pts (current)
  Avg: 18.4 pts | Trend: → stable

 THROUGHPUT (pts/hr)
  sprint-001: 6.2 | sprint-002: 7.8 | sprint-003: 8.1
  sprint-004: 9.2 | sprint-005: 8.5 (current)
  Avg: 7.9 pts/hr | Trend: ↑ improving

 ESTIMATE ACCURACY
  sprint-001: 72% | sprint-002: 85% | sprint-003: 91%
  Avg: 83% | Trend: ↑ improving

 CARRY-OVER RATE
  sprint-001: 20% | sprint-002: 10% | sprint-003: 5%
  Avg: 12% | Trend: ↓ improving

 ANTI-PATTERNS
  ⚠️ Overloading: sprint-005 planned at 110% capacity
  ✅ No zombie stories
  ✅ No estimation gaps >50%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### /ship-status spec

Per-epic completion matrix with feature status indicators and overall product progress:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPEC COVERAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Overall: [████████░░] 72% | 86/120 pts shipped

 E001: Auth System        [██████████] 100% | 30/30 pts
   ✅ S001: Login          ✅ S002: Register     ✅ S003: Password Reset

 E002: Payments           [██████░░░░]  60% | 12/20 pts
   ✅ S004: Card Pay       🔄 S005: Refunds      ⬜ S006: Split Pay

 E003: Notifications      [██░░░░░░░░]  20% | 4/20 pts
   ✅ S007: Email          ⬜ S008: Push          ⬜ S009: In-App

 Ungrouped:               [░░░░░░░░░░]   0% | 0/10 pts
   ⬜ S010: Dark Mode      ⬜ S011: Export

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Status indicators: ✅ done/released | 🔄 in-progress | ⬜ proposed/approved | ⛔ blocked | ⚠️ needs-attention
