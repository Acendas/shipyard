---
name: ship-quick
description: "Take one item from words to reviewed code."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, Agent, AskUserQuestion, Monitor, TaskCreate, TaskUpdate, TaskList, TaskStop, SendMessage, Skill, Workflow, WebSearch, WebFetch]
model: opus
effort: low
argument-hint: "[what to build, in words | S### | E### | IDEA-### | ticket key] [--tutorial [--sandbox]]"
---

# Shipyard: Quick Run

One item, all the way: discussed, planned, built and reviewed in one go, on the branch the person is on. An intent, a ticket or a bug goes in; reviewed code on that branch comes out. Then the person decides what happens to the branch.

## Input

$ARGUMENTS

## What a quick run is

It is the four regular commands in a row, each one whole: `/ship-discuss`, `/ship-sprint`, `/ship-execute`, `/ship-review`. Nothing in them is lighter here. What differs is where the records live: the run has its own (its own stories, plan, locks and numbers), so the regular sprint and backlog of this project are not touched and do not appear.

```
/ship-quick <item>
  discuss  →  plan  →  build  →  review  →  finish
  the person answers here ─┘        │          └─ and is asked once here
                    nobody is asked during the build
```

## The tutorial

`/ship-quick --tutorial [item]` is the guided run: the same quick run, with narration. The item may be left out; the run then opens at a `pick` stage that finds something small in the repository. `/ship-quick --tutorial --sandbox` makes a throwaway project to take the tutorial in instead; nothing starts on this branch.

- **The CLI narrates; you echo.** In a tutorial run the CLI prints a `TUTORIAL:` block as a stage is entered, from `shipyard-data quick next`; as a build or review stage advances, from `shipyard-data cursor advance`; and under a gate's refusal. Show every such block to the person as it is, before the stage's work. Add no narration of your own: the text is in `${CLAUDE_PLUGIN_ROOT}/project-files/references/tutorial-narration.md` and is tested there.
- **The first card.** `quick start --tutorial` prints the `intro` block. Show it, then ask one card: **Start** · **Use a sandbox project instead** · **Not now**. "Use a sandbox project instead" → run `shipyard-data quick start --tutorial --sandbox`, show its two lines in a code block, then `shipyard-data quick drop <run> --reason "sandbox instead"`, and stop. "Not now" → `shipyard-data quick drop <run> --reason "not now"`, one line, and stop.
- **The `pick` stage.** The NEXT line asks for three small, safe improvements from this repository: each under fifty changed lines, in one or two files, with an observable behaviour a test can check, touching no external service. Read the code to find them. Show the three as a short table with three columns, what, where and why it is safe, then one card with the three and "something else". Then `shipyard-data quick pick "<the item, in words>"` and carry on with `quick next`.
- **Nothing else changes.** Every stage runs whole, with every check and every question card it has. The run uses the project's own models and settings, as the intro block says.

## Rules

- **The CLI says where the run stands.** `shipyard-data quick next` reads the stage from what is on record and prints the one thing to do. Never decide the stage yourself, and never say a stage is done: run the command again and read it.
- **Run each stage through the `Skill` tool, by the name the NEXT line gives.** Never do a stage's work from memory of how that command goes, and never shorten it. Follow the loaded command to its end, with every check and every question it has.
- **Each stage starts from the records.** What was said in an earlier stage is in the story files, the plan and the event log. Read those; do not rely on what you remember of the conversation.
- **Do not stop between stages** and do not ask whether to continue. When a command ends by naming the next command to run, that is your cue to run `shipyard-data quick next`, not to tell the person.
- **The branch is the person's.** Never create, switch, merge, rebase, push or delete it. Builders work in their own temporary working copies, merge back into this branch, and are removed when merged; that is the build's own job and `quick finish` checks it.
- **Talk as every Shipyard command does** (SHIPYARD_STARTUP_RULES of the stage's command): quiet while working, one short line with a small visual when a stage ends.

## Steps

1. Run `shipyard-data quick next`.
   - It prints a `NEXT:` line → a run is open on this branch. Go to step 3. Arguments given now are ignored: say so in one line.
   - It exits 3 (no run on this branch) and the arguments are empty → run `shipyard-data quick list`, show its output in a code block, say `Start one with /ship-quick <the item>` and stop.
   - It exits 3 and there are arguments → step 2.
2. Run `shipyard-data quick start <the arguments, as one quoted string, as they were typed>`. The flags `--tutorial` and `--sandbox` pass through as they are.
   - It refuses (exit 3) → show its message as it is and stop. On the repository's main line it asks for a branch: the person makes it. Do not make one.
   - It starts → one line for the person, for example `Quick run quick-001 on branch feat/export: discuss → plan → build → review.` In a tutorial run, first show the `TUTORIAL:` block it printed and ask the first card of § The tutorial.
3. Do what the `NEXT:` line says. For a stage that is a command, call the `Skill` tool with exactly the skill and arguments it names, then follow that command to its end.
4. When the command has ended, write one progress line (`[██░░] discussed → planning`), run `shipyard-data quick next` again, and go to step 3. A run with more stories than one plan held comes back to `plan` by itself; carry on.
5. When the NEXT line says to close the run, run `shipyard-data quick finish`. Show its output in a code block as it is. That is the last message: the branch is the person's now.

## When something stops the run

- A stage's command refuses to start (another session holds its lock, setup is needed) or pauses to ask the person something: show what it said. The run stays open; `/ship-quick` on this branch carries on from the same stage.
- `quick finish` refuses: it names what is left (a builder's working copy with uncommitted changes, a stage not done). Fix that through the stage's own command, never by hand, then run it again.
- Never run `shipyard-data quick drop` or `shipyard-data quick land` unless the person asks. Dropping gives the item back to the project untouched; landing brings the run's records into the project after the branch was merged.
