# Code Quality Standards (construct ⟷ verify)

Shared dimension set for Shipyard's build/verify surface — the SAME criteria a
builder writes to and a reviewer checks against, so review confirms quality
that's already there instead of discovering its absence later, in a colder
context, at higher cost. Each dimension below is a `## <dimension>` block with
a `### Construct` half (what good looks like while you're writing) and a
`### Verify` half (what a reviewer scans the diff for).

**Single source of truth.** The dimension set is defined here, once.
`shipyard-disciplined-builder` reads the `### Construct` halves while
implementing (gated on task effort — see `dispatching-task-loop`'s Inputs).
`shipyard-code-reviewer`'s concern definitions point back at the matching
`### Verify` half instead of re-stating it. Don't fork a second copy of either
half into either agent file — edit here, both sides pick it up.

**Self-gate per dimension.** Apply a dimension only to the code that actually
touches it — an `observability` construct has nothing to say about a pure
data-transform with no boundary to log; a `security` construct has nothing to
say about a helper with no external input to validate. This is the same
significance discipline the `data` concern already uses (auto-gates on
persistence-touching diffs) — don't force a dimension onto code it doesn't
apply to, on either side of the split.

**Scope bound: build to spec, robustly — never gold-plate.** These standards
raise the floor on the code the acceptance criteria already ask for. They are
not license to add defenses for inputs the feature doesn't accept, an
abstraction for a use case nobody asked for, or hardening beyond what the AC
needs. That is over-build, not robustness, and the spec reviewer's
`OVER-BUILT` finding class exists specifically to catch it — see
`shipyard-spec-reviewer.md`.

**Not an adjudication surface.** This file states what good construction and
good verification look like — it does not classify findings (MET / PARTIAL /
OVER-BUILT lives with the spec reviewer) and it carries no confidence-scoring
vocabulary (the ≥ 80 threshold lives with the code reviewer's own Confidence
Threshold section). Read it for the dimension content; read the dispatching
agent for how findings get scored and routed.

---

## security

### Construct
- Parameterize every query and every shell/template invocation built from
  external input — never string-concat untrusted data into a sink.
- Check auth/authz on every access to another user's resource: verify
  ownership, not just identity, and never trust a client-supplied ID alone.
- Never hardcode secrets or credentials in source — read them from config or
  environment.
- Use vetted crypto (no MD5/SHA1 for auth, salted hashes, random IVs,
  constant-time token compares) and validate/bound every external input
  (length, charset, type) before it's used.

### Verify
  - Injection sinks: SQL, shell, template, NoSQL, LDAP. Look for unparameterized
    query construction, shell commands built with string concat, template
    rendering of user input.
  - Auth / authz: missing or wrong check, role escalation, broken object-level
    auth (e.g., user can fetch another user's resource by ID).
  - Hardcoded secrets / credentials in source.
  - Crypto misuse: weak algorithms (MD5, SHA1 for auth), missing salt, fixed
    IVs, ECB mode, missing constant-time compare on token check.
  - Unsafe deserialization of untrusted input via language-level binary
    serializers; YAML loaders that allow arbitrary tag construction; eval-like
    sinks that interpret user-supplied strings as code.
  - Path traversal: user-controlled path joined without containment check.
  - SSRF: outbound requests to user-supplied URLs without allowlist.
  - Input validation gaps: missing length / charset / type bounds.

## bugs

### Construct
- Guard the boundary explicitly before you write a range/slice/index — don't
  assume off-by-one can't happen here.
- Check for null/undefined before dereferencing, especially on anything that
  crossed a function or API boundary.
- Protect shared state you mutate with locking; avoid check-then-act races —
  recheck under the lock, or use an atomic primitive.
- Close every resource you open (file handles, sockets, subprocess pipes) via
  the language's scoped/`with`/`try-finally` idiom; don't rely on GC.
- Use the operator the language actually needs (no `=` where `==` is meant, no
  `&` where `&&` is meant), and watch for implicit type coercion, timezone
  math, integer overflow, and float equality at boundaries.

### Verify
  - Off-by-one: ranges, slices, indexing.
  - Null / undefined handling: missing checks before deref.
  - Race conditions: shared state mutated without locking; check-then-act
    patterns.
  - Resource leaks: file handles, sockets, subprocess pipes not closed.
  - Wrong operators: `=` vs `==`, `&` vs `&&`, `is` vs `==`.
  - Type confusion: implicit conversions producing wrong results.
  - Boundary errors: timezone math, integer overflow at API boundaries,
    floating-point equality.

## silent-failures

### Construct
- Never leave a catch/except block empty or pass-only — log it or re-raise
  with the original cause attached (`raise ... from`, a wrapped exception, or
  the language's equivalent).
- If you retry, surface the final failure to the caller instead of quietly
  returning a default/None after N failed attempts.
- Write a test for the error path of any function whose failure the caller
  needs to observe — a function with only happy-path tests is a
  silent-failure risk by default.

### Verify
  - Empty `catch` / `except` blocks (or catches that only `pass`).
  - Catches that swallow the original exception (no `raise from`, no log).
  - Retries that hide root cause (try N times, return None on N failures).
  - Default-on-error patterns that mask the failure to the caller.
  - Missing error-path tests for critical functions.

## patterns

### Construct
- Read `.claude/rules/project-*.md` and `.claude/rules/learnings/*.md` (if
  present) before writing — the project's own conventions outrank your own
  preference.
- Match the surrounding code's naming, and check whether a nearby function
  already does this before writing a new one (see the simplicity ladder
  below).
- Name constants instead of embedding magic numbers/strings; remove dead or
  commented-out code before you commit it rather than leaving it "just in
  case."

### Verify
  - Violations of <project_rules_path> files (read those first; cite which
    rule was violated).
  - Naming convention violations.
  - Anti-patterns from project learnings (`.claude/rules/learnings/*.md` if
    present).
  - Duplication of a function that already exists nearby.
  - Magic numbers / strings without a named constant.
  - Dead code / commented-out blocks.
  - Unnecessary/duplicate/reinvented code that a nearby function, the
    stdlib, or an installed dependency already covers — this is
    `simplicity`'s review-side coverage (see that dimension's Verify half);
    it lives here rather than as a separate scan.

## tests

### Construct
- Write an assertion for every acceptance criterion that checks real
  behavior, not just "it didn't throw."
- Cover the edge cases the AC implies — empty input, max bounds, error
  paths — not only the happy path.
- Assert on observable behavior, not internal implementation details, and
  don't mock away the integration the test exists to prove.

### Verify
  - Missing critical-path coverage (touched function with no test).
  - Weak assertions (`assertNotNull` only, when stronger assertion is
    needed).
  - Missing edge cases (empty input, max bounds, error paths).
  - Brittle tests (assertions on internal implementation, not behavior).
  - Mocks that hide integration breaks (over-mocking).
  - Test files without imports of the new code (probably stubbed).

## observability

### Construct
- Log at error boundaries with enough context to act on it — and never log
  raw PII or secrets.
- Add a metric for any new code path a human will want to watch in
  production.
- Propagate trace/request context across any async boundary you introduce.

### Verify
  - Missing logs at error boundaries.
  - Missing metrics for new code paths users will care about.
  - Missing trace context propagation across async boundaries.
  - Logged values that look like PII / secrets.

## simplicity

### Construct
Before writing code, walk the ladder: (1) does it need to exist? → don't
write it; (2) already in the codebase? → reuse it; (3) stdlib/platform
provides it? → use that; (4) an installed dependency covers it? → use it;
(5) only then write the minimum necessary. Small because necessary, NEVER
golfed — clarity and matching the surrounding code's idiom always win over
line-count. The other dimensions are the floor: validation, security,
error-visibility, tests, and accessibility are never cut to save lines.

### Verify
Verification of unnecessary/duplicate/reinvented code is covered by the
`patterns` concern (duplication, dead code) and the spec-reviewer's
`OVER-BUILT` class — see there; do not add a separate simplicity scan.

## data

Construction and verification of database-touching code — indexing, queries,
migrations, N+1, SARGability, partitioning/replication/caching/pooling — live
in `data-implementation-guide.md`, gated the same way this file is (apply
only when the task or diff touches persistence). Do not restate that content
here; this entry is a pointer, not a duplicate.

---

**Attribution.** The `simplicity` dimension distills a YAGNI /
necessity-ladder principle — write only what's needed, in ascending order of
"does this actually need to exist" — into a construction step. The wording
here is Shipyard's own.
