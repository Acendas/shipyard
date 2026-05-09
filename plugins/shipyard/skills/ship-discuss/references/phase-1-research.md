# Phase 1.5 Research — Detail

This is the full protocol for Phase 1.5 (Research) in `/ship-discuss`. The SKILL body summarizes; this file holds the how.

## Order of operations

Walk this in order. **Use LSP first** for code navigation; fall back to Grep/Read silently.

1. **Constitution check.** Glob `.claude/rules/project-*.md` and `.claude/rules/learnings/*.md`, read every match. Extract architecture boundaries, banned patterns, naming conventions, domain vocabulary, shared utilities. Flag tensions with the proposed feature as pre-loaded Phase 1.5b challenge items. Skip silently if no `project-*.md` files exist.

2. **Internal research.** Glob `<SHIPYARD_DATA>/spec/features/F*.md` and Read each to find overlaps. Use LSP `documentSymbol` / `findReferences` for relevant codebase patterns. Read `<SHIPYARD_DATA>/codebase-context.md` for stack constraints.

3. **How others solve it.** WebSearch how established products handle this same problem, the standard UX patterns users expect, and open-source implementations to study. WebSearch common user complaints about existing solutions to learn from their mistakes. WebSearch best practices and security pitfalls for the domain (include the current year for currency). WebFetch official docs for mentioned libraries/APIs.

## Where findings go

**Write findings to the feature file `## Technical Notes`** (after Phase 3 creates it) with this structure:

```markdown
## Technical Notes

### Research Findings

**How others do it**
- [Product/project] — [how they solve this, what we can learn] (confidence: HIGH/MEDIUM)
- [Open-source repo] — [relevant approach or pattern] (confidence: HIGH/MEDIUM)
- [Common user complaints about existing solutions] — [what to avoid]

**Relevant docs**
- [URL] — [why it matters] (confidence: HIGH)

**Codebase patterns to follow**
- [file path] — [what pattern to mirror]

**Constitution constraints**
- [rule from project-*.md] — [how it applies to this feature]

**Known gotchas**
- [pitfall] — [how to avoid] (confidence: HIGH/MEDIUM/LOW)

**Recommended approach**
- [prescriptive direction — "Use X" not "Consider X or Y"]
```

Confidence levels: **HIGH** = verified in official docs or codebase. **MEDIUM** = multiple sources agree but not officially verified. **LOW** = single source or AI knowledge only.

Be prescriptive: "Use X" not "Consider X or Y". The builder needs decisions, not options.

Fold findings into the conversation naturally before challenging: "I looked into how other apps handle this — most use [X] because [Y]. That aligns with what you're describing."

## Visual context

If the feature spans multiple services, external APIs, or touches multiple parts of the architecture, show a C4 diagram (Context or Container level) so the user can see where it fits. If it involves 3+ components communicating in sequence, show a sequence diagram to make the interaction flow visible. See `references/communication-design.md` for C4 and sequence diagram patterns. Skip for features that live entirely within one component.
