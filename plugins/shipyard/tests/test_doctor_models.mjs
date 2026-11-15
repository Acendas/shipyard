/** T017 / F003: doctor warns (exit 0) on empty/absent models.* tiers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function mk(fm) {
  const base = mkdtempSync(join(tmpdir(), "doctor-models-"));
  const d = join(base, "projects", "abc123abc123");
  mkdirSync(join(d, "templates"), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "config.md"), `---\n${fm}\n---\n\n# Config\n`);
  return { base, d };
}
const doctor = (d) =>
  spawnSync("node", [CLI, "doctor", "--data-dir", d], { encoding: "utf8" });
const warnings = (r) => r.stdout.split("\n").filter((l) => l.startsWith("warning:"));

test("AC-7 empty models.build warns, names config set-model, exits 0", () => {
  const { base, d } = mk(`models:\n  think: opus\n  build: ""`);
  try {
    const r = doctor(d);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const w = warnings(r).filter((l) => l.includes("models.build"));
    assert.equal(w.length, 1, r.stdout);
    assert.match(w[0], /config set-model/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("AC-6 absent models block warns for each tier", () => {
  const { base, d } = mk(`agent_effort:\n  build: medium`);
  try {
    const r = doctor(d);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const w = warnings(r);
    assert.ok(w.some((l) => l.includes("models.think")), r.stdout);
    assert.ok(w.some((l) => l.includes("models.build")), r.stdout);
    assert.ok(w.every((l) => /config set-model/.test(l)));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("fully set tiers (incl. explicit inherit) produce no warning", () => {
  const { base, d } = mk(`models:\n  think: opus\n  build: inherit\n  light: ""\n  orchestrate: opus`);
  try {
    const r = doctor(d);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(warnings(r).length, 0, r.stdout);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("AC-10 absent models.light warns with set-model command; empty light does not", () => {
  const a = mk(`models:\n  think: opus\n  build: sonnet`);
  const b = mk(`models:\n  think: opus\n  build: sonnet\n  light: ""`);
  try {
    const r = doctor(a.d);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const w = warnings(r).filter((l) => l.includes("models.light"));
    assert.equal(w.length, 1, r.stdout);
    assert.match(w[0], /config set-model light/);
    assert.equal(warnings(doctor(b.d)).length, 0);
  } finally { rmSync(a.base, { recursive: true, force: true }); rmSync(b.base, { recursive: true, force: true }); }
});

test("legacy claude-* model id warns naming the key and config set-model, exits 0", () => {
  const { base, d } = mk(`models:\n  think: claude-opus-4-8\n  build: sonnet\n  light: ""\n  orchestrate: claude-mystery-1`);
  try {
    const r = doctor(d);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const w = warnings(r);
    const t = w.filter((l) => l.includes("models.think"));
    assert.equal(t.length, 1, r.stdout);
    assert.match(t[0], /claude-opus-4-8/);
    assert.match(t[0], /config set-model think/);
    const o = w.filter((l) => l.includes("models.orchestrate"));
    assert.equal(o.length, 1, r.stdout);
    assert.equal(w.filter((l) => l.includes("models.build")).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
