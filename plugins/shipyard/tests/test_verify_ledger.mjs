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
  listVerifications,
  checkVerification,
  evaluateFreshness,
  recordVerification,
  recordByCommand,
  reuseByCommand,
  commandKey,
  inLedgerCheckout,
  chainParts,
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

test("record refuses when a tracked file is changed (never records)", () => {
  const f = makeFixture();
  try {
    writeFileSync(join(f.repo, "a.txt"), "edited, not committed\n");
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
    writeFileSync(join(f.repo, "a.txt"), "edited after the proof\n");
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

// --- a project that lives in a sub-folder of a larger repository (4.11.2) ----

test("monorepo sub-project: untracked sibling folders do not block a proof; dirt inside the project still does, at record and at check", () => {
  const f = makeFixture();
  try {
    // the repository holds two projects; only game/ is tracked, the sibling is somebody else's untracked work
    mkdirSync(join(f.repo, "game"), { recursive: true });
    writeFileSync(join(f.repo, "game", "main.c"), "int main(void){return 0;}\n");
    git(["add", "-A"], f.repo);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "game"], f.repo);
    mkdirSync(join(f.repo, "other-project"), { recursive: true });
    writeFileSync(join(f.repo, "other-project", "notes.txt"), "untracked\n");
    const args = { key: "full-suite", command: "make test", exitCode: 0, capturePath: f.capturePath };
    // from the repository root the sibling's files are part of the fingerprint (4.13.1)
    assert.equal(recordVerification(f.dataDir, { ...args, projectDir: f.repo }).ok, true);
    assert.equal(JSON.parse(readFileSync(join(f.dataDir, "sprints", "current", LEDGER_BASENAME), "utf8"))["full-suite"].untrackedCount, 1);
    // from the project's own folder the proof records, scoped to it
    const rec = recordVerification(f.dataDir, { ...args, projectDir: join(f.repo, "game") });
    assert.equal(rec.ok, true, rec.message);
    const entry = JSON.parse(readFileSync(join(f.dataDir, "sprints", "current", LEDGER_BASENAME), "utf8"))["full-suite"];
    assert.equal(entry.scope, "game");
    assert.equal(entry.untrackedCount, 0, "scoped to the project: the sibling's files are not its business");
    assert.equal(evaluateFreshness(f.dataDir, { key: "full-suite", command: "make test" }).fresh, true, "the check uses the recorded folder, wherever it is run from");
    // a tracked file edited inside the project is still dirt
    writeFileSync(join(f.repo, "game", "main.c"), "int main(void){return 1;}\n");
    const stale = evaluateFreshness(f.dataDir, { key: "full-suite", command: "make test" });
    assert.equal(stale.fresh, false); assert.match(stale.reason, /dirty right now \(under game\/\)/);
    const again = recordVerification(f.dataDir, { ...args, projectDir: join(f.repo, "game") });
    assert.equal(again.ok, false); assert.match(again.message, /a tracked file is changed under game\//);
  } finally { f.cleanup(); }
});

// --- untracked files: a fingerprint, not a refusal (4.13.1) -------------------

test("untracked files do not block a proof: it holds for the committed tree plus exactly those files, and goes stale when they change", () => {
  const f = makeFixture();
  try {
    // a tool left a scratch folder in the project
    mkdirSync(join(f.repo, ".tool-scratch"), { recursive: true });
    writeFileSync(join(f.repo, ".tool-scratch", "page.yml"), "a snapshot\n");
    const args = { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath };
    const rec = recordVerification(f.dataDir, args);
    assert.equal(rec.ok, true, rec.message);
    const entry = JSON.parse(readFileSync(join(f.dataDir, "sprints", "current", LEDGER_BASENAME), "utf8")).unit;
    assert.equal(entry.untrackedCount, 1); assert.match(entry.untracked, /^[0-9a-f]{64}$/);
    assert.equal(evaluateFreshness(f.dataDir, { key: "unit", command: "run tests" }).fresh, true);
    // a new untracked file could change what the build sees: the proof no longer applies
    writeFileSync(join(f.repo, "new_source.c"), "int x;\n");
    let stale = evaluateFreshness(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(stale.fresh, false); assert.match(stale.reason, /untracked files changed since the proof was recorded/);
    rmSync(join(f.repo, "new_source.c"));
    assert.equal(evaluateFreshness(f.dataDir, { key: "unit", command: "run tests" }).fresh, true, "back to the recorded set");
    // the same file with different content
    writeFileSync(join(f.repo, ".tool-scratch", "page.yml"), "a different, longer snapshot\n");
    stale = evaluateFreshness(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(stale.fresh, false);
    // an entry recorded before 4.13.1 (no fingerprint) was recorded with no untracked files at all
    const lp = join(f.dataDir, "sprints", "current", LEDGER_BASENAME);
    const ledger = JSON.parse(readFileSync(lp, "utf8")); delete ledger.unit.untracked; delete ledger.unit.untrackedCount;
    writeFileSync(lp, JSON.stringify(ledger));
    assert.equal(evaluateFreshness(f.dataDir, { key: "unit", command: "run tests" }).fresh, false);
    rmSync(join(f.repo, ".tool-scratch"), { recursive: true });
    assert.equal(evaluateFreshness(f.dataDir, { key: "unit", command: "run tests" }).fresh, true);
  } finally { f.cleanup(); }
});

test("verify list: every recorded proof with its state now, and the full suite's key is named", () => {
  const f = makeFixture();
  try {
    assert.deepEqual(listVerifications(f.dataDir), []);
    recordVerification(f.dataDir, { key: "sprint_full_tests", command: "make test", exitCode: 0, capturePath: f.capturePath });
    let rows = listVerifications(f.dataDir);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].key, rows[0].fresh, rows[0].command], ["sprint_full_tests", true, "make test"]);
    writeFileSync(join(f.repo, "a.txt"), "edited after the proof\n");
    rows = listVerifications(f.dataDir);
    assert.equal(rows[0].fresh, false); assert.match(rows[0].reason, /dirty/);
  } finally { f.cleanup(); }
});

// --- 4.0: evidence instead of a second run ----------------------------------

const commit = (repo, files, msg) => {
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), c); }
  git(["add", "-A"], repo);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg], repo);
};

test("a proof is found by its command, whatever name it was recorded under", () => {
  const f = makeFixture();
  try {
    recordVerification(f.dataDir, { key: "wave_2_tests", command: "make -k test", exitCode: 0, capturePath: f.capturePath });
    const chk = checkVerification(f.dataDir, { key: "test_commands.unit", command: "make -k test" });
    assert.equal(chk.code, 0, chk.message);
    assert.equal(checkVerification(f.dataDir, { key: "test_commands.unit", command: "make test" }).code, 3, "another command is not proven");
    assert.equal(evaluateFreshness(f.dataDir, { key: "test_commands.unit" }).fresh, false, "no command named: only the key counts");
    assert.deepEqual(listVerifications(f.dataDir).map((r) => r.key), ["wave_2_tests"], "the command twin is not listed twice");
    commit(f.repo, { "a.txt": "two\n" }, "change");
    assert.equal(checkVerification(f.dataDir, { key: "test_commands.unit", command: "make -k test" }).code, 3);
  } finally { f.cleanup(); }
});

test("a project in a folder of a larger repository: a commit in a sibling folder keeps the proof", () => {
  const f = makeFixture();
  try {
    commit(f.repo, { "game/src/a.c": "a\n", "other/x.txt": "x\n" }, "two projects");
    const projectDir = join(f.repo, "game");
    recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath, projectDir });
    commit(f.repo, { "other/x.txt": "changed\n" }, "sibling project");
    assert.equal(checkVerification(f.dataDir, { key: "unit", command: "run tests" }).code, 0, "nothing under game/ changed");
    commit(f.repo, { "game/src/a.c": "b\n" }, "the project itself");
    assert.equal(checkVerification(f.dataDir, { key: "unit", command: "run tests" }).code, 3);
  } finally { f.cleanup(); }
});

test("verify_ignore: a commit that touches only listed paths keeps the proof; changing the list drops it", () => {
  const f = makeFixture();
  try {
    writeFileSync(join(f.dataDir, "config.md"), "---\nverify_ignore: [CHANGELOG.md, docs/]\n---\n");
    commit(f.repo, { "CHANGELOG.md": "v1\n", "docs/design.md": "d\n" }, "docs");
    recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath });
    commit(f.repo, { "CHANGELOG.md": "v2\n", "docs/design.md": "d2\n" }, "only documents");
    assert.equal(checkVerification(f.dataDir, { key: "unit", command: "run tests" }).code, 0);
    commit(f.repo, { "a.txt": "code\n", "CHANGELOG.md": "v3\n" }, "code too");
    assert.equal(checkVerification(f.dataDir, { key: "unit", command: "run tests" }).code, 3);
    recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath });
    writeFileSync(join(f.dataDir, "config.md"), "---\nverify_ignore: [CHANGELOG.md]\n---\n");
    const chk = checkVerification(f.dataDir, { key: "unit", command: "run tests" });
    assert.equal(chk.code, 3);
    assert.match(chk.message, /verify_ignore list changed/);
  } finally { f.cleanup(); }
});

test("a green run is proof only in the checkout the ledger is about: a builder's worktree records nothing and reuses nothing", () => {
  const f = makeFixture();
  const cwd = process.cwd();
  try {
    const wt = join(f.root, "wt");
    git(["worktree", "add", "-q", "-b", "shipyard/wt-P001", wt], f.repo);
    process.chdir(wt);
    assert.equal(inLedgerCheckout(f.dataDir), false);
    assert.equal(recordByCommand(f.dataDir, { command: "make -k test", capturePath: f.capturePath }), false);
    process.chdir(f.repo);
    assert.equal(reuseByCommand(f.dataDir, "make -k test"), null, "nothing was recorded from the worktree");
    assert.equal(recordByCommand(f.dataDir, { command: "make -k test", capturePath: f.capturePath }), true);
    assert.equal(reuseByCommand(f.dataDir, "make -k test")?.key, commandKey("make -k test"));
    process.chdir(wt);
    assert.equal(reuseByCommand(f.dataDir, "make -k test"), null, "the main checkout's proof says nothing about the worktree's code");
  } finally { process.chdir(cwd); f.cleanup(); }
});

test("an entry recorded before 4.0 (whole-repository tree, no idKind) is still honoured", () => {
  const f = makeFixture();
  try {
    recordVerification(f.dataDir, { key: "unit", command: "run tests", exitCode: 0, capturePath: f.capturePath });
    const p = join(f.dataDir, "sprints", "current", LEDGER_BASENAME);
    const led = JSON.parse(readFileSync(p, "utf8"));
    delete led.unit.idKind; delete led.unit.ignore;
    led.unit.treeId = git(["rev-parse", "HEAD^{tree}"], f.repo).trim();
    writeFileSync(p, JSON.stringify(led));
    assert.equal(checkVerification(f.dataDir, { key: "unit", command: "run tests" }).code, 0);
  } finally { f.cleanup(); }
});

test("a green `a && b && c` run proves each part; anything fancier is not split (4.0)", () => {
  assert.deepEqual(chainParts("zsh -c make && make -k -j8 test && make ui-check"), ["make", "make -k -j8 test", "make ui-check"]);
  assert.deepEqual(chainParts("make -k -j8 test"), []);
  assert.deepEqual(chainParts("sh -c cd src && make test"), [], "a cd changes what the next part means");
  assert.deepEqual(chainParts("make test >/dev/null && make check"), []);
  assert.deepEqual(chainParts("make test | tee log && make check"), []);
  assert.deepEqual(chainParts("make test; make check && make x"), []);
  const f = makeFixture();
  const cwd = process.cwd();
  try {
    process.chdir(f.repo);
    assert.equal(recordByCommand(f.dataDir, { command: "zsh -c make && make -k -j8 test && make ui-check", capturePath: f.capturePath }), true);
    assert.equal(checkVerification(f.dataDir, { key: "test_commands.unit", command: "make -k -j8 test" }).code, 0, "the test tier is proven by the step's chain");
    assert.equal(checkVerification(f.dataDir, { key: "test_commands.unit", command: "make -j8 test" }).code, 3);
  } finally { process.chdir(cwd); f.cleanup(); }
});
