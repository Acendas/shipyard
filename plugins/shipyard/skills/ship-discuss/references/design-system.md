# The design system: the project's own, signed by its owner

A screen belongs to a design system. The project says which one, once: a system defined here, the project's own, or none in the owner's words. `shipyard-data design-system` is the only writer of that decision; `story set-status approved` refuses any story that changes what a person sees (`ui: true`) until it is on record, with or without a mock-up: a waived mock-up is about the picture, not the system.

`SHIPYARD_DESIGN_SYSTEM` in the startup context says where the project stands. Run `shipyard-data design-system show` before designing any screen.

## What the deliverable is

The record lives in `<SHIPYARD_DATA>/spec/design-system/`.

| File | Holds |
|---|---|
| `tokens.json` | The values, in the platform's own unit: colours per theme, type roles, spacing scale, radii, depth, motion, fixed sizes, touch target |
| `rules.json` | Every rule, with how it is checked (on the values, on a rendered screen, in the code, by the project's own check, by eye) and where its number comes from |
| `DESIGN-SYSTEM.md` | Twelve sections in words: principles, voice and wording, colour, typography, space and layout, shape and depth, motion, icons and imagery, components, patterns, rules and constraints, handoff and change |
| `components/<name>.md` | One page per component, the same eight parts: purpose, anatomy, variants, sizes, states, behaviour, tokens, do and don't |
| `prototype.json` | This project's screens as blocks, linked the way a person moves through them |
| `design-system.json` | CLI-owned: the decision, version, hash, the owner's words. Never write it |

The platform is one of `web`, `android`, `ios`, `desktop`, `game`, `terminal`, `other`. Nothing assumes a browser: the values are checked by the CLI with no renderer.

## Step 1: what is there already

Run `shipyard-data design-system detect`, and read what it lists. Then one of four starts:

| The project has | Do |
|---|---|
| A whole system of its own (it names its source of truth, it has its own checks) | Ask the owner, then `design-system adopt --path <each> --answer "<their words>"`. Design within it; change it only through the project's own files |
| Part of one (a theme file, some components) | `design-system init --platform <p> --basis <each file>`: their values become the tokens, the gaps are filled |
| Screens but no system: values typed in the code | `design-system extract`, then `init --basis extracted.json`. The most used values become the tokens; show the owner what is merged into what |
| Nothing | `design-system init --platform <p> --name "<the project's name>"`, with `--inspiration "<link, file or name>"` for each inspiration the owner gave |

When the owner wants none: `design-system none --answer "<their words>"`. Never choose that for them.

**An inspiration is for look and feel.** Name the qualities taken from it (calm, dense, high contrast) in "Where it comes from". Copy no component and no asset from it.

**Extraction counts; it does not decide.** Replacing the typed values in the code with tokens is a story of its own. Do not do it inside this one.

## Step 2: fill it

- Choose the values in `tokens.json`. Carry existing values over before choosing a new one. A colour role named `on-X` is the text colour on `X` and is checked for contrast against it; list other pairs under `color.pairs` (`kind: "ui"` for a border or an icon).
- Write each section of `DESIGN-SYSTEM.md` in place of its `<!-- FILL -->` marker. A `###` heading inside a section becomes a frame of its own in the book.
- `design-system component add <name>` for each component the first screens need. Add the ones this work needs, not a catalogue.
- Write `prototype.json`: this project's real screens and the ways between them, then remove `draft`. Shape: `{ "start": "<screen>", "screens": { "<id>": { "title": "…", "blocks": [ … ] } } }`. Anything with `to: "<screen>"` is clickable; `to: "back"` goes back; `toast: "…"` beside a `to` shows a message on arrival. The blocks and their fields:

| Block `type` | Fields |
|---|---|
| `bar` | `title`, `back: true`, `action: {label, to}` |
| `heading`, `text` | `text`; `text` also takes `muted: true` |
| `total` | `label`, `value` |
| `list` | `rows: [{title, sub, value, badge, switch: true, to}]` |
| `field` | `label`, `value`, `placeholder`, `help`, `error` |
| `buttons` | `items: [{label, variant: "secondary" or "danger", disabled: true, to, toast}]` |
| `tabs`, `nav` | `items: [{label, on: true, to}]` |
| `card` | `blocks: [ … ]`, `to` |
| `meter` | `label`, `value` (0 to 100) |
| `toast` | `text`, `action: {label, to}` |
| `empty` | `title`, `text`, `button: {label, to}` |
| `dialog` | `title`, `text`, `buttons: [{label, variant: "primary" or "danger", to, toast}]` |
| `title` (game) | `text`, `sub`, `to` |
| `menu` (game) | `title`, `center: true`, `rows: [{label, value, to}]` |
| `hud` (game) | `clock`, `gold`, `score`, `pause: {label, to}`, `orbs: [{label, to}]` |
- A project's own check goes into `rules.json` as `check: "project"` with `command:`. A rule the project relaxes is changed there, with the reason in section 11.
- `shipyard-data design-system check` until it says `READY`. A rule judged by eye is a checklist for the review; never report it as passed.

## Step 3: the owner reviews on the Claude Design artifact, then signs

The owner's feedback is given in one place: the Claude Design artifact. Build a Design System artifact from the record (the DESIGN stage's rules for artifacts apply: private, never published without the owner's go) and give them the link. Their comments go into the record first, then the artifact is updated from it. The record is what is signed; the artifact is a view of it.

Only when the `Artifact` tool is not available (say so in one line): `shipyard-data design-system render` and give them the path of the book to look at, and take their feedback in the chat.

Explain in the chat what they are about to sign (the values in a table, the components, the rules that can fail a screen), then one card. On yes:

`shipyard-data design-system approve --answer "<their words>" [--artifact <link>] [--story <S###>]`

The sign-off writes the book: one HTML file, a page per section, each an open canvas, and a page where the project's screens are clicked through. **The book is a reference.** It takes no feedback and changes no value; a later change is a new review on the artifact and a new version.

## Step 4: into the project

`shipyard-data design-system export --to <folder in the project>` writes the document, the component pages, the book and the token file in the code's format (`css`, `android`, `c`, `json`). A discussion never edits the project, so the export is the **first step of the first UI story**: say so in the story's spec, and the builder runs it and commits the files with that step. The same step makes the code read its values from the exported token file (a stylesheet imports it, a build includes it). A screen that types the same values again under names of its own has not used the system.

## A system that is behind the work

Before designing a screen against an existing system:

1. `shipyard-data design-system covers <each component and value the screen needs> --story <S###>`.
2. Something is missing, or a value no longer matches what the owner decided: bring the system up to date **for this piece of work only**. Add the component page, the value, the rule.
3. `design-system check`, then `design-system changes`: show the owner that list with the reason for each line, and record the sign-off as a new version.
4. Anything else that looks out of date and is not needed by this work: `shipyard-data idea capture`, and leave it.

`design-system extract` on a project with a system also says which colours the code uses that the system lacks, and which the system has that the code never uses.

An adopted system is the project's own: update it through the project's own files, as steps of the story.
