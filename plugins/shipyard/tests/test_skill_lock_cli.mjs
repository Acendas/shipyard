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
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, "bin", "shipyard-data.mjs");
const { reapSessionLocks } = await import(join(PLUGIN_ROOT, "bin", "skill-lock.mjs"));

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
  // The test runner itself runs inside a Claude Code session, so its env carries
  // CLAUDE_CODE_SESSION_ID. Drop it too, otherwise the no-`--session` fixtures
  // (meant to exercise the unverified path) would silently inherit it and become
  // verified. Tests that want a verified identity pass `--session` explicitly.
  delete env.CLAUDE_CODE_SESSION_ID;
  const run = (args, envOverride = {}) => {
    const result = spawnSync("node", [CLI, ...args], { cwd: repo, env: { ...env, ...envOverride }, encoding: "utf8" });
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
  return { root, repo, dataDir, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function readLock(p, kind) {
  const base = kind === "planning" ? ".active-session.json" : kind === "discuss" ? ".active-discuss.json" : ".active-execution.json";
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
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.acquired, true);
    assert.equal(json.reentry, false);
    assert.equal(json.depth, 1);
    const lock = readLock(p, "planning");
    assert.equal(lock.skill, "ship-sprint");
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
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
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
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /recovered stale/);
    const json = stdoutJson(r);
    assert.equal(json.recovered, "stale");
    assert.equal(readLock(p, "planning").skill, "ship-sprint");
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
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
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
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessB"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /⛔ Another planning session is active/);
    assert.match(r.stderr, /ship-sprint/);
    const json = stdoutJson(r);
    assert.equal(json.acquired, false);
    assert.equal(json.blocked.skill, "ship-sprint");
  } finally {
    p.cleanup();
  }
});

// --- cross-lock guard --------------------------------------------------------

test("different commands never block each other: execute starts while sprint planning runs in another session", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    const r = p.run(["lock", "acquire", "execution", "--skill", "ship-execute", "--session", "sessB"]);
    assert.equal(r.code, 0, r.stderr);
    const json = stdoutJson(r);
    assert.equal(json.cross_lock_allowed, "ship-execute+ship-sprint");
    assert.deepEqual(json.running_beside, ["ship-sprint"]);
  } finally {
    p.cleanup();
  }
});

test("cross-lock guard: ship-execute may run while ship-discuss planning is held", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]);
    const r = p.run(["lock", "acquire", "execution", "--skill", "ship-execute", "--session", "sessB"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.acquired, true);
    assert.equal(json.cross_lock_allowed, "ship-discuss+ship-execute");
    assert.match(readEvents(p), /"skill_lock_concurrent_allowed"/);
  } finally {
    p.cleanup();
  }
});

test("cross-lock guard: ship-discuss may run while ship-execute execution is held", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "execution", "--skill", "ship-execute", "--session", "sessA"]);
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessB"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.acquired, true);
    assert.equal(json.cross_lock_allowed, "ship-discuss+ship-execute");
  } finally {
    p.cleanup();
  }
});

test("the next sprint can be planned while the current one executes, and a discussion runs beside both", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "execution", "--skill", "ship-execute", "--session", "sessA"]);
    let r = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessB"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(stdoutJson(r).cross_lock_allowed, "ship-execute+ship-sprint");
    r = p.run(["lock", "acquire", "discuss", "--skill", "ship-discuss", "--session", "sessC"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(stdoutJson(r).running_beside.sort(), ["ship-execute", "ship-sprint"]);
    // the lock still stops a second copy of the same command
    for (const [kind, skill] of [["execution", "ship-execute"], ["execution", "ship-review"], ["planning", "ship-sprint"], ["discuss", "ship-discuss"]]) {
      const again = p.run(["lock", "acquire", kind, "--skill", skill, "--session", "sessZ"]);
      assert.equal(again.code, 3, `${skill} must be blocked by the running ${kind} command`);
    }
    assert.match(p.run(["lock", "acquire", "discuss", "--skill", "ship-discuss", "--session", "sessZ"]).stderr, /Another discussion is active/);
  } finally {
    p.cleanup();
  }
});

test("a caller that still says `planning --skill ship-discuss` gets the discuss lock, and sprint planning is not blocked by it", () => {
  const p = makeProject();
  try {
    assert.equal(p.run(["lock", "acquire", "planning", "--skill", "ship-discuss", "--session", "sessA"]).code, 0);
    assert.equal(JSON.parse(readFileSync(join(p.dataDir, ".active-discuss.json"), "utf8")).skill, "ship-discuss");
    assert.equal(p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessB"]).code, 0);
    assert.equal(p.run(["lock", "release", "planning", "--skill", "ship-discuss", "--session", "sessA"]).code, 0);
    assert.equal(JSON.parse(readFileSync(join(p.dataDir, ".active-discuss.json"), "utf8")).skill, null);
    assert.equal(JSON.parse(readFileSync(join(p.dataDir, ".active-session.json"), "utf8")).skill, "ship-sprint");
  } finally {
    p.cleanup();
  }
});

test("cross-lock guard: same session on the other lock proceeds and flags cross_lock_same_session", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    const r = p.run(["lock", "acquire", "execution", "--skill", "ship-execute", "--session", "sessA"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.acquired, true);
    assert.equal(json.cross_lock_same_session, true);
  } finally {
    p.cleanup();
  }
});

test("only the command's own lock blocks it: other held locks are reported, not counted", () => {
  const p = makeProject();
  try {
    const now = new Date().toISOString();
    writeFileSync(
      join(p.dataDir, ".active-session.json"),
      JSON.stringify({ skill: "ship-sprint", sprint: null, wave: null, started: now, session_id: "sessA", cleared: null, depth: 1 }),
    );
    writeFileSync(
      join(p.dataDir, ".active-execution.json"),
      JSON.stringify({ skill: "ship-execute", sprint: null, wave: null, started: now, session_id: "sessB", cleared: null, depth: 1 }),
    );
    const r = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessC"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /ship-sprint/);
    assert.doesNotMatch(r.stderr, /ship-execute/);
    const json = stdoutJson(r);
    assert.equal(json.blocked.skill, "ship-sprint");
  } finally {
    p.cleanup();
  }
});

// --- release: decrement / sentinel / no-op / idempotent / force ---------------

test("release: depth > 1 only decrements, does not release", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]); // depth 2
    const r = p.run(["lock", "release", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.released, false);
    assert.equal(json.depth, 1);
    assert.equal(readLock(p, "planning").skill, "ship-sprint", "still held at depth 1");
  } finally {
    p.cleanup();
  }
});

test("release: depth 1 writes the sentinel and emits skill_lock_released", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    const r = p.run(["lock", "release", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
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
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    const r = p.run(["lock", "release", "planning", "--skill", "ship-sprint", "--session", "sessB"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.released, false);
    assert.equal(json.reason, "held_by_other");
    assert.equal(readLock(p, "planning").skill, "ship-sprint", "not released by a stranger's request");
  } finally {
    p.cleanup();
  }
});

test("release: already-released/missing lock is idempotent (exit 0)", () => {
  const p = makeProject();
  try {
    const r = p.run(["lock", "release", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    assert.equal(r.code, 0);
    assert.equal(stdoutJson(r).released, true);
  } finally {
    p.cleanup();
  }
});

test("release: --force writes the sentinel regardless of holder", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
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
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint"]);
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
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint"]);
    const r = p.run(["lock", "release", "planning", "--skill", "ship-sprint"]);
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

    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
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
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    const r = p.run(["lock", "status"]);
    assert.equal(r.code, 0);
    const json = stdoutJson(r);
    assert.equal(json.planning.state, "held");
    assert.equal(json.planning.skill, "ship-sprint");
    assert.equal(json.execution.state, "released");
    assert.ok(["free", "released"].includes(json.discuss.state), "the discuss lock is reported too");
  } finally {
    p.cleanup();
  }
});

// --- CLAUDE_CODE_SESSION_ID resolution (the abrupt-exit re-entry bug) --------

test("CLAUDE_CODE_SESSION_ID makes a same-session re-acquire 'mine', not blocked", () => {
  // Regression for the reported bug: the resolver read CLAUDE_SESSION_ID (a var
  // Claude Code never sets) instead of CLAUDE_CODE_SESSION_ID, so every lock was
  // acquired unverified and a session that abruptly exited could not re-acquire
  // its own lock — it looked held-by-a-stranger until the 2h stale threshold.
  const p = makeProject();
  try {
    const envA = { CLAUDE_CODE_SESSION_ID: "sess-real" };
    const first = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint"], envA);
    assert.equal(first.code, 0);
    assert.equal(readLock(p, "planning").session_id, "sess-real");

    // Simulate the skill abruptly exiting (no release), then the SAME session
    // re-running a planning skill. It must re-acquire as reentry, not block.
    const second = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint"], envA);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(stdoutJson(second).reentry, true);
  } finally {
    p.cleanup();
  }
});

test("a different session is still correctly blocked (identity is real, not ignored)", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint"], { CLAUDE_CODE_SESSION_ID: "sess-A" });
    const other = p.run(["lock", "acquire", "planning", "--skill", "ship-sprint"], { CLAUDE_CODE_SESSION_ID: "sess-B" });
    assert.equal(other.code, 3);
  } finally {
    p.cleanup();
  }
});

// --- reapSessionLocks (SessionEnd hook cleanup) ------------------------------

test("reapSessionLocks releases the ending session's own locks", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    p.run(["lock", "acquire", "execution", "--skill", "ship-execute", "--session", "sessA"]);

    const { released } = reapSessionLocks(p.dataDir, "sessA");
    assert.equal(released.length, 2);
    assert.equal(readLock(p, "planning").skill, null);
    assert.equal(readLock(p, "execution").skill, null);
    assert.match(readEvents(p), /skill_lock_reaped/);
  } finally {
    p.cleanup();
  }
});

// The owner typed /clear in the middle of a discussion (2026-11-15, 4.0.0) and
// the next /ship-discuss in the same terminal was refused twice by the ended
// session's own lock: the reap covered planning and execution only.
test("reapSessionLocks releases the ending session's discuss lock, so /clear does not block the next discussion", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "discuss", "--skill", "ship-discuss", "--session", "sessA"]);
    const blocked = p.run(["lock", "acquire", "discuss", "--skill", "ship-discuss", "--session", "sessB"]);
    assert.equal(blocked.code, 3);
    assert.match(blocked.stderr + blocked.stdout, /lock release discuss --force/, "the refusal names the command that frees a closed session's lock");

    const { released } = reapSessionLocks(p.dataDir, "sessA");
    assert.deepEqual(released.map((r) => r.kind), ["discuss"]);
    assert.equal(readLock(p, "discuss").skill, null);
    const again = p.run(["lock", "acquire", "discuss", "--skill", "ship-discuss", "--session", "sessB"]);
    assert.equal(again.code, 0, again.stderr);
  } finally {
    p.cleanup();
  }
});

test("reapSessionLocks never touches a concurrent session's lock", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    // A different session ends; sessA's lock must survive.
    const { released } = reapSessionLocks(p.dataDir, "sessB");
    assert.equal(released.length, 0);
    assert.equal(readLock(p, "planning").skill, "ship-sprint");
  } finally {
    p.cleanup();
  }
});

test("reapSessionLocks is a no-op when the ending session id is absent", () => {
  const p = makeProject();
  try {
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "sessA"]);
    const { released } = reapSessionLocks(p.dataDir, null);
    assert.equal(released.length, 0);
    assert.equal(readLock(p, "planning").skill, "ship-sprint");
  } finally {
    p.cleanup();
  }
});

test("reapSessionLocks leaves an unverified (null-session) lock alone", () => {
  const p = makeProject();
  try {
    // No --session, no CLAUDE_CODE_SESSION_ID -> session_id stored as null.
    p.run(["lock", "acquire", "planning", "--skill", "ship-sprint"]);
    assert.equal(readLock(p, "planning").session_id, null);
    const { released } = reapSessionLocks(p.dataDir, "sess-whatever");
    assert.equal(released.length, 0);
    assert.equal(readLock(p, "planning").skill, "ship-sprint");
  } finally {
    p.cleanup();
  }
});

// The owner, 4.0.1: "when i provide jira links, and research turns out theres more i should have let me know to
// create the tickets in jira or ask to assist create. and then once discuss is done. ask to sync".
test("a discussion that touched tracker-linked work cannot end without the sync question being answered", () => {
  const p = makeProject();
  try {
    const d = p.dataDir;
    const acquire = () => p.run(["lock", "acquire", "discuss", "--skill", "ship-discuss", "--session", "s1"]);
    const release = () => p.run(["lock", "release", "discuss", "--skill", "ship-discuss", "--session", "s1"]);
    // an import leaves nothing owed: the records say what their tickets say
    const input = join(d, "in.json");
    writeFileSync(input, JSON.stringify({ source: "jira", items: [{ key: "ABC-1", title: "Offline mode", type: "Epic" }, { key: "ABC-2", title: "Pay by card", type: "Story" }] }));
    assert.equal(acquire().code, 0);
    assert.match(p.run(["tracker", "pull", "--input", input]).stdout, /create 2/);
    // this test is about the tracker: the owner's answer on the project's sources is on record, and it names none
    assert.equal(p.run(["sources", "none", "--answer", "the repository is everything"]).code, 0);
    assert.equal(release().code, 0, "importing tickets is not a change to send back");

    // the discussion refines the idea into an epic and writes a story no ticket covers
    assert.equal(acquire().code, 0);
    assert.match(p.run(["idea", "promote", "IDEA-001"]).stdout, /IDEA-001 promoted to E001/);
    writeFileSync(join(d, "spec", "stories", "S050-new.md"), '---\nid: S050\ntitle: "Found in research"\ntype: feature\nepic: E001\nstatus: proposed\nexternal_refs: []\n---\n\n# Found in research\n');
    let r = release();
    assert.equal(r.code, 3);
    assert.match(r.stderr, /not finished with the tracker: 1 item\(s\) written here have no ticket and 1 linked item\(s\) changed here since they were last sent/);
    assert.match(r.stderr, /shipyard-data tracker plan --since /); assert.match(r.stderr, /tracker decided --sync applied\|later\|none/);
    const plan = p.run(["tracker", "plan"]).stdout;
    assert.match(plan, /1\. S050 +Story +Found in research +· under ABC-1/); assert.match(plan, /2\. E001 +ABC-1 +Offline mode +· here: proposed +· never sent/);
    assert.match(plan, /^TRACKER PLAN · 1 with no ticket · 1 changed since last sent · tracker_sync: ask/);
    // The person stepped away while a question waited (after 4.0.2, live: the card timed out, the release was
    // refused, and the lock stayed with a session that had ended its turn). The discussion is paused, never
    // answered for them, and the next one answers for what this one left.
    assert.match(r.stderr, /If the person is away[\s\S]*release with --pause/);
    const pause = () => p.run(["lock", "release", "discuss", "--skill", "ship-discuss", "--session", "s1", "--pause"]);
    r = pause();
    assert.equal(r.code, 3); assert.match(r.stderr, /--pause is for a discussion with something left open/);
    assert.equal(p.run(["discuss-queue", "start", "--items", "S050"]).code, 0);
    r = pause();
    assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(r.stdout).paused, true);
    assert.equal(acquire().code, 0);
    assert.ok(JSON.parse(readFileSync(join(d, ".active-discuss.json"), "utf8")).owed_since, "the new discussion carries the old one's start");
    r = release();
    assert.equal(r.code, 3); assert.match(r.stderr, /not finished with the tracker: 1 item\(s\) written here have no ticket/);
    p.run(["discuss-queue", "clear"]);
    p.run(["tracker", "decided", "--sync", "later"]);
    assert.equal(release().code, 0, '"later" is an answer; silence is not');
  } finally {
    p.cleanup();
  }
});

// Seen live on 4.0.1: a discussion that split an epic into a spike and draft stories ended with
// "I have not read the Google Drive hardware documents yet". Nothing was approved, so the approval gate never ran.
// After 4.0.3 (the owner: "shipyard is forcing jira, confluence google drive search … sometimes its not necessary
// at all"): what a discussion owes at its end follows the sources the project names.
test("a discussion cannot end before the owner was asked once about the project's sources, and, when some are named, before it says where it looked", () => {
  const p = makeProject();
  try {
    const acquire = () => p.run(["lock", "acquire", "discuss", "--skill", "ship-discuss", "--session", "s1"]);
    const release = () => p.run(["lock", "release", "discuss", "--skill", "ship-discuss", "--session", "s1"]);
    assert.equal(acquire().code, 0);
    assert.equal(release().code, 0, "a discussion that wrote nothing owes nothing");
    assert.equal(acquire().code, 0);
    p.run(["idea", "capture", "--title", "Returns page ready for the first pilot shop"]);
    let r = release();
    assert.equal(r.code, 3); assert.match(r.stderr, /this project has not said where its knowledge lives, besides the code[\s\S]*shipyard-data sources suggest/);
    assert.equal(JSON.parse(r.stdout).reason, "project_sources_not_asked");
    assert.equal(p.run(["sources", "none", "--answer", "the repository is everything"]).code, 0);
    assert.equal(release().code, 0, "a project that names no source owes no record of where a discussion looked");

    // the owner names a place: from then on a discussion says, for it, searched / not needed / out of reach
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100); // events carry whole seconds: the last discussion's record is not this one's
    assert.equal(acquire().code, 0);
    assert.equal(p.run(["sources", "add", "Design notes", "--holds", "what was decided and why", "--path", "doc/", "--answer", "the design notes folder too"]).code, 0);
    p.run(["discuss-questions", "start", "--topic", "epic-e001"]);
    r = release();
    assert.equal(r.code, 3); assert.match(r.stderr, /has not said where its research looked[\s\S]*discuss-questions sources --looked/);
    p.run(["discuss-questions", "sources", "--looked", "Design notes: doc/returns.md, the refund rules", "--external", "the payment provider's guide", "--open", "who pays the return postage"]);
    r = release();
    assert.equal(r.code, 3); assert.match(r.stderr, /a fact was left open and the person has not been asked about documents this session cannot reach/);
    p.run(["discuss-questions", "sources", "--person-said", "no, that is everything"]);
    p.run(["idea", "capture", "--title", "Something this discussion wrote"]);
    p.run(["discuss-questions", "reset"]);
    assert.equal(release().code, 0, "closing the question list does not make the discussion owe its sources again");

    // Seen live: an idea refined into an epic through cards of the session's own, with no question list at all.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100);
    assert.equal(acquire().code, 0);
    p.run(["idea", "capture", "--title", "A second page for the pilot shop"]);
    r = release();
    assert.equal(r.code, 3, "a discussion that wrote specs owes the record even with no question list"); assert.match(r.stderr, /has not said where its research looked/);
    const out = p.run(["discuss-questions", "sources", "--skipped", "Design notes: the scope comes from the test plan, nothing was decided"]).stdout;
    assert.match(out, /\| Design notes \| not needed: the scope comes from the test plan, nothing was decided \|/);
    assert.doesNotMatch(out, /Is there a document I could not reach\?/, "with nothing left open the person is not asked");
    assert.equal(release().code, 0, release().stderr);

    // the quick lanes do no research: a tiny change filed to land now owes nothing
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100);
    assert.equal(acquire().code, 0);
    p.run(["route-intake", "--confirm", "land-now", "--proposed", "land-now"]);
    p.run(["idea", "capture", "--title", "Log an unknown reader code"]);
    assert.equal(release().code, 0, release().stderr);
  } finally {
    p.cleanup();
  }
});

// The owner: "will shipyard work with user session to update external ticket details along the way until
// up to completion". The same question when a sprint is planned and when it is reviewed; never from execute.
test("sprint planning and the sprint review ask about linked tickets before they end; execute never does; off switches it off", () => {
  const p = makeProject();
  try {
    const d = p.dataDir;
    mkdirSync(join(d, "spec", "stories"), { recursive: true });
    const story = (status) => writeFileSync(join(d, "spec", "stories", "S001-x.md"), `---\nid: S001\ntitle: "Pay by card"\ntype: feature\nstatus: ${status}\nstory_points: 5\nexternal_refs: ["ABC-7"]\nsynced_at: "2020-01-01T00:00:00.000Z"\nupstream:\n  key: "ABC-7"\n  status: "To Do"\n---\n\n# Pay by card\n`);
    for (const [kind, skill, word] of [["planning", "ship-sprint", "planning"], ["execution", "ship-review", "review"]]) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100); // events carry whole seconds: an answer given to the last command is not this one's
      assert.equal(p.run(["lock", "acquire", kind, "--skill", skill, "--session", "s1"]).code, 0);
      story(kind === "planning" ? "in-progress" : "done");
      const r = p.run(["lock", "release", kind, "--skill", skill, "--session", "s1"]);
      assert.equal(r.code, 3, `${skill} asks`); assert.match(r.stderr, new RegExp(`1 linked item\\(s\\) changed in this ${word} and their tickets do not know yet \\(S001\\)`));
      assert.match(p.run(["tracker", "plan"]).stdout, /S001 +ABC-7 +Pay by card +· here: (in-progress|done) \(ticket: To Do\) +· 5 pts/);
      p.run(["tracker", "synced", "S001"]); p.run(["tracker", "decided", "--sync", "applied"]);
      assert.equal(p.run(["lock", "release", kind, "--skill", skill, "--session", "s1"]).code, 0);
    }
    assert.equal(p.run(["lock", "acquire", "execution", "--skill", "ship-execute", "--session", "s1"]).code, 0);
    story("done");
    assert.equal(p.run(["lock", "release", "execution", "--skill", "ship-execute", "--session", "s1"]).code, 0, "the build asks nothing");
    writeFileSync(join(d, "config.md"), "---\nproject_name: x\ntracker_sync: ask\n---\n");
    assert.equal(p.run(["config", "set", "tracker-sync", "off"]).code, 0);
    assert.match(readFileSync(join(d, "config.md"), "utf8"), /^tracker_sync: off$/m);
    assert.equal(p.run(["lock", "acquire", "planning", "--skill", "ship-sprint", "--session", "s1"]).code, 0);
    story("in-progress");
    assert.equal(p.run(["lock", "release", "planning", "--skill", "ship-sprint", "--session", "s1"]).code, 0, "tracker_sync: off");
  } finally {
    p.cleanup();
  }
});

// Seen on a fresh project: the build's readiness check asked "how should the untracked .shipyard link be handled?".
test("the .shipyard link is hidden from git by whoever makes it, in the repository's local exclude file", async () => {
  const { ensureDataDirLink } = await import(join(PLUGIN_ROOT, "bin", "shipyard-resolver.mjs"));
  const p = makeProject();
  try {
    const repo = join(p.dataDir, "..", "..", "..", "repo");
    const status = () => execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    const r = ensureDataDirLink(repo, p.dataDir);
    assert.ok(["created", "ok", "repointed"].includes(r.status), r.status);
    assert.equal(status(), "", "the link does not show as an untracked file");
    assert.match(readFileSync(join(repo, ".git", "info", "exclude"), "utf8"), /^\.shipyard$/m);
    assert.equal(execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: repo, encoding: "utf8" }).includes(".shipyard"), true);
    ensureDataDirLink(repo, p.dataDir);
    assert.equal((readFileSync(join(repo, ".git", "info", "exclude"), "utf8").match(/^\.shipyard$/gm) || []).length, 1, "once");
  } finally {
    p.cleanup();
  }
});
