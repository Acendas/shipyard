/**
 * Parity tests for bin/hooks/session-guard.mjs.
 *
 * Mirrors the high-value cases from tests/test_session_guard.py and adds
 * coverage for the D7 soft-delete sentinel (skill: null / cleared field).
 *
 * Run via: node --test tests/test_session_guard.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run as runHook } from "../bin/hooks/session-guard.mjs";

async function withTempDirs(fn) {
  const sd = realpathSync(mkdtempSync(join(tmpdir(), "guard-sd-")));
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "guard-proj-")));
  try {
    return await fn(sd, proj);
  } finally {
    rmSync(sd, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

function writeSession(sd, content) {
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, ".active-session.json"), JSON.stringify(content));
}

async function runWithEnv(hookInput, sd, proj) {
  const captured = { stdout: "", stderr: "" };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => {
    captured.stdout += typeof c === "string" ? c : c.toString("utf8");
    return true;
  };
  process.stderr.write = (c) => {
    captured.stderr += typeof c === "string" ? c : c.toString("utf8");
    return true;
  };
  const origSd = process.env.SHIPYARD_DATA;
  const origProj = process.env.CLAUDE_PROJECT_DIR;
  process.env.SHIPYARD_DATA = sd;
  if (proj) process.env.CLAUDE_PROJECT_DIR = proj;
  let code;
  try {
    code = await runHook(hookInput, process.env);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    if (origSd === undefined) delete process.env.SHIPYARD_DATA;
    else process.env.SHIPYARD_DATA = origSd;
    if (origProj === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origProj;
  }
  return { ...captured, code };
}


// ---- Block decisions ----

test("session-guard: blocks .py source write during /ship-discuss", async () => {
  await withTempDirs(async (sd, proj) => {
    writeSession(sd, { skill: "ship-discuss", topic: "feature x" });
    const target = join(proj, "src", "main.py");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(target, ""); // make file exist for realpath
    const { code, stderr } = await runWithEnv(
      { tool_name: "Edit", tool_input: { file_path: target } },
      sd,
      proj,
    );
    assert.equal(code, 2);
    assert.ok(stderr.includes("SESSION GUARD"));
  });
});

test("session-guard: blocks NotebookEdit during ship-sprint", async () => {
  await withTempDirs(async (sd, proj) => {
    writeSession(sd, { skill: "ship-sprint", topic: "next sprint" });
    const target = join(proj, "src", "code.ts");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(target, "");
    const { code } = await runWithEnv(
      { tool_name: "NotebookEdit", tool_input: { file_path: target } },
      sd,
      proj,
    );
    assert.equal(code, 2);
  });
});

// ---- Allow decisions ----

test("session-guard: allows .md edit (extension allowlist)", async () => {
  await withTempDirs(async (sd, proj) => {
    writeSession(sd, { skill: "ship-discuss", topic: "feature x" });
    const target = join(proj, "src", "spec.md");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(target, "");
    const { code } = await runWithEnv(
      { tool_name: "Edit", tool_input: { file_path: target } },
      sd,
      proj,
    );
    assert.equal(code, 0);
  });
});

test("session-guard: allows write inside SHIPYARD_DATA (containment)", async () => {
  await withTempDirs(async (sd, proj) => {
    writeSession(sd, { skill: "ship-discuss", topic: "feature x" });
    const target = join(sd, "spec", "features", "F001-x.ts");
    mkdirSync(join(sd, "spec", "features"), { recursive: true });
    writeFileSync(target, "");
    const { code } = await runWithEnv(
      { tool_name: "Write", tool_input: { file_path: target } },
      sd,
      proj,
    );
    assert.equal(code, 0);
  });
});

test("session-guard: allows .claude/* writes (relative prefix)", async () => {
  await withTempDirs(async (sd, proj) => {
    writeSession(sd, { skill: "ship-discuss", topic: "x" });
    const target = join(proj, ".claude", "rules", "x.ts");
    mkdirSync(join(proj, ".claude", "rules"), { recursive: true });
    writeFileSync(target, "");
    const { code } = await runWithEnv(
      { tool_name: "Edit", tool_input: { file_path: target } },
      sd,
      proj,
    );
    assert.equal(code, 0);
  });
});

test("session-guard: allows when no session marker exists", async () => {
  await withTempDirs(async (sd, proj) => {
    // No session file written
    const target = join(proj, "src", "main.py");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(target, "");
    const { code } = await runWithEnv(
      { tool_name: "Edit", tool_input: { file_path: target } },
      sd,
      proj,
    );
    assert.equal(code, 0);
  });
});

test("session-guard: allows when session is for an impl skill (ship-execute)", async () => {
  await withTempDirs(async (sd, proj) => {
    writeSession(sd, { skill: "ship-execute", topic: "build" });
    const target = join(proj, "src", "main.py");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(target, "");
    const { code } = await runWithEnv(
      { tool_name: "Edit", tool_input: { file_path: target } },
      sd,
      proj,
    );
    assert.equal(code, 0);
  });
});

// ---- D7: soft-delete sentinel handling ----

test("session-guard D7: skill: null is treated as inactive", async () => {
  await withTempDirs(async (sd, proj) => {
    writeSession(sd, { skill: null, cleared: "2026-04-06T00:00:00Z" });
    const target = join(proj, "src", "main.py");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(target, "");
    const { code } = await runWithEnv(
      { tool_name: "Edit", tool_input: { file_path: target } },
      sd,
      proj,
    );
    assert.equal(code, 0, "skill: null sentinel must be treated as inactive");
  });
});

test("session-guard D7: cleared field alone is treated as inactive", async () => {
  await withTempDirs(async (sd, proj) => {
    writeSession(sd, { cleared: "2026-04-06T00:00:00Z" });
    const target = join(proj, "src", "main.py");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(target, "");
    const { code } = await runWithEnv(
      { tool_name: "Edit", tool_input: { file_path: target } },
      sd,
      proj,
    );
    assert.equal(code, 0, "cleared field must be treated as inactive");
  });
});

test("session-guard D7: missing skill key is inactive", async () => {
  await withTempDirs(async (sd, proj) => {
    writeSession(sd, { topic: "stale" });
    const target = join(proj, "src", "main.py");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(target, "");
    const { code } = await runWithEnv(
      { tool_name: "Edit", tool_input: { file_path: target } },
      sd,
      proj,
    );
    assert.equal(code, 0);
  });
});

// ---- Tool filter ----

test("session-guard: ignores Read tool (not guarded)", async () => {
  await withTempDirs(async (sd, proj) => {
    writeSession(sd, { skill: "ship-discuss" });
    const { code } = await runWithEnv(
      { tool_name: "Read", tool_input: { file_path: "/etc/passwd" } },
      sd,
      proj,
    );
    assert.equal(code, 0);
  });
});

test("session-guard: ignores Bash tool", async () => {
  await withTempDirs(async (sd, proj) => {
    writeSession(sd, { skill: "ship-discuss" });
    const { code } = await runWithEnv(
      { tool_name: "Bash", tool_input: { command: "echo hi" } },
      sd,
      proj,
    );
    assert.equal(code, 0);
  });
});

// ---- Breadcrumb log ----

test("session-guard: writes breadcrumb on block", async () => {
  await withTempDirs(async (sd, proj) => {
    writeSession(sd, { skill: "ship-discuss", topic: "x" });
    const target = join(proj, "src", "main.py");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(target, "");
    await runWithEnv(
      { tool_name: "Edit", tool_input: { file_path: target } },
      sd,
      proj,
    );
    const log = join(sd, ".session-guard.log");
    assert.ok(existsSync(log));
    const content = readFileSync(log, "utf8");
    assert.ok(content.includes("block"));
    assert.ok(content.includes("ship-discuss"));
  });
});

test("session-guard: writes breadcrumb on allow-no-session", async () => {
  await withTempDirs(async (sd, proj) => {
    const target = join(proj, "src", "main.py");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(target, "");
    await runWithEnv(
      { tool_name: "Edit", tool_input: { file_path: target } },
      sd,
      proj,
    );
    const log = join(sd, ".session-guard.log");
    assert.ok(existsSync(log));
    const content = readFileSync(log, "utf8");
    assert.ok(content.includes("allow-no-session"));
  });
});
