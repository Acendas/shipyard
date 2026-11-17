# REFINE Mode: Update Existing Feature

**Questions come from the list (4.0).** Before the first card run `shipyard-data discuss-questions start --topic refine-<story id in lowercase, e.g. refine-s007> --budget 8`, then `shipyard-data discuss-questions bind --story <S###>` (the approval is then refused while one of its questions is open). From then on every question in this mode is added with `shipyard-data discuss-questions add … --by main` (an approval with `--kind gate`) and asked the way `references/async-questions.md` § "Your loop" step 4 says: `next`, write its summary and its show block in the chat, one card, `answer`. Add every question you already have before you ask the first, so the person hears how many there are; small ones are offered together by the list itself. No researcher runs in this mode unless you dispatch one, so nothing waits. End with `discuss-questions reset` when the work is finished and `pause` when it stops early. Where a step below says "AskUserQuestion", it means a question on this list.

**Writing the refined story is one call.** Write the refined text (user story, why it matters, paths, acceptance criteria) to a draft file in your scratch folder, then `shipyard-data story refine <S###> --body <draft.md> --points <n> --rice <reach>,<impact>,<confidence %>,<effort> --probe auto|assisted|manual --probe-command "<cmd>" [--probe-steps <file>]`. It replaces the body (the title, the ticket's own text and the decision log are kept), marks the story refined, sets the numbers, gives the criteria their ids and prints the checks an approval runs. Never write `refined:`, the probe block or the numbers by hand, and never with a script. It approves nothing.

**A card nobody answers.** When a card comes back unanswered (the person is away), do not answer for them and do not hold the discussion open: `shipyard-data discuss-questions pause`, `shipyard-data discuss-queue stop` if a queue runs, then `shipyard-data lock release discuss --skill ship-discuss --pause`. Say in one line what waits. The next `/ship-discuss` asks the waiting question and what this discussion still owes (its sources, the ticket question).

### Step 0: Sprint Impact Check

Before anything else, check if this feature is in an active sprint:

1. **Read the active sprint file** (`<SHIPYARD_DATA>/sprints/current/SPRINT.md` — check if this feature's ID appears in any wave, or if any task in the feature's `tasks:` array appears in the sprint)
2. **Check task status** — are any tasks for this feature already in-progress or completed?

If the feature is **in an active sprint**, render the sprint state as chat text first — sprint ID, task progress, which tasks are in-progress/done — then ask; the warning block belongs in chat, not inside the question string (the AskUserQuestion card cannot carry it, and the sprint file is a Read result the user hasn't seen). AskUserQuestion:

"⚠️ S007 is already being worked on in Sprint 3.
  Progress: 2/5 tasks done, 1 in-progress.
  Changing it now may disrupt the current sprint.
  What would you like to do? (continue editing / pull from sprint first / cancel)"

Three paths:
- **"continue editing"** → Continue REFINE in-place. After Step 4, flag sprint plan as stale and show impact (see Step 4).
- **"pull from sprint"** → Move feature back to backlog (`status: approved`), remove from sprint file, adjust sprint capacity. Then continue REFINE normally.
- **"cancel"** → Abort. Suggest finishing the sprint first, then discussing in the next cycle.

If tasks are **in-progress or completed**, warn that spec changes may invalidate completed work and confirm before proceeding.

### Step 1: Load & Present

1. **Load existing story file** — read all current content
2. **Show current state** with a quick health assessment: scenario count and specificity, edge-case coverage, TODO/TBD placeholders, task concreteness.

### Step 2: Challenge Existing Spec (same technique as Phase 1.5b — applied to existing content)

Run the full Challenge & Surface analysis against the **existing feature content**:
**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-1-5b-challenge.md` (the protocol that was previously bundled inline here).

Apply each section to what's already in the spec — audit assumptions baked into the current writing, sweep for edge cases not covered by existing acceptance scenarios, scan for conflicts with features added since this was first discussed, and list what's still missing.

### Step 3: Gather Updates

Based on what Phase 1.5 surfaced, gather updates through the question list (never plain text): one question per gap that needs the person, each with your recommended answer first. Render the Step-2 challenge findings as chat text first (the compact ⚠️/✅/❓ summary block), then run `next`. The findings came from the challenge protocol and file Reads — invisible to the user until re-emitted; a question's own text cannot substitute for the block.
- Resolve each gap: addressed / deferred / not needed
- New insights, changed requirements, concerns?
- New acceptance scenarios for uncovered edge cases
- **Technical decisions made since last discussion?** Derive these from the record FIRST — `git log` since the feature's `updated:` date and the diff of the spec/code areas the feature touches — then STATE what you found ("since we last talked, the auth middleware moved to `lib/auth/` and you switched to Argon2"). Ask only about decisions the record can't show (rationale, intent, things not yet committed).

### Step 4: Update & Re-evaluate

1. **Update the story file** — preserve decision log, add new entries with date
2. **Recalculate estimates** — scope likely changed after surfacing gaps
3. **Re-run viability gate** — feature may now be better defined (or need splitting). **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/viability-and-scope-drift.md` § "Phase 2: Viability Gate" (read it once; also needed for Step 5).
4. **Backlog**: If estimates changed, no need to update BACKLOG.md — it only stores IDs. The updated data will be read from the story file next time the backlog is displayed.

**E2E AC Backfill:** After challenge, check if the feature has any `tier: "e2e"` AC (look for `### E2E AC` section). If not, invoke Phase 3.7 (E2E AC Validation) as backfill. Present as: "This feature predates E2E taxonomy validation." See `references/phase-e2e-validation.md` § Backfill Protocol.

### Step 4.5: Impact Analysis

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/impact-analysis.md`

This is a REFINE run — see "REFINE mode specifics" in that file.

#### Sprint Impact Report (if feature is in active sprint)

If the feature was in-sprint and the user chose to continue in-place, show the impact:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPRINT IMPACT: S007 refined mid-sprint
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Estimate change:  5 → 8 points (+3)
 New scenarios:    +2 acceptance scenarios added
 New tasks:        +1 task (P009: handle timeout)
 Invalidated:      none (existing work still valid)
 Sprint capacity:  was 3 pts remaining, now 0 (over by 3)

 Cross-feature impacts (from Step 4.5):
   S003: dependency added (informational)
   S005: acceptance criteria updated (action-required)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then AskUserQuestion: "Sprint is now over capacity. Options:"
- **Absorb** — team stretches to cover (small overrun)
- **Defer new tasks** — add new tasks to backlog, finish original scope this sprint
- **Swap** — pull a different unstarted feature out of the sprint to make room
- **Replan** — cancel and re-plan the sprint (`/ship-sprint --cancel`, then `/ship-sprint`)

Update the sprint file with whatever the user chooses.

### Step 5: Approval Gate & Finalize

After the impact analysis (and any sprint-replan choices) is applied, run Phase 5 (Spec Approval Gate) and Phase 6 (Finalize) against the refined feature — **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-finalize.md` for both (the SKILL router holds only the terminal `lock release`). Phase 5's SCOPE-DRIFT DIFF is the Phase 4.97 check: **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/viability-and-scope-drift.md` § "Phase 4.97: Scope-Drift Check" (skip the Read if already loaded in Step 4). Same STOP rule, same ordering invariant: the active-skill mutex stays active until the last step.

REFINE-mode differences from NEW-mode finalize (status no-op for already-approved features, BACKLOG.md no-op if ID already present, idea archival only if this run graduated an idea, cancel-branch cleanup) are documented in `references/phase-finalize.md` under "REFINE-mode differences".
