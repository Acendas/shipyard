/**
 * Tests for bin/idea-backlog.mjs and the config accessor behind it.
 *
 * The invariant these protect is the one the old design got backwards:
 * ALLOCATION MUST NEVER FAIL. A builder that finds something real and is
 * refused an id writes the finding somewhere unindexed instead — which is how
 * a live project lost ~30 spec-reference findings and an inert config field to
 * a cap of 12 against a backlog of 156. The cap belongs on opening the next
 * sprint (a real deferral decision), not on writing down what you just saw.
 *
 * The other load-bearing behavior is that the acceptance escape hatch is
 * SIZE-SCOPED. The events log is append-only and project-wide, so an
 * unqualified acceptance would silently disable the gate forever after one use.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { countUndispositionedIdeas, checkIdeaBacklog } from "../bin/idea-backlog.mjs";
import { readMaxUndispositionedIdeas } from "../bin/config-read.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "shipyard-data.mjs");

/** Build a data dir with `statuses.length` idea files carrying those statuses. */
function withIdeas(statuses, execBlock) {
  const dir = mkdtempSync(join(tmpdir(), "idea-backlog-"));
  mkdirSync(join(dir, "spec", "ideas"), { recursive: true });
  statuses.forEach((status, i) => {
    const id = String(i + 1).padStart(3, "0");
    const body = status == null ? `no frontmatter here\n` : `---\nid: IDEA-${id}\nstatus: ${status}\n---\nbody\n`;
    writeFileSync(join(dir, "spec", "ideas", `IDEA-${id}-x.md`), body);
  });
  if (execBlock != null) {
    writeFileSync(join(dir, "config.md"), `---\nexecution:\n${execBlock}\n---\n\n# Config\n`);
  }
  return dir;
}

function cleanup(d) {
  rmSync(d, { recursive: true, force: true });
}

// --- counting -------------------------------------------------------------

test("only graduated/rejected ideas are dispositioned", () => {
  const d = withIdeas(["captured", "proposed", "graduated", "rejected", "GRADUATED"]);
  try {
    // 5 files, 3 dispositioned (graduated, rejected, GRADUATED — case-insensitive).
    assert.deepEqual(countUndispositionedIdeas(d), { count: 2, total: 5 });
  } finally {
    cleanup(d);
  }
});

test("a frontmatter-less idea counts as undispositioned, not as dispositioned", () => {
  // Conservative direction: we cannot prove an unparseable file was handled,
  // and undercounting would let the gate pass on a backlog it can't see.
  const d = withIdeas([null, "graduated"]);
  try {
    assert.equal(countUndispositionedIdeas(d).count, 1);
  } finally {
    cleanup(d);
  }
});

test("a missing ideas dir counts zero rather than throwing", () => {
  const d = mkdtempSync(join(tmpdir(), "idea-backlog-empty-"));
  try {
    assert.deepEqual(countUndispositionedIdeas(d), { count: 0, total: 0 });
  } finally {
    cleanup(d);
  }
});

// --- config accessor ------------------------------------------------------

test("cap defaults to 12, honors the new key, and falls back to the legacy one", () => {
  const none = withIdeas([]);
  const fresh = withIdeas([], "  max_undispositioned_ideas: 40");
  const legacy = withIdeas([], "  max_ideas_per_sprint: 7");
  const both = withIdeas([], "  max_undispositioned_ideas: 40\n  max_ideas_per_sprint: 7");
  try {
    assert.equal(readMaxUndispositionedIdeas(none), 12);
    assert.equal(readMaxUndispositionedIdeas(fresh), 40);
    // Projects configured before the rename must keep working.
    assert.equal(readMaxUndispositionedIdeas(legacy), 7);
    // The accurate key wins when a project has migrated but left the old line.
    assert.equal(readMaxUndispositionedIdeas(both), 40);
  } finally {
    [none, fresh, legacy, both].forEach(cleanup);
  }
});

test("a non-positive or malformed cap disables the gate", () => {
  const zero = withIdeas([], "  max_undispositioned_ideas: 0");
  const junk = withIdeas([], "  max_undispositioned_ideas: banana");
  try {
    assert.equal(readMaxUndispositionedIdeas(zero), Infinity);
    assert.equal(readMaxUndispositionedIdeas(junk), Infinity);
    assert.equal(checkIdeaBacklog(zero, [], Infinity).allowed, true);
  } finally {
    [zero, junk].forEach(cleanup);
  }
});

// --- the gate -------------------------------------------------------------

test("at the cap is allowed; over the cap refuses with an actionable reason", () => {
  const d = withIdeas(["captured", "captured", "captured"]);
  try {
    assert.equal(checkIdeaBacklog(d, [], 3).allowed, true, "count == cap is not over cap");
    const refused = checkIdeaBacklog(d, [], 2);
    assert.equal(refused.allowed, false);
    assert.equal(refused.over_cap, true);
    assert.match(refused.reason, /ship-backlog/, "must name the grooming path");
    assert.match(refused.reason, /idea_backlog_accepted count=3/, "must name the escape hatch with the count");
  } finally {
    cleanup(d);
  }
});

test("acceptance covers the count it recorded and everything below it", () => {
  const d = withIdeas(["captured", "captured", "captured"]);
  try {
    const accept3 = [{ type: "idea_backlog_accepted", count: 3 }];
    const accept5 = [{ type: "idea_backlog_accepted", count: 5 }];
    assert.equal(checkIdeaBacklog(d, accept3, 1).allowed, true, "exact count is covered");
    assert.equal(checkIdeaBacklog(d, accept5, 1).allowed, true, "a higher acceptance still covers");
  } finally {
    cleanup(d);
  }
});

test("acceptance stops covering once the backlog grows past it", () => {
  // The whole point of size-scoping: one acknowledgement must not be a
  // permanent bypass on an append-only, project-wide event log.
  const d = withIdeas(["captured", "captured", "captured", "captured"]);
  try {
    const stale = [{ type: "idea_backlog_accepted", count: 3 }];
    const r = checkIdeaBacklog(d, stale, 1);
    assert.equal(r.allowed, false);
    assert.equal(r.accepted_at, 3);
    assert.match(r.reason, /grown past it/);
  } finally {
    cleanup(d);
  }
});

test("a malformed acceptance event does not disable the gate", () => {
  const d = withIdeas(["captured", "captured"]);
  try {
    for (const ev of [{ type: "idea_backlog_accepted" }, { type: "idea_backlog_accepted", count: "lots" }]) {
      assert.equal(checkIdeaBacklog(d, [ev], 1).allowed, false, JSON.stringify(ev));
    }
  } finally {
    cleanup(d);
  }
});

// --- CLI contract ---------------------------------------------------------

test("next-id ideas ALLOCATES over cap and only warns (the regression that lost findings)", () => {
  const d = withIdeas(["captured", "captured", "captured"], "  max_undispositioned_ideas: 1");
  try {
    const res = execFileSync(process.execPath, [BIN, "next-id", "ideas", "--data-dir", d], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // stdout must still be a usable id — this is the contract builders depend on.
    assert.match(res.trim(), /^\d{3}$/, "an id must be returned even far over cap");
  } catch (err) {
    assert.fail(`next-id ideas must never exit non-zero on a full backlog: ${err.message}`);
  } finally {
    cleanup(d);
  }
});

test("check-idea-backlog exits 3 over cap and 0 once groomed under it", () => {
  const over = withIdeas(["captured", "captured", "captured"], "  max_undispositioned_ideas: 1");
  const under = withIdeas(["captured", "graduated", "rejected"], "  max_undispositioned_ideas: 1");
  try {
    let code = 0;
    try {
      execFileSync(process.execPath, [BIN, "check-idea-backlog", "--data-dir", over], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      code = err.status;
    }
    assert.equal(code, 3, "over cap must be a gate refusal, not a warning");

    const ok = execFileSync(process.execPath, [BIN, "check-idea-backlog", "--data-dir", under, "--json"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(ok);
    assert.equal(parsed.allowed, true);
    assert.equal(parsed.count, 1, "grooming to graduated/rejected clears the gate");
  } finally {
    [over, under].forEach(cleanup);
  }
});
