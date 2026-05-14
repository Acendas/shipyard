---
name: authoring-acceptance-probe
description: Author a runnable acceptance probe from criteria.
disable-model-invocation: true
---

# Authoring an Acceptance Probe

A probe is the smoke-test contract that proves wiring works end-to-end. Without one, a task cannot be dispatched in 2.0 — `dispatching-task-loop` refuses to run a task whose `acceptance_probe:` is missing or empty. So **authoring the probe is part of authoring the task**, not an optional polish step.

## When This Applies

- During `/ship-sprint` Step 3 (task decomposition), as you write each task file.
- During `/ship-quick` scoping, before dispatching the change.
- During `/ship-bug` fix authoring — the probe is the regression scenario.
- During `/ship-discuss` *only* if the discussion produces a task spec ready to enter the backlog with a probe.

If a task is genuinely too speculative to author a probe for, that task isn't ready for execution. Either refine until it is, or mark it `kind: research` (no probe needed; deliverable is a findings doc).

## The Authoring Question

Ask exactly this:

> **"What single shell command, run from a clean state against the merged change, would print observable evidence that the wiring works?"**

If you cannot answer that question in one sentence, the acceptance criteria are too vague. Refine the criteria first, then return.

## Source Material

A probe is *derived* from:

1. **Acceptance criteria** in the task file's `## Acceptance Criteria` section. Each AC describes an observable outcome; the probe demonstrates at least one of them happens.
2. **Technical Notes** in the parent feature file. These often spell out the exact endpoints, function signatures, table columns, or CLI flags involved.
3. **`config.md` test commands** — for the scoped test pattern that proves a unit slice ran. Useful only when paired with a wiring check, not as a probe by itself.

If the AC is "the new endpoint returns 201 with the created user's ID", the probe is the curl that proves it. If the AC is "the migration adds column X to table Y", the probe is a SQL query against `information_schema`.

## Probe Patterns by Task Shape

### HTTP / REST endpoint
```
curl -fsS -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"probe","email":"p@p.io"}' | jq -e '.id and .name == "probe"'
```
Exit 0 only when the response has `id` and `name == "probe"`. `-f` makes curl exit non-zero on HTTP error. `-S` shows errors. `jq -e` exits non-zero on false.

### CLI subcommand
```
node bin/mytool.mjs new-subcommand --help | grep -q "synopsis line text"
# OR, if it does work:
node bin/mytool.mjs new-subcommand --dry-run input.txt | grep -q "expected output marker"
```

### Library / module export
```
node -e 'const m = require("./dist/index.js"); if (typeof m.newFn !== "function") process.exit(1); const r = m.newFn(42); if (r !== 84) process.exit(1); console.log("OK:", r);'
```

### Database migration
```
psql "$DATABASE_URL" -c "SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='new_col'" | grep -q '1 row'
```

### Refactor with no behavior change
The probe is the test suite scoped to the touched module:
```
npm run build && npm test -- --testPathPattern='module-touched'
```
This is the one case where the probe and a test command overlap legitimately — a refactor's contract IS that tests still pass.

### Frontend route or component
A Playwright check is ideal:
```
npx playwright test e2e/new-feature.spec.ts --reporter=line
```
If Playwright isn't set up yet:
```
curl -fsS http://localhost:3000/the-new-page | grep -qE 'data-testid="new-feature"|<NewFeature'
```

### Background job / scheduled task
Probe by triggering it manually and observing its output:
```
node bin/run-job.mjs new-job-name --once 2>&1 | grep -q "job completed: new-job-name"
```

### Configuration change
Read it back:
```
node -e 'const c = require("./config/loaded.json"); if (c.newKey !== "expected") process.exit(1)'
```

## Anti-Patterns to Reject

| Don't write | Why |
|---|---|
| `npm test` (the full suite) | A test suite is not a probe — it doesn't prove THIS task's wiring; it could pass against a stub the task didn't fix. |
| `echo "done"` | No observable evidence; it can't fail. |
| `cat fixtures/expected.json` | Reads a file the task didn't write; doesn't exercise new code. |
| `node -e '"use strict"; console.log("ok")'` | Doesn't import or call any of the task's code. |
| Multi-line scripts requiring setup state | Probes must be self-contained. If setup is needed, fold it into the probe with `&&` or refactor the task. |
| Interactive prompts | Probes must run unattended. |
| Curl against an external service | Non-deterministic and not under the change's control. Use a local mock or skip. |
| Anything that takes >5 minutes | Probe is too broad. Split the task or narrow the probe. |
| `! command_that_fails_today` | "Negative" probes that pass *because* something is broken are ambiguous after a fix lands. |

## Quality Checklist Before Saving

Before writing the probe to the task file, confirm:

- [ ] **One command.** Multi-step setup belongs in the task's prerequisites, not the probe. Allowed connectors: `&&` (sequential), `|` (pipe), `;` (only if every step is independently meaningful — rare).
- [ ] **Self-contained.** Could be run by anyone, in any clone, with the standard project setup, and produce the same exit code.
- [ ] **Exit 0 ↔ pass.** No "exit 0 means probably ok"; exit 0 means the AC is satisfied.
- [ ] **Observable output.** When passing, the probe prints something that demonstrates the wiring (a value, a row count, a matched text). Bare exit-0 with empty output is suspicious.
- [ ] **Deterministic.** Run twice without changes → same exit code. Network calls to external APIs, time-based checks, or randomized inputs are red flags.
- [ ] **Bounded.** Default budget is 60s; hard cap 5m. A probe that needs >60s is testing too much — narrow it.
- [ ] **Doesn't pass today.** Run the probe on the current working branch *before* implementation. It should FAIL — if it passes pre-implementation, the probe isn't testing the change. (This is the probe-equivalent of TDD's "watch it fail" rule.)

## Where the Probe Lands

In the task file's frontmatter:

```yaml
---
id: T-042
title: Add user creation endpoint
kind: feature
parent_feature: F-007
status: approved
effort: M
acceptance_probe: |
  curl -fsS -X POST http://localhost:3000/api/users \
    -H "Content-Type: application/json" \
    -d '{"name":"probe","email":"p@p.io"}' | jq -e '.id and .name == "probe"'
---
```

Use a YAML block scalar (`|`) when the probe is multi-line or contains characters that would need escaping. Otherwise inline:

```yaml
acceptance_probe: 'node -e ''require("./dist").newFn(42) === 84 || process.exit(1)'''
```

(Quoting JS one-liners in YAML is genuinely unpleasant; prefer the block scalar.)

## When Probe Authoring is Hard

Some legitimate cases where the probe is non-obvious:

1. **The feature is asynchronous.** Probe by triggering the action and polling for the observable result with a bounded retry: `for i in {1..10}; do <check> && exit 0 || sleep 1; done; exit 1`.
2. **The feature is observable only via logs.** Trigger the path, then `grep` the log file or stdout for the expected line.
3. **The feature is a UI-only change with no backend.** Use a Playwright check or, in a pinch, `curl` + grep for a unique element marker.
4. **The feature is an internal refactor with no new external surface.** Probe is the scoped test suite (the legitimate exception above).
5. **The change is purely additive to a config file.** Read the config back via the application's loader and assert the new key is honored.

If after these patterns the probe is still elusive, surface to the user via AskUserQuestion: *"This task's acceptance criteria don't reduce to a single observable command. Should we (a) refine the criteria, (b) split into smaller tasks, or (c) mark this task `kind: research` and produce a findings doc instead?"* Recommend (a) by default.

## Pairing With Other Skills

- **`running-acceptance-probe`** runs what this skill writes. The contracts must align: the probe shape this skill produces is exactly what that skill expects.
- **`dispatching-task-loop`** consumes the `acceptance_probe:` field at dispatch time. A missing or empty probe blocks dispatch — author one or mark `kind: research`.
- **`anti-stub-scan`** can flag stub-shaped probes (`echo done`) as MEDIUM findings; a probe that doesn't exercise added code is itself a kind of stub.
- **`/ship-review`** re-runs probes during review; flaky probes surface here and cycle back to this skill for re-authoring.

## Bottom Line

- One command, derived from the AC, that prints observable evidence.
- Fails today, passes after the change.
- Self-contained, bounded, deterministic.
- Written to `acceptance_probe:` in the task frontmatter at planning time.
- Without one, the task is not ready for execution.
