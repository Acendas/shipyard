# Phase 4.9 Quality Gate + Phase 4.95 Adversarial Critique — Detail

This is the full protocol for Phase 4.9 and Phase 4.95 in `/ship-discuss`. The SKILL body summarizes; this file holds the how.

## Phase 4.9: Quality Gate (self-review loop)

Before presenting to the user, review your own output. Re-read each feature file you wrote and check against this checklist:

| # | Check | Fail criteria |
|---|---|---|
| 1 | **Every acceptance scenario is Given/When/Then** | Vague prose like "user can do X" without structured scenario |
| 2 | **Happy path + at least 1 edge case per feature** | Only happy path covered |
| 3 | **No ambiguous words** | "appropriate", "properly", "as needed", "etc.", "various" in acceptance criteria |
| 4 | **No TBDs or placeholders** | Any "TBD", "TODO", "to be decided", "[fill in]" left in the spec |
| 5 | **User story has clear actor, action, and value** | "As a... I want... so that..." missing any part |
| 6 | **RICE fields all populated** | Any RICE field still at 0 without a reason in the decision log |
| 7 | **Dependencies identified** | Feature touches other features but `dependencies: []` is empty |
| 8 | **Research findings are prescriptive** | "Consider X or Y" instead of "Use X" |
| 9 | **How others do it section populated** | No real-world product references found |
| 10 | **Feature is one feature, not multiple** | Acceptance scenarios describe unrelated behaviors |
| 11 | **NFRs considered** | Feature handles sensitive data or has scale concerns but no NFR notes |
| 12 | **Edge cases covered** | No boundary values, state transitions, or concurrency scenarios |
| 13 | **Failure modes analyzed** | Write operations exist but no failure mode table |
| 14 | **EARS syntax used** | Acceptance criteria use vague language instead of WHEN/WHILE/IF patterns |
| 15 | **All states covered** | Missing empty state, error state, loading state, or offline state |

Iterate the checklist on each feature file, fixing failures (AskUserQuestion when input is needed) and re-running. Max 3 iterations. **Hold the table in mind across iterations — emit only per-iteration deltas (which checks fixed, which remain). Do not re-print the table on each pass.** Flag remaining gaps as "Unresolved — needs follow-up in /ship-discuss [ID]". Then proceed to Phase 4.95.

## Phase 4.95: Adversarial Critique

After the self-review quality gate passes, spawn the critic agent to challenge the spec from angles the self-review doesn't cover — implicit assumptions, feasibility risks, and design decision quality.

**Determine stakes level:**
- `high` if: feature is part of an epic, story_points >= 8, touches auth/payments/data, or has 6+ acceptance scenarios
- `standard` otherwise

**Spawn the critic:** dispatch a `general-purpose` subagent with the inline critic prompt below. The critic role is reused across ship-review, ship-sprint, and ship-discuss with mode-specific framing; per S-1's granularity criterion, the prompt stays inline.

Substitute the literal SHIPYARD_DATA path before spawning:

```
Agent(subagent_type: "general-purpose", prompt: |

You are an adversarial critic of a feature spec. Your job is to find what
the spec misses: implicit assumptions, feasibility risks, ambiguous
acceptance criteria, design decisions that locked in a constraint without
acknowledging it, and missing error states.

Apply anti-sycophancy: do not agree with the spec just because it sounds
reasonable. Pre-mortem the feature: imagine it shipped and broke in
production — what was the failure mode the spec didn't catch?

Mode: feature-critique
Stakes: [standard | high]   (high if part of an epic, ≥8 story points,
                             touches auth/payments/data, or 6+ acceptance
                             scenarios)

Read these files:
  - All feature files written in Phase 3 (full paths inlined here)
  - Codebase context: <SHIPYARD_DATA>/codebase-context.md
  - Project rules: .claude/rules/project-*.md

Return:
  STATUS: CHALLENGES
  PRIORITY_ACTIONS: <ordered list — mandatory fixes>
  IMPLICIT_ASSUMPTIONS: <baked-in assumptions the spec didn't surface>
  FEASIBILITY_RISKS: <design choices that may not survive contact with reality>
  AMBIGUITIES: <ACs that are too vague to test against>
  MISSING_ERROR_STATES: <happy-path-only paths that should specify failure>

If you genuinely have no challenges:
  STATUS: NO_CHALLENGES
  REASON: <one paragraph confirming you considered each adversarial angle>

You are READ-ONLY: no edits, no commits, no spawning subagents.
)
```

**Process the critic's findings:**

1. Read the `PRIORITY ACTIONS` section — these are mandatory fixes
2. For each FAIL item and HIGH-risk assumption, classify by fix-shape (the classification determines routing, not the critic's confidence):
   - **Mechanical / non-semantic fix** — pure formatting (Given/When/Then restructuring of existing-text scenarios with no semantic change), typo correction, missing-citation backfill, internal-link repair. Apply directly to the feature file.
   - **Semantic / policy-shaped fix** — anything that ADDS a new acceptance criterion, MAKES an implicit assumption explicit in the spec, ADDS a noted dependency edge, CHANGES error-handling behavior, INTRODUCES a rate limit / timeout / retry policy, or otherwise encodes a product decision. **These MUST go through `AskUserQuestion`** even when the model judges them "obvious" or "standard practice." Adding `rate-limit at 5/min` looks mechanical from the model's perspective but is a policy decision the user has standing on. The v2.4.0 audit flagged silent auto-fixes of this shape as HIGH-risk because they encode wrong-by-default product policy under the cover of "the critic said to fix it."
   - **Ambiguous case** — if it's unclear whether a fix is mechanical or semantic, route through `AskUserQuestion`. Cheap to ask, expensive to silently encode a wrong policy.

   Batch the policy-shaped fixes into a single AskUserQuestion (or themed groups of ≤4) with the critic's evidence inlined and your recommendation. Do not present the critic's findings as questions for the user to interpret — present them as: "Critic flagged [issue]. Recommend [fix]. Apply? (apply / modify / skip — log as accepted-risk)".
3. For CONCERN items: note them in the feature's `## Decision Log` as "Critic flagged — [summary]. Accepted because: [your reasoning]" or fix if quick (mechanical only — semantic CONCERNs go through AskUserQuestion per the rule above).
4. For RECONSIDER verdicts from Pass 3 (steel-man challenges): AskUserQuestion with both options and the critic's reasoning, plus your recommendation
5. If the critic identified assumptions that the spec relies on silently, **do NOT make them explicit in the spec silently.** Making an assumption explicit IS a policy decision (you're committing the spec to a specific reading the user may not have intended). AskUserQuestion: "Critic flagged silent assumption: [text]. Apply as explicit acceptance criterion / Apply as Technical Notes line / Decline (assumption may not be load-bearing)". Default-recommend "Apply as Technical Notes line" — that's the lowest-commitment way to surface the assumption without baking it into the test contract.

**Do NOT re-run the critic after fixes.** One round only. Address what you can, ask the user about the rest, and proceed.
