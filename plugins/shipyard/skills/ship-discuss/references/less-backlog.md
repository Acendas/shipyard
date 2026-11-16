# One backlog, releases as fix versions (Large-Scale Scrum)

Shipyard follows Large-Scale Scrum (LeSS) for the backlog: **one product, one backlog, one definition of done**. LeSS has no epic-versus-story vocabulary: an item is an item, fine-grained near the top of the backlog and coarse below. Read this when the input is a release, a batch of tickets, or anything too big for one story.

## The words

| Word | What it is | What it is not |
|---|---|---|
| **Fix version** | The release an item is expected to ship in. A forecast. `shipyard-data version …` | Not an epic. Not a sprint: the sprint is where work happens, the version is where it ships |
| **Idea** | Something someone asked for, not yet sized or broken down (some teams say *intent*: the same thing). Keeps the link to its ticket. Refined, it becomes an epic | Not a commitment |
| **Epic** | One capability a user would name ("pay by card"). A coarse item | Never a release, a client, a team or a phase |
| **Story** | One slice a user, operator or technician can observe, small enough for a sprint | Not a layer ("build the API"), not "part 1 of 3" |
| **Task** | Enabling work. A **spike** answers written questions inside a timebox; its output is a decision or a split | Not a way to hide a story's work |

Every epic, story, task and idea has `fix_version`. A story or task with none takes its epic's.

## A release or a batch of tickets arrives

```
tickets / CSV / a list          ideas (link kept)            epics                 spikes + stories
────────────────────── pull ──► IDEA-001 ← KEY-12 ─ promote ► E001 ─ /ship-discuss ► T001 spike
"the v4.2.0 release"            IDEA-002 ← KEY-31             (coarse, sized S-XL)   S001, S002 …
        │                                                                                │
        └── shipyard-data version add v4.2.0 ──── every item above: fix_version v4.2.0 ──┘
```

1. **Name the release as a version, not as an epic:** `shipyard-data version add <name> [--date YYYY-MM-DD] [--title "..."] [--check "<work a finished item does not cover>"]…`.
2. **Take the tickets in, with their links:** `shipyard-data tracker pull --csv <export.csv>` (or `--input <normalized.json>`). A ticket typed epic, initiative or theme becomes an idea; a story or a bug becomes an unrefined story; a task becomes a task. Each keeps `external_refs`, its tracker fix version and a sync block, and a ticket whose parent is already an epic here lands under it. When the person calls the tickets ideas, intents or epics, or the export has no type column, say so: `--as ideas`. Loose thoughts with no ticket: `shipyard-data idea capture …`, then `version set`.
   **Look at every source the person named before intake ends.** A linked page, a drive, a folder, a file: open it now, even though nothing is broken down yet. At the least list what it holds and capture what no ticket covers as ideas (with the offer to create their tickets, `references/tracker-sync.md`). A named source is never put off to "when an idea is refined"; one that cannot be reached is named in one line.
3. **Do not break everything down at intake.** Order the ideas coarsely. Refine the ones near the top into epics: `shipyard-data idea promote <IDEA-NNN> [--size S|M|L|XL]`. The links, the sync block and the version go with it. An idea becomes an epic, never a story or a spike directly; a small idea gives a small epic.
4. **Break down only what is next:** `/ship-discuss <E###>` splits an epic into spikes (for what is unknown) and stories. Refine about one or two sprints ahead; the rest stays coarse on purpose. Several epics in a row: `/ship-discuss --chain E001,E002`.
   Write each one with the CLI, never by hand: `shipyard-data task add --title "..." --kind spike --parent <E###> --question "..." --timebox "..."` and `shipyard-data story add --title "..." --epic <E###> [--ui] [--as "..." --want "..." --so "..."] [--after <id,id>]`. A story made this way is coarse (`refined: false`, no points, no criteria) until its own `/ship-discuss <S###>`.
   **A child never carries its epic's ticket.** `epic:` (or `parent:`) is the tie. A record's own ticket is its `ticket:` field, written only by `tracker link` and `tracker pull`; `external_refs` are tickets it mentions, and nothing is ever sent to those.
5. **Keep the tracker in step:** new work found here gets a ticket (offered, never silent), and the discussion ends by asking to sync (`references/tracker-sync.md` is read from SKILL.md's rule).
6. **See the release:** `shipyard-data version show <name>` (what is in it, what is done, what was never broken down, the release checks).

## Fix version rules

- Set it when an item is ordered into a release, not by reflex at creation.
- **Move it openly.** Changing an item's version needs `--reason`; the move is logged. A date that slips is a forecast that changed, not a failure to hide.
- A version is released with `shipyard-data version release <name>`: refused while an item in it is unfinished, was never broken down, or a release check is open. Unfinished work moves to the next version first.
- **Release checks are the work "done" does not cover** (a look on the real device, a configuration push, sign-off, release notes). They live on the version, in sight, and are ticked only with the person's words: `shipyard-data version check <name> <n> --answer "..."`. LeSS calls this undone work: keep the list short and make it shorter.

## Splitting (in this order; stop at the first that gives valuable, roughly equal slices)

workflow steps → operations (create, read, change, remove) → business-rule variants → data variations → ways of entering data → the one hard part first → simple then rich → defer "make it fast" → a spike (last resort).

- Find the core difficulty and cut one complete thin slice through it first. Cover every must-have case thinly before enriching any one slice.
- Prefer the split that exposes low-value work that can be dropped.
- New hardware or an outside system: spike on the protocol → the happy path on one model → faults one by one → the maintenance screen. Keep "works against a fake" and "seen on the real device" as a visible pair.

Send these back: a layer or component as an item; "part 1 of 3"; a spike with no questions or no timebox; all the risk in the last slice; one copy of a capability per client; a story that needs every other story first; "make it fast" alone; a gold-plated first slice.

## Ordering

- One list, in the owner's order, by what a delay costs: who is hurt by a week's wait, how much, how soon. Contracted dates, money and safety risk, outages in the field, and risky unknowns (learn early) go up. Place an item with `shipyard-data backlog move <id> --top | --above <id> | --below <id> | --to <n> --why "<what a delay costs>"`; the reason is kept and shown on the board as "why here". From the first placement on, the list is the owner's: a new story waits at the bottom until it is placed, and nothing re-sorts it by score. The score (RICE) only gives the first sort of a list nobody has ordered yet.
- A sprint takes stories from the top, in order. Skipping one says why.
- Say "not now", with the reason, rather than "no".
- Remove a dependency before managing it (a fake, a default, a narrower slice). What cannot be removed gets pulled earlier as a spike or a question to whoever knows.

## Size

Points are relative and proposed until the people building confirm them. Never derive points from days, never compare people by them. 13 or more, or "no idea": split it or spike it first. Pace is measured (`shipyard-data capacity`), never assumed.
