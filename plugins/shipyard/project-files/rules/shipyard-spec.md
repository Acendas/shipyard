---
alwaysApply: true
---

# Spec Authoring Rules

When creating or editing spec files ($(shipyard-data)/spec/):

- **One file per entity** — every epic, feature, and task gets its own file. Never combine.
- **YAML frontmatter first** — machine-readable metadata (id, status, estimates, RICE scores) in frontmatter. Human-readable body below.
- **200-line limit for main feature files** — `$(shipyard-data)/spec/features/` files must stay under 200 lines. When a section grows large, extract it to `$(shipyard-data)/spec/references/` (no size limit there).
- **Reference files are unlimited** — `$(shipyard-data)/spec/references/` files hold full technical content: API contracts, schemas, protocol specs, config schemas, sequence diagrams. These ARE part of the spec — ship-spec displays them inline when you look up a feature.
- **Given/When/Then acceptance criteria** — every feature must have at least one scenario.

## Feature File Structure

A feature file is the anchor: user story, BDD scenarios, planning metadata, and decisions. Technical depth lives in linked reference files.

**Sections that belong in the main feature file (< 200 lines total):**
- User Story
- Why This Matters
- Acceptance Criteria (BDD scenarios)
- Interface (brief — API surface summary)
- Data Model (brief — key entities and relationships)
- Configuration (brief — key settings)
- Flows (brief — high-level diagram)
- Error Handling (key failure modes)
- Technical Notes
- Decision Log

**Sections that should be extracted to reference files when they exceed ~50 lines:**
- Full API contracts → `FNNN-api.md`
- Complete schemas → `FNNN-schema.md`
- Full config reference → `FNNN-config.md`
- Detailed flow diagrams → `FNNN-flows.md`
- Protocol specs → `FNNN-protocol.md`

When absorbing an external doc (via `/ship-spec absorb` or during `ship-init`), the slug is derived from the source filename and may be arbitrary (e.g., `FNNN-payment-orchestration.md`). Both canonical names and absorb-derived slugs are valid — the canonical names above are for manually extracted sections only.

**Reference file frontmatter** — every file in `$(shipyard-data)/spec/references/` must have:
```yaml
---
feature: FNNN   # ID of the owning feature, or "" for architecture docs not tied to a feature
source: <original-path or "extracted from FNNN during discuss">
---
```
The `feature:` field enables reverse lookup. Always store full relative paths in the owning feature's `references:` array: `$(shipyard-data)/spec/references/FNNN-slug.md`.

## Splitting Large Spec Files

When a feature, epic, or task grows beyond 200 lines, split it:

**Pattern 1: Feature → Sub-features**
A feature with 20+ acceptance scenarios should be split into smaller features:
```
F001-email-login.md (parent — summary, links to children)
  references:
    - F001a-login-form.md (form UI, validation scenarios)
    - F001b-auth-logic.md (authentication, session management scenarios)
    - F001c-rate-limiting.md (rate limiting, lockout scenarios)
```
The parent file keeps: overview, RICE score, dependencies, decision log, and a list of child features with their IDs.
Each child keeps: its own acceptance scenarios, criteria, and technical notes.

**Pattern 2: Feature → Detail References (preferred for technical depth)**
When the feature itself is focused but has extensive technical notes, API contracts, or data models:
```
F005-payment-processor.md (feature — scenarios + decisions, <200 lines)
  references:
    - F005-api.md (full API request/response shapes, error codes)
    - F005-schema.md (database schema, field constraints, relationships)
    - F005-flows.md (payment flow sequence diagrams, state machine)
    - F005-config.md (provider config schemas, environment variables)
```
Use `references:` in the feature's frontmatter to link to detail files. Store them in `$(shipyard-data)/spec/references/`.
Ship-spec automatically displays these inline when you look up the feature — no separate reading step needed.

**Pattern 3: Epic → Features (already the default)**
Epics should never contain acceptance scenarios directly — they link to features which contain the scenarios.

### Absorbing External Technical Docs

When bringing in an existing technical doc (e.g., from a `spec/` directory):
1. Create the feature file with frontmatter, user story, BDD scenarios, and brief summaries
2. Copy the FULL source doc content into a reference file — do NOT truncate or summarize
3. Add frontmatter to the reference file: `feature: FNNN` and `source: <original-path>`. If the source file already has YAML frontmatter, merge these fields into it rather than prepending a second `---` block.
4. Add the full relative path (`$(shipyard-data)/spec/references/FNNN-slug.md`) to the `references:` array in the feature's frontmatter
5. Original source files are untouched — the user removes them manually after verifying

### Line Count Check
Before writing any spec file, check: will the main feature file exceed 200 lines? If yes, plan the reference file split BEFORE writing, not after.
- **Mermaid for diagrams** — state machines, flows, entity-relationship diagrams. Never ASCII art.
- **No placeholder text** — every section must have specific, actionable content or be omitted.
- **Link, don't duplicate** — reference other features by ID (F001, T002), don't copy content.
- **Decision log per feature** — every decision recorded with date, options considered, chosen option, reasoning.
- **Status is mandatory** — every feature/task must have a status. Valid values: `proposed | approved | in-progress | done | deployed | released | deferred | rejected`. See `.claude/rules/shipyard-data-model.md` for the canonical state machine.
- **IDs are immutable** — once assigned, never change. F001 is F001 forever.
- **Epic files must NOT contain a `features:` array** — epic membership is derived by querying feature `epic:` fields. See data model rule.
- **When creating sub-features**, add their IDs to the parent feature's `children:` array in frontmatter.
- **Frontmatter types are strict:**
  - id: string (F001, E001, T001, B001)
  - status: enum (proposed | approved | in-progress | done | deployed | released | deferred | rejected)
  - story_points: number (0 | 1 | 2 | 3 | 5 | 8 | 13) — `0` means not yet estimated
  - rice_score: number (calculated, not manual)
  - dependencies: array of IDs

## External References

Features, epics, and tasks may carry an `external_refs` array in frontmatter for linking to external issue trackers, project management tools, or any external system:

```yaml
external_refs:
  - "JIRA-123"
  - "GH-456"
  - "https://linear.app/team/issue/ENG-789"
```

Each entry is a free-form string — an issue key, URL, or any identifier meaningful in the user's tooling. Shipyard never interprets or calls these references; they exist so the user's session (via their own MCP tools like Jira, GitHub, Linear) can cross-reference Shipyard specs with external systems.

**Conventions:**
- Issue keys (e.g., `JIRA-123`, `GH-456`) are preferred over full URLs when the project has a single tracker — shorter and scannable.
- Full URLs when linking to systems without short keys or when multiple trackers are in use.
- Empty array `[]` is the default. Never `null`.

**`/ship-spec absorb` and `/ship-spec sync` behavior:**
- `absorb`: if the absorbed document mentions an external issue key (detected by patterns like `[A-Z]+-\d+`), offer to add it to `external_refs`.
- `sync`: preserve `external_refs` during sync — never overwrite or clear them. When syncing back to an external system, the user's session can read `external_refs` to know which external issue to update.

## E2E Acceptance Criteria Schema

Feature acceptance criteria are organized into two tiers:

- **Core AC** (`tier: "core"`) — happy-path and edge-case scenarios from the feature discussion. Required: at least 2 (happy path + one edge case). This is the existing AC model.
- **E2E AC** (`tier: "e2e"`) — outer-bound operational scenarios from the E2E taxonomy, added by Phase 3.7 validation. Optional. Tagged with `[category-slug]` in the feature body.

Each AC in the structured representation carries three additional fields:
- `tier`: `"core"` (default) | `"e2e"`
- `e2e_category`: taxonomy slug (e.g., `"timeout"`, `"idempotency"`) — `null` for core AC
- `verification_type`: `"probe"` (default) | `"tool"` | `"manual"`

**Backward compatibility:** When reading AC without these fields, apply defaults: `tier: "core"`, `e2e_category: null`, `verification_type: "probe"`. Existing features work unchanged.

## Epic Integration Acceptance Criteria

Epic files may contain a `## Integration Acceptance Criteria` section with cross-feature seam-level scenarios in Given/When/Then format. These reference multiple feature IDs in their Given/When clauses (e.g., "Given user signed up via F001 and verified email via F002"). Integration AC uses `e2e_category: "integration-seam"`.

If the section exceeds ~50 lines, extract to `spec/references/ENNN-integration-ac.md` and add to the epic's references.

## Sprint Quality Gate Manifest

Each sprint may have a `sprints/current/QUALITY-GATE.md` file — a derived artifact generated by `/ship-sprint` Step 10 and enforced by `/ship-review` Stage 1.5. It contains two sections:
- **Standing Gates** — from `config.md quality_gates.standing`, applied to every sprint
- **Sprint-Specific Gates** — derived from the sprint's features' E2E AC categories

QUALITY-GATE.md is never manually edited. It is regenerated when the sprint scope changes.
