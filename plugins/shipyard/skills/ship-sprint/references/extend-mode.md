### Step E1: Show Current Sprint + Available Features

Show current progress (wave, tasks done, used/remaining capacity, current features) beside the RICE-sorted backlog features available to add, each with points and whether it fits remaining capacity.

AskUserQuestion: "Which features to add? (list IDs)"

### Step E2: Capacity Check

Sum new points + existing used points. If over capacity by >10%:
AskUserQuestion: "Adding [features] puts sprint at [N]/[M] pts ([X]% over capacity). Proceed anyway, or drop something? (proceed / drop [ID] from sprint / cancel)"

### Step E3: Decompose New Features

Follow the shared steps (Steps 3-4 only, loaded above; Step 5+ mentions are PLAN-only, capacity is E2's remaining capacity): research each new feature, create step files, update feature `tasks:` arrays. At the end of Step 4, take the shared steps' **Exit** line: go to Step E4.

### Step E4: Slot Into Waves

New tasks go into the wave structure:
1. Read current wave from PROGRESS.md (`current_wave`)
2. Tasks with no dependencies on existing work → add to the current wave (if it hasn't started) or the next wave
3. Tasks that depend on in-progress work → add to the wave after their dependency completes
4. Tasks that depend on each other → chain into sequential waves as normal

Never reorder or modify already-completed waves. Only add to the current wave (if unstarted tasks exist) or append new waves.

### Step E5: Update Sprint Files

1. Add new task IDs to SPRINT.md wave structure (body Edit), then run `shipyard-data sprint check`: it confirms the `### Wave N` structure still parses AND that the changed plan still passes the plan gate (4.0). Exit 3 names what the change broke (a step later than it has to be, two steps of one wave on one file, a step that needs the person at the start pushed out of wave 1): fix the waves or the new dependencies and run it again. A step with `needs_person: before` stays in wave 1 whatever else moves. To change what a step waits for: `shipyard-data step set-deps <PID> <PID,PID|none>` (the field is CLI-owned; never edit it by hand). Then `shipyard-data sprint probes-at-base` for the new steps
2. Update SPRINT.md frontmatter via `shipyard-data sprint set features "<full updated list>"` (not a hand Edit of frontmatter). If the total capacity budget changes, also `shipyard-data sprint set capacity <N>`; used-capacity is derived and not a stored frontmatter field.
3. Update feature statuses to `in-progress` in story frontmatter
4. Remove new feature IDs from BACKLOG.md
5. Log in SPRINT.md swap log: `| [date] | [added IDs] | — | Mid-sprint extension |`
6. After extending scope, regenerate QUALITY-GATE.md to reflect updated features (see `references/quality-manifest.md` § EXTEND Mode).

Then show:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPRINT UPDATED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Added: [feature list]
 New tasks: [N] across [M] waves
 Capacity: [used]/[total] pts

 Updated wave structure:
   Wave 1: ✅ done
   Wave 2: [existing + new task IDs] (current)
   Wave 3: [new task IDs] (added)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▶ NEXT UP: Continue building
  /ship-execute
  (tip: /clear first for a fresh context window)
```

**Then release the planning lock**, the same as PLAN mode: stop every named helper this run started (`TaskStop`), commit by path any project file this run changed, and run `shipyard-data lock release planning --skill ship-sprint`. A live extension ended without it and the lock stayed held by an idle session.
