# Task Technical Notes Template

This is the canonical template for the `## Technical Notes` section in every task file. The orchestrator reads this file once during sprint planning, fills it in per task, and writes the result into the task file. **Do not echo this template back into conversation** — write it directly to the task file via the Write tool.

```markdown
## Technical Notes

### Implementation Context

**Architecture**
- Layers touched: [e.g., UI → API → service → DB]
- Blast radius: [what else could break if this changes]
- Boundaries crossed: [e.g., client/server, service/service]
- Shared contracts affected: [interfaces, schemas, APIs that other code depends on]

**Files to modify**
- [exact path] — [what changes needed]

**Patterns to follow**
- [file path] — [what to mirror] (confidence: HIGH)

**Strategy**
- [refactoring/migration approach if touching existing code — e.g., "Extract interface first, then swap implementation"]
- [incremental steps — what can be shipped independently]
- [rollback plan — what to revert if this fails]

**Principles**
- [specific design principles that apply — e.g., "Depend on the abstraction (PaymentProvider), not the implementation (Stripe)"]

**Don't do**
- [anti-pattern for this specific context] — [why and what to do instead]

**Don't hand-roll**
- [problem] → use [existing library/utility] instead (confidence: HIGH)

**Docs & references**
- [URL] — [what to read, specific section] (confidence: HIGH/MEDIUM)

**Gotchas**
- [common mistake] — [how to avoid] (confidence: HIGH/MEDIUM/LOW)

**Cleanup**
- [dead code, unused imports, deprecated patterns, stale config to remove after this task]
- [temporary scaffolding from this task that must be removed later]
- [feature flags, TODO comments, or migration shims to clean up post-release]

**Code snippets**
- [exact code pattern to follow — copy-paste ready, with placeholders marked as `<PLACEHOLDER>`]
- [second pattern if multiple files need similar changes]

**Verification steps**
- [ ] [specific check: "run X, expect Y"]
- [ ] [specific check: "open Z, verify W is visible"]
- [ ] [acceptance scenario Given/When/Then mapped to exact test assertion]

**Expected output**
- [what the task produces when done — e.g., "new file at src/lib/auth.ts with createSession() exported"]
- [observable behavior — e.g., "POST /api/login returns 200 with { token, expiresAt } on valid credentials"]
```

## Confidence levels

- **HIGH** — verified in official docs or codebase.
- **MEDIUM** — multiple sources agree but not officially verified.
- **LOW** — single source or AI knowledge only.

## Style

Be prescriptive. "Use X" not "Consider X or Y". The builder needs decisions, not options. Task specs should be executable — a builder should be able to follow them mechanically without re-reading the feature file.
