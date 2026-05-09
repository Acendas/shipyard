# Phase 1.5b Challenge & Surface — Detail

This is the full protocol for Phase 1.5b in `/ship-discuss`. The SKILL body summarizes; this file holds the how.

## Capability skill invocation

Once you have a reasonable understanding of the feature, **proactively challenge it** before moving to spec. Invoke the **`shipyard:discovering-edge-cases` capability skill** to walk the seven discovery categories (boundary inputs, concurrency, failure modes, adversarial input, observability gaps, NFRs, domain-specific) and return structured findings.

Pass to the capability skill:

| Parameter | Value |
|---|---|
| `feature_text` | Inline summary of the user's feature so far, OR contents of `.research-draft.md` if it exists |
| `parent_context` | Path to the parent epic/feature if applicable, else null |
| `domain_hints` | Inferred from the feature draft (`["auth"]`, `["payments"]`, `["external-api"]`, `["multi-tenant"]`, `["AI/LLM"]`, `["cache"]` — pick relevant ones) |
| `data_dir` | Literal SHIPYARD_DATA path |

The capability skill returns a structured findings list with per-finding `category`, `case`, `currently_handled` (true/false/ambiguous), and `spec_response_needed`. You hold the structured list (~3-5k tokens), not the seven methodology references. Also run a quick pre-mortem (from `discovery-techniques.md`) — that one is short enough to do inline.

## Presentation

Follow `references/communication-design.md`. Max 3–4 items per AskUserQuestion; batch into themed groups of 3 if more. For each item: what I found → why it matters → what I recommend. Use the 3-layer pattern for anything genuinely surprising. Compact visual summary before the AskUserQuestion:

```
  ⚠️  [Finding]           → [impact], recommend [action]
  ⚠️  [Finding]           → [impact], recommend [action]
  ✅  [Finding]           → [status — no action needed]
  ❓  [Finding]           → needs decision
```

**Do not proceed to Phase 2 until grey areas are resolved or explicitly deferred.**

## Research draft file

Write research findings and challenge resolutions to `<SHIPYARD_DATA>/spec/.research-draft.md`:

```yaml
---
topic: "[primary topic from user input]"
created: [ISO date]
---
```

Body sections: `## Research Findings` (implementation context, patterns, docs/references, gotchas — same structure as feature Technical Notes), `## Challenge Resolutions` (resolved grey areas, deferred items). This file is absorbed into the feature file's Technical Notes in Phase 3 and then deleted.

## REFINE-mode usage

When REFINE mode reuses this technique against existing feature content, apply each section to what's already in the spec — audit assumptions baked into the current writing, sweep for edge cases not covered by existing acceptance scenarios, scan for conflicts with features added since this was first discussed, and list what's still missing.
