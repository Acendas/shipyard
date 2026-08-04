/**
 * Tests for `shipyard-data review plan`.
 *
 * The command makes `/ship-review` batching deterministic: scanners provide
 * findings, then the CLI clusters fixes and validation waves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, "bin", "shipyard-data.mjs");

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "review-plan-test-"));
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(data, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  delete env.SHIPYARD_DATA;
  execFileSync("node", [CLI, "init"], { cwd: repo, env, encoding: "utf8" });
  return {
    root,
    repo,
    env,
    run(args) {
      return execFileSync("node", [CLI, ...args], { cwd: repo, env, encoding: "utf8" });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("review plan clusters overlapping findings and assigns non-conflicting waves", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "findings.json");
    writeFileSync(input, JSON.stringify({
      findings: [
        {
          id: "R003",
          title: "profile form does not surface validation",
          severity: "must-fix",
          files: ["src/profile/Form.tsx"],
          required_validation: ["npm test -- profile"],
          source: "bugs",
        },
        {
          id: "R001",
          title: "auth token can be swallowed",
          severity: "high",
          files: ["src/auth/session.ts"],
          required_validation: ["npm test -- auth"],
          source: "security",
        },
        {
          id: "R002",
          title: "auth test is missing expiry case",
          severity: "should-fix",
          files: ["src/auth/session.ts", "tests/auth/session.test.ts"],
          required_validation: ["npm test -- auth"],
          source: "tests",
        },
        {
          id: "R004",
          title: "style preference",
          severity: "low",
          files: ["src/profile/Form.tsx"],
          status: "consider",
        },
      ],
    }));

    const plan = JSON.parse(p.run(["review", "plan", input]));

    assert.equal(plan.counts.findings_total, 4);
    assert.equal(plan.counts.findings_actionable, 3);
    assert.equal(plan.counts.batches, 2);
    assert.equal(plan.counts.waves, 1);
    assert.deepEqual(plan.batches.map((b) => b.id), ["review-fix-1", "review-fix-2"]);

    const auth = plan.batches.find((b) => b.findings.includes("R001"));
    assert.deepEqual(auth.findings, ["R001", "R002"]);
    assert.equal(auth.risk, "high");
    assert.deepEqual(auth.required_probes, ["npm test -- auth"]);

    const profile = plan.batches.find((b) => b.findings.includes("R003"));
    assert.deepEqual(profile.findings, ["R003"]);
    assert.deepEqual(profile.required_probes, ["npm test -- profile"]);
    assert.deepEqual(plan.waves[0].batch_ids.sort(), ["review-fix-1", "review-fix-2"]);
    assert.deepEqual(plan.validation_ladder.wave_boundary, ["npm test -- auth", "npm test -- profile"]);
  } finally {
    p.cleanup();
  }
});

test("review plan writes to --out and merges conflicting file findings before wave assignment", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "findings.json");
    const out = join(p.root, "plan.json");
    writeFileSync(input, JSON.stringify([
      { id: "A", severity: "high", files: ["src/a.ts"], required_probes: ["npm test -- a"] },
      { id: "B", severity: "high", files: ["src/b.ts"], required_probes: ["npm test -- b"] },
      { id: "C", severity: "high", files: ["src/a.ts"], required_probes: ["npm test -- c"] },
    ]));

    const stdout = p.run(["review", "plan", input, "--out", out]).trim();
    assert.equal(stdout, out);
    assert.ok(existsSync(out));

    const plan = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(plan.counts.batches, 2, "A and C share src/a.ts and become one batch");
    assert.equal(plan.counts.waves, 1, "the merged src/a batch can run beside src/b");
    assert.deepEqual(plan.batches.find((b) => b.files.includes("src/a.ts")).findings, ["A", "C"]);
  } finally {
    p.cleanup();
  }
});

test("review plan output enqueues into the planned review fix waves", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "findings.json");
    const out = join(p.root, "plan.json");
    writeFileSync(input, JSON.stringify([
      { id: "A", severity: "high", files: ["src/a.ts"], required_probes: ["npm test -- a"] },
      { id: "B", severity: "high", files: ["src/b.ts"], required_probes: ["npm test -- b"] },
      { id: "C", severity: "high", files: ["src/a.ts", "src/b.ts"], required_probes: ["npm test -- c"] },
    ]));

    p.run(["review", "plan", input, "--out", out]);
    const plan = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(plan.counts.waves, 2, "merged transitive overlap should force a second wave");
    assert.deepEqual(plan.waves.map((w) => w.index), [1, 2]);

    p.run(["queue", "enqueue", "--pipeline", "ship-review", "--stage", "review_fix_wave", "--input", out]);
    const listed = JSON.parse(p.run(["queue", "list", "--pipeline", "ship-review"]));
    assert.deepEqual(listed.tasks.map((t) => [t.id, t.stage]), [
      ["review-fix-1", "review_fix_wave_1"],
      ["review-fix-2", "review_fix_wave_2"],
    ]);
  } finally {
    p.cleanup();
  }
});
