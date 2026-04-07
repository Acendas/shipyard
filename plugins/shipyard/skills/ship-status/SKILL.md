---
name: ship-status
description: "Project dashboard showing sprint progress, backlog health, spec coverage, state validation, and what to do next. Also validates and auto-fixes state inconsistencies. Use when the user asks about project status, progress, what's happening, what's left, what to work on next, wants a health check, suspects state corruption, or just wants an overview."
allowed-tools: [Read, Write, Edit, Grep, Glob, AskUserQuestion, "Bash(shipyard-context:*)"]
model: haiku
effort: low
argument-hint: "[sprint|backlog|health|spec]"
---

# Shipyard Status Dashboard

Read all project state, validate it, auto-fix issues, and present a clear dashboard.

## Context

!`shipyard-context path`
!`shipyard-context diagnose`

!`shipyard-context view config`
!`shipyard-context view sprint`
!`shipyard-context view sprint-progress`
!`shipyard-context view backlog`
!`shipyard-context view metrics 50`
!`shipyard-context debug-count`
!`shipyard-context view sprint-handoff`
!`shipyard-context status-counts`

**Paths.** All file ops use the absolute SHIPYARD_DATA prefix from the context block. No `~`, `$HOME`, or shell variables in `file_path`. No bash invocation of `shipyard-data` or `shipyard-context` — use Read / Grep / Glob.

## Input

$ARGUMENTS

If arguments specify a section (sprint, backlog, health, spec, diagnose), show only that section in detail.
If no arguments, show the full dashboard.
If project not initialized → "Project not initialized. Run /ship-init to get started."

**diagnose section** — when invoked as `/ship-status diagnose`, print only the resolver diagnostic block from the context above (SHIPYARD_DATA, PROJECT_ROOT, PROJECT_HASH, env vars, .auto-approve.log tail). This is the self-serve format for filing actionable bug reports about permission prompts or state divergence. Include a one-line interpretation note: if `AUTO_APPROVE_LOG=(does not exist)` the auto-approve hook has never fired for this project; if `CLAUDE_PLUGIN_DATA=(unset)` the resolver is using its discovery probe or legacy fallback.

---

## Step 1: Validate & Auto-Fix (silent)

Before showing the dashboard, run health checks and fix what can be fixed automatically. Do NOT prompt the user for each fix — just fix it and report what was fixed at the bottom of the dashboard.

### Check 1: Frontmatter Schema

Use Glob to enumerate every `.md` file under `<SHIPYARD_DATA>/spec/` (substitute the literal SHIPYARD_DATA from the context block), then Read each one and validate frontmatter:

**Feature files** — required: `id` (F+digits), `title` (non-empty), `type` (feature), `epic` (string), `status` (proposed|approved|in-progress|done|deployed|released|cancelled), `story_points` (≥0), `complexity` (low|medium|high|""), `token_estimate` (≥0), `rice_reach` (0-10), `rice_impact` (0-3), `rice_confidence` (0-100), `rice_effort` (>0), `rice_score` (≥0), `dependencies` (list), `references` (list), `tasks` (list), `created` (date)

**Task files** — required: `id` (T+digits), `title` (non-empty), `feature` (valid feature ID), `status` (pending|in-progress|done|blocked), `effort` (S|M|L), `dependencies` (list)

**Bug files** — required: `id` (B+digits), `title`, `status`, `severity`

**Idea files** — required: `id` (IDEA+digits), `title`, `status`

**Epic files** — required: `id` (E+digits), `title`, `status`

**Auto-fix:** Backfill missing fields with defaults where safe (e.g., `dependencies: []`, `references: []`, `tasks: []`). Log unfixable issues (wrong type, invalid status).

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

- Empty spec files → Edit frontmatter to `obsolete: true`
- Orphan task files (not in any feature's `tasks:` array) → log as warning
- Epic files with `features:` arrays → remove the array (membership is derived)
- Stale `<SHIPYARD_DATA>/.loop-state.json` → Write `{"cleared": "<iso>", "events": []}`
- Stale `<SHIPYARD_DATA>/.active-session.json` (>24h old) → Write `{"skill": null, "cleared": "<iso>"}`
- Stale `<SHIPYARD_DATA>/.compaction-count` (no active execution lock) → Write content `0`
- `<SHIPYARD_DATA>/.active-execution.json` — Read it, parse JSON. If `cleared` is set, ignore. Otherwise: if `started` is >2h old, Write the cleared sentinel automatically; if <2h, show it in the dashboard and AskUserQuestion: "Execution lock found ([skill], started [time]). Still running? (yes, leave it / no, clear it)". On clear, Write the cleared sentinel.

### Check 7: File Size Health

- `metrics.md` > 300 lines → quarterly rollover. Read the file, split off the older content, use Write to create `<SHIPYARD_DATA>/memory/metrics-[quarter].md`, then use Edit to truncate the original `metrics.md` to the current quarter only.
- `BACKLOG.md` > 200 lines → archive completed items by Edit (remove their IDs); the underlying feature files keep their `status: done|released` and are reaped by `reap-obsolete` after retention.
- `reconcile-log.md` > 200 lines → Read it, then use Write to overwrite with the last 10 entries.

**All fixes are silent.** The dashboard shows a summary line at the bottom: "Auto-fixed: N items" with a brief list. Only use AskUserQuestion for destructive ambiguous issues (duplicate IDs, tasks referencing deleted features).

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
    Wave 2: [██░░░] 2/5 tasks | T012 blocked
    Wave 3: ⬜ [N] tasks pending
  Critical path: [T001 → T003 → T007] — [on track / delayed by T003]
  Blocked: [N] ([task IDs + reasons])
  Time: ~[N]hrs elapsed | ~[M]hrs remaining (at [X] pts/hr)

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
1. **RESUME** — HANDOFF.md exists → "Run /ship-execute to resume from [task]"
2. **DEBUG** — active debug sessions → "Run /ship-debug --resume"
3. **BLOCKER** — blocked task needs human input → "Unblock [task]: [reason]"
4. **REVIEW** — completed work waiting for approval → "Run /ship-review"
5. **EXECUTE** — sprint has unstarted tasks → "Run /ship-execute"
6. **PLAN** — approved features but no sprint → "Run /ship-sprint"
7. **DISCUSS** — proposed features need refinement → "Run /ship-discuss [ID]"
8. **GROOM** — backlog health issues → "Run /ship-backlog groom"
9. **IDLE** — nothing pending → "Run /ship-discuss to explore new features"

## Rules

- Compute ALL metrics from **source files** (feature files, task files) — never from aggregate views
- Never guess or use placeholder numbers
- If a section has no data, say so briefly — don't show empty tables
- Always end with NEXT ACTION
- Flag issues: ⚠️ warnings, ❌ blockers
- Keep output scannable — tables and bullets, no paragraphs
- Auto-fix silently. Only AskUserQuestion for destructive ambiguous issues.
- Append fixes to `<SHIPYARD_DATA>/reconcile-log.md` (use Read to get current contents, then Write back with the appended line — one line per fix with date)

## Detailed Views

### /ship-status sprint

Per-feature progress within the sprint, then per-wave task breakdown:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPRINT [NNN] — [goal]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 FEATURES
  F001: [title]  [████████░░] 4/5 tasks | 8 pts
  F005: [title]  [██████████] 3/3 tasks | 5 pts ✅

 WAVES
  Wave 1: ✅ complete
    ✅ T001: [title] (S) — feat(T001): [commit msg]
    ✅ T002: [title] (M) — feat(T002): [commit msg]

  Wave 2: in-progress
    ✅ T003: [title] (M) — feat(T003): [commit msg]
    🔄 T004: [title] (L) — in-progress
    ⛔ T005: [title] (S) — blocked: [reason]

  Wave 3: pending
    ⬜ T006: [title] (M) — depends on T004
    ⬜ T007: [title] (S)

 CRITICAL PATH: T001 → T003 → T004 → T006
   Status: delayed at T004 (in-progress longer than estimate)

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
   ✅ F001: Login          ✅ F002: Register     ✅ F003: Password Reset

 E002: Payments           [██████░░░░]  60% | 12/20 pts
   ✅ F004: Card Pay       🔄 F005: Refunds      ⬜ F006: Split Pay

 E003: Notifications      [██░░░░░░░░]  20% | 4/20 pts
   ✅ F007: Email          ⬜ F008: Push          ⬜ F009: In-App

 Ungrouped:               [░░░░░░░░░░]   0% | 0/10 pts
   ⬜ F010: Dark Mode      ⬜ F011: Export

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Status indicators: ✅ done/released | 🔄 in-progress | ⬜ proposed/approved | ⛔ blocked
