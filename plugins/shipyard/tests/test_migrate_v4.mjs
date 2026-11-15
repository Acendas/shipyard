/**
 * F022 AC-5: `shipyard-data migrate` — dry-run writes nothing, apply is
 * idempotent, --reverse restores the original tree byte for byte.
 * Run: node --test tests/test_migrate_v4.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "migrate-v4-"));
  const d = join(base, "projects", "abc123abc123");
  for (const sub of ["spec/features", "spec/tasks", "spec/bugs", "spec/ideas", "spec/epics", "sprints/current", "templates"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "config.md"), "---\nproject_name: x\n---\n");
  const w = (rel, body) => writeFileSync(join(d, rel), body);
  w("spec/features/F001-login.md", "---\nid: F001\ntitle: \"Login\"\ntype: feature\nstatus: in-progress\ntasks: [T001, T002]\ncreated: 2026-01-01\n---\n\n# Login\n");
  w("spec/tasks/T001-form.md", "---\nid: \"T001\"\ntitle: \"Form\"\ntype: task\nkind: feature\nfeature: F001\nstatus: done\neffort: \"S\"\ndependencies: []\ncreated: 2026-01-01\n---\n\n# Form\n");
  w("spec/tasks/T002-api.md", "---\nid: \"T002\"\ntitle: \"API\"\ntype: task\nkind: operational\nfeature: F001\nstatus: pending\neffort: \"M\"\ndependencies: [T001]\ncreated: 2026-01-01\n---\n\n# API\n");
  w("spec/tasks/T005-spike.md", "---\nid: \"T005\"\ntitle: \"Spike\"\ntype: task\nkind: spike\nstatus: open\ncreated: 2026-01-01\n---\n\n# Spike (already v4)\n");
  w("spec/tasks/Q-007-typo.md", "---\nid: Q-007\ntitle: \"Fix typo\"\ntype: quick-task\nstatus: done\ncreated: 2026-01-01\n---\n\n# Fix typo\n");
  w("spec/bugs/B001-crash.md", "---\nid: B001\ntitle: \"Crash\"\ntype: bug\nstatus: open\nseverity: high\n---\n\n# Crash\n");
  w("spec/bugs/B-HOT-003-outage.md", "---\nid: B-HOT-003\ntitle: \"Outage\"\ntype: bug\nhotfix: true\nstatus: open\nseverity: critical\n---\n\n# Outage\n");
  w("sprints/current/SPRINT.md", "---\nid: sprint-001\nstatus: completed\nfeatures: [F001]\n---\n\n## Waves\n\n### Wave 1\n- T001\n- T002\n");
  return { base, d };
}
const run = (d, ...args) => spawnSync("node", [CLI, "migrate", ...args, "--data-dir", d], { encoding: "utf8" });
function snapshot(d) {
  const out = {};
  const walk = (p) => {
    for (const e of readdirSync(p)) {
      const full = join(p, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (!full.endsWith(".shipyard-events.jsonl")) out[relative(d, full)] = readFileSync(full, "utf8");
    }
  };
  walk(d);
  return out;
}

test("dry-run prints the plan and writes nothing", () => {
  const { base, d } = fixture();
  try {
    const before = snapshot(d);
    const r = run(d, "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /move T001 -> P001/);
    assert.match(r.stdout, /move T002 -> P002/);
    assert.match(r.stdout, /move Q-007 -> T006/, "quick task continues the T counter past the highest existing T id");
    assert.match(r.stdout, /move B-HOT-003 -> S001/);
    assert.match(r.stdout, /dry run — nothing written/);
    assert.deepEqual(snapshot(d), before);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("apply: builder units become steps with aliases, quick tasks become tasks, hotfix bugs become stories; references follow; second run is a no-op; reverse restores exactly", () => {
  const { base, d } = fixture();
  try {
    const before = snapshot(d);
    const r = run(d);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /applied: 4 record\(s\) moved, 2 file\(s\) rewritten/);

    const step1 = readFileSync(join(d, "spec/steps/P001-form.md"), "utf8");
    assert.match(step1, /^id: "P001"$/m);
    assert.match(step1, /^type: step$/m);
    assert.match(step1, /^aliases: \["T001"\]$/m);
    assert.match(step1, /^story: F001$/m);
    assert.match(step1, /^feature: F001$/m, "legacy key kept for pre-v4 readers");
    assert.ok(!existsSync(join(d, "spec/tasks/T001-form.md")));
    assert.ok(existsSync(join(d, "spec/steps/P002-api.md")));
    assert.ok(existsSync(join(d, "spec/tasks/T005-spike.md")), "a v4 task is not a builder unit and stays");

    const quick = readFileSync(join(d, "spec/tasks/T006-typo.md"), "utf8");
    assert.match(quick, /^type: task$/m);
    assert.match(quick, /^kind: chore$/m);
    assert.match(quick, /^aliases: \["Q-007"\]$/m);
    assert.match(quick, /^status: done$/m);

    const hot = readFileSync(join(d, "spec/stories/S001-outage.md"), "utf8");
    assert.match(hot, /^id: S001$/m);
    assert.match(hot, /^type: bug$/m);
    assert.match(hot, /^lane: hotfix$/m);
    assert.match(hot, /^aliases: \["B-HOT-003"\]$/m);
    assert.match(hot, /^status: proposed$/m);
    assert.ok(existsSync(join(d, "spec/bugs/B001-crash.md")), "plain legacy bugs stay in place (I-2)");

    assert.match(readFileSync(join(d, "spec/features/F001-login.md"), "utf8"), /^steps: \[P001, P002\]$/m);
    assert.match(readFileSync(join(d, "sprints/current/SPRINT.md"), "utf8"), /- P001\n- P002/);
    assert.equal(readFileSync(join(d, "spec/steps/.id-seq"), "utf8"), "2");
    assert.equal(readFileSync(join(d, "spec/tasks/.id-seq"), "utf8"), "6");
    assert.equal(readFileSync(join(d, "spec/stories/.id-seq"), "utf8"), "1");
    assert.ok(existsSync(join(d, "spec/.migration-v4.json")));
    assert.match(readFileSync(join(d, ".shipyard-events.jsonl"), "utf8"), /migration_v4_applied/);

    const again = run(d);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already applied/);

    const rev = run(d, "--reverse");
    assert.equal(rev.status, 0, rev.stderr);
    assert.match(rev.stdout, /reversed: 4 record\(s\) moved back, 2 file\(s\) restored/);
    const after = snapshot(d);
    // the original tree, byte for byte; empty v4 dirs left behind do not count
    assert.deepEqual(after, before);
    assert.ok(!existsSync(join(d, "spec/.migration-v4.json")));
    assert.ok(!existsSync(join(d, "spec/steps/.id-seq")));
    assert.equal(run(d, "--reverse").stdout.trim(), "nothing to reverse (no journal)");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("nothing to migrate on a v4-only tree; unknown flag is a usage error", () => {
  const base = mkdtempSync(join(tmpdir(), "migrate-v4-empty-"));
  const d = join(base, "projects", "abc123abc123");
  try {
    mkdirSync(join(d, "spec", "stories"), { recursive: true });
    mkdirSync(join(d, "templates"), { recursive: true });
    writeFileSync(join(d, ".project-root"), "/nonexistent\n");
    const r = run(d);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to migrate/);
    assert.equal(run(d, "--bogus").status, 2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("migrate refuses while a sprint is in flight (4.6): the event log keeps old ids, so renumbering mid-sprint loses the gates' evidence; --force overrides", () => {
  const { base, d } = fixture();
  try {
    const sp = join(d, "sprints/current/SPRINT.md");
    writeFileSync(sp, readFileSync(sp, "utf8").replace("status: completed", "status: in-progress"));
    const r = run(d);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /a sprint is in flight/);
    assert.ok(readdirSync(join(d, "spec/tasks")).length > 0 && !existsSync(join(d, "spec/steps")), "nothing moved");
    assert.equal(run(d, "--dry-run").status, 0, "a dry run is always allowed");
    assert.equal(run(d, "--force").status, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
