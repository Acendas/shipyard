# Sprint Analyst Report — Dispatch Prompt and Schema

This file documents how `/ship-sprint` Step 3 delegates per-feature research to subagents.

## Dispatch model

For each selected feature, spawn one `general-purpose` subagent **in parallel** (single message, N tool calls).

The analyst role is single-use to ship-sprint, so the prompt template is inline (not a Layer-2 capability skill). Substitute the literal SHIPYARD_DATA path before spawning.

**Model + effort (think)** — analysts do reasoning work: Run `shipyard-data resolve-model think` — one line `model=<m> effort=<e>`; pass each value as a string on the Agent call and OMIT any empty field (inherit). Never hardcode a literal. Log it once: `shipyard-data events emit dispatch_model_resolved role=<role> model=<model or inherit> effort=<effort>` (a logging failure never blocks the dispatch). Same values for each parallel `Agent(...)` call.

## Prompt template

```
Agent(subagent_type: "general-purpose", model: <model= from resolve-model think; omit if empty>, effort: <effort= from resolve-model think; omit if empty>, prompt: |
  You are a sprint analyst. Investigate one feature in depth and return a
  structured SPRINT ANALYST REPORT covering: architecture impact, files to
  modify, patterns to follow, reuse opportunities, strategy (clean addition /
  refactor / migration with named pattern), principles, anti-patterns,
  risks/gotchas, and external doc URLs.

  Feature ID: F<NNN>
  Feature path: <SHIPYARD_DATA>/spec/stories/F<NNN>-*.md
  Codebase context: <SHIPYARD_DATA>/codebase-context.md
  Project rules glob: .claude/rules/project-*.md and .claude/rules/learnings/*.md

  Use LSP first for code navigation (documentSymbol, findReferences,
  goToDefinition); fall back to Grep + WebSearch. Read the feature spec,
  its references, the codebase areas it touches, and relevant rules. Then
  return your structured report. READ-ONLY: no edits, no commits.
)
```

## Report schema

The reports cover:
- Architecture impact
- Files to modify
- Patterns to follow
- Reuse opportunities
- Strategy (clean addition / refactor / migration with named pattern)
- Principles
- Anti-patterns
- Risks / gotchas
- External docs (URLs)

## Low-confidence findings

The orchestrator validates low-confidence findings inline (LSP first, then Grep / WebSearch) before relying on them.
