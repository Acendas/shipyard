# Challenge & Surface Analysis

Proactively challenge the feature to surface what the user hasn't thought about. This is not a checklist to run mechanically — adapt to the feature. Skip sections that clearly don't apply.

## Assumption Audit

List every implicit assumption detected. Present them explicitly:
- "You're assuming [X] — is that safe?"
- "This implies [Y] about your data model — confirmed?"
- "I'm reading this as [Z] — correct, or am I misunderstanding?"

When refining an existing feature, also check:
- Are assumptions baked into the current spec still valid?
- Has anything changed in the codebase or other features since this was written?

## Edge Case & Failure Mode Sweep

Think through what breaks:
- **Empty/null states** — What does the UI show with zero data? First-time user experience?
- **Failure paths** — API down, invalid input, timeout, partial success, race conditions
- **Scale concerns** — Works for 10 users, what about 10,000? Large datasets?
- **Permission boundaries** — Who CAN'T do this? What happens when they try?
- **Undo/reversibility** — Can the user recover from mistakes? Should they be able to?
- **Concurrency** — Two users doing this simultaneously — what happens?

Only raise edge cases that are **plausible for this feature**. Don't manufacture hypotheticals.

When refining, note which edge cases are already covered by acceptance scenarios and which are missing:
- "Your scenarios cover the happy path and validation errors, but nothing about [concurrent edits / empty state / permission denied / timeout]. Do any of those matter?"

## Conflict & Dependency Scan

Check existing spec for friction:
- Does this contradict or overlap with an existing feature?
- Does this depend on something not yet built? Flag the dependency chain.
- Will this break or change behavior of something already shipped?
- Are there data model implications that ripple to other features?

If conflicts are found, present them: "This overlaps with F003 — they both modify user permissions. Should they be the same feature, or do they coexist? How?"

Note: At this stage, scan only what you have in memory. Do not read all feature files —
the full scan happens in Phase 3.5 (NEW) or Step 4.5 (REFINE) after spec is written.

When refining, re-check against current spec state — new features may have been added since the feature was first discussed.

## "What You Haven't Told Me"

Explicitly list what's **missing from the conversation** (or from the existing spec) and ask if it matters:
- "We haven't discussed [authentication/caching/notifications/migration/offline support/etc.] — is that relevant here?"
- "You described the happy path. What should happen when [specific realistic failure]?"
- "Who maintains this after it ships? Any operational concerns?"

When refining, compare the feature against a complete feature checklist: user story, acceptance criteria, error handling, edge cases, technical notes, task breakdown. Present gaps as a checklist.

Present this as a concise checklist, not an interrogation. The user can dismiss items quickly: "not relevant" / "good catch, let's add that" / "capture as a separate idea."

## Resolution

Use AskUserQuestion (not plain text) to present open items — bundle them into a concise checklist in a single call. Do not output questions as plain text; the model will not pause without a tool call.

For each surfaced item, reach one of:
- **Addressed** — user answered, fold into the feature spec
- **Deferred** — user says "later", capture as IDEA or decision log entry with reasoning
- **Killed** — user says "not needed", record in decision log why

**Do not proceed until grey areas are resolved or explicitly deferred.**
