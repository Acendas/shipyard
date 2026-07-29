/**
 * Tests for bin/verify-ledger.mjs — the P1 verification-evidence ledger
 * backing `shipyard-data verify record|check`.
 *
 * Truth table (mirrors the plan's "Tests to add" section):
 *   fresh                        => check exit 0
 *   changed tree                 => check exit 3
 *   changed command               => check exit 3
 *   dirty tree at record          => record refuses (never writes)
 *   dirty at check                => check exit 3
 *   expired TTL                   => check exit 3
 *   missing capture               => check exit 3
 *   rebase preserving tree        => still fresh (tree-id-over-sha)
 *   unparseable ledger            => check exit 3
 *
 * Run: node --test tests/test_verify_ledger.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LEDGER_BASENAME,
  checkVerification,
  evaluateFreshness,
  recordVerification,
} from "../bin/verify-ledger.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

/** Build a temp dataDir with a real git repo as its project root. */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "verify-ledger-test-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(dataDir, "sprints", "current"), { recursive: true });
  git(["init", "-q"], repo);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "config", "commit.gpgsign", "false"], repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["add", "-A"], repo);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], repo);
  writeFileSync(join(dataDir, ".project-root"), repo + "\n");
  const capturePath = join(root, "capture.log");
  writeFileSync(capturePath, "PASS\n");
  return { root, repo, dataDir, capturePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// --- record: refuses on a dirty tree ---------------------------------------

test("record refuses when the working tree is dirty (never records)", () => {
  const f = makeFixture();
  try {
    writeFileSync(join(f.repo, "dirty.txt"), "uncommitted\n");
    const r = recordVerification(f.dataDir, {
      key: "unit",
      command: "run tests",
      exitCode: 0,
      capturePath: f.capturePath,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
    assert.ok(!require_ledgerHasKey(f.dataDir, "unit"));
  } finally {
    f.cleanup();
  }
});

function require_ledgerHasKey(dataDir, key) {
  const p = join(dataDir, "sprints", "current", LEDGER_BASENAME);
  try {
    const obj = JSON.parse(readFileSync(p, "utf8"));
    return Object.prototype.hasOwnProperty.call(obj, key);
  } catch {
    return false;
  }
}

// --- record + check: the fresh path -----------------------------------------

test("record then check on the same clean tree/command: fresh (exit 0)", () => {
  const f = makeFixture();
  try {
    const rec = recordVerification(f.dataDir, {
      key: "unit",
      command: "run tests",
      exitCode: 0,
      capturePath: f.capturePath,
    });
    assert.equal(rec.ok, true, rec.message);

    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(chk.ok, true, chk.message);
    assert.equal(chk.code, 0);
  } finally {
    f.cleanup();
  }
});

test("checking a key that was never recorded is stale (exit 3)", () => {
  const f = makeFixture();
  try {
    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(chk.ok, false);
    assert.equal(chk.code, 3);
  } finally {
    f.cleanup();
  }
});

// --- changed tree -------------------------------------------------------------

test("changed tree since recording => stale", () => {
  const f = makeFixture();
  try {
    recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath });

    writeFileSync(join(f.repo, "b.txt"), "two\n");
    git(["add", "-A"], f.repo);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "second"], f.repo);

    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(chk.ok, false);
    assert.equal(chk.code, 3);
    assert.match(chk.message, /tree changed/);
  } finally {
    f.cleanup();
  }
});

// --- changed command ------------------------------------------------------------

test("changed command since recording => stale", () => {
  const f = makeFixture();
  try {
    recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath });
    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests --different-flag" });
    assert.equal(chk.ok, false);
    assert.equal(chk.code, 3);
    assert.match(chk.message, /command changed/);
  } finally {
    f.cleanup();
  }
});

// --- dirty at check time --------------------------------------------------------

test("dirty tree at check time => stale, even though record was clean", () => {
  const f = makeFixture();
  try {
    recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath });
    writeFileSync(join(f.repo, "dirty.txt"), "uncommitted\n");
    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(chk.ok, false);
    assert.equal(chk.code, 3);
    assert.match(chk.message, /dirty/);
  } finally {
    f.cleanup();
  }
});

// --- expired TTL -----------------------------------------------------------------

test("expired TTL => stale", () => {
  const f = makeFixture();
  try {
    recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath });
    // ttlHours: 0 means "disabled — always stale" per the spec.
    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests", ttlHours: 0 });
    assert.equal(chk.ok, false);
    assert.equal(chk.code, 3);
  } finally {
    f.cleanup();
  }
});

test("a tiny TTL window expires almost immediately", async () => {
  const f = makeFixture();
  try {
    recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath });
    // 1e-9 hours ~ 3.6 microseconds; sleep briefly to guarantee elapse.
    await new Promise((r) => setTimeout(r, 5));
    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests", ttlHours: 1e-9 });
    assert.equal(chk.ok, false);
    assert.equal(chk.code, 3);
    assert.match(chk.message, /TTL expired/);
  } finally {
    f.cleanup();
  }
});

// --- missing capture -------------------------------------------------------------

test("missing capture file => stale", () => {
  const f = makeFixture();
  try {
    recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath });
    rmSync(f.capturePath);
    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(chk.ok, false);
    assert.equal(chk.code, 3);
    assert.match(chk.message, /capture file/);
  } finally {
    f.cleanup();
  }
});

test("capture file content changed (same size or not) since recording => stale", () => {
  const f = makeFixture();
  try {
    recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath });
    writeFileSync(f.capturePath, "FAIL\n"); // same length, different content
    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(chk.ok, false);
    assert.equal(chk.code, 3);
  } finally {
    f.cleanup();
  }
});

// --- nonzero recorded exit --------------------------------------------------------

test("a recorded nonzero exit code is never reusable, even if everything else matches", () => {
  const f = makeFixture();
  try {
    const rec = recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 1, capturePath: f.capturePath });
    assert.equal(rec.ok, true, rec.message); // recording a failure is allowed — it's the record of what happened
    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(chk.ok, false);
    assert.equal(chk.code, 3);
    assert.match(chk.message, /exit code/);
  } finally {
    f.cleanup();
  }
});

// --- rebase preserving tree => still fresh (D3: tree-id, not sha) ----------------

test("rebase that preserves the tree (amend to a new sha, same content) is still fresh", () => {
  const f = makeFixture();
  try {
    recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath });
    const beforeSha = git(["rev-parse", "HEAD"], f.repo).trim();

    // Simulate a rebase: amend the commit message only, which changes the
    // commit sha but leaves the tree identical.
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--amend", "-q", "-m", "reworded"], f.repo);
    const afterSha = git(["rev-parse", "HEAD"], f.repo).trim();
    assert.notEqual(beforeSha, afterSha, "amend must actually change the sha for this test to be meaningful");

    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(chk.ok, true, `expected fresh after a tree-preserving rebase; got: ${chk.message}`);
  } finally {
    f.cleanup();
  }
});

// --- unparseable ledger ------------------------------------------------------------

test("unparseable ledger file => stale", () => {
  const f = makeFixture();
  try {
    const ledgerPath = join(f.dataDir, "sprints", "current", LEDGER_BASENAME);
    writeFileSync(ledgerPath, "{ not json");
    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(chk.ok, false);
    assert.equal(chk.code, 3);
    assert.match(chk.message, /not parseable/);
  } finally {
    f.cleanup();
  }
});

test("ledger file that parses but isn't an object => stale", () => {
  const f = makeFixture();
  try {
    const ledgerPath = join(f.dataDir, "sprints", "current", LEDGER_BASENAME);
    writeFileSync(ledgerPath, JSON.stringify(["not", "an", "object"]));
    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(chk.ok, false);
    assert.equal(chk.code, 3);
  } finally {
    f.cleanup();
  }
});

// --- multiple keys don't clobber each other --------------------------------------

test("recording under a second key does not disturb the first key's entry", () => {
  const f = makeFixture();
  try {
    recordVerification(f.dataDir, { key: "unit", command: "run unit", exitCode: 0, capturePath: f.capturePath });
    const capture2 = join(f.root, "capture2.log");
    writeFileSync(capture2, "PASS2\n");
    recordVerification(f.dataDir, { key: "integration", command: "run integration", exitCode: 0, capturePath: capture2 });

    const chkUnit = checkVerification(f.dataDir, { key: "unit", command: "run unit" });
    const chkIntegration = checkVerification(f.dataDir, { key: "integration", command: "run integration" });
    assert.equal(chkUnit.ok, true, chkUnit.message);
    assert.equal(chkIntegration.ok, true, chkIntegration.message);
  } finally {
    f.cleanup();
  }
});

// --- no forced-skip surface ---------------------------------------------------------

test("evaluateFreshness never returns fresh when project root cannot be resolved", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-ledger-noroot-"));
  try {
    const dataDir = join(root, "data");
    mkdirSync(join(dataDir, "sprints", "current"), { recursive: true });
    // No .project-root file, and the resolver's cwd fallback (this test
    // runner's cwd) isn't guaranteed non-git — force an unresolvable root
    // by pointing .project-root at a path that isn't a git repo at all.
    writeFileSync(join(dataDir, ".project-root"), join(root, "not-a-repo") + "\n");
    const result = evaluateFreshness(dataDir, { key: "unit" });
    assert.equal(result.fresh, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
