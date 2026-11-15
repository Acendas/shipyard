# Planning the next sprint while one is running (4.17)

A sprint that is running, or waiting for its review, owns `<SHIPYARD_DATA>/sprints/current/`. Planning does not wait for it: the next sprint is drafted in `<SHIPYARD_DATA>/sprints/next/`, approved there, and moved into `current/` when the running sprint is archived.

```
sprint-011 running ──────────────► reviewed ─► archived
        │                                          │
/ship-sprint (draft ahead)                  /ship-sprint
  writes sprints/next/                        promote-next
  owner approves ─► queue-next (ready)        finish as a normal plan ─► /ship-execute
```

The startup context says which case this is. Never work it out yourself.

| Context line | Meaning |
|---|---|
| `SHIPYARD_SPRINT_PLAN_MODE=now` | `current/` is free. Plan as usual |
| `SHIPYARD_SPRINT_PLAN_MODE=draft-ahead` | `SHIPYARD_ACTIVE_SPRINT` owns `current/`. Follow "Draft ahead" below |
| `SHIPYARD_SPRINT_PLAN_DIR=<path>` | Where every planning file of THIS plan goes |
| `SHIPYARD_SPRINT_PLAN_ID=sprint-NNN` | The id of the sprint being planned |
| `SHIPYARD_NEXT_SPRINT_DRAFT=<id> (<status>; …)` | A drafted sprint already exists in `next/` |
| `SHIPYARD_NEXT_SPRINT_READY=<id>` | An approved sprint is waiting and `current/` is free. Follow "Promote" below |
| `SHIPYARD_RUNNING_BESIDE=ship-execute,…` | Other commands working on this project right now |

## Draft ahead

Run PLAN mode exactly as written, with these differences:

1. **Files.** `SPRINT-DRAFT.md`, `QUALITY-GATE.md` and any other planning file go to `SHIPYARD_SPRINT_PLAN_DIR` (`sprints/next/`), never `sprints/current/`. Step files go to `spec/steps/` as usual. Pass `--next` where a command takes it: `shipyard-data sprint check --next`, `shipyard-data sprint plan-score --next`, `shipyard-data sprint probes-at-base --next`, `shipyard-data draft set-sprint-status <status> --next`.
2. **Read-only.** Everything the running sprint owns is read-only: `sprints/current/*`, its stories and its steps. `shipyard-data sprint set` refuses from this session while the sprint runs. Do not pick a story that is in the running sprint.
3. **The code is moving.** The running sprint is changing the code you are planning against. Plan against what is committed, and write each step so it names what it depends on; the promotion check below re-reads it.
4. **Capacity.** Use `shipyard-data capacity` as usual. Say in the plan that the running sprint's result is not in the numbers yet.
5. **Approval.** Show the plan and ask as usual. On approval, run only `shipyard-data sprint queue-next`. It checks the draft (id, stories all `approved`, waves parse, and the plan score has no problem) and marks it `ready`. **Do not** run `init-sprint`, do not change a story's status, do not touch the backlog: the sprint has not started. Tell the owner it starts with `/ship-sprint` once the running sprint is reviewed and archived. If the running sprint was archived while you were planning, `queue-next` says so: go straight on to "Promote" below, without asking for the plan's approval a second time.
6. **A draft already exists** (`SHIPYARD_NEXT_SPRINT_DRAFT`): show it and ask one question: keep refining it / replace it / leave it.

EXTEND and CANCEL act on the running sprint. Offer them only when `SHIPYARD_RUNNING_BESIDE` names neither `ship-execute` nor `ship-review`; while one of those runs, the choices are "draft the next sprint (Recommended)" and "wait".

## Promote

When the context has `SHIPYARD_NEXT_SPRINT_READY=<id>`:

1. `shipyard-data sprint promote-next` moves the files from `sprints/next/` into `sprints/current/`.
2. **Check it still fits**, quietly: every story is still `approved` (`shipyard-data story check-scenarios <ids>` passes); each step's files and dependencies still exist in the code as it is now; capacity still covers the points (`shipyard-data capacity`). Fix what is small (a renamed file, a step the last sprint already did) and say what you changed in one table.
3. Ask one question: start `<id>` as drafted (Recommended) / refine it first / drop it and plan fresh.
4. On "start": continue PLAN mode at its finishing steps (the ones after plan approval: `init-sprint`, story statuses, backlog). The plan was already approved; do not ask for approval of it again.
