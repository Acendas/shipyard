# Splitting Patterns — Catalogue

Detail for the 11 patterns walked in `splitting-stories` Step 2. Read before splitting; the SKILL body lists the patterns by name but the trigger phrases and stack-specific hints live here.

The patterns are ordered by how often they fire on real software work. Walk top-to-bottom; first hit splits.

---

## 1. Workflow Steps

**Trigger:** the draft involves a sequence of distinct process verbs.

**Signal phrases:** "then", "after which", "followed by", "once X is done", multiple sequential verbs in one sentence, numbered process steps.

**Split by:** each step becomes its own child. Build the simplest end-to-end happy path first (steps 1 → N with no branching), add middle steps and special cases as follow-ons.

**Example:** "Submit maintenance request → notify admin → admin reviews → mark resolved" → at minimum 3 children: submit + store, notification dispatch, admin review + status transition.

**Anti-failure note:** the most common slop here is splitting the workflow but having the second child depend on data the first child didn't actually persist. Each child must own its own persistence.

---

## 2. CRUD Operations

**Trigger:** the draft uses "manage", "administer", "handle", or implicitly covers multiple data verbs on the same entity.

**Signal phrases:** "manage [entity]", "CRUD for X", "let admin work with X", multiple verbs (create/list/edit/delete/archive/duplicate) on one noun.

**Split by:** verb. Create / Read (list and detail are often separate) / Update / Delete each become their own child.

**Example:** "Manage tenant profiles" → Create profile + List profiles + View profile + Edit profile + Deactivate profile (3–5 children).

**Rule:** never bundle two CRUD verbs in one child, even if the same screen shows them.

---

## 3. Business Rule Variations

**Trigger:** the draft has conditional logic on the same base behavior.

**Signal phrases:** "if premium…", "unless admin…", "when overdue…", "for trials…", "based on [role/plan/region]".

**Split by:** happy path (base behavior, no rules) first, then each rule variation as a follow-on. Lawrence's selection rule applies — prefer surfacing rules that turn out to be cuttable.

**Example:** "Calculate rent with late fees, discounts, and proration" → Calculate base rent + Apply late fee + Apply discount + Handle proration (4 children).

---

## 4. Data Variations

**Trigger:** the draft handles multiple data types, formats, or sources in a single pass.

**Signal phrases:** "supports PDF, Word, images, …", "any of these formats", "for both X and Y data", "accepts CSV or JSON", multi-currency, multi-locale, multi-tenant data shapes.

**Split by:** simplest and most common shape first; additional shapes as follow-ons.

**Example:** "Accept document uploads (PDF, Word, images, spreadsheets)" → Accept PDF → add Word → add images → add spreadsheets. Ship PDF first.

---

## 5. Interface vs. Functionality

**Trigger:** the draft bundles UI complexity with backend behavior.

**Signal phrases:** "search with autocomplete", "form with live validation", "table with inline editing and bulk actions".

**Split by:** backend behavior (API / service layer) first; UI rendering on top. The first child is testable via API; the second adds the UI affordance.

**Example:** "Search maintenance requests with autocomplete dropdown" → Search API + results page, then autocomplete widget as a separate child.

**Note:** does not contradict vertical slicing — both halves remain user-observable (the API child is demoable via curl/Postman; the UI child adds the visible affordance). What's prohibited is splitting *just* the API and *just* the UI when neither is observable on its own.

---

## 6. Happy Path vs. Edge Cases

**Trigger:** the draft mixes success and failure scenarios.

**Signal phrases:** "and handle errors", "and validate", "including edge cases", "with retry logic", AC list includes both success and failure cases.

**Split by:** happy path (success scenario) as one child; error handling / validation / failure branches as follow-ons. Each follow-on names the specific failure mode (declined card, network timeout, malformed input).

**Example:** "Process payment and handle declined cards and network timeouts" → Successful payment + Declined card handling + Timeout/retry logic (3 children).

**Tie-in with `discovering-edge-cases`:** when that skill surfaces edge cases the spec didn't cover, this pattern is how they become their own children rather than bloating the parent.

---

## 7. Make-it-Work vs. Make-it-Fast

**Trigger:** the draft mentions caching, optimization, performance, scalability, throughput, or indexing.

**Signal phrases:** "fast", "optimized", "with caching", "scalable", "low-latency", "high-throughput", "indexed".

**Split by:** correctness-first implementation as one child; performance optimization as a follow-on.

**Example:** "Fast property search with query caching" → Property search (correct results) + Add search result caching (2 children).

**Mandatory.** Any draft mentioning performance/caching/optimization splits — no exceptions. Reason: premature optimization inside a feature task violates the TDD Red step (you can't write a failing perf test before the behavior exists). The performance child gets its own perf assertion as its Red step.

---

## 8. Major Effort (Infrastructure-Dominant)

**Trigger:** more than half the draft is infrastructure / setup, not behavior.

**Signal phrases:** the draft *leads* with "set up", "integrate", "configure", "install", "wire up", "scaffold".

**Split by:** infrastructure setup as the walking-skeleton foundation child (Wave 1 in `/ship-sprint`); behavior on top in Wave 2+.

**Example:** "Integrate Stripe SDK and implement checkout flow" → Stripe SDK setup + Checkout flow (2 children, different waves).

**Cross-reference:** the foundation child is the **one sanctioned horizontal slice** in the system — see `splitting-stories` Step 3. Outside of foundation, horizontal is rejected.

---

## 9. Simple vs. Complex

**Trigger:** a small core behavior surrounded by variations, exceptions, or polish.

**Signal phrases:** "with all the bells and whistles", "for all cases", "covering both X and Y", a draft whose scope balloons because of "while we're at it".

**Split by:** extract the core behavior as one child; push each variation/exception into its own follow-on. Apply Lawrence's selection rule: the split's value comes from making the variations cuttable, not from sequencing them.

**Example:** "Notification system supporting email, SMS, push, in-app, and Slack" → core in-app notification + add email + add SMS + add push + add Slack (5 children, the last 3 are likely cuttable).

---

## 10. Paths (SPIDR)

**Trigger:** multiple user routes accomplishing the same goal.

**Signal phrases:** "users can do this via X or Y", "supports both [path A] and [path B]".

**Split by:** one path per child. Ship the most-used path first; other paths as follow-ons.

**Example:** "Share video via direct link, social media, or embed code" → Direct link share + Social media share + Embed code (3 children).

---

## 11. Spike (Last Resort)

**Trigger:** the implementation approach is genuinely unknown — no codebase pattern to follow, no clear library choice, no precedent.

**Signal phrases:** "we'll need to figure out…", "depends on whether we can…", "research X first".

**Split by:** time-boxed `kind: research` child first (produces a findings doc); `kind: feature` child after, informed by findings.

**Apply as last resort.** If the Knowledge Gap Assessment in `/ship-sprint` Step 3.6 ran properly, spikes should already be caught earlier. A spike at decomposition time means the gap was missed — note it in the sprint risk register.

---

## 12. Hypothesis-Driven (feature-level only)

**Trigger:** the parent itself is a bet — "we believe users want X" — and the discuss-phase research surfaced low-confidence assumptions that should be validated before building the full surface.

**Signal phrases:** "we think users will…", "this assumes…", "this depends on user behavior we haven't measured".

**Split by:** one thin slice that tests the riskiest assumption (often a measurement-only or single-flow MVP), then a follow-on feature for the full surface conditional on the slice's signal.

**Apply only at `level: feature`.** Tasks aren't bets — they're work — so this pattern doesn't fire at task level.

---

## The "And" Test (applied first, before all 11 patterns)

Any draft whose title or description contains `and` connecting two **independent** behaviors is a mandatory split candidate.

**Split:**
- "Create user **and** send welcome email" — two boundaries, two failure tests
- "Add migration **and** update API response shape" — two layers, two commits' worth
- "Implement search **and** add caching" — Pattern 7 also fires
- "Store payment **and** emit event to billing queue" — two systems

**Do not split:**
- "Create record **and** return ID" — one atomic database op
- "Parse request **and** validate schema" — one guard at one boundary
- "Find **and** update" — one read-modify-write on one record

The test: would these two clauses produce two separate failing tests? If yes, split.

---

## Selection Rules When Multiple Patterns Fire

Often more than one pattern fires on the same draft. Pick deliberately:

1. **Prefer the split that exposes the lowest-value child.** That child can be deprioritized or cut, which is the highest-leverage outcome of splitting. (Richard Lawrence's rule.)
2. **Prefer the split that produces roughly equal-sized children.** One giant child + slivers usually means the slivers are horizontal in disguise.
3. **Prefer the split that reduces cross-child dependencies.** If two children must land in the same wave because they depend on each other, a foundation task is missing — extract it (Pattern 8) and re-split.
4. **Cite the chosen pattern in the candidate's `pattern` field.** If multiple were tied, document the tiebreaker in `selection_notes` at the top level.

If multiple patterns fired and the tiebreaker doesn't pick a clear winner, split twice (once per pattern) and re-run the patterns from the top on the resulting grandchildren.

---

## Stack-Specific Notes

A few stacks have characteristic splitting traps. Read these before splitting if `domain_hints` includes the relevant tag.

- **`payments` / `billing`:** Pattern 7 (perf) almost never fires here; Pattern 6 (happy vs. edge) almost always does — declined cards, partial captures, idempotency-key collisions, refund flow are each their own child. Never bundle authorize + capture + refund in one child.
- **`auth`:** Pattern 3 (rules) fires on permission variations (admin / member / viewer). Pattern 6 fires on session expiry, MFA fallback, account lockout. The happy "log in" and "log out" paths are separate children.
- **`ai-llm`:** Pattern 11 (spike) fires often — prompt design and model choice are research before code. Pattern 6 fires on hallucination handling, prompt-injection guards, cost-cap behavior.
- **`migrations` / `schema`:** Pattern 8 fires by definition — the migration is the foundation task; the behavior using new columns is a separate child. Bundling them produces a child that "succeeds" by running the migration without anything actually using the new columns.
- **`ui-only` features:** Pattern 5 doesn't fire (no backend half). Pattern 1 (workflow steps) and Pattern 6 (validation/error states) fire most often.

---

## Anti-Patterns

What this skill must **not** produce:

- **Horizontal slices** — children sliced by architectural layer (UI / API / DB) where no single child is independently demoable. Detected and rejected in `splitting-stories` Step 3. The walking-skeleton foundation is the only exception.
- **One-step-at-a-time chains** — children sequenced through a workflow where nothing is demoable until the last child lands. Repair: build the thinnest end-to-end happy path first, then thicken.
- **Pre-enumerating every child in a complex domain** — if the parent's `complexity:` frontmatter is `complex`, return at most 2 children with `partial: true`. Don't fake certainty.
- **Splits driven by sprint capacity** — if every child lands a sliver with no observable user change, it's a horizontal slice with extra steps. Re-split vertically.
- **Splits that drop value silently** — if a child "covers performance" but the parent never lands a follow-on, the perf concern is lost. Only split out perf/edge-cases when the team will actually do the follow-on; otherwise keep them in the parent and accept the larger size.
