# E2E Acceptance Criteria Taxonomy

Reference file for the `validating-e2e-coverage` capability skill. Maps feature touch surfaces to mandatory E2E acceptance criteria categories. The taxonomy is the universe of what COULD apply; touch-surface detection filters it to what DOES apply per feature.

## How This File Is Used

1. `validating-e2e-coverage` reads the feature spec (user story, AC, interface, data model, technical notes, flows, error handling)
2. Matches spec content against the Touch Surface Detection Table below
3. For each activated category, pulls the specific types and example scenarios
4. Compares against existing AC to find COVERED / GAP / PARTIAL
5. Returns gaps with draft GWT scenarios for user approval

## Touch Surface Detection Table

Match spec content against these patterns to activate categories. A category activates when ANY pattern in its row matches.

| Pattern (in spec content) | Activates Categories |
|---|---|
| `POST\|PUT\|PATCH\|DELETE`, `endpoint`, `API`, `REST`, `GraphQL`, `route` | timeout, rate-limiting, input-sanitization, idempotency |
| `auth`, `login`, `session`, `token`, `JWT`, `OAuth`, `permission`, `role`, `admin` | privilege-escalation, input-sanitization |
| `database`, `query`, `migration`, `schema`, `table`, `index`, `SQL`, `ORM` | data-consistency, migration-safety |
| `cache`, `Redis`, `Memcached`, `TTL`, `invalidat` | cache-coherence |
| `queue`, `event`, `publish`, `subscribe`, `Kafka`, `RabbitMQ`, `SQS`, `async`, `background job` | idempotency, retry-storm, partial-failure-recovery |
| `external`, `third-party`, `API call`, `webhook`, `HTTP client`, `fetch`, `axios` | integration-boundary, graceful-degradation, timeout |
| `timeout`, `deadline`, `SLA`, `latency`, `response time` | timeout |
| `payment`, `billing`, `charge`, `refund`, `invoice`, `ledger`, `wallet`, `money`, `currency` | idempotency, data-consistency, state-machine-integrity, observability-completeness |
| `rate limit`, `throttle`, `quota`, `burst` | rate-limiting |
| `upload`, `file`, `blob`, `storage`, `S3`, `disk` | resource-exhaustion, input-sanitization |
| `cron`, `scheduler`, `periodic`, `interval`, `background` | concurrency-control, resource-exhaustion |
| `concurrent`, `parallel`, `thread`, `lock`, `mutex`, `race`, `atomic` | concurrency-control |
| `config`, `environment`, `feature flag`, `toggle`, `setting` | configuration-drift, deployment-safety |
| `deploy`, `release`, `rollback`, `canary`, `blue-green`, `migration` | deployment-safety, migration-safety |
| `log`, `metric`, `trace`, `monitor`, `alert`, `dashboard`, `observab` | observability-completeness |
| `state`, `status`, `workflow`, `transition`, `lifecycle`, `FSM` | state-machine-integrity |
| `retry`, `backoff`, `circuit breaker`, `fallback` | retry-storm, graceful-degradation |
| `user input`, `form`, `validation`, `sanitiz`, `escap`, `XSS`, `injection` | input-sanitization |

---

## Categories

### 1. timeout (Timeout & Deadline Handling)

**Default verification_type:** probe

Validates that the system handles time boundaries correctly — requests that take too long, cascading timeouts through service chains, and deadline propagation.

**Types:**

**1.1 Request deadline at boundary**
When a request approaches or exceeds the documented timeout, the system returns a clear error rather than hanging.

> Given a request to the endpoint with a 30-second deadline,
> When processing takes 31 seconds,
> Then the system returns HTTP 504 with a structured timeout error before the client's own timeout fires.

**1.2 Cascading timeout through service chain**
When an upstream timeout fires, downstream in-flight work is cancelled rather than completing silently.

> Given Service A calls Service B with a 10-second timeout,
> When Service B calls Service C and the 10-second deadline passes,
> Then Service B cancels the Service C call and propagates the timeout to Service A.

**1.3 Timeout recovery — no dangling state**
After a timeout, no server-side state is left in a partially-committed condition.

> Given a write operation that times out mid-execution,
> When the client retries,
> Then the system either completes the original write (idempotent) or rolls it back cleanly — no partial records.

**1.4 Client retry after ambiguous timeout**
The system handles the case where the client doesn't know if the timed-out operation succeeded.

> Given a payment charge request that times out,
> When the client retries with the same idempotency key,
> Then exactly one charge is created regardless of whether the first attempt completed.

---

### 2. idempotency (Idempotency & Exactly-Once Processing)

**Default verification_type:** probe

Validates that duplicate requests produce the same outcome as a single request.

**Types:**

**2.1 Double-submit under user retry**
User clicks twice or browser retries — only one effect occurs.

> Given a user submits a form,
> When the same submission arrives twice within 1 second,
> Then only one record is created and the second request returns the same result as the first.

**2.2 Network retry after ambiguous response**
Client retries because the response was lost, not because the request failed.

> Given a POST request that the server processes successfully,
> When the response is lost and the client retries with the same idempotency key,
> Then the server returns the original response without re-executing the side effect.

**2.3 At-least-once delivery duplicate handling**
Message queue delivers the same event twice — consumer handles it without duplication.

> Given an event is published to the queue,
> When the consumer receives the same event twice,
> Then the side effect occurs exactly once.

**2.4 Concurrent retries with same key**
Two retry attempts race to execute the same operation.

> Given two concurrent requests with the same idempotency key,
> When both arrive at the server simultaneously,
> Then exactly one executes, the other returns the first's result, and no data corruption occurs.

---

### 3. rate-limiting (Rate Limiting & Throttling)

**Default verification_type:** probe

Validates behavior at and beyond rate limits.

**Types:**

**3.1 At-limit behavior**
At exactly the rate limit, all requests succeed.

> Given the rate limit is 100 requests per minute,
> When exactly 100 requests arrive in one minute,
> Then all 100 succeed with no throttling.

**3.2 Over-limit rejection**
Beyond the limit, requests are rejected with clear feedback.

> Given the rate limit is 100 requests per minute,
> When the 101st request arrives,
> Then it receives HTTP 429 with a Retry-After header indicating when to retry.

**3.3 Rate limit fairness across tenants**
One tenant's burst doesn't starve others.

> Given a multi-tenant system with per-tenant rate limits,
> When Tenant A sends a burst of 10x their limit,
> Then Tenant B's requests are unaffected and served at normal latency.

---

### 4. graceful-degradation (Graceful Degradation & Partial Failure)

**Default verification_type:** manual

Validates that the system remains usable when a dependency is unavailable.

**Types:**

**4.1 Dependency down — core path survives**
When a non-critical dependency fails, the primary user experience continues.

> Given the recommendation service is unavailable,
> When the user loads the product page,
> Then the page loads with product details and a "recommendations unavailable" placeholder — no error page.

**4.2 Degraded mode messaging**
The user sees a clear indication of reduced functionality, not a confusing partial state.

> Given the search index is stale (>5 minutes behind),
> When the user searches,
> Then results include a banner "Results may not include the latest items" and the search still completes.

**4.3 Recovery after dependency returns**
When the dependency recovers, the system resumes full functionality without restart.

> Given the payment gateway was unavailable for 5 minutes,
> When the gateway becomes reachable again,
> Then pending operations resume and new requests process normally within 30 seconds.

**4.4 Cascading failure prevention**
Failure in one component doesn't cascade to bring down the entire system.

> Given the notification service crashes,
> When the user completes a purchase,
> Then the purchase succeeds and the notification is queued for retry — the checkout flow is unaffected.

---

### 5. data-consistency (Data Consistency & Integrity)

**Default verification_type:** probe

Validates that data remains correct across operations, replicas, and failure scenarios.

**Types:**

**5.1 Referential integrity after delete**
Deleting an entity doesn't leave orphaned references.

> Given an entity with dependent records,
> When the entity is deleted,
> Then all dependent records are either cascade-deleted or the delete is rejected with a clear error.

**5.2 Read-after-write consistency**
A write is immediately visible to subsequent reads from the same client.

> Given a user updates their profile,
> When they immediately reload the profile page,
> Then the updated data is visible (not stale cached data).

**5.3 Concurrent write conflict resolution**
Two simultaneous writes to the same entity produce a predictable outcome.

> Given two users edit the same record concurrently,
> When both submit their changes,
> Then either optimistic locking rejects the second write with a conflict error, or the system merges changes with a documented strategy.

**5.4 Transaction boundary correctness**
Operations that must be atomic either all succeed or all roll back.

> Given a multi-step operation (debit account + credit account),
> When the second step fails,
> Then the first step is rolled back and no money disappears or appears from nowhere.

---

### 6. concurrency-control (Concurrency & Race Conditions)

**Default verification_type:** probe

Validates that concurrent operations don't corrupt data or produce incorrect results.

**Types:**

**6.1 Double-booking prevention**
Two concurrent attempts to reserve the same resource — only one succeeds.

> Given one remaining seat,
> When two users attempt to book simultaneously,
> Then exactly one booking succeeds and the other receives a "no longer available" error.

**6.2 Counter/balance accuracy under contention**
Concurrent increments/decrements produce the correct total.

> Given a counter starting at 0,
> When 100 concurrent increment requests execute,
> Then the final counter value is exactly 100.

**6.3 Lock ordering — no deadlocks**
Operations that acquire multiple locks do so in a consistent order.

> Given two operations that each need locks on resources A and B,
> When both run concurrently,
> Then both eventually complete (no deadlock) within the timeout period.

---

### 7. privilege-escalation (Privilege Escalation & Authorization Bypass)

**Default verification_type:** probe

Validates that users cannot gain access beyond their granted permissions.

**Types:**

**7.1 Horizontal privilege escalation**
A user cannot access another user's resources by manipulating identifiers.

> Given User A's resource at /api/users/123/settings,
> When User B requests /api/users/123/settings with their own valid token,
> Then the system returns HTTP 403 (not the other user's data).

**7.2 Vertical privilege escalation**
A regular user cannot access admin functionality.

> Given a regular user's session token,
> When the user requests an admin-only endpoint,
> Then the system returns HTTP 403 regardless of how the request is crafted (header tampering, parameter injection).

**7.3 Token/session manipulation**
Tampering with auth tokens doesn't grant elevated access.

> Given a valid JWT with role=user,
> When the payload is modified to role=admin and re-signed with a guessed key,
> Then the system rejects the token with HTTP 401.

---

### 8. input-sanitization (Input Sanitization & Validation)

**Default verification_type:** probe

Validates that malicious or malformed input is handled safely.

**Types:**

**8.1 Injection prevention (SQL, template, command)**
Adversarial input doesn't execute as code.

> Given a search field,
> When the input is `'; DROP TABLE users; --`,
> Then the system treats it as a literal string, returns no results (or matching results), and the database is unmodified.

**8.2 Oversized payload handling**
Payloads beyond the documented maximum are rejected before processing.

> Given the maximum request body is 10MB,
> When a 15MB payload is submitted,
> Then the system returns HTTP 413 without attempting to parse or store the payload.

**8.3 Encoding edge cases**
Unicode, emoji, null bytes, and combining characters don't cause crashes or data corruption.

> Given a text field,
> When the input contains emoji (🎉), CJK characters (日本語), RTL text (العربية), and a null byte,
> Then the value is stored and displayed correctly (null byte stripped or rejected).

**8.4 Path traversal prevention**
File path inputs cannot escape the intended directory.

> Given a file download endpoint that accepts a filename parameter,
> When the input is `../../etc/passwd`,
> Then the system rejects the request (HTTP 400) rather than serving the file.

---

### 9. state-machine-integrity (State Machine & Workflow Integrity)

**Default verification_type:** probe

Validates that entities follow valid state transitions and reject invalid ones.

**Types:**

**9.1 Invalid state transition rejection**
Entities cannot skip states or transition backwards without explicit policy.

> Given an order in "shipped" status,
> When a request attempts to transition it back to "pending",
> Then the system rejects the transition with an error naming the invalid transition.

**9.2 Terminal state immutability**
Once in a terminal state, entities cannot be modified.

> Given a refund in "completed" status,
> When any update is attempted,
> Then the system returns HTTP 409 indicating the entity is in a terminal state.

**9.3 Concurrent state transition safety**
Two simultaneous transitions from the same state — only one succeeds.

> Given an order in "pending" status,
> When two concurrent requests attempt to move it to "approved" and "cancelled",
> Then exactly one transition succeeds and the other receives a conflict error.

---

### 10. integration-boundary (Integration Boundary & Contract)

**Default verification_type:** probe

Validates behavior at the boundary between your system and external services.

**Types:**

**10.1 External service contract validation**
Responses from external services are validated before use.

> Given the external API is expected to return `{ "status": "ok", "data": {...} }`,
> When it returns an unexpected shape (missing `data` field, extra fields, wrong types),
> Then the system logs the schema violation and handles it gracefully (fallback or error) rather than crashing.

**10.2 External service version drift**
The integration handles minor version changes in the external API.

> Given the external API adds a new optional field to its response,
> When our system receives the updated response,
> Then parsing succeeds (unknown fields are ignored, not rejected).

**10.3 Webhook delivery reliability**
Inbound webhooks are processed idempotently with retry tolerance.

> Given an inbound webhook notification,
> When the same webhook is delivered twice (provider retry),
> Then the side effect occurs exactly once.

---

### 11. resource-exhaustion (Resource Exhaustion)

**Default verification_type:** tool

Validates behavior when system resources approach their limits.

**Types:**

**11.1 Disk space approaching limit**
The system detects and handles low disk gracefully.

> Given disk usage reaches 95%,
> When a new write is attempted,
> Then the system rejects the write with a clear error and emits an alert — no crash or data corruption.

**11.2 Memory pressure under load**
The system doesn't leak memory over sustained operation.

> Given sustained load for 4 hours,
> When memory usage is measured hourly,
> Then growth is bounded (< 50MB/hour) and no OOM occurs.

**11.3 Connection pool saturation**
When all connections are in use, new requests fail gracefully.

> Given all database connections are in use,
> When a new request arrives,
> Then it receives a 503 with Retry-After rather than hanging indefinitely.

---

### 12. configuration-drift (Configuration Drift & Feature Flags)

**Default verification_type:** manual

Validates that configuration changes are safe and observable.

**Types:**

**12.1 Feature flag default-off safety**
New features default to off and can be enabled gradually.

> Given a new feature behind a flag,
> When the flag is not explicitly set,
> Then the feature is disabled and existing behavior is unchanged.

**12.2 Configuration rollback**
A bad configuration change can be reverted quickly.

> Given a configuration change that causes errors,
> When the change is reverted,
> Then normal behavior resumes within 60 seconds.

---

### 13. migration-safety (Migration & Upgrade Safety)

**Default verification_type:** tool

Validates that data and schema migrations don't lose data or break running systems.

**Types:**

**13.1 Zero-downtime migration**
Schema changes don't require application downtime.

> Given a database migration that adds a column,
> When the migration runs while the application is serving traffic,
> Then no requests fail and the new column is available after migration completes.

**13.2 Rollback path exists**
Every migration has a working reverse migration.

> Given a migration that has been applied,
> When the rollback migration is executed,
> Then the schema returns to its pre-migration state without data loss.

**13.3 Data preservation through migration**
No records are lost, duplicated, or corrupted during migration.

> Given 1,000,000 records in the source table,
> When the migration completes,
> Then exactly 1,000,000 records exist in the target with all field values preserved.

---

### 14. observability-completeness (Observability & Debuggability)

**Default verification_type:** manual

Validates that the system is observable enough to diagnose production issues.

**Types:**

**14.1 Error logging with correlation**
Every error is logged with enough context to trace back to the originating request.

> Given a request that triggers an internal error,
> When the error is logged,
> Then the log entry includes: correlation ID, timestamp, stack trace, request context (sanitized), and user identifier.

**14.2 Critical path metrics**
Key business operations emit metrics that can trigger alerts.

> Given a new payment endpoint,
> When a payment is processed,
> Then latency, success/failure counts, and amount metrics are emitted and visible in the monitoring dashboard.

**14.3 Trace propagation across async boundaries**
Distributed traces survive async operations (queues, background jobs).

> Given a request that enqueues a background job,
> When the job executes,
> Then the job's trace shares the original request's trace ID and appears in the same distributed trace.

---

### 15. cache-coherence (Cache Coherence)

**Default verification_type:** probe

Validates that cached data doesn't serve stale or incorrect results.

**Types:**

**15.1 Cache invalidation on write**
When the source data changes, the cache reflects the update within the documented window.

> Given a cached entity,
> When the entity is updated in the database,
> Then subsequent reads return the updated value (not stale cache) within 5 seconds.

**15.2 Cache stampede prevention**
When the cache expires, concurrent requests don't all hit the backend simultaneously.

> Given a popular cache key that expires,
> When 100 concurrent requests arrive,
> Then at most one request reaches the backend (the rest wait or get a slightly stale response).

---

### 16. retry-storm (Retry Storm Prevention)

**Default verification_type:** probe

Validates that retry behavior doesn't amplify failures.

**Types:**

**16.1 Exponential backoff with jitter**
Retries use increasing delays with randomness to prevent thundering herd.

> Given a downstream service returns 503,
> When the client retries,
> Then retry intervals increase exponentially with jitter, and total retries are capped at a documented maximum.

**16.2 Circuit breaker engagement**
After repeated failures, the circuit opens and fails fast instead of adding load.

> Given 5 consecutive failures to a downstream service,
> When the circuit breaker opens,
> Then subsequent requests fail immediately (no attempt to call the downstream) for the cooldown period.

---

### 17. partial-failure-recovery (Partial Failure Recovery)

**Default verification_type:** manual

Validates that the system recovers from operations that partially complete.

**Types:**

**17.1 Saga/compensation on partial failure**
Multi-step operations that fail midway are compensated or resumed.

> Given a multi-step order process (reserve inventory → charge card → confirm order),
> When the charge step fails,
> Then the inventory reservation is released and the user sees a clear "payment failed" message.

**17.2 Orphan resource cleanup**
Resources created before a failure are cleaned up.

> Given a file upload that fails after the file is stored but before the database record is created,
> When the failure is detected,
> Then the orphaned file is cleaned up (immediately or by background sweep).

---

### 18. deployment-safety (Deployment & Rollback Safety)

**Default verification_type:** manual

Validates that deployments are safe and reversible.

**Types:**

**18.1 Canary/gradual rollout support**
New versions can be deployed to a subset of traffic first.

> Given a new version deployed to 5% of traffic,
> When error rates on the new version exceed 2x the baseline,
> Then automatic rollback triggers within 5 minutes.

**18.2 Rollback without data loss**
Rolling back to the previous version doesn't lose data written by the new version.

> Given the new version wrote data using a new schema field,
> When the system is rolled back to the old version,
> Then the old version ignores the new field (no crash) and no data is lost.

**18.3 Health check accuracy**
The health endpoint reflects actual readiness, not just process liveness.

> Given the application process is running but the database connection is lost,
> When the health endpoint is checked,
> Then it returns unhealthy (not 200 OK), triggering the load balancer to stop routing traffic.
