// A sprint drafted ahead and commands running side by side (4.17).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
const CTX = join(ROOT, "bin", "shipyard-context.mjs");
const BODY = "\n## Paths\n| Ending | Covered by |\n|---|---|\n| works | @AC-1 |\n\n## Acceptance Criteria\n```gherkin\n@AC-1 @e2e\nScenario: works\n  Given a\n  When b\n  Then c\n```\n";

function project() {
  const root = mkdtempSync(join(tmpdir(), "ahead-"));
  const repo = join(root, "repo"), data = join(root, "data");
  mkdirSync(repo, { recursive: true }); mkdirSync(data, { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q", "-b", "main"); writeFileSync(join(repo, "a.txt"), "a\n"); g("add", "-A"); g("commit", "-q", "-m", "init");
  const baseEnv = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  delete baseEnv.SHIPYARD_DATA; delete baseEnv.CLAUDE_PID; delete baseEnv.CLAUDE_CODE_SESSION_ID; delete baseEnv.CLAUDE_SESSION_ID;
  const as = (bin) => (args, session) => { const r = spawnSync("node", [bin, ...args], { cwd: repo, env: { ...baseEnv, ...(session ? { CLAUDE_CODE_SESSION_ID: session } : {}) }, encoding: "utf8" }); return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" }; };
  const run = as(CLI), ctx = as(CTX);
  assert.equal(run(["onboarding", "bootstrap"]).code, 0);
  const dataDir = run([]).out.trim();
  for (const d of ["spec/stories", "spec/steps", "sprints/current"]) mkdirSync(join(dataDir, d), { recursive: true });
  const story = (id, status) => writeFileSync(join(dataDir, "spec", "stories", `${id}-x.md`), `---\nid: ${id}\ntitle: "Story ${id}"\ntype: feature\nstatus: ${status}\nstory_points: 2\n---\n${BODY}`);
  // the drafted sprint's one step (4.19: a wave may only list steps that exist)
  writeFileSync(join(dataDir, "spec", "steps", "P900-x.md"), `---\nid: "P900"\ntype: step\nkind: feature\nstory: S002\nstatus: approved\neffort: S\ndependencies: []\ntouches: [src/a.c]\n---\n`);
  return { root, repo, dataDir, run, ctx, g, story, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const draft = (id, stories, status = "draft") => `---\nid: ${id}\nstatus: ${status}\nstories: [${stories.join(", ")}]\n---\n\n## Waves\n\n### Wave 1\n- P900\n`;

test("while a sprint runs, the planner is sent to sprints/next/; the plan is queued, then promoted when current/ is free", () => {
  const p = project();
  try {
    let i = JSON.parse(p.run(["sprint", "plan-dir", "--json"]).out);
    assert.equal(i.mode, "now"); assert.match(i.dir, /sprints\/current$/); assert.equal(i.id, "sprint-001");
    // sprint-001 is running
    p.story("S001", "in-progress"); p.story("S002", "approved");
    writeFileSync(join(p.dataDir, "sprints", "current", "SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\nstories: [S001]\n---\n\n## Waves\n\n### Wave 1\n- P001\n");
    i = JSON.parse(p.run(["sprint", "plan-dir", "--json"]).out);
    assert.deepEqual([i.mode, i.id, i.active.id], ["draft-ahead", "sprint-002", "sprint-001"]);
    assert.match(i.dir, /sprints\/next$/);
    // nothing to queue yet, then a draft with a story that is in the running sprint is refused
    assert.equal(p.run(["sprint", "queue-next"]).code, 3);
    mkdirSync(join(p.dataDir, "sprints", "next"), { recursive: true });
    writeFileSync(join(p.dataDir, "sprints", "next", "SPRINT-DRAFT.md"), draft("sprint-002", ["S001"]));
    let r = p.run(["sprint", "queue-next"]);
    assert.equal(r.code, 3); assert.match(r.err, /S001 is "in-progress", expected approved/);
    writeFileSync(join(p.dataDir, "sprints", "next", "SPRINT-DRAFT.md"), draft("sprint-002", ["S002"]));
    assert.equal(p.run(["sprint", "check", "--next"]).code, 0);
    r = p.run(["sprint", "queue-next"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /sprint-002 is approved and waiting behind sprint-001/);
    assert.match(readFileSync(join(p.dataDir, "sprints", "next", "SPRINT-DRAFT.md"), "utf8"), /^status: ready$/m);
    assert.match(readFileSync(join(p.dataDir, "spec", "stories", "S002-x.md"), "utf8"), /^status: approved$/m, "nothing changed status");
    assert.match(readFileSync(join(p.dataDir, "sprints", "current", "SPRINT.md"), "utf8"), /id: sprint-001/, "the running sprint is untouched");
    // cannot be promoted while sprint-001 owns current/
    r = p.run(["sprint", "promote-next"]);
    assert.equal(r.code, 3); assert.match(r.err, /sprint-001 \(in-progress\) still owns sprints\/current/);
    // sprint-001 is archived: current/ is free
    rmSync(join(p.dataDir, "sprints", "current", "SPRINT.md"));
    mkdirSync(join(p.dataDir, "sprints", "sprint-001"), { recursive: true });
    i = JSON.parse(p.run(["sprint", "plan-dir", "--json"]).out);
    assert.deepEqual([i.mode, i.promotable, i.id], ["now", true, "sprint-002"]);
    r = p.run(["sprint", "promote-next"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(p.dataDir, "sprints", "current", "SPRINT-DRAFT.md")));
    assert.ok(!existsSync(join(p.dataDir, "sprints", "next", "SPRINT-DRAFT.md")));
    const ev = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(ev, /"next_sprint_queued"/); assert.match(ev, /"next_sprint_promoted"/);
  } finally { p.cleanup(); }
});

test("each command is told what runs beside it: a planner gets its directory, a discussion gets the stories it must leave alone", () => {
  const p = project();
  try {
    p.story("S001", "in-progress"); p.story("S002", "approved");
    writeFileSync(join(p.dataDir, "sprints", "current", "SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\nstories: [S001]\n---\n\n## Waves\n\n### Wave 1\n- P001\n");
    mkdirSync(join(p.dataDir, "sprints", "next"), { recursive: true });
    writeFileSync(join(p.dataDir, "sprints", "next", "SPRINT-DRAFT.md"), draft("sprint-002", ["S002"], "ready"));
    assert.match(p.ctx(["sprint-execution"], "EXEC").out, /SHIPYARD_LOCK_ACQUIRED=true/);
    const plan = p.ctx(["sprint-planning"], "PLAN").out;
    assert.match(plan, /SHIPYARD_LOCK_ACQUIRED=true/, "planning is not blocked by the running sprint");
    assert.match(plan, /SHIPYARD_RUNNING_BESIDE=ship-execute/);
    assert.match(plan, /SHIPYARD_SPRINT_PLAN_MODE=draft-ahead/);
    assert.match(plan, /SHIPYARD_SPRINT_PLAN_DIR=.*sprints\/next/);
    assert.match(plan, /SHIPYARD_NEXT_SPRINT_DRAFT=sprint-002 \(ready; stories S002\)/);
    const disc = p.ctx(["discuss-context"], "DISC").out;
    assert.match(disc, /SHIPYARD_LOCK_ACQUIRED=true/, "a discussion is not blocked by planning or by the sprint");
    assert.match(disc, /SHIPYARD_RUNNING_BESIDE=.*ship-execute/); assert.match(disc, /SHIPYARD_RUNNING_BESIDE=.*ship-sprint/);
    assert.match(disc, /SHIPYARD_READONLY_STORIES=S001,S002/);
    // the same command twice is still refused
    assert.match(p.ctx(["discuss-context"], "DISC2").out, /SHIPYARD_LOCK_ACQUIRED=false/);
    assert.match(p.ctx(["sprint-planning"], "PLAN2").out, /SHIPYARD_LOCK_ACQUIRED=false/);
    // the running sprint is read-only to the planner's session, not to its own
    let r = p.run(["sprint", "set", "status", "cancelled"], "PLAN");
    assert.equal(r.code, 3); assert.match(r.err, /being run by ship-execute in another session/);
    assert.equal(p.run(["sprint", "set", "current_wave", "2"], "EXEC").code === 3, false, "the executor's own session is never locked out");
  } finally { p.cleanup(); }
});

test("with another command working in the checkout, nothing is set aside and the planner's release does not blame it for files it may not own", () => {
  const p = project();
  try {
    assert.match(p.ctx(["sprint-execution"], "EXEC").out, /SHIPYARD_LOCK_ACQUIRED=true/);
    assert.match(p.ctx(["sprint-planning"], "PLAN").out, /SHIPYARD_LOCK_ACQUIRED=true/);
    writeFileSync(join(p.repo, "a.txt"), "an in-place builder is halfway through this file\n");
    let r = p.run(["stray", "set-aside", "--reason", "looks stray"], "PLAN");
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /ship-execute is running on this project in another session/);
    assert.equal(readFileSync(join(p.repo, "a.txt"), "utf8"), "an in-place builder is halfway through this file\n", "untouched");
    r = p.run(["lock", "release", "planning", "--skill", "ship-sprint"], "PLAN");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /ship-execute is running here too, so they may be its work/);
  } finally { p.cleanup(); }
});

test("a discussion beside a running sprint must commit the decision document the hook saw it write; other dirty files are still not blamed on it", () => {
  const p = project();
  try {
    mkdirSync(join(p.repo, "docs"), { recursive: true });
    writeFileSync(join(p.repo, "docs", "decisions.md"), "one\n"); p.g("add", "-A"); p.g("commit", "-q", "-m", "docs");
    assert.match(p.ctx(["sprint-execution"], "EXEC").out, /SHIPYARD_LOCK_ACQUIRED=true/);
    assert.match(p.ctx(["discuss-context"], "DISC").out, /SHIPYARD_LOCK_ACQUIRED=true/);
    // the sprint's own in-place work, and the discussion's decision record
    writeFileSync(join(p.repo, "a.txt"), "a builder is halfway through this file\n");
    writeFileSync(join(p.repo, "docs", "decisions.md"), "one\ntwo: decided today\n");
    p.run(["events", "emit", "discuss_wrote_project_file", `file=${join(p.repo, "docs", "decisions.md")}`, "session=DISC"]);
    let r = p.run(["lock", "release", "discuss", "--skill", "ship-discuss"], "DISC");
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /this discussion wrote docs\/decisions\.md and it is not committed/);
    assert.match(r.err, /git add -- docs\/decisions\.md/);
    assert.doesNotMatch(r.err, /a\.txt/, "the sprint's file is not this discussion's to commit");
    // 4.0: a reason does not get past it. A live discussion released with "a commit is made only
    // on request" and the sprint beside it could not record its test proof on the changed tree.
    r = p.run(["lock", "release", "discuss", "--skill", "ship-discuss", "--leave-changes", "commits are made only on request"], "DISC");
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /--leave-changes is not accepted for a file this discussion wrote while another command runs here/);
    p.g("add", "--", "docs/decisions.md"); p.g("commit", "-q", "-m", "docs: decided today");
    r = p.run(["lock", "release", "discuss", "--skill", "ship-discuss"], "DISC");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /ship-execute is running here too, so they may be its work/);
  } finally { p.cleanup(); }
});
