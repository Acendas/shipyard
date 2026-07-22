/**
 * Tests for the v3.6.0 (wave 2) task-state CLI:
 *   bin/spec-state-cli.mjs — `shipyard-data task set-status|append-verify`
 *
 * Same subprocess-against-shipyard-data.mjs pattern as
 * test_spec_state_cli.mjs / test_cursor_cli.mjs.
 *
 * Run: node --test tests/test_task_state_cli.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, "bin", "shipyard-data.mjs");

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "task-state-cli-test-"));
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(data, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  delete env.SHIPYARD_DATA;
  const run = (args) => {
    const result = spawnSync("node", [CLI, ...args], { cwd: repo, env, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const dataDir = run(["init"]).stdout.trim();
  return { root, repo, dataDir, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeTask(p, tid, overrides = {}) {
  const fm = {
    id: tid,
    title: "Test Task",
    type: "task",
    kind: "feature",
    feature: "F001",
    status: "approved",
    effort: "S",
    dependencies: "[]",
    external_refs: "[]",
    created: "2026-01-01",
    ...overrides,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  const content = `---\n${lines.join("\n")}\n---\n\n# Test Task\n`;
  writeFileSync(join(p.dataDir, "spec", "tasks", `${tid}-test.md`), content);
}

function readTask(p, tid) {
  return readFileSync(join(p.dataDir, "spec", "tasks", `${tid}-test.md`), "utf8");
}

function readEvents(p) {
  return readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
}

// --- task set-status ---------------------------------------------------------

test("task set-status: legal set writes status + emits task_status_set", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { status: "pending" });
    const r = p.run(["task", "set-status", "T001", "in-progress"]);
    assert.equal(r.code, 0);
    assert.match(readTask(p, "T001"), /status: in-progress/);
    assert.match(readEvents(p), /task_status_set/);
  } finally {
    p.cleanup();
  }
});

test("task set-status: blocked without --reason is refused", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { status: "in-progress" });
    const r = p.run(["task", "set-status", "T001", "blocked"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /--reason/);
  } finally {
    p.cleanup();
  }
});

test("task set-status: blocked writes blocked_reason + blocked_since AND emits task_blocked", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { status: "in-progress" });
    const r = p.run(["task", "set-status", "T001", "blocked", "--reason", "waiting on API key"]);
    assert.equal(r.code, 0);
    const content = readTask(p, "T001");
    assert.match(content, /blocked_reason: "waiting on API key"/);
    assert.match(content, /blocked_since: "\d{4}-\d{2}-\d{2}T/);
    const events = readEvents(p);
    assert.match(events, /"task_status_set".*"to":"blocked".*"reason":"waiting on API key"/);
    assert.match(events, /"task_blocked".*"task":"T001".*"reason":"waiting on API key"/);
  } finally {
    p.cleanup();
  }
});

test("task set-status: unblocking clears blocked_reason/blocked_since", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { status: "in-progress" });
    p.run(["task", "set-status", "T001", "blocked", "--reason", "flaky env"]);
    const r = p.run(["task", "set-status", "T001", "approved"]);
    assert.equal(r.code, 0);
    const content = readTask(p, "T001");
    assert.doesNotMatch(content, /blocked_reason:/);
    assert.doesNotMatch(content, /blocked_since:/);
  } finally {
    p.cleanup();
  }
});

test("task set-status: done is terminal — leaving without --force is refused, with --force succeeds", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { status: "done" });
    const blocked = p.run(["task", "set-status", "T001", "approved"]);
    assert.equal(blocked.code, 3);
    const forced = p.run(["task", "set-status", "T001", "approved", "--force"]);
    assert.equal(forced.code, 0);
    assert.match(readTask(p, "T001"), /status: approved/);
  } finally {
    p.cleanup();
  }
});

test("task set-status: unknown task id exits 4", () => {
  const p = makeProject();
  try {
    const r = p.run(["task", "set-status", "T999", "done"]);
    assert.equal(r.code, 4);
  } finally {
    p.cleanup();
  }
});

test("task set-status: unknown status value exits 2 (usage)", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001");
    const r = p.run(["task", "set-status", "T001", "not-a-status"]);
    assert.equal(r.code, 2);
  } finally {
    p.cleanup();
  }
});

// --- task append-verify --------------------------------------------------------

test("task append-verify: appends a structurally-parseable block entry", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { kind: "operational" });
    const r = p.run([
      "task",
      "append-verify",
      "T001",
      "iteration=1",
      "command=npm test",
      "exit=0",
      "capture=captures/T001/run-1.log",
    ]);
    assert.equal(r.code, 0);
    const content = readTask(p, "T001");
    assert.match(content, /verify_history:\n\s*- iteration: 1/);
    assert.match(content, /command: "npm test"/);
    assert.match(content, /exit: 0/);
    assert.match(content, /capture: "captures\/T001\/run-1\.log"/);
    assert.match(content, /at: "\d{4}-\d{2}-\d{2}T/);
    assert.match(readEvents(p), /task_verify_appended/);
  } finally {
    p.cleanup();
  }
});

test("task append-verify: duplicate iteration is refused", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { kind: "operational" });
    p.run(["task", "append-verify", "T001", "iteration=1", "command=npm test", "exit=0", "capture=captures/T001/run-1.log"]);
    const r = p.run(["task", "append-verify", "T001", "iteration=1", "command=npm test", "exit=1", "capture=captures/T001/run-1b.log"]);
    assert.equal(r.code, 3);
  } finally {
    p.cleanup();
  }
});

test("task append-verify: second iteration appends after the first (both present)", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { kind: "operational" });
    p.run(["task", "append-verify", "T001", "iteration=1", "command=npm test", "exit=1", "capture=captures/T001/run-1.log"]);
    const r = p.run(["task", "append-verify", "T001", "iteration=2", "command=npm test", "exit=0", "capture=captures/T001/run-2.log"]);
    assert.equal(r.code, 0);
    const content = readTask(p, "T001");
    assert.match(content, /- iteration: 1/);
    assert.match(content, /- iteration: 2/);
  } finally {
    p.cleanup();
  }
});

test("task append-verify: at= defaults to now when omitted", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { kind: "operational" });
    p.run(["task", "append-verify", "T001", "iteration=1", "command=npm test", "exit=0", "capture=captures/T001/run-1.log"]);
    const content = readTask(p, "T001");
    assert.match(content, /at: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    p.cleanup();
  }
});

test("task append-verify: non-integer exit is refused", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { kind: "operational" });
    const r = p.run(["task", "append-verify", "T001", "iteration=1", "command=npm test", "exit=not-a-number", "capture=captures/T001/run-1.log"]);
    assert.equal(r.code, 3);
  } finally {
    p.cleanup();
  }
});

// --- task set-status needs-attention (wave 2 follow-up) ---------------------

test("task set-status: needs-attention requires --reason, does NOT auto-emit task_blocked", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { status: "in-progress" });
    const missing = p.run(["task", "set-status", "T001", "needs-attention"]);
    assert.equal(missing.code, 3);
    assert.match(missing.stderr, /--reason/);
    const r = p.run(["task", "set-status", "T001", "needs-attention", "--reason", "persistent_failure"]);
    assert.equal(r.code, 0);
    const events = readEvents(p);
    assert.match(events, /"task_status_set".*"to":"needs-attention".*"reason":"persistent_failure"/);
    assert.doesNotMatch(events, /"task_blocked"/, "needs-attention must not auto-emit task_blocked (documented as distinct from blocked)");
  } finally {
    p.cleanup();
  }
});

test("task set-status: needs-attention writes attention_reason/attention_since, and leaving it clears them", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { status: "in-progress" });
    p.run(["task", "set-status", "T001", "needs-attention", "--reason", "presumed_dead"]);
    const content = readTask(p, "T001");
    assert.match(content, /attention_reason: "presumed_dead"/);
    assert.match(content, /attention_since: "\d{4}-\d{2}-\d{2}T/);
    const r = p.run(["task", "set-status", "T001", "approved"]);
    assert.equal(r.code, 0);
    const after = readTask(p, "T001");
    assert.doesNotMatch(after, /attention_reason:/);
    assert.doesNotMatch(after, /attention_since:/);
  } finally {
    p.cleanup();
  }
});

test("task set-status: done is terminal even when the destination is needs-attention (still requires --force)", () => {
  const p = makeProject();
  try {
    writeTask(p, "T001", { status: "done" });
    const blocked = p.run(["task", "set-status", "T001", "needs-attention", "--reason", "salvage_failed"]);
    assert.equal(blocked.code, 3);
    const forced = p.run(["task", "set-status", "T001", "needs-attention", "--reason", "salvage_failed", "--force"]);
    assert.equal(forced.code, 0);
    assert.match(readTask(p, "T001"), /status: needs-attention/);
  } finally {
    p.cleanup();
  }
});
