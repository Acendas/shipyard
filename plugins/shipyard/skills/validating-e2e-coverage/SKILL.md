---
name: validating-e2e-coverage
description: Validate E2E acceptance criteria coverage.
disable-model-invocation: true
---

# Validating E2E Coverage

Post-hoc validation that reads a written feature spec, detects which operational/architectural surfaces the feature touches, maps them to the E2E taxonomy, gap-analyzes against existing acceptance criteria, and returns recommended additions. The goal is to catch the scenarios that live outside the feature's own logic — timeouts, idempotency, degradation, privilege boundaries — before they become production incidents.

## When to Invoke

| Caller | Trigger |
|---|---|
| `/ship-discuss` Phase 3.7 | After spec write, before quality gate |
| `/ship-discuss` REFINE mode | On re-entry to existing feature (backfill) |

## Inputs

The calling skill provides:
- Feature file path (the written spec at `<SHIPYARD_DATA>/spec/features/FNNN-slug.md`)
- Existing AC list (parsed from the feature file's `## Acceptance Criteria` section)
- Domain hints (e.g., `["payments", "auth"]`) from the discussion context

## Procedure

### Step 1: Detect Touch Surfaces

Read the feature spec: user story, acceptance criteria, interface, data model, technical notes, flows, error handling sections. For each line, match against the touch-surface detection table in `${CLAUDE_PLUGIN_ROOT}/skills/discovering-edge-cases/references/e2e-taxonomy.md`.

Collect all activated category slugs. If the feature's `domain_tags` include domain-specific terms (payments, auth, etc.), also activate categories commonly associated with those domains.

### Step 2: Map to Taxonomy Categories

For each activated category, pull the specific types and example GWT scenarios from the taxonomy. This is the "universe" of E2E scenarios that could apply to this feature.

### Step 3: Gap Analysis

For each activated type, check whether existing AC already covers it:
- **COVERED** — an existing AC's Given/When/Then semantically addresses this type (e.g., existing "timeout returns 504" covers the timeout category)
- **GAP** — no existing AC covers this type; recommend addition
- **PARTIAL** — an existing AC touches the area but doesn't fully specify the behavior (e.g., "handles errors" without specifying timeout vs. connection refused vs. 5xx)

Match by semantic overlap, not exact text — the existing AC may use different words but cover the same concern.

### Step 4: Generate Recommendations

For each GAP or PARTIAL finding, draft a concrete Given/When/Then scenario using the taxonomy's examples as templates, customized to this feature's specific entities, endpoints, and data flows. Each recommendation includes:

- The GWT scenario text
- `tier: "e2e"`
- `e2e_category: "<slug>"` from the taxonomy
- `verification_type`: inferred from the taxonomy's default for this category, adjusted if the feature context makes it more or less automatable
- `rationale`: one sentence explaining why this matters for this specific feature

## Output Shape

```json
{
  "activated_categories": ["timeout", "idempotency", "privilege-escalation"],
  "total_types_checked": 12,
  "gaps": [
    {
      "category": "timeout",
      "type": "Request deadline at boundary",
      "status": "GAP",
      "recommended_ac": {
        "ac": "Given a POST /api/payments request with a 30-second deadline, When processing takes 31 seconds, Then the system returns HTTP 504 with a structured timeout error and no charge is created.",
        "tier": "e2e",
        "e2e_category": "timeout",
        "verification_type": "probe"
      },
      "rationale": "Feature exposes a payment endpoint with no timeout AC — a timeout during charge could leave money in limbo."
    }
  ],
  "already_covered": [
    {
      "category": "idempotency",
      "type": "Double-submit under user retry",
      "covered_by": "AC-3"
    }
  ]
}
```

## Skip Conditions

Do not invoke this skill when:
- Feature is trivial: `story_points <= 2` AND `complexity == "low"`
- The calling skill determines no touch surfaces were detected (activated_categories is empty after Step 1)
- User explicitly declines E2E validation ("skip e2e validation for this feature")

## Edge Cases

- **No touch surfaces detected**: Return `activated_categories: []`, `gaps: []`. The feature is purely additive with no E2E-sensitive surface. This is a valid outcome — not every feature needs E2E AC.
- **All categories already covered**: Return empty gaps and a full `already_covered` list. The spec is comprehensive. This is the ideal outcome.
- **Feature spec is very short (< 5 AC)**: Still run — short specs are MORE likely to have E2E gaps, not fewer.
- **Feature references existing utilities with E2E guarantees**: If the Technical Notes say "uses the existing retry middleware" and the retry middleware already has its own E2E AC, mark the retry-storm category as COVERED with a note referencing the middleware.

## Backfill Protocol

When invoked in REFINE mode on an existing feature that predates E2E validation:
- Check if the feature has any `tier: "e2e"` AC
- If not, run the full procedure and present findings as: "This feature predates E2E taxonomy validation. I found [N] coverage gaps across [M] categories."
- The calling skill decides how to present to the user (accept all / pick / skip)

## Read-Only Contract

This skill does not edit feature files. It returns structured findings. The calling skill (`/ship-discuss`) is responsible for:
1. Presenting gaps to the user via AskUserQuestion
2. Writing approved E2E AC to the feature file under `### E2E AC`
3. Handling 200-line overflow (extract to reference file)

## Pairing With Other Skills

- **discovering-edge-cases** — complementary, not overlapping. Edge cases finds logic-level gaps (boundary inputs, concurrency in business logic). This skill finds operational/architectural gaps (timeout handling, idempotency, degradation).
- **extracting-acceptance-criteria** — this skill's output uses the same AC schema with the 3 new fields (`tier`, `e2e_category`, `verification_type`).
- **authoring-acceptance-probe** — downstream; E2E AC with `verification_type: "probe"` get probes authored the same way as core AC.
