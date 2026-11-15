/**
 * `shipyard-data patch-budget [--json]` (v4.14.1) — how many fix steps this
 * sprint may still add.
 *
 * The cap was a flat `execution.max_patch_tasks` (5) that the orchestrator
 * counted by hand. Story reviews create fix steps by design, so a
 * seven-story sprint spent the budget on healthy work, and the next real
 * defects (a dead pointer that passed its check) could only be parked. The
 * cap now grows with the sprint: the larger of `max_patch_tasks` and
 * `patch_steps_per_story` (default 2) × the sprint's stories. The count comes
 * from the event log, never from memory.
 *   exit 0  budget left        exit 3  budget spent (decide with the ladder)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, sprintStoryIds } from "./terminal-gate.mjs";
import { readEvents as readEventsWithArchive } from "./event-report.mjs";
import { eventMatches, inSprintWindow } from "./vocab.mjs";
import { readMaxPatchTasks, readPatchStepsPerStory } from "./config-read.mjs";

export function patchBudget(dataDir, { events = null } = {}) {
  let sprintText = "";
  try { sprintText = readFileSync(join(dataDir, "sprints", "current", "SPRINT.md"), "utf8"); } catch { return null; }
  const sprintId = String(parseFrontmatter(sprintText).id ?? "").trim();
  const stories = sprintStoryIds(sprintText).length;
  const flat = readMaxPatchTasks(dataDir), perStory = readPatchStepsPerStory(dataDir);
  const cap = flat === Infinity ? Infinity : Math.max(flat, perStory * stories);
  const all = events ?? readEventsWithArchive(dataDir).events;
  const first = all.findIndex((e) => inSprintWindow(e, sprintId));
  const win = first === -1 ? [] : all.slice(first);
  const ids = new Set();
  for (const e of win) if (eventMatches(e, "patch_step_created")) ids.add(String(e.step ?? e.task_id ?? e.task ?? `#${ids.size}`));
  const used = ids.size;
  return { sprint: sprintId, stories, cap, used, left: cap === Infinity ? Infinity : Math.max(0, cap - used), max_patch_tasks: flat, patch_steps_per_story: perStory };
}

export function main(dataDir, args = []) {
  const b = patchBudget(dataDir);
  if (!b) { process.stderr.write("shipyard-data patch-budget: no current sprint\n"); process.exit(3); }
  const show = (n) => (n === Infinity ? "unlimited" : String(n));
  if (args.includes("--json")) process.stdout.write(JSON.stringify({ ...b, cap: b.cap === Infinity ? null : b.cap, left: b.left === Infinity ? null : b.left, max_patch_tasks: b.max_patch_tasks === Infinity ? null : b.max_patch_tasks }) + "\n");
  else process.stdout.write(`patch budget: ${show(b.left)} left (${b.used} used of ${show(b.cap)}; ${b.stories} stories × ${b.patch_steps_per_story}, floor ${show(b.max_patch_tasks)})\n`);
  if (b.left <= 0) process.exit(3);
}
