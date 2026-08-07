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
 *   shipyard-data init                         → ensures the data directory tree
 *   shipyard-data onboarding status|bootstrap  → setup/onboarding state
 *   shipyard-data with-lock <key> -- <cmd>     → fcntl-style locking primitive
 *   shipyard-data archive-sprint <id> [--force]→ atomic sprint rename
 *   shipyard-data metrics record-retro ...      → CLI-owned metrics update
 *   shipyard-data init-sprint <id> [--data-dir] → copy canonical templates into sprints/current/
 *   shipyard-data events emit <type> [k=v ...] → structured event log append
 *                             [--data-dir <path>]
 *   shipyard-data next-id <kind> [--data-dir]   → atomic ID allocator
 *   shipyard-data link-data-dir [--force]      → create <projectRoot>/.shipyard
 *                                                symlink (POSIX) or junction
 *                                                (Windows) → SHIPYARD_DATA
 *   shipyard-data clean-worktrees [--dry-run]  → remove merged/gone worktrees
 *                                 [--force]      under .claude/worktrees/
 *                                 [--all]
 *   shipyard-data ensure-worktree-baseref      → set worktree.baseRef="head" in
 *                                                <projectRoot>/.claude/settings.json
 *   shipyard-data doctor                       → read-only integrity scan for
 *                                                phantom/forked project dirs,
 *                                                nested projects/ dirs, and
 *                                                dangling patch tasks
 *   shipyard-data scan-stubs <base>..<head>    → diff scan for stub patterns
 *                            [--lang <x>]        (see anti-stub-scan/SKILL.md).
 *                            [--data-dir <path>] Exit 3 on unmarked HIGH finding.
 *                                                --data-dir affects only where
 *                                                the stub_scan_run event lands.
 *   shipyard-data task set-status <id> <status> → typed task frontmatter
 *                            [--data-dir <path>]   mutation; --data-dir skips
 *                                                   git-based resolution.
 *   shipyard-data draft obsolete-research       → typed checkpoint
 *   shipyard-data draft set-sprint-status ...      frontmatter mutation.
 *   shipyard-data task accept-return <id> ...     → accept a gate-passed
 *                                                   builder return: anchor
 *                                                   commit, emit terminal
 *                                                   return event, mark done.
 *   shipyard-data task accept-operational <id> ...→ accept a gate-passed
 *                                                   operational task: emit
 *                                                   evidence events, mark done.
 *   shipyard-data verify record --key <k>      → record a verification result
 *     --command <literal> --exit <n>              (see bin/verify-ledger.mjs)
 *     --capture <path>
 *   shipyard-data verify check --key <k>       → exit 0 = fresh (reusable),
 *     --command <literal> [--ttl-hours <n>]       exit 3 = stale (re-run it)
 *   shipyard-data review plan <findings.json>  → deterministic review finding
 *     [--out <path>]                              batches and validation waves
 *   shipyard-data queue <enqueue|claim|complete|fail|list|requeue-stale|retry-stale|park-stale>
 *                                                → durable flat-worker queue
 */

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvent, withLockfile } from "./_hook_lib.mjs";
import { dirLooksInitialized, ensureDataDirLink, getDataDir, getProjectRoot, ShipyardResolverError } from "./shipyard-resolver.mjs";
import { cursorCmd } from "./cursor-cli.mjs";
import { parseFrontmatter, parseWaves, readEvents } from "./terminal-gate.mjs";
import { specStateCmd } from "./spec-state-cli.mjs";
import { FEATURE_TRANSITIONS } from "./spec-lifecycle.mjs";
import { skillLockCmd } from "./skill-lock.mjs";
import { scanStubsCmd } from "./scan-stubs.mjs";
import { verifyCmd } from "./verify-ledger.mjs";
import { readinessCheckCmd } from "./readiness-check.mjs";
import { checkIdeaBacklogCmd, countUndispositionedIdeas } from "./idea-backlog.mjs";
import { bootstrapOnboarding, ensureInitializedDataDir, renderOnboardingLines } from "./init-data.mjs";
import { reviewPlanCmd } from "./review-plan.mjs";
import { queueCmd } from "./worker-queue.mjs";
import {
  readExecutionIsolation,
  normalizeIsolationToken,
  readMaxUndispositionedIdeas,
  readEnforceAcCoverage,
  readRefactorScope,
  readDispatchOrder,
  readMaxTasksPerWave,
  readMergeIndependentLayers,
  readMaxTasksPerWaveMerged,
} from "./config-read.mjs";

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

/**
 * Extract an optional `--data-dir <path>` flag from an args array, in either
 * position (same parsing style as `init-sprint`'s existing `--data-dir`).
 *
 * A builder subagent worktree can hash to a DIFFERENT project data dir than
 * the orchestrator when the orchestrator itself is running inside a user
 * worktree of the same repo (the resolver's builder-vs-user-worktree
 * classification splits on toplevel path, not on "same repo"). When the
 * orchestrator already knows its own SHIPYARD_DATA, passing it explicitly
 * lets the builder skip git-based re-resolution entirely, so it can never
 * land in the wrong data dir. Absent the flag, behavior is byte-identical
 * to the pre-existing resolver-based path.
 *
 * Validates the path is absolute, exists, and is a directory — a silently
 * wrong relative/missing path would defeat the whole point of the flag.
 * Returns { dataDir: string|undefined, rest: string[] } with the flag and
 * its value stripped from `rest`. Exits non-zero naming "--data-dir" on
 * invalid input.
 */
function extractDataDirFlag(args, commandName) {
  const idx = args.indexOf("--data-dir");
  if (idx === -1) return { dataDir: undefined, rest: args };
  const value = args[idx + 1];
  if (!value) {
    process.stderr.write(`shipyard-data ${commandName}: --data-dir requires a path argument\n`);
    process.exit(2);
  }
  if (!isAbsolute(value)) {
    process.stderr.write(`shipyard-data ${commandName}: --data-dir path must be absolute: ${value}\n`);
    process.exit(2);
  }
  if (!existsSync(value)) {
    process.stderr.write(`shipyard-data ${commandName}: --data-dir path does not exist: ${value}\n`);
    process.exit(2);
  }
  let stat;
  try {
    stat = statSync(value);
  } catch (err) {
    process.stderr.write(`shipyard-data ${commandName}: cannot stat --data-dir path ${value}: ${err.message}\n`);
    process.exit(2);
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`shipyard-data ${commandName}: --data-dir path is not a directory: ${value}\n`);
    process.exit(2);
  }
  const rest = args.slice(0, idx).concat(args.slice(idx + 2));
  return { dataDir: value, rest };
}

function init() {
  const dataDir = ensureInitializedDataDir({ resetLocks: true });
  process.stdout.write(dataDir + "\n");
}

function onboardingCmd(args) {
  const sub = args[0] ?? "status";
  if (sub === "status") {
    const dataDir = ensureInitializedDataDir();
    process.stdout.write(`SHIPYARD_DATA=${dataDir}\n`);
    renderOnboardingLines(dataDir, (line) => process.stdout.write(line + "\n"));
    return;
  }
  if (sub === "bootstrap") {
    const { dataDir } = bootstrapOnboarding();
    process.stdout.write(`SHIPYARD_DATA=${dataDir}\n`);
    renderOnboardingLines(dataDir, (line) => process.stdout.write(line + "\n"));
    return;
  }
  process.stderr.write(
    `shipyard-data onboarding: unknown subcommand "${sub}". Expected: status | bootstrap\n`,
  );
  process.exit(2);
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

  // Velocity is a cross-sprint input for `/ship-sprint` capacity planning.
  // Do this in the archive command, not in review/sprint prose, so every
  // successful archive path leaves the next sprint with the prior velocity.
  const velocityResult = recordSprintVelocity(dataDir, currentDir, sprintId);

  // Atomic single-syscall archive. Same-filesystem rename guarantees all
  // current/ contents land in the archive dir in one step — no partial
  // state on crash, no copy/delete race.
  renameSync(currentDir, archiveDir);

  // Recreate an empty current/ for the next sprint so skills that expect
  // the directory to exist (ship-sprint's Compaction Recovery checks for
  // SPRINT-DRAFT.md there) don't ENOENT on the first read after archive.
  mkdirSync(currentDir, { recursive: true });

  // P5 (fixes 3.3): archiveSprint previously renamed sprints/current/ only
  // — nothing archived the task files belonging to that sprint, so
  // spec/tasks/ grows unbounded (measured: 779 files and growing on the
  // customer workspace) and every O(product) scan over spec/ pays for it
  // forever. Move DONE task files for this sprint into spec/archive/tasks/;
  // best-effort — never fail the sprint archive itself over task cleanup.
  try {
    const taskArchiveResult = archiveSprintTasks(dataDir, archiveDir);
    if (taskArchiveResult.archived.length > 0) {
      logEvent(dataDir, "sprint_tasks_archived", {
        sprint: sprintId,
        count: taskArchiveResult.archived.length,
        tasks: taskArchiveResult.archived.join(","),
      });
    }
  } catch {
    /* best-effort — the sprint archive above already succeeded */
  }

  if (velocityResult.recorded) {
    try {
      logEvent(dataDir, "sprint_velocity_recorded", {
        sprint: sprintId,
        velocity: String(velocityResult.velocity),
        features: velocityResult.features.join(","),
      });
    } catch {
      /* best-effort */
    }
  }

  process.stdout.write(archiveDir + "\n");
}

function recordSprintVelocity(dataDir, currentDir, sprintId) {
  const sprintPath = join(currentDir, "SPRINT.md");
  if (!existsSync(sprintPath)) {
    return { recorded: false, velocity: 0, features: [], reason: "missing_sprint" };
  }

  const sprintContent = readFileSync(sprintPath, "utf8");
  const sprintFm = parseFrontmatter(sprintContent);
  if (String(sprintFm.status || "").trim().toLowerCase() !== "completed") {
    return { recorded: false, velocity: 0, features: [], reason: "not_completed" };
  }
  const featureIds = parseSprintFeatureIds(sprintFm.features);
  if (featureIds.length === 0) {
    return { recorded: false, velocity: 0, features: [], reason: "no_features" };
  }

  const delivered = [];
  for (const id of featureIds) {
    const featurePath = findFeatureFile(dataDir, id);
    if (!featurePath) continue;
    let featureFm;
    try {
      featureFm = parseFrontmatter(readFileSync(featurePath, "utf8"));
    } catch {
      continue;
    }
    const status = String(featureFm.status || "").trim().toLowerCase();
    if (!["done", "released", "completed"].includes(status)) continue;
    const points = Number.parseInt(String(featureFm.story_points || "0"), 10);
    if (!Number.isFinite(points) || points < 0) continue;
    delivered.push({ id, points });
  }

  const velocity = delivered.reduce((sum, f) => sum + f.points, 0);
  if (delivered.length === 0) {
    return { recorded: false, velocity, features: [], reason: "no_delivered_features" };
  }
  const state = loadMetricsState(dataDir);
  const existingRecent = state.velocity.recent.find((r) => r.sprint === sprintId);
  const alreadyRecorded = !!existingRecent;
  const record = {
    sprint: sprintId,
    points: velocity,
    features: delivered.map((f) => ({ id: f.id, points: f.points })),
    recorded_at: new Date().toISOString(),
  };
  updateMetricAggregate(state.velocity, velocity, existingRecent?.points);
  state.velocity.recent = state.velocity.recent.filter((r) => r.sprint !== sprintId);
  state.velocity.recent.push(record);
  state.velocity.recent = sortSprintRecords(state.velocity.recent).slice(-10);
  writeMetricsState(dataDir, state);
  return {
    recorded: !alreadyRecorded,
    velocity,
    features: delivered.map((f) => f.id),
    reason: alreadyRecorded ? "already_recorded_updated" : "recorded",
  };
}

function parseSprintFeatureIds(value) {
  if (!value) return [];
  return [...String(value).matchAll(/\bF\d+\b/g)].map((m) => m[0]);
}

function emptyMetricsState() {
  return {
    schema_version: 1,
    velocity: { all_time: { count: 0, total: 0, min: null, max: null, average: null }, recent: [] },
    throughput: { all_time: { count: 0, total: 0, min: null, max: null, average: null }, recent: [] },
    retro: { recent: [] },
  };
}

function normalizeMetricsState(raw) {
  const state = emptyMetricsState();
  if (!raw || typeof raw !== "object") return state;
  for (const key of ["velocity", "throughput"]) {
    const src = raw[key] && typeof raw[key] === "object" ? raw[key] : {};
    const all = src.all_time && typeof src.all_time === "object" ? src.all_time : src;
    state[key].all_time.count = Number.isFinite(Number(all.count)) ? Number(all.count) : 0;
    state[key].all_time.total = Number.isFinite(Number(all.total)) ? Number(all.total) : 0;
    state[key].all_time.min = all.min === null || all.min === undefined ? null : Number(all.min);
    state[key].all_time.max = all.max === null || all.max === undefined ? null : Number(all.max);
    state[key].all_time.average = all.average === null || all.average === undefined ? null : Number(all.average);
    state[key].recent = Array.isArray(src.recent) ? src.recent : [];
  }
  state.retro.recent = Array.isArray(raw.retro?.recent) ? raw.retro.recent : [];
  return state;
}

function loadMetricsState(dataDir) {
  const jsonPath = join(dataDir, "memory", "metrics.json");
  if (existsSync(jsonPath)) {
    try {
      return normalizeMetricsState(JSON.parse(readFileSync(jsonPath, "utf8")));
    } catch {
      return emptyMetricsState();
    }
  }
  return loadLegacyMetricsState(dataDir);
}

function loadLegacyMetricsState(dataDir) {
  const state = emptyMetricsState();
  const metricsPath = join(dataDir, "memory", "metrics.md");
  if (!existsSync(metricsPath)) return state;
  let content = "";
  try {
    content = readFileSync(metricsPath, "utf8");
  } catch {
    return state;
  }
  for (const line of content.split(/\r?\n/)) {
    const velocity = line.match(/\bVelocity:\s*(\d+)\s*pts\b/i);
    const sprint = line.match(/\b(sprint-\d{3,})\b/i);
    if (velocity && sprint) {
      state.velocity.recent.push({
        sprint: sprint[1].toLowerCase(),
        points: Number.parseInt(velocity[1], 10),
        features: parseFeatureSummary(line),
        recorded_at: null,
      });
    }
    const throughput = line.match(/\bThroughput:\s*([0-9]+(?:\.[0-9]+)?)\s*pts\/hr\b/i);
    if (throughput && sprint) {
      state.throughput.recent.push({
        sprint: sprint[1].toLowerCase(),
        points_per_hour: Number(throughput[1]),
        recorded_at: null,
      });
    }
  }
  state.velocity.recent = dedupeSprintRecords(sortSprintRecords(state.velocity.recent));
  state.throughput.recent = dedupeSprintRecords(sortSprintRecords(state.throughput.recent));
  recomputeAggregateFromRecent(state.velocity, "points");
  recomputeAggregateFromRecent(state.throughput, "points_per_hour");
  state.velocity.recent = state.velocity.recent.slice(-10);
  state.throughput.recent = state.throughput.recent.slice(-10);
  return state;
}

function parseFeatureSummary(line) {
  const m = line.match(/\bfeatures=([^#\n]+)/);
  if (!m) return [];
  return m[1].split(",").map((part) => {
    const [id, points] = part.trim().split(":");
    return { id, points: Number.parseInt(points, 10) || 0 };
  // Child/sub-feature ids (F071d) are legitimate — see FID_RE in
  // spec-state-cli.mjs. A plain /^F\d+$/ silently dropped them from every
  // sprint feature summary, so their story points vanished from metrics.
  }).filter((f) => /^F\d+[a-z]?$/.test(f.id));
}

function sortSprintRecords(records) {
  return [...records].sort((a, b) => sprintSortKey(a.sprint) - sprintSortKey(b.sprint));
}

function sprintSortKey(sprint) {
  const n = String(sprint || "").match(/sprint-(\d+)/i)?.[1];
  return n ? Number.parseInt(n, 10) : 0;
}

function dedupeSprintRecords(records) {
  const bySprint = new Map();
  for (const record of records) bySprint.set(record.sprint, record);
  return [...bySprint.values()];
}

function recomputeAggregateFromRecent(bucket, valueKey) {
  const values = bucket.recent
    .map((r) => Number(r[valueKey]))
    .filter((n) => Number.isFinite(n));
  bucket.all_time.count = values.length;
  bucket.all_time.total = roundMetric(values.reduce((sum, n) => sum + n, 0));
  bucket.all_time.min = values.length ? roundMetric(Math.min(...values)) : null;
  bucket.all_time.max = values.length ? roundMetric(Math.max(...values)) : null;
  bucket.all_time.average = values.length ? roundMetric(bucket.all_time.total / values.length) : null;
}

function updateMetricAggregate(bucket, value, replacingValue = undefined) {
  const n = roundMetric(Number(value));
  if (!Number.isFinite(n)) return;
  const all = bucket.all_time;
  if (Number.isFinite(Number(replacingValue))) {
    const previous = Number(replacingValue);
    all.total = roundMetric(all.total - previous + n);
    all.average = all.count > 0 ? roundMetric(all.total / all.count) : null;
    if (all.min === null || n < all.min) all.min = n;
    if (all.max === null || n > all.max) all.max = n;
    return;
  }
  all.count += 1;
  all.total = roundMetric(all.total + n);
  all.min = all.min === null ? n : Math.min(all.min, n);
  all.max = all.max === null ? n : Math.max(all.max, n);
  all.average = roundMetric(all.total / all.count);
}

function roundMetric(n) {
  return Math.round(n * 100) / 100;
}

function writeMetricsState(dataDir, state) {
  const metricsDir = join(dataDir, "memory");
  mkdirSync(metricsDir, { recursive: true });
  const normalized = normalizeMetricsState(state);
  normalized.velocity.recent = sortSprintRecords(normalized.velocity.recent).slice(-10);
  normalized.throughput.recent = sortSprintRecords(normalized.throughput.recent).slice(-10);
  normalized.retro.recent = sortSprintRecords(normalized.retro.recent).slice(-10);

  const jsonPath = join(metricsDir, "metrics.json");
  const jsonTmp = jsonPath + ".tmp";
  writeFileSync(jsonTmp, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  renameSync(jsonTmp, jsonPath);

  const mdPath = join(metricsDir, "metrics.md");
  const mdTmp = mdPath + ".tmp";
  writeFileSync(mdTmp, renderMetricsMarkdown(normalized), "utf8");
  renameSync(mdTmp, mdPath);
}

function renderMetricsMarkdown(state) {
  const lines = [
    "# Metrics",
    "",
    "Generated by `shipyard-data metrics` and `shipyard-data archive-sprint`. Do not edit by hand.",
    "",
    "## Summary",
  ];
  const velocityAll = state.velocity.all_time;
  const throughputAll = state.throughput.all_time;
  if (velocityAll.count > 0) {
    lines.push(`Velocity average: ${velocityAll.average} pts/sprint`);
    lines.push(`Velocity range: ${velocityAll.min}-${velocityAll.max} pts/sprint`);
    lines.push(`Velocity total: ${velocityAll.total} pts across ${velocityAll.count} sprint${velocityAll.count === 1 ? "" : "s"}`);
    lines.push(`Velocity records retained: ${state.velocity.recent.length} sprint${state.velocity.recent.length === 1 ? "" : "s"}`);
  } else {
    lines.push("Velocity: no completed sprints recorded");
  }
  if (throughputAll.count > 0) {
    lines.push(`Throughput average: ${throughputAll.average} pts/hr`);
    lines.push(`Throughput range: ${throughputAll.min}-${throughputAll.max} pts/hr`);
  }
  lines.push("", "## Recent Sprint Velocity");
  if (state.velocity.recent.length === 0) {
    lines.push("- none");
  } else {
    for (const r of sortSprintRecords(state.velocity.recent).slice().reverse()) {
      const features = Array.isArray(r.features) && r.features.length
        ? `; features=${r.features.map((f) => `${f.id}:${f.points}`).join(",")}`
        : "";
      lines.push(`Velocity: ${r.points} pts  # ${r.sprint}${features}`);
    }
  }
  lines.push("", "## Recent Throughput");
  if (state.throughput.recent.length === 0) {
    lines.push("- none");
  } else {
    for (const r of sortSprintRecords(state.throughput.recent).slice().reverse()) {
      lines.push(`Throughput: ${r.points_per_hour} pts/hr  # ${r.sprint}`);
    }
  }
  if (state.retro.recent.length > 0) {
    lines.push("", "## Recent Retro Metrics");
    for (const r of sortSprintRecords(state.retro.recent).slice().reverse()) {
      const parts = [];
      for (const key of ["carry_over", "bug_rate", "estimate_accuracy", "flags"]) {
        if (r[key]) parts.push(`${key}=${r[key]}`);
      }
      lines.push(`- ${r.sprint}: ${parts.length ? parts.join("; ") : "recorded"}`);
    }
  }
  return lines.join("\n") + "\n";
}

function parseKvArgs(args, commandName) {
  const kv = {};
  for (const arg of args) {
    const idx = arg.indexOf("=");
    if (idx <= 0) {
      process.stderr.write(`shipyard-data ${commandName}: expected k=v argument, got ${JSON.stringify(arg)}\n`);
      process.exit(2);
    }
    kv[arg.slice(0, idx)] = arg.slice(idx + 1);
  }
  return kv;
}

function metricsCmd(args, opts = {}) {
  const sub = args[0];
  const dataDir = opts.dataDir ?? getDataDir({ silent: true });
  if (sub === "record-retro") {
    const kv = parseKvArgs(args.slice(1), "metrics record-retro");
    const sprint = kv.sprint;
    if (!/^sprint-\d{3,}$/.test(String(sprint || ""))) {
      process.stderr.write("shipyard-data metrics record-retro: sprint=<sprint-NNN> is required\n");
      process.exit(2);
    }
    const state = loadMetricsState(dataDir);
    const throughput = kv.throughput === undefined || kv.throughput === ""
      ? null
      : Number(kv.throughput);
    if (throughput !== null) {
      if (!Number.isFinite(throughput) || throughput < 0) {
        process.stderr.write("shipyard-data metrics record-retro: throughput must be a non-negative number\n");
        process.exit(2);
      }
      const existingRecent = state.throughput.recent.find((r) => r.sprint === sprint);
      updateMetricAggregate(state.throughput, throughput, existingRecent?.points_per_hour);
      state.throughput.recent = state.throughput.recent.filter((r) => r.sprint !== sprint);
      state.throughput.recent.push({
        sprint,
        points_per_hour: roundMetric(throughput),
        recorded_at: new Date().toISOString(),
      });
    }
    const retro = {
      sprint,
      carry_over: kv.carry_over || "",
      bug_rate: kv.bug_rate || "",
      estimate_accuracy: kv.estimate_accuracy || "",
      flags: kv.flags || "",
      recorded_at: new Date().toISOString(),
    };
    state.retro.recent = state.retro.recent.filter((r) => r.sprint !== sprint);
    state.retro.recent.push(retro);
    writeMetricsState(dataDir, state);
    try {
      logEvent(dataDir, "sprint_retro_metrics_recorded", { sprint });
    } catch { /* best-effort */ }
    process.stdout.write(`metrics recorded for ${sprint}\n`);
    return;
  }
  if (sub === "regenerate") {
    writeMetricsState(dataDir, loadMetricsState(dataDir));
    process.stdout.write(join(dataDir, "memory", "metrics.md") + "\n");
    return;
  }
  process.stderr.write(
    `shipyard-data metrics: unknown or missing subcommand ${JSON.stringify(sub)}. ` +
      `Expected: record-retro | regenerate\n`,
  );
  process.exit(2);
}

/**
 * Archive DONE task files belonging to a just-archived sprint into
 * spec/archive/tasks/. Reads the archived SPRINT.md's `### Wave N` bodies
 * (parseWaves — the same parser the terminal gate uses) to find which task
 * IDs belong to this sprint, then moves only the ones whose frontmatter
 * `status:` is the terminal `done` value. Non-terminal tasks (blocked,
 * needs-attention, in-progress, pending) are left in spec/tasks/ so they
 * stay visible for follow-up — archiving is a bounding measure for
 * completed history, not a place to lose open work.
 *
 * Read-only on SPRINT.md; the only mutation is renameSync per task file
 * (atomic, same filesystem). Never throws — a task file it can't read or
 * move is recorded as skipped and left in place.
 */
function archiveSprintTasks(dataDir, archiveDir) {
  const archived = [];
  const skipped = [];
  const sprintPath = join(archiveDir, "SPRINT.md");
  if (!existsSync(sprintPath)) return { archived, skipped };

  let content;
  try {
    content = readFileSync(sprintPath, "utf8");
  } catch {
    return { archived, skipped };
  }
  const waves = parseWaves(content);
  const taskIds = [...new Set(waves.flatMap((w) => w.tasks))];
  if (taskIds.length === 0) return { archived, skipped };

  const archiveTasksDir = join(dataDir, "spec", "archive", "tasks");

  for (const id of taskIds) {
    const filePath = findTaskFile(dataDir, id);
    if (!filePath) {
      skipped.push({ id, reason: "no task file found" });
      continue;
    }
    let taskContent;
    try {
      taskContent = readFileSync(filePath, "utf8");
    } catch (err) {
      skipped.push({ id, reason: `unreadable: ${err.message}` });
      continue;
    }
    const fm = parseFrontmatter(taskContent);
    if (fm.status !== "done") {
      skipped.push({ id, reason: `status=${fm.status || "(none)"}` });
      continue;
    }
    try {
      mkdirSync(archiveTasksDir, { recursive: true });
      const dest = join(archiveTasksDir, basename(filePath));
      renameSync(filePath, dest);
      archived.push(id);
    } catch (err) {
      skipped.push({ id, reason: `move failed: ${err.message}` });
    }
  }

  return { archived, skipped };
}


/**
 * Atomically create sprints/current/SPRINT.md and sprints/current/PROGRESS.md
 * from the canonical templates at <plugin-root>/project-files/templates/.
 *
 * Eliminates the schema-drift failure mode where /ship-sprint Step 11.1
 * told the model to "Use Write to create SPRINT.md and PROGRESS.md" with no
 * template-read instruction — the model improvised non-canonical schemas
 * (Tasks Completed lists, Wave Status tables) that drift from
 * project-files/templates/PROGRESS.md and trigger /ship-review drift alarms.
 *
 * Contract:
 *   - Substitutes `id:` and `created:` in SPRINT.md frontmatter only.
 *   - All other frontmatter fields (goal, capacity, branch, status, etc.)
 *     stay at template defaults; the model fills them via Edit after this
 *     runs.
 *   - PROGRESS.md is written byte-for-byte from the template (it has no
 *     id-specific fields — current_wave starts at 1, body sections empty).
 *   - Refuses to overwrite an existing SPRINT.md or PROGRESS.md (use
 *     archive-sprint first if you're starting a new sprint).
 *   - Strict sprint-id validation (`sprint-NNN` with NNN ≥ 3 digits) — same
 *     pattern archive-sprint enforces.
 */
function initSprint(sprintId, opts = {}) {
  if (!sprintId) {
    process.stderr.write(
      "shipyard-data init-sprint: missing sprint ID\n" +
      "  Usage: shipyard-data init-sprint <sprint-id> [--data-dir <path>]\n" +
      "  Sprint ID must match: sprint-NNN (3+ digits)\n"
    );
    process.exit(1);
  }
  if (!/^sprint-[0-9]{3,}$/.test(sprintId)) {
    process.stderr.write(
      `shipyard-data init-sprint: invalid sprint ID ${JSON.stringify(sprintId)}\n` +
      `  Expected format: sprint-NNN (e.g. sprint-001, sprint-042)\n`
    );
    process.exit(1);
  }

  let dataDir;
  if (opts.dataDir) {
    if (!existsSync(opts.dataDir)) {
      process.stderr.write(
        `shipyard-data init-sprint: --data-dir path does not exist: ${opts.dataDir}\n`
      );
      process.exit(1);
    }
    dataDir = opts.dataDir;
  } else {
    dataDir = getDataDir({ silent: true });
  }
  const currentDir = join(dataDir, "sprints", "current");
  mkdirSync(currentDir, { recursive: true });

  const sprintPath = join(currentDir, "SPRINT.md");
  const progressPath = join(currentDir, "PROGRESS.md");
  if (existsSync(sprintPath) || existsSync(progressPath)) {
    process.stderr.write(
      `shipyard-data init-sprint: sprints/current/ already contains SPRINT.md or PROGRESS.md.\n` +
      `  Refusing to overwrite. Archive the previous sprint first:\n` +
      `    shipyard-data archive-sprint <previous-sprint-id>\n`
    );
    process.exit(1);
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pluginRoot = dirname(__dirname);
  const templatesSrc = join(pluginRoot, "project-files", "templates");
  const sprintTemplate = readFileSync(join(templatesSrc, "SPRINT.md"), "utf8");
  const progressTemplate = readFileSync(join(templatesSrc, "PROGRESS.md"), "utf8");

  const isoDate = new Date().toISOString().slice(0, 10);
  const sprintContent = sprintTemplate
    .replace(/^id:\s*sprint-\d+\s*$/m, `id: ${sprintId}`)
    .replace(/^created:\s*null\s*$/m, `created: ${isoDate}`);

  // Atomic write via temp + rename. The lockfile pattern isn't needed here
  // because we already refused-on-exist above — a concurrent call would
  // race on existsSync, but the rename-into-place is itself atomic and the
  // second writer would clobber the first's content, not corrupt it.
  // For belt-and-braces atomicity, write tmp + rename anyway.
  const sprintTmp = sprintPath + ".tmp";
  const progressTmp = progressPath + ".tmp";
  writeFileSync(sprintTmp, sprintContent, "utf8");
  writeFileSync(progressTmp, progressTemplate, "utf8");
  renameSync(sprintTmp, sprintPath);
  renameSync(progressTmp, progressPath);

  process.stdout.write(currentDir + "\n");
}

/**
 * Reap markdown files marked obsolete or terminally-statused after retention.
 *
 * Soft-delete sentinels are written by skill bodies (Edit frontmatter to
 * `obsolete: true` or `status: graduated|superseded|cancelled`). This
 * subcommand physically removes them after `--max-age-days` (default 30).
 *
 * Scope: scans <SHIPYARD_DATA>/spec/ recursively for `.md` files only. Does
 * NOT scan JSON sentinel files (`.active-session.json`, `.compaction-count`)
 * because those are overwritten in place by the next skill invocation and
 * never accumulate (validator C6).
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
 * Clean up stale Shipyard worktrees whose branches have been merged or
 * whose remote tracking branch is gone.
 *
 * Enumerates `git worktree list` for `shipyard/wt-*` entries. For each:
 *   1. Check if the branch is already merged into the working branch
 *      (via `git merge-base --is-ancestor`).
 *   2. Check if the branch's remote tracking is `[gone]`.
 *   3. If merged or gone: `git worktree remove` + `git branch -d`.
 *   4. If unmerged with real commits: report but don't delete.
 *
 * Emits a structured event for each removal so the event log tracks
 * what was cleaned and why.
 *
 * Options:
 *   --dry-run    List what would be removed without removing
 *   --force      Also remove unmerged worktrees (destructive)
 *   --all        Clean ALL .claude/worktrees/* entries, not just shipyard/wt-*
 *
 * Usage: shipyard-data clean-worktrees [--dry-run] [--force] [--all]
 */


function cleanWorktrees(opts = {}) {
  const projectRoot = getProjectRoot();
  const worktreesDir = join(projectRoot, ".claude", "worktrees");

  if (!existsSync(worktreesDir)) {
    process.stdout.write("No .claude/worktrees/ directory found — nothing to clean.\n");
    return;
  }

  // Run git worktree prune first to clean stale admin metadata
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: projectRoot, stdio: "pipe" });
  } catch { /* non-fatal */ }

  // Parse `git worktree list --porcelain` for structured output
  let porcelainOutput;
  try {
    porcelainOutput = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    process.stderr.write(`clean-worktrees: failed to list worktrees: ${err.message}\n`);
    process.exit(1);
  }

  // Parse porcelain output into worktree entries
  const entries = [];
  let current = {};
  for (const line of porcelainOutput.split("\n")) {
    if (line === "") {
      if (current.worktree) entries.push(current);
      current = {};
      continue;
    }
    if (line.startsWith("worktree ")) current.worktree = line.slice(9);
    else if (line.startsWith("branch refs/heads/")) current.branch = line.slice(18);
    else if (line === "detached") current.detached = true;
    else if (line === "prunable") current.prunable = true;
  }
  if (current.worktree) entries.push(current);

  // Filter to shipyard worktrees (or all, with --all)
  const realWorktreesDir = (() => {
    try { return realpathSync(worktreesDir); } catch { return worktreesDir; }
  })();
  const candidates = entries.filter((e) => {
    if (!e.worktree || !e.branch) return false;
    // Must live under .claude/worktrees/
    const inClaudeWorktrees = e.worktree.startsWith(worktreesDir) ||
                              e.worktree.startsWith(realWorktreesDir);
    if (!inClaudeWorktrees) return false;
    if (opts.all) return true;
    return e.branch.startsWith("shipyard/wt-");
  });

  // Determine working branch
  let workingBranch;
  try {
    workingBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    workingBranch = "HEAD";
  }

  let removed = 0;
  let skipped = 0;
  const results = [];

  for (const entry of candidates) {
    const { worktree, branch } = entry;
    const shortPath = worktree.replace(projectRoot + "/", "");

    // Check if merged into working branch
    let isMerged = false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", branch, workingBranch], {
        cwd: projectRoot,
        stdio: "pipe",
      });
      isMerged = true;
    } catch {
      // exit code 1 = not ancestor = not merged
    }

    // Check if remote tracking branch is gone
    let isGone = false;
    try {
      const trackInfo = execFileSync(
        "git", ["for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`],
        { cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      isGone = trackInfo === "[gone]";
    } catch { /* no tracking info = local-only, fine */ }

    // Check for uncommitted changes
    let hasUncommitted = false;
    try {
      const status = execFileSync("git", ["-C", worktree, "status", "--porcelain"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      hasUncommitted = status.length > 0;
    } catch { /* can't check = assume dirty */ hasUncommitted = true; }

    const reason = isMerged ? "merged" : isGone ? "gone" : null;
    const canRemove = reason !== null || opts.force;

    if (!canRemove) {
      results.push({ shortPath, branch, action: "skip", reason: "unmerged" });
      skipped++;
      continue;
    }

    if (hasUncommitted && !opts.force) {
      results.push({ shortPath, branch, action: "skip", reason: "uncommitted changes" });
      skipped++;
      continue;
    }

    if (opts.dryRun) {
      results.push({ shortPath, branch, action: "would-remove", reason: reason ?? "force" });
      removed++;
      continue;
    }

    // Remove the worktree
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch {
      // Fallback: if git worktree remove fails, try manual cleanup
      try {
        rmSync(worktree, { recursive: true, force: true });
        execFileSync("git", ["worktree", "prune"], { cwd: projectRoot, stdio: "pipe" });
      } catch {
        results.push({ shortPath, branch, action: "error", reason: "remove failed" });
        skipped++;
        continue;
      }
    }

    // Delete the branch
    try {
      execFileSync("git", ["branch", "-D", branch], {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch { /* branch may already be gone */ }

    // Emit event for observability
    try {
      const dataDir = getDataDir({ silent: true });
      logEvent(dataDir, "worktree_cleaned", {
        branch,
        reason: reason ?? "force",
        path: shortPath,
      });
    } catch { /* non-fatal — don't fail cleanup because of event logging */ }

    results.push({ shortPath, branch, action: "removed", reason: reason ?? "force" });
    removed++;
  }

  // Also clean orphaned branches — shipyard/wt-* branches with no worktree
  const worktreeBranches = new Set(entries.map((e) => e.branch).filter(Boolean));
  let orphanedBranches;
  try {
    const branchOutput = execFileSync("git", ["branch", "--format=%(refname:short)"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    orphanedBranches = branchOutput.split("\n")
      .map((b) => b.trim())
      .filter((b) => {
        if (!b) return false;
        if (opts.all) return b.startsWith("worktree-");
        return b.startsWith("shipyard/wt-");
      })
      .filter((b) => !worktreeBranches.has(b));
  } catch { orphanedBranches = []; }

  for (const branch of orphanedBranches) {
    let isMerged = false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", branch, workingBranch], {
        cwd: projectRoot,
        stdio: "pipe",
      });
      isMerged = true;
    } catch { /* not merged */ }

    const canRemove = isMerged || opts.force;
    if (!canRemove) {
      results.push({ shortPath: "(no worktree)", branch, action: "skip", reason: "orphaned branch, unmerged" });
      skipped++;
      continue;
    }

    if (opts.dryRun) {
      results.push({ shortPath: "(no worktree)", branch, action: "would-remove", reason: "orphaned branch" + (isMerged ? ", merged" : "") });
      removed++;
      continue;
    }

    try {
      execFileSync("git", ["branch", "-D", branch], {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch {
      results.push({ shortPath: "(no worktree)", branch, action: "error", reason: "branch delete failed" });
      skipped++;
      continue;
    }

    try {
      const dataDir = getDataDir({ silent: true });
      logEvent(dataDir, "worktree_cleaned", { branch, reason: "orphaned_branch", merged: isMerged });
    } catch { /* non-fatal */ }

    results.push({ shortPath: "(no worktree)", branch, action: "removed", reason: "orphaned branch" + (isMerged ? ", merged" : "") });
    removed++;
  }

  // Report
  if (results.length === 0) {
    process.stdout.write("No stale worktrees or orphaned branches found.\n");
    return;
  }

  if (opts.dryRun) {
    process.stdout.write("DRY RUN — no changes made.\n\n");
  }

  for (const r of results) {
    const icon = r.action === "removed" ? "✓" :
                 r.action === "would-remove" ? "~" :
                 r.action === "skip" ? "·" : "✗";
    process.stdout.write(`  ${icon} ${r.branch} (${r.reason})\n`);
  }

  const verb = opts.dryRun ? "would remove" : "removed";
  process.stdout.write(`\n${removed} ${verb}, ${skipped} skipped.\n`);
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
function eventsCmd(args, opts = {}) {
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
      const dataDir = opts.dataDir || getDataDir();
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
 *   shipyard-data next-id <kind> [--data-dir <path>] → same, but skip
 *     git-based resolution and both allocate the counter AND acquire the
 *     advisory lock inside the given dir. Without this, a caller whose
 *     worktree resolves to a different data dir than another concurrent
 *     caller isn't actually serialized against it — both the counter file
 *     and its `.lock` live under the (wrong) resolved dir, so two parallel
 *     allocations can race and hand out the same id (observed live: two
 *     agents both allocated IDEA-149). Passing `--data-dir` pins both the
 *     counter and the lock to the same explicit directory for every caller
 *     that passes it, restoring the serialization guarantee.
 *
 * Output format is a zero-padded 3-digit string (matching the historical
 * NNN conventions), no trailing newline — callers that want newline use
 * `$(shipyard-data next-id ideas)` inside existing skill patterns OR read
 * directly. (Note: skill bodies must NOT shell-substitute `shipyard-data`
 * — they read the number from this CLI inside an agent or subprocess.)
 */
function nextIdCmd(args, { dataDir: dataDirOverride } = {}) {
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

  const dataDir = dataDirOverride ?? getDataDir();
  const kindDir = join(dataDir, entry.dir);
  // Ensure the entity directory exists. Fresh projects with no ideas/bugs/etc
  // land here on first allocation. mkdirSync is idempotent with recursive.
  mkdirSync(kindDir, { recursive: true });

  // Deferral-backlog WARNING (not a gate). This used to exit 3 once the
  // undispositioned backlog hit the cap, which made capture the failure point:
  // a builder that found something real got a refusal, had no sanctioned
  // override in its agent body, and wrote the finding somewhere unindexed
  // instead. An untidy backlog is a chore; a lost finding is gone. So
  // allocation now always succeeds and the cap is enforced at sprint-open
  // instead (`check-idea-backlog`), which is where an ungroomed backlog is
  // actually a decision to defer. Full rationale: bin/idea-backlog.mjs.
  if (kind === "ideas" && !args.includes("--force")) {
    const cap = readMaxUndispositionedIdeas(dataDir);
    if (Number.isFinite(cap)) {
      const { count } = countUndispositionedIdeas(dataDir);
      if (count >= cap) {
        process.stderr.write(
          `shipyard-data next-id ideas: WARNING — ${count} undispositioned idea(s) at/over cap ${cap}. ` +
            `Allocating anyway (capture is never blocked); /ship-sprint will refuse to open the next sprint ` +
            `until the backlog is groomed via /ship-backlog.\n`,
        );
      }
    }
  }

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
    // withLockfile throws (ELOCKTIMEOUT) if it can't acquire, so a timeout
    // never reaches here — it propagates out before this guard. The closure
    // always writes `allocated` on the success path, so a null here means the
    // closure ran without setting it: something is very wrong.
    process.stderr.write(
      `shipyard-data next-id: allocation failed — lockfile unavailable and closure did not run. This is a bug.\n`,
    );
    process.exit(1);
  }

  // Zero-padded 3-digit output, matching historical NNN conventions.
  const padded = String(allocated).padStart(3, "0");
  process.stdout.write(padded + "\n");
}

/**
 * Create (or repoint) a `<projectRoot>/.shipyard` symlink that points at the
 * resolved Shipyard data dir. Gives users a stable, in-project breadcrumb to
 * the otherwise-hidden plugin data area without committing machine-specific
 * paths to git.
 *
 * Cross-platform contract:
 *   - POSIX (macOS, Linux): regular directory symlink via symlinkSync(target, link, 'dir').
 *   - Windows: NTFS junction via symlinkSync(target, link, 'junction'). Junctions
 *     work without admin rights or Developer Mode (real symlinks on Windows
 *     require SeCreateSymbolicLinkPrivilege), only support directory targets
 *     (which is exactly what we want), and resolve transparently for both
 *     Node fs and Win32 file APIs. Same drive only — fine because
 *     CLAUDE_PLUGIN_DATA is always local.
 *
 * Idempotency:
 *   - No existing entry → create.
 *   - Existing symlink/junction pointing at the correct target → no-op.
 *   - Existing symlink/junction with wrong target → unlink + recreate.
 *   - Existing real file or directory → refuse unless --force (which deletes
 *     the entry first). Default-refuse protects accidentally-clobbering a
 *     user-created .shipyard/ directory holding real content.
 *
 * Stdout: the link path on success.
 */
function linkDataDir(opts = {}) {
  const projectRoot = getProjectRoot();
  const dataDir = pathResolve(getDataDir({ projectRoot, silent: true }));
  const linkPath = join(projectRoot, ".shipyard");

  // CLI-only policy for a real (non-symlink) entry: protect user content by
  // refusing unless --force. The shared writer (ensureDataDirLink) would just
  // report 'blocked' and leave it; the explicit CLI surfaces that as an error,
  // or clobbers it when the operator opts in. Symlink create/repoint/no-op is
  // delegated to the single writer so there's no second copy of the
  // junction-on-Windows logic to drift.
  let existing = null;
  try {
    existing = lstatSync(linkPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (existing && !existing.isSymbolicLink()) {
    if (opts.force) {
      rmSync(linkPath, { recursive: true, force: true });
    } else {
      process.stderr.write(
        `shipyard-data link-data-dir: refusing — ${linkPath} exists and is not a symlink/junction.\n` +
        `  Re-run with --force to replace it (destructive: removes the existing entry first).\n`
      );
      process.exit(1);
    }
  }

  const linked = ensureDataDirLink(projectRoot, dataDir);
  if (linked.status === "uninitialized") {
    // Explicit operator command — fail loud rather than silently no-op, so
    // "I ran link-data-dir and got nothing" is never a mystery.
    process.stderr.write(
      `shipyard-data link-data-dir: refusing — ${dataDir} was never initialized\n` +
      `  (no .project-root, config.md, or templates/). A data dir can appear from\n` +
      `  diagnostic logging alone; linking it would plant a .shipyard symlink in a\n` +
      `  project that has not completed CLI setup. Run shipyard-data onboarding bootstrap first.\n`
    );
    process.exit(1);
  }
  process.stdout.write(linkPath + "\n");
}

/**
 * Ensure <projectRoot>/.claude/settings.json has worktree.baseRef = "head".
 *
 * Why at execute, not one-time setup: settings drift; baseRef must hold
 * every sprint. A worktree that forks from origin/<default> (Claude Code's
 * "fresh" default) silently skips earlier waves' local commits. Verifying here
 * is self-healing — and a backstop for when our WorktreeCreate hook doesn't
 * fire (so native creation still bases on local HEAD, not origin/default).
 *
 * Why a CLI, not a model Edit: settings.json is structured JSON; an LLM-driven
 * Edit risks corrupting it (cf. the perl-glued frontmatter incident — a regex
 * substitution ate a newline and welded two YAML keys together). Atomic
 * read-merge-write preserves every other key and never half-writes.
 *
 * Idempotent: no-op (+ event) when already "head". Emits worktree_baseref_ensured.
 */
function ensureWorktreeBaseref() {
  const projectRoot = getProjectRoot();
  const claudeDir = join(projectRoot, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  let settings = {};
  if (existsSync(settingsPath)) {
    let raw;
    try {
      raw = readFileSync(settingsPath, "utf8");
    } catch (err) {
      process.stderr.write(`shipyard-data ensure-worktree-baseref: cannot read ${settingsPath}: ${err.message}\n`);
      process.exit(1);
    }
    try {
      settings = JSON.parse(raw);
    } catch (err) {
      process.stderr.write(
        `shipyard-data ensure-worktree-baseref: ${settingsPath} is not valid JSON (${err.message}) — refusing to overwrite.\n`,
      );
      process.exit(1);
    }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      process.stderr.write(
        `shipyard-data ensure-worktree-baseref: ${settingsPath} is not a JSON object — refusing to overwrite.\n`,
      );
      process.exit(1);
    }
  }

  const prevWorktree =
    settings.worktree && typeof settings.worktree === "object" && !Array.isArray(settings.worktree)
      ? settings.worktree
      : null;
  const was = prevWorktree ? prevWorktree.baseRef ?? null : null;

  if (was === "head") {
    try {
      logEvent(getDataDir({ projectRoot, silent: true }), "worktree_baseref_ensured", { was: "head", now: "head", changed: false });
    } catch { /* event is best-effort */ }
    process.stdout.write(`worktree.baseRef already "head" — ${settingsPath}\n`);
    return;
  }

  settings.worktree = { ...(prevWorktree ?? {}), baseRef: "head" };

  mkdirSync(claudeDir, { recursive: true });
  const out = JSON.stringify(settings, null, 2) + "\n";
  const tmp = settingsPath + ".tmp";
  writeFileSync(tmp, out, "utf8");
  renameSync(tmp, settingsPath);

  try {
    logEvent(getDataDir({ projectRoot, silent: true }), "worktree_baseref_ensured", { was, now: "head", changed: true });
  } catch { /* event is best-effort */ }
  process.stdout.write(`worktree.baseRef set to "head" (was: ${was ?? "unset"}) — ${settingsPath}\n`);
}

/**
 * Parse the flat `shared_caches:` map from config.md frontmatter — env var
 * name → absolute path. Comment lines (`#`) and empty/blank values are
 * ignored. Any read/parse failure or an absent block returns an empty map
 * (the safe no-op default), so projects initialized before this key existed
 * are unaffected. Deliberately hand-rolled to match the other config-block
 * scanners here rather than pulling in a YAML dep.
 */
function readSharedCachesConfig(dataDir) {
  const configPath = join(dataDir, "config.md");
  if (!existsSync(configPath)) return {};
  let content;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return {};
  }
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return {};
  const lines = fmMatch[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^shared_caches:\s*$/.test(l));
  if (start === -1) return {};
  const out = {};
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // left the block
    // Grab `KEY: <rest>` first, THEN decide how to read the value — so a
    // quoted value can legitimately contain a `#` or spaces (F6). Comment
    // stripping only applies to the unquoted form.
    const m = lines[i].match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let rest = m[2];
    let val;
    const q = rest[0];
    if (q === '"' || q === "'") {
      // Quoted: take everything up to the matching closing quote verbatim;
      // anything after it (e.g. a trailing comment) is ignored.
      const end = rest.indexOf(q, 1);
      val = end === -1 ? rest.slice(1) : rest.slice(1, end);
    } else {
      // Unquoted: a ` #...` tail is a comment; trim what remains.
      val = rest.replace(/\s+#.*$/, "").trim();
    }
    if (val) out[key] = val;
  }
  return out;
}

/**
 * Ensure <projectRoot>/.claude/settings.json `env` carries the configured
 * `shared_caches` entries so every builder — parent or worktree subagent —
 * inherits the same package-manager download cache. settings.json `env` is
 * the injection seam (structural, not model-authored prose); reusing the
 * same atomic read-merge-write as ensureWorktreeBaseref keeps every other
 * key intact.
 *
 * Only ABSOLUTE-path values are written; a relative value is refused with a
 * warning (a worktree-relative cache defeats the purpose). Values may use a
 * leading `~` or `${HOME}`/`$HOME`, expanded here so a config isn't nailed to
 * one machine's literal home path (F4).
 *
 * Reconciled, not additive (F2): the exact set of keys THIS command wrote last
 * time is tracked in a data-dir sidecar (`shared-caches-managed.json`). On each
 * run, keys previously written by us but no longer in config are REMOVED from
 * settings.json `env`; keys we never wrote (a user's own `env` entries) are
 * never touched — that's why we track ownership explicitly instead of pruning
 * by a name allowlist, which would clobber a hand-set var. Disabling the
 * feature (emptying `shared_caches`) therefore cleanly withdraws our injections.
 *
 * Idempotent: a run that changes nothing writes nothing (never creates an empty
 * settings.json). Emits shared_caches_ensured.
 */
function expandHomePath(p) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p.replace(/\$\{HOME\}/g, home).replace(/\$HOME\b/g, home);
}

function ensureSharedCaches() {
  const projectRoot = getProjectRoot();
  const dataDir = getDataDir({ projectRoot, silent: true });
  const caches = readSharedCachesConfig(dataDir);

  // Desired = configured entries, home-expanded and absolute-validated.
  const desired = {};
  for (const [k, rawV] of Object.entries(caches)) {
    const v = expandHomePath(rawV);
    if (!isAbsolute(v)) {
      process.stderr.write(`shipyard-data ensure-shared-caches: refusing "${k}=${rawV}" — value must resolve to an absolute path\n`);
      continue;
    }
    desired[k] = v;
  }

  // Keys we wrote on a previous run (ownership record for safe pruning).
  const managedPath = join(dataDir, "shared-caches-managed.json");
  let prevManaged = [];
  if (existsSync(managedPath)) {
    try {
      const parsed = JSON.parse(readFileSync(managedPath, "utf8"));
      if (Array.isArray(parsed)) prevManaged = parsed.filter((x) => typeof x === "string");
    } catch { /* malformed sidecar → treat as empty; we'll rewrite it */ }
  }

  const claudeDir = join(projectRoot, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const settingsExisted = existsSync(settingsPath);
  let settings = {};
  if (settingsExisted) {
    let raw;
    try {
      raw = readFileSync(settingsPath, "utf8");
    } catch (err) {
      process.stderr.write(`shipyard-data ensure-shared-caches: cannot read ${settingsPath}: ${err.message}\n`);
      process.exit(1);
    }
    try {
      settings = JSON.parse(raw);
    } catch (err) {
      process.stderr.write(
        `shipyard-data ensure-shared-caches: ${settingsPath} is not valid JSON (${err.message}) — refusing to overwrite.\n`,
      );
      process.exit(1);
    }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      process.stderr.write(
        `shipyard-data ensure-shared-caches: ${settingsPath} is not a JSON object — refusing to overwrite.\n`,
      );
      process.exit(1);
    }
  }

  const prevEnv =
    settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? settings.env : {};
  const nextEnv = { ...prevEnv };

  // Prune: only keys WE wrote last time and that are gone from config now.
  const removed = [];
  for (const k of prevManaged) {
    if (!(k in desired) && k in nextEnv) {
      delete nextEnv[k];
      removed.push(k);
    }
  }
  // Set desired.
  for (const [k, v] of Object.entries(desired)) nextEnv[k] = v;

  const desiredKeys = Object.keys(desired);
  const envChanged = JSON.stringify(prevEnv) !== JSON.stringify(nextEnv);
  const managedChanged = JSON.stringify(prevManaged.slice().sort()) !== JSON.stringify(desiredKeys.slice().sort());

  if (!envChanged && !managedChanged) {
    process.stdout.write(
      desiredKeys.length === 0
        ? "shared_caches: none configured — no-op\n"
        : `shared_caches: already up to date (${desiredKeys.length} env var(s))\n`,
    );
    return;
  }

  // Write settings.json only when env actually changed (avoid creating an
  // empty file just to record a no-op), but always keep the sidecar in sync.
  if (envChanged) {
    if (Object.keys(nextEnv).length > 0) {
      settings.env = nextEnv;
    } else {
      // Withdrew our last entries and nothing else lives in env — drop the key
      // rather than leave an empty object behind.
      delete settings.env;
    }
    mkdirSync(claudeDir, { recursive: true });
    const out = JSON.stringify(settings, null, 2) + "\n";
    const tmp = settingsPath + ".tmp";
    writeFileSync(tmp, out, "utf8");
    renameSync(tmp, settingsPath);
  }

  // Sidecar records exactly what we now own.
  const mtmp = managedPath + ".tmp";
  writeFileSync(mtmp, JSON.stringify(desiredKeys) + "\n", "utf8");
  renameSync(mtmp, managedPath);

  try {
    logEvent(dataDir, "shared_caches_ensured", { keys: desiredKeys.join(","), removed: removed.join(",") });
  } catch { /* event is best-effort */ }

  const parts = [];
  if (desiredKeys.length) parts.push(`wrote ${desiredKeys.length} (${desiredKeys.join(", ")})`);
  if (removed.length) parts.push(`removed ${removed.length} (${removed.join(", ")})`);
  process.stdout.write(`shared_caches: ${parts.join("; ") || "no change"} — ${settingsPath}\n`);
}

/**
 * `shipyard-data resolve-isolation [--flag <true|false|worktree|none|on|off>]`
 * — the single deterministic answer to "does this dispatch use worktree
 * isolation?". Precedence: `--flag` (this invocation) > `execution.isolation`
 * in config.md > default `worktree`. Prints exactly `worktree` or `none` to
 * stdout so a skill can capture it with `$(...)` and branch without
 * re-deriving the rule in prose (the prose-drift class the whole isolation
 * change exists to fix — resolution now has a CLI source of truth).
 *
 * An unrecognized `--flag` value is a hard error (exit 2), never a silent
 * fall-through to the default.
 */
function resolveIsolation(args) {
  let flagRaw = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--flag") {
      flagRaw = args[i + 1];
      i++;
    } else if (args[i].startsWith("--flag=")) {
      flagRaw = args[i].slice("--flag=".length);
    }
  }
  let resolved;
  if (flagRaw != null) {
    const norm = normalizeIsolationToken(flagRaw);
    if (norm === null) {
      process.stderr.write(
        `shipyard-data resolve-isolation: invalid --flag "${flagRaw}" — expected true|false|worktree|none|on|off\n`,
      );
      process.exit(2);
    }
    resolved = norm;
  } else {
    resolved = readExecutionIsolation(getDataDir({ silent: true }));
  }
  process.stdout.write(resolved + "\n");
}

/**
 * `shipyard-data resolve-refactor-scope` — prints exactly `sprint` or `wave`.
 *
 * Same reason `resolve-isolation` exists: the stage graph permits BOTH
 * `wave_gate → sprint_refactor` and `wave_gate → sprint_full_build`, so which
 * one a tick takes is a config read, and a config read the model performs by
 * eyeballing config.md text is the prose-drift class we keep paying for.
 */
function resolveRefactorScope() {
  process.stdout.write(readRefactorScope(getDataDir({ silent: true })) + "\n");
}

/**
 * `shipyard-data resolve-wave-caps` — prints the wave-width decision inputs as
 * one JSON object so `/ship-sprint` wave assignment reads them instead of
 * re-deriving defaults from config.md prose (and silently using the wrong
 * default when the key is absent).
 */
function resolveWaveCaps() {
  const dataDir = getDataDir({ silent: true });
  process.stdout.write(
    JSON.stringify({
      max_tasks_per_wave: readMaxTasksPerWave(dataDir),
      merge_independent_layers: readMergeIndependentLayers(dataDir),
      max_tasks_per_wave_merged: readMaxTasksPerWaveMerged(dataDir),
      dispatch_order: readDispatchOrder(dataDir),
    }) + "\n",
  );
}






// --- worktree-integration git helpers (anchor-commit + verify-wave-integrated) ---

function gitCapture(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

function gitIsAncestor(ancestor, descendant, cwd) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "pipe", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the `@AC-<n>` tags in a feature file's `## Acceptance Criteria`
 * section. Returns a sorted array of numeric ids (e.g. [1, 2, 3]). Empty if
 * the section is missing or untagged (→ advisory, never a hard fail).
 */
function parseFeatureAcIds(featurePath) {
  let content;
  try {
    content = readFileSync(featurePath, "utf8");
  } catch {
    return [];
  }
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Acceptance Criteria\s*$/i.test(l));
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const ids = new Set();
  for (let i = start; i < end; i++) {
    const re = /@AC-(\d+)\b/g;
    let m;
    while ((m = re.exec(lines[i])) !== null) ids.add(parseInt(m[1], 10));
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * `verify-ac-coverage --base <sha> --head <sha>` — deterministic backing for
 * sprint-complete invariant 4. For each feature linked to the current sprint,
 * every `@AC-<n>`-tagged acceptance criterion must have a matching `AC-<n>`
 * marker (`// AC-<n>`, `# AC-<n>`, or the `@AC-<n>` tag copied into a test)
 * somewhere in the sprint diff `base..head`. A tagged AC with no marker is an
 * ORPHAN. Features with NO tagged ACs are reported as advisory WARNINGs and
 * never fail the gate — that is the migration-safety valve: a project that has
 * not run `feature assign-ac-ids` is never false-blocked.
 *
 * Exit 0 = no orphans (warnings allowed). Exit 3 = one or more orphans AND
 * execution.enforce_ac_coverage is true. When enforcement is off, orphans are
 * printed but exit is 0 (advisory mode).
 */
function verifyAcCoverage(args) {
  const flagVal = (name) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
  };
  const base = flagVal("--base");
  const head = flagVal("--head") || "HEAD";
  if (!base) {
    process.stderr.write("shipyard-data verify-ac-coverage: --base <sha> is required (pass sprint_base_sha)\n");
    process.exit(2);
  }
  const projectRoot = getProjectRoot();
  const dataDir = getDataDir({ projectRoot, silent: true });

  // Sprint features from SPRINT.md frontmatter.
  const sprintPath = join(dataDir, "sprints", "current", "SPRINT.md");
  if (!existsSync(sprintPath)) {
    process.stderr.write(`shipyard-data verify-ac-coverage: no ${sprintPath}\n`);
    process.exit(2);
  }
  const sprintContent = readFileSync(sprintPath, "utf8");
  const fm = sprintContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const featuresLine = fm ? fm[1].match(/^features:\s*(.+)$/m) : null;
  const featureIds = featuresLine
    ? featuresLine[1].replace(/[[\]"']/g, "").split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  // Full sprint diff text (added + context lines) — markers may sit on either.
  const diff = gitCapture(["diff", `${base}..${head}`], projectRoot) || "";

  const featuresDir = join(dataDir, "spec", "features");
  const orphans = [];
  const warnings = [];
  let checkedFeatures = 0;

  for (const fid of featureIds) {
    // Resolve the feature file by <fid>-*.md prefix.
    let featurePath = null;
    try {
      const match = readdirSync(featuresDir).find((f) => f.startsWith(`${fid}-`) && f.endsWith(".md"));
      if (match) featurePath = join(featuresDir, match);
    } catch { /* no features dir */ }
    if (!featurePath) {
      warnings.push(`${fid}: feature file not found — skipped`);
      continue;
    }
    const acIds = parseFeatureAcIds(featurePath);
    if (acIds.length === 0) {
      warnings.push(`${fid}: no @AC-<n> tags — run \`shipyard-data feature assign-ac-ids ${fid}\` (advisory, not blocking)`);
      continue;
    }
    checkedFeatures += 1;
    for (const n of acIds) {
      const marker = new RegExp(`\\bAC-${n}\\b`);
      if (!marker.test(diff)) orphans.push(`${fid} AC-${n}`);
    }
  }

  for (const w of warnings) process.stdout.write(`WARN ${w}\n`);
  if (orphans.length === 0) {
    process.stdout.write(`verify-ac-coverage: OK — ${checkedFeatures} feature(s) with tagged ACs fully covered in ${base}..${head}\n`);
    process.exit(0);
  }

  process.stdout.write(`verify-ac-coverage: ${orphans.length} orphan AC(s) — no AC-<n> marker in ${base}..${head}:\n`);
  for (const o of orphans) process.stdout.write(`  - ${o}\n`);
  const enforce = readEnforceAcCoverage(dataDir);
  try {
    logEvent(dataDir, "ac_coverage_checked", { orphans: orphans.length, checked_features: checkedFeatures, enforce });
  } catch { /* best-effort */ }
  if (enforce) {
    process.stdout.write("Add `// AC-<n>` / `# AC-<n>` markers (or the @AC-<n> tag in a test) for each orphan, or set execution.enforce_ac_coverage: false for advisory mode.\n");
    process.exit(3);
  }
  process.stdout.write("(advisory mode: execution.enforce_ac_coverage is false — not blocking)\n");
  process.exit(0);
}

/**
 * Anchor a subagent's returned commit under a stable ref so it survives
 * worktree teardown, rebase, and Claude Code worktree-name collisions
 * (#51596). This is the insurance half of the wave-integration gate: once
 * anchored, the original SHA can never be GC'd or orphaned, independent of
 * whether `worktreeBranch` came back undefined.
 *
 * shipyard-data anchor-commit <task-id> <sha> [--data-dir <path>]
 *
 * `--data-dir` (optional) is used only for the best-effort event-log write
 * below — it never changes where the git ref itself is created, since that
 * always targets the resolved project root regardless of which data dir a
 * caller passes.
 */
function anchorCommit(taskId, sha, opts = {}) {
  if (!taskId || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(taskId)) {
    process.stderr.write(
      `shipyard-data anchor-commit: invalid task id ${JSON.stringify(taskId)} — expected [A-Za-z][A-Za-z0-9_-]{0,63}\n`,
    );
    process.exit(1);
  }
  if (!sha || !/^[0-9a-fA-F]{7,40}$/.test(sha)) {
    process.stderr.write(
      `shipyard-data anchor-commit: invalid sha ${JSON.stringify(sha)} — expected 7-40 hex chars\n`,
    );
    process.exit(1);
  }
  const projectRoot = getProjectRoot();
  if (gitCapture(["cat-file", "-e", `${sha}^{commit}`], projectRoot) === null) {
    process.stderr.write(`shipyard-data anchor-commit: commit ${sha} not found in repo at ${projectRoot}\n`);
    process.exit(1);
  }
  const ref = `shipyard/keep-${taskId}`;
  if (gitCapture(["branch", "-f", ref, sha], projectRoot) === null) {
    process.stderr.write(`shipyard-data anchor-commit: failed to create anchor ref ${ref} -> ${sha}\n`);
    process.exit(1);
  }
  try {
    logEvent(opts.dataDir || getDataDir({ projectRoot, silent: true }), "task_commit_anchored", { task: taskId, sha, ref });
  } catch { /* event is best-effort */ }
  process.stdout.write(`${ref} -> ${sha}\n`);
}

/**
 * Wave-integration gate. Before a wave's worktrees are torn down, prove two
 * invariants over ground truth (git + the structured return contract), never
 * the unreliable `worktreeBranch` field:
 *
 *   A. every live shipyard/wt-* worktree branch is merged into the working
 *      branch — no un-integrated worktree left to be reaped; AND
 *   B. every COMPLETE subagent return commit is reachable from the working
 *      branch, a live worktree branch, or a shipyard/keep-* anchor — no
 *      dangling/orphaned task commit (the v2.8 incident symptom: 6 task
 *      commits left dangling after the orchestrator tore down worktrees
 *      without merging, because it read worktreeBranch=undefined).
 *
 * Emits wave_integration_verified on pass (exit 0) or wave_integration_failed
 * (exit 3, with the offending branches/tasks). Read-only except for the event,
 * so it is safe to run repeatedly.
 *
 * shipyard-data verify-wave-integrated
 */
function verifyWaveIntegrated() {
  const projectRoot = getProjectRoot();
  const dataDir = getDataDir({ projectRoot, silent: true });
  const workingBranch = gitCapture(["rev-parse", "--abbrev-ref", "HEAD"], projectRoot) || "HEAD";

  // Live worktree branches (prefix shipyard/wt-) from porcelain ground truth.
  const porcelain = gitCapture(["worktree", "list", "--porcelain"], projectRoot) || "";
  const wtBranches = [];
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("branch refs/heads/")) {
      const b = line.slice("branch refs/heads/".length);
      if (b.startsWith("shipyard/wt-")) wtBranches.push(b);
    }
  }

  // Anchor refs created by anchor-commit on return.
  const keepRaw = gitCapture(["branch", "--list", "shipyard/keep-*", "--format=%(refname:short)"], projectRoot) || "";
  const keepRefs = keepRaw.split("\n").map((s) => s.trim()).filter(Boolean);

  // Check A — every worktree branch merged into working.
  const unintegrated = wtBranches.filter((b) => !gitIsAncestor(b, workingBranch, projectRoot));

  // Parse COMPLETE returns from the structured return contract.
  const returnsDir = join(dataDir, "sprints", "current", ".subagent-returns");
  const returns = [];
  if (existsSync(returnsDir)) {
    const seenJson = new Set();
    for (const name of readdirSync(returnsDir)) {
      // v2.9.0+: structured JSON written by `shipyard-data task-return`.
      if (name.endsWith(".json")) {
        let rec;
        try {
          rec = JSON.parse(readFileSync(join(returnsDir, name), "utf8"));
        } catch {
          continue;
        }
        const task = rec.task || name.replace(/\.json$/, "");
        seenJson.add(task);
        returns.push({
          task,
          status: String(rec.status || "").toUpperCase(),
          sha: /^[0-9a-fA-F]{7,40}$/.test(rec.commit_sha || "") ? rec.commit_sha : "",
        });
      }
    }
    for (const name of readdirSync(returnsDir)) {
      // Legacy pre-2.9 model-written text contract; JSON wins on collision.
      if (!name.endsWith(".txt")) continue;
      // The v2.9 builder writes `<task>.probe-tail.txt` (raw probe output
      // fed to task-return) into the same dir — probe output that echoes
      // STATUS:/COMMIT: tokens must not become a phantom Check-B return.
      if (name.endsWith(".probe-tail.txt")) continue;
      const task = name.replace(/\.txt$/, "");
      if (seenJson.has(task)) continue;
      let content;
      try {
        content = readFileSync(join(returnsDir, name), "utf8");
      } catch {
        continue;
      }
      const status = (content.match(/^STATUS:\s*(\S+)/m) || [])[1] || "";
      const sha = (content.match(/^COMMIT:\s*([0-9a-fA-F]{7,40})/m) || [])[1] || "";
      returns.push({ task, status: status.toUpperCase(), sha });
    }
  }

  // Check B — every COMPLETE return sha reachable from something tracked.
  const reachableFrom = [workingBranch, ...wtBranches, ...keepRefs];
  const dangling = [];
  for (const r of returns) {
    if (r.status !== "COMPLETE" || !r.sha) continue;
    const ok = reachableFrom.some((ref) => gitIsAncestor(r.sha, ref, projectRoot));
    if (!ok) dangling.push(r);
  }

  const checked = returns.filter((r) => r.status === "COMPLETE" && r.sha).length;
  const passed = unintegrated.length === 0 && dangling.length === 0;

  if (passed) {
    try {
      logEvent(dataDir, "wave_integration_verified", {
        working_branch: workingBranch,
        worktree_branches: wtBranches.length,
        returns_checked: checked,
      });
    } catch { /* event is best-effort */ }
    process.stdout.write(
      `✓ wave integration verified — ${wtBranches.length} worktree branch(es) merged into ${workingBranch}; ` +
        `${checked} return commit(s) reachable.\n`,
    );
    return;
  }

  try {
    logEvent(dataDir, "wave_integration_failed", {
      working_branch: workingBranch,
      unintegrated_branches: unintegrated,
      dangling_tasks: dangling.map((r) => ({ task: r.task, sha: r.sha })),
    });
  } catch { /* event is best-effort */ }

  process.stderr.write(`✗ wave integration gate FAILED — do not tear down worktrees or advance the wave.\n`);
  if (unintegrated.length) {
    process.stderr.write(`  Un-integrated worktree branches (commits not in ${workingBranch}):\n`);
    for (const b of unintegrated) {
      process.stderr.write(`    - ${b}  → rebase + ff-merge onto ${workingBranch} before teardown\n`);
    }
  }
  if (dangling.length) {
    process.stderr.write(`  Dangling task commits (reachable from nothing tracked — orphaned):\n`);
    for (const r of dangling) {
      process.stderr.write(`    - ${r.task}: ${r.sha}  → 'shipyard-data anchor-commit ${r.task} ${r.sha}' then integrate\n`);
    }
  }
  process.exit(3);
}

/**
 * `shipyard-data sprint set <key> <value>` — typed, atomic frontmatter
 * mutation on sprints/current/SPRINT.md.
 *
 * Why a CLI, not a model Edit: SPRINT.md frontmatter is machine-parsed
 * (terminal-gate reads `status:` and `features:`; the stale-cycle guard keys
 * off `status: completed`), and model Edits on frontmatter are the
 * corruption class that welded YAML keys together in the perl-glue
 * incident. The wave/body narrative stays model-authored — this command
 * touches only the leading frontmatter block.
 *
 * Key allowlist mirrors the lifecycle fields skills legitimately flip.
 * Unknown keys are refused so drift shows up as an error, not silent state.
 */
const SPRINT_SETTABLE_KEYS = new Set([
  "status",
  "goal",
  "capacity",
  "features",
  "execution_mode",
  "branch",
  "started_at",
  "completed_at",
]);

/**
 * `execution_mode` vocabulary (dispatch-shape rebuild, §4.6): `solo` / `task`
 * / `track` are current; `subagent` and `team` are accepted as aliases of
 * `task` and `track` respectively so SPRINT.md files written before this
 * rename keep working unchanged. This is the only key with value
 * validation today — the rest stay free-form per the original
 * keys-only-validation design; add here only if another key develops the
 * same drift risk.
 */
const EXECUTION_MODE_VALUES = new Set(["solo", "task", "track", "subagent", "team"]);

function sprintSet(key, value) {
  if (!key || value === undefined) {
    process.stderr.write(
      "shipyard-data sprint set: usage: sprint set <key> <value>\n" +
        `  Settable keys: ${[...SPRINT_SETTABLE_KEYS].join(", ")}\n`,
    );
    process.exit(2);
  }
  if (!SPRINT_SETTABLE_KEYS.has(key)) {
    process.stderr.write(
      `shipyard-data sprint set: key "${key}" is not settable. ` +
        `Allowed: ${[...SPRINT_SETTABLE_KEYS].join(", ")}\n`,
    );
    process.exit(2);
  }
  if (key === "execution_mode" && !EXECUTION_MODE_VALUES.has(value)) {
    process.stderr.write(
      `shipyard-data sprint set: execution_mode "${value}" is not valid. ` +
        `Allowed: solo, task, track (legacy aliases: subagent → task, team → track)\n`,
    );
    process.exit(2);
  }
  const dataDir = getDataDir({ silent: true });
  const sprintPath = join(dataDir, "sprints", "current", "SPRINT.md");
  if (!existsSync(sprintPath)) {
    process.stderr.write(`shipyard-data sprint set: no ${sprintPath} — run init-sprint first\n`);
    process.exit(1);
  }
  const content = readFileSync(sprintPath, "utf8");
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) {
    process.stderr.write("shipyard-data sprint set: SPRINT.md has no frontmatter block — refusing\n");
    process.exit(1);
  }
  const [, open, block, close] = fmMatch;
  const lineRe = new RegExp(`^${key}:.*$`, "m");
  let newBlock;
  if (lineRe.test(block)) {
    newBlock = block.replace(lineRe, `${key}: ${value}`);
  } else {
    newBlock = block.replace(/\s*$/, "") + `\n${key}: ${value}`;
  }
  const newContent = open + newBlock + close + content.slice(fmMatch[0].length);
  const tmp = sprintPath + ".tmp";
  writeFileSync(tmp, newContent, "utf8");
  renameSync(tmp, sprintPath);
  try {
    logEvent(dataDir, "sprint_frontmatter_set", { key, value });
  } catch { /* best-effort */ }
  process.stdout.write(`${key}: ${value}\n`);
}

/**
 * `shipyard-data sprint check` — validate the model-authored SPRINT.md
 * wave body against what the machine consumers can actually parse.
 *
 * SPRINT.md is dual-purpose: freeform plan narrative AND a machine
 * contract (terminal-gate parseWaves extracts `### Wave N` headings +
 * task IDs to know which evidence to demand). A formatting drift in the
 * wave headings silently changed what the gate enforced. This check makes
 * the drift loud at authoring time: ship-sprint runs it right after
 * writing the wave body; cursor preflight can re-run it cheaply.
 *
 * Exit 0 with a parse report, or exit 3 naming what's unparseable.
 */
function sprintCheck() {
  const dataDir = getDataDir({ silent: true });
  const sprintPath = join(dataDir, "sprints", "current", "SPRINT.md");
  if (!existsSync(sprintPath)) {
    process.stderr.write(`✗ sprint check: no ${sprintPath}\n`);
    process.exit(3);
  }
  const content = readFileSync(sprintPath, "utf8");
  const waves = parseWaves(content);
  const problems = [];
  if (waves.length === 0) {
    problems.push("no `### Wave N` headings parsed — the terminal gate would have no waves to verify");
  }
  const empty = waves.filter((w) => w.tasks.length === 0);
  for (const w of empty) {
    problems.push(
      `Wave ${w.wave} parsed with ZERO task IDs — use \`Tasks: [T001, T002]\` or \`- T001\` bullets under the heading`,
    );
  }
  const seen = new Set();
  for (const w of waves) {
    if (seen.has(w.wave)) problems.push(`duplicate \`### Wave ${w.wave}\` heading`);
    seen.add(w.wave);
  }
  if (problems.length > 0) {
    process.stderr.write("✗ sprint check FAILED — SPRINT.md wave structure is not machine-parseable:\n");
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.exit(3);
  }
  const total = waves.reduce((n, w) => n + w.tasks.length, 0);
  process.stdout.write(
    `✓ sprint check — ${waves.length} wave(s), ${total} task(s): ` +
      waves.map((w) => `W${w.wave}[${w.tasks.join(",")}]`).join(" ") +
      "\n",
  );
}

/**
 * `shipyard-data config set-model <tier> <model>` — typed, atomic mutation
 * of the `models:` block in config.md frontmatter.
 *
 * The user can flip the think tier between opus and fable at any time
 * (not just at setup) — the next dispatch reads the new value; no
 * session restart needed. A typed setter (not a model Edit) because
 * config.md frontmatter is machine-read by every dispatch site and
 * nested-YAML hand edits are the frontmatter-welding corruption class.
 *
 *   shipyard-data config set-model think fable
 *   shipyard-data config set-model think opus
 *   shipyard-data config set-model build sonnet
 *   shipyard-data config set-model think claude-opus-4-8
 *   shipyard-data config set-model think inherit   ("" — omit model:, inherit session)
 */
const MODEL_TIERS = new Set(["think", "build", "orchestrate"]);
const MODEL_VALUES = new Set(["fable", "opus", "sonnet", "haiku", "inherit"]);
const CLAUDE_MODEL_ID_RE = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ORCHESTRATION_SKILL_NAMES = ["ship-execute", "ship-review", "ship-sprint", "ship-discuss"];
const AGENT_EFFORT_TIERS = new Set(["build", "build_trivial", "fixer", "operational", "operational_fix", "think", "coordinator", "simplifier"]);
const AGENT_EFFORT_VALUES = new Set(["low", "medium", "high", "inherit"]);

function isAllowedModelValue(value) {
  return MODEL_VALUES.has(value) || CLAUDE_MODEL_ID_RE.test(value);
}

function setFrontmatterNestedValue(block, blockName, key, written) {
  const blockRe = new RegExp(`^${blockName}:\\s*$`, "m");
  if (blockRe.test(block)) {
    const lines = block.split("\n");
    const start = lines.findIndex((l) => new RegExp(`^${blockName}:\\s*$`).test(l));
    let done = false;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;
      const m = lines[i].match(new RegExp(`^(\\s+${key}:)\\s*\\S*(\\s*#.*)?$`));
      if (m) {
        lines[i] = `${m[1]} ${written}${m[2] ?? ""}`;
        done = true;
        break;
      }
    }
    if (!done) {
      lines.splice(start + 1, 0, `  ${key}: ${written}`);
    }
    return lines.join("\n");
  }
  return block.replace(/\s*$/, "") + `\n${blockName}:\n  ${key}: ${written}`;
}

function pluginRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function setSkillFrontmatterModel(skillPath, value) {
  const content = readFileSync(skillPath, "utf8");
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) {
    throw new Error(`missing frontmatter in ${skillPath}`);
  }
  const [, open, block, close] = fmMatch;
  let nextBlock;
  if (value === "inherit") {
    nextBlock = block.replace(/^model:[^\n]*(\r?\n)?/m, "");
  } else if (/^model:[^\n]*$/m.test(block)) {
    nextBlock = block.replace(/^model:[^\n]*$/m, `model: ${value}`);
  } else {
    const lines = block.split("\n");
    const allowedIdx = lines.findIndex((line) => /^allowed-tools:/.test(line));
    lines.splice(allowedIdx === -1 ? 2 : allowedIdx + 1, 0, `model: ${value}`);
    nextBlock = lines.join("\n");
  }
  if (nextBlock === block) return false;
  const next = open + nextBlock + close + content.slice(fmMatch[0].length);
  const tmp = skillPath + ".tmp";
  writeFileSync(tmp, next, "utf8");
  renameSync(tmp, skillPath);
  return true;
}

function syncOrchestrateModel(value) {
  const root = pluginRoot();
  const changed = [];
  for (const name of ORCHESTRATION_SKILL_NAMES) {
    const skillPath = join(root, "skills", name, "SKILL.md");
    if (!existsSync(skillPath)) {
      throw new Error(`missing orchestration skill: ${skillPath}`);
    }
    if (setSkillFrontmatterModel(skillPath, value)) changed.push(name);
  }
  return changed;
}

function configSetModel(tier, value, { dataDir: dataDirOverride } = {}) {
  if (!MODEL_TIERS.has(tier) || !isAllowedModelValue(value)) {
    process.stderr.write(
      "shipyard-data config set-model: usage: config set-model <think|build|orchestrate> <fable|opus|sonnet|haiku|inherit|claude-*>\n",
    );
    process.exit(2);
  }
  const written = value === "inherit" ? '""' : value;
  const dataDir = dataDirOverride ?? getDataDir({ silent: true });
  const configPath = join(dataDir, "config.md");
  if (!existsSync(configPath)) {
    process.stderr.write(`shipyard-data config set-model: no ${configPath} — run shipyard-data onboarding bootstrap first\n`);
    process.exit(1);
  }
  const content = readFileSync(configPath, "utf8");
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) {
    process.stderr.write("shipyard-data config set-model: config.md has no frontmatter block — refusing\n");
    process.exit(1);
  }
  let [, open, block, close] = fmMatch;
  block = setFrontmatterNestedValue(block, "models", tier, written);
  const newContent = open + block + close + content.slice(fmMatch[0].length);
  const tmp = configPath + ".tmp";
  writeFileSync(tmp, newContent, "utf8");
  renameSync(tmp, configPath);
  let synced = [];
  if (tier === "orchestrate") {
    try {
      synced = syncOrchestrateModel(value);
    } catch (err) {
      process.stderr.write(`shipyard-data config set-model: config updated, but failed to sync orchestration skill frontmatter: ${err.message}\n`);
      process.exit(3);
    }
  }
  try {
    logEvent(dataDir, "config_model_set", { tier, value, synced_skills: synced.join(",") });
  } catch { /* best-effort */ }
  const syncNote = tier === "orchestrate" ? ` synced=${synced.length}` : "";
  process.stdout.write(`models.${tier}: ${written}${syncNote}\n`);
}

function configSetEffort(tier, value, { dataDir: dataDirOverride } = {}) {
  if (!AGENT_EFFORT_TIERS.has(tier) || !AGENT_EFFORT_VALUES.has(value)) {
    process.stderr.write(
      "shipyard-data config set-effort: usage: config set-effort <build|build_trivial|fixer|operational|operational_fix|think|coordinator|simplifier> <low|medium|high|inherit>\n",
    );
    process.exit(2);
  }
  const written = value === "inherit" ? '""' : value;
  const dataDir = dataDirOverride ?? getDataDir({ silent: true });
  const configPath = join(dataDir, "config.md");
  if (!existsSync(configPath)) {
    process.stderr.write(`shipyard-data config set-effort: no ${configPath} — run shipyard-data onboarding bootstrap first\n`);
    process.exit(1);
  }
  const content = readFileSync(configPath, "utf8");
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) {
    process.stderr.write("shipyard-data config set-effort: config.md has no frontmatter block — refusing\n");
    process.exit(1);
  }
  let [, open, block, close] = fmMatch;
  block = setFrontmatterNestedValue(block, "agent_effort", tier, written);
  const newContent = open + block + close + content.slice(fmMatch[0].length);
  const tmp = configPath + ".tmp";
  writeFileSync(tmp, newContent, "utf8");
  renameSync(tmp, configPath);
  try {
    logEvent(dataDir, "config_agent_effort_set", { tier, value });
  } catch { /* best-effort */ }
  process.stdout.write(`agent_effort.${tier}: ${written}\n`);
}

// `execution.isolation` vocabulary: `worktree` (task/track builders each get an
// isolated git worktree, parallel + branch-integrated) or `none` (sequential
// in-place on the working branch, no worktrees — the warm-checkout choice for
// heavy builds). Validated because it gates dispatch shape; a typo must fail
// loud, not silently fall through to the default.
const ISOLATION_VALUES = new Set(["worktree", "none"]);

function configSetIsolation(value, { dataDir: dataDirOverride } = {}) {
  if (!ISOLATION_VALUES.has(value)) {
    process.stderr.write(
      "shipyard-data config set-isolation: usage: config set-isolation <worktree|none>\n",
    );
    process.exit(2);
  }
  const dataDir = dataDirOverride ?? getDataDir({ silent: true });
  const configPath = join(dataDir, "config.md");
  if (!existsSync(configPath)) {
    process.stderr.write(`shipyard-data config set-isolation: no ${configPath} — run shipyard-data onboarding bootstrap first\n`);
    process.exit(1);
  }
  const content = readFileSync(configPath, "utf8");
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) {
    process.stderr.write("shipyard-data config set-isolation: config.md has no frontmatter block — refusing\n");
    process.exit(1);
  }
  let [, open, block, close] = fmMatch;
  block = setFrontmatterNestedValue(block, "execution", "isolation", value);
  const newContent = open + block + close + content.slice(fmMatch[0].length);
  const tmp = configPath + ".tmp";
  writeFileSync(tmp, newContent, "utf8");
  renameSync(tmp, configPath);
  try {
    logEvent(dataDir, "config_isolation_set", { value });
  } catch { /* best-effort */ }
  process.stdout.write(`execution.isolation: ${value}\n`);
}

/**
 * `shipyard-data task-return <task-id> status=<COMPLETE|BLOCKED> ...` —
 * record a builder subagent's structured return contract as JSON.
 *
 * Replaces the model-Written `.subagent-returns/<id>.txt` free-text files
 * (v2.9.0). The orchestrator gate and `verify-wave-integrated` Check B
 * previously regex-parsed the model's text; JSON written by this CLI
 * removes the parse-the-model's-prose step. `.txt` files from older
 * versions are still read by verify-wave-integrated for one release.
 *
 * Usage:
 *   shipyard-data task-return T-007 status=COMPLETE commit=<sha> \
 *     probe-exit=0 [output-tail-file=<path>] [escalation-code=<c>] \
 *     [--data-dir <path>]
 *
 * `--data-dir` (optional) skips git-based resolution entirely and writes
 * straight into the given data dir — see `extractDataDirFlag`'s doc comment
 * for why this matters (a builder worktree re-resolving can land in a
 * different project data dir than the orchestrator that dispatched it).
 */
function taskReturn(args, opts = {}) {
  const taskId = args[0];
  if (!taskId || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(taskId)) {
    process.stderr.write(
      `shipyard-data task-return: invalid task id ${JSON.stringify(taskId)} — expected [A-Za-z][A-Za-z0-9_-]{0,63}\n`,
    );
    process.exit(2);
  }
  const kv = {};
  for (const a of args.slice(1)) {
    const eq = a.indexOf("=");
    if (eq <= 0) {
      process.stderr.write(`shipyard-data task-return: unrecognized argument "${a}" — expected k=v\n`);
      process.exit(2);
    }
    kv[a.slice(0, eq)] = a.slice(eq + 1);
  }
  const status = (kv.status || "").toUpperCase();
  if (status !== "COMPLETE" && status !== "BLOCKED") {
    process.stderr.write("shipyard-data task-return: status=COMPLETE|BLOCKED is required\n");
    process.exit(2);
  }
  const sha = kv.commit || "";
  if (status === "COMPLETE" && !/^[0-9a-fA-F]{7,40}$/.test(sha)) {
    process.stderr.write("shipyard-data task-return: status=COMPLETE requires commit=<7-40 hex sha>\n");
    process.exit(2);
  }
  const probeExit = kv["probe-exit"] !== undefined ? parseInt(kv["probe-exit"], 10) : null;
  if (status === "COMPLETE" && probeExit !== 0) {
    process.stderr.write(
      `shipyard-data task-return: status=COMPLETE requires probe-exit=0 (got ${kv["probe-exit"] ?? "(missing)"}) — a COMPLETE claim with a failing probe is the false-completion class this contract exists to block\n`,
    );
    process.exit(3);
  }
  let outputTail = "";
  if (kv["output-tail-file"]) {
    try {
      const raw = readFileSync(kv["output-tail-file"], "utf8");
      outputTail = raw.length > 4096 ? raw.slice(-4096) : raw;
    } catch (err) {
      process.stderr.write(`shipyard-data task-return: cannot read output-tail-file: ${err.message}\n`);
      process.exit(2);
    }
  }

  const dataDir = opts.dataDir || getDataDir({ silent: true });
  const returnsDir = join(dataDir, "sprints", "current", ".subagent-returns");
  mkdirSync(returnsDir, { recursive: true });
  const record = {
    task: taskId,
    status,
    commit_sha: sha || null,
    probe_exit_code: probeExit,
    escalation_code: kv["escalation-code"] || null,
    output_tail: outputTail,
    recorded_at: new Date().toISOString(),
  };
  const path = join(returnsDir, `${taskId}.json`);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
  try {
    logEvent(dataDir, "task_return_recorded", {
      task: taskId,
      status: status.toLowerCase(),
      commit_sha: sha || null,
      probe_exit_code: probeExit,
    });
  } catch { /* best-effort */ }
  process.stdout.write(path + "\n");
}

/**
 * Accept a builder return after the orchestrator has already run every
 * independent gate (STATUS parse, sha existence, probe exit/tail, anti-stub
 * scan). This is intentionally narrower than the whole gate: scan-stubs keeps
 * its own exit-3 redispatch branch, while the post-pass state changes happen
 * in one CLI transaction-shaped call.
 *
 * Usage:
 *   shipyard-data task accept-return <task-id> sprint=<id> wave=<n> commit=<sha>
 *     [--data-dir <path>]
 */
function taskAcceptReturn(args, opts = {}) {
  const taskId = args[0];
  const kv = {};
  for (const a of args.slice(1)) {
    const eq = a.indexOf("=");
    if (eq <= 0) {
      process.stderr.write(`shipyard-data task accept-return: unrecognized argument "${a}" — expected k=v\n`);
      process.exit(2);
    }
    kv[a.slice(0, eq)] = a.slice(eq + 1);
  }
  const sprint = kv.sprint || "";
  const wave = kv.wave || "";
  const sha = kv.commit || kv.commit_sha || "";
  if (!taskId || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(taskId)) {
    process.stderr.write(
      `shipyard-data task accept-return: invalid task id ${JSON.stringify(taskId)} — expected [A-Za-z][A-Za-z0-9_-]{0,63}\n`,
    );
    process.exit(2);
  }
  if (!sprint) {
    process.stderr.write("shipyard-data task accept-return: sprint=<id> is required\n");
    process.exit(2);
  }
  if (!wave || !/^[0-9]+$/.test(wave)) {
    process.stderr.write("shipyard-data task accept-return: wave=<number> is required\n");
    process.exit(2);
  }
  if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) {
    process.stderr.write("shipyard-data task accept-return: commit=<7-40 hex sha> is required\n");
    process.exit(2);
  }

  const dataDir = opts.dataDir || getDataDir({ silent: true });
  anchorCommit(taskId, sha, { dataDir });

  logEvent(dataDir, "task_dispatch_returned", {
    pipeline: "ship-execute",
    sprint,
    wave: Number.parseInt(wave, 10),
    task: taskId,
    status: "complete",
    commit_sha: sha,
  });
  specStateCmd(dataDir, ["task", "set-status", taskId, "done"]);
  process.stdout.write(`task ${taskId} accepted complete return ${sha}\n`);
}

/**
 * Accept a non-worktree operational task after the orchestrator has verified
 * its capture file and final verify_history entry. Unlike accept-return, there
 * is no returned builder commit to anchor; the terminal-gate evidence records
 * the orchestrator's current HEAD.
 *
 * Usage:
 *   shipyard-data task accept-operational <task-id> sprint=<id> wave=<n>
 *     capture=<path> [iterations=<n>] [--data-dir <path>]
 */
function taskAcceptOperational(args, opts = {}) {
  const taskId = args[0];
  const kv = {};
  for (const a of args.slice(1)) {
    const eq = a.indexOf("=");
    if (eq <= 0) {
      process.stderr.write(`shipyard-data task accept-operational: unrecognized argument "${a}" — expected k=v\n`);
      process.exit(2);
    }
    kv[a.slice(0, eq)] = a.slice(eq + 1);
  }
  const sprint = kv.sprint || "";
  const wave = kv.wave || "";
  const capture = kv.capture || kv.verify_output || "";
  if (!taskId || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(taskId)) {
    process.stderr.write(
      `shipyard-data task accept-operational: invalid task id ${JSON.stringify(taskId)} — expected [A-Za-z][A-Za-z0-9_-]{0,63}\n`,
    );
    process.exit(2);
  }
  if (!sprint) {
    process.stderr.write("shipyard-data task accept-operational: sprint=<id> is required\n");
    process.exit(2);
  }
  if (!wave || !/^[0-9]+$/.test(wave)) {
    process.stderr.write("shipyard-data task accept-operational: wave=<number> is required\n");
    process.exit(2);
  }
  if (!capture) {
    process.stderr.write("shipyard-data task accept-operational: capture=<path> is required\n");
    process.exit(2);
  }
  const projectRoot = getProjectRoot();
  const sha = gitCapture(["rev-parse", "HEAD"], projectRoot);
  if (!sha || !/^[0-9a-fA-F]{7,40}$/.test(sha)) {
    process.stderr.write("shipyard-data task accept-operational: cannot resolve current HEAD commit\n");
    process.exit(1);
  }
  const dataDir = opts.dataDir || getDataDir({ silent: true });
  const waveNumber = Number.parseInt(wave, 10);
  const iterations = kv.iterations !== undefined ? Number.parseInt(kv.iterations, 10) : undefined;
  const operationalFields = {
    pipeline: "ship-execute",
    sprint,
    wave: waveNumber,
    task: taskId,
    status: "complete",
    capture,
    verify_output: capture,
  };
  if (Number.isFinite(iterations)) operationalFields.iterations_run = iterations;
  logEvent(dataDir, "operational_task_completed", operationalFields);
  logEvent(dataDir, "task_dispatch_returned", {
    pipeline: "ship-execute",
    sprint,
    wave: waveNumber,
    task: taskId,
    status: "complete",
    kind: "operational",
    commit_sha: sha,
  });
  specStateCmd(dataDir, ["task", "set-status", taskId, "done"]);
  process.stdout.write(`task ${taskId} accepted operational completion at ${sha}\n`);
}

/**
 * Does a project data dir hold real Shipyard state (as opposed to being an
 * empty shell)? Used by doctor to tell a fork/orphan apart from a legitimately
 * uninitialized dir. State = an event log or any allocated ID counter.
 */
function dirHoldsState(dir) {
  if (existsSync(join(dir, ".shipyard-events.jsonl"))) return true;
  for (const kind of ["ideas", "bugs", "features", "epics", "tasks"]) {
    if (existsSync(join(dir, "spec", kind, ".id-seq"))) return true;
  }
  return false;
}

// dirLooksInitialized now lives in shipyard-resolver.mjs (imported above) so
// `ensureDataDirLink` can gate on the same predicate. Kept as one copy on
// purpose — duplicated resolver helpers have drifted here before.

/**
 * Find the task file for an id under `spec/tasks/`, or null. Task files are
 * named `<id>-<slug>.md` (occasionally bare `<id>.md`), so match by prefix.
 */
function findTaskFile(dataDir, id) {
  const tasksDir = join(dataDir, "spec", "tasks");
  let entries;
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return null;
  }
  const hit = entries.find(
    (name) => name === `${id}.md` || name.startsWith(`${id}-`),
  );
  return hit ? join(tasksDir, hit) : null;
}

/**
 * Find the feature file for an id under `spec/features/`, or null. Feature
 * files follow the same `<id>-<slug>.md` convention as tasks.
 */
function findFeatureFile(dataDir, id) {
  const featuresDir = join(dataDir, "spec", "features");
  let entries;
  try {
    entries = readdirSync(featuresDir);
  } catch {
    return null;
  }
  const hit = entries.find(
    (name) => name === `${id}.md` || name.startsWith(`${id}-`),
  );
  return hit ? join(featuresDir, hit) : null;
}

/**
 * P5 (fixes 3.1, 3.2): registry-schema validation, watermark-gated for
 * incrementality. `ship-status`'s Check 1 currently does this by Glob'ing
 * every `.md` file under spec/ and Read'ing each one into the model's own
 * context — an O(product) cost re-paid on every invocation (measured:
 * 779 files and growing on the customer workspace). This is the CLI half:
 * the same per-file schema check, but bounded to files touched since the
 * last clean run.
 *
 * Watermark: `<SHIPYARD_DATA>/.doctor-watermark.json`, `{lastCleanAt,
 * schemaVersion}`. A run only re-validates files whose mtime is newer than
 * `lastCleanAt` — UNLESS `full` is requested, or the stored schema version
 * doesn't match `REGISTRY_SCHEMA_VERSION` (a rule-set change invalidates
 * any prior "this file was clean" claim). The watermark only advances on a
 * fully clean scan — advancing it on a dirty scan would let an unfixed
 * file silently age out of every future incremental scan.
 */
const REGISTRY_SCHEMA_VERSION = 1;
const DOCTOR_WATERMARK_BASENAME = ".doctor-watermark.json";

const REGISTRY_ENTITY_RULES = {
  features: {
    dir: join("spec", "features"),
    // Accepts child/sub-feature ids (F036a, F071d) — the documented split
    // convention in project-files/rules/shipyard-spec.md. Without the
    // optional letter, doctor reported real feature files as malformed.
    idRe: /^F\d+[a-z]?$/,
    requiredKeys: [
      "id", "title", "type", "epic", "status", "story_points", "complexity",
      "token_estimate", "rice_reach", "rice_impact", "rice_confidence",
      "rice_effort", "rice_score", "dependencies", "references", "tasks", "created",
    ],
    statusValues: Object.keys(FEATURE_TRANSITIONS),
  },
  tasks: {
    dir: join("spec", "tasks"),
    idRe: /^T[-A-Za-z0-9]*\d+$/,
    requiredKeys: ["id", "title", "feature", "status", "effort", "dependencies"],
    statusValues: ["pending", "in-progress", "done", "blocked", "needs-attention", "approved"],
  },
  bugs: {
    dir: join("spec", "bugs"),
    idRe: /^B\d+$/,
    requiredKeys: ["id", "title", "status", "severity"],
  },
  ideas: {
    dir: join("spec", "ideas"),
    idRe: /^IDEA-?\d+$/,
    requiredKeys: ["id", "title", "status"],
  },
  epics: {
    dir: join("spec", "epics"),
    idRe: /^E\d+$/,
    requiredKeys: ["id", "title", "status"],
  },
};

function readDoctorWatermark(dataDir) {
  const p = join(dataDir, DOCTOR_WATERMARK_BASENAME);
  if (!existsSync(p)) return null;
  try {
    const obj = JSON.parse(readFileSync(p, "utf8"));
    if (obj && typeof obj === "object" && typeof obj.lastCleanAt === "string" && typeof obj.schemaVersion === "number") {
      return obj;
    }
  } catch {
    /* corrupt watermark — treated as absent, forces a full sweep */
  }
  return null;
}

function writeDoctorWatermark(dataDir, obj) {
  const p = join(dataDir, DOCTOR_WATERMARK_BASENAME);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}

function validateRegistryFile(rules, filePath) {
  const content = readFileSync(filePath, "utf8");
  const fm = parseFrontmatter(content);
  const problems = [];
  for (const key of rules.requiredKeys) {
    if (!(key in fm) || fm[key] === "") problems.push(`missing/empty field: ${key}`);
  }
  if (rules.statusValues && fm.status && !rules.statusValues.includes(fm.status)) {
    problems.push(`invalid status: "${fm.status}"`);
  }
  if (rules.idRe && fm.id && !rules.idRe.test(fm.id)) {
    problems.push(`id "${fm.id}" does not match the expected pattern`);
  }
  return problems;
}

/**
 * Run the registry-schema scan. Read-only except for the watermark file
 * itself (and only on a fully clean result). `opts.full` forces a whole-
 * tree sweep regardless of the watermark.
 */
function scanRegistry(dataDir, opts = {}) {
  const watermark = readDoctorWatermark(dataDir);
  const schemaMatches = watermark && watermark.schemaVersion === REGISTRY_SCHEMA_VERSION;
  const incremental = !opts.full && schemaMatches;
  const sinceMs = incremental ? Date.parse(watermark.lastCleanAt) : NaN;
  const hasSince = Number.isFinite(sinceMs);

  const findings = [];
  let scannedCount = 0;
  let skippedCount = 0;
  const scanStartedAt = new Date();

  for (const [kind, rules] of Object.entries(REGISTRY_ENTITY_RULES)) {
    const dir = join(dataDir, rules.dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // entity dir doesn't exist yet — nothing to scan
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
      const filePath = join(dir, ent.name);
      if (incremental && hasSince) {
        let st;
        try {
          st = statSync(filePath);
        } catch {
          continue;
        }
        if (st.mtimeMs <= sinceMs) {
          skippedCount++;
          continue;
        }
      }
      scannedCount++;
      let problems;
      try {
        problems = validateRegistryFile(rules, filePath);
      } catch (err) {
        problems = [`unreadable/unparseable: ${err.message}`];
      }
      for (const p of problems) {
        findings.push({ kind, file: filePath, problem: p });
      }
    }
  }

  const clean = findings.length === 0;
  if (clean) {
    // Only advance the watermark on a fully clean scan — advancing it
    // after finding problems would let an unfixed file age out of every
    // future incremental scan (mtime never changes again if nobody
    // touches it, so it would never get re-checked).
    try {
      writeDoctorWatermark(dataDir, {
        lastCleanAt: scanStartedAt.toISOString(),
        schemaVersion: REGISTRY_SCHEMA_VERSION,
      });
    } catch {
      /* best-effort — a failed watermark write just costs the next run its incrementality */
    }
  }

  return { findings, scannedCount, skippedCount, incremental: incremental && hasSince, clean };
}

/**
 * `shipyard-data doctor` — read-only integrity scan for the classes of data
 * corruption reported in upstream issue #4:
 *
 *   1. Phantom/forked project dirs — a `projects/<hash>/` that holds state but
 *      was never initialized (no `.project-root`/`config.md`/`templates/`).
 *      These are minted when a bookkeeping command runs from a cwd that isn't
 *      the project git repo (now prevented by the resolver's non-git guard;
 *      doctor surfaces any that already exist).
 *   2. Nested `projects/` dirs — a `projects/` directory INSIDE a project dir,
 *      i.e. `projects/<realhash>/projects/<wronghash>/`, the historical shape
 *      of the same bug.
 *   3. Dangling patch tasks — a `patch_task_created` event whose task id has
 *      no `spec/tasks/<id>-*.md` file, so everything that frontmatter-checks
 *      tasks (ship-status, review's evidence check, carry-over scan) sees a
 *      broken reference (issue #4, defect 3).
 *   4. Registry-schema drift (P5) — a spec/ entity file missing a required
 *      frontmatter field, an invalid status value, or a malformed id.
 *      Watermark-gated (see scanRegistry above) so a doctor run after a
 *      large sprint doesn't re-read every spec/ file, only ones touched
 *      since the last clean run. `--full` forces a whole-tree sweep.
 *
 * Exits 0 when clean, 1 when any issue is found. Never mutates state other
 * than the doctor watermark itself — it only reports, with a remediation
 * hint per finding.
 */
function doctor(opts = {}) {
  let dataDir;
  try {
    dataDir = getDataDir({ silent: true });
  } catch (err) {
    process.stderr.write(
      `shipyard-data doctor: cannot locate the plugin data directory.\n` +
        (err instanceof ShipyardResolverError ? err.message : `${err}\n`),
    );
    process.exit(1);
  }
  const projectsDir = dirname(dataDir);
  const currentHash = basename(dataDir);
  const findings = [];

  // --- Cross-project scan: phantom dirs + nested projects/ dirs. ---
  let entries = [];
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    /* no projects/ dir yet — nothing to scan */
  }
  let scanned = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    scanned++;
    const dir = join(projectsDir, ent.name);

    if (existsSync(join(dir, "projects"))) {
      findings.push({
        kind: "nested-projects",
        detail: `${join(dir, "projects")} — a projects/ dir nested inside a project dir`,
        hint: "Merge its event log/counters into the real project, then delete the nested projects/ tree.",
      });
    }

    if (!dirLooksInitialized(dir) && dirHoldsState(dir)) {
      findings.push({
        kind: "phantom-project",
        detail: `${dir} — holds state but was never initialized (no .project-root/config.md/templates/)`,
        hint: "Likely a fork minted from a non-repo cwd. Merge its events/counters into the real project dir, then delete it.",
      });
    }
  }

  // --- Current project: dangling patch tasks. ---
  const eventsLog = join(dataDir, ".shipyard-events.jsonl");
  if (existsSync(eventsLog)) {
    let lines = [];
    try {
      lines = readFileSync(eventsLog, "utf8").split("\n");
    } catch {
      /* unreadable — skip this check */
    }
    const seen = new Set();
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type !== "patch_task_created") continue;
      const id = ev.task_id ?? ev.task;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!findTaskFile(dataDir, id)) {
        findings.push({
          kind: "dangling-patch-task",
          detail: `patch_task_created id=${id} has no spec/tasks/${id}-*.md file`,
          hint: `Write the missing task file (spec/tasks/${id}-<slug>.md) — the dispatch path must create it before emitting patch_task_created.`,
        });
      }
    }
  }

  // --- Current project: registry-schema validation (P5, watermark-gated). ---
  let registryScan = null;
  try {
    registryScan = scanRegistry(dataDir, { full: !!opts.full });
  } catch {
    /* best-effort — the other doctor checks above still stand */
  }
  if (registryScan) {
    for (const f of registryScan.findings) {
      findings.push({
        kind: "registry-schema",
        detail: `${f.kind} ${f.file} — ${f.problem}`,
        hint: `Fix the frontmatter field, then re-run 'shipyard-data doctor' to confirm (or --full to re-check everything).`,
      });
    }
  }

  const registrySummary = registryScan
    ? `; registry: ${registryScan.scannedCount} file(s) checked` +
      (registryScan.incremental ? ` (incremental, ${registryScan.skippedCount} skipped via watermark)` : " (full sweep)")
    : "";

  if (findings.length === 0) {
    process.stdout.write(
      `shipyard-data doctor: no issues found ` +
        `(scanned ${scanned} project dir${scanned === 1 ? "" : "s"} under ${projectsDir}; ` +
        `current project ${currentHash}${registrySummary}).\n`,
    );
    return;
  }

  process.stdout.write(
    `shipyard-data doctor: ${findings.length} issue${findings.length === 1 ? "" : "s"} found.\n`,
  );
  for (const f of findings) {
    process.stdout.write(`\n  [${f.kind}] ${f.detail}\n`);
    process.stdout.write(`    → ${f.hint}\n`);
  }
  process.stdout.write("\n");
  process.exit(1);
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
    case "onboarding":
      onboardingCmd(process.argv.slice(3));
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
    case "metrics": {
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "metrics");
      metricsCmd(rest, { dataDir: dataDirOverride });
      break;
    }
    case "init-sprint": {
      const initSprintArgs = process.argv.slice(3);
      const ddIdx = initSprintArgs.indexOf("--data-dir");
      let initSprintDataDir;
      let initSprintId;
      if (ddIdx !== -1) {
        initSprintDataDir = initSprintArgs[ddIdx + 1];
        initSprintId = initSprintArgs.find((_a, i) => i !== ddIdx && i !== ddIdx + 1);
      } else {
        initSprintId = initSprintArgs[0];
      }
      initSprint(initSprintId, { dataDir: initSprintDataDir });
      break;
    }
    case "events": {
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "events emit");
      eventsCmd(rest, { dataDir: dataDirOverride });
      break;
    }
    case "next-id": {
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "next-id");
      nextIdCmd(rest, { dataDir: dataDirOverride });
      break;
    }
    case "link-data-dir": {
      const rest = process.argv.slice(3);
      linkDataDir({ force: rest.includes("--force") });
      break;
    }
    case "clean-worktrees": {
      const rest = process.argv.slice(3);
      cleanWorktrees({
        dryRun: rest.includes("--dry-run"),
        force: rest.includes("--force"),
        all: rest.includes("--all"),
      });
      break;
    }
    case "ensure-shared-caches": {
      ensureSharedCaches();
      break;
    }
    case "resolve-isolation": {
      resolveIsolation(process.argv.slice(3));
      break;
    }
    case "resolve-refactor-scope": {
      resolveRefactorScope();
      break;
    }
    case "resolve-wave-caps": {
      resolveWaveCaps();
      break;
    }
    case "ensure-worktree-baseref": {
      ensureWorktreeBaseref();
      break;
    }
    case "anchor-commit": {
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "anchor-commit");
      anchorCommit(rest[0], rest[1], { dataDir: dataDirOverride });
      break;
    }
    case "verify-ac-coverage": {
      verifyAcCoverage(process.argv.slice(3));
      break;
    }
    case "verify-wave-integrated": {
      verifyWaveIntegrated();
      break;
    }
    case "cursor": {
      cursorCmd(getDataDir({ silent: true }), process.argv.slice(3));
      break;
    }
    case "sprint": {
      const rest = process.argv.slice(3);
      if (rest[0] === "set") {
        sprintSet(rest[1], rest.slice(2).join(" "));
      } else if (rest[0] === "check") {
        sprintCheck();
      } else {
        process.stderr.write(
          `shipyard-data sprint: unknown subcommand "${rest[0] ?? ""}". Expected: set <key> <value> | check\n`,
        );
        process.exit(2);
      }
      break;
    }
    case "config": {
      // `config set` routes into spec-state-cli and so needs `--data-dir` for
      // the same worktree reason as feature/backlog/idea/task. The sibling
      // set-model/set-effort/set-isolation verbs write the SAME config.md, so
      // they take the override too — a flag that worked on one config verb
      // and was silently dropped by the next three would be worse than none.
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "config");
      if (rest[0] === "set-model") {
        configSetModel(rest[1], rest[2], { dataDir: dataDirOverride });
      } else if (rest[0] === "set-effort") {
        configSetEffort(rest[1], rest[2], { dataDir: dataDirOverride });
      } else if (rest[0] === "set-isolation") {
        configSetIsolation(rest[1], { dataDir: dataDirOverride });
      } else if (rest[0] === "set") {
        // Generic allowlisted config.md fields outside the `models:` block
        // (currently just product-spec-path) route through spec-state-cli's
        // shared conventions (withLockfile, temp+rename, logEvent) rather
        // than a second copy of that machinery here.
        specStateCmd(dataDirOverride ?? getDataDir({ silent: true }), ["config", "set", ...rest.slice(1)]);
      } else {
        process.stderr.write(
          `shipyard-data config: unknown subcommand "${rest[0] ?? ""}". Expected: set-model <think|build|orchestrate> <fable|opus|sonnet|haiku|inherit|claude-*> | set-effort <build|build_trivial|fixer|operational|operational_fix|think|coordinator|simplifier> <low|medium|high|inherit> | set-isolation <worktree|none> | set <key> <value>\n`,
        );
        process.exit(2);
      }
      break;
    }
    case "task-return": {
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "task-return");
      taskReturn(rest, { dataDir: dataDirOverride });
      break;
    }
    case "doctor": {
      doctor({ full: process.argv.slice(3).includes("--full") });
      break;
    }
    case "feature":
    case "backlog":
    case "idea": {
      // These route into spec-state-cli exactly like `task`/`draft` do, and
      // for the same reason need `--data-dir`: a builder/subagent whose
      // worktree re-resolves to a different project dir than the
      // orchestrator's would otherwise mutate the wrong feature files. The
      // flag used to be parsed nowhere on this path, so it landed in `rest`
      // as a stray positional: `feature set-status F001 approved --data-dir
      // /x` ignored the trailing pair entirely and wrote into the RESOLVED
      // dir instead — a wrong-target write that exited 0 and looked like
      // success.
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), command);
      specStateCmd(dataDirOverride ?? getDataDir({ silent: true }), [command, ...rest]);
      break;
    }
    case "draft": {
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "draft");
      specStateCmd(dataDirOverride ?? getDataDir({ silent: true }), ["draft", ...rest]);
      break;
    }
    case "task": {
      // `task set-status` is invoked from several builder/dispatch bodies
      // running inside a worktree whose resolver-derived data dir can
      // differ from the orchestrator's — same class of bug --data-dir
      // fixes on task-return/events/anchor-commit. extractDataDirFlag
      // strips the flag from the args passed through to specStateCmd, so
      // that CLI never sees it.
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "task");
      if (rest[0] === "accept-return") {
        taskAcceptReturn(rest.slice(1), { dataDir: dataDirOverride });
      } else if (rest[0] === "accept-operational") {
        taskAcceptOperational(rest.slice(1), { dataDir: dataDirOverride });
      } else {
        specStateCmd(dataDirOverride ?? getDataDir({ silent: true }), ["task", ...rest]);
      }
      break;
    }
    case "lock": {
      skillLockCmd(getDataDir({ silent: true }), process.argv.slice(3));
      break;
    }
    case "scan-stubs": {
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "scan-stubs");
      scanStubsCmd(dataDirOverride ?? getDataDir({ silent: true }), rest);
      break;
    }
    case "verify": {
      verifyCmd(getDataDir({ silent: true }), process.argv.slice(3));
      break;
    }
    case "review": {
      reviewPlanCmd(process.argv.slice(3));
      break;
    }
    case "queue": {
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "queue");
      queueCmd(dataDirOverride ?? getDataDir({ silent: true }), rest);
      break;
    }
    case "readiness-check": {
      readinessCheckCmd(getProjectRoot(), getDataDir({ silent: true }), process.argv.slice(3));
      break;
    }
    case "check-idea-backlog": {
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(
        process.argv.slice(3),
        "check-idea-backlog",
      );
      const dd = dataDirOverride ?? getDataDir({ silent: true });
      checkIdeaBacklogCmd(dd, readEvents(dd), readMaxUndispositionedIdeas(dd), rest);
      break;
    }
    // For project-id / project-root use `node ${CLAUDE_PLUGIN_ROOT}/bin/shipyard-resolver.mjs project-hash|project-root`.
    default:
      process.stderr.write(
        `shipyard-data: unknown command "${command}". ` +
        `Expected: (none) | init | onboarding <status|bootstrap> | with-lock <key> -- <cmd> | archive-sprint <sprint-id> [--force] | metrics <record-retro|regenerate> ... [--data-dir <path>] | init-sprint <sprint-id> [--data-dir <path>] | cursor <advance|pause|escalate|noop> ... | sprint <set|check> ... | task-return <task-id> k=v ... [--data-dir <path>] | events emit <type> [k=v ...] [--data-dir <path>] | next-id <kind> [--data-dir <path>] | link-data-dir [--force] | clean-worktrees [--dry-run] [--force] [--all] | ensure-worktree-baseref | ensure-shared-caches | resolve-isolation [--flag <true|false|worktree|none>] | resolve-refactor-scope | resolve-wave-caps | anchor-commit <task-id> <sha> [--data-dir <path>] | verify-wave-integrated | verify-ac-coverage [--base <sha>] [--head <sha>] | doctor [--full] | feature <set-status|set|add-ref|add-external-ref|add-dep|remove-dep|set-tasks|clear-tasks|record-proof|check-probes|assign-ac-ids> ... [--data-dir <path>] | backlog <add|remove|rank|set> ... [--data-dir <path>] | idea set-status ... [--to FNNN] [--data-dir <path>] | task <set-status|append-verify|accept-return|accept-operational> ... [--data-dir <path>] | draft <obsolete-research|set-sprint-status> ... [--data-dir <path>] | config <set-model|set-effort|set-isolation|set> ... [--data-dir <path>] | lock <acquire|release|check|status> ... | scan-stubs <base>..<head> [--lang <x>] [--data-dir <path>] | verify <record|check> ... | review plan <findings.json> [--out <path>] | queue <enqueue|claim|complete|fail|list|requeue-stale|retry-stale|park-stale> ... [--data-dir <path>] | readiness-check [--target-branch <b>] [--baseline-failing] | readiness-check --classify <path> ... | check-idea-backlog [--json] [--data-dir <path>]\n`,
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
