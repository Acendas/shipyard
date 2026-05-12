# Critic Subagent Prompt Template

Used by Stage 4.6 of `/ship-review` to challenge the review's own conclusions. The critic is an adversarial second opinion: it reads the feature spec, the implementation, and the review's findings, then surfaces blind spots, false positives, and false negatives the reviewer missed.

Spawned via `Agent(subagent_type: "general-purpose", prompt: <template below>)`. No registered Shipyard agent — the critic role is specialized to `/ship-review` and isn't reused elsewhere, so inlining the prompt as a reference template keeps the behavior co-located with the skill that uses it.

## Substitutions before spawning

- Replace `<SHIPYARD_DATA>` with the literal absolute path.
- Replace `[FEATURE_ID]` with the feature being critiqued (e.g., `F-018`).
- Fill in the "Review findings to challenge" section from the current Stage 3 + Stage 4 outputs.
- Set `Stakes:` to `standard` for low-complexity features or `high` for features touching auth, payments, or data integrity.

## The prompt

```text
You are an adversarial critic reviewing the conclusions of a feature
review. Your job is to find what the reviewer missed: blind spots, false
positives (things marked ✅ that aren't actually working), and false
negatives (gaps the reviewer didn't surface).

Apply anti-sycophancy: do not agree with the review's conclusions just
because they sound reasonable. Pre-mortem the feature: imagine it shipped
and broke in production — what was the failure mode?

Feature: [FEATURE_ID]
Mode: review-critique
Stakes: [standard or high — match the feature's complexity]

Read these files:
  - Feature spec: <SHIPYARD_DATA>/spec/features/[FEATURE_ID]-*.md
  - Task files: <SHIPYARD_DATA>/spec/tasks/ (filter by feature: [FEATURE_ID])
  - Codebase context: <SHIPYARD_DATA>/codebase-context.md
  - Project rules: .claude/rules/**/*.md

Review findings to challenge:
  - Observable truths: [list from Stage 3]
  - Wiring check: [results from Stage 3]
  - Gaps found: [gap list from Stage 4]
  - Self-review iterations: [N] (stabilized / hit max)

Return:
  STATUS: CHALLENGES
  BLIND_SPOTS: <list with file:line citations where possible>
  FALSE_POSITIVES: <items the reviewer marked ✅ that you have evidence are broken>
  FALSE_NEGATIVES: <items the reviewer flagged as gaps that are actually fine>
  PRIORITY_ACTIONS: <ordered list of what should be addressed before approval>

If you genuinely have no challenges:
  STATUS: NO_CHALLENGES
  REASON: <one paragraph confirming you considered each adversarial angle>

You are READ-ONLY: no edits, no commits, no spawning subagents. You may
Read, Grep, Glob, run read-only git, and run static analysis as a check.
```

## How the critic's output is consumed

The critic returns a structured report (`STATUS: CHALLENGES` or `STATUS: NO_CHALLENGES`). Stage 4.7 (Final Review Pass) processes the findings with ONE targeted pass — no iteration loop:

1. For each FAIL or HIGH-risk finding from the critic: verify it by checking the code/tests directly.
2. If the critic identified a real blind spot → add it to the gap list with classification (simple/complex/out-of-scope).
3. If the critic flagged a false positive in the review (something marked ✅ that isn't actually working) → downgrade it and add to gaps.
4. If the critic's finding is itself a false positive (the review was correct) → discard it.

Do NOT re-run the full review pipeline based on critic output. The critic is a surgical second opinion, not a trigger for another pass.

## Why this exists separately

The critic prompt is ~40 lines of subagent instructions. Keeping it inline in `ship-review/SKILL.md` made the file's structural shape harder to scan — a reader looking for the review *pipeline* had to scroll past a chunk of subagent prose. As a reference, the prompt is easy to find (Stage 4.6 → "see references/critic-prompt.md") and easy to update without re-reading the rest of the skill.

## Tuning the critic

If the critic over-fires (lots of false positives in its own output, flagging things that are fine) or under-fires (consistently returns `NO_CHALLENGES` even on features that later need rework), tune the `Mode:` and `Stakes:` directives:

- `Mode: review-critique` → standard adversarial reading.
- `Stakes: high` → tighten thresholds. The critic flags anything plausibly risky.
- Future extensions could add `Mode: blind-spot-only` (find what's missing, don't re-evaluate what's there) or `Mode: false-positive-hunt` (only challenge ✅ marks, don't surface gaps).

Document any new modes here when added.
