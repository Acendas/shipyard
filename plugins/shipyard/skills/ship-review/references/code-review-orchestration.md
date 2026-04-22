# Code Review Orchestration

Shared orchestration logic for code review. Used by both `/ship-review` and `/ship-execute` (sprint completion code review loop).

## Why this is split out

Code review is run by two skills (`ship-review`, `ship-execute`) and both need the same multi-agent dispatch logic. This file is the single source of truth — both skills should follow the steps below verbatim.

## The architecture

```
You (the orchestrating skill, in user's session — opus[1m] recommended)
  │
  ├─ Phase 1: Setup
  │   • Resolve diff command
  │   • Get changed file list once
  │   • Categorize files by type (code / test / auth-sensitive / config)
  │
  ├─ Phase 2: Wave 1 — parallel specialized scanners (single message, 6 Agent calls)
  │   ├─ shipyard:shipyard-review-security      (auth/data files + config)
  │   ├─ shipyard:shipyard-review-bugs          (all code files)
  │   ├─ shipyard:shipyard-review-silent-failures (all code files)
  │   ├─ shipyard:shipyard-review-patterns      (all code files + rules)
  │   ├─ shipyard:shipyard-review-tests         (test files + spec)
  │   └─ shipyard:shipyard-review-spec          (impl + feature/task specs)
  │
  ├─ Phase 3: Aggregate & dedupe findings
  │
  └─ Phase 4: Wave 2 — conditional deep-dive (parallel investigators)
      └─ shipyard:shipyard-investigator × N (one per high-stakes finding)
```

The skill stays on whatever model the user selected (recommend Opus, which is GA at 1M, for code review on large diffs). Wave-1 scanners run on Sonnet (parallel cost matters; they're focused pattern matchers). Sonnet GA is 200K context — fine for narrow scanners since each one only sees its slice of the diff plus the files it grep-walks. The investigator runs on Opus (reasoning matters; one finding at a time).

> **Heads-up on the 1M billing gate.** Anthropic's Claude Code currently has a known bug where a skill with `model: sonnet` invoked from an Opus-1M session can resolve to `sonnet[1m]` and trip the "Extra usage required for 1M context" gate (Sonnet 1M requires extra-usage even on Max). Tracking: github.com/anthropics/claude-code/issues/45847. If you hit it, switch to a standard-context Sonnet via `/model` or enable `/extra-usage`. Our scanners do not need 1M.

---

## Phase 1 — Setup

1. **Resolve the diff range.** You already know it from your skill's flow:
   - First iteration: `git diff $(git merge-base HEAD <main_branch>)...HEAD`
   - Subsequent iterations: `git diff <pre-code-review-tag>..HEAD`
2. **Get the changed file list once:**
   ```bash
   git diff --name-only <range>
   ```
3. **Categorize files** by extension and path heuristics:
   - **Code files** — `.py .ts .tsx .js .jsx .go .rs .java .kt .swift .rb .php .cs .cpp .c`
   - **Test files** — paths matching `test`, `spec`, `__tests__/`, `tests/`
   - **Auth/data sensitive** — paths containing any of: `auth`, `login`, `session`, `token`, `crypto`, `parse`, `serialize`, `query`, `db`, `api`, `route`, `handler`, `middleware`
   - **Config files** — `.json .yaml .yml .toml .env .env.*`
4. **Hold the manifest in your context.** You'll dispatch slices of it in Phase 2.

---

## Phase 2 — Wave 1: Batched Parallel Scanners

Scanners have a hard 32k token output cap. Large diffs can exceed this, causing silent truncation — lowest-severity findings get dropped and the orchestrator has no way to detect it. To prevent this, file lists are **batched** into fixed-size chunks.

### Batching logic

1. **Batch size:** `MAX_FILES_PER_BATCH = 8` files per scanner per round. This keeps scanner output well under 32k even for verbose diffs.
2. **Chunk each scanner's file list** into batches of 8. Example: 24 code files → 3 rounds for the bugs scanner.
3. **Per round:** Spawn up to 6 scanners in parallel (single message, multiple `Agent` tool calls) — same pattern as before, just with a subset of files. Skip a scanner for that round if its file list is already exhausted.
4. **Accumulate findings** across all rounds into one master list. Findings from round 2 are appended to round 1's findings (no dedup until Phase 3).
5. **Spillover:** If a scanner reports `TRUNCATED: true` in any round, move its `FILES_NOT_REVIEWED` into a spillover queue and include them in the next round. Max 2 spillover attempts per scanner — if it's still truncating after 2 spillovers, reduce that scanner's batch size to 4 for remaining rounds.
6. **Stop condition:** All scanners have reviewed all their files (or been spillover-capped).

### Per-scanner prompts

Each scanner gets a TARGETED prompt with only the files relevant to its concern for **this batch**. Don't send the full file list — that defeats both specialization and batching.

**Security scanner** — `shipyard:shipyard-review-security`
```
Run a security review on this sprint's changes.
Diff command: <your diff range>
Scope: focus exclusively on these files (other files have already been screened):
  <auth/data sensitive files + all config files>
Look for: injection, auth/authz bypass, hardcoded secrets, crypto misuse, unsafe deserialization, missing input validation, path traversal.
Confidence ≥ 80 only. Return findings in the standard format.
```

**Bugs scanner** — `shipyard:shipyard-review-bugs`
```
Run a logic bug review on this sprint's changes.
Diff command: <your diff range>
Scope: <all code files>
Look for: off-by-one, null/undefined handling, type confusion, race conditions, resource leaks, wrong operators.
Confidence ≥ 80 only. Return findings in the standard format.
```

**Silent failures scanner** — `shipyard:shipyard-review-silent-failures`
```
Run a silent failure review on this sprint's changes.
Diff command: <your diff range>
Scope: <all code files>
Look for: empty catch blocks, swallowed errors, masked failures, missing error propagation.
Confidence ≥ 80 only. Return findings in the standard format.
```

**Patterns scanner** — `shipyard:shipyard-review-patterns`
```
Run a project conventions review on this sprint's changes.
Diff command: <your diff range>
Scope: <all code files>
Load all project rules from .claude/rules/ and <SHIPYARD_DATA>/codebase-context.md before reviewing.
Look for: constitution violations, learnings violations, codebase pattern deviations, duplication, dead code, magic numbers.
Confidence ≥ 80 only. Return findings in the standard format.
```

**Tests scanner** — `shipyard:shipyard-review-tests`
```
Run a test quality review on this sprint's changes.
Diff command: <your diff range>
Scope: <test files>
Cross-reference with implementation files: <code files>
Look for: critical path coverage gaps, weak assertions, missing edge cases, brittle tests, missing error path tests.
Confidence ≥ 80 only. Return findings in the standard format.
```

**Spec scanner** — `shipyard:shipyard-review-spec`
```
Run a spec compliance review on this sprint's changes.
Diff command: <your diff range>
Feature: <feature ID>
Spec file: <SHIPYARD_DATA>/spec/features/<feature>.md
Reference files: <if any>
Task spec files: <SHIPYARD_DATA>/spec/tasks/T-<feature>-*.md
Implementation files: <code files>
Look for: missing acceptance criterion implementation, over-building, interface contract violations.
Confidence ≥ 80 only. Return findings in the standard format.
```

### Output contract

Every scanner returns:
```
SCANNER: <name>
FILES_REVIEWED: <count>
TRUNCATED: false
FINDINGS:
- file: path/to/file.py
  line: 42
  category: <category>
  severity: must-fix | should-fix | consider
  confidence: <0-100>
  summary: <one line>
  evidence: <code snippet>
- file: ...
```

**Truncation fields** (required — scanner agents MUST report these):
- `TRUNCATED: true|false` — whether any findings were dropped due to the 32k output cap
- `DROPPED_COUNT: <N>` — number of findings dropped (0 if not truncated). Only present when `TRUNCATED: true`.
- `FILES_NOT_REVIEWED: [file1.py, file2.py]` — files that could not be reviewed due to output pressure. Only present when `TRUNCATED: true`. The orchestrator spills these into the next batch round.

Empty findings (`FINDINGS: []`) are normal. Don't treat empty as an error. `TRUNCATED: false` with empty findings means the scanner reviewed everything and found nothing — that's a clean pass.

---

## Phase 3 — Aggregation & Deduplication

After all batch rounds complete (all scanners have reviewed all their files or hit the spillover cap):

1. **Collect all findings** from all scanners across all rounds into a single list
2. **Normalize** to `{file, line, category, severity, confidence, summary, evidence, source_scanner}`
3. **Dedupe** — group by `(file, line)`. If multiple scanners flagged the same line:
   - Keep the highest-confidence one
   - Add `also_flagged_by: [scanner names]` to the kept finding
   - Promote severity to the highest among all flagging scanners
4. **Sort** by severity (must-fix → should-fix → consider) then confidence (descending)

You hold the full aggregated list in context. Wave-1 scanners cannot see each other's output — only you can.

---

## Phase 4 — Wave 2: Conditional Deep-Dive

For findings that need verification, spawn `shipyard:shipyard-investigator`. This is conditional — most findings don't need wave 2.

### Escalation criteria

Spawn an investigator if **any** of these are true:

- `severity: must-fix` AND `confidence < 95`
- `category` ∈ `[security, sql-injection, command-injection, path-traversal, auth-bypass, crypto, deserialization, race-condition, data-loss]`
- Two or more scanners flagged the same `(file, line)` (suspicious convergence — verify)
- Finding mentions a function called from multiple places (impact unclear from line alone)

**Skip wave 2 for `should-fix` and `consider` findings unless they're security-flagged.** The investigator is opus and expensive — use it where being wrong matters most.

### Investigator dispatch

Spawn investigators in PARALLEL (single message, multiple Agent calls), one per finding to escalate:

```
Investigate this code review finding. Confirm or refute it with evidence.
Finding:
  file: <path>
  line: <number>
  category: <category>
  summary: <summary>
  evidence: <code snippet from scanner>
Diff command: <your diff range>
```

### Apply investigator results

After investigators return their verdicts:
- **confirmed** → keep the finding, attach the IMPACT to it
- **refuted** → drop the finding entirely
- **partial** → keep but downgrade severity by one level (must-fix → should-fix → consider)

---

## Phase 5 — Final Report

Use the standard two-section output format. Write the result to `<SHIPYARD_DATA>/sprints/current/CODE-REVIEW.md`:

```
VERDICT: approve | must-fix | needs-discussion
COUNTS: [N] must-fix, [N] should-fix, [N] consider
---ACTIONABLE---
M1. [file:line] — [category] — [summary]. Fix: [recommendation]
M2. ...
S1. ...
```

Rules:
- VERDICT and COUNTS on lines 1 and 2 — these are the only lines the parent skill reads to decide whether to trigger the fixer
- `---ACTIONABLE---` separator — everything below is for the fixer agent
- M = must-fix, S = should-fix
- One line per finding
- No consider items in the actionable section
- No confidence scores in the actionable section (already filtered ≥80)

---

## Why parallel matters

Six sequential reviews of the same diff would consume ~6× the wall-clock time and saturate one context. Six parallel reviews finish in the time of one and each gets a fresh 200k context to work in.

The orchestrating skill (you) holds the aggregated picture in opus[1m] context. Each scanner holds its own narrow slice. Total tokens spent goes up vs the old monolithic reviewer, but:

1. The old reviewer was running out of context — it was a hard failure
2. Parallel finishes faster
3. Each scanner is more focused → higher quality findings
4. Wave 2 only fires for findings that matter → opus reasoning is rationed

The cost increase is the price of fixing the context exhaustion bug AND improving review quality at the same time.
