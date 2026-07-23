# Phase 6 Finalize — Detail

This is the full protocol for Phase 6 (Finalize) in `/ship-discuss`. The SKILL body summarizes; this file holds the how.

## Ordering invariant

Run these steps in order. The active-skill mutex stays active until the **very last** step so that any accidental Edit to a source file during Finalize still gets blocked — that's the whole point of the ordering. Do not reorder to "optimize" the cleanup.

1. **Update feature statuses.** For each approved feature, run `shipyard-data feature set-status FNNN approved`.
2. **Append to BACKLOG.md.** Run `shipyard-data backlog add <IDs>` (one call, all approved IDs together — the CLI inserts each in RICE-sorted position).
3. **Mark graduated ideas.** If any features were sourced from an IDEA file (IDEA mode), run `shipyard-data idea set-status IDEA-NNN graduated --to FNNN` (writes `status: graduated` + `graduated_to: FNNN` atomically) now. These `shipyard-data` Bash calls run fine inside the guarded window — the active-skill mutex only blocks accidental Edits to source files, not CLI state mutations. Doing this here — inside the guarded window — keeps the lifecycle change inside the mutex window.
4. **Constitution amendment prompt.** If `.research-draft.md` has a `## Constitution Gaps` section with unresolved-or-resolved entries, surface them now. For each gap, the Phase 1.5b discussion produced an explicit decision (the user picked an approach for the gray area) — those decisions are candidate constitution rules. Render the gap list as chat text first — one line per gap: "how to handle X — decision: Y — would land in project-<area>.md" — then a single AskUserQuestion carrying only "Add these decisions to the project rules? (yes/pick/no)". The gaps live in `.research-draft.md` (a Read result); a bullet list packed into the question string renders as a compact card and does not count as shown. On `yes`/`pick`, append to the most relevant existing `project-*.md` (or create `project-<area>.md` if none fits) with the decision, the *why*, and the feature ID that prompted it as the rationale anchor. Do this BEFORE step 5 so the rules land inside the mutex window.
5. **Use the Edit tool to also mark `.research-draft.md` obsolete** if it still exists with the current topic — sets `obsolete: true` in its frontmatter.
6. **Print the Next Up block** (see SKILL.md "Next Up" section). The user sees it and the conversation is effectively over.
7. **Last action — after everything above has flushed:** run `shipyard-data lock release planning --skill ship-discuss` (soft-delete sentinel — CLI-owned, never a hand Write). Until this step, the active-skill mutex still claims this session for `/ship-discuss` and other skills entering will refuse. After this step, do **not** continue with any tool calls — the discussion is done. If the user wants to build the feature, they will run `/ship-sprint` in a new session.

## REFINE-mode differences

REFINE-specific differences from the NEW-mode finalize:

- Phase 6 step 1 is a no-op for features that were already `status: approved` before this session — leave the status alone.
- Phase 6 step 2 is a no-op if the feature ID is already in BACKLOG.md (REFINE edits an existing backlog entry, it does not append a duplicate).
- Phase 6 step 3 (idea graduation via `shipyard-data idea set-status ... graduated --to ...`) only applies if this REFINE run just graduated an idea; otherwise skip.
- Phase 6 steps 4 and 5 (Next Up + `lock release planning`) always run, in that order. The guard cleanup is still the very last action so any accidental source-code Edit during the wrap-up is still blocked.

If the REFINE run was interrupted by the "cancel" branch of the Sprint Impact Check (Step 0), the active-skill mutex still needs to be cleaned up — run `shipyard-data lock release planning --skill ship-discuss` as the last action before returning control to the user.

## Idea graduation target

The graduation target for IDEA-mode features is:
```
<SHIPYARD_DATA>/spec/ideas/IDEA-NNN-[slug].md
```

When Phase 6 runs for an idea-sourced feature, after appending to BACKLOG.md, run `shipyard-data idea set-status IDEA-NNN graduated --to FNNN`. Confirm: "IDEA-NNN has been graduated to [FNNN: title]." Doing this inside Phase 6 keeps it inside the mutex window. Listings filter `status: graduated` ideas out by default; physical removal is manual for now.
