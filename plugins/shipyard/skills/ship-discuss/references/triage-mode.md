# TRIAGE Mode: Surface what needs discussion

When the user asks "anything requires discussion" or similar:

1. Use Grep with `pattern: ^status: proposed`, `path: <SHIPYARD_DATA>/spec`, `glob: {stories,features}/[SF]*.md`, `output_mode: files_with_matches` to find features still at `status: proposed`. For each match, Read the file and extract `id`, `title`, `story_points`, and acceptance criteria count.
2. Use Glob `<SHIPYARD_DATA>/spec/ideas/IDEA-*.md` to enumerate idea files. For each, Read the file, parse frontmatter, and skip any with `status: promoted` (legacy `graduated`), `status: rejected` or `status: parked`.
3. Present the result as a compact triage list:
   ```
   Items needing discussion:

   PROPOSED FEATURES (refine acceptance criteria, estimate, decide):
     [1] S012 — Payment Analytics (proposed, 0 pts, 0 scenarios)
     [2] S015 — Split Payments (proposed, 8 pts, 2 scenarios)

   IDEAS (capture-only — flesh out into features):
     [3] IDEA-007 — Magic-link auth (captured YYYY-MM-DD)
     [4] IDEA-009 — Bulk export to CSV (captured YYYY-MM-DD)
   ```
4. AskUserQuestion: "Pick a number to discuss, several numbers or 'all' to walk through them in a row, or 'done' to exit triage."
5. One pick → jump into its mode (REFINE for a story, IDEA for an idea). Several picks or 'all' → CHAINED mode: run `shipyard-data discuss-queue start --items <id,id,...>` (proposed stories first, then ideas, in list order) and follow `references/chained-mode.md`. The list above came from native Read/Grep/Glob calls; the queue is the only CLI write here.

If both lists are empty: "Nothing currently needs discussion. The proposed-feature queue is empty and there are no captured ideas. Run /ship-discuss with a topic to start something new."
