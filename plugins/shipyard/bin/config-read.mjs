/**
 * config-read — tiny read-only accessors for config.md frontmatter values
 * that CLI *logic* (not just the model's `!` context block) needs to branch
 * on. Kept as a leaf module with no Shipyard deps so both shipyard-data.mjs
 * (the `resolve-isolation` verb) and worker-queue.mjs (the enqueue guard) can
 * import it without a cycle.
 *
 * Every accessor returns a safe default on any read/parse failure or absent
 * key, so a project initialized before a key existed is never broken by a
 * reader that assumes it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read `execution.isolation` from config.md. Returns "worktree" | "none";
 * defaults to "worktree" (today's behavior) when absent/unreadable/invalid.
 * Any value other than the exact string `none` is treated as `worktree` —
 * fail safe toward isolation, never accidentally into unguarded in-place.
 */
export function readExecutionIsolation(dataDir) {
  if (!dataDir) return "worktree";
  const configPath = join(dataDir, "config.md");
  if (!existsSync(configPath)) return "worktree";
  let content;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return "worktree";
  }
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return "worktree";
  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^execution:\s*$/.test(l));
  if (start === -1) return "worktree";
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // left the block
    const m = lines[i].replace(/\s+#.*$/, "").match(/^\s+isolation:\s*(\S+)\s*$/);
    if (m) return m[1] === "none" ? "none" : "worktree";
  }
  return "worktree";
}

/**
 * Read a scalar under the `execution:` block of config.md, returning the raw
 * string (comment-stripped) or null. Shared by the typed accessors below;
 * mirrors readExecutionIsolation's block scan.
 */
function readExecutionScalar(dataDir, key) {
  if (!dataDir) return null;
  const configPath = join(dataDir, "config.md");
  if (!existsSync(configPath)) return null;
  let content;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^execution:\s*$/.test(l));
  if (start === -1) return null;
  const re = new RegExp(`^\\s+${key}:\\s*(\\S+)\\s*$`);
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    const m = lines[i].replace(/\s+#.*$/, "").match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * `execution.max_parked_ratio` — the fraction of a sprint's tasks that may be
 * parked (blocked/needs-attention) and still allow a terminal advance without
 * explicit operator acceptance. Default 0.34. Clamped to [0, 1]; a malformed
 * value falls back to the default rather than failing open (0 would block any
 * park; 1 would disable the gate).
 */
export function readMaxParkedRatio(dataDir) {
  const raw = readExecutionScalar(dataDir, "max_parked_ratio");
  if (raw == null) return 0.34;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0.34;
  return n;
}

/**
 * `execution.max_ideas_per_sprint` — cap on UNDISPOSITIONED idea files before
 * `next-id ideas` refuses further allocation (deferral-backlog guard). Default
 * 12. A non-positive/malformed value disables the cap (returns Infinity).
 */
export function readMaxIdeasPerSprint(dataDir) {
  const raw = readExecutionScalar(dataDir, "max_ideas_per_sprint");
  if (raw == null) return 12;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Infinity;
  return Math.floor(n);
}

/**
 * `execution.max_patch_tasks` — cap on cumulative patch tasks created during a
 * single execute/review run before escalation. Default 5. Non-positive/malformed
 * → Infinity (disabled).
 */
export function readMaxPatchTasks(dataDir) {
  const raw = readExecutionScalar(dataDir, "max_patch_tasks");
  if (raw == null) return 5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Infinity;
  return Math.floor(n);
}

/**
 * `execution.require_park_evidence` — when true, parking a task that was
 * actively in progress (in-progress → blocked/needs-attention) requires an
 * `--evidence <path>` pointing at a real capture/return file, mirroring what
 * `task accept-return` demands for completion. Default false (opt-in), because
 * turning it on requires every difficulty-park call site to thread evidence.
 */
export function readRequireParkEvidence(dataDir) {
  const raw = readExecutionScalar(dataDir, "require_park_evidence");
  return String(raw).toLowerCase() === "true";
}

/**
 * `execution.enforce_ac_coverage` — when true (default), verify-ac-coverage
 * exits non-zero on an orphan AC (a tagged acceptance criterion with no
 * `AC-<n>` marker in the sprint diff), making sprint invariant 4 a hard gate.
 * A feature with NO tagged ACs is always advisory (WARN) regardless, so a
 * project that hasn't adopted AC ids yet is never false-blocked.
 */
export function readEnforceAcCoverage(dataDir) {
  const raw = readExecutionScalar(dataDir, "enforce_ac_coverage");
  if (raw == null) return true;
  return String(raw).toLowerCase() !== "false";
}

/**
 * Normalize a user-supplied isolation token to "worktree" | "none" | null.
 * Accepts both the flag vocabulary (`true`/`false`) and the config
 * vocabulary (`worktree`/`none`), plus `on`/`off`, case-insensitively.
 * Returns null for an unrecognized token so callers can reject it.
 */
export function normalizeIsolationToken(raw) {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "worktree" || v === "on") return "worktree";
  if (v === "false" || v === "none" || v === "off") return "none";
  return null;
}
