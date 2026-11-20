/**
 * `shipyard-data quick …` (after 4.0.6): one item, from words to reviewed
 * code, on a branch the person made.
 *
 * The owner's rules, in their words: "ship-quick to do discuss sprint execute
 * review all chained on a single item"; "ship-quick shouldnt mix with the
 * normal flow"; "as the user i will branch off and run ship-quick … builders
 * get their job done merge back into the branch and then i will decide what
 * happens next"; "using ship-quick shouldnt affect quality due to chaining".
 *
 * So a quick run is not a lighter pipeline. It is the same four commands with
 * every gate they have, run on records of their own:
 *
 *   - `quick start` binds the run to the current branch and gives it a data
 *     folder inside the project's (`<home>/quick/<run>/`). The resolver sends
 *     every command and hook there while the checkout is on that branch
 *     (`shipyard-resolver.mjs` § quick run). The regular sprint, its locks,
 *     its numbers and its backlog are never read or written.
 *   - A record the item already has in the project is TAKEN: copied into the
 *     run, marked `quick: <run>` at home and taken off the backlog, so the
 *     regular planner cannot pull it into a sprint meanwhile.
 *   - There is no stage counter to advance. `quick next` derives the stage
 *     from what is on record (stories, the sprint, the cursor, the archive),
 *     so a stage cannot be skipped by saying it was done.
 *   - `quick finish` closes the run when everything is built and reviewed and
 *     no builder worktree or branch of the run is left. The branch stays as
 *     it is: Shipyard never merges it.
 *   - The project's own records follow the code: `quick land` writes them
 *     back when the branch has been merged (or on the owner's word), `quick
 *     drop` gives taken records back untouched.
 *
 *   quick start [--tutorial] <the item, in words or as an id or ticket key>
 *   quick start --tutorial [--sandbox]   (a guided run: the item may be picked in the run; --sandbox makes a throwaway project instead)
 *   quick pick <the item, in words>    (a tutorial run that opened without an item)
 *   quick next [--json]
 *   quick finish
 *   quick list [--json]
 *   quick land <run> [--answer "<the owner's words>"]
 *   quick drop <run> --reason "<why>"
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { parseFrontmatter } from "./terminal-gate.mjs";
import { planInfo } from "./sprint-ahead.mjs";
import { listShipyardBranches, listShipyardWorktrees, repoFor, sprintInFlight, sweepBranches, sweepWorktrees } from "./branches.mjs";
import { QUICK_RUN_RE, getDataDir, getProjectRoot, homeOf, quickRunFor } from "./shipyard-resolver.mjs";
import { ensureInitializedDataDir } from "./init-data.mjs";
import { readEvents } from "./event-report.mjs";
import { createSandbox, isTutorial, markTutorialCompleted, tutorialBlock } from "./tutorial.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "shipyard-data.mjs");
const KINDS = ["stories", "features", "bugs", "epics", "tasks", "ideas"];
const STORY_KINDS = ["stories", "features", "bugs"];
const FINISHED = new Set(["done", "deployed", "released"]);
const CLOSED = new Set([...FINISHED, "rejected", "deferred", "cancelled"]);
const TICKET_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const RECORD_ID_RE = /^(?:[SFBETP]\d{3,}|IDEA-\d{3,})$/;
// Settings a run starts with. Numbers (metrics, proofs, the event log) are never copied: a run has its own.
const SEED_FILES = ["config.md", "risk-profile.json", "sources.json", ".shipyard-version"];
const SEED_DIRS = [["spec", "designs"], ["spec", "design-system"], ["spec", "references"], ["codebase"]];

const readIf = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const clean = (v) => String(v ?? "").replace(/^["']|["']$/g, "").trim();
const git = (args, cwd) => { try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).trim(); } catch { return null; } };
const cli = (dataDir, ...argv) => spawnSync("node", [CLI, ...argv, "--data-dir", dataDir], { encoding: "utf8" });
const fail = (msg, code = 3) => { process.stderr.write(`shipyard-data quick: ${msg}\n`); process.exit(code); };

export function quickInfo(dataDir) {
  try { const o = JSON.parse(readFileSync(join(dataDir, "quick.json"), "utf8")); return o && QUICK_RUN_RE.test(String(o.run ?? "")) ? o : null; } catch { return null; }
}
function writeInfo(dir, info) {
  atomicWrite(join(dir, "quick.json"), JSON.stringify(info, null, 1) + "\n");
  // `.open` tells the resolver whether any run is open, so a project with none never asks git on its hot path.
  const home = dirname(dirname(dir));
  const open = join(home, "quick", ".open");
  if (info.state === "active") writeFileSync(open, "");
  else if (!listRuns(home).some((r) => r.state === "active")) rmSync(open, { force: true });
}

/** Every quick run of this project: [{ run, dir, ...info }], oldest first. */
export function listRuns(home) {
  let names = [];
  try { names = readdirSync(join(home, "quick")); } catch { return []; }
  return names.filter((n) => QUICK_RUN_RE.test(n)).sort().map((n) => { const dir = join(home, "quick", n); const info = quickInfo(dir); return info ? { ...info, dir } : null; }).filter(Boolean);
}

function records(dataDir, kinds = KINDS) {
  const out = [];
  for (const sub of kinds) {
    const dir = join(dataDir, "spec", sub);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".md") || n.startsWith(".")) continue;
      const path = join(dir, n);
      const text = readIf(path);
      if (!text) continue;
      const fm = parseFrontmatter(text);
      const id = clean(fm.id);
      if (id) out.push({ id, fm, text, path, kind: sub, rel: join("spec", sub, n) });
    }
  }
  return out;
}

/** Set (or with `null` remove) one top-level frontmatter line. The record's other lines are not touched. */
export function setKey(path, key, value) {
  const text = readFileSync(path, "utf8");
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(text);
  if (!m) return false;
  const lines = m[2].split(/\r?\n/).filter((l) => !new RegExp(`^${key}:`).test(l));
  if (value !== null) lines.push(`${key}: ${value}`);
  atomicWrite(path, m[1] + lines.join("\n") + m[3] + text.slice(m[0].length));
  return true;
}

function lockFree(dataDir, name) {
  const text = readIf(join(dataDir, name));
  if (!text) return true;
  try { const o = JSON.parse(text); return !o || o.cleared || o.skill == null; } catch { return true; }
}
const LOCKS = [[".active-discuss.json", "a discussion"], [".active-session.json", "planning"], [".active-execution.json", "the build or the review"]];
const heldLocks = (dir) => LOCKS.filter(([f]) => !lockFree(dir, f)).map(([, what]) => what);

/** The branch a checkout must not be on for a quick run: the repository's main line, or the one a regular sprint builds on. */
function mainLine(root, home) {
  const names = new Set(["main", "master"]);
  const origin = git(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], root);
  if (origin) names.add(origin.replace(/^origin\//, ""));
  const cfg = git(["config", "--get", "init.defaultBranch"], root);
  if (cfg) names.add(cfg);
  const sprint = readIf(join(home, "sprints", "current", "SPRINT.md"));
  const b = sprint ? clean(parseFrontmatter(sprint).branch) : "";
  if (b) names.add(b);
  return names;
}

/** Records the item names that the project already has: by id, by epic, or by ticket key. */
export function recordsFor(home, item) {
  const all = records(home);
  const words = String(item ?? "").split(/[\s,]+/).filter(Boolean);
  const ids = words.filter((w) => RECORD_ID_RE.test(w));
  const tickets = words.filter((w) => TICKET_RE.test(w) && !RECORD_ID_RE.test(w));
  const take = new Map();
  for (const id of ids) for (const r of all) if (r.id === id) take.set(r.id, r);
  for (const key of tickets) {
    const re = new RegExp(`^\\s*(?:ticket|key):\\s*["']?${key}["']?\\s*$`, "m");
    for (const r of all) if (re.test(r.text.split(/\n---/)[0])) take.set(r.id, r);
  }
  // an epic brings its open stories; a story's epic comes along as context only
  for (const e of [...take.values()].filter((r) => r.kind === "epics")) {
    for (const r of all) if (STORY_KINDS.includes(r.kind) && clean(r.fm.epic) === e.id && !CLOSED.has(clean(r.fm.status))) take.set(r.id, r);
  }
  const context = new Map();
  for (const r of take.values()) {
    const epic = clean(r.fm.epic);
    if (epic && !take.has(epic)) { const e = all.find((x) => x.id === epic && x.kind === "epics"); if (e) context.set(e.id, e); }
  }
  return { take: [...take.values()], context: [...context.values()], missing: ids.filter((id) => !take.has(id)) };
}

/**
 * Where the run stands, read from what is on record. Never stored.
 *   discuss → plan → build → review → (plan again while stories remain) → finish
 *   task: a small item filed as a task builds with no sprint.
 */
export function stageOf(dir) {
  const info = quickInfo(dir);
  if (!info) return null;
  if (info.state !== "active") return { stage: info.state, info };
  // A tutorial may open without an item: the first stage is to pick one from the repository.
  if (info.tutorial === true && !String(info.item ?? "").trim()) return { stage: "pick", info };
  const stories = records(dir, STORY_KINDS);
  const tasks = records(dir, ["tasks"]);
  const st = (r) => clean(r.fm.status);
  const pi = planInfo(dir);
  if (pi.active) {
    const hasCursor = existsSync(join(dir, "sprints", "current", "EXECUTE-CURSOR.md"));
    const built = pi.active.status === "completed" || (hasCursor && !sprintInFlight(dir));
    return { stage: built ? "review" : "build", info, sprint: pi.active.id };
  }
  const open = stories.filter((s) => !CLOSED.has(st(s)));
  const ready = open.filter((s) => ["approved", "in-progress"].includes(st(s)));
  const openTasks = tasks.filter((t) => !CLOSED.has(st(t)));
  const done = stories.filter((s) => FINISHED.has(st(s))).length + tasks.filter((t) => FINISHED.has(st(t))).length;
  if (!lockFree(dir, ".active-discuss.json") || open.length > ready.length || (!open.length && !openTasks.length && !done)) return { stage: "discuss", info, waiting: open.filter((s) => !ready.includes(s)).map((s) => s.id) };
  if (ready.length) return { stage: "plan", info, stories: ready.map((s) => s.id) };
  if (openTasks.length) return { stage: "task", info, task: openTasks[0].id };
  return { stage: "finish", info, built: done };
}

const NEXT = Object.freeze({
  pick: () => 'Find three small, safe improvements in this repository and offer them: each under fifty changed lines, in one or two files, with an observable behaviour a test can check, and touching no external service. Show the three as a short table, then one card: the three, plus "something else". Then run `shipyard-data quick pick "<the item, in words>"`.',
  discuss: (s) => `Run the discussion for this item now: the Skill tool, skill "shipyard:ship-discuss", args: ${JSON.stringify(s.info.taken?.length ? s.info.taken.join(" ") : s.info.item)}.${s.waiting?.length ? ` Not approved yet: ${s.waiting.join(", ")}.` : ""} It ends when every story of the item is refined and approved.`,
  plan: (s) => `Plan the whole item now: the Skill tool, skill "shipyard:ship-sprint" (no arguments). Every approved story of this run goes into the plan (${s.stories.join(", ")}); there is no capacity limit to fit. The plan's approval card is the person's go-ahead for the build.`,
  build: (s) => `Build it now: the Skill tool, skill "shipyard:ship-execute" (no arguments). ${s.sprint} runs unattended to its end.`,
  task: (s) => `Build the task now: the Skill tool, skill "shipyard:ship-execute", args: "--task ${s.task}".`,
  review: (s) => `Show the review now: the Skill tool, skill "shipyard:ship-review" (no arguments). It reviews ${s.sprint} and asks the person once.`,
  finish: () => "Everything of this item is built and reviewed. Close the run: shipyard-data quick finish",
});
/** The stage names a quick run can be at, in the order `quick next` prints them. The narration file has one entry per name. */
export const QUICK_STAGES = Object.freeze(Object.keys(NEXT));

function printNext(dir, json) {
  const s = stageOf(dir);
  const line = NEXT[s.stage] ? NEXT[s.stage](s) : `This run is ${s.stage}.`;
  const tutorial = s.info.tutorial === true;
  const narration = tutorial ? tutorialBlock(dir, `quick:${s.stage === "task" ? "build" : s.stage}`) : "";
  if (json) { process.stdout.write(JSON.stringify({ run: s.info.run, branch: s.info.branch, stage: s.stage, next: line, item: s.info.item, ...(tutorial ? { tutorial: true, narration: narration.trim() } : {}) }) + "\n"); return; }
  const order = [...(tutorial ? ["pick"] : []), "discuss", "plan", "build", "review", "finish"];
  const at = s.stage === "task" ? "build" : s.stage;
  process.stdout.write(
    `QUICK RUN ${s.info.run} on branch ${s.info.branch}${tutorial ? " (tutorial)" : ""}\n` +
    `  item:  ${s.info.item || "(to be picked)"}\n` +
    `  stage: ${order.map((x) => (x === at ? `[${x}]` : x)).join(" → ")}\n` +
    narration +
    `NEXT: ${line}\n` +
    (NEXT[s.stage] && s.stage !== "finish" ? "When that command ends, run `shipyard-data quick next` again and do what it says. Do not stop between stages and do not ask whether to continue.\n" : ""),
  );
}

function start(home, args) {
  const tutorial = args.includes("--tutorial");
  const sandbox = args.includes("--sandbox");
  const item = args.filter((a) => a !== "--tutorial" && a !== "--sandbox").join(" ").trim();
  if (sandbox && !tutorial) fail("--sandbox goes with --tutorial: quick start --tutorial --sandbox", 2);
  if (sandbox) {
    // The sandbox is a repository of its own, with a data folder of its own. The run starts there, in a session opened there.
    const made = createSandbox();
    process.stdout.write(`Sandbox ready at ${made.path} on branch ${made.branch}.\n  Open a session there and run /ship-quick --tutorial:   cd ${made.path} && claude\n`);
    return;
  }
  if (!item && !tutorial) fail("say what to build: quick start <the item, in words, or an id, or a ticket key>", 2);
  let root = repoFor(home);
  if (!root || !existsSync(join(home, "config.md"))) {
    // A working copy made beside the project (`git worktree add`) is a project of its own to Shipyard and starts
    // empty. For a quick run it takes the settings of the project it was made from, so nothing has to be set up twice.
    const here = getProjectRoot();
    const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], here);
    const parentRoot = common ? dirname(common) : null;
    let parentHome = null;
    try { parentHome = parentRoot && parentRoot !== here ? getDataDir({ projectRoot: parentRoot, silent: true, home: true }) : null; } catch { parentHome = null; }
    if (!parentHome || !existsSync(join(parentHome, "config.md"))) fail("this project is not set up for Shipyard yet. Run /ship-status once, then start the quick run.");
    ensureInitializedDataDir({ projectRoot: here, dataDir: home });
    for (const f of SEED_FILES) { const t = readIf(join(parentHome, f)); if (t !== null && !existsSync(join(home, f))) writeFileSync(join(home, f), t); }
    root = here;
  }
  const branch = git(["symbolic-ref", "--short", "-q", "HEAD"], root);
  if (!branch) fail("the working copy is not on a branch. Make one for this item first: git switch -c <name>");
  if (mainLine(root, home).has(branch)) fail(`you are on ${branch}. A quick run builds on a branch of its own, and that branch stays yours to merge.\n  Make one first: git switch -c <name>\n  Then run /ship-quick again.`);
  const blocked = heldLocks(home).filter((w) => w !== "a discussion");
  if (blocked.length) fail(`${blocked.join(" and ")} is running in this working copy right now. A quick run needs a working copy of its own while that goes on (git worktree add ../<folder> -b <name>), or wait for it to end.`);
  const runs = listRuns(home);
  const run = `quick-${String(runs.reduce((n, r) => Math.max(n, Number(r.run.slice(6))), 0) + 1).padStart(3, "0")}`;
  const dir = join(home, "quick", run);
  const found = recordsFor(home, item);
  if (found.missing.length) fail(`no record ${found.missing.join(", ")} in this project. Check the id, or say the item in words.`);
  const elsewhere = found.take.filter((r) => clean(r.fm.quick));
  if (elsewhere.length) fail(`${elsewhere.map((r) => `${r.id} is already in ${clean(r.fm.quick)}`).join("; ")}. Finish or drop that run first (shipyard-data quick list).`);
  const building = found.take.filter((r) => clean(r.fm.status) === "in-progress");
  if (building.length) fail(`${building.map((r) => r.id).join(", ")} ${building.length === 1 ? "is" : "are"} being built in the regular sprint. A quick run takes only work that no sprint holds.`);

  mkdirSync(dir, { recursive: true });
  ensureInitializedDataDir({ projectRoot: root, dataDir: dir });
  for (const f of SEED_FILES) { const t = readIf(join(home, f)); if (t !== null) writeFileSync(join(dir, f), t); }
  for (const parts of SEED_DIRS) { const src = join(home, ...parts); if (existsSync(src)) cpSync(src, join(dir, ...parts), { recursive: true }); }
  for (const r of [...found.context, ...found.take]) { mkdirSync(dirname(join(dir, r.rel)), { recursive: true }); writeFileSync(join(dir, r.rel), r.text); }
  const session = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  const info = { v: 1, run, state: "active", branch, base: git(["rev-parse", "HEAD"], root), item, taken: found.take.map((r) => r.id), context: found.context.map((r) => r.id), started: new Date().toISOString(), session, ...(tutorial ? { tutorial: true } : {}) };
  writeInfo(dir, info);
  for (const r of found.take) {
    setKey(r.path, "quick", run);
    cli(home, "backlog", "remove", r.id); // off the regular backlog while the run has it; best-effort (it may not be listed)
    if (STORY_KINDS.includes(r.kind) && clean(r.fm.status) === "approved") cli(dir, "backlog", "add", r.id);
  }
  if (git(["config", `branch.${branch}.shipyard-quick`, run], root) === null) fail("could not record the run on the branch (git config refused). Nothing else was changed that matters: remove the folder " + dir, 1);
  for (const d of [home, dir]) { try { logEvent(d, "quick_started", { run, branch, taken: info.taken.join(","), item: item.slice(0, 200), ...(tutorial ? { tutorial: true } : {}) }); } catch { /* best-effort */ } }
  if (tutorial) process.stdout.write(tutorialBlock(dir, "intro"));
  process.stdout.write(`Started ${run}${tutorial ? " (tutorial)" : ""} on branch ${branch}.${info.taken.length ? ` Taken from the project: ${info.taken.join(", ")} (off the regular backlog until the run lands or is dropped).` : ""}\n`);
  printNext(dir, false);
}

/** A tutorial run that opened without an item gets one here: the words become the run's item. */
function pick(dir, args) {
  const info = quickInfo(dir);
  if (!info || info.state !== "active") fail("no quick run is open on this branch.");
  if (info.tutorial !== true) fail(`${info.run} is not a tutorial run; its item was given when it started.`);
  if (String(info.item ?? "").trim()) fail(`${info.run} already has its item: ${info.item}`);
  const item = args.join(" ").trim();
  if (!item) fail('say what to build: quick pick "<the item, in words>"', 2);
  writeInfo(dir, { ...info, item, picked: new Date().toISOString() });
  for (const d of [homeOf(dir), dir]) { try { logEvent(d, "quick_picked", { run: info.run, item: item.slice(0, 200) }); } catch { /* best-effort */ } }
  process.stdout.write(`Picked for ${info.run}: ${item}\n`);
  printNext(dir, false);
}

/** The gates that fired in this run, one line each, from the run's own event log. */
function gatesSeen(dir) {
  let events = [];
  try { events = readEvents(dir).events; } catch { events = []; }
  const count = (pred) => events.filter(pred).length;
  const rows = [
    ["probes-at-base", count((e) => e.type === "probes_at_base_checked"), (n) => `${n} run${n === 1 ? "" : "s"} of every step's check on today's code${events.some((e) => e.type === "probes_at_base_checked" && Number(e.unexplained) > 0) ? ", at least one check sent back for passing already" : ""}`],
    ["unattended-ask", count((e) => e.type === "unattended_ask_denied"), (n) => `${n} question${n === 1 ? "" : "s"} refused during the build`],
    ["task-return", count((e) => e.type === "task_dispatch_returned" && String(e.status) === "complete"), (n) => `${n} step${n === 1 ? "" : "s"} accepted with a passing check and a real commit`],
    ["wave gate", count((e) => e.type === "wave_integration_verified"), (n) => `${n} wave${n === 1 ? "" : "s"} verified merged`],
    ["sprint gate", count((e) => e.type === "sprint_complete_passed"), (n) => `passed ${n} time${n === 1 ? "" : "s"}`],
    ["story review", count((e) => e.type === "story_reviewed"), (n) => `${n} stor${n === 1 ? "y" : "ies"} reviewed against ${n === 1 ? "its" : "their"} scenarios`],
  ].filter(([, n]) => n > 0);
  return rows.length ? rows.map(([name, n, say]) => `    ${name}: ${say(n)}`).join("\n") : "    none recorded in this run's log";
}

function closeTutorial(dir, info) {
  const home = homeOf(dir);
  const report = (mode) => { const r = cli(dir, "report", mode); const text = String(r.stdout ?? "").trim(); return text || `  (no ${mode} report: the run recorded no events for it)`; };
  process.stdout.write(
    tutorialBlock(dir, "quick:finish") +
    "What you saw\n" +
    "  Gates that fired:\n" + gatesSeen(dir) + "\n" +
    `  Branch ${info.branch}: ${info.commits} commit${info.commits === 1 ? "" : "s"}, nothing pushed. Merge or delete it as you like: git log --oneline ${String(info.base).slice(0, 8)}..HEAD\n` +
    `  Records of this run: ${dir}\n  Your project's records: ${home}   (/ship-status diagnose prints the path)\n` +
    "What this tutorial cost\n" + report("time").replace(/^/gm, "  ") + "\n" + report("cost").replace(/^/gm, "  ") + "\n" +
    "Next\n" +
    "  /ship-discuss <what you want>   start real work\n" +
    "  /ship-help                      ask anything about what you saw\n",
  );
  try { markTutorialCompleted(dir, info.run); } catch { /* read-only data dir: the offer line is already gone */ }
}

function finish(dir) {
  const s = stageOf(dir);
  if (!s || s.info.state !== "active") fail("no quick run is open on this branch.");
  if (s.stage !== "finish") { process.stderr.write(`shipyard-data quick finish: ${s.info.run} is not finished, it is at "${s.stage}".\n`); printNext(dir, false); process.exit(3); }
  const held = heldLocks(dir);
  if (held.length) fail(`${held.join(" and ")} of this run is still open. Let that command end first.`);
  const root = repoFor(dir);
  const owner = s.info.run;
  // Builders are temporary (the owner's rule): a merged builder's worktree and branch go; unmerged work is kept under an archive ref.
  const wt = sweepWorktrees(root, { owner });
  if (wt.kept.length) fail(`${wt.kept.length} builder working cop${wt.kept.length === 1 ? "y" : "ies"} of this run still ${wt.kept.length === 1 ? "has" : "have"} uncommitted changes and ${wt.kept.length === 1 ? "was" : "were"} not removed:\n${wt.kept.map((k) => `  ${k.path} (${k.why})`).join("\n")}\n  Look at ${wt.kept.length === 1 ? "it" : "them"}: commit and merge what is wanted, or remove the folder, then run this again.`);
  const swept = sweepBranches(root, { label: owner, owner });
  if (swept.error) fail(swept.error, 1);
  const left = [...listShipyardWorktrees(root, owner).map((w) => w.path), ...listShipyardBranches(root, owner).map((b) => b.name)];
  if (left.length) fail(`builder leftovers of this run could not be removed: ${left.join(", ")}.`);
  const tip = git(["rev-parse", "HEAD"], root);
  const commits = Number(git(["rev-list", "--count", `${s.info.base}..HEAD`], root) ?? 0);
  const stories = records(dir, STORY_KINDS).filter((r) => FINISHED.has(clean(r.fm.status))).map((r) => r.id);
  const tasks = records(dir, ["tasks"]).filter((r) => FINISHED.has(clean(r.fm.status))).map((r) => r.id);
  const info = { ...s.info, state: "finished", tip, commits, built: [...stories, ...tasks], finished: new Date().toISOString(), archived_refs: swept.archived || 0 };
  writeInfo(dir, info);
  git(["config", "--unset", `branch.${info.branch}.shipyard-quick`], root);
  const home = homeOf(dir);
  for (const d of [home, dir]) { try { logEvent(d, "quick_finished", { run: info.run, branch: info.branch, commits, built: info.built.join(",") }); } catch { /* best-effort */ } }
  const dirty = (git(["status", "--porcelain", "--untracked-files=no"], root) ?? "").split("\n").filter(Boolean).length;
  process.stdout.write(
    `${info.run} is finished. It is all on branch ${info.branch}: ${commits} commit${commits === 1 ? "" : "s"}, ${info.built.length} item${info.built.length === 1 ? "" : "s"} built and reviewed (${info.built.join(", ") || "none"}).\n` +
    `  builders: ${wt.removed.length} working cop${wt.removed.length === 1 ? "y" : "ies"} removed, ${swept.deleted || 0} merged branch${(swept.deleted || 0) === 1 ? "" : "es"} deleted${swept.archived ? `, ${swept.archived} unmerged kept under ${swept.refs_prefix}` : ""}\n` +
    (dirty ? `  note: ${dirty} tracked file${dirty === 1 ? " has" : "s have"} uncommitted changes in the working copy\n` : "") +
    `  the run's records and its review: ${dir}\n` +
    "The branch is yours: Shipyard did not merge or push it. When it is merged, the project's records follow by themselves at the next planning or status run;\n" +
    `after a squash merge say so: shipyard-data quick land ${info.run} --answer "<your words>". To give the work up: shipyard-data quick drop ${info.run} --reason "<why>".\n`,
  );
  if (isTutorial(dir) || s.info.tutorial === true) closeTutorial(dir, info);
}

/** Is the run's work in the branch the project's checkout is on now? */
export function merged(root, info) {
  if (!info.tip) return false;
  try { execFileSync("git", ["merge-base", "--is-ancestor", info.tip, "HEAD"], { cwd: root, stdio: "ignore", timeout: 15000 }); return true; } catch { return false; }
}

/** Finished runs whose branch has been merged into where the checkout is now: ready to land. */
export function landable(home) {
  const root = repoFor(home);
  if (!root) return [];
  const here = quickRunFor(root)?.run ?? null;
  return listRuns(home).filter((r) => r.state === "finished" && r.run !== here && git(["symbolic-ref", "--short", "-q", "HEAD"], root) !== r.branch && merged(root, r));
}

function giveBack(home, info) {
  const all = records(home);
  for (const id of info.taken ?? []) {
    const r = all.find((x) => x.id === id);
    if (r && clean(r.fm.quick) === info.run) setKey(r.path, "quick", null);
  }
}

function land(home, args) {
  const run = args.find((a) => QUICK_RUN_RE.test(a));
  if (!run) fail("which run? quick land <run> (shipyard-data quick list shows them)", 2);
  const dir = join(home, "quick", run);
  const info = quickInfo(dir);
  if (!info) fail(`no run ${run} in this project.`);
  if (info.state === "landed") { process.stdout.write(`${run} has already landed.\n`); return; }
  if (info.state !== "finished") fail(`${run} is ${info.state}, not finished. Only a finished run lands.`);
  const root = repoFor(home);
  const ai = args.indexOf("--answer");
  const answer = ai !== -1 ? String(args[ai + 1] ?? "").trim() : "";
  if (!merged(root, info) && !answer) fail(`branch ${info.branch} (${String(info.tip).slice(0, 8)}) is not merged into the branch this working copy is on.\n  Merge it first. If it went in another way (a squash merge), the owner says so: quick land ${run} --answer "<their words>"`);
  // The run's records become the project's: what was taken is replaced, what is new is added, nothing else is touched.
  const taken = new Set(info.taken ?? []);
  const copied = [];
  for (const r of records(dir)) {
    const dest = join(home, r.rel);
    if (existsSync(dest) && !taken.has(r.id)) continue; // context copies and anything the project changed meanwhile stay the project's
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, r.text);
    copied.push(r.id);
  }
  // what the run filed beside its records (archived steps, designs, references, research): added, never replacing
  for (const parts of [["spec", "archive"], ["spec", "designs"], ["spec", "references"], ["research"]]) {
    const src = join(dir, ...parts);
    if (existsSync(src)) cpSync(src, join(home, ...parts), { recursive: true, force: false, errorOnExist: false });
  }
  // The design system is the project's. A run that defined it, or signed a newer version, brings it home whole;
  // an older or equal one never replaces the project's.
  {
    const ds = ["spec", "design-system"];
    const ver = (d) => { try { const j = JSON.parse(readFileSync(join(d, ...ds, "design-system.json"), "utf8")); return j.mode ? Number(j.version) || 0 : -1; } catch { return -1; } };
    const mine = ver(dir), theirs = ver(home);
    if (mine >= 0 && (theirs < 0 || mine > theirs)) cpSync(join(dir, ...ds), join(home, ...ds), { recursive: true, force: true });
  }
  // An answer the owner gave once per project inside the run (where knowledge lives, what must never happen) is the
  // project's too, when the project has none of its own.
  for (const f of ["sources.json", "risk-profile.json"]) { const t = readIf(join(dir, f)); if (t !== null && !existsSync(join(home, f))) writeFileSync(join(home, f), t); }
  giveBack(home, info);
  writeInfo(dir, { ...info, state: "landed", landed: new Date().toISOString(), landed_by: answer ? "owner" : "merge", ...(answer ? { landed_answer: answer.slice(0, 400) } : {}) });
  try { logEvent(home, "quick_landed", { run, branch: info.branch, records: copied.join(","), by: answer ? "owner" : "merge" }); } catch { /* best-effort */ }
  cli(home, "reconcile", "--fix");
  process.stdout.write(`${run} has landed: ${copied.length} record${copied.length === 1 ? "" : "s"} now in the project (${copied.join(", ") || "none"}).\n`);
}

function drop(home, args) {
  const run = args.find((a) => QUICK_RUN_RE.test(a));
  if (!run) fail("which run? quick drop <run> --reason \"<why>\"", 2);
  const ri = args.indexOf("--reason");
  const reason = ri !== -1 ? String(args[ri + 1] ?? "").trim() : "";
  if (!reason || reason.startsWith("--")) fail("say why: quick drop <run> --reason \"<why>\"", 2);
  const dir = join(home, "quick", run);
  const info = quickInfo(dir);
  if (!info) fail(`no run ${run} in this project.`);
  if (!["active", "finished"].includes(info.state)) fail(`${run} is already ${info.state}.`);
  const held = heldLocks(dir);
  if (held.length) fail(`${held.join(" and ")} of ${run} is still open. End that command first.`);
  const root = repoFor(home);
  const wt = sweepWorktrees(root, { owner: run });
  const swept = sweepBranches(root, { label: run, owner: run });
  giveBack(home, info);
  for (const id of info.taken ?? []) {
    const r = records(home, STORY_KINDS).find((x) => x.id === id);
    if (r && clean(r.fm.status) === "approved") cli(home, "backlog", "add", id);
  }
  git(["config", "--unset", `branch.${info.branch}.shipyard-quick`], root);
  writeInfo(dir, { ...info, state: "dropped", dropped: new Date().toISOString(), drop_reason: reason.slice(0, 400) });
  try { logEvent(home, "quick_dropped", { run, branch: info.branch, reason: reason.slice(0, 200) }); } catch { /* best-effort */ }
  process.stdout.write(`${run} is dropped.${info.taken?.length ? ` Back in the project as they were: ${info.taken.join(", ")}.` : ""} Branch ${info.branch} was not touched${wt.kept.length ? `; ${wt.kept.length} builder working cop${wt.kept.length === 1 ? "y" : "ies"} with uncommitted changes left in place` : ""}${swept.archived ? `; ${swept.archived} unmerged builder branch${swept.archived === 1 ? "" : "es"} kept under ${swept.refs_prefix}` : ""}.\n`);
}

function list(home, json) {
  const runs = listRuns(home);
  if (json) { process.stdout.write(JSON.stringify(runs.map(({ dir, ...r }) => ({ ...r, dir: relative(home, dir) }))) + "\n"); return; }
  if (!runs.length) { process.stdout.write("No quick runs in this project.\n"); return; }
  const root = repoFor(home);
  process.stdout.write("run        state     branch                          item\n");
  for (const r of runs) {
    const state = r.state === "active" ? stageOf(r.dir)?.stage ?? "active" : r.state === "finished" && root && merged(root, r) ? "merged" : r.state;
    process.stdout.write(`${r.run.padEnd(10)} ${String(state).padEnd(9)} ${String(r.branch).slice(0, 30).padEnd(31)} ${String(r.item).replace(/\s+/g, " ").slice(0, 60)}\n`);
  }
}

export function main(dataDir, args = []) {
  const sub = args[0];
  const rest = args.slice(1);
  const json = args.includes("--json");
  const here = quickInfo(dataDir);
  const home = homeOf(dataDir);
  if (sub === "start") {
    if (here?.state === "active") { process.stdout.write(`${here.run} is already open on this branch. Carrying on with it.\n`); printNext(dataDir, false); return; }
    return start(home, rest.filter((a) => a !== "--json"));
  }
  if (sub === "next") {
    if (!here || here.state !== "active") {
      const waiting = listRuns(home).filter((r) => r.state === "active");
      process.stdout.write(`No quick run is open on this branch.${waiting.length ? ` Open on other branches: ${waiting.map((r) => `${r.run} (${r.branch})`).join(", ")} — switch to that branch to carry on.` : ""}\n  Start one: /ship-quick <the item>\n`);
      process.exit(here ? 0 : 3);
    }
    const session = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
    if (session && session !== here.session) writeInfo(dataDir, { ...here, session });
    return printNext(dataDir, json);
  }
  if (sub === "pick") { if (!here) fail("no quick run is open on this branch."); return pick(dataDir, rest.filter((a) => a !== "--json")); }
  if (sub === "finish") { if (!here) fail("no quick run is open on this branch."); return finish(dataDir); }
  if (sub === "list") return list(home, json);
  if (sub === "land") return land(home, rest);
  if (sub === "drop") return drop(home, rest);
  process.stderr.write("shipyard-data quick: start [--tutorial [--sandbox]] <item> | pick <item> | next [--json] | finish | list [--json] | land <run> [--answer \"…\"] | drop <run> --reason \"…\"\n");
  process.exit(2);
}
