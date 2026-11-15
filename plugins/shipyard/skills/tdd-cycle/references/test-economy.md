# Test economy: start from the behaviour, prove each one once

A test suite that grows with every task eventually costs more per feature than the feature. These rules keep the suite small and sharp without cutting assertions. They apply to the spec writer, every builder, fixer and patch step, and the code reviewer's `tests` concern enforces them.

## Start from the behaviour, not the code

- Each acceptance criterion is **one scenario**: `Given` (the starting state), `When` (what the user or the outside world does), `Then` (what someone outside the system can observe: a screen, a saved record, a message sent, money moved). A `Then` that names a function, a flag or an internal state is not a `Then`.
- **Map the paths first.** Before writing scenarios, list every path from the trigger to each way it can end (success, each refusal, each failure, each timeout). Every ending has a scenario, or a stated reason it cannot happen. The map is written in the story (`## Paths`), it is what the grouping is built from, and it is what the reviewer checks coverage against.
- **Spec and code never disagree quietly.** If they do, one of them is a bug, and both are fixed in the same change: the code, or the scenario's wording through the orchestrator (a builder returns `SPEC_FIX: <AC id>: <what the scenario should say and why>`; it never codes around a scenario it believes is wrong).

## One level per scenario, and the journey is the default

Each scenario carries one **level tag** next to its id, and its test is written at that level **and nowhere else**: not a unit test, a module test and a screen test all re-proving "insufficient funds".

| Tag | Use it for | Shape |
|---|---|---|
| `@e2e` (**default**) | every scenario, unless one of the two rows below applies | an end-to-end journey: the real code wired together, fakes only at the true edges (hardware, network, clock, a paid third party). The acceptance probe, a scenario file, a device run |
| `@component` | only a fault, race or timing the journey cannot stage | one real composed piece with its real collaborators |
| `@unit` | only a rule with many input values | one table, one row per value |

- A journey asserts every outcome channel **by value**, including what must not happen (no second charge, no refund, no extra packet), read from the boundary fake or the real store. Rendered output (a frame, a receipt, a ticket) is compared whole against a golden file.
- **A lower-level test earns its place only if breaking the behaviour turns it red and no journey already does.** A pure wiring task may ship with zero new lower-level tests.

## Banned

- Tests that only check "the port/collaborator was called" (interaction-only), dependency-injection or wiring tests, and coverage padding.
- A second test for a behaviour already proven at another level.
- **The delete test:** if deleting the production line would not turn the test red, the test does not get to exist. The builder's mutation check (break the line on purpose, watch red, restore) is this rule run by hand: break each outcome channel of a journey on purpose before shipping.

## Few tests, full assertions: group on setup

- Scenarios that share a `Given` live in one test: one grouped assertion block (`assertAll` / several `CHECK`s) when they share the `When`; one journey test when each step continues from the last; one table-driven test (one row per scenario) when the `When`s differ. Tests that differ only in values become one table, and when the spec has an `Examples:` table the test reads it rather than retyping it.
- Every `Then` / `And` line is checked by its actual value, as its own assertion labelled with its scenario id, so a failure names what broke.
- Rule of thumb: if every test function carries exactly one scenario tag, grouping has not happened yet.
- Shared pieces, not copies: doubles and builders with defaults from the project's test fixtures, nested groups instead of new files, virtual or fixed time instead of sleeping.

## Test first, from the spec

Write the test from the scenario's words, **before reading the code it will exercise**, and watch it fail for the right reason. Then write the least code that makes it pass. Then tidy up. A test written after reading the implementation proves what the code does, not what the spec promises.

## Every scenario has a test, every test has a scenario

Tag each test with its scenario id (`AC-<n>`, as a comment or the tag itself). `shipyard-data verify-ac-coverage` checks both directions on the sprint diff: a tagged scenario with no marker is an orphan scenario, and a test file changed in the sprint that carries no scenario id is an orphan test. A test with a real reason to have no scenario says so on a line: `no-scenario: <reason>`.

## Migrate as you touch

When a task touches a feature whose tests predate this rule set, migrate that feature's tests to this shape **in the same change** (group, drop the duplicates, add the level tags). Never widen a band, loosen a check or delete a failing test to get green: that is a different rule and it still holds.

## For the reviewer (`tests` concern)

Flag, with the scenario id: an ending in the path map with no scenario and no reason; a `Then` nobody outside the system could observe; a lower-level test where the journey could stage it; a behaviour proven at two levels; an interaction-only or wiring test; a test with no scenario tag; a test the delete test would not catch; a journey that asserts only the happy channel; ungrouped scenarios sharing a `Given`; code and scenario that disagree; a touched feature left unmigrated. Count ungrouped and duplicate tests in the verdict so the trend can only shrink (a ratchet).
