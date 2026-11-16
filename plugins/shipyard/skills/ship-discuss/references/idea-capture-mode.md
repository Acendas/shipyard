# IDEA-CAPTURE Mode: Instant Idea Stash (`--idea`)

When the input starts with `--idea`, this is the fastest possible capture path. No conversation, no depth offer, no questions. Stash and exit.

1. Strip the `--idea` prefix from the input. The remaining text is the idea description.
2. Capture it in one call (the CLI allocates the id, names the file and writes it; never `next-id` plus a hand-written file, and never a shell redirect into the data folder):

```
shipyard-data idea capture --title "<cleaned-up title>" --idea "<the description, lightly cleaned up>" --why "<one sentence: best guess at value>" --source "inline capture (--idea)"
```

3. Output exactly:
```
Captured: IDEA-NNN — [title]
Flesh out later with: /ship-discuss IDEA-NNN
```

4. Release the lock if this session took one: `shipyard-data lock release discuss --skill ship-discuss`. Done. No follow-up question, no Phase 1, no depth offer.

**Rules for IDEA-CAPTURE mode:**
- Be instant. The user typed `--idea` because they want zero friction.
- No `AskUserQuestion`. No clarifying questions. No RICE. No estimates.
- No `--why` if nothing is obvious: the section is then a single dash.
- No `--thoughts` (unlike CAPTURE mode, which may pass it). Keep it minimal.
