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
