// Did a builder stay inside the files its step declared? (4.0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { covers, outsideTouches, reportOutsideTouches, spellings } from "../bin/step-touched.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "step-touched-"));
  const repo = join(root, "repo"), dataDir = join(root, "data");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(dataDir, "sprints", "current"), { recursive: true });
  mkdirSync(join(dataDir, "spec", "steps"), { recursive: true });
  const git = (...a) => { const r = spawnSync("git", a, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  writeFileSync(join(repo, "src", "a.c"), "a\n"); writeFileSync(join(repo, "src", "b.c"), "b\n"); writeFileSync(join(repo, "notes.md"), "n\n");
  git("add", "-A"); git("commit", "-q", "-m", "base");
  writeFileSync(join(dataDir, "sprints", "current", "SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\n---\n\n## Waves\n\n### Wave 1\nTasks: [P001, P002]\n\n### Wave 2\nTasks: [P003]\n");
  const step = (id, touches) => writeFileSync(join(dataDir, "spec", "steps", `${id}-x.md`), `---\nid: ${id}\nstory: S001\nkind: feature\neffort: S\n${touches === null ? "" : `touches: [${touches.join(", ")}]\n`}---\n`);
  step("P001", ["src/a.c"]); step("P002", ["src/b.c#draw", "tests/"]); step("P003", null);
  const commit = (files, msg) => { for (const [f, c] of Object.entries(files)) { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), c); } git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
  return { root, repo, dataDir, git, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a touches entry covers a file, a folder, a glob and a named part of a file", () => {
  assert.equal(covers("src/a.c", "src/a.c"), true);
  assert.equal(covers("src/a.c#render", "src/a.c"), true);
  assert.equal(covers("tests/", "tests/unit/test_a.c"), true);
  assert.equal(covers("src/*.c", "src/b.c"), true);
  assert.equal(covers("src/a.c", "src/b.c"), false);
});

test("a builder that kept to its list reports nothing; one that left it is named, with the same-wave collision", () => {
  const f = fixture();
  try {
    const base = f.git("rev-parse", "HEAD");
    const inside = f.commit({ "src/a.c": "a2\n" }, "P001 inside");
    let r = outsideTouches(f.dataDir, "P001", inside, { cwd: f.repo, base });
    assert.deepEqual(r.outside, []);
    assert.equal(reportOutsideTouches(f.dataDir, "P001", inside, { cwd: f.repo, base }), null);
    assert.equal(existsSync(join(f.dataDir, ".shipyard-events.jsonl")), false, "nothing to record");

    const outside = f.commit({ "src/a.c": "a3\n", "src/b.c": "b2\n", "notes.md": "n2\n" }, "P001 outside");
    r = outsideTouches(f.dataDir, "P001", outside, { cwd: f.repo, base: inside });
    assert.deepEqual(r.outside.sort(), ["notes.md", "src/b.c"]);
    assert.deepEqual(r.collisions, [{ file: "src/b.c", step: "P002" }], "only the file another step of the same wave declared");
    reportOutsideTouches(f.dataDir, "P001", outside, { cwd: f.repo, base: inside, sprint: "sprint-001" });
    const events = readFileSync(join(f.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /"type":"step_outside_touches"[^\n]*"step":"P001"[^\n]*"count":2/);
    assert.match(events, /"collides":"src\/b\.c \(P002\)"/);
  } finally { f.cleanup(); }
});

test("a step with no touches list is not measured, and the base is found without being told", () => {
  const f = fixture();
  try {
    const sha = f.commit({ "notes.md": "x\n" }, "P003");
    assert.equal(outsideTouches(f.dataDir, "P003", sha, { cwd: f.repo }), null);
    // built in place: the parent commit is where P002's own work starts
    const p2 = f.commit({ "tests/t.c": "t\n", "src/a.c": "zz\n" }, "P002");
    const r = outsideTouches(f.dataDir, "P002", p2, { cwd: f.repo });
    assert.deepEqual(r.outside, ["src/a.c"]);
    assert.deepEqual(r.collisions, [{ file: "src/a.c", step: "P001" }]);
    // on a builder branch that is not merged yet: everything since the fork
    f.git("checkout", "-q", "-b", "shipyard/wt-P001");
    f.commit({ "src/a.c": "q\n" }, "one");
    const tip = f.commit({ "notes.md": "q\n" }, "two");
    f.git("checkout", "-q", "main");
    assert.deepEqual(outsideTouches(f.dataDir, "P001", tip, { cwd: f.repo }).outside, ["notes.md"]);
  } finally { f.cleanup(); }
});

test("a project that lives in a folder of a larger repository: declared files are not reported (seen live)", () => {
  assert.deepEqual(spellings("game/src/a.c", "game/"), ["game/src/a.c", "src/a.c"]);
  const f = fixture();
  try {
    // move the project one folder down: the plan still says src/a.c
    f.git("mv", "src", "game-src"); f.git("commit", "-q", "-m", "move");
    const base = f.git("rev-parse", "HEAD");
    const sha = f.commit({ "game/src/a.c": "x\n", "game/src/b.c": "y\n", "game/extra.md": "z\n" }, "P001 in a subfolder");
    const r = outsideTouches(f.dataDir, "P001", sha, { cwd: f.repo, base });
    assert.deepEqual(r.outside.sort(), ["game/extra.md", "game/src/b.c"], "src/a.c is declared; the other two are not");
    assert.deepEqual(r.collisions, [{ file: "game/src/b.c", step: "P002" }]);
  } finally { f.cleanup(); }
});

test("after a wave is merged, a step is not blamed for its siblings' files (seen live: 43 files of four other steps)", () => {
  const f = fixture();
  try {
    const ev = (o) => JSON.stringify({ ts: new Date().toISOString(), ...o });
    // P002 lands first, then P001 on top of it (the merged order of one wave)
    const p2 = f.commit({ "src/b.c": "b2\n", "tests/t.c": "t\n" }, "P002");
    const p1 = f.commit({ "src/a.c": "a2\n" }, "P001");
    writeFileSync(join(f.dataDir, ".shipyard-events.jsonl"), [ev({ type: "task_commit_anchored", task: "P002", sha: p2 }), ev({ type: "task_commit_anchored", task: "P001", sha: p1 })].join("\n") + "\n");
    const r = outsideTouches(f.dataDir, "P001", p1, { cwd: f.repo });
    assert.equal(r.changed, 1, "only its own commit");
    assert.deepEqual(r.outside, []);
    assert.deepEqual(outsideTouches(f.dataDir, "P002", p2, { cwd: f.repo }).outside, []);
  } finally { f.cleanup(); }
});
