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
 *   shipyard-data onboarding status|bootstrap  → setup/onboarding state (prints
 *                                                SHIPYARD_TUTORIAL_OFFER once per project)
 *   shipyard-data quick <start|pick|next|finish|list|land|drop> → one item from words to
 *                                                reviewed code on the person's branch
 *                                                (see bin/quick.mjs; `start --tutorial`
 *                                                is the guided run)
 *   shipyard-data tutorial sandbox [--path <f>]  → a throwaway project to take the
 *                            | --remove <f>        tutorial in (see bin/tutorial.mjs)
 *   shipyard-data with-lock <key> -- <cmd>     → fcntl-style locking primitive
 *   shipyard-data archive-sprint <id> [--force] [--unreviewed|--via-review]→ atomic sprint rename
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
 *   shipyard-data verify findings --wave <n> --tasks <ids> --met <n> --partial <n>
 *     --missing <n> --over-built <n>   → wave_verify_findings event (counts only)
 *   shipyard-data verify check --key <k>       → exit 0 = fresh (reusable),
 *     --command <literal> [--ttl-hours <n>]       exit 3 = stale (re-run it)
 *   shipyard-data review plan <findings.json>  → deterministic review finding
 *     [--out <path>]                              batches and validation waves
 *   shipyard-data queue <enqueue|claim|complete|fail|list|requeue-stale|retry-stale|park-stale>
 *                                                → durable flat-worker queue
 */

import { execFileSync, spawnSync } from "node:child_process";
import { findDrift, applyFixes } from "./reconcile.mjs";
import { ownedNames, ownerFor, ownerOf, repoFor, stampOwner, sweepBranches, sweepWorktrees } from "./branches.mjs";
import { strayChanges, othersWorkingHere } from "./stray.mjs";
import { main as sprintAheadMain } from "./sprint-ahead.mjs";
import { readSweepBranches } from "./config-read.mjs";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as pathResolve, resolve } from "node:path";
import { loadMetricsState, sortSprintRecords, updateMetricAggregate, roundMetric, writeMetricsState } from "./metrics-state.mjs";
import { capacityMain } from "./capacity.mjs";
import { migrateMain } from "./migrate-v4.mjs";
import { ENTITIES, entityForNextIdKind, STEP_ID_RE, eventMatches, eventTypeAliases, canonicalEventType, WAVE_UNIT_ID_RE, inSprintWindow, isStepSpawn } from "./vocab.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EVENTS_LOG_NAME, logEvent, withLockfile } from "./_hook_lib.mjs";
import { readEvents as readEventsWithArchive, activeTime } from "./event-report.mjs";
import { dirLooksInitialized, ensureDataDirLink, getDataDir, getProjectRoot, homeOf, ShipyardResolverError } from "./shipyard-resolver.mjs";
import { cursorCmd } from "./cursor-cli.mjs";
import { parseFrontmatter, parseWaves, readEvents, sprintStoryIds, sprintStoryList } from "./terminal-gate.mjs";
import { parseFrontmatterList } from "./frontmatter-list.mjs";
import { specStateCmd } from "./spec-state-cli.mjs";
import { FEATURE_TRANSITIONS } from "./spec-lifecycle.mjs";
import { skillLockCmd, resolveSessionIdentity, runningBeside } from "./skill-lock.mjs";
import { scanStubsCmd } from "./scan-stubs.mjs";
import { verifyCmd } from "./verify-ledger.mjs";
import { readinessCheckCmd } from "./readiness-check.mjs";
import { checkIdeaBacklogCmd, countUndispositionedIdeas } from "./idea-backlog.mjs";
import { bootstrapOnboarding, ensureInitializedDataDir, renderOnboardingLines } from "./init-data.mjs";
import { tutorialNote } from "./tutorial.mjs";
import { reviewPlanCmd } from "./review-plan.mjs";
import { queueCmd, settleFromReturn } from "./worker-queue.mjs";
import { tierFor } from "./model-for.mjs";
import {
  readExecutionIsolation,
  readRoutingRules,
  ROLE_EFFORT_DEFAULT,
  readModelTier,
  normalizeLegacyModel,
  readAgentEffort,
  ROLE_TIER,
  normalizeIsolationToken,
  readMaxUndispositionedIdeas,
  readEnforceAcCoverage,
  readRefactorScope,
  readDispatchOrder,
  readMaxTasksPerWave,
  readMergeIndependentLayers,
  readMaxTasksPerWaveMerged,
} from "./config-read.mjs";
import { collectConfigWarnings, collectConfigErrors } from "./doctor-config.mjs";
import { routeDecision } from "./route.mjs";

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
    renderOnboardingLines(dataDir, (line) => process.stdout.write(line + "\n"), { stampTutorialOffer: true });
    return;
  }
  if (sub === "bootstrap") {
    const { dataDir } = bootstrapOnboarding();
    process.stdout.write(`SHIPYARD_DATA=${dataDir}\n`);
    renderOnboardingLines(dataDir, (line) => process.stdout.write(line + "\n"), { stampTutorialOffer: true });
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
function reviewCursorAllowsViaReview(currentDir, sprintId) {
  const p = join(currentDir, "REVIEW-CURSOR.md");
  if (!existsSync(p)) return false;
  try {
    const fm = parseFrontmatter(readFileSync(p, "utf8"));
    const stage = String(fm.stage || "").trim();
    if (stage !== "release_step_3" && stage !== "archive") return false;
    const cs = String(fm.sprint || "").trim();
    return !cs || cs === sprintId;
  } catch { return false; }
}

/** See the call site in archiveSprint. Returns [{id, to}] for the stories it moved. */
function finalizeSprintStories(dataDir, currentDir, sprintId) {
  const out = [];
  let content;
  try { content = readFileSync(join(currentDir, "SPRINT.md"), "utf8"); } catch { return out; }
  const completed = String(parseFrontmatter(content).status || "").trim().toLowerCase() === "completed";
  const self = fileURLToPath(import.meta.url);
  const run = (...argv) => spawnSync("node", [self, ...argv, "--data-dir", dataDir], { encoding: "utf8" });
  for (const id of parseSprintFeatureIds(content)) {
    const fp = findFeatureFile(dataDir, id);
    if (!fp) continue;
    let status = "";
    try { status = String(parseFrontmatter(readFileSync(fp, "utf8")).status || "").trim().toLowerCase(); } catch { continue; }
    if (status !== "in-progress") continue;
    let approved = false;
    try { approved = String(parseFrontmatter(readFileSync(join(dataDir, "verify", `${id}-verdict.md`), "utf8")).recommendation || "").trim() === "approve"; } catch { approved = false; }
    if (completed && approved) {
      if (run("story", "set-status", id, "done").status === 0) out.push({ id, to: "done" });
    } else if (run("story", "set-status", id, "approved").status === 0) {
      run("backlog", "add", id);
      out.push({ id, to: "approved" });
    }
  }
  return out;
}

// AC-1 AC-2 AC-3 AC-4 AC-7 (F043): a completed sprint may only be archived
// with review evidence and no in-progress feature, unless --via-review.
function enforceReviewGate(dataDir, currentDir, sprintId, unreviewed = false, events = null) {
  const sprintPath = join(currentDir, "SPRINT.md");
  if (!existsSync(sprintPath)) return;
  const content = readFileSync(sprintPath, "utf8");
  if (String(parseFrontmatter(content).status || "").trim().toLowerCase() !== "completed") return;
  const isRelease = (v) => v === "archive" || /^release_step_\d+$/.test(String(v || ""));
  // Archive-aware: review evidence rotated into events-archive/ still counts.
  const reviewed = (events ?? readEventsWithArchive(dataDir).events).some(
    (e) =>
      e.pipeline === "ship-review" &&
      e.sprint === sprintId &&
      (isRelease(e.stage) ||
        isRelease(e.next_stage) ||
        (e.type === "pipeline_terminal" && ["success", "escalated"].includes(e.outcome))),
  );
  const inProgress = [];
  for (const id of parseSprintFeatureIds(content)) {
    const fp = findFeatureFile(dataDir, id);
    if (!fp) continue;
    try {
      if (String(parseFrontmatter(readFileSync(fp, "utf8")).status || "").trim().toLowerCase() === "in-progress") inProgress.push(id);
    } catch { /* unreadable feature: not evidence of in-progress */ }
  }
  if (unreviewed) {
    // AC-5 (F043): explicit override — archive anyway, but leave an audit
    // trail only when the gate would actually have refused (no no-op noise).
    if (reviewed && inProgress.length === 0) return;
    logEvent(dataDir, "sprint_archived_unreviewed", {
      sprint: sprintId,
      review_evidence: reviewed,
      in_progress_features: inProgress.join(","),
    });
    return;
  }
  if (reviewed && inProgress.length === 0) return;
  const why = [];
  if (!reviewed) why.push("no /ship-review evidence for this sprint");
  if (inProgress.length) why.push(`feature(s) still in-progress: ${inProgress.join(", ")}`);
  process.stderr.write(
    `shipyard-data archive-sprint: refusing — ${why.join("; ")}\n` +
    `  Run /ship-review ${sprintId} first, or re-run with --unreviewed to archive anyway.\n`
  );
  process.exit(1);
}

function archiveSprint(sprintId, opts = {}) {
  if (!sprintId) {
    process.stderr.write(
      "shipyard-data archive-sprint: missing sprint ID\n" +
      "  Usage: shipyard-data archive-sprint <sprint-id> [--force] [--unreviewed | --via-review]\n" +
      "  Sprint ID must match: sprint-NNN (3+ digits)\n"
    );
    process.exit(1);
  }
  if (opts.unreviewed && opts.viaReview) {
    process.stderr.write(
      "shipyard-data archive-sprint: --unreviewed and --via-review are mutually exclusive\n" +
      "  --via-review: the review pipeline is archiving; --unreviewed: operator override (audited).\n"
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

  // Destination-exists refusal comes BEFORE the review gate: a refused
  // archive must not leave a sprint_archived_unreviewed audit event.
  if (existsSync(archiveDir) && !opts.force) {
    process.stderr.write(
      `shipyard-data archive-sprint: refusing — archive destination already exists: ${archiveDir}\n` +
      `  Re-run with --force to overwrite (existing contents will be removed first).\n`
    );
    process.exit(1);
  }

  // Gate before any destructive step: a refusal must change nothing.
  // --via-review is honored only while /ship-review itself is archiving
  // (review cursor at release_step_3/archive); otherwise the normal gate runs.
  // One pass over the live log + archives, shared by the review gate and the
  // throughput record (each used to parse the whole history on its own).
  let sprintEvents = null;
  try { sprintEvents = readEventsWithArchive(dataDir).events; } catch { /* unreadable: gate reads nothing, throughput reports events_unreadable */ }
  if (!(opts.viaReview && reviewCursorAllowsViaReview(currentDir, sprintId))) enforceReviewGate(dataDir, currentDir, sprintId, !!opts.unreviewed, sprintEvents ?? []);

  // A review commits what it wrote to the project (4.15.1). It records the
  // owner's answers in the project's own docs; twice it ended with that file
  // uncommitted and a line saying "say the word and I'll commit it". Only
  // files that became dirty since the review's own start count.
  if (opts.viaReview) {
    let before = null;
    try { before = JSON.parse(readFileSync(join(currentDir, ".tree-baseline-ship-review.json"), "utf8")).dirty; } catch { before = null; }
    if (Array.isArray(before)) {
      let now = null;
      try { now = strayChanges(dataDir)?.tracked ?? null; } catch { now = null; }
      const fresh = now ? now.filter((p) => !before.includes(p)) : [];
      const besideReview = fresh.length ? othersWorkingHere(dataDir) : [];
      if (fresh.length && besideReview.length && !opts.leaveChanges) {
        // 4.17: another command is running here; the file may be its own.
        process.stderr.write(`shipyard-data archive-sprint: note — ${fresh.length} uncommitted project file(s): ${fresh.join(", ")}. ${besideReview.join(" and ")} is running here too, so they may be its work. If this review wrote one, commit that path.\n`);
        try { logEvent(dataDir, "archive_with_uncommitted_changes", { sprint: sprintId, files: fresh.join(","), reason: `beside ${besideReview.join("+")}` }); } catch { /* best-effort */ }
      } else if (fresh.length && !opts.leaveChanges) {
        process.stderr.write(
          `shipyard-data archive-sprint: ${fresh.length} project file(s) changed during this review and are not committed: ${fresh.join(", ")}.\n` +
          `  If the review wrote them (the owner's decisions, a doc): commit exactly those paths — git add -- <paths> && git commit -m "docs: <what was decided>".\n` +
          `  If it did not: shipyard-data stray set-aside --reason "<who or what>".\n` +
          `  To archive with them uncommitted on purpose: add --leave-changes "<why>".\n`
        );
        process.exit(3);
      }
      if (fresh.length) { try { logEvent(dataDir, "archive_with_uncommitted_changes", { sprint: sprintId, files: fresh.join(","), reason: String(opts.leaveChanges).slice(0, 200) }); } catch { /* best-effort */ } }
    }
  }

  if (existsSync(archiveDir)) {
    // --force path: remove the existing archive dir so the rename can
    // succeed. This is destructive; the operator asked for it explicitly.
    rmSync(archiveDir, { recursive: true, force: true });
  }

  mkdirSync(sprintsDir, { recursive: true });

  // Velocity is a cross-sprint input for `/ship-sprint` capacity planning.
  // Do this in the archive command, not in review/sprint prose, so every
  // successful archive path leaves the next sprint with the prior velocity.
  const velocityResult = recordSprintVelocity(dataDir, currentDir, sprintId);
  // F011: points per hour is recorded HERE and only here (AC-17), from the
  // event log, for a completed sprint that delivered points. A sprint without
  // claim/completion events gets no entry and no guessed rate (AC-3).
  const throughputResult = velocityResult.features.length > 0
    ? recordSprintThroughput(dataDir, sprintId, velocityResult.velocity, sprintEvents)
    : { recorded: false, reason: "no_delivered_features" };

  // 4.6: the archive leaves no story behind. A story the sprint still holds
  // as in-progress is either finished (its review verdict recommends approve
  // and the sprint is completed → done) or it is carried over (→ approved and
  // back on the backlog). Review prose used to own this and sometimes skipped
  // it; the next sprint then met in-progress stories no sprint held.
  const finalized = finalizeSprintStories(dataDir, currentDir, sprintId);
  // An idea whose fix was built in this sprint is done with (4.12.2): a
  // defect triaged with `fixed_by: <step>` whose step is done becomes
  // `landed`. Without this it sat in the backlog as an open idea, counted
  // against the grooming cap, and the owner was asked how to close a bug
  // that had been fixed two sprints earlier.
  try {
    const ideasDir = join(dataDir, "spec", "ideas");
    const self = fileURLToPath(import.meta.url);
    for (const n of readdirSync(ideasDir)) {
      if (!n.endsWith(".md")) continue;
      const fm = parseFrontmatter(readFileSync(join(ideasDir, n), "utf8"));
      const step = String(fm.fixed_by ?? "").replace(/^"|"$/g, "").trim();
      const status = String(fm.status ?? "").trim();
      if (!step || ["landed", "promoted", "graduated", "rejected"].includes(status)) continue;
      let stepDone = false;
      for (const sub of ["steps", "tasks", join("archive", "steps"), join("archive", "tasks")]) {
        let names = [];
        try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
        const f = names.find((x) => x.startsWith(`${step}-`));
        if (f && /^status:\s*done\b/m.test(readFileSync(join(dataDir, "spec", sub, f), "utf8"))) { stepDone = true; break; }
      }
      if (!stepDone) continue;
      const id = String(fm.id ?? n.split("-").slice(0, 2).join("-")).replace(/^"|"$/g, "").trim();
      spawnSync("node", [self, "idea", "set-status", id, "landed", "--data-dir", dataDir], { encoding: "utf8" });
    }
  } catch { /* best-effort: the archive itself must not fail on an idea file */ }

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

  if (throughputResult.recorded) {
    try {
      logEvent(dataDir, "sprint_throughput_recorded", {
        sprint: sprintId,
        points_per_hour: throughputResult.points_per_hour,
        active_hours: throughputResult.active_hours,
        points: throughputResult.points,
      });
    } catch {
      /* best-effort */
    }
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

  for (const f of finalized) {
    try { logEvent(dataDir, "sprint_story_finalized", { sprint: sprintId, story: f.id, to: f.to, by: "archive-sprint" }); } catch { /* best-effort */ }
  }
  // Leave the repository as it was found (4.9): this sprint's builder branches
  // and anchors are done with. Merged ones are deleted; the rest move under
  // refs/shipyard/archive/<sprint>/ where `git branch` does not list them and
  // their commits stay reachable. Before the drift sweep, so that one finds
  // nothing left to report.
  if (readSweepBranches(dataDir)) {
    try {
      const wt = sweepWorktrees(repoFor(dataDir), { owner: ownerOf(dataDir) });
      if (wt.removed.length || wt.kept.length) process.stderr.write(`archive-sprint: removed ${wt.removed.length} finished builder worktree(s)${wt.kept.length ? `; left ${wt.kept.length} with uncommitted changes: ${wt.kept.map((k) => k.path).join(", ")}` : ""}\n`);
      const swept = sweepBranches(repoFor(dataDir), { label: sprintId, owner: ownerOf(dataDir) });
      if (!swept.error && (swept.deleted || swept.archived || wt.removed.length)) {
        logEvent(dataDir, "branches_swept", { label: swept.label, deleted: swept.deleted, archived: swept.archived, skipped: swept.skipped, worktrees_removed: wt.removed.length, worktrees_kept: wt.kept.length, by: "archive-sprint" });
        if (swept.deleted || swept.archived) process.stderr.write(`archive-sprint: swept ${swept.deleted + swept.archived} Shipyard branch(es) — ${swept.deleted} already merged (deleted), ${swept.archived} kept under ${swept.refs_prefix}\n`);
      }
    } catch { /* best-effort — the archive itself already succeeded */ }
  }
  // Sweep whatever else drifted (epic roll-up, backlog rows for closed work).
  try {
    applyFixes(dataDir, findDrift(dataDir).filter((f) => f.fix));
  } catch { /* best-effort — the archive itself already succeeded */ }

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
  const featureIds = parseSprintFeatureIds(sprintContent);
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

/**
 * F011 AC-1/AC-2/AC-3: throughput = delivered points / active hours, where active
 * hours come from the shared activeTime() over the sprint's event window. The
 * window is [first, last] event tagged `sprint: <id>` (cursor ticks, task events);
 * every event inside it counts, because worker_queue_claimed/completed carry no
 * sprint field, and builder claims between ticks are exactly the time that must
 * count as active. No claim or no completion in the window -> nothing recorded.
 */
export const THROUGHPUT_FORMULA =
  "points_per_hour = delivered_points / active_hours; active_hours = activeTime(events in [first, last] event tagged sprint, gap 30 min; builder claim->completion and spawn->return spans count as active).activeMs / 3600000";

function recordSprintThroughput(dataDir, sprintId, points, events = null) {
  if (!events) {
    try {
      events = readEventsWithArchive(dataDir).events;
    } catch {
      return { recorded: false, reason: "events_unreadable" };
    }
  }
  const tagged = events.filter((e) => inSprintWindow(e, sprintId)).map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  if (tagged.length < 2) return { recorded: false, reason: "no_sprint_window" };
  const lo = Math.min(...tagged);
  const hi = Math.max(...tagged);
  const window = events.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= lo && t <= hi;
  });
  // A builder run is a queue claim, or (a sprint built in place has no queue)
  // a `builder-<step>` spawn; its end is a queue completion or a recorded
  // return. Before 4.17.2 only the queue counted, so a solo sprint recorded
  // no points per hour at all.
  const claims = window.filter((e) => e.type === "worker_queue_claimed" || isStepSpawn(e)).length;
  const completions = window.filter((e) => e.type === "worker_queue_completed" || e.type === "task_return_recorded").length;
  if (claims === 0 || completions === 0) return { recorded: false, reason: "no_claim_or_completion_events", claims, completions };
  const { activeMs } = activeTime(window);
  if (!(activeMs > 0) || !(Number(points) > 0)) return { recorded: false, reason: "no_active_time" };
  const activeHours = roundMetric(activeMs / 3600000);
  const pph = roundMetric(Number(points) / (activeMs / 3600000));
  const state = loadMetricsState(dataDir);
  const existing = state.throughput.recent.find((r) => r.sprint === sprintId);
  updateMetricAggregate(state.throughput, pph, existing?.points_per_hour);
  state.throughput.recent = state.throughput.recent.filter((r) => r.sprint !== sprintId);
  state.throughput.recent.push({
    sprint: sprintId,
    points: Number(points),
    active_hours: activeHours,
    points_per_hour: pph,
    formula: THROUGHPUT_FORMULA,
    recorded_at: new Date().toISOString(),
  });
  state.throughput.recent = sortSprintRecords(state.throughput.recent).slice(-10);
  writeMetricsState(dataDir, state);
  return { recorded: true, points: Number(points), points_per_hour: pph, active_hours: activeHours };
}

// The sprint's story list, by the one rule every reader shares (terminal-gate
// sprintStoryIds: `stories:` canonical / `features:` alias, inline or block,
// S###/F###/B### with letter-suffixed child ids kept). Returns { ids, raw }.
function parseSprintFeatureList(content) {
  return { ids: sprintStoryIds(content), raw: sprintStoryList(content).raw };
}

function parseSprintFeatureIds(content) {
  return parseSprintFeatureList(content).ids;
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
    // F011 AC-17: throughput.recent has exactly one writer, archive-sprint. The
    // retro used to write a wall-clock-minus-pauses figure under the same key,
    // so whichever ran last silently overwrote the other.
    if (kv.throughput !== undefined) {
      process.stderr.write(
        "shipyard-data metrics record-retro: throughput= is not accepted — points per hour is recorded once, by archive-sprint, from the event log. Drop the field.\n",
      );
      process.exit(2);
    }
    const state = loadMetricsState(dataDir);
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
  }).filter((e) => opts.all || ownedNames(projectRoot, [e.branch]).length === 1); // never another side's builder

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
    if (!opts.all) orphanedBranches = ownedNames(projectRoot, orphanedBranches);
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
      const raw = {};
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
        raw[k] = rawV;
      }
      if (type === "subagent_completed") {
        // F010 AC-1: same validation/omission rules as accept-return.
        for (const k of ["role", "model", "effort", "attempt", "tokens"]) delete fields[k];
        Object.assign(fields, dispatchAttributionFields(raw));
      }
      const dataDir = opts.dataDir || getDataDir();
      logEvent(dataDir, canonicalEventType(type), // v4: writers emit the new name; the log keeps history as written
         fields);
      break;
    }
  }
}

/**
 * `verify findings --wave <n> --tasks <T001,T002> --met <n> --partial <n>
 * --missing <n> --over-built <n>` — F010 AC-17. Emits `wave_verify_findings`
 * with counts only. Strict allowlist: any other flag (e.g. --text, --message)
 * is rejected, so finding text can never reach the event log.
 */
function verifyFindingsCmd(dataDir, args) {
  const fail = (msg) => {
    process.stderr.write(`shipyard-data verify findings: ${msg}\n`);
    process.exit(2);
  };
  const CLASS_FLAGS = { "--met": "MET", "--partial": "PARTIAL", "--missing": "MISSING", "--over-built": "OVER-BUILT" };
  const vals = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (flag !== "--wave" && flag !== "--tasks" && !(flag in CLASS_FLAGS)) {
      fail(`unknown argument "${flag}" (counts only; finding text is never accepted)`);
    }
    if (args[i + 1] === undefined) fail(`${flag} requires a value`);
    vals[flag] = args[i + 1];
  }
  const asCount = (flag, v) => {
    if (!/^\d+$/.test(v ?? "")) fail(`${flag} must be a non-negative integer`);
    return Number(v);
  };
  const wave = asCount("--wave", vals["--wave"]);
  const taskIds = (vals["--tasks"] ?? "").split(",").filter(Boolean);
  if (taskIds.length === 0) fail("--tasks <T001,T002,...> is required");
  // v4: a wave's units are steps (P###); builder/patch task ids (T###, T-P###, T-HOT1)
  // are accepted exactly as parseWaves reads them from SPRINT.md, so a wave that
  // carries a patch task can still record its verify outcome.
  for (const t of taskIds) if (!WAVE_UNIT_ID_RE.test(t)) fail(`invalid step id "${t}" — expected P### (or a builder task id such as T001 / T-P001)`);
  const classCounts = {};
  let total = 0;
  for (const [flag, name] of Object.entries(CLASS_FLAGS)) {
    classCounts[name] = asCount(flag, vals[flag] ?? "0");
    total += classCounts[name];
  }
  logEvent(dataDir, "wave_verify_findings", {
    wave,
    task_ids: taskIds.join(","),
    finding_count: total,
    met: classCounts.MET,
    partial: classCounts.PARTIAL,
    missing: classCounts.MISSING,
    over_built: classCounts["OVER-BUILT"],
  });
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
      `shipyard-data next-id: missing kind argument. Expected: stories|steps|tasks|ideas|epics (features|bugs alias stories)\n`,
    );
    process.exit(1);
  }

  // Map kind → {dir, prefix}. The dir is relative to <SHIPYARD_DATA>.
  // v4 (F022, terminology-v4 A-06 / D-6): kinds come from the vocabulary table.
  // `stories` (S###) replaces `features`/`bugs`, which are accepted as aliases;
  // `steps` (P###) is the builder unit; `tasks` (T###) is the new entity and
  // continues the counter past archived builder ids (IDEA-008 scan).
  const entityName = entityForNextIdKind(kind);
  const KIND_TABLE = Object.fromEntries(
    Object.entries(ENTITIES).map(([name, e]) => [e.nextIdKinds[0], { dir: join(...e.dir), prefix: e.prefix, name }]),
  );
  const entry = entityName ? KIND_TABLE[ENTITIES[entityName].nextIdKinds[0]] : undefined;
  if (!entry) {
    process.stderr.write(
      `shipyard-data next-id: unknown kind "${kind}". Expected one of: ${Object.keys(KIND_TABLE).join("|")} (features|bugs are aliases of stories)\n`,
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

  // One counter per project (after 4.0.6): a quick run takes its ids from the project's own counter, so a
  // record made in the run can come back to the project later without meeting an id that is already there.
  const idHome = homeOf(dataDir);
  const seqDir = join(idHome, entry.dir);
  if (idHome !== dataDir) mkdirSync(seqDir, { recursive: true });
  const seqPath = join(seqDir, ".id-seq");
  const lockPath = seqPath + ".lock";

  // Scan existing files to find the highest extant ID. Used as a fallback
  // when the seq file is missing or unreadable, AND as a safety floor — if
  // someone hand-creates an IDEA-999 file outside this allocator, we must
  // not hand out IDEA-500 on the next call. max(seq, scan) + 1 wins.
  //
  // The archive dir (`spec/archive/<kind>/`) is scanned too: archive-sprint
  // moves done task files there, so a stale `.id-seq` (observed: counter at
  // 90 while T091-T098 sat in the archive) would otherwise re-issue ids that
  // still exist in archived files, events and `(TNNN)` commit subjects.
  function scanMax() {
    let max = 0;
    // Match <prefix><digits> at the start of the filename. For prefixes
    // that end in `-` (IDEA-, B-) the separator is already in the prefix.
    // For bare-letter prefixes (F, E, T) we allow an optional separator.
    // Use a regex built from the prefix for safety.
    const escaped = entry.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escaped}0*(\\d+)`);
    for (const dir of [...new Set([dataDir, idHome])].flatMap((d) => [join(d, entry.dir), join(d, "spec", "archive", basename(entry.dir))])) {
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        const m = name.match(re);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
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
  // The link is Shipyard's, not the project's: keep it out of `git status`
  // with a repo-local exclude (nothing is added to the user's .gitignore).
  excludeFromGit(projectRoot, ".shipyard");
  process.stdout.write(linkPath + "\n");
}

/** Add a path to .git/info/exclude (repo-local, never committed). Best-effort. */
function excludeFromGit(projectRoot, relPath) {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const abs = isAbsolute(gitDir) ? gitDir : join(projectRoot, gitDir);
    const infoDir = join(abs, "info");
    mkdirSync(infoDir, { recursive: true });
    const p = join(infoDir, "exclude");
    const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (!cur.split(/\r?\n/).includes(relPath)) writeFileSync(p, cur + (cur.endsWith("\n") || cur === "" ? "" : "\n") + relPath + "\n", "utf8");
  } catch { /* no git or unwritable: harmless */ }
}

/**
 * Ensure <projectRoot>/.claude/settings.local.json has worktree.baseRef = "head".
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
  // Local settings, not the shared file: `.claude/settings.json` is tracked in
  // most repos, so writing it dirtied the user's tree and the readiness step
  // then committed it as 'wip: pre-sprint'. settings.local.json is merged by
  // Claude Code the same way and is excluded from git below (repo-local
  // exclude, nothing added to the user's .gitignore). A baseRef already set in
  // the shared file is honored as-is.
  const sharedPath = join(claudeDir, "settings.json");
  const settingsPath = join(claudeDir, "settings.local.json");
  try {
    const shared = existsSync(sharedPath) ? JSON.parse(readFileSync(sharedPath, "utf8")) : null;
    if (shared?.worktree?.baseRef === "head") {
      try { logEvent(getDataDir({ projectRoot, silent: true }), "worktree_baseref_ensured", { was: "head", now: "head", changed: false, file: "settings.json" }); } catch { /* best-effort */ }
      process.stdout.write(`worktree.baseRef already "head" — ${sharedPath}\n`);
      return;
    }
  } catch { /* unreadable shared settings: fall through to the local file */ }
  excludeFromGit(projectRoot, ".claude/settings.local.json");

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
 * `shipyard-data resolve-model <role> [--override <model>] [--subject <TID>] [--data-dir <path>]`
 * — the single deterministic answer to "which model/effort does this dispatch
 * use?". Prints exactly one line `model=<m> effort=<e>`; an empty value means
 * omit that field on the Agent call. Roles are the agent_effort roles.
 * `--override` replaces the model for the `think` role only (a `--think`
 * invocation override). Pure: reads config.md, writes nothing, emits no events
 * (the wrapper logs `dispatch_model_resolved`). Unknown role: exit 2.
 */
function resolveModel(args) {
  const { dataDir: dataDirOverride, rest } = extractDataDirFlag(args, "resolve-model");
  let role = null;
  let override = null;
  let subject = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--subject") {
      subject = rest[i + 1] ?? "";
      i++;
    } else if (rest[i].startsWith("--subject=")) {
      subject = rest[i].slice("--subject=".length);
    } else if (rest[i] === "--override") {
      override = rest[i + 1] ?? "";
      i++;
    } else if (rest[i].startsWith("--override=")) {
      override = rest[i].slice("--override=".length);
    } else if (role === null) {
      role = rest[i];
    }
  }
  const roles = Object.keys(ROLE_TIER);
  if (!role || !Object.hasOwn(ROLE_TIER, role)) {
    process.stderr.write(
      `shipyard-data resolve-model: unknown role "${role ?? ""}" — expected one of: ${roles.join(", ")}\n`,
    );
    process.exit(2);
  }
  if (override !== null && role !== "think") {
    process.stderr.write(`shipyard-data resolve-model: --override applies to the think role only\n`);
    process.exit(2);
  }
  const dataDir = dataDirOverride ?? getDataDir({ silent: true });
  let tier = ROLE_TIER[role];
  let ladder = null;
  let routed = null;
  if (subject !== null) {
    if (!subject) {
      process.stderr.write(`shipyard-data resolve-model: --subject requires a task id\n`);
      process.exit(2);
    }
    // v4.2 rules-first routing + the retry ladder, in one shared definition
    // (bin/model-for.mjs) that the agent-ledger hook also enforces at spawn.
    const t = tierFor(dataDir, role, subject, {
      onNoSprint: (sprintPath) => process.stderr.write(`shipyard-data resolve-model: warning: cannot read sprint id from ${sprintPath}; dispatch attempts counted as 0\n`),
    });
    tier = t.tier; ladder = t.ladder; routed = t.routed;
  }
  let model = override !== null ? normalizeLegacyModel(override) : readModelTier(dataDir, tier);
  if (model === "inherit") model = "";
  // Effort: the routed value (by size/risk) applies when agent_effort.<role> is
  // absent or still at the role default; a value the user CUSTOMIZED is a floor
  // that routing can only raise (never silently dropped — 4.3.0 code review).
  const configuredEffort = readAgentEffort(dataDir, role);
  const EFFORT_ORDER = ["low", "medium", "high"];
  const customized = configuredEffort !== "" && configuredEffort !== (ROLE_EFFORT_DEFAULT[role] ?? "");
  const effort = !routed ? configuredEffort
    : customized && EFFORT_ORDER.indexOf(configuredEffort) > EFFORT_ORDER.indexOf(routed.effort) ? configuredEffort
    : routed.effort;
  if (ladder === null) {
    process.stdout.write(`model=${model} effort=${effort}\n`);
    return;
  }
  process.stdout.write(
    `model=${model} effort=${effort} tier=${tier} attempt=${ladder.attempt} ladder=${ladder.exhausted ? "exhausted" : "ok"}${routed ? ` routed=${routed.tier}:${routed.effort}` : ""}\n`,
  );
  if (ladder.exhausted) process.exit(3);
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

/** A file that holds tests, by name (never by folder: helpers live beside tests). */
const TEST_FILE_RE = /(^|\/)(test_[^/]+\.[A-Za-z0-9]+|[^/]+_test\.[A-Za-z0-9]+|[^/]+\.(test|spec)\.[A-Za-z0-9]+|[^/]+Tests?\.(java|kt|kts|cs|swift|scala|groovy))$/;

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
  const { ids: featureIds, raw: featuresRaw } = parseSprintFeatureList(sprintContent);
  if (featureIds.length === 0) {
    process.stderr.write(`shipyard-data verify-ac-coverage: no feature ids parsed from SPRINT.md features: ${JSON.stringify(featuresRaw)} — nothing would be checked\n`);
    process.exit(3);
  }

  // Full sprint diff text (added + context lines) — markers may sit on either.
  const diff = gitCapture(["diff", `${base}..${head}`], projectRoot) || "";

  const orphans = [];
  const warnings = [];
  let checkedFeatures = 0;

  for (const fid of featureIds) {
    // Resolve the story file (S### under spec/stories/, legacy F###/B###).
    let featurePath = null;
    try {
      featurePath = findFeatureFile(dataDir, fid);
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

  // The other direction (4.15): every test has a scenario. A test file added
  // or changed in the sprint must carry a scenario id, or say why it has none
  // (`no-scenario: <reason>`). Only when the sprint has tagged scenarios at
  // all — a project that has not adopted ids is never blocked by this.
  const orphanTests = [];
  if (checkedFeatures > 0) {
    const names = (gitCapture(["diff", "--name-status", "--diff-filter=AMR", `${base}..${head}`], projectRoot) || "").split("\n").filter(Boolean)
      .map((l) => l.split("\t").pop());
    for (const file of names) {
      if (!TEST_FILE_RE.test(file)) continue;
      const text = gitCapture(["show", `${head}:${file}`], projectRoot);
      if (text == null) continue;
      if (!/\bAC-\d+\b/.test(text) && !/no-scenario:\s*\S/.test(text)) orphanTests.push(file);
    }
  }

  for (const w of warnings) process.stdout.write(`WARN ${w}\n`);
  if (orphans.length === 0 && orphanTests.length === 0) {
    process.stdout.write(`verify-ac-coverage: OK — ${checkedFeatures} feature(s) with tagged ACs fully covered in ${base}..${head}\n`);
    process.exit(0);
  }

  if (orphans.length) {
    process.stdout.write(`verify-ac-coverage: ${orphans.length} orphan AC(s) — no AC-<n> marker in ${base}..${head}:\n`);
    for (const o of orphans) process.stdout.write(`  - ${o}\n`);
  }
  if (orphanTests.length) {
    process.stdout.write(`verify-ac-coverage: ${orphanTests.length} orphan test file(s) — changed in ${base}..${head} with no scenario id (AC-<n>) and no \`no-scenario: <reason>\` line:\n`);
    for (const o of orphanTests) process.stdout.write(`  - ${o}\n`);
  }
  const enforce = readEnforceAcCoverage(dataDir);
  try {
    logEvent(dataDir, "ac_coverage_checked", { orphans: orphans.length, orphan_tests: orphanTests.length, checked_features: checkedFeatures, enforce });
  } catch { /* best-effort */ }
  if (enforce) {
    if (orphans.length) process.stdout.write("Add `// AC-<n>` / `# AC-<n>` markers (or the @AC-<n> tag in a test) for each orphan, or set execution.enforce_ac_coverage: false for advisory mode.\n");
    if (orphanTests.length) process.stdout.write("Give each orphan test file its scenario id (`AC-<n>`) or a `no-scenario: <reason>` line.\n");
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
  stampOwner(projectRoot, ref, ownerFor(projectRoot));
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
  // Only this side's builders (after 4.0.6): a quick run and the regular project build in one repository.
  const mine = ownerOf(dataDir);
  const keepRefs = ownedNames(projectRoot, keepRaw.split("\n").map((s) => s.trim()).filter(Boolean), mine);
  wtBranches.splice(0, wtBranches.length, ...ownedNames(projectRoot, wtBranches, mine));

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
      // a field is one line of text: a list of objects was logged as "[object Object],[object Object]"
      unintegrated_branches: unintegrated.join(","),
      dangling_tasks: dangling.map((r) => `${r.task}:${String(r.sha ?? "").slice(0, 10)}`).join(","),
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
  "stories",
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
  // 4.17: commands run side by side, so the running sprint needs an owner.
  // While /ship-execute or /ship-review holds the execution lock in another
  // session, nobody else rewrites this sprint; a planner drafts the next one.
  {
    const { sessionId, unverified } = resolveSessionIdentity([]);
    // only when both sides are known and differ: an unidentified caller is never locked out of its own sprint
    const exec = unverified ? null : runningBeside(dataDir, "planning", sessionId, unverified).find((b) => b.kind === "execution" && b.state === "held" && b.session_id);
    // After 4.0.0: "the running sprint" is one that has started. A sprint its
    // own planner is still writing (planned, never started, no execute cursor,
    // planning lock held by the caller) is not run by anybody: the execution
    // lock beside it belongs to something else (a single task, a hotfix). A
    // planner was stopped at its last step, 97 steps in, by such a lock.
    const mineToPlan = () => {
      try {
        const fm = parseFrontmatter(readFileSync(sprintPath, "utf8"));
        const started = String(fm.started_at ?? "").replace(/#.*$/, "").trim();
        if (String(fm.status ?? "").trim() !== "planned" || (started && started !== "null")) return false;
        if (existsSync(join(dataDir, "sprints", "current", "EXECUTE-CURSOR.md"))) return false;
        const plan = JSON.parse(readFileSync(join(dataDir, ".active-session.json"), "utf8"));
        return !!plan && !plan.cleared && plan.skill != null && String(plan.session_id ?? "") === String(sessionId);
      } catch { return false; }
    };
    if (exec && !mineToPlan()) {
      process.stderr.write(`shipyard-data sprint set: the current sprint is being run by ${exec.skill} in another session — it is read-only to everyone else.\n  To plan more work now, draft the next sprint (/ship-sprint writes it to sprints/next/); to change this one, stop that run first.\n`);
      process.exit(3);
    }
  }
  const content = readFileSync(sprintPath, "utf8");
  // F043 bypass guard: completed -> cancelled would skip the archive review gate.
  if (
    key === "status" &&
    String(value).trim().toLowerCase() === "cancelled" &&
    String(parseFrontmatter(content).status || "").trim().toLowerCase() === "completed"
  ) {
    process.stderr.write(
      "shipyard-data sprint set: refusing — a completed sprint cannot be cancelled (that would bypass the review gate)\n" +
      "  Run /ship-review to review it, or `shipyard-data archive-sprint <id> --unreviewed` to archive it knowingly (audited).\n",
    );
    process.exit(1);
  }
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
function sprintCheck(next = false) {
  const dataDir = getDataDir({ silent: true });
  // --next: the sprint drafted ahead (sprints/next/SPRINT-DRAFT.md), same parse
  const sprintPath = next ? join(dataDir, "sprints", "next", "SPRINT-DRAFT.md") : join(dataDir, "sprints", "current", "SPRINT.md");
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
  const ok = () => process.stdout.write(
    `✓ sprint check — ${waves.length} wave(s), ${total} task(s): ` +
      waves.map((w) => `W${w.wave}[${w.tasks.join(",")}]`).join(" ") +
      "\n",
  );
  if (next) { ok(); return; } // the sprint drafted ahead is gated when it is queued
  // 4.0: the running sprint's plan must still pass the plan gate after any
  // change to its waves. Extending a sprint rewrote the waves and ran only
  // this structure check: a step that needs the person at the start had been
  // pushed into wave 2 and nothing said so.
  // Only the plan's shape (order, overlap, width, the person rule): whether
  // each probe fails first is checked later, when a story enters the sprint.
  import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "plan-score.mjs")).href).then(async (m) => {
    let plan = [];
    try {
      const { readParallelPlan } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "config-read.mjs")).href);
      const s = readParallelPlan(dataDir) ? m.planScore(dataDir) : { problems: [] };
      plan = s.error ? [] : s.problems.filter((p) => !/no step file/.test(p));
    } catch { plan = []; }
    if (plan.length) {
      process.stderr.write("✗ sprint check FAILED — the waves parse, but the plan does not pass the plan gate:\n");
      for (const p of plan) process.stderr.write(`  - ${p}\n`);
      process.stderr.write("  See it whole: shipyard-data sprint plan-score\n");
      process.exit(3);
    }
    ok();
  });
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
 *   shipyard-data config set-model think inherit   ("" — omit model:, inherit session)
 */
const MODEL_TIERS = new Set(["think", "build", "light", "orchestrate"]);
const MODEL_VALUES = new Set(["fable", "opus", "sonnet", "haiku", "inherit"]);
const ORCHESTRATION_SKILL_NAMES = ["ship-execute", "ship-review", "ship-sprint", "ship-discuss"];
const AGENT_EFFORT_TIERS = new Set(["build", "build_trivial", "fixer", "operational", "operational_fix", "think", "coordinator", "simplifier"]);
const AGENT_EFFORT_VALUES = new Set(["low", "medium", "high", "inherit"]);

function isAllowedModelValue(value) {
  return MODEL_VALUES.has(value);
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
  // Test seam: lets tests sync orchestration frontmatter in a copy of skills/.
  if (process.env.SHIPYARD_PLUGIN_ROOT) return process.env.SHIPYARD_PLUGIN_ROOT;
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
      "shipyard-data config set-model: usage: config set-model <think|build|light|orchestrate> <fable|opus|sonnet|haiku|inherit>\n",
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
 * `shipyard-data config set-max-agents <n>` (v4.18) — the most agents alive
 * at once in this project (default 100). Writes `execution.max_agents` and
 * removes the retired `max_parallel_agents` line so one number is on record.
 */
function configSetMaxAgents(value, { dataDir: dataDirOverride } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write("shipyard-data config set-max-agents: usage: config set-max-agents <whole number, 1 or more>\n");
    process.exit(2);
  }
  const dataDir = dataDirOverride ?? getDataDir({ silent: true });
  const configPath = join(dataDir, "config.md");
  if (!existsSync(configPath)) {
    process.stderr.write(`shipyard-data config set-max-agents: no ${configPath} — run shipyard-data onboarding bootstrap first\n`);
    process.exit(1);
  }
  const content = readFileSync(configPath, "utf8");
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) {
    process.stderr.write("shipyard-data config set-max-agents: config.md has no frontmatter block — refusing\n");
    process.exit(1);
  }
  let [, open, block, close] = fmMatch;
  block = setFrontmatterNestedValue(block, "execution", "max_agents", String(n));
  block = block.split("\n").filter((l) => !/^\s+max_parallel_agents:/.test(l)).join("\n");
  const tmp = configPath + ".tmp";
  writeFileSync(tmp, open + block + close + content.slice(fmMatch[0].length), "utf8");
  renameSync(tmp, configPath);
  try { logEvent(dataDir, "config_max_agents_set", { value: n }); } catch { /* best-effort */ }
  process.stdout.write(`execution.max_agents: ${n}\n`);
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
    try { tutorialNote(opts.dataDir || getDataDir({ silent: true }), "refusal:task-return", { stream: "stderr" }); } catch { /* narration never changes the exit */ }
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
    output_tail: outputTail.trim() ? outputTail : "(no probe output was recorded with this return)",
    // Where the evidence is: the probe tail file when one was given, else this file.
    capture_file: kv["output-tail-file"] && existsSync(resolve(kv["output-tail-file"])) ? resolve(kv["output-tail-file"]) : join(returnsDir, `${taskId}.json`),
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
  // One command for the builder: the return also closes its queue item.
  const settled = settleFromReturn(dataDir, taskId, path);
  if (settled.settled) process.stderr.write(`task-return: queue item ${taskId} closed (${String(settled.task.artifact_status ?? status).toLowerCase()}) — no \`queue complete\` needed\n`);
  else if (settled.reason && settled.reason !== "no_claimed_item") process.stderr.write(`task-return: the return is recorded, but the queue item was not closed: ${settled.reason}\n`);
  process.stdout.write(path + "\n");
}

/**
 * Optional dispatch-attribution fields (F010 AC-1/3/4): role/model/effort
 * strings (200-char cap), attempt (F004 dispatch attempt, NOT queue
 * claim_attempt) and tokens as positive integers. Blank/zero/unknown/invalid
 * values are omitted so old readers and absent data stay valid.
 */
function dispatchAttributionFields(kv) {
  const out = {};
  for (const k of ["role", "model", "effort"]) {
    const v = typeof kv[k] === "string" ? kv[k].trim() : "";
    if (v && v.toLowerCase() !== "unknown") out[k] = v.slice(0, 200);
  }
  for (const k of ["attempt", "tokens"]) {
    const v = kv[k];
    if (typeof v === "string" && /^[0-9]+$/.test(v.trim())) {
      const n = Number.parseInt(v, 10);
      if (n > 0 && Number.isSafeInteger(n)) out[k] = n;
    }
  }
  return out;
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
 *     [role=<r> model=<m> effort=<e> attempt=<n> tokens=<n>] [--data-dir <path>]
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
  // Report every problem in one go: one refusal per missing argument cost a
  // real orchestrator three round trips per accepted step.
  const problems = [];
  if (!taskId || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(taskId)) problems.push(`invalid task id ${JSON.stringify(taskId)} — expected [A-Za-z][A-Za-z0-9_-]{0,63}`);
  if (!sprint) problems.push("sprint=<id> is required");
  if (!wave || !/^[0-9]+$/.test(wave)) problems.push("wave=<number> is required");
  if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) problems.push("commit=<7-40 hex sha> is required");
  if (problems.length) {
    process.stderr.write(
      `shipyard-data task accept-return: ${problems.join("; ")}\n` +
        "  Usage: step accept-return <step-id> sprint=<id> wave=<n> commit=<sha> [role=<r> model=<m> effort=<e> attempt=<n> tokens=<n>] [--data-dir <path>]\n",
    );
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
    ...dispatchAttributionFields(kv),
  });
  // A hotfix has no step: the work is recorded against the story itself (4.0).
  // The step status call refused a story id, and a live hotfix recorded its
  // completion by hand. The story's own status is the review's to change.
  const isStory = (() => {
    const has = (dir) => { try { return readdirSync(join(dataDir, "spec", dir)).some((n) => n.startsWith(`${taskId}-`) || n === `${taskId}.md`); } catch { return false; } };
    return !has("steps") && !has("tasks") && (has("stories") || has("features") || has("bugs"));
  })();
  if (isStory) {
    process.stdout.write(`story ${taskId} accepted complete return ${sha} (no step to close; its status changes at the review)\n`);
    return;
  }
  specStateCmd(dataDir, ["task", "set-status", taskId, "done"]);
  process.stdout.write(`task ${taskId} accepted complete return ${sha}\n`);
  // 4.0: did the builder stay inside the files its step declared? A note and
  // an event, never a refusal (see step-touched.mjs).
  import("./step-touched.mjs")
    .then((m) => m.reportOutsideTouches(dataDir, taskId, sha, { cwd: getProjectRoot(), sprint, base: /^[0-9a-fA-F]{7,40}$/.test(kv.base || "") ? kv.base : "" }))
    .catch(() => {});
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
    ...dispatchAttributionFields(kv),
  });
  specStateCmd(dataDir, ["task", "set-status", taskId, "done"]);
  process.stdout.write(`task ${taskId} accepted operational completion at ${sha}\n`);
}

/**
 * Does a project data dir hold real Shipyard state (as opposed to being an
 * empty shell)? Used by doctor to tell a fork/orphan apart from a legitimately
 * uninitialized dir. State = an event log or any allocated ID counter.
 */
/**
 * Does this never-initialized folder hold work that belongs in a real project? An id counter does, and so does
 * an event that records a record being made. A log that holds only what hooks note in passing (an agent
 * returned, a source was read) does not: after 4.0.2, on an install with many projects, every health check
 * listed a dozen other projects' folders as "phantom", told the session to merge them into this project, and
 * exited 1.
 */
function dirHoldsState(dir) {
  for (const kind of ["ideas", "bugs", "features", "stories", "epics", "tasks"]) {
    if (existsSync(join(dir, "spec", kind, ".id-seq"))) return true;
  }
  let text = "";
  try { text = readFileSync(join(dir, ".shipyard-events.jsonl"), "utf8").slice(0, 400000); } catch { return false; }
  return /"type":"(next_id_allocated|[a-z_]+_(added|captured|imported|promoted|created|pulled|status_changed))"/.test(text);
}

// dirLooksInitialized now lives in shipyard-resolver.mjs (imported above) so
// `ensureDataDirLink` can gate on the same predicate. Kept as one copy on
// purpose — duplicated resolver helpers have drifted here before.

/**
 * Find the task file for an id under `spec/tasks/`, or null. Task files are
 * named `<id>-<slug>.md` (occasionally bare `<id>.md`), so match by prefix.
 */
function findInDirs(dataDir, subdirs, id) {
  for (const sub of subdirs) {
    const dir = join(dataDir, "spec", sub);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    const hit = entries.find((name) => name === `${id}.md` || name.startsWith(`${id}-`));
    if (hit) return join(dir, hit);
  }
  return null;
}

/** v4: a builder unit is a P### step under spec/steps/ or a legacy T### under spec/tasks/. */
function findTaskFile(dataDir, id) {
  const live = STEP_ID_RE.test(String(id)) ? ["steps", "tasks"] : ["tasks", "steps"];
  // archive-sprint moves done records under spec/archive/<kind>/ — still a file.
  const dirs = [...live, join("archive", "steps"), join("archive", "tasks")];
  return findInDirs(dataDir, dirs, id) ?? findByAlias(dataDir, dirs, id);
}

/**
 * A migrated record keeps its old id in `aliases:` (T421 became P022). The
 * event log is never rewritten, so anything that goes from an event's id to a
 * file must be able to follow the alias.
 */
function findByAlias(dataDir, subdirs, id) {
  const needle = new RegExp(`^aliases:\\s*\\[[^\\]]*["']?${String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?[^\\]]*\\]`, "m");
  for (const sub of subdirs) {
    const dir = join(dataDir, "spec", sub);
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      try { if (needle.test(readFileSync(join(dir, name), "utf8").slice(0, 600))) return join(dir, name); } catch { /* unreadable */ }
    }
  }
  return null;
}

/**
 * Find the feature file for an id under `spec/features/`, or null. Feature
 * files follow the same `<id>-<slug>.md` convention as tasks.
 */
/** v4: a story is S### under spec/stories/, or a legacy F### (spec/features/) / B### (spec/bugs/). */
function findFeatureFile(dataDir, id) {
  return findInDirs(dataDir, ["stories", "features", "bugs"], id);
}
const findStoryFile = findFeatureFile;

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

// What every gate and board reads from a story, and nothing more (after 4.0.1). The list used to demand the
// score fields (rice_*), complexity, token_estimate and references too. A backlog in the owner's order has no
// scores, and a coarse story under an epic has none of the rest yet: on a real project 50 such stories gave 400
// "missing field" findings, and the one finding that mattered was the 401st.
const STORY_REQUIRED_KEYS = ["id", "title", "type", "epic", "status", "story_points", "dependencies", "created"];
const REGISTRY_ENTITY_RULES = {
  // v4 written directories first; the legacy dirs below keep their own rules.
  stories: {
    dir: join("spec", "stories"),
    idRe: /^S\d+[a-z]?$/,
    requiredKeys: STORY_REQUIRED_KEYS,
    allowEmpty: ["epic"],
    statusValues: Object.keys(FEATURE_TRANSITIONS),
  },
  steps: {
    dir: join("spec", "steps"),
    idRe: /^P\d+$/,
    requiredKeys: ["id", "title", "story", "status", "effort", "dependencies"],
    statusValues: ["pending", "in-progress", "done", "blocked", "needs-attention", "approved"],
  },
  features: {
    dir: join("spec", "features"),
    // Accepts child/sub-feature ids (F036a, F071d) — the documented split
    // convention in project-files/rules/shipyard-spec.md. Without the
    // optional letter, doctor reported real feature files as malformed.
    idRe: /^F\d+[a-z]?$/,
    requiredKeys: [
      "id", "title", "type", "epic", "status", "story_points", "complexity",
      "token_estimate", "rice_reach", "rice_impact", "rice_confidence",
      "rice_effort", "rice_score", "dependencies", "references", "created",
    ],
    // pre-v4 records list their builder units under `tasks:`, migrated ones under `steps:`.
    anyOfKeys: [["tasks", "steps"]],
    // `epic: ""` is the documented "no epic" state (the template default; the
    // backlog renders an "(no epic)" group), so presence is required but an
    // empty value is not a schema problem. Found by the v3.27.0 CLI e2e.
    allowEmpty: ["epic"],
    statusValues: Object.keys(FEATURE_TRANSITIONS),
  },
  tasks: {
    dir: join("spec", "tasks"),
    idRe: /^T[-A-Za-z0-9]*\d+$/,
    requiredKeys: ["id", "title", "status", "effort", "dependencies"],
    // A builder record names its owner as `feature`/`story`; a v4 standalone
    // task (land-now, spike, chore) carries `parent`, legitimately empty.
    anyOfKeys: [["feature", "story", "parent"]],
    statusValues: ["pending", "in-progress", "done", "blocked", "needs-attention", "approved", "open", "dropped"],
  },
  bugs: {
    dir: join("spec", "bugs"),
    idRe: /^B-?\d+$/,
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
  const allowEmpty = new Set(rules.allowEmpty ?? []);
  for (const key of rules.requiredKeys) {
    if (!(key in fm)) problems.push(`missing/empty field: ${key}`);
    else if (fm[key] === "" && !allowEmpty.has(key)) problems.push(`missing/empty field: ${key}`);
  }
  for (const group of rules.anyOfKeys ?? []) {
    if (!group.some((k) => k in fm)) problems.push(`missing field: one of ${group.join("|")}`);
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
    dataDir = opts.dataDir ?? getDataDir({ silent: true });
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

  // --- Current project: state that drifted when a cycle ended (4.6). ---
  try {
    for (const f of findDrift(dataDir)) {
      findings.push({ kind: "state-drift", detail: `${f.kind}: ${f.detail}`, hint: f.fix || f.move ? "Run `shipyard-data reconcile --fix` (repairs it through the typed verbs and logs state_reconciled)." : f.hint });
    }
  } catch { /* unreadable spec tree — the registry checks below report it */ }

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
      if (!eventMatches(ev, "patch_step_created")) continue;
      const id = ev.step ?? ev.task_id ?? ev.task;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // Pre-v4 logs carried placeholder ids (PATCH-R1, none); only a wave-unit id names a file.
      if (!WAVE_UNIT_ID_RE.test(String(id))) continue;
      if (!findTaskFile(dataDir, id)) {
        findings.push({
          kind: "dangling-patch-step",
          detail: `${ev.type} id=${id} has no spec/steps/${id}-*.md (or legacy spec/tasks/) file`,
          hint: `Write the missing step file (spec/steps/${id}-<slug>.md) — the dispatch path must create it before emitting patch_step_created.`,
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

  findings.push(...collectConfigErrors(dataDir));
  const configWarnings = collectConfigWarnings(dataDir);
  const emitWarnings = () => {
    for (const w of configWarnings) {
      process.stdout.write(`warning: [${w.kind}] ${w.detail} — ${w.hint}\n`);
    }
  };

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
    emitWarnings();
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
  emitWarnings();
  process.exit(1);
}

const COMMAND_SUMMARY = `(none) | init | onboarding <status|bootstrap> | with-lock <key> -- <cmd> | archive-sprint <sprint-id> [--force] [--unreviewed|--via-review] | metrics <record-retro|regenerate> ... [--data-dir <path>] | capacity [--points <P>] [--hours <H> | --until <time>] [--json] [--data-dir <path>] | migrate [--dry-run] [--reverse] [--data-dir <path>] | route-intake ... | discuss-queue <start|status|next|mark|decision|stop|clear> ... | discuss-questions <start|bind|add|revise|assume|next|answer|answer-bundle|answers|drop|sources|research|wait|status|pause|reset> ... | plugin-issue <add|list> ... | backlog board | infra <check|apply> [--json] | build-gate <status [--json]|check [--accept "<answer>"]> | sprint <set|check|plan-score|probes-at-base|needs-you|plan-dir|queue-next|promote-next> ... | tracker <pull|status|ack|plan|hold|outbox|link|unlink|synced|decided> ... | sources <list|suggest|add|remove|always|none> ... | version <add|list|show|set|clear|rename|remove|check|release> ... | risk <profile|score|drift> ... | route (--step|--task|--story|--role) ... | design <approve|check|status> ... | ui <doctor|screenshot|verify|rules> ... | agents <spawned|stopped|live|check> ... | review-pack [--sprint <id>] [--base <sha> --head <sha>] [--json] | reconcile [--fix] [--json] | patch-budget [--json] | stray <list|set-aside --reason "..."> [--json] | decide --question <q> --option <A=text> --option <B=text> [--facts-file <f>] [--stage <s>] [--subject <id>] [--json] | branches <status|sweep> [--label <name>] [--dry-run] [--json] | story-review <record|disposition|check> ... | init-sprint <sprint-id> [--data-dir <path>] | cursor <advance|pause|escalate|noop> ... | sprint <set|check [--next]|plan-dir|queue-next|promote-next> ... | task-return <task-id> k=v ... [--data-dir <path>] | events emit <type> [k=v ...] [--data-dir <path>] | next-id <kind> [--data-dir <path>] | link-data-dir [--force] | clean-worktrees [--dry-run] [--force] [--all] | ensure-worktree-baseref | ensure-shared-caches | resolve-isolation [--flag <true|false|worktree|none>] | resolve-model <role> [--override <model>] [--subject <task-id>] [--data-dir <path>] | resolve-refactor-scope | resolve-wave-caps | anchor-commit <task-id> <sha> [--data-dir <path>] | verify-wave-integrated | verify-ac-coverage [--base <sha>] [--head <sha>] | doctor [--full] | story <add|refine|set-status|set|add-ref|add-external-ref|add-dep|remove-dep|set-steps|clear-steps|record-proof|check-probes|check-scenarios|probe-command|assign-ac-ids> ... [--data-dir <path>]   (feature is an accepted alias) | backlog <add|remove|move|rank|set> ... [--data-dir <path>] | idea <capture|promote|set-status|triage|repair> ... [--data-dir <path>] | task <add|set-status|append-verify|accept-return|accept-operational> ... [--data-dir <path>] | draft <obsolete-research|set-sprint-status> ... [--data-dir <path>] | config <set-model|set-effort|set-isolation|set-max-agents|set> ... [--data-dir <path>] | lock <acquire|release|check|status> ... | scan-stubs <base>..<head> [--lang <x>] [--data-dir <path>] | verify <list|record|check|findings> ... | review plan <findings.json> [--out <path>] | queue <enqueue|claim|complete|fail|list|requeue-stale|retry-stale|park-stale> ... [--data-dir <path>] | readiness-check [--target-branch <b>] [--baseline-failing] | readiness-check --classify <path> ... | check-idea-backlog [--json] [--data-dir <path>] | report <time|cost|idle|boundary-share|stages> [--data-dir <path>] | quick <start [--tutorial [--sandbox]] <item>|pick <item>|next [--json]|finish|list [--json]|land <run> [--answer "…"]|drop <run> --reason "…"> | tutorial sandbox [--path <folder>] | tutorial sandbox --remove <folder>`;

/**
 * Asking a verb for help never runs it (4.13.6). `next-id steps --help`
 * allocated an id, and any other writer would have written: a flag a verb
 * does not know was simply ignored. Only arguments before a literal `--`
 * count, so a wrapped command's own `--help` (with-lock) is left alone.
 */
function helpRequested(argv) {
  const cut = argv.indexOf("--");
  return (cut === -1 ? argv : argv.slice(0, cut)).some((a) => a === "--help" || a === "-h");
}

function main() {
  const command = process.argv[2] ?? "";
  if (command && command !== "help" && !command.startsWith("-") && helpRequested(process.argv.slice(3))) {
    const lines = COMMAND_SUMMARY.split(" | ").filter((l) => l === command || l.startsWith(`${command} `));
    process.stdout.write(`shipyard-data ${command} — usage (nothing was run):\n`);
    for (const l of lines.length ? lines : [`${command} (no summary line; call it without arguments for its usage)`]) process.stdout.write(`  shipyard-data ${l}\n`);
    return;
  }
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
      const viaReview = rest.includes("--via-review");
      const unreviewed = rest.includes("--unreviewed");
      const lc = rest.indexOf("--leave-changes");
      const leaveChanges = lc !== -1 && rest[lc + 1] && !rest[lc + 1].startsWith("--") ? rest[lc + 1] : "";
      if (lc !== -1 && !leaveChanges) { process.stderr.write("shipyard-data archive-sprint: --leave-changes needs a reason\n"); process.exit(2); }
      const sprintId = rest.find((a, i) => !a.startsWith("--") && !(lc !== -1 && i === lc + 1));
      archiveSprint(sprintId, { force, viaReview, unreviewed, leaveChanges });
      break;
    }
    case "metrics": {
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "metrics");
      metricsCmd(rest, { dataDir: dataDirOverride });
      break;
    }
    case "capacity": {
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "capacity");
      capacityMain(dataDirOverride ?? getDataDir({ silent: true }), rest);
      break;
    }
    case "migrate": {
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "migrate");
      migrateMain(dataDirOverride ?? getDataDir({ silent: true }), rest);
      break;
    }
    case "discuss-queue":
    case "plugin-issue":
    case "infra":
    case "build-gate":
    case "discuss-questions":
    case "tracker":
    case "story-review":
    case "risk":
    case "route":
    case "design":
    case "design-system":
    case "ui":
    case "agents":
    case "review-pack":
    case "reconcile":
    case "stray":
    case "patch-budget":
    case "decide":
    case "branches":
    case "quick":
    case "tutorial":
    case "version":
    case "sources":
    case "route-intake": {
      // v4 intake verbs (F023 route-intake, F026 discuss-queue, F027 tracker)
      // live in their own leaf modules, loaded on demand like `report`.
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), command);
      const file = join(dirname(fileURLToPath(import.meta.url)), `${command}.mjs`);
      if (!existsSync(file)) {
        process.stderr.write(`shipyard-data ${command}: module ${file} is missing\n`);
        process.exit(1);
      }
      const dd = dataDirOverride ?? getDataDir({ silent: true });
      import(pathToFileURL(file).href).then(
        (mod) => mod.main(dd, rest),
      ).catch((err) => {
        process.stderr.write(`shipyard-data ${command}: ${err?.message ?? err}\n`);
        process.exit(typeof err?.exitCode === "number" ? err.exitCode : 1);
      });
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
    case "resolve-model": {
      resolveModel(process.argv.slice(3));
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
        sprintCheck(rest.includes("--next"));
      } else if (rest[0] === "needs-you") {
        // v4.0: whether the person is needed now, and what waits for them at the review
        const { dataDir: dd, rest: more } = extractDataDirFlag(rest.slice(1), "sprint needs-you");
        import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "person-steps.mjs")).href).then((m) => m.main(dd ?? getDataDir({ silent: true }), more));
      } else if (rest[0] === "person-check") {
        // v4.0: the person's own answer to a step's end-of-sprint (or start) check
        const { dataDir: dd, rest: more } = extractDataDirFlag(rest.slice(1), "sprint person-check");
        import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "person-steps.mjs")).href).then((m) => m.main(dd ?? getDataDir({ silent: true }), ["person-check", ...more]));
      } else if (rest[0] === "probes-at-base") {
        // v4.21: run each step's probe on today's code; one that already passes proves nothing
        const { dataDir: dd, rest: more } = extractDataDirFlag(rest.slice(1), "sprint probes-at-base");
        import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "probes-at-base.mjs")).href).then((m) => m.main(dd ?? getDataDir({ silent: true }), more));
      } else if (rest[0] === "plan-score") {
        // v4.19: how parallel the plan is, and what in it is later than it has to be
        const { dataDir: dd, rest: more } = extractDataDirFlag(rest.slice(1), "sprint plan-score");
        import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "plan-score.mjs")).href).then((m) => m.main(dd ?? getDataDir({ silent: true }), more));
      } else {
        // plan-dir | queue-next | promote-next (a sprint drafted ahead, 4.17)
        sprintAheadMain(getDataDir({ silent: true }), rest);
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
      } else if (rest[0] === "set-max-agents") {
        configSetMaxAgents(rest[1], { dataDir: dataDirOverride });
      } else if (rest[0] === "set") {
        // Generic allowlisted config.md fields outside the `models:` block
        // (currently just product-spec-path) route through spec-state-cli's
        // shared conventions (withLockfile, temp+rename, logEvent) rather
        // than a second copy of that machinery here.
        specStateCmd(dataDirOverride ?? getDataDir({ silent: true }), ["config", "set", ...rest.slice(1)]);
      } else {
        process.stderr.write(
          `shipyard-data config: unknown subcommand "${rest[0] ?? ""}". Expected: set-model <think|build|light|orchestrate> <fable|opus|sonnet|haiku|inherit> | set-effort <build|build_trivial|fixer|operational|operational_fix|think|coordinator|simplifier> <low|medium|high|inherit> | set-isolation <worktree|none> | set-max-agents <n> | set <key> <value>\n`,
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
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "doctor");
      doctor({ full: rest.includes("--full"), dataDir: dataDirOverride });
      break;
    }
    case "story":
    case "feature":
    case "bug":
    // `step` is NOT here: it shares the `task` case below so `step accept-return`
    // / `accept-operational` reach the gate functions (a duplicate case label
    // made them unreachable — found by the 4.3.0 code review).
    case "epic":
    case "backlog":
    case "idea": {
      // 4.0.1: the whole board as text, from its own leaf module
      if (command === "backlog" && process.argv[3] === "board") {
        const { dataDir: dd, rest: more } = extractDataDirFlag(process.argv.slice(4), "backlog board");
        import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "backlog-board.mjs")).href).then((m) => m.main(dd ?? getDataDir({ silent: true }), more));
        break;
      }
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
    case "step":
    case "task": {
      // v4: `step` is the canonical verb for a builder unit; `task` is accepted
      // for pre-v4 skill text and for the new task entity (spec-state routes).
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
        specStateCmd(dataDirOverride ?? getDataDir({ silent: true }), [command === "step" ? "step" : "task", ...rest]);
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
      if (process.argv[3] === "findings") {
        const { dataDir: findingsDir, rest } = extractDataDirFlag(process.argv.slice(4), "verify findings");
        verifyFindingsCmd(findingsDir ?? getDataDir({ silent: true }), rest);
        break;
      }
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
    case "report": {
      // `report <mode>` loads bin/report-<mode>.mjs. The mode is validated
      // against a strict slug before it reaches an import path.
      const { dataDir: dataDirOverride, rest } = extractDataDirFlag(process.argv.slice(3), "report");
      const rawMode = rest[0] ?? "";
      const mode = rawMode === "boundary-share" ? "idle" : rawMode; // alias
      const file = /^[a-z][a-z-]*$/.test(mode) ? join(dirname(fileURLToPath(import.meta.url)), `report-${mode}.mjs`) : null;
      if (!file || !existsSync(file)) {
        process.stderr.write(`shipyard-data report: unknown mode "${mode}". Expected: report <time|cost|idle|boundary-share|stages> [--data-dir <path>]\n`);
        process.exit(2);
      }
      const dd = dataDirOverride ?? getDataDir({ silent: true });
      import(pathToFileURL(file).href).then(
        (mod) => mod.reportMain(dd, rest.slice(1)),
      ).catch((err) => {
        process.stderr.write(`shipyard-data report ${mode}: ${err?.message ?? err}\n`);
        process.exit(1);
      });
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
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`shipyard-data — Shipyard's CLI-owned state and gates (one verb per line; each verb prints its own usage when called without arguments)\n\n`);
      for (const line of COMMAND_SUMMARY.split(" | ")) process.stdout.write(`  shipyard-data ${line}\n`);
      process.stdout.write(`\nAll verbs accept --data-dir <path> where listed. Docs: skills/*/references and UPGRADING.md.\n`);
      break;
    // For project-id / project-root use `node ${CLAUDE_PLUGIN_ROOT}/bin/shipyard-resolver.mjs project-hash|project-root`.
    default:
      process.stderr.write(`shipyard-data: unknown command "${command}". Run \`shipyard-data help\` for the list of verbs.\n`);
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
