/**
 * After 4.0.7: `/ship-quick --tutorial` — a quick run with narration printed by the CLI.
 * These pin: the `pick` stage, the `TUTORIAL:` blocks before each NEXT line and under a gate's refusal,
 * a plain run's output unchanged, the one-time offer on the dashboard, the close that records the tutorial
 * as taken, and the sandbox project. The walk is driven by records, as test_quick.mjs drives `stageOf`,
 * so no agent runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageOf } from "../bin/quick.mjs";
import { isTutorial, normalizeCursorKey, tutorialBlock, loadNarration, SANDBOX_MARKER } from "../bin/tutorial.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
const CONTEXT = join(ROOT, "bin", "shipyard-context.mjs");
const RESOLVER = join(ROOT, "bin", "shipyard-resolver.mjs");

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutorial-")));
  const repo = join(root, "repo"); const data = join(root, "data");
  mkdirSync(repo, { recursive: true }); mkdirSync(data, { recursive: true });
  const genv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: genv }).trim();
  g("init", "-q", "-b", "main"); writeFileSync(join(repo, "a.txt"), "a\n"); g("add", "-A"); g("commit", "-q", "-m", "init");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_CODE_SESSION_ID: "S1" };
  delete env.SHIPYARD_DATA; delete env.CLAUDE_PID; delete env.CLAUDE_PROJECT_DIR;
  const run = (args, extra = {}) => { const r = spawnSync("node", [CLI, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: "utf8" }); return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" }; };
  const ctx = (args) => { const r = spawnSync("node", [CONTEXT, ...args], { cwd: repo, env, encoding: "utf8" }); return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" }; };
  assert.equal(run(["onboarding", "bootstrap"]).code, 0);
  const where = () => spawnSync("node", [RESOLVER, "data-dir"], { cwd: repo, env, encoding: "utf8" }).stdout.trim();
  const home = where();
  const story = (dir, id, status, extra = "") => {
    mkdirSync(join(dir, "spec", "stories"), { recursive: true });
    writeFileSync(join(dir, "spec", "stories", `${id}-x.md`), `---\nid: ${id}\ntitle: "story ${id}"\ntype: feature\nstatus: ${status}\nrefined: true\n${extra}---\n\n# ${id}\n`);
  };
  return { root, repo, home, env, run, ctx, g, where, story, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const onboarding = (home) => JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"));

test("a tutorial opens without an item at the pick stage, narrates every stage before its NEXT line, and a plain run prints no narration", () => {
  const p = project();
  try {
    p.g("switch", "-q", "-c", "tutorial");
    let r = p.run(["quick", "start", "--tutorial"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^TUTORIAL: A guided run of one small change, on the branch you are on\./m, "the intro block comes first");
    assert.match(r.out, /Models: this run uses the models your project uses, routed the same way/, "the cost disclaimer is in the intro");
    assert.match(r.out, /Started quick-001 \(tutorial\) on branch tutorial/);
    assert.match(r.out, /stage: \[pick\] → discuss → plan → build → review → finish/);
    assert.match(r.out, /item:  \(to be picked\)/);
    assert.match(r.out, /TUTORIAL: First, something small to build\.[\s\S]*NEXT: Find three small, safe improvements/, "the pick block precedes the pick instructions");
    const dir = p.where();
    const info = JSON.parse(readFileSync(join(dir, "quick.json"), "utf8"));
    assert.equal(info.tutorial, true);
    assert.equal(info.item, "");
    assert.equal(stageOf(dir).stage, "pick");
    assert.equal(isTutorial(dir), true);
    assert.equal(readFileSync(join(dir, "config.md"), "utf8"), readFileSync(join(p.home, "config.md"), "utf8"), "the run's settings are the project's, byte for byte");

    // the stage cannot move on without an item
    r = p.run(["quick", "finish"]);
    assert.equal(r.code, 3);
    r = p.run(["quick", "pick"]);
    assert.equal(r.code, 2, "a pick needs words");
    r = p.run(["quick", "pick", "handle an empty title in slugify"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Picked for quick-001: handle an empty title in slugify/);
    assert.match(r.out, /TUTORIAL: Stage 1 of 4: the discussion\.[\s\S]*NEXT: Run the discussion for this item now/, "the discuss block precedes the discuss instructions");
    assert.equal(stageOf(dir).stage, "discuss");
    assert.match(readFileSync(join(p.home, ".shipyard-events.jsonl"), "utf8"), /"quick_picked"/);
    r = p.run(["quick", "pick", "something else"]);
    assert.equal(r.code, 3, "an item is picked once");

    // the walk, by records: plan → build → review → finish, each with its block before NEXT
    p.story(dir, "S001", "approved");
    r = p.run(["quick", "next"]);
    assert.match(r.out, /TUTORIAL: Stage 2 of 4: the plan\.[\s\S]*probes-at-base[\s\S]*NEXT: Plan the whole item now/);
    const j = JSON.parse(p.run(["quick", "next", "--json"]).out);
    assert.equal(j.tutorial, true);
    assert.match(j.narration, /^TUTORIAL: Stage 2 of 4/);
    const cur = join(dir, "sprints", "current"); mkdirSync(cur, { recursive: true });
    writeFileSync(join(cur, "SPRINT.md"), "---\nid: sprint-001\nstatus: active\nstories: [S001]\n---\n");
    r = p.run(["quick", "next"]);
    assert.match(r.out, /TUTORIAL: Stage 3 of 4: the build\.[\s\S]*NEXT: Build it now/);
    writeFileSync(join(cur, "EXECUTE-CURSOR.md"), "---\nstage: terminal\nstatus: complete\nterminal: true\n---\n");
    r = p.run(["quick", "next"]);
    assert.match(r.out, /TUTORIAL: Stage 4 of 4: the review\.[\s\S]*NEXT: Show the review now/);
    const order = ["pick", "discuss", "plan", "build", "review", "finish"].map((k) => loadNarration().get(`quick:${k}`).split("\n")[0]);
    assert.ok(order.every(Boolean), "every quick stage has narration");

    // the cursor's block, keyed with N for the wave number; nothing in a plain run
    assert.match(tutorialBlock(dir, `cursor:${normalizeCursorKey("wave_3_gate")}`), /^TUTORIAL: The wave gate\./);
    assert.equal(normalizeCursorKey("wave_2_redispatch_iter_4"), "wave_N_redispatch_iter_N");
    assert.equal(tutorialBlock(dir, "cursor:no_such_stage"), "");
    assert.equal(tutorialBlock(p.home, "cursor:wave_N_gate"), "", "the project's own folder is not a tutorial");

    // a plain run on another branch: the 4.0.7 output, byte for byte in shape
    p.g("switch", "-q", "main"); p.g("switch", "-q", "-c", "feat/plain");
    r = p.run(["quick", "start", "export the report as a file"]);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /TUTORIAL/);
    assert.match(r.out, /^Started quick-002 on branch feat\/plain\.\nQUICK RUN quick-002 on branch feat\/plain\n  item:  export the report as a file\n  stage: \[discuss\] → plan → build → review → finish\nNEXT: Run the discussion/m);
    assert.equal(stageOf(p.where()).stage, "discuss", "a plain run never opens at pick");
    assert.equal("tutorial" in JSON.parse(p.run(["quick", "next", "--json"]).out), false);
    assert.equal(isTutorial(p.where()), false);
  } finally { p.cleanup(); }
});

test("--sandbox goes with --tutorial, and a tutorial refuses the main line like any quick run", () => {
  const p = project();
  try {
    let r = p.run(["quick", "start", "--tutorial"]);
    assert.equal(r.code, 3);
    assert.match(r.err, /you are on main[\s\S]*git switch -c <name>/);
    assert.equal(existsSync(join(p.home, "quick")), false);
    r = p.run(["quick", "start", "--sandbox", "a thing"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--sandbox goes with --tutorial/);
    r = p.run(["quick", "start", "x"], {});
    assert.equal(r.code, 3, "a plain start on main is refused as before");
  } finally { p.cleanup(); }
});

test("a gate's refusal carries its TUTORIAL block in a tutorial run and nothing in a plain run", () => {
  const p = project();
  try {
    p.g("switch", "-q", "-c", "tutorial");
    assert.equal(p.run(["quick", "start", "--tutorial", "a small thing"]).code, 0);
    const dir = p.where();
    // task-return: a COMPLETE claim with a failing probe is refused; the tutorial says what the gate is for
    let r = p.run(["task-return", "P001", "status=COMPLETE", "commit=0123456789ab", "probe-exit=1", "--data-dir", dir]);
    assert.equal(r.code, 3);
    assert.match(r.err, /requires probe-exit=0[\s\S]*TUTORIAL: This is a gate firing, on purpose\.\n  A builder claimed a step was complete/);
    // story approval: an unrefined story cannot be approved; the block follows the refusal
    mkdirSync(join(dir, "spec", "stories"), { recursive: true });
    writeFileSync(join(dir, "spec", "stories", "S001-x.md"), "---\nid: S001\ntitle: \"s\"\ntype: feature\nstatus: proposed\nrefined: false\n---\n\n# S001\n");
    r = p.run(["story", "set-status", "S001", "approved", "--data-dir", dir]);
    assert.equal(r.code, 3);
    assert.match(r.err, /is unrefined[\s\S]*TUTORIAL: This is a gate firing, on purpose\.\n  A story cannot be approved while something it needs is missing/);
    // the same refusals in the project's own folder say nothing about a tutorial
    r = p.run(["task-return", "P001", "status=COMPLETE", "commit=0123456789ab", "probe-exit=1", "--data-dir", p.home]);
    assert.equal(r.code, 3);
    assert.doesNotMatch(r.err, /TUTORIAL/);
  } finally { p.cleanup(); }
});

test("the dashboard offers the tutorial once per project; other skill starts read the answer without changing it", () => {
  const p = project();
  try {
    // bootstrap already ran in project(): the first print stamped the offer
    const rec = onboarding(p.home);
    assert.ok(rec.tutorial_offered, "bootstrap printed the offer and recorded it");
    assert.equal(rec.tutorial_completed, null);
    let r = p.run(["onboarding", "status"]);
    assert.match(r.out, /^SHIPYARD_TUTORIAL_OFFER=false$/m, "offered once, not again");

    // a fresh project: the help context reads true and does not stamp; the dashboard stamps
    rmSync(join(p.home, "onboarding.json"));
    r = p.ctx(["help-context"]);
    assert.match(r.out, /^SHIPYARD_TUTORIAL_OFFER=true$/m);
    assert.equal(existsSync(join(p.home, "onboarding.json")), false, "a read does not record the offer");
    r = p.ctx(["status-dashboard"]);
    assert.match(r.out, /^SHIPYARD_TUTORIAL_OFFER=true$/m);
    assert.ok(onboarding(p.home).tutorial_offered, "the dashboard records the offer");
    r = p.ctx(["status-dashboard"]);
    assert.match(r.out, /^SHIPYARD_TUTORIAL_OFFER=false$/m);
    const log = join(p.home, ".shipyard-events.jsonl");
    assert.ok(!existsSync(log) || !/tutorial_offered/.test(readFileSync(log, "utf8")), "the offer is a record, not an event: the sprint's event report must not count it");
  } finally { p.cleanup(); }
});

test("a finished tutorial records itself as taken and prints what was seen, what it cost and what is next; a plain finish records nothing", () => {
  const p = project();
  try {
    p.g("switch", "-q", "-c", "tutorial");
    assert.equal(p.run(["quick", "start", "--tutorial", "a small thing"]).code, 0);
    const dir = p.where();
    p.story(dir, "S001", "done");
    assert.equal(stageOf(dir).stage, "finish");
    let r = p.run(["quick", "finish"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /quick-001 is finished\./);
    assert.match(r.out, /TUTORIAL: The run is over\./);
    assert.match(r.out, /^What you saw\n  Gates that fired:\n/m);
    assert.match(r.out, /^What this tutorial cost\n/m);
    assert.match(r.out, /^Next\n  \/ship-discuss <what you want>   start real work\n  \/ship-help/m);
    assert.match(r.out, /Branch tutorial: 0 commits, nothing pushed/);
    const rec = onboarding(p.home);
    assert.ok(rec.tutorial_completed, "the project remembers the tutorial was taken");
    assert.match(readFileSync(join(p.home, ".shipyard-events.jsonl"), "utf8"), /"tutorial_completed"[^\n]*"run":"quick-001"/);
    assert.match(p.run(["onboarding", "status"]).out, /^SHIPYARD_TUTORIAL_OFFER=false$/m);

    // a plain run's finish leaves the record alone
    const before = readFileSync(join(p.home, "onboarding.json"), "utf8");
    p.g("switch", "-q", "main"); p.g("switch", "-q", "-c", "feat/plain");
    assert.equal(p.run(["quick", "start", "another thing"]).code, 0);
    p.story(p.where(), "S002", "done");
    r = p.run(["quick", "finish"]);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /TUTORIAL|What you saw/);
    assert.equal(readFileSync(join(p.home, "onboarding.json"), "utf8"), before);
  } finally { p.cleanup(); }
});

test("the sandbox is a small Node project on branch tutorial, set up for Shipyard, and only a folder the CLI made is removed", () => {
  const p = project();
  const folder = join(p.root, "sandbox");
  try {
    let r = p.run(["tutorial", "sandbox", "--path", folder]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Sandbox ready at .*sandbox on branch tutorial\.\n  Open a session there and run \/ship-quick --tutorial:   cd .*sandbox && claude$/m);
    assert.equal(existsSync(join(folder, SANDBOX_MARKER)), true);
    const g = (...a) => execFileSync("git", a, { cwd: folder, encoding: "utf8" }).trim();
    assert.equal(g("symbolic-ref", "--short", "HEAD"), "tutorial");
    assert.equal(g("rev-list", "--count", "HEAD"), "1");
    assert.equal(g("status", "--porcelain"), "", "everything is committed");
    assert.equal(JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).scripts.test, "node --test");
    const t = spawnSync("node", ["--test"], { cwd: folder, encoding: "utf8" });
    assert.equal(t.status, 0, t.stderr);
    assert.match(readFileSync(join(folder, "src", "slug.js"), "utf8"), /TODO/, "the fixture leaves something to improve");
    // Shipyard is set up in the sandbox's own data folder, with the stack detected
    const sd = spawnSync("node", [RESOLVER, "data-dir"], { cwd: folder, env: p.env, encoding: "utf8" }).stdout.trim();
    assert.notEqual(sd, p.home, "the sandbox is a project of its own");
    const config = readFileSync(join(sd, "config.md"), "utf8");
    assert.match(config, /project_type: "node"/);
    assert.match(config, /unit: "npm test"/);

    r = p.run(["tutorial", "sandbox", "--path", folder]);
    assert.equal(r.code, 3, "a non-empty folder is refused");
    const other = join(p.root, "not-a-sandbox"); mkdirSync(other); writeFileSync(join(other, "x"), "x");
    r = p.run(["tutorial", "sandbox", "--remove", other]);
    assert.equal(r.code, 3);
    assert.match(r.err, /was not made by/);
    assert.equal(existsSync(other), true);
    r = p.run(["tutorial", "sandbox", "--remove", folder]);
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(folder), false);
    r = p.run(["tutorial"]);
    assert.equal(r.code, 2);
  } finally { p.cleanup(); }
});
