---
name: ship-debug
description: "Systematic debugging with persistent state that survives session breaks and /clear. Use when the user reports a bug, something isn't working, tests are failing, they're stuck on an error, or they want to investigate unexpected behavior. Also use when the user says 'debug', 'investigate', 'why is this broken', or 'help me fix this'."
allowed-tools: [Read, Write, Edit, Grep, Glob, LSP, AskUserQuestion, EnterPlanMode, ExitPlanMode, "Bash(shipyard-context:*)", "Bash(shipyard-logcap:*)", "Bash(shipyard-data:*)"]
model: sonnet
effort: high
argument-hint: "[description of the problem] [--resume]"
---

# Shipyard: Persistent Debugger

Systematic debugging that doesn't lose progress when context compacts or sessions break.

## Context

!`shipyard-context path`

!`shipyard-context list debug-sessions`
!`shipyard-context view config 5`

**Paths.** All file ops use the absolute SHIPYARD_DATA prefix from the context block. No `~`, `$HOME`, or shell variables in `file_path`. No bash invocation of `shipyard-data` or `shipyard-context` — use Read / Grep / Glob.

## Input

$ARGUMENTS

## Detect Mode

- `--resume` or existing debug file referenced → Resume existing session
- Description of a problem → Start new session
- No args → List active debug sessions, then AskUserQuestion: "Which session to resume? (pick an ID, or describe a new problem to start a fresh session)"

---

## Why Persistent State Matters

Claude's auto-compaction and `/clear` wipe conversation history. Without a debug file, you'd re-investigate dead ends, lose evidence, and forget what was eliminated. The debug file IS the debugging brain — it contains everything needed to resume perfectly.

## New Debug Session

### Step 1: Create Debug File

Generate a slug from the problem description. Use the Write tool to create `<SHIPYARD_DATA>/debug/[slug].md` (substitute SHIPYARD_DATA from the context block):

```markdown
---
status: gathering
trigger: "[verbatim user input]"
created: [ISO timestamp]
updated: [ISO timestamp]
---

# Debug: [short title]

## Symptoms
- **Expected:** [what should happen]
- **Actual:** [what happens instead]
- **Error:** [error message if any]
- **Repro:** [steps to reproduce]
- **Started:** [when did this start / what changed]

## Evidence
[Facts discovered during investigation — APPEND ONLY, never delete]

## Eliminated
[Hypotheses disproved with evidence — APPEND ONLY, prevents re-investigating after /clear]

## Current Focus
- **Hypothesis:** [what we think is wrong]
- **Test:** [how we're testing this hypothesis]
- **Expecting:** [what we expect to see]
- **Next:** [exact next action to take]

## Resolution
- **Root cause:** [TBD]
- **Fix:** [TBD]
- **Verification:** [TBD]
- **Files changed:** [TBD]
```

### Step 2: Gather Symptoms

AskUserQuestion (if not already clear from their input):
"To debug this, I need a few details:
1. What did you expect to happen?
2. What actually happens?
3. Any error messages?
4. When did this start / what changed recently?"

Update the Symptoms section. Set status → `investigating`.

### Step 2.5: Pattern Analysis

Before forming hypotheses, ground your investigation in the codebase. Find working code similar to the broken behavior and compare.

**LSP-first code intelligence:** Use LSP before Grep/Read for all code navigation — it's faster and uses fewer tokens. `goToDefinition` to find symbol sources, `findReferences` to map usage, `incomingCalls`/`outgoingCalls` to trace call chains, `hover` for type info. If LSP isn't available or returns nothing, fall back to Grep/Read silently. See `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/lsp-strategy.md` for the full pattern.

1. **Find working examples** — Grep/Glob for similar code paths, patterns, or components that work correctly. If a login flow is broken, find another auth flow that works. If a database query fails, find a similar query that succeeds.
2. **Compare working vs broken** — read both implementations side by side. List EVERY difference, however small:
   - Different imports, dependencies, or versions
   - Different config, env vars, or feature flags
   - Different call patterns, argument order, or return handling
   - Different error handling or fallback behavior
3. **Check assumptions** — what does the working code rely on that the broken code might be missing?
   - Database state, migrations, seed data
   - Environment variables or config files
   - External service availability or API versions
   - Initialization order or timing
4. **Record findings** — APPEND differences and observations to `## Evidence` in the debug file. These differences directly seed your first hypothesis in Step 3.

If no similar working code exists in the codebase, skip to Step 3 — but note in Evidence: "No comparable working pattern found in codebase."

### Step 3: Investigate

Follow the scientific method:

1. **Form hypothesis** — based on symptoms and evidence
2. **Design test** — a specific check that will confirm or eliminate the hypothesis
3. **Run test** — execute the check (read code, run command, check logs). **Every command run goes through `shipyard-logcap`.** Never invoke a test runner, reproduction script, or diagnostic command directly — wrap it:
   ```
   shipyard-logcap run <debug-slug>-iter<N> -- <command>
   ```
   Where `<debug-slug>` is the slug from the debug file name (`<SHIPYARD_DATA>/debug/<slug>.md`) and `<N>` is the hypothesis iteration counter (starts at 1, increments for each hypothesis you test). Example: `shipyard-logcap run auth-timeout-iter3 -- npm run test:e2e auth/login`.

   **Why this is non-negotiable for debug sessions:** debug sessions are the canonical "re-run expensive things to gather one more signal" workflow, and context compaction mid-investigation is common (long sessions, many hypotheses, `/clear` between steps). If you run commands directly, the output is lost to compaction and the next `/ship-debug --resume` has to re-run everything to see what happened. With logcap, every prior iteration's output is on disk, named by hypothesis iter, and `shipyard-logcap grep <debug-slug>-iter2 "Expected"` is a sub-second re-read instead of a multi-minute re-run.

   **For long-running streams** (dev servers, watch mode, `adb logcat`, tail -f equivalents), logcap handles signal forwarding so `Ctrl-C` propagates cleanly, and line-boundary rotation keeps `grep` context intact across rotation. See `skills/ship-execute/references/live-capture.md` for the decision table on `--max-size` / `--max-files` bounds per workload class.
4. **Record result**:
   - If hypothesis eliminated → APPEND to `## Eliminated` with evidence AND the logcap capture name so it's reproducible: `eliminated: <hypothesis> | evidence: <summary> | capture: <debug-slug>-iter<N>`
   - If evidence found → APPEND to `## Evidence` with the capture name: `finding: <what> | capture: <debug-slug>-iter<N> | line_refs: <file:line>`
   - If root cause found → update `## Resolution` and reference the final capture that proved it
5. **Update Current Focus** — overwrite with next hypothesis and next action
6. **Repeat** until root cause found

Update the debug file after EVERY step. This is critical — if context compacts mid-investigation, the file is the only record. The logcap captures are the *evidence* backing the file's claims — together they form a resumable audit trail.

**Fix attempt tracking:** When you reach Step 4 and apply a fix that doesn't work, increment `fix_attempts` in the debug file's `## Current Focus` section. Track what each attempt changed and why it failed. After **3 failed fix attempts** (actual code changes applied and verified to not work — not hypotheses eliminated):

1. **STOP** — do not attempt fix #4
2. **Check the pattern** — did each fix reveal a new problem in a different place? That's a sign of architectural/structural issues, not a simple bug.
3. **AskUserQuestion:**
   "3 fix attempts failed — each revealing issues in different areas. This may be an architectural problem, not a bug.

   1. Redesign — step back and rethink the approach (discuss architecture)
   2. One more attempt — I have a specific theory for why the previous fixes failed
   3. Get help — describe the problem so you can assist

   Recommended: 1 — repeated fix failures usually mean the pattern is wrong"
4. Record the escalation in `## Evidence`: "Escalated after 3 failed fixes: [summary of what each attempt revealed]"

### Step 3.5: Present Fix Plan — Plan Mode

Once root cause is identified, present the diagnosis and proposed fix for approval before changing any code. Debug fixes can touch production-critical code — the user should see the plan first.

**Enter plan mode** (`EnterPlanMode`) and present:

**DIAGNOSIS**
- Root cause: [what's actually wrong]
- Evidence: [key findings that confirm this — quote from Evidence section]
- Eliminated: [N] hypotheses ruled out

**PROPOSED FIX**
- Approach: [what will change and why]
- Files to modify: [exact paths]
- Blast radius: [what else could be affected by this change]
- Regression test: [what test will prevent this from recurring]

**RISK**
- Confidence: [HIGH/MEDIUM/LOW that this is the correct root cause]
- If wrong: [what happens, how we'd know, what to try next]

**Exit plan mode** (`ExitPlanMode`) — triggers built-in approval flow:
- **Approve** → proceed to Step 4 (apply the fix)
- **Adjust** → user modifies the approach, iterate
- **Investigate more** → return to Step 3 with a new hypothesis

### Step 4: Fix

Once root cause is identified and fix plan is approved:

**Planning-session mutex check** — before writing code, use the Read tool on `<SHIPYARD_DATA>/.active-session.json`. Parse the JSON if it exists. If `cleared` is not set, `skill` is not null, AND `started` is less than 2 hours ago, **hard block**:
```
⛔ Planning session active — cannot apply debug fix.
  Skill:   /{skill from file}
  Topic:   {topic from file}
  Started: {started from file}

A discussion or sprint planning session is in progress. Finish or pause it first.
If the planning session crashed: /ship-status (will offer to clear the stale lock)
```
Do not proceed. If `cleared` is set, `skill` is null, or `started` is more than 2 hours ago, treat the planning session as inactive — print "(recovered stale planning lock from `/{previous skill}`)" if the lock was stale, then continue to the execution lock check below. The investigation phases (Steps 1-3) are read-only and don't need this check; only the fix-application phase does.

**Execution lock check** — before writing code, use the Read tool on `<SHIPYARD_DATA>/.active-execution.json`. Parse the JSON. If `cleared` is not set AND `started` is less than 2 hours ago, **hard block**:
```
⛔ BLOCKED: Another execution session is active.
  Skill: [skill name]
  Started: [timestamp]

Finish or pause the active session first, then apply the debug fix.
If the other session crashed or was closed: /ship-status (will ask to clear the lock)
```
Do not proceed. Do not offer an override. If no lock exists, the lock has `cleared` set, or the lock is stale → use the Write tool to write a new lock JSON `{"skill": "ship-debug", "task": "[debug slug]", "started": "[ISO]"}` while fixing. When done, use Write to overwrite the lock with `{"skill": null, "cleared": "<iso>"}` (soft-delete sentinel).

1. Set status → `fixing`
2. Write the fix (follow project patterns)
3. Write a regression test that fails without the fix
4. **Run tests to verify via `shipyard-logcap run <debug-slug>-fix -- <test-command>`**. The capture is the proof the fix worked — referenced in `## Resolution.verification`.
5. Update `## Resolution` with root cause, fix description, files changed, and the verification capture name.

### Step 5: Verify

1. Set status → `verifying`
2. **Run the reproduction steps via `shipyard-logcap run <debug-slug>-verify-repro -- <repro-command>`** — the bug should no longer reproduce. The capture proves it; a naked "I ran the repro and it's fixed" claim is exactly what the logcap wrapper prevents (silent-pass failure mode, identical to the operational-task silent-pass bug).
3. **Run tests for the affected feature via `shipyard-logcap run <debug-slug>-verify-tests -- <test-command>`** — all should pass.
4. Update `## Resolution.verification` with results AND the two capture names so the resolution is independently verifiable.

### Step 5.5: Defense-in-Depth

After the regression test passes, harden the surrounding code to make this class of bug structurally impossible. Add validation at the layers the bad data passed through:

| Layer | Purpose | When to apply |
|---|---|---|
| 1. Entry-point validation | Reject invalid input at the API/function boundary with a clear error | Simple bugs and up |
| 2. Business-logic guard | Assert the specific bad condition at the processing layer | Data flow bugs and up |
| 3. Environment guard | Guard for the context where the bug appeared (prod-only, config-specific) | Production incidents |
| 4. Debug instrumentation | Log relevant state at the failure point so future occurrences are immediately visible | Production incidents, security bugs |

Apply only what fits the bug. A typo fix needs zero. A security bug always needs all four.

Commit defense-in-depth additions separately: `fix(debug): add validation layers for [bug description]`

Update `## Resolution` in the debug file with what layers were added and where.

### Step 6: Close

1. AskUserQuestion: "Fix verified. Does this resolve the issue?"
2. If yes: set status → `resolved` in the debug file's frontmatter (Edit in place — do not move). The `reap-obsolete` housekeeping will physically reap resolved debug files after the retention period.
3. If related to a sprint task, update PROGRESS.md
4. If this was a hotfix, suggest: "Create a bug report with /ship-bug --hotfix for proper tracking?"

---

## Resume Debug Session

When `--resume` is passed or an existing debug file is referenced:

1. Read the debug file
2. Parse frontmatter → know current status
3. Read `## Current Focus` → know exactly what was happening
4. Read `## Eliminated` → know what NOT to re-investigate
5. Read `## Evidence` → know what's been learned
6. Continue from `Next` action in Current Focus

Tell the user: "Resuming debug session: [title]. Last focus: [hypothesis]. [N] hypotheses eliminated. Continuing with: [next action]."

---

## Section Mutability Rules

These rules prevent losing progress across context resets:

| Section | Rule | Why |
|---------|------|-----|
| Symptoms | Write once, never change | Preserves original report |
| Evidence | Append only, never delete | Builds the case |
| Eliminated | Append only, never delete | Prevents re-investigating dead ends |
| Current Focus | Overwrite each step | Always reflects current state |
| Resolution | Overwrite as understanding evolves | Refined until final |

## Size Management

Debug files can bloat during complex investigations. Keep them useful, not exhaustive:

- **Evidence & Eliminated entries**: 1-2 lines each, not paragraphs
- **Soft limit: 150 lines per debug file.** If approaching this:
  1. Summarize older Evidence entries into a single "Summary of findings so far" line
  2. Collapse Eliminated section — replace individual entries with: "Eliminated [N] hypotheses: [one-line list]. See `<SHIPYARD_DATA>/debug/[slug]-investigation-log.md` for details."
  3. Use the Write tool to put verbose investigation details in `<SHIPYARD_DATA>/debug/[slug]-investigation-log.md`
  4. Keep Current Focus and Resolution in the main file (these are what matters for resume)

The debug file is a resume-point, not a novel. Future-you needs: what's proven, what's eliminated, what to try next.

## Rules

- Update the debug file after EVERY investigation step — it's the persistent brain
- Never re-investigate an eliminated hypothesis
- If stuck after 5 hypotheses eliminated → AskUserQuestion with summary of what was tried
- Keep the debug file concise — evidence and eliminations should be 1-2 lines each
- If the problem is simple (obvious error, typo), skip the full process — just fix it

### Red Flags — STOP and Return to Process

If you catch yourself thinking any of these, STOP immediately and return to Step 2.5 (Pattern Analysis) or Step 3 (Investigate):

| Thought | What it means | Do instead |
|---------|--------------|------------|
| "Just one quick fix" | Skipping investigation | Return to Step 2.5 |
| "It's probably X, let me fix that" | Unverified hypothesis | Form hypothesis in Step 3, design a test |
| "I'll write the test after confirming the fix works" | Skipping TDD | Write the test first (Step 4.3) |
| "One more attempt" (after 2+ failures) | Fix-thrashing | Check fix attempt counter, escalate at 3 |
| "I don't fully understand but this might work" | Guessing | Research more in Step 2.5 |
| "Multiple changes at once to save time" | Can't isolate what works | One variable at a time (Step 3) |
| Proposing fixes before tracing data flow | Treating symptoms | Return to Pattern Analysis |

## Next Up (after debug resolved)

```
▶ NEXT UP: Resume where you left off
  /ship-execute — if mid-sprint
  /ship-status — to check what's pending
  (tip: /clear first for a fresh context window)
```
