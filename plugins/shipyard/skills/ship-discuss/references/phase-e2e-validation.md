# Phase 3.7: E2E AC Validation

After the feature spec is written (Phase 3) and impact analyzed (Phase 3.5), validate the feature's acceptance criteria against the E2E taxonomy. This phase detects touch surfaces from the written spec and surfaces gaps in E2E coverage.

## When to Run

| Mode | Trigger | Sequence position |
|------|---------|-------------------|
| NEW | After Phase 3.5 (Impact Analysis), before Phase 3.8 (Simplification Scan) | Always |
| REFINE | After challenge step (Step 4), as backfill | If feature has no `tier: "e2e"` AC |
| IDEA | Inherits from NEW mode sequence | Always |
| EPIC | After each feature's Phase 3, before EP5 Quality Gate | Per feature |

## Skip Conditions

Skip this phase entirely when:
- Feature is trivial: `story_points <= 2` AND `complexity == "low"`
- User explicitly declines: "skip e2e validation for this feature"

If the validation runs but returns zero activated categories (no touch surfaces detected), inform the user and move on — this is a valid outcome for purely additive features.

## Procedure

### Step 1: Invoke validating-e2e-coverage

Follow the `validating-e2e-coverage` playbook with:
- **feature_file_path**: the feature spec just written (e.g., `<SHIPYARD_DATA>/spec/features/F009-payment-endpoint.md`)
- **existing_ac**: the AC list from the feature file's `## Acceptance Criteria` section
- **domain_hints**: domain tags from the discussion context (e.g., `["payments", "auth"]`)

The skill reads the taxonomy at `${CLAUDE_PLUGIN_ROOT}/skills/discovering-edge-cases/references/e2e-taxonomy.md`, detects touch surfaces, and returns structured gaps.

### Step 2: Present Gaps to User

If gaps are non-empty, present them grouped by category using the communication-design.md 3-layer pattern:

**One-liner:** "E2E validation found **[N] coverage gaps** across [M] categories ([category names])."

**Context per category:**
```
### [Category Name] — [N] gaps

[Rationale for why this category matters for this feature]

| # | Scenario | Verification |
|---|----------|-------------|
| 1 | Given..., When..., Then... | probe |
| 2 | Given..., When..., Then... | manual |
```

### Step 3: User Approval

Step 2's gap tables (with the full draft Given/When/Then text) must appear as assistant chat text BEFORE this ask — the gaps are a capability-skill return the user cannot see, and "Accept all" is only safe when the drafted scenarios are on screen, not summarized as a count inside the question. Then AskUserQuestion (groups of ≤4 scenarios per question):

"The E2E taxonomy flagged [N] coverage gaps. For each, I've drafted a scenario."

Options:
- "Accept all" — add all recommended E2E AC
- "Pick scenarios" — present each for individual accept/reject
- "Skip — accept risk" — skip all E2E AC for this feature

### Step 4: Write Approved E2E AC

For accepted gaps, use Edit to add to the feature file. Place them under a new `### E2E AC` subsection within the existing `## Acceptance Criteria` section. Each scenario is written in Given/When/Then format with its category tag:

```markdown
### E2E AC

**[timeout]** Given a POST /api/payments request with a 30-second deadline, When processing takes 31 seconds, Then the system returns HTTP 504 with a structured timeout error and no charge is created.

**[idempotency]** Given a payment charge request, When the same request arrives twice with the same idempotency key, Then exactly one charge is created and both responses are identical.
```

### Step 5: Handle 200-Line Overflow

If adding E2E AC would push the feature file over 200 lines:
1. Extract the entire `### E2E AC` section to `<SHIPYARD_DATA>/spec/references/FNNN-e2e-ac.md`
2. Run `shipyard-data feature add-ref FNNN <SHIPYARD_DATA>/spec/references/FNNN-e2e-ac.md` to add the reference path to the feature's `references:` array
3. Replace the `### E2E AC` section in the feature body with: `### E2E AC → see references/FNNN-e2e-ac.md`

## Backfill Protocol (REFINE Mode)

When `/ship-discuss` enters REFINE mode and reads an existing feature:

1. Check if the feature has any AC with `tier: "e2e"` (look for `### E2E AC` section or `[category-slug]` tags)
2. If no E2E AC exist, auto-invoke this phase after the challenge step
3. Present findings as: "This feature predates E2E taxonomy validation. I found [N] coverage gaps across [M] categories. Add them?"
4. Follow the same approval flow (Steps 2-5)
5. Existing Core AC remain untouched — E2E AC are additive only

## Output Events

On completion, emit a structured event:
```
shipyard-data events emit e2e_validation_completed feature=FNNN activated_categories=N gaps_found=N gaps_accepted=N gaps_skipped=N
```
