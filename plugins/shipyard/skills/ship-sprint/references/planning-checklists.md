# Planning Checklists

## Definition of Ready Gate (run before decomposing tasks)

For each selected feature, verify readiness:

| # | Check | Action if fails |
|---|---|---|
| 1 | Acceptance criteria exist and are testable | → Send back to /ship-discuss |
| 2 | No unresolved TBDs or TODOs in spec | → Resolve now or send back |
| 3 | Dependencies available (done or in this sprint) | → Pull dependency in or defer |
| 4 | Spec not stale (updated within 30 days, codebase hasn't changed in relevant areas) | → Quick refresh against current codebase |
| 5 | Technical approach agreed (Step 3.5 decisions resolved) | → Resolve before decomposing |
| 6 | Scope fits one sprint (points <= 50% of capacity) | → Split or plan focused sprint |

## Cross-Cutting Concerns Audit

For each concern, answer: "Does this feature need this, and how?"

| Concern | Question | If Yes |
|---|---|---|
| **Auth/AuthZ** | New permissions, roles, or access rules? | Add to task Technical Notes. Flag middleware changes. |
| **Logging** | Operations needing audit trails or debug logs? | Specify log level, what to log, what NOT to log (PII). |
| **Error handling** | Error boundaries, retry logic, circuit breakers? | Specify per-operation strategy in failure modes. |
| **Caching** | Data that can be cached? Invalidates existing caches? | Specify cache key, TTL, invalidation triggers. |
| **Rate limiting** | Endpoints that could be abused? | Specify limits per-endpoint. |
| **Analytics** | Events the business needs to track? | Specify event names, properties, triggers. |
| **Feature flags** | Gradual rollout needed? | Specify flag name, default state, rollout plan. |
| **Background jobs** | Async work triggered? | Specify job type, retry policy, dead letter handling. |
| **Notifications** | User notifications needed? (email, push, in-app) | Specify trigger, template, channels, opt-out. |
| **Search/Indexing** | Data that needs to be searchable? | Specify indexed fields, search behavior. |
| **Migration** | Data model changes needing migration? | Specify strategy (additive? breaking? backfill?). |
| **Config** | Runtime configuration needed? | Specify config keys, defaults, location (env vars). |

## Knowledge Gap Assessment

For each task:
- Similar code exists in codebase? (pattern exists → LOW risk)
- Requires library/API nobody has used? (new territory → MEDIUM risk)
- Domain with regulatory/compliance requirements? (→ HIGH risk, needs research)
- Touching poorly documented or untested code? (fragile → MEDIUM risk)

For MEDIUM/HIGH gaps:
- Add research time to estimate
- Add docs/tutorials to Technical Notes
- Consider a learning spike task in Wave 1

## Risk Register (add to SPRINT.md)

```
## Risks

| Risk | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|
| [e.g., Auth library upgrade may break] | Medium | High | Spike in Wave 1 | Open |
```

Derive from: critical path tasks, external deps, knowledge gaps, spec uncertainty, technical debt.

## MoSCoW Classification (per acceptance criteria)

Tag every acceptance criterion within each feature:
- **MUST**: Without this, feature is broken. Defines the MVP.
- **SHOULD**: Expected but feature works without. Ship if time allows.
- **COULD**: Polish. Only with sprint slack. NO tasks created.
- **WON'T (this sprint)**: Consciously deferred. Backlog tickets created.

Rules:
- MUST items alone fit within capacity
- SHOULD items have individual estimates (pull-in candidates)
- COULD items have no tasks (prevents invisible scope creep)
- WON'T items have backlog tickets (prevents forgetting)

## SOLID Principles Check

| Principle | Planning Question |
|---|---|
| **SRP** | Does this give any existing component a second reason to change? Split first? |
| **OCP** | Modifying existing behavior or extending? Can we extend instead? |
| **LSP** | New variant usable everywhere the base type is used? |
| **ISP** | Bloating an existing interface with methods only some consumers need? |
| **DIP** | Direct dependency on concrete external service? Introduce abstraction? |

## 12-Factor App Check

| Factor | Question |
|---|---|
| **III. Config** | New config through env vars? (not hardcoded, not committed) |
| **IV. Backing Services** | New service (DB, queue, cache, API)? Treated as attached resource? |
| **VI. Processes** | Requires sticky sessions or local state? Redesign if so. |
| **X. Dev/Prod Parity** | Runs in dev exactly as prod? Any prod-only deps? |
| **XI. Logs** | Structured logs to stdout? No local files. |

## CAP Theorem Check (if distributed)

Trigger: feature involves data in multiple services/databases.
- Which two: Consistency, Availability, Partition Tolerance?
- If CP: what does user see during partition?
- If AP: what is the inconsistency window? Acceptable?
- Compensation/reconciliation mechanism needed?

## Three-Point Estimation (PERT)

For each task, estimate three scenarios:
- **OPTIMISTIC**: Everything goes right. Patterns exist, deps work first try.
- **LIKELY**: Normal development. Some surprises, some debugging.
- **PESSIMISTIC**: Significant obstacles. Undocumented behavior, refactoring needed.

**PERT = (O + 4×L + P) / 6**

Flag any task where pessimistic > 3× optimistic — high-uncertainty, may need a spike.

Add to task frontmatter:
```yaml
effort_optimistic: S    # if everything goes perfectly
effort_likely: M        # realistic expectation
effort_pessimistic: L   # if significant obstacles
effort: M              # computed PERT
```

## Reference Class Forecasting

After estimating, cross-check against actuals:
- Similar tasks in past sprints? (check archived SPRINT.md files)
- How long did those actually take vs estimate?
- If consistently longer → adjust upward
- No history? Note: "No reference class — estimates lower confidence. Consider 20% buffer."

## Test Strategy (add to each task file)

```
## Test Strategy

### What to test
- [behaviors from feature's Gherkin scenarios that apply to this task]
- [edge cases from the edge case analysis]

### Test data needed
- [fixtures, seed data, factories required]
- [realistic data volumes? minimal fixtures?]

### Mocking/stubbing needed
- [external services to mock]
- [existing mocks/fixtures in codebase to reuse?]

### Test boundaries
- [unit: pure logic, no I/O — what functions?]
- [integration: module boundaries, DB, API — what flows?]
- [E2E: full user journey — which scenarios?]

### Chaos tests (if FMEA RPN > 200 or feature has SLA/data integrity requirements)
- [what to break: e.g., kill DB connection mid-write]
- [expected behavior: e.g., transaction rolls back, user sees retry prompt]
- [how to verify: e.g., check DB state is consistent after kill]
```
