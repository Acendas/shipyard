# Simplification Opportunity Scan

When a feature introduces new libraries, utilities, patterns, or abstractions, scan the codebase for places that currently hand-roll what the new thing provides. Small wins get folded into the current work; larger opportunities become backlog items.

This scan is deliberately conservative — only surface high-confidence opportunities where the replacement is clear and the benefit is measurable (less code, fewer dependencies, or better consistency).

## When to Run

Run this scan when the feature being discussed or planned:
- Adds a **new dependency** (library, SDK, framework module)
- Creates a **new shared utility** (helper function, service, abstraction layer)
- Introduces a **new pattern** (API client pattern, state management approach, error handling strategy)
- Extracts or refactors an **existing abstraction** into something more general

Skip if the feature is purely additive (new endpoint, new UI page) with no reusable infrastructure.

## Detection Strategies

### Strategy 1: New Dependency Scan

**Trigger:** Feature's Technical Notes or Decision Log reference a new library not currently in the project's dependency manifest.

**Process:**
1. Identify what the library provides (from research findings or WebSearch: "[library] replaces hand-rolled [what]")
2. Grep the codebase for hand-rolled equivalents:
   - **Date libraries** (date-fns, dayjs, luxon) → search for raw `new Date()` arithmetic, manual formatting, timezone string manipulation
   - **Validation libraries** (zod, yup, joi) → search for manual if/else validation chains, regex-based input checks
   - **HTTP clients** (axios, ky) → search for raw `fetch()` wrappers with retry/timeout logic
   - **State management** → search for hand-rolled pub/sub, manual context propagation, ad-hoc event emitters
   - **ORM/query builders** → search for raw SQL string concatenation, manual connection pooling
   - **General pattern:** search for the *problem the library solves*, not the library name
3. For each match, assess: is the hand-rolled version doing essentially the same thing the library does? Or is it solving a subtly different problem?

**Output per finding:**
```
[file:line] — hand-rolled [what] that [library] provides natively
  Current: [brief description of existing code]
  Replacement: [what it would look like with the library]
  Confidence: HIGH/MEDIUM (HIGH = drop-in replacement, MEDIUM = needs adaptation)
  Effort: trivial/small/medium (trivial = swap call, small = refactor function, medium = change interface)
```

### Strategy 2: New Utility/Helper Scan

**Trigger:** Feature creates a new shared function, service, or module that encapsulates reusable logic.

**Process:**
1. Identify the core operation the utility performs (e.g., "formats currency strings", "validates email addresses", "retries with exponential backoff")
2. Grep the codebase for inline code that does the same operation:
   - Search for the domain keywords (e.g., "currency", "format", "cents", "decimal")
   - Search for the algorithmic pattern (e.g., `setTimeout` + increasing delay for retry logic)
   - Search for copy-pasted code blocks that vary slightly from the new utility
3. Exclude the feature's own files from results

**Confidence filter:** Only report if the inline code is doing ≥80% of what the new utility does. If the inline version handles a special case the utility doesn't, note the gap — it may mean the utility needs to be more general, not that the inline code should be replaced.

### Strategy 3: Pattern Consolidation Scan

**Trigger:** Feature introduces a new way of doing something the codebase already does in multiple ad-hoc ways.

**Process:**
1. From the feature's Technical Notes, identify the pattern being introduced (e.g., "repository pattern for data access", "Result type for error handling", "command pattern for mutations")
2. Search for existing code that solves the same problem differently:
   - Grep for the operation type (e.g., all database access code, all error handling, all API calls)
   - Compare the existing approaches with the new pattern
   - Count how many variations exist — 3+ variations of the same operation is a strong signal
3. Group by similarity — which existing code is closest to the new pattern and easiest to migrate?

**Output per cluster:**
```
Pattern: [what the code does]
  New way: [the pattern being introduced]
  Existing variations: [N] files
    - [file:line] — [brief description of variation] (migration effort: trivial/small/medium)
    - [file:line] — [brief description of variation] (migration effort: trivial/small/medium)
  Consistency win: replacing [N] ad-hoc approaches with one pattern
```

### Strategy 4: Abstraction Opportunity Scan

**Trigger:** Feature extracts a concept that 2+ other places in the codebase would benefit from.

**Process:**
1. Identify the abstraction boundary the feature creates (interface, base class, protocol, generic type)
2. Search for concrete implementations of similar behavior elsewhere:
   - If the feature creates `PaymentProvider` interface → search for direct Stripe/PayPal/etc. API calls
   - If the feature creates a `Cacheable` decorator → search for manual cache-check-then-fetch patterns
   - If the feature creates a pagination helper → search for manual offset/limit/cursor code
3. Only report if 2+ additional places would benefit (single instances aren't worth abstracting)

### Strategy 5: Dead Code / Supersession Scan

**Trigger:** Feature replaces or supersedes existing functionality.

**Process:**
1. If the feature replaces an existing approach, search for other consumers of the old approach
2. Check if old utilities, helpers, or modules become partially or fully unused after the feature ships
3. Look for configuration, feature flags, or environment variables that reference the old approach
4. Check for imports of the old module from files outside the feature scope

**Output:**
```
Superseded: [old module/function/pattern]
  Replaced by: [new thing from this feature]
  Remaining consumers: [N] files still use the old approach
    - [file:line] — [what it uses]
  Can fully remove old code: yes/no (no if remaining consumers exist)
```

## Sizing and Routing

For each opportunity found, classify and route:

| Effort | Route | Action |
|---|---|---|
| **Trivial** (< 15 min, < 5 files, drop-in swap) | Fold into feature | Add as a sub-task or extend an existing task's scope |
| **Small** (< 1 hour, < 10 files, straightforward refactor) | Sprint task | Create a dedicated cleanup task in the current sprint (last wave) |
| **Medium** (1+ hours, 10+ files, or requires testing strategy) | IDEA file | Create `IDEA-NNN-simplify-[slug].md` for backlog consideration |
| **Large** (cross-cutting, architecture-level, or risky) | IDEA file | Create `IDEA-NNN-simplify-[slug].md` with `complexity: high` note |

**Scope guard:** The total effort of trivial + small items folded into the sprint MUST NOT exceed 20% of the sprint's capacity. If it would, demote excess items to IDEA files. The feature itself always takes priority.

## IDEA File Format (for Medium/Large)

```yaml
---
id: IDEA-NNN
title: "Simplify: [what] using [new thing from feature]"
type: idea
status: proposed
source: "simplification-scan from [feature ID]"
captured: [today's date]
---

# Simplify: [what] using [new thing]

## Opportunity
[What was found — which files hand-roll what the new utility/library/pattern provides]

## Affected Files
- [file:line] — [what needs to change]

## Expected Benefit
- [Lines of code removed / dependencies reduced / consistency improved]
- [Estimated effort: S/M/L]

## Depends On
- [Feature ID] must ship first (introduces the [utility/library/pattern])
```

## Presentation Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SIMPLIFICATION OPPORTUNITIES from [Feature ID]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 FOLD INTO FEATURE ([N] items, ~[M] min)
   [file] — replace hand-rolled [X] with [new utility] (trivial)
   [file] — swap manual [Y] for [library] call (trivial)

 SPRINT CLEANUP TASKS ([N] items)
   "Migrate [module] to [pattern]" — [N] files, ~[effort] (small)

 BACKLOG IDEAS ([N] items)
   IDEA-NNN — Simplify: [description] ([M] files, medium effort)
   IDEA-NNN — Simplify: [description] ([M] files, large effort)

 SKIP (low confidence)
   [file] — looks similar but solves a different problem

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then AskUserQuestion: "Apply these simplification opportunities? (all / pick / skip)"

- **all** → fold trivial items, create sprint tasks, create IDEA files
- **pick** → user selects which to apply
- **skip** → no action; note in feature's decision log: "Simplification scan ran, opportunities deferred"
