// `shipyard-data infra check|apply` (4.0): the project's test setup at its best level.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const tasks = (d) => readdirSync(join(d, "spec/tasks")).filter((n) => /^T\d+.*\.md$/.test(n));
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "shipyard-data.mjs");

function project(files, { unit = "", runs = [] } = {}) {
  const base = mkdtempSync(join(tmpdir(), "infra-"));
  const repo = join(base, "repo"), d = join(base, "data");
  mkdirSync(repo, { recursive: true });
  for (const sub of ["spec/tasks", "sprints/current"]) mkdirSync(join(d, sub), { recursive: true });
  for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), c); }
  spawnSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(d, ".project-root"), repo + "\n");
  writeFileSync(join(d, "config.md"), `---\nconfig_version: 5\ntest_commands:\n  unit: "${unit}"\n  scoped: ""\n  rerun_failed: ""\nbuild_commands:\n  full: ""\n---\n`);
  if (runs.length) writeFileSync(join(d, ".shipyard-events.jsonl"), runs.map((s, i) => JSON.stringify({ ts: `2026-11-14T10:${String(i).padStart(2, "0")}:00Z`, type: "command_run", name: `suite-${i}`, exit: 0, seconds: s, command: unit })).join("\n") + "\n");
  const run = (...a) => { const r = spawnSync("node", [CLI, ...a, "--data-dir", d], { encoding: "utf8", cwd: repo, env: { ...process.env, CLAUDE_PROJECT_DIR: repo } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  return { d, repo, run, config: () => readFileSync(join(d, "config.md"), "utf8"), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("a tool that has the modes gets them set, with only flags the tool really has", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "jest" }, devDependencies: { jest: "^29" } }) }, { unit: "npm test" });
  try {
    let r = p.run("infra", "check");
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.out, /✗ After a fix, only the tests that failed run again — not set; jest has it/);
    r = p.run("infra", "apply");
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(p.config(), /rerun_failed: "?npx jest --onlyFailures"?/);
    assert.match(p.config(), /scoped: "?npx jest --changedSince=\{base\}"?/);
    assert.match(r.out, /4 of 4 in place/);
    assert.equal(p.run("infra", "check").code, 0, "nothing left to do");
    assert.equal(tasks(p.d).length, 0, "no task: the tool had everything");
  } finally { p.cleanup(); }
});

test("make without -k is fixed; a slow suite with no such mode gets ONE land-now task with a measurable end", () => {
  const p = project({ "Makefile": "all:\n\tcc x.c\ntest:\n\t./run\n" }, { unit: "make test", runs: [] });
  try {
    let r = p.run("infra", "apply");
    assert.match(p.config(), /unit: "?make -k test"?/);
    assert.match(r.out, /not measured yet/);
    assert.equal(tasks(p.d).length, 0, "not measured: nothing is filed on a guess");
    // three green runs of about five minutes
    writeFileSync(join(p.d, ".shipyard-events.jsonl"), [290, 310, 300].map((s, i) => JSON.stringify({ ts: `2026-11-14T10:0${i}:00Z`, type: "command_run", name: `w${i}`, exit: 0, seconds: s, command: "make -k test" })).join("\n") + "\n");
    r = p.run("infra", "check");
    assert.equal(r.code, 3);
    assert.match(r.out, /whole suite: about 300 s \(3 green runs measured\)/);
    r = p.run("infra", "apply");
    assert.match(r.out, /Filed T\d+ — Fast test runs: only the tests a change can affect \(land-now\)\nBuild it with: \/ship-execute --task T\d+/);
    const files = tasks(p.d);
    assert.equal(files.length, 1);
    const task = readFileSync(join(p.d, "spec/tasks", files[0]), "utf8");
    assert.match(task, /kind: chore/);
    assert.match(task, /stamp file that depends on its binary/, "the make hint");
    assert.match(task, /Right after a green whole-suite run, the affected-tests command runs no test and exits 0/);
    r = p.run("infra", "apply");
    assert.equal(tasks(p.d).length, 1, "the task is filed once");
    assert.match(r.out, /T\d+ is filed for the rest/);
    assert.equal(p.run("infra", "check").code, 0, "filed: nothing more to do until it is built");
    // closed with something still missing: not filed a second time, and the next step is a discussion
    const tf = join(p.d, "spec/tasks", tasks(p.d)[0]);
    writeFileSync(tf, readFileSync(tf, "utf8").replace(/^status: open$/m, "status: done"));
    r = p.run("infra", "apply");
    assert.equal(tasks(p.d).length, 1, "never a second auto-filed task");
    assert.match(r.out, /T\d+ is closed and something is still missing: what is left is more than a small task\. Plan it: \/ship-discuss T\d+/);
    assert.equal(p.run("infra", "check").code, 0);
  } finally { p.cleanup(); }
});

test("a tool that already skips unchanged tests needs nothing; a fast suite does not get a task", () => {
  const go = project({ "go.mod": "module x\n" }, { unit: "go test ./..." });
  try {
    const r = go.run("infra", "check");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /4 of 4 in place/);
    assert.match(r.out, /go caches the result of every package/);
  } finally { go.cleanup(); }
  const fast = project({ "Makefile": "test:\n\t./run\n" }, { unit: "make -k test", runs: [12, 14, 13] });
  try {
    const r = fast.run("infra", "apply");
    assert.equal(tasks(fast.d).length, 0);
    assert.match(r.out, /filed once the suite is measured at 60 s or more/);
  } finally { fast.cleanup(); }
});

test("the test command itself names the tool when the project's files do not", () => {
  const p = project({ "README.md": "x\n" }, { unit: "python3 -m pytest tests/ -q" });
  try {
    const r = p.run("infra", "apply");
    assert.match(p.config(), /rerun_failed: "?python3 -m pytest -q --lf"?/);
    assert.match(r.out, /\(pytest\)/);
  } finally { p.cleanup(); }
});
