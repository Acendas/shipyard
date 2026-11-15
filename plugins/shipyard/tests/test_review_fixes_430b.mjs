/** Regression pins for the second 4.3.0 code-review pass (churn on a no-source diff, archived dispatch attempts, wave-unit ids, one isStoryId, CRLF design blocks, one sprint-list rule). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { technicalSignals } from "../bin/risk.mjs";
import { isStoryId, WAVE_UNIT_ID_RE } from "../bin/vocab.mjs";
import { readDesign, checkStory } from "../bin/design.mjs";
import { sprintStoryIds, currentSprintId, parseWaves } from "../bin/terminal-gate.mjs";
import { computeStoryReviewStatus } from "../bin/story-review.mjs";
import { parseFlags } from "../bin/cli-flags.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

function dataDir(base) {
  const d = join(base, "projects", "abc123abc123");
  for (const sub of ["templates", "spec/stories", "spec/steps", "spec/tasks", "spec/bugs", "sprints/current", "events-archive"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  return d;
}
const cli = (d, ...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8" });

test("risk: a docs-only diff runs no churn/diff git call with an empty pathspec — churn is 0, not every commit in the repo", () => {
  const base = mkdtempSync(join(tmpdir(), "rf-"));
  try {
    const r = join(base, "repo");
    mkdirSync(join(r, "src"), { recursive: true });
    git(r, "init", "-q");
    // 25 source commits in the last 30 days: an "active repo"
    for (let i = 0; i < 25; i++) { writeFileSync(join(r, "src", "a.js"), `export const a = ${i};\n`); git(r, "add", "-A"); git(r, "commit", "-q", "-m", `c${i}`); }
    const b = git(r, "rev-parse", "HEAD");
    writeFileSync(join(r, "NOTES.md"), "docs only\n"); git(r, "add", "-A"); git(r, "commit", "-q", "-m", "docs");
    const h = git(r, "rev-parse", "HEAD");
    const t = technicalSignals({ base: b, head: h, cwd: r });
    assert.equal(t.source.length, 0);
    assert.equal(t.churn, 0, "no source file → no churn signal");
    assert.ok(!t.signals.some((s) => s.signal === "churn"), JSON.stringify(t.signals));
    // and a real source change in the same repo still measures churn
    writeFileSync(join(r, "src", "a.js"), "export const a = 99;\n"); git(r, "add", "-A"); git(r, "commit", "-q", "-m", "src");
    const t2 = technicalSignals({ base: h, head: git(r, "rev-parse", "HEAD"), cwd: r });
    assert.ok(t2.churn >= 20, `churn measured for src/a.js: ${t2.churn}`);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("resolve-model: dispatch_attempt events rotated into events-archive/ still count toward the ladder", () => {
  const base = mkdtempSync(join(tmpdir(), "rf-"));
  try {
    const d = dataDir(base);
    writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-003\nstatus: in-progress\nstories: [S001]\n---\n");
    writeFileSync(join(d, "config.md"), "---\nmodels:\n  think: opus\n  build: sonnet\n---\n");
    const ev = (o) => JSON.stringify({ ts: "2026-11-11T10:00:00+00:00", type: "dispatch_attempt", subject: "P007", sprint: "sprint-003", ...o });
    writeFileSync(join(d, "events-archive", "events-2026-11-11.jsonl"), ev({ attempt: 1 }) + "\n" + ev({ attempt: 2 }) + "\n");
    writeFileSync(join(d, ".shipyard-events.jsonl"), "");
    const r = cli(d, "resolve-model", "build", "--subject", "P007");
    assert.match(r.stdout, /attempt=2/, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /attempt=0/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("wave-unit ids: verify findings --tasks, parseWaves and story-review stepOwners all accept the same shapes (P###, T###, T-P###, T-HOT1)", () => {
  for (const id of ["P001", "T012", "T-P003", "T-HOT1"]) assert.ok(WAVE_UNIT_ID_RE.test(id), id);
  for (const id of ["PR12", "Part2", "S001", "task1", "T"]) assert.ok(!WAVE_UNIT_ID_RE.test(id), id);
  const base = mkdtempSync(join(tmpdir(), "rf-"));
  try {
    const d = dataDir(base);
    writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\nstories: [S001]\n---\n\n## Waves\n\n### Wave 2\nTasks: [T012, T-P003]\n");
    let r = cli(d, "verify", "findings", "--wave", "2", "--tasks", "T012,T-P003", "--met", "2");
    assert.equal(r.status, 0, r.stderr);
    r = cli(d, "verify", "findings", "--wave", "2", "--tasks", "PR12", "--met", "1");
    assert.notEqual(r.status, 0, "PR12 is not a wave unit");
    // a story whose remaining step is a patch task becomes complete
    writeFileSync(join(d, "spec/tasks", "T012-build.md"), "---\nid: \"T012\"\ntype: task\nkind: feature\nfeature: S001\nstatus: done\n---\n");
    writeFileSync(join(d, "spec/tasks", "T-P003-patch.md"), "---\nid: \"T-P003\"\ntype: task\nkind: feature\nfeature: S001\nstatus: done\n---\n");
    const st = computeStoryReviewStatus(d);
    assert.deepEqual(parseWaves(readFileSync(join(d, "sprints/current/SPRINT.md"), "utf8"))[0].tasks, ["T012", "T-P003"]);
    assert.equal(st.stories[0].steps, 2, JSON.stringify(st));
    assert.equal(st.stories[0].complete, true, JSON.stringify(st));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("one isStoryId: a hotfix story B-HOT-004 is a story for story-review, design, tracker and route, as it already was for spec-state", () => {
  for (const id of ["S001", "F012", "B003", "B-HOT-004"]) assert.ok(isStoryId(id), id);
  for (const id of ["P001", "T001", "IDEA-001", "E001", "Q-1", ""]) assert.ok(!isStoryId(id), id);
  const base = mkdtempSync(join(tmpdir(), "rf-"));
  try {
    const d = dataDir(base);
    writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\nstories: [B-HOT-004]\n---\n");
    writeFileSync(join(d, "spec/bugs", "B-HOT-004-crash.md"), "---\nid: B-HOT-004\ntitle: \"Crash\"\ntype: bug\nlane: hotfix\nstatus: in-progress\nui: true\n---\n");
    let r = cli(d, "story-review", "record", "B-HOT-004", "--verdict", "approve", "--code", "CLEAN");
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(join(base, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]));
    r = cli(d, "design", "approve", "B-HOT-004", "--file", join(base, "shot.png"));
    assert.equal(r.status, 0, r.stderr);
    r = cli(d, "design", "check", "B-HOT-004");
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("design: a CRLF story file reads back its design block (no MISSING after approve, no duplicate block on re-approve)", () => {
  const crlf = 'id: S012\r\nui: true\r\ndesign:\r\n  version: 1\r\n  hash: "abc"\r\n  path: "spec/designs/S012-v1.png"\r\n  approved_at: "2026-11-13"\r\n  note: "x"\r\nsteps: []';
  const d1 = readDesign(crlf);
  assert.ok(d1, "block found in CRLF frontmatter");
  assert.equal(d1.version, 1); assert.equal(d1.hash, "abc"); assert.equal(d1.path, "spec/designs/S012-v1.png");
  const base = mkdtempSync(join(tmpdir(), "rf-"));
  try {
    const d = dataDir(base);
    writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\r\nid: sprint-001\r\nstatus: in-progress\r\nstories: [S012]\r\n---\r\n");
    writeFileSync(join(d, "spec/stories", "S012-pay.md"), "---\r\nid: S012\r\ntitle: \"Pay\"\r\ntype: feature\r\nstatus: approved\r\nui: true\r\nsteps: []\r\n---\r\n\r\n# Pay\r\n");
    writeFileSync(join(base, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
    writeFileSync(join(base, "b.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]));
    let r = cli(d, "design", "approve", "S012", "--file", join(base, "a.png"));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(checkStory(d, "S012").verdict, "OK");
    r = cli(d, "design", "approve", "S012", "--file", join(base, "b.png"));
    assert.equal(r.status, 0, r.stderr);
    const story = readFileSync(join(d, "spec/stories", "S012-pay.md"), "utf8");
    assert.equal((story.match(/^design:/gm) || []).length, 1, "one design block after re-approve");
    assert.equal(checkStory(d, "S012").version, 2);
    assert.ok(!/[^\r]\n/.test(story.split("---")[1]), "frontmatter keeps CRLF line endings");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("one sprint-list rule: block and inline forms, stories/features alias, de-duplicated; currentSprintId shared", () => {
  assert.deepEqual(sprintStoryIds("---\nid: s\nstories:\n  - S001\n  - S002\n  - S001\n---\n"), ["S001", "S002"]);
  assert.deepEqual(sprintStoryIds("---\nid: s\nfeatures: [F071d, \"B003\"] # note\n---\n"), ["F071d", "B003"]);
  assert.deepEqual(sprintStoryIds("---\nid: s\nfeatures: [F001]\n---\n"), ["F001"], "no canonical key: the legacy alias is read");
  assert.deepEqual(sprintStoryIds("---\nid: s\nstories: []\nfeatures: [F001]\n---\n"), [], "an explicit empty canonical key is an empty sprint, not a fallback");
  const base = mkdtempSync(join(tmpdir(), "rf-"));
  try {
    const d = dataDir(base);
    assert.equal(currentSprintId(d), null);
    writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-007\n---\n");
    assert.equal(currentSprintId(d), "sprint-007");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("parseFlags: --json boolean, --name value, bare words in order, a flag without a value reports through the caller's usage", () => {
  const o = parseFlags(["check", "S001", "--json", "--sprint", "sprint-002"], (m) => { throw new Error(m); });
  assert.deepEqual(o, { _: ["check", "S001"], json: true, sprint: "sprint-002" });
  assert.throws(() => parseFlags(["--sprint", "--json"], (m) => { throw new Error(m); }), /--sprint needs a value/);
});
