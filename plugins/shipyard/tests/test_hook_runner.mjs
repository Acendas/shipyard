/**
 * Integration tests for bin/hook-runner.mjs in-process dispatch.
 *
 * The runner is the dispatcher for every hook fired by Claude Code. After
 * Phase H3, dispatch is in-process via dynamic import — these tests
 * exercise that path end-to-end without going through Claude Code.
 *
 * Run via:  node --test tests/test_hook_runner.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(__dirname, "..", "bin", "hook-runner.mjs");

function withTempProject(fn) {
  // realpath both dirs so the hook's containment + project-dir checks
  // see the same paths the test creates
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hook-runner-test-")));
  const projectDir = join(root, "project");
  const pluginData = join(root, "plugin-data");
  mkdirSync(projectDir);
  mkdirSync(pluginData);
  try {
    return fn({ root, projectDir, pluginData });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runHook(name, input, env = {}) {
  // Build a clean env: start from process.env, then explicitly delete the
  // Claude Code keys so we don't inherit accidental state, then layer the
  // test's env on top. Avoids Node's "undefined → string 'undefined'" trap.
  const childEnv = { ...process.env };
  delete childEnv.CLAUDE_PROJECT_DIR;
  delete childEnv.CLAUDE_PLUGIN_DATA;
  delete childEnv.CLAUDE_PLUGIN_ROOT;
  delete childEnv.SHIPYARD_DATA;
  Object.assign(childEnv, env);

  const result = spawnSync("node", [RUNNER, name], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: childEnv,
    timeout: 10000,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    code: result.status ?? -1,
  };
}

// ---- Dispatcher contract ----

test("hook-runner: missing script name exits 1", () => {
  const result = runHook("", "");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /missing script name/);
});

test("hook-runner: invalid hook name (path traversal) is rejected", () => {
  const result = runHook("../etc/passwd", "");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid hook name/);
});

test("hook-runner: invalid hook name (uppercase) is rejected", () => {
  const result = runHook("Auto-Approve-Data", "");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid hook name/);
});

test("hook-runner: nonexistent hook name exits 1 with clear error", () => {
  const result = runHook("nonexistent-hook", "");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no such hook/);
});

// ---- auto-approve-data dispatch ----

test("hook-runner: dispatches auto-approve-data and approves write inside SHIPYARD_DATA", () => {
  withTempProject(({ projectDir, pluginData }) => {
    const result = runHook(
      "auto-approve-data",
      {
        tool_name: "Edit",
        tool_input: { file_path: join(pluginData, "spec.md") },
      },
      {
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_PLUGIN_DATA: pluginData,
        SHIPYARD_DATA: pluginData,
      },
    );
    assert.equal(result.code, 0, `unexpected stderr: ${result.stderr}`);
    if (result.stdout) {
      const resp = JSON.parse(result.stdout);
      assert.equal(resp.hookSpecificOutput.permissionDecision, "allow");
    }
  });
});

test("a discussion cannot edit a project file; its own rule files, another session and a session that is building are left alone (4.20)", () => {
  withTempProject(({ projectDir, pluginData }) => {
    const env = { CLAUDE_PROJECT_DIR: projectDir, CLAUDE_PLUGIN_DATA: pluginData, SHIPYARD_DATA: pluginData };
    const edit = (file, session) => runHook("auto-approve-data", { tool_name: "Edit", session_id: session, tool_input: { file_path: file } }, env);
    const decision = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : "pass");
    const src = join(projectDir, "src.c");
    writeFileSync(src, "int x;\n");
    assert.equal(decision(edit(src, "s1")), "pass", "no discussion is running");
    writeFileSync(join(pluginData, ".active-discuss.json"), JSON.stringify({ skill: "ship-discuss", session_id: "s1", pid: process.pid }));
    const denied = edit(src, "s1");
    assert.equal(decision(denied), "deny");
    assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /a discussion writes specs, never the project/);
    assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /ship-execute --task/);
    assert.equal(decision(edit(src, "builder-session")), "pass", "a sprint running beside the discussion still builds");
    assert.equal(decision(edit(src, undefined)), "pass", "no session id: never guessed");
    mkdirSync(join(projectDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(projectDir, ".claude", "rules", "project-ui.md"), "x\n");
    assert.equal(decision(edit(join(projectDir, ".claude", "rules", "project-ui.md"), "s1")), "pass", "the project's rule files may be amended");
    writeFileSync(join(projectDir, "CLAUDE.md"), "x\n");
    assert.equal(decision(edit(join(projectDir, "CLAUDE.md"), "s1")), "pass", "CLAUDE.md is a rule file too");
    assert.equal(decision(edit(join(pluginData, "spec.md"), "s1")), "allow", "its own data is still its own");
    // A draft in the session's own scratch folder is not the project (after 4.0.2, live: three drafts were
    // refused as "a project file" and went into the data folder instead). The repository the project's folder
    // sits in still is.
    const scratch = mkdtempSync(join(tmpdir(), "scratch-"));
    try {
      assert.equal(decision(edit(join(scratch, "draft.md"), "s1")), "pass", "outside the project: not this rule's business");
      const repo = mkdtempSync(join(tmpdir(), "mono-"));
      mkdirSync(join(repo, ".git")); mkdirSync(join(repo, "app")); mkdirSync(join(repo, "lib"));
      writeFileSync(join(repo, "lib", "x.c"), "int y;\n");
      writeFileSync(join(pluginData, ".project-root"), join(repo, "app") + "\n");
      assert.equal(decision(edit(join(repo, "lib", "x.c"), "s1")), "deny", "a sibling folder of the same repository");
      assert.equal(decision(edit(join(scratch, "draft.md"), "s1")), "pass");
      rmSync(join(pluginData, ".project-root")); rmSync(repo, { recursive: true, force: true });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    // the owner lists where this project records its decisions (4.20.1)
    mkdirSync(join(projectDir, "docs", "ui"), { recursive: true });
    writeFileSync(join(projectDir, "docs", "game-design.md"), "x\n"); writeFileSync(join(projectDir, "docs", "ui", "rules.md"), "x\n"); writeFileSync(join(projectDir, "docs", "notes.md"), "x\n");
    assert.equal(decision(edit(join(projectDir, "docs", "game-design.md"), "s1")), "deny");
    writeFileSync(join(pluginData, "config.md"), "---\nconfig_version: 5\ndiscuss_writable: [docs/game-design.md, docs/ui/**]\n---\n");
    assert.equal(decision(edit(join(projectDir, "docs", "game-design.md"), "s1")), "pass");
    assert.equal(decision(edit(join(projectDir, "docs", "ui", "rules.md"), "s1")), "pass");
    assert.equal(decision(edit(join(projectDir, "docs", "notes.md"), "s1")), "deny", "a document that is not listed stays read-only");
    assert.equal(decision(edit(src, "s1")), "deny", "source code is never on the list by accident");
    writeFileSync(join(pluginData, ".active-execution.json"), JSON.stringify({ skill: "ship-execute", session_id: "s1", pid: process.pid }));
    assert.equal(decision(edit(src, "s1")), "pass", "the same session went on to build: the execution lock wins");
  });
});

test("hook-runner: dispatches auto-approve-data and stays silent for non-guarded tool", () => {
  withTempProject(({ projectDir, pluginData }) => {
    const result = runHook(
      "auto-approve-data",
      {
        tool_name: "Read",
        tool_input: { file_path: join(pluginData, "spec.md") },
      },
      {
        CLAUDE_PROJECT_DIR: projectDir,
        SHIPYARD_DATA: pluginData,
      },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  });
});

// ---- Stdin handling ----

test("hook-runner: handles invalid JSON stdin gracefully", () => {
  withTempProject(({ pluginData }) => {
    const result = runHook("auto-approve-data", "not json at all", {
      SHIPYARD_DATA: pluginData,
    });
    // Should not crash; should exit 0 (silently ignore unparseable input)
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  });
});

test("hook-runner: handles empty stdin gracefully for hooks that need input", () => {
  withTempProject(({ pluginData }) => {
    const result = runHook("auto-approve-data", "", {
      SHIPYARD_DATA: pluginData,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  });
});

// ---- lock-reap (SessionEnd) ----

function seedPlanningLock(dataDir, sessionId) {
  writeFileSync(
    join(dataDir, ".active-session.json"),
    JSON.stringify({
      skill: "ship-discuss",
      sprint: null,
      wave: null,
      started: new Date().toISOString(),
      session_id: sessionId,
      cleared: null,
      depth: 1,
    }),
  );
}

test("hook-runner: lock-reap releases the ending session's held lock", () => {
  withTempProject(({ pluginData }) => {
    seedPlanningLock(pluginData, "sessA");
    const result = runHook("lock-reap", { session_id: "sessA", reason: "clear" }, { SHIPYARD_DATA: pluginData });
    assert.equal(result.code, 0);
    const lock = JSON.parse(readFileSync(join(pluginData, ".active-session.json"), "utf8"));
    assert.equal(lock.skill, null, "the ending session's lock is released");
    assert.ok(lock.cleared, "release writes the cleared sentinel");
  });
});

test("hook-runner: lock-reap leaves a different session's lock held", () => {
  withTempProject(({ pluginData }) => {
    seedPlanningLock(pluginData, "sessA");
    const result = runHook("lock-reap", { session_id: "sessB", reason: "logout" }, { SHIPYARD_DATA: pluginData });
    assert.equal(result.code, 0);
    const lock = JSON.parse(readFileSync(join(pluginData, ".active-session.json"), "utf8"));
    assert.equal(lock.skill, "ship-discuss", "a concurrent session's lock is untouched");
  });
});

test("hook-runner: lock-reap is a silent no-op with no session_id", () => {
  withTempProject(({ pluginData }) => {
    seedPlanningLock(pluginData, "sessA");
    const result = runHook("lock-reap", { reason: "other" }, { SHIPYARD_DATA: pluginData });
    assert.equal(result.code, 0);
    const lock = JSON.parse(readFileSync(join(pluginData, ".active-session.json"), "utf8"));
    assert.equal(lock.skill, "ship-discuss");
  });
});
