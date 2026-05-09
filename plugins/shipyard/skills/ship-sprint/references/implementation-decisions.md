# Surfacing Implementation Decisions (Step 3.7) and Simplification Scan (Step 3.75)

## Step 3.7 — Surface Implementation Decisions

After research, identify every point where there's a meaningful choice — don't silently pick one and move on. Common decision points:

- **Library/framework choice** — "Use Zustand vs Redux vs Jotai for state management"
- **Architecture approach** — "Server components vs client components for this page"
- **Data modeling** — "Separate table vs JSON column for this data"
- **API design** — "REST vs GraphQL vs tRPC for this endpoint"
- **Migration strategy** — "Big bang vs incremental strangler fig"
- **Build vs buy** — "Hand-roll auth vs use Auth.js vs use Clerk"

For each decision point:

1. **Output explanation** (plain text) — describe the options, tradeoffs, what the codebase already uses, what research found, and your recommendation with reasoning
2. **AskUserQuestion** — short summary with numbered choices and your recommendation

```
State management approach for F001:

1. Library A — already used in the project, team knows it, well-documented
2. Library B — newer, less boilerplate, but no team experience
3. Custom solution — full control, but more code and maintenance

Recommended: 1 — already a dependency, aligns with existing patterns in the codebase
```

**If research can't resolve the decision** — offer a POC spike:

```
I can't confidently recommend an approach here. Want me to spike it?

1. Spike it — I'll build a minimal POC in a worktree to test [option A] vs [option B] (takes ~5-10 min, throwaway code)
2. Pick one — go with [your recommendation] and course-correct during execution if needed
3. Defer — park this feature and plan the rest of the sprint

Recommended: 1 — the risk of picking wrong is high enough to justify a quick spike
```

### POC spike flow (if user chooses spike)

A POC spike does not fit `dispatching-task-loop`'s contract (no tests, no atomic commit, no acceptance probe — the deliverable is a recommendation, not production code). Dispatch directly via `general-purpose` with `isolation: "worktree"` so the spike runs in throwaway isolation:

```
Agent(subagent_type: "general-purpose", isolation: "worktree", prompt: |
  Build a minimal proof-of-concept to test: <SPECIFIC QUESTION>.
  No tests needed. No production quality. Just prove whether <APPROACH>
  works in this project's context.

  Work in your worktree freely — commits stay on the worktree branch and
  will be discarded after this spike (the worktree is throwaway).

  Return: what worked, what didn't, any gotchas you hit, and your
  recommendation for the planning conversation.
)
```

After the subagent returns, read its findings, present to the user with the updated recommendation, and AskUserQuestion with the revised choices. The worktree gets cleaned up automatically by Claude Code's stale-worktree cleanup since nothing merges back.

7. Record decision in the feature's Decision Log: "POC spike: tested [approach], found [result], chose [decision]"
8. Worktree is automatically cleaned up (throwaway)

The POC takes minutes, not hours. It answers "will this work?" with evidence instead of guessing.

**If no meaningful choices exist** (the codebase already uses a framework, there's only one sensible approach, or the feature is straightforward) — skip this step for that feature and note in Technical Notes: "No implementation decisions — approach follows existing patterns."

**Record all decisions** in the feature file's `## Decision Log` with date and reasoning. These decisions flow into task Technical Notes so the builder knows what was decided and why.

**Write findings to each task file `## Technical Notes`** (after Step 4 creates task files). The full template lives in `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/task-tech-notes-template.md` — Read it once at the start of Step 4, then fill it in per task and Write directly to the task file. **Do not echo the template back into conversation.** Task specs must be executable: a builder follows them mechanically without re-reading the feature file.

## Step 3.75 — Simplification Opportunity Scan

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/simplification-scan.md`

Now that research has identified the libraries, patterns, and utilities this sprint will introduce, scan the codebase for simplification opportunities. This is more concrete than the discuss-time scan because implementation decisions have been made and files-to-modify are identified.

**Skip if:** no selected feature introduces new libraries, shared utilities, or patterns (purely additive features with no reusable infrastructure).

**Process:**
1. For each selected feature, extract from research findings and decision log:
   - New libraries being added (from Step 3.7 decisions)
   - New utilities/helpers being created (from architecture analysis)
   - New patterns being introduced (from implementation strategy)
2. Run the 5 detection strategies from the protocol against the codebase
3. Also check existing IDEA files: use Grep with `pattern: ^source: "?simplification-scan`, `path: <SHIPYARD_DATA>/spec/ideas`, `glob: IDEA-*.md`, `output_mode: files_with_matches` — a previous `/ship-discuss` may have already found opportunities for features now entering the sprint. Re-evaluate those: are they still valid? Can any be promoted to sprint tasks now?

**Routing at sprint time:**

| Effort | Route | Action |
|---|---|---|
| **Trivial** (< 15 min, < 5 files) | Extend existing task | Add to the relevant task's Technical Notes under **Cleanup** |
| **Small** (< 1 hr, < 10 files) | New cleanup task | Create a task in the final wave with dependency on the feature task that introduces the new thing |
| **Medium/Large** | IDEA file | Create or keep existing IDEA file for backlog |

**Scope guard:** Total effort of trivial + small items MUST NOT exceed 20% of sprint capacity. Excess → demote to IDEA files.

Present findings using the protocol's format and AskUserQuestion: "Apply these simplification opportunities? (all / pick / skip)"

- **all** → extend tasks, create cleanup tasks, create/keep IDEA files
- **pick** → user selects
- **skip** → note in sprint draft: "Simplification scan ran, opportunities deferred"
