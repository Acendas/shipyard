#!/usr/bin/env node
/**
 * shipyard-data — resolve and manage the per-project Shipyard data directory.
 *
 * Cross-platform Node implementation. Skills invoke this as a bare command —
 * PATH lookup finds `shipyard-data` (sh shim) on Unix and `shipyard-data.cmd`
 * on Windows.
 *
 * Usage:
 *   shipyard-data                              → prints data directory path
 *   shipyard-data init                         → creates the directory tree
 *   shipyard-data with-lock <key> -- <cmd>     → fcntl-style locking primitive
 *   shipyard-data archive-sprint <id> [--force]→ atomic sprint rename
 *   shipyard-data events emit <type> [k=v ...] → structured event log append
 *   shipyard-data next-id <kind>               → atomic ID allocator
 */

import { execFileSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvent, withLockfile } from "./_hook_lib.mjs";
import { getDataDir, getProjectRoot, ShipyardResolverError } from "./shipyard-resolver.mjs";

// Shared Int32Array used by Atomics.wait for a true synchronous sleep in
// withLock's poll loop. Never notified — always waits the full timeout.
const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));

/**
 * Check whether a pid corresponds to a living process.
 * `process.kill(pid, 0)` does not actually signal the process — it just
 * probes for existence. Throws ESRCH if the process is gone, EPERM if it
 * exists but is owned by a different user (treat as alive — we shouldn't
 * steal locks from processes we can't even introspect).
 *
 * Cross-platform: Node implements process.kill(pid, 0) on Windows too;
 * see https://nodejs.org/api/process.html#processkillpid-signal
 */
function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const SUBDIRS = [
  ["spec", "epics"],
  ["spec", "features"],
  ["spec", "tasks"],
  ["spec", "bugs"],
  ["spec", "ideas"],
  ["spec", "references"],
  ["backlog"],
  ["sprints", "current"],
  ["verify"],
  ["debug", "resolved"],
  ["memory"],
  ["releases"],
  ["templates"],
];

function ensureTree(dataDir) {
  for (const parts of SUBDIRS) {
    mkdirSync(join(dataDir, ...parts), { recursive: true });
  }
}

function init() {
  const projectRoot = getProjectRoot();
  const dataDir = getDataDir({ projectRoot, silent: true });
  ensureTree(dataDir);

  // Record which project this data belongs to (for debugging/cleanup)
  writeFileSync(join(dataDir, ".project-root"), projectRoot + "\n");

  // Copy project-files/templates into the data dir's templates/.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pluginRoot = dirname(__dirname);
  const templatesSrc = join(pluginRoot, "project-files", "templates");
  if (existsSync(templatesSrc)) {
    cpSync(templatesSrc, join(dataDir, "templates"), {
      recursive: true,
      force: true,
    });
  }

  // Remove transient state files left from prior sessions (idempotent)
  for (const f of [".loop-state.json", ".active-session.json", ".test-output.tmp"]) {
    rmSync(join(dataDir, f), { force: true });
  }
  // Remove legacy scripts/ dir if a previous ship-init copied scripts in
  // (now served from the plugin, not the data dir)
  rmSync(join(dataDir, "scripts"), { recursive: true, force: true });

  process.stdout.write(dataDir + "\n");
}

/**
 * Acquire an advisory lock keyed by name, run a child command, then release.
 * Building block for skills that serialize writes to shared Shipyard data
 * files (e.g. SPRINT.md updated by parallel waves).
 *
 * Lock file lives at $SHIPYARD_DATA/.locks/<key>.lock. We use exclusive
 * file creation (O_EXCL) for the lock — atomic on POSIX and Windows. If
 * the lock exists, we poll up to `timeoutMs` (default 30s).
 *
 * Stale locks (> 5 min old, e.g. from a crashed process) are forcibly
 * cleared on first contention so the system self-heals.
 *
 * Usage: shipyard-data with-lock <key> -- <command> [args...]
 * Exit code is the child's exit code; lock is always released.
 */
function withLock(args) {
  const sepIdx = args.indexOf("--");
  if (sepIdx < 0 || sepIdx === 0 || sepIdx === args.length - 1) {
    process.stderr.write(
      "shipyard-data with-lock: usage: with-lock <key> -- <command> [args...]\n",
    );
    process.exit(2);
  }
  const key = args.slice(0, sepIdx).join("-");
  const childArgs = args.slice(sepIdx + 1);
  // Sanitize key — only allow safe chars (rejects path traversal in lock name)
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) {
    process.stderr.write(
      `shipyard-data with-lock: invalid key "${key}" — must match [A-Za-z0-9._-]{1,128}\n`,
    );
    process.exit(2);
  }

  const dataDir = getDataDir({ silent: true });
  const locksDir = join(dataDir, ".locks");
  mkdirSync(locksDir, { recursive: true });
  const lockPath = join(locksDir, `${key}.lock`);

  const STALE_MS = 5 * 60 * 1000; // 5 minutes
  const TIMEOUT_MS = 30 * 1000;
  const POLL_MS = 100;
  const deadline = Date.now() + TIMEOUT_MS;

  let fd;
  while (true) {
    try {
      fd = openSync(lockPath, "wx"); // exclusive create; throws if exists
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Check for stale lock. mtime alone is not enough — a long-
      // running wave may legitimately hold the lock past STALE_MS. Read
      // the holder's pid out of the lock file and only steal it if the
      // process is gone. Unreadable lock files are treated as stale
      // (most likely a partial-write from a crash before pid was recorded).
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > STALE_MS) {
          let holderPid = 0;
          try {
            const content = readFileSync(lockPath, "utf8").trim();
            holderPid = parseInt(content, 10) || 0;
          } catch {
            // Unreadable — treat as stale
          }
          if (!isProcessAlive(holderPid)) {
            rmSync(lockPath, { force: true });
            continue;
          }
          // Holder is still alive — fall through to wait up to deadline.
        }
      } catch {
        // Stat failed — race with another holder, just retry
      }
      if (Date.now() >= deadline) {
        process.stderr.write(
          `shipyard-data with-lock: timeout waiting for ${key} after ${TIMEOUT_MS / 1000}s\n`,
        );
        process.exit(124); // matches GNU timeout convention
      }
      // Sleep — Atomics.wait gives us a true synchronous sleep at ~0% CPU.
      // We never notify on this view, so it always waits the full POLL_MS.
      // Replaces a busy spin-loop that pegged a core during contention.
      Atomics.wait(SLEEP_VIEW, 0, 0, POLL_MS);
    }
  }
  // Write our pid into the lock for diagnosability
  try {
    writeFileSync(lockPath, String(process.pid) + "\n");
  } catch { /* non-fatal */ }
  closeSync(fd);

  let exitCode = 0;
  try {
    execFileSync(childArgs[0], childArgs.slice(1), { stdio: "inherit" });
  } catch (err) {
    exitCode = err.status ?? 1;
  } finally {
    try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
  }
  process.exit(exitCode);
}

/**
 * Atomically archive the current sprint into sprints/<sprint-id>/.
 *
 * Renames $SHIPYARD_DATA/sprints/current → $SHIPYARD_DATA/sprints/<sprint-id>
 * and recreates an empty current/ for the next sprint. A single directory
 * rename is atomic on the same filesystem (rename(2) guarantee) — strictly
 * safer than the cp + rm bash sequence skills used to synthesize, which
 * was:
 *   a) not atomic (partial archive on crash)
 *   b) out of scope for the auto-approve-data PreToolUse hook (which only
 *      matches Edit/Write/NotebookEdit/MultiEdit — NOT Bash), so every
 *      invocation triggered a permission prompt against the plugin data
 *      dir path ("suspicious path outside project root").
 *
 * Routing skills through this single entry point lets them use
 * `Bash(shipyard-data:*)` in allowed-tools and skip the prompt entirely.
 *
 * Sprint ID is validated against a strict allowlist (sprint-NNN where NNN
 * is 3+ digits) to prevent path traversal via argv. refuse to overwrite
 * an existing archive dir unless --force is given, matching migrate's
 * safety contract.
 */
function archiveSprint(sprintId, opts = {}) {
  if (!sprintId) {
    process.stderr.write(
      "shipyard-data archive-sprint: missing sprint ID\n" +
      "  Usage: shipyard-data archive-sprint <sprint-id> [--force]\n" +
      "  Sprint ID must match: sprint-NNN (3+ digits)\n"
    );
    process.exit(1);
  }
  // Strict allowlist — rejects path traversal, absolute paths, and any
  // non-sprint identifier. Must match the pattern skills generate.
  if (!/^sprint-[0-9]{3,}$/.test(sprintId)) {
    process.stderr.write(
      `shipyard-data archive-sprint: invalid sprint ID ${JSON.stringify(sprintId)}\n` +
      `  Expected format: sprint-NNN (e.g. sprint-001, sprint-042)\n`
    );
    process.exit(1);
  }

  const dataDir = getDataDir({ silent: true });
  const sprintsDir = join(dataDir, "sprints");
  const currentDir = join(sprintsDir, "current");
  const archiveDir = join(sprintsDir, sprintId);

  if (!existsSync(currentDir)) {
    process.stderr.write(
      `shipyard-data archive-sprint: no current sprint to archive\n` +
      `  Expected: ${currentDir}\n`
    );
    process.exit(1);
  }

  if (existsSync(archiveDir)) {
    if (!opts.force) {
      process.stderr.write(
        `shipyard-data archive-sprint: refusing — archive destination already exists: ${archiveDir}\n` +
        `  Re-run with --force to overwrite (existing contents will be removed first).\n`
      );
      process.exit(1);
    }
    // --force path: remove the existing archive dir so the rename can
    // succeed. This is destructive; the operator asked for it explicitly.
    rmSync(archiveDir, { recursive: true, force: true });
  }

  mkdirSync(sprintsDir, { recursive: true });

  // Atomic single-syscall archive. Same-filesystem rename guarantees all
  // current/ contents land in the archive dir in one step — no partial
  // state on crash, no copy/delete race.
  renameSync(currentDir, archiveDir);

  // Recreate an empty current/ for the next sprint so skills that expect
  // the directory to exist (ship-sprint's Compaction Recovery checks for
  // SPRINT-DRAFT.md there) don't ENOENT on the first read after archive.
  mkdirSync(currentDir, { recursive: true });

  process.stdout.write(archiveDir + "\n");
}


/**
 * Reap markdown files marked obsolete or terminally-statused after retention.
 *
 * Soft-delete sentinels are written by skill bodies (Edit frontmatter to
 * `obsolete: true` or `status: graduated|superseded|cancelled`). This
 * subcommand physically removes them after `--max-age-days` (default 30).
 *
 * Scope: scans <SHIPYARD_DATA>/spec/ recursively for `.md` files only. Does
 * NOT scan JSON sentinel files (`.active-session.json`, `.compaction-count`,
 * `.loop-state.json`) because those are overwritten in place by the next
 * skill invocation and never accumulate (validator C6).
 *
 * Frontmatter parsing: a minimal regex scan for `^obsolete: true$` and
 * `^status: (graduated|superseded|cancelled)$` inside the leading `---` /
 * `---` block. Avoids a YAML dependency.
 *
 * Modes:
 *   --dry-run               → list matches, do not delete
 *   --max-age-days N        → override the default retention (30 days)
 *
 * Logged to .data-ops.log per file removed.
 */
/**
 * `shipyard-data events` — query and emit structured events from
 * `$SHIPYARD_DATA/.shipyard-events.jsonl`. The events log is the primary
 * cross-cutting diagnostic for bug reports — see `_hook_lib.mjs::logEvent`
 * for the schema and the writer side.
 *
 * Subcommands:
 *
 *   tail [-n N]               last N events (default 50), pretty-printed
 *   tail [-n N] --json        last N events as raw JSONL (for piping into jq)
 *   grep <type-substring>     events whose `type` field contains the substring
 *   since <iso|duration>      events at or after the given timestamp.
 *                             Duration form: "1h", "30m", "2d", "45s".
 *   json                      entire log as JSONL (rotated tail)
 *   emit <type> [k=v ...]     manually emit one event. Used by skill bodies
 *                             that want to record narrative events
 *                             (sprint_started, task_completed, etc.)
 *                             from a bash backtick. Values parse as JSON
 *                             where possible (numbers, true/false), else
 *                             plain strings.
 */
function eventsCmd(args) {
  const dataDir = getDataDir();
  const sub = args[0];

  // The events log is JSONL — query directly by reading
  // <SHIPYARD_DATA>/.shipyard-events.jsonl. `emit` is the only subcommand
  // because it's the append-with-lock path that hooks and skills need to
  // write structured events without racing.
  if (!sub || sub !== "emit") {
    process.stderr.write(
      `shipyard-data events: only 'emit' is supported.\n` +
      `  Read events directly: <SHIPYARD_DATA>/.shipyard-events.jsonl\n`
    );
    process.exit(1);
  }

  switch (sub) {
    case "emit": {
      const type = args[1];
      if (!type) {
        process.stderr.write("shipyard-data events emit: <type> is required\n");
        process.exit(1);
      }
      const fields = {};
      for (let i = 2; i < args.length; i++) {
        const a = args[i];
        const eq = a.indexOf("=");
        if (eq <= 0) continue;
        const k = a.slice(0, eq);
        const rawV = a.slice(eq + 1);
        // Try JSON-parse first (so "count=3" → number 3, "ok=true" → bool).
        // Fall back to plain string for everything else.
        let v;
        try {
          v = JSON.parse(rawV);
        } catch {
          v = rawV;
        }
        fields[k] = v;
      }
      logEvent(dataDir, type, fields);
      break;
    }
  }
}

/**
 * Allocate the next available ID for a given entity kind (currently: `ideas`,
 * `bugs`, `features`, `epics`, `tasks`).
 *
 * Problem this solves: parallel builders writing ideas (or any entity kind)
 * concurrently would all scan `spec/<kind>/` and see the same max, producing
 * colliding IDs and silently clobbering each other's work. The prior state
 * of the art was "generate next available IDEA-NNN" as prose in skill bodies
 * with no atomicity — a pre-existing latent race.
 *
 * The fix: a sequence file at `<SHIPYARD_DATA>/spec/<kind>/.id-seq` holding
 * the last-allocated integer. Allocation is serialized by `withLockfile`
 * (O_EXCL lockfile, cross-platform, already used by the event log and
 * breadcrumb writers). On first use (seq file missing), scan existing files
 * to seed the counter. On corruption (unreadable seq file), fall back to
 * scan + 1.
 *
 * Prefix table maps kind → ID prefix in filenames. Keep in sync with the
 * conventions in project-files/templates/ and the skills that create these
 * files.
 *
 * CLI:
 *   shipyard-data next-id ideas      → prints e.g. "042"
 *   shipyard-data next-id bugs       → prints next bug id
 *   shipyard-data next-id features   → etc.
 *
 * Output format is a zero-padded 3-digit string (matching the historical
 * NNN conventions), no trailing newline — callers that want newline use
 * `$(shipyard-data next-id ideas)` inside existing skill patterns OR read
 * directly. (Note: skill bodies must NOT shell-substitute `shipyard-data`
 * — they read the number from this CLI inside an agent or subprocess.)
 */
function nextIdCmd(args) {
  const kind = args[0];
  if (!kind) {
    process.stderr.write(
      `shipyard-data next-id: missing kind argument. Expected: ideas|bugs|features|epics|tasks\n`,
    );
    process.exit(1);
  }

  // Map kind → {dir, prefix}. The dir is relative to <SHIPYARD_DATA>.
  const KIND_TABLE = {
    ideas: { dir: join("spec", "ideas"), prefix: "IDEA-" },
    bugs: { dir: join("spec", "bugs"), prefix: "B-" },
    features: { dir: join("spec", "features"), prefix: "F" },
    epics: { dir: join("spec", "epics"), prefix: "E" },
    tasks: { dir: join("spec", "tasks"), prefix: "T" },
  };
  const entry = KIND_TABLE[kind];
  if (!entry) {
    process.stderr.write(
      `shipyard-data next-id: unknown kind "${kind}". Expected one of: ${Object.keys(KIND_TABLE).join("|")}\n`,
    );
    process.exit(1);
  }

  const dataDir = getDataDir();
  const kindDir = join(dataDir, entry.dir);
  // Ensure the entity directory exists. Fresh projects with no ideas/bugs/etc
  // land here on first allocation. mkdirSync is idempotent with recursive.
  mkdirSync(kindDir, { recursive: true });

  const seqPath = join(kindDir, ".id-seq");
  const lockPath = seqPath + ".lock";

  // Scan existing files to find the highest extant ID. Used as a fallback
  // when the seq file is missing or unreadable, AND as a safety floor — if
  // someone hand-creates an IDEA-999 file outside this allocator, we must
  // not hand out IDEA-500 on the next call. max(seq, scan) + 1 wins.
  function scanMax() {
    let max = 0;
    let entries;
    try {
      entries = readdirSync(kindDir);
    } catch {
      return 0;
    }
    // Match <prefix><digits> at the start of the filename. For prefixes
    // that end in `-` (IDEA-, B-) the separator is already in the prefix.
    // For bare-letter prefixes (F, E, T) we allow an optional separator.
    // Use a regex built from the prefix for safety.
    const escaped = entry.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escaped}0*(\\d+)`);
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const m = name.match(re);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }

  let allocated = null;
  withLockfile(lockPath, () => {
    let seq = 0;
    if (existsSync(seqPath)) {
      try {
        const raw = readFileSync(seqPath, "utf8").trim();
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 0) seq = parsed;
      } catch {
        // unreadable seq file — fall through to scan
      }
    }
    const scanned = scanMax();
    const base = Math.max(seq, scanned);
    const next = base + 1;
    // Atomic write: write to temp then rename. The lockfile serializes
    // callers, so concurrent writes to the seq file are impossible while
    // the lock is held, but we still want a rename to avoid half-written
    // files if the process is killed mid-write.
    const tmpPath = seqPath + ".tmp";
    writeFileSync(tmpPath, String(next), "utf8");
    renameSync(tmpPath, seqPath);
    allocated = next;
  });

  if (allocated === null) {
    // withLockfile fails open (runs fn anyway if it can't acquire). The
    // closure wrote `allocated`, so we should always have a value — if
    // not, something is very wrong.
    process.stderr.write(
      `shipyard-data next-id: allocation failed — lockfile unavailable and closure did not run. This is a bug.\n`,
    );
    process.exit(1);
  }

  // Zero-padded 3-digit output, matching historical NNN conventions.
  const padded = String(allocated).padStart(3, "0");
  process.stdout.write(padded + "\n");
}

function main() {
  const command = process.argv[2] ?? "";
  switch (command) {
    case "":
      process.stdout.write(getDataDir({ silent: true }) + "\n");
      break;
    case "init":
      init();
      break;
    case "with-lock":
      withLock(process.argv.slice(3));
      break;
    case "archive-sprint": {
      // Parse `archive-sprint <sprint-id> [--force]`. Flag may be in
      // either position.
      const rest = process.argv.slice(3);
      const force = rest.includes("--force");
      const sprintId = rest.find((a) => a !== "--force");
      archiveSprint(sprintId, { force });
      break;
    }
    case "events": {
      eventsCmd(process.argv.slice(3));
      break;
    }
    case "next-id": {
      nextIdCmd(process.argv.slice(3));
      break;
    }
    // For project-id / project-root use `node ${CLAUDE_PLUGIN_ROOT}/bin/shipyard-resolver.mjs project-hash|project-root`.
    default:
      process.stderr.write(
        `shipyard-data: unknown command "${command}". ` +
          `Expected: (none) | init | with-lock <key> -- <cmd> | archive-sprint <sprint-id> [--force] | events emit <type> [k=v ...] | next-id <kind>\n`,
      );
      process.exit(1);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ShipyardResolverError) {
    process.stderr.write(err.message);
    process.exit(1);
  }
  throw err;
}
