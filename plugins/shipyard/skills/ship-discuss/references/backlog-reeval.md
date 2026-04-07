# Backlog Re-evaluation Protocol

After creating new features and applying impact analysis, re-evaluate the full backlog. This is distinct from impact analysis (which targets direct ripple effects) — this is about whether the overall picture has changed.

Skip if BACKLOG.md is empty or doesn't exist.

## Step 1: Re-check dependencies

Read all backlog feature files. For each, verify:
- Are `dependencies` still accurate? Does the new feature unlock or block anything?
- Are there now implied ordering constraints that weren't explicit before? (e.g., new F010 must ship before F003 to make F003 useful)

If dependency changes are found, update affected feature files silently. Surface only non-obvious ones to the user as plain text: "FYI: F003 now depends on F010 — updated."

## Step 2: Re-score RICE where affected

Identify backlog features whose RICE components may have shifted due to this discussion:
- **Reach** — does the new feature expand or shrink the user base assumption for existing features?
- **Impact** — does the new feature make an existing feature more or less impactful?
- **Confidence** — did research findings change confidence in existing estimates?
- **Effort** — does shared infrastructure from the new feature reduce effort for existing ones?

Do NOT re-score everything — only features with a clear reason to change. For each candidate, show the proposed change:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 RICE RE-EVALUATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 F003 — Payment Reminders
   Impact: 2 → 3  (F010's notification layer makes this cheaper to implement)
   RICE: 28.4 → 42.1

 F007 — Bulk Import
   Effort: 1.0 → 0.5  (shared CSV parser from new F012 reduces work)
   RICE: 24.0 → 48.0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then use AskUserQuestion: "Apply these RICE updates? (yes / adjust / skip)"

If approved, update `rice_*` fields and `rice_score` in the affected feature files. Do NOT reorder BACKLOG.md — note in the wrap-up: "Run `/ship-backlog rank` to re-sort by updated RICE scores."

## Step 3: Ordering check

Based on updated dependencies and RICE scores, identify if the current backlog order looks wrong:
- Is a high-RICE feature blocked by a low-RICE dependency that should be prioritized first?
- Does a new dependency chain create a forced ordering that contradicts current rank?

Surface as a plain text note in the wrap-up summary (don't reorder automatically). Example: "F003 now depends on F010 — you may want to pull F010 higher in the backlog."
