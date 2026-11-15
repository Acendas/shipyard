/**
 * accept-return event fields v2 (F010 AC-1/2/3/4).
 * Run: node --test tests/test_event_fields_v2.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "bin", "shipyard-data.mjs");

function accept(extra) {
  const d = mkdtempSync(join(tmpdir(), "evf2-"));
  mkdirSync(join(d, "spec", "tasks"), { recursive: true });
  writeFileSync(join(d, "spec", "tasks", "T001-x.md"),
    '---\nid: "T001"\ntitle: "x"\ntype: task\nstatus: in_progress\n---\n# x\n');
  const g = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
  g("init", "-q");
  g("commit", "-q", "--allow-empty", "-m", "c");
  const sha = g("rev-parse", "HEAD").stdout.trim();
  const r = spawnSync(process.execPath, [CLI, "task", "accept-return", "T001",
    "sprint=s1", "wave=1", `commit=${sha}`, ...extra, "--data-dir", d],
    { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
  let ev = null;
  try {
    const lines = readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").split("\n").filter(Boolean);
    ev = lines.map((l) => JSON.parse(l)).find((e) => e.type === "task_dispatch_returned");
  } catch { /* no log */ }
  rmSync(d, { recursive: true, force: true });
  return { r, ev };
}

test("fields_emitted_when_known", () => { // AC-1
  const { ev } = accept(["role=builder", "model=sonnet", "effort=high", "attempt=2", "tokens=1234"]);
  assert.ok(ev, "event emitted");
  assert.equal(ev.role, "builder");
  assert.equal(ev.model, "sonnet");
  assert.equal(ev.effort, "high");
  assert.equal(ev.attempt, 2);
  assert.equal(ev.tokens, 1234);
});

test("blank_zero_omitted", () => { // AC-1, AC-4
  const { ev } = accept(["role=", "model=unknown", "effort=  ", "attempt=0", "tokens=0"]);
  assert.ok(ev);
  for (const k of ["role", "model", "effort", "attempt", "tokens"]) assert.ok(!(k in ev), k);
});

test("old_events_still_read", () => { // AC-2
  const { ev } = accept([]);
  assert.ok(ev);
  assert.equal(ev.status, "complete");
  for (const k of ["role", "model", "effort", "attempt", "tokens"]) assert.ok(!(k in ev), k);
});

test("string_cap_200", () => { // AC-3
  const { ev } = accept(["model=" + "m".repeat(500)]);
  assert.equal(ev.model.length, 200);
});

test("tokens_absent_when_unseen", () => { // AC-4
  const { ev } = accept(["tokens=abc", "attempt=-1"]);
  assert.ok(ev);
  assert.ok(!("tokens" in ev));
  assert.ok(!("attempt" in ev));
});

function emitCompleted(extra) {
  const d = mkdtempSync(join(tmpdir(), "evf2c-"));
  spawnSync(process.execPath, [CLI, "events", "emit", "subagent_completed", "task=T001", "status=COMPLETE", ...extra, "--data-dir", d],
    { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
  const ev = readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).find((e) => e.type === "subagent_completed");
  rmSync(d, { recursive: true, force: true });
  return ev;
}

test("subagent_completed_carries_attribution", () => { // AC-1
  const ev = emitCompleted(["role=builder", "model=sonnet", "effort=high", "attempt=2"]);
  assert.equal(ev.role, "builder");
  assert.equal(ev.model, "sonnet");
  assert.equal(ev.effort, "high");
  assert.equal(ev.attempt, 2);
  assert.equal(ev.task, "T001");
});

test("subagent_completed_omits_blank_and_caps", () => { // AC-1, AC-3, AC-4
  const ev = emitCompleted(["role=", "model=" + "m".repeat(500), "effort=unknown", "attempt=0", "tokens=abc"]);
  assert.ok(!("role" in ev) && !("effort" in ev) && !("attempt" in ev) && !("tokens" in ev));
  assert.equal(ev.model.length, 200);
});

test("accept_operational_carries_attribution", () => { // AC-1
  const d = mkdtempSync(join(tmpdir(), "evf2o-"));
  mkdirSync(join(d, "spec", "tasks"), { recursive: true });
  writeFileSync(join(d, "spec", "tasks", "T002-x.md"),
    '---\nid: "T002"\ntitle: "x"\ntype: task\nkind: operational\nstatus: in_progress\n---\n# x\n');
  const g = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
  g("init", "-q");
  g("commit", "-q", "--allow-empty", "-m", "c");
  writeFileSync(join(d, "cap.txt"), "ok\n");
  const r = spawnSync(process.execPath, [CLI, "task", "accept-operational", "T002", "sprint=s1", "wave=1",
    `capture=${join(d, "cap.txt")}`, "iterations=1", "role=operational", "model=haiku", "attempt=1", "--data-dir", d],
    { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: d, } , cwd: d });
  const evs = readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ev = evs.find((e) => e.type === "task_dispatch_returned");
  rmSync(d, { recursive: true, force: true });
  assert.ok(ev, r.stderr);
  assert.equal(ev.role, "operational");
  assert.equal(ev.model, "haiku");
  assert.equal(ev.attempt, 1);
  assert.ok(!("effort" in ev) && !("tokens" in ev));
});
