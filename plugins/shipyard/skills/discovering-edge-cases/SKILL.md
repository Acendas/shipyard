---
name: discovering-edge-cases
description: Use during /ship-discuss Phase 1.5b and /ship-sprint planning to surface edge cases, failure modes, NFRs, and adversarial inputs that the happy-path spec missed. Returns a structured findings list the calling skill folds into the feature/task spec. Replaces the shipyard-discovery-scout registered agent. Read-only.
disable-model-invocation: true
---

# Discovering Edge Cases

Most spec drafts describe the happy path. The bugs live in everything else. This skill systematically enumerates the categories where reality diverges from the happy path, then asks the model to populate each category for the specific feature being discussed.

The output is **a list of cases the spec should address**, not opinions or warnings — concrete inputs/conditions/scenarios with whether the current draft handles them.

## When to Invoke

| Caller | Trigger |
|---|---|
| `/ship-discuss` Phase 1.5b | After feature draft + happy-path AC, before user approval |
| `/ship-sprint` task decomposition | When breaking a feature into tasks, to surface tasks that aren't obvious from the happy path |
| `/ship-spec` review | When auditing an existing feature spec for missing-coverage rot |
| Manual / ad-hoc | When the user says "what could go wrong with this?" |

Do NOT invoke for trivial features (effort: S, single touchpoint). The discovery overhead exceeds value for those.

## Inputs

- `feature_draft` — the current spec text (markdown). May be a draft from `/ship-discuss` or an existing feature file.
- `acceptance_criteria` — the happy-path AC list, if separate from the draft.
- `domain_hints` — optional list of domain tags (`["payments", "auth", "external-api", "user-input"]`) that activate domain-specific case categories.
- `data_dir` — for reading `<SHIPYARD_DATA>/codebase-context.md` and prior learnings.

## Discovery Categories

Walk these in order. Each category has a set of probe questions; the output finds answers for the specific feature.

### 1. Boundary inputs

Probe questions:
- **Empty**: empty string, empty list, empty file, zero count, null, undefined.
- **Singleton**: one element where the spec implies many.
- **Max**: largest realistic input (1M items, 10MB file, max-int).
- **Beyond max**: input one larger than the bound (UX, error path).
- **Off-by-one**: ranges, slices, off-by-one in pagination.
- **Negative / zero**: where positive was assumed.
- **Type extremes**: NaN, Infinity, very-precise floats, Unicode (emoji, RTL, combining chars), surrogates.

### 2. Concurrency / ordering

- Two simultaneous requests for the same resource.
- Out-of-order events (event B arrives before event A that produced it).
- Partial failure in a multi-step transaction.
- Idempotency: same request twice — does it double-count, error, or no-op?
- Read-after-write consistency window.
- Worker crash mid-job; resumption semantics.

### 3. Failure modes

- Network partition / timeout to dependency.
- Dependency returns 5xx, 4xx, malformed response, very slow response.
- Disk full, write failure, permission denied.
- Database constraint violation, deadlock, connection pool exhaustion.
- Out-of-memory / OOM-killed.
- Process restart mid-flow; what's persisted vs lost.

### 4. Adversarial input

(Activate when domain_hints include `user-input`, `external-api`, or `auth`.)
- Malicious string: SQL/template/shell injection, path traversal, ReDoS regex.
- Oversized input: > expected bound by 10x, 100x, 1000x.
- Malformed structure: invalid JSON/XML, truncated, with extra fields.
- Encoding edge: invalid UTF-8, BOM, mixed line endings.
- Privilege escalation: low-priv user requests high-priv resource.
- Replay / stale token.
- CSRF / SSRF surface.

### 5. Observability gaps

- What logs at error boundaries? Are PII / secrets stripped?
- What metrics? Is the new code path counted?
- What traces? Does the trace context propagate across async hops?
- What's debuggable from logs alone if the user reports "it didn't work"?

### 6. NFRs (non-functional)

- Performance: P50/P95/P99 latency budget. What happens at 10x load?
- Memory: working set bound. Streaming vs buffering for large input.
- Backward compatibility: existing clients still work? Schema migration?
- Forward compatibility: future fields ignored vs rejected?
- Accessibility (UI): keyboard nav, screen reader, color contrast.
- Internationalization: text expansion (German is 30% longer), RTL, locale-aware formatting.
- Offline / degraded: app still works without network?

### 7. Domain-specific

(Activate per domain_hints.)

- **payments / financial**: idempotency keys, double-charge prevention, refund flow, currency precision (no floats), reconciliation, audit log immutability.
- **auth**: session expiry, token revocation, account lockout, MFA fallback, audit trail.
- **multi-tenant**: tenant isolation (data + compute), per-tenant quotas, cross-tenant leak surface.
- **AI/LLM**: prompt injection, model output validation, cost cap, hallucination handling.
- **cache**: invalidation, stale read, cache stampede, TTL boundary.

## Output Shape

Return a structured findings list. Each finding:

```
{
  "category": "boundary" | "concurrency" | "failure-mode" | "adversarial" | "observability" | "nfr" | "domain",
  "case": "<one-line summary of the edge case>",
  "currently_handled": true | false | "ambiguous",
  "probe_question": "<the question that surfaced this case>",
  "spec_response_needed": "<what the spec should add: an AC, a Technical Note, or 'explicit non-goal'>"
}
```

Categorize "currently handled" honestly:

- **true** — the spec already addresses this case (cite the AC or Tech Note).
- **false** — the spec doesn't mention it; this is a real gap.
- **ambiguous** — the spec touches the area but doesn't clearly specify behavior; flag for clarification.

Sort by category, then "false" before "ambiguous" before "true".

## Output Discipline

1. **Concrete cases, not warnings.** "What if the input is empty?" not "Make sure to handle bad input." A case is something a test could be written for.
2. **No padding.** If a category genuinely has no relevant edge case for this feature, say "No relevant cases" — don't invent.
3. **Deduplicate against the existing spec.** A case the spec already covers is `currently_handled: true`; surface it briefly and move on.
4. **Confidence: include a case only if you'd defend it under questioning.** Speculative ("maybe the user could be on a flaky network") only if there's a real failure mode the spec should address.

The test of a good output: a reader can take the `currently_handled: false` cases and add them to the spec without further reasoning. If a case requires more reasoning to act on, it isn't ready to surface.

## Two Modes

### Mode 1 — broad sweep (default)

Walk all 7 categories with the probe questions activated by `domain_hints`. Suitable for `/ship-discuss` Phase 1.5b on a new feature.

### Mode 2 — targeted

Caller passes `target_categories: ["concurrency", "failure-mode"]` to focus. Suitable for `/ship-spec` audit of an existing feature where some categories are known-handled.

The default is broad sweep; narrow only when the caller specifies.

## Read-Only Contract

This skill produces findings; it does not edit the feature draft. The calling command skill folds findings into the spec after presenting to the user. Do not Write to the draft directly.

## What This Replaces

- `shipyard-discovery-scout` registered agent (78 lines, deletion per CC-1 / F-25). Its body becomes this skill's discovery taxonomy + output contract.
- The inline edge-case prompts in `/ship-discuss` Phase 1.5b that previously dispatched the registered agent — now invoke this skill instead.

The original agent's reference files (`challenge`, `edge-case`, `nfr`, `failure-mode` methodology references in `ship-discuss/references/`) collapse into the categories above. Per F-53's audit-9-references action, this skill removes the need for several of them.

## Pairing With Other Skills

- **`extracting-acceptance-criteria`** runs alongside this in `/ship-discuss`. Edge cases discovered here often become new ACs there.
- **`authoring-acceptance-probe`** runs after — once an edge case becomes an AC, a probe is authored for it.
- **`dispatching-spec-review`** later verifies the cases discovered here actually got coverage in the implementation.

## Bottom Line

- 7 categories × probe questions × domain hints = systematic happy-path divergence map.
- Output is concrete cases, not warnings — testable, actionable, non-speculative.
- Read-only; calling skill folds findings into the spec.
- Replaces shipyard-discovery-scout agent and several discuss/references files.
- 13th of 14 capability skills.
