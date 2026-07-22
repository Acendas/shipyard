/**
 * Tests for the v3.7.0 skill-lock CLI:
 *   bin/skill-lock.mjs — `shipyard-data lock acquire|release|check|status`
 *
 * Same subprocess-against-shipyard-data.mjs pattern as
 * test_spec_state_cli.mjs / test_task_state_cli.mjs.
 *
 * Run: node --test tests/test_skill_lock_cli.mjs
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
  const root = mkdtempSync(join(tmpdir(), "skill-lock-cli-test-"));
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(data, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  delete env.SHIPYARD_DATA;
  delete env.CLAUDE_SESSION_ID;
  const run = (args, envOverride = {}) => {
    const result = spawnSync("node", [CLI, ...args], { cwd: repo, env: { ...env, ...envOverride }, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const dataDir = run(["init"]).stdout.trim();
  return { root, repo, dataDir, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function readLock(p, kind) {
  const base = kind === "planning" ? ".active-session.json" : ".active-execution.json";
  return JSON.parse(readFileSync(join(p.dataDir, base), "utf8"));
}

function readEvents(p) {
  return readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
}

function stdoutJson(r) {
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

// --- init pre-creates released sentinels ------------------------------------

test("init pre-creates a released sentinel for both lock kinds", () => {
  const p = makeProject();
  try {
    const planning = readLock(p, "planning");
    const execution = readLock(p, "execution");
    assert.equal(planning.skill, null);
    assert.equal(execution.skill, null);
    assert.ok(planning.cleared);
    assert.ok(execution.cleared);
  } finally {
    p.cleanup();
  }
});

// --- acquire: free / released --------------------------------------------------

test("acquire: free/released lock acquires cleanly with depth:1", () => {
  const p = makeProject();
  try {
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.acquired, true);
    assert.equal(json.reentry, false);
    assert.equal(json.depth, 1);
    const lock = readLock(p, "planning");
    assert.equal(lock.skill, "ship-discuss");
    assert.equal(lock.session_id, "sessA");
    assert.equal(lock.depth, 1);
    assert.equal("compaction_count" in lock, false, "compaction_count must not be in the new shape");
  } finally {
    p.cleanup();
  }
});

// --- acquire: reentry ------------------------------------------------------

test("acquire: same-session reentry bumps depth and reports reentry:true", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.acquired, true);
    assert.equal(json.reentry, true);
    assert.equal(json.depth, 2);
    assert.equal(readLock(p, "planning").depth, 2);
  } finally {
    p.cleanup();
  }
});

// --- acquire: stale recovery -------------------------------------------------

test("acquire: stale lock (>2h) is recovered and emits stale_lock_recovered", () => {
  const p = makeProject();
  try {
    const staleStarted = new Date(Date.now() - 3 * 3600000).toISOString();
    writeFileSync(
      join(p.dataDir, ".active-session.json"),
      JSON.stringify({ skill: "ship-sprint", sprint: null, wave: null, started: staleStarted, session_id: "oldsess", cleared: null, depth: 1 }),
    );
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /recovered stale/);
    const json = stdoutJson(r);
    assert.equal(json.recovered, "stale");
    assert.equal(readLock(p, "planning").skill, "ship-discuss");
    const events = readEvents(p);
    assert.match(events, /"stale_lock_recovered".*"prior_skill":"ship-sprint"/);
  } finally {
    p.cleanup();
  }
});

// --- acquire: corrupt recovery ------------------------------------------------

test("acquire: corrupt JSON is recovered and emits corrupt_lock_recovered with a sanitized raw tail", () => {
  const p = makeProject();
  try {
    writeFileSync(join(p.dataDir, ".active-session.json"), "{not valid json at all");
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /recovered corrupt/);
    const json = stdoutJson(r);
    assert.equal(json.recovered, "corrupt");
    const events = readEvents(p);
    assert.match(events, /"corrupt_lock_recovered"/);
    assert.match(events, /"raw_tail":"\{not valid json at all"/);
  } finally {
    p.cleanup();
  }
});

// --- acquire: held by another fresh session --------------------------------

test("acquire: held by another fresh session exits 3 with block text and blocked JSON", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessB"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /⛔ Another planning session is active/);
    assert.match(r.stderr, /ship-discuss/);
    const json = stdoutJson(r);
    assert.equal(json.acquired, false);
    assert.equal(json.blocked.skill, "ship-discuss");
  } finally {
    p.cleanup();
  }
});

// --- cross-lock guard --------------------------------------------------------

test("cross-lock guard: acquiring execution while planning is held by a different fresh session is blocked", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    const r = p.run(["lock", "acquire", "execution", "--skill", "ship-execute", "--session", "sessB"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /planning session is active/);
  } finally {
    p.cleanup();
  }
});

test("cross-lock guard: same session on the other lock proceeds and flags cross_lock_same_session", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    const r = p.run(["lock", "acquire", "execution", "--skill", "ship-execute", "--session", "sessA"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.acquired, true);
    assert.equal(json.cross_lock_same_session, true);
  } finally {
    p.cleanup();
  }
});

test("cross-lock guard: both locks held by (different) strangers reports both and hints /ship-status", () => {
  const p = makeProject();
  try {
    // The guard structurally prevents this state from arising through two
    // sequential CLI acquires (the second would always be blocked by the
    // first via the cross-lock check) — it can only arise from a legacy/
    // hand-written lock file or a race between two concurrent first-time
    // acquires on the two DIFFERENT kind-specific meta-locks. Simulate that
    // by writing both lock files directly, then attempting a third acquire.
    const now = new Date().toISOString();
    writeFileSync(
      join(p.dataDir, ".active-session.json"),
      JSON.stringify({ skill: "ship-discuss", sprint: null, wave: null, started: now, session_id: "sessA", cleared: null, depth: 1 }),
    );
    writeFileSync(
      join(p.dataDir, ".active-execution.json"),
      JSON.stringify({ skill: "ship-execute", sprint: null, wave: null, started: now, session_id: "sessB", cleared: null, depth: 1 }),
    );
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessC"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /ship-discuss/);
    assert.match(r.stderr, /ship-execute/);
    assert.match(r.stderr, /\/ship-status to clear/);
    const json = stdoutJson(r);
    assert.equal(Array.isArray(json.blocked), true);
    assert.equal(json.blocked.length, 2);
  } finally {
    p.cleanup();
  }
});

// --- release: decrement / sentinel / no-op / idempotent / force ---------------

test("release: depth > 1 only decrements, does not release", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]); // depth 2
    const r = p.run(["lock", "release", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.released, false);
    assert.equal(json.depth, 1);
    assert.equal(readLock(p, "planning").skill, "ship-discuss", "still held at depth 1");
  } finally {
    p.cleanup();
  }
});

test("release: depth 1 writes the sentinel and emits skill_lock_released", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    const r = p.run(["lock", "release", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.released, true);
    const lock = readLock(p, "planning");
    assert.equal(lock.skill, null);
    assert.ok(lock.cleared);
    assert.match(readEvents(p), /"skill_lock_released"/);
  } finally {
    p.cleanup();
  }
});

test("release: held by another session is a no-op (exit 0, reason held_by_other)", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    const r = p.run(["lock", "release", "planning", "--skill", "ship-discuss", "--session", "sessB"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.released, false);
    assert.equal(json.reason, "held_by_other");
    assert.equal(readLock(p, "planning").skill, "ship-discuss", "not released by a stranger's request");
  } finally {
    p.cleanup();
  }
});

test("release: already-released/missing lock is idempotent (exit 0)", () => {
  const p = makeProject();
  try {
    const r = p.run(["lock", "release", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    assert.equal(r.code, 0);
    assert.equal(stdoutJson(r).released, true);
  } finally {
    p.cleanup();
  }
});

test("release: --force writes the sentinel regardless of holder", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    const r = p.run(["lock", "release", "planning", "--force", "--session", "sessB"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.released, true);
    assert.equal(json.forced, true);
    assert.equal(readLock(p, "planning").skill, null);
    assert.match(readEvents(p), /"skill_lock_released".*"forced":true/);
  } finally {
    p.cleanup();
  }
});

// --- session-unverified asymmetric degradation --------------------------------

test("session-unverified: acquire treats a fresh held lock as held-by-other even with a matching (null) session_id", () => {
  const p = makeProject();
  try {
    // First acquire also unverified (no --session, no CLAUDE_SESSION_ID) -> session_id stored as null.
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss"]);
    // Second unverified acquire must NOT treat this as "mine" just because both have session_id null.
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /⛔/);
  } finally {
    p.cleanup();
  }
});

test("session-unverified: release still succeeds when --skill matches the held lock's skill", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss"]);
    const r = p.run(["lock", "release", "planning", "--skill", "ship-discuss"]);
    assert.equal(r.code, 0);
    assert.equal(stdoutJson(r).released, true);
    assert.equal(readLock(p, "planning").skill, null);
  } finally {
    p.cleanup();
  }
});

// --- check / status (read-only) ------------------------------------------------

test("check: read-only, reports free/mine/held without writing or recovering", () => {
  const p = makeProject();
  try {
    const free = p.run(["lock", "check", "planning"]);
    assert.equal(free.code, 0);
    assert.equal(stdoutJson(free).state, "released");

    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    const mine = p.run(["lock", "check", "planning", "--session", "sessA"]);
    assert.equal(mine.code, 0);
    assert.equal(stdoutJson(mine).state, "mine");

    const held = p.run(["lock", "check", "planning", "--session", "sessB"]);
    assert.equal(held.code, 3);
    assert.match(held.stderr, /⛔/);
  } finally {
    p.cleanup();
  }
});

test("status: read-only, reports both locks in one JSON line", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    const r = p.run(["lock", "status"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.planning.state, "held");
    assert.equal(json.planning.skill, "ship-discuss");
    assert.equal(json.execution.state, "released");
  } finally {
    p.cleanup();
  }
});
