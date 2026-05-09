# Sprint Analyst Report — Dispatch Prompt and Schema

This file documents how `/ship-sprint` Step 3 delegates per-feature research to subagents.

## Why delegate

Each analyst loads its feature file + references + relevant codebase context + project rules and returns a structured `SPRINT ANALYST REPORT`. The orchestrator holds N reports (~2k each), not N feature trees + their references + all rules.

## Dispatch model

For each selected feature, spawn one `general-purpose` subagent **in parallel** (single message, N tool calls).

The analyst role is single-use to ship-sprint, so the prompt template is inline (not a Layer-2 capability skill). Substitute the literal SHIPYARD_DATA path before spawning.

## Prompt template

```
Agent(subagent_type: "general-purpose", prompt: |
  You are a sprint analyst. Investigate one feature in depth and return a
  structured SPRINT ANALYST REPORT covering: architecture impact, files to
  modify, patterns to follow, reuse opportunities, strategy (clean addition /
  refactor / migration with named pattern), principles, anti-patterns,
  risks/gotchas, and external doc URLs.

  Feature ID: F<NNN>
  Feature path: <SHIPYARD_DATA>/spec/features/F<NNN>-*.md
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

Use the analyst output directly in Step 4 task decomposition — it drops into the task Technical Notes template with minimal rework.

## Low-confidence findings

If a report flags low-confidence findings, the orchestrator validates them inline before relying on them — use LSP first (`documentSymbol`, `findReferences`, `goToDefinition`) for code navigation, then Grep / WebSearch as fallback. The analysts already use LSP in their own runs; this is a final spot-check pass at the orchestrator level.
