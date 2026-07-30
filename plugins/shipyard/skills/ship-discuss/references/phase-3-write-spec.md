# Phase 3 Write to Spec — Detail

This is the full protocol for Phase 3 in `/ship-discuss`. The SKILL body summarizes; this file holds the how.

## Research draft absorption

Use the Read tool on `<SHIPYARD_DATA>/spec/.research-draft.md`. If it exists and is not marked `obsolete: true`, absorb its content into the feature file's `## Technical Notes` and `## Decision Log` sections. **Do not mark it obsolete yet** — it serves as a recovery checkpoint until Phase 3 is fully complete (feature file written with acceptance criteria, estimates, and epic assignment). Use Edit to set `obsolete: true` in `.research-draft.md`'s frontmatter only after Phase 3 finishes.

## Per feature

For each well-defined feature:

1. **Generate ID** — Next available FNNN (F001, F002, etc.)

2. **Determine epic** — Use Glob `<SHIPYARD_DATA>/spec/epics/E*.md` to enumerate epics and Read each. Use Grep with `pattern: ^epic:`, `path: <SHIPYARD_DATA>/spec/features`, `glob: F*.md`, `output_mode: content`, `-n: false` to see how features are grouped. Then decide:

   **Does it belong to an existing epic?** Check if the feature:
   - Shares the same user-facing domain (e.g., auth, payments, onboarding)
   - Would be described under the same section of a product overview
   - Depends on or extends features already in an existing epic

   **Should it create a new epic?** Check if:
   - It introduces a new product area not covered by existing epics
   - It involves 3+ features that logically group together (1-2 features don't justify an epic)
   - Existing epics would be diluted by adding unrelated functionality

   **If unclear** — explain the options and AskUserQuestion:
   ```
   This feature touches [domain]. I see two options:

   1. Add to E002 (Payments) — it's related to billing, but the scope is broader
   2. Create new epic "Revenue Analytics" — this is the first of likely 3+ features in this area

   Recommended: 2 — this feels like a distinct product area that will grow
   ```

   **If no epics exist yet** — create the first one if the feature is part of a larger initiative. Otherwise, leave `epic: ""` and let it accumulate. Epics emerge from patterns, don't force them early.

3. **Write feature file** to `<SHIPYARD_DATA>/spec/features/FNNN-[slug].md`.

   **Frontmatter — every field is required. No omissions.**
   ```yaml
   ---
   id: FNNN
   title: ""
   type: feature
   epic: ""               # E00N if assigned, empty string if none
   status: proposed
   story_points: 0        # rough estimate from discussion
   complexity: ""         # low | medium | high
   token_estimate: 0      # estimated total tokens (input+output) to implement this feature. Guide: S task ~50K, M task ~150K, L task ~300K. Sum across expected tasks.
   rice_reach: 0          # 0–10: how many users affected
   rice_impact: 0         # 0–3: massive=3, high=2, medium=1, low=0.5
   rice_confidence: 0     # 0–100: % confidence in reach/impact estimates
   rice_effort: 0         # person-months (use 0.5 for small features)
   rice_score: 0          # cached derived score: (reach × impact × confidence) / effort; keep in sync with components
   feasibility: 0         # 1–10 from viability gate
   dependencies: []       # feature IDs this depends on
   references: []         # full relative paths: <SHIPYARD_DATA>/spec/references/FNNN-slug.md
   children: []           # sub-feature IDs if split
   tasks: []              # populated during sprint planning
   created: YYYY-MM-DD
   updated: YYYY-MM-DD
   user_flow_probe:       # REQUIRED — see below
     kind: auto           # auto | assisted | manual
     command: |           # auto + assisted only
       <command>
     steps: |             # assisted + manual only
       <numbered user steps + expected observable outcome>
   ---
   ```

   **`user_flow_probe` is authored HERE, with the acceptance criteria — not later.** It is the proof the feature works *for a user*: unit/integration/e2e-in-CI runs do not exercise the path a user takes, and the per-task `acceptance_probe` only proves wiring inside one task. Authoring it at spec time is what makes it a real bar; a probe written after the sprint has already built the feature is a rubber stamp. `/ship-sprint` refuses to plan a feature without one, and `/ship-execute` re-checks before wave 1 — so omitting it here blocks the feature downstream rather than silently deferring.

   Pick `kind` from what actually demonstrates the flow — this is a two-way door, so decide and inform rather than asking (confidence gate, `question-design.md`):

   | Signal | kind |
   |---|---|
   | The flow has a callable surface (HTTP endpoint, CLI, library entry point) | `auto` — one command, exit 0 == works |
   | The flow is on-device / in-UI but a machine can deploy and launch to it | `assisted` — `command` sets up, a human confirms `steps` |
   | The flow can only be judged by a person (visual, hardware, third-party sandbox) | `manual` — `steps` only |

   For `assisted`/`manual`, write `steps` as numbered user actions with the **expected observable outcome** on each — "2. Expect: lands on the home screen with the account name in the header", not "2. Check it works". The person confirming may not be the person who wrote it, and a step with no stated expectation cannot be failed.

   An `assisted`/`manual` verdict is recorded as evidence (`shipyard-data feature record-proof`) and satisfies sprint-complete invariant 8 exactly as an `auto` exit-0 does. `skip-with-reason` is reserved for features where **no proof of any kind exists** — a hand-checked flow is `kind: manual`, not a skip.

   **Body sections:**
   - User story ("As a... I want... so that...")
   - Why This Matters (business reasoning)
   - Acceptance criteria in Given/When/Then format (at least 2 scenarios: happy path + one edge case)
   - **Interface** — only if API endpoints, method signatures, or event schemas were discussed. Skip the section entirely if nothing was covered.
   - **Data Model** — only if schema fields, entity relationships, or data constraints were discussed. Skip if not.
   - **Configuration** — only if settings, environment variables, or feature flags were discussed. Skip if not.
   - **Flows** — convert every diagram shown during Phase 1.5 Research to Mermaid and write it here. This is the persistence step — diagrams shown in conversation vanish after the session; Mermaid in the spec file survives. **This list is the canonical diagram-type → Mermaid-syntax mapping — `ship-discuss/SKILL.md`'s persistence line and `epic-integration-ac.md`'s Flows reference both defer to it. Keep them in lock-step.** Include:
     - **C4 diagrams** → `C4Context` / `C4Container` / `C4Component` (or `graph TD`)
     - **Sequence diagrams** → `sequenceDiagram` Mermaid syntax
     - **State machines** → `stateDiagram-v2` Mermaid syntax
     - **ER / data-model diagrams** → `erDiagram` Mermaid syntax (may live under `## Data Model` instead when the schema is the feature's primary artifact)
     - **Deployment / runtime-topology diagrams** → `C4Deployment` (or `graph TD` with node groupings)
     - **Data-flow diagrams** → `flowchart LR` / `graph LR` with trust-boundary `subgraph`s
     - **User journeys** → `journey` Mermaid syntax
     If no diagrams were shown and no flows were discussed, skip this section entirely.
   - **Error Handling** — only if specific failure modes or error responses were discussed. Skip if not.
   - Technical notes (research findings — from `.research-draft.md`)
   - Decision log (decisions made during this discussion)
   - **No inline task table** — tasks are created as separate files in `<SHIPYARD_DATA>/spec/tasks/` and referenced via the `tasks:` array in frontmatter. Preliminary task IDs can be listed during discuss; full task files are created during sprint planning.
   - **Hard limit: 200 lines per file.** If the feature has 10+ acceptance scenarios or extensive technical notes, split it:
     - Split into sub-features (F001a, F001b) for large scenario sets
     - Extract API contracts, data models, wireframes to `<SHIPYARD_DATA>/spec/references/FNNN-<slug>.md`. Add frontmatter to each extracted file: `feature: FNNN` and `source: extracted from FNNN during discuss`.
     - `<SHIPYARD_DATA>/spec/references/FNNN-flows.md` — Mermaid diagrams (C4, sequence, state machine, ER, deployment, data-flow, user journey) when `## Flows` exceeds ~30 lines
     - Add full relative paths (e.g., `<SHIPYARD_DATA>/spec/references/F001-api.md`) to the `references:` array in the feature's frontmatter
     - Plan the split BEFORE writing, not after

4. **Estimates are Shipyard-decided — NEVER a user question.** Fill every estimate field (`rice_reach`, `rice_impact`, `rice_confidence`, `rice_effort`, `story_points`, `complexity`, `token_estimate`, `feasibility`) yourself from the evidence in this discussion (scope, acceptance-scenario count, touched surfaces, prior similar features). Do NOT AskUserQuestion for any estimate value. Record a one-line rationale per non-obvious value in the Decision Log as `ASSUMED: story_points=5 because ...`. The numbers appear in the Phase 5 ESTIMATES section with rationale; the user vetoes via the Round-4 approval gate ("Refine"), never via a question. Low confidence goes into `rice_confidence` and the rationale, not into a question.

5. **Epic**: If an epic was assigned, set `epic: E00N` in feature frontmatter. Do NOT update the epic file with a features list — epic membership is derived by querying feature files.
