/**
 * Parity tests for bin/_hook_lib.mjs.
 *
 * Mirrors tests/test_hook_lib.py case-for-case so the Node port can be
 * trusted as a drop-in replacement before Phase H4 deletes the Python
 * implementation. If a test exists in test_hook_lib.py and not here, that
 * is a port gap.
 *
 * Run via:  node --test tests/test_hook_lib.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sanitizeForLog,
  dataDirContains,
  logBreadcrumb,
  logEvent,
  EVENTS_LOG_NAME,
  resolveShipyardData,
  atomicWrite,
  withLockfile,
  WORKTREE_NAME_RE,
  SKILL_SLUG_RE,
  REFERENCE_NAME_RE,
} from "../bin/_hook_lib.mjs";

// ---- sanitizeForLog ----

test("sanitizeForLog: strips newline", () => {
  assert.equal(sanitizeForLog("a\nb"), "ab");
});

test("sanitizeForLog: strips carriage return", () => {
  assert.equal(sanitizeForLog("a\rb"), "ab");
});

test("sanitizeForLog: strips tab", () => {
  assert.equal(sanitizeForLog("a\tb"), "ab");
});

test("sanitizeForLog: strips ANSI escape", () => {
  // ESC \x1b is a C0 control char — Python's isprintable() returns False
  // for ESC, so the byte is dropped but the rest of the sequence ([31m)
  // passes through as printable ASCII.
  assert.equal(sanitizeForLog("a\x1b[31mb"), "a[31mb");
});

test("sanitizeForLog: strips DEL char", () => {
  assert.equal(sanitizeForLog("a\x7fb"), "ab");
});

test("sanitizeForLog: preserves plain space", () => {
  assert.equal(sanitizeForLog("hello world"), "hello world");
});

test("sanitizeForLog: preserves printable Unicode", () => {
  assert.equal(sanitizeForLog("café"), "café");
});

test("sanitizeForLog: caps length with ellipsis", () => {
  const result = sanitizeForLog("x".repeat(500), 10);
  // 10 chars + ellipsis = 11 code units
  assert.equal([...result].length, 11);
  assert.ok(result.endsWith("…"));
});

test("sanitizeForLog: null returns empty string", () => {
  assert.equal(sanitizeForLog(null), "");
});

test("sanitizeForLog: undefined returns empty string", () => {
  assert.equal(sanitizeForLog(undefined), "");
});

test("sanitizeForLog: non-string coerced", () => {
  assert.equal(sanitizeForLog(42), "42");
});

// ---- dataDirContains ----

function withTempDir(name, fn) {
  // Sync usage only — all callers in this file pass synchronous functions.
  // If you need async, use `await withTempDirAsync(...)` instead.
  const dir = mkdtempSync(join(tmpdir(), `hooklib-${name}-`));
  try {
    const result = fn(dir);
    if (result && typeof result.then === "function") {
      throw new Error("withTempDir got an async fn — use withTempDirAsync");
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("dataDirContains: file inside returns true", () => {
  withTempDir("contains", (real) => {
    const inner = join(real, "spec.md");
    assert.equal(dataDirContains(inner, real), true);
  });
});

test("dataDirContains: file outside returns false", () => {
  withTempDir("contains", (real) => {
    withTempDir("other", (other) => {
      const target = join(other, "evil.md");
      assert.equal(dataDirContains(target, real), false);
    });
  });
});

test("dataDirContains: prefix collision (sibling -evil) returns false", () => {
  // The classic startsWith bug: /foo and /foo-evil share a string prefix
  // but /foo-evil/hack.py is NOT inside /foo. path.relative correctly
  // returns "../foo-evil/hack.py" which starts with "..".
  withTempDir("contains", (real) => {
    const sibling = real + "-evil";
    mkdirSync(sibling, { recursive: true });
    try {
      const target = join(sibling, "hack.py");
      assert.equal(dataDirContains(target, real), false);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

test("dataDirContains: empty inputs return false", () => {
  assert.equal(dataDirContains("", "/foo"), false);
  assert.equal(dataDirContains("/foo", ""), false);
});

// ---- logBreadcrumb ----

test("logBreadcrumb: writes single line", () => {
  withTempDir("log", (real) => {
    logBreadcrumb(real, ".test.log", "allow", ["Edit", "/foo/bar.md"]);
    const path = join(real, ".test.log");
    const content = readFileSync(path, "utf8");
    assert.equal(content.split("\n").length - 1, 1, "exactly one trailing newline");
    assert.ok(content.includes("allow"));
    assert.ok(content.includes("Edit"));
    assert.ok(content.includes("/foo/bar.md"));
  });
});

test("logBreadcrumb: creates data dir if missing", () => {
  withTempDir("log", (real) => {
    const fresh = join(real, "new-dir");
    logBreadcrumb(fresh, ".test.log", "allow", ["Edit"]);
    const stat = statSync(join(fresh, ".test.log"));
    assert.ok(stat.isFile());
  });
});

test("logBreadcrumb: empty data dir is no-op", () => {
  // Should silently return without error
  logBreadcrumb("", ".test.log", "allow", ["Edit"]);
});

test("logBreadcrumb: newline in field cannot forge a second log line", () => {
  withTempDir("log", (real) => {
    logBreadcrumb(real, ".test.log", "allow", [
      "Edit",
      "bad\nfield\n2099-01-01 forged entry",
    ]);
    const content = readFileSync(join(real, ".test.log"), "utf8");
    assert.equal(content.split("\n").length - 1, 1);
  });
});

test("logBreadcrumb: rotation caps lines under maxLines+maxBytes pressure", () => {
  withTempDir("log", (real) => {
    const path = join(real, ".test.log");
    for (let i = 0; i < 200; i++) {
      logBreadcrumb(
        real,
        ".test.log",
        "allow",
        [`line-${i}`],
        { maxLines: 50, maxBytes: 1024 },
      );
    }
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    // Rotation should have kicked in at least once, leaving at most
    // maxLines + a few new entries since the most recent rotation.
    assert.ok(
      lines.length <= 100,
      `rotation ineffective: ${lines.length} lines (expected <=100)`,
    );
  });
});

// ---- resolveShipyardData ----

test("resolveShipyardData: env var wins", async () => {
  const orig = process.env.SHIPYARD_DATA;
  process.env.SHIPYARD_DATA = "/tmp/forced-path";
  try {
    const result = await resolveShipyardData();
    assert.equal(result, "/tmp/forced-path");
  } finally {
    if (orig === undefined) delete process.env.SHIPYARD_DATA;
    else process.env.SHIPYARD_DATA = orig;
  }
});

test("resolveShipyardData: missing env does not throw", async () => {
  const orig = process.env.SHIPYARD_DATA;
  delete process.env.SHIPYARD_DATA;
  try {
    const result = await resolveShipyardData();
    // Either resolves via the bundled resolver (returns a path) or returns ''
    assert.equal(typeof result, "string");
  } finally {
    if (orig !== undefined) process.env.SHIPYARD_DATA = orig;
  }
});

// ---- atomicWrite ----

test("atomicWrite: writes file content", () => {
  withTempDir("atomic", (real) => {
    const path = join(real, "out.txt");
    atomicWrite(path, "hello\n");
    assert.equal(readFileSync(path, "utf8"), "hello\n");
  });
});

test("atomicWrite: overwrites existing file", () => {
  withTempDir("atomic", (real) => {
    const path = join(real, "out.txt");
    writeFileSync(path, "old");
    atomicWrite(path, "new");
    assert.equal(readFileSync(path, "utf8"), "new");
  });
});

test("atomicWrite: creates parent directory if missing", () => {
  withTempDir("atomic", (real) => {
    const path = join(real, "nested", "deep", "out.txt");
    atomicWrite(path, "hi");
    assert.equal(readFileSync(path, "utf8"), "hi");
  });
});

test("atomicWrite: leaves no .tmp- artifact on success", () => {
  withTempDir("atomic", (real) => {
    const path = join(real, "out.txt");
    atomicWrite(path, "x");
    const remaining = readdirSync(real).filter((n) => n.startsWith(".out.txt.tmp-"));
    assert.equal(remaining.length, 0);
  });
});

// ---- withLockfile ----

test("withLockfile: runs the callback under lock", () => {
  withTempDir("lock", (real) => {
    const lockPath = join(real, "guard.lock");
    let ran = false;
    withLockfile(lockPath, () => {
      ran = true;
    });
    assert.equal(ran, true);
    // Lock file removed after exit
    let stillExists = false;
    try {
      statSync(lockPath);
      stillExists = true;
    } catch {
      stillExists = false;
    }
    assert.equal(stillExists, false);
  });
});

test("withLockfile: removes lock even if callback throws", () => {
  withTempDir("lock", (real) => {
    const lockPath = join(real, "guard.lock");
    assert.throws(() =>
      withLockfile(lockPath, () => {
        throw new Error("boom");
      }),
    );
    let stillExists = false;
    try {
      statSync(lockPath);
      stillExists = true;
    } catch {
      stillExists = false;
    }
    assert.equal(stillExists, false);
  });
});

test("withLockfile: stale lock recovery via mtime", () => {
  withTempDir("lock", (real) => {
    const lockPath = join(real, "guard.lock");
    // Write a stale lockfile (mtime way in the past)
    writeFileSync(lockPath, "");
    const oldTs = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath, oldTs, oldTs);
    // ttlMs default is 30000, so this should be considered stale.
    let ran = false;
    withLockfile(lockPath, () => {
      ran = true;
    });
    assert.equal(ran, true);
  });
});

// ---- Frozen identifier regexes ----

test("WORKTREE_NAME_RE accepts valid names", () => {
  assert.ok(WORKTREE_NAME_RE.test("task-001"));
  assert.ok(WORKTREE_NAME_RE.test("F042"));
  assert.ok(WORKTREE_NAME_RE.test("a"));
});

test("WORKTREE_NAME_RE rejects invalid names", () => {
  assert.equal(WORKTREE_NAME_RE.test(""), false);
  assert.equal(WORKTREE_NAME_RE.test(".lock"), false);
  assert.equal(WORKTREE_NAME_RE.test("../escape"), false);
  assert.equal(WORKTREE_NAME_RE.test("name with spaces"), false);
  assert.equal(WORKTREE_NAME_RE.test("a".repeat(65)), false);
});

test("SKILL_SLUG_RE accepts ship-* slugs", () => {
  assert.ok(SKILL_SLUG_RE.test("ship-discuss"));
  assert.ok(SKILL_SLUG_RE.test("ship-execute"));
});

test("SKILL_SLUG_RE rejects non-ship slugs", () => {
  assert.equal(SKILL_SLUG_RE.test("discuss"), false);
  assert.equal(SKILL_SLUG_RE.test("ship-"), false);
  assert.equal(SKILL_SLUG_RE.test("ship-EXECUTE"), false);
});

test("REFERENCE_NAME_RE accepts simple ref names", () => {
  assert.ok(REFERENCE_NAME_RE.test("communication-design"));
  assert.ok(REFERENCE_NAME_RE.test("backlog-reeval.md"));
});

test("REFERENCE_NAME_RE rejects path traversal", () => {
  assert.equal(REFERENCE_NAME_RE.test("../etc"), false);
  assert.equal(REFERENCE_NAME_RE.test("/abs"), false);
  assert.equal(REFERENCE_NAME_RE.test(""), false);
});

// ---- logEvent ----
//
// `logEvent` is the writer side of the structured event log
// (`.shipyard-events.jsonl`) used by `shipyard-data events` and the
// `shipyard-context diagnose` dump. The contract: append-only JSONL,
// sanitized fields, byte-capped rotation, errors swallowed.

function withTempEventsDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "events-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readEvents(dir) {
  const path = join(dir, EVENTS_LOG_NAME);
  try {
    return readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test("logEvent: writes a single JSONL line with type and ts", () => {
  withTempEventsDir((dir) => {
    logEvent(dir, "compaction_detected", { count: 3, sprint: "S001" });
    const events = readEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "compaction_detected");
    assert.equal(events[0].count, 3);
    assert.equal(events[0].sprint, "S001");
    assert.match(events[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  });
});

test("logEvent: appends without truncating earlier events", () => {
  withTempEventsDir((dir) => {
    logEvent(dir, "first", { n: 1 });
    logEvent(dir, "second", { n: 2 });
    logEvent(dir, "third", { n: 3 });
    const events = readEvents(dir);
    assert.equal(events.length, 3);
    assert.equal(events[0].type, "first");
    assert.equal(events[2].type, "third");
  });
});

test("logEvent: preserves number and boolean field types", () => {
  withTempEventsDir((dir) => {
    logEvent(dir, "x", { count: 42, ratio: 3.14, flag: true, off: false });
    const [ev] = readEvents(dir);
    assert.equal(typeof ev.count, "number");
    assert.equal(ev.count, 42);
    assert.equal(typeof ev.ratio, "number");
    assert.equal(ev.ratio, 3.14);
    assert.equal(typeof ev.flag, "boolean");
    assert.equal(ev.flag, true);
    assert.equal(ev.off, false);
  });
});

test("logEvent: sanitizes string fields against newline forgery", () => {
  withTempEventsDir((dir) => {
    // A malicious file path containing a newline + a fake log line.
    // sanitizeForLog must strip the newline so the JSON line stays one
    // line and the fake event cannot be smuggled in.
    logEvent(dir, "session_guard_blocked", {
      file: "ok.ts\n{\"type\":\"FAKE\"}",
    });
    const path = join(dir, EVENTS_LOG_NAME);
    const raw = readFileSync(path, "utf8");
    // One trailing newline = one event line on disk.
    assert.equal(raw.split("\n").filter(Boolean).length, 1);
    const events = readEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "session_guard_blocked");
    assert.ok(!events[0].file.includes("\n"));
  });
});

test("logEvent: drops null and undefined fields", () => {
  withTempEventsDir((dir) => {
    logEvent(dir, "x", { kept: 1, gone: null, also_gone: undefined });
    const [ev] = readEvents(dir);
    assert.equal(ev.kept, 1);
    assert.ok(!("gone" in ev));
    assert.ok(!("also_gone" in ev));
  });
});

test("logEvent: no-op when dataDir is empty", () => {
  // No throw, no file created. Mirrors logBreadcrumb's contract.
  logEvent("", "x", { a: 1 });
  // If we got here without throwing, the contract held.
});

test("logEvent: no-op when type is empty", () => {
  withTempEventsDir((dir) => {
    logEvent(dir, "", { a: 1 });
    const events = readEvents(dir);
    assert.equal(events.length, 0);
  });
});

test("logEvent: rotates by tail when over byte cap", () => {
  withTempEventsDir((dir) => {
    // Tiny caps so we trigger rotation deterministically. Each event is
    // ~80 bytes; 5 lines × ~80 ≈ 400 B, well over a 200 B cap.
    for (let i = 0; i < 10; i++) {
      logEvent(
        dir,
        "x",
        { i, padding: "abcdefghij".repeat(3) },
        { maxLines: 4, maxBytes: 200 },
      );
    }
    const events = readEvents(dir);
    // Rotation keeps the tail. Exact count depends on JSON encoding size,
    // but it must be << 10 and the most recent event must be present.
    assert.ok(events.length <= 5, `expected rotation, got ${events.length} events`);
    assert.equal(events[events.length - 1].i, 9);
  });
});

test("logEvent: handles unserializable values by dropping the event", () => {
  withTempEventsDir((dir) => {
    const cyclic = {};
    cyclic.self = cyclic;
    logEvent(dir, "x", { bad: cyclic });
    // Sanitize coerces objects to strings via String(), so the event
    // SHOULD actually be written (with bad="[object Object]") because
    // sanitizeForLog will stringify it before JSON.stringify sees it.
    // What we're testing here is that the call doesn't THROW.
    const events = readEvents(dir);
    // Event was either written (sanitized to a string) or dropped — both
    // are acceptable; the contract is "doesn't throw".
    assert.ok(events.length === 0 || events.length === 1);
  });
});
