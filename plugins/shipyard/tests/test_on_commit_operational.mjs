/**
 * Unit tests for emitOperationalTaskPassedEvents in bin/hooks/on-commit.mjs.
 *
 * Purpose: verify the diagnostic event `operational_task_passed` fires for
 * every operational task being committed with a populated verify_output
 * field, and does NOT fire for feature tasks, non-task files, or operational
 * tasks lacking verify_output. The absence of this event for a task that is
 * marked done is the smoking-gun signal of the silent-pass bug — so we need
 * to be precise about when it fires.
 *
 * Run via:  node --test tests/test_on_commit_operational.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isTaskFile,
  parseTaskFrontmatter,
  emitOperationalTaskPassedEvents,
} from "../bin/hooks/on-commit.mjs";
import { EVENTS_LOG_NAME } from "../bin/_hook_lib.mjs";

// ---- isTaskFile / parseTaskFrontmatter sanity (light coverage — full in tdd-check tests) ----

test("on-commit isTaskFile: matches spec/tasks/T001.md", () => {
  assert.equal(isTaskFile("spec/tasks/T001.md"), true);
});

test("on-commit parseTaskFrontmatter: reads kind and status", () => {
  const fm = parseTaskFrontmatter("---\nkind: operational\nstatus: done\n---\n");
  assert.equal(fm.kind, "operational");
  assert.equal(fm.status, "done");
});

// ---- emitOperationalTaskPassedEvents ----

function makeTmpProject() {
  const dir = mkdtempSync(join(tmpdir(), "shipyard-on-commit-op-"));
  mkdirSync(join(dir, "spec", "tasks"), { recursive: true });
  return dir;
}

function writeTaskFile(projectDir, name, frontmatterBody) {
  const path = join(projectDir, "spec", "tasks", name);
  writeFileSync(path, `---\n${frontmatterBody}\n---\n\n# Body\n`, "utf8");
  return path;
}

function readEvents(dataDir) {
  const eventsPath = join(dataDir, EVENTS_LOG_NAME);
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("emitOperationalTaskPassedEvents: empty committed set → no events", () => {
  const dataDir = makeTmpProject();
  try {
    emitOperationalTaskPassedEvents(new Set(), dataDir);
    assert.deepEqual(readEvents(dataDir), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("emitOperationalTaskPassedEvents: non-task files ignored", () => {
  const dataDir = makeTmpProject();
  try {
    emitOperationalTaskPassedEvents(
      new Set(["src/main.ts", "README.md", "package.json"]),
      dataDir,
    );
    assert.deepEqual(readEvents(dataDir), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("emitOperationalTaskPassedEvents: feature task committed → no event", () => {
  const dataDir = makeTmpProject();
  try {
    const p = writeTaskFile(
      dataDir,
      "T001-feature.md",
      "id: T001\nkind: feature\nstatus: done",
    );
    emitOperationalTaskPassedEvents(new Set([p]), dataDir);
    assert.deepEqual(readEvents(dataDir), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("emitOperationalTaskPassedEvents: operational + done + verify_output → emits event", () => {
  const dataDir = makeTmpProject();
  try {
    const p = writeTaskFile(
      dataDir,
      "T007-e2e.md",
      "id: T007\nkind: operational\nstatus: done\nverify_output: T007-verify-iter2",
    );
    emitOperationalTaskPassedEvents(new Set([p]), dataDir);
    const events = readEvents(dataDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "operational_task_passed");
    assert.equal(events[0].capture, "T007-verify-iter2");
    assert.ok(events[0].task_file.endsWith("T007-e2e.md"));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("emitOperationalTaskPassedEvents: operational + done + NO verify_output → no event", () => {
  // This is the case tdd-check.mjs should have blocked earlier. If it somehow
  // got through, on-commit should NOT emit a spurious operational_task_passed
  // event — the task is in the silent-pass state, not the passed state.
  const dataDir = makeTmpProject();
  try {
    const p = writeTaskFile(
      dataDir,
      "T007-e2e.md",
      "id: T007\nkind: operational\nstatus: done",
    );
    emitOperationalTaskPassedEvents(new Set([p]), dataDir);
    assert.deepEqual(readEvents(dataDir), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("emitOperationalTaskPassedEvents: operational + in-progress → no event", () => {
  const dataDir = makeTmpProject();
  try {
    const p = writeTaskFile(
      dataDir,
      "T007-e2e.md",
      "id: T007\nkind: operational\nstatus: in-progress\nverify_output: T007-verify-iter1",
    );
    emitOperationalTaskPassedEvents(new Set([p]), dataDir);
    assert.deepEqual(readEvents(dataDir), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("emitOperationalTaskPassedEvents: multiple operational tasks in one commit → one event each", () => {
  const dataDir = makeTmpProject();
  try {
    const p1 = writeTaskFile(
      dataDir,
      "T007-e2e.md",
      "id: T007\nkind: operational\nstatus: done\nverify_output: T007-verify-iter1",
    );
    const p2 = writeTaskFile(
      dataDir,
      "T008-audit.md",
      "id: T008\nkind: operational\nstatus: done\nverify_output: T008-verify-iter1",
    );
    emitOperationalTaskPassedEvents(new Set([p1, p2]), dataDir);
    const events = readEvents(dataDir);
    assert.equal(events.length, 2);
    const captures = events.map((e) => e.capture).sort();
    assert.deepEqual(captures, ["T007-verify-iter1", "T008-verify-iter1"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("emitOperationalTaskPassedEvents: nonexistent task file is skipped gracefully", () => {
  const dataDir = makeTmpProject();
  try {
    emitOperationalTaskPassedEvents(
      new Set([join(dataDir, "spec", "tasks", "T999-ghost.md")]),
      dataDir,
    );
    assert.deepEqual(readEvents(dataDir), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
