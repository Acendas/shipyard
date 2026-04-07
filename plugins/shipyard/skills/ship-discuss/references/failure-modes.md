# Failure Mode Analysis

## FMEA Table (add to feature spec)

For each write operation or state change, fill this table:

| Operation | Failure Mode | Severity (1-10) | Probability (1-10) | Detection (1-10) | RPN | Mitigation |
|---|---|---|---|---|---|---|
| [e.g., save payment] | [network timeout] | [8 - data loss] | [5 - mobile users] | [3 - client detects] | 120 | [local draft + retry with idempotency key] |

**Scoring:**
- Severity: 1=cosmetic, 5=feature broken for some, 8=data loss, 10=security breach/total outage
- Probability: 1=nearly impossible, 5=happens under load, 10=every request if triggered
- Detection: 1=caught by unit test, 5=integration test, 8=only in production, 10=silent corruption

**RPN = Severity × Probability × Detection**
- RPN > 200: MUST have mitigation in sprint
- RPN > 100: SHOULD have mitigation
- Severity >= 8: MUST have mitigation regardless of RPN

## Failure Mode Prompts

For each write operation or state change:
- What if the operation partially completes? (wrote to DB but not cache)
- What if it times out? (is state now ambiguous?)
- What if it succeeds but user doesn't get confirmation? (they retry — safe?)
- What if an external dependency is down?
- What if data is corrupted or invalid at read time? (defensive read fallback?)
- What about poison messages? (event that crashes handler on every retry?)

## HAZOP Guide Words on Data Flows

For each data flow (A → B), apply:

| Guide Word | Meaning | Question |
|---|---|---|
| NO/NONE | Data doesn't arrive | Upstream returns nothing? Queue empty? |
| MORE | Too much data | Result set 10x expected? Payload 100MB? |
| LESS | Incomplete data | Required fields missing? Response truncated? |
| REVERSE | Wrong direction | Receive data we should send? Event fires twice? |
| PART OF | Partial delivery | 3 of 5 batch records succeed? |
| OTHER THAN | Wrong type/format | String instead of number? Wrong encoding? |
| EARLY | Arrives too soon | Callback before resource ready? Race condition? |
| LATE | Arrives too late | Response after timeout? Stale event? |

Any scenario causing data corruption, silent failure, or security issue → add mitigation task.

## Chaos Test Candidates

After completing the FMEA table and HAZOP analysis, identify chaos test scenarios — things to deliberately break during testing to verify resilience:

**Infrastructure chaos:**
- Kill a dependency mid-request (DB, cache, external API)
- Inject network latency (200ms → 5s) on a critical path
- Fill disk/memory to capacity
- Expire all auth tokens simultaneously

**Data chaos:**
- Send malformed payloads (wrong types, missing fields, oversized)
- Inject duplicate events/messages
- Corrupt a cache entry (stale data served)
- Simulate clock skew between services

**Load chaos:**
- Spike traffic 10x normal on a single endpoint
- Slow consumer (queue backs up)
- Connection pool exhaustion

**For each chaos scenario, define:**
- **What to break**: specific component/connection to disrupt
- **How to break it**: tool or technique (network proxy, kill process, inject error)
- **Expected behavior**: what SHOULD happen (graceful degradation, retry, error message)
- **Actual test**: how to verify (automated test, manual check, monitoring alert)

**When to plan chaos tests:**
- Any FMEA item with RPN > 200
- Any feature with availability requirements (SLA)
- Any feature handling financial/health/safety data
- Any feature with distributed state (multiple services)

Chaos test tasks go in the sprint's final wave — after the feature works, stress-test its failure handling.
