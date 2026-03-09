# Feature Discovery Techniques

## Jobs-to-be-Done (JTBD)

Before asking "what should this feature do?", ask:

- What job is the user hiring this feature to do? (not "what does it do" but "what progress are they trying to make")
- What are they doing TODAY without this feature? (current workaround reveals the real pain)
- When do they fire their current solution? What makes it fail? (switching triggers)
- Three dimensions of the job:
  - Functional: "I need to X"
  - Emotional: "I want to feel Y" (confident, in control, not embarrassed)
  - Social: "I want to be seen as Z" (competent, organized, responsive)
- Adjacent jobs: what will the user do immediately before/after this? (reveals missing features or integration points)

## User Journey Mapping (Before/During/After)

Map the full journey, not just the feature behavior:

- **BEFORE**: What is the user doing before they encounter this feature? (entry point, context, mental state)
- **TRIGGER**: What causes them to use it? (notification, search, habit, emergency)
- **DURING**: Steps in the happy path (numbered sequence)
- **AFTER**: What do they do after? (next action, confirmation needed, share results)
- **ABANDON**: Where can they abandon? What happens to their state?
- **INFORMATION**: What info do they need at each step that they might not have?

## Pre-Mortem

Imagine this feature shipped 3 months ago and FAILED. Why?

- "Users didn't adopt it" — onboarding unclear? Value not obvious? Too much behavior change?
- "It caused more problems than it solved" — disrupted existing workflow? Created new edge cases?
- "We built it wrong" — what technical decision could we regret?
- "We scoped it wrong" — built too much (users only needed 30%)? Too little (critical piece missing)?
- "Something external changed" — dependency broke? Competitor made it irrelevant?

## ISO 25010 Quality Characteristics

For each, 2-3 questions the spec should answer:

**Functional Suitability**
- Covers ALL user tasks end-to-end, or leaves gaps?
- Defined correctness criteria? (expected output for each input class)

**Performance Efficiency**
- Target response time at p50/p95/p99?
- Resource ceilings (CPU, memory, DB connections)?

**Compatibility**
- Coexists with other features sharing same data/resources?
- External system API contract versions?

**Interaction Capability**
- New user can accomplish task without docs? Max steps?
- User makes a mistake mid-flow — can they undo/recover?

**Reliability**
- Required availability level?
- Blast radius if this feature fails?
- Recovery: auto or manual?

**Security**
- Data classification (public, internal, confidential, restricted)?
- Authorization model (role-based, attribute-based, resource-based)?

**Maintainability**
- Testable in isolation?
- Makes future changes harder? (coupling)

**Flexibility**
- Deployable independently?
- Platform-specific dependencies?

## ATAM — Architecture Tradeoff Analysis (lightweight)

1. Top 3 quality attribute drivers for this feature (performance? security? modifiability?)
2. For each, what architectural approach are we using?
3. Sensitivity points: "If X changes, this design breaks"
4. Tradeoff points: "We chose A over B, gaining X but losing Y"
5. Risks: "If load exceeds N, this approach degrades because..."

## EARS Syntax for Requirements

Structure acceptance criteria using these 5 patterns to eliminate ambiguity:

- **Ubiquitous**: "The [system] shall [action]"
- **Event-driven**: "WHEN [trigger], the [system] shall [action]"
- **State-driven**: "WHILE [state], the [system] shall [action]"
- **Unwanted**: "IF [condition], THEN the [system] shall [action]"
- **Optional**: "WHERE [feature enabled], the [system] shall [action]"

Rules:
- Every WHEN/IF must have the ELSE case defined
- No vague terms: "fast", "user-friendly", "secure", "robust" — replace with measurable criteria
- Name the specific component, not "the system" generically

## IEEE 830 / ISO 29148 Completeness Checks

Every requirement must be:
- **Unambiguous**: Two developers read it → build the same thing
- **Testable**: Can write a test assertion right now
- **Bounded**: Explicitly says what's NOT in scope
- **Traceable**: Points to user need or business goal
- **Feasible**: Confirmed buildable within sprint
- **Free of implementation bias**: Says WHAT, not HOW (unless HOW is a constraint)

Specification-level:
- No TBDs remaining
- All states covered (happy, error, edge, empty, loading)
- All actors covered (admin, user, anonymous, API consumer)
- Interfaces defined (inputs, outputs, side effects, errors)
- Assumptions listed
- Constraints listed (regulatory, technical debt, backward compat)
