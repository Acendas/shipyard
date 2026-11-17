# The tracker: tickets for new work, and the sync at the end

A project is tracker-linked once any record carries a ticket in `external_refs` (the person gave ticket links, a key, an export). The link and the sync are for **every kind of record**: ideas, epics, stories (bugs included) and tasks. The tracker stays the owner of the ticket; Shipyard owns the refined spec. Shipyard never writes to the tracker without the person's answer, and they see what is sent first (§ What the person sees).

## 1. When research finds more than the tickets cover

The moment the discussion writes something no ticket covers (a new story, a spike, a bug, an epic), say so; do not wait for the end. After the specs are written (Phase 3), run:

```
shipyard-data tracker plan --since <the time this discussion started>
```

Write its "No ticket yet" list in the chat as a table (what, kind, under which ticket, fix version) with a 40-word summary above it, then one card:

| Choice | What happens |
|---|---|
| **Create them with my help (Recommended)** | For each one you draft the ticket (title, type, parent ticket, fix version, description from the spec) into the outbox, show the outbox table, and create it with the session's tracker tool on their go. Then `shipyard-data tracker link <id> <KEY>` |
| I will create them myself | Give them the list ready to paste. When they return the keys: `shipyard-data tracker link <id> <KEY>` |
| Leave them without a ticket for now | Nothing is created; the plan lists them again at the end. When they mean "not these, until I say" (stories under an epic that has its ticket, for example): `shipyard-data tracker hold <id>... \| --under <E###>`, and the plan only counts them from then on |

No tracker write tool in this session: say so in one line; only the second and third choices apply. Never invent a key.

## 2. When the discussion is done: ask to sync

Before the lock is released (Phase 6), run `shipyard-data tracker plan --since <start>` again and show it whole: what still has no ticket, and which linked tickets differ from what was decided here. One card:

| Choice | What happens |
|---|---|
| **Sync now (Recommended)** | Per numbered row, on their go: create or update the ticket (title, description and acceptance criteria from the spec, parent, fix version). Read it back to confirm (an empty tool reply is not proof). Then `tracker link <id> <KEY>` for a created one, `tracker synced <id>` for an updated one |
| Pick | They name the numbers; the rest stay on the plan |
| Not now | Nothing is written |

Record the answer, whatever it is: `shipyard-data tracker decided --sync applied|later|none [--note "..."]`. The lock release is refused until it is recorded: "later" is a fine answer, not asking is not.

## What the person sees before anything is sent

A write hook holds any ticket or page text the person has not seen. How they see it depends on its size:

| What is sent | How it is shown |
|---|---|
| A short text: one comment, a few lines | In the chat, word for word, inside a code block; then ask |
| A description, or more than one ticket | Never pasted. Write each text, exactly as it will be sent, to `<SHIPYARD_DATA>/tracker/outbox/<record id>.md` (a comment: `<record id>-comment.md`). Run `shipyard-data tracker outbox`, write its table in the chat under a summary of 40 words or fewer (every record id stays in it), end with `Question follows.`; one card: send all now / show me one in full first / not now |

Go straight to the outbox: do not first paste a draft and ask whether to create, then show the outbox and ask again. That is one decision, so it is one card. After their go, send each file's text word for word; `tracker link` or `tracker synced` then moves the file to `tracker/sent/`. A file edited after the table was shown is listed and shown again before it is sent. "Then update the tickets", said before the texts existed, is why you prepare them: it is not the go for texts nobody has seen. Never send in the same message that writes the spec.

## 3. Along the way to done (`/ship-sprint`, `/ship-execute`, `/ship-review`)

A linked ticket is kept in step from the discussion to the release, for every kind of record. `shipyard-data tracker plan --since <when this command began>` lists what its ticket does not know yet: where the item stands here against the ticket's status, the sprint it is in, its points, its fix version.

| Moment | What the ticket learns | Who starts it |
|---|---|---|
| A discussion ends | The refined title, description and acceptance criteria; new tickets for new work | § 1 and § 2 above |
| A sprint is planned (`/ship-sprint`, after the plan is approved) | It is in a sprint: the nearest "in progress" or "planned" transition the ticket offers, the sprint, the points, the fix version | the planner shows the plan and asks, before its lock is released |
| The sprint is built (`/ship-execute`) | Nothing: the build is unattended and a story is not done until the review closes the sprint | nobody |
| The sprint is reviewed and accepted (`/ship-review`) | Done: the nearest "done" transition, the fix version, one comment naming what was delivered and how it was proven | the review shows the plan and asks, before its lock is released |
| A version is released | The fix version is released in the tracker too | offered with `version release` |

`tracker_sync` in the project's config decides how: **ask** (default: show the plan, apply what the person picks), **auto** (send the updates without asking and report each in one line; creating a ticket still needs their go), **off** (never propose tracker changes). Set it: `shipyard-data config set tracker-sync <ask|auto|off>`. A status is changed only through a transition the ticket really offers (ask the tracker for them); when none fits, say so and leave the status alone. After each update: `shipyard-data tracker synced <id>` (add `--ticket-status "<its status now>"` when you moved the ticket, so Shipyard's mirror of it stays true); then `shipyard-data tracker decided --sync applied|later|none`. The lock of `/ship-sprint` and `/ship-review` is not released until that is recorded.

## Rules

- **A record's ticket is its `ticket:` field** (`tracker link`, `tracker pull`). Keys in `external_refs` are tickets it mentions: its epic's, a related one, one in another project. The plan never proposes writing to a mentioned ticket; a record that only mentions tickets is listed as having none, with what it mentions.

- The ticket's assignee and other people's comments are the tracker's. A status changes only as a row of the plan the person agreed to (or under `tracker_sync: auto`), never as a side effect.
- A ticket's fix version and Shipyard's `fix_version` can differ: the tracker's is mirrored under `upstream:`; Shipyard's is the forecast decided here. Sending it to the tracker is a row of the plan like any other.
- `shipyard-data tracker pull` (again, any time) refreshes what the tickets say; a record whose ticket changed is marked `upstream_changed` until `tracker ack <id>`.

## Two tickets, one story

When two tickets are one fix, one story keeps its own ticket and the other story is closed with `story set-status <S###> rejected --reason "merged into <S###>" --replaced-by <S###>`. The closed story keeps its ticket. From then on `tracker plan` lists that ticket whenever the story it was merged into changes ("merged into S002, which is done"), so it is closed with the other one and not left open.
