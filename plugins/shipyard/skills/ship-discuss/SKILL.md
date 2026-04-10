---
name: ship-discuss
description: "Feature discovery — from quick idea capture to full spec with acceptance criteria. Use when the user mentions a new feature, a 'what if', a 'we should also', wants to discuss requirements, brainstorm, refine an existing feature, explore what to build next, define acceptance criteria, or jot down something for later."
allowed-tools: [Read, Write, Edit, Grep, Glob, LSP, Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode, WebSearch, WebFetch, "Bash(shipyard-context:*)"]
model: opus
effort: high
argument-hint: "[topic, feature ID, or quick idea]"
---

# Shipyard: Feature Discussion

You are facilitating a feature discovery conversation. This is fluid — not a questionnaire.

## Context

!`shipyard-context path`

!`shipyard-context view config`
!`shipyard-context view codebase`
!`shipyard-context list epics`
!`shipyard-context list features`

**Paths.** All file ops use the absolute SHIPYARD_DATA prefix from the context block. No `~`, `$HOME`, or shell variables in `file_path`. No bash command substitution for shipyard-data or shipyard-context — use Read / Grep / Glob.

## Input

$ARGUMENTS

## Session Mutex Check

**Absolute first action — before reading any context, before mode detection, before anything.** Use the Read tool on `<SHIPYARD_DATA>/.active-session.json` (substitute the literal SHIPYARD_DATA path from the context block above). Then decide:

- **File does not exist** → no other planning session is active. Proceed to "Session Guard" below.
- **File exists.** Parse the JSON and check three fields:
  1. If `cleared` is set OR `skill` is `null` → previous session ended cleanly (soft-delete sentinel). Proceed.
  2. If `started` timestamp is more than 2 hours old → stale lock (probably a crashed session). Print one line to the user: "(recovered stale lock from `/{previous skill}` started {N}h ago)". Proceed.
  3. Otherwise → **HARD BLOCK.** Another planning session is active. Print this message as the entire response and STOP — do not continue with any other instructions, do not load any context, do not call any other tools:

  ```
  ⛔ Another planning session is active.
    Skill:   /{skill from file}
    Topic:   {topic from file}
    Started: {started from file}

  Concurrent planning sessions can corrupt the spec and lose research notes.
  Finish or pause the active session first.

  If the other session crashed or was closed:
    Run /ship-status — it will offer to clear the stale lock.
  ```

This is a Read+Write mutex. There is a small theoretical race window between the Read and the Write below, but in practice two human-typed `/ship-discuss` invocations cannot collide within milliseconds.

## Session Guard

**Second action — only if the mutex check above said proceed:** Use the Write tool to write `.active-session.json` to the SHIPYARD_DATA directory (use the full literal path from the context block — e.g., `/Users/x/.claude/plugins/data/shipyard/projects/abc123/.active-session.json`). This both claims the mutex (overwriting any stale or cleared marker) AND prevents post-compaction implementation drift:

```json
{
  "skill": "ship-discuss",
  "topic": "[user's topic or feature ID from $ARGUMENTS]",
  "started": "[ISO date]"
}
```

This file activates a PreToolUse hook that blocks source code writes. If you find yourself wanting to write implementation code, STOP — you are in a discussion, not an execution session.

## Detect Mode

- If input is an **epic ID** (E001) → **EPIC mode** (refine epic scope, cascade changes to features)
- If input is an **idea ID** (IDEA-NNN) → **IDEA mode** (convert idea to feature — see below)
- If input is a **feature ID** (F001) → **REFINE mode** (load existing, gather updates)
- If input is a **triage phrase** — phrases like "anything requires discussion", "anything requires discussion?", "what's open", "what needs discussion", "what needs attention", "what's pending", "what needs refinement", "anything else", "discuss anything", "what else", "any ideas", "any ideas to discuss", "what ideas" → **TRIAGE mode** (see below)
- If input is a **short one-liner** (under ~20 words, no questions, no detail) → **CAPTURE mode** (quick idea, zero ceremony)
- If input describes something **large** (multiple features implied, a whole product area) → offer: "This sounds like an epic — multiple features under one initiative. Discuss as an epic, or start with the first feature? (epic / feature)"
- If input is a **detailed topic** or the user is asking questions → **NEW mode** (start fresh conversation)
- If no input → AskUserQuestion: "What would you like to discuss?"

### TRIAGE Mode: Surface what needs discussion

When the user asks "anything requires discussion" or similar:

1. Use Grep with `pattern: ^status: proposed`, `path: <SHIPYARD_DATA>/spec/features`, `glob: F*.md`, `output_mode: files_with_matches` to find features still at `status: proposed`. For each match, Read the file and extract `id`, `title`, `story_points`, and acceptance criteria count.
2. Use Glob `<SHIPYARD_DATA>/spec/ideas/IDEA-*.md` to enumerate idea files. For each, Read the file, parse frontmatter, and skip any with `status: graduated` or `status: rejected`.
3. Present the result as a compact triage list:
   ```
   Items needing discussion:

   PROPOSED FEATURES (refine acceptance criteria, estimate, decide):
     [1] F012 — Payment Analytics (proposed, 0 pts, 0 scenarios)
     [2] F015 — Split Payments (proposed, 8 pts, 2 scenarios)

   IDEAS (capture-only — flesh out into features):
     [3] IDEA-007 — Magic-link auth (captured 2026-03-12)
     [4] IDEA-009 — Bulk export to CSV (captured 2026-03-21)
   ```
4. AskUserQuestion: "Pick a number to discuss, or type 'all proposed' to walk through every proposed feature, or 'done' to exit triage."
5. On selection, jump into the appropriate mode (REFINE for a feature, IDEA for an idea). Do not run any bash commands and do not improvise pipelines — every list item came from native Read/Grep/Glob calls above.

If both lists are empty: "Nothing currently needs discussion. The proposed-feature queue is empty and there are no captured ideas. Run /ship-discuss with a topic to start something new."

---

### Compaction Recovery

If you lose context mid-discussion (e.g., after auto-compaction):

1. Use the Read tool on `<SHIPYARD_DATA>/spec/.research-draft.md`. If it exists, parse its frontmatter — if `obsolete: true` is set, treat it as absent (skip to step 2). Otherwise:
   - If found and `topic:` matches → research and challenge phases completed. Read it for findings. Resume from Phase 2 (Viability Gate)
   - If found but its `topic:` doesn't match the current discussion topic → AskUserQuestion: "A previous discussion left unfinished research on '[topic]'. Mark it obsolete and start fresh on your current topic? (mark obsolete / keep and resume that topic instead)"
     - **mark obsolete**: use Edit to set `obsolete: true` in the draft's frontmatter, proceed fresh into Phase 1.5 (Research) for the current topic
     - **keep**: Switch to the old topic. Read `topic:` from `.research-draft.md`, load its research findings, and resume from Phase 2 (Viability Gate) for that topic. Inform the user: "Resuming discussion on [old topic]. To discuss [new topic], run /ship-discuss [new topic] in a new session."
2. Check for feature file matching the topic: use Glob `<SHIPYARD_DATA>/spec/features/F*-*.md` to enumerate, then Read each and match by title against the current topic.
   - If found with empty acceptance criteria → Phase 3 incomplete, resume Phase 3
   - If found with acceptance criteria and `status: proposed` → Phase 3 done, resume from Phase 3.5 (Impact Analysis)
   - If found with `status: approved` but `.active-session.json` still has `skill: ship-discuss` (not cleared) → Phase 6 (Finalize) was interrupted mid-sequence. Read BACKLOG.md: if the feature ID is already listed, resume from Phase 6 step 3 (idea archival) or step 4 (Next Up) depending on whether an idea file still has `status: proposed`. If the feature ID is missing from BACKLOG.md, resume from Phase 6 step 2 (append to BACKLOG.md). Either way, the final session-guard sentinel write still runs last.
3. If neither file exists → pre-research phases only (interactive). AskUserQuestion: "A previous discussion session was interrupted before research completed. Can you summarize what was decided so far?" Resume from Phase 1.5 (Research)

Research findings are the most expensive state to lose (WebSearch/WebFetch results). The research draft file preserves them.

---

## CAPTURE Mode: Quick Idea (zero ceremony)

When the input is a short one-liner — capture it instantly and offer to go deeper.

### Step C1: Create Idea File

Generate the next available IDEA-NNN ID. Write to `<SHIPYARD_DATA>/spec/ideas/IDEA-NNN-[slug].md`:

```yaml
---
id: IDEA-NNN
title: "[title from user's description]"
type: idea
status: proposed
source: "inline capture"
captured: [today's date]
---

# [Title]

## Idea
[User's description, cleaned up slightly but preserving intent]

## Why It Might Matter
[One sentence — your best guess at the value. Keep it brief.]

## Initial Thoughts
[Any immediate technical considerations. One or two bullets max. Skip if nothing obvious.]
```

### Step C2: Offer Depth

```
Captured: IDEA-NNN — [title]

Want to flesh this out into a full feature now, or save it for later?
```

- **"now" / "yes" / user engages** → switch to IDEA mode (Step I1 below) with the just-created IDEA-NNN
- **"later" / "no" / silence** → done. Clean up session guard and exit.

**Rules for CAPTURE mode:**
- Be fast. Don't ask clarifying questions upfront.
- Don't estimate. No RICE, no story points.
- Slug from title — lowercase, hyphens, max 40 chars.
- If called mid-conversation or mid-sprint, capture and return immediately.

---

## EPIC Mode: Discuss at Epic Level

When the input is an epic ID (E001) or the user describes a large initiative.

### Step EP1: Load Epic Context

If existing epic:
1. Use Glob `<SHIPYARD_DATA>/spec/epics/E00N-*.md` (substitute the epic ID), then Read the matching file.
2. Find all features in this epic: use Grep with `pattern: ^epic: E00N`, `path: <SHIPYARD_DATA>/spec/features`, `glob: F*.md`, `output_mode: files_with_matches`, then Read each match.
3. For each feature, read title, status, story points, acceptance criteria count

Present the current state:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 EPIC: E001 — Payment System
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Features (4):
   F003 — Card Payments (done, 8 pts, 5 scenarios)
   F004 — Refund Flow (approved, 5 pts, 3 scenarios)
   F012 — Payment Analytics (proposed, 3 pts, 2 scenarios)
   F015 — Split Payments (proposed, 8 pts, 0 scenarios)

 Total: 24 pts | Done: 8 pts | Remaining: 16 pts
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If new epic (user described a large initiative): create the epic file first, then proceed.

### Step EP2: Epic-Level Discussion

Use AskUserQuestion to understand the direction:
- What's changing about this epic? (scope, priority, direction)
- Any new features to add? Any existing features to remove or split?
- Has the business context changed? (competitor launched, user feedback, pivot)
- Are there cross-feature concerns to address? (shared infrastructure, common patterns, sequencing)

### Step EP3: Cascade Changes to Features

This is the critical step. Based on the discussion, identify changes that need to propagate to features:

**For each affected feature:**

| Change type | What happens |
|---|---|
| **Scope change** | Update feature's acceptance criteria, re-estimate RICE/points |
| **New dependency** | Add to feature's `dependencies:` array (bidirectional) |
| **Priority shift** | Update RICE fields, note in decision log |
| **Acceptance criteria change** | Edit feature file, add decision log entry: "Updated due to epic E00N discussion: [reason]" |
| **Feature removed from epic** | Set `epic: ""` in feature frontmatter, note in decision log |
| **Feature added to epic** | Set `epic: E00N` in feature frontmatter |
| **Feature invalidated** | Set `status: cancelled` in feature frontmatter, note reason in decision log |
| **New feature identified** | Run NEW mode inline to create it, assign to this epic |

**Sprint impact check:** For each modified feature, check if it's in an active sprint. If yes, flag:
```
⚠ F004 (Refund Flow) is in Sprint 3 — 2/4 tasks done.
  Changing acceptance criteria may invalidate completed work.
  Apply now / defer to post-sprint / skip this change
```

### Step EP4: Create New Features (if any)

For each new feature identified during the epic discussion, run the standard NEW mode phases (Phase 1 → 5) with the epic pre-assigned. Bundle related features — discuss all new features before writing any, so dependencies are clear.

### Step EP5: Quality Gate

Review the epic after all changes:

| # | Check | Fail criteria |
|---|---|---|
| 1 | **All features have acceptance criteria** | Any feature in epic has 0 scenarios |
| 2 | **No orphan features** | Features that lost their epic assignment aren't floating unassigned |
| 3 | **Dependencies are consistent** | Feature A depends on B, but B doesn't know about A |
| 4 | **No duplicates within epic** | Two features describe the same behavior |
| 5 | **Epic scope is coherent** | Features in the epic don't logically belong together |

### Step EP6: Wrap Up

Present the changed state:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 EPIC UPDATED: E001 — Payment System
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Changes:
   F004: acceptance criteria updated (3 → 5 scenarios)
   F012: RICE re-estimated (score: 18 → 24)
   F015: split into F015 + F018 (split payments → basic + advanced)
   F018: NEW — Advanced Split Payments (5 pts, 4 scenarios)

 Sprint impact:
   F004 is in Sprint 3 — changes deferred to post-sprint

 Features (5):
   F003 — Card Payments (done)
   F004 — Refund Flow (approved, updated)
   F012 — Payment Analytics (proposed, re-estimated)
   F015 — Basic Split Payments (proposed, scoped down)
   F018 — Advanced Split Payments (proposed, NEW)

 Total: 29 pts | Done: 8 pts | Remaining: 21 pts
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

AskUserQuestion: "Approve these changes? (yes / adjust / revert all)"

---

## IDEA Mode: Convert Idea to Feature

When the input is an idea ID (IDEA-NNN), the goal is to graduate it into a proper feature. This is NEW mode with the idea pre-loaded as seed context — not REFINE mode.

### Step I1: Load Idea

Read `<SHIPYARD_DATA>/spec/ideas/IDEA-NNN-[slug].md`. Extract:
- Title and description
- "Why It Might Matter" section
- Any initial thoughts

Present it briefly to the user as plain text:
```
Idea: IDEA-NNN — [title]
[description]
[why it might matter]
```

### Step I2: Seed NEW Mode

Pass the idea content as context into the full NEW mode flow (Phases 1 → 6), starting at Phase 1. The idea's description pre-answers some of Phase 1's questions — skip what's already clear, focus AskUserQuestion on genuine unknowns.

Run all phases in sequence: Phase 1 (Understand) → Phase 1.5 (Research) → Phase 1.5b (Challenge & Surface) → Phase 2 (Viability Gate) → Phase 3 (Write to Spec as FNNN) → **Phase 3.5 (Impact Analysis)** → **Phase 3.7 (Simplification Scan)** → Phase 4 (Capture tangential ideas) → Phase 5 (Spec Approval Gate) → Phase 6 (Finalize).

Impact Analysis (Phase 3.5) runs as normal — it scans existing features for dependencies, overlaps, conflicts, and invalidations caused by the new feature, and uses AskUserQuestion to confirm what to apply.

### Step I3: Mark the Idea as Graduated

Idea archival happens inside Phase 6 (Finalize), between the BACKLOG.md append and the session-guard cleanup — not here and not as a standalone step. The graduation target is:
```
<SHIPYARD_DATA>/spec/ideas/IDEA-NNN-[slug].md
```

When Phase 6 runs for an idea-sourced feature, after appending to BACKLOG.md, use the Edit tool to set the idea file's frontmatter to `status: graduated` and add `graduated_to: FNNN`. Confirm: "IDEA-NNN has been graduated to [FNNN: title]." Doing the Edit inside Phase 6 keeps it inside the session-guard window. Listings filter `status: graduated` ideas out by default; the `reap-obsolete` housekeeping reaps them physically after retention.

---

## NEW Mode: Discover Features

### Phase 1: Understand

**Read the discovery techniques:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/discovery-techniques.md` — contains JTBD, user journey mapping, pre-mortem, ISO 25010 quality characteristics, ATAM tradeoff analysis, EARS syntax, and IEEE 830 completeness checks. Apply these throughout Phases 1-3.

**Communication design:** When surfacing something the user hasn't considered, use the 3-layer pattern from `references/communication-design.md` — one-liner (what + recommendation), context (why it matters, tradeoff, analogy if helpful), detail (only for high-stakes). Max 3–4 new concepts and 2–3 options per question. Under 100 words per decision message. Name the tradeoff on each option. Always recommend a default.

Have a natural conversation about the topic. **Always use AskUserQuestion — never plain text — to ask questions.** AskUserQuestion suspends execution and waits for input; plain text does not. Bundle related questions into a single call. Key topics to cover (combine where natural):
- Who are the users? What roles/permissions?
- What's the core behavior? What should happen?
- What's the business value? Why does this matter?
- Any constraints, compliance, or technical requirements?
- **JTBD**: What job is the user hiring this feature for? What are they doing today without it? What functional/emotional/social dimensions? What adjacent jobs happen before/after?
- **Journey**: What triggers usage? What's the full before/during/after flow? Where can they abandon?

**Key behaviors during conversation:**
- **Splitting:** If the user describes multiple distinct features, use AskUserQuestion: "I'm hearing two things: [X] and [Y]. Want to capture them separately?"
- **Branching:** If something tangential comes up, capture it as an idea inline and state it as plain text: "That's a good point — I'll capture that as IDEA-NNN. Let's stay focused on [current topic]." (This is a statement, not a question — no AskUserQuestion needed.)
- **Referencing:** If it relates to an existing feature, use AskUserQuestion: "This connects to F003 — should we extend that or keep this separate?"
- **Parking:** If user says "not now" about something, record it in the decision log as deferred with their reasoning.

### Phase 1.5: Research

Once you understand what the user wants, research before challenging. Walk this in order. **Use LSP first** for code navigation; fall back to Grep/Read silently.

1. **Constitution check.** Glob `.claude/rules/project-*.md` and `.claude/rules/learnings/*.md`, read every match. Extract architecture boundaries, banned patterns, naming conventions, domain vocabulary, shared utilities. Flag tensions with the proposed feature as pre-loaded Phase 1.5b challenge items. Skip silently if no `project-*.md` files exist.

2. **Internal research.** Glob `<SHIPYARD_DATA>/spec/features/F*.md` and Read each to find overlaps. Use LSP `documentSymbol` / `findReferences` for relevant codebase patterns. Read `<SHIPYARD_DATA>/codebase-context.md` for stack constraints.

3. **How others solve it.** WebSearch how established products handle this same problem, the standard UX patterns users expect, and open-source implementations to study. WebSearch common user complaints about existing solutions to learn from their mistakes. WebSearch best practices and security pitfalls for the domain (include the current year for currency). WebFetch official docs for mentioned libraries/APIs.

**Write findings to the feature file `## Technical Notes`** (after Phase 3 creates it) with this structure:

```markdown
## Technical Notes

### Research Findings

**How others do it**
- [Product/project] — [how they solve this, what we can learn] (confidence: HIGH/MEDIUM)
- [Open-source repo] — [relevant approach or pattern] (confidence: HIGH/MEDIUM)
- [Common user complaints about existing solutions] — [what to avoid]

**Relevant docs**
- [URL] — [why it matters] (confidence: HIGH)

**Codebase patterns to follow**
- [file path] — [what pattern to mirror]

**Constitution constraints**
- [rule from project-*.md] — [how it applies to this feature]

**Known gotchas**
- [pitfall] — [how to avoid] (confidence: HIGH/MEDIUM/LOW)

**Recommended approach**
- [prescriptive direction — "Use X" not "Consider X or Y"]
```

Confidence levels: **HIGH** = verified in official docs or codebase. **MEDIUM** = multiple sources agree but not officially verified. **LOW** = single source or AI knowledge only.

Be prescriptive: "Use X" not "Consider X or Y". The builder needs decisions, not options.

Fold findings into the conversation naturally before challenging: "I looked into how other apps handle this — most use [X] because [Y]. That aligns with what you're describing."

**Visual context:** If the feature spans multiple services, external APIs, or touches multiple parts of the architecture, show a C4 diagram (Context or Container level) so the user can see where it fits. If it involves 3+ components communicating in sequence, show a sequence diagram to make the interaction flow visible. See `references/communication-design.md` for C4 and sequence diagram patterns. Skip for features that live entirely within one component.

### Phase 1.5b: Challenge & Surface

Once you have a reasonable understanding of the feature, **proactively challenge it** before moving to spec. Delegate the heavy methodology pass to a `shipyard-discovery-scout` subagent so you keep the user dialogue context clean.

**Spawn the scout** (single Agent call):

```
subagent_type: shipyard:shipyard-discovery-scout
prompt: |
  Feature draft: <inline summary of the user's feature so far, OR path to .research-draft.md if it exists>
  Codebase context: <SHIPYARD_DATA>/codebase-context.md
  Project rules: .claude/rules/project-*.md

  Apply the four methodology references — references/challenge-surface.md,
  references/edge-case-framework.md, references/nfr-scan.md,
  references/failure-modes.md — and return your structured findings list.
```

The scout reads the methodology files and returns a `DISCOVERY SCOUT REPORT` with grouped findings (challenges / edge cases / NFRs / failure modes). You hold the report; the methodology files never enter your context. Also run a quick pre-mortem (from `discovery-techniques.md`) — that one is short enough to do inline.

**Presentation:** Follow `references/communication-design.md`. Max 3–4 items per AskUserQuestion; batch into themed groups of 3 if more. For each item: what I found → why it matters → what I recommend. Use the 3-layer pattern for anything genuinely surprising. Compact visual summary before the AskUserQuestion:

```
  ⚠️  [Finding]           → [impact], recommend [action]
  ⚠️  [Finding]           → [impact], recommend [action]
  ✅  [Finding]           → [status — no action needed]
  ❓  [Finding]           → needs decision
```

**Do not proceed to Phase 2 until grey areas are resolved or explicitly deferred.**

Write research findings and challenge resolutions to `<SHIPYARD_DATA>/spec/.research-draft.md`:

```yaml
---
topic: "[primary topic from user input]"
created: [ISO date]
---
```

Body sections: `## Research Findings` (implementation context, patterns, docs/references, gotchas — same structure as feature Technical Notes), `## Challenge Resolutions` (resolved grey areas, deferred items). This file is absorbed into the feature file's Technical Notes in Phase 3 and then deleted.

### Phase 2: Viability Gate

Before writing to spec, silently evaluate each feature:

1. **USER VALUE** — Can we articulate who wants this and why? → KILL if no clear user story
2. **DEFINABLE** — Can we write testable acceptance criteria (Given/When/Then)? → KILL if too vague
3. **BUILDABLE** — Can we decompose into executable tasks? → KILL if impossible constraints
4. **TESTABLE** — Can we verify with automated tests + demo? → KILL if purely subjective
5. **SCOPED** — Is it one feature, not three in a trench coat? → SPLIT if multiple stories

If viability kills the feature, use the Edit tool to set `obsolete: true` in `<SHIPYARD_DATA>/spec/.research-draft.md`'s frontmatter (soft-delete sentinel — recovery logic filters it out; `reap-obsolete` reaps it later).

If a feature fails a gate, AskUserQuestion — don't block. Frame positively: "This feature needs X to be buildable" not "This feature fails because X is missing."
Example: "I can't write testable acceptance criteria for this yet — the scope is too broad. Can we narrow it to something specific? (narrow it / capture as-is and refine later)"

The user can override: "Just capture it as proposed, we'll refine later."

### Phase 3: Write to Spec

Use the Read tool on `<SHIPYARD_DATA>/spec/.research-draft.md`. If it exists and is not marked `obsolete: true`, absorb its content into the feature file's `## Technical Notes` and `## Decision Log` sections. **Do not mark it obsolete yet** — it serves as a recovery checkpoint until Phase 3 is fully complete (feature file written with acceptance criteria, estimates, and epic assignment). Use Edit to set `obsolete: true` in `.research-draft.md`'s frontmatter only after Phase 3 finishes.

For each well-defined feature:

1. **Generate ID** — Next available FNNN (F001, F002, etc.)
2. **Determine epic** — Use Glob `<SHIPYARD_DATA>/spec/epics/E*.md` to enumerate epics and Read each. Use Grep with `pattern: ^epic:`, `path: <SHIPYARD_DATA>/spec/features`, `glob: F*.md`, `output_mode: content`, `-n: false` to see how features are grouped. Then decide:

   **Does it belong to an existing epic?** Check if the feature:
   - Shares the same user-facing domain (e.g., auth, payments, onboarding)
   - Would be described under the same section of a product overview
   - Depends on or extends features already in an existing epic

   **Should it create a new epic?** Check if:
   - It introduces a new product area not covered by existing epics
   - It involves 3+ features that logically group together (1-2 features don't justify an epic)
   - Existing epics would be diluted by adding unrelated functionality

   **If unclear** — explain the options and AskUserQuestion:
   ```
   This feature touches [domain]. I see two options:

   1. Add to E002 (Payments) — it's related to billing, but the scope is broader
   2. Create new epic "Revenue Analytics" — this is the first of likely 3+ features in this area

   Recommended: 2 — this feels like a distinct product area that will grow
   ```

   **If no epics exist yet** — create the first one if the feature is part of a larger initiative. Otherwise, leave `epic: ""` and let it accumulate. Epics emerge from patterns, don't force them early.

3. **Write feature file** to `<SHIPYARD_DATA>/spec/features/FNNN-[slug].md`.

   **Frontmatter — every field is required. No omissions.**
   ```yaml
   ---
   id: FNNN
   title: ""
   type: feature
   epic: ""               # E00N if assigned, empty string if none
   status: proposed
   story_points: 0        # rough estimate from discussion
   complexity: ""         # low | medium | high
   token_estimate: 0      # estimated total tokens (input+output) to implement this feature. Guide: S task ~50K, M task ~150K, L task ~300K. Sum across expected tasks.
   rice_reach: 0          # 0–10: how many users affected
   rice_impact: 0         # 0–3: massive=3, high=2, medium=1, low=0.5
   rice_confidence: 0     # 0–100: % confidence in reach/impact estimates
   rice_effort: 0         # person-months (use 0.5 for small features)
   rice_score: 0          # computed: (reach × impact × confidence) / effort
   feasibility: 0         # 1–10 from viability gate
   dependencies: []       # feature IDs this depends on
   references: []         # full relative paths: <SHIPYARD_DATA>/spec/references/FNNN-slug.md
   children: []           # sub-feature IDs if split
   tasks: []              # populated during sprint planning
   created: YYYY-MM-DD
   updated: YYYY-MM-DD
   ---
   ```

   **Body sections:**
   - User story ("As a... I want... so that...")
   - Why This Matters (business reasoning)
   - Acceptance criteria in Given/When/Then format (at least 2 scenarios: happy path + one edge case)
   - **Interface** — only if API endpoints, method signatures, or event schemas were discussed. Skip the section entirely if nothing was covered.
   - **Data Model** — only if schema fields, entity relationships, or data constraints were discussed. Skip if not.
   - **Configuration** — only if settings, environment variables, or feature flags were discussed. Skip if not.
   - **Flows** — only if a sequence, state machine, or user journey was discussed. Use Mermaid. Skip if not.
   - **Error Handling** — only if specific failure modes or error responses were discussed. Skip if not.
   - Technical notes (research findings — from `.research-draft.md`)
   - Decision log (decisions made during this discussion)
   - **No inline task table** — tasks are created as separate files in `<SHIPYARD_DATA>/spec/tasks/` and referenced via the `tasks:` array in frontmatter. Preliminary task IDs can be listed during discuss; full task files are created during sprint planning.
   - **Hard limit: 200 lines per file.** If the feature has 10+ acceptance scenarios or extensive technical notes, split it:
     - Split into sub-features (F001a, F001b) for large scenario sets
     - Extract API contracts, data models, wireframes to `<SHIPYARD_DATA>/spec/references/FNNN-<slug>.md`. Add frontmatter to each extracted file: `feature: FNNN` and `source: extracted from FNNN during discuss`.
     - Add full relative paths (e.g., `<SHIPYARD_DATA>/spec/references/F001-api.md`) to the `references:` array in the feature's frontmatter
     - Plan the split BEFORE writing, not after

4. **Initial estimates** — fill every RICE field in the frontmatter written above:
   - Use AskUserQuestion for `rice_reach` and `rice_impact` if not obvious from context
   - Estimate `rice_confidence`, `rice_effort`, `story_points`, `complexity`, `token_estimate`, and `feasibility` yourself based on the discussion
   - Compute `rice_score` = (rice_reach × rice_impact × rice_confidence) / rice_effort
   - No field may be left at 0 or empty without a deliberate reason noted in the decision log

5. **Epic**: If an epic was assigned, set `epic: E00N` in feature frontmatter. Do NOT update the epic file with a features list — epic membership is derived by querying feature files.

### Phase 3.5: Impact Analysis

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/impact-analysis.md`

**Presentation:** Keep impact summaries under 200 words. Bold the single most important finding. Use the 3-layer pattern for any impact that changes existing behavior. Show an impact diagram for features with multiple ripple effects:
```
  F007 (new) ──impacts──▶ F003 (criteria change)
             ──depends──▶ F001 (must be done first)
             ──overlaps─▶ F005 (shared data model)
```

Skip if Glob `<SHIPYARD_DATA>/spec/features/F*.md` returns no results.

### Phase 3.7: Simplification Opportunity Scan

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/simplification-scan.md`

Scan the codebase for places that hand-roll what this feature's new libraries, utilities, or patterns provide. The scan detects five types of opportunities: new dependency replacements, new utility reuse, pattern consolidation, abstraction adoption, and dead code from supersession.

**Skip if:** the feature is purely additive (new endpoint, new UI page) with no reusable infrastructure — nothing introduced that other code could benefit from.

**At discuss time**, the scan operates on the feature's Technical Notes and research findings (not implementation code, which doesn't exist yet). Focus on:
- Libraries referenced in Technical Notes → grep for hand-rolled equivalents
- Patterns decided in the Decision Log → grep for ad-hoc variations
- Shared utilities mentioned in research → grep for inline duplicates

**Routing at discuss time:** All findings become IDEA files (since there's no sprint to fold tasks into yet). The sprint planning step (Step 3.75) will re-evaluate these and promote trivial/small items into sprint tasks if the feature is selected.

Present findings and AskUserQuestion as defined in the protocol. If no opportunities found, move on silently.

### Phase 4: Capture Tangential Ideas

Any tangential features mentioned → create as idea files via the same logic as CAPTURE mode above.

### Phase 4.5: Backlog Re-evaluation

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/backlog-reeval.md`
!`shipyard-context reference ship-discuss backlog-reeval 55`

Skip if BACKLOG.md is empty or doesn't exist.

### Phase 4.9: Quality Gate (self-review loop)

Before presenting to the user, review your own output. Re-read each feature file you wrote and check against this checklist:

| # | Check | Fail criteria |
|---|---|---|
| 1 | **Every acceptance scenario is Given/When/Then** | Vague prose like "user can do X" without structured scenario |
| 2 | **Happy path + at least 1 edge case per feature** | Only happy path covered |
| 3 | **No ambiguous words** | "appropriate", "properly", "as needed", "etc.", "various" in acceptance criteria |
| 4 | **No TBDs or placeholders** | Any "TBD", "TODO", "to be decided", "[fill in]" left in the spec |
| 5 | **User story has clear actor, action, and value** | "As a... I want... so that..." missing any part |
| 6 | **RICE fields all populated** | Any RICE field still at 0 without a reason in the decision log |
| 7 | **Dependencies identified** | Feature touches other features but `dependencies: []` is empty |
| 8 | **Research findings are prescriptive** | "Consider X or Y" instead of "Use X" |
| 9 | **How others do it section populated** | No real-world product references found |
| 10 | **Feature is one feature, not multiple** | Acceptance scenarios describe unrelated behaviors |
| 11 | **NFRs considered** | Feature handles sensitive data or has scale concerns but no NFR notes |
| 12 | **Edge cases covered** | No boundary values, state transitions, or concurrency scenarios |
| 13 | **Failure modes analyzed** | Write operations exist but no failure mode table |
| 14 | **EARS syntax used** | Acceptance criteria use vague language instead of WHEN/WHILE/IF patterns |
| 15 | **All states covered** | Missing empty state, error state, loading state, or offline state |

Iterate the checklist on each feature file, fixing failures (AskUserQuestion when input is needed) and re-running. Max 3 iterations. **Hold the table in mind across iterations — emit only per-iteration deltas (which checks fixed, which remain). Do not re-print the table on each pass.** Flag remaining gaps as "Unresolved — needs follow-up in /ship-discuss [ID]". Then proceed to Phase 4.95.

### Phase 4.95: Adversarial Critique

After the self-review quality gate passes, spawn the critic agent to challenge the spec from angles the self-review doesn't cover — implicit assumptions, feasibility risks, and design decision quality.

**Determine stakes level:**
- `high` if: feature is part of an epic, story_points >= 8, touches auth/payments/data, or has 6+ acceptance scenarios
- `standard` otherwise

**Spawn the critic:**
```
subagent_type: shipyard:shipyard-critic
```

Prompt the critic with:
- Mode: `feature-critique`
- Stakes: `[standard|high]`
- Artifact paths: all feature files written in Phase 3 (full paths)
- Codebase context path: `<SHIPYARD_DATA>/codebase-context.md`
- Project rules: `.claude/rules/project-*.md`

**Process the critic's findings:**

1. Read the `PRIORITY ACTIONS` section — these are mandatory fixes
2. For each FAIL item and HIGH-risk assumption:
   - If fixable without user input → fix the feature file directly (update acceptance criteria, add missing error states, clarify ambiguous text, add noted dependencies)
   - If requires user judgment → collect into a single AskUserQuestion with the critic's evidence and your recommendation
3. For CONCERN items: note them in the feature's `## Decision Log` as "Critic flagged — [summary]. Accepted because: [your reasoning]" or fix if quick
4. For RECONSIDER verdicts from Pass 3 (steel-man challenges): AskUserQuestion with both options and the critic's reasoning, plus your recommendation
5. If the critic identified assumptions that the spec relies on silently, make them explicit in the spec — add them to acceptance criteria or Technical Notes

**Do NOT re-run the critic after fixes.** One round only. Address what you can, ask the user about the rest, and proceed.

### Phase 5: Spec Approval Gate (NOT an Implementation Plan)

Feature files are already written with `status: proposed`. Use `EnterPlanMode` because it is Claude Code's generic approval + pause primitive, **not** because code changes follow. Implementation belongs to `/ship-execute` after `/ship-sprint` plans the work. It is never this skill's job.

**STOP rule — read before entering plan mode.**

The payload is a *spec approval summary*: past-tense outcomes only. What was discovered, decided, and written to spec files. No future-tense implementation verbs (`will modify`, `add function`, `edit class`, `change file`). If you catch yourself composing any of the following, you are in the wrong skill — exit plan mode without calling it, and resume the discussion:

- File paths outside `<SHIPYARD_DATA>/` as steps to change
- A task list that reads like TODO items for building the feature
- Anything that looks like `/ship-execute`'s output

The failure mode this rule exists to prevent: a customer session where `EnterPlanMode` was called with code-change steps, the user approved assuming it was the spec, and source files got edited during a discussion session. `EnterPlanMode` is a generic approval primitive. It is not a signal to generate implementation steps.

**Enter plan mode** (`EnterPlanMode`) with the discussion outcome. Use these sections only — describe what already exists in the spec files, not what should be built:

- **FEATURES DEFINED** — per feature: ID, title, points, RICE, complexity, one-line user story, acceptance-scenario count, NFRs, high-RPN failure modes, edge cases, dependencies
- **IDEAS CAPTURED** — tangential ideas filed during discussion
- **EPIC** — if assigned, show epic with all features
- **IMPACTS** — cross-feature changes already applied to spec files
- **BACKLOG EFFECT** — re-estimation notes, priority shifts
- **UNRESOLVED** — quality-gate items flagged for follow-up

**Exit plan mode** (`ExitPlanMode`) — this triggers Claude Code's built-in approval flow:

- **Approve** → **mandatory** proceed to Phase 6 (Finalize). The discussion is not complete until Phase 6 runs in full.
- **Refine** → stay in discussion, iterate on flagged features, re-enter Phase 5 when ready. Do not touch `.active-session.json`.
- **Reject** → leave features at `status: proposed`, stop. User can resume later with `/ship-discuss [ID]`. Do not touch `.active-session.json`.

### Phase 6: Finalize (only on Approve)

Run these steps in order. The session guard stays active until the **very last** step so that any accidental Edit to a source file during Finalize still gets blocked — that's the whole point of the ordering. Do not reorder to "optimize" the cleanup.

1. **Update feature statuses.** For each approved feature, change `status: proposed` → `status: approved` in its spec file (`.md`, allowed by the guard).
2. **Append to BACKLOG.md.** Use the Edit tool to add approved feature IDs to `<SHIPYARD_DATA>/spec/BACKLOG.md` (`.md`, allowed by the guard).
3. **Mark graduated ideas.** If any features were sourced from an IDEA file (IDEA mode), use the Edit tool to set `status: graduated` and add `graduated_to: FNNN` in the corresponding `<SHIPYARD_DATA>/spec/ideas/IDEA-NNN-*.md` frontmatter now. Doing this here — inside the guarded window — keeps the lifecycle change inside the session-guard cover.
4. **Use the Edit tool to also mark `.research-draft.md` obsolete** if it still exists with the current topic — sets `obsolete: true` in its frontmatter.
5. **Print the Next Up block** (see below). The user sees it and the conversation is effectively over.
6. **Last action — after everything above has flushed:** use the Write tool to overwrite `<SHIPYARD_DATA>/.active-session.json` with `{"skill": null, "cleared": "<iso-timestamp>"}` (soft-delete sentinel — `session-guard` treats `skill: null` as inactive). Until this step, any Edit to a source-code path is still blocked by the session guard. After this step, do **not** continue with any tool calls — the discussion is done. If the user wants to build the feature, they will run `/ship-sprint` in a new session.

---

## REFINE Mode: Update Existing Feature

### Step 0: Sprint Impact Check

Before anything else, check if this feature is in an active sprint:

1. **Read the active sprint file** (`<SHIPYARD_DATA>/sprints/current/SPRINT.md` — check if this feature's ID appears in any wave, or if any task in the feature's `tasks:` array appears in the sprint)
2. **Check task status** — are any tasks for this feature already in-progress or completed?

If the feature is **in an active sprint**, AskUserQuestion:

"⚠️ F007 is already being worked on in Sprint 3.
  Progress: 2/5 tasks done, 1 in-progress.
  Changing it now may disrupt the current sprint.
  What would you like to do? (continue editing / pull from sprint first / cancel)"

Three paths:
- **"continue editing"** → Continue REFINE in-place. After Step 4, flag sprint plan as stale and show impact (see Step 4).
- **"pull from sprint"** → Move feature back to backlog (`status: approved`), remove from sprint file, adjust sprint capacity. Then continue REFINE normally.
- **"cancel"** → Abort. Suggest finishing the sprint first, then discussing in the next cycle.

If tasks are **in-progress or completed**, add extra caution:
"Task T003 (auth middleware) is already done. Changes to the spec may invalidate completed work. Want to proceed anyway?"

### Step 1: Load & Present

1. **Load existing feature file** — read all current content
2. **Show current state** to user with a quick health assessment:
   - How many acceptance scenarios exist? Are they specific or vague?
   - Are edge cases covered or only the happy path?
   - Are there TODOs, TBDs, or placeholder text?
   - Is the task decomposition concrete enough to execute?

"Here's what we have for F007. I see some gaps — let me walk through them."

### Step 2: Challenge Existing Spec (same technique as Phase 1.5b — applied to existing content)

Run the full Challenge & Surface analysis against the **existing feature content**:
!`shipyard-context reference ship-discuss challenge-surface 80`

Apply each section to what's already in the spec — audit assumptions baked into the current writing, sweep for edge cases not covered by existing acceptance scenarios, scan for conflicts with features added since this was first discussed, and list what's still missing.

### Step 3: Gather Updates

Based on what Phase 1.5 surfaced, use AskUserQuestion (never plain text) to gather updates — bundle gaps into a single question where possible:
- Resolve each gap: addressed / deferred / not needed
- New insights, changed requirements, concerns?
- New acceptance scenarios for uncovered edge cases
- Technical decisions made since last discussion?

### Step 4: Update & Re-evaluate

1. **Update the feature file** — preserve decision log, add new entries with date
2. **Recalculate estimates** — scope likely changed after surfacing gaps
3. **Re-run viability gate** — feature may now be better defined (or need splitting)
4. **Backlog**: If estimates changed, no need to update BACKLOG.md — it only stores IDs. The updated data will be read from the feature file next time the backlog is displayed.

### Step 4.5: Impact Analysis

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/impact-analysis.md`

This is a REFINE run — see "REFINE mode specifics" in that file.

#### Sprint Impact Report (if feature is in active sprint)

If the feature was in-sprint and the user chose to continue in-place, show the impact:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPRINT IMPACT: F007 refined mid-sprint
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Estimate change:  5 → 8 points (+3)
 New scenarios:    +2 acceptance scenarios added
 New tasks:        +1 task (T009: handle timeout)
 Invalidated:      none (existing work still valid)
 Sprint capacity:  was 3 pts remaining, now 0 (over by 3)

 Cross-feature impacts (from Step 4.5):
   F003: dependency added (informational)
   F005: acceptance criteria updated (action-required)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then AskUserQuestion: "Sprint is now over capacity. Options:"
- **Absorb** — team stretches to cover (small overrun)
- **Defer new tasks** — add new tasks to backlog, finish original scope this sprint
- **Swap** — pull a different unstarted feature out of the sprint to make room
- **Replan** — cancel and re-plan the sprint (`/ship-sprint --cancel`, then `/ship-sprint`)

Update the sprint file with whatever the user chooses.

### Step 5: Approval Gate & Finalize

After the impact analysis (and any sprint-replan choices) is applied, run Phase 5 (Spec Approval Gate) and Phase 6 (Finalize) against the refined feature. Same STOP rule, same ordering invariant: the session guard stays active until the last step.

REFINE-specific differences from the NEW-mode finalize:

- Phase 6 step 1 is a no-op for features that were already `status: approved` before this session — leave the status alone.
- Phase 6 step 2 is a no-op if the feature ID is already in BACKLOG.md (REFINE edits an existing backlog entry, it does not append a duplicate).
- Phase 6 step 3 (idea archival) only applies if this REFINE run just graduated an idea; otherwise skip.
- Phase 6 steps 4 and 5 (Next Up + `.active-session.json` delete) always run, in that order. The guard cleanup is still the very last action so any accidental source-code Edit during the wrap-up is still blocked.

If the REFINE run was interrupted by the "cancel" branch of the Sprint Impact Check (Step 0), the session guard still needs to be cleaned up — delete `.active-session.json` as the last action before returning control to the user.

---

## Rules

- **Use AskUserQuestion — never plain text for questions.** AskUserQuestion is a tool call that suspends execution and waits for user input. Plain text output does not pause — the model will continue without user input. Every question that requires an answer must use AskUserQuestion.
- **Always recommend.** Every question to the user must include your recommendation. Never ask "A or B?" without saying which you'd pick and why. Example: "Should we require email verification? I'd recommend yes — it prevents fake accounts and is standard for auth flows."
- **Don't ask obvious questions.** If the answer is clear from context, the tech stack, or standard practice — just state your recommendation and move on. Only ask when there's a genuine decision to make. Example: don't ask "should login errors be user-friendly?" — of course they should. Do ask "should we rate-limit login attempts? I'd recommend 5 per minute to prevent brute force."
- **Be conversational, not mechanical.** This is a discussion, not a form.
- **Suggest structure.** If the user rambles, organize their thoughts into features/epics.
- **Never assume technical decisions.** Ask about architecture, approach, tradeoffs — but always lead with your suggestion.
- **Reference existing spec.** Don't create duplicates. Link to related features.
- **Record everything.** Every decision, every "let's not do that", every "maybe later" goes in the decision log.
- **Multi-session safe.** If the user stops mid-discussion, state is saved. They can resume with `/ship-discuss [ID]`.

## Next Up (after features are approved)

When features are approved and added to backlog, end with:
```
▶ NEXT UP: Plan a sprint to build these features
  /ship-sprint
  (tip: /clear first for a fresh context window)
```

If the user wants to discuss more features instead, that's fine — skip the Next Up and keep talking.
