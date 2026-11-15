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

test("scan-stubs flags a weakened test: a changed number, a removed assertion and a deleted test file, in any language", () => {
  const p = makeRepo();
  try {
    mkdirSync(join(p.repo, "tests"), { recursive: true });
    writeFileSync(join(p.repo, "src.c"), "int f(void) { return 1; }\n");
    writeFileSync(join(p.repo, "tests", "test_flash.c"), "#define FLASH_FLOOR 24\nvoid t(void) {\n  CHECK(flash() >= FLASH_FLOOR);\n  CHECK(margin() == 4);\n  CHECK(border() == 1);\n}\n");
    writeFileSync(join(p.repo, "tests", "test_old.c"), "void t2(void) { CHECK(1); }\n");
    const base = p.commit("init");
    // the builder "fixes" the failure by halving the floor, dropping a check and deleting a test
    writeFileSync(join(p.repo, "src.c"), "int f(void) { return 2; }\n");
    writeFileSync(join(p.repo, "tests", "test_flash.c"), "#define FLASH_FLOOR 12\nvoid t(void) {\n  CHECK(flash() >= FLASH_FLOOR);\n  CHECK(border() == 1);\n}\n");
    rmSync(join(p.repo, "tests", "test_old.c"));
    const head = p.commit("make it pass");
    const r = p.run(["scan-stubs", `${base}..${head}`]);
    assert.equal(r.code, 0, "a flag for the reviewer, not a hard stop: " + r.stderr);
    const f = JSON.parse(r.stdout).findings;
    const by = (pat) => f.filter((x) => x.pattern === pat);
    assert.equal(by("test-number-changed").length, 1);
    assert.match(by("test-number-changed")[0].snippet, /FLASH_FLOOR 24\s+→\s+#define FLASH_FLOOR 12/);
    assert.equal(by("test-number-changed")[0].file, "tests/test_flash.c");
    assert.equal(by("test-assertion-removed").length, 1);
    assert.match(by("test-assertion-removed")[0].snippet, /1 assertion\(s\) removed, e\.g\. CHECK\(margin\(\) == 4\);/);
    assert.equal(by("test-file-deleted").length, 1);
    assert.equal(by("test-file-deleted")[0].file, "tests/test_old.c");
    assert.ok(f.every((x) => x.confidence === "MEDIUM"));
    // the other range spelling
    const r2 = p.run(["scan-stubs", "--base", base, "--head", head]);
    assert.equal(JSON.parse(r2.stdout).findings.length, f.length);
  } finally { p.cleanup(); }
});

test("scan-stubs does not flag honest test work: new tests, added assertions, a reworded assertion", () => {
  const p = makeRepo();
  try {
    mkdirSync(join(p.repo, "tests"), { recursive: true });
    writeFileSync(join(p.repo, "src.py"), "def f():\n    return 1\n");
    writeFileSync(join(p.repo, "tests", "test_a.py"), "def test_a():\n    assert f() == 1\n");
    const base = p.commit("init");
    writeFileSync(join(p.repo, "src.py"), "def f():\n    return 1\n\ndef g():\n    return 2\n");
    writeFileSync(join(p.repo, "tests", "test_a.py"), "def test_a():\n    assert f() == 1, 'f is one'\n    assert g() == 2\n");
    writeFileSync(join(p.repo, "tests", "test_b.py"), "def test_b():\n    assert g() == 2\n");
    const head = p.commit("more tests");
    const f = JSON.parse(p.run(["scan-stubs", `${base}..${head}`]).stdout).findings;
    assert.deepEqual(f.filter((x) => x.pattern.startsWith("test-")), []);
  } finally { p.cleanup(); }
});

test("scan-stubs with no range prints both accepted forms", () => {
  const p = makeRepo();
  try {
    writeFileSync(join(p.repo, "a.py"), "x = 1\n"); p.commit("init");
    const r = p.run(["scan-stubs"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /scan-stubs <base>\.\.<head>/);
    assert.match(r.stderr, /scan-stubs --base <ref> --head <ref>/);
  } finally { p.cleanup(); }
});
