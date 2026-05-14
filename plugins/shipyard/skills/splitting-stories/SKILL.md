---
name: splitting-stories
description: Split a story or task into smaller pieces.
disable-model-invocation: true
---

# Splitting Stories

A feature or task that is too big does not get smaller by being given a smaller estimate — it gets smaller by being **split into independently valuable pieces**. The default failure mode for an LLM orchestrator is to split horizontally (UI / API / DB as separate stories), which produces tasks that are technically smaller but none of which is independently demoable. This skill exists to force vertical slicing.

The output is **a list of split candidates**, not opinions — concrete child stories/tasks each with a one-line user-observable outcome and the splitting pattern that produced it.

## When to Invoke

| Caller | Trigger |
|---|---|
| `/ship-discuss` Phase 2 (Viability Gate) | When the SPLIT signal fires ("multiple stories in a trench coat") or BUILDABLE/SIZED fails on size grounds |
| `/ship-discuss` Phase 1.5b challenge | When the user describes a feature whose acceptance criteria already exceed what fits in one sprint |
| `/ship-sprint` Stage 3 (task decomposition) | When a behavior draft fails the "and" test or any of the 11 patterns fires |
| `/ship-sprint` Stage 5 (effort) | When a task is estimated `effort: L` and the L-confirmation checklist is uncertain |
| Manual / ad-hoc | When the user says "this feels too big" |

Skip for trivial inputs (single AC, single touchpoint, S effort with one obvious Red step). The splitting overhead exceeds value.

## Inputs

- `story_text` — the feature/task draft to split (markdown). May be a `/ship-discuss` draft, an existing feature spec, or a task draft from `/ship-sprint` Stage 1.
- `acceptance_criteria` — the AC list for the input, if separate from the draft.
- `level` — `feature` (splitting a story into smaller stories) or `task` (splitting a task into smaller tasks). Default `task`.
- `domain_hints` — optional list of domain tags (`["payments", "auth", "external-api", "ui"]`) that bias which patterns fire first.
- `data_dir` — for reading `<SHIPYARD_DATA>/codebase-context.md` to ground splits in the actual stack.

## Step 0: INVEST Gate

Run before attempting to split. Check the input against INVEST minus Small:

- **Valuable** — does the story have a clear user-observable outcome? If no, **do not split** — return one finding `{ "action": "rescope", "reason": "no observable user value to split into smaller observable outcomes" }`. Splitting an unvaluable story produces unvaluable smaller stories.
- **Independent** — can it be prioritized on its own? If no (it's a sub-step of something else), the split candidates inherit the same dependency — flag it.
- **Negotiable** — is there room for design conversation? If the input is already over-specified down to implementation detail, a split may just be re-arranging the implementation rather than scope.
- **Estimable** — does the team know roughly what's involved? If no, the right output is a `Spike` (Pattern 9), not a normal split.
- **Testable** — can each resulting child have a clear done-condition? Every split candidate output must satisfy this.

## Step 1: The "And" Test

Apply before running the patterns. Any draft whose title or description contains `and` connecting two **independent** behaviors is a mandatory split.

**Split:**
- "Create user **and** send welcome email" → 2 children
- "Add migration **and** update API response shape" → 2 children
- "Implement search **and** add caching" → 2 children (Pattern 7 also fires)

**Do not split:**
- "Create record **and** return ID" — one atomic operation
- "Parse request **and** validate schema" — one guard at one boundary
- "Find **and** update" — one read-modify-write on the same record

The test: would these two clauses produce two separate failing tests? If yes, split.

## Step 2: Run the 11 Splitting Patterns

Apply in order. For each draft, walk the patterns; the first one that fires produces a split. Re-run from the top on each resulting child until no pattern fires.

**Read the catalogue:** `${CLAUDE_PLUGIN_ROOT}/skills/splitting-stories/references/patterns.md` for trigger phrases, signal words, examples, and stack-specific notes for each pattern.

Summary (pattern → trigger → split-by):

1. **Workflow Steps** — sequential process verbs ("then", "after", "followed by") → split per step; build thin end-to-end happy path first, fill middle steps after.
2. **CRUD Operations** — "manage X", multiple data verbs on one entity → split per verb (Create / Read / Update / Delete).
3. **Business Rule Variations** — "if premium…", "unless admin…", "when overdue…" → happy path first, each rule as a follow-on.
4. **Data Variations** — multiple data types/formats/sources in one pass → simplest/most-common type first; additional types as follow-ons.
5. **Interface vs. Functionality** — UI complexity bundled with backend behavior → backend (API/service) first, UI rendering on top.
6. **Happy Path vs. Edge Cases** — "and handle errors", "and validate", AC mixes success and failure → happy path first, error/validation/timeout branches as follow-ons.
7. **Make-it-Work vs. Make-it-Fast** — caching, optimization, performance, throughput keywords → correctness first, performance as follow-on. **Mandatory** — premature optimization breaks the Red step (no failing perf test before behavior exists).
8. **Major Effort (Infrastructure-Dominant)** — "set up", "integrate", "configure", "install" leads the description → infrastructure as foundation, behavior on top in a later wave.
9. **Simple vs. Complex** — a small core behavior surrounded by variations → extract the core, push variations into separate stories. Lawrence's selection-rule pairs well here: prefer the split that exposes the lowest-value variation.
10. **Paths (SPIDR)** — multiple user routes accomplishing the same goal → one path per child; ship the most-used path first.
11. **Spike (last resort)** — implementation approach is genuinely unknown, no codebase pattern to follow → time-boxed `kind: research` task first, `kind: feature` after, informed by findings.

A 12th category exists for `level: feature` only — **Hypothesis-Driven** splitting: when the parent is itself a bet ("we believe users want X"), produce a thin slice that tests the riskiest assumption. Use this when the discuss-phase research surfaced low-confidence assumptions that should be validated before building the full surface.

## Step 3: Reject Horizontal Slices Structurally

After producing candidate children, check each one with this single question:

> Does this child, on its own, produce a user-observable outcome that the user can demo or that an end-to-end test can assert on?

If the answer is no, the split is horizontal (sliced by architectural layer — UI / API / DB / migration as separate children) and **must be rejected**. Common shapes of horizontal slices to detect:

- Children titled "add database migration", "add API endpoint", "add UI component" with no behavior in any single one
- Children whose acceptance criteria are "the migration runs" or "the endpoint returns 200" without a user-facing assertion
- Children that only become demoable when the whole set lands together

Repair: re-split using a vertical pattern from Step 2. The walking-skeleton foundation task (Stage 2 of `/ship-sprint`) is the **one exception** — it is explicitly horizontal (schema + routes + types + stubs across all layers, no behavior) and lives in Wave 1 by itself precisely so every behavior task on top of it can be vertical. Outside of that, no horizontal children.

## Step 4: Selection Tiebreaker

If multiple valid splits are possible (e.g., the same draft could split by CRUD or by user role), prefer the split that:

1. **Exposes a low-value child** — the child the user can deprioritize or cut. Lawrence's rule: a split is most valuable when it makes scope-cutting possible, not just sequencing.
2. **Produces roughly equal-sized children** — avoid one giant child + several slivers; that usually means the slivers are horizontal disguise.
3. **Reduces cross-child dependencies** — same-wave dependencies indicate a missed foundation task; redo Stage 2.

If no split satisfies (1) or (2), the input may be one cohesive piece of work — return `{ "action": "no-split", "reason": "..." }` rather than forcing a split.

## Step 5: Cynefin Sensitivity

Adjust depth based on domain context (read `<SHIPYARD_DATA>/codebase-context.md` and any feature `complexity:` frontmatter):

- **Obvious** — find all children, prioritize by value, ship.
- **Complicated** — find all children, prioritize by value/risk; expect re-splitting after the first lands.
- **Complex** — do **not** try to enumerate all children. Produce 1–2 thin slices, ship, learn, then split the rest based on what was observed. Mark output `partial: true`.
- **Chaotic** — refuse to split; recommend stabilization first. Return `{ "action": "stabilize-first", ... }`.

## Output Shape

Return a structured split list. Each candidate:

```
{
  "id": "child-1" | "child-2" | ...,
  "title": "<one-line user-observable outcome>",
  "pattern": "workflow" | "crud" | "rules" | "data" | "interface"
           | "happy-vs-edge" | "perf" | "major-effort" | "simple-complex"
           | "paths" | "spike" | "hypothesis",
  "acceptance_hint": "<one-line testable done condition — basis for the Red step>",
  "depends_on": ["child-N", ...],
  "deferrable": true | false,
  "rationale": "<why this is a vertical slice, not a horizontal one>"
}
```

Wrap with metadata:

```
{
  "input_passed_invest": true | false,
  "invest_failures": ["valuable", "estimable", ...],
  "patterns_tried": ["and-test", "workflow", "crud", ...],
  "patterns_fired": ["crud", "happy-vs-edge"],
  "horizontal_rejections": [<repaired children>],
  "partial": false | true,
  "candidates": [ <child objects> ],
  "selection_notes": "<why this split over alternatives, per Step 4>"
}
```

## Output Discipline

1. **Vertical only.** Every candidate must independently produce a user-observable outcome (or be the explicit walking-skeleton foundation task). Reject and repair horizontal candidates before returning.
2. **Concrete titles.** "Submit maintenance request and store it" beats "Implement submission". A reader should be able to write the Red step from the title alone.
3. **No padding.** If only one pattern fires, return only the children that pattern produces — don't manufacture variants from other patterns to look thorough.
4. **Cite the pattern.** Every candidate has exactly one `pattern` field naming the rule that produced it. If "multiple patterns fired", split twice and re-run.
5. **Honor `partial: true` in complex domains.** Two thin slices with `partial: true` is a better answer than seven speculative ones.

The test of a good output: a reader can take each candidate, write its Red step, and start building — without re-reasoning whether the candidate is independently valuable.

## Read-Only Contract

This skill produces a split plan; it does not edit feature/task files. The calling command skill creates the resulting feature/task files (with their own probe authoring, Technical Notes, and frontmatter). Do not Write to the spec or task tree directly.

## Pairing With Other Skills

- **`extracting-acceptance-criteria`** — the input AC list often comes from this skill. After splitting, each child gets its own AC subset.
- **`discovering-edge-cases`** — runs alongside on the parent, then again on individual children once split. Edge cases discovered on a child often justify Pattern 6 (Happy Path vs. Edge Cases) splits.
- **`authoring-acceptance-probe`** — runs on each `kind: feature` child after split, deriving the smoke command from the child's `acceptance_hint`.
- **`/ship-sprint` Stage 2 (walking skeleton)** — the one sanctioned horizontal task. Splitting-stories' horizontal-rejection rule explicitly excepts it.
- **`/ship-discuss` Phase 2 viability** — when SPLIT fires, this skill produces the candidate decomposition the user picks from.

## Bottom Line

- INVEST gate first; reject the input if it isn't valuable or estimable, don't waste pattern walks on it.
- 11 patterns + the "and" test, applied in order, until none fires on any child.
- Horizontal slices are the default LLM failure mode — a structural rejection step makes the failure visible and forces a vertical re-split.
- Cynefin and the low-value-exposure tiebreaker prevent over-splitting and pick the most useful split when multiple are valid.
- Output is concrete child stories/tasks with cited patterns and acceptance hints — testable, actionable, non-speculative.
