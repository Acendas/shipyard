/**
 * Tests for bin/worktree-warm.mjs — the P4 opt-in artifact-dir warm that
 * pre-populates a freshly created builder worktree with gitignored build
 * caches from the parent checkout.
 *
 * Run: node --test tests/test_worktree_warm.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isRefused,
  readWorktreeWarmConfig,
  warmWorktree,
  warmWorktreeFromConfig,
} from "../bin/worktree-warm.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function makeSourceRepo() {
  const root = mkdtempSync(join(tmpdir(), "worktree-warm-test-"));
  const sourceRoot = join(root, "source");
  const worktreePath = join(root, "worktree");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  git(["init", "-q"], sourceRoot);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "config", "commit.gpgsign", "false"], sourceRoot);
  writeFileSync(join(sourceRoot, "README.md"), "hi\n");
  writeFileSync(join(sourceRoot, ".gitignore"), "build/\n.gradle/\nnode_modules/\n.venv/\nvendor/bundle/\n");
  git(["add", "-A"], sourceRoot);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], sourceRoot);
  return { root, sourceRoot, worktreePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeArtifactDir(sourceRoot, relPath, files) {
  const dir = join(sourceRoot, relPath);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

// --- refusal list --------------------------------------------------------------

test("refusal list rejects node_modules and .venv by basename", () => {
  assert.equal(isRefused("node_modules"), true);
  assert.equal(isRefused("packages/app/node_modules"), true);
  assert.equal(isRefused(".venv"), true);
  assert.equal(isRefused("venv"), true);
  assert.equal(isRefused("env"), true);
  assert.equal(isRefused(".tox"), true);
  assert.equal(isRefused("vendor/bundle"), true);
});

test("refusal list does not reject safe artifact dirs", () => {
  assert.equal(isRefused("build"), false);
  assert.equal(isRefused(".gradle"), false);
  assert.equal(isRefused("target"), false);
  assert.equal(isRefused("bin"), false);
  assert.equal(isRefused("obj"), false);
  assert.equal(isRefused(".build"), false);
});

test("warmWorktree refuses a configured node_modules path even if it exists and is gitignored", () => {
  const f = makeSourceRepo();
  try {
    writeArtifactDir(f.sourceRoot, "node_modules", { "pkg.json": "{}" });
    const result = warmWorktree({ sourceRoot: f.sourceRoot, worktreePath: f.worktreePath, paths: ["node_modules"] });
    assert.deepEqual(result.warmed, []);
    assert.equal(existsSync(join(f.worktreePath, "node_modules")), false);
  } finally {
    f.cleanup();
  }
});

test("warmWorktree refuses a configured .venv path", () => {
  const f = makeSourceRepo();
  try {
    writeArtifactDir(f.sourceRoot, ".venv", { pyvenv: "cfg" });
    const result = warmWorktree({ sourceRoot: f.sourceRoot, worktreePath: f.worktreePath, paths: [".venv"] });
    assert.deepEqual(result.warmed, []);
    assert.equal(existsSync(join(f.worktreePath, ".venv")), false);
  } finally {
    f.cleanup();
  }
});

// --- happy path: clone / copy succeed -------------------------------------------

test("warmWorktree copies a gitignored artifact dir into the worktree (copy mode)", () => {
  const f = makeSourceRepo();
  try {
    writeArtifactDir(f.sourceRoot, "build", { "output.class": "binary-ish content" });
    const result = warmWorktree({ sourceRoot: f.sourceRoot, worktreePath: f.worktreePath, paths: ["build"], mode: "copy" });
    assert.deepEqual(result.warmed, ["build"]);
    assert.equal(existsSync(join(f.worktreePath, "build", "output.class")), true);
    assert.equal(
      readFileSync(join(f.worktreePath, "build", "output.class"), "utf8"),
      "binary-ish content",
    );
    assert.ok(result.bytes > 0);
  } finally {
    f.cleanup();
  }
});

test("warmWorktree in clone mode still lands correct content (degrades to copy where CoW is unavailable)", () => {
  const f = makeSourceRepo();
  try {
    writeArtifactDir(f.sourceRoot, ".gradle", { "cache.bin": "gradle cache data" });
    const result = warmWorktree({ sourceRoot: f.sourceRoot, worktreePath: f.worktreePath, paths: [".gradle"], mode: "clone" });
    assert.deepEqual(result.warmed, [".gradle"]);
    assert.equal(
      readFileSync(join(f.worktreePath, ".gradle", "cache.bin"), "utf8"),
      "gradle cache data",
    );
    // Either "clone" (CoW succeeded) or "copy" (degraded) is an acceptable
    // outcome on any given CI machine/filesystem — what matters is the
    // content landed correctly and it's never a symlink.
    assert.ok(result.modes.every((m) => m === "clone" || m === "copy"));
  } finally {
    f.cleanup();
  }
});

test("warmWorktree never symlinks — copied files are independent of the source", () => {
  const f = makeSourceRepo();
  try {
    writeArtifactDir(f.sourceRoot, "build", { "a.txt": "original" });
    warmWorktree({ sourceRoot: f.sourceRoot, worktreePath: f.worktreePath, paths: ["build"] });
    // Mutate the destination; the source must be unaffected — proves it's
    // a real copy, not a shared/symlinked reference.
    writeFileSync(join(f.worktreePath, "build", "a.txt"), "mutated in worktree");
    assert.equal(readFileSync(join(f.sourceRoot, "build", "a.txt"), "utf8"), "original");
  } finally {
    f.cleanup();
  }
});

// --- gates: tracked dir refused, missing source is a no-op ---------------------

test("warmWorktree refuses a tracked (non-gitignored) directory", () => {
  const f = makeSourceRepo();
  try {
    // "src" is tracked (not in .gitignore).
    writeArtifactDir(f.sourceRoot, "src", { "main.ts": "code" });
    git(["add", "-A"], f.sourceRoot);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add src"], f.sourceRoot);

    const result = warmWorktree({ sourceRoot: f.sourceRoot, worktreePath: f.worktreePath, paths: ["src"] });
    assert.deepEqual(result.warmed, []);
    assert.equal(existsSync(join(f.worktreePath, "src")), false);
  } finally {
    f.cleanup();
  }
});

test("missing source path is a loud no-op, not a failure", () => {
  const f = makeSourceRepo();
  try {
    const result = warmWorktree({ sourceRoot: f.sourceRoot, worktreePath: f.worktreePath, paths: ["build"] });
    assert.deepEqual(result.warmed, []);
    assert.deepEqual(result.bytes, 0);
  } finally {
    f.cleanup();
  }
});

// --- failure never blocks / never touches stdout --------------------------------

test("a per-path failure never throws — other paths still warm", () => {
  const f = makeSourceRepo();
  try {
    writeArtifactDir(f.sourceRoot, "build", { "ok.txt": "fine" });
    // node_modules exists and is gitignored but must be refused; build must
    // still succeed in the same call.
    writeArtifactDir(f.sourceRoot, "node_modules", { "pkg.json": "{}" });
    let result;
    assert.doesNotThrow(() => {
      result = warmWorktree({ sourceRoot: f.sourceRoot, worktreePath: f.worktreePath, paths: ["node_modules", "build"] });
    });
    assert.deepEqual(result.warmed, ["build"]);
  } finally {
    f.cleanup();
  }
});

test("warmWorktree writes nothing to stdout", () => {
  const f = makeSourceRepo();
  try {
    writeArtifactDir(f.sourceRoot, "build", { "ok.txt": "fine" });
    const origWrite = process.stdout.write;
    let wroteToStdout = false;
    process.stdout.write = (...args) => {
      wroteToStdout = true;
      return true;
    };
    try {
      warmWorktree({ sourceRoot: f.sourceRoot, worktreePath: f.worktreePath, paths: ["build", "node_modules", "missing"] });
    } finally {
      process.stdout.write = origWrite;
    }
    assert.equal(wroteToStdout, false, "worktree-warm must never write to stdout — the hook's stdout contract is path-only");
  } finally {
    f.cleanup();
  }
});

test("warmWorktree with no paths / missing args is a safe no-op", () => {
  const f = makeSourceRepo();
  try {
    assert.deepEqual(warmWorktree({}).warmed, []);
    assert.deepEqual(warmWorktree({ sourceRoot: f.sourceRoot, worktreePath: f.worktreePath, paths: [] }).warmed, []);
  } finally {
    f.cleanup();
  }
});

// --- config reading: default disabled, enabled + paths honored ------------------

function writeConfig(dataDir, block) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "config.md"),
    `---\nconfig_version: 4\n${block}\n---\n\n# Project Configuration\n`,
  );
}

test("readWorktreeWarmConfig defaults to disabled when config.md is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-warm-cfg-"));
  try {
    const cfg = readWorktreeWarmConfig(join(root, "nonexistent-data-dir"));
    assert.equal(cfg.enabled, false);
    assert.deepEqual(cfg.paths, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readWorktreeWarmConfig defaults to disabled when the worktree_warm block is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-warm-cfg-"));
  try {
    const dataDir = join(root, "data");
    writeConfig(dataDir, "project_name: \"x\"");
    const cfg = readWorktreeWarmConfig(dataDir);
    assert.equal(cfg.enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readWorktreeWarmConfig reads enabled + paths when present", () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-warm-cfg-"));
  try {
    const dataDir = join(root, "data");
    writeConfig(
      dataDir,
      "worktree_warm:\n  enabled: true\n  paths: [\"build\", \".gradle\"]",
    );
    const cfg = readWorktreeWarmConfig(dataDir);
    assert.equal(cfg.enabled, true);
    assert.deepEqual(cfg.paths, ["build", ".gradle"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("warmWorktreeFromConfig is a no-op end-to-end when disabled (the shipped default)", () => {
  const f = makeSourceRepo();
  try {
    writeArtifactDir(f.sourceRoot, "build", { "ok.txt": "fine" });
    // No config.md at all — matches a project that never opted in.
    const result = warmWorktreeFromConfig({ sourceRoot: f.sourceRoot, worktreePath: f.worktreePath });
    assert.deepEqual(result.warmed, []);
    assert.equal(existsSync(join(f.worktreePath, "build")), false);
  } finally {
    f.cleanup();
  }
});
