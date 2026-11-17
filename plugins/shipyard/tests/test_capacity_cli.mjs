/**
 * F011: `shipyard-data capacity` + execution.assumed_points_per_hour.
 * Run: node --test tests/test_capacity_cli.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutUserSettings } from "./lib/no-user-settings.mjs";

import { computeCapacity, parseCapacityArgs, hoursUntil, renderCapacity } from "../bin/capacity.mjs";
import { readAssumedPointsPerHour } from "../bin/config-read.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

const vel = (...pts) => ({ velocity: { recent: pts.map((p, i) => ({ sprint: `sprint-${String(i + 1).padStart(3, "0")}`, points: p })) }, throughput: { recent: [] } });
const withRate = (state, ...rates) => ({ ...state, throughput: { recent: rates.map((r, i) => ({ sprint: `sprint-${String(i + 1).padStart(3, "0")}`, points_per_hour: r })) } });

// AC-7
test("below three finished sprints: range, no percentage", () => {
  const r = computeCapacity(vel(5, 41), { points: 20 });
  assert.equal(r.n, 2);
  assert.equal(r.fit, null);
  assert.equal(r.capacity, 23);
  const out = renderCapacity(r);
  assert.match(out, /2 finished sprints: 5 to 41 pts/);
  assert.doesNotMatch(out, /fits at/);
  assert.match(out, /Calibration: n=2/);
});

// AC-5, AC-6, AC-8
test("three finished sprints: empirical fit with n and min..max, calibration beside it", () => {
  const r = computeCapacity(vel(5, 41, 18), { points: 18 });
  assert.deepEqual(r.fit, { points: 18, percent: 67, atLeast: 2, n: 3, min: 5, max: 41 });
  const out = renderCapacity(r);
  assert.match(out, /18 pts fits at 67% — 2 of the last 3 finished sprints/);
  assert.match(out, /range 5 to 41/);
  assert.match(out, /Calibration: n=3 finished sprints \(completed, not cancelled\), min 5, max 41, average 21\.3 pts/);
  assert.match(out, /fit_percent=67/);
});

// AC-4
test("capacity is the rolling mean of the last 3 finished sprints", () => {
  assert.equal(computeCapacity(vel(100, 10, 20, 30)).capacity, 20);
  assert.equal(computeCapacity(vel()).capacity, null);
  assert.match(renderCapacity(computeCapacity(vel())), /no finished sprints yet/);
});

// AC-10
test("--hours converts through the measured rate and says how many sprints back it", () => {
  const r = computeCapacity(withRate(vel(20, 22, 24), 4.0, 5.6), { hours: 6 });
  assert.equal(r.measured.rate, 4.8);
  assert.deepEqual(r.budget, { hours: 6, rate: 4.8, source: "measured", sprints: 2, points: 28 });
  assert.match(renderCapacity(r), /6 h x 4\.8 pts\/hr = 28 pts \(from measured rate, 2 sprints behind it\)/);
});

// AC-12, AC-13
test("no measured rate: assumed rate is used and labeled; none at all refuses to convert", () => {
  const assumed = computeCapacity(vel(20), { hours: 6, assumedRate: 4 });
  assert.equal(assumed.budget.source, "assumed");
  assert.equal(assumed.budget.points, 24);
  assert.match(renderCapacity(assumed), /your assumed rate, not measured/);
  const none = computeCapacity(vel(20), { hours: 6 });
  assert.equal(none.budget.source, "none");
  const out = renderCapacity(none);
  assert.match(out, /no points-per-hour rate yet — nothing is converted from a guess/);
  assert.match(out, /budget_points=\n/);
  // a measured rate always overrides the assumed one
  const both = computeCapacity(withRate(vel(20), 2), { hours: 6, assumedRate: 4 });
  assert.equal(both.budget.source, "measured");
  assert.equal(both.budget.points, 12);
});

// AC-9
test("no time flag: points budget by default", () => {
  assert.equal(computeCapacity(vel(20)).budget, null);
  assert.match(renderCapacity(computeCapacity(vel(20))), /Budget: points \(default\)/);
});

// AC-11, AC-15, AC-16
test("argument validation: bad hours, past --until, exclusive flags", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  assert.match(parseCapacityArgs(["--hours", "0"]).error, /positive number/);
  assert.match(parseCapacityArgs(["--hours", "-2"]).error, /positive number/);
  assert.match(parseCapacityArgs(["--hours", "abc"]).error, /positive number/);
  assert.match(parseCapacityArgs(["--until", "2026-11-12T09:00:00Z"], now).error, /in the past/);
  assert.match(parseCapacityArgs(["--until", "yesterday"], now).error, /not an ISO-8601/);
  assert.match(parseCapacityArgs(["--points", "10", "--hours", "2"]).error, /pick one budget/);
  assert.match(parseCapacityArgs(["--hours", "2", "--until", "2026-11-12T12:00:00Z"], now).error, /pick one/);
  assert.match(parseCapacityArgs(["--points", "0"]).error, /positive whole number/);
  assert.equal(parseCapacityArgs(["--until", "2026-11-12T16:00:00Z"], now).hours, 6);
  assert.equal(hoursUntil("2026-11-12T13:30:00Z", now).hours, 3.5);
  assert.deepEqual(parseCapacityArgs(["--points", "13", "--json"]), { points: 13, hours: null, json: true });
});

// AC-13, AC-14
test("readAssumedPointsPerHour: absent/empty is off and valid; junk is invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-cfg-"));
  try {
    assert.deepEqual(readAssumedPointsPerHour(dir), { value: null, valid: true });
    writeFileSync(join(dir, "config.md"), `---\nexecution:\n  assumed_points_per_hour: ""\n---\n`);
    assert.deepEqual(readAssumedPointsPerHour(dir), { value: null, valid: true });
    writeFileSync(join(dir, "config.md"), `---\nexecution:\n  assumed_points_per_hour: 4.8  # observed\n---\n`);
    assert.deepEqual(readAssumedPointsPerHour(dir), { value: 4.8, valid: true });
    for (const bad of ["abc", "0", "-3"]) {
      writeFileSync(join(dir, "config.md"), `---\nexecution:\n  assumed_points_per_hour: ${bad}\n---\n`);
      assert.deepEqual(readAssumedPointsPerHour(dir), { value: null, valid: false }, bad);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dataDir(metrics, configExec = "") {
  const base = mkdtempSync(join(tmpdir(), "cap-cli-"));
  const d = join(base, "projects", "abc123abc123");
  mkdirSync(join(d, "memory"), { recursive: true });
  mkdirSync(join(d, "templates"), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "config.md"), `---\nexecution:\n${configExec}\n---\n\n# Config\n`);
  if (metrics) writeFileSync(join(d, "memory", "metrics.json"), JSON.stringify(metrics));
  return { base, d };
}
const run = (d, ...args) => spawnSync("node", [CLI, "capacity", ...args, "--data-dir", d], { encoding: "utf8" });

test("CLI: prints capacity, fit, calibration and machine lines; exit 2 on usage errors; never writes", () => {
  const { base, d } = dataDir(withRate(vel(5, 41, 18), 4.8));
  try {
    const r = run(d, "--points", "18");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Capacity ~21 pts \(rolling velocity, last 3 finished sprints\)/);
    assert.match(r.stdout, /fits at 67%/);
    assert.match(r.stdout, /measured rate 4\.8 pts\/hr over 1 sprint/);
    assert.match(r.stdout, /capacity_points=21\nfinished_sprints=3\nfit_percent=67\nrate_source=\nbudget_points=\n/);
    const h = run(d, "--hours", "5");
    assert.equal(h.status, 0, h.stderr);
    assert.match(h.stdout, /= 24 pts \(from measured rate, 1 sprint behind it\)/);
    assert.match(h.stdout, /rate_source=measured\nbudget_points=24/);
    assert.equal(run(d, "--hours", "0").status, 2);
    assert.equal(run(d, "--points", "3", "--hours", "1").status, 2);
    const j = run(d, "--json");
    assert.equal(JSON.parse(j.stdout).capacity, 21);
    assert.equal(spawnSync("ls", [join(d, "memory")], { encoding: "utf8" }).stdout.trim(), "metrics.json", "read-only");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("CLI: no rate falls back to points with an explanation (exit 0); assumed rate is labeled", () => {
  const { base, d } = dataDir(vel(20, 22));
  try {
    const r = run(d, "--hours", "4");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no points-per-hour rate yet/);
    assert.match(r.stdout, /rate_source=none/);
    assert.match(r.stderr, /planning by points/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const a = dataDir(vel(20, 22), "  assumed_points_per_hour: 4.8");
  try {
    const r = run(a.d, "--hours", "5");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /= 24 pts \(your assumed rate, not measured/);
    assert.match(r.stdout, /rate_source=assumed\nbudget_points=24/);
  } finally {
    rmSync(a.base, { recursive: true, force: true });
  }
});

// AC-14: doctor reports a junk assumed rate
test("doctor reports an invalid execution.assumed_points_per_hour", () => {
  const { base, d } = dataDir(null, "  assumed_points_per_hour: fast");
  try {
    const r = spawnSync("node", [CLI, "doctor", "--data-dir", d], { encoding: "utf8", env: withoutUserSettings(base) });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /assumed_points_per_hour/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
