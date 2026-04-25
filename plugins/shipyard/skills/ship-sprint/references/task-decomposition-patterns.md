# Task Decomposition Patterns

Reference for Step 4 of `/ship-sprint`. Read before decomposing any feature — the protocol in SKILL.md refers to sections here by name.

## Why this reference exists

"Break into atomic tasks" is an aspiration, not a protocol. Without named patterns and a forcing function, an LLM orchestrator decomposes top-down (thinking in features and waves) and naturally lands at a granularity too coarse for the builder. This reference gives the concrete patterns that fire before a task file is written, ensuring splits happen at the right moment.

---

## Stage 2: Walking Skeleton — What to Extract

A walking skeleton is the thinnest end-to-end connection that proves all layers communicate. Before any behavior task, identify what must exist for any behavior to be testable:

**Extract these into a Wave 1 foundation task:**
- Database schema changes (new tables, columns, indexes, migrations)
- New route registrations (the route exists, returns 501 or stub)
- New type / interface / enum definitions
- Service or module stubs (files with correct signatures, empty bodies)
- Dependency injection wiring
- Config entries that are read at startup

**Foundation task template:**
```yaml
id: T001
title: "[Feature name] foundation — schema, routes, types"
feature: F0NN
kind: feature
effort: S
dependencies: []
status: approved
```

Technical Notes for a foundation task describe the exact files to create/modify, the schema, and the stub signatures — but do NOT implement behavior. The builder creates empty-but-wired infrastructure. Later tasks fill in behavior.

**When to skip Stage 2:** If the feature has no cross-layer infrastructure needs — a pure UI wording change, adding a constant, modifying a single isolated function — skip the foundation task. Behavior tasks go in Wave 1 directly.

**Anti-pattern:** Including any behavior in the foundation task. "Create the user table and implement user creation" = two tasks. The walking skeleton walks; it does not run.

---

## Stage 3: The 9 Splitting Patterns

For each behavior draft from Stage 1, apply these patterns in order. If any fires, split before writing the task file. Re-evaluate each resulting draft — one draft may need multiple passes.

### Pattern 1: Workflow Steps
**Trigger:** The task involves a sequence of distinct process steps.
**Split by:** Each step becomes its own task. Build the simplest end-to-end case first (steps 1 → N with no branching), then add middle steps and special cases as follow-on tasks.
**Example:** "Submit maintenance request → notify admin → admin reviews → mark resolved" = at minimum 3 tasks: submit + store, notification dispatch, admin review + status transition.
**Signal phrase:** "then", "after which", "followed by", multiple sequential verbs.

### Pattern 2: CRUD Operations
**Trigger:** The task uses "manage", or implicitly covers multiple data operations on the same entity.
**Split by:** Verb — create, read (list + detail are often separate), update, delete are each their own task.
**Example:** "Manage tenant profiles" = Create profile + View profile + Edit profile + Delete/deactivate profile (3–4 tasks).
**Rule:** Never bundle two CRUD verbs into one task, even if the UI shows them together.

### Pattern 3: Business Rule Variations
**Trigger:** The task has conditional logic applied to the same base behavior ("if premium user...", "unless admin...", "when overdue...").
**Split by:** Happy path first (base behavior, no rules), then each rule variation as a follow-on task.
**Example:** "Calculate rent with late fees, discounts, and proration" = Calculate base rent + Apply late fee logic + Apply discount logic + Handle proration (4 tasks, each with one rule).

### Pattern 4: Data Variations
**Trigger:** The task handles multiple data types, formats, or sources in a single pass.
**Split by:** Simplest / most common data type first; additional types as follow-on tasks.
**Example:** "Accept document uploads (PDF, Word, images, spreadsheets)" = Accept PDF upload → add Word → add images → add spreadsheets. Ship PDF first; other formats are data variations.

### Pattern 5: Interface vs. Functionality
**Trigger:** The task bundles a UI component's complexity with backend behavior.
**Split by:** Backend behavior (API / service layer) first; UI rendering on top.
**Example:** "Search maintenance requests with autocomplete dropdown" = Search API + results list, then autocomplete widget as a separate task.

### Pattern 6: Happy Path vs. Edge Cases
**Trigger:** The task description contains "and handle errors", "and validate", "including edge cases", or acceptance criteria mix success and failure scenarios.
**Split by:** Happy path (success scenario) as one task; error handling / validation / failure branches as a follow-on task.
**Example:** "Process payment and handle declined cards and network timeouts" = Successful payment processing + Declined card handling + Timeout/retry logic (3 tasks).

### Pattern 7: Make-it-Work vs. Make-it-Fast
**Trigger:** The task mentions caching, optimization, performance, scalability, or throughput.
**Split by:** Correctness-first implementation as one task; performance optimization as a follow-on task.
**Example:** "Fast property search with query caching" = Property search (correct results) + Add search result caching (2 tasks).
**This pattern is mandatory.** Any task mentioning caching, performance, indexing, or optimization splits. No exceptions — premature optimization inside a feature task violates the TDD cycle's Red step (you can't write a failing performance test before implementing the feature).

### Pattern 8: Major Effort (Infrastructure-Dominant)
**Trigger:** More than half the task is infrastructure / setup, not behavior. The task description leads with "set up", "integrate", "configure", "install".
**Split by:** Infrastructure setup as Stage 2's foundation task (Wave 1), behavior on top in Wave 2+.
**Example:** "Integrate Stripe SDK and implement checkout flow" = Stripe SDK setup + Checkout flow (2 tasks, different waves).

### Pattern 9: Spike (Research Isolation)
**Trigger:** The implementation approach is genuinely unknown — not a preference, a true knowledge gap where no pattern exists in the codebase to follow.
**Split by:** Time-boxed `kind: research` task first (produces a findings doc); `kind: feature` implementation task after, informed by findings.
**Apply as last resort.** If research is needed, the Knowledge Gap Assessment in Step 3.6 (planning-checklists.md) should have caught it earlier. A spike at decomposition time means the gap was missed. Note it in the sprint risk register.

---

## The "And" Test

Apply before running the 9 patterns. Any task draft whose title or description contains "and" connecting two independent behaviors is a mandatory split candidate.

**Split:**
- "Create user **and** send welcome email" → 2 tasks
- "Add migration **and** update API response shape" → 2 tasks
- "Implement search **and** add caching" → 2 tasks (Pattern 7 also fires)
- "Store payment **and** emit event to billing queue" → 2 tasks

**Do not split:**
- "Create record **and** return ID" — one atomic database operation
- "Parse request **and** validate schema" — one guard at a single boundary
- "Find **and** update" — one read-modify-write on the same record

The test: would these two clauses produce two separate failing tests? If yes, split.

---

## Stage 4: The Red Step Forcing Function

Before writing any task file, complete this sentence:

> "The first failing test for this task is: `[specific assertion]`"

Write it into `## Technical Notes → First failing test:` in the task file. The builder reads it as the TDD cycle's starting point.

**Good Red steps** — each names one specific assertion:
- `POST /auth/refresh returns 200 with new access_token when given a valid refresh_token`
- `Organization.create() raises ValidationError when name is blank`
- `MaintenanceRequest#status transitions to "resolved" after AdminReview.approve() is called`
- `GET /properties returns only properties matching the search term in the title field`

**Bad Red steps — task needs splitting:**
- "Tests for the auth flow" → vague; what specific behavior?
- `POST /auth/refresh works **and** POST /auth/logout invalidates the session` → two assertions, two tasks
- "Unit tests and integration tests for the payment module" → scope is a module, not a behavior

**When the Red step is genuinely unknowable** (research gap, third-party API with unclear behavior), it signals a Spike (Pattern 9). Create the research task first; the Red step for the implementation task is written after findings are in.

---

## Stage 5: Adapted 8/80 Rule for Software Tasks

PMI's 8/80 rule defines work package size as 8–80 hours. Adapted for the TDD cycle on a solo dev or small team:

| Effort | Time range | When it applies |
|--------|-----------|----------------|
| **S** | 1–4 hours | One clear Red step, obvious implementation, pattern exists in codebase |
| **M** | 4–8 hours | Some exploration needed, bounded scope, pattern partially exists |
| **L** | 1–2 days | Significant implementation, but one coherent behavior, no splitting pattern fires |

**L-effort confirmation checklist** — answer all three before writing `effort: L`:
1. All 9 patterns checked, none fired?
2. Red step covers exactly one behavior?
3. Task touches one coherent area of the codebase?

If all three: L is justified. Write in Technical Notes: "L effort because: [reason — e.g., 'large but cohesive DB migration across 12 tables with no splitting pattern applicable']."

If any is uncertain: AskUserQuestion — *"This task is estimated L (1–2 days). Could it split into [specific suggestions]? (yes, split / no, it's cohesive)"*

**Hard ceiling:** No task exceeds L. A task that genuinely requires more than 2 days is a feature, not a task. Return it to `/ship-discuss` for re-specification as its own feature with its own acceptance criteria.

---

## INVEST Output Check

After all tasks are written, verify two INVEST criteria that catch remaining sizing errors:

**I — Independent:** No task in the same wave depends on another task in the same wave. Same-wave dependencies indicate a missing foundation task — return to Stage 2 and extract the shared dependency.

**T — Testable:** Every task has exactly one specific done-condition (one Red step). Multiple done-conditions or an ambiguous "done" means the task should split.

The other four INVEST criteria (Negotiable, Valuable, Estimable, Small) are enforced by the protocol stages above and need not be checked separately.
