# Retro and Release — Detailed mechanics

This reference holds the step-by-step detail for the Sprint Retrospective and Release stages. SKILL.md keeps the one-paragraph "what runs at each stage" summary plus all `AskUserQuestion` decision points and the upstream-vs-project routing rule for retro findings; the per-step mechanics live here.

## Sprint Retrospective

After sprint approval, ask at `retro_decision` whether to run or skip the retrospective. Run it only if the user chooses **Run retro**, unless `--retro-only` was passed. `--skip-retro` bypasses the decision and goes directly to release planning/archive.

At `retro_decision`, render a short data-derived recommendation first: sprint size, patch-task count, review iterations, salvage/timeout/plugin issue signals, and whether this looks like a high-learning sprint. Pause before asking with `shipyard-data cursor pause review --note "awaiting user: retro decision"`, then ask one question: **Run retro** or **Skip retro**. Do not ask the three retro questions unless the user chose **Run retro**.

If `--retro-only` with a sprint ID (e.g., `--retro-only sprint-003`), Read that sprint's archived files from `<SHIPYARD_DATA>/sprints/sprint-NNN/` instead of `current/`.

### Retro Compaction Recovery

If you lose context mid-retro:
1. Check for `RETRO-DATA.md` in the sprint directory
2. Read frontmatter `step` field: `data_gathered` → skip to Retro Step 2, `feedback_collected` → skip to Retro Step 3, `action_items_created` → skip to Retro Step 4
3. If no RETRO-DATA.md → start from Retro Step 1

### Retro Step 1: Gather Data

Compute from source files (read SPRINT.md for task IDs, then read each task file for status/effort, and each feature file for points):
- **Planned vs delivered** — count task files with `status: done` vs total tasks
- **Velocity** — sum story points from completed features
- **Carry-over** — tasks not finished (and why)
- **Bugs found** — filter by `found_during` matching sprint ID
- **Blocked time** — total time tasks spent blocked
- **Swaps** — mid-sprint scope changes
- **Patch tasks** — gaps found during review
- **Estimate accuracy** — planned effort vs actual per task
- **Token accuracy** — compare `token_estimate` from feature frontmatter (planned) against actual if available. Note: actual token usage isn't automatically tracked (Claude Code doesn't expose per-session token counts). Record as "estimated: NNK" for now. As actual data becomes available from billing/usage, it can be fed back to improve estimates.
- **Agentic delivery signals** — build/test rerun count, verification-ledger reuse count, code-review iterations, gap-analysis iterations, patch tasks created during review, user-flow probe failures, timeout/salvage events, and Shipyard plugin issue candidates.

**Agentic quality bar.** Shipyard is an agentic one-shot build framework, so the retro should optimize the system that makes future one-shots faster and safer. Prefer evidence-backed conclusions from event logs, cursor history, task files, captures, and the verification ledger. Ask the user only for judgment the data cannot provide.

**Throughput computation:**
1. Read `started_at`, `completed_at`, `total_paused_minutes` from SPRINT.md frontmatter
2. If both timestamps present:
   - `active_minutes` = elapsed - paused
   - If `active_minutes > 0`: compute `pts_per_hour`, append to metrics.md
   - If `active_minutes <= 0`: warn about incomplete timing data
3. If timestamps missing: omit throughput

Write computed data to `RETRO-DATA.md` (frontmatter: `step: data_gathered`). Present summary:

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

### Retro Step 2: Facilitate Discussion

Pause before asking (`shipyard-data cursor pause review --note "awaiting user: retro discussion"`), Render the observations as chat text first — the Retro Step 1 summary block plus the flagged issues and suggested improvements (RETRO-DATA.md content and question strings do not count as shown) — then ask all three in **ONE** AskUserQuestion call (three questions), each led by its data observation and each with a cheap "'skip' is fine" exit:

1. **What went well?** — lead with data-driven observations, then ask for the user's perspective
2. **What didn't go well?** — lead with flagged issues, then ask
3. **What should we change next sprint?** — lead with suggested improvements, then ask

On the answers, `shipyard-data cursor resume review`, then append responses to RETRO-DATA.md under `## Team Feedback`. Update frontmatter: `step: feedback_collected`.

### Retro Step 3: Create Action Items

For each actionable improvement, allocate an ID atomically and write an idea file. Cap at 5 IDEAs per retrospective. Each IDEA must cite the trigger metric or event evidence from `RETRO-DATA.md`; duplicate, vague, or one-off observations stay in `RETRO-DATA.md` as notes instead of entering the backlog.

**Allocate the ID.** Run `shipyard-data next-id ideas` — the CLI returns a zero-padded 3-digit string (e.g., `042`). Use it as `IDEA-042` in the filename and the `id` frontmatter field. **Do NOT `ls spec/ideas/` and pick a number manually** — parallel sessions would race and clobber each other. The allocator is the only safe way to pick an idea ID.

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

**Source-tag format.** `source: retro/<sprint-id>` (slash-separated origin, e.g., `retro/sprint-007`) is the new convention — it mirrors `execute/<sprint-id>` and `review-gap/<sprint-id>` so the carry-over scan can grep with a single regex `^source: (execute|review-gap|retro)/`. The old `retro-sprint-NNN` format (hyphen-separated) is still recognized by readers for backwards compatibility with IDEAs created before this change, but new IDEAs must use the slash form.

Update RETRO-DATA.md: `step: action_items_created`, `ideas_created: [IDEA-<id>, ...]`.

### Retro Step 4: Update Metrics

1. **Update metrics** — Read `<SHIPYARD_DATA>/memory/metrics.md`, then use Write to overwrite with the previous content plus appended new entries: velocity, carry-over rate, bug rate, estimate accuracy, anti-pattern flags
2. **Quarterly rollover** — if metrics.md exceeds 300 lines, archive older data to `metrics-[quarter].md`
3. **Save to memory** — key retro insights that persist across sessions

### Anti-Pattern Detection

During retro, flag:
- **Overloading** — planned >120% of capacity
- **Over-building** — tasks 2x+ estimate without scope change
- **Estimation gaps** — estimates consistently off by >50%
- **Zombie stories** — same items in 2+ sprints, never completed
- **Scope creep** — too many mid-sprint swaps

Present as observations, not judgments.

## Release

After retro completes, generate the release record. This is a changelog + status tracker — Shipyard does not create git tags, push, or create GitHub releases.

### Release Step 1: Present Release Plan

Read all feature files with `status: done` from this sprint. Generate the full release picture. The release is the most irreversible action in the workflow — status changes, archiving, and changelog are hard to undo.

Output the release plan as text:

**CHANGELOG** — what ships:
```
 FEATURES
  - F001: [title] — [one-line description from spec]
  - F005: [title] — [one-line description from spec]

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
- Feature file frontmatter updates
- Sprint directory archived

Pause before asking (`shipyard-data cursor pause review --note "awaiting user: release approval"`), then use `AskUserQuestion` for approval (load-bearing — the most irreversible action; never skip). On the answer, `shipyard-data cursor resume review`, then proceed:
- **Release (Recommended)** — proceed to Release Step 2 (write everything)
- **Edit changelog** — adjust changelog text, then re-approve
- **Skip release** — skip release record, still archive sprint

### Release Step 2: Write Release Record

1. Update feature statuses to `released` in feature file frontmatter
2. Record in each feature's frontmatter: `released_at: [date]`
3. Append changelog to `CHANGELOG.md` in the **project root** (not plugin data). If the file doesn't exist, create it. Prepend the new entry at the top (newest first). This is a project deliverable that belongs in git.

### Release Step 3: Archive Sprint

Run `shipyard-data archive-sprint sprint-NNN` from Bash (substitute the real sprint ID). This atomically renames `<SHIPYARD_DATA>/sprints/current/` → `<SHIPYARD_DATA>/sprints/sprint-NNN/` and recreates an empty `current/` for the next cycle. Do NOT synthesize raw `cp`/`mv`/`mkdir` against the plugin data dir — those are not portable and not atomic. `shipyard-data archive-sprint` is the only Shipyard binary you need to invoke from Bash, and it works because this skill has generic `Bash` allowed.

### Final: Run Status

After archiving, run the `/ship-status` validation and dashboard to give the user a clean project health snapshot. This catches any state issues from the sprint and auto-fixes them before the next cycle.
