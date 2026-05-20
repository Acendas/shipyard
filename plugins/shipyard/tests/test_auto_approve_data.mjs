/**
 * Parity tests for bin/hooks/auto-approve-data.mjs.
 *
 * Mirrors tests/test_auto_approve_data.py case-for-case. Run via:
 *   node --test tests/test_auto_approve_data.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run as runHook } from "../bin/hooks/auto-approve-data.mjs";

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "auto-approve-test-"));
  const real = realpathSync(dir);
  try {
    return await fn(real);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runWithEnv(hookInput, env) {
  // Capture stdout from the hook by stubbing process.stdout.write.
  const originalWrite = process.stdout.write.bind(process.stdout);
  const captured = [];
  process.stdout.write = (chunk) => {
    captured.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return true;
  };
  // Set env vars for the duration of the call.
  const orig = {};
  for (const k of Object.keys(env || {})) {
    orig[k] = process.env[k];
    process.env[k] = env[k];
  }
  // Always clear SHIPYARD_DATA unless overridden, to match Python test setup.
  if (!("SHIPYARD_DATA" in (env || {}))) {
    orig.SHIPYARD_DATA = process.env.SHIPYARD_DATA;
    delete process.env.SHIPYARD_DATA;
  }
  let code;
  try {
    code = await runHook(hookInput, process.env);
  } finally {
    process.stdout.write = originalWrite;
    for (const k of Object.keys(orig)) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  }
  return { stdout: captured.join(""), code };
}

test("auto-approve: approves Edit to file inside SHIPYARD_DATA", async () => {
  await withTempDir(async (sd) => {
    const { stdout, code } = await runWithEnv(
      { tool_name: "Edit", tool_input: { file_path: join(sd, "spec.md") } },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    const resp = JSON.parse(stdout);
    assert.equal(resp.hookSpecificOutput.permissionDecision, "allow");
  });
});

test("auto-approve: approves Write to nested subdir", async () => {
  await withTempDir(async (sd) => {
    const nested = join(sd, "sprints", "s1", "SPRINT.md");
    const { stdout, code } = await runWithEnv(
      { tool_name: "Write", tool_input: { file_path: nested } },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    const resp = JSON.parse(stdout);
    assert.equal(resp.hookSpecificOutput.permissionDecision, "allow");
  });
});

test("auto-approve: approves MultiEdit (not just Edit) to SHIPYARD_DATA", async () => {
  await withTempDir(async (sd) => {
    const { stdout, code } = await runWithEnv(
      { tool_name: "MultiEdit", tool_input: { file_path: join(sd, "spec.md") } },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    const resp = JSON.parse(stdout);
    assert.equal(resp.hookSpecificOutput.permissionDecision, "allow");
  });
});

test("auto-approve: rejects write outside SHIPYARD_DATA (no JSON output)", async () => {
  await withTempDir(async (sd) => {
    const { stdout, code } = await runWithEnv(
      {
        tool_name: "Edit",
        tool_input: { file_path: "/home/user/project/src/main.py" },
      },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });
});

test("auto-approve: rejects path with .. traversal segment", async () => {
  await withTempDir(async (sd) => {
    const traversal = join(sd, "..", "etc", "passwd");
    const { stdout, code } = await runWithEnv(
      { tool_name: "Write", tool_input: { file_path: traversal } },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });
});

test("auto-approve: rejects symlink escape (TOCTOU defense)", async () => {
  await withTempDir(async (sd) => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    try {
      const link = join(sd, "evil");
      symlinkSync(outside, link);
      const target = join(link, "pwned.txt");
      const { stdout, code } = await runWithEnv(
        { tool_name: "Write", tool_input: { file_path: target } },
        { SHIPYARD_DATA: sd },
      );
      assert.equal(code, 0);
      assert.equal(stdout, "", "symlink escape must NOT be approved");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("auto-approve: ignores non-file tools (Bash)", async () => {
  await withTempDir(async (sd) => {
    const { stdout, code } = await runWithEnv(
      { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });
});

test("auto-approve: ignores missing file_path", async () => {
  await withTempDir(async (sd) => {
    const { stdout, code } = await runWithEnv(
      { tool_name: "Edit", tool_input: {} },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });
});

test("auto-approve: Read tool no longer approved (scope reduction)", async () => {
  await withTempDir(async (sd) => {
    const { stdout, code } = await runWithEnv(
      {
        tool_name: "Read",
        tool_input: { file_path: join(sd, "backlog.md") },
      },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });
});

test("auto-approve: prefix attack (sibling -evil dir) not approved", async () => {
  await withTempDir(async (sd) => {
    const sibling = sd + "-evil";
    mkdirSync(sibling, { recursive: true });
    try {
      const { stdout, code } = await runWithEnv(
        {
          tool_name: "Write",
          tool_input: { file_path: join(sibling, "hack.py") },
        },
        { SHIPYARD_DATA: sd },
      );
      assert.equal(code, 0);
      assert.equal(stdout, "");
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

test("auto-approve: dotdot segments rejected pre-resolution", async () => {
  await withTempDir(async (sd) => {
    const target = sd + "/subdir/../../../etc/passwd";
    const { stdout, code } = await runWithEnv(
      { tool_name: "Write", tool_input: { file_path: target } },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });
});

test("auto-approve: breadcrumb log written on allow", async () => {
  await withTempDir(async (sd) => {
    await runWithEnv(
      {
        tool_name: "Edit",
        tool_input: { file_path: join(sd, "spec.md") },
      },
      { SHIPYARD_DATA: sd },
    );
    const log = join(sd, ".auto-approve.log");
    assert.ok(existsSync(log), "breadcrumb log should be created");
    const content = readFileSync(log, "utf8");
    assert.ok(content.includes("allow"));
    assert.ok(content.includes("Edit"));
  });
});

test("auto-approve: breadcrumb creates data dir if missing (R12)", async () => {
  await withTempDir(async (sd) => {
    const fresh = join(sd, "fresh-data-dir");
    assert.equal(existsSync(fresh), false);
    const target = join(fresh, "spec.md");
    await runWithEnv(
      { tool_name: "Edit", tool_input: { file_path: target } },
      { SHIPYARD_DATA: fresh },
    );
    const log = join(fresh, ".auto-approve.log");
    assert.ok(
      existsSync(log),
      "first-run breadcrumb should create the data dir and write the log",
    );
  });
});

test("auto-approve: breadcrumb log written on pass (file outside data dir)", async () => {
  await withTempDir(async (sd) => {
    const outside = mkdtempSync(join(tmpdir(), "outside-pass-"));
    try {
      await runWithEnv(
        {
          tool_name: "Edit",
          tool_input: { file_path: join(outside, "main.py") },
        },
        { SHIPYARD_DATA: sd },
      );
      const log = join(sd, ".auto-approve.log");
      assert.ok(existsSync(log));
      const content = readFileSync(log, "utf8");
      assert.ok(content.includes("pass"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// --- Terminal-cursor gate integration (v2.6.0) -------------------------
//
// The gate fires only on Write/Edit to EXECUTE-CURSOR.md or REVIEW-CURSOR.md
// when the proposed final content is a "claim of success" terminal. These
// tests cover the hook ↔ gate wiring; the gate logic itself is exercised
// in test_terminal_gate.mjs.

import { mkdirSync as mkdirSyncFs, writeFileSync as writeFileSyncFs } from "node:fs";

function writeSprintFixture(sd, opts = {}) {
  const sprintsCurrent = join(sd, "sprints", "current");
  mkdirSyncFs(sprintsCurrent, { recursive: true });
  const waves = opts.waves ?? [{ wave: 1, tasks: ["T001"] }];
  const waveBlock = waves
    .map((w) => `### Wave ${w.wave}\nTasks: [${w.tasks.join(", ")}]\n`)
    .join("\n");
  writeFileSyncFs(
    join(sprintsCurrent, "SPRINT.md"),
    `---\nid: sprint-001\nstatus: in-progress\nfeatures: [F001]\nstarted_at: 2026-05-19T00:00:00Z\n---\n\n## Waves\n\n${waveBlock}\n`,
  );
}

function writeEventsFixture(sd, events) {
  const lines = events.map((e) => JSON.stringify({ ts: new Date().toISOString(), ...e })).join("\n") + "\n";
  writeFileSyncFs(join(sd, ".shipyard-events.jsonl"), lines);
}

test("terminal gate: non-terminal cursor Write passes through to allow", async () => {
  await withTempDir(async (sd) => {
    writeSprintFixture(sd);
    const cursorPath = join(sd, "sprints", "current", "EXECUTE-CURSOR.md");
    const { stdout, code } = await runWithEnv(
      {
        tool_name: "Write",
        tool_input: {
          file_path: cursorPath,
          content: `---\npipeline: ship-execute\nstage: wave_1_dispatch\nterminal: false\nstatus: in_progress\n---\n\nbody`,
        },
      },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    const resp = JSON.parse(stdout);
    assert.equal(resp.hookSpecificOutput.permissionDecision, "allow");
  });
});

test("terminal gate: success terminal Write without evidence is DENIED", async () => {
  await withTempDir(async (sd) => {
    writeSprintFixture(sd);
    // No events log → gate denies
    const cursorPath = join(sd, "sprints", "current", "EXECUTE-CURSOR.md");
    const { stdout, code } = await runWithEnv(
      {
        tool_name: "Write",
        tool_input: {
          file_path: cursorPath,
          content: `---\npipeline: ship-execute\nstage: terminal_handoff_to_review\nterminal: true\nstatus: complete\n---\n\nSprint complete.`,
        },
      },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    const resp = JSON.parse(stdout);
    assert.equal(resp.hookSpecificOutput.permissionDecision, "deny");
    assert.match(resp.hookSpecificOutput.permissionDecisionReason, /missing required event-log evidence/i);
    assert.match(resp.hookSpecificOutput.permissionDecisionReason, /wave_1_gate/);
    assert.match(resp.hookSpecificOutput.permissionDecisionReason, /sprint_complete_passed/);
  });
});

test("terminal gate: escalated terminal Write bypasses gate", async () => {
  await withTempDir(async (sd) => {
    writeSprintFixture(sd);
    // status: escalated is NOT a success claim — gate must not fire
    const cursorPath = join(sd, "sprints", "current", "EXECUTE-CURSOR.md");
    const { stdout, code } = await runWithEnv(
      {
        tool_name: "Write",
        tool_input: {
          file_path: cursorPath,
          content: `---\npipeline: ship-execute\nstage: wave_1_redispatch_iter_1\nterminal: true\nstatus: escalated\n---\n\nEscalated for review.`,
        },
      },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    const resp = JSON.parse(stdout);
    assert.equal(resp.hookSpecificOutput.permissionDecision, "allow");
  });
});

test("terminal gate: complete evidence allows success terminal Write", async () => {
  await withTempDir(async (sd) => {
    writeSprintFixture(sd);
    writeEventsFixture(sd, [
      { type: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_1_gate" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task: "T001" },
      { type: "sprint_complete_passed", sprint_id: "sprint-001" },
    ]);
    const cursorPath = join(sd, "sprints", "current", "EXECUTE-CURSOR.md");
    const { stdout, code } = await runWithEnv(
      {
        tool_name: "Write",
        tool_input: {
          file_path: cursorPath,
          content: `---\npipeline: ship-execute\nstage: terminal_handoff_to_review\nterminal: true\nstatus: complete\n---\n\nDone.`,
        },
      },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    const resp = JSON.parse(stdout);
    assert.equal(resp.hookSpecificOutput.permissionDecision, "allow");
  });
});

test("terminal gate: Edit on cursor file uses post-edit content for evaluation", async () => {
  await withTempDir(async (sd) => {
    writeSprintFixture(sd);
    const cursorPath = join(sd, "sprints", "current", "EXECUTE-CURSOR.md");
    // Pre-existing cursor at non-terminal state
    writeFileSyncFs(
      cursorPath,
      `---\npipeline: ship-execute\nstage: wave_1_dispatch\nterminal: false\nstatus: in_progress\n---\n\nbody`,
    );
    // Edit flips terminal: false → true + status: in_progress → complete
    const { stdout, code } = await runWithEnv(
      {
        tool_name: "Edit",
        tool_input: {
          file_path: cursorPath,
          old_string: `terminal: false\nstatus: in_progress`,
          new_string: `terminal: true\nstatus: complete`,
        },
      },
      { SHIPYARD_DATA: sd },
    );
    assert.equal(code, 0);
    const resp = JSON.parse(stdout);
    assert.equal(resp.hookSpecificOutput.permissionDecision, "deny",
      "Edit that flips cursor to terminal: true status: complete without evidence must be denied");
  });
});
