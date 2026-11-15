/**
 * Events rotation archives dropped lines (F010 AC-11/12/14/16/2).
 * Run: node --test tests/test_events_archive.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";

import { logEvent, withLockfile, EVENTS_LOG_NAME } from "../bin/_hook_lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "bin", "_hook_lib.mjs");
const CTX = join(HERE, "..", "bin", "shipyard-context.mjs");

function tmp() { return mkdtempSync(join(tmpdir(), "evarch-")); }
function nonEmpty(p) { return readFileSync(p, "utf8").split("\n").filter(Boolean); }
function archiveLines(d) {
  const ad = join(d, "events-archive");
  if (!existsSync(ad)) return [];
  return readdirSync(ad).flatMap((f) => nonEmpty(join(ad, f)));
}

test("rotation_archives_dropped_lines", () => { // AC-11
  const d = tmp();
  try {
    for (let i = 0; i < 30; i++) logEvent(d, "e", { n: i }, { maxLines: 10, maxBytes: 100 });
    const live = nonEmpty(join(d, EVENTS_LOG_NAME));
    const arch = archiveLines(d);
    assert.ok(live.length <= 11);
    assert.ok(arch.length > 0);
    const all = [...arch, ...live].map((l) => JSON.parse(l).n);
    assert.deepEqual(all, Array.from({ length: 30 }, (_, i) => i));
    assert.match(readdirSync(join(d, "events-archive"))[0], /^events-\d{4}-\d{2}-\d{2}\.jsonl$/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("below_threshold_no_archive", () => { // AND rule kept
  const d = tmp();
  try {
    for (let i = 0; i < 20; i++) logEvent(d, "e", { n: i }, { maxLines: 10, maxBytes: 1024 * 1024 });
    assert.equal(existsSync(join(d, "events-archive")), false);
    assert.equal(nonEmpty(join(d, EVENTS_LOG_NAME)).length, 20);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("withLockfile_reports_held", () => {
  const d = tmp();
  try {
    let a;
    withLockfile(join(d, "x.lock"), (h) => { a = h; });
    assert.equal(a, true);
    writeFileSync(join(d, "y.lock"), "");
    let b;
    withLockfile(join(d, "y.lock"), (h) => { b = h; }, { failOpen: true, maxRetries: 1, retryMs: 1 });
    assert.equal(b, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("concurrent_rotation_exactly_once", async () => { // AC-12
  const d = tmp();
  try {
    const N = 6, PER = 25;
    const script = `import {logEvent} from ${JSON.stringify(pathToUrl(LIB))};
      const [d,w]=[process.argv[1],process.argv[2]];
      for(let i=0;i<${PER};i++) logEvent(d,"e",{id:w+"-"+i},{maxLines:20,maxBytes:200});`;
    await Promise.all(Array.from({ length: N }, (_, w) => new Promise((res, rej) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", script, d, String(w)], { stdio: "ignore" });
      p.on("exit", (c) => (c === 0 ? res() : rej(new Error("child " + c))));
    })));
    const ids = [...archiveLines(d), ...nonEmpty(join(d, EVENTS_LOG_NAME))].map((l) => JSON.parse(l).id);
    assert.equal(ids.length, N * PER);
    assert.equal(new Set(ids).size, N * PER);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("scan_events_does_not_read_archive", () => { // AC-14
  const proj = tmp();
  const pd = tmp();
  try {
    spawnSync("git", ["init", "-q"], { cwd: proj });
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pd, CLAUDE_PROJECT_DIR: proj };
    delete env.SHIPYARD_DATA;
    const run = (...a) => spawnSync(process.execPath, [CTX, ...a], { encoding: "utf8", cwd: proj, env });
    const m = run("path").stdout.match(/SHIPYARD_DATA=(.+)/);
    assert.ok(m, "could not resolve data dir");
    const d = m[1].trim();
    mkdirSync(join(d, "events-archive"), { recursive: true });
    writeFileSync(join(d, "events-archive", "events-2020-01-01.jsonl"), JSON.stringify({ type: "archived_only" }) + "\n");
    writeFileSync(join(d, EVENTS_LOG_NAME), JSON.stringify({ type: "live_one" }) + "\n");
    const r = run("scan-events", "archived_only", "live_one");
    assert.match(r.stdout, /live_one/);
    assert.doesNotMatch(r.stdout, /archived_only/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(pd, { recursive: true, force: true });
  }
});

test("event_shape_unchanged", () => { // AC-2
  const d = tmp();
  try {
    logEvent(d, "foo", { a: 1 });
    const ev = JSON.parse(nonEmpty(join(d, EVENTS_LOG_NAME))[0]);
    assert.equal(ev.type, "foo");
    assert.equal(ev.a, 1);
    assert.ok(ev.ts);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

function pathToUrl(p) { return "file://" + (p.startsWith("/") ? "" : "/") + p.replace(/\\/g, "/"); }


test("failed_live_rewrite_keeps_event_and_no_duplicates", () => { // AC-12 AC-16
  const d = tmp();
  try {
    const opts = { maxLines: 10, maxBytes: 100 };
    for (let i = 0; i < 9; i++) logEvent(d, "e", { n: i }, { maxLines: 1000, maxBytes: 1e9 });
    const failing = { ...opts, _atomicWrite: () => { throw new Error("EBUSY"); } };
    logEvent(d, "e", { n: 9 }, failing);
    logEvent(d, "e", { n: 10 }, failing);
    for (let i = 11; i < 20; i++) logEvent(d, "e", { n: i }, opts);
    const all = [...archiveLines(d), ...nonEmpty(join(d, EVENTS_LOG_NAME))].map((l) => JSON.parse(l).n);
    assert.deepEqual([...all].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
    assert.equal(new Set(all).size, 20);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("windows_style_eperm_rename_failure", () => { // AC-16
  const d = tmp();
  try {
    const eperm = () => { const e = new Error("EPERM: operation not permitted, rename"); e.code = "EPERM"; throw e; };
    for (let i = 0; i < 15; i++) logEvent(d, "e", { n: i }, { maxLines: 1000, maxBytes: 1e9 });
    logEvent(d, "e", { n: 15 }, { maxLines: 10, maxBytes: 100, _atomicWrite: eperm });
    const live = nonEmpty(join(d, EVENTS_LOG_NAME)).map((l) => JSON.parse(l).n);
    assert.ok(live.includes(15), "new event must land in live log");
    logEvent(d, "e", { n: 16 }, { maxLines: 10, maxBytes: 100 });
    const all = [...archiveLines(d), ...nonEmpty(join(d, EVENTS_LOG_NAME))].map((l) => JSON.parse(l).n);
    assert.deepEqual(all, Array.from({ length: 17 }, (_, i) => i));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
