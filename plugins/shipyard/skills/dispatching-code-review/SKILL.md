---
name: dispatching-code-review
description: Use to dispatch a fresh-context subagent that scans a diff for code-quality issues — security vulns, logic bugs, silent failures, pattern violations, weak tests. Consolidates the six registered review-* agents (security, bugs, silent-failures, patterns, tests, plus optional observability) into one prompt template invoked via general-purpose dispatch. Read-only; returns confidence-scored findings.
disable-model-invocation: true
---

# Dispatching a Code Review

The companion to `dispatching-spec-review`. Spec review answers *"is what was asked delivered?"*; code review answers *"is what was delivered any good?"*. Same fresh-context subagent pattern, different concern set.

## When to Invoke

| Caller | Scope | Trigger |
|---|---|---|
| `/ship-execute` post-task gate | One task | Optional — fires only when `effort: M\|L\|XL`; effort: S skips both spec and code review |
| `/ship-execute` wave VERIFY | Wave-level diff | Optional — fires when wave touched security-relevant or financial-domain code |
| `/ship-review` | Sprint or feature | **Required** before user approval |
| `/ship-quick` | Single-change diff | Optional flag (`--review`) |

Code review is more expensive than spec review (broader concern surface). `/ship-review` runs it mandatorily before approval; the post-task path remains optional and gated on effort.

## Inputs

- `scope` — `"task" | "wave" | "feature" | "sprint"`
- `target_ids` — list of task / feature IDs (or null when scope is sprint).
- `base_ref` / `head_ref` — diff range.
- `concerns` — subset of `["security", "bugs", "silent-failures", "patterns", "tests", "observability"]`. Default: all six. Caller can narrow (e.g., `["security", "bugs"]` for a wave that didn't touch tests).
- `data_dir` — literal `<SHIPYARD_DATA>` path.
- `project_rules_path` — `.claude/rules/*.md` paths so the patterns scanner has the project's conventions. Shipyard does not inject its own rules into `.claude/rules/`; only project-authored rules pass through here.

## The Subagent Prompt Template

Dispatch via `Agent(subagent_type: "general-purpose", prompt: <template>)`. Read-only role. The prompt activates only the requested `concerns`.

```text
You are conducting a code-quality review of a Shipyard {{scope}}.

# Scope

Scope:        {{scope}}
Target IDs:   {{target_ids}}
Base ref:     {{base_ref}}
Head ref:     {{head_ref}}
Concerns:     {{concerns_csv}}
Data dir:     {{data_dir}}
Project rules: {{project_rules_files}}

# Reading list

  $ git diff {{base_ref}}..{{head_ref}}                  (the diff itself)
  $ git diff --name-only {{base_ref}}..{{head_ref}}      (touched files)
  - {{data_dir}}/codebase-context.md                     (project conventions)
  - {{project_rules_path}}                               (if any)

For each touched file, you may Read the full file when context inside the diff
hunk isn't sufficient (e.g., understanding what an imported helper does).

# Concerns

For each concern in {{concerns_csv}}, scan the diff and accumulate findings.
Concern definitions follow.

## security
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
  - Empty `catch` / `except` blocks (or catches that only `pass`).
  - Catches that swallow the original exception (no `raise from`, no log).
  - Retries that hide root cause (try N times, return None on N failures).
  - Default-on-error patterns that mask the failure to the caller.
  - Missing error-path tests for critical functions.

## patterns
  - Violations of {{project_rules_path}} files (read those first; cite which
    rule was violated).
  - Naming convention violations.
  - Anti-patterns from project learnings (`.claude/rules/learnings/*.md` if
    present).
  - Duplication of a function that already exists nearby.
  - Magic numbers / strings without a named constant.
  - Dead code / commented-out blocks.

## tests
  - Missing critical-path coverage (touched function with no test).
  - Weak assertions (`assertNotNull` only, when stronger assertion is
    needed).
  - Missing edge cases (empty input, max bounds, error paths).
  - Brittle tests (assertions on internal implementation, not behavior).
  - Mocks that hide integration breaks (over-mocking).
  - Test files without imports of the new code (probably stubbed).

## observability  (optional — include only if listed in concerns)
  - Missing logs at error boundaries.
  - Missing metrics for new code paths users will care about.
  - Missing trace context propagation across async boundaries.
  - Logged values that look like PII / secrets.

# Confidence Threshold

Report only findings at confidence ≥ 80 (you are reasonably sure this is a
real problem, not a style preference). Findings between 60–80 are advisory;
include them as `confidence: 60–80` if they're worth surfacing but suppress
otherwise. Do not pad findings to look thorough.

# READ-ONLY

You may NOT edit any file, run state-mutating commands, spawn other subagents,
or transition any artifact's status.

You MAY Read, Grep, Glob, run read-only git, and run the project's static
analysis (linter, typechecker) to confirm a finding — but only as a check,
not a fix.

# Required Return Shape

Your reply MUST contain these lines exactly:

    STATUS: CLEAN                               (only when no findings ≥ 80)
    FINDINGS: 0
    SCOPE: {{scope}}
    TARGETS: <comma-separated target_ids>

OR:

    STATUS: FINDINGS
    FINDINGS: <integer count of findings ≥ 80>
    ADVISORY: <integer count of findings 60–80>
    SCOPE: {{scope}}
    TARGETS: <comma-separated target_ids>
    -----
    [<concern>][confidence:<NN>] <one-line summary>
      file: <path>:<line>
      snippet: <touched line, ≤120 chars>
      reason: <one paragraph — why this is a problem, not a style nit>
      fix: <one-line suggested direction, optional>
    [<concern>]... (repeat per finding, sorted by concern then confidence)

OR:

    STATUS: BLOCKED
    REASON: <one paragraph>

Begin.
```

## Orchestrator-Side Action Rules

1. **`STATUS: CLEAN`** → record; advance.

2. **`STATUS: FINDINGS`**:

   - **High-confidence security findings** (`concern: security`, confidence ≥ 90) → block. Re-dispatch `dispatching-task-loop` with the security findings inlined: *"Code review found security issues that must be fixed: <list>; re-implement and re-probe."*
   - **Other ≥ 80 findings** → present in the calling skill's report. The user (in `/ship-review`) decides per finding: fix now, file as bug, or accept. The post-task path can auto-redispatch the task once for high-density findings (≥ 3) but stops there to avoid loop-on-quality.
   - **Advisory (60–80)** → log to PROGRESS.md deviations; no auto-action.

3. **`STATUS: BLOCKED`** → AskUserQuestion. Likely: diff is too large, spec missing, project rules path bad.

4. **Read-only enforcement** — same as `dispatching-spec-review`: post-return `git status --porcelain` + HEAD ref check. Any drift is a contract violation.

## Parallel Dispatch For High-Stakes Reviews

For high-stakes reviews (release-bound, large diff, payments/auth/data), `/ship-review` may dispatch this skill multiple times in parallel with non-overlapping `concerns` arrays — each subagent gets its own context window, scanning is genuinely parallel. The trade is more tokens for better depth on each concern.

## Pairing With Other Skills

- **`dispatching-spec-review`** runs before this — spec compliance is "did we deliver"; code review is "is the delivery any good." Both must pass for `/ship-review` approval.
- **`dispatching-task-loop`** is invoked when high-confidence findings demand re-implementation.
- **`anti-stub-scan`** is structural; this skill is contextual / semantic. Both run on the diff but ask different questions.
- **`running-acceptance-probe`** is orthogonal — code review doesn't run probes; spec review may.

## Bottom Line

- One dispatch, sectioned prompt, six concern domains.
- Read-only; structured findings; confidence ≥ 80 to block.
- Security ≥ 90 auto-redispatches; everything else surfaces for orchestrator/user decision.
- Post-return git-status check enforces the read-only contract.
