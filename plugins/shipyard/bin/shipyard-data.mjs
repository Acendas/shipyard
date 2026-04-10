#!/usr/bin/env node
/**
 * shipyard-data — resolve and manage the per-project Shipyard data directory.
 *
 * Cross-platform Node implementation. Replaces the legacy extensionless Python
 * script which could not run on Windows (no shebang support, extensionless
 * files not in PATHEXT). Skills invoke this as a bare command — PATH lookup
 * finds `shipyard-data` (sh shim) on Unix and `shipyard-data.cmd` on Windows.
 *
 * Usage:
 *   shipyard-data              → prints data directory path
 *   shipyard-data init         → creates the directory tree if missing
 *   shipyard-data project-id   → prints just the project hash
 *   shipyard-data project-root → prints the parent repo root
 *
 * The init subcommand also handles the cp -r / rm -rf cleanup that
 * ship-init's SKILL.md used to inline as POSIX shell commands. Doing it
 * here keeps skill bodies portable.
 */

import { execFileSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENTS_LOG_NAME, logEvent, withLockfile } from "./_hook_lib.mjs";
import { getDataDir, getProjectHash, getProjectRoot, ShipyardResolverError } from "./shipyard-resolver.mjs";

// Shared Int32Array used by Atomics.wait for a true synchronous sleep in
// withLock's poll loop. Never notified — always waits the full timeout.
const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));

/**
 * R13: Check whether a pid corresponds to a living process.
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
  // This replaces the `cp -r .shipyard/* "$(shipyard-data)/"` line in the
  // legacy ship-init skill body, which was POSIX-shell-only.
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
 * Migrate from a legacy in-project .shipyard/ directory to the plugin data
 * dir. Replaces the cp -r / rm -rf / rm -f sequence that ship-init's SKILL.md
 * used to inline as POSIX shell commands. Idempotent.
 *
 * Steps:
 *  1. Ensure data dir tree exists
 *  2. Copy <src>/* into data dir (skipping ./scripts which is plugin-served now)
 *  3. Remove transient state files (.loop-state.json etc.)
 *  4. Print the data dir path
 */
/**
 * Inspect a data dir for non-empty content. Returns a list of {name, count}
 * entries describing what's there. Ignores the .locks/ dir and the
 * .pre-migrate-backup-* dirs (those are bookkeeping, not user data).
 */
function describeExistingData(dataDir) {
  if (!existsSync(dataDir)) return [];
  const entries = [];
  for (const name of readdirSync(dataDir)) {
    if (name === ".locks") continue;
    if (name.startsWith(".pre-migrate-backup-")) continue;
    const full = join(dataDir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      let inner;
      try { inner = readdirSync(full); } catch { inner = []; }
      if (inner.length > 0) entries.push({ name: name + "/", count: inner.length });
    } else if (st.isFile() && st.size > 0) {
      // .project-root with content counts as "this dir is populated"
      entries.push({ name, count: 1 });
    }
  }
  return entries;
}

function migrate(src, opts = {}) {
  if (!src) {
    process.stderr.write("shipyard-data migrate: missing source path\n");
    process.exit(1);
  }
  if (!existsSync(src)) {
    process.stderr.write(`shipyard-data migrate: source not found: ${src}\n`);
    process.exit(1);
  }
  const projectRoot = getProjectRoot();
  const dataDir = getDataDir({ projectRoot, silent: true });

  // Safety guard: refuse to overwrite a populated destination unless --force.
  // cpSync(force: true) silently overwrites — running migrate against the
  // wrong source dir, or re-running after the user added work, would lose
  // state. Inspect the dataDir for any non-empty subdirs or files first.
  const existing = describeExistingData(dataDir);
  if (existing.length > 0) {
    if (!opts.force) {
      process.stderr.write(
        `shipyard-data migrate: refusing — destination not empty: ${dataDir}\n` +
          `  Found existing data:\n` +
          existing.map((e) => `    ${e.name} (${e.count} entries)`).join("\n") +
          "\n" +
          `  Re-run with --force to overwrite. Existing data will be backed up to\n` +
          `  ${dataDir}/.pre-migrate-backup-<timestamp>/\n`,
      );
      process.exit(1);
    }
    // --force path: snapshot the existing data dir into a timestamped backup
    // before we overwrite anything. Excludes .locks/ and any prior backup
    // dirs so we don't recursively snapshot snapshots.
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace(/Z$/, "");
    const backupDir = join(dataDir, `.pre-migrate-backup-${ts}`);
    mkdirSync(backupDir, { recursive: true });
    for (const name of readdirSync(dataDir)) {
      if (name === ".locks") continue;
      if (name.startsWith(".pre-migrate-backup-")) continue;
      cpSync(join(dataDir, name), join(backupDir, name), {
        recursive: true,
        force: true,
      });
    }
    process.stderr.write(
      `shipyard-data migrate: --force — backed up existing data to ${backupDir}\n`,
    );

    // R17: After backing up, remove the live data dir contents so the
    // migration is a true REPLACEMENT, not a merge layered on top of
    // leftover state. Without this, files in the dest that don't exist
    // in src would silently persist after migration — breaking the
    // user's "I just migrated, my dest is now src" mental model.
    // Excludes .locks/ (in-use lock files) and the backup we just made.
    for (const name of readdirSync(dataDir)) {
      if (name === ".locks") continue;
      if (name.startsWith(".pre-migrate-backup-")) continue;
      rmSync(join(dataDir, name), { recursive: true, force: true });
    }
  }

  ensureTree(dataDir);

  // Copy src/* into dataDir, skipping the legacy scripts/ subdir
  for (const entry of readdirSync(src)) {
    if (entry === "scripts") continue;
    const from = join(src, entry);
    const to = join(dataDir, entry);
    cpSync(from, to, { recursive: true, force: true });
  }

  // Remove transient state from prior sessions
  for (const f of [".loop-state.json", ".active-session.json", ".test-output.tmp"]) {
    rmSync(join(dataDir, f), { force: true });
  }
  // Remove any legacy scripts/ that snuck through
  rmSync(join(dataDir, "scripts"), { recursive: true, force: true });

  // R19: Overwrite .project-root with the CURRENT project root. The src may
  // have copied a stale .project-root recording its own (now-irrelevant)
  // path — common when migrating an orphaned plugin-data dir whose hash
  // belonged to a worktree path. Future find-orphans calls scan this file
  // to match data dirs to projects, so it must reflect the dest project,
  // not the src.
  writeFileSync(join(dataDir, ".project-root"), projectRoot + "\n");

  process.stdout.write(dataDir + "\n");
}

/**
 * Acquire an advisory lock keyed by name, run a child command, then release.
 * F12: building block for skills that need to serialize writes to shared
 * Shipyard data files (e.g. SPRINT.md updated by parallel waves).
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
      // Check for stale lock. R13: mtime alone is not enough — a long-
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
 * R18: Detect orphaned plugin-data dirs whose recorded .project-root matches
 * the current parent repo or any of its worktrees. This surfaces data that
 * would otherwise be silently abandoned across resolver semantics changes:
 *
 *   - R1/F5 (builder worktrees share parent hash): users whose previous
 *     sessions ran inside a worktree had data under the worktree-hash;
 *     after the fix the resolver returns the parent-repo-hash and ship-init
 *     sees an empty dir. The orphan lives at the old worktree-hash.
 *
 *   - User-worktree isolation (user-owned worktrees outside
 *     `<parent>/.claude/worktrees/` now get their OWN isolated hash instead
 *     of sharing the parent's): users whose previous sessions ran inside
 *     one of these worktrees had data under the parent-repo-hash and the
 *     new resolver now hashes the worktree-toplevel. The orphan lives at
 *     the old parent-repo-hash — same detection mechanism, mirror direction.
 *     Heads up when migrating: if two user-worktree sessions of the same
 *     repo co-mingled state under the parent-repo-hash, only ONE worktree
 *     can claim that data via /ship-init's migration prompt; the other must
 *     start fresh. There's no automatic way to de-interleave a shared dir.
 *
 * Detection is identical for both cases: enumerate all worktree paths of
 * the current parent repo via `git worktree list`, build a set of "claimed
 * paths" (parent + worktrees, all realpath'd), and flag any sibling
 * `projects/<hash>/` dir whose `.project-root` breadcrumb resolves into
 * that set.
 *
 * Output: one line per orphan, tab-separated: <orphan-data-dir>\t<recorded-root>
 * Exits 0 with no output when there's nothing to migrate.
 */
function hasUserData(dataDir) {
  if (existsSync(join(dataDir, "config.md"))) return true;
  const dirs = [
    "spec/features",
    "spec/epics",
    "spec/tasks",
    "spec/bugs",
    "backlog",
    "sprints/current",
  ];
  for (const d of dirs) {
    const p = join(dataDir, d);
    try {
      if (
        statSync(p).isDirectory() &&
        readdirSync(p).filter((n) => !n.startsWith(".")).length > 0
      ) {
        return true;
      }
    } catch {
      /* missing dir, skip */
    }
  }
  return false;
}

function realpathOrResolve(p) {
  try {
    return realpathSync(p);
  } catch {
    return pathResolve(p);
  }
}

function findOrphans() {
  let currentProjectRoot;
  let currentDataDir;
  try {
    currentProjectRoot = getProjectRoot();
    currentDataDir = getDataDir({ projectRoot: currentProjectRoot, silent: true });
  } catch {
    // No resolvable data dir → nothing to do
    return;
  }

  // Step 2: if the current data dir already has user data, don't suggest
  // a migration — we don't migrate over a populated dest.
  if (hasUserData(currentDataDir)) return;

  // Step 3: <plugin-data>/projects/ is the parent of the current data dir.
  const projectsDir = dirname(currentDataDir);
  if (!existsSync(projectsDir)) return;

  // Step 4: enumerate parent repo's worktrees via git worktree list --porcelain
  const worktreePaths = [];
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: currentProjectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        worktreePaths.push(line.slice("worktree ".length).trim());
      }
    }
  } catch {
    // Not a git repo or git missing — still check the current project root
    // against recorded paths below.
  }

  // Step 5: build claimedPaths set (realpath'd where possible)
  const claimedPaths = new Set();
  claimedPaths.add(realpathOrResolve(currentProjectRoot));
  for (const wp of worktreePaths) {
    claimedPaths.add(realpathOrResolve(wp));
  }

  // Step 6: scan sibling dirs under projectsDir
  const orphans = [];
  let entries;
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return;
  }
  for (const candidate of entries) {
    const candidatePath = join(projectsDir, candidate);
    if (candidatePath === currentDataDir) continue;
    let st;
    try {
      st = statSync(candidatePath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const projectRootFile = join(candidatePath, ".project-root");
    if (!existsSync(projectRootFile)) continue;
    let recorded;
    try {
      recorded = readFileSync(projectRootFile, "utf8").trim();
    } catch {
      continue;
    }
    if (!recorded) continue;
    const recordedReal = realpathOrResolve(recorded);
    if (!claimedPaths.has(recordedReal)) continue;
    if (!hasUserData(candidatePath)) continue;
    orphans.push({ dataDir: candidatePath, recordedRoot: recorded });
  }

  // Step 7: output one line per orphan, tab-separated
  for (const o of orphans) {
    process.stdout.write(`${o.dataDir}\t${o.recordedRoot}\n`);
  }
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
 *      dir path ("suspicious path outside project root", issue #41763).
 *
 * Routing skills through this single entry point lets them use
 * `Bash(shipyard-data:*)` in allowed-tools and skip the prompt entirely.
 * Matches the same pattern enforced for migrations by the eval assertion
 * `uses_atomic_migrate_command`.
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
 * Safely delete an orphaned data directory after migration.
 *
 * Customer-facing destructive op: when the resolver semantics change (e.g.,
 * adding worktree-parent detection in commit 7554998), users' prior data
 * directories become orphaned at the old hash. `find-orphans` discovers
 * them; `drop-orphan` reaps them. Refuses to delete the current project's
 * data dir even if invoked with the matching hash — that would destroy
 * live state.
 *
 * Safety:
 *   1. Hash format strictly validated against `^[0-9a-f]{12}$` (no path
 *      traversal via argv).
 *   2. Refuse if the resolved candidate equals or is contained by the
 *      current data dir (handles symlink/case-insensitive FS edge cases
 *      that pure hash comparison would miss). Validator C7.
 *   3. Refuse if the candidate has no `.project-root` breadcrumb file —
 *      we never `rm -rf` arbitrary directories.
 *
 * Logged to .data-ops.log via the same breadcrumb format auto-approve-data
 * uses, so customers can grep `shipyard-context diagnose` output for the
 * deletion event.
 */
function dropOrphan(hash) {
  if (!hash) {
    process.stderr.write(
      "shipyard-data drop-orphan: missing project hash\n" +
      "  Usage: shipyard-data drop-orphan <12-hex-hash>\n"
    );
    process.exit(1);
  }
  if (!/^[0-9a-f]{12}$/.test(hash)) {
    process.stderr.write(
      `shipyard-data drop-orphan: invalid hash ${JSON.stringify(hash)}\n` +
      `  Expected: 12 lowercase hex characters (e.g., dbaa5569a9b3)\n`
    );
    process.exit(1);
  }

  let currentDataDir;
  try {
    currentDataDir = getDataDir({ silent: true });
  } catch {
    process.stderr.write(
      "shipyard-data drop-orphan: cannot resolve current data dir; aborting for safety\n"
    );
    process.exit(1);
  }

  const projectsDir = dirname(currentDataDir);
  const candidate = join(projectsDir, hash);
  if (!existsSync(candidate)) {
    process.stderr.write(
      `shipyard-data drop-orphan: no such directory: ${candidate}\n`
    );
    process.exit(1);
  }
  // C7: containment check via realpath equality / nesting, not hash equality.
  const candidateReal = realpathOrResolve(candidate);
  const currentReal = realpathOrResolve(currentDataDir);
  if (candidateReal === currentReal) {
    process.stderr.write(
      `shipyard-data drop-orphan: refusing to delete the current project's data dir\n` +
      `  current:   ${currentDataDir}\n` +
      `  requested: ${candidate}\n`
    );
    process.exit(1);
  }
  // Reject if either path nests inside the other (symlinked variants).
  const rel = pathRelative(currentReal, candidateReal);
  if (!rel || (!rel.startsWith("..") && rel !== "")) {
    process.stderr.write(
      `shipyard-data drop-orphan: refusing — candidate overlaps the current data dir via realpath\n` +
      `  current realpath:   ${currentReal}\n` +
      `  candidate realpath: ${candidateReal}\n`
    );
    process.exit(1);
  }

  const breadcrumb = join(candidate, ".project-root");
  if (!existsSync(breadcrumb)) {
    process.stderr.write(
      `shipyard-data drop-orphan: refusing — no .project-root breadcrumb at ${breadcrumb}\n` +
      `  This directory does not look like a Shipyard data dir.\n`
    );
    process.exit(1);
  }

  let recordedRoot = "";
  try { recordedRoot = readFileSync(breadcrumb, "utf8").trim(); } catch { /* ignore */ }

  rmSync(candidate, { recursive: true, force: false });

  // Best-effort breadcrumb log to the CURRENT data dir's .data-ops.log.
  // Errors are swallowed — diagnostics never break the command.
  try {
    const ts = new Date().toISOString();
    const line = `${ts} drop-orphan hash=${hash} recorded_root=${recordedRoot} candidate=${candidate}\n`;
    const logPath = join(currentDataDir, ".data-ops.log");
    let existing = "";
    try { existing = readFileSync(logPath, "utf8"); } catch { /* file may not exist */ }
    writeFileSync(logPath, existing + line);
  } catch { /* ignore */ }

  process.stdout.write(`Dropped orphan ${hash}\n`);
}

// Helper for dropOrphan's containment check. Node's path.relative on its own
// is sufficient because both inputs are pre-realpath'd.
function pathRelative(from, to) {
  // Lazy import via path.relative; we already imported `relative` would be
  // ideal but the file uses pathResolve elsewhere — keep the import surface
  // small by using a tiny manual implementation.
  if (from === to) return "";
  const fromParts = from.split(/[/\\]/);
  const toParts = to.split(/[/\\]/);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  if (i === 0) return null; // disjoint
  const up = fromParts.slice(i).map(() => "..");
  const down = toParts.slice(i);
  return [...up, ...down].join("/") || "";
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
function reapObsolete(args) {
  const dryRun = args.includes("--dry-run");
  let maxAgeDays = 30;
  const ageIdx = args.indexOf("--max-age-days");
  if (ageIdx >= 0 && ageIdx + 1 < args.length) {
    const n = parseInt(args[ageIdx + 1], 10);
    if (!Number.isNaN(n) && n >= 0) maxAgeDays = n;
  }
  const cutoffMs = Date.now() - maxAgeDays * 86400000;

  let dataDir;
  try {
    dataDir = getDataDir({ silent: true });
  } catch {
    process.stderr.write("shipyard-data reap-obsolete: cannot resolve data dir\n");
    process.exit(1);
  }
  const specDir = join(dataDir, "spec");
  if (!existsSync(specDir)) {
    process.stdout.write("Reaped 0 files (no spec dir)\n");
    return;
  }

  const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;
  const OBSOLETE_RE = /^obsolete:\s*true\s*$/m;
  const STATUS_RE = /^status:\s*(graduated|superseded|cancelled)\s*$/m;

  const matches = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!ent.name.endsWith(".md")) continue;
      let content;
      try { content = readFileSync(full, "utf8"); } catch { continue; }
      const fm = FRONTMATTER_RE.exec(content);
      if (!fm) continue;
      const block = fm[1];
      const hit = OBSOLETE_RE.test(block) || STATUS_RE.test(block);
      if (!hit) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.mtimeMs > cutoffMs) continue;
      matches.push(full);
    }
  };
  walk(specDir);

  if (dryRun) {
    for (const m of matches) process.stdout.write(`would-reap ${m}\n`);
    process.stdout.write(`Would reap ${matches.length} files (dry-run, max-age-days=${maxAgeDays})\n`);
    return;
  }

  let removed = 0;
  for (const m of matches) {
    try {
      rmSync(m, { force: false });
      removed++;
    } catch (err) {
      process.stderr.write(`shipyard-data reap-obsolete: failed to remove ${m}: ${err.message}\n`);
    }
  }

  // Best-effort breadcrumb log
  try {
    const ts = new Date().toISOString();
    const lines = matches.slice(0, removed).map((m) => `${ts} reap-obsolete file=${m}\n`).join("");
    if (lines) {
      const logPath = join(dataDir, ".data-ops.log");
      let existing = "";
      try { existing = readFileSync(logPath, "utf8"); } catch { /* ignore */ }
      writeFileSync(logPath, existing + lines);
    }
  } catch { /* ignore */ }

  process.stdout.write(`Reaped ${removed} obsolete files (max-age-days=${maxAgeDays})\n`);
}

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
  const logPath = join(dataDir, EVENTS_LOG_NAME);
  const sub = args[0] ?? "tail";

  function readAllEvents() {
    if (!existsSync(logPath)) return [];
    let raw;
    try {
      raw = readFileSync(logPath, "utf8");
    } catch (err) {
      process.stderr.write(`shipyard-data events: cannot read log: ${err.message}\n`);
      process.exit(1);
    }
    const out = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // Tolerate malformed lines (e.g., partial write recovered after a
        // crash). The events log is best-effort, not a database.
      }
    }
    return out;
  }

  function pretty(ev) {
    // Compact one-liner: "ts type k1=v1 k2=v2 ...". Quoted only if value
    // contains a space; otherwise bare for grep-friendliness.
    const parts = [ev.ts || "?", ev.type || "?"];
    for (const [k, v] of Object.entries(ev)) {
      if (k === "ts" || k === "type") continue;
      const s = typeof v === "string" ? v : JSON.stringify(v);
      const needsQuote = /\s/.test(s);
      parts.push(`${k}=${needsQuote ? JSON.stringify(s) : s}`);
    }
    return parts.join(" ");
  }

  function parseDuration(s) {
    // "1h", "30m", "2d", "45s" → ms
    const m = /^(\d+)([smhd])$/.exec(s);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const mul = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return n * mul;
  }

  switch (sub) {
    case "tail": {
      let n = 50;
      let asJson = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "-n" && args[i + 1]) {
          const v = parseInt(args[i + 1], 10);
          if (Number.isFinite(v) && v > 0) n = v;
          i++;
        } else if (args[i] === "--json") {
          asJson = true;
        }
      }
      const events = readAllEvents();
      const tail = events.slice(-n);
      for (const ev of tail) {
        process.stdout.write((asJson ? JSON.stringify(ev) : pretty(ev)) + "\n");
      }
      break;
    }
    case "grep": {
      const needle = args[1] || "";
      if (!needle) {
        process.stderr.write("shipyard-data events grep: <type-substring> is required\n");
        process.exit(1);
      }
      const events = readAllEvents();
      for (const ev of events) {
        if (typeof ev.type === "string" && ev.type.includes(needle)) {
          process.stdout.write(pretty(ev) + "\n");
        }
      }
      break;
    }
    case "since": {
      const arg = args[1] || "";
      if (!arg) {
        process.stderr.write("shipyard-data events since: <iso-or-duration> is required (e.g. '1h', '2026-04-07T17:00:00Z')\n");
        process.exit(1);
      }
      let cutoffMs;
      const dur = parseDuration(arg);
      if (dur !== null) {
        cutoffMs = Date.now() - dur;
      } else {
        const parsed = Date.parse(arg);
        if (Number.isNaN(parsed)) {
          process.stderr.write(`shipyard-data events since: cannot parse "${arg}" as ISO timestamp or duration (Ns/Nm/Nh/Nd)\n`);
          process.exit(1);
        }
        cutoffMs = parsed;
      }
      const events = readAllEvents();
      for (const ev of events) {
        const t = Date.parse(ev.ts);
        if (Number.isFinite(t) && t >= cutoffMs) {
          process.stdout.write(pretty(ev) + "\n");
        }
      }
      break;
    }
    case "json": {
      // Stream the raw JSONL — preserves the on-disk shape exactly so
      // pipelines like `shipyard-data events json | jq 'select(...)'`
      // work without re-parsing pretty output.
      if (!existsSync(logPath)) break;
      try {
        process.stdout.write(readFileSync(logPath, "utf8"));
      } catch (err) {
        process.stderr.write(`shipyard-data events json: cannot read log: ${err.message}\n`);
        process.exit(1);
      }
      break;
    }
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
    default:
      process.stderr.write(
        `shipyard-data events: unknown subcommand "${sub}". ` +
          `Expected: tail [-n N] [--json] | grep <substring> | since <iso|duration> | json | emit <type> [k=v ...]\n`,
      );
      process.exit(1);
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
    case "migrate": {
      // Parse `migrate <src> [--force]`. The flag may appear in either
      // position so users don't have to memorize ordering.
      const rest = process.argv.slice(3);
      const force = rest.includes("--force");
      const src = rest.find((a) => a !== "--force");
      migrate(src, { force });
      break;
    }
    case "with-lock":
      withLock(process.argv.slice(3));
      break;
    case "find-orphans":
      findOrphans();
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
    case "drop-orphan": {
      const hash = process.argv[3];
      dropOrphan(hash);
      break;
    }
    case "reap-obsolete": {
      reapObsolete(process.argv.slice(3));
      break;
    }
    case "events": {
      eventsCmd(process.argv.slice(3));
      break;
    }
    case "project-id":
      process.stdout.write(getProjectHash(getProjectRoot()) + "\n");
      break;
    case "project-root":
      process.stdout.write(getProjectRoot() + "\n");
      break;
    case "next-id": {
      nextIdCmd(process.argv.slice(3));
      break;
    }
    default:
      process.stderr.write(
        `shipyard-data: unknown command "${command}". ` +
          `Expected: (none) | init | migrate <src> [--force] | with-lock <key> -- <cmd> | find-orphans | archive-sprint <sprint-id> [--force] | drop-orphan <hash> | reap-obsolete [--dry-run] [--max-age-days N] | events <subcmd> | next-id <kind> | project-id | project-root\n`,
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
