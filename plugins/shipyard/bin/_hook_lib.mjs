/**
 * Shared helpers for Shipyard hook scripts.
 *
 * Node port of `project-files/scripts/_hook_lib.py`. The two implementations
 * MUST stay behaviorally equivalent during the H1→H4 cutover. Tests in
 * `tests/test_hook_lib.mjs` exercise the same matrix as `test_hook_lib.py`.
 *
 * What lives here vs the individual hook modules:
 *
 * - `resolveShipyardData()` — single fallback pattern for when the
 *   `SHIPYARD_DATA` env var is unset. `hook-runner.mjs` usually sets it in
 *   production via `getDataDir({silent: true})`, but the resolver can throw
 *   silently and leave the env var empty; every hook then needs the same
 *   recovery path.
 * - `logBreadcrumb()` — uniform append-with-locking + rotation for hook log
 *   files. Every Shipyard hook log goes to `$SHIPYARD_DATA/.<name>.log`.
 * - `sanitizeForLog()` — strip control chars, cap length. Applied to any
 *   field that flows from user-controlled state (file paths, frontmatter,
 *   session-marker fields) before it ends up in a log line or hook stdout.
 *   Defends against indirect prompt injection and log-line forgery via
 *   embedded newlines.
 * - `dataDirContains()` — `path.relative`-based containment check that
 *   matches Python's `commonpath` behavior. More reliable than `startsWith`
 *   around trailing separators, Windows drive letters, and case-insensitive
 *   volumes.
 * - `atomicWrite()` — write-then-rename atomic file write. Writes to a
 *   sibling temp file in the destination directory (NOT `os.tmpdir()`) to
 *   ensure `fs.renameSync` stays atomic on Windows (same volume).
 * - `withLockfile()` — `O_EXCL` lockfile-based exclusion. Cross-platform
 *   replacement for Python's fcntl/msvcrt split. 30s default TTL with
 *   stale-lock recovery via mtime comparison.
 *
 * SECURITY: see CLAUDE.md "Hooks Are Attack Surface". Containment checks
 * use `realpath` + `path.relative`-startsWith-`..` rejection (NOT
 * `startsWith(base)` which is TOCTOU-exploitable). All identifiers (worktree
 * names, skill slugs) go through frozen RegExp constants. Breadcrumb fields
 * are sanitized before joining.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LOG_MAX_LINES = 1000;
const DEFAULT_LOG_MAX_BYTES = 256 * 1024;

// Structured event log (JSONL). Distinct from per-hook breadcrumb logs
// (.auto-approve.log, .session-guard.log) — this is the cross-cutting
// diagnostic timeline for `shipyard-context diagnose` and bug reports.
// Larger caps than breadcrumbs because users need enough history to
// reconstruct "what happened" during a sprint that failed hours ago.
export const EVENTS_LOG_NAME = ".shipyard-events.jsonl";
const DEFAULT_EVENTS_MAX_LINES = 5000;
const DEFAULT_EVENTS_MAX_BYTES = 1024 * 1024; // 1 MB

// Frozen identifier allowlists. Copied verbatim from the Python side.
export const WORKTREE_NAME_RE = Object.freeze(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
);
export const SKILL_SLUG_RE = Object.freeze(/^ship-[a-z0-9][a-z0-9-]{0,63}$/);
export const REFERENCE_NAME_RE = Object.freeze(
  /^[a-z0-9][a-z0-9._-]{0,63}$/,
);

/**
 * Best-effort plugin-root discovery when CLAUDE_PLUGIN_ROOT is unset.
 * `bin/_hook_lib.mjs` → `bin/` parent → plugin root.
 */
function pluginRootFromScript() {
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(here); // bin/ -> plugin root
}

/**
 * Return the Shipyard data directory, or '' if it cannot be determined.
 *
 * Priority: SHIPYARD_DATA env var → bin/shipyard-resolver.mjs in-process
 * import → empty string. Never hard-fails. Callers that need a data dir
 * must handle the empty return by exiting 0 (allow) — blocking a tool call
 * because we couldn't resolve our own state is worse than the permission
 * prompt the user was going to see anyway.
 */
export async function resolveShipyardData() {
  const envValue = process.env.SHIPYARD_DATA || "";
  if (envValue) return envValue;

  let pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || "";
  if (
    !pluginRoot ||
    !existsSync(join(pluginRoot, ".claude-plugin", "plugin.json"))
  ) {
    pluginRoot = pluginRootFromScript();
  }

  const resolverPath = join(pluginRoot, "bin", "shipyard-resolver.mjs");
  if (!existsSync(resolverPath)) return "";

  try {
    // Convert filesystem path to file:// URL for ESM import on all platforms.
    const url = "file://" + (isAbsolute(resolverPath) ? resolverPath : resolve(resolverPath));
    const mod = await import(url);
    if (typeof mod.getDataDir === "function") {
      try {
        const result = mod.getDataDir({ silent: true });
        return result || "";
      } catch {
        return "";
      }
    }
  } catch {
    // resolver import failed — fall through to empty
  }
  return "";
}

/**
 * Strip control characters and cap length.
 *
 * Applied to any field sourced from user-controlled state before it gets
 * written into a log line or emitted as hook stdout. Protects against
 * indirect prompt injection via file paths / frontmatter / session-marker
 * fields, and against log-line forgery via embedded newlines and ANSI
 * escapes.
 *
 * Mirrors the Python implementation byte-for-byte for ASCII inputs:
 *   - Plain space is preserved
 *   - All other control chars (\x00-\x1f, \x7f DEL) are stripped
 *   - Printable ASCII and most printable Unicode are preserved
 *   - Non-string inputs are coerced via String(...)
 *   - null/undefined → ''
 *   - Length cap appends ellipsis (…) when over max_len
 */
export function sanitizeForLog(value, maxLen = 256) {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  // Match Python: keep plain space + char.isprintable() (excluding DEL).
  // Python's isprintable returns True for letters, digits, punctuation,
  // and most Unicode printables; False for control chars (Cc), separators
  // other than U+0020, and surrogates. The closest JS equivalent is to
  // explicitly drop the C0 controls (\x00-\x1f), \x7f, and the C1 controls
  // (\x80-\x9f). Everything else passes through.
  let cleaned = "";
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === " ") {
      cleaned += ch;
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      continue; // strip control chars
    }
    cleaned += ch;
  }
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen) + "…";
  }
  return cleaned;
}

/**
 * Containment check: true iff `filePath` is inside `dataDir`.
 *
 * Both inputs should be absolute. Caller is responsible for realpath
 * resolution before calling — this function does NOT realpath internally
 * because the caller often needs the realpath result for other checks.
 *
 * Implementation uses path.relative + reject-on-`..`-or-absolute. This
 * matches Python's commonpath() behavior for the cases that matter:
 *   - file inside dir → true
 *   - file outside dir → false
 *   - sibling dir with shared string prefix (e.g. /foo and /foo-evil) → false
 *   - empty inputs → false
 *   - cross-volume on Windows → path.relative returns the absolute target,
 *     caught by the isAbsolute check
 *
 * Crucially we do NOT use `filePath.startsWith(dataDir)` — that's the
 * TOCTOU-exploitable form CLAUDE.md explicitly forbids.
 */
export function dataDirContains(filePath, dataDir) {
  if (!filePath || !dataDir) return false;
  try {
    const rel = relative(dataDir, filePath);
    if (!rel) return true; // same path
    if (rel.startsWith("..")) return false;
    if (isAbsolute(rel)) return false; // Windows cross-drive
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a log line with sanitization, locking, and rotation.
 *
 * Line format:
 *
 *     <iso-utc-timestamp> <decision> <field1> <field2> ...
 *
 * Every field is sanitized (control chars stripped, length capped) before
 * joining — no newlines, no ANSI, no log-line forgery via crafted
 * frontmatter. `dataDir` is created if missing so the first hook
 * invocation for a brand-new project still leaves a breadcrumb.
 *
 * Errors are swallowed: diagnostics must never break the hook itself.
 * Losing a log line is better than failing a tool call.
 *
 * Locking + rotation use a sibling `.lock` file via `withLockfile`. The
 * rotation block (read → truncate → rewrite) is racy without it on every
 * platform; one copy keeps both writes and rotation atomic.
 */
export function logBreadcrumb(
  dataDir,
  logName,
  decision,
  fields,
  opts = {},
) {
  const maxLines = opts.maxLines ?? DEFAULT_LOG_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES;

  if (!dataDir) return;
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    return;
  }

  const logPath = join(dataDir, logName);
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const parts = [ts, sanitizeForLog(decision, 32)];
  for (const field of fields) {
    parts.push(sanitizeForLog(field));
  }
  const line = parts.join(" ") + "\n";

  withLockfile(logPath + ".lock", () => {
    try {
      // Append the line
      let existing = "";
      try {
        existing = readFileSync(logPath, "utf8");
      } catch {
        existing = "";
      }
      let updated = existing + line;
      // Rotate if over byte cap AND over line cap
      if (Buffer.byteLength(updated, "utf8") > maxBytes) {
        const lines = updated.split("\n");
        if (lines.length > maxLines) {
          // Keep last `maxLines` non-empty lines
          const kept = lines.slice(-maxLines - 1); // -1 to keep trailing newline split
          updated = kept.join("\n");
        }
      }
      atomicWrite(logPath, updated);
    } catch {
      // swallow
    }
  });
}

/**
 * Append a structured event to the Shipyard event log.
 *
 * Events are stored as JSONL at `$SHIPYARD_DATA/.shipyard-events.jsonl`,
 * one JSON object per line:
 *
 *     {"ts":"<iso+00:00>","type":"<event_type>", ...fields}
 *
 * This is the cross-cutting diagnostic timeline. It is a passive artifact
 * on disk — nothing in the normal skill flow reads it, so emitting events
 * costs zero Claude tokens in steady state. Users query it on demand via
 * `shipyard-data events tail` or the `shipyard-context diagnose` dump.
 *
 * Design goals:
 *   1. Hooks emit events reliably. Skill bodies can too via
 *      `shipyard-data events emit`, but the authoritative signal is the
 *      hook-side event stream because Claude can forget to emit under
 *      context pressure.
 *   2. Writes are append-only with locking + byte-capped rotation. Same
 *      `withLockfile` + atomic-write strategy as `logBreadcrumb`.
 *   3. Errors are swallowed. Losing an event is strictly better than
 *      failing a tool call.
 *   4. Field values are sanitized (`sanitizeForLog`) before JSON encoding
 *      to block log-line forgery via embedded newlines / ANSI and indirect
 *      prompt injection via user-controlled paths / frontmatter.
 *
 * Caps are larger than per-hook breadcrumb logs (5000 lines / 1 MB) because
 * a user filing a bug report two hours after the incident needs enough
 * timeline to locate the relevant window.
 *
 * @param {string} dataDir  Absolute path to the Shipyard data dir. Falsy → no-op.
 * @param {string} type     Event type identifier. Falsy → no-op.
 * @param {object} fields   Extra fields to merge into the event object.
 *                          Numbers and booleans pass through; everything
 *                          else is coerced via sanitizeForLog.
 * @param {object} opts     `{maxLines, maxBytes}` overrides for tests.
 */
export function logEvent(dataDir, type, fields = {}, opts = {}) {
  if (!dataDir || !type) return;
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    return;
  }

  const maxLines = opts.maxLines ?? DEFAULT_EVENTS_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_EVENTS_MAX_BYTES;
  const logPath = join(dataDir, EVENTS_LOG_NAME);

  // Sanitize each field value. Numbers + booleans pass through untouched
  // so counts, durations, and flags stay machine-readable. Strings and
  // everything else get scrubbed of control chars and capped at 200 chars
  // — long enough for file paths, short enough that a single malicious
  // input cannot blow up the log line.
  const sanitized = {};
  if (fields && typeof fields === "object") {
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "number" && Number.isFinite(v)) {
        sanitized[k] = v;
      } else if (typeof v === "boolean") {
        sanitized[k] = v;
      } else {
        sanitized[k] = sanitizeForLog(v, 200);
      }
    }
  }

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const event = { ts, type: sanitizeForLog(type, 64), ...sanitized };

  let line;
  try {
    line = JSON.stringify(event) + "\n";
  } catch {
    // Fields contained something that couldn't be serialized (e.g. a
    // BigInt or a circular reference from a caller that was sloppy).
    // Drop the event rather than corrupt the log.
    return;
  }

  withLockfile(logPath + ".lock", () => {
    try {
      let existing = "";
      try {
        existing = readFileSync(logPath, "utf8");
      } catch {
        existing = "";
      }
      let updated = existing + line;
      if (Buffer.byteLength(updated, "utf8") > maxBytes) {
        const lines = updated.split("\n");
        if (lines.length > maxLines) {
          const kept = lines.slice(-maxLines - 1);
          updated = kept.join("\n");
        }
      }
      atomicWrite(logPath, updated);
    } catch {
      // swallow — diagnostics must not break hooks
    }
  });
}

/**
 * Atomic file write via temp + rename.
 *
 * Writes to a sibling `.tmp-<pid>-<random>` file in the destination
 * directory, then `fs.renameSync` to the final path. Atomic on POSIX
 * (rename(2)) and on Windows (MoveFileExW with REPLACE_EXISTING) — but
 * ONLY on the same filesystem volume. Sibling temp files in destDir
 * guarantee same-volume.
 *
 * Validator C8: never use `os.tmpdir()` here — that may live on a
 * different volume on Windows, silently degrading to copy-then-delete
 * which is non-atomic.
 */
export function atomicWrite(destPath, content) {
  const destDir = dirname(destPath);
  try {
    mkdirSync(destDir, { recursive: true });
  } catch {
    // best effort
  }
  const tmpName = `.${require_basename(destPath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const tmpPath = join(destDir, tmpName);
  writeFileSync(tmpPath, content);
  try {
    renameSync(tmpPath, destPath);
  } catch (err) {
    // Best-effort cleanup of the temp file before re-throwing
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// Local helper — Node's path.basename is in the named import set already,
// but we keep import surface tight by parsing the basename inline.
function require_basename(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * O_EXCL lockfile-based mutual exclusion.
 *
 * Acquires `lockPath` via `openSync(..., 'wx')` (O_EXCL). On EEXIST, stats
 * the existing file — if mtime is older than `ttlMs`, treats it as stale
 * and retries once after deletion. Otherwise polls every `retryMs` until
 * `maxRetries` is exhausted, then throws.
 *
 * On exit (normal or thrown), the lockfile is removed in a finally block.
 *
 * Synchronous API to match the rest of the hook chain — hooks run in
 * short-lived processes and don't benefit from async locking.
 *
 * Validator C4: 30s default TTL with single stale recovery, matching the
 * 30s timeout `worktree-branch.py` enforces for parallel `git worktree
 * add` races.
 */
export function withLockfile(lockPath, fn, opts = {}) {
  const ttlMs = opts.ttlMs ?? 30000;
  const retryMs = opts.retryMs ?? 100;
  const maxRetries = opts.maxRetries ?? 300;
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

  let fd = null;
  let attempt = 0;
  let staleRecovered = false;
  while (true) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") {
        // Some other error — fail open (caller swallows for breadcrumb,
        // surfaces for guard hooks).
        try { fn(); } catch { /* ignore */ }
        return;
      }
      // Lock contended. Check if stale.
      if (!staleRecovered) {
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > ttlMs) {
            try { unlinkSync(lockPath); } catch { /* ignore */ }
            staleRecovered = true;
            continue;
          }
        } catch {
          // race: file vanished between EEXIST and stat
          continue;
        }
      }
      attempt++;
      if (attempt > maxRetries) {
        // Could not acquire — fail open. Better to lose serialization
        // than to fail the hook and break a tool call.
        try { fn(); } catch { /* ignore */ }
        return;
      }
      // Synchronous sleep via Atomics.wait. Never notified.
      Atomics.wait(sleepBuf, 0, 0, retryMs);
    }
  }

  try {
    closeSync(fd);
    fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }
}
