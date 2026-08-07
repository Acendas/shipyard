/**
 * Tests for the v3.5.0 CLI-absorption spec-state CLI:
 *   bin/spec-lifecycle.mjs   (transition graphs)
 *   bin/spec-state-cli.mjs  (feature/backlog/idea subcommands)
 *
 * Exercised as a subprocess against shipyard-data.mjs (0 ok, 2 usage,
 * 3 validation refusal, 4 not-found), same pattern as test_cursor_cli.mjs.
 *
 * Run: node --test tests/test_spec_state_cli.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateStatusTransition, FEATURE_TRANSITIONS, IDEA_TRANSITIONS } from "../bin/spec-lifecycle.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, "bin", "shipyard-data.mjs");
const BACKLOG_TEMPLATE = readFileSync(join(PLUGIN_ROOT, "project-files", "templates", "BACKLOG.md"), "utf8");

// --- transition-graph unit tests -----------------------------------------

test("spec-lifecycle: legal feature transition", () => {
  assert.ok(validateStatusTransition(FEATURE_TRANSITIONS, "proposed", "approved").ok);
  assert.ok(validateStatusTransition(FEATURE_TRANSITIONS, "done", "deployed").ok);
});

test("spec-lifecycle: illegal feature transition lists valid next states", () => {
  const r = validateStatusTransition(FEATURE_TRANSITIONS, "proposed", "done");
  assert.equal(r.ok, false);
  assert.deepEqual(r.validNext, ["approved", "deferred", "rejected"]);
});

test("spec-lifecycle: done does NOT skip straight to released (rules-file chain)", () => {
  assert.equal(validateStatusTransition(FEATURE_TRANSITIONS, "done", "released").ok, false);
});

test("spec-lifecycle: idea transitions", () => {
  assert.ok(validateStatusTransition(IDEA_TRANSITIONS, "proposed", "graduated").ok);
  assert.equal(validateStatusTransition(IDEA_TRANSITIONS, "graduated", "rejected").ok, false);
});

// --- CLI integration fixture ----------------------------------------------

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "spec-state-cli-test-"));
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(data, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  delete env.SHIPYARD_DATA;
  const run = (args) => {
    const result = spawnSync("node", [CLI, ...args], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const initResult = run(["init"]);
  const dataDir = initResult.stdout.trim();
  // Fail HERE if init didn't actually work. Without this guard an empty stdout
  // leaves dataDir === "", and every later join(dataDir, "spec", ...) silently
  // degrades to a RELATIVE path — surfacing much later as a baffling
  // `ENOENT: spec/...` that looks like a product bug rather than a failed
  // fixture. That is the shape of the intermittent failure seen under
  // concurrent `node --test tests/*.mjs` runs.
  if (initResult.code !== 0 || !isAbsolute(dataDir)) {
    throw new Error(
      `fixture setup failed: shipyard-data init exited ${initResult.code}, ` +
        `stdout=${JSON.stringify(initResult.stdout)} stderr=${initResult.stderr}`,
    );
  }
  writeFileSync(join(dataDir, "backlog", "BACKLOG.md"), BACKLOG_TEMPLATE);
  return { root, repo, dataDir, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeFeature(p, fid, overrides = {}) {
  const fm = {
    id: fid,
    title: "Test Feature",
    type: "feature",
    epic: '""',
    status: "proposed",
    story_points: 3,
    rice_reach: 10,
    rice_impact: 2,
    rice_confidence: 0.8,
    rice_effort: 2,
    references: "[]",
    external_refs: "[]",
    updated: "2026-01-01",
    ...overrides,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  const content = `---\n${lines.join("\n")}\n---\n\n# Test Feature\n`;
  writeFileSync(join(p.dataDir, "spec", "features", `${fid}-test.md`), content);
}

function writeEpic(p, eid) {
  writeFileSync(join(p.dataDir, "spec", "epics", `${eid}-test.md`), `---\nid: ${eid}\ntitle: Test Epic\nstatus: proposed\n---\n\n# Test Epic\n`);
}

function writeIdea(p, id, status = "proposed") {
  writeFileSync(join(p.dataDir, "spec", "ideas", `${id}-test.md`), `---\nid: ${id}\ntitle: Test Idea\nstatus: ${status}\n---\n\n# Test Idea\n`);
}

function writeTask(p, tid, overrides = {}) {
  const fm = {
    id: tid,
    title: "Test Task",
    type: "task",
    feature: "F001",
    status: "planned",
    kind: "feature",
    acceptance_probe: "'node --test'",
    ...overrides,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(p.dataDir, "spec", "tasks", `${tid}-test.md`), `---\n${lines.join("\n")}\n---\n\n# Test Task\n`);
}

function readFeature(p, fid) {
  const dir = join(p.dataDir, "spec", "features");
  return readFileSync(join(dir, `${fid}-test.md`), "utf8");
}

function readEvents(p) {
  return readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
}

function readBacklogIds(p) {
  const content = readFileSync(join(p.dataDir, "backlog", "BACKLOG.md"), "utf8");
  return [...content.matchAll(/^\|\s*\d+\s*\|\s*(\S+)\s*\|\s*$/gm)].map((m) => m[1]);
}

// --- feature set-status ----------------------------------------------------

test("feature set-status: legal transition writes status + updated, emits event", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "proposed" });
    const r = p.run(["feature", "set-status", "F001", "approved"]);
    assert.equal(r.code, 0);
    const content = readFeature(p, "F001");
    assert.match(content, /status: approved/);
    assert.match(content, new RegExp(`updated: ${new Date().toISOString().slice(0, 10)}`));
    assert.match(readEvents(p), /feature_status_changed/);
  } finally {
    p.cleanup();
  }
});

test("feature set-status: illegal transition exits 3 and lists valid next states", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "proposed" });
    const r = p.run(["feature", "set-status", "F001", "done"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /approved, deferred, rejected/);
  } finally {
    p.cleanup();
  }
});

test("feature set-status: unknown FID exits 4", () => {
  const p = makeProject();
  try {
    const r = p.run(["feature", "set-status", "F999", "approved"]);
    assert.equal(r.code, 4);
  } finally {
    p.cleanup();
  }
});

test("feature set-status: --force overrides the graph", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "proposed" });
    const r = p.run(["feature", "set-status", "F001", "done", "--force"]);
    assert.equal(r.code, 0);
    assert.match(readFeature(p, "F001"), /status: done/);
  } finally {
    p.cleanup();
  }
});

test("feature set-status: landing on a backlog-removing status removes the ID from BACKLOG.md", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "approved" });
    writeFileSync(
      join(p.dataDir, "backlog", "BACKLOG.md"),
      BACKLOG_TEMPLATE.replace("|------|----|\n", "|------|----|\n| 1 | F001 |\n"),
    );
    p.run(["feature", "set-status", "F001", "deferred"]);
    assert.deepEqual(readBacklogIds(p), []);
  } finally {
    p.cleanup();
  }
});

test("feature set-status: approved does NOT auto-add to backlog", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "proposed" });
    p.run(["feature", "set-status", "F001", "approved"]);
    assert.deepEqual(readBacklogIds(p), []);
  } finally {
    p.cleanup();
  }
});

// --- feature set ------------------------------------------------------------

test("feature set: allowlisted numeric keys update, updated auto-bumps", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { updated: "2020-01-01" });
    const r = p.run(["feature", "set", "F001", "rice_reach=20", "story_points=5"]);
    assert.equal(r.code, 0);
    const content = readFeature(p, "F001");
    assert.match(content, /rice_reach: 20/);
    assert.match(content, /story_points: 5/);
    assert.doesNotMatch(content, /updated: 2020-01-01/);
    assert.match(readEvents(p), /feature_field_set/);
  } finally {
    p.cleanup();
  }
});

test("feature set: rice component updates refresh cached rice_score", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", {
      rice_reach: 10,
      rice_impact: 2,
      rice_confidence: 0.8,
      rice_effort: 2,
      rice_score: 8,
    });
    const r = p.run(["feature", "set", "F001", "rice_reach=20", "rice_impact=3", "rice_confidence=0.5", "rice_effort=2"]);
    assert.equal(r.code, 0);
    assert.match(readFeature(p, "F001"), /rice_score: 15/);
  } finally {
    p.cleanup();
  }
});

test("feature set: refuses status/id/title/tasks/references/external_refs with a hint", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    const r = p.run(["feature", "set", "F001", "status=approved"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /set-status/);
    const r2 = p.run(["feature", "set", "F001", "references=foo"]);
    assert.equal(r2.code, 3);
    assert.match(r2.stderr, /add-ref/);
  } finally {
    p.cleanup();
  }
});

test("feature set: rice_effort must be > 0", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    const r = p.run(["feature", "set", "F001", "rice_effort=0"]);
    assert.equal(r.code, 3);
  } finally {
    p.cleanup();
  }
});

test("feature set: story_points must be a positive integer", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    const r = p.run(["feature", "set", "F001", "story_points=-1"]);
    assert.equal(r.code, 3);
  } finally {
    p.cleanup();
  }
});

test("feature set: epic must exist under spec/epics/ or be empty to unassign", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    const missing = p.run(["feature", "set", "F001", "epic=E001"]);
    assert.equal(missing.code, 3);
    writeEpic(p, "E001");
    const ok = p.run(["feature", "set", "F001", "epic=E001"]);
    assert.equal(ok.code, 0);
    assert.match(readFeature(p, "F001"), /epic: E001/);
    const unassign = p.run(["feature", "set", "F001", 'epic=']);
    assert.equal(unassign.code, 0);
  } finally {
    p.cleanup();
  }
});

test("feature set: updated/synced_at must be ISO dates", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    const r = p.run(["feature", "set", "F001", "synced_at=not-a-date"]);
    assert.equal(r.code, 3);
  } finally {
    p.cleanup();
  }
});

// --- feature add-ref / add-external-ref ------------------------------------

test("feature add-ref: containment refusal outside spec/references", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    const outside = join(p.root, "outside.md");
    writeFileSync(outside, "hi");
    const r = p.run(["feature", "add-ref", "F001", outside]);
    assert.equal(r.code, 3);
  } finally {
    p.cleanup();
  }
});

test("feature add-ref: adds inside spec/references and is idempotent", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    const refPath = join(p.dataDir, "spec", "references", "F001-doc.md");
    writeFileSync(refPath, "doc content");
    const r = p.run(["feature", "add-ref", "F001", refPath]);
    assert.equal(r.code, 0);
    assert.match(readFeature(p, "F001"), /references: \[.*F001-doc\.md.*\]/);
    const again = p.run(["feature", "add-ref", "F001", refPath]);
    assert.equal(again.code, 0);
    const content = readFeature(p, "F001");
    assert.equal((content.match(/F001-doc\.md/g) || []).length, 1, "duplicate add-ref is a no-op");
  } finally {
    p.cleanup();
  }
});

test("feature add-external-ref: validates PROJECT-123 / #123 patterns, dedupes", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    const bad = p.run(["feature", "add-external-ref", "F001", "not-a-key"]);
    assert.equal(bad.code, 3);
    const ok = p.run(["feature", "add-external-ref", "F001", "JIRA-42"]);
    assert.equal(ok.code, 0);
    const hashOk = p.run(["feature", "add-external-ref", "F001", "#7"]);
    assert.equal(hashOk.code, 0);
    const again = p.run(["feature", "add-external-ref", "F001", "JIRA-42"]);
    assert.equal(again.code, 0);
    const content = readFeature(p, "F001");
    assert.equal((content.match(/JIRA-42/g) || []).length, 1);
  } finally {
    p.cleanup();
  }
});

// --- backlog add/remove/rank/set --------------------------------------------

test("backlog add: refuses a non-approved feature, naming its actual status", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "proposed" });
    const r = p.run(["backlog", "add", "F001"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /proposed/);
  } finally {
    p.cleanup();
  }
});

test("backlog add: inserts in RICE-descending position and dedupes", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "approved", rice_reach: 1, rice_impact: 1, rice_confidence: 1, rice_effort: 10 }); // low score
    writeFeature(p, "F002", { status: "approved", rice_reach: 100, rice_impact: 2, rice_confidence: 1, rice_effort: 1 }); // high score
    p.run(["backlog", "add", "F001"]);
    p.run(["backlog", "add", "F002"]);
    assert.deepEqual(readBacklogIds(p), ["F002", "F001"]);
    const again = p.run(["backlog", "add", "F001"]);
    assert.equal(again.code, 0);
    assert.deepEqual(readBacklogIds(p), ["F002", "F001"]);
    assert.match(readEvents(p), /backlog_added/);
  } finally {
    p.cleanup();
  }
});

test("backlog remove: idempotent on missing IDs (stderr note, exit 0)", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "approved" });
    p.run(["backlog", "add", "F001"]);
    const r = p.run(["backlog", "remove", "F001", "F999"]);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /F999/);
    assert.deepEqual(readBacklogIds(p), []);
    assert.match(readEvents(p), /backlog_removed/);
  } finally {
    p.cleanup();
  }
});

test("backlog rank: sorts by live RICE desc, sinks missing-RICE items to the bottom", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "approved", rice_reach: 1, rice_impact: 1, rice_confidence: 1, rice_effort: 10 });
    writeFeature(p, "F002", { status: "approved", rice_reach: 100, rice_impact: 2, rice_confidence: 1, rice_effort: 1 });
    writeFeature(p, "F003", { status: "approved", rice_effort: 0 }); // missing/invalid RICE
    p.run(["backlog", "add", "F001", "F002", "F003"]);
    const r = p.run(["backlog", "rank"]);
    assert.equal(r.code, 0);
    const ids = readBacklogIds(p);
    assert.equal(ids[ids.length - 1], "F003", "missing-RICE item sinks to the bottom");
    assert.deepEqual(ids.slice(0, 2), ["F002", "F001"]);
    assert.match(readEvents(p), /backlog_ranked/);
  } finally {
    p.cleanup();
  }
});

test("backlog set last_groomed: allowlist is exactly {last_groomed}, accepts 'today'", () => {
  const p = makeProject();
  try {
    const r = p.run(["backlog", "set", "last_groomed", "today"]);
    assert.equal(r.code, 0);
    const content = readFileSync(join(p.dataDir, "backlog", "BACKLOG.md"), "utf8");
    assert.match(content, new RegExp(`last_groomed: ${new Date().toISOString().slice(0, 10)}`));
    const bad = p.run(["backlog", "set", "other_key", "x"]);
    assert.equal(bad.code, 2);
    assert.match(readEvents(p), /backlog_groomed/);
  } finally {
    p.cleanup();
  }
});

// --- idea set-status --------------------------------------------------------

test("idea set-status: legal transitions to graduated/rejected, illegal refused", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    writeIdea(p, "IDEA-001", "proposed");
    const r = p.run(["idea", "set-status", "IDEA-001", "graduated", "--to", "F001"]);
    assert.equal(r.code, 0);
    assert.match(readEvents(p), /idea_status_changed/);
    writeIdea(p, "IDEA-002", "graduated");
    const bad = p.run(["idea", "set-status", "IDEA-002", "rejected"]);
    assert.equal(bad.code, 3);
  } finally {
    p.cleanup();
  }
});

// --- events: every mutation appends to the event log ------------------------

test("every mutation command appends its named event", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "proposed" });
    writeEpic(p, "E001");
    writeIdea(p, "IDEA-001", "proposed");
    p.run(["feature", "set-status", "F001", "approved"]);
    p.run(["feature", "set", "F001", "epic=E001"]);
    p.run(["backlog", "add", "F001"]);
    p.run(["backlog", "rank"]);
    p.run(["backlog", "set", "last_groomed", "today"]);
    p.run(["backlog", "remove", "F001"]);
    p.run(["idea", "set-status", "IDEA-001", "graduated", "--to", "F001"]);
    const events = readEvents(p);
    for (const type of [
      "feature_status_changed",
      "feature_field_set",
      "backlog_added",
      "backlog_ranked",
      "backlog_groomed",
      "backlog_removed",
      "idea_status_changed",
    ]) {
      assert.match(events, new RegExp(type), `missing event: ${type}`);
    }
  } finally {
    p.cleanup();
  }
});

// --- feature add-dep / remove-dep (wave 2) ----------------------------------

test("feature add-dep: writes both sides atomically and emits one event", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    writeFeature(p, "F002");
    const r = p.run(["feature", "add-dep", "F001", "F002"]);
    assert.equal(r.code, 0);
    assert.match(readFeature(p, "F001"), /dependencies: \[F002\]/);
    assert.match(readFeature(p, "F002"), /dependencies: \[F001\]/);
    assert.match(readEvents(p), /feature_dep_added/);
  } finally {
    p.cleanup();
  }
});

test("feature add-dep: idempotent on a second call", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    writeFeature(p, "F002");
    p.run(["feature", "add-dep", "F001", "F002"]);
    const r = p.run(["feature", "add-dep", "F001", "F002"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no-op/);
  } finally {
    p.cleanup();
  }
});

test("feature add-dep: self-dependency refused", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    const r = p.run(["feature", "add-dep", "F001", "F001"]);
    assert.equal(r.code, 3);
  } finally {
    p.cleanup();
  }
});

test("feature remove-dep: strips both sides", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    writeFeature(p, "F002");
    p.run(["feature", "add-dep", "F001", "F002"]);
    const r = p.run(["feature", "remove-dep", "F001", "F002"]);
    assert.equal(r.code, 0);
    assert.match(readFeature(p, "F001"), /dependencies: \[\]/);
    assert.match(readFeature(p, "F002"), /dependencies: \[\]/);
    assert.match(readEvents(p), /feature_dep_removed/);
  } finally {
    p.cleanup();
  }
});

test("feature add-dep: missing B exits 4", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001");
    const r = p.run(["feature", "add-dep", "F001", "F999"]);
    assert.equal(r.code, 4);
  } finally {
    p.cleanup();
  }
});

// --- feature clear-tasks -----------------------------------------------------

test("feature clear-tasks: empties tasks: and emits count", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { tasks: "[T001, T002]" });
    const r = p.run(["feature", "clear-tasks", "F001"]);
    assert.equal(r.code, 0);
    assert.match(readFeature(p, "F001"), /tasks: \[\]/);
    assert.match(readEvents(p), /"feature_tasks_cleared".*"feature":"F001".*"count":2/);
  } finally {
    p.cleanup();
  }
});

test("feature set-tasks: writes deduped task membership through the CLI-owned path", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { tasks: "[]" });
    writeTask(p, "T001", { feature: "F001" });
    writeTask(p, "T002", { feature: "F001" });
    const r = p.run(["feature", "set-tasks", "F001", "T001,T002"]);
    assert.equal(r.code, 0);
    assert.match(readFeature(p, "F001"), /tasks: \[T001, T002\]/);
    assert.match(readEvents(p), /feature_tasks_set/);
    const dup = p.run(["feature", "set-tasks", "F001", "T001,T001"]);
    assert.equal(dup.code, 3);
  } finally {
    p.cleanup();
  }
});

test("feature set-tasks: refuses missing task references", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { tasks: "[]" });
    const r = p.run(["feature", "set-tasks", "F001", "T999"]);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /refuses missing task T999/);
    assert.match(readFeature(p, "F001"), /tasks: \[\]/);
  } finally {
    p.cleanup();
  }
});

test("feature set-tasks: refuses tasks owned by another feature", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { tasks: "[]" });
    writeFeature(p, "F002", { tasks: "[]" });
    writeTask(p, "T001", { feature: "F002" });
    const r = p.run(["feature", "set-tasks", "F001", "T001"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /task feature is "F002", not "F001"/);
    assert.match(readFeature(p, "F001"), /tasks: \[\]/);
  } finally {
    p.cleanup();
  }
});

// --- idea set-status --to ----------------------------------------------------

test("idea set-status: graduated without --to is refused", () => {
  const p = makeProject();
  try {
    writeIdea(p, "IDEA-001", "proposed");
    const r = p.run(["idea", "set-status", "IDEA-001", "graduated"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /--to/);
  } finally {
    p.cleanup();
  }
});

test("idea set-status: --to naming a missing feature is refused", () => {
  const p = makeProject();
  try {
    writeIdea(p, "IDEA-001", "proposed");
    const r = p.run(["idea", "set-status", "IDEA-001", "graduated", "--to", "F999"]);
    assert.equal(r.code, 3);
  } finally {
    p.cleanup();
  }
});

// --- config set ---------------------------------------------------------------

test("config set product-spec-path: round-trips and refuses unknown keys", () => {
  const p = makeProject();
  try {
    writeFileSync(join(p.dataDir, "config.md"), "---\nconfig_version: 5\n---\n");
    const r = p.run(["config", "set", "product-spec-path", "docs/spec/"]);
    assert.equal(r.code, 0);
    const content = readFileSync(join(p.dataDir, "config.md"), "utf8");
    assert.match(content, /product_spec_path: docs\/spec\//);
    const bad = p.run(["config", "set", "not-a-real-key", "x"]);
    assert.equal(bad.code, 2);
  } finally {
    p.cleanup();
  }
});

test("config set worktree-warm-enabled: writes into the nested worktree_warm block, preserving paths + comment", () => {
  const p = makeProject();
  try {
    writeFileSync(
      join(p.dataDir, "config.md"),
      "---\nconfig_version: 5\nworktree_warm:\n  enabled: false        # opt-in\n  paths: []\n---\n",
    );
    const r = p.run(["config", "set", "worktree-warm-enabled", "true"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "config: worktree_warm.enabled = true");
    const content = readFileSync(join(p.dataDir, "config.md"), "utf8");
    assert.match(content, /worktree_warm:\n\s+enabled: true\s+# opt-in\n\s+paths: \[\]/);
  } finally {
    p.cleanup();
  }
});

test("config set worktree-warm-enabled: refuses a non-boolean value", () => {
  const p = makeProject();
  try {
    writeFileSync(join(p.dataDir, "config.md"), "---\nconfig_version: 5\nworktree_warm:\n  enabled: false\n  paths: []\n---\n");
    const r = p.run(["config", "set", "worktree-warm-enabled", "yes"]);
    assert.equal(r.code, 2);
  } finally {
    p.cleanup();
  }
});

test("config set worktree-warm-paths: comma-separated CLI value renders as a flow-style array", () => {
  const p = makeProject();
  try {
    writeFileSync(join(p.dataDir, "config.md"), "---\nconfig_version: 5\nworktree_warm:\n  enabled: false\n  paths: []\n---\n");
    const r = p.run(["config", "set", "worktree-warm-paths", ".gradle,build,target"]);
    assert.equal(r.code, 0);
    const content = readFileSync(join(p.dataDir, "config.md"), "utf8");
    assert.match(content, /paths: \[".gradle", "build", "target"\]/);
  } finally {
    p.cleanup();
  }
});

test("config set test-commands-rerun-failed: writes into the nested test_commands block", () => {
  const p = makeProject();
  try {
    writeFileSync(
      join(p.dataDir, "config.md"),
      "---\nconfig_version: 5\ntest_commands:\n  unit: \"vitest run\"\n  rerun_failed: \"\"\n---\n",
    );
    const r = p.run(["config", "set", "test-commands-rerun-failed", "--onlyFailures"]);
    assert.equal(r.code, 0);
    const content = readFileSync(join(p.dataDir, "config.md"), "utf8");
    assert.match(content, /rerun_failed: --onlyFailures/);
    // sibling key inside the same block must survive untouched
    assert.match(content, /unit: "vitest run"/);
  } finally {
    p.cleanup();
  }
});

test("config set worktree-warm-enabled: creates the worktree_warm block when absent (pre-P4 config.md)", () => {
  const p = makeProject();
  try {
    writeFileSync(join(p.dataDir, "config.md"), "---\nconfig_version: 5\n---\n");
    const r = p.run(["config", "set", "worktree-warm-enabled", "true"]);
    assert.equal(r.code, 0);
    const content = readFileSync(join(p.dataDir, "config.md"), "utf8");
    assert.match(content, /worktree_warm:\n\s+enabled: true/);
  } finally {
    p.cleanup();
  }
});

// --- child / sub-feature ids (F071d) ---------------------------------------
//
// `F001a`/`F001b` sub-features are a documented split convention
// (project-files/rules/shipyard-spec.md, ship-discuss's 200-line limit), but
// FID_RE only accepted `F\d{3}` — so `backlog add F071d` was refused and one
// real project's BACKLOG.md logged seven hand-worked-around instances.

test("backlog add: accepts a child feature id (F071d)", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F071d", { status: "approved" });
    const r = p.run(["backlog", "add", "F071d"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readBacklogIds(p), ["F071d"]);
  } finally {
    p.cleanup();
  }
});

test("feature set-status / set: accept a child feature id", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F036a", { status: "proposed" });
    assert.equal(p.run(["feature", "set-status", "F036a", "approved"]).code, 0);
    assert.match(readFeature(p, "F036a"), /status: approved/);
    assert.equal(p.run(["feature", "set", "F036a", "story_points=5"]).code, 0);
    assert.match(readFeature(p, "F036a"), /story_points: 5/);
  } finally {
    p.cleanup();
  }
});

test("feature id validation still rejects genuinely malformed ids", () => {
  const p = makeProject();
  try {
    for (const bad of ["F71d", "F071dd", "F071D", "F0711", "NOT-AN-ID"]) {
      const r = p.run(["backlog", "add", bad]);
      assert.equal(r.code, 2, `${bad} should be a usage error, got ${r.code}`);
    }
  } finally {
    p.cleanup();
  }
});

test("backlog add/rank: a malformed PRE-EXISTING row warns instead of blocking the whole index", () => {
  const p = makeProject();
  try {
    // Seed the index with a row no validator accepts. Before the fix,
    // readFeatureRice hard-failed on it while scoring EVERY existing row, so
    // one bad row refused every future add and every re-rank.
    const backlogFile = join(p.dataDir, "backlog", "BACKLOG.md");
    writeFileSync(
      backlogFile,
      readFileSync(backlogFile, "utf8").replace("|------|----|", "|------|----|\n| 1 | NOT-AN-ID |"),
    );
    writeFeature(p, "F002", { status: "approved" });

    const add = p.run(["backlog", "add", "F002"]);
    assert.equal(add.code, 0, add.stderr);
    assert.match(add.stderr, /unrecognized id: NOT-AN-ID/);
    assert.ok(readBacklogIds(p).includes("F002"));
    // Kept, not silently dropped — and sunk below the scoreable rows.
    assert.deepEqual(readBacklogIds(p), ["F002", "NOT-AN-ID"]);

    const rank = p.run(["backlog", "rank"]);
    assert.equal(rank.code, 0, rank.stderr);
    assert.match(rank.stderr, /unrecognized id: NOT-AN-ID/);
  } finally {
    p.cleanup();
  }
});

// --- false-green exit codes -------------------------------------------------

test("feature set-status: an unknown status is refused even with --force", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "proposed" });
    // --force overrides the transition GRAPH, never the status vocabulary.
    // This used to write `status: bogus` into the feature file and exit 0.
    const r = p.run(["feature", "set-status", "F001", "bogus", "--force"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown feature status "bogus"/);
    assert.match(readFeature(p, "F001"), /status: proposed/);
  } finally {
    p.cleanup();
  }
});

test("feature set-status: a flag is never read as the status positional", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "proposed" });
    // `set-status F001 --force approved` used to bind toStatus="--force" and,
    // waved past the graph by --force itself, write `status: --force` + exit 0.
    const r = p.run(["feature", "set-status", "F001", "--force", "approved"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFeature(p, "F001"), /status: approved/);
    assert.doesNotMatch(readFeature(p, "F001"), /status: --force/);
  } finally {
    p.cleanup();
  }
});

test("backlog remove: exits non-zero when NONE of the named ids were present", () => {
  const p = makeProject();
  try {
    writeFeature(p, "F001", { status: "approved" });
    assert.equal(p.run(["backlog", "add", "F001"]).code, 0);

    // All-missing: previously printed an error AND `removed (none)` at exit 0,
    // indistinguishable from a real removal to an exit-code-checking caller.
    const none = p.run(["backlog", "remove", "F900"]);
    assert.equal(none.code, 4);
    assert.deepEqual(readBacklogIds(p), ["F001"]);

    // Partial hit stays successful (per-id removal is idempotent) but says so.
    const partial = p.run(["backlog", "remove", "F001", "F900"]);
    assert.equal(partial.code, 0, partial.stderr);
    assert.match(partial.stderr, /not present \(no-op\): F900/);
    assert.deepEqual(readBacklogIds(p), []);
  } finally {
    p.cleanup();
  }
});
