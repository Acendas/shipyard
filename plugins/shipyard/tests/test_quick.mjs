/**
 * After 4.0.6: `/ship-quick` — one item from words to reviewed code on the person's own branch, with records
 * of its own. These pin what keeps it apart from the regular project and what keeps it honest:
 * the branch binding, the shared id counter, taken records, the stage read from the records, builders seen
 * only by their own side, the close, and the way the records come home.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideQuick, QUICK_GOES_ON } from "../bin/hooks/ask-after-explain.mjs";
import { stageOf } from "../bin/quick.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
const RESOLVER = join(ROOT, "bin", "shipyard-resolver.mjs");

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quick-")));
  const repo = join(root, "repo"); const data = join(root, "data");
  mkdirSync(repo, { recursive: true }); mkdirSync(data, { recursive: true });
  const genv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: genv }).trim();
  g("init", "-q", "-b", "main"); writeFileSync(join(repo, "a.txt"), "a\n"); g("add", "-A"); g("commit", "-q", "-m", "init");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_CODE_SESSION_ID: "S1" };
  delete env.SHIPYARD_DATA; delete env.CLAUDE_PID; delete env.CLAUDE_PROJECT_DIR;
  const run = (args, extra = {}) => { const r = spawnSync("node", [CLI, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: "utf8" }); return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" }; };
  assert.equal(run(["onboarding", "bootstrap"]).code, 0);
  const where = () => spawnSync("node", [RESOLVER, "data-dir"], { cwd: repo, env, encoding: "utf8" }).stdout.trim();
  const home = where();
  const story = (dir, id, status, extra = "") => {
    mkdirSync(join(dir, "spec", "stories"), { recursive: true });
    writeFileSync(join(dir, "spec", "stories", `${id}-x.md`), `---\nid: ${id}\ntitle: "story ${id}"\ntype: feature\nstatus: ${status}\nrefined: true\n${extra}---\n\n# ${id}\n`);
  };
  const commit = (file) => { writeFileSync(join(repo, file), file); g("add", "-A"); g("commit", "-q", "-m", file); return g("rev-parse", "HEAD"); };
  return { root, repo, home, run, g, where, story, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const fm = (p) => readFileSync(p, "utf8").split("\n---")[0];

test("a quick run needs a branch of its own, and while the checkout is on it every command works in the run's own folder", () => {
  const p = project();
  try {
    let r = p.run(["quick", "start", "export the report as a file"]);
    assert.equal(r.code, 3);
    assert.match(r.err, /you are on main[\s\S]*git switch -c <name>/);
    assert.equal(existsSync(join(p.home, "quick")), false, "a refused start leaves nothing behind");

    p.g("switch", "-q", "-c", "feat/export");
    r = p.run(["quick", "start", "export the report as a file"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Started quick-001 on branch feat\/export[\s\S]*stage: \[discuss\] → plan → build → review → finish[\s\S]*NEXT: Run the discussion[\s\S]*shipyard:ship-discuss/);
    const dir = join(p.home, "quick", "quick-001");
    assert.equal(p.where(), dir);
    assert.equal(existsSync(join(p.home, "quick", ".open")), true);
    assert.equal(readFileSync(join(dir, "config.md"), "utf8"), readFileSync(join(p.home, "config.md"), "utf8"), "the run starts with the project's settings");
    assert.equal(existsSync(join(dir, ".shipyard-events.jsonl")) && /sprint_archived|command_run/.test(readFileSync(join(dir, ".shipyard-events.jsonl"), "utf8")), false, "the project's history is never copied");
    // a second start on the same branch carries on with the same run
    r = p.run(["quick", "start", "something else"]);
    assert.match(r.out, /quick-001 is already open on this branch/);

    // one id counter for the project and its runs
    assert.equal(p.run(["next-id", "stories"]).out.trim(), "001");
    p.g("switch", "-q", "main");
    assert.equal(p.where(), p.home, "back on main, the regular project is back");
    assert.equal(p.run(["next-id", "stories"]).out.trim(), "002");
    r = p.run(["quick", "next"]);
    assert.equal(r.code, 3);
    assert.match(r.out, /No quick run is open on this branch\. Open on other branches: quick-001 \(feat\/export\)/);
    assert.match(readFileSync(join(p.home, ".shipyard-events.jsonl"), "utf8"), /"quick_started"[^\n]*"run":"quick-001"/);
  } finally { p.cleanup(); }
});

test("an item the project already has is taken: off the regular backlog, marked at home, and no second run can take it", () => {
  const p = project();
  try {
    p.story(p.home, "S001", "approved", "epic: E001\n");
    mkdirSync(join(p.home, "spec", "epics"), { recursive: true });
    writeFileSync(join(p.home, "spec", "epics", "E001-x.md"), "---\nid: E001\ntitle: \"epic\"\nstatus: proposed\n---\n");
    p.story(p.home, "S002", "in-progress");
    assert.equal(p.run(["backlog", "add", "S001"]).code, 0);
    assert.match(readFileSync(join(p.home, "backlog", "BACKLOG.md"), "utf8"), /S001/);

    p.g("switch", "-q", "-c", "feat/one");
    let r = p.run(["quick", "start", "S009"]);
    assert.equal(r.code, 3);
    assert.match(r.err, /no record S009/);
    r = p.run(["quick", "start", "S002"]);
    assert.equal(r.code, 3);
    assert.match(r.err, /S002 is being built in the regular sprint/);
    r = p.run(["quick", "start", "S001"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Taken from the project: S001/);
    const dir = join(p.home, "quick", "quick-001");
    assert.match(fm(join(p.home, "spec", "stories", "S001-x.md")), /^quick: quick-001$/m);
    assert.doesNotMatch(fm(join(dir, "spec", "stories", "S001-x.md")), /^quick:/m);
    assert.equal(existsSync(join(dir, "spec", "epics", "E001-x.md")), true, "its epic comes along to read");
    assert.equal(existsSync(join(dir, "spec", "stories", "S002-x.md")), false, "nothing else of the project is in the run");
    assert.doesNotMatch(readFileSync(join(p.home, "backlog", "BACKLOG.md"), "utf8"), /\bS001\b/);
    assert.equal(stageOf(dir).stage, "plan", "an approved story is ready to plan");

    p.g("switch", "-q", "main"); p.g("switch", "-q", "-c", "feat/two");
    r = p.run(["quick", "start", "S001"]);
    assert.equal(r.code, 3);
    assert.match(r.err, /S001 is already in quick-001/);

    // dropped: the record is the project's again, untouched, and back on the backlog
    r = p.run(["quick", "drop", "quick-001"]);
    assert.equal(r.code, 2, "a drop needs a reason");
    r = p.run(["quick", "drop", "quick-001", "--reason", "not now"]);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(fm(join(p.home, "spec", "stories", "S001-x.md")), /^quick:/m);
    assert.match(readFileSync(join(p.home, "backlog", "BACKLOG.md"), "utf8"), /\bS001\b/);
    p.g("switch", "-q", "feat/one");
    assert.equal(p.where(), p.home, "the branch is no longer bound");
    assert.equal(p.g("rev-parse", "--abbrev-ref", "HEAD"), "feat/one", "and it was not touched");
  } finally { p.cleanup(); }
});

test("the stage is read from the records, so it cannot be skipped by saying so", () => {
  const p = project();
  try {
    p.g("switch", "-q", "-c", "feat/x");
    assert.equal(p.run(["quick", "start", "a thing"]).code, 0);
    const dir = p.where();
    assert.equal(stageOf(dir).stage, "discuss");
    assert.equal(p.run(["quick", "finish"]).code, 3, "nothing is built yet");
    p.story(dir, "S001", "proposed");
    p.story(dir, "S002", "approved");
    assert.deepEqual([stageOf(dir).stage, stageOf(dir).waiting], ["discuss", ["S001"]], "one story is not approved yet");
    p.story(dir, "S001", "approved");
    assert.deepEqual(stageOf(dir).stories.sort(), ["S001", "S002"]);
    assert.match(p.run(["quick", "next"]).out, /\[plan\][\s\S]*shipyard:ship-sprint[\s\S]*S001, S002[\s\S]*no capacity limit/);
    // a sprint holds them
    const cur = join(dir, "sprints", "current"); mkdirSync(cur, { recursive: true });
    writeFileSync(join(cur, "SPRINT.md"), "---\nid: sprint-001\nstatus: active\nstories: [S001, S002]\n---\n");
    assert.equal(stageOf(dir).stage, "build");
    writeFileSync(join(cur, "EXECUTE-CURSOR.md"), "---\nstage: wave_1_build\nstatus: in_progress\n---\n");
    assert.equal(stageOf(dir).stage, "build");
    writeFileSync(join(cur, "EXECUTE-CURSOR.md"), "---\nstage: terminal\nstatus: complete\nterminal: true\n---\n");
    assert.equal(stageOf(dir).stage, "review");
    assert.match(p.run(["quick", "next", "--json"]).out, /"stage":"review"[^\n]*shipyard:ship-review/);
    // reviewed and archived, one story carried over: it is planned again
    rmSync(cur, { recursive: true }); mkdirSync(join(dir, "sprints", "sprint-001"), { recursive: true });
    p.story(dir, "S001", "done");
    assert.equal(stageOf(dir).stage, "plan");
    p.story(dir, "S002", "done");
    assert.equal(stageOf(dir).stage, "finish");
    // a small item filed as a task builds with no sprint
    mkdirSync(join(dir, "spec", "tasks"), { recursive: true });
    writeFileSync(join(dir, "spec", "tasks", "T001-x.md"), "---\nid: T001\nstatus: open\nkind: chore\n---\n");
    assert.match(p.run(["quick", "next"]).out, /ship-execute", args: "--task T001"/);
  } finally { p.cleanup(); }
});

test("each side sees only its own builders, and the run closes only when its builders are gone", () => {
  const p = project();
  try {
    // the regular project has a builder with unmerged work
    p.g("switch", "-q", "-c", "shipyard/wt-agent-home"); p.commit("home-builder.txt"); p.g("switch", "-q", "main");
    p.g("switch", "-q", "-c", "feat/x");
    assert.equal(p.run(["quick", "start", "a thing"]).code, 0);
    const dir = p.where();
    // the run's builders: one merged back, one whose worktree still has uncommitted work
    const mk = (name) => { p.g("switch", "-q", "-c", name); p.g("config", `branch.${name}.shipyard-owner`, "quick-001"); };
    mk("shipyard/wt-agent-q1"); p.commit("q1.txt"); p.g("switch", "-q", "feat/x"); p.g("merge", "-q", "--no-ff", "-m", "merge q1", "shipyard/wt-agent-q1");
    mk("shipyard/wt-agent-q2"); p.g("switch", "-q", "feat/x");
    p.g("worktree", "add", "-q", join(p.root, "wt-q2"), "shipyard/wt-agent-q2");
    writeFileSync(join(p.root, "wt-q2", "half.txt"), "not committed\n");

    let s = JSON.parse(p.run(["branches", "status", "--json"]).out);
    assert.deepEqual([s.visible, s.worktrees], [2, 1], "inside the run: its two builders, not the project's");
    s = JSON.parse(p.run(["branches", "status", "--json", "--data-dir", p.home]).out);
    assert.deepEqual([s.visible, s.worktrees], [1, 0], "at home: the project's one builder, not the run's");

    p.story(dir, "S001", "done");
    let r = p.run(["quick", "finish"]);
    assert.equal(r.code, 3);
    assert.match(r.err, /1 builder working copy of this run still has uncommitted changes and was not removed[\s\S]*wt-q2/);
    assert.equal(stageOf(dir).info.state, "active", "a refused close changes nothing");
    rmSync(join(p.root, "wt-q2", "half.txt"));
    r = p.run(["quick", "finish"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /quick-001 is finished\. It is all on branch feat\/x: 2 commits, 1 item built and reviewed \(S001\)[\s\S]*1 working copy removed, 2 merged branches deleted[\s\S]*Shipyard did not merge or push it/);
    const left = p.g("branch", "--format=%(refname:short)").split("\n").sort();
    assert.deepEqual(left, ["feat/x", "main", "shipyard/wt-agent-home"], "the run's builders are gone; the project's is untouched");
    assert.equal(readFileSync(join(p.repo, ".git", "config"), "utf8").includes("quick-001"), false, "nothing of the run is left in the repository's config");
    assert.equal(p.where(), p.home, "the branch is unbound: the person's from here");
    assert.equal(existsSync(join(p.home, "quick", ".open")), false, "no run is open: the resolver asks git nothing from here on");
  } finally { p.cleanup(); }
});

test("the project's records follow the code: they land when the branch is merged, or on the owner's word", () => {
  const p = project();
  try {
    p.story(p.home, "S001", "approved");
    p.g("switch", "-q", "-c", "feat/x");
    assert.equal(p.run(["quick", "start", "S001"]).code, 0);
    const dir = p.where();
    p.commit("feature.txt");
    p.story(dir, "S001", "done");
    p.story(dir, "S002", "done"); // a story the discussion added
    assert.equal(p.run(["quick", "finish"]).code, 0);
    p.g("switch", "-q", "main");
    assert.match(fm(join(p.home, "spec", "stories", "S001-x.md")), /^status: approved$/m, "built on a branch is not done in the project");
    assert.match(p.run(["quick", "list"]).out, /quick-001\s+finished\s+feat\/x/);
    let r = p.run(["quick", "land", "quick-001"]);
    assert.equal(r.code, 3);
    assert.match(r.err, /is not merged into the branch this working copy is on/);
    assert.equal(p.run(["reconcile"]).out.includes("quick-run-merged"), false);

    p.g("merge", "-q", "--no-ff", "-m", "merge feat/x", "feat/x");
    assert.match(p.run(["quick", "list"]).out, /quick-001\s+merged/);
    r = p.run(["reconcile"]);
    assert.match(r.out + r.err, /quick-001 \(branch feat\/x\) is built and merged; its records are not in the project yet/);
    r = p.run(["reconcile", "--fix"]);
    assert.equal(r.code, 0, r.out + r.err);
    const s1 = fm(join(p.home, "spec", "stories", "S001-x.md"));
    assert.match(s1, /^status: done$/m);
    assert.doesNotMatch(s1, /^quick:/m);
    assert.equal(existsSync(join(p.home, "spec", "stories", "S002-x.md")), true, "what the run added is in the project now");
    assert.match(p.run(["quick", "land", "quick-001"]).out, /already landed/);

    // a squash merge leaves no ancestry: the owner says so
    p.g("switch", "-q", "-c", "feat/y");
    assert.equal(p.run(["quick", "start", "another thing"]).code, 0);
    p.commit("y.txt"); p.story(p.where(), "S003", "done");
    assert.equal(p.run(["quick", "finish"]).code, 0);
    p.g("switch", "-q", "main");
    assert.equal(p.run(["quick", "land", "quick-002"]).code, 3);
    r = p.run(["quick", "land", "quick-002", "--answer", "squashed it in by hand"]);
    assert.equal(r.code, 0, r.err);
    assert.match(readFileSync(join(p.home, ".shipyard-events.jsonl"), "utf8"), /"quick_landed"[^\n]*"run":"quick-002"[^\n]*"by":"owner"/);
  } finally { p.cleanup(); }
});

test("a working copy made beside the project starts a quick run with the project's settings", () => {
  const p = project();
  try {
    const cfg = join(p.home, "config.md");
    writeFileSync(cfg, readFileSync(cfg, "utf8") + "\n# marker-from-the-project\n");
    const wt = join(p.root, "beside");
    p.g("worktree", "add", "-q", wt, "-b", "feat/beside");
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: join(p.root, "data"), CLAUDE_CODE_SESSION_ID: "S1" };
    delete env.SHIPYARD_DATA; delete env.CLAUDE_PROJECT_DIR;
    const r = spawnSync("node", [CLI, "quick", "start", "a thing"], { cwd: wt, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const dir = spawnSync("node", [RESOLVER, "data-dir"], { cwd: wt, env, encoding: "utf8" }).stdout.trim();
    assert.match(dir, /quick[\\/]quick-001$/);
    assert.equal(dir.startsWith(p.home), false, "it is a project of its own, beside the regular one");
    assert.match(readFileSync(join(dir, "config.md"), "utf8"), /marker-from-the-project/);
    assert.equal(p.where(), p.home, "the regular project's working copy is not affected");
  } finally { p.cleanup(); }
});

test("a quick run is not left standing between its stages, and is left alone inside one", () => {
  const p = project();
  try {
    p.g("switch", "-q", "-c", "feat/x");
    assert.equal(p.run(["quick", "start", "a thing"]).code, 0);
    const dir = p.where();
    const stop = (session = "S1", last = "Planning is next: run /ship-sprint.") => decideQuick(dir, { session_id: session, last_assistant_message: last });
    assert.equal(stop(), null, "a discussion that is not running was paused or waits on the person");
    p.story(dir, "S001", "approved");
    const v = stop();
    assert.equal(v?.kind, "quick");
    assert.match(v.reason, new RegExp(`^${QUICK_GOES_ON} It is at "plan"[\\s\\S]*shipyard-data quick next`));
    assert.equal(stop("S2"), null, "another session is not this run's");
    assert.equal(stop("S1", "Here is the plan.\n\nQuestion follows."), null, "a card is on its way");
    writeFileSync(join(dir, ".active-session.json"), JSON.stringify({ skill: "ship-sprint", session_id: "S1", cleared: null }));
    assert.equal(stop(), null, "a command is running: its own rules decide");
    writeFileSync(join(dir, ".active-session.json"), JSON.stringify({ skill: null, cleared: "x" }));
    const cur = join(dir, "sprints", "current"); mkdirSync(cur, { recursive: true });
    writeFileSync(join(cur, "SPRINT.md"), "---\nid: sprint-001\nstatus: active\nstories: [S001]\n---\n");
    writeFileSync(join(cur, "EXECUTE-CURSOR.md"), "---\nstage: wave_1_build\nstatus: paused\n---\n");
    assert.equal(stop(), null, "a build that paused to ask is the person's turn");
    writeFileSync(join(cur, "EXECUTE-CURSOR.md"), "---\nstage: terminal\nstatus: complete\nterminal: true\n---\n");
    assert.match(stop().reason, /It is at "review"/);
  } finally { p.cleanup(); }
});
