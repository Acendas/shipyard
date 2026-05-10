# Phase 6 Finalize — Detail

This is the full protocol for Phase 6 (Finalize) in `/ship-discuss`. The SKILL body summarizes; this file holds the how.

## Ordering invariant

Run these steps in order. The active-skill mutex stays active until the **very last** step so that any accidental Edit to a source file during Finalize still gets blocked — that's the whole point of the ordering. Do not reorder to "optimize" the cleanup.

1. **Update feature statuses.** For each approved feature, change `status: proposed` → `status: approved` in its spec file (`.md`, allowed by the guard).
2. **Append to BACKLOG.md.** Use the Edit tool to add approved feature IDs to `<SHIPYARD_DATA>/spec/BACKLOG.md` (`.md`, allowed by the guard).
3. **Mark graduated ideas.** If any features were sourced from an IDEA file (IDEA mode), use the Edit tool to set `status: graduated` and add `graduated_to: FNNN` in the corresponding `<SHIPYARD_DATA>/spec/ideas/IDEA-NNN-*.md` frontmatter now. Doing this here — inside the guarded window — keeps the lifecycle change inside the mutex window.
4. **Constitution amendment prompt.** If `.research-draft.md` has a `## Constitution Gaps` section with unresolved-or-resolved entries, surface them now. For each gap, the Phase 1.5b discussion produced an explicit decision (the user picked an approach for the gray area) — those decisions are candidate constitution rules. Present them as a single AskUserQuestion: "This feature settled [N] questions the constitution doesn't currently answer: [bullet list, one line each: 'how to handle X — decision: Y']. Want me to add these to `.claude/rules/project-*.md` so the next feature inherits the decision? (yes/pick/no)". On `yes`/`pick`, append to the most relevant existing `project-*.md` (or create `project-<area>.md` if none fits) with the decision, the *why*, and the feature ID that prompted it as the rationale anchor. Do this BEFORE step 5 so the rules land inside the mutex window.
5. **Use the Edit tool to also mark `.research-draft.md` obsolete** if it still exists with the current topic — sets `obsolete: true` in its frontmatter.
6. **Print the Next Up block** (see SKILL.md "Next Up" section). The user sees it and the conversation is effectively over.
7. **Last action — after everything above has flushed:** use the Write tool to overwrite `<SHIPYARD_DATA>/.active-session.json` with `{"skill": null, "cleared": "<iso-timestamp>"}` (soft-delete sentinel — the mutex pattern treats `skill: null` as inactive). Until this step, the active-skill mutex still claims this session for `/ship-discuss` and other skills entering will refuse. After this step, do **not** continue with any tool calls — the discussion is done. If the user wants to build the feature, they will run `/ship-sprint` in a new session.

## REFINE-mode differences

REFINE-specific differences from the NEW-mode finalize:

- Phase 6 step 1 is a no-op for features that were already `status: approved` before this session — leave the status alone.
- Phase 6 step 2 is a no-op if the feature ID is already in BACKLOG.md (REFINE edits an existing backlog entry, it does not append a duplicate).
- Phase 6 step 3 (idea archival) only applies if this REFINE run just graduated an idea; otherwise skip.
- Phase 6 steps 4 and 5 (Next Up + `.active-session.json` delete) always run, in that order. The guard cleanup is still the very last action so any accidental source-code Edit during the wrap-up is still blocked.

If the REFINE run was interrupted by the "cancel" branch of the Sprint Impact Check (Step 0), the active-skill mutex still needs to be cleaned up — delete `.active-session.json` as the last action before returning control to the user.

## Idea graduation target

The graduation target for IDEA-mode features is:
```
<SHIPYARD_DATA>/spec/ideas/IDEA-NNN-[slug].md
```

When Phase 6 runs for an idea-sourced feature, after appending to BACKLOG.md, use the Edit tool to set the idea file's frontmatter to `status: graduated` and add `graduated_to: FNNN`. Confirm: "IDEA-NNN has been graduated to [FNNN: title]." Doing the Edit inside Phase 6 keeps it inside the mutex window. Listings filter `status: graduated` ideas out by default; physical removal is manual for now.
