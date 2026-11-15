/** E005-S3: design sign-off — approve records version + hash, check gates UI stories, drift is caught. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDesign, checkStory } from "../bin/design.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "design-"));
  const d = join(base, "projects", "abc123abc123");
  for (const sub of ["templates", "spec/stories", "sprints/current"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\nstories: [S001, S002]\n---\n");
  writeFileSync(join(d, "spec/stories/S001-login.md"), "---\nid: S001\ntitle: \"Login screen\"\ntype: feature\nstatus: approved\nui: true\nsteps: []\n---\n\n# Login\n");
  writeFileSync(join(d, "spec/stories/S002-api.md"), "---\nid: S002\ntitle: \"API\"\ntype: feature\nstatus: approved\nsteps: []\n---\n\n# API\n");
  writeFileSync(join(base, "mock.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  return { base, d };
}
const run = (d, ...args) => spawnSync("node", [CLI, "design", ...args, "--data-dir", d], { encoding: "utf8" });
const events = (d) => readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("check: a UI story without a design fails (exit 3); a non-UI story is fine; approve → OK; editing the snapshot → DRIFTED; re-approve → v2", () => {
  const { base, d } = fixture();
  try {
    let r = run(d, "check");
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.stdout, /S001: MISSING/);
    assert.match(r.stdout, /S002: NOT-UI/);
    assert.match(r.stderr, /S001 \(MISSING\)/);

    r = run(d, "approve", "S001", "--file", join(base, "mock.txt"));
    assert.equal(r.status, 2, "a missing snapshot is a usage error");
    r = run(d, "approve", "S001", "--file", join(base, "mock.png"), "--note", "v1 from the design canvas");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /S001: design v1 approved/);
    assert.ok(existsSync(join(d, "spec/designs/S001-v1.png")));
    const fm = readFileSync(join(d, "spec/stories/S001-login.md"), "utf8");
    const dsg = readDesign(fm.match(/^---\n([\s\S]*?)\n---/)[1]);
    assert.equal(dsg.version, 1);
    assert.equal(dsg.path, "spec/designs/S001-v1.png");
    assert.equal(dsg.hash.length, 64);
    assert.match(fm, /# Login/, "body untouched");

    r = run(d, "check", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).failing, []);

    writeFileSync(join(d, "spec/designs/S001-v1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
    r = run(d, "check", "S001");
    assert.equal(r.status, 3);
    assert.match(r.stdout, /S001: DRIFTED v1/);
    assert.equal(checkStory(d, "S001").verdict, "DRIFTED");

    r = run(d, "approve", "S001", "--file", join(base, "mock.png"));
    assert.match(r.stdout, /design v2 approved/);
    assert.equal(checkStory(d, "S001").verdict, "OK");
    assert.equal(checkStory(d, "S002").verdict, "NOT-UI");
    assert.equal(checkStory(d, "S009").verdict, "MISSING-FILE");

    r = run(d, "status");
    assert.match(r.stdout, /S001: ui design v2/);

    const ev = events(d).filter((e) => e.type === "design_approved");
    assert.equal(ev.length, 2);
    assert.equal(ev[1].version, 2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("approve on a story without ui: true marks it ui: true (a design makes it a UI story)", () => {
  const { base, d } = fixture();
  try {
    const r = run(d, "approve", "S002", "--file", join(base, "mock.png"));
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(d, "spec/stories/S002-api.md"), "utf8"), /^ui: true$/m);
    assert.equal(checkStory(d, "S002").verdict, "OK");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
