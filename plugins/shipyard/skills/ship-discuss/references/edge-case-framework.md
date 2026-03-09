# Systematic Edge Case Framework

Apply each technique to the feature. Skip categories that clearly don't apply.

## Boundary Value Analysis
For every input, parameter, or configurable value:
- Minimum valid value? What happens at min-1?
- Maximum valid value? What happens at max+1?
- Zero? Empty string? Null? Undefined?
- Exactly at the boundary? (off-by-one is the #1 bug class)

## Equivalence Partitioning
For every input:
- Valid partitions? (types of valid input that behave differently)
- Invalid partitions? (types of invalid input)
- Test one representative from each partition

## State Transition Analysis
For every entity with lifecycle states:
- Draw the state machine: states + valid transitions
- Invalid transitions attempted? (cancel an already-completed order)
- Same transition triggered twice? (idempotency)
- Transitions arriving out of order? (race condition)
- Entity stuck with no valid exit? (dead state)

## Data Cardinality Sweep
- Zero items (empty state)
- Exactly one item (singleton edge cases)
- Many items (pagination, performance)
- Maximum items (system limits)
- Duplicate items (uniqueness violations)

## Temporal Edge Cases
- Midnight? Day/month/year boundaries?
- Timezone differences?
- Clock skew between client and server?
- Leap years, DST transitions?
- Very fast repeated actions (double-click, rapid retry)?
- Very slow actions (session timeout during operation)?

## Concurrency & Ordering
- Two users modifying same resource simultaneously
- Operations arriving out of expected order
- Partial completion (step 2 of 3 fails — state?)
- Retry after failure (is operation idempotent?)

## Output

Add edge cases discovered to the feature's acceptance criteria as specific scenarios. Each edge case should become a Given/When/Then or EARS-format requirement.
