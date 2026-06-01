# Phase 1.5 Research — Detail

This is the full protocol for Phase 1.5 (Research) in `/ship-discuss`. The SKILL body summarizes; this file holds the how.

## Order of operations

Walk this in order. **Use LSP first** for code navigation; fall back to Grep/Read silently.

1. **Constitution check.** Glob `.claude/rules/project-*.md` and `.claude/rules/learnings/*.md`, read every match. Extract architecture boundaries, banned patterns, naming conventions, domain vocabulary, shared utilities. Then do **two** passes against the proposed feature:
   - **Tensions** — places the feature would violate an existing rule. Pre-load these as Phase 1.5b challenge items.
   - **Gaps (gray areas)** — territory the feature enters that no existing rule covers. For each gap, write one line to `<SHIPYARD_DATA>/spec/.research-draft.md` under a `## Constitution Gaps` section: `- [area] — no rule covers [decision needed]; agent slop risk: [specific failure mode]`. Examples of gap-triggers: a new concurrency model (queues, jobs, websockets), a new external integration class (payments, auth provider, AI/LLM call), a new data category (PII, tenant-scoped, audit-logged), a new UI surface (background tab, server component, edge route), a new error class that needs propagation rules. Phase 1.5b challenges resolve these gray areas explicitly; Phase 6 Finalize then proposes the resolutions as new constitution rules. Skip the gap pass silently if no `project-*.md` files exist (the project hasn't opted into a constitution).

2. **Internal research.** Glob `<SHIPYARD_DATA>/spec/features/F*.md` and Read each to find overlaps. Use LSP `documentSymbol` / `findReferences` for relevant codebase patterns. Read `<SHIPYARD_DATA>/codebase-context.md` for stack constraints.

3. **How others solve it.** WebSearch how established products handle this same problem, the standard UX patterns users expect, and open-source implementations to study. WebSearch common user complaints about existing solutions to learn from their mistakes. WebSearch best practices and security pitfalls for the domain (include the current year for currency). WebFetch official docs for mentioned libraries/APIs.

4. **Architecture visualization.** Before moving to findings, generate the diagrams that make the feature's structure visible. **Gate on architectural significance, not participation.** A diagram earns its place when it reveals structure a reader cannot hold from prose — a *new* boundary, a *real* lifecycle, a *non-obvious* interaction, a *multi-entity* relationship, a *new* runtime unit. Do NOT draw a diagram merely because the feature traverses existing layers — a CRUD endpoint that reuses the same controller→service→repo path as fifty others is a sentence, not a picture. Over-generation destroys the signal: if every feature carries a diagram, a diagram stops meaning "the structure here is worth your attention." Expect the diagram-worthy set to be the architecturally-interesting subset of features, not all of them.

   Walk every trigger below and generate each diagram whose trigger fires — a single feature can warrant several. Generation is **mandatory when a trigger fires** — not optional polish. "When in doubt, generate" means a genuine significance call is ambiguous, NOT "the feature touched two files."

   **C4 diagram** — generate when the feature **adds or changes a structural element**: a new service/container, a new external integration, OR a new internal component or boundary. Pick the level by which condition fired:
   - **Context (Level 1)** — a new external system or actor enters the picture (third-party API, new client surface). Monolith-friendly: this fires even on a single-service app the moment it talks to something new outside itself.
   - **Container (Level 2)** — a new service/datastore/queue appears, or the interaction between two existing containers changes.
   - **Component (Level 3)** — the feature stays inside one container but adds or rewires 3+ internal components (controllers, services, repositories, gateways). **This is the level monoliths actually need:** when "2+ services" never fires because the whole app is one service, Component level shows the internal structure that genuinely changes.

   Do NOT fire C4 when the feature reuses the existing layer path with no new component or boundary. Class/Code-level C4 is **out of scope at spec altitude** — a feature spec describes structure and behavior, not class internals; capture class design in the task, not the feature spec.

   **Sequence diagram** — generate when **2+ components exchange messages AND the interaction is non-obvious**: async/callback/retry/idempotency, a compensation or error-recovery flow, fan-out/fan-in, or multi-step ordering that is hard to track in prose. The component count is **not** the gate — a *2-party* flow with retries and idempotency (e.g. app ↔ external payment API) is highly sequence-worthy. Do NOT draw a sequence diagram for a single synchronous request/response just because it has a try/catch — that is one sentence (consistent with `communication-design.md` "Don't visualize linear sequences"). Show the happy path first, then add error/timeout branches as `alt` blocks.

   **State machine diagram** — generate when a **state graph is complex enough to be hard to follow in prose**: an entity lifecycle with **≥3 states or branching/guarded/cyclic transitions** (order status, approval workflow, subscription state), OR a non-trivial **UI/view state machine** with branching transitions. Do NOT draw one for the routine loading→loaded→error quartet — that is adequately covered by the Quality Gate's Check 15, which requires the spec to *handle* empty/error/loading/offline states in prose AC. The diagram and Check 15 are **complementary**: Check 15 guarantees the states are handled; this diagram fires only when the transition graph itself is too tangled to read as text. Show all states, valid transitions, and terminal states.

   **ER / data-model diagram** — generate when the feature **introduces or changes 2+ related entities, or a non-trivial schema** (new tables/collections, foreign keys, join tables, polymorphic relations). The `## Data Model` section is otherwise prose-only; a Mermaid `erDiagram` shows cardinality and relationships a paragraph cannot. Especially warranted when the Constitution-Gap pass flagged a new data category (PII, tenant-scoped, audit-logged). Do NOT draw one for adding a single column to an existing table.

   **Deployment / runtime-topology diagram** — generate when the feature **adds a new runtime unit or crosses a deployment/trust boundary**: a worker, queue, cron job, edge function, webhook receiver, new region, or a third-party that runs out-of-process. It shows *where things run*, which prose hides. Pairs directly with the Constitution-Gap triggers for "new concurrency model (queues, jobs, websockets)" and "new UI surface (background tab, server component, edge route)." Do NOT draw one for a feature that runs entirely inside the existing request path.

   **Data-flow diagram (with trust boundaries)** — generate when **data crosses a trust boundary or moves through 2+ processing stages/stores**: PII entering or leaving the system, tenant-scoped data, an ingest→transform→store pipeline, or anything the security pass should see boundaries for. A `flowchart`/`graph LR` with explicit trust-boundary lanes makes the data path and its crossings legible. Do NOT draw one for data that stays within a single store and a single trust zone.

   **User-journey diagram** — generate when the feature has a **multi-step before→trigger→during→after flow with decision or abandon points** (onboarding, checkout, multi-screen wizards). The User Journey Mapping discovery technique already collects this; render it as a Mermaid `journey` so the abandon and decision points are visible. Do NOT draw one for a single-screen, single-action feature.

   **Skip criteria (the significance test):** skip ALL diagrams when the feature lives entirely within one component, reuses the existing structure, touches no external system, introduces no new entity-relationship or runtime unit, and has no non-trivial state graph or multi-step journey. A copy change, a single-column migration, a new form field, or a CRUD endpoint on an existing path needs none. If at least one trigger fires, generate that diagram; if a genuine significance call is ambiguous, generate it — it costs one paragraph and saves hours of miscommunication.

   Show diagrams inline in the conversation using ASCII box-drawing (see `references/communication-design.md` for patterns). Phase 3 converts each to Mermaid for the spec file — the canonical diagram-type → Mermaid-syntax mapping lives in `references/phase-3-write-spec.md`. Present each diagram with a one-sentence setup: "Here's where this feature fits in the current architecture:" or "Here's the interaction flow for the happy path:".

5. **Data-modeling guidance (gated).** When the feature **persists or models data** — i.e. the ER / data-model diagram trigger fired, the feature will have a `## Data Model` section, or the Constitution-Gap pass flagged a new data category (PII, tenant-scoped, audit-logged) — Read `${CLAUDE_PLUGIN_ROOT}/project-files/references/data-modeling-guide.md` and apply it: normalize to 3NF/BCNF unless there's measured cause to denormalize, choose keys (surrogate PK + unique natural key), pick types/constraints, run the right-sizing decision routine, and reject schema-shape anti-patterns (EAV, OTLT, god tables) at design time. Fold the conclusions into the `## Data Model` section and `## Technical Notes` prescriptively ("Use X"). **Skip entirely for features with no persistence concern** — loading database guidance into a non-data feature is the over-engineering this gate prevents (same significance discipline as the diagram triggers). Project constitution rules (`.claude/rules/project-*.md`) still win over the guide's defaults.

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
