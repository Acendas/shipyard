# EPIC Mode — Detail

This is the full detail of EPIC mode in `/ship-discuss`. The SKILL body has the entry point and high-level summary; this file holds the per-step prose.

## Step EP1: Load Epic Context

If existing epic:
1. Use Glob `<SHIPYARD_DATA>/spec/epics/E00N-*.md` (substitute the epic ID), then Read the matching file.
2. Find all features in this epic: use Grep with `pattern: ^epic: E00N`, `path: <SHIPYARD_DATA>/spec/features`, `glob: F*.md`, `output_mode: files_with_matches`, then Read each match.
3. For each feature, read title, status, story points, acceptance criteria count

Present the current state:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 EPIC: E001 — Payment System
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Features (4):
   F003 — Card Payments (done, 8 pts, 5 scenarios)
   F004 — Refund Flow (approved, 5 pts, 3 scenarios)
   F012 — Payment Analytics (proposed, 3 pts, 2 scenarios)
   F015 — Split Payments (proposed, 8 pts, 0 scenarios)

 Total: 24 pts | Done: 8 pts | Remaining: 16 pts
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If new epic (user described a large initiative): create the epic file first, then proceed.

## Step EP2: Epic-Level Discussion

Use AskUserQuestion to understand the direction:
- What's changing about this epic? (scope, priority, direction)
- Any new features to add? Any existing features to remove or split?
- Has the business context changed? (competitor launched, user feedback, pivot)
- Are there cross-feature concerns to address? (shared infrastructure, common patterns, sequencing)

## Step EP3: Cascade Changes to Features

This is the critical step. Based on the discussion, identify changes that need to propagate to features:

**For each affected feature:**

| Change type | What happens |
|---|---|
| **Scope change** | Update feature's acceptance criteria, re-estimate RICE/points |
| **New dependency** | Add to feature's `dependencies:` array (bidirectional) |
| **Priority shift** | Update RICE fields, note in decision log |
| **Acceptance criteria change** | Edit feature file, add decision log entry: "Updated due to epic E00N discussion: [reason]" |
| **Feature removed from epic** | Set `epic: ""` in feature frontmatter, note in decision log |
| **Feature added to epic** | Set `epic: E00N` in feature frontmatter |
| **Feature invalidated** | Set `status: cancelled` in feature frontmatter, note reason in decision log |
| **New feature identified** | Run NEW mode inline to create it, assign to this epic |

**Sprint impact check:** For each modified feature, check if it's in an active sprint. If yes, flag:
```
⚠ F004 (Refund Flow) is in Sprint 3 — 2/4 tasks done.
  Changing acceptance criteria may invalidate completed work.
  Apply now / defer to post-sprint / skip this change
```

## Step EP4: Create New Features (if any)

For each new feature identified during the epic discussion, run the standard NEW mode phases (Phase 1 → 5) with the epic pre-assigned. Bundle related features — discuss all new features before writing any, so dependencies are clear.

## Step EP5: Quality Gate

Review the epic after all changes:

| # | Check | Fail criteria |
|---|---|---|
| 1 | **All features have acceptance criteria** | Any feature in epic has 0 scenarios |
| 2 | **No orphan features** | Features that lost their epic assignment aren't floating unassigned |
| 3 | **Dependencies are consistent** | Feature A depends on B, but B doesn't know about A |
| 4 | **No duplicates within epic** | Two features describe the same behavior |
| 5 | **Epic scope is coherent** | Features in the epic don't logically belong together |

## Step EP6: Wrap Up

Present the changed state:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 EPIC UPDATED: E001 — Payment System
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Changes:
   F004: acceptance criteria updated (3 → 5 scenarios)
   F012: RICE re-estimated (score: 18 → 24)
   F015: split into F015 + F018 (split payments → basic + advanced)
   F018: NEW — Advanced Split Payments (5 pts, 4 scenarios)

 Sprint impact:
   F004 is in Sprint 3 — changes deferred to post-sprint

 Features (5):
   F003 — Card Payments (done)
   F004 — Refund Flow (approved, updated)
   F012 — Payment Analytics (proposed, re-estimated)
   F015 — Basic Split Payments (proposed, scoped down)
   F018 — Advanced Split Payments (proposed, NEW)

 Total: 29 pts | Done: 8 pts | Remaining: 21 pts
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

AskUserQuestion: "Approve these changes? (yes / adjust / revert all)"
