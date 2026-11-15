# Backlog Re-evaluation Protocol

After creating new features and applying impact analysis, re-evaluate the full backlog. This is distinct from impact analysis (which targets direct ripple effects) — this is about whether the overall picture has changed.

Skip if BACKLOG.md is empty or doesn't exist.

## Step 1: Re-check dependencies

Read all backlog story files. For each, verify:
- Are `dependencies` still accurate? Does the new feature unlock or block anything?
- Are there now implied ordering constraints that weren't explicit before? (e.g., new S010 must ship before S003 to make S003 useful)

**Cross-feature dependency edges are user-facing changes — NEVER apply them silently.** Phantom edges must not reach BACKLOG ordering or downstream sprint planning, so ask first.

The rule is:
- **Current-feature mutations** (the feature being discussed in this `/ship-discuss` session) — fine to apply directly without per-edit confirmation; the user is approving this feature via the Phase 5 gate.
- **Other-feature mutations** (any change to a story file the user did not invoke this discussion to edit) — REQUIRE `AskUserQuestion` confirmation before the Edit. Present the proposed change with the source feature, the target feature, the edge type (depends-on / unlocks / overlaps), and the model's evidence for inferring the edge:

```
  Cross-feature edge proposed:
    Source:    S012 (this discussion)
    Target:    S003 (existing backlog feature)
    Edge:      S003 depends on S012
    Evidence:  S003's acceptance scenarios reference [data model X],
               which S012 introduces. Without S012 shipped first,
               S003's scenarios can't execute.
```

Then `AskUserQuestion`: "Add S003 depends on S012? (yes / no / refine the evidence)". With several proposed edges, show them all in one table in chat, then ask one card: apply all / go through them one by one. Apply each Edit only after explicit user approval.

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

 S003 — Payment Reminders
   Impact: 2 → 3  (S010's notification layer makes this cheaper to implement)
   RICE: 28.4 → 42.1

 S007 — Bulk Import
   Effort: 1.0 → 0.5  (shared CSV parser from new S012 reduces work)
   RICE: 24.0 → 48.0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Apply these updates directly — this is a two-way door and evidence-based (Shipyard decides estimates, never the user). Update the `rice_*` component fields via `shipyard-data story set`; the CLI refreshes cached `rice_score` atomically from those components. Log each change as `ASSUMED: <feature> <field> X → Y because <evidence>` in that feature's Decision Log. Include the rendered RICE RE-EVALUATION block in the wrap-up summary with a veto line ("Say the word if any of these re-scores look wrong — I'll adjust"). Do NOT reorder BACKLOG.md — note in the wrap-up: "Run `/ship-backlog rank` to re-sort by updated RICE scores."

## Step 3: Ordering check

Based on updated dependencies and RICE scores, identify if the current backlog order looks wrong:
- Is a high-RICE feature blocked by a low-RICE dependency that should be prioritized first?
- Does a new dependency chain create a forced ordering that contradicts current rank?

Surface as a plain text note in the wrap-up summary (don't reorder automatically). Example: "S003 now depends on S010 — you may want to pull S010 higher in the backlog."
