/**
 * Unit tests for the operational-task silent-pass guard in bin/hooks/tdd-check.mjs.
 *
 * These tests exercise the exact failure mode that motivated the fix: an
 * operational-shaped task being marked done without captured evidence of a
 * passing verify command. The hook is the last line of defense — if the skill
 * router drifts and the builder guard drifts, the hook still blocks the bad
 * commit.
 *
 * Run via:  node --test tests/test_tdd_check_operational.mjs
 *
 * Tests call the helper functions directly rather than invoking `run()`
 * with a staged git index, because the helpers have no git dependency and
 * the goal is to pin the classification logic. End-to-end `run()` coverage
 * lives in the integration tests once those exist.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isTaskFile,
  parseTaskFrontmatter,
  checkOperationalTaskFiles,
} from "../bin/hooks/tdd-check.mjs";
import { EVENTS_LOG_NAME } from "../bin/_hook_lib.mjs";

// ---- isTaskFile ----

test("isTaskFile: matches spec/tasks/T001-foo.md", () => {
  assert.equal(isTaskFile("spec/tasks/T001-foo.md"), true);
});

test("isTaskFile: matches .shipyard/spec/tasks/T001.md", () => {
  assert.equal(isTaskFile(".shipyard/spec/tasks/T001.md"), true);
});

test("isTaskFile: matches absolute path with spec/tasks segment", () => {
  assert.equal(isTaskFile("/Users/foo/data/projects/abc/spec/tasks/T007-e2e.md"), true);
});

test("isTaskFile: rejects spec/features/F001.md", () => {
  assert.equal(isTaskFile("spec/features/F001.md"), false);
});

test("isTaskFile: rejects spec/tasks/README.txt (wrong extension)", () => {
  assert.equal(isTaskFile("spec/tasks/README.txt"), false);
});

test("isTaskFile: rejects bare README.md at repo root", () => {
  assert.equal(isTaskFile("README.md"), false);
});

test("isTaskFile: Windows backslash path accepted", () => {
  assert.equal(isTaskFile("spec\\tasks\\T001.md"), true);
});

// ---- parseTaskFrontmatter ----

test("parseTaskFrontmatter: returns {} for no frontmatter", () => {
  assert.deepEqual(parseTaskFrontmatter("# just markdown"), {});
});

test("parseTaskFrontmatter: reads scalar string fields", () => {
  const content = `---
id: T007
kind: operational
status: done
verify_command: test_commands.e2e
---

# Body
`;
  const fm = parseTaskFrontmatter(content);
  assert.equal(fm.id, "T007");
  assert.equal(fm.kind, "operational");
  assert.equal(fm.status, "done");
  assert.equal(fm.verify_command, "test_commands.e2e");
});

test("parseTaskFrontmatter: strips double quotes", () => {
  const content = `---
title: "Run E2E suite"
---
`;
  const fm = parseTaskFrontmatter(content);
  assert.equal(fm.title, "Run E2E suite");
});

test("parseTaskFrontmatter: strips single quotes", () => {
  const content = `---
title: 'Run E2E suite'
---
`;
  const fm = parseTaskFrontmatter(content);
  assert.equal(fm.title, "Run E2E suite");
});

test("parseTaskFrontmatter: treats bare-comment value as empty", () => {
  const content = `---
verify_output: # populated later
---
`;
  const fm = parseTaskFrontmatter(content);
  assert.equal(fm.verify_output, "");
});

test("parseTaskFrontmatter: ignores malformed lines", () => {
  const content = `---
id: T007
this is not a valid line
kind: operational
---
`;
  const fm = parseTaskFrontmatter(content);
  assert.equal(fm.id, "T007");
  assert.equal(fm.kind, "operational");
});

// ---- checkOperationalTaskFiles ----

function makeTmpProject() {
  const dir = mkdtempSync(join(tmpdir(), "shipyard-tdd-op-"));
  mkdirSync(join(dir, "spec", "tasks"), { recursive: true });
  return dir;
}

function writeTaskFile(projectDir, name, frontmatterBody) {
  const path = join(projectDir, "spec", "tasks", name);
  writeFileSync(path, `---\n${frontmatterBody}\n---\n\n# Body\n`, "utf8");
  return path;
}

test("checkOperationalTaskFiles: empty staged list → no block, no event", () => {
  const dataDir = makeTmpProject();
  try {
    const result = checkOperationalTaskFiles([], dataDir);
    assert.equal(result.block, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("checkOperationalTaskFiles: feature task marked done → no block", () => {
  const dataDir = makeTmpProject();
  try {
    const taskPath = writeTaskFile(
      dataDir,
      "T001-feature.md",
      "id: T001\nkind: feature\nstatus: done",
    );
    const result = checkOperationalTaskFiles([taskPath], dataDir);
    assert.equal(result.block, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("checkOperationalTaskFiles: operational + done + no verify_output → BLOCK", () => {
  const dataDir = makeTmpProject();
  try {
    const taskPath = writeTaskFile(
      dataDir,
      "T007-e2e.md",
      "id: T007\nkind: operational\nstatus: done",
    );
    const result = checkOperationalTaskFiles([taskPath], dataDir);
    assert.equal(result.block, true, "silent-pass must be blocked");
    assert.match(result.message, /SILENT-PASS BLOCKED/);
    assert.match(result.message, /verify_output/);
    assert.match(result.message, /T007-e2e\.md/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("checkOperationalTaskFiles: BLOCK case emits operational_task_silent_pass_blocked event", () => {
  const dataDir = makeTmpProject();
  try {
    const taskPath = writeTaskFile(
      dataDir,
      "T007-e2e.md",
      "id: T007\nkind: operational\nstatus: done",
    );
    checkOperationalTaskFiles([taskPath], dataDir);
    const eventsPath = join(dataDir, EVENTS_LOG_NAME);
    assert.equal(existsSync(eventsPath), true, "events log should exist");
    const lines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.type, "operational_task_silent_pass_blocked");
    assert.ok(event.task_file.endsWith("T007-e2e.md"));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("checkOperationalTaskFiles: operational + done + verify_output populated → no block", () => {
  const dataDir = makeTmpProject();
  try {
    const taskPath = writeTaskFile(
      dataDir,
      "T007-e2e.md",
      "id: T007\nkind: operational\nstatus: done\nverify_output: T007-verify-iter2",
    );
    const result = checkOperationalTaskFiles([taskPath], dataDir);
    assert.equal(result.block, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("checkOperationalTaskFiles: operational + in-progress → no block (not yet done)", () => {
  const dataDir = makeTmpProject();
  try {
    const taskPath = writeTaskFile(
      dataDir,
      "T007-e2e.md",
      "id: T007\nkind: operational\nstatus: in-progress",
    );
    const result = checkOperationalTaskFiles([taskPath], dataDir);
    assert.equal(result.block, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("checkOperationalTaskFiles: legacy task (no kind) + done → warn via event, do NOT block", () => {
  const dataDir = makeTmpProject();
  try {
    const taskPath = writeTaskFile(
      dataDir,
      "T001-legacy.md",
      "id: T001\nstatus: done",
    );
    const result = checkOperationalTaskFiles([taskPath], dataDir);
    assert.equal(result.block, false, "legacy tasks must not block for backwards compat");
    const eventsPath = join(dataDir, EVENTS_LOG_NAME);
    assert.equal(existsSync(eventsPath), true);
    const lines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.type, "legacy_task_no_kind");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("checkOperationalTaskFiles: mixed staged list — feature ok, operational bad → BLOCK on bad one", () => {
  const dataDir = makeTmpProject();
  try {
    const okPath = writeTaskFile(
      dataDir,
      "T001-feature.md",
      "id: T001\nkind: feature\nstatus: done",
    );
    const badPath = writeTaskFile(
      dataDir,
      "T007-e2e.md",
      "id: T007\nkind: operational\nstatus: done",
    );
    const result = checkOperationalTaskFiles([okPath, badPath], dataDir);
    assert.equal(result.block, true);
    assert.match(result.message, /T007-e2e/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("checkOperationalTaskFiles: unreadable file is skipped, not crashed", () => {
  const dataDir = makeTmpProject();
  try {
    // Reference a task file that doesn't exist on disk (staged-for-delete case)
    const result = checkOperationalTaskFiles(
      [join(dataDir, "spec", "tasks", "T999-ghost.md")],
      dataDir,
    );
    assert.equal(result.block, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("checkOperationalTaskFiles: non-task files ignored entirely", () => {
  const dataDir = makeTmpProject();
  try {
    const result = checkOperationalTaskFiles(
      ["src/main.ts", "README.md", "package.json"],
      dataDir,
    );
    assert.equal(result.block, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
