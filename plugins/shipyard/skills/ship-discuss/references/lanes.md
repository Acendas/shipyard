# Intake lanes — the single front door (F023)

Every piece of new work enters through `/ship-discuss`. Free-text input is routed to one of four lanes by a deterministic ceremony ladder; the router (you) only classifies the input and proposes, the CLI decides, the user confirms in one keypress, and every decision is logged.

| Lane | What it is for | Ceremony | Writes | Hands off to |
|---|---|---|---|---|
| **capture** | a thought worth keeping, not yet worth questions | zero questions | `spec/ideas/IDEA-###.md` (`status: captured`) | later: `/ship-discuss IDEA-###` |
| **refine** | a story worth building (feature or bug) | a question budget scaled by size (`question_budget`) | `spec/stories/S###.md` with ACs, points, probe | `/ship-sprint` |
| **land-now** | tiny, clear, low-risk change | one confirmation | `spec/tasks/T###.md` (`kind: chore`) | `/ship-execute --task T###` (land-now guarantees) |
| **hotfix** | a production incident | minimal story, no planning lock | `spec/stories/S###.md` (`type: bug`, `lane: hotfix`) + `debug/S###.md` | `/ship-execute --hotfix S###` and `/ship-debug` |

## Step L1: Classify (one line, no questions)

From the input alone, assess the five ladder inputs. Do not ask the user for them — classify, propose, let the confirmation catch a miss:

| Input | Values | How to read it |
|---|---|---|
| `size` | xs / s / m / l / xl | xs: one line or one value; s: one function or file; m: one component; l: several components; xl: a product area |
| `ambiguity` | low / medium / high | low: you could write the acceptance test now; high: you do not know what "done" means |
| `repro` | known / unknown / na | bugs only; `na` for anything that is not a bug |
| `risk` | none / low / medium / high | auth, payments, data migration, destructive or irreversible = high; config/copy/docs = none |
| `urgency` | normal / high / production | "prod is down", "customers blocked", "outage", "--hotfix" = production |

Run `shipyard-data route-intake --size <v> --ambiguity <v> --repro <v> --risk <v> --urgency <v> [--kind feature|bug|unknown]`. It prints `lane=<lane>`, `question_budget=<n>` for refine (at most that many questions, asked one at a time; never tell the person about "rounds"), and the reasons; it logs `intake_routed` with every input (AC-3, AC-4). Never derive the lane in prose and never skip the call — the ladder thresholds live in `bin/route-intake.mjs`, not here. **Haiku escalator (E004, opt-in):** when config.md has `routing.haiku_router: true` and your `ambiguity` is `medium`, add `--haiku "<the user's input verbatim>"`: a Haiku `claude -p` run re-reads the text and may RAISE ambiguity, risk or urgency (or flip repro to unknown) — never lower anything, never change size. The CLI prints a `haiku:` line and logs `intake_haiku_consulted` (latency, cost, what it raised). Say once per session that it spends the user's own quota (~$0.01, ~5 s). Never pass `--haiku` when the key is off; the CLI refuses.

## Step L2: Confirm in one keypress (AC-4)

Render one line as chat text — the input summary, the proposed lane and the CLI's first reason — then ONE `AskUserQuestion` whose first option is the proposed lane marked `(Recommended)` and whose other options are the three remaining lanes with one-phrase descriptions. Record the answer: `shipyard-data route-intake --confirm <chosen> --proposed <proposed>` (logs `intake_lane_confirmed`, with `overridden: true` when they differ). Then route:

- **capture** → `references/capture-mode.md` (CAPTURE).
- **refine** → NEW mode (`references/new-mode.md`); the printed `question_budget` is the question list's budget (`discuss-questions start --budget`); a bug (`--kind bug`, or the input describes broken behavior) first follows `references/bug-lane.md` § Refining a bug.
- **land-now** → Step L3.
- **hotfix** → `references/bug-lane.md` § Hotfix lane.

Unambiguous inputs skip the ladder entirely: ids (`S###`, `E###`, `IDEA-###`, external keys), `--idea`, `--hotfix`, `--chain`, `--pull` and the TRIAGE phrases route as SKILL.md's Detect Mode says.

## Step L3: Land-now lane

1. Allocate the id: `shipyard-data next-id tasks` → `T<id>`.
2. Write `<SHIPYARD_DATA>/spec/tasks/T<id>-<slug>.md` from `templates/task.md` with `kind: chore` (or `spike` when the change is an experiment), `status: open`, `parent: ""` (or the story id the user named), `## What` = the request in one paragraph, `## Done When` = the observable result in one or two lines (a failing-then-passing test when the change is testable).
3. Say exactly:
   ```
   Filed T<id> — [title] (land-now)
   Build it with: /ship-execute --task T<id>
   ```
   and stop. `/ship-execute --task` owns the guarantees (baseline green, test first, green after refactor with no test-file edits, one focused commit, escalation back here when the task outgrows the lane — `references/mode-task.md` in ship-execute). Do not start building inside `/ship-discuss`.
4. Release the discuss lock if this session holds it (`shipyard-data lock release discuss --skill ship-discuss`).

## Locks (AC-5)

`shipyard-context discuss-context` acquires the **planning** lock on entry. Capture (`--idea`, CAPTURE lane) and hotfix write only NEW records and must never wait on it: when the context block says `SHIPYARD_LOCK_ACQUIRED=false` and the input is `--idea ...`, `--hotfix ...`, or a confirmed CAPTURE/HOTFIX lane, continue **lock-free** (write the new file, run the CLI calls, hand off) and do not release a lock you do not hold. Every other lane stops on a blocked lock, as before.

## Logging (AC-4)

Two events per routed input, both CLI-emitted: `intake_routed` (the five inputs, the proposed lane, `refine_rounds`) and `intake_lane_confirmed` (the chosen lane, `proposed`, `overridden`). They are how the ladder thresholds get tuned later — never tune by editing prose.
