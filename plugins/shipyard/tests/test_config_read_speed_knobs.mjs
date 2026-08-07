/**
 * Tests for the v3.24.0 sprint-speed config accessors in bin/config-read.mjs.
 *
 * Every accessor must return today's behavior on an absent key (a project
 * initialized before the key existed is never broken) and must never fail open
 * on a malformed value — an uncapped wave width or a silently-flipped refactor
 * scope is exactly the failure these caps exist to prevent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readRefactorScope,
  readDispatchOrder,
  readMaxTasksPerWave,
  readMergeIndependentLayers,
  readMaxTasksPerWaveMerged,
  hasConfiguredCommand,
} from "../bin/config-read.mjs";

function withConfig(execBlock) {
  const dir = mkdtempSync(join(tmpdir(), "cfg-speed-"));
  mkdirSync(dir, { recursive: true });
  if (execBlock != null) {
    writeFileSync(join(dir, "config.md"), `---\nexecution:\n${execBlock}\n---\n\n# Config\n`);
  }
  return dir;
}

test("absent config.md yields today's defaults for every speed knob", () => {
  const d = withConfig(null);
  try {
    assert.equal(readRefactorScope(d), "sprint");
    assert.equal(readDispatchOrder(d), "critical_path");
    assert.equal(readMaxTasksPerWave(d), 6);
    assert.equal(readMergeIndependentLayers(d), true);
    assert.equal(readMaxTasksPerWaveMerged(d), 12);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("absent keys inside an existing execution block yield defaults", () => {
  const d = withConfig("  isolation: worktree");
  try {
    assert.equal(readRefactorScope(d), "sprint");
    assert.equal(readDispatchOrder(d), "critical_path");
    assert.equal(readMaxTasksPerWaveMerged(d), 12);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("explicit values are honored", () => {
  const d = withConfig(
    [
      "  refactor_scope: wave",
      "  dispatch_order: task_id",
      "  max_tasks_per_wave: 4",
      "  merge_independent_layers: false",
      "  max_tasks_per_wave_merged: 8",
    ].join("\n"),
  );
  try {
    assert.equal(readRefactorScope(d), "wave");
    assert.equal(readDispatchOrder(d), "task_id");
    assert.equal(readMaxTasksPerWave(d), 4);
    assert.equal(readMergeIndependentLayers(d), false);
    assert.equal(readMaxTasksPerWaveMerged(d), 8);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("trailing comments are stripped, matching the isolation reader", () => {
  const d = withConfig("  refactor_scope: wave   # per-wave attribution matters here");
  try {
    assert.equal(readRefactorScope(d), "wave");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("malformed values fall back to the default rather than failing open", () => {
  const d = withConfig(
    [
      "  refactor_scope: nonsense",
      "  dispatch_order: nonsense",
      "  max_tasks_per_wave: 0",
      "  max_tasks_per_wave_merged: -3",
    ].join("\n"),
  );
  try {
    // Unknown scope/order resolve to the DEFAULT, not to the other option —
    // a typo must not silently flip behavior.
    assert.equal(readRefactorScope(d), "sprint");
    assert.equal(readDispatchOrder(d), "critical_path");
    // Width caps never become Infinity: an uncapped merged wave is precisely
    // the unbounded merge surface max_tasks_per_wave exists to prevent.
    assert.equal(readMaxTasksPerWave(d), 6);
    assert.equal(readMaxTasksPerWaveMerged(d), 12);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("merge_independent_layers only turns off on an explicit false", () => {
  for (const [raw, expected] of [["false", false], ["FALSE", false], ["true", true], ["yes", true], ["", true]]) {
    const d = withConfig(raw === "" ? "  isolation: worktree" : `  merge_independent_layers: ${raw}`);
    try {
      assert.equal(readMergeIndependentLayers(d), expected, `raw=${JSON.stringify(raw)}`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

test("hasConfiguredCommand sees a key written below a flush-left comment", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-block-"));
  try {
    // A `#` comment at column 0 inside the block used to read as "block ended",
    // hiding `full:` — which made a real build stage look collapsible.
    writeFileSync(
      join(dir, "config.md"),
      `---\nbuild_commands:\n  scoped: ""\n# full build for this monorepo\n  full: "npm run build"\n---\n\n# Config\n`,
    );
    assert.equal(hasConfiguredCommand(dir, "build_commands", "full"), true);
    assert.equal(hasConfiguredCommand(dir, "build_commands", "scoped"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasConfiguredCommand still stops at a genuine sibling block", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-block2-"));
  try {
    writeFileSync(
      join(dir, "config.md"),
      `---\nbuild_commands:\n  scoped: ""\nexecution:\n  full: "not a build command"\n---\n\n# Config\n`,
    );
    assert.equal(hasConfiguredCommand(dir, "build_commands", "full"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
