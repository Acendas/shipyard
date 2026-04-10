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

// ---- session-guard dispatch ----

test("hook-runner: dispatches session-guard and allows when no session marker", () => {
  withTempProject(({ projectDir, pluginData }) => {
    const target = join(projectDir, "src", "main.py");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(target, "");
    const result = runHook(
      "session-guard",
      {
        tool_name: "Edit",
        tool_input: { file_path: target },
      },
      {
        CLAUDE_PROJECT_DIR: projectDir,
        SHIPYARD_DATA: pluginData,
      },
    );
    assert.equal(result.code, 0, `expected allow, got: ${result.stderr}`);
  });
});

test("hook-runner: session-guard blocks .py write during /ship-discuss", () => {
  withTempProject(({ projectDir, pluginData }) => {
    writeFileSync(
      join(pluginData, ".active-session.json"),
      JSON.stringify({ skill: "ship-discuss", topic: "test" }),
    );
    const target = join(projectDir, "src", "main.py");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(target, "");
    const result = runHook(
      "session-guard",
      {
        tool_name: "Edit",
        tool_input: { file_path: target },
      },
      {
        CLAUDE_PROJECT_DIR: projectDir,
        SHIPYARD_DATA: pluginData,
      },
    );
    assert.equal(result.code, 2, `expected block, got code ${result.code}`);
    assert.match(result.stderr, /SESSION GUARD/);
  });
});

test("hook-runner: session-guard treats `skill: null` as inactive (D7 sentinel)", () => {
  withTempProject(({ projectDir, pluginData }) => {
    writeFileSync(
      join(pluginData, ".active-session.json"),
      JSON.stringify({ skill: null, cleared: "2026-04-07T00:00:00Z" }),
    );
    const target = join(projectDir, "src", "main.py");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(target, "");
    const result = runHook(
      "session-guard",
      {
        tool_name: "Edit",
        tool_input: { file_path: target },
      },
      {
        CLAUDE_PROJECT_DIR: projectDir,
        SHIPYARD_DATA: pluginData,
      },
    );
    assert.equal(result.code, 0, "soft-delete sentinel must be treated as inactive");
  });
});

// ---- tdd-check dispatch ----

test("hook-runner: tdd-check exits 0 for non-commit Bash", () => {
  const result = runHook(
    "tdd-check",
    {
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    },
  );
  assert.equal(result.code, 0);
});

test("hook-runner: tdd-check honors --no-verify bypass", () => {
  const result = runHook(
    "tdd-check",
    {
      tool_name: "Bash",
      tool_input: { command: "git commit --no-verify -m foo" },
    },
  );
  assert.equal(result.code, 0);
});

// ---- post-compact dispatch (no stdin needed) ----

test("hook-runner: dispatches post-compact without stdin", () => {
  const result = runHook("post-compact", "");
  // post-compact should exit 0 cleanly even with no sprint state
  assert.equal(result.code, 0);
});

// ---- post-compact: counter lives on the execution lock ----
//
// Regression tests for the April 2026 compaction-counter refactor. The
// counter used to live in a sentinel file `.compaction-count` that any
// skill with an execution lock could leak increments into (see
// `skills/ship-execute/references/context-pressure.md` for the full
// story). The counter is now a field on `.active-execution.json`, gated by
// `tracks_compaction_pressure: true`. These tests pin that contract.

function writeActiveSprint(pluginData) {
  const sprintDir = join(pluginData, "sprints", "current");
  mkdirSync(sprintDir, { recursive: true });
  writeFileSync(
    join(sprintDir, "SPRINT.md"),
    "---\nid: S001\nstatus: active\nbranch: main\n---\n",
  );
}

function readLock(pluginData) {
  const path = join(pluginData, ".active-execution.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

test("hook-runner: post-compact increments counter on ship-execute lock", () => {
  withTempProject(({ projectDir, pluginData }) => {
    writeActiveSprint(pluginData);
    writeFileSync(
      join(pluginData, ".active-execution.json"),
      JSON.stringify({
        skill: "ship-execute",
        sprint: "S001",
        wave: "1",
        started: new Date().toISOString(),
        tracks_compaction_pressure: true,
        compaction_count: 0,
      }),
    );

    const r1 = runHook("post-compact", "", {
      CLAUDE_PROJECT_DIR: projectDir,
      SHIPYARD_DATA: pluginData,
    });
    assert.equal(r1.code, 0, `unexpected stderr: ${r1.stderr}`);
    const lock1 = readLock(pluginData);
    assert.equal(lock1.compaction_count, 1);
    assert.equal(lock1.skill, "ship-execute");
    assert.equal(lock1.tracks_compaction_pressure, true);

    const r2 = runHook("post-compact", "", {
      CLAUDE_PROJECT_DIR: projectDir,
      SHIPYARD_DATA: pluginData,
    });
    assert.equal(r2.code, 0);
    const lock2 = readLock(pluginData);
    assert.equal(lock2.compaction_count, 2);

    // stdout at count 2 is the "#N this sprint" silent-note form (below
    // warn threshold). Should not contain "pressure" or "pause".
    assert.ok(!/PRESSURE|pause/i.test(r2.stdout), r2.stdout);
  });
});

test("hook-runner: post-compact does NOT touch ship-quick lock (no opt-in)", () => {
  withTempProject(({ projectDir, pluginData }) => {
    writeActiveSprint(pluginData);
    const initialLock = {
      skill: "ship-quick",
      task: "unrelated quick task",
      started: new Date().toISOString(),
    };
    writeFileSync(
      join(pluginData, ".active-execution.json"),
      JSON.stringify(initialLock),
    );

    const r = runHook("post-compact", "", {
      CLAUDE_PROJECT_DIR: projectDir,
      SHIPYARD_DATA: pluginData,
    });
    assert.equal(r.code, 0);

    // Lock should be byte-for-byte unchanged — no counter added, no
    // last_compaction field, no mutation whatsoever. This is the bug that
    // motivated the refactor: ship-quick runs would silently inflate a
    // counter that ship-execute later consumed.
    const after = readLock(pluginData);
    assert.deepEqual(after, initialLock);
    assert.ok(!("compaction_count" in after));
    assert.ok(!("last_compaction" in after));
    assert.ok(!("tracks_compaction_pressure" in after));
  });
});

test("hook-runner: post-compact ignores cleared-sentinel lock", () => {
  withTempProject(({ projectDir, pluginData }) => {
    writeActiveSprint(pluginData);
    const cleared = {
      skill: null,
      cleared: new Date().toISOString(),
    };
    writeFileSync(
      join(pluginData, ".active-execution.json"),
      JSON.stringify(cleared),
    );

    const r = runHook("post-compact", "", {
      CLAUDE_PROJECT_DIR: projectDir,
      SHIPYARD_DATA: pluginData,
    });
    assert.equal(r.code, 0);
    const after = readLock(pluginData);
    assert.deepEqual(after, cleared);
  });
});

test("hook-runner: post-compact warns in stdout at count = 4", () => {
  withTempProject(({ projectDir, pluginData }) => {
    writeActiveSprint(pluginData);
    writeFileSync(
      join(pluginData, ".active-execution.json"),
      JSON.stringify({
        skill: "ship-execute",
        sprint: "S001",
        wave: "3",
        started: new Date().toISOString(),
        tracks_compaction_pressure: true,
        compaction_count: 3, // next bump takes us to 4
      }),
    );
    const r = runHook("post-compact", "", {
      CLAUDE_PROJECT_DIR: projectDir,
      SHIPYARD_DATA: pluginData,
    });
    assert.equal(r.code, 0);
    assert.equal(readLock(pluginData).compaction_count, 4);
    // At count 4 the hook should emit the "working memory is degrading"
    // warn line but NOT the hard auto-pause line.
    assert.match(r.stdout, /summarised 4 times|working memory/i);
    assert.ok(!/PRESSURE/.test(r.stdout) || /degrading/.test(r.stdout));
  });
});

test("hook-runner: post-compact emits pause recommendation at count >= 5", () => {
  withTempProject(({ projectDir, pluginData }) => {
    writeActiveSprint(pluginData);
    writeFileSync(
      join(pluginData, ".active-execution.json"),
      JSON.stringify({
        skill: "ship-execute",
        sprint: "S001",
        wave: "4",
        started: new Date().toISOString(),
        tracks_compaction_pressure: true,
        compaction_count: 4, // next bump takes us to 5 — pause threshold
      }),
    );
    const r = runHook("post-compact", "", {
      CLAUDE_PROJECT_DIR: projectDir,
      SHIPYARD_DATA: pluginData,
    });
    assert.equal(r.code, 0);
    assert.equal(readLock(pluginData).compaction_count, 5);
    assert.match(r.stdout, /CONTEXT PRESSURE|reconstructed 5 times/i);
    assert.match(r.stdout, /pause|fresh working memory/i);
    // Crucially, the hook should NOT use the old "quota" framing. That
    // wording is wrong on 1M-context models where rate limits are
    // decoupled from compaction.
    assert.ok(!/quota/i.test(r.stdout), `quota wording leaked: ${r.stdout}`);
  });
});

// ---- Event log emission across hooks ----
//
// Each hook that mutates state, blocks a tool call, or detects a
// significant condition emits a structured event into
// `.shipyard-events.jsonl`. These tests pin which events fire from
// which hooks under which conditions — the timeline is the primary
// diagnostic for support cases like "the sprint died, was it the
// counter or the builder?", so the contract matters.

function readEventsLog(pluginData) {
  const path = join(pluginData, ".shipyard-events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("hook-runner: post-compact emits compaction_detected on ship-execute lock", () => {
  withTempProject(({ projectDir, pluginData }) => {
    writeActiveSprint(pluginData);
    writeFileSync(
      join(pluginData, ".active-execution.json"),
      JSON.stringify({
        skill: "ship-execute",
        sprint: "S001",
        wave: "2",
        started: new Date().toISOString(),
        tracks_compaction_pressure: true,
        compaction_count: 0,
      }),
    );
    runHook("post-compact", "", { CLAUDE_PROJECT_DIR: projectDir, SHIPYARD_DATA: pluginData });
    const events = readEventsLog(pluginData);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "compaction_detected");
    // Sprint ID comes from SPRINT.md frontmatter (writeActiveSprint plants
    // S001), not from the lock — the hook is the authority on sprint id.
    assert.equal(events[0].sprint, "S001");
    assert.equal(events[0].count, 1);
    assert.equal(events[0].warn, false);
    assert.equal(events[0].pause, false);
  });
});

test("hook-runner: post-compact event marks warn=true at count 4", () => {
  withTempProject(({ projectDir, pluginData }) => {
    writeActiveSprint(pluginData);
    writeFileSync(
      join(pluginData, ".active-execution.json"),
      JSON.stringify({
        skill: "ship-execute",
        sprint: "S007",
        wave: "3",
        started: new Date().toISOString(),
        tracks_compaction_pressure: true,
        compaction_count: 3, // bumps to 4
      }),
    );
    runHook("post-compact", "", { CLAUDE_PROJECT_DIR: projectDir, SHIPYARD_DATA: pluginData });
    const ev = readEventsLog(pluginData).at(-1);
    assert.equal(ev.count, 4);
    assert.equal(ev.warn, true);
    assert.equal(ev.pause, false);
  });
});

test("hook-runner: post-compact event marks pause=true at count 5", () => {
  withTempProject(({ projectDir, pluginData }) => {
    writeActiveSprint(pluginData);
    writeFileSync(
      join(pluginData, ".active-execution.json"),
      JSON.stringify({
        skill: "ship-execute",
        sprint: "S007",
        wave: "4",
        started: new Date().toISOString(),
        tracks_compaction_pressure: true,
        compaction_count: 4, // bumps to 5
      }),
    );
    runHook("post-compact", "", { CLAUDE_PROJECT_DIR: projectDir, SHIPYARD_DATA: pluginData });
    const ev = readEventsLog(pluginData).at(-1);
    assert.equal(ev.count, 5);
    assert.equal(ev.warn, true);
    assert.equal(ev.pause, true);
  });
});

test("hook-runner: post-compact event marks tracked=false on non-tracking lock", () => {
  // Even ship-quick / ship-bug compactions should appear in the timeline
  // (so users debugging "my quick task died" can see when it compacted),
  // but the event must mark them as untracked so the diagnostic can tell
  // them apart from real ship-execute pressure events.
  withTempProject(({ projectDir, pluginData }) => {
    writeActiveSprint(pluginData);
    writeFileSync(
      join(pluginData, ".active-execution.json"),
      JSON.stringify({
        skill: "ship-quick",
        task: "tweak something",
        started: new Date().toISOString(),
      }),
    );
    runHook("post-compact", "", { CLAUDE_PROJECT_DIR: projectDir, SHIPYARD_DATA: pluginData });
    const events = readEventsLog(pluginData);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "compaction_detected");
    assert.equal(events[0].tracked, false);
    // Should NOT carry a count field — non-tracking locks don't have one.
    assert.ok(!("count" in events[0]));
  });
});

test("hook-runner: session-guard emits session_guard_blocked on block", () => {
  withTempProject(({ projectDir, pluginData }) => {
    // Plant a planning session marker so the guard blocks code edits.
    writeFileSync(
      join(pluginData, ".active-session.json"),
      JSON.stringify({ skill: "ship-discuss", topic: "auth refactor" }),
    );
    const target = join(projectDir, "src", "main.py");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(target, "");
    const result = runHook(
      "session-guard",
      { tool_name: "Edit", tool_input: { file_path: target } },
      { CLAUDE_PROJECT_DIR: projectDir, SHIPYARD_DATA: pluginData },
    );
    assert.equal(result.code, 2, `expected block (exit 2), got: ${result.stderr}`);
    const events = readEventsLog(pluginData);
    const block = events.find((e) => e.type === "session_guard_blocked");
    assert.ok(block, "expected a session_guard_blocked event");
    assert.equal(block.skill, "ship-discuss");
    assert.equal(block.tool, "Edit");
    assert.match(block.file, /main\.py$/);
  });
});

test("hook-runner: session-guard does NOT emit on allow", () => {
  withTempProject(({ projectDir, pluginData }) => {
    // No active session → guard allows everything → no event should fire.
    const target = join(projectDir, "src", "main.py");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(target, "");
    runHook(
      "session-guard",
      { tool_name: "Edit", tool_input: { file_path: target } },
      { CLAUDE_PROJECT_DIR: projectDir, SHIPYARD_DATA: pluginData },
    );
    const events = readEventsLog(pluginData);
    assert.equal(
      events.filter((e) => e.type === "session_guard_blocked").length,
      0,
      "allow path must not emit a block event",
    );
  });
});

test("hook-runner: tdd-check emits tdd_violation_detected on block", () => {
  withTempProject(({ projectDir, pluginData }) => {
    // Set up a real git repo with staged impl-only files so tdd-check
    // actually fires its violation path. Without git, the hook returns
    // early (no staged files) and never reaches the violation branch.
    execFileSync("git", ["init", "-q"], { cwd: projectDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: projectDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: projectDir });
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src", "x.ts"), "export const x = 1\n");
    execFileSync("git", ["add", "src/x.ts"], { cwd: projectDir });

    // Run tdd-check from the project dir so its `git diff --cached` sees
    // the staged file. runHook() spawns from process.cwd, so we use
    // spawnSync directly here to set cwd to the temp project.
    const result = spawnSync("node", [RUNNER, "tdd-check"], {
      cwd: projectDir,
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "feat: x"' },
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        SHIPYARD_DATA: pluginData,
      },
      timeout: 10000,
    });
    assert.equal(result.status, 2, `expected block (exit 2), got code=${result.status} stderr=${result.stderr}`);
    const events = readEventsLog(pluginData);
    const violation = events.find((e) => e.type === "tdd_violation_detected");
    assert.ok(violation, "expected tdd_violation_detected event");
    assert.equal(violation.impl_count, 1);
    assert.equal(violation.test_count, 0);
    assert.match(violation.first_file, /x\.ts$/);
  });
});

test("hook-runner: tdd-check emits tdd_bypass_used on --no-verify", () => {
  withTempProject(({ projectDir, pluginData }) => {
    runHook(
      "tdd-check",
      {
        tool_name: "Bash",
        tool_input: { command: 'git commit --no-verify -m "skip"' },
      },
      { CLAUDE_PROJECT_DIR: projectDir, SHIPYARD_DATA: pluginData },
    );
    const events = readEventsLog(pluginData);
    const bypass = events.find((e) => e.type === "tdd_bypass_used");
    assert.ok(bypass, "expected tdd_bypass_used event");
  });
});

test("hook-runner: cwd-restore emits agent_tool_returned for Agent calls", () => {
  withTempProject(({ projectDir, pluginData }) => {
    runHook(
      "cwd-restore",
      {
        tool_name: "Agent",
        tool_input: { subagent_type: "shipyard-builder" },
      },
      { CLAUDE_PROJECT_DIR: projectDir, SHIPYARD_DATA: pluginData },
    );
    const events = readEventsLog(pluginData);
    const ret = events.find((e) => e.type === "agent_tool_returned");
    assert.ok(ret, "expected agent_tool_returned event");
    assert.equal(ret.subagent, "shipyard-builder");
  });
});

test("hook-runner: cwd-restore does NOT emit for non-Agent tools", () => {
  withTempProject(({ projectDir, pluginData }) => {
    runHook(
      "cwd-restore",
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { CLAUDE_PROJECT_DIR: projectDir, SHIPYARD_DATA: pluginData },
    );
    const events = readEventsLog(pluginData);
    assert.equal(events.length, 0, "non-Agent calls must not emit events");
  });
});

test("hook-runner: post-compact is a no-op when no data dir can be resolved", () => {
  // Fail-loud per CLAUDE.md: if resolver can't find the data dir, the hook
  // must NOT fall back to `<cwd>/.shipyard`. It should return 0 silently
  // and touch nothing. This regression-tests the removal of the phantom
  // `.shipyard` fallback from post-compact.mjs.
  const result = runHook("post-compact", "", {
    // deliberately no SHIPYARD_DATA, no CLAUDE_PLUGIN_DATA, no
    // CLAUDE_PROJECT_DIR — resolver has nothing to work with
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});

// ---- cwd-restore dispatch ----

test("hook-runner: cwd-restore returns 0 for non-Agent tool", () => {
  withTempProject(({ projectDir }) => {
    const result = runHook(
      "cwd-restore",
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { CLAUDE_PROJECT_DIR: projectDir },
    );
    assert.equal(result.code, 0);
  });
});

// ---- loop-detect dispatch ----

test("hook-runner: loop-detect tracks edit count below threshold", () => {
  withTempProject(({ projectDir, pluginData }) => {
    const target = join(projectDir, "src", "x.ts");
    const result = runHook(
      "loop-detect",
      {
        tool_name: "Edit",
        tool_input: { file_path: target },
      },
      { SHIPYARD_DATA: pluginData },
    );
    assert.equal(result.code, 0);
    // No loop warning yet (count = 1)
    assert.equal(result.stdout, "");
    // State file should now exist
    assert.ok(existsSync(join(pluginData, ".loop-state.json")));
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
