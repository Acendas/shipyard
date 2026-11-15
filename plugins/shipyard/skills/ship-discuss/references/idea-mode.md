# IDEA Mode: Convert Idea to Feature

When the input is an idea ID (IDEA-NNN), the goal is to graduate it into a proper feature. This is NEW mode with the idea pre-loaded as seed context — not REFINE mode.

## Step I1: Load Idea

Read `<SHIPYARD_DATA>/spec/ideas/IDEA-NNN-[slug].md`. Extract:
- Title and description
- "Why It Might Matter" section
- Any initial thoughts

Present it briefly to the user as plain text (title, description, why it might matter).

## Step I2: Seed NEW Mode

Pass the idea content as context into the full NEW mode flow (Phases 1 → 6), starting at Phase 1. The idea's description pre-answers some of Phase 1's questions — skip what's already clear, focus AskUserQuestion on genuine unknowns.

Run every NEW mode phase in order (see `new-mode.md`), Phase 1 through Phase 6, including Impact Analysis (Phase 3.5).

## Step I3: Mark the Idea as Graduated

Idea archival happens inside Phase 6 (Finalize), between the BACKLOG.md append and the mutex release — not here and not as a standalone step. See `references/phase-finalize.md` for the graduation target path and exact ordering.
