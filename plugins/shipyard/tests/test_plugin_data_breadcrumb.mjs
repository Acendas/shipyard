/**
 * Tests for bin/hooks/plugin-data-breadcrumb.mjs — the SessionStart hook.
 *
 * Two responsibilities:
 *   1. Write the CLAUDE_PLUGIN_DATA breadcrumb to every breadcrumbCandidates()
 *      path (TMPDIR-split defense — the hook and skill subprocess can resolve
 *      os.tmpdir() differently).
 *   2. Ensure `<projectRoot>/.shipyard` exists for an initialized project, so a
 *      later session can resolve the data dir even if the breadcrumb is
 *      stranded by a TMPDIR split. The symlink is env/TMPDIR-independent.
 *
 * Run via:  node --test tests/test_plugin_data_breadcrumb.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { run } from "../bin/hooks/plugin-data-breadcrumb.mjs";
import {
  getProjectRoot,
  getProjectHash,
  breadcrumbCandidates,
} from "../bin/shipyard-resolver.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sy-bc-hook-"));
  const projectDir = join(root, "project");
  mkdirSync(projectDir);
  execFileSync("git", ["init", "-q", projectDir]);
  const pluginData = join(root, "plugin-data");
  mkdirSync(pluginData);

  // Run the hook as production does: CLAUDE_PROJECT_DIR points at the session
  // cwd, which getProjectRoot() uses as the git starting dir.
  const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = projectDir;

  const projectRoot = getProjectRoot();
  const hash = getProjectHash(projectRoot);
  const dataDir = join(pluginData, "projects", hash);
  const linkPath = join(projectRoot, ".shipyard");

  const cleanup = () => {
    for (const p of breadcrumbCandidates(hash)) {
      try { rmSync(p); } catch { /* ignore */ }
    }
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    rmSync(root, { recursive: true, force: true });
  };

  return { root, projectDir, pluginData, projectRoot, hash, dataDir, linkPath, cleanup };
}

/**
 * Make a data dir look genuinely `shipyard-data init`-ed.
 *
 * Bare existence is NOT enough and must not be: the diagnostic-log writers in
 * _hook_lib mkdir the data dir recursively, so one appears merely from editing
 * a file in any git repo with Shipyard installed. Gating the symlink on
 * existence planted a stray `.shipyard` in never-initialized projects
 * (observed 2026-07-28). `ensureDataDirLink` now requires an init marker.
 */
function markInitialized(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, ".project-root"), "/some/project\n");
}

test("creates .shipyard symlink for an initialized data dir", () => {
  const t = setup();
  try {
    markInitialized(t.dataDir);

    const rc = run({}, { CLAUDE_PLUGIN_DATA: t.pluginData });
    assert.equal(rc, 0);

    assert.ok(existsSync(t.linkPath), ".shipyard should exist");
    assert.ok(lstatSync(t.linkPath).isSymbolicLink(), ".shipyard should be a symlink");
    assert.equal(realpathSync(t.linkPath), realpathSync(t.dataDir));

    // Breadcrumb also written to every candidate.
    for (const p of breadcrumbCandidates(t.hash)) {
      assert.equal(readFileSync(p, "utf8").trim(), t.pluginData,
        `breadcrumb at ${p} should hold the plugin-data path`);
    }
  } finally {
    t.cleanup();
  }
});

test("does NOT create a dangling .shipyard when the data dir is absent", () => {
  const t = setup();
  try {
    // dataDir intentionally not created (project never completed onboarding).
    const rc = run({}, { CLAUDE_PLUGIN_DATA: t.pluginData });
    assert.equal(rc, 0);
    assert.equal(existsSync(t.linkPath), false,
      "no .shipyard should be dropped into a non-Shipyard project");
  } finally {
    t.cleanup();
  }
});

test("leaves a real .shipyard directory untouched (blocked)", () => {
  const t = setup();
  try {
    mkdirSync(t.dataDir, { recursive: true });
    // A user has a real .shipyard/ dir with content — must not be clobbered.
    mkdirSync(t.linkPath);
    const sentinel = join(t.linkPath, "user-content.md");
    writeFileSync(sentinel, "do not delete\n");

    const rc = run({}, { CLAUDE_PLUGIN_DATA: t.pluginData });
    assert.equal(rc, 0);

    assert.equal(lstatSync(t.linkPath).isSymbolicLink(), false,
      "real .shipyard dir must stay a dir, not become a symlink");
    assert.equal(readFileSync(sentinel, "utf8"), "do not delete\n",
      "user content must survive");
  } finally {
    t.cleanup();
  }
});

test("does NOT create .shipyard for a data dir that was never initialized", () => {
  const t = setup();
  try {
    // Bare dir with only a diagnostic log — exactly what the auto-approve hook
    // leaves behind in a repo that never completed onboarding.
    mkdirSync(t.dataDir, { recursive: true });
    writeFileSync(join(t.dataDir, ".auto-approve.log"), "some diagnostics\n");

    const rc = run({}, { CLAUDE_PLUGIN_DATA: t.pluginData });
    assert.equal(rc, 0, "hook must still succeed — the link is best-effort");

    assert.ok(
      !existsSync(t.linkPath),
      ".shipyard must NOT be planted in a project that was never initialized",
    );

    // The breadcrumb half is unconditional and must still have happened.
    for (const p of breadcrumbCandidates(t.hash)) {
      assert.equal(readFileSync(p, "utf8").trim(), t.pluginData);
    }
  } finally {
    t.cleanup();
  }
});

test("idempotent: a correct existing link is not recreated", () => {
  const t = setup();
  try {
    markInitialized(t.dataDir);

    run({}, { CLAUDE_PLUGIN_DATA: t.pluginData });
    const inoBefore = lstatSync(t.linkPath).ino;

    run({}, { CLAUDE_PLUGIN_DATA: t.pluginData });
    const inoAfter = lstatSync(t.linkPath).ino;

    assert.equal(inoBefore, inoAfter, "correct link should not be recreated");
  } finally {
    t.cleanup();
  }
});
