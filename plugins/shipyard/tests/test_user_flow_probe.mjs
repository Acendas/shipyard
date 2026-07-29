/**
 * Tests for the user_flow_probe surface:
 *   - readUserFlowProbe()               (bin/spec-state-cli.mjs)
 *   - `shipyard-data feature record-proof`
 *   - readinessCheck() / classifyPaths() (bin/readiness-check.mjs)
 *
 * Both modules are exercised in-process (pure functions) and the CLI verb as
 * a direct specStateCmd call, mirroring test_scan_stubs_cli.mjs's throwaway-
 * fixture pattern without needing a full plugin-data resolve.
 *
 * Run: node --test tests/test_user_flow_probe.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { readUserFlowProbe, specStateCmd } = await import(join(PLUGIN_ROOT, "bin", "spec-state-cli.mjs"));
const { readinessCheck, classifyPaths } = await import(join(PLUGIN_ROOT, "bin", "readiness-check.mjs"));

const fm = (s) => s.match(/^---\n([\s\S]*?)\n---/)[1];

// --- readUserFlowProbe -------------------------------------------------------

test("mapping form reports its kind", () => {
  const p = readUserFlowProbe(fm(`---
id: F001
user_flow_probe:
  kind: assisted
  command: ./deploy.sh
  steps: |
    1. Tap it.
---
`));
  assert.equal(p.shape, "mapping");
  assert.equal(p.kind, "assisted");
  assert.equal(p.legacy, false);
});

test("legacy scalar demo_probe reads as kind: auto and is flagged legacy", () => {
  // The compat path: existing projects carry a bare command scalar. It must
  // keep working for a release rather than forcing a data migration.
  const p = readUserFlowProbe(fm(`---
id: F002
demo_probe: |
  curl -fsS localhost:3000/health
---
`));
  assert.equal(p.shape, "scalar");
  assert.equal(p.kind, "auto");
  assert.equal(p.legacy, true);
});

test("skip-with-reason is its own shape, not a kind", () => {
  // Load-bearing: skip means NO proof of any kind exists. A hand-checked flow
  // is kind: manual. Collapsing the two is the inversion this work removed.
  const p = readUserFlowProbe(fm(`---
id: F003
user_flow_probe: skip-with-reason
user_flow_probe_skip_reason: "no user-facing surface"
---
`));
  assert.equal(p.shape, "skip");
  assert.equal(p.kind, undefined);
});

test("absent field is absent, not a false kind", () => {
  assert.equal(readUserFlowProbe(fm("---\nid: F004\n---\n")).shape, "absent");
});

test("user_flow_probe wins over a stale legacy demo_probe in the same file", () => {
  const p = readUserFlowProbe(fm(`---
id: F005
user_flow_probe:
  kind: manual
  steps: |
    1. Look at it.
demo_probe: |
  ./old-thing.sh
---
`));
  assert.equal(p.kind, "manual");
  assert.equal(p.legacy, false);
});

// --- feature record-proof ----------------------------------------------------

function fixture(body) {
  const dir = mkdtempSync(join(tmpdir(), "ufp-test-"));
  mkdirSync(join(dir, "spec", "features"), { recursive: true });
  writeFileSync(join(dir, "spec", "features", "F001-x.md"), body);
  return dir;
}

/** Run specStateCmd in a child so its process.exit doesn't kill the test run. */
function runCli(dataDir, args) {
  const src = `import('${join(PLUGIN_ROOT, "bin", "spec-state-cli.mjs")}').then(m=>m.specStateCmd(${JSON.stringify(dataDir)}, ${JSON.stringify(args)}))`;
  try {
    const stdout = execFileSync(process.execPath, ["-e", src], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const ASSISTED = `---
id: F001
updated: 2026-01-01
user_flow_probe:
  kind: assisted
  command: ./deploy.sh
  steps: |
    1. Tap Create Account.
---
# X
`;

test("records a human verdict as evidence and emits the event", () => {
  const d = fixture(ASSISTED);
  const r = runCli(d, ["feature", "record-proof", "F001", "verdict=pass", "confirmed-by=mafahir", "commit=abc1234"]);
  assert.equal(r.code, 0);

  const written = readFileSync(join(d, "spec", "features", "F001-x.md"), "utf8");
  assert.match(written, /last_verdict: pass/);
  assert.match(written, /last_confirmed_by: "mafahir"/);
  assert.match(written, /last_commit: abc1234/);

  const events = readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const ev = events.find((e) => e.type === "user_flow_probe_confirmed");
  assert.ok(ev, "user_flow_probe_confirmed must be emitted — invariant 8 reads it");
  assert.equal(ev.verdict, "pass");
  assert.equal(ev.kind, "assisted");
});

test("the defining keys stay above the appended verdict record", () => {
  // Purely a readability contract, but feature files are hand-read: the
  // definition (kind/command/steps) must not get buried under the record.
  const d = fixture(ASSISTED);
  runCli(d, ["feature", "record-proof", "F001", "verdict=pass", "confirmed-by=x", "commit=abc1234"]);
  const w = readFileSync(join(d, "spec", "features", "F001-x.md"), "utf8");
  assert.ok(w.indexOf("kind: assisted") < w.indexOf("last_verdict"));
});

test("a trailing block scalar survives the write", () => {
  const d = fixture(ASSISTED);
  runCli(d, ["feature", "record-proof", "F001", "verdict=fail", "confirmed-by=x", "commit=abc1234"]);
  assert.match(readFileSync(join(d, "spec", "features", "F001-x.md"), "utf8"), /1\. Tap Create Account\./);
});

test("refuses to hand-record a verdict for an auto probe", () => {
  // An auto probe's verdict IS its exit code; accepting a typed verdict here
  // would let a green claim bypass the run entirely.
  const d = fixture(`---\nid: F001\nupdated: 2026-01-01\ndemo_probe: |\n  ./x.sh\n---\n# X\n`);
  const r = runCli(d, ["feature", "record-proof", "F001", "verdict=pass", "confirmed-by=x", "commit=abc1234"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /kind: auto/);
});

test("refuses on skip-with-reason and points at kind: manual", () => {
  const d = fixture(`---\nid: F001\nupdated: 2026-01-01\nuser_flow_probe: skip-with-reason\nuser_flow_probe_skip_reason: "x"\n---\n# X\n`);
  const r = runCli(d, ["feature", "record-proof", "F001", "verdict=pass", "confirmed-by=x", "commit=abc1234"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /kind: manual/);
});

test("refuses an unattributed verdict", () => {
  const d = fixture(ASSISTED);
  const r = runCli(d, ["feature", "record-proof", "F001", "verdict=pass", "commit=abc1234"]);
  assert.equal(r.code, 2);
});

test("refuses a non-sha commit", () => {
  const d = fixture(ASSISTED);
  const r = runCli(d, ["feature", "record-proof", "F001", "verdict=pass", "confirmed-by=x", "commit=HEAD"]);
  assert.equal(r.code, 3);
});

test("refuses when no probe is authored at all", () => {
  const d = fixture(`---\nid: F001\nupdated: 2026-01-01\n---\n# X\n`);
  const r = runCli(d, ["feature", "record-proof", "F001", "verdict=pass", "confirmed-by=x", "commit=abc1234"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /ship-discuss/);
});

// --- readiness-check ---------------------------------------------------------

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "readiness-test-"));
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(data, "sprints", "current"), { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "pipe" });
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "hi\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  g("branch", "feat/s8");
  writeFileSync(join(data, "sprints", "current", "SPRINT.md"), "---\nbranch: feat/s8\n---\n");
  return { repo, data, g };
}

test("clean tree on the wrong branch switches without asking", () => {
  const { repo, data } = makeRepo();
  const r = readinessCheck(repo, data);
  assert.equal(r.must_ask, false);
  assert.deepEqual(r.actions.map((a) => a.code), ["switch_branch"]);
});

test("leftover worktree branch is a derived switch, never an ask", () => {
  // This used to be an AskUserQuestion offering exactly ONE option, which is
  // not a decision — the single-option ask this work removed.
  const { repo, data, g } = makeRepo();
  g("checkout", "-q", "-b", "shipyard/wt-agent-1");
  const r = readinessCheck(repo, data);
  assert.equal(r.on_wt_branch, true);
  assert.equal(r.must_ask, false);
  assert.deepEqual(r.actions.map((a) => a.code), ["switch_branch"]);
});

test("dirty tree on the right branch commits without asking", () => {
  const { repo, data, g } = makeRepo();
  g("checkout", "-q", "feat/s8");
  writeFileSync(join(repo, "a.txt"), "changed\n");
  const r = readinessCheck(repo, data);
  assert.equal(r.must_ask, false);
  assert.deepEqual(r.actions.map((a) => a.code), ["commit_dirty"]);
});

test("dirty tree AND wrong branch is genuinely ambiguous -> ask", () => {
  // The two individually-safe actions conflict: committing lands the work on
  // the wrong branch, switching carries it across. Only combination that asks.
  const { repo, data } = makeRepo();
  writeFileSync(join(repo, "a.txt"), "changed\n");
  const r = readinessCheck(repo, data);
  assert.equal(r.must_ask, true);
  assert.deepEqual(r.ask_reasons.map((x) => x.code), ["dirty_and_branch_mismatch"]);
});

test("a missing target branch asks instead of guessing", () => {
  const { repo, data, g } = makeRepo();
  g("branch", "-D", "feat/s8");
  const r = readinessCheck(repo, data);
  assert.equal(r.must_ask, true);
  assert.ok(r.ask_reasons.some((x) => x.code === "target_branch_missing"));
});

test("clean tree on the right branch does nothing at all", () => {
  const { repo, data, g } = makeRepo();
  g("checkout", "-q", "feat/s8");
  const r = readinessCheck(repo, data);
  assert.equal(r.must_ask, false);
  assert.deepEqual(r.actions, []);
});

test("a failing baseline always asks and is never auto-resolved", () => {
  const { repo, data, g } = makeRepo();
  g("checkout", "-q", "feat/s8");
  const r = readinessCheck(repo, data, { baselineFailing: true });
  assert.equal(r.must_ask, true);
  assert.ok(r.ask_reasons.some((x) => x.code === "baseline_failing"));
});

test("classifyPaths separates artifacts from real source", () => {
  const { repo } = makeRepo();
  writeFileSync(join(repo, ".gitignore"), "dist/\n");
  const c = classifyPaths(repo, ["dist/app.js", "package-lock.json", "src/main.ts", ".DS_Store"]);
  assert.deepEqual(c.source, ["src/main.ts"]);
  assert.deepEqual(c.generated, ["package-lock.json"]);
  assert.equal(c.artifact_only, false);
});

test("an artifact-only set needs no interrupt", () => {
  const { repo } = makeRepo();
  const c = classifyPaths(repo, ["build/out.o", ".DS_Store", "yarn.lock"]);
  assert.equal(c.artifact_only, true);
});
