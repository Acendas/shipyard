/** E004: risk profile (lazy, fail-safe floors), risk score (MAX, git-read, logged), drift. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globToRe, matchFloors, maxLevel, scoreRisk, storyOwnFiles, GATE, FLOORS } from "../bin/risk.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "risk-"));
  const d = join(base, "projects", "abc123abc123");
  for (const sub of ["templates", "sprints/current"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\nstories: [S001]\n---\n");
  return { base, d };
}
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
function repo(base) {
  const r = join(base, "repo");
  mkdirSync(join(r, "src", "auth"), { recursive: true });
  mkdirSync(join(r, "src", "ui"), { recursive: true });
  mkdirSync(join(r, "tests"), { recursive: true });
  git(r, "init", "-q");
  writeFileSync(join(r, "README.md"), "x\n");
  git(r, "add", "-A"); git(r, "commit", "-q", "-m", "init");
  const b = git(r, "rev-parse", "HEAD");
  writeFileSync(join(r, "src", "ui", "button.js"), "export const b = 1; // AC-1\n");
  git(r, "add", "-A"); git(r, "commit", "-q", "-m", "small ui");
  const small = git(r, "rev-parse", "HEAD");
  writeFileSync(join(r, "src", "auth", "login.js"), "export const login = () => 1;\n");
  writeFileSync(join(r, "package.json"), '{"name":"x","dependencies":{"left-pad":"1"}}\n');
  git(r, "add", "-A"); git(r, "commit", "-q", "-m", "auth + deps, no tests");
  const risky = git(r, "rev-parse", "HEAD");
  return { r, b, small, risky };
}
const run = (d, ...args) => spawnSync("node", [CLI, "risk", ...args, "--data-dir", d], { encoding: "utf8" });
const events = (d) => readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("globToRe and floors: dir prefixes match below, ** crosses dirs, floors name auth/secrets/migrations/payments/deploy/dependencies", () => {
  assert.ok(globToRe("src/payments").test("src/payments/charge.js"));
  assert.ok(globToRe("src/**/charge*.js").test("src/a/b/charge-x.js"));
  assert.ok(!globToRe("src/payments").test("src/pay/x.js"));
  const f = matchFloors(["src/auth/login.js", ".env.local", "db/migrations/001.sql", "lib/billing/invoice.rb", ".github/workflows/ci.yml", "package.json", "src/ui/button.js"]);
  assert.deepEqual(f.map((x) => x.floor), ["auth", "secrets", "migrations", "payments", "deploy", "dependencies"]);
  assert.equal(maxLevel("low", "medium", "critical", "high"), "critical");
  assert.equal(GATE.critical.human_gate, true);
  assert.equal(FLOORS.length, 6);
});

test("profile is lazy and fail-safe: missing → floors apply; add-harm creates H001 with the closed severity map; score is MAX over signals and logs", () => {
  const { base, d } = fixture();
  try {
    let r = run(d, "profile", "status", "--json");
    assert.equal(JSON.parse(r.stdout).status, "missing");
    const { r: cwd, b, small, risky } = repo(base);

    r = run(d, "score", "--base", b, "--head", small, "--story", "S001", "--repo", cwd, "--json");
    assert.equal(r.status, 0, r.stderr);
    let j = JSON.parse(r.stdout);
    assert.equal(j.level, "low", JSON.stringify(j.reasons));
    assert.equal(j.review_level, "low");
    assert.equal(j.human_gate, false);
    assert.match(j.profile, /missing/);

    r = run(d, "score", "--base", small, "--head", risky, "--story", "S001", "--repo", cwd, "--json");
    j = JSON.parse(r.stdout);
    assert.equal(j.level, "high", "auth floor wins by MAX even on a tiny diff");
    assert.ok(j.reasons.some((x) => x.signal === "floor:auth" && x.level === "high"));
    assert.ok(j.reasons.some((x) => x.signal === "floor:dependencies" && x.level === "medium"));
    assert.ok(!j.reasons.some((x) => x.signal === "no_tests_touched"), "a 2-line change is not flagged for missing tests");
    assert.ok(j.reasons.some((x) => x.signal === "no_ac_markers"), "a story diff without AC markers is flagged");

    r = run(d, "profile", "add-harm", "--name", "a user is charged twice", "--severity", "critical", "--paths", "src/payments,src/auth/**", "--check", "idempotency key test", "--check", "refund reconciliation");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^H001: a user is charged twice \(critical, human gate\)/);
    assert.ok(existsSync(join(d, "risk-profile.json")));
    r = run(d, "profile", "add-harm", "--name", "x", "--severity", "loud");
    assert.equal(r.status, 2);

    r = run(d, "score", "--base", small, "--head", risky, "--story", "S001", "--repo", cwd, "--json");
    j = JSON.parse(r.stdout);
    assert.equal(j.level, "critical");
    assert.equal(j.review_level, "high");
    assert.equal(j.human_gate, true);
    assert.deepEqual(j.harms, ["H001"]);
    assert.deepEqual(j.required_checks, ["idempotency key test", "refund reconciliation"]);

    // planning-time score from paths only
    r = run(d, "score", "--paths", "src/ui/button.js,docs/x.md", "--json");
    j = JSON.parse(r.stdout);
    assert.equal(j.level, "low");
    assert.ok(j.reasons.some((x) => x.signal === "paths_only"));

    const scored = events(d).filter((e) => e.type === "risk_scored");
    assert.equal(scored.length, 4);
    assert.equal(scored[2].level, "critical");
    assert.equal(scored[2].sprint, "sprint-001");
    assert.equal(scored[2].story, "S001");

    r = run(d, "profile", "remove-harm", "H001");
    assert.equal(r.status, 0);
    r = run(d, "profile", "remove-harm", "H009");
    assert.equal(r.status, 3);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("--cap: the per-sprint ceiling on critical reviews refuses (exit 3) once reached, still reporting the level", () => {
  const { base, d } = fixture();
  try {
    writeFileSync(join(d, "config.md"), "---\nrisk:\n  max_critical_per_sprint: 1\n---\n");
    const { r: cwd, small, risky } = repo(base);
    run(d, "profile", "add-harm", "--name", "h", "--severity", "critical", "--paths", "src/auth");
    let r = run(d, "score", "--base", small, "--head", risky, "--repo", cwd, "--story", "S001", "--cap", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).cap.exceeded, false);
    r = run(d, "score", "--base", small, "--head", risky, "--repo", cwd, "--story", "S001", "--cap", "--json");
    assert.equal(r.status, 0, "re-scoring the SAME story never consumes the cap");
    r = run(d, "score", "--base", small, "--head", risky, "--repo", cwd, "--story", "S002", "--cap", "--json");
    assert.equal(r.status, 3, "a second DISTINCT critical story hits cap=1");
    const j = JSON.parse(r.stdout);
    assert.equal(j.level, "critical");
    assert.equal(j.cap.exceeded, true);
    assert.match(r.stderr, /cap 1/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("drift: risky-looking files with no harm area are listed; covered ones are not", () => {
  const { base, d } = fixture();
  try {
    const { r: cwd, small, risky } = repo(base);
    let r = run(d, "drift", "--base", small, "--head", risky, "--repo", cwd, "--json");
    assert.equal(r.status, 0, r.stderr);
    let j = JSON.parse(r.stdout);
    assert.deepEqual(j.unmapped.map((u) => u.floor).sort(), ["auth", "dependencies"]);
    run(d, "profile", "add-harm", "--name", "account takeover", "--severity", "high", "--paths", "src/auth");
    r = run(d, "drift", "--base", small, "--head", risky, "--repo", cwd, "--json");
    j = JSON.parse(r.stdout);
    assert.deepEqual(j.unmapped.map((u) => u.floor), ["dependencies"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("scoreRisk is pure over its inputs when given paths (no git needed)", () => {
  const { base, d } = fixture();
  try {
    const r = scoreRisk(d, { paths: ["db/migrations/2.sql"] });
    assert.equal(r.level, "high");
    assert.equal(r.review_level, "high");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a story is scored on the files its own steps changed, not on its siblings' (4.17.2)", () => {
  const { base, d } = fixture();
  try {
    const r = join(base, "repo2");
    for (const sub of ["docs", "src/auth", "tools"]) mkdirSync(join(r, sub), { recursive: true });
    git(r, "init", "-q");
    writeFileSync(join(r, "README.md"), "x\n");
    git(r, "add", "-A"); git(r, "commit", "-q", "-m", "init");
    const b = git(r, "rev-parse", "HEAD");
    const commit = (file, text, msg) => { writeFileSync(join(r, file), text); git(r, "add", "-A"); git(r, "commit", "-q", "-m", msg); return git(r, "rev-parse", "HEAD"); };
    const a1 = commit("docs/audit.md", "one\ntwo\nthree\n", "P001 audit");
    const a2 = commit("src/auth/login.js", "export const login = () => 1;\n", "P002 login");
    writeFileSync(join(r, "tools", "gen.py"), Array.from({ length: 30 }, (_, i) => `x${i} = ${i}`).join("\n") + "\n");
    const a3 = commit("tools/test_gen.py", "def test_gen():\n    assert True  # AC-1\n", "P003 generator");
    mkdirSync(join(d, "spec", "steps"), { recursive: true });
    for (const [id, story] of [["P001", "S001"], ["P002", "S002"], ["P003", "S003"]]) writeFileSync(join(d, "spec", "steps", `${id}-x.md`), `---\nid: ${id}\nstory: ${story}\nstatus: done\n---\n`);
    const emit = (...kv) => spawnSync("node", [CLI, "events", "emit", "task_commit_anchored", ...kv, "--data-dir", d], { encoding: "utf8" });
    emit("task=P001", `sha=${a1}`); emit("task=P002", `sha=${a2}`); emit("task=P003", `sha=${a3}`);
    const score = (story) => JSON.parse(run(d, "score", "--base", b, "--head", a3, "--story", story, "--repo", r, "--json").stdout);

    let j = score("S001");
    assert.deepEqual([j.scope, j.files, j.level], ["story", 1, "low"], "a three-line document is not made risky by a sibling's auth change: " + JSON.stringify(j.reasons));
    j = score("S002");
    assert.equal(j.scope, "story");
    assert.equal(j.files, 1);
    assert.ok(j.reasons.some((x) => x.signal === "floor:auth"), "its own auth change still counts");
    j = score("S003");
    assert.equal(j.files, 2);
    assert.ok(!j.reasons.some((x) => x.signal === "no_tests_touched"), "test_gen.py is a test file: " + JSON.stringify(j.reasons));
    assert.ok(!j.reasons.some((x) => x.signal === "floor:auth"));

    j = score("S009");
    assert.deepEqual([j.scope, j.files], ["range", 4], "a story with no anchored step is scored on the whole range, as before");
    assert.equal(j.level, "high");
    const plain = run(d, "score", "--base", b, "--head", a3, "--story", "S001", "--repo", r).stdout;
    assert.match(plain, /1 files changed by S001's own steps/);
    assert.equal(events(d).filter((e) => e.type === "risk_scored").at(-1).scope, "story");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a story's later fix step adds to its own slice; a merged history is still attributed", () => {
  const { base, d } = fixture();
  try {
    const r = join(base, "repo3");
    mkdirSync(join(r, "src"), { recursive: true });
    git(r, "init", "-q", "-b", "main");
    writeFileSync(join(r, "README.md"), "x\n");
    git(r, "add", "-A"); git(r, "commit", "-q", "-m", "init");
    const b = git(r, "rev-parse", "HEAD");
    const commit = (file, text, msg) => { mkdirSync(join(r, "src"), { recursive: true }); writeFileSync(join(r, file), text); git(r, "add", "-A"); git(r, "commit", "-q", "-m", msg); return git(r, "rev-parse", "HEAD"); };
    // two builders on their own branches, merged with merge commits
    git(r, "checkout", "-q", "-b", "wt-1"); const a1 = commit("src/one.js", "export const one = 1;\n", "P001");
    git(r, "checkout", "-q", "main"); git(r, "checkout", "-q", "-b", "wt-2"); const a2 = commit("src/two.js", "export const two = 2;\n", "P002");
    git(r, "checkout", "-q", "main"); git(r, "merge", "-q", "--no-ff", "-m", "merge 1", "wt-1"); git(r, "merge", "-q", "--no-ff", "-m", "merge 2", "wt-2");
    const a3 = commit("src/one_fix.js", "export const fix = 1;\n", "P003 fix for S001");
    mkdirSync(join(d, "spec", "steps"), { recursive: true });
    for (const [id, story] of [["P001", "S001"], ["P002", "S002"], ["P003", "S001"]]) writeFileSync(join(d, "spec", "steps", `${id}-x.md`), `---\nid: ${id}\nstory: ${story}\nstatus: done\n---\n`);
    for (const [id, sha] of [["P001", a1], ["P002", a2], ["P003", a3]]) spawnSync("node", [CLI, "events", "emit", "task_commit_anchored", `task=${id}`, `sha=${sha}`, "--data-dir", d], { encoding: "utf8" });
    const s1 = storyOwnFiles(d, "S001", { base: b, head: "HEAD", cwd: r });
    assert.deepEqual(s1.sort(), ["src/one.js", "src/one_fix.js"]);
    assert.deepEqual(storyOwnFiles(d, "S002", { base: b, head: "HEAD", cwd: r }), ["src/two.js"]);
    assert.equal(storyOwnFiles(d, "S001", { base: "HEAD", head: "HEAD", cwd: r }), null, "nothing newer than the base: fall back to the range");
    assert.equal(storyOwnFiles(d, null, { base: b, head: "HEAD", cwd: r }), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
