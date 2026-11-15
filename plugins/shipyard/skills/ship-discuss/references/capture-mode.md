# CAPTURE Mode: Quick Idea (zero ceremony)

When the input is a short one-liner — capture it instantly and offer to go deeper.

## Step C1: Create Idea File

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

## Step C2: Offer Depth

```
Captured: IDEA-NNN — [title]

Want to flesh this out into a full feature now, or save it for later?
```

- **"now" / "yes" / user engages** → switch to IDEA mode (Read `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/idea-mode.md`, Step I1) with the just-created IDEA-NNN
- **"later" / "no" / silence** → done. Clean up active-skill mutex and exit.

**Rules for CAPTURE mode:**
- Be fast. Don't ask clarifying questions upfront.
- Don't estimate. No RICE, no story points.
- Slug from title — lowercase, hyphens, max 40 chars.
- If called mid-conversation or mid-sprint, capture and return immediately.
