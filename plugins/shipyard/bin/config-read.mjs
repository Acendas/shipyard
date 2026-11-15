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
  // Shared block scan: a column-0 `# comment` inside `execution:` does not end it.
  const v = scanBlockScalar(dataDir, "execution", "isolation");
  return v === "none" ? "none" : "worktree";
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
 * string (comment-stripped, quotes kept) or null. Single-token values only:
 * a value with internal whitespace is treated as absent. Wrapper over the one
 * block scan (scanBlockScalar).
 */
function readExecutionScalar(dataDir, key) {
  const v = scanBlockScalar(dataDir, "execution", key);
  return v !== undefined && /^\S+$/.test(v) ? v : null;
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
 * `execution.max_undispositioned_ideas` — cap on UNDISPOSITIONED idea files
 * before /ship-sprint refuses to open a new sprint (deferral-backlog gate).
 * Default 12. A non-positive/malformed value disables the cap (Infinity).
 *
 * The legacy key `max_ideas_per_sprint` is still read as a fallback. That name
 * promised a per-sprint scoping that was never implemented — the count has
 * always been a lifetime scan of `spec/ideas/` — so it read as a throttle when
 * it was a permanent ceiling. See bin/idea-backlog.mjs for why the cap moved
 * off the allocation path entirely.
 */
export function readMaxUndispositionedIdeas(dataDir) {
  const raw =
    readExecutionScalar(dataDir, "max_undispositioned_ideas") ??
    readExecutionScalar(dataDir, "max_ideas_per_sprint");
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
 * `execution.max_agents` (default 100): the most agents — builders, reviewers,
 * researchers, every named helper — that may be alive in this project at the
 * same moment. The owner's rule (2026-11-14). The agent hook refuses a spawn
 * over it; before 4.18 the only limit was a sentence in a skill ("3 builders,
 * hard ceiling 4") that no command read.
 *
 * The older `execution.max_parallel_agents` is honoured only when it was
 * changed from its template value of 3: every project got that 3 written by
 * the template, so a 3 was never anyone's choice, but a 1, 2 or 4 was.
 */
export const DEFAULT_MAX_AGENTS = 100;
export function readMaxAgents(dataDir) {
  const ok = (raw) => { const n = Number(raw); return raw != null && Number.isInteger(n) && n >= 1 ? n : null; };
  const own = ok(readExecutionScalar(dataDir, "max_agents"));
  if (own !== null) return own;
  const legacy = ok(readExecutionScalar(dataDir, "max_parallel_agents"));
  return legacy !== null && legacy !== 3 ? legacy : DEFAULT_MAX_AGENTS;
}

/**
 * `execution.parallel_plan` (default true): the plan gate. A story cannot
 * enter a sprint while `sprint plan-score` reports a problem (a late step, two
 * steps of one wave on the same file, a solo sprint with a wide wave).
 */
export function readParallelPlan(dataDir) {
  return String(readExecutionScalar(dataDir, "parallel_plan")).toLowerCase() !== "false";
}

/** `execution.probe_must_fail_first` (default true): a step's probe must fail on today's code before the sprint starts. */
export function readProbeMustFailFirst(dataDir) {
  return String(readExecutionScalar(dataDir, "probe_must_fail_first")).toLowerCase() !== "false";
}

/**
 * `execution.patch_wave_tests` (default "sprint"): a wave made only of fix
 * steps skips its own build and test run; the sprint's full build and suite
 * cover it once at the end. "wave" runs them per fix wave.
 */
export function readPatchWaveTests(dataDir) {
  return String(readExecutionScalar(dataDir, "patch_wave_tests")).toLowerCase() === "wave" ? "wave" : "sprint";
}

/** `execution.patch_steps_per_story` (default 2): the patch budget grows with the sprint's stories. */
export function readPatchStepsPerStory(dataDir) {
  // A missing key is the default, not zero: Number(null) is 0, which printed
  // "3 stories × 0" on a project whose config predates the key.
  const raw = readExecutionScalar(dataDir, "patch_steps_per_story");
  if (raw == null) return 2;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
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
/**
 * `execution.overlap_waves` (4.4) — dispatch wave N+1 the moment wave N is
 * merged and run N's build/tests/verify/review lane alongside. Default true.
 */
/** `execution.unattended` (4.4) — /ship-execute asks nothing after readiness. Default true. */
export function readUnattended(dataDir) {
  const raw = readExecutionScalar(dataDir, "unattended");
  if (raw == null) return true;
  return !/^(false|0|no|off)$/i.test(String(raw).trim());
}

/** `execution.triage_sprint_findings` (4.7.2) — ideas captured during a sprint are triaged; defects above low are fixed in it. Default true. */
export function readTriageSprintFindings(dataDir) {
  const raw = readExecutionScalar(dataDir, "triage_sprint_findings");
  if (raw == null) return true;
  return !/^(false|0|no|off)$/i.test(String(raw).trim());
}

export function readOverlapWaves(dataDir) {
  const raw = readExecutionScalar(dataDir, "overlap_waves");
  if (raw == null) return true;
  return !/^(false|0|no|off)$/i.test(String(raw).trim());
}

/**
 * `execution.code_review` (4.6) — code review and its fixes happen inside
 * /ship-execute (per story, while the work is fresh), so /ship-review can be
 * a sprint review for the owner. Default true; false restores the pre-4.6
 * shape where /ship-review scans and fixes.
 */
export function readExecuteCodeReview(dataDir) {
  const raw = readExecutionScalar(dataDir, "code_review");
  if (raw == null) return true;
  return !/^(false|0|no|off)$/i.test(String(raw).trim());
}

/** `execution.design_review` (4.8) — a UI story's review records the delivered screen against its approved design. Default true. */
export function readExecuteDesignReview(dataDir) {
  const raw = readExecutionScalar(dataDir, "design_review");
  if (raw == null) return true;
  return !/^(false|0|no|off)$/i.test(String(raw).trim());
}

/** `execution.sweep_branches` (4.9) — at sprint archive, delete or hide this sprint's Shipyard branches. Default true. */
export function readSweepBranches(dataDir) {
  const raw = readExecutionScalar(dataDir, "sweep_branches");
  if (raw == null) return true;
  return !/^(false|0|no|off)$/i.test(String(raw).trim());
}

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
 * Why longest-first is the default: before 4.18 three builders ran at a time, so a
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
 * `execution.max_tasks_per_wave` — width cap for a wave. Since 4.19 the
 * default is `execution.max_agents` (100): a wave is as wide as its
 * dependencies allow, because each story is reviewed at its own boundary, not
 * once per wave. The old template wrote `6` into every project, so a 6 is read
 * as "never chosen" and ignored; any other number is the owner's and is kept.
 * Wave COUNT is never capped (that is dependency depth).
 */
export function readMaxTasksPerWave(dataDir) {
  return waveCap(dataDir, "max_tasks_per_wave", 6);
}
function waveCap(dataDir, key, oldTemplateValue) {
  const raw = readExecutionScalar(dataDir, key);
  const n = Number(raw);
  if (raw == null || !Number.isFinite(n) || n <= 0 || Math.floor(n) === oldTemplateValue) return readMaxAgents(dataDir);
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
 * `execution.max_tasks_per_wave_merged` — the upper bound on a wave formed by
 * merging an independent layer (see readMergeIndependentLayers). Since 4.19 it
 * defaults to `execution.max_agents` and is never below the plain cap; the old
 * template's 12 is ignored, any other number is kept.
 */
export function readMaxTasksPerWaveMerged(dataDir) {
  // 4.19: follows max_agents like the plain cap; the old template's 12 is ignored.
  return Math.max(waveCap(dataDir, "max_tasks_per_wave_merged", 12), readMaxTasksPerWave(dataDir));
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

/**
 * Role -> model tier for `shipyard-data resolve-model`. Roles are the
 * `agent_effort` roles. `think` is the think tier, `coordinator` the light
 * tier, everything else is labor on the `build` tier; `orchestrate` is the user-command shell and is never a dispatch role.
 */
export const ROLE_TIER = Object.freeze({
  build: "build",
  build_trivial: "build",
  fixer: "build",
  operational: "build",
  operational_fix: "build",
  think: "think",
  coordinator: "light",
  simplifier: "build",
  decide: "light",
});

/**
 * The lowest tier a role may be routed to when a subject's kind, size and risk
 * are known (v4.10). ROLE_TIER above stays the STATIC tier (no subject, or
 * `routing.rules: false`). Before 4.10 the static tier doubled as the floor,
 * so a builder could never run below `build` and the light tier (Haiku) was
 * reachable only by track coordinators.
 */
export const ROLE_FLOOR = Object.freeze({
  build: "light",
  build_trivial: "light",
  fixer: "light",
  operational: "light",
  operational_fix: "build",
  think: "think",
  coordinator: "light",
  simplifier: "build",
  decide: "light",
});

/** Effort used when `agent_effort.<role>` is absent (matches the template). */
export const ROLE_EFFORT_DEFAULT = Object.freeze({
  build: "medium",
  build_trivial: "low",
  fixer: "medium",
  operational: "low",
  operational_fix: "medium",
  think: "high",
  coordinator: "low",
  simplifier: "low",
  decide: "low",
});

/**
 * The one block scan. Returns the trimmed, ` #`-comment-stripped raw value of
 * `<key>:` under the top-level `<block>:` mapping, or undefined when the file,
 * block or key is absent/unreadable. Comment rule (deliberate, YAML-faithful):
 * column-0 `# comment` lines and blank lines do NOT end the block; only a
 * non-comment column-0 line does.
 */
function scanBlockScalar(dataDir, block, key) {
  if (!dataDir) return undefined;
  const configPath = join(dataDir, "config.md");
  if (!existsSync(configPath)) return undefined;
  let content;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return undefined;
  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${block}:\\s*$`).test(l));
  if (start === -1) return undefined;
  const re = new RegExp(`^\\s+${key}:\\s*(.*)$`);
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*(#|$)/.test(lines[i])) continue;
    if (/^\S/.test(lines[i])) break;
    const m = lines[i].replace(/\s+#.*$/, "").match(re);
    if (m) return m[1].trim();
  }
  return undefined;
}

/**
 * Read a scalar under a top-level block. Returns undefined when the file,
 * block or key is absent/unreadable; otherwise the comment-stripped,
 * unquoted string (possibly "").
 */
export function readBlockScalar(dataDir, block, key) {
  const v = scanBlockScalar(dataDir, block, key);
  return v === undefined ? undefined : v.replace(/^["']|["']$/g, "");
}

/** True for a legacy versioned first-party id (`claude-*`) no longer accepted. */
export function isLegacyClaudeModelId(v) {
  return typeof v === "string" && /^claude-/i.test(v);
}

/**
 * Map a legacy `claude-<family>-...` id to its family tier
 * (opus|sonnet|haiku|fable); any other `claude-*` value becomes "" (unset,
 * inherit). Non-claude values pass through unchanged.
 */
export function normalizeLegacyModel(v) {
  if (!isLegacyClaudeModelId(v)) return v;
  const m = v.toLowerCase().match(/^claude-(opus|sonnet|haiku|fable)(?:-|$)/);
  return m ? m[1] : "";
}

/**
 * `models.<tier>` as a model string; "" means omit the `model:` field
 * (empty, `inherit`, absent block/key, unreadable config). Absent inherits on
 * purpose, never the template default: that would silently downgrade an Opus
 * session on a project initialized before the models block existed.
 */
/**
 * The light tier is a model of its own: `models.light` is set and resolves to
 * something other than the build model. When it is not (the key is empty on
 * every project that predates 4.10), routing treats light as build, so nothing
 * changes until the owner names a light model.
 */
export function lightIsDistinct(dataDir) {
  const raw = readBlockScalar(dataDir, "models", "light");
  if (raw === undefined || raw === "" || raw === "inherit") return false;
  return normalizeLegacyModel(raw) !== readModelTier(dataDir, "build");
}

/** `routing.size_tiers` — tier by step size for sized kinds. Default S=light, M=build, L=think, XL=think. */
export const DEFAULT_SIZE_TIERS = Object.freeze({ S: "light", M: "build", L: "think", XL: "think" });
export function readSizeTiers(dataDir) {
  const raw = readBlockScalar(dataDir, "routing", "size_tiers");
  const out = { ...DEFAULT_SIZE_TIERS };
  if (!raw) return out;
  for (const part of String(raw).replace(/^["']|["']$/g, "").split(",")) {
    const m = part.trim().match(/^(S|M|L|XL)\s*=\s*(light|build|think)$/i);
    if (m) out[m[1].toUpperCase()] = m[2].toLowerCase();
  }
  return out;
}

export function readModelTier(dataDir, tier) {
  const v = readBlockScalar(dataDir, "models", tier);
  // Legacy versioned `claude-*` ids are mapped to their family tier (the Agent
  // tool accepts only fable|opus|sonnet|haiku); doctor warns about them.
  // light falls back to the RESOLVED build value (never a literal): no silent
  // downgrade for projects that predate the light key.
  if (tier === "light" && (v === undefined || v === "")) return readModelTier(dataDir, "build");
  return v === undefined || v === "inherit" ? "" : normalizeLegacyModel(v);
}

/**
 * `agent_effort.<role>`; "" means omit `effort:` (empty or `inherit`).
 * Absent key/block falls back to the role's default effort.
 */
export function readAgentEffort(dataDir, role) {
  const v = readBlockScalar(dataDir, "agent_effort", role);
  if (v === undefined) return ROLE_EFFORT_DEFAULT[role] ?? "";
  return v === "inherit" ? "" : v;
}

/**
 * `execution.max_session_minutes` — optional session wall-clock budget.
 * Returns `{value, valid}`. Absent or 0 means OFF (`value: 0, valid: true`).
 * A negative, fractional or non-numeric value is invalid: `{value: 0, valid:
 * false}` — the budget is treated as off and `doctor` reports the error.
 */
export function readMaxSessionMinutes(dataDir) {
  const raw = readExecutionScalar(dataDir, "max_session_minutes");
  if (raw == null) return { value: 0, valid: true };
  const s = raw.replace(/^["']|["']$/g, "");
  if (!/^\d+$/.test(s)) return { value: 0, valid: false };
  return { value: Number(s), valid: true };
}

/**
 * `review.code_review` (F031) — level at which /ship-review Stage 0 also invokes
 * the built-in `code-review` skill: off (default) | low | medium | high.
 * `ultra` and `max` are user-triggered, billed levels and are never selected by
 * Shipyard: they (and any other junk) read as `off` with `valid: false` so
 * doctor can report them. Returns `{level, valid}`.
 */
export const CODE_REVIEW_LEVELS = Object.freeze(["off", "low", "medium", "high"]);
export function readCodeReviewLevel(dataDir) {
  const raw = scanBlockScalar(dataDir, "review", "code_review");
  if (raw === undefined || raw === "" || raw === '""') return { level: "off", valid: true };
  const s = String(raw).replace(/^["']|["']$/g, "").toLowerCase();
  if (CODE_REVIEW_LEVELS.includes(s)) return { level: s, valid: true };
  return { level: "off", valid: false };
}

/**
 * `review.workflow` (F033) — opt-in: run the read-only review fan-out (Stage 0
 * scanners, per-story spec/gap review) through the Workflow tool. Default off.
 */
export function readReviewWorkflow(dataDir) {
  const raw = scanBlockScalar(dataDir, "review", "workflow");
  if (raw === undefined) return false;
  const s = String(raw).replace(/^["']|["']$/g, "").toLowerCase();
  return s === "true" || s === "on" || s === "yes" || s === "1";
}

/**
 * `execution.story_review` (F028) — when true (default), every story in the
 * sprint must carry a settled per-story review (story_reviewed verdict=approve,
 * or changes + story_review_dispositioned) before the execute terminal and the
 * sprint-complete predicate pass. `false` restores the pre-4.1 behavior.
 */
export function readStoryReview(dataDir) {
  const raw = readExecutionScalar(dataDir, "story_review");
  if (raw == null) return true;
  const s = raw.replace(/^["']|["']$/g, "").toLowerCase();
  return !(s === "false" || s === "off" || s === "0" || s === "no");
}

/**
 * `execution.assumed_points_per_hour` (F011 AC-13, AC-14) — an OPTIONAL user-
 * observed rate used only to convert a time budget when no MEASURED rate exists.
 * Off by default (no shipped value). Returns `{value, valid}`: absent/empty ->
 * `{value: null, valid: true}`; non-numeric or non-positive -> `{value: null,
 * valid: false}` (ignored; `doctor` reports it). A measured rate always wins.
 */
export function readAssumedPointsPerHour(dataDir) {
  const raw = readExecutionScalar(dataDir, "assumed_points_per_hour");
  if (raw == null) return { value: null, valid: true };
  const s = raw.replace(/^["']|["']$/g, "");
  if (s === "") return { value: null, valid: true };
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return { value: null, valid: false };
  return { value: n, valid: true };
}

/**
 * `execution.presumed_dead_minutes` — age past which a claimed queue item with
 * no completion and no recent heartbeat is reported as presumed dead.
 * Returns `{value, valid}`; absent means the default 60. Zero, negative,
 * fractional or non-numeric is invalid: default 60 is used and `doctor`
 * reports the error.
 */
/**
 * `risk.max_critical_per_sprint` (E004) — ceiling on critical-level risk scores per
 * sprint; `risk score --cap` refuses (exit 3) once reached. Absent/empty → 3.
 * 0 disables. Negative, fractional or non-numeric → `{value: 3, valid: false}`.
 */
export function readRiskMaxCriticalPerSprint(dataDir) {
  const raw = readBlockScalar(dataDir, "risk", "max_critical_per_sprint");
  if (raw === undefined || raw === "") return { value: 3, valid: true };
  if (!/^\d+$/.test(raw)) return { value: 3, valid: false };
  return { value: Number(raw), valid: true };
}

/** `routing.rules` (E004) — resolve-model --subject consults `route`. Default true. */
export function readRoutingRules(dataDir) {
  const v = readBlockScalar(dataDir, "routing", "rules");
  if (v === undefined || v === "") return true;
  return /^(true|on|yes)$/i.test(v);
}

/** `routing.quick_decisions` (4.11) — the light-tier quick-decision rung (`shipyard-data decide`). Default true. */
export function readQuickDecisions(dataDir) {
  const v = readBlockScalar(dataDir, "routing", "quick_decisions");
  if (v === undefined || v === "") return true;
  return /^(true|on|yes)$/i.test(v);
}

/** `routing.haiku_router` (E004) — opt-in Haiku escalator for `route-intake --haiku`. Default false. */
export function readHaikuRouter(dataDir) {
  const v = readBlockScalar(dataDir, "routing", "haiku_router");
  return v !== undefined && /^(true|on|yes)$/i.test(v);
}

/**
 * `ui.*` (E005, v4.3) — render-target adapter settings. adapter: none|web (default none:
 * every UI stage is skipped with one line); base_url; playwright_root (a dir holding
 * node_modules/playwright[-core]); rule_pack (JSON path, relative to the data dir);
 * widths (comma list). Unknown adapter values are reported by doctor and treated as none.
 */
function num01(raw) {
  if (raw === undefined || raw === "") return null;
  const n = Number(String(raw).replace(/^["']|["']$/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export function readUiConfig(dataDir) {
  const adapterRaw = readBlockScalar(dataDir, "ui", "adapter");
  const adapter = adapterRaw === undefined || adapterRaw === "" ? "none" : adapterRaw.toLowerCase();
  const widths = (readBlockScalar(dataDir, "ui", "widths") ?? "").split(",").map((w) => Number(w.trim())).filter((w) => Number.isInteger(w) && w > 0);
  const valid = ["none", "web", "frames"].includes(adapter);
  return {
    adapter: valid ? adapter : "none",
    adapter_valid: valid,
    // frames (4.4): the project's own renderer is the pixel source. The command
    // receives {scene} (the --url argument) and {out} (the PNG to write).
    frame_command: readBlockScalar(dataDir, "ui", "frame_command") ?? "",
    base_url: readBlockScalar(dataDir, "ui", "base_url") ?? "",
    playwright_root: readBlockScalar(dataDir, "ui", "playwright_root") ?? "",
    rule_pack: readBlockScalar(dataDir, "ui", "rule_pack") ?? "",
    // 4.8 mockup comparison: unset = draft thresholds (warnings); set = the project's own bar (errors).
    min_layout: num01(readBlockScalar(dataDir, "ui", "min_layout")),
    min_palette: num01(readBlockScalar(dataDir, "ui", "min_palette")),
    widths,
  };
}

export function readPresumedDeadMinutes(dataDir) {
  const raw = readExecutionScalar(dataDir, "presumed_dead_minutes");
  if (raw == null) return { value: 60, valid: true };
  const s = raw.replace(/^["']|["']$/g, "");
  if (!/^[1-9]\d*$/.test(s)) return { value: 60, valid: false };
  return { value: Number(s), valid: true };
}
