/**
 * Tests for the optional `--data-dir <path>` flag on `shipyard-data
 * task-return`, `shipyard-data events emit`, `shipyard-data anchor-commit`,
 * `shipyard-data task set-status`, `shipyard-data next-id`, and
 * `shipyard-data scan-stubs` (the last only redirects where the
 * `stub_scan_run` audit event lands — see test_scan_stubs_cli.mjs for the
 * scan/exit-code behavior itself).
 *
 * Why this flag exists: a builder subagent runs inside
 * `<parentRepo>/.claude/worktrees/agent-*`. When the ORCHESTRATOR itself is
 * running inside a user worktree of the same repo, the resolver's
 * builder-vs-user-worktree classification sends the two to different
 * project data dirs — so a builder that re-resolves its own data dir can
 * write its structured return where the orchestrator never looks. Passing
 * `--data-dir` explicitly (same spelling/shape as `init-sprint`'s existing
 * flag) lets the caller skip git-based resolution entirely.
 *
 * Run: node --test tests/test_data_dir_flag.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, "bin", "shipyard-data.mjs");

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "data-dir-flag-test-"));
  const repo = join(root, "repo");
  const realDataDir = join(root, "real-data");
  const explicitDataDir = join(root, "explicit-data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(realDataDir, { recursive: true });
  mkdirSync(explicitDataDir, { recursive: true });

  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "config", "commit.gpgsign", "false"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "hello\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  // Real data dir (what the resolver would pick via CLAUDE_PLUGIN_DATA).
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: realDataDir };
  delete env.SHIPYARD_DATA;

  const run = (args) => {
    try {
      const stdout = execFileSync("node", [CLI, ...args], {
        cwd: repo,
        env,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  };

  // CLAUDE_PLUGIN_DATA is the plugin-wide data root; the resolver appends
  // "projects/<hash>" to get the actual per-project data dir. Ask the CLI
  // itself for the resolved path rather than re-deriving the hash here.
  const resolvedDataDir = execFileSync("node", [CLI], { cwd: repo, env, encoding: "utf8" }).trim();

  return {
    root,
    repo,
    realDataDir: resolvedDataDir,
    explicitDataDir,
    sha,
    run,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function readEventsLog(dataDir) {
  const p = join(dataDir, ".shipyard-events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// --- events emit ---------------------------------------------------------

test("events emit: --data-dir honored, writes into the explicit dir not the resolved one", () => {
  const f = makeFixture();
  try {
    const r = f.run(["events", "emit", "my_event", "k=v", "--data-dir", f.explicitDataDir]);
    assert.equal(r.code, 0, r.stderr);
    const explicitEvents = readEventsLog(f.explicitDataDir);
    assert.equal(explicitEvents.length, 1);
    assert.equal(explicitEvents[0].type, "my_event");
    assert.equal(explicitEvents[0].k, "v");
    assert.equal(readEventsLog(f.realDataDir).length, 0);
  } finally {
    f.cleanup();
  }
});

test("events emit: absent --data-dir behaves exactly as before (resolver path)", () => {
  const f = makeFixture();
  try {
    const r = f.run(["events", "emit", "my_event", "k=v"]);
    assert.equal(r.code, 0, r.stderr);
    const events = readEventsLog(f.realDataDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "my_event");
  } finally {
    f.cleanup();
  }
});

test("events emit: invalid --data-dir path exits non-zero naming the flag", () => {
  const f = makeFixture();
  try {
    const r = f.run(["events", "emit", "my_event", "--data-dir", join(f.root, "does-not-exist")]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--data-dir/);
  } finally {
    f.cleanup();
  }
});

test("events emit: relative --data-dir path is refused", () => {
  const f = makeFixture();
  try {
    const r = f.run(["events", "emit", "my_event", "--data-dir", "relative/path"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--data-dir/);
    assert.match(r.stderr, /absolute/);
  } finally {
    f.cleanup();
  }
});

test("events emit: --data-dir pointing at a file (not a directory) is refused", () => {
  const f = makeFixture();
  try {
    const filePath = join(f.root, "not-a-dir.txt");
    writeFileSync(filePath, "x");
    const r = f.run(["events", "emit", "my_event", "--data-dir", filePath]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--data-dir/);
    assert.match(r.stderr, /directory/);
  } finally {
    f.cleanup();
  }
});

// --- task-return ----------------------------------------------------------

test("task-return: --data-dir honored, writes .subagent-returns into the explicit dir", () => {
  const f = makeFixture();
  try {
    const r = f.run([
      "task-return", "T-001",
      "status=COMPLETE", `commit=${f.sha}`, "probe-exit=0",
      "--data-dir", f.explicitDataDir,
    ]);
    assert.equal(r.code, 0, r.stderr);
    const explicitPath = join(f.explicitDataDir, "sprints", "current", ".subagent-returns", "T-001.json");
    assert.ok(existsSync(explicitPath), "expected return JSON in explicit data dir");
    const realPath = join(f.realDataDir, "sprints", "current", ".subagent-returns", "T-001.json");
    assert.ok(!existsSync(realPath), "return JSON must NOT land in the resolver-resolved data dir");
    const record = JSON.parse(readFileSync(explicitPath, "utf8"));
    assert.equal(record.task, "T-001");
    assert.equal(record.status, "COMPLETE");
    assert.equal(record.commit_sha, f.sha);
  } finally {
    f.cleanup();
  }
});

test("task-return: absent --data-dir behaves exactly as before (resolver path)", () => {
  const f = makeFixture();
  try {
    const r = f.run(["task-return", "T-002", "status=COMPLETE", `commit=${f.sha}`, "probe-exit=0"]);
    assert.equal(r.code, 0, r.stderr);
    const realPath = join(f.realDataDir, "sprints", "current", ".subagent-returns", "T-002.json");
    assert.ok(existsSync(realPath));
  } finally {
    f.cleanup();
  }
});

test("task-return: invalid --data-dir path exits non-zero naming the flag", () => {
  const f = makeFixture();
  try {
    const r = f.run([
      "task-return", "T-003",
      "status=COMPLETE", `commit=${f.sha}`, "probe-exit=0",
      "--data-dir", join(f.root, "does-not-exist"),
    ]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--data-dir/);
  } finally {
    f.cleanup();
  }
});

// --- anchor-commit ----------------------------------------------------------

test("anchor-commit: --data-dir honored, event log written into the explicit dir", () => {
  const f = makeFixture();
  try {
    const r = f.run(["anchor-commit", "T-004", f.sha, "--data-dir", f.explicitDataDir]);
    assert.equal(r.code, 0, r.stderr);
    const explicitEvents = readEventsLog(f.explicitDataDir).filter((e) => e.type === "task_commit_anchored");
    assert.equal(explicitEvents.length, 1);
    assert.equal(explicitEvents[0].task, "T-004");
    assert.equal(readEventsLog(f.realDataDir).filter((e) => e.type === "task_commit_anchored").length, 0);
    // The git ref is created regardless of --data-dir — it targets the
    // resolved project root, not the passed data dir.
    const ref = execFileSync("git", ["rev-parse", "shipyard/keep-T-004"], { cwd: f.repo, encoding: "utf8" }).trim();
    assert.equal(ref, f.sha);
  } finally {
    f.cleanup();
  }
});

test("anchor-commit: absent --data-dir behaves exactly as before (resolver path)", () => {
  const f = makeFixture();
  try {
    const r = f.run(["anchor-commit", "T-005", f.sha]);
    assert.equal(r.code, 0, r.stderr);
    const events = readEventsLog(f.realDataDir).filter((e) => e.type === "task_commit_anchored");
    assert.equal(events.length, 1);
    assert.equal(events[0].task, "T-005");
  } finally {
    f.cleanup();
  }
});

test("anchor-commit: invalid --data-dir path exits non-zero naming the flag", () => {
  const f = makeFixture();
  try {
    const r = f.run(["anchor-commit", "T-006", f.sha, "--data-dir", join(f.root, "does-not-exist")]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--data-dir/);
  } finally {
    f.cleanup();
  }
});

// --- task set-status --------------------------------------------------------

function makeTaskFile(dataDir, tid) {
  const dir = join(dataDir, "spec", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${tid}.md`),
    `---\nid: ${tid}\nstatus: pending\n---\n\n# ${tid}\n`,
  );
}

function readTaskFile(dataDir, tid) {
  return readFileSync(join(dataDir, "spec", "tasks", `${tid}.md`), "utf8");
}

test("task set-status: --data-dir honored, writes into the explicit dir not the resolved one", () => {
  const f = makeFixture();
  try {
    makeTaskFile(f.explicitDataDir, "T001");
    const r = f.run(["task", "set-status", "T001", "in-progress", "--data-dir", f.explicitDataDir]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readTaskFile(f.explicitDataDir, "T001"), /status:\s*in-progress/);
    const explicitEvents = readEventsLog(f.explicitDataDir).filter((e) => e.type === "task_status_set");
    assert.equal(explicitEvents.length, 1);
    assert.equal(readEventsLog(f.realDataDir).filter((e) => e.type === "task_status_set").length, 0);
  } finally {
    f.cleanup();
  }
});

test("task set-status: absent --data-dir behaves exactly as before (resolver path)", () => {
  const f = makeFixture();
  try {
    makeTaskFile(f.realDataDir, "T002");
    const r = f.run(["task", "set-status", "T002", "in-progress"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readTaskFile(f.realDataDir, "T002"), /status:\s*in-progress/);
  } finally {
    f.cleanup();
  }
});

test("task set-status: invalid --data-dir path exits non-zero naming the flag", () => {
  const f = makeFixture();
  try {
    const r = f.run([
      "task", "set-status", "T003", "in-progress",
      "--data-dir", join(f.root, "does-not-exist"),
    ]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--data-dir/);
  } finally {
    f.cleanup();
  }
});

// --- next-id ----------------------------------------------------------------

test("next-id: --data-dir honored, allocates against the explicit dir not the resolved one", () => {
  const f = makeFixture();
  try {
    const r = f.run(["next-id", "ideas", "--data-dir", f.explicitDataDir]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "001");
    assert.ok(existsSync(join(f.explicitDataDir, "spec", "ideas", ".id-seq")));
    assert.ok(!existsSync(join(f.realDataDir, "spec", "ideas", ".id-seq")));
  } finally {
    f.cleanup();
  }
});

test("next-id: absent --data-dir behaves exactly as before (resolver path)", () => {
  const f = makeFixture();
  try {
    const r = f.run(["next-id", "ideas"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "001");
    assert.ok(existsSync(join(f.realDataDir, "spec", "ideas", ".id-seq")));
  } finally {
    f.cleanup();
  }
});

test("next-id: invalid --data-dir path exits non-zero naming the flag", () => {
  const f = makeFixture();
  try {
    const r = f.run(["next-id", "ideas", "--data-dir", join(f.root, "does-not-exist")]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--data-dir/);
  } finally {
    f.cleanup();
  }
});

test("next-id: two concurrent allocations against the SAME explicit --data-dir return distinct ids (counter + lock both redirected)", async () => {
  const f = makeFixture();
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    // Run two allocations concurrently against the SAME explicit data dir,
    // from two different cwds that resolve to DIFFERENT project data dirs
    // (proving the flag — not incidental resolver agreement — is what
    // serializes them against each other).
    const otherRepo = join(f.root, "other-repo");
    mkdirSync(otherRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: otherRepo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "config", "commit.gpgsign", "false"], { cwd: otherRepo });
    writeFileSync(join(otherRepo, "README.md"), "hello\n");
    execFileSync("git", ["add", "-A"], { cwd: otherRepo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: otherRepo });

    const runEnv = { ...process.env, CLAUDE_PLUGIN_DATA: join(f.root, "real-data") };
    delete runEnv.SHIPYARD_DATA;

    const [a, b] = await Promise.all([
      execFileAsync("node", [CLI, "next-id", "ideas", "--data-dir", f.explicitDataDir], { cwd: f.repo, env: runEnv }),
      execFileAsync("node", [CLI, "next-id", "ideas", "--data-dir", f.explicitDataDir], { cwd: otherRepo, env: runEnv }),
    ]);
    const idA = a.stdout.trim();
    const idB = b.stdout.trim();
    assert.notEqual(idA, idB, `expected distinct ids, got ${idA} and ${idB}`);
    assert.deepEqual(new Set([idA, idB]), new Set(["001", "002"]));
  } finally {
    f.cleanup();
  }
});

// --- scan-stubs (event write only) ------------------------------------------

test("scan-stubs: --data-dir redirects only the stub_scan_run event write", () => {
  const f = makeFixture();
  try {
    writeFileSync(join(f.repo, "a.py"), "def f():\n    return 1\n");
    execFileSync("git", ["add", "-A"], { cwd: f.repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add a.py"], { cwd: f.repo });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim();
    writeFileSync(join(f.repo, "a.py"), "def f():\n    return 1\n\ndef g():\n    return 2\n");
    execFileSync("git", ["add", "-A"], { cwd: f.repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add g"], { cwd: f.repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim();

    const r = f.run(["scan-stubs", `${base}..${head}`, "--data-dir", f.explicitDataDir]);
    assert.equal(r.code, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(parsed.findings, []);
    const explicitEvents = readEventsLog(f.explicitDataDir).filter((e) => e.type === "stub_scan_run");
    assert.equal(explicitEvents.length, 1);
    assert.equal(readEventsLog(f.realDataDir).filter((e) => e.type === "stub_scan_run").length, 0);
  } finally {
    f.cleanup();
  }
});

test("scan-stubs: invalid --data-dir path exits non-zero naming the flag", () => {
  const f = makeFixture();
  try {
    const r = f.run(["scan-stubs", "HEAD~1..HEAD", "--data-dir", join(f.root, "does-not-exist")]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--data-dir/);
  } finally {
    f.cleanup();
  }
});

// --- feature / backlog / idea / config ------------------------------------
//
// These route into spec-state-cli exactly like `task` and `draft`, but used
// to parse `--data-dir` nowhere: the flag and its value fell through as stray
// positionals and the command wrote into the RESOLVED dir at exit 0 — a
// wrong-target write that looked like success.

function seedSpecDir(dataDir, { feature, idea, config, backlog } = {}) {
  mkdirSync(join(dataDir, "spec", "features"), { recursive: true });
  mkdirSync(join(dataDir, "spec", "ideas"), { recursive: true });
  if (feature) {
    writeFileSync(
      join(dataDir, "spec", "features", `${feature}-x.md`),
      `---\nid: ${feature}\nstatus: proposed\nrice_reach: 4\nrice_impact: 2\nrice_confidence: 1\nrice_effort: 2\nupdated: 2026-01-01\n---\n\n# x\n`,
    );
  }
  if (idea) {
    writeFileSync(
      join(dataDir, "spec", "ideas", `${idea}-x.md`),
      `---\nid: ${idea}\nstatus: proposed\n---\n\n# x\n`,
    );
  }
  if (backlog) {
    mkdirSync(join(dataDir, "backlog"), { recursive: true });
    writeFileSync(
      join(dataDir, "backlog", "BACKLOG.md"),
      "---\nlast_groomed: 2026-01-01\n---\n\n# Backlog\n\n| Rank | ID |\n|------|----|\n\n## Overrides\n",
    );
  }
  if (config) writeFileSync(join(dataDir, "config.md"), "---\nconfig_version: 5\n---\n");
}

test("feature set-status: --data-dir honored, mutates the explicit dir not the resolved one", () => {
  const f = makeFixture();
  try {
    seedSpecDir(f.explicitDataDir, { feature: "F001" });
    seedSpecDir(f.realDataDir, { feature: "F001" });
    const r = f.run(["feature", "set-status", "F001", "approved", "--data-dir", f.explicitDataDir]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(join(f.explicitDataDir, "spec", "features", "F001-x.md"), "utf8"), /status: approved/);
    // The resolved dir must be untouched — that is the whole point of the flag.
    assert.match(readFileSync(join(f.realDataDir, "spec", "features", "F001-x.md"), "utf8"), /status: proposed/);
  } finally {
    f.cleanup();
  }
});

test("backlog add: --data-dir honored", () => {
  const f = makeFixture();
  try {
    seedSpecDir(f.explicitDataDir, { feature: "F002", backlog: true });
    seedSpecDir(f.realDataDir, { backlog: true });
    f.run(["feature", "set-status", "F002", "approved", "--data-dir", f.explicitDataDir]);
    const r = f.run(["backlog", "add", "F002", "--data-dir", f.explicitDataDir]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(join(f.explicitDataDir, "backlog", "BACKLOG.md"), "utf8"), /\|\s*1\s*\|\s*F002\s*\|/);
    assert.doesNotMatch(readFileSync(join(f.realDataDir, "backlog", "BACKLOG.md"), "utf8"), /F002/);
  } finally {
    f.cleanup();
  }
});

test("idea set-status: --data-dir honored", () => {
  const f = makeFixture();
  try {
    seedSpecDir(f.explicitDataDir, { idea: "IDEA-001" });
    const r = f.run(["idea", "set-status", "IDEA-001", "rejected", "--data-dir", f.explicitDataDir]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(join(f.explicitDataDir, "spec", "ideas", "IDEA-001-x.md"), "utf8"), /status: rejected/);
  } finally {
    f.cleanup();
  }
});

test("config set / set-isolation: --data-dir honored on every config verb", () => {
  const f = makeFixture();
  try {
    seedSpecDir(f.explicitDataDir, { config: true });
    seedSpecDir(f.realDataDir, { config: true });

    const set = f.run(["config", "set", "product-spec-path", "docs/spec/", "--data-dir", f.explicitDataDir]);
    assert.equal(set.code, 0, set.stderr);
    // set-isolation is a sibling verb writing the SAME config.md; it must not
    // silently drop a flag its neighbour honors.
    const iso = f.run(["config", "set-isolation", "none", "--data-dir", f.explicitDataDir]);
    assert.equal(iso.code, 0, iso.stderr);

    const written = readFileSync(join(f.explicitDataDir, "config.md"), "utf8");
    assert.match(written, /product_spec_path: docs\/spec\//);
    assert.match(written, /isolation: none/);
    assert.equal(readFileSync(join(f.realDataDir, "config.md"), "utf8"), "---\nconfig_version: 5\n---\n");
  } finally {
    f.cleanup();
  }
});

test("feature: --data-dir validation errors are reported, not swallowed", () => {
  const f = makeFixture();
  try {
    const rel = f.run(["feature", "set-status", "F001", "approved", "--data-dir", "relative/path"]);
    assert.equal(rel.code, 2);
    assert.match(rel.stderr, /--data-dir path must be absolute/);
    const missing = f.run(["backlog", "rank", "--data-dir", join(f.root, "nope")]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--data-dir path does not exist/);
  } finally {
    f.cleanup();
  }
});
