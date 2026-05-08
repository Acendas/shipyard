---
name: extracting-acceptance-criteria
description: Use during /ship-discuss feature shaping, /ship-spec drafting, or /ship-sprint task decomposition to convert a feature description (or the user's natural language) into a numbered list of atomic, observable, testable acceptance criteria. Each AC becomes a row that authoring-acceptance-probe can probe and dispatching-spec-review can verify. Read-only.
disable-model-invocation: true
---

# Extracting Acceptance Criteria

A feature description is usually a paragraph: "users should be able to create accounts with email + password, get a verification email, and log in once verified." That description has three or four implicit acceptance criteria woven together. This skill pulls them out into a list a builder can implement against and a reviewer can check.

The output is the **input** to `authoring-acceptance-probe` (which probes each AC) and `dispatching-spec-review` (which verifies each AC was met).

## When to Invoke

| Caller | Trigger |
|---|---|
| `/ship-discuss` | Right after the user's feature pitch crystallizes — convert prose into ACs before edge-case discovery |
| `/ship-spec` | When auditing or rewriting a feature spec; pull ACs out of buried prose |
| `/ship-sprint` | When breaking a feature into tasks, each task gets a slice of the feature's ACs |
| `/ship-bug` | Convert a bug report into a regression AC ("the system shall not <symptom>") |

If the spec already has a clean numbered AC list with one observable per item, don't invoke this skill — there's nothing to extract. Run `discovering-edge-cases` instead to find missing ACs.

## Inputs

- `feature_text` — the prose description, user request, or existing spec section.
- `parent_context` — optional pointer to the parent feature/epic for inheritance (a sub-feature inherits the parent's domain ACs unless overridden).
- `domain_hints` — `["payments", "auth", "external-api", ...]`, used to pre-load domain-specific AC patterns (idempotency, audit, etc.).

## What an Acceptance Criterion Is

An AC is a single, observable, testable statement about what the system does (or doesn't do) under specific conditions. The shape:

> **Given** \<context\>, **when** \<action\>, **then** \<observable outcome\>.

You don't have to write them in literal Given/When/Then. The shape just enforces three properties: a starting condition, a triggering action, and an observable outcome that a probe can check.

Examples (good):

- "When a user submits a signup form with a valid email and ≥8-char password, the system creates a `User` row, returns `201` with the user's `id`, and sends a verification email to that address."
- "When a user submits a signup form with an email already in use, the system returns `409 Conflict` with body `{"error":"email_taken"}` and does NOT create a user row or send any email."
- "Verification links expire 24 hours after the verification email was sent. After expiry, clicking the link returns a `Link expired` page (HTTP 410) and offers a 'Resend' button."

What an AC is NOT:

- A goal: "Make signup easy." (Not testable. Goals belong in the feature's purpose section.)
- An implementation note: "Use bcrypt for password hashing." (Implementation leaks. ACs talk about *what*, not *how*.)
- A vague qualifier: "Errors should be handled gracefully." (What does "gracefully" mean? Make it observable.)
- A multi-AC bullet: "Users can sign up, log in, and reset their password." (That's three ACs; split.)

## Extraction Procedure

Walk the feature text and produce ACs in three passes:

### Pass 1 — Surface the obvious

For each sentence in the feature text, ask: *"What is this asserting the system will do?"* If the answer is a behavior, draft an AC. If the answer is a goal/intention, skip — that goes in the purpose section.

Don't fight the feature text's wording yet — capture as written, normalize later.

### Pass 2 — Split compounds

Any AC mentioning "and" linking two distinct outcomes is at least two ACs. Same for "or." Split until each AC is atomic.

> **Compound (bad):** "When a user signs up, the system creates a row AND sends a verification email AND returns the user's id."

> **Atomic (good):**
> 1. When a user signs up with valid input, the system creates a `User` row.
> 2. When a user signs up with valid input, the system sends a verification email.
> 3. When a user signs up with valid input, the system returns the user's `id` in the response.

The atomic version is verbose but each line maps 1:1 to a probe.

### Pass 3 — Add the negative ACs

For every "shall do X" AC, ask: *"What's the corresponding 'shall not Y'?"* These are the cases the spec usually misses:

- "Shall create a row" → "shall NOT create a row when input is invalid."
- "Shall return the user's id" → "shall NOT leak the user's password hash in the response."
- "Shall send the email to that address" → "shall NOT send to any other address."

Negative ACs are where security and correctness bugs hide. Surface them explicitly.

## Output Shape

Return a structured list. Each entry:

```
{
  "id": "AC-<N>",
  "ac": "<the criterion as a Given/When/Then-shaped sentence>",
  "polarity": "positive" | "negative",
  "observable": "<what changes / what's returned / what's logged — the thing a probe can check>",
  "owner_layer": "frontend" | "backend" | "db" | "infra" | "cross-cutting",
  "domain_tags": ["<from domain_hints, if applicable>"]
}
```

Numbering is sequential (`AC-1`, `AC-2`, ...). The calling skill renumbers if it merges ACs from multiple sources.

The `observable` field is the bridge to `authoring-acceptance-probe`: a clear `observable` is what makes a good probe possible. If you can't fill `observable` with something concrete, the AC is too vague — refine it.

## Quality Checklist

Before returning, run each AC through:

- [ ] **Atomic** — one observable outcome per line.
- [ ] **Observable** — `observable` field has a concrete artifact (HTTP response field, DB row state, file content, logged event).
- [ ] **Testable** — could be encoded as an automated test or a probe command.
- [ ] **What, not how** — no library names, no specific algorithms, no infrastructure choices.
- [ ] **No vague qualifiers** — replace "fast", "user-friendly", "secure" with measurable bounds.
- [ ] **Negative companion present** — every positive AC has a "shall not" partner where applicable.
- [ ] **Owner layer assigned** — knowing which layer owns it helps `/ship-sprint` distribute tasks.

## Hard Cases

- **Performance ACs.** Convert "fast" into a budget: "P95 latency for the signup endpoint stays under 500ms when called at 100 req/s." If you can't pick a number, the AC isn't ready — surface to user via the calling skill.
- **Security ACs.** Phrase as observable absences: "The signup response shall not contain the user's password hash, salt, or any field of the `User.private` namespace." Observable = response body.
- **UX ACs.** "User-friendly" → "The signup form shows an inline error within 200ms of an invalid email field losing focus, and the error references the specific field name." Observable = DOM state.
- **Backward compatibility ACs.** "Existing v1 clients that POST to `/api/users` continue to receive the v1 response shape (no new required fields)." Observable = response schema diff.

## Output Discipline

1. **No padding.** If the feature text is small (one sentence), the output may be three ACs. Don't generate ten.
2. **Match the feature's scope.** ACs that go beyond what the feature text says should surface as `discovering-edge-cases` findings, not as ACs invented here.
3. **Confidence: include only ACs you'd defend** — if it's a stretch interpretation of the feature text, flag it as ambiguous and ask the user.
4. **Don't overlap with the spec's purpose section.** Goals/intentions stay there; this skill produces *what the system does*.

## Read-Only Contract

This skill produces a structured list; it does NOT edit the feature draft. The calling command skill folds the ACs into the spec's `## Acceptance Criteria` section after presenting to the user for approval.

## What This Replaces

There's no single registered agent this skill replaces — AC extraction was previously inline prose inside `/ship-discuss` and `/ship-sprint` SKILL.md files. Lifting it into a capability skill (per S-1) means:

- `/ship-discuss` and `/ship-sprint` can drop ~80–120 lines each of inline AC-extraction prose, replacing with a single `Skill: extracting-acceptance-criteria` invocation.
- The extraction logic is consistent across callers (today, the prose drifts between skills).
- Future improvements to AC quality apply everywhere at once.

This is part of the Sprint 5 "polish" work where command skills slim by extracting capability content.

## Pairing With Other Skills

- **`discovering-edge-cases`** runs after this — extracts ACs first, then surfaces what's missing. Edge cases become new ACs in a follow-up extraction pass.
- **`authoring-acceptance-probe`** runs per-AC after extraction stabilizes — each AC's `observable` field guides probe authoring.
- **`dispatching-spec-review`** verifies each AC during review — the AC list is the reviewer's checklist.

## Bottom Line

- Convert prose features into atomic, observable, testable ACs.
- Three passes: surface obvious, split compounds, add negatives.
- Each AC has a concrete `observable` field — the bridge to probes.
- No padding, no scope expansion, no implementation leaks.
- Read-only; calling skill folds output into the spec.
- 14th of 14 capability skills.
