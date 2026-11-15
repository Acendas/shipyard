# IDEA-CAPTURE Mode: Instant Idea Stash (`--idea`)

When the input starts with `--idea`, this is the fastest possible capture path. No conversation, no depth offer, no questions. Stash and exit.

1. Strip the `--idea` prefix from the input. The remaining text is the idea description.
2. Generate the next available IDEA-NNN ID (the next available number, same as CAPTURE mode).
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
