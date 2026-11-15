/** T031 / F005: session budget evaluator, config reader, doctor check. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSessionBudget } from "../bin/session-budget.mjs";
import { readMaxSessionMinutes } from "../bin/config-read.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
const T0 = "2026-11-11T10:00:00.000Z";
const at = (min) => new Date(Date.parse(T0) + min * 60000).toISOString();

function mk(fm) {
  const base = mkdtempSync(join(tmpdir(), "sess-budget-"));
  const d = join(base, "projects", "abc123abc123");
  mkdirSync(join(d, "templates"), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "config.md"), `---\n${fm}\n---\n\n# Config\n`);
  return { base, d };
}

test("AC-1 off when maxMinutes is 0, absent, or invalid", () => {
  for (const m of [0, undefined, null, -5, NaN]) {
    const r = evaluateSessionBudget({ now: at(9999), startedAt: T0, maxMinutes: m });
    assert.equal(r.enabled, false);
    assert.equal(r.exceeded, false);
  }
});

test("AC-2 30 of 240 minutes proceeds", () => {
  const r = evaluateSessionBudget({ now: at(30), startedAt: T0, maxMinutes: 240 });
  assert.equal(r.enabled, true);
  assert.equal(r.exceeded, false);
  assert.equal(r.elapsedMinutes, 30);
});

test("exceeded at and beyond the limit", () => {
  assert.equal(evaluateSessionBudget({ now: at(240), startedAt: T0, maxMinutes: 240 }).exceeded, true);
  assert.equal(evaluateSessionBudget({ now: at(239), startedAt: T0, maxMinutes: 240 }).exceeded, false);
});

test("AC-12 now before start (clock skew) gives elapsed 0", () => {
  const r = evaluateSessionBudget({ now: at(-10), startedAt: T0, maxMinutes: 240 });
  assert.equal(r.elapsedMinutes, 0);
  assert.equal(r.exceeded, false);
});

test("missing or unparseable startedAt never exceeds (no reset on ambiguity)", () => {
  for (const s of [undefined, "", "garbage"]) {
    const r = evaluateSessionBudget({ now: at(500), startedAt: s, maxMinutes: 240 });
    assert.equal(r.exceeded, false);
    assert.equal(r.elapsedMinutes, 0);
  }
});

test("accepts Date and epoch ms inputs", () => {
  const r = evaluateSessionBudget({ now: new Date(at(60)), startedAt: Date.parse(T0), maxMinutes: 240 });
  assert.equal(r.elapsedMinutes, 60);
});

test("readMaxSessionMinutes: absent/0 valid, positive valid, negative/non-numeric invalid", () => {
  const cases = [
    ["execution:\n  isolation: worktree", { value: 0, valid: true }],
    ["execution:\n  max_session_minutes: 0", { value: 0, valid: true }],
    ["execution:\n  max_session_minutes: 240 # note", { value: 240, valid: true }],
    ["execution:\n  max_session_minutes: -5", { value: 0, valid: false }],
    ["execution:\n  max_session_minutes: abc", { value: 0, valid: false }],
    ["execution:\n  max_session_minutes: 1.5", { value: 0, valid: false }],
  ];
  for (const [fm, want] of cases) {
    const { base, d } = mk(fm);
    try { assert.deepEqual(readMaxSessionMinutes(d), want, fm); }
    finally { rmSync(base, { recursive: true, force: true }); }
  }
  assert.deepEqual(readMaxSessionMinutes(undefined), { value: 0, valid: true });
});

test("AC-13 doctor reports an error for invalid value; valid and absent are clean", () => {
  const bad = mk("execution:\n  max_session_minutes: -5\nmodels:\n  think: a\n  build: b\n  light: \"\"");
  const ok = mk("execution:\n  max_session_minutes: 240\nmodels:\n  think: a\n  build: b\n  light: \"\"");
  try {
    const r = spawnSync("node", [CLI, "doctor", "--data-dir", bad.d], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /max_session_minutes/);
    assert.match(r.stdout, /budget is off|ignored/i);
    const r2 = spawnSync("node", [CLI, "doctor", "--data-dir", ok.d], { encoding: "utf8" });
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.doesNotMatch(r2.stdout, /max_session_minutes/);
  } finally {
    rmSync(bad.base, { recursive: true, force: true });
    rmSync(ok.base, { recursive: true, force: true });
  }
});
