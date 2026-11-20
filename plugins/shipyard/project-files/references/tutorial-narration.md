# Tutorial narration

The text the CLI prints during a guided run, `/ship-quick --tutorial`. One entry per key. A `## key` heading starts an entry; the lines below it, up to the next heading, are the entry's text. The first line is the headline; the rest is indented under it when printed.

Keys: `intro`; `quick:<stage>` for the quick run's stages, printed by `shipyard-data quick next`; `cursor:<stage id>` for a build or review stage, printed by `shipyard-data cursor advance`, with a wave number written as `N`; `refusal:<gate>` for a gate that refused, printed by the gate after its refusal.

Skills echo these blocks as they are. No skill adds narration of its own.

## intro
A guided run of one small change, on the branch you are on.
Shipyard will discuss, plan, build and review the change with every check it has, and explain each stage as it comes.
Time: about 20 to 30 minutes.
Models: this run uses the models your project uses, routed the same way, so it costs what real work costs. The figures are shown at the end.
Your repository: commits land on this branch only. Nothing is pushed or merged.

## quick:pick
First, something small to build.
A story is one thing the product should do, with the checks that prove it. The tutorial builds one small story so you can watch every stage once.
Three safe candidates from this repository follow. Pick one, or name something else.

## quick:discuss
Stage 1 of 4: the discussion.
Shipyard first proposes a lane: how much process the item needs. For the tutorial the lane is a story. You confirm with one key.
The discussion then writes the story with its acceptance scenarios. Every scenario gets an id, `@AC-1`, `@AC-2` and so on. A test will carry that id, and a check will look for both the scenario and the test.
Questions come one card at a time, each under a short explanation. The approval card is always the last one. Nothing is built in this stage.

## quick:plan
Stage 2 of 4: the plan.
A step is one small piece of the story that one builder finishes. A wave is the set of steps that can be built at the same time.
`shipyard-data sprint plan-score` scores the plan: how many steps, how many waves, the widest wave and the longest chain. A story cannot enter the sprint while the score reports a problem.
`shipyard-data sprint probes-at-base` runs every step's check on today's code. Each check must fail now. A check that already passes would prove nothing when it passes later.
You approve the plan once. After that, nobody is asked until the review.

## quick:build
Stage 3 of 4: the build.
Each step goes to a builder agent in its own copy of the code, a git worktree. The builder writes a failing test, then the code, then runs the step's check.
No question reaches you during the build. A hook refuses one. Where the build would have asked, it works down a written ladder and records the decision for the review.
When a story's last step is merged, the story is reviewed against its scenarios, for what is missing, and for code problems. Findings are fixed in the same run.

## quick:review
Stage 4 of 4: the review.
The review is one document in twelve sections, shown whole: goal and outcome, what you can do now, evidence before and after, quality work, decisions made without asking, numbers, not done, found but not done, not verified, what went well and badly, what to improve, next.
Read "not done" and "decisions made for you" first. Those two sections are where a run tells you what it did not do and what it decided on your behalf.
One acceptance card follows the whole document.

## quick:finish
The run is over. What follows is what you saw, what it cost, and where to go next.

## cursor:wave_N_dispatch
A wave starts. One builder per step, each in its own worktree, each on the model the step's size routes to: small steps on the light model, steps that need reasoning on the build model, hard steps on the think model.
From here to the review, nothing will ask you anything.

## cursor:wave_N_gate
The wave gate. Six checks, all of them on record: every builder returned a structured result, every claimed commit is merged and none is orphaned, the wave's tests passed on the merged code, every step's completion was recorded by the gate and not only claimed by the builder, no silent-failure marker appeared in the log, and no builder worktree holds uncommitted work.
A wave that fails a check does not pass. The gate is code, not a reminder.

## cursor:sprint_complete_gate
The sprint gate. Nine checks before the run can call itself complete: integration evidence for every step, a passing sprint-level probe, every story marked done, no scenario without a test marker, no silent-failure marker, no uncommitted worktree, no must-fix code-review finding, every shipped story's user-flow probe proven in this sprint, and a settled per-story review.
Anything missing stops here, and the reason is printed.

## refusal:probes-at-base
This is a gate firing, on purpose.
The planner wrote a check that already passes on today's code. Passing it later would prove nothing, so the planner is sent back to write a check that fails now. You will see the corrected check in the next plan.

## refusal:plan-score
This is a gate firing, on purpose.
The plan has a step placed later than it needs to be, or two steps in one wave that change the same file. Either makes the sprint slower than it has to be, so the planner is sent back to fix the plan before any story enters it.

## refusal:task-return
This is a gate firing, on purpose.
A builder claimed a step was complete while the step's check did not pass. The CLI refuses to record the claim. The builder fixes the work and runs the check again; only a passing check can be recorded.

## refusal:story-approve
This is a gate firing, on purpose.
A story cannot be approved while something it needs is missing: refinement, a design decision for a screen, or scenarios that break the rules. The discussion supplies what is missing and asks again.

## refusal:unattended-ask
This is a hook firing, on purpose.
The build tried to ask you a question. During a build nobody is asked: the build decides by a written ladder and records the decision, and you read the decisions at the review.
