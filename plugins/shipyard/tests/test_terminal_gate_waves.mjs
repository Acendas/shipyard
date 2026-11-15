/**
 * parseWaves quoted `Tasks:` lists (F002 AC-8).
 * Run: node --test tests/test_terminal_gate_waves.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWaves } from "../bin/terminal-gate.mjs";

const wave = (tasksLine) => `## Waves\n\n### Wave 1\n${tasksLine}\n`;

test("AC-8: double-quoted Tasks ids parse without quotes", () => {
  assert.deepEqual(parseWaves(wave('Tasks: ["T001", "T002"]'))[0].tasks, ["T001", "T002"]);
});

test("AC-8: single-quoted Tasks ids parse without quotes", () => {
  assert.deepEqual(parseWaves(wave("Tasks: ['T001', 'T002']"))[0].tasks, ["T001", "T002"]);
});

test("unquoted Tasks ids unchanged", () => {
  assert.deepEqual(parseWaves(wave("Tasks: [T001, T002]"))[0].tasks, ["T001", "T002"]);
  assert.deepEqual(parseWaves(wave("Tasks: T001, T-P002"))[0].tasks, ["T001", "T-P002"]);
});

test("placeholders still filtered when quoted", () => {
  assert.deepEqual(parseWaves(wave('Tasks: ["T001", "TBD"]'))[0].tasks, ["T001"]);
});
