# Communication Design System

How Shipyard communicates with users when surfacing discoveries, explaining technical concepts, and asking clarification questions.

## Audience

**Do not assume the reader is an expert.** The person reading may be the owner of the product, not the person who would build it. They know what they want and what their users do. They may not know how software is put together, and they should not have to. Write so that a smart person from outside the field understands it on the first read.

What this means in practice:
- **Plain words.** Say "the list loads slowly because it asks the database once per row", not "an N+1 query". If a technical word is truly needed, explain it in half a sentence the first time: "a migration (a one-time change to how the data is stored)".
- **Their words, never the method's.** Use the names the user uses for their own things. The vocabulary of the discovery methods (JTBD, ATAM, EARS, ISO 25010, "quality attribute", "NFR", "job to be done") never reaches the user. It structures the analysis; translate every probe into a plain scenario (rule Q1 in `question-design.md`).
- **What it means for them, before how it works.** Lead with the effect a person would notice: what a user sees, what breaks, what it costs, what gets slower. The mechanism comes after, and only as much as the decision needs.
- **Show, don't describe.** A picture, a small table or one real example carries more than three paragraphs. See "The 3-Layer Explanation Pattern" below.
- **An expert loses nothing.** Plain words and a picture are faster for experts too. Depth is still there, one step down (Layer 3), for whoever wants it.

## Hard Targets

| Dimension | Target | Why |
|---|---|---|
| Progress update | One line: 8 words or fewer plus a small visual (bar, count, badges) | The user wants to glance, not read |
| Summary at the top | 40 words or fewer: readable in 15 seconds | It is the only part some readers will read. It must stand alone |
| Words against pictures | After the summary, more picture, table and example than prose | A shape is read faster than a sentence |
| Options per decision | 2–3 max, always with a recommended default | More options, worse decisions |
| New ideas per message | 3–4 max | Working memory holds about four new things |
| Decision message length | Under 100 words of prose (pictures and tables do not count) | About 25 seconds of reading |
| Informational message length | Under 200 words of prose | About 50 seconds |
| Sentence length | 16–20 words, one idea each | Short sentences survive a quick read |
| Words | Everyday words. A technical term only with its meaning beside it | The reader may not be an expert |
| Comparison to something familiar | 1 sentence, and say where it stops being true | An unexplained mismatch leaves a wrong idea behind |

## The 3-Layer Explanation Pattern

Every explanation and every question has the same shape: **a 15-second summary, then show it, then detail only if needed.** Use it whenever you tell the user something or ask them something.

### Layer 1: The 15-second summary (always, always first)

Forty words or fewer. What is going on, what it means for them, and what you recommend or need. It must make sense with nothing else on the screen.

> "People can try passwords on your login page as fast as they like. Someone could guess a weak password in minutes. I recommend a short wait after 5 wrong tries. One small change."

### Layer 2: Show it (always)

A picture, a table, or a real example with real inputs and outputs. Pick whichever makes the point fastest, and prefer two short ones over a paragraph. Words here only connect the pieces.

> ```
> today:    wrong, wrong, wrong, wrong ... (no limit) ... right   → account opened
> proposed: wrong ×5 → wait 1 minute → wrong ×5 → wait 5 minutes  → guessing takes years
> ```
>
> | Who | What they notice |
> |---|---|
> | A normal user who mistypes twice | Nothing |
> | A user who forgot their password | A one-minute wait after the fifth try |
> | Someone guessing passwords | Stopped |

**Use a scenario** whenever the point is "what happens when": name the person, the moment and the result. "Sam taps Pay with $0 left → today the app spins forever → after this change Sam sees 'not enough balance'."

### Layer 3: Detail (only when needed)

How it works underneath. Include it when the decision is costly to undo, when there is more than one sound way to build it, or when the user asks. Start it with a plain signal such as "How it works underneath:" so a reader who does not need it can stop.

> How it works underneath: the count of wrong tries can be kept in the app's memory (simple, forgotten when the app restarts) or in a shared store (survives restarts, one more thing to run).

### When to Skip Layers

- **Something the user already knows or just said:** Layer 1 only.
- **Cheap to undo:** Layers 1–2.
- **Costly to undo, or truly several ways to go:** all three.

Never skip Layer 1, and never put it anywhere but the top.

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

Example (summary first, then show it, then the ask):

> **Chat text:** Your sign-in cookie can be sent along by other websites. That lets a bad site act as a signed-in user. Your own project rules already forbid it. I recommend the strict setting: one line, and nothing of yours depends on the loose one.
>
> | Setting | A link from another site | Risk |
> |---|---|---|
> | Today (not set) | Signed in | Other sites can act as the user |
> | Strict (recommended) | Asked to sign in again | None from other sites |
> | Lax | Signed in for plain links only | Small |
>
> **AskUserQuestion:** "How strict should the sign-in cookie be?
>
> 1. Strict (Recommended): safest; a link from another site asks the user to sign in again
> 2. Lax: links from other sites keep working
> 3. Leave as it is: tracked as a follow-up"

## Tone

- **First person.** "I found..." / "I recommend..." — not "It was found..." or "The analysis shows..."
- **Plain and short.** Everyday words, one idea per sentence. If a sentence needs a second read, split it.
- **Show, don't tell.** Put the number, the example or the picture in the message. Do not send the user to look it up.
- **A colleague, not a report.** Talk the way you would across a table.
- **Honest about what you do not know.** "I can't tell yet whether this will be slow with ten thousand records. Want me to try it first?"

## Interim Communication: Quiet by Default

Between user-input gates, Shipyard works **quietly**. The default is silence: run the tools, do the analysis, advance the state — without narrating it. The user asked for a colleague who reports progress in one line and speaks up when a decision is needed, not one who thinks out loud. This is **not** true silence (the user is never left wondering whether anything is happening) — it is the absence of *commentary between* the one-line markers below.

**While it works, Shipyard says almost nothing.** No thinking out loud, no step-by-step account, no report each time a helper finishes. The user reads a line when something changed that they would want to know, and a full explanation when a decision is theirs.

Exactly three things reach the chat outside a user-input gate:

1. **The progress line: a few words and a small visual, on one line.** When crossing a major boundary (a phase, a pipeline stage, a wave) emit ONE line: eight words or fewer saying what just happened, then a bar, a count or badges that show where things stand. Never a sentence of explanation, never two lines.
   ```
   Wave 2 merged            [████████░░░░] 6/9 steps   ✅ 6  🔄 2  🚫 1
   Reviews done             [█████] 5/5 stories        2 fixes added
   Research back            3 findings   ⚠ 1 needs you
   ```
   Per boundary, not per tool call and not per helper.
2. **Compact status blocks at a gate.** Badge lists, sparklines and the wave timeline below, when a decision or a summary follows. Compact by construction.
3. **Dispatch banners for long-running background work.** ONE line when launching a background dispatch that would otherwise be silent for minutes (`→ Dispatched design deep-dive … usually 1–3 min`), and ONE line when it returns (`→ Deep-dive back: 3 findings, 1 data-model risk`). A silent long dispatch reads as frozen — this is load-bearing anti-silence — but it is one line each, never a running account of what the dispatch is doing.

Everything else waits for a gate. **Findings, diagrams, analysis, and reasoning are rendered in full ONLY when they feed an imminent AskUserQuestion (the render-before-ask rule in `question-design.md`) or a final gate / approval summary.** A research write-up, a viability read, an impact map, a quality-gate pass, a critic reconciliation that does NOT immediately precede a user decision collapses to a **one-line result**; the detail folds into the eventual gate summary. Reading a file or receiving a subagent's return puts it in YOUR context — that is not a reason to re-emit it to the user unless a decision is riding on it right now.

**A helper finishing is not a boundary.** One builder or reviewer returning is not news; do not print a line for it. Say it once per boundary: "wave 2 merged, 7 of 7 steps", "all 5 stories reviewed, 2 fix steps added". The progress bar carries the rest.

**No running commentary.** Do not announce a step before doing it ("Now I'll…", "Let me analyze…", "I'm going to check…"), do not explain the rationale for a step that needs no user input, do not restate what a stage does before running it, and do not re-narrate what a tool result already showed. If nothing needs a decision and no boundary was crossed, say nothing — do the work and move on.

**Subagent and capability-skill returns are internal by default.** A registered agent's final reply is a machine contract, not a user-facing progress note. Agents return only their required `STATUS:` block and fields, with no preamble, epilogue, apology, "here's what I did", or freeform explanation outside named fields such as `REASON:`, `LAST_LINES:`, `TLDR:`, `TRACK_NOTES:`, or structured findings. Orchestrator skills parse those fields and surface only one of: a gate summary, a blocker that needs a decision, a terminal summary, or the compact boundary marker. Never paste a subagent's commentary into chat just because the Agent tool returned it.

This does NOT loosen render-before-ask. At a user-input gate, render fully — that is exactly the "explaining when a decision is needed is justified" the user wants. Quiet-by-default governs the space *between* gates; render-before-ask governs the moment *at* a gate. They are complements: quiet in the corridors, full light in the rooms where the user decides.

## Ask vs Assume

Not every decision is a question. Before composing any AskUserQuestion, run the **confidence gate** in `question-design.md`: a decision where the evidence converges (codebase, spec/constitution, industry practice all point the same way) AND the choice is a two-way door (cheap to reverse) is **decided and informed in one line**, not asked — "Going with X — [≤10-word why]. (say 'change' to override)" — and logged as `ASSUMED:` in the Decision Log. Only genuinely uncertain calls (evidence conflicts, user-value judgment, or one-way doors) reach the user. This keeps the number of cards low and respects the person's time: a trusted default beats a question they'd answer the obvious way. The full gate, ten-rule rulebook, and kill-list live in `question-design.md` — that file is the authority for everything user-facing; this file governs how the messages that DO get sent are shaped.

## Batching Open Items

When multiple items need resolution (assumption audit, edge cases, impact analysis):

- **One question per card, written in the chat first.** Explain it (summary, then show it), state the question in one sentence, then call the tool for that question alone. Then the next one.
- **Keep the count low.** Decide what you can decide; at most 3–4 questions in a round. With 8 small items of the same kind, show them as one table in chat and ask a single question: "apply all recommendations / go through them one by one".
- For each item: what I found → why it matters → what I recommend.
- Offer bulk resolution: "Addressed / Deferred / Not relevant" for each, or "Apply all recommendations."

## Visual Communication

Text explains *what something means*. Visuals show *what the shape is*. Use both together — visuals to orient, text to inform.

### When to Use Visuals vs Text

| Use Visual When... | Pattern |
|---|---|
| Showing progress or proportion | Progress bar: `[████████░░░░] 65%` |
| Showing relationships or dependencies | DAG with arrows: `P001 ─▶ P003 ─▶ P007` |
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
  /ship-discuss <anything>  → the ceremony ladder proposes a lane
  ├── production incident?  → hotfix   (/ship-execute --hotfix S###)
  ├── tiny, clear, low-risk → land-now (/ship-execute --task T###)
  ├── small and vague       → capture  (IDEA-###)
  └── otherwise             → refine   (story S###, then /ship-sprint)
```

**Impact diagrams** — for showing ripple effects:
```
  S007 (new) ──impacts──▶ S003 (criteria change)
             ──depends──▶ S001 (must be done first)
             ──overlaps─▶ S005 (shared data model)
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
