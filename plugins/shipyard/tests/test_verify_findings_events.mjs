/**
 * `shipyard-data verify findings` (F010 AC-17): counts only, CLI-emitted.
 * Run: node --test tests/test_verify_findings_events.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "bin", "shipyard-data.mjs");

function run(args) {
  const d = mkdtempSync(join(tmpdir(), "vfind-"));
  const r = spawnSync(process.execPath, [CLI, "verify", "findings", ...args, "--data-dir", d],
    { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
  const log = join(d, ".shipyard-events.jsonl");
  const raw = existsSync(log) ? readFileSync(log, "utf8") : "";
  const ev = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "wave_verify_findings");
  rmSync(d, { recursive: true, force: true });
  return { r, ev, raw };
}

const GOOD = ["--wave", "2", "--tasks", "T001,T002", "--met", "5", "--partial", "1", "--missing", "2", "--over-built", "0"];

test("counts_per_classification", () => { // AC-17
  const { r, ev } = run(GOOD);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ev.wave, 2);
  assert.equal(ev.task_ids, "T001,T002");
  assert.equal(ev.finding_count, 8);
  assert.deepEqual([ev.met, ev.partial, ev.missing, ev.over_built], [5, 1, 2, 0]);
});

test("no_finding_text_in_event", () => { // AC-17
  const { r, ev, raw } = run([...GOOD, "--text", "SECRET-FINDING-TEXT"]);
  assert.notEqual(r.status, 0);
  assert.equal(ev, undefined);
  assert.ok(!raw.includes("SECRET-FINDING-TEXT"));
  assert.ok(!r.stdout.includes("SECRET-FINDING-TEXT"));
});

test("rejects_invalid_counts", () => {
  for (const bad of ["-1", "1.5", "abc", ""]) {
    const { r, ev } = run(["--wave", "1", "--tasks", "T001", "--met", bad]);
    assert.notEqual(r.status, 0, bad);
    assert.equal(ev, undefined);
  }
  assert.notEqual(run(["--wave", "1", "--tasks", "free text here", "--met", "1"]).r.status, 0);
});
