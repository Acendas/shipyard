/** T023 / F004: light tier, role->tier map, template key, set-model light. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_TIER, readModelTier } from "../bin/config-read.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
const mk = (fm) => {
  const d = mkdtempSync(join(tmpdir(), "light-tier-"));
  writeFileSync(join(d, "config.md"), `---\n${fm}\n---\n\n# Config\n`);
  return d;
};
const resolve = (d, role) =>
  spawnSync("node", [CLI, "resolve-model", role, "--data-dir", d], { encoding: "utf8" }).stdout;

test("role->tier map: coordinator is light, think is think, rest build", () => {
  assert.equal(ROLE_TIER.coordinator, "light");
  assert.equal(ROLE_TIER.think, "think");
  for (const r of ["build", "build_trivial", "fixer", "operational", "operational_fix", "simplifier"]) {
    assert.equal(ROLE_TIER[r], "build", r);
  }
});

test("AC-1 models.light haiku -> coordinator resolves haiku", () => {
  const d = mk(`models:\n  think: opus\n  build: sonnet\n  light: haiku`);
  try {
    assert.match(resolve(d, "coordinator"), /^model=haiku /);
    assert.match(resolve(d, "build"), /^model=sonnet /);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("AC-2 absent or empty light -> resolved build value, never haiku", () => {
  for (const fm of [
    `models:\n  think: opus\n  build: sonnet`,
    `models:\n  think: opus\n  build: sonnet\n  light: ""`,
  ]) {
    const d = mk(fm);
    try {
      assert.match(resolve(d, "coordinator"), /^model=sonnet /);
      assert.equal(readModelTier(d, "light"), "sonnet");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
  const d = mk(`models:\n  build: claude-sonnet-4-6`);
  try { assert.equal(readModelTier(d, "light"), "sonnet"); } // legacy id mapped to family tier
  finally { rmSync(d, { recursive: true, force: true }); }
  const e = mk(`models:\n  build: ""\n  light: ""`);
  try { assert.equal(readModelTier(e, "light"), ""); }
  finally { rmSync(e, { recursive: true, force: true }); }
});

test("AC-3 think roles never resolve to light", () => {
  const d = mk(`models:\n  think: opus\n  build: sonnet\n  light: haiku`);
  try { assert.match(resolve(d, "think"), /^model=opus /); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test("the template ships models.light: haiku for NEW projects (owner decision, 4.10); an existing project's empty key still means no light tier", () => {
  // Was `light: ""` (AC-13). The owner asked for straightforward work to run on
  // Haiku by default. Existing projects are untouched: their config keeps the
  // empty key, and routing treats a light tier with no model of its own as build.
  const t = readFileSync(join(ROOT, "project-files", "templates", "config.md"), "utf8");
  assert.match(t, /^ {2}light: haiku/m);
  assert.match(t, /^ {2}size_tiers: "S=light,M=build,L=think,XL=think"/m);
});

test("config set-model light accepts haiku", () => {
  const d = mk(`models:\n  think: opus\n  build: sonnet\n  light: ""`);
  try {
    const r = spawnSync("node", [CLI, "config", "set-model", "light", "haiku", "--data-dir", d], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readModelTier(d, "light"), "haiku");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
