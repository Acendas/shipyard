# Impact Analysis Protocol

When a feature is created or refined, scan existing features for ripple effects. This is triggered conditionally — skip if no features exist in `<SHIPYARD_DATA>/spec/features/`.

## Scan Protocol

Grep across `<SHIPYARD_DATA>/spec/features/` frontmatter for keyword matches against the new/refined feature's title, epic, and domain terms. Only read full files for likely matches. Check four dimensions:

- **Duplicates** — Is this substantially the same as an existing feature? Signals: same user story, same acceptance scenarios, same domain nouns. If found → AskUserQuestion: "This looks like it overlaps heavily with [ID: title]. Merge them, keep separate, or refine the distinction?"
- **Dependencies** — Does the new feature need something from an existing feature? Does an existing feature now need something from this one? Signals: shared domain keywords, overlapping data model entities, API endpoints one produces that another consumes.
- **Overlap/Conflict** — Do features modify the same component, API route, data model, or UI element? Are acceptance criteria contradictory? Signals: similar Given/When/Then actors and objects, same epic.
- **Invalidation** — Does the new feature make existing acceptance criteria stale or an existing feature unnecessary? Signals: same user story verb on the same noun, superseding scope.
- **Epic Restructuring** — Should features be moved between epics to match natural domain clustering?

For each dimension, record: impacted feature ID, relationship type, severity (informational / action-required), and proposed change.

If no impacts are found across all dimensions, state "No cross-feature impacts detected" and move on.

## Sprint-Active Handling

For each impacted feature, check if it appears in `<SHIPYARD_DATA>/sprints/current/SPRINT.md` (by feature ID or its task IDs in wave listings). If sprint-active, classify the impact:

- **Informational** (dependency-only change): "[ID] is in Sprint N. The dependency link won't block work, but the team should know."
- **Action-required** (acceptance criteria change, invalidation, or epic move): "[ID]'s acceptance criteria need updating, and it's in Sprint N with X/Y tasks done. Changing criteria now may invalidate completed work."

Available actions per impact:
1. **Apply now** — Make the change and flag sprint plan as stale
2. **Defer** — Capture in the affected feature's decision log for post-sprint handling
3. **Skip** — Do not apply this impact

Impact analysis never blocks. It surfaces, warns, proposes. User can always defer.

## Proposal Format

Present all impacts in a structured block:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 IMPACT ANALYSIS: [ID] — [title]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 DUPLICATES
   none

 DEPENDENCIES
   [ID] → [ID]: [reason]
   [ID] → [ID]: [reason]

 OVERLAPS
   [ID] ↔ [ID]: [what overlaps]
     ⚠ [ID] is in Sprint N (X/Y tasks done)
     Proposed: [specific change]

 INVALIDATIONS
   none

 EPIC CHANGES
   none

 BACKLOG NOTE
   [any re-estimation or grooming notes]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then AskUserQuestion: "Apply these impacts? (yes / adjust / skip)"

- **yes** — Apply all proposed changes
- **adjust** — User specifies which impacts to apply, defer, or skip
- **skip** — No changes applied; impacts noted in the feature's decision log for future reference

## What Gets Changed on Approval

- **Dependencies** — Bidirectional linking: update BOTH features. Example: if F010 depends on F003, add `F003` to F010's `dependencies:` AND add `F010` to F003's `dependencies:`. Both files must be written.
- **Acceptance criteria** — Edit the affected feature file's acceptance criteria. Record the change in that feature's decision log with date and reasoning: "Acceptance criteria updated due to [new feature ID]: [what changed]."
- **Re-estimation flags** — Do NOT recalculate RICE/points for other features. Add decision log entry: "Re-estimation needed: scope changed due to [ID]." The backlog note in the summary will suggest `/ship-backlog groom`.
- **Epic reassignment** — Update `epic:` in feature frontmatter only. Epic membership is derived, never stored in epic files.
- **NEVER reorder BACKLOG.md** — BACKLOG.md is an ordered index managed by `/ship-backlog`. Note in wrap-up summary: "Run `/ship-backlog rank` to re-prioritize."

### REFINE mode specifics

When running impact analysis during REFINE (Step 4.5), compare the updated feature against its pre-refinement state. Only surface impacts caused by the refinement — not pre-existing relationships. Use the diff between old and new acceptance criteria, dependencies, and scope to determine what changed.

If impacted features are in the active sprint, feed those impacts into the Sprint Impact Report's "Cross-feature impacts" section rather than presenting them separately.
