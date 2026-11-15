/** T098: one block-scan; pins the column-0 comment rule and the shared ms helper. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMaxSessionMinutes, readBlockScalar } from "../bin/config-read.mjs";
import { toMs } from "../bin/session-budget.mjs";

function cfg(body) {
  const d = mkdtempSync(join(tmpdir(), "cfg-scan-"));
  writeFileSync(join(d, "config.md"), `---\n${body}\n---\n`);
  return d;
}

test("column-0 comment inside execution block does not end it (rule: skip)", () => {
  const d = cfg("execution:\n  max_parked_ratio: 0.5\n# a comment\n\n  max_session_minutes: 90\nother: 1");
  try {
    assert.deepEqual(readMaxSessionMinutes(d), { value: 90, valid: true });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a non-comment column-0 line still ends the block", () => {
  const d = cfg("execution:\n  x: 1\nother:\n  max_session_minutes: 90");
  try {
    assert.deepEqual(readMaxSessionMinutes(d), { value: 0, valid: true });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("quoted value and inline comment; multi-word value is absent for execution scalars", () => {
  const d = cfg('execution:\n  max_session_minutes: "45" # note\nmodels:\n  think: "some model" # c');
  try {
    assert.deepEqual(readMaxSessionMinutes(d), { value: 45, valid: true });
    assert.equal(readBlockScalar(d, "models", "think"), "some model");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("toMs is non-finite safe", () => {
  assert.ok(Number.isNaN(toMs(Infinity)));
  assert.ok(Number.isNaN(toMs(NaN)));
  assert.equal(toMs(5), 5);
  assert.equal(toMs(new Date(7)), 7);
  assert.equal(toMs("1970-01-01T00:00:01Z"), 1000);
  assert.ok(Number.isNaN(toMs("")));
});
