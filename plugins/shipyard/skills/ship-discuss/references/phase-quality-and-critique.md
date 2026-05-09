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
2. For each FAIL item and HIGH-risk assumption:
   - If fixable without user input → fix the feature file directly (update acceptance criteria, add missing error states, clarify ambiguous text, add noted dependencies)
   - If requires user judgment → collect into a single AskUserQuestion with the critic's evidence and your recommendation
3. For CONCERN items: note them in the feature's `## Decision Log` as "Critic flagged — [summary]. Accepted because: [your reasoning]" or fix if quick
4. For RECONSIDER verdicts from Pass 3 (steel-man challenges): AskUserQuestion with both options and the critic's reasoning, plus your recommendation
5. If the critic identified assumptions that the spec relies on silently, make them explicit in the spec — add them to acceptance criteria or Technical Notes

**Do NOT re-run the critic after fixes.** One round only. Address what you can, ask the user about the rest, and proceed.
