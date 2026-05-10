# Constitution Advisor

When a project has weak, vague, or missing architectural rules, Shipyard should proactively propose concrete, project-specific conventions. This isn't about generic best practices — it's about researching the project's specific tech stack and proposing rules that experienced teams actually use.

## When to Trigger

Run this assessment during init (both FRESH INSTALL and UPDATE modes) after codebase analysis is complete. Evaluate what exists:

**Strong constitution** — project already has detailed, specific rules (like file size limits, naming conventions, banned patterns, layer boundaries). Skip or offer minor suggestions.

**Weak constitution** — project has some rules but they're vague ("write clean code", "follow best practices") or missing critical categories. Propose improvements.

**No constitution** — project has no `.claude/rules/`, no CLAUDE.md conventions, no constitution file. Full proposal needed.

## Assessment: Check These Locations

1. `.claude/rules/` — existing Claude Code rules
2. `CLAUDE.md` — project-level guidance
3. `.cursor/rules/` or `.cursorrules` — Cursor rules (import to Claude rules)
4. `.github/copilot-instructions.md` — Copilot rules (import to Claude rules)
5. `.eslintrc*`, `biome.json`, `.prettierrc` — automated linting (counts as enforcement)
6. `tsconfig.json` strict mode, `pyproject.toml` settings — language-level strictness
7. Any `constitution.md`, `conventions.md`, `CONTRIBUTING.md`

## Rule Categories

Evaluate the project against these 11 categories. Each category is either COVERED (has specific, enforceable rules), WEAK (has vague guidance), or MISSING.

For every category, ask a second question alongside the conventional one: **where can an AI agent generate slop in this part of the codebase, and what rule would prevent it?** AI slop in this context means plausible-looking output that fails on contact with reality — hallucinated APIs/imports, fabricated types, generic patterns that ignore project conventions, defensive code for impossible states, premature abstractions, comment noise restating the code, half-implemented stubs that compile but don't work, and "helpful" extras outside the requested scope. Constitutions are one of the few durable defenses, so the rules proposed here should be designed to be agent-resistant, not just human-readable.

### 1. Architecture & Layer Boundaries
What layers exist? What can import what? Where does business logic live?
- Examples: "Components never import from data layer directly", "Server Actions are the only bridge between UI and data"
- Detect from: import patterns in codebase, directory structure

### 2. Code Size Limits
Concrete, measurable limits that prevent bloat.
- Examples: function max 20 lines, component max 80 lines, file max 150 lines
- Detect from: existing ESLint max-lines rules, or measure actual file sizes to propose realistic limits

### 3. Naming Conventions
File names, variables, functions, types, components, constants, booleans, event handlers.
- Examples: "files: kebab-case", "components: PascalCase", "booleans: is/has/can prefix"
- Detect from: existing file patterns, variable naming in codebase

### 4. Component/Module Patterns
Required structure, state handling, error boundaries.
- Examples: "Every component handles 4 states: loading, empty, error, default", "Props interface above component"
- Detect from: framework (React, Vue, Svelte, etc.) and existing component patterns

### 5. Testing Patterns
What to test, how to test, coverage thresholds, naming, mocking strategy.
- Examples: "Test naming: should [behavior] when [condition]", "Mock external deps only", "80% coverage minimum"
- Detect from: existing test files, test config, coverage config

### 6. Error Handling
How errors propagate, what gets logged, return types for operations.
- Examples: "Server Actions return ActionResult<T>", "Never swallow errors silently", "Use Sentry not console.log"
- Detect from: existing error patterns, logging setup, monitoring tools

### 7. Banned Patterns / Anti-Patterns
Explicit "never do this" list with "do this instead".
- Examples: "No `any` type — use `unknown` + narrow", "No `// TODO` — fix or create ticket"
- Detect from: existing linter rules, common anti-patterns in the tech stack

### 8. Domain Vocabulary
Project-specific terminology that code must use consistently.
- Examples: "Use 'tenant' not 'user'", "Use 'subscription' not 'plan'"
- Detect from: domain context, existing naming in code, README/docs

### 9. Shared Patterns & No-Duplication
Common operations that must use shared utilities, never be reimplemented.
- Examples: "Auth check via require-user.ts", "CSV building via lib/utils/csv.ts"
- Detect from: repeated patterns across files, existing utility directories

### 10. Build/Dependency Order
What depends on what, what gets built first, layer dependencies.
- Examples: "Bottom-up: migrations → validators → data → actions → components → pages"
- Detect from: dependency graph, import analysis

### 11. AI Slop Mitigation
Rules whose primary purpose is preventing the failure modes agents reliably exhibit in *this* codebase. These are project-shaped, not generic.
- Examples: "Imports must resolve — no speculative module paths; if a util doesn't exist, propose creating it explicitly", "No `try/except: pass` or empty catch — surface errors to the boundary defined in §6", "Don't add input validation, retries, or fallbacks for conditions the caller already guarantees", "Don't introduce a new abstraction on first use — duplicate twice, extract on the third", "Comments must explain *why*, never restate *what*", "No backwards-compat shims unless an external consumer is named", "Match the file's existing style (early-return vs. nested, named vs. default export) — don't import a different idiom from training data", "Stubs/TODOs ship only behind an explicit feature flag, never silently"
- Detect from: a per-area walk of the codebase asking *what's the most likely way an agent gets this wrong here?* — e.g., in a Rails app the slop risk is fabricated AR scopes; in a Next.js app it's mixing server/client boundaries; in a Go service it's wrapping every error with a generic message that hides root cause; in a typed FE codebase it's `any`/`as unknown as` to silence the type-checker.

## Research Strategy

For each WEAK or MISSING category, research what the project's specific tech stack recommends, AND identify the agent-failure modes specific to that stack and area:

1. **WebSearch** for "[framework] best practices [category]" — e.g., "Next.js 15 component patterns", "FastAPI error handling patterns", "Go naming conventions"
2. **WebSearch** for "[framework] production rules" — find what experienced teams enforce
3. **WebSearch** for "[framework] common LLM/AI coding mistakes" or "[framework] hallucinated API" — surfaces the well-documented slop patterns for that stack (e.g., invented hooks in React, made-up Django ORM methods, wrong Tailwind class names, ESM/CJS confusion in Node, fabricated `useEffect` dependencies)
4. **Check framework docs** via context7 or WebFetch for official style guides AND deprecated/removed APIs that agents still suggest
5. **Look at the project's actual code** — propose rules that match what the codebase already does well (codify existing good patterns, don't fight them)
6. **Per-area slop walk** — for each major area of the codebase (data layer, UI, API/handlers, background jobs, tests, infra), explicitly answer: *what's the most likely way an agent generates plausible-but-wrong code here, and what concrete rule prevents it?* Examples of areas to walk: schema/migrations (fabricated columns, missing indexes on FKs), auth (bypassing the project's existing helper and rolling its own check), error handling (swallowing instead of propagating), tests (asserting on mocks instead of behavior, or testing the framework not the code), config/env (hardcoding values that belong in env), public API surface (breaking shape without bumping version).

The goal is rules that are:
- **Specific** — "function max 20 lines" not "keep functions short"
- **Enforceable** — can be checked by a linter, a rule, or a human reviewer
- **Stack-appropriate** — React rules for React projects, not generic OOP rules
- **Realistic** — based on the project's actual patterns, not aspirational
- **Agent-resistant** — written so an LLM following the rule literally produces correct output. State the *why* inline so an agent can judge edge cases instead of pattern-matching to a generic answer. Prefer "do X because Y; if Y doesn't apply, ask" over rigid MUSTs that invite weird workarounds.

## Proposal Format

Present proposals grouped by category with rationale:

```
I analyzed your codebase and found some areas where clearer rules would help.
Here's what I'd suggest based on [framework] best practices:

**Architecture** (currently: no explicit layer boundaries)
  Your code already follows a rough pattern of [X]. I'd formalize it:
  - [specific rule with rationale]

**Code Limits** (currently: no size limits)
  Your average file is [N] lines, largest is [M]. Suggested limits:
  - [specific limits based on actual codebase measurements]

**Naming** (currently: inconsistent)
  You mostly use [pattern] but some files use [other pattern]. Pick one:
  - [specific convention matching majority pattern]

Want me to create these as .claude/rules/ files? (yes/all/pick/no)
```

If the user says yes or all, create one rule file per major category in `.claude/rules/`:
- Name them descriptively: `project-architecture.md`, `project-naming.md`, `project-testing.md`
- Do NOT prefix with `shipyard-` (those are Shipyard's own rules, not project rules)
- Include appropriate `paths:` scoping in frontmatter
- Keep each rule file focused and under 100 lines

If the user says pick, let them choose which categories to adopt.
