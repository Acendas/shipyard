# Phase 1.5 Research — Detail

This is the full protocol for Phase 1.5 (Research) in `/ship-discuss`. The SKILL body summarizes; this file holds the how.

## Order of operations

Walk this in order. **Use LSP first** for code navigation; fall back to Grep/Read silently.

1. **Constitution check.** Glob `.claude/rules/project-*.md` and `.claude/rules/learnings/*.md`, read every match. Extract architecture boundaries, banned patterns, naming conventions, domain vocabulary, shared utilities. Then do **two** passes against the proposed feature:
   - **Tensions** — places the feature would violate an existing rule. Pre-load these as Phase 1.5b challenge items.
   - **Gaps (gray areas)** — territory the feature enters that no existing rule covers. For each gap, write one line to `<SHIPYARD_DATA>/spec/.research-draft.md` under a `## Constitution Gaps` section: `- [area] — no rule covers [decision needed]; agent slop risk: [specific failure mode]`. Examples of gap-triggers: a new concurrency model (queues, jobs, websockets), a new external integration class (payments, auth provider, AI/LLM call), a new data category (PII, tenant-scoped, audit-logged), a new UI surface (background tab, server component, edge route), a new error class that needs propagation rules. Phase 1.5b challenges resolve these gray areas explicitly; Phase 6 Finalize then proposes the resolutions as new constitution rules. Skip the gap pass silently if no `project-*.md` files exist (the project hasn't opted into a constitution).

2. **Internal research.** Glob `<SHIPYARD_DATA>/spec/features/F*.md` and Read each to find overlaps. Use LSP `documentSymbol` / `findReferences` for relevant codebase patterns. Read `<SHIPYARD_DATA>/codebase-context.md` for stack constraints.

3. **How others solve it.** WebSearch how established products handle this same problem, the standard UX patterns users expect, and open-source implementations to study. WebSearch common user complaints about existing solutions to learn from their mistakes. WebSearch best practices and security pitfalls for the domain (include the current year for currency). WebFetch official docs for mentioned libraries/APIs.

4. **Architecture visualization.** Before moving to findings, generate diagrams that make the feature's scope and interaction visible. This is mandatory when the triggers below apply — not optional polish.

   **C4 diagram** — generate when the feature spans 2+ services, touches external APIs, or affects multiple architecture layers. Use C4 Context level for broad scope, Container level for service-to-service detail. Show the feature's new/changed elements highlighted against the existing landscape.

   **Sequence diagram** — generate when 3+ components communicate in sequence, when order of operations matters, or when async/callback/retry patterns are involved. Show the happy path first, then add error/timeout branches as alt blocks.

   **State machine diagram** — generate when the feature introduces or modifies entity lifecycle states (e.g., order status, approval workflow, subscription state). Show all states, valid transitions, and terminal states.

   **Skip criteria:** features that live entirely within one component with no external interaction and no state lifecycle changes. If in doubt, generate the diagram — it costs one paragraph and saves hours of miscommunication.

   Show diagrams inline in the conversation using ASCII box-drawing (see `references/communication-design.md` for patterns). Phase 3 will convert them to Mermaid for the spec file. Present each diagram with a one-sentence setup: "Here's where this feature fits in the current architecture:" or "Here's the interaction flow for the happy path:".

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

See **Step 4 (Architecture visualization)** in the order of operations above. That step is the mandatory checkpoint — diagrams are generated there, shown inline during conversation, and persisted to the `## Flows` section in Phase 3.
