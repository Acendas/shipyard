/**
 * A sprint drafted ahead (v4.17): plan the next sprint while the current one
 * runs.
 *
 * `sprints/current/` belongs to the sprint that is running (or waiting for its
 * review). A planner that starts while it exists writes to `sprints/next/`
 * instead and touches nothing in `current/`: no story changes status, nothing
 * leaves the backlog. When the owner approves that plan it is QUEUED
 * (`sprint queue-next`: draft status `ready`). When `current/` is free again
 * it is PROMOTED (`sprint promote-next`: the files move into `current/`), and
 * the planner's normal finishing steps run from there.
 *
 *   sprint plan-dir [--json]   where this planner writes, and why
 *   sprint queue-next          the drafted sprint is approved and waiting
 *   sprint promote-next        move the waiting sprint into current/
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { parseFrontmatter, parseWaves, sprintStoryIds } from "./terminal-gate.mjs";
import { planGateProblems } from "./plan-score.mjs";
import "./probes-at-base.mjs"; // registers the probe check with the plan gate

const SPRINT_ID_RE = /^sprint-(\d{3,})$/;
const readIf = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const clean = (v) => String(v ?? "").replace(/^["']|["']$/g, "").trim();

function highestSprintNumber(dataDir, extra = []) {
  let n = 0;
  let names = [];
  try { names = readdirSync(join(dataDir, "sprints")); } catch { /* none yet */ }
  for (const id of [...names, ...extra]) { const m = SPRINT_ID_RE.exec(clean(id)); if (m) n = Math.max(n, Number(m[1])); }
  return n;
}

/** Where a planner writes right now. Pure read. */
export function planInfo(dataDir) {
  const currentDir = join(dataDir, "sprints", "current");
  const nextDir = join(dataDir, "sprints", "next");
  const sprintText = readIf(join(currentDir, "SPRINT.md"));
  const fm = sprintText ? parseFrontmatter(sprintText) : null;
  const activeStatus = fm ? clean(fm.status) : "";
  // a sprint that still owns current/: running, paused, or finished and waiting for its review
  const active = fm && activeStatus !== "cancelled" ? { id: clean(fm.id), status: activeStatus || "unknown" } : null;
  const nextText = readIf(join(nextDir, "SPRINT-DRAFT.md"));
  const nfm = nextText ? parseFrontmatter(nextText) : null;
  const nextStatus = nfm ? clean(nfm.status) : "";
  const next = nfm && !["superseded", "cancelled"].includes(nextStatus)
    ? { id: clean(nfm.id), status: nextStatus || "draft", stories: sprintStoryIds(nextText) }
    : null;
  const ahead = !!active;
  const id = ahead
    ? (next?.id && SPRINT_ID_RE.test(next.id) ? next.id : `sprint-${String(highestSprintNumber(dataDir, [active.id]) + 1).padStart(3, "0")}`)
    : (next?.id && SPRINT_ID_RE.test(next.id) ? next.id : `sprint-${String(highestSprintNumber(dataDir) + 1).padStart(3, "0")}`);
  return { mode: ahead ? "draft-ahead" : "now", dir: ahead ? nextDir : currentDir, id, active, next, promotable: !ahead && !!next && next.status === "ready" };
}

/** Stories other commands must not edit: the running sprint's and the queued next sprint's. */
export function readonlyStories(dataDir) {
  const out = new Set();
  const cur = readIf(join(dataDir, "sprints", "current", "SPRINT.md"));
  if (cur && clean(parseFrontmatter(cur).status) !== "cancelled") for (const id of sprintStoryIds(cur)) out.add(id);
  const info = planInfo(dataDir);
  if (info.next) for (const id of info.next.stories) out.add(id);
  return [...out];
}

function storyStatus(dataDir, id) {
  for (const sub of ["stories", "features", "bugs"]) {
    let names = [];
    try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
    const n = names.find((x) => x === `${id}.md` || x.startsWith(`${id}-`));
    if (n) return clean(parseFrontmatter(readIf(join(dataDir, "spec", sub, n)) ?? "").status);
  }
  return null;
}

function setDraftStatus(path, status) {
  const text = readFileSync(path, "utf8");
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(text);
  if (!m) throw new Error("SPRINT-DRAFT.md has no frontmatter block");
  const block = /^status:.*$/m.test(m[2]) ? m[2].replace(/^status:.*$/m, `status: ${status}`) : `${m[2].replace(/\s*$/, "")}\nstatus: ${status}`;
  atomicWrite(path, m[1] + block + m[3] + text.slice(m[0].length));
}

/** Problems that stop a drafted sprint from being queued, or []. */
export function nextDraftProblems(dataDir) {
  const p = join(dataDir, "sprints", "next", "SPRINT-DRAFT.md");
  const text = readIf(p);
  if (!text) return [`no drafted sprint: ${p} does not exist`];
  const fm = parseFrontmatter(text);
  const out = [];
  if (!SPRINT_ID_RE.test(clean(fm.id))) out.push(`its id is "${clean(fm.id)}", expected sprint-NNN`);
  const stories = sprintStoryIds(text);
  if (!stories.length) out.push("it lists no stories (stories: [S001, S002])");
  for (const id of stories) {
    const st = storyStatus(dataDir, id);
    if (st === null) out.push(`${id}: no story file`);
    else if (st !== "approved") out.push(`${id} is "${st}", expected approved (a story in the running sprint cannot also be in the next one)`);
  }
  const waves = parseWaves(text);
  if (!waves.length) out.push("no `### Wave N` headings parse");
  for (const w of waves) if (!w.tasks.length) out.push(`Wave ${w.wave} lists no step ids`);
  return out;
}

export function main(dataDir, args = []) {
  const sub = args[0];
  const json = args.includes("--json");
  if (sub === "plan-dir") {
    const i = planInfo(dataDir);
    if (json) { process.stdout.write(JSON.stringify(i) + "\n"); return; }
    process.stdout.write(`SHIPYARD_SPRINT_PLAN_MODE=${i.mode}\nSHIPYARD_SPRINT_PLAN_DIR=${i.dir}\nSHIPYARD_SPRINT_PLAN_ID=${i.id}\n`);
    if (i.active) process.stdout.write(`SHIPYARD_ACTIVE_SPRINT=${i.active.id} (${i.active.status})\n`);
    if (i.next) process.stdout.write(`SHIPYARD_NEXT_SPRINT_DRAFT=${i.next.id} (${i.next.status}; stories ${i.next.stories.join(", ") || "none"})\n`);
    if (i.promotable) process.stdout.write(`SHIPYARD_NEXT_SPRINT_READY=${i.next.id}\n`);
    return;
  }
  if (sub === "queue-next") {
    const problems = nextDraftProblems(dataDir);
    if (!problems.length) problems.push(...planGateProblems(dataDir, { next: true })); // 4.19: the plan gate, for a sprint drafted ahead
    if (problems.length) { process.stderr.write(`shipyard-data sprint queue-next: the drafted sprint is not ready to wait:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`); process.exit(3); }
    const p = join(dataDir, "sprints", "next", "SPRINT-DRAFT.md");
    setDraftStatus(p, "ready");
    const i = planInfo(dataDir);
    try { logEvent(dataDir, "next_sprint_queued", { sprint: i.next.id, stories: i.next.stories.join(","), behind: i.active?.id ?? "" }); } catch { /* best-effort */ }
    process.stdout.write(`${i.next.id} is approved and waiting${i.active ? ` behind ${i.active.id}` : ""}: ${i.next.stories.length} stor${i.next.stories.length === 1 ? "y" : "ies"} (${i.next.stories.join(", ")}). Nothing changed status and nothing left the backlog.\n  ${i.active ? `It starts with /ship-sprint once ${i.active.id} is reviewed and archived.` : "sprints/current/ is free already (the sprint that was running has been archived): promote it now with shipyard-data sprint promote-next and finish the plan."}\n`);
    return;
  }
  if (sub === "promote-next") {
    const i = planInfo(dataDir);
    if (i.active) { process.stderr.write(`shipyard-data sprint promote-next: ${i.active.id} (${i.active.status}) still owns sprints/current/ — finish, review and archive it first\n`); process.exit(3); }
    if (!i.next) { process.stderr.write("shipyard-data sprint promote-next: no drafted sprint is waiting in sprints/next/\n"); process.exit(3); }
    if (i.next.status !== "ready" && !args.includes("--force")) { process.stderr.write(`shipyard-data sprint promote-next: ${i.next.id} is "${i.next.status}", not approved yet (ready). Finish planning it, or pass --force to bring the draft over as it is.\n`); process.exit(3); }
    const nextDir = join(dataDir, "sprints", "next"), currentDir = join(dataDir, "sprints", "current");
    mkdirSync(currentDir, { recursive: true });
    const names = readdirSync(nextDir);
    const clash = names.filter((n) => existsSync(join(currentDir, n)) && n !== "SPRINT-DRAFT.md");
    if (clash.length) { process.stderr.write(`shipyard-data sprint promote-next: sprints/current/ already has ${clash.join(", ")} — nothing was moved\n`); process.exit(3); }
    for (const n of names) renameSync(join(nextDir, n), join(currentDir, n));
    try { logEvent(dataDir, "next_sprint_promoted", { sprint: i.next.id, files: names.length }); } catch { /* best-effort */ }
    process.stdout.write(`${i.next.id} moved into sprints/current/ (${names.length} file(s)). Check it still fits (stories still approved, steps still apply to the code as it is now), then finish it as a normal plan.\n`);
    return;
  }
  process.stderr.write(`shipyard-data sprint: unknown subcommand "${sub ?? ""}". Expected: set <key> <value> | check [--next] | plan-dir [--json] | queue-next | promote-next [--force]\n`);
  process.exit(2);
}
