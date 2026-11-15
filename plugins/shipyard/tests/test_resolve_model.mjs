/**
 * Tests for `shipyard-data resolve-model <role>` (F003) and the config-read
 * readers behind it. Subprocess-exercised with --data-dir against a temp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function mk(fm) {
  const d = mkdtempSync(join(tmpdir(), "resolve-model-"));
  if (fm != null) writeFileSync(join(d, "config.md"), `---\n${fm}\n---\n\n# Config\n`);
  return d;
}
function run(dir, ...args) {
  return spawnSync("node", [CLI, "resolve-model", ...args, "--data-dir", dir], { encoding: "utf8" });
}
const FULL = `models:
  think: opus
  build: sonnet
  orchestrate: opus
agent_effort:
  build: medium
  build_trivial: low
  fixer: medium
  operational: low
  operational_fix: medium
  think: high
  coordinator: low
  simplifier: low`;

test("AC-1 build resolves to model=sonnet effort=medium exactly", () => {
  const d = mk(FULL);
  try {
    const r = run(d, "build");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "model=sonnet effort=medium\n");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("AC-2 empty tier prints model= and exits 0", () => {
  const d = mk(`models:\n  build: ""\nagent_effort:\n  build: medium`);
  try {
    const r = run(d, "build");
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "model= effort=medium\n");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("inherit tier also omits the model", () => {
  const d = mk(`models:\n  build: inherit\nagent_effort:\n  build: inherit`);
  try {
    assert.equal(run(d, "build").stdout, "model= effort=\n");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("AC-3 unknown role exits 2 and lists roles", () => {
  const d = mk(FULL);
  try {
    const r = run(d, "bogus");
    assert.equal(r.status, 2);
    for (const role of ["build", "build_trivial", "fixer", "operational", "operational_fix", "think", "coordinator", "simplifier"]) {
      assert.ok(r.stderr.includes(role), `stderr lists ${role}`);
    }
    assert.equal(run(d).status, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("AC-4 all eight roles resolve with tier-derived model and own effort", () => {
  const d = mk(FULL);
  const want = {
    build: "model=sonnet effort=medium",
    build_trivial: "model=sonnet effort=low",
    fixer: "model=sonnet effort=medium",
    operational: "model=sonnet effort=low",
    operational_fix: "model=sonnet effort=medium",
    think: "model=opus effort=high",
    coordinator: "model=sonnet effort=low",
    simplifier: "model=sonnet effort=low",
  };
  try {
    for (const [role, line] of Object.entries(want)) {
      const r = run(d, role);
      assert.equal(r.status, 0, role);
      assert.equal(r.stdout, line + "\n", role);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("AC-5 legacy versioned ids map to their family tier", () => {
  const cases = {
    "claude-opus-4-8": "opus",
    "claude-sonnet-5": "sonnet",
    "claude-haiku-4-5": "haiku",
    "claude-fable-1": "fable",
    "claude-mystery-9": "", // unknown family -> unset/inherit
  };
  for (const [id, want] of Object.entries(cases)) {
    const d = mk(`models:\n  think: ${id}\nagent_effort:\n  think: high`);
    try {
      assert.equal(run(d, "think").stdout, `model=${want} effort=high\n`, id);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test("AC-5 --override with a legacy id is mapped too", () => {
  const d = mk(`models:\n  think: opus`);
  try {
    assert.equal(run(d, "think", "--override", "claude-sonnet-5").stdout, "model=sonnet effort=high\n");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("AC-6 absent models block inherits; absent agent_effort uses role default", () => {
  const d = mk(`execution:\n  isolation: worktree`);
  try {
    assert.equal(run(d, "build").stdout, "model= effort=medium\n");
    assert.equal(run(d, "think").stdout, "model= effort=high\n");
    assert.equal(run(d, "build_trivial").stdout, "model= effort=low\n");
  } finally { rmSync(d, { recursive: true, force: true }); }
  const d2 = mk(null); // no config.md at all
  try {
    assert.equal(run(d2, "build").stdout, "model= effort=medium\n");
  } finally { rmSync(d2, { recursive: true, force: true }); }
});

test("--override replaces the think model only", () => {
  const d = mk(FULL);
  try {
    assert.equal(run(d, "think", "--override", "fable").stdout, "model=fable effort=high\n");
    assert.equal(run(d, "build", "--override", "fable").status, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("AC-9 resolver writes nothing", () => {
  const d = mk(FULL);
  try {
    const before = readdirSync(d).sort();
    run(d, "build"); run(d, "think");
    assert.deepEqual(readdirSync(d).sort(), before);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("T097 --override on every non-think role exits 2 with the think-only message", () => {
  const d = mk(FULL);
  try {
    for (const role of ["build", "build_trivial", "fixer", "operational", "operational_fix", "coordinator", "simplifier"]) {
      const r = run(d, role, "--override", "fable");
      assert.equal(r.status, 2, role);
      assert.match(r.stderr, /--override applies to the think role only/, role);
      assert.equal(r.stdout, "", role);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("T097 empty --subject exits 2 (both spellings); a real subject does not", () => {
  const d = mk(FULL);
  try {
    for (const args of [["build", "--subject", ""], ["build", "--subject="], ["build", "--subject"]]) {
      const r = run(d, ...args);
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.match(r.stderr, /--subject requires a task id/, JSON.stringify(args));
      assert.equal(r.stdout, "", JSON.stringify(args));
    }
    assert.equal(run(d, "build", "--subject", "T001").status, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
