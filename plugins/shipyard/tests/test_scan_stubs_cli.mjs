/**
 * Tests for bin/scan-stubs.mjs, backing `shipyard-data scan-stubs`.
 *
 * The CLI is exercised as a subprocess against a throwaway git repo, same
 * pattern as test_cursor_cli.mjs: 0 = clean/advisory, 3 = unmarked HIGH
 * finding.
 *
 * Run: node --test tests/test_scan_stubs_cli.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, "bin", "shipyard-data.mjs");

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "scan-stubs-test-"));
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(data, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "config", "commit.gpgsign", "false"], { cwd: repo });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  delete env.SHIPYARD_DATA;

  const commit = (msg) => {
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg], { cwd: repo });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  };

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

  return { root, repo, commit, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("scan-stubs: clean diff exits 0 with empty findings", () => {
  const p = makeRepo();
  try {
    writeFileSync(join(p.repo, "a.py"), "def f():\n    return 1\n");
    const base = p.commit("init");
    writeFileSync(join(p.repo, "a.py"), "def f():\n    return 1\n\ndef g():\n    return 2\n");
    const head = p.commit("add g");

    const r = p.run(["scan-stubs", `${base}..${head}`]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(parsed.findings, []);
  } finally {
    p.cleanup();
  }
});

test("scan-stubs: unmarked TODO on an added line is HIGH and exits 3", () => {
  const p = makeRepo();
  try {
    writeFileSync(join(p.repo, "a.py"), "def f():\n    return 1\n");
    const base = p.commit("init");
    writeFileSync(join(p.repo, "a.py"), "def f():\n    return 1\n\ndef g():\n    # TODO: implement\n    return None\n");
    const head = p.commit("add g stub");

    const r = p.run(["scan-stubs", `${base}..${head}`]);
    assert.equal(r.code, 3);
    const parsed = JSON.parse(r.stdout);
    const high = parsed.findings.filter((f) => f.confidence === "HIGH");
    assert.ok(high.length >= 1, "expected at least one HIGH finding");
    assert.ok(high.some((f) => f.pattern === "todo-marker"));
    assert.match(r.stderr, /HIGH-confidence stub finding/);
  } finally {
    p.cleanup();
  }
});

test("scan-stubs: empty-body stub with placeholder marker downgrades to LOW and exits 0", () => {
  const p = makeRepo();
  try {
    writeFileSync(join(p.repo, "a.py"), "def f():\n    return 1\n");
    const base = p.commit("init");
    writeFileSync(
      p.repo + "/a.py",
      "def f():\n    return 1\n\n# shipyard:placeholder reason=stub-for-future-task-T-099\ndef g():\n    pass\n",
    );
    const head = p.commit("add marked stub");

    const r = p.run(["scan-stubs", `${base}..${head}`]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.length >= 1);
    for (const f of parsed.findings) {
      assert.equal(f.confidence, "LOW");
      assert.equal(f.placeholder_marker, "stub-for-future-task-T-099");
    }
  } finally {
    p.cleanup();
  }
});

test("scan-stubs: not-implemented marker (TS) is HIGH", () => {
  const p = makeRepo();
  try {
    writeFileSync(join(p.repo, "a.ts"), "export function f(): number {\n  return 1;\n}\n");
    const base = p.commit("init");
    writeFileSync(
      join(p.repo, "a.ts"),
      'export function f(): number {\n  return 1;\n}\n\nexport function g(): void {\n  throw new Error("not implemented");\n}\n',
    );
    const head = p.commit("add g stub");

    const r = p.run(["scan-stubs", `${base}..${head}`]);
    assert.equal(r.code, 3);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.some((f) => f.pattern === "not-implemented-marker" && f.confidence === "HIGH"));
  } finally {
    p.cleanup();
  }
});

test("scan-stubs: --lang filters files by extension", () => {
  const p = makeRepo();
  try {
    writeFileSync(join(p.repo, "a.py"), "x = 1\n");
    writeFileSync(join(p.repo, "b.ts"), "const x = 1;\n");
    const base = p.commit("init");
    writeFileSync(join(p.repo, "a.py"), "x = 1\n# TODO fix this\n");
    writeFileSync(join(p.repo, "b.ts"), "const x = 1;\n// TODO fix this\n");
    const head = p.commit("add todos");

    const r = p.run(["scan-stubs", `${base}..${head}`, "--lang", "py"]);
    assert.equal(r.code, 3);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.every((f) => f.file === "a.py"));
  } finally {
    p.cleanup();
  }
});

test("scan-stubs: commented-out call site is MEDIUM, doesn't block exit", () => {
  const p = makeRepo();
  try {
    writeFileSync(join(p.repo, "a.ts"), "export function f(): number {\n  return 1;\n}\n");
    const base = p.commit("init");
    writeFileSync(
      join(p.repo, "a.ts"),
      "export function f(): number {\n  return 1;\n}\n\nexport function wireItUp(): void {\n  // f();\n}\n",
    );
    const head = p.commit("add commented-out call");

    const r = p.run(["scan-stubs", `${base}..${head}`]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.some((f) => f.pattern === "commented-call-site" && f.confidence === "MEDIUM"));
  } finally {
    p.cleanup();
  }
});

test("scan-stubs: commented-out call site marked with placeholder is downgraded to LOW", () => {
  const p = makeRepo();
  try {
    writeFileSync(join(p.repo, "a.py"), "def f():\n    return 1\n");
    const base = p.commit("init");
    writeFileSync(
      join(p.repo, "a.py"),
      "def f():\n    return 1\n\n\ndef wire_it_up():\n    # shipyard:placeholder reason=waiting-on-T050\n    # f()\n",
    );
    const head = p.commit("add placeholder-marked commented call");

    const r = p.run(["scan-stubs", `${base}..${head}`]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    const finding = parsed.findings.find((f) => f.pattern === "commented-call-site");
    assert.ok(finding);
    assert.equal(finding.confidence, "LOW");
    assert.equal(finding.placeholder_marker, "waiting-on-T050");
  } finally {
    p.cleanup();
  }
});

test("scan-stubs: test file added with no production file is test-no-impl (MEDIUM)", () => {
  const p = makeRepo();
  try {
    writeFileSync(join(p.repo, "a.py"), "def f():\n    return 1\n");
    const base = p.commit("init");
    writeFileSync(join(p.repo, "test_a.py"), "def test_f():\n    assert True\n");
    const head = p.commit("add test only, no impl change");

    const r = p.run(["scan-stubs", `${base}..${head}`]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.some((f) => f.pattern === "test-no-impl" && f.confidence === "MEDIUM" && f.file === "test_a.py"));
  } finally {
    p.cleanup();
  }
});

test("scan-stubs: test file added alongside a production change is NOT test-no-impl", () => {
  const p = makeRepo();
  try {
    writeFileSync(join(p.repo, "a.py"), "def f():\n    return 1\n");
    const base = p.commit("init");
    writeFileSync(join(p.repo, "a.py"), "def f():\n    return 1\n\n\ndef g():\n    return 2\n");
    writeFileSync(join(p.repo, "test_a.py"), "def test_g():\n    assert True\n");
    const head = p.commit("add impl + test together");

    const r = p.run(["scan-stubs", `${base}..${head}`]);
    const parsed = JSON.parse(r.stdout);
    assert.ok(!parsed.findings.some((f) => f.pattern === "test-no-impl"));
    void r.code;
  } finally {
    p.cleanup();
  }
});

test("scan-stubs: malformed range exits 2", () => {
  const p = makeRepo();
  try {
    const r = p.run(["scan-stubs", "not-a-range"]);
    assert.equal(r.code, 2);
  } finally {
    p.cleanup();
  }
});
