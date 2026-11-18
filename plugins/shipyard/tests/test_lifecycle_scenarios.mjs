/**
 * Lifecycle scenarios (4.6): hard kill and resume, graceful pause and resume, the end of a cycle
 * leaving clean state for the next sprint, upgrade notice, and migration guards.
 * Every scenario drives the real CLI against a throwaway git repo and data dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutUserSettings } from "./lib/no-user-settings.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
const CTX = join(ROOT, "bin", "shipyard-context.mjs");

function project() {
  const root = mkdtempSync(join(tmpdir(), "life-"));
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo, { recursive: true }); mkdirSync(data, { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  g("init", "-q", "-b", "main"); writeFileSync(join(repo, "a.txt"), "a\n"); g("add", "-A"); g("commit", "-q", "-m", "init");
  const baseEnv = withoutUserSettings(root, { ...process.env, CLAUDE_PLUGIN_DATA: data });
  delete baseEnv.SHIPYARD_DATA; delete baseEnv.CLAUDE_PID; delete baseEnv.CLAUDE_CODE_SESSION_ID; delete baseEnv.CLAUDE_SESSION_ID;
  const run = (args, env = {}) => { const r = spawnSync("node", [CLI, ...args], { cwd: repo, env: { ...baseEnv, ...env }, encoding: "utf8" }); return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" }; };
  const ctx = (args, env = {}) => { const r = spawnSync("node", [CTX, ...args], { cwd: repo, env: { ...baseEnv, ...env }, encoding: "utf8" }); return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" }; };
  const init = run(["onboarding", "bootstrap"]);
  assert.equal(init.code, 0, init.err);
  const dataDir = run([]).out.trim();
  assert.ok(isAbsolute(dataDir), dataDir);
  const story = (id, status, extra = "") => writeFileSync(join(dataDir, "spec", "stories", `${id}-x.md`), `---\nid: ${id}\ntitle: "Story ${id}"\ntype: feature\nepic: E001\nstatus: ${status}\nstory_points: 3\nsteps: []\nuser_flow_probe:\n  kind: auto\n  command: "true"\n${extra}---\n\n@AC-1\n`);
  const step = (id, s, status) => writeFileSync(join(dataDir, "spec", "steps", `${id}-x.md`), `---\nid: "${id}"\ntitle: "Step ${id}"\ntype: step\nkind: feature\nstory: ${s}\nstatus: ${status}\neffort: S\ndependencies: []\ntouches: [${id}.c]\n---\n`);
  for (const sub of ["spec/stories", "spec/steps", "spec/epics", "verify"]) mkdirSync(join(dataDir, sub), { recursive: true });
  writeFileSync(join(dataDir, "spec", "epics", "E001-x.md"), "---\nid: E001\ntitle: \"Epic\"\nstatus: proposed\n---\n");
  return { root, repo, dataDir, run, ctx, g, story, step, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function sprint(p, id, stories, waves) {
  assert.equal(p.run(["init-sprint", id]).code, 0);
  assert.equal(p.run(["sprint", "set", "stories", stories.join(",")]).code, 0);
  const sp = join(p.dataDir, "sprints", "current", "SPRINT.md");
  writeFileSync(sp, readFileSync(sp, "utf8").replace(/\n## Waves[\s\S]*$/, "") + "\n## Waves\n\n" + waves.map((w, i) => `### Wave ${i + 1}\n${w.map((s) => `- ${s}`).join("\n")}\n`).join("\n"));
  assert.equal(p.run(["sprint", "check"]).code, 0);
  assert.equal(p.run(["sprint", "set", "status", "in-progress"]).code, 0);
}
function deadPid() {
  const r = spawnSync("node", ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout); // the process has exited: its pid is free
}

test("hard kill: the dead session's lock is recovered at once; a live session's lock still blocks", () => {
  const p = project();
  try {
    // session A is alive (this test process) — B is refused
    let r = p.run(["lock", "acquire", "execution", "--skill", "ship-execute"], { CLAUDE_CODE_SESSION_ID: "A", CLAUDE_PID: String(process.pid) });
    assert.equal(r.code, 0, r.err);
    r = p.run(["lock", "acquire", "execution", "--skill", "ship-execute"], { CLAUDE_CODE_SESSION_ID: "B", CLAUDE_PID: String(process.pid) });
    assert.equal(r.code, 3, "a live owner keeps its lock");
    assert.equal(p.run(["lock", "release", "execution", "--skill", "ship-execute"], { CLAUDE_CODE_SESSION_ID: "A" }).code, 0);
    // session A was killed (its pid no longer exists) — B takes over immediately, no 2-hour wait
    r = p.run(["lock", "acquire", "execution", "--skill", "ship-execute"], { CLAUDE_CODE_SESSION_ID: "A", CLAUDE_PID: String(deadPid()) });
    assert.equal(r.code, 0, r.err);
    r = p.run(["lock", "acquire", "execution", "--skill", "ship-execute"], { CLAUDE_CODE_SESSION_ID: "B", CLAUDE_PID: String(process.pid) });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out + r.err, /no longer running|recovered/);
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"stale_lock_recovered".*"owner_process_gone"/);
  } finally { p.cleanup(); }
});

test("hard kill mid-wave: the next session resumes from the cursor; the dead builder's claim is requeued", () => {
  const p = project();
  try {
    p.story("S001", "in-progress"); p.step("P001", "S001", "approved");
    sprint(p, "sprint-001", ["S001"], [["P001"]]);
    const A = { CLAUDE_CODE_SESSION_ID: "A", CLAUDE_PID: String(deadPid()) };
    for (const st of ["preflight", "salvage", "load", "readiness", "wave_1_dispatch"]) assert.equal(p.run(["cursor", "advance", "execute", st, "sprint=sprint-001"], A).code, 0, st);
    const items = join(p.root, "w1.json"); writeFileSync(items, JSON.stringify([{ id: "P001", effort: "S" }]));
    assert.equal(p.run(["queue", "enqueue", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--input", items], A).code, 0);
    assert.match(p.run(["queue", "claim", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--worker", "builder-P001", "--task", "P001", "--ttl-seconds", "1"], A).out, /"claimed":true/);
    assert.equal(p.run(["cursor", "advance", "execute", "wave_1_waiting", "sprint=sprint-001"], A).code, 0);
    // ---- the session dies here. A new session (B) starts.
    const B = { CLAUDE_CODE_SESSION_ID: "B", CLAUDE_PID: String(process.pid) };
    const state = p.ctx(["cursor-state", "execute"], B);
    assert.match(state.out, /wave_1_waiting/, state.out + state.err);
    spawnSync("node", ["-e", "setTimeout(()=>{}, 1200)"]); // let the 1 s claim deadline pass
    const rq = p.run(["queue", "requeue-stale", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch"], B);
    assert.equal(rq.code, 0, rq.err);
    const list = JSON.parse(p.run(["queue", "list", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch"], B).out);
    assert.ok(["pending", "stale"].includes(list.tasks[0].status), `the dead builder's item is claimable again or flagged stale: ${list.tasks[0].status}`);
    // the cursor accepts the new session and moves on
    assert.equal(p.run(["cursor", "advance", "execute", "wave_1_waiting", "sprint=sprint-001"], B).code, 0);
    assert.equal(p.run(["cursor", "advance", "execute", "wave_1_recovery", "sprint=sprint-001"], B).code, 0);
    // the dead builder is still on the agent ledger until someone accounts for it
    assert.equal(p.run(["agents", "check"], B).code, 3);
    assert.equal(p.run(["agents", "stopped", "builder-P001", "--reason", "dead"], B).code, 0);
    assert.equal(p.run(["agents", "check"], B).code, 0);
  } finally { p.cleanup(); }
});

test("graceful pause and resume: a paused sprint is inert until resumed, then continues from the same stage", () => {
  const p = project();
  try {
    p.story("S001", "in-progress"); p.step("P001", "S001", "approved");
    sprint(p, "sprint-001", ["S001"], [["P001"]]);
    for (const st of ["preflight", "salvage", "load", "readiness", "wave_1_dispatch"]) assert.equal(p.run(["cursor", "advance", "execute", st, "sprint=sprint-001"]).code, 0, st);
    let r = p.run(["cursor", "pause", "execute", "--note", "owner asked to stop for the day"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /CYCLE COMPLETE/);
    assert.match(p.ctx(["cursor-state", "execute"]).out, /paused/);
    r = p.run(["cursor", "noop", "execute"]); // what a /goal re-entry does on a paused sprint
    assert.equal(r.code, 0); assert.match(r.out, /awaiting user/);
    assert.match(p.ctx(["cursor-state", "execute"]).out, /wave_1_dispatch/, "pause keeps the stage");
    assert.equal(p.run(["cursor", "resume", "execute"]).code, 0);
    assert.match(p.ctx(["cursor-state", "execute"]).out, /in_progress/);
    assert.equal(p.run(["cursor", "advance", "execute", "wave_1_boundary", "sprint=sprint-001"]).code, 0);
  } finally { p.cleanup(); }
});

test("end of a cycle: archive finishes or carries over every story, rolls the epic up, and the next sprint starts clean", () => {
  const p = project();
  try {
    p.story("S001", "in-progress"); p.story("S002", "in-progress"); p.story("S003", "in-progress"); // S003: held by no sprint
    p.step("P001", "S001", "done"); p.step("P002", "S002", "needs-attention");
    sprint(p, "sprint-001", ["S001", "S002"], [["P001", "P002"]]);
    writeFileSync(join(p.dataDir, "verify", "S001-verdict.md"), "---\nfeature: S001\nrecommendation: approve\n---\n");
    assert.equal(p.run(["sprint", "set", "status", "completed"]).code, 0);
    // what a sprint leaves in git: a merged anchor, and a salvaged commit that never merged
    p.g("branch", "shipyard/keep-P001", "main");
    p.g("checkout", "-q", "-b", "shipyard/wt-agent-old"); writeFileSync(join(p.repo, "salvage.txt"), "x\n"); p.g("add", "-A"); p.g("commit", "-q", "-m", "salvage");
    const salvage = p.g("rev-parse", "HEAD"); p.g("checkout", "-q", "main");
    assert.equal(p.run(["reconcile"]).code, 3, "the orphan story and the epic are reported before the fix");
    // an idea whose fix step is done, one whose fix is not, and one with no fix named
    mkdirSync(join(p.dataDir, "spec", "ideas"), { recursive: true });
    const ideaFile = (id, extra) => writeFileSync(join(p.dataDir, "spec", "ideas", `${id}-x.md`), `---\nid: ${id}\ntitle: "x"\ntype: idea\ncreated: 2026-11-14\nstatus: captured\n${extra}---\n`);
    ideaFile("IDEA-001", "kind: defect\nseverity: medium\nfixed_by: P001\n"); ideaFile("IDEA-002", "kind: defect\nseverity: medium\nfixed_by: P002\n"); ideaFile("IDEA-003", "kind: improvement\n");
    const a = p.run(["archive-sprint", "sprint-001", "--unreviewed"]);
    assert.equal(a.code, 0, a.err);
    const ideaStatus = (id) => (readFileSync(join(p.dataDir, "spec", "ideas", `${id}-x.md`), "utf8").match(/^status:\s*(.*)$/m) || [])[1];
    assert.equal(ideaStatus("IDEA-001"), "landed", "its fix step is done: the idea is closed with the sprint");
    assert.equal(ideaStatus("IDEA-002"), "captured", "its fix step was parked: still open");
    assert.equal(ideaStatus("IDEA-003"), "captured");
    assert.match(a.err, /swept 2 Shipyard branch\(es\) — 1 already merged \(deleted\), 1 kept under refs\/shipyard\/archive\/sprint-001\//);
    assert.equal(p.g("branch", "--format=%(refname:short)"), "main", "the repository's branch list is as it was before the sprint");
    assert.equal(p.g("rev-parse", "refs/shipyard/archive/sprint-001/wt-agent-old"), salvage, "the salvaged commit is still reachable");
    const status = (id) => (readFileSync(join(p.dataDir, "spec", "stories", `${id}-x.md`), "utf8").match(/^status:\s*(.*)$/m) || [])[1];
    assert.equal(status("S001"), "done", "approved by its verdict → done");
    assert.equal(status("S002"), "approved", "not finished → carried over");
    const backlog = readFileSync(join(p.dataDir, "backlog", "BACKLOG.md"), "utf8");
    assert.match(backlog, /\|\s*S002\s*\|/);
    assert.doesNotMatch(backlog, /\|\s*S001\s*\|/);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /"sprint_story_finalized".*"S001".*"done"/);
    assert.match(events, /"sprint_story_finalized".*"S002".*"approved"/);
    assert.match(readFileSync(join(p.dataDir, "spec", "epics", "E001-x.md"), "utf8"), /^status:\s*in-progress$/m, "the epic follows its stories");
    // the archive's sweep also repaired the story no sprint held; state is consistent afterwards
    assert.equal(status("S003"), "approved");
    assert.match(readFileSync(join(p.dataDir, "backlog", "BACKLOG.md"), "utf8"), /\|\s*S003\s*\|/);
    assert.equal(p.run(["reconcile"]).code, 0);
    // the next sprint starts without --force and without leftovers
    assert.equal(readdirSync(join(p.dataDir, "sprints", "current")).length, 0);
    assert.equal(p.run(["init-sprint", "sprint-002"]).code, 0);
    assert.equal(p.run(["cursor", "advance", "execute", "preflight", "sprint=sprint-002"]).code, 0);
  } finally { p.cleanup(); }
});

test("a cursor left behind with no sprint and no running session is moved aside by reconcile --fix", () => {
  const p = project();
  try {
    mkdirSync(join(p.dataDir, "sprints", "current"), { recursive: true });
    writeFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "---\npipeline: ship-execute\nstage: single_task\nstatus: in_progress\nterminal: false\n---\n");
    const r = p.run(["reconcile", "--json"]);
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.out).findings[0].kind, "stale-cursor");
    assert.equal(p.run(["reconcile", "--fix"]).code, 0);
    assert.ok(!existsSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md")));
    assert.equal(readdirSync(join(p.dataDir, "sprints", "stale-cursors")).length, 1);
  } finally { p.cleanup(); }
});

test("upgrade: the first skill start under a new plugin version says so once and re-stamps", () => {
  const p = project();
  try {
    writeFileSync(join(p.dataDir, ".shipyard-version"), "3.26.0\n");
    let r = p.ctx(["sprint-planning"]);
    assert.match(r.out, /SHIPYARD_UPGRADED=3\.26\.0 -> \d+\.\d+\.\d+/, r.out + r.err);
    assert.match(r.out, /UPGRADING\.md/);
    r = p.ctx(["sprint-planning"]);
    assert.doesNotMatch(r.out, /SHIPYARD_UPGRADED/, "said once");
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"plugin_upgraded".*"3\.26\.0"/);
  } finally { p.cleanup(); }
});

// After 4.0.2, on a real project: a session opened under 4.0.1 was resumed after 4.0.2 had worked on the data.
// It said "Shipyard is now 4.0.1", stamped the folder back, and its older health check asked for fields 4.0.2 no
// longer needs, which the session then wrote by hand.
test("an old session is stopped at the door; it does not stamp the data folder back to its version", async () => {
  const { olderSession, newerInstalled, newerVersion, renderOnboardingLines, renderUpgradeNotice } = await import("../bin/init-data.mjs");
  const p = project();
  const cache = mkdtempSync(join(tmpdir(), "cache-"));
  try {
    for (const v of ["4.0.3", "4.0.4", "4.0.10", "notes"]) mkdirSync(join(cache, v));
    const root = join(cache, "4.0.3");
    assert.ok(newerVersion("4.0.10", "4.0.4") && !newerVersion("4.0.3", "4.0.3") && newerVersion("4.1.0", "4.0.99"));
    assert.equal(newerInstalled(root), "4.0.10");
    assert.equal(newerInstalled(join(cache, "4.0.10")), "");
    assert.equal(newerInstalled(join(cache, "notes")), "", "a development copy has no version folder: never guessed");
    writeFileSync(join(p.dataDir, ".shipyard-version"), "4.0.4\n");
    assert.deepEqual(olderSession(p.dataDir, { running: "4.0.3", root }), { running: "4.0.3", data: "4.0.4", installed: "4.0.10" });
    const lines = [];
    const status = renderOnboardingLines(p.dataDir, (l) => lines.push(l), { running: "4.0.3", root });
    assert.equal(status.required, true);
    assert.equal(status.reason, "older_session");
    const text = lines.join("\n");
    assert.match(text, /SHIPYARD_ONBOARDING_REQUIRED=true\nSHIPYARD_ONBOARDING_REASON=older_session/);
    assert.match(text, /it runs 4\.0\.3, and this project was last worked on with 4\.0\.4 \(4\.0\.10 is installed\)/);
    assert.match(text, /quit it and start a new Claude Code session[\s\S]*run no Shipyard command/);
    assert.doesNotMatch(text, /SHIPYARD_UPGRADED|SHIPYARD_ONBOARDING_COMMAND/);
    assert.equal(readFileSync(join(p.dataDir, ".shipyard-version"), "utf8"), "4.0.4\n", "not stamped back");
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"plugin_older_session"/);
    // the same version, or an older data folder, is the usual path
    assert.equal(olderSession(p.dataDir, { running: "4.0.4", root: join(cache, "4.0.4") }), null);
    assert.equal(olderSession(p.dataDir, { running: "4.0.10", root: join(cache, "4.0.10") }), null);
    // a real downgrade (nothing newer is installed): said as what it is, and stamped
    const solo = mkdtempSync(join(tmpdir(), "solo-")); mkdirSync(join(solo, "4.0.3"));
    assert.equal(olderSession(p.dataDir, { running: "4.0.3", root: join(solo, "4.0.3") }), null);
    const down = [];
    renderUpgradeNotice(p.dataDir, (l) => down.push(l), { running: "4.0.3", root: join(solo, "4.0.3") });
    assert.match(down.join("\n"), /SHIPYARD_UPGRADED=4\.0\.4 -> 4\.0\.3\n.*older than the 4\.0\.4 that last worked on this project/);
    assert.equal(readFileSync(join(p.dataDir, ".shipyard-version"), "utf8"), "4.0.3\n");
    rmSync(solo, { recursive: true, force: true });
  } finally { p.cleanup(); rmSync(cache, { recursive: true, force: true }); }
});

test("migration: refused while a sprint is in flight; after it, doctor follows aliases and accepts steps:", () => {
  const p = project();
  try {
    for (const sub of ["spec/features", "spec/tasks"]) mkdirSync(join(p.dataDir, sub), { recursive: true });
    writeFileSync(join(p.dataDir, "spec", "features", "F001-x.md"), "---\nid: F001\ntitle: \"x\"\ntype: feature\nepic: \"\"\nstatus: done\nstory_points: 1\ncomplexity: low\ntoken_estimate: 0\nrice_reach: 1\nrice_impact: 1\nrice_confidence: 1\nrice_effort: 1\nrice_score: 1\ndependencies: []\nreferences: []\ntasks: [T001]\ncreated: 2026-11-01\n---\n");
    writeFileSync(join(p.dataDir, "spec", "tasks", "T001-x.md"), "---\nid: \"T001\"\ntitle: \"x\"\ntype: task\nkind: feature\nfeature: F001\nstatus: done\neffort: S\ndependencies: []\n---\n");
    writeFileSync(join(p.dataDir, ".shipyard-events.jsonl"), JSON.stringify({ ts: "2026-11-01T00:00:00Z", type: "patch_task_created", task_id: "T001" }) + "\n");
    mkdirSync(join(p.dataDir, "sprints", "current"), { recursive: true });
    writeFileSync(join(p.dataDir, "sprints", "current", "SPRINT.md"), "---\nid: sprint-009\nstatus: in-progress\nfeatures: [F001]\n---\n\n## Waves\n\n### Wave 1\n- T001\n");
    let r = p.run(["migrate"]);
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /a sprint is in flight/);
    assert.ok(existsSync(join(p.dataDir, "spec", "tasks", "T001-x.md")), "nothing moved");
    rmSync(join(p.dataDir, "sprints", "current", "SPRINT.md"));
    r = p.run(["migrate"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(p.dataDir, "spec", "steps", "P001-x.md")));
    const d = p.run(["doctor", "--full"]);
    assert.doesNotMatch(d.out, /dangling-patch-step/, d.out);
    assert.doesNotMatch(d.out, /missing\/empty field: tasks|one of tasks\|steps/, d.out);
    assert.equal(p.run(["migrate", "--reverse"]).code, 0);
    assert.ok(existsSync(join(p.dataDir, "spec", "tasks", "T001-x.md")));
  } finally { p.cleanup(); }
});

test("releasing a story stamps its release date; a second release keeps the first date", () => {
  const p = project();
  try {
    p.story("S050", "done");
    const r = p.run(["story", "set-status", "S050", "released"]);
    assert.equal(r.code, 0, r.err);
    const f = join(p.dataDir, "spec", "stories", "S050-x.md");
    assert.match(readFileSync(f, "utf8"), /^released_at: "?\d{4}-\d{2}-\d{2}"?$/m);
    writeFileSync(f, readFileSync(f, "utf8").replace(/^released_at: .*$/m, "released_at: 2026-01-02"));
    p.run(["story", "set-status", "S050", "released", "--force"]);
    assert.match(readFileSync(f, "utf8"), /^released_at: 2026-01-02$/m);
  } finally { p.cleanup(); }
});

test("asking a verb for help never runs it: no id is used up, nothing is written", () => {
  const p = project();
  try {
    const first = p.run(["next-id", "steps"]).out.trim();
    for (const flag of ["--help", "-h"]) {
      const r = p.run(["next-id", "steps", flag]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /usage \(nothing was run\)/); assert.match(r.out, /shipyard-data next-id <kind>/);
    }
    const second = p.run(["next-id", "steps"]).out.trim();
    assert.equal(Number(second), Number(first) + 1, "the two help calls allocated nothing");
    p.story("S060", "done");
    assert.match(p.run(["story", "set-status", "S060", "released", "--help"]).out, /nothing was run/);
    assert.match(readFileSync(join(p.dataDir, "spec", "stories", "S060-x.md"), "utf8"), /^status: done$/m);
    assert.match(p.ctx(["check-dirty-tree", "--help"]).out + p.ctx(["check-dirty-tree", "--help"]).err, /Usage: shipyard-context/);
  } finally { p.cleanup(); }
});

test("patch budget grows with the sprint's stories and is counted from the event log", () => {
  const p = project();
  try {
    assert.equal(p.run(["patch-budget"]).code, 3, "no sprint: nothing to budget");
    for (const id of ["S071", "S072", "S073", "S074"]) p.story(id, "approved");
    p.step("P710", "S071", "approved");
    sprint(p, "sprint-031", ["S071", "S072", "S073", "S074"], [["P710"]]);
    let r = p.run(["patch-budget", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual((({ cap, used, left, stories }) => [cap, used, left, stories])(JSON.parse(r.out)), [8, 0, 8, 4], "4 stories x 2 beats the floor of 5");
    p.run(["events", "emit", "pipeline_tick_completed", "sprint=sprint-031", "stage=preflight"]);
    for (let i = 0; i < 8; i++) p.run(["events", "emit", "patch_step_created", `step=P80${i}`, "story=S071", "source=story-review"]);
    p.run(["events", "emit", "patch_step_created", "step=P800", "story=S071", "source=story-review"]); // the same step twice counts once
    r = p.run(["patch-budget"]);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /patch budget: 0 left \(8 used of 8; 4 stories × 2, floor 5\)/);
    // a config written before the key existed gets the default, not zero
    const cfg = join(p.dataDir, "config.md");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^\s*patch_steps_per_story:.*\n/m, ""));
    assert.doesNotMatch(readFileSync(cfg, "utf8"), /^\s*patch_steps_per_story:/m);
    assert.match(p.run(["patch-budget"]).out, /4 stories × 2, floor 5/);
  } finally { p.cleanup(); }
});

test("a review commits what it wrote: archive --via-review refuses files that became dirty during the review", () => {
  const p = project();
  try {
    writeFileSync(join(p.repo, "b.txt"), "b\n"); p.g("add", "-A"); p.g("commit", "-q", "-m", "b");
    p.story("S080", "done"); p.step("P800", "S080", "done");
    sprint(p, "sprint-041", ["S080"], [["P800"]]);
    writeFileSync(join(p.repo, "b.txt"), "the owner's own open edit\n"); // dirty before the review began
    // the review's first tick records what was already uncommitted
    assert.equal(p.run(["sprint", "set", "status", "completed"]).code, 0);
    const pre = p.run(["cursor", "advance", "review", "preflight", "--note", "start"]);
    assert.equal(pre.code, 0, pre.out + pre.err);
    assert.deepEqual(JSON.parse(readFileSync(join(p.dataDir, "sprints", "current", ".tree-baseline-ship-review.json"), "utf8")).dirty, ["b.txt"]);
    writeFileSync(join(p.dataDir, "sprints", "current", "REVIEW-CURSOR.md"), "---\npipeline: ship-review\nsprint: sprint-041\nstage: release_step_3\nstatus: in_progress\n---\n");
    writeFileSync(join(p.repo, "a.txt"), "the owner's answers, written by the review\n");
    let r = p.run(["archive-sprint", "sprint-041", "--via-review"]);
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /1 project file\(s\) changed during this review and are not committed: a\.txt\./);
    assert.ok(existsSync(join(p.dataDir, "sprints", "current", "SPRINT.md")), "a refusal changes nothing");
    assert.equal(p.run(["archive-sprint", "sprint-041", "--via-review", "--leave-changes"]).code, 2);
    p.g("add", "--", "a.txt"); p.g("commit", "-q", "-m", "docs: review decisions");
    r = p.run(["archive-sprint", "sprint-041", "--via-review"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(p.dataDir, "sprints", "sprint-041", "SPRINT.md")));
  } finally { p.cleanup(); }
});

test("approval is the behaviour-first gate: a proposed story is approved only when its scenarios follow the rules", () => {
  const p = project();
  try {
    const f = (id) => join(p.dataDir, "spec", "stories", `${id}-x.md`);
    p.story("S090", "proposed");
    let r = p.run(["story", "set-status", "S090", "approved"]);
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /cannot be approved yet — its scenarios do not start from the behaviour/);
    assert.match(readFileSync(f("S090"), "utf8"), /^status: proposed$/m);
    // unit tags with no reason and no path map: each problem is named
    writeFileSync(f("S090"), readFileSync(f("S090"), "utf8") + "\n## Acceptance Criteria\n```gherkin\n@AC-1 @unit\nScenario: one\n  Given a\n  When b\n  Then c\n```\n");
    r = p.run(["story", "set-status", "S090", "approved"]);
    assert.equal(r.code, 3);
    assert.match(r.err, /@AC-1 is @unit with no reason/); assert.match(r.err, /no `## Paths` section/);
    assert.equal(p.run(["story", "check-scenarios", "S090"]).code, 3, "the same list, as a read");
    // fixed: the journey by default and a path map
    writeFileSync(f("S090"), readFileSync(f("S090"), "utf8").replace("@AC-1 @unit", "@AC-1 @e2e") + "\n## Paths\n| Ending | Covered by |\n|---|---|\n| works | @AC-1 |\n| twice | cannot happen: the button disables |\n");
    assert.equal(p.run(["story", "check-scenarios", "S090"]).code, 0);
    r = p.run(["story", "set-status", "S090", "approved"]);
    assert.equal(r.code, 0, r.err);
    // the same check where a story enters a sprint: one approved before the rule is fixed at planning
    p.story("S094", "approved");
    r = p.run(["story", "set-status", "S094", "in-progress"]);
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /S094 cannot enter a sprint yet/);
    assert.equal(p.run(["story", "set-status", "S090", "in-progress"]).code, 0, "a story that follows the rules enters");
    // not applied to a hotfix, to a story coming back from a sprint, or when switched off
    p.story("S091", "proposed", "lane: hotfix\n");
    assert.equal(p.run(["story", "set-status", "S091", "approved"]).code, 0, "hotfix lane: minimal ceremony");
    p.story("S092", "in-progress");
    assert.equal(p.run(["story", "set-status", "S092", "approved", "--force"]).code, 0, "carried back from a sprint");
    p.story("S093", "proposed");
    const cfg = join(p.dataDir, "config.md");
    const before = readFileSync(cfg, "utf8");
    writeFileSync(cfg, /behaviour_first:/.test(before) ? before.replace(/behaviour_first:\s*true/, "behaviour_first: false") : before.replace(/\n---\n/, "\nspec:\n  behaviour_first: false\n---\n"));
    assert.equal(p.run(["story", "set-status", "S093", "approved"]).code, 0, "spec.behaviour_first: false");
  } finally { p.cleanup(); }
});

test("a plugin problem found in a review is written down locally, and the line it prints says nothing was sent (4.0)", () => {
  const p = project();
  try {
    assert.match(p.run(["plugin-issue", "list"]).out, /no Shipyard problems are written down/);
    assert.equal(p.run(["plugin-issue", "add"]).code, 2);
    let r = p.run(["plugin-issue", "add", "--title", "No stage edge from cleanup to a new wave", "--detail", "the cursor had to be forced back", "--sprint", "sprint-013"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Written down for you in .*plugin-issues\.md \(1 so far\)\. Nothing was sent\. To report it yourself: https:\/\/github\.com\/acendas\/shipyard\/issues\n$/);
    p.run(["plugin-issue", "add", "--title", "Second problem"]);
    const file = readFileSync(join(p.dataDir, "plugin-issues.md"), "utf8");
    assert.match(file, /Nothing here was sent anywhere/);
    assert.match(file, /## No stage edge from cleanup to a new wave\n\n- Found: \d{4}-\d\d-\d\d, sprint-013/);
    assert.equal((file.match(/^## /gm) || []).length, 2);
  } finally { p.cleanup(); }
});
