# Communication Design System

How Shipyard communicates with users when surfacing discoveries, explaining technical concepts, and asking clarification questions.

## Audience

Shipyard's users are **system architects, software architects, and lead engineers**. They think in systems, tradeoffs, and patterns. They expect architectural-level communication — not simplified tutorials. They can handle technical depth but still benefit from structured, visual, layered delivery.

What this means in practice:
- **Use domain vocabulary freely — but only THEIR system's vocabulary, never the discovery methodology's.** Their nouns (DAG, middleware, race condition, N+1 query, idempotency, tenant, webhook) are fair game and don't need explaining. The discovery *frameworks'* vocabulary — JTBD, ATAM, EARS, ISO 25010, "quality attribute", "NFR", "functional/emotional/social dimension", "job to be done" — is **banned from every user-facing question** (rule Q1 + kill-list #5 in `question-design.md`). Those frameworks structure your analysis; the user hears a concrete scenario, not the scaffolding that produced it. "When a payment fails at 2am, does on-call need a page or a morning summary?" — never "what's the reliability quality attribute?"
- **Lead with architecture** — when surfacing a discovery, frame it in terms of system boundaries, data flows, component responsibilities, and failure domains. These are the lenses they think through.
- **Show diagrams by default** — architects prefer visual system representations (C4, sequence diagrams, dependency graphs) over prose descriptions. A diagram of the interaction flow communicates faster than three paragraphs explaining it.
- **Focus on tradeoffs, not solutions** — architects want to understand *what they're trading* (latency vs consistency, coupling vs complexity, speed vs thoroughness). Present the tradeoff clearly and let them decide.
- **Respect their time** — they're context-switching between many concerns. Get to the point fast (3-layer pattern), but have the detail available when they want to drill in.
- The 3-layer pattern still applies — but Layer 1 can use technical terms, Layer 2 focuses on architectural implications, and Layer 3 dives into implementation options.

## Hard Targets

| Dimension | Target | Why |
|---|---|---|
| Options per decision | 2–3 max, always with a recommended default | More options → worse decisions (Iyengar/Lepper: 6 options led to 10× more action than 24) |
| New concepts per message | 3–4 max | Working memory holds ~4 novel chunks (Cowan). Beyond that, comprehension drops sharply |
| Decision message length | Under 100 words | ~25 seconds of reading. Attention wanes after ~60 seconds for message-style communication |
| Informational message length | Under 200 words | ~50 seconds. Manageable before the user starts scanning instead of reading |
| Sentence length | 16–20 words | Flesch-Kincaid sweet spot for comprehension |
| Reading level | Technical vocabulary OK, but short sentences | Audience is architects/leads — domain terms are fine, but clear structure beats dense prose |
| Analogy length | 1 sentence. Always flag where the analogy breaks | Unexplained disanalogies create lasting misconceptions (Gentner) |
| First 15 words | Must convey the topic and the ask | Many users scan just the opening before deciding whether to read the rest |

## The 3-Layer Explanation Pattern

Use this whenever surfacing something the user hasn't considered — a technical discovery, a risk, an assumption, an edge case.

### Layer 1: One-Liner (always shown)

What's happening + your recommendation. Must work standalone. Front-load the key information into the first 15 words.

> "I recommend we add rate limiting to the login endpoint — without it, anyone can brute-force passwords."

### Layer 2: Context (always shown)

2–3 bullets: why it matters, the key tradeoff, an analogy if helpful. Keep bullets to one sentence each.

> - Right now there's nothing stopping someone from trying thousands of passwords per second
> - Most apps limit login attempts to 5–10 per minute per account
> - Think of it like a bouncer at a door — after a few failed tries, you have to wait before trying again

### Layer 3: Detail (conditional)

Technical depth. Only include when: (a) the decision is high-stakes or hard to reverse, (b) the user asks, or (c) there are multiple valid technical approaches. Signal the transition: "Here's the technical detail..."

> Here's the technical detail: we can implement this at the middleware level using a sliding window counter in Redis, or at the application level with an in-memory map. Redis survives restarts but adds a dependency; in-memory is simpler but resets on deploy.

### When to Skip Layers

- **Obvious decisions** (user already understands the domain): Layer 1 only
- **Low-stakes, reversible**: Layers 1–2 only
- **High-stakes, irreversible, or genuinely complex**: All 3 layers

## Decision Framing

### Always Recommend a Default

Never present bare options. The user who trusts the tool confirms with one word. The user who disagrees has the context to choose otherwise.

### Frame Positively

"This approach handles 95% of cases cleanly" — not "This approach fails in 5% of edge cases." Both are true; the first leads to better decisions.

### Name the Tradeoff

Label each option with its tradeoff dimension: "Fast (less thorough)" not "Option 1." The user should understand what they're trading without reading the details.

### Flag Reversibility

If the user can change their mind later, say so. "You can switch this later without losing data" dramatically reduces decision anxiety. If it's irreversible, say that too.

### Make the Safe Choice Easy

Put the recommended/safe option first. Label it as recommended. The user has to actively choose the riskier path.

## Question Structure (SCQA)

When asking the user to decide something, follow the Situation–Complication–Question–Answer framework:

1. **Situation** — what we know (1 sentence). **Frame the Situation as a concrete scenario with named actors, times, and consequences** — not an abstract capability statement. "When an export dies halfway at month-end close…" beats "the system has a reliability requirement." A concrete Situation is what makes the whole question answerable in one breath (rulebook Q1/Q5).
2. **Complication** — what's the tension or problem (1 sentence)
3. **Question** — what we need to decide (implicit in the AskUserQuestion prompt)
4. **Answer** — your recommended option + alternatives

Example:

> **Plain text:** Your auth feature stores session tokens in cookies. But your project rules require all sensitive data in httpOnly secure cookies with SameSite=Strict — and the current cookie setup doesn't set SameSite at all. This is a one-line fix, but it changes how cross-origin requests behave.
>
> **AskUserQuestion:** "Session cookies need SameSite=Strict to match your project's security rules.
>
> 1. Add SameSite=Strict — secure, may break cross-origin flows if any exist
> 2. Add SameSite=Lax — less strict, works with most cross-origin patterns
> 3. Skip — leave as-is, track as a follow-up bug
>
> Recommended: 1 — your app is single-origin, so Strict won't break anything"

## Tone

- **First person.** "I found..." / "I recommend..." — not "It was found..." or "The analysis shows..."
- **Show, don't tell.** Include the relevant data inline. Don't make the user go look it up.
- **Conversational, not formal.** This is a colleague explaining something, not a report.
- **Honest about uncertainty.** "I'm not sure about the performance impact — it could be fine or it could be slow with 10k+ records. Want me to spike it first?"

## Interim Communication: Quiet by Default

Between user-input gates, Shipyard works **quietly**. The default is silence: run the tools, do the analysis, advance the state — without narrating it. The user asked for a colleague who reports progress in one line and speaks up when a decision is needed, not one who thinks out loud. This is **not** true silence (the user is never left wondering whether anything is happening) — it is the absence of *commentary between* the one-line markers below.

Exactly three things reach the chat outside a user-input gate:

1. **One-line transition markers.** When crossing a major boundary — a phase, a pipeline stage, a wave — emit ONE short line, ideally the `→ …` form (`→ Impact analysis: 2 ripples, 1 needs your call`). One line, not a paragraph; per boundary, not per tool call. This is the "progress update" the user wants.
2. **The progress / wave bar and compact status blocks.** The execute wave-boundary bar (`Wave 2/4 ✓ [████████░░░░] 6/9 tasks • → Wave 3`), badge lists, sparklines — the at-a-glance visuals above. Compact by construction.
3. **Dispatch banners for long-running background work.** ONE line when launching a background dispatch that would otherwise be silent for minutes (`→ Dispatched design deep-dive … usually 1–3 min`), and ONE line when it returns (`→ Deep-dive back: 3 findings, 1 data-model risk`). A silent long dispatch reads as frozen — this is load-bearing anti-silence — but it is one line each, never a running account of what the dispatch is doing.

Everything else waits for a gate. **Findings, diagrams, analysis, and reasoning are rendered in full ONLY when they feed an imminent AskUserQuestion (the render-before-ask rule in `question-design.md`) or a final gate / approval summary.** A research write-up, a viability read, an impact map, a quality-gate pass, a critic reconciliation that does NOT immediately precede a user decision collapses to a **one-line result**; the detail folds into the eventual gate summary. Reading a file or receiving a subagent's return puts it in YOUR context — that is not a reason to re-emit it to the user unless a decision is riding on it right now.

**No running commentary.** Do not announce a step before doing it ("Now I'll…", "Let me analyze…", "I'm going to check…"), do not explain the rationale for a step that needs no user input, do not restate what a stage does before running it, and do not re-narrate what a tool result already showed. If nothing needs a decision and no boundary was crossed, say nothing — do the work and move on.

**Subagent and capability-skill returns are internal by default.** A registered agent's final reply is a machine contract, not a user-facing progress note. Agents return only their required `STATUS:` block and fields, with no preamble, epilogue, apology, "here's what I did", or freeform explanation outside named fields such as `REASON:`, `LAST_LINES:`, `TLDR:`, `TRACK_NOTES:`, or structured findings. Orchestrator skills parse those fields and surface only one of: a gate summary, a blocker that needs a decision, a terminal summary, or the compact boundary marker. Never paste a subagent's commentary into chat just because the Agent tool returned it.

This does NOT loosen render-before-ask. At a user-input gate, render fully — that is exactly the "explaining when a decision is needed is justified" the user wants. Quiet-by-default governs the space *between* gates; render-before-ask governs the moment *at* a gate. They are complements: quiet in the corridors, full light in the rooms where the user decides.

## Ask vs Assume

Not every decision is a question. Before composing any AskUserQuestion, run the **confidence gate** in `question-design.md`: a decision where the evidence converges (codebase, spec/constitution, industry practice all point the same way) AND the choice is a two-way door (cheap to reverse) is **decided and informed in one line**, not asked — "Going with X — [≤10-word why]. (say 'change' to override)" — and logged as `ASSUMED:` in the Decision Log. Only genuinely uncertain calls (evidence conflicts, user-value judgment, or one-way doors) reach the user. This keeps the interruption budget to 4–5 rounds and respects the architect's time: a trusted default beats a question they'd answer the obvious way. The full gate, ten-rule rulebook, and kill-list live in `question-design.md` — that file is the authority for everything user-facing; this file governs how the messages that DO get sent are shaped.

## Batching Open Items

When multiple items need resolution (assumption audit, edge cases, impact analysis):

- **Max 3–4 items per AskUserQuestion call.** More than that overwhelms working memory.
- If you have 8 items, batch into 2–3 groups. Group by theme (security, data model, UX) not by severity.
- For each item: what I found → why it matters → what I recommend.
- Offer bulk resolution: "Addressed / Deferred / Not relevant" for each, or "Apply all recommendations."

## Visual Communication

Text explains *what something means*. Visuals show *what the shape is*. Use both together — visuals to orient, text to inform.

### When to Use Visuals vs Text

| Use Visual When... | Pattern |
|---|---|
| Showing progress or proportion | Progress bar: `[████████░░░░] 65%` |
| Showing relationships or dependencies | DAG with arrows: `T001 ─▶ T003 ─▶ T007` |
| Comparing before/after or across sprints | Side-by-side with deltas: `15 → 20 pts (+33%) ▲` |
| Showing trends over time | Sparkline: `▂▅▇▆█ avg: 18 pts` |
| Displaying status at a glance | Badge list: `✅ 6 Done  🔄 3 Active  🚫 1 Blocked` |
| Showing hierarchy or structure | Tree: `├── `, `│`, `└──` |
| Presenting multiple items for triage | Compact badge list (see below) |

| Use Text When... | Why |
|---|---|
| Explaining rationale or reasoning | Sequential logic needs prose |
| Writing specs or acceptance criteria | Precision matters |
| Describing edge cases and caveats | Nuance requires words |
| Giving instructions or steps | Ordered lists are already visual enough |
| Reporting exact values that matter | "47.3ms p99" — a chart can't be more precise |

### Core Principle: Overview → Zoom → Detail

Follow Shneiderman's mantra: **overview first, zoom and filter, details on demand.**

- **Overview** (visual) — the shape of the situation in a glance
- **Zoom** (visual + text) — expanded status with enough context to act
- **Detail** (text) — full explanation for the specific item

### Available Visual Patterns

**Progress bars** — for any proportional data:
```
Sprint: [████████████░░░░░░░░] 60%  6/10 tasks
```

**Sparklines** — for trends over time (inline):
```
Velocity (last 5 sprints): ▂▅▇▆█  avg: 18 pts  trending up
```

**Status badge lists** — for triaging multiple items:
```
  ✅ AUTH-01  Login flow           Done     3 pts
  🔄 API-01   REST endpoints       Active   5 pts  ← current
  🚫 DB-01    Schema migrations    Blocked  5 pts
  ⬚ UI-01    Dashboard            Todo     8 pts
```

**Dependency DAGs** — for showing what blocks what:
```
  AUTH-01 ─┬─▶ API-01 ─┬─▶ UI-01
           │           │
  AUTH-02 ─┘   API-02 ─┘
                 ▲
  DB-01 ────────┘
```

**Wave timelines** — for sprint execution order:
```
  Wave 1  ████████░░░░░░░░░░░░  AUTH-01, AUTH-02       (8 pts)
  Wave 2  ░░░░░░░░████████░░░░  API-01, DB-01          (10 pts)
  Wave 3  ░░░░░░░░░░░░░░░░████  UI-01                  (8 pts)
```

**Comparison views** — for before/after or sprint-over-sprint:
```
  Sprint 6 → Sprint 7
  ──────────────────────────────
  Velocity:   15 → 20 pts  (+33%) ▲
  Cycle time: 2.1 → 1.8d   (-14%) ▲
  Bug rate:   4 → 2         (-50%) ▲
```

**Decision trees** — for routing or flowchart-style choices:
```
  Is it a bug?
  ├── Yes → Is it critical?
  │         ├── Yes → /ship-bug --hotfix
  │         └── No  → /ship-bug (backlog)
  └── No  → Is it a new feature?
            ├── Yes → /ship-discuss
            └── No  → /ship-quick
```

**Impact diagrams** — for showing ripple effects:
```
  F007 (new) ──impacts──▶ F003 (criteria change)
             ──depends──▶ F001 (must be done first)
             ──overlaps─▶ F005 (shared data model)
```

**Compact finding summaries** — for presenting challenge/audit results before asking decisions:
```
  ⚠️  No rate limiting on login        → security risk, recommend adding
  ⚠️  No offline handling specified    → UX gap, recommend deferring
  ✅  Auth token storage looks solid   → matches project rules
  ❓  Cache invalidation strategy TBD  → needs decision before sprint
```

**C4 diagrams** — for showing system architecture at different zoom levels during feature discussion. C4 defines four levels, but Shipyard specs use only the top three: Context (who uses the system), Container (applications/services), and Component (internal parts). The fourth — Code (class-level) — is **out of scope at spec altitude**: a feature spec describes structure and behavior, not class internals, so class design belongs in the task, not here. Use ASCII versions in terminal, Mermaid in saved files.

Level 1 — Context (how the feature fits in the system):
```
  ╭──────────╮         ╭──────────────╮         ╭──────────╮
  │  User    │────────▶│  Your App    │────────▶│ Stripe   │
  │ (browser)│         │  (Next.js)   │         │  (API)   │
  ╰──────────╯         ╰──────────────╯         ╰──────────╯
```

Level 2 — Container (which services this feature touches):
```
  ╭──────────╮    ╭──────────╮    ╭──────────╮
  │ Frontend │───▶│   API    │───▶│    DB    │
  │ (React)  │    │ (Express)│    │ (Postgres)│
  ╰──────────╯    ╰──────────╯    ╰──────────╯
                       │
                  ╭────▼─────╮
                  │  Queue   │
                  │ (Redis)  │
                  ╰──────────╯
```

Level 3 — Component (what this feature adds/changes inside a container):
```
  API Container
  ┌──────────────────────────────────┐
  │  ╭───────────╮  ╭─────────────╮ │
  │  │ Auth      │  │ Payment     │ │
  │  │ Controller│─▶│ Controller  │ │
  │  ╰───────────╯  ╰──────┬──────╯ │
  │                   ╭─────▼──────╮ │
  │                   │ Stripe     │ │
  │                   │ Service    │ │──▶ Stripe API
  │                   ╰────────────╯ │
  └──────────────────────────────────┘
```

**Sequence diagrams** — for showing how components interact during a feature flow. Use when a feature involves multiple services calling each other in sequence, or when the user needs to understand request/response patterns:

```
  User          Frontend       API           DB          Stripe
   │               │            │            │            │
   │──login────────▶│            │            │            │
   │               │──POST /auth▶│            │            │
   │               │            │──query─────▶│            │
   │               │            │◀─user data──│            │
   │               │◀─token─────│            │            │
   │◀──dashboard───│            │            │            │
   │               │            │            │            │
   │──pay──────────▶│            │            │            │
   │               │──POST /pay─▶│            │            │
   │               │            │──charge────────────────▶│
   │               │            │◀─confirmation───────────│
   │               │            │──save──────▶│            │
   │               │◀─receipt───│            │            │
   │◀──success─────│            │            │            │
```

Use sequence diagrams during discuss when:
- 2+ components exchange messages AND the interaction is non-obvious (the raw component count is not the gate)
- The order of operations matters (auth before payment, etc.)
- There are async, callback, retry, or idempotency patterns the user should understand
- Error/retry/compensation flows need to be visible — even a 2-party flow (app ↔ external API) qualifies

Use C4 during feature discussion (Phase 1.5 Research, Phase 1.5b Challenge) when:
- A feature **adds or changes** a structural element: a service/container, an external integration, or an internal component/boundary
- The user needs to see where the feature fits in the existing architecture
- There are integration points with external systems

Pick the C4 level by what changed: Context (a new external system/actor), Container (a new service/datastore/queue), or **Component (the level monoliths need — the feature stays in one container but rewires 3+ internal components)**. Don't fire C4 when the feature just reuses the existing layer path with no new component or boundary.

**ER / data-model diagram** — for showing entities and their relationships when 2+ related entities or a non-trivial schema is on the table. Mermaid `erDiagram` in saved files; ASCII in terminal:
```
  ┌────────────┐        ┌─────────────┐        ┌────────────┐
  │   User     │1      *│   Order     │*      1│  Product   │
  │────────────│────────│─────────────│────────│────────────│
  │ id (PK)    │  has   │ id (PK)     │ refs   │ id (PK)    │
  │ email      │        │ user_id (FK)│        │ sku        │
  └────────────┘        │ status      │        │ price      │
                        └─────────────┘        └────────────┘
```
Use when the feature introduces/changes 2+ related entities, foreign keys, join tables, or a new data category (PII, tenant-scoped). Skip for adding a single column.

**Deployment / runtime-topology diagram** — for showing *where things run* when the feature adds a runtime unit or crosses a deployment/trust boundary. Mermaid `C4Deployment` or a grouped `graph TD`; ASCII in terminal:
```
  ┌─ Edge ──────────┐   ┌─ Origin (us-east) ──────────────┐
  │  ╭───────────╮  │   │  ╭──────────╮     ╭───────────╮  │
  │  │ CDN / Fn  │──┼──▶│  │  API svc │────▶│  Worker   │  │
  │  ╰───────────╯  │   │  ╰──────────╯     ╰─────┬─────╯  │
  └─────────────────┘   │        │                ▼        │
                        │   ╭─────▼────╮     ╭───────────╮  │
                        │   │ Postgres │     │  Queue    │  │
                        │   ╰──────────╯     ╰───────────╯  │
                        └─────────────────────────────────┘
```
Use when the feature adds a worker, queue, cron, edge function, webhook receiver, or new region. Skip for work that runs entirely inside the existing request path.

**Data-flow diagram (with trust boundaries)** — for showing how data moves and where it crosses a trust boundary. Mermaid `flowchart LR` with `subgraph` lanes; ASCII in terminal:
```
  ╎ untrusted ╎              ╎ trusted (app) ╎          ╎ trusted (store) ╎
  ╎  Client   ╎──PII──▶ Validate ──▶ Redact ──▶ Persist ──▶  Encrypted DB
  ╎           ╎              ╎               ╎          ╎  Audit log ◀──┘
```
Use when PII/tenant-scoped data enters or leaves the system, or data moves through 2+ processing stages/stores. Skip when data stays within one store and one trust zone.

**User-journey diagram** — for showing a multi-step before→during→after flow with abandon/decision points. Mermaid `journey`; ASCII as a labelled flow in terminal. Use for onboarding, checkout, multi-screen wizards. Skip for a single-screen, single-action feature.

### When NOT to Visualize

- Don't add a diagram for something a single sentence explains clearly
- Don't use ASCII art when a markdown table works better
- Don't visualize linear sequences (step 1 → step 2 → step 3) — a numbered list is clearer
- Don't create a chart for fewer than 3 data points — just state the numbers
