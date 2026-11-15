/** F023 AC-3/AC-4: the intake ladder is CLI output and every decision is logged. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { routeIntake, LANES, REFINE_ROUNDS } from "../bin/route-intake.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

test("ladder: production urgency is always hotfix", () => {
  for (const size of ["xs", "xl"]) {
    assert.equal(routeIntake({ size, ambiguity: "low", repro: "known", risk: "none", urgency: "production" }).lane, "hotfix");
  }
});

test("ladder: tiny + ambiguous = capture; tiny + clear + low risk = land-now; otherwise refine with rounds by size", () => {
  assert.equal(routeIntake({ size: "s", ambiguity: "high", repro: "na", risk: "none", urgency: "normal" }).lane, "capture");
  // floors beat capture (F031 probe finding): risk, unknown repro or urgency refine even a vague one-liner
  assert.equal(routeIntake({ size: "s", ambiguity: "high", repro: "na", risk: "high", urgency: "normal" }).lane, "refine");
  assert.equal(routeIntake({ size: "xs", ambiguity: "high", repro: "unknown", risk: "none", urgency: "normal" }).lane, "refine");
  assert.equal(routeIntake({ size: "xs", ambiguity: "high", repro: "na", risk: "none", urgency: "high" }).lane, "refine");
  assert.equal(routeIntake({ size: "xs", ambiguity: "low", repro: "na", risk: "low", urgency: "normal" }).lane, "land-now");
  assert.equal(routeIntake({ size: "xs", ambiguity: "low", repro: "known", risk: "none", urgency: "normal" }).lane, "land-now");
  const r = routeIntake({ size: "xs", ambiguity: "low", repro: "na", risk: "high", urgency: "normal" });
  assert.equal(r.lane, "refine", "a risk floor forces refinement even for a tiny change");
  assert.equal(routeIntake({ size: "s", ambiguity: "low", repro: "unknown", risk: "none", urgency: "normal" }).lane, "refine", "an unknown repro cannot land now");
  assert.equal(routeIntake({ size: "s", ambiguity: "low", repro: "na", risk: "none", urgency: "high" }).lane, "refine", "high urgency still refines, just fast");
  for (const [size, rounds] of Object.entries(REFINE_ROUNDS)) {
    const x = routeIntake({ size, ambiguity: "medium", repro: "na", risk: "low", urgency: "normal" });
    assert.equal(x.lane, "refine");
    assert.equal(x.refine_rounds, rounds, size);
  }
  assert.ok(routeIntake({ size: "m", ambiguity: "low", repro: "unknown", risk: "none", urgency: "normal", kind: "bug" }).reasons.some((s) => /failing test first/.test(s)));
});

function dataDir() {
  const base = mkdtempSync(join(tmpdir(), "route-intake-"));
  const d = join(base, "projects", "abc123abc123");
  mkdirSync(join(d, "templates"), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  return { base, d };
}
const run = (d, ...args) => spawnSync("node", [CLI, "route-intake", ...args, "--data-dir", d], { encoding: "utf8" });

test("CLI: proposes a lane with reasons and logs intake_routed; --confirm logs the answer and overrides", () => {
  const { base, d } = dataDir();
  try {
    const r = run(d, "--size", "s", "--ambiguity", "low", "--repro", "na", "--risk", "none", "--urgency", "normal");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^lane=land-now$/m);
    assert.match(r.stdout, /The router proposes; the user confirms/);
    const j = JSON.parse(run(d, "--size", "l", "--ambiguity", "high", "--repro", "na", "--risk", "medium", "--urgency", "normal", "--json").stdout);
    assert.equal(j.lane, "refine");
    assert.equal(j.refine_rounds, 4);
    assert.equal(j.inputs.size, "l");
    const c = run(d, "--confirm", "refine", "--proposed", "land-now");
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /overrode proposed land-now/);
    const events = readFileSync(join(d, ".shipyard-events.jsonl"), "utf8");
    assert.equal((events.match(/"intake_routed"/g) || []).length, 2);
    assert.match(events, /"intake_lane_confirmed".*"lane":"refine".*"proposed":"land-now".*"overridden":true/);
    assert.equal(run(d, "--size", "huge", "--ambiguity", "low", "--repro", "na", "--risk", "none", "--urgency", "normal").status, 2);
    assert.equal(run(d, "--confirm", "nope", "--proposed", "refine").status, 2);
    assert.equal(run(d, "--size", "s").status, 2, "every ladder input is required");
    assert.deepEqual([...LANES], ["capture", "refine", "land-now", "hotfix"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
