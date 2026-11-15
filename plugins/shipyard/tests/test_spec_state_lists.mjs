/**
 * T015: spec-state-cli must refuse block/bare list-valued frontmatter and
 * never append a duplicate key (it used to treat a block list as [] and
 * rewrite it, or append a second `references:` line).
 *
 * Run: node --test tests/test_spec_state_lists.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, "bin", "shipyard-data.mjs");

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "spec-state-lists-"));
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(data, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  delete env.SHIPYARD_DATA;
  const run = (args) => {
    const r = spawnSync("node", [CLI, ...args], { cwd: repo, env, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const dataDir = run(["init"]).stdout.trim();
  mkdirSync(join(dataDir, "spec", "references"), { recursive: true });
  writeFileSync(join(dataDir, "spec", "references", "a.md"), "x");
  return { dataDir, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeFeature(p, extra) {
  const path = join(p.dataDir, "spec", "features", "F001-test.md");
  writeFileSync(path, `---\nid: F001\ntitle: T\ntype: feature\nstatus: proposed\n${extra}\nupdated: 2026-01-01\n---\n\n# T\n`);
  return path;
}
const keyCount = (s, k) => (s.match(new RegExp(`^${k}\\s*:`, "gm")) || []).length;

test("add-ref refuses a block list and leaves the file unchanged", () => {
  const p = makeProject();
  try {
    const path = writeFeature(p, "references:\n  - spec/references/old.md");
    const before = readFileSync(path, "utf8");
    const r = p.run(["feature", "add-ref", "F001", join(p.dataDir, "spec", "references", "a.md")]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /block|list/i);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally { p.cleanup(); }
});

test("add-external-ref refuses a bare (unbracketed) list unchanged", () => {
  const p = makeProject();
  try {
    const path = writeFeature(p, "external_refs: GH-6, GH-7");
    const before = readFileSync(path, "utf8");
    const r = p.run(["feature", "add-external-ref", "F001", "GH-9"]);
    assert.notEqual(r.code, 0);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally { p.cleanup(); }
});

test("add-external-ref on a block list leaves a single key, unchanged", () => {
  const p = makeProject();
  try {
    const path = writeFeature(p, "external_refs:\n  - GH-6");
    const before = readFileSync(path, "utf8");
    const r = p.run(["feature", "add-external-ref", "F001", "GH-9"]);
    assert.notEqual(r.code, 0);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(keyCount(before, "external_refs"), 1);
  } finally { p.cleanup(); }
});

test("empty `references:` (no value) is replaced, not duplicated", () => {
  const p = makeProject();
  try {
    const path = writeFeature(p, "references:");
    const r = p.run(["feature", "add-ref", "F001", join(p.dataDir, "spec", "references", "a.md")]);
    assert.equal(r.code, 0, r.stderr);
    const after = readFileSync(path, "utf8");
    assert.equal(keyCount(after, "references"), 1);
    assert.match(after, /references: \[.*a\.md.*\]/);
  } finally { p.cleanup(); }
});

test("inline list round-trips and absent key appends exactly one key", () => {
  const p = makeProject();
  try {
    const path = writeFeature(p, "external_refs: [GH-6]");
    assert.equal(p.run(["feature", "add-external-ref", "F001", "GH-9"]).code, 0);
    let after = readFileSync(path, "utf8");
    assert.match(after, /external_refs: \[GH-6, GH-9\]/);
    assert.equal(p.run(["feature", "add-ref", "F001", join(p.dataDir, "spec", "references", "a.md")]).code, 0);
    after = readFileSync(path, "utf8");
    assert.equal(keyCount(after, "references"), 1);
  } finally { p.cleanup(); }
});

test("multiline_flow add-external-ref collapses the complete inline list to one line and drops no item", () => {
  // 4.3.0 code review: a multiline inline list is complete, so rewriting it is safe —
  // refusing it (the 4.0.0 behavior) broke every pre-v4 record authored that way.
  const p = makeProject();
  try {
    const path = writeFeature(p, "external_refs: [GH-1,\n  GH-2]");
    const r = p.run(["feature", "add-external-ref", "F001", "GH-3"]);
    assert.equal(r.code, 0, r.stderr);
    const after = readFileSync(path, "utf8");
    assert.match(after, /^external_refs: \[GH-1, GH-2, GH-3\]$/m);
    assert.ok(!/GH-2\]\n  /.test(after), "no leftover continuation line");
  } finally { p.cleanup(); }
});
