#!/usr/bin/env node
/**
 * shipyard-logcap — tee a command's output to a rotating file in $TMPDIR.
 *
 * Cross-platform Node implementation. Skills invoke this as a bare command;
 * PATH lookup finds `shipyard-logcap` (sh wrapper) on Unix and
 * `shipyard-logcap.cmd` on Windows.
 *
 * Purpose: when a verification command is run live, the unfiltered stream
 * disappears the moment it passes through a grep or a live tail. If a
 * different signal is needed later, the only recourse is to re-run the
 * command — burning tokens, time, and device minutes. This tool wraps the
 * command, tees raw stdout+stderr to a rotating file in tmp, and propagates
 * the child's exit code. Re-analysis happens over the captured file via
 * `tail` and `grep` subcommands — no re-run required.
 *
 * This is dumb I/O plumbing. No log parsing, structured extraction, keyword
 * classification, or platform detection beyond what's needed to locate tmp.
 * The skill invoking this tool is the smart layer — it picks bounds based
 * on project context via the decision table in live-capture.md.
 *
 * Storage: $TMPDIR/shipyard/<project-hash>/<session>/<name>.log[.1][.2]...
 *   - project-hash via shipyard-resolver (worktree-aware; all worktrees of
 *     one project share one capture dir, matching plugin-data semantics).
 *   - session from $SHIPYARD_LOGCAP_SESSION (ship-execute sets it to
 *     <sprint>-wave-<N>) or per-shell-timestamp fallback.
 *
 * Usage:
 *   shipyard-logcap run <name> [--max-size S] [--max-files N] -- <command...>
 *   shipyard-logcap tail <name> [--filter <regex>] [--follow]
 *   shipyard-logcap grep <name> <pattern> [--context N]
 *   shipyard-logcap list [--project]
 *   shipyard-logcap path <name>
 *   shipyard-logcap probe
 *   shipyard-logcap prune [--older-than 24h]
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  getProjectHash,
  getProjectRoot,
  ShipyardResolverError,
} from "./shipyard-resolver.mjs";

// ─── Constants ──────────────────────────────────────────────────────────────

// Built-in safety fallback. Skills should always pick bounds explicitly via
// the decision table in live-capture.md; this exists only so the primitive
// doesn't crash if something upstream forgot. 500KB × 10 = 5MB ceiling.
const DEFAULT_MAX_SIZE = 500 * 1024;
const DEFAULT_MAX_FILES = 10;

// Minimum --max-size. Rationale: Node's child-process stdout pipe default
// is a 64 KB high-water mark, so individual data chunks can reach that
// size. When a single chunk exceeds --max-size we can't split it at an
// arbitrary byte without breaking text lines, so the file overflows the
// ceiling by up to one chunk. Setting the floor at 64 KB ensures the
// overflow is bounded to at most one chunk's worth — a well-understood
// size-based rotation semantic. Bounds tighter than this surprise users.
const MIN_MAX_SIZE = 64 * 1024;

// Capture name allowlist. Same shape as worktree name validation elsewhere
// in shipyard: first char alnum, 1-64 chars total, no path traversal, no
// reserved .lock suffix. Names become filenames on disk — strict by design.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_SUFFIXES = [".lock"];

// Breadcrumb log — one-line-per-event trail for `shipyard-context diagnose`.
// Capped at 1000 lines, rotated at 256KB. Errors here are swallowed; the
// breadcrumb must never break capture itself.
const BREADCRUMB_NAME = ".logcap.log";
const BREADCRUMB_MAX_LINES = 1000;
const BREADCRUMB_MAX_BYTES = 256 * 1024;

// ─── Error types ────────────────────────────────────────────────────────────

class LogcapError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "LogcapError";
    this.exitCode = exitCode;
  }
}

// ─── Path resolution ────────────────────────────────────────────────────────

/**
 * Return the per-project capture root:
 *   $TMPDIR/shipyard/<project-hash>/
 *
 * Uses the shared resolver for project-hash computation — same hash as
 * plugin-data, which is worktree-aware. Never duplicates resolver logic.
 */
function getProjectCaptureRoot() {
  let projectRoot;
  try {
    projectRoot = getProjectRoot();
  } catch (err) {
    if (err instanceof ShipyardResolverError) {
      throw new LogcapError(
        `shipyard-logcap: cannot resolve project root.\n${err.message}`,
      );
    }
    throw err;
  }
  const hash = getProjectHash(projectRoot);
  return join(tmpdir(), "shipyard", hash);
}

/**
 * Return the current session directory under the project capture root.
 * Session is $SHIPYARD_LOGCAP_SESSION if set (ship-execute sets it to
 * <sprint>-wave-<N>), otherwise a stable per-process timestamp.
 */
function getSessionDir(captureRoot) {
  let session = process.env.SHIPYARD_LOGCAP_SESSION;
  if (session) {
    // Sanitize: session names come from skill context and become directory
    // names. Same allowlist shape as capture names but longer limit.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session)) {
      throw new LogcapError(
        `shipyard-logcap: invalid SHIPYARD_LOGCAP_SESSION value. ` +
          `Must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}.`,
      );
    }
  } else {
    session = getFallbackSession();
  }
  return join(captureRoot, session);
}

/**
 * Fallback session when $SHIPYARD_LOGCAP_SESSION is unset. Uses a per-day
 * bucket (`session-YYYYMMDD`) instead of per-process so `run` and a
 * subsequent `list`/`tail`/`grep`/`path` in a different shell invocation
 * find each other. Same day → same session; cross-day → new bucket.
 * Skills that want tighter grouping (per-sprint-wave) set the env var.
 */
function getFallbackSession() {
  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  return `session-${ts}`;
}

/**
 * Validate a capture name. Names become filenames; strict allowlist prevents
 * path traversal, reserved suffixes, and shell-surprising characters.
 */
function validateName(name) {
  if (!name || typeof name !== "string") {
    throw new LogcapError("shipyard-logcap: <name> is required.");
  }
  if (!NAME_RE.test(name)) {
    throw new LogcapError(
      `shipyard-logcap: invalid name "${name}". Must match ` +
        `[A-Za-z0-9][A-Za-z0-9._-]{0,63} (first char alnum, max 64 chars).`,
    );
  }
  for (const suffix of RESERVED_SUFFIXES) {
    if (name.endsWith(suffix)) {
      throw new LogcapError(
        `shipyard-logcap: name "${name}" uses reserved suffix "${suffix}".`,
      );
    }
  }
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new LogcapError(
      `shipyard-logcap: name "${name}" contains path separators or is reserved.`,
    );
  }
}

/** Resolve the live log file path for a capture name (not a rotated tail). */
function getLogPath(name) {
  validateName(name);
  const captureRoot = getProjectCaptureRoot();
  const sessionDir = getSessionDir(captureRoot);
  return join(sessionDir, `${name}.log`);
}

// ─── Size parsing ───────────────────────────────────────────────────────────

/**
 * Parse a human size string ("500K", "2M", "1G", or plain bytes) into bytes.
 * Used for --max-size and the built-in defaults.
 */
function parseSize(input) {
  if (typeof input === "number") return input;
  const match = /^(\d+)\s*([KMG]?)(B?)$/i.exec(String(input).trim());
  if (!match) {
    throw new LogcapError(
      `shipyard-logcap: invalid size "${input}". Expected NNN, NNNK, NNNM, or NNNG.`,
    );
  }
  const n = parseInt(match[1], 10);
  const unit = match[2].toUpperCase();
  const mult = unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
  return n * mult;
}

/** Format bytes back into a short human string for the banner. */
function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

/** Parse "24h", "7d", "30m" → ms. Used by prune. */
function parseDuration(input) {
  const match = /^(\d+)([smhd])$/.exec(String(input).trim());
  if (!match) {
    throw new LogcapError(
      `shipyard-logcap: invalid duration "${input}". Expected NNNs/m/h/d.`,
    );
  }
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const mult = unit === "d" ? 86400000 : unit === "h" ? 3600000 : unit === "m" ? 60000 : 1000;
  return n * mult;
}

// ─── Breadcrumbs ────────────────────────────────────────────────────────────

/**
 * Append a one-line event to the project's breadcrumb log. Errors swallowed.
 * Mirrors the .auto-approve.log pattern: tiny, capped, fail-quiet so
 * diagnostics never break capture itself.
 */
function writeBreadcrumb(action, details = {}) {
  try {
    const captureRoot = getProjectCaptureRoot();
    mkdirSync(captureRoot, { recursive: true });
    const crumb = join(captureRoot, BREADCRUMB_NAME);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action,
      ...details,
    }) + "\n";

    // Rotate if oversized. One-shot truncation to the last half of lines —
    // same approach as auto-approve-data.py, avoids a separate .1 file.
    if (existsSync(crumb)) {
      const size = statSync(crumb).size;
      if (size > BREADCRUMB_MAX_BYTES) {
        const content = readFileSync(crumb, "utf8");
        const lines = content.split("\n").filter(Boolean);
        const kept = lines.slice(-Math.floor(BREADCRUMB_MAX_LINES / 2));
        writeFileSync(crumb, kept.join("\n") + "\n");
      }
    }
    // Append. If the file doesn't exist, writeFileSync with flag "a" creates it.
    writeFileSync(crumb, line, { flag: "a" });
  } catch {
    // Diagnostics are best-effort — never let breadcrumb failures break capture.
  }
}

// ─── Rotation ───────────────────────────────────────────────────────────────

/**
 * Rename chain: <name>.log.N-1 → <name>.log.N, ..., <name>.log → <name>.log.1.
 * Drop anything past maxFiles. Called when the live file size exceeds maxSize.
 *
 * This is the only "complex" disk operation in the run loop. It runs in the
 * single writer process (one shipyard-logcap per capture name), so in-process
 * synchronization is sufficient — no cross-process lock file. If the user
 * invokes two concurrent `run` calls with the same name, output will
 * interleave regardless of any locking, and that's already documented as
 * unsupported in live-capture.md.
 */
function rotate(logPath, maxFiles) {
  // Drop the oldest, if any.
  const oldest = `${logPath}.${maxFiles - 1}`;
  if (existsSync(oldest)) {
    try {
      rmSync(oldest);
    } catch (err) {
      throw new Error(`cannot remove oldest rotated file ${oldest}: ${err.message}`);
    }
  }
  // Shift each .N → .N+1 from highest to lowest.
  for (let i = maxFiles - 2; i >= 1; i--) {
    const src = `${logPath}.${i}`;
    const dst = `${logPath}.${i + 1}`;
    if (existsSync(src)) {
      renameSync(src, dst);
    }
  }
  // Finally, live file → .1
  if (existsSync(logPath)) {
    renameSync(logPath, `${logPath}.1`);
  }
}

// ─── Subcommand: run ────────────────────────────────────────────────────────

/**
 * Spawn a command, tee its stdout+stderr to a rotating capture file and the
 * parent's corresponding streams, and exit with the child's exit code.
 */
async function cmdRun(args) {
  // Split at `--`. Everything before is logcap options; everything after is
  // the user's command.
  const sep = args.indexOf("--");
  if (sep === -1) {
    throw new LogcapError(
      `shipyard-logcap run: missing \`--\` separator before the command.\n` +
        `Usage: shipyard-logcap run <name> [--max-size S] [--max-files N] -- <command...>`,
    );
  }
  const logcapArgs = args.slice(0, sep);
  const cmdArgs = args.slice(sep + 1);
  if (cmdArgs.length === 0) {
    throw new LogcapError("shipyard-logcap run: no command given after `--`.");
  }

  const opts = parseRunOptions(logcapArgs);

  // Resolve paths. Fail-loud if resolver can't find project.
  const logPath = getLogPath(opts.name);
  mkdirSync(dirname(logPath), { recursive: true });

  // Startup banner → stderr so it doesn't pollute the child's stdout.
  process.stderr.write(
    `logcap: ${logPath}\n` +
      `logcap: bounds ${formatSize(opts.maxSize)} × ${opts.maxFiles} ` +
      `(session: ${basename(dirname(logPath))})\n`,
  );

  writeBreadcrumb("run_start", {
    name: opts.name,
    session: basename(dirname(logPath)),
    command: cmdArgs[0],
    max_size: opts.maxSize,
    max_files: opts.maxFiles,
  });

  // Open the live file in append mode and seed `written` from the current
  // on-disk size. Append mode may attach to an existing file from a prior
  // run within the same session (same day, same SHIPYARD_LOGCAP_SESSION),
  // so size can be >0 here; a freshly-created file reports 0. Track bytes
  // in-process from here on so we don't statSync on every write (hot path).
  let fd = openSync(logPath, "a");
  let written = statSync(logPath).size;

  function teeChunk(chunk, parentStream) {
    // Forward to parent stream first — live view is the user's source of
    // truth for watching progress. Even if the file write fails, the live
    // stream stays intact.
    try {
      parentStream.write(chunk);
    } catch {
      // Parent stream closed (pipe broken upstream). Continue capturing to
      // the file; don't let a closed pipe kill the wrapped command.
    }

    // Rotate if this chunk would exceed maxSize.
    if (written + chunk.length > opts.maxSize) {
      try {
        closeSync(fd);
      } catch {
        // Already closed; ignore.
      }
      try {
        rotate(logPath, opts.maxFiles);
      } catch (err) {
        // Rotation failure is non-fatal. Log a warning and keep trying to
        // write — losing capture is always worse than killing the run.
        writeBreadcrumb("rotate_failed", {
          name: opts.name,
          error: err.message,
        });
        process.stderr.write(
          `logcap: warning: rotation failed (${err.message}); capture may grow unbounded\n`,
        );
      }
      try {
        fd = openSync(logPath, "a");
        written = 0;
      } catch (err) {
        writeBreadcrumb("reopen_failed", {
          name: opts.name,
          error: err.message,
        });
        process.stderr.write(
          `logcap: warning: cannot reopen capture file (${err.message}); further output not captured\n`,
        );
        fd = -1;
        return;
      }
    }

    // Append to file.
    if (fd !== -1) {
      try {
        writeSync(fd, chunk);
        written += chunk.length;
      } catch (err) {
        writeBreadcrumb("write_failed", {
          name: opts.name,
          error: err.message,
        });
        process.stderr.write(
          `logcap: warning: write failed (${err.message}); capture may be incomplete\n`,
        );
      }
    }
  }

  // Spawn child. stdin is inherited so interactive programs still work;
  // stdout/stderr are piped so we can tee them.
  const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
    stdio: ["inherit", "pipe", "pipe"],
  });

  child.on("error", (err) => {
    // Usually ENOENT — command not found. Fail loud with a clear message.
    writeBreadcrumb("spawn_failed", {
      name: opts.name,
      command: cmdArgs[0],
      error: err.message,
    });
    process.stderr.write(`logcap: failed to spawn "${cmdArgs[0]}": ${err.message}\n`);
    try {
      if (fd !== -1) closeSync(fd);
    } catch {}
    process.exit(127);
  });

  child.stdout.on("data", (chunk) => teeChunk(chunk, process.stdout));
  child.stderr.on("data", (chunk) => teeChunk(chunk, process.stderr));

  // Forward signals to child so Ctrl-C propagates cleanly.
  const forward = (signal) => {
    if (!child.killed) {
      try {
        child.kill(signal);
      } catch {}
    }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGHUP", () => forward("SIGHUP"));

  // Wait for child to exit and propagate its exit code.
  // Note: on Windows, `signal` is typically null because real POSIX signals
  // aren't delivered — children usually exit with a numeric code instead.
  // The signal path below is therefore mostly POSIX behavior; on Windows,
  // we fall through to the numeric-code branch which is what we want.
  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        const SIGNAL_NUMS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };
        resolve(128 + (SIGNAL_NUMS[signal] ?? 0));
      } else {
        resolve(code ?? 0);
      }
    });
  });

  try {
    if (fd !== -1) closeSync(fd);
  } catch {}

  writeBreadcrumb("run_end", {
    name: opts.name,
    exit: exitCode,
    bytes: written,
  });

  process.exit(exitCode);
}

/** Parse run-specific options (everything before `--`). */
function parseRunOptions(args) {
  if (args.length === 0) {
    throw new LogcapError("shipyard-logcap run: <name> is required.");
  }
  const name = args[0];
  let maxSize = DEFAULT_MAX_SIZE;
  let maxFiles = DEFAULT_MAX_FILES;

  // Env-var overrides come between defaults and CLI flags.
  if (process.env.SHIPYARD_LOGCAP_MAX_SIZE) {
    maxSize = parseSize(process.env.SHIPYARD_LOGCAP_MAX_SIZE);
  }
  if (process.env.SHIPYARD_LOGCAP_MAX_FILES) {
    maxFiles = parseInt(process.env.SHIPYARD_LOGCAP_MAX_FILES, 10);
    if (!Number.isFinite(maxFiles) || maxFiles < 1) {
      throw new LogcapError(
        `shipyard-logcap: invalid SHIPYARD_LOGCAP_MAX_FILES value.`,
      );
    }
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--max-size") {
      maxSize = parseSize(args[++i]);
    } else if (arg === "--max-files") {
      maxFiles = parseInt(args[++i], 10);
      if (!Number.isFinite(maxFiles) || maxFiles < 1) {
        throw new LogcapError(`shipyard-logcap: --max-files must be a positive integer.`);
      }
    } else {
      throw new LogcapError(`shipyard-logcap run: unknown option "${arg}".`);
    }
  }

  if (maxSize < MIN_MAX_SIZE) {
    throw new LogcapError(
      `shipyard-logcap: --max-size must be at least ${MIN_MAX_SIZE} bytes (64K). ` +
        `Smaller bounds are unsafe because Node's child-process pipe can deliver ` +
        `chunks up to this size, and we can't split a chunk mid-text without breaking ` +
        `lines — so any bound below 64K is silently overflowed by the first chunk.`,
    );
  }

  return { name, maxSize, maxFiles };
}

// ─── Subcommand: tail ───────────────────────────────────────────────────────

/**
 * Stream a capture file, optionally with a read-side regex filter and/or
 * follow mode. Capture itself is always unfiltered — filter is a view.
 */
async function cmdTail(args) {
  if (args.length === 0) {
    throw new LogcapError("shipyard-logcap tail: <name> is required.");
  }
  const name = args[0];
  let filter = null;
  let follow = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--filter") {
      filter = new RegExp(args[++i]);
    } else if (args[i] === "--follow" || args[i] === "-f") {
      follow = true;
    } else {
      throw new LogcapError(`shipyard-logcap tail: unknown option "${args[i]}".`);
    }
  }

  const logPath = getLogPath(name);
  if (!existsSync(logPath)) {
    throw new LogcapError(
      `shipyard-logcap tail: no capture named "${name}" in this session.\n` +
        `Run \`shipyard-logcap list\` to see available captures.`,
    );
  }

  // Stream existing content line-by-line.
  await streamFileLines(logPath, filter);

  if (!follow) return;

  // Follow mode: poll the file for growth. Simple polling beats fs.watch
  // portability headaches; captures are low-frequency enough for a 250ms
  // tick to be invisible.
  //
  // Partial-line handling: the producer may flush a write that ends mid-line,
  // and the next write completes it. We mustn't emit that partial line as a
  // complete line or the filter regex will see torn input. Buffer any
  // trailing fragment (the bytes after the last '\n') between ticks and
  // prepend it to the next read.
  let pos = statSync(logPath).size;
  let residual = "";
  setInterval(() => {
    try {
      const st = statSync(logPath);
      if (st.size > pos) {
        const buf = readFileSync(logPath).subarray(pos, st.size);
        const text = residual + buf.toString("utf8");
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline === -1) {
          // No complete line yet — keep buffering.
          residual = text;
        } else {
          const complete = text.slice(0, lastNewline);
          residual = text.slice(lastNewline + 1);
          for (const line of complete.split("\n")) {
            if (!filter || filter.test(line)) process.stdout.write(line + "\n");
          }
        }
        pos = st.size;
      } else if (st.size < pos) {
        // Rotated — flush any residual as a final line then restart.
        if (residual.length > 0) {
          if (!filter || filter.test(residual)) process.stdout.write(residual + "\n");
          residual = "";
        }
        pos = 0;
      }
    } catch {
      // File gone (pruned or rotated mid-read); stop silently.
    }
  }, 250);
}

function streamFileLines(path, filter) {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(path);
    rs.on("error", reject);
    const rl = createInterface({ input: rs });
    rl.on("line", (line) => {
      if (!filter || filter.test(line)) process.stdout.write(line + "\n");
    });
    rl.on("close", resolve);
  });
}

// ─── Subcommand: grep ───────────────────────────────────────────────────────

/**
 * Post-hoc search across the live file AND all rotated tails. Iterates
 * newest-first so the most recent output appears at the top of the results.
 */
async function cmdGrep(args) {
  if (args.length < 2) {
    throw new LogcapError(
      "shipyard-logcap grep: usage: grep <name> <pattern> [--context N]",
    );
  }
  const name = args[0];
  const pattern = new RegExp(args[1]);
  let context = 0;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--context" || args[i] === "-C") {
      context = parseInt(args[++i], 10);
      if (!Number.isFinite(context) || context < 0) {
        throw new LogcapError("shipyard-logcap grep: --context must be a non-negative integer.");
      }
    } else {
      throw new LogcapError(`shipyard-logcap grep: unknown option "${args[i]}".`);
    }
  }

  const logPath = getLogPath(name);
  if (!existsSync(logPath)) {
    throw new LogcapError(
      `shipyard-logcap grep: no capture named "${name}" in this session.`,
    );
  }

  // Gather files newest-first: live, then .1, .2, ...
  const files = [logPath];
  for (let i = 1; i < 100; i++) {
    const rotated = `${logPath}.${i}`;
    if (!existsSync(rotated)) break;
    files.push(rotated);
  }

  let matchCount = 0;
  for (const file of files) {
    const content = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < content.length; i++) {
      if (pattern.test(content[i])) {
        if (context > 0) {
          const start = Math.max(0, i - context);
          const end = Math.min(content.length, i + context + 1);
          process.stdout.write(
            `── ${basename(file)}:${i + 1} ────────────────\n`,
          );
          for (let j = start; j < end; j++) {
            const marker = j === i ? ">" : " ";
            process.stdout.write(`${marker} ${content[j]}\n`);
          }
        } else {
          process.stdout.write(`${basename(file)}:${i + 1}: ${content[i]}\n`);
        }
        matchCount++;
      }
    }
  }

  process.exit(matchCount > 0 ? 0 : 1);
}

// ─── Subcommand: list ───────────────────────────────────────────────────────

function cmdList() {
  const captureRoot = getProjectCaptureRoot();
  if (!existsSync(captureRoot)) {
    process.stdout.write("(no captures for this project)\n");
    return;
  }

  const sessions = readdirSync(captureRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (sessions.length === 0) {
    process.stdout.write("(no captures for this project)\n");
    return;
  }

  for (const session of sessions) {
    const sessionDir = join(captureRoot, session);
    const files = readdirSync(sessionDir)
      .filter((f) => f.endsWith(".log"))
      .sort();
    if (files.length === 0) continue;
    process.stdout.write(`${session}/\n`);
    for (const f of files) {
      const st = statSync(join(sessionDir, f));
      const rotatedCount = readdirSync(sessionDir).filter((n) =>
        n.startsWith(f + "."),
      ).length;
      const tail = rotatedCount > 0 ? ` (+${rotatedCount} rotated)` : "";
      process.stdout.write(
        `  ${f.padEnd(32)} ${formatSize(st.size).padStart(6)}${tail}\n`,
      );
    }
  }
}

// ─── Subcommand: path ───────────────────────────────────────────────────────

function cmdPath(args) {
  if (args.length === 0) {
    throw new LogcapError("shipyard-logcap path: <name> is required.");
  }
  const logPath = getLogPath(args[0]);
  process.stdout.write(logPath + "\n");
}

// ─── Subcommand: probe ──────────────────────────────────────────────────────

/**
 * Print platform facts relevant to deciding bounds. Skills call this when
 * they want to sanity-check free space before picking a generous --max-size.
 */
function cmdProbe() {
  const tmp = tmpdir();
  let projectHash = "(resolver error)";
  let projectRoot = "(resolver error)";
  try {
    projectRoot = getProjectRoot();
    projectHash = getProjectHash(projectRoot);
  } catch (err) {
    if (!(err instanceof ShipyardResolverError)) throw err;
  }

  let tmpType = "(unknown)";
  if (platform() === "linux") {
    try {
      const mounts = readFileSync("/proc/mounts", "utf8");
      // Find the longest mount point that is a prefix of tmp.
      let best = { path: "", fs: "unknown" };
      for (const line of mounts.split("\n")) {
        const parts = line.split(/\s+/);
        if (parts.length < 3) continue;
        const mnt = parts[1];
        const fs = parts[2];
        if (tmp === mnt || tmp.startsWith(mnt + "/")) {
          if (mnt.length > best.path.length) best = { path: mnt, fs };
        }
      }
      if (best.fs) tmpType = best.fs;
    } catch {
      // /proc/mounts not readable; leave as unknown.
    }
  } else if (platform() === "darwin") {
    tmpType = "apfs (per-user, disk-backed)";
  } else if (platform() === "win32") {
    tmpType = "ntfs (disk-backed)";
  }

  // Free space — best effort via statfsSync if the Node runtime supports it.
  // statfsSync landed in Node 18.15+; on older runtimes the import resolves
  // to undefined and we skip quietly rather than fail the whole probe.
  let freeBytes = null;
  try {
    if (typeof statfsSync === "function") {
      const st = statfsSync(tmp);
      freeBytes = Number(st.bavail) * Number(st.bsize);
    }
  } catch {
    // No statfs on this path — leave null.
  }

  process.stdout.write(`project_root: ${projectRoot}\n`);
  process.stdout.write(`project_hash: ${projectHash}\n`);
  process.stdout.write(`tmp_dir:      ${tmp}\n`);
  process.stdout.write(`tmp_type:     ${tmpType}\n`);
  if (freeBytes !== null) {
    process.stdout.write(`tmp_free:     ${formatSize(freeBytes)}\n`);
  } else {
    process.stdout.write(`tmp_free:     (unavailable)\n`);
  }
  const captureRoot = join(tmp, "shipyard", projectHash);
  process.stdout.write(`capture_root: ${captureRoot}\n`);

  // Print the session the primitive would USE for a new `run` right now.
  // If SHIPYARD_LOGCAP_SESSION is set but invalid, don't echo the bad value
  // (avoids leaking control chars / attacker-controlled strings into probe
  // output that might be pasted into bug reports). Run it through the same
  // allowlist `getSessionDir` uses, and mark it invalid on mismatch.
  const sessionEnv = process.env.SHIPYARD_LOGCAP_SESSION;
  let session;
  if (sessionEnv) {
    session = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionEnv)
      ? sessionEnv
      : "(invalid — rejected by SHIPYARD_LOGCAP_SESSION allowlist)";
  } else {
    session = getFallbackSession();
  }
  process.stdout.write(`session:      ${session}\n`);
}

// ─── Subcommand: prune ──────────────────────────────────────────────────────

function cmdPrune(args) {
  let olderThan = "24h";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--older-than") {
      olderThan = args[++i];
    } else {
      throw new LogcapError(`shipyard-logcap prune: unknown option "${args[i]}".`);
    }
  }
  const olderThanMs = parseDuration(olderThan);

  const captureRoot = getProjectCaptureRoot();
  if (!existsSync(captureRoot)) {
    process.stdout.write("(nothing to prune)\n");
    return;
  }

  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const entry of readdirSync(captureRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = join(captureRoot, entry.name);
    const st = statSync(sessionDir);
    if (st.mtimeMs < cutoff) {
      try {
        rmSync(sessionDir, { recursive: true, force: true });
        removed++;
      } catch (err) {
        process.stderr.write(`logcap: cannot remove ${sessionDir}: ${err.message}\n`);
      }
    }
  }
  process.stdout.write(`pruned ${removed} session(s) older than ${olderThan}\n`);
}

// ─── CLI dispatch ───────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);

  try {
    switch (subcommand) {
      case "run":
        await cmdRun(rest);
        return;
      case "tail":
        await cmdTail(rest);
        return;
      case "grep":
        await cmdGrep(rest);
        return;
      case "list":
        cmdList();
        return;
      case "path":
        cmdPath(rest);
        return;
      case "probe":
        cmdProbe();
        return;
      case "prune":
        cmdPrune(rest);
        return;
      default:
        process.stderr.write(`shipyard-logcap: unknown subcommand "${subcommand}".\n`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof LogcapError) {
      process.stderr.write(err.message + "\n");
      process.exit(err.exitCode);
    }
    throw err;
  }
}

function printHelp() {
  process.stderr.write(
    `shipyard-logcap — tee a command's output to a rotating file in tmp\n\n` +
      `Usage:\n` +
      `  shipyard-logcap run <name> [--max-size S] [--max-files N] -- <command...>\n` +
      `  shipyard-logcap tail <name> [--filter <regex>] [--follow]\n` +
      `  shipyard-logcap grep <name> <pattern> [--context N]\n` +
      `  shipyard-logcap list\n` +
      `  shipyard-logcap path <name>\n` +
      `  shipyard-logcap probe\n` +
      `  shipyard-logcap prune [--older-than 24h]\n\n` +
      `See skills/ship-execute/references/live-capture.md for the full guide.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`shipyard-logcap: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
