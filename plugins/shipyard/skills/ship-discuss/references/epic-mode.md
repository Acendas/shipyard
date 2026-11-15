# EPIC Mode — Detail

This is the full detail of EPIC mode in `/ship-discuss`. The SKILL body has the entry point and high-level summary; this file holds the per-step prose.

## Step EP1: Load Epic Context

**Questions come from the list (4.0).** Before the first card run `shipyard-data discuss-questions start --topic epic-<epic id in lowercase, e.g. epic-e003> --budget 8`. From then on every question in this mode is added with `shipyard-data discuss-questions add … --by main` (an approval with `--kind gate`) and asked the way `references/async-questions.md` § "Your loop" step 4 says: `next`, write its summary and its show block in the chat, one card, `answer`. Add every question you already have before you ask the first, so the person hears how many there are; small ones are offered together by the list itself. No researcher runs in this mode unless you dispatch one, so nothing waits. End with `discuss-questions reset` when the work is finished and `pause` when it stops early. Where a step below says "AskUserQuestion", it means a question on this list.

If existing epic:
1. Use Glob `<SHIPYARD_DATA>/spec/epics/E00N-*.md` (substitute the epic ID), then Read the matching file.
2. Find all features in this epic: use Grep with `pattern: ^epic: E00N`, `path: <SHIPYARD_DATA>/spec`, `glob: {stories,features}/[SF]*.md`, `output_mode: files_with_matches`, then Read each match.
3. For each feature, read title, status, story points, acceptance criteria count

Present the current state:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 EPIC: E001 — Payment System
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Features (4):
   S003 — Card Payments (done, 8 pts, 5 scenarios)
   S004 — Refund Flow (approved, 5 pts, 3 scenarios)
   S012 — Payment Analytics (proposed, 3 pts, 2 scenarios)
   S015 — Split Payments (proposed, 8 pts, 0 scenarios)

 Total: 24 pts | Done: 8 pts | Remaining: 16 pts
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If new epic (user described a large initiative): create the epic file first, then proceed.

## Step EP2: Epic-Level Discussion

**Put the four context questions on the list, then ask them one card at a time** (a card with more than one question is refused by the hook). Each question carries an example answer so the user can respond in one breath, and each has a cheap first option, "nothing changed / you decide":

- **What's changing about this epic?** (scope, priority, direction) — e.g. "we're dropping the analytics half", "bumping this ahead of the reporting epic", or "nothing — just reviewing."
- **Any features to add, remove, or split?** — e.g. "add a refund-flow feature", "S015 should split into basic + advanced", or "none."
- **Has the business context changed?** — e.g. "a competitor shipped split payments", "user feedback says onboarding is the blocker", or "no change."
- **Any cross-feature concerns?** (shared infrastructure, common patterns, sequencing) — e.g. "S003 must land before S012", "all of these share the ledger schema", or "none."

Run the confidence gate first: anything the epic file or story files already answer is stated, not asked.

## Step EP3: Cascade Changes to Features

This is the critical step. Based on the discussion, identify changes that need to propagate to features:

**For each affected feature:**

| Change type | What happens |
|---|---|
| **Scope change** | Update feature's acceptance criteria, re-estimate RICE/points |
| **New dependency** | Run `shipyard-data story add-dep <SID> <DEP_FID>` (means `<SID>` waits for `<DEP_FID>`; the CLI records the reverse on the other file as `dependents:` and refuses a loop) |
| **Priority shift** | Update RICE fields via `shipyard-data story set <SID> rice_reach=... rice_impact=... rice_confidence=... rice_effort=...`, note in decision log |
| **Acceptance criteria change** | Edit story file, add decision log entry: "Updated due to epic E00N discussion: [reason]" |
| **Feature removed from epic** | Run `shipyard-data story set <SID> epic=""`, note in decision log |
| **Feature added to epic** | Run `shipyard-data story set <SID> epic=E00N` |
| **Feature invalidated** | Run `shipyard-data story set-status <SID> rejected` or `deferred` per the decision, note reason in decision log |
| **New feature identified** | Run NEW mode inline to create it, assign to this epic |

**Sprint impact check:** For each modified feature, check if it's in an active sprint. If yes, flag:
```
⚠ S004 (Refund Flow) is in Sprint 3 — 2/4 tasks done.
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
   S004: acceptance criteria updated (3 → 5 scenarios)
   S012: RICE re-estimated (score: 18 → 24)
   S015: split into S015 + S018 (split payments → basic + advanced)
   S018: NEW — Advanced Split Payments (5 pts, 4 scenarios)

 Sprint impact:
   S004 is in Sprint 3 — changes deferred to post-sprint

 Features (5):
   S003 — Card Payments (done)
   S004 — Refund Flow (approved, updated)
   S012 — Payment Analytics (proposed, re-estimated)
   S015 — Basic Split Payments (proposed, scoped down)
   S018 — Advanced Split Payments (proposed, NEW)

 Total: 29 pts | Done: 8 pts | Remaining: 21 pts
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

The changed-state block shows counts ("3 → 5 scenarios") — counts are not approvable. For every feature whose acceptance criteria changed or were newly written in EP3/EP4, render the changed/new scenarios VERBATIM as chat text below the block before this ask; the story files are Read/Edit results the user hasn't seen. Approving here is approve-having-read, not approve-a-count.

Add the approval to the list (`--kind gate`) and ask it when `next` hands it out: "Approve these changes? (yes / adjust / revert all)"

## Step EP7: Integration AC

Cross-feature seam-level E2E criteria — see `references/epic-integration-ac.md`.
