# Bugs as stories — refining a bug, and the hotfix lane (F025, F023 AC-6)

A bug is a story with `type: bug`. It has points, acceptance criteria, backlog presence and the same lifecycle as a feature story; what differs is the refinement record and the first acceptance criterion.

## Refining a bug (refine lane, `--kind bug`)

Runs inside NEW mode's rounds. Before the usual Phase-1 understanding questions, collect — from the input, the codebase and the linked story's acceptance criteria first, from the user only for what the record cannot answer (kill-list applies):

| Field | Where it lands in the story file |
|---|---|
| Reproduction steps | `## Steps to Reproduce` (numbered) and frontmatter `repro_steps:` |
| Expected vs actual | `## Expected (from spec)` — pull the matched story's acceptance scenario — and `## Actual`; frontmatter `expected:` / `actual:` |
| Environment | `environment:` (version, device, branch, data set) |
| Severity | `severity: low | medium | high | critical` — infer from words ("crash", "can't", "data loss" → high/critical; "typo", "wrong color" → low) and state it; ask only when the words do not say |

**First acceptance criterion is always a failing test** (AC-2). Write it first in `## Acceptance Criteria`:

```gherkin
@AC-1
Scenario: A regression test reproduces the bug
  Given the reproduction steps above
  When the test runs against the current code
  Then it FAILS with the reported symptom, and passes once the fix lands
```

The builder's hotfix/bug cycle (`tdd-cycle` § Bug fix with regression test) is Red → Green → Revert → Red → Restore → Green; a regression test that does not fail without the fix is not one.

**Unknown root cause → a debug-spike task (AC-4).** When the user does not know why it happens and the codebase does not show it in a few minutes of reading: allocate `shipyard-data next-id tasks`, Write `<SHIPYARD_DATA>/spec/tasks/T<id>-<slug>.md` (`kind: debug`, `parent: S<id>`, `## What`: the question to answer, `## Done When`: the root cause named with evidence), then `shipyard-data story add-dep S<id> T<id>` — the task blocks the story through `dependencies:` until it is `done`, and `/ship-sprint`'s readiness gate refuses the story while it is blocked. Record `debug_task: T<id>` on the story.

Points, RICE and `user_flow_probe` follow the normal Phase 3 rules; a bug's probe is usually `kind: auto` running the regression test. On finalize the story is `approved` and in the backlog like any other, so it is planned, built and reviewed as a story (AC-3, AC-5: `/ship-execute --hotfix S###` and `/ship-debug` keep working for urgent fixes).

## Hotfix lane (production incident)

No planning lock, no rounds, no RICE: the point is to get to `/ship-execute --hotfix` in seconds (AC-6 of F023).

1. **Allocate** `shipyard-data next-id stories` → `S<id>`.
2. **Write** `<SHIPYARD_DATA>/spec/stories/S<id>-<slug>.md`:
   ```yaml
   ---
   id: S<id>
   title: "[title]"
   type: bug
   lane: hotfix
   severity: critical
   status: approved          # a hotfix skips the backlog; approved so ship-execute --hotfix accepts it
   refined: false            # the full record (repro, expected/actual) is filled while fixing
   epic: ""
   story_points: 0
   dependencies: []
   external_refs: []
   steps: []
   found_during: "[current sprint id or manual report]"
   user_flow_probe:           # how the fix is seen working, the way the reporter saw it broken (4.0: `/ship-execute --hotfix` refuses a story without it)
     kind: auto               # auto when a command can show it; assisted or manual when a person must look
     command: "[the command that shows the fixed behaviour: the regression test or scenario, by name]"
   created: [today]
   updated: [today]
   ---

   # [Title]

   ## Bug
   [the report, verbatim-ish]

   ## Steps to Reproduce
   [what is known; "to be determined" is acceptable here]

   ## Acceptance Criteria
   @AC-1 Scenario: A regression test reproduces the bug (fails before the fix, passes after)
   ```
   `refined: false` is deliberate: the refined-story gate blocks `approved` for IMPORTED stories, but a hotfix is written `approved` directly by this lane (the file is created with that status, never transitioned into it), so the gate never fires and the flag still marks the record as unrefined for later grooming.
2b. **Check the probe now**: `shipyard-data story check-probes S<id>`. Exit 3 names what is wrong; fix the story and run it again before going on. `/ship-execute --hotfix` runs the same check first, and a hotfix filed without a probe was sent straight back here.
3. **Start the debug session**: Write `<SHIPYARD_DATA>/debug/S<id>.md` with the symptoms (the `ship-debug` file shape), so investigation is systematic from the first minute.
4. **Capture the repro** when one runs: `shipyard-logcap run S<id>-repro -- <command>`; read it back with `shipyard-logcap grep`, never re-trigger a flaky bug to re-filter.
5. **Say exactly** and stop (release the planning lock only if this session holds it — the lane runs lock-free when the lock was blocked):
   ```
   🚨 HOTFIX S<id> — [title]
     Debug session: <SHIPYARD_DATA>/debug/S<id>.md
     Fix it now: /ship-execute --hotfix S<id>   (regression test first; commit fix(S<id>): …)
     Investigate: /ship-debug --resume
   ```

Hotfix does not touch sprint state or velocity, and Shipyard never creates branches, merges or pushes for it — the user's git workflow applies.
