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
 * Is a command configured under a top-level block (e.g. `build_commands:`)?
 * Used by the --via collapse allowlist, which may only collapse a stage whose
 * command is UNSET. Any read/parse failure returns true (treat as configured),
 * because a wrongly-refused collapse costs one re-entry while a wrongly-allowed
 * one fabricates proof that a stage ran.
 */
export function hasConfiguredCommand(dataDir, block, key) {
  if (!dataDir) return true;
  const configPath = join(dataDir, "config.md");
  if (!existsSync(configPath)) return false;
  let content;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return true;
  }
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return true;
  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${block}:\\s*$`).test(l));
  if (start === -1) return false;
  const re = new RegExp(`^\\s+${key}:\\s*(.*)$`);
  for (let i = start + 1; i < lines.length; i++) {
    // A flush-left COMMENT is not the end of the block. Treating it as one made
    // a configured `full:` written below a `# ...` line invisible, so a real
    // build stage looked unconfigured and became --via-collapsible — emitting
    // proof the build ran while it never did. Blank lines are likewise not a
    // block boundary.
    const raw = lines[i];
    if (/^\s*(#|$)/.test(raw)) continue;
    if (/^\S/.test(raw)) break;
    const m = raw.replace(/\s+#.*$/, "").match(re);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, "");
      return v.length > 0;
    }
  }
  return false;
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
 * `execution.refactor_scope` — where the REFACTOR+MUTATE pass runs.
 *
 * "sprint" (default) runs it ONCE at `sprint_refactor`, just before
 * `sprint_full_build`, so the full build + full suite validate it. "wave"
 * restores the pre-v3.19 per-wave `wave_N_refactor` dispatch.
 *
 * Default is "sprint" because the per-wave pass was N LLM agent dispatches
 * sitting on the critical path between one wave's builders finishing and the
 * next wave's starting — for a stage explicitly declared "not a wave blocker".
 * One sprint-wide pass is also strictly better refactoring: it sees the whole
 * diff, so it can dedupe across waves that N narrow passes each miss.
 *
 * The trade, for projects that should set "wave": one large refactor has worse
 * failure attribution than N small ones, and later waves' builders no longer
 * inherit earlier waves' extractions.
 */
export function readRefactorScope(dataDir) {
  const raw = readExecutionScalar(dataDir, "refactor_scope");
  if (raw == null) return "sprint";
  return String(raw).toLowerCase() === "wave" ? "wave" : "sprint";
}

/**
 * `execution.dispatch_order` — the order wave tasks are enqueued.
 *
 * "critical_path" (default) enqueues longest-effort-first (XL→L→M→S), tie-broken
 * by task id. "task_id" restores pre-v3.19 plain id order.
 *
 * Why longest-first is the default: `max_parallel_agents` defaults to 3, so a
 * 6-task wave runs in batches. Starting the XL last means the whole wave waits
 * on it after everything else has drained; starting it first overlaps it with
 * the short tasks. Merge order at the wave boundary is unaffected — that stays
 * task-id order.
 */
export function readDispatchOrder(dataDir) {
  const raw = readExecutionScalar(dataDir, "dispatch_order");
  if (raw == null) return "critical_path";
  return String(raw).toLowerCase() === "task_id" ? "task_id" : "critical_path";
}

/**
 * `execution.max_tasks_per_wave` — width cap for a wave formed from a
 * dependency layer. Default 6. Non-positive/malformed → the default, never
 * Infinity: an uncapped wave is the unbounded merge surface this exists to
 * prevent. Wave COUNT is never capped (that is dependency depth).
 */
export function readMaxTasksPerWave(dataDir) {
  const raw = readExecutionScalar(dataDir, "max_tasks_per_wave");
  if (raw == null) return 6;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 6;
  return Math.floor(n);
}

/**
 * `execution.merge_independent_layers` — when true (default), `/ship-sprint`
 * wave assignment keeps an oversized-but-mutually-independent dependency layer
 * as ONE wave up to `max_tasks_per_wave_merged`, instead of splitting it into
 * consecutive waves that have no dependency on each other yet are executed
 * strictly in series.
 *
 * Set false to restore the pre-v3.19 always-split behavior when failure
 * attribution on a smaller merge surface matters more than the saved boundary.
 */
export function readMergeIndependentLayers(dataDir) {
  const raw = readExecutionScalar(dataDir, "merge_independent_layers");
  if (raw == null) return true;
  return String(raw).toLowerCase() !== "false";
}

/**
 * `execution.max_tasks_per_wave_merged` — the hard upper bound on a wave formed
 * by merging an independent layer (see readMergeIndependentLayers). Default 12.
 * Beyond this the layer splits normally, because the merge-surface cost of an
 * arbitrarily wide wave does eventually exceed the saved boundary.
 * Non-positive/malformed → the default, never Infinity: an uncapped merged wave
 * is exactly the unbounded merge surface `max_tasks_per_wave` exists to prevent.
 */
export function readMaxTasksPerWaveMerged(dataDir) {
  const raw = readExecutionScalar(dataDir, "max_tasks_per_wave_merged");
  if (raw == null) return 12;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 12;
  return Math.floor(n);
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
