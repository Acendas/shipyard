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

// --- CLI-owned state deny (v2.9.0) ------------------------------------
//
// Cursor files, PROGRESS.md and HANDOFF.md have a single deterministic
// writer: the shipyard-data CLI (which runs the terminal-evidence gate and
// loop-leak guard in-process — see test_cursor_cli.mjs). The hook's job is
// now simply to DENY any model Write/Edit to these basenames inside the
// data dir, with a hint pointing at the CLI. These tests replace the
// v2.6.0 gate-wiring and v2.8.2 loop-leak hook tests — that logic moved
// into `shipyard-data cursor advance`.

import { mkdirSync as mkdirSyncFs } from "node:fs";

const CLI_OWNED = ["EXECUTE-CURSOR.md", "REVIEW-CURSOR.md", "PROGRESS.md", "HANDOFF.md"];

for (const base of CLI_OWNED) {
  test(`cli-owned deny: Write to ${base} in the data dir is DENIED with a CLI hint`, async () => {
    await withTempDir(async (sd) => {
      mkdirSyncFs(join(sd, "sprints", "current"), { recursive: true });
      const { stdout, code } = await runWithEnv(
        {
          tool_name: "Write",
          tool_input: {
            file_path: join(sd, "sprints", "current", base),
            content: "anything",
          },
        },
        { SHIPYARD_DATA: sd },
      );
      assert.equal(code, 0);
      const resp = JSON.parse(stdout);
      assert.equal(resp.hookSpecificOutput.permissionDecision, "deny");
      assert.match(
        resp.hookSpecificOutput.permissionDecisionReason,
        /shipyard-data cursor/,
        "deny reason must point the model at the CLI",
      );
    });
  });
}

test("cli-owned deny: Edit to a cursor file is DENIED (not just Write)", async () => {
  await withTempDir(async (sd) => {
    mkdirSyncFs(join(sd, "sprints", "current"), { recursive: true });
    const { stdout } = await runWithEnv(
      {
        tool_name: "Edit",
        tool_input: {
          file_path: join(sd, "sprints", "current", "EXECUTE-CURSOR.md"),
          old_string: "terminal: false",
          new_string: "terminal: true",
        },
      },
      { SHIPYARD_DATA: sd },
    );
    const resp = JSON.parse(stdout);
    assert.equal(resp.hookSpecificOutput.permissionDecision, "deny");
  });
});

test("cli-owned deny: same basename OUTSIDE the data dir passes through (no deny)", async () => {
  // A user project can legitimately have its own PROGRESS.md — the deny is
  // scoped to the Shipyard data dir.
  await withTempDir(async (sd) => {
    const outside = mkdtempSync(join(tmpdir(), "outside-progress-"));
    try {
      const { stdout, code } = await runWithEnv(
        {
          tool_name: "Write",
          tool_input: { file_path: join(outside, "PROGRESS.md"), content: "x" },
        },
        { SHIPYARD_DATA: sd },
      );
      assert.equal(code, 0);
      assert.equal(stdout, "", "outside the data dir the hook stays silent (default permission flow)");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("cli-owned deny: other data-dir files (e.g. SPRINT.md body, spec files) still auto-approved", async () => {
  await withTempDir(async (sd) => {
    mkdirSyncFs(join(sd, "sprints", "current"), { recursive: true });
    const { stdout } = await runWithEnv(
      {
        tool_name: "Write",
        tool_input: {
          file_path: join(sd, "sprints", "current", "SPRINT.md"),
          content: "---\nid: sprint-001\n---\n\n### Wave 1\nTasks: [T001]\n",
        },
      },
      { SHIPYARD_DATA: sd },
    );
    const resp = JSON.parse(stdout);
    assert.equal(resp.hookSpecificOutput.permissionDecision, "allow");
  });
});

test("cli-owned deny: breadcrumb log records the deny", async () => {
  await withTempDir(async (sd) => {
    mkdirSyncFs(join(sd, "sprints", "current"), { recursive: true });
    await runWithEnv(
      {
        tool_name: "Write",
        tool_input: {
          file_path: join(sd, "sprints", "current", "REVIEW-CURSOR.md"),
          content: "x",
        },
      },
      { SHIPYARD_DATA: sd },
    );
    const log = readFileSync(join(sd, ".auto-approve.log"), "utf8");
    assert.ok(log.includes("cli_owned_state"));
  });
});
