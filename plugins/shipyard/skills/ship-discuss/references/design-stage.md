# DESIGN Stage: a signed-off design for UI stories (E005)

A story that changes what a user sees (`ui: true`) carries an approved design snapshot the way a feature step carries an `acceptance_probe`. The snapshot is the visual contract: builders render against it, the wave boundary and the review diff against it, and a change after sign-off is a new version. Design happens **here, in discuss, before the sprint** — `/ship-sprint` only checks the decision was made (Check 25) and never designs.

## The decision is recorded, never skipped

A `ui: true` story cannot be approved without a design decision on record: `shipyard-data story set-status approved` refuses it (exit 3) until one of

- `shipyard-data design approve <S###> --file <snapshot>` — a signed-off design, or
- `shipyard-data design waive <S###> --reason "<why this screen ships without one>"` — an explicit no (`design check` reports `WAIVED` and passes; look-and-feel stays a manual probe and `ui verify --level screen` has no baseline).

Offer the stage **once**, in NEW or REFINE mode right after the acceptance criteria are settled and before Phase 3 writes the spec: one `AskUserQuestion` — **Design it now (Recommended for new screens)** / Already have a design (point me at the file) / Waive — ship without a design (say why). Record the answer with the matching CLI verb. Silently listing "design skipped" among the assumptions is the failure this rule exists for.

## Step D0: Decide the pixel source once (recorded by CLI)

Run `shipyard-data ui doctor`. With `ui.adapter: none` and a UI story on the table, decide how this project's screens become pixels and record it — never leave it for the builder to discover:

| Project renders with | Set | Command |
|---|---|---|
| a browser (web app, Electron, Playwright present or installable by the project) | `web` | `shipyard-data config set ui-adapter web` (+ `ui-base-url`, `ui-playwright-root` if needed) |
| its own renderer (a game harness, a device screenshot tool, a terminal recorder, a native app) | `frames` | `shipyard-data config set ui-adapter frames` and `shipyard-data config set ui-frame-command "<cmd writing {out} for {scene}>"` |
| nothing scriptable yet | leave `none` | `design waive <S###> --reason` and a manual look-and-feel probe, said out loud |

`frames` is the answer for most non-web projects: a screenshot is "run the project's command for a scene"; `ui verify --level screen` then diffs that frame against the approved design with no browser, and component/flow levels stay the project's own checks. A new project should leave onboarding with this set when its stack is detectable; the DESIGN stage is the last place it may still be missing.

## Step D1: Prototype on the Claude Design artifact

- Find the repo's existing components and tokens first (component library, theme or token files, existing screens of the same kind) and design **within** them — a prototype that invents a second button style is a defect, not a design.
- **Prototype on a Claude Design artifact** (`Artifact` tool, `action: "quickstart"`, `intent: "design"`; a Design System artifact for the tokens when the repo has none, then a Design canvas for the screens — follow the `design-handbook` skill when it is listed). The artifact is where the user looks at and reacts to the design: give them the artifact link, iterate on the canvas from their comments, and keep the artifact private — **Never publish an artifact without the user's explicit confirmation**; do not use `DesignSync`.
- Only when the `Artifact` tool is not available in the session (say so in one line) fall back to an HTML mock-up written with the Write tool under `<SHIPYARD_DATA>/ui/<S###>/mock.html`, rendered to a PNG for the user to open. Serve nothing from the user's repo and leave no files in it (no `.playwright-mcp/`, no stray servers).
- Give every element the user will later verify a **stable id** (`data-testid` or an `id`), and write them into the story's Interface section: the component-level verification (`shipyard-data ui verify --level component`) addresses elements by these ids.

## Step D2: Export a snapshot into the data dir

Export the approved frame at the story's primary width (default 375 px) to a PNG under `<SHIPYARD_DATA>/ui/<S###>/` — from the Design artifact's export, or `shipyard-data ui screenshot --url <mock url> --widths 375 --story <S###> --label design` when the fallback mock is in play and `ui.adapter: web` resolves Playwright. The screen-level verification needs a PNG; other formats are accepted by `design approve` but only hash-checked.

## Step D3: Sign-off gate (CLI-owned)

State where the design lives (the artifact link, or the PNG path — a terminal cannot show "the image above"), list the element ids as chat text, then one `AskUserQuestion`: **Approve this design** / Change it / Waive instead. On approve run `shipyard-data design approve <S###> --file <snapshot> --note "<one line>"`. It copies the file to `spec/designs/<S###>-v<n>.<ext>`, writes the story's `design:` block (version, sha256, path) and logs `design_approved`; it also sets `ui: true`. Never write the `design:` block by hand.

- **Say what kind of picture it is.** A frame-accurate snapshot (a screenshot of the approved prototype at the real size) is the default and is compared pixel for pixel. A drawing — a proposal sketch, a page export with margins, a photo — is approved with `--fidelity mockup` (add `--crop x,y,w,h` to cut the screen out of a larger image) and is compared by eye from a side-by-side image the CLI writes. For a native renderer (`ui.adapter: frames`) add `--scene <name>`: the frame `ui verify` renders for this story.
- **One design for several stories:** approve it once, then `shipyard-data design approve <other story> --from <first story>` for the rest. The snapshot, fidelity, crop and scene come along; add `--scene <name>` when a story is better judged on a different frame.
- **Changes after sign-off need a new version.** Edit the prototype, export again, run `design approve` again (v2, v3 …). `shipyard-data design check` fails a UI story whose snapshot no longer hashes to the approved value (DRIFTED) or has no decision (MISSING) — `/ship-sprint` Check 25 and `/ship-execute` pre-flight run it, so a UI step cannot start against an unapproved screen.
- **Proof follows the adapter.** When `shipyard-data ui doctor` says `ui.adapter: web` resolves, the story's `user_flow_probe` is `kind: auto` running `shipyard-data ui verify --level flow --spec <SHIPYARD_DATA>/ui/<S###>/flow.json` (steps written from the acceptance scenarios, one per scenario); a hand-run browser checklist (`kind: assisted`) is the fallback only when no adapter resolves, and even then it is collected at `/ship-review` Stage 5, never mid-execute.

## What the design seeds downstream

| Consumer | Uses |
|---|---|
| Phase 3 spec | Interface section lists the stable ids; acceptance scenarios may reference the design version |
| `/ship-sprint` | Check 25: `shipyard-data design check <ids>` for every `ui: true` story (`WAIVED` passes) |
| Builder (render-and-look) | screenshots its screen after the probe and compares by eye to `spec/designs/<S###>-v<n>.png` |
| Wave boundary / `/ship-review` Stage 2 | `shipyard-data ui verify --level screen` diffs against the approved snapshot and runs the design lint (`frames`: the project's frame for the story's scene; a device screenshot works the same way through `--image`) |
