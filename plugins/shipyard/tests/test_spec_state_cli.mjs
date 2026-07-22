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
import { dirname, join } from "node:path";
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
  const dataDir = run(["init"]).stdout.trim();
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
    writeFileSync(join(p.dataDir, "config.md"), "---\nconfig_version: 4\n---\n");
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
