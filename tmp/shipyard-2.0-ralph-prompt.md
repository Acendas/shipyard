# Shipyard 2.0 Implementation — Ralph Loop Prompt

You are implementing **Shipyard 2.0** by working through every action item in `tmp/shipyard-2.0-action-items.md`. The same prompt fires every iteration; your prior work persists in files + git. Each iteration: pick the next unchecked item, finish it for real, mark it done with evidence, commit, repeat.

## Iron Laws (non-negotiable)

```
NO CHECKBOX FLIPS WITHOUT EVIDENCE
NO CLAIMS WITHOUT FRESH VERIFICATION
NO COMMITS THAT DO NOT MATCH WHAT YOU JUST CHANGED
```

Specifically:

1. **An action item is "done" only when:** the change is in a commit, the verification command exits 0 (or the eval/test passes), and the file/state actually reflects what the item described.
2. **Run the verification command in this iteration.** "It worked last time" is not evidence. Run it. Read the output. Then claim.
3. **One commit per item or per tight cluster.** Atomic. Message format: `<sprint>(<item-id>): <one-line>` (e.g. `s1(F-3): drop 9 hooks, keep 3`).
4. **If you cannot complete an item this iteration, leave it unchecked.** Do not partially flip.

## Source of truth

`tmp/shipyard-2.0-action-items.md` — every action item has an ID (`CC-N`, `F-N`, `R-N`, `S-N`). When you complete one, prefix the line where the ID is first defined with `[x]`. When you start one, prefix with `[~]`. Untouched items remain unprefixed.

Examples:
- `- **F-3.** Delete agent-heartbeat …` → `- [x] **F-3.** Delete agent-heartbeat …`
- `- **F-7.** Drop the 4-step chain …` → `- [~] **F-7.** Drop the 4-step chain …` (when in progress)

The file IS the progress board. Do not create a separate progress file.

## Iteration recipe (run this every iteration)

### Step 1 — Read the board
Read `tmp/shipyard-2.0-action-items.md`. Skim for `[ ]` / `[~]` / `[x]` markers. (If the file has no markers yet, this is the first iteration — initialize markers by adding `[ ]` to every action item ID.)

### Step 2 — Pick the next item
Order rules (strict):
1. **Sprint order.** Complete Sprint 1 fully before Sprint 2. The sprint sections are: "Sprint 1 — De-globalize", "Sprint 2 — Ralph-without-bloat", "Sprint 3 — Lean the data layer", "Sprint 4 — Slim ship-execute", "Sprint 5 — Polish".
2. **Within a sprint**, work in the order items are listed in the "Recommended sprint sequence" section.
3. **Cross-cutting items (CC-N) and skill-decomposition items (S-N)** integrate into the sprint where the section says they go (S-2 names exact waves).
4. **Capability skills (S-1 through S-8)** are built alongside Sprint 1–5, not separately. Build a capability skill the moment its first consumer in the sprint sequence needs it.

If unsure which to pick, pick the lowest-numbered `[ ]` item that lives in the earliest unfinished sprint. If you start one, mark it `[~]` immediately.

### Step 3 — Plan the change in one sentence
Before any edit, write one sentence to yourself: "I am changing X from Y to Z because <action-item-id> says so." If you can't, you don't understand the item — re-read it. If the item is ambiguous, log a clarifying question in `tmp/shipyard-2.0-questions.md` (one section per item) and skip to the next item.

### Step 4 — Delegate via subagent when scope > one file or > 100 lines
Keep YOUR context lean. For substantive changes:

- Use `Agent(subagent_type: general-purpose, prompt: …)` with a tight, self-contained prompt.
- The subagent must do its own verification before returning.
- Subagent's return must include: `STATUS: COMPLETE` or `STATUS: BLOCKED`, `COMMIT: <sha>` (if any), and a 5–20 line summary of what changed and what was verified.
- If the subagent returns `STATUS: BLOCKED`, do NOT retry blindly — read the reason, decide whether to retry with a tighter prompt, escalate to the user via AskUserQuestion, or skip and log to questions.md.

For trivial edits (≤ one file, ≤ 30 lines), do them directly.

### Step 5 — Verify before claiming
For each item, define and run the verification:

| Item type | How to verify |
|---|---|
| Hook deletion (F-3, etc.) | `node -e "JSON.parse(require('fs').readFileSync('plugins/shipyard/hooks/hooks.json'))"` and grep that the hook name no longer appears |
| File deletion | `ls plugins/shipyard/agents/ \|\| echo gone` |
| Skill body edit | Read the file; grep for the new content |
| Resolver simplification (F-7) | Run the existing tests: `python3 plugins/shipyard/tests/test_shipyard_resolver.py` |
| New capability skill (S-1..) | Read its SKILL.md; eval-run if assertion file exists |
| Eval coverage | `python3 plugins/shipyard/tests/eval-run.py` and check it exits 0 |
| Anything code-y under `bin/` | Existing pytest suite: `python3 -m pytest plugins/shipyard/tests/` |

Run the smallest sufficient verification. **Capture the verification command output** (paste the last 10 lines into the commit body).

### Step 6 — Commit
Atomic commit per item. Stage only what this item changed. Message:
```
<sprint-tag>(<item-id>): <one-line summary>

<2-5 line body explaining the change>

Verification:
  $ <command>
  <last 10 lines of output>
```

Sprint tags: `s1`, `s2`, `s3`, `s4`, `s5`. For cross-cutting work that doesn't fit one sprint, use `cc`. For skill-decomp: `s` (e.g., `s(S-1)`).

### Step 7 — Mark `[x]` on the action items file
Edit `tmp/shipyard-2.0-action-items.md`: change the leading marker from `[~]` to `[x]` on the item you just finished. Commit this edit as part of the item's commit OR as a tail edit `chore(progress): mark <item-id> done`.

### Step 8 — Decide: continue or promise
Re-read the action items file. Count `[x]` vs total. Run the **completion guard** (below). If everything passes, output the promise and exit. Otherwise, return to Step 1 (Ralph re-fires the prompt).

## Completion guard (run before emitting the promise)

All of these must be true. If any fails, do NOT emit the promise — fix it first:

1. **All `CC-`, `F-`, `R-`, `S-` items are `[x]`** in `tmp/shipyard-2.0-action-items.md`. (Items that became obsolete during implementation may be marked `[x]` with a one-line obsolete-reason in the line itself.)
2. **`plugins/shipyard/agents/` directory does not exist** (CC-1 / F-25). Verify: `[ ! -d plugins/shipyard/agents ] && echo gone`.
3. **`plugins/shipyard/hooks/hooks.json` has at most 3 hook configurations**: `SessionStart`, `PreToolUse Edit|Write|MultiEdit|NotebookEdit`, `WorktreeCreate`. Verify by reading the file.
4. **No `.claude/rules/shipyard-*.md` is written by `/ship-init`** (F-29 / F-30). Verify by grepping `plugins/shipyard/skills/ship-init/SKILL.md` for `.claude/rules/shipyard` — there should be no Write call writing to that path. There SHOULD be the legacy-removal step (F-50).
5. **Plugin version is `2.0.0`** in `plugins/shipyard/.claude-plugin/plugin.json` (F-1).
6. **Eval suite passes:** `python3 plugins/shipyard/tests/eval-run.py` exits 0.
7. **Python tests pass:** `python3 -m pytest plugins/shipyard/tests/` exits 0.
8. **All 14 capability skills exist** at `plugins/shipyard/skills/<name>/SKILL.md` (S-1):
   - `verifying-completion`, `tdd-cycle`, `running-acceptance-probe`, `anti-stub-scan`
   - `dispatching-task-loop`, `dispatching-spec-review`, `dispatching-code-review`, `dispatching-research-task`, `dispatching-operational-task`
   - `using-worktrees`
   - `acquiring-skill-lock`
   - `discovering-edge-cases`, `extracting-acceptance-criteria`, `authoring-acceptance-probe`
   Verify: `for s in verifying-completion tdd-cycle … ; do test -f plugins/shipyard/skills/$s/SKILL.md || echo MISSING $s; done`
9. **`ship-execute/SKILL.md` ≤ 400 lines** (F-43). Verify: `wc -l plugins/shipyard/skills/ship-execute/SKILL.md`.
10. **No registered builder agent referenced** anywhere: `grep -r "shipyard:shipyard-builder\|shipyard-builder.md" plugins/shipyard/skills/ \|\| echo none`.

When all 10 pass, emit:

```
<promise>SHIPYARD_2_0_COMPLETE</promise>
```

## Discipline rules (re-state every iteration)

- **Don't refactor for refactor's sake.** `ship-discuss`, `ship-sprint`, `ship-backlog`, `ship-spec`, `ship-status` work today. Touch them only as the action items specify (mechanical CC-1 conversions, capability extractions in Sprint 5).
- **Lean orchestrator.** Your context (this iteration's window) holds the *flow*, not the *content*. Push substantive edits into subagents.
- **One item at a time.** Don't batch flips of multiple items into one commit unless the items are explicitly grouped in the action items doc (e.g., a single capability skill creation that satisfies S-1 + part of F-26).
- **If you find a NEW issue not in the action items file**, append a new item (use a new ID like `EXT-1`, `EXT-2` for extension findings) and put it at the end of the appropriate sprint. Don't silently drift.
- **Never edit `tmp/shipyard-2.0-action-items.md`** except to flip `[ ]` → `[~]` → `[x]` markers, append `EXT-N` items, or strike obsolete items with a one-line reason. Don't rewrite the document.
- **Don't skip the completion guard.** Even if you "feel" done. Run every check. Read every output. Then promise.

## When stuck or in doubt

- **Repeated failure on the same item (3+ iterations):** Add a section to `tmp/shipyard-2.0-questions.md` describing what you tried, the failure mode, and what you'd need from the user. Mark the item `[~]` (still in progress) and move on to a different unblocked item. Don't loop on the same blocker forever.
- **Existing tests broken by your change:** Stop. Investigate. Fix the implementation, not the test. If the test is genuinely wrong (rare), document why in the commit body.
- **Verification command doesn't exist:** Define one. Pick the smallest sufficient check. Document it in the commit body.

## Bootstrap (only on the very first iteration)

If the action items file has zero `[ ]`/`[~]`/`[x]` markers, this is iteration 1. Initialize:

1. Open `tmp/shipyard-2.0-action-items.md`.
2. For every line that starts with `- **CC-`, `- **F-`, `- **R-`, `- **S-`, prefix the `**` with `[ ] `. For example: `- **F-3.** Delete agent-heartbeat …` becomes `- [ ] **F-3.** Delete agent-heartbeat …`.
3. Commit: `chore(progress): initialize Shipyard 2.0 progress markers`.
4. Then proceed to Step 1 of the iteration recipe.

This is a one-shot. Subsequent iterations skip this section because markers already exist.

---

Begin. Read the action items file. Pick the next item. Do it for real. Verify. Commit. Mark `[x]`. Loop.
