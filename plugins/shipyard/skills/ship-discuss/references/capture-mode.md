# CAPTURE Mode: Quick Idea (zero ceremony)

When the input is a short one-liner — capture it instantly and offer to go deeper.

## Step C1: Create Idea File

One call captures it: the CLI allocates the id, names the file and writes it. Never `next-id` plus a hand-written file, and never a shell redirect into the data folder. Several ideas at once (coarse slices kept for later) are one call each.

```
shipyard-data idea capture --title "<title from the user's description>" \
  --idea "<their description, cleaned up slightly but preserving intent>" \
  --why "<one sentence: your best guess at the value>" \
  --thoughts "<one or two immediate technical considerations; leave the flag out if nothing is obvious>" \
  --source "inline capture"
```

It prints `IDEA-NNN captured: <path>`. To add more to the body afterwards, Edit that file.

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
