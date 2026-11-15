/** F026: the chained-discuss queue is CLI-owned, resumable, bounded. Run: node --test tests/test_discuss_queue.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kindOf, STATUSES, QUEUE_BASENAME } from "../bin/discuss-queue.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "discuss-queue-"));
  const d = join(base, "projects", "abc123abc123");
  mkdirSync(join(d, "templates"), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  return { base, d };
}
const run = (d, ...args) => spawnSync("node", [CLI, "discuss-queue", ...args, "--data-dir", d], { encoding: "utf8" });
const events = (d) => readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("kindOf: ideas, stories (incl. legacy aliases) and external keys; anything else is refused", () => {
  assert.equal(kindOf("IDEA-007"), "idea");
  assert.equal(kindOf("S012"), "story");
  assert.equal(kindOf("F012"), "story");
  assert.equal(kindOf("ABC-123"), "external");
  assert.equal(kindOf("P001"), null, "a builder step is not discussable");
  assert.equal(kindOf("T001"), null);
  assert.equal(kindOf("banana"), null);
  assert.deepEqual([...STATUSES], ["pending", "in-discussion", "refined", "skipped", "deferred", "needs-info"]);
});

test("AC-1/AC-2/AC-4/AC-5: start, next, mark, stop, resume at the recorded position, done, clear — all through the CLI file", () => {
  const { base, d } = fixture();
  try {
    let r = run(d, "start", "--items", "S001,P009");
    assert.equal(r.status, 2, "a step id is refused");
    assert.match(r.stderr, /P009/);

    r = run(d, "start", "--items", "S001,IDEA-002,ABC-3,S001", "--summary-every", "2");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /3 item\(s\)/, "duplicates collapse");
    assert.ok(existsSync(join(d, QUEUE_BASENAME)));

    r = run(d, "start", "--items", "S009");
    assert.equal(r.status, 3, "an active queue is never silently replaced");
    assert.match(r.stderr, /--force/);

    r = run(d, "next", "--json");
    assert.equal(r.status, 0, r.stderr);
    let j = JSON.parse(r.stdout);
    assert.equal(j.item.id, "S001");
    assert.equal(j.item.status, "in-discussion");
    assert.deepEqual(j.decisions, []);
    assert.equal(j.summary_due, false);

    r = run(d, "decision", "add", "naming: use 'story' everywhere");
    assert.equal(r.status, 0, r.stderr);
    r = run(d, "decision", "add", "naming: use 'story' everywhere");
    assert.match(r.stdout, /\(1\)/, "decisions dedupe");

    r = run(d, "mark", "S001", "refined", "--note", "8 pts, 3 scenarios");
    assert.equal(r.status, 0, r.stderr);
    r = run(d, "mark", "S001", "bogus");
    assert.equal(r.status, 2);
    r = run(d, "mark", "S777", "skipped");
    assert.equal(r.status, 3, "an id outside the queue is refused");

    r = run(d, "next");
    assert.match(r.stdout, /item 2 of 3: IDEA-002 \(idea, in-discussion\)/);
    assert.match(r.stdout, /decisions so far:\n- naming: use 'story' everywhere/, "the carry-over note is the CLI's, not the chat's");
    r = run(d, "mark", "IDEA-002", "skipped");
    assert.equal(r.status, 0);

    // the session dies here; the queue file is the recovery point
    r = run(d, "stop");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /stopped at 2\/3/);
    assert.ok(existsSync(join(d, QUEUE_BASENAME)), "stop keeps the file for resume");

    r = run(d, "status", "--json");
    j = JSON.parse(r.stdout);
    assert.equal(j.active, true);
    assert.equal(j.current, "ABC-3");
    assert.equal(j.done, 2);

    r = run(d, "next");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /item 3 of 3: ABC-3 \(external, in-discussion\)/, "resume lands on the recorded position");
    assert.match(r.stdout, /SHIPYARD_DISCUSS_QUEUE_SUMMARY_DUE=true/, "cadence summary after every 2 settled items");

    r = run(d, "mark", "ABC-3", "deferred");
    r = run(d, "next");
    assert.match(r.stdout, /SHIPYARD_DISCUSS_QUEUE_DONE=true/);
    r = run(d, "start", "--items", "S009");
    assert.equal(r.status, 0, "a finished queue can be replaced without --force");
    r = run(d, "clear");
    assert.equal(r.status, 0);
    assert.ok(!existsSync(join(d, QUEUE_BASENAME)));
    r = run(d, "next");
    assert.equal(r.status, 3, "no queue → refuse, never invent one");

    const types = events(d).map((e) => e.type);
    assert.ok(types.includes("discuss_queue_started"));
    assert.ok(types.filter((t) => t === "discuss_queue_item_marked").length >= 3);
    assert.ok(types.includes("discuss_queue_stopped"));
    assert.ok(types.includes("discuss_queue_cleared"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("AC-7: lookahead is bounded to two items; needs-info items come back around", () => {
  const { base, d } = fixture();
  try {
    assert.equal(run(d, "start", "--items", "S001,S002,S003,S004").status, 0);
    let r = run(d, "next", "--peek", "3");
    assert.equal(r.status, 2, "peek > 2 is refused");
    r = run(d, "next", "--peek", "2", "--json");
    assert.deepEqual(JSON.parse(r.stdout).peek, ["S002", "S003"]);
    assert.equal(run(d, "mark", "S001", "needs-info", "--note", "waiting on the PO").status, 0);
    for (const id of ["S002", "S003", "S004"]) {
      r = run(d, "next", "--json");
      assert.equal(JSON.parse(r.stdout).item.id, id);
      assert.equal(run(d, "mark", id, "refined").status, 0);
    }
    r = run(d, "next", "--json");
    assert.equal(JSON.parse(r.stdout).item.id, "S001", "needs-info is not terminal: it wraps around");
    assert.equal(JSON.parse(r.stdout).item.note, "waiting on the PO");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
