---
name: ship-discuss
description: "Discover features from idea to full spec."
allowed-tools: [Read, Write, Edit, Grep, Glob, LSP, Agent, AskUserQuestion, WebSearch, WebFetch, TaskCreate, TaskUpdate, TaskList, "Bash(shipyard-context:*)", "Bash(shipyard-data:*)"]
model: opus
effort: low
argument-hint: "[topic | feature ID | issue key | --idea <description>] [--think <model>]"
---

# Shipyard: Feature Discussion

You are facilitating a feature discovery conversation. This is fluid — not a questionnaire.

## Context

!`shipyard-context discuss-context`

**Paths.** Use the absolute SHIPYARD_DATA prefix from the bundled context block. No `~`, `$HOME`, or shell variables in `file_path`. No bash command substitution for shipyard-data or shipyard-context — use Read / Grep / Glob after context is loaded. **Never use `echo`/`printf`/shell redirects to write state files** — use the Write tool (auto-approved for SHIPYARD_DATA).

**Onboarding gate.** If the bundled context contains `SHIPYARD_ONBOARDING_REQUIRED=true`, run the exact `SHIPYARD_ONBOARDING_COMMAND` once with Bash, report the CLI output to the user, and STOP. Do not infer setup state by reading or writing Shipyard state files; onboarding decisions are CLI-owned.

**Quiet by default.** This is a conversation, so the interruption *rounds* carry real discussion — but between them, work quietly. Only three things reach the chat outside a user-input round: a one-line transition marker per phase, a compact ASCII diagram/status block, and a one-line banner when launching or receiving the background deep-dive (`→ Deep-dive back: 3 findings, 1 data-model risk`). Research findings, viability reads, impact maps, and diagrams are rendered in full ONLY when they feed an imminent AskUserQuestion (render-before-ask) — otherwise they collapse to a one-line result and fold into the eventual gate summary. Reading the dossier puts it in YOUR context; that is not a reason to re-emit it as prose unless a decision rides on it now. **No running commentary** ("Now I'll research…", "Let me run the viability gate…", explaining a no-input phase). Full doctrine: `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md` § "Interim Communication: Quiet by Default".

**Capability-skill playbooks.** Where a step says *"follow the `X` playbook"* or "dispatch `X`", X is a capability skill — **Read** `${CLAUDE_PLUGIN_ROOT}/skills/<X>/SKILL.md` and execute it inline; never hand it to the `Skill` tool (capability skills are `disable-model-invocation: true`, so `Skill` refuses them). There is no legacy loop-skill fallback.

## Input

$ARGUMENTS

**`--think <model>` override (this invocation only).** If `$ARGUMENTS` contains `--think <value>`, validate `<value>` as either one of `{fable, opus, sonnet, haiku}` or a first-party Claude model ID matching `claude-*` (for example `claude-opus-4-8` or `claude-sonnet-5`). Valid → strip `--think <value>` from the arguments before mode detection and remember it as `think_override` for the rest of this session; every think-tier dispatch below (the design deep-dive, the critic) passes `model: <think_override>` instead of reading `models.think` from config.md. Invalid value (anything else) → print one line ("`--think <value>` isn't a recognized model — ignoring, using the configured think tier") and fall back to `models.think` as normal; do not block on it or ask a follow-up question. No config.md mutation — this never persists past the current invocation. On first dispatch that actually uses the override, emit `shipyard-data events emit think_override_used model=<think_override>` (once per session, not once per dispatch).

## Session Mutex Check

**Absolute first context action — before mode detection, before any manual reads.** The `shipyard-context discuss-context` pre-exec block above acquires the planning lock and returns the discussion context bundle in one CLI call. If that context contains `SHIPYARD_LOCK_ACQUIRED=false`, echo the `SHIPYARD_LOCK_BLOCKED:` `⛔` block text verbatim as the entire response and STOP — do not continue with any other instructions, do not call any other tools. If it contains `SHIPYARD_LOCK_NOTICE:`, echo that stale/corrupt-lock recovery line once, then proceed (see the `acquiring-skill-lock` capability skill for the full contract — locks are CLI-owned as of v3.7.0, never Read or Write either lock file by hand).

**Concurrent execution safety.** The lock CLI allows exactly one cross-lock pair: `ship-discuss` may run while `ship-execute` holds the execution lock. This exception is for **future/backlog work** only. If the bundled context includes `SHIPYARD_LOCK_CROSS_ALLOWED=ship-discuss+ship-execute`, continue in **future-work mode**:
- The active sprint summary is already included in the bundled context; treat every feature/task referenced by `<SHIPYARD_DATA>/sprints/current/SPRINT.md` as read-only.
- Keep that list as the active-sprint read-only set for the whole invocation.
- Safe: create new IDEAs, discuss new features, write future feature specs, graduate an idea into a new feature, and add future approved features to BACKLOG.md. `/ship-execute` has already snapshotted its active sprint; backlog additions do not enter the running sprint.
- Unsafe: editing active-sprint feature specs, active-sprint task files, SPRINT.md, PROGRESS.md, cursors, task statuses, or acceptance/user-flow probes for features in the running sprint. If the user asks for one, refuse the edit and offer to capture a follow-up IDEA or bug for the next sprint.
- EPIC/refine flows that would cascade into an active-sprint feature must skip those files and surface them as deferred follow-ups. Never silently mutate a feature that `/ship-execute` may be reading or verifying.

## Load Context

The `shipyard-context discuss-context` block is the only startup context call. It returns SHIPYARD_DATA, config, codebase context, epics, features, and, when concurrent execution is allowed, the active sprint summary. Use the returned SHIPYARD_DATA path literally in all file operations. Do not rerun those context commands manually before mode detection.

## Detect Mode

Auto-route ONLY on unambiguous inputs. Heuristic classifications must be confirmed with the user before proceeding — wrong-mode-by-default is a high-impact failure (CAPTURE mode demotes a meaty idea to a stub without acceptance criteria; NEW mode interrogates a brainstorm the user wanted to stash). See the per-input rules below.

**Unambiguous (auto-route, no confirmation needed):**

- If input starts with `--idea ` → **IDEA-CAPTURE mode** (see below). Strip the `--idea` prefix; the rest is the idea description. This is a fast-path: capture immediately, no depth offer, no ceremony. Example: `/ship-discuss --idea webhook retry with exponential backoff`.
- If input is an **epic ID** (E001) → **EPIC mode** (refine epic scope, cascade changes to features)
- If input is an **idea ID** (IDEA-NNN) → **IDEA mode** (convert idea to feature — see below)
- If input is a **feature ID** (F001) → **REFINE mode** (load existing, gather updates)
- If input matches an **external issue key** pattern (`[A-Z]+-\d+` but NOT a Shipyard ID like F001/E001/T001/IDEA-NNN) → **EXTERNAL mode**. Fetch context from the user's session MCP tools and seed a NEW mode discussion. See `references/external-issue-fetch.md` for the full protocol. Examples: `JIRA-123`, `SYS-456`, `ENG-789`.
- If input is a **triage phrase** — exact phrase match against: "anything requires discussion", "anything requires discussion?", "what's open", "what needs discussion", "what needs attention", "what's pending", "what needs refinement", "anything else", "discuss anything", "what else", "any ideas", "any ideas to discuss", "what ideas" → **TRIAGE mode** (see below)
- If no input → AskUserQuestion: "What would you like to discuss?"

**Heuristic-classified:** Any input that does not match the unambiguous list above is heuristic-classified. **The confirmation discipline is tiered by reversibility** (this is the confidence gate applied to mode selection — see `references/question-design.md`):

- **CAPTURE and EPIC still REQUIRE confirmation before routing** — they are one-way-ish doors (CAPTURE writes an IDEA file and demotes a meaty idea to a stub; EPIC cascades changes across many feature files). Compose a one-line summary of the input, the inferred mode, and the mode's outcome, and use `AskUserQuestion` to confirm. Default-recommend the inferred mode but always offer the cheaper-to-recover-from neighbor:
  - **Short one-liner heuristic** (under ~20 words, no questions, no detail) → inferred CAPTURE mode. Ask: "This looks like a quick capture — file as IDEA-NNN (zero ceremony) or open a full feature discussion?" Default: CAPTURE.
  - **Large-initiative heuristic** (multiple features implied, a whole product area) → inferred EPIC mode. Ask: "This sounds like an epic — multiple features under one initiative. Discuss as an epic, or start with the first feature? (epic / feature)". Default: epic.
- **Detailed-topic heuristic** (the user is describing a single feature in more than a few words OR asking questions about a single behavior) → inferred NEW mode. **Do NOT ask a standalone confirmation** — entering NEW is a two-way door (nothing is written until Phase 3, and the user sees the spec before it's finalized), so a confirmation interruption here is cheap-to-recover reasoning applied to a costless choice. Instead **proceed into NEW mode immediately with a stated assumption**, folded into the first Phase-1 round: open with one line — "Treating this as a full feature discussion — say 'just stash it' to capture as an IDEA instead." The veto is live but does not cost a round.

The CAPTURE/EPIC confirmation step is two sentences max — do not turn it into a full Phase 1 question. Its only purpose is to catch wrong-mode-by-default before the skill commits to a flow that's hard to back out of. After confirmation (CAPTURE/EPIC) or the stated assumption (NEW), route to the chosen mode.

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

### IDEA-CAPTURE Mode: Instant Idea Stash (`--idea`)

When the input starts with `--idea`, this is the fastest possible capture path. No conversation, no depth offer, no questions. Stash and exit.

1. Strip the `--idea` prefix from the input. The remaining text is the idea description.
2. Generate the next available IDEA-NNN ID (same allocation logic as CAPTURE mode).
3. Derive a slug from the description (lowercase, hyphens, max 40 chars).
4. Write `<SHIPYARD_DATA>/spec/ideas/IDEA-NNN-[slug].md`:

```yaml
---
id: IDEA-NNN
title: "[cleaned up title from description]"
type: idea
status: proposed
source: "inline capture (--idea)"
created: [today's date]
---

# [Title]

## Idea
[User's description text, lightly cleaned up]

## Why It Might Matter
[One sentence — best guess at value]
```

5. Output exactly:
```
Captured: IDEA-NNN — [title]
Flesh out later with: /ship-discuss IDEA-NNN
```

6. Release the session mutex: `shipyard-data lock release planning --skill ship-discuss`. Done. No follow-up question, no Phase 1, no depth offer.

**Rules for IDEA-CAPTURE mode:**
- Be instant. The user typed `--idea` because they want zero friction.
- No `AskUserQuestion`. No clarifying questions. No RICE. No estimates.
- No `Why It Might Matter` if nothing is obvious — leave the section with a single dash.
- No `Initial Thoughts` section (unlike CAPTURE mode). Keep it minimal.

---

### Compaction Recovery

If you lose context mid-discussion (e.g., after auto-compaction):

0. **Call `TaskList()` first.** If the phase-checklist tasks from NEW mode Phase 0 are present, the last `in_progress` (or first non-`completed`) task names the phase to resume — use it as the structured position anchor, then confirm against the file evidence below before resuming (the tasks are a mirror, not authority; if tasks and files disagree, the files win).

1. Run `shipyard-context draft-state research`. If `SHIPYARD_RESEARCH_DRAFT_PRESENT=false` or `SHIPYARD_RESEARCH_DRAFT_OBSOLETE=true`, treat the draft as absent (skip to step 2). Otherwise use the Read tool on `<SHIPYARD_DATA>/spec/.research-draft.md` for the narrative body only:
   - If found and `topic:` matches → the design deep-dive ran (the dossier carries `## Research Findings`, `## Constitution Gaps`, `## Diagrams`, `## Viability Pre-Assessment`, `## Impact Analysis`, `## Simplification Candidates`) and the research/challenge phases completed. Read it for findings and resume from Phase 2 (Viability Gate) — later phases consume their dossier sections rather than re-dispatching.
   - If found but its `topic:` doesn't match the current discussion topic → topic-mismatch fork. The user just typed `/ship-discuss [new topic]`, but stale research exists for `[old topic]`. The default behavior MUST favor the user's most recent intent (the new topic) — abandoning a fresh request to resume stale research is the wrong-by-default semantics that surfaced as HIGH-risk in the v2.4.0 audit (user picks "keep" thinking it means "keep my new topic", silently discards the new request). Before the ask, render a two-line summary of the stale draft as chat text — its `topic:`, `created:` date, and which dossier sections it carries — so the user sees what "the old discussion" actually contains. The draft exists only in a Read result until re-emitted; option labels alone cannot carry it. Use `AskUserQuestion` with options labeled by the topic they refer to, NOT by abstract verbs like "keep" or "discard":
     - **"Continue with the new topic '[new topic]' (recommended)"** → run `shipyard-data draft obsolete-research --topic "<old topic>"` (preserving the old research as a soft-deleted record), proceed fresh into Phase 1.5 (Research) for the current topic. This is the default and should be presented first.
     - **"Resume the old discussion on '[old topic]' instead"** → switch to the old topic. Read `topic:` from `.research-draft.md`, load its research findings, and resume from Phase 2 (Viability Gate) for that topic. Inform the user: "Resuming discussion on [old topic]. To discuss [new topic], run /ship-discuss [new topic] in a new session." Only choose this if the user explicitly picks it — never default to it.
     - **"Resume the old topic AND archive the old research before starting the new one"** (when the user wants both) → first finalize the old discussion to Phase 6 in a quick wrap-up pass, then start fresh on the new topic.

   Never present this as a generic "keep / discard" pair without naming which topic each refers to — that's the exact source of the v2.4.0 wrong-by-default report. Both topic strings must appear in the option labels.
2. Check for feature file matching the topic: use Glob `<SHIPYARD_DATA>/spec/features/F*-*.md` to enumerate, then Read each and match by title against the current topic.
   - If found with empty acceptance criteria → Phase 3 incomplete, resume Phase 3
   - If found with acceptance criteria and `status: proposed` → Phase 3 done, resume from Phase 3.5 (Impact Analysis)
   - If found with `status: approved` but `shipyard-data lock check planning` still reports `state: "mine"` for `skill: ship-discuss` (not released) → Phase 6 (Finalize) was interrupted mid-sequence. Read BACKLOG.md: if the feature ID is already listed, resume from Phase 6 step 3 (idea archival) or step 4 (Next Up) depending on whether an idea file still has `status: proposed`. If the feature ID is missing from BACKLOG.md, resume from Phase 6 step 2 (append to BACKLOG.md). Either way, the final `lock release` call still runs last.
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
created: [today's date]
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
- **"later" / "no" / silence** → done. Clean up active-skill mutex and exit.

**Rules for CAPTURE mode:**
- Be fast. Don't ask clarifying questions upfront.
- Don't estimate. No RICE, no story points.
- Slug from title — lowercase, hyphens, max 40 chars.
- If called mid-conversation or mid-sprint, capture and return immediately.

---

## EPIC Mode: Discuss at Epic Level

When the input is an epic ID (E001) or the user describes a large initiative.

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/epic-mode.md`

Seven steps in sequence: **EP1 Load Epic Context** (Glob the epic file, Grep features by `^epic: E00N`, present a summary block of features + points + scenarios); **EP2 Epic-Level Discussion** (AskUserQuestion about scope, new/removed features, business context shifts, cross-feature concerns); **EP3 Cascade Changes to Features** (propagate scope changes, new dependencies, priority shifts, acceptance criteria changes, additions/removals/invalidations to each affected feature file — full change-type table in reference; flag sprint-active features before mutating them); **EP4 Create New Features** (run NEW mode Phase 1→5 inline with epic pre-assigned, bundle related features so dependencies are clear); **EP5 Quality Gate** (5 checks: all features have acceptance criteria, no orphan features, consistent dependencies, no duplicates, coherent epic scope); **EP6 Wrap Up** (present changed-state summary, AskUserQuestion: "Approve these changes? (yes / adjust / revert all)"); **EP7 Integration AC** (cross-feature seam-level E2E criteria — see `references/epic-integration-ac.md`).

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

Run all phases in sequence: Phase 1 (Understand) → Phase 1.5 (Research) → Phase 1.5b (Challenge & Surface) → Phase 2 (Viability Gate) → Phase 3 (Write to Spec as FNNN) → **Phase 3.5 (Impact Analysis)** → **Phase 3.7 (E2E AC Validation)** → **Phase 3.8 (Simplification Scan)** → Phase 4 (Capture tangential ideas) → Phase 4.5 (Backlog Re-evaluation) → Phase 4.9 (Quality Gate) → Phase 4.95 (Adversarial Critique) → **Phase 4.97 (Scope-Drift Check)** → Phase 5 (Spec Approval Gate) → Phase 6 (Finalize).

Impact Analysis (Phase 3.5) runs as normal — it scans existing features for dependencies, overlaps, conflicts, and invalidations caused by the new feature, and uses AskUserQuestion to confirm what to apply.

### Step I3: Mark the Idea as Graduated

Idea archival happens inside Phase 6 (Finalize), between the BACKLOG.md append and the mutex release — not here and not as a standalone step. See `references/phase-finalize.md` for the graduation target path and exact ordering.

---

## NEW Mode: Discover Features

### Phase 0: Create the Phase Checklist (task list)

On entering NEW mode, `TaskCreate` one task per phase so the user can see where the discussion is and skipped phases become visible instead of silent:

| # | Subject |
|---|---------|
| 1 | Phase 1: Understand — discovery conversation |
| 2 | Phase 1.5: Research (constitution, internal, external, diagrams) |
| 3 | Phase 1.5b: Challenge & Surface |
| 4 | Phase 2: Viability Gate (5 gates) |
| 5 | Phase 3: Write to Spec |
| 6 | Phase 3.5: Impact Analysis |
| 7 | Phase 3.7: E2E AC Validation |
| 8 | Phase 3.8: Simplification Scan |
| 9 | Phase 4: Capture Tangential Ideas |
| 10 | Phase 4.5: Backlog Re-evaluation |
| 11 | Phase 4.9: Quality Gate (self-review loop) |
| 12 | Phase 4.95: Adversarial Critique |
| 13 | Phase 4.97: Scope-Drift Check |
| 14 | Phase 5: Spec Approval Gate |
| 15 | Phase 6: Finalize |

Create all 15 in one batch (subjects prefixed with the topic slug, e.g. `[auth-flow] Phase 2: Viability Gate`, so parallel sessions don't collide). `TaskUpdate` each to `in_progress` when its phase starts and `completed` when it ends. If a mode variant legitimately skips a phase (e.g. REFINE entering mid-flow), mark the skipped tasks `completed` with a `skipped: <reason>` note in the description — never delete them silently.

**Deep-dive dispatch coverage.** The analytical bulk of Phases 1.5, 3.5, and 3.8 runs inside the single dispatched **design deep-dive** agent (see Phase 1.5), which produces the dossier those phases consume. Those phases still exist as shell steps — they present the dossier's findings and drive the user-facing gates — so keep their tasks in the checklist. The deep-dive is dispatched **concurrently at Phase 0.6** (seeded with the topic) so its no-user-input passes overlap the Phase-1 conversation; mark task 2 (Phase 1.5) `in_progress` at that dispatch and `completed` once the dossier is written and presented. Tasks 6 (Phase 3.5) and 8 (Phase 3.8) track the shell's present-and-apply steps as usual.

**Interruption-round budget (load-bearing).** The 15 phases collapse into **4–5 user-interruption rounds**, not 15 asks: Round 1 = Phase 1 bulk understanding; Round 2 = Phase 1.5b challenge + Phase 2 viability echo in one call; Round 3 = Phases 3.5/3.7/3.8/4.5 consolidated post-spec decisions in one call; Round 4 = Phase 5 consolidated approval (verbatim ACs + scope-drift + spec approved in one gate). The phases stay as checklist steps and present-and-apply work; only their **interruption points** merge. See `references/question-design.md` for the discipline.

**Guardrail (load-bearing): the task list is a progress surface and a recovery anchor, NEVER authority.** Do not gate any behavior on TaskList state, do not cite task status as evidence a phase ran, and never mark a phase's task completed before the phase's file/event artifacts exist. The spec files, `.research-draft.md`, and the event log remain the record; the tasks are the user-visible mirror. (Same discipline as PROGRESS.md vs the event log.)

### Phase 0.6: Dispatch the design deep-dive in the background (concurrent)

**Immediately after mode detection routes to NEW (or IDEA-graduated-to-NEW), before composing the first Phase-1 question**, dispatch the design deep-dive agent **in the background**, seeded with just the TOPIC. Steps 1–3 of the research protocol (constitution check, internal research, external "how others solve it" research) need no user answers — they run against the topic and codebase alone, so they overlap the user's Phase-1 thinking time for free. See Phase 1.5 for the exact dispatch (the "concurrent seed" variant) and the SendMessage hand-off that feeds it the Phase-1 summary once the conversation finishes. Print the one-line dispatch banner there.

**Fallback:** if background dispatch is unavailable or the launch fails, skip this and dispatch the whole deep-dive after Phase 1 as the documented Phase 1.5 fallback path.

### Phase 1: Understand

**Read the two authorities for this phase:**
- `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/question-design.md` — **how to ask**: the confidence gate (run BEFORE composing any question), the ten-rule rulebook, the kill-list, the ≤5-question budget, and the 4–5-round target. This governs everything user-facing below.
- `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/discovery-techniques.md` — JTBD, user journey mapping, pre-mortem, ISO 25010, ATAM, EARS, IEEE 830. **These structure YOUR analysis only** — their vocabulary never reaches the user (rule Q1 + kill-list #5). Apply them throughout Phases 1-3 as scaffolding, then translate every probe into a concrete scenario before asking.

**Communication design:** When surfacing something the user hasn't considered, use the 3-layer pattern from `references/communication-design.md` — one-liner (what + recommendation), context (why it matters, tradeoff, analogy if helpful), detail (only for high-stakes). Max 3–4 new concepts and 2–3 options per question. Under 100 words per decision message. Name the tradeoff on each option. Always recommend a default.

**Think first, ask once (bulk understanding — this is Round 1 of the 4–5-round budget).** Do the derivation BEFORE composing any question:

1. **List every unknown** the spec would need answered. Use the JTBD and journey lenses as scaffolding: who is the user, what job are they hiring this for, what do they do today without it, what triggers usage, what's the before/during/after flow, where can they abandon, what's the business value, what constraints exist.
2. **Kill what the record already answers** (kill-list + rule Q8). Grep the codebase/config, the spec + Decision Logs + constitution, git history, and the user's own words this session. For anything found, STATE it rather than ask ("You're on Postgres with row-level tenancy, so I'll scope this per-tenant").
3. **Run the confidence gate** over every remaining item (question-design.md). HIGH items (evidence converges AND two-way door) are decided, informed in one line, and logged as ASSUMED — they never reach AskUserQuestion. Only MEDIUM and LOW items are asked.
4. **Ask everything remaining in AT MOST ONE `AskUserQuestion` call of up to 4 questions** (each ≤4 options + a recommended default + Other). A second call in this phase only if the first call's answers genuinely fork the design. Every question is scenario-framed and past-behavior-anchored per the rulebook — never framework vocabulary, never a hypothetical-opinion probe. Before the call, render the SCQA Situation for each question as chat text — the derived context (what the record answered, what was stated vs assumed) plus the concrete scenario each question hangs on. The question/option strings render as a compact card and cannot carry the scenario; anything discovered via Grep/Read exists only in your context until re-emitted as chat text.

If this discussion arrived via the detailed-topic heuristic (NEW-by-assumption), fold the stated mode assumption into this round's opening line ("Treating this as a full feature discussion — say 'just stash it' to capture as an IDEA instead") rather than spending a separate confirmation.

**Always use AskUserQuestion — never plain text — to ask questions.** AskUserQuestion suspends execution and waits for input; plain text does not.

**Once the Phase-1 conversation finishes, SendMessage the deep-dive agent the Phase-1 summary** (see Phase 1.5) so it completes its remaining passes. Then narrate the transition in one line ("→ Design deep-dive finishing: diagrams + viability read underway").

**Key behaviors during conversation:**
- **Splitting:** If the user describes multiple distinct features, use AskUserQuestion: "I'm hearing two things: [X] and [Y]. Want to capture them separately?"
- **Branching:** If something tangential comes up, capture it as an idea inline and state it as plain text: "That's a good point — I'll capture that as IDEA-NNN. Let's stay focused on [current topic]." (This is a statement, not a question — no AskUserQuestion needed.)
- **Referencing:** If it relates to an existing feature, use AskUserQuestion: "This connects to F003 — should we extend that or keep this separate?"
- **Parking:** If user says "not now" about something, record it in the decision log as deferred with their reasoning.

### Phase 1.5: Research (via the design deep-dive dispatch)

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-1-research.md`

The analytical bulk of this phase runs in **one dispatched design deep-dive agent** — the shell (this session) stays lean for conversation and gates; the heavy reasoning (research, diagram generation, viability pre-assessment, impact + simplification prep) runs on the think tier. The shell then **presents the dossier's findings conversationally** and drives the user-facing gates itself.

**Dispatch it CONCURRENTLY, in two passes, so nothing blocks the user.** The dispatch is split so the no-user-input work overlaps the Phase-1 conversation:

- **Seed pass (at Phase 0.6, background).** Immediately after mode detection, launch the agent in the background (`run_in_background: true`) with a stable `name` derived from the topic slug (e.g. `deepdive-<slug>`), seeded with only the TOPIC. It runs research protocol steps 1–3 (constitution check, internal research, external "how others solve it") — none need user answers. Print the dispatch banner: `→ Dispatched design deep-dive: constitution check, codebase scan, external research, diagrams — usually 1–3 min`.
- **Hand-off (when Phase 1 finishes).** `SendMessage` the named agent the Phase-1 conversation summary (users, core behavior, value, constraints, JTBD/journey findings, decisions already made) so it completes the remaining passes — (4) Architecture visualization, data-modeling guidance, viability pre-assessment, impact-analysis prep, simplification candidates — and writes the dossier.

When the agent returns, **lead with its one-line summary** ("→ Deep-dive back: 3 findings, viability clean, 1 data-model risk").

**Fallback (background dispatch or SendMessage unavailable/failed).** If the background launch, the agent `name` addressing, or the `SendMessage` hand-off is unavailable or errors, fall back to the documented path: dispatch **the whole deep-dive as ONE synchronous subagent after Phase 1 completes** (seeded with the full Phase-1 summary up front). Note the fallback to the user in one line and continue. Either way the Agent template and prompt below are identical — only the timing and the seed-vs-summary split differ.

**Model tier (think).** If a `--think` override is active for this invocation, pass `model: <think_override>` on the Agent call — do not read config.md for this dispatch. Otherwise, read `models.think` from config.md (the `/ship-discuss` context block already carries config, or Read `<SHIPYARD_DATA>/config.md`): if the value is non-empty, pass `model: <value>` on the Agent call; if empty or absent, OMIT the `model:` field so the subagent inherits the session model. Never hardcode a model literal. **Spawn-failure fallback:** if the dispatch errors at spawn because the requested model is unavailable, print one line ("`<model>` unavailable — falling back to `models.think`") and re-dispatch using the config value instead (this applies whether the unavailable model came from `--think` or from config.md itself).

**Effort tier (think).** Read `agent_effort.think` from config.md; default `high`. If the value is non-empty, pass `effort: <value>` on the Agent call; if empty or absent, OMIT `effort:` so the subagent inherits the runtime default.

```
Agent(subagent_type: "general-purpose", model: <models.think — omit if empty>, effort: <agent_effort.think — omit if empty>, prompt: |

You are the design deep-dive for a Shipyard feature discussion. Perform the
analytical bulk of the discovery pipeline and write a structured design
dossier. You have Read/Grep/Glob/LSP/WebSearch/WebFetch. You are READ-ONLY on
source; the only file you WRITE is the dossier below. No commits, no subagents.

# Input
Feature topic (always provided at dispatch):
  <the topic string>
Phase 1 conversation summary (provided up front on the synchronous-fallback
path; arrives via SendMessage on the concurrent path — begin steps 1–3 on the
topic alone, then do steps 4-onward once the summary lands):
  <users, core behavior, value, constraints, JTBD, journey, and any decisions
   the user already made>
Data dir: <SHIPYARD_DATA>
Plugin root: ${CLAUDE_PLUGIN_ROOT}

# Do (in order)
1. Run the full Phase 1.5 research protocol in
   ${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-1-research.md,
   in its documented order: (1) constitution check (tensions + gaps);
   (2) internal research; (3) how others solve it (WebSearch established
   products / complaints / security pitfalls; WebFetch docs);
   (4) Architecture visualization — diagrams gated on architectural
   significance, not participation (the seven types, each with its own
   trigger, plus the skip criteria); (5) data-modeling guidance (gated) —
   when the feature persists data (ER/data-model trigger fired or a
   `## Data Model` concern exists), Read and apply
   ${CLAUDE_PLUGIN_ROOT}/project-files/references/data-modeling-guide.md;
   skip for features with no persistence concern.
2. Viability pre-assessment against the 5 gates (USER VALUE, DEFINABLE,
   BUILDABLE, TESTABLE, SCOPED): per gate, cite the evidence and a
   pass/concern verdict. This is INPUT for the shell to walk with the user —
   you do NOT decide viability, you assess it.
3. Impact-analysis prep: which existing features/specs/code areas this feature
   depends on, overlaps, or would invalidate (Glob spec/features/F*.md).
4. Simplification-scan candidates: places the feature's new libraries /
   utilities / patterns could replace hand-rolled equivalents.

# Return contract
Create the dossier checkpoint at <SHIPYARD_DATA>/spec/.research-draft.md with the frontmatter below. This is the initial narrative artifact creation step; subsequent state changes to this file's frontmatter, such as `obsolete: true`, go through `shipyard-data draft ...` only.
`topic:` + `created:` and these sections (extend the existing checkpoint file;
do not invent a new file):
  ## Research Findings         (HIGH/MEDIUM/LOW confidence, prescriptive "Use X")
  ## Constitution Gaps         (one line per gray area, per the protocol)
  ## Diagrams                  (each diagram as Mermaid, labeled by type)
  ## Viability Pre-Assessment  (per-gate evidence + pass/concern verdict)
  ## Impact Analysis           (affected features/specs/code areas)
  ## Simplification Candidates (reuse opportunities)
Your final text is a SHORT summary (which gates look clean, top findings,
biggest risk). The dossier file is the artifact the shell consumes.
)
```

**Then lead with the one-line result — do NOT dump the dossier as chat prose.** Read `<SHIPYARD_DATA>/spec/.research-draft.md` and open with the one-line summary the agent returned (`→ Deep-dive back: 3 findings, viability clean, 1 data-model risk`). That is all that reaches the chat *now*. Do NOT re-emit the whole `## Research Findings` / `## Diagrams` as running prose just because you read them — that's the commentary quiet-by-default cuts. **Render the specific findings and diagrams in full only at the round that acts on them** (render-before-ask): every dossier section a later round's AskUserQuestion depends on (viability verdicts, impact ripples, simplification candidates) must be rendered as chat text — with a diagram inline (ASCII per `references/communication-design.md`) where it clarifies the decision — immediately before *that round's* ask fires, not here. Later phases consume the remaining sections: Phase 1.5b resolves `## Constitution Gaps`, Phase 2 walks `## Viability Pre-Assessment`, Phase 3.5 reads `## Impact Analysis`, Phase 3.8 reads `## Simplification Candidates`. Phase 3 absorbs Research Findings into the feature's `## Technical Notes` (HIGH/MEDIUM/LOW labels) and persists the Diagrams to `## Flows` as Mermaid.

**If the dossier is not yet written but the background agent is still running, WAIT for it — waiting is never a user decision.** Print one line ("→ Waiting for the design deep-dive to finish") and poll (re-check the background handle / re-Read the dossier every ~15s) up to a 5-minute budget. Only on genuine agent failure or budget exhaustion take the inline fallback below — announced as a STATEMENT ("Deep-dive didn't return in time — running the research inline"), never as a question.

**Fallback (dispatch failed or unusable dossier).** If the Agent call fails, returns nothing, or the dossier is missing the sections above, fall back to running the `phase-1-research.md` protocol **inline** in the shell (the pre-4.0 path — the reference is still the protocol either way). Note the fallback to the user in one line and continue; the shell can do the analysis itself, it just costs more of the session's context.

### Phase 1.5b: Challenge & Surface

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-1-5b-challenge.md`

Once you have a reasonable understanding of the feature, **proactively challenge it** before moving to spec. Follow the **`discovering-edge-cases` playbook** to walk the seven discovery categories (boundary inputs, concurrency, failure modes, adversarial input, observability gaps, NFRs, domain-specific) and return structured findings. Pass `feature_text`, `parent_context`, `domain_hints`, and `data_dir`. The capability skill returns a structured list (~3-5k tokens). Also run a quick pre-mortem inline (from `discovery-techniques.md`).

**Presentation — this is Round 2, and it fuses the challenge with the Phase 2 viability echo into ONE `AskUserQuestion` call.** Follow `references/communication-design.md`. Present ALL findings at once in the compact visual summary (no per-finding drip), then resolve them in a single call. The compact summary block MUST appear as assistant chat text immediately before the AskUserQuestion — the findings arrive as a capability-skill return and dossier sections, which the user cannot see; and the themed question/option strings are a compact card that cannot substitute for the block. For each ❓/⚠️ item the user must decide, the finding, its impact, and the recommendation must be on screen in the block, not only in option text. Give each ❓/⚠️ item a **mini-story per challenge item** in that block — who hits it, when, what breaks (rule Q9) — the one-line finding is the summary, not the example scenario the user reasons from (see `references/question-design.md` § "Render an example scenario").

```
  ⚠️  [Finding]           → [impact], recommend [action]
  ⚠️  [Finding]           → [impact], recommend [action]
  ✅  [Finding]           → [status — no action needed]
  ❓  [Finding]           → needs decision
```

The single `AskUserQuestion` carries **up to 4 questions**:
- **Up to 3 themed challenge questions** — group the resolvable findings into ≤3 themes (e.g. security, data model, failure modes); each question's recommended default option is **"Apply all recommendations"** for that theme, so the trusting user resolves a whole theme with one pick. For each item inside a theme: what I found → why it matters → what I recommend.
- **The 4th question is the Phase 2 viability-echo confirmation** (see Phase 2 — mandatory, never dropped): "I'm reading this as one feature, scoped to [scope], with these acceptance themes: [themes]. Does this match your intent?"

**Kill the old per-group serial gating.** Do NOT resolve challenge themes one AskUserQuestion at a time and do NOT block "until each group is resolved" before showing the next — present everything and bulk-resolve in the one call. (If more than 3 challenge themes genuinely exist, a second call is the sanctioned overflow, but aim for one.) Create/update the dossier body in `<SHIPYARD_DATA>/spec/.research-draft.md` (initial frontmatter `topic:` + `created:` only; later state flags use `shipyard-data draft ...`; body sections `## Research Findings` and `## Challenge Resolutions`). This file is absorbed into the feature file's Technical Notes in Phase 3 and then deleted.

### Phase 2: Viability Gate

The design deep-dive already produced a **viability pre-assessment** (per-gate evidence + a pass/concern verdict) in `<SHIPYARD_DATA>/spec/.research-draft.md` under `## Viability Pre-Assessment`. Read that section and use it as the input to this gate. **The pre-assessment is analysis, not a decision — the viability decision authority stays with the shell and the user.** If the dossier lacks the section (inline-fallback path), evaluate the 5 gates directly here.

Evaluate each feature against the 5 gates AND echo the verdicts to the user. The historical "silently evaluate" pattern hid model misjudgments — USER VALUE, SCOPED, and TESTABLE are judgment calls the user has standing on, and silent-pass leaves no feedback channel when the model reads the feature wrong.

**The gates:**

1. **USER VALUE** — Can we articulate who wants this and why? → KILL if no clear user story
2. **DEFINABLE** — Can we write testable acceptance criteria (Given/When/Then)? → KILL if too vague
3. **BUILDABLE** — Can we decompose into executable tasks? → KILL if impossible constraints
4. **TESTABLE** — Can we verify with automated tests + demo? → KILL if purely subjective
5. **SCOPED** — Is it one feature, not three in a trench coat? → SPLIT if multiple stories

**Verdict echo (MANDATORY — even on PASS).** After running the gates, render the verdict block as assistant chat text before the Round-2 AskUserQuestion fires. The dossier's `## Viability Pre-Assessment` is a Read result — invisible to the user until re-emitted; the echo question's text cannot carry the five verdicts. Alongside the verdict block, render the **primary use scenario** as chat text — "When [actor] [does X] at [moment], they get [outcome]" — so "does this match your intent?" is answered against a concrete flow, not the abstract gate labels (see `references/question-design.md` § "Render an example scenario").

```
  Viability read:
    USER VALUE  ✓  [one-line summary of who + why, as the model read it]
    DEFINABLE   ✓  [acceptance theme — what the criteria will test]
    BUILDABLE   ✓  [task-decomposition shape — small/medium/large]
    TESTABLE    ✓  [verification approach — auto-test + demo path]
    SCOPED      ✓  [N feature(s) — if N>1, list the split]
```

**Delivery: this echo is the 4th question of the Round-2 `AskUserQuestion` call** composed in Phase 1.5b — it does NOT get its own separate interruption. Present the verdict block above alongside the challenge summary, and ask (as that call's final question): "I'm reading this as one feature, scoped to [scope], with these acceptance themes: [themes]. Does this match your intent? (looks right / refine the read / split into multiple features)". Default-recommend "looks right" only when all five gates pass cleanly. If the user picks "refine the read" or "split into multiple features", go back to Phase 1 for re-clarification before writing to spec. Do NOT skip this echo step — it stays MANDATORY even though it's merged into Round 2 — the v2.4.0 audit flagged silent-pass as a HIGH-risk gap because users have no way to catch a model misjudgment about USER VALUE / TESTABLE / SCOPED otherwise. (When SPLIT fires or the user picks anything other than "looks right", the split/re-clarify sub-flow below runs as its own follow-up — the merge is about the default clean-pass path, not about suppressing a needed split conversation.)

When SPLIT fires (or BUILDABLE/SCOPED fails on size grounds), follow the **`splitting-stories` playbook** with `level: feature`, the draft text, the AC list, and `domain_hints` inferred from the discussion. The skill returns split candidates with cited patterns and `acceptance_hint`s. Render each split candidate as chat text first — child title, one-line scope, and its `acceptance_hint` — then ask. The candidates are a capability-skill return the user hasn't seen, and option labels cannot hold them. "This looks like [N] stories, not one — split it? (split as suggested / pick which children to keep / capture as-is and refine later)". Reject any candidate that fails the skill's horizontal-slice check before presenting (the skill flags these in `horizontal_rejections` — re-prompt the skill if it returned any).

If viability kills the feature, run `shipyard-data draft obsolete-research --topic "<current topic>"` to set `<SHIPYARD_DATA>/spec/.research-draft.md`'s `obsolete: true` frontmatter sentinel (soft-delete sentinel — recovery logic filters it out; it stays as a soft-deleted record).

If a feature fails a gate, AskUserQuestion — don't block. Frame positively: "This feature needs X to be buildable" not "This feature fails because X is missing."
Example: "I can't write testable acceptance criteria for this yet — the scope is too broad. Can we narrow it to something specific? (narrow it / capture as-is and refine later)"

The user can override: "Just capture it as proposed, we'll refine later."

### Phase 3: Write to Spec

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-3-write-spec.md`

For each well-defined feature: generate the next FNNN ID, determine the epic (existing, new, or empty — see reference for the decision tree), and write `<SHIPYARD_DATA>/spec/features/FNNN-[slug].md` with full required frontmatter (id, title, type, epic, status, story_points, complexity, token_estimate, all RICE fields, feasibility, dependencies, references, external_refs, children, tasks, created, updated).

**External linking:** If the user mentioned an external issue key during discussion (e.g., "this is JIRA-123" or "relates to GH-456"), add it to `external_refs` in the feature frontmatter. Don't ask — if they said it, link it. Body sections: user story, Why This Matters, **acceptance criteria in Given/When/Then format** (happy path + at least one edge case), optional Interface / Data Model / Configuration / Flows / Error Handling sections (include only if discussed), Technical Notes (absorbed from `.research-draft.md`), Decision Log. **Hard limit: 200 lines per file** — split into sub-features (F001a/b) or extract to `<SHIPYARD_DATA>/spec/references/FNNN-<slug>.md` if larger. Fill every RICE component field; `rice_score` is the derived cached score `(reach × impact × confidence) / effort` and must match those components. Mark `.research-draft.md` obsolete via `shipyard-data draft obsolete-research --topic "<current topic>"` only after Phase 3 finishes (it is the recovery checkpoint until then).

**Diagram persistence:** Every diagram shown during Phase 1.5 — C4, sequence, state machine, ER, deployment, data-flow, or user-journey — is converted to Mermaid and written to the feature's `## Flows` section (an ER diagram may live under `## Data Model` instead when the schema is the feature's primary artifact). Diagrams shown in conversation are ephemeral — this is the only chance to persist them. The canonical diagram-type → Mermaid-syntax mapping is the single source of truth in `references/phase-3-write-spec.md`; keep this list in lock-step with it. See that reference for format rules.

**ASSUMED logging in the Decision Log.** Every HIGH-tier decision the confidence gate resolved without asking (Phase 1 and throughout) is recorded in the feature's `## Decision Log` in the ASSUMED form, distinct from user-confirmed `DECIDED:` entries:

```
ASSUMED: <decision> — <evidence one-liner> — reversible: yes
DECIDED: <decision> — <user's explicit answer>
```

These ASSUMED entries are what Phase 5's ASSUMPTIONS MADE section reads back for the one cheap audit point. See `references/question-design.md` § "Assumption logging."

**Narrate the write in one line** ("→ Wrote F012 to spec — 4 acceptance scenarios, RICE 24") so the transition into the Round-3 consolidated decisions is visible, never silent.

### Round 3: Consolidated post-spec decisions (Phases 3.5 → 3.7 → 3.8 → 4.5)

The four post-spec phases below all run their **analysis and present-and-apply work as usual and keep their checklist tasks** — but their **user-interruption points merge into ONE consolidated `AskUserQuestion` call** (up to 4 questions): impact ripples to confirm (3.5), E2E AC gaps to accept (3.7), simplification candidates to route (3.8), and (4.5 contributes rendered RICE re-evaluation blocks and cross-feature dependency edges to confirm — never estimate approvals). Run all four phases' analysis first, collect each one's decision items, then ask once. Consolidating the ask does NOT consolidate away the rendering: before the single call, render each contributing phase's decision block as chat text — the IMPACT ANALYSIS block (3.5), the E2E gap table with draft scenarios (3.7), the SIMPLIFICATION OPPORTUNITIES block (3.8), and the RICE RE-EVALUATION / cross-feature-edge blocks (4.5) — exactly as their reference protocols specify. Those blocks come from the dossier and analysis in your context; none of it is visible to the user until re-emitted, and the four question strings cannot carry it. An ask fired straight off the dossier Read with no blocks above it is the blind-ask bug this rule exists to prevent. Each impact ripple that changes existing behavior carries a one-line **before/after example scenario**, and each simplification candidate a one-line "today [X] is hand-rolled in [place]; [lib] would do [Y]" example — not just the summary block (see `references/question-design.md` § "Render an example scenario"); E2E gaps already carry draft scenarios. **Only sanctioned overflow:** an E2E gap set too large for one question may take a second call. Each phase notes below what it contributes to this single call rather than asking on its own.

### Phase 3.5: Impact Analysis

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/impact-analysis.md`

**Consume the dossier first.** The design deep-dive wrote the affected features/specs/code areas to `<SHIPYARD_DATA>/spec/.research-draft.md` under `## Impact Analysis`. Read that section and use it as the starting point — present and confirm-then-apply per the protocol rather than re-deriving the ripple set from scratch. If the section is absent (inline-fallback), run the analysis here as before.

**Presentation:** Keep impact summaries under 200 words. Bold the single most important finding. Use the 3-layer pattern for any impact that changes existing behavior. Show an impact diagram for features with multiple ripple effects:
```
  F007 (new) ──impacts──▶ F003 (criteria change)
             ──depends──▶ F001 (must be done first)
             ──overlaps─▶ F005 (shared data model)
```
**Persist it (≥2 ripple edges):** the inline ASCII is ephemeral. When the impact diagram has 2+ ripple edges, convert it to a Mermaid `graph LR` and write it into the new/refined feature's `## Decision Log` so the ripple map survives the session — see `references/impact-analysis.md` § "What Gets Changed on Approval". A single dependency edge stays a sentence (per `references/communication-design.md` "fewer than 3 data points").

**Contributes to the Round-3 consolidated call** — the ripple-confirmation is one of that call's ≤4 questions, not a separate interruption.

Skip if Glob `<SHIPYARD_DATA>/spec/features/F*.md` returns no results.

### Phase 3.7: E2E AC Validation

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-e2e-validation.md`

After impact analysis, validate the feature's acceptance criteria against the E2E taxonomy. Follow the `validating-e2e-coverage` playbook with the feature file path, existing AC, and domain hints. The skill detects touch surfaces from the spec content, maps to the E2E taxonomy, and returns coverage gaps with draft scenarios.

**Skip if:** feature is trivial (`story_points <= 2` AND `complexity == "low"`) or no touch surfaces detected.

**Contributes to the Round-3 consolidated call** — the accepted-gap decision is one of that call's ≤4 questions, not a separate interruption. **Overflow exception:** if the gap set is too large to fit as one question alongside the other three phases, it may take a second AskUserQuestion call (the only sanctioned Round-3 overflow). For accepted gaps, write to the feature file under `### E2E AC` within `## Acceptance Criteria`. If adding E2E AC would push the file over 200 lines, extract to `<SHIPYARD_DATA>/spec/references/FNNN-e2e-ac.md`.

### Phase 3.8: Simplification Opportunity Scan

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/simplification-scan.md`

Scan the codebase for places that hand-roll what this feature's new libraries, utilities, or patterns provide. The scan detects five types of opportunities: new dependency replacements, new utility reuse, pattern consolidation, abstraction adoption, and dead code from supersession.

**Skip if:** the feature is purely additive (new endpoint, new UI page) with no reusable infrastructure — nothing introduced that other code could benefit from.

**Consume the dossier first.** The design deep-dive wrote reuse candidates to `<SHIPYARD_DATA>/spec/.research-draft.md` under `## Simplification Candidates`. Read that section and use it as the starting point for the findings below; if absent (inline-fallback), run the scan here.

**At discuss time**, the scan operates on the feature's Technical Notes and research findings (not implementation code, which doesn't exist yet). Focus on:
- Libraries referenced in Technical Notes → grep for hand-rolled equivalents
- Patterns decided in the Decision Log → grep for ad-hoc variations
- Shared utilities mentioned in research → grep for inline duplicates

**Routing at discuss time:** All findings become IDEA files (since there's no sprint to fold tasks into yet). The sprint planning step (Step 3.75) will re-evaluate these and promote trivial/small items into sprint tasks if the feature is selected.

**Contributes to the Round-3 consolidated call** — the routing decision is one of that call's ≤4 questions, not a separate interruption. If no opportunities found, contribute nothing and move on silently.

### Phase 4: Capture Tangential Ideas

Any tangential features mentioned → create as idea files via the same logic as CAPTURE mode above.

### Phase 4.5: Backlog Re-evaluation

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/backlog-reeval.md`
!`shipyard-context reference ship-discuss backlog-reeval 55`

**Contributes to the Round-3 consolidated call** — only cross-feature dependency edges ride in this call; re-estimations are decide-and-inform (rendered + ASSUMED-logged), never a question. (Other-feature mutations still follow the protocol's AskUserQuestion-with-evidence rule; they ride inside this consolidated call.)

Skip if BACKLOG.md is empty or doesn't exist.

### Phase 4.9: Quality Gate (self-review loop)

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-quality-and-critique.md`

Before presenting to the user, re-read each feature file and run the 15-check quality gate (Given/When/Then formatting, happy + edge cases, no ambiguous words, no TBDs, RICE populated, dependencies identified, prescriptive research, NFRs, EARS syntax, all states covered, etc. — full table in the reference). Iterate fixes up to 3 passes. **This is a no-input self-review loop — run it quietly: do NOT narrate each pass or print the table. Surface at most a one-line result** (`→ Quality gate: passed` or `→ Quality gate: 2 items unresolved`); flag any remaining gaps as "Unresolved — needs follow-up in /ship-discuss [ID]" (they ride into the Phase 5 summary), then proceed to Phase 4.95.

### Phase 4.95: Adversarial Critique

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-quality-and-critique.md`

After the quality gate passes, spawn a `general-purpose` critic subagent (inline prompt in the reference — kept inline per S-1 granularity) to challenge the spec from angles self-review misses: implicit assumptions, feasibility risks, ambiguities, missing error states. Determine stakes level: `high` if feature is part of an epic, story_points ≥ 8, touches auth/payments/data, or has 6+ acceptance scenarios; `standard` otherwise.

**Dispatch the critic CONCURRENTLY with composing the Phase 5 summary.** The critic and the Phase 5 summary composition are independent — launch the critic (background where available), then compose the FEATURES DEFINED / verbatim-AC summary while it runs. **Reconcile the critic's findings BEFORE asking the user anything** (the Round-4 sign-off call must reflect the reconciled spec, not a pre-critic one): when the critic returns, apply its mechanical fixes silently, then hold its judgment-call items for the merged batch below.

**If the summary is composed before the critic returns, WAIT for the critic silently — waiting is never a user decision and never an AskUserQuestion.** Print one status line ("→ Summary ready; critic still running — waiting") and poll the background handle, bounded budget. On critic timeout/failure, state it in one line ("Critic didn't return — proceeding with self-review only, noted in the Decision Log") and continue to Round 4; do not ask whether to proceed.

**Process the critic's findings in ONE merged batch.** Fix what's fixable without user input. Then combine the critic's judgment-call items AND the silent-assumption-surfacing items into a **single AskUserQuestion batch** — rendering each item's finding, the critic's evidence, and your recommendation as chat text (compact list, one entry per item) immediately before the batch. The critic's return is a subagent payload the user has never seen; evidence packed into question/option strings renders as a compact card and does not count as shown. Semantic assumptions are surfaced through this question, never encoded into the spec silently (see the reference). Log CONCERN items in the Decision Log. **Do NOT re-run the critic after fixes.** One round only.

### Phase 4.97: Scope-Drift Check ("did we drop something?")

**Delivery: this check is folded INTO the Phase 5 summary presentation, not run as a separate interruption before it.** The two-column diff below is shown as part of the Round-4 summary, and its "did anything get dropped?" question is embedded in the Round-4 call (it rides alongside the AC sign-off / approval sequence rather than costing its own round). The check itself still runs, once, in full — only its interruption merges into Round 4.

The discussion entered Phase 1 with one shape (the user's initial topic, idea, or feature request) and may have evolved through challenge, viability, impact, and critique — sometimes losing scope on the way. Up to this point in the skill, there is no checkpoint that asks the user whether the spec they're about to approve still covers everything they originally wanted. Phase 4 captures NEW tangents that come up; this phase asks about OLD intent that may have been dropped.

Run this check exactly once per discussion, regardless of mode (NEW, IDEA-graduated-to-NEW, REFINE). Skip only on CAPTURE mode (which doesn't write acceptance criteria at all).

Compose a two-column diff in plain text:

```
  Started with:                          Landed at:
    "[paraphrase of user's initial         F012 — [title]
     topic from Phase 1 / the                  • [scenario 1 one-liner]
     IDEA file / the REFINE prompt]"          • [scenario 2 one-liner]
                                              • [scenario 3 one-liner]
                                              (RICE [score], [complexity])
                                          IDEA-007 — [title of tangent captured during Phase 4]
                                          IDEA-009 — [title of tangent captured during Phase 4]
```

The two-column diff is carried into the Phase 5 summary as the SCOPE-DRIFT DIFF section, and the question "Did anything important from the original idea NOT make it into the spec? (nothing dropped — proceed to approval / something is missing — let me add it / a piece I wanted got captured as an IDEA instead — promote it)" is asked there, embedded in the Round-4 call (see Phase 5's "Scope-drift question" paragraph for the full delivery, defaults, and the missing/promote branches). Default-recommend "nothing dropped" only if the spec's acceptance themes cover every noun/verb in the user's initial topic (paraphrase from Phase 1's first AskUserQuestion).

This phase has zero existing coverage anywhere else in the skill — until v2.4.0, there was no point where the user was asked "what did we cut?" Scope creep prevention was implicit in the model's judgment, which means it was silent and unrecoverable. The audit flagged this as a HIGH-risk gap.

### Phase 5: Spec Approval Gate (NOT an Implementation Plan)

Feature files are already written with `status: proposed`. This is a spec approval summary — implementation belongs to `/ship-execute` after `/ship-sprint` plans the work. It is never this skill's job.

**STOP rule — read before presenting the summary.**

The summary is *past-tense outcomes only*. What was discovered, decided, and written to spec files. No future-tense implementation verbs (`will modify`, `add function`, `edit class`, `change file`). If you catch yourself composing any of the following, you are in the wrong skill — stop and resume the discussion:

- File paths outside `<SHIPYARD_DATA>/` as steps to change
- A task list that reads like TODO items for building the feature
- Anything that looks like `/ship-execute`'s output

Output the discussion outcome as text. Use these sections only — describe what already exists in the spec files, not what should be built:

- **FEATURES DEFINED** — per feature: ID, title, points, RICE, complexity, one-line user story, acceptance-scenario count, NFRs, high-RPN failure modes, edge cases, dependencies
- **ACCEPTANCE SCENARIOS (VERBATIM)** — for each feature, list **every acceptance scenario in full Given/When/Then text** exactly as it was written to the spec file.
  For each feature, group scenarios by tier:
  - **Core AC** — happy path + edge cases
  - **E2E AC** — taxonomy-validated scenarios (show `[category]` tag for context) Do not paraphrase, do not summarize, do not list "N scenarios" without showing them. These scenarios are the test contract that `/ship-execute` will treat as authoritative — the user must read the actual text, not approve on a count.
- **HOW WE'LL PROVE IT WORKS** — per feature, the `user_flow_probe`: its `kind` and, verbatim, the `command` and/or `steps`. This is the proof the feature works *for a user*, and it is part of what "Approve everything" approves — a probe the user never read is a bar they never agreed to. Flag `kind: manual`/`assisted` explicitly ("this one needs you to confirm on a device at sprint end") so the later interruption is expected rather than a surprise, and flag any `skip-with-reason` as a known gap.
- **IDEAS CAPTURED** — tangential ideas filed during discussion
- **EPIC** — if assigned, show epic with all features
- **IMPACTS** — cross-feature changes already applied to spec files
- **BACKLOG EFFECT** — re-estimation notes, priority shifts
- **ASSUMPTIONS MADE** — every `ASSUMED:` entry from the feature Decision Logs (the HIGH-tier decisions the confidence gate resolved without asking), each with its evidence one-liner and reversibility. Lead the section with "flag any to change before approval" — this is the one cheap audit point for the decide-and-inform assumptions (see `references/question-design.md`).
- **SCOPE-DRIFT DIFF** — the Phase 4.97 two-column "Started with → Landed at" diff (below), shown here rather than as a separate interruption.
- **UNRESOLVED** — quality-gate items flagged for follow-up

**Consolidated approval gate — this IS Round 4 (the single endgame interruption).** Everything the user approves — the acceptance scenarios, the scope coverage, and the spec — is approved in ONE gate. The safeguard that used to justify a separate AC round is preserved structurally by the render-before-ask rule (see `references/question-design.md` § "Render before asking"): every acceptance scenario is quoted VERBATIM in the summary text above (the ACCEPTANCE SCENARIOS (VERBATIM) section), the SCOPE-DRIFT DIFF is shown, and the ASSUMPTIONS MADE are listed — all as chat text — BEFORE the single AskUserQuestion. The user reads the real scenario text and scope diff on screen; the tool call carries only the short question and option labels. Approving is therefore approve-having-read, not approve-a-count.

Render the full summary as text first (all sections above — this is the render-before-ask step). Then ONE `AskUserQuestion`:

- **Approve everything (Recommended)** — approves the acceptance scenarios as written, confirms nothing was dropped from the original scope, and approves the spec. Proceeds to Phase 6 (Finalize). The discussion is not complete until Phase 6 runs in full.
- **Fix an acceptance scenario** — a scenario is wrong, unclear, or missing. A follow-up `AskUserQuestion` captures which scenario and the correction; update the feature file, re-render the affected scenario(s) as text, and re-present this gate.
- **Something's missing from the original scope** — using the SCOPE-DRIFT DIFF, the user names a dropped concern. Re-enter Phase 1 with it as the seed (re-run 1.5b → 2 → 3), or promote a captured IDEA back into the feature (inline-merge or split into a sibling feature); then re-render and re-present this gate.
- **Refine** — broader iteration; stay in discussion, re-enter Phase 5 when ready. Do not run `lock release` — the planning lock stays held.
- **Reject** — leave features at `status: proposed`, then release the planning mutex with `shipyard-data lock release planning --skill ship-discuss` as the last action and stop. User can resume with `/ship-discuss [ID]`. Keep the lock only for nonterminal **Refine** paths.

**Do not skip rendering the verbatim scenarios and the scope-drift diff before this gate.** The v2.4.0 audit flagged approving-a-count as the single largest risk surface in `/ship-discuss`; the mitigation is now the render-before-ask guarantee (the actual scenario text is on screen), not a dedicated extra round. Loop the "Fix an acceptance scenario" and "Something's missing" adjust paths — re-rendering and re-asking — until the user picks **Approve everything**.

### Phase 6: Finalize (only on Approve)

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-finalize.md`

Run these steps in order. The active-skill mutex stays active until the **very last** step so that any accidental Edit to a source file during Finalize still gets blocked. Do not reorder to "optimize" the cleanup.

0. **Gate — every approved feature has a `user_flow_probe`.** Run `shipyard-data feature check-probes <all approved IDs>` before any status flip. Non-zero exit names features missing a probe: author each one now (shape + `kind` decision table in `references/phase-3-write-spec.md`), render it as chat text, and re-run until it exits 0. Do NOT proceed to step 1 with a feature still missing its probe — this is the enforcement that makes "authored at spec time" true instead of aspirational. Full protocol: `references/phase-finalize.md` step 0.
1. **Update feature statuses** — run `shipyard-data feature set-status FNNN approved` for each approved feature.
2. **Append to BACKLOG.md** — run `shipyard-data backlog add <IDs>` (one call, all approved IDs together).
3. **Mark graduated ideas** — for IDEA-sourced features, run `shipyard-data idea set-status IDEA-NNN graduated --to FNNN`. This `shipyard-data` Bash call runs fine inside the guarded window — the active-skill mutex only blocks accidental Edits to source files, not CLI state mutations — and doing it here keeps the lifecycle change inside the mutex window.
4. **Constitution amendment prompt** — if `.research-draft.md` has `## Constitution Gaps`, render the candidate rules as chat text and ask whether to add them to project rules. Keep this before draft cleanup so the gap evidence is still present.
5. **Mark `.research-draft.md` obsolete** if it still exists with the current topic: run `shipyard-data draft obsolete-research --topic "<current topic>"`.
6. **Print the Next Up block** (see below).
7. **Last action — after everything above has flushed:** run `shipyard-data lock release planning --skill ship-discuss` (soft-delete sentinel — CLI-owned, never a hand Write). After this step, do **not** continue with any tool calls — the discussion is done. If the user wants to build the feature, they will run `/ship-sprint` in a new session.

---

## REFINE Mode: Update Existing Feature

### Step 0: Sprint Impact Check

Before anything else, check if this feature is in an active sprint:

1. **Read the active sprint file** (`<SHIPYARD_DATA>/sprints/current/SPRINT.md` — check if this feature's ID appears in any wave, or if any task in the feature's `tasks:` array appears in the sprint)
2. **Check task status** — are any tasks for this feature already in-progress or completed?

If the feature is **in an active sprint**, render the sprint state as chat text first — sprint ID, task progress, which tasks are in-progress/done — then ask; the warning block belongs in chat, not inside the question string (the AskUserQuestion card cannot carry it, and the sprint file is a Read result the user hasn't seen). AskUserQuestion:

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
!`shipyard-context reference ship-discuss phase-1-5b-challenge 80`

Apply each section to what's already in the spec — audit assumptions baked into the current writing, sweep for edge cases not covered by existing acceptance scenarios, scan for conflicts with features added since this was first discussed, and list what's still missing.

### Step 3: Gather Updates

Based on what Phase 1.5 surfaced, use AskUserQuestion (never plain text) to gather updates — bundle gaps into a single question where possible (one call, per the bulk-ask discipline). Render the Step-2 challenge findings as chat text first (the compact ⚠️/✅/❓ summary block), then ask. The findings came from the challenge protocol and file Reads — invisible to the user until re-emitted; bundled question items cannot substitute for the block.
- Resolve each gap: addressed / deferred / not needed
- New insights, changed requirements, concerns?
- New acceptance scenarios for uncovered edge cases
- **Technical decisions made since last discussion?** Derive these from the record FIRST — `git log` since the feature's `updated:` date and the diff of the spec/code areas the feature touches — then STATE what you found ("since we last talked, the auth middleware moved to `lib/auth/` and you switched to Argon2"). Ask only about decisions the record can't show (rationale, intent, things not yet committed). Don't ask the user to recite what git already records.

### Step 4: Update & Re-evaluate

1. **Update the feature file** — preserve decision log, add new entries with date
2. **Recalculate estimates** — scope likely changed after surfacing gaps
3. **Re-run viability gate** — feature may now be better defined (or need splitting)
4. **Backlog**: If estimates changed, no need to update BACKLOG.md — it only stores IDs. The updated data will be read from the feature file next time the backlog is displayed.

**E2E AC Backfill:** After challenge, check if the feature has any `tier: "e2e"` AC (look for `### E2E AC` section). If not, invoke Phase 3.7 (E2E AC Validation) as backfill. Present as: "This feature predates E2E taxonomy validation." See `references/phase-e2e-validation.md` § Backfill Protocol.

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

After the impact analysis (and any sprint-replan choices) is applied, run Phase 5 (Spec Approval Gate) and Phase 6 (Finalize) against the refined feature. Same STOP rule, same ordering invariant: the active-skill mutex stays active until the last step.

REFINE-mode differences from NEW-mode finalize (status no-op for already-approved features, BACKLOG.md no-op if ID already present, idea archival only if this run graduated an idea, cancel-branch cleanup) are documented in `references/phase-finalize.md` under "REFINE-mode differences".

---

## Rules

**How to ask is governed by `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/question-design.md`** — the confidence gate, the ten-rule rulebook, the kill-list, and the bulk-ask discipline. The rules below are the load-bearing summary; that file is the authority.

- **Use AskUserQuestion — never plain text for questions.** AskUserQuestion is a tool call that suspends execution and waits for user input. Plain text output does not pause — the model will continue without user input. Every question that requires an answer must use AskUserQuestion.
- **Render before asking.** Before every AskUserQuestion, render the decision context — the scenarios, concrete examples, tradeoffs, and any verbatim content being approved — as chat text; the tool call then carries only the short question and option labels. A bare AskUserQuestion with no rendered context above it is a bug (the window is too small to carry a real decision). Content in a Read result, a subagent/Agent return, a SendMessage payload, or a dossier file does NOT count as rendered — re-emit it as chat text; and question/option strings render as a compact card, so packing the context into them is the same bug. If the user says "show me" or "I don't see X", render in full before any further ask.
- **Confidence gate before every question (replaces "never assume").** Score each pending decision on evidence convergence and reversibility. **HIGH** (evidence converges AND two-way door) → **decide, inform in one line ("Going with X — [why]. say 'change' to override"), and log as `ASSUMED:`** — do NOT ask. Only **MEDIUM** and **LOW** items reach AskUserQuestion. **One-way doors and user-value questions (who it's for, whether it's worth building) are never HIGH** — they always ask; the Phase 2 viability echo stays mandatory. This is the opposite of the old "never assume technical decisions" rule: for reversible, evidence-backed calls, assuming-and-informing is faster and better than interrupting.
- **Always recommend.** Every question to the user must include your recommendation. Never ask "A or B?" without saying which you'd pick and why. Options are outcomes with tradeoffs, not mechanisms (rulebook Q4).
- **Don't ask what the record already answers — check the kill-list.** Before every AskUserQuestion call, run the kill-list in `question-design.md` (derivable from code/config, derivable from the spec dir, restating the user's own words, universal-yes questions, framework-vocabulary questions, hypothetical-opinion questions, two-way-door minutiae, questions whose answer won't change the spec, derivable-by-analysis judgments like story points/RICE/estimates, and process/orchestration mechanics like whether to wait for background work). If it's on the list, STATE what you found or decide-and-log instead. Example: don't ask "should login errors be user-friendly?" — of course they should. Do ask "should we rate-limit login attempts? I'd recommend 5 per minute to prevent brute force."
- **Question budget: ≤5 asks through Phases 1–2, 4–5 interruption rounds total.** Round 1 bulk understanding, Round 2 challenge + viability echo, Round 3 consolidated post-spec decisions, Round 4 consolidated approval (verbatim ACs + scope-drift + spec, one gate). Overflow items become HIGH assumptions, not extra asks. Every round beyond that needs a reason.
- **Be conversational, not mechanical.** This is a discussion, not a form.
- **Suggest structure.** If the user rambles, organize their thoughts into features/epics.
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
