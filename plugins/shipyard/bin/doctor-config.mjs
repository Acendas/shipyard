/**
 * Config checks for `shipyard-data doctor`. Each check returns warnings
 * ({kind, detail, hint}); warnings print as `warning:` lines and never
 * change doctor's exit code.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readBlockScalar, readMaxSessionMinutes, readPresumedDeadMinutes, readAssumedPointsPerHour, readCodeReviewLevel, CODE_REVIEW_LEVELS, readRiskMaxCriticalPerSprint, readUiConfig, isLegacyClaudeModelId, normalizeLegacyModel } from "./config-read.mjs";

const DISPATCH_TIERS = ["think", "build"];

/** Warn when a dispatch model tier is empty or absent (explicit `inherit` is fine). */
export function checkModelTiers(dataDir) {
  const warnings = [];
  for (const tier of DISPATCH_TIERS) {
    const v = readBlockScalar(dataDir, "models", tier);
    if (v === undefined || v === "") {
      warnings.push({
        kind: "empty-model-tier",
        detail: `models.${tier} is ${v === undefined ? "absent" : "empty"}; dispatched ${tier} work inherits the session model`,
        hint: `Run 'shipyard-data config set-model ${tier} <model>' (or 'inherit' to silence this).`,
      });
    }
  }
  // Legacy versioned ids: still resolved (mapped to the family tier) but unsupported.
  for (const tier of ["think", "build", "light", "orchestrate"]) {
    const v = readBlockScalar(dataDir, "models", tier);
    if (isLegacyClaudeModelId(v)) {
      const mapped = normalizeLegacyModel(v);
      warnings.push({
        kind: "legacy-claude-model-id",
        detail: `models.${tier} is "${v}"; claude-* ids are unsupported (the Agent tool accepts only fable|opus|sonnet|haiku) and resolve as ${mapped ? `"${mapped}"` : "unset (inherit)"}`,
        hint: `Run 'shipyard-data config set-model ${tier} <fable|opus|sonnet|haiku|inherit>'.`,
      });
    }
  }
  // light: empty is the template default (falls back to build) and is fine;
  // only an absent key (project predates it) is worth a nudge.
  if (readBlockScalar(dataDir, "models", "light") === undefined) {
    warnings.push({
      kind: "absent-model-tier",
      detail: "models.light is absent, so there is no light tier: straightforward (size S) steps, command runners and quick decisions all run on the build model",
      hint: "Run 'shipyard-data config set-model light haiku' to route them to Haiku (fast; a failed dispatch climbs to build, then think), or 'inherit' to keep one model.",
    });
  }
  const adv = advisorHint(dataDir);
  if (adv) warnings.push(adv);
  return warnings;
}

/**
 * Advisor hint (4.5). Claude Code's advisor is a stronger model that reads the
 * whole conversation at decision points; Shipyard's decision ladder consults
 * it last, after the think-tier consult and before parking. It is a per-user setting
 * (`advisorModel`, `/advisor <model>`), so the CLI can only notice it is off
 * while a tier that would benefit (sonnet/haiku orchestrator or builders) is
 * configured. Read-only; a missing or unreadable settings file is no warning.
 */
export function advisorHint(dataDir, { env = process.env, home = homedir() } = {}) {
  if (env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL === "1") return null;
  const tiers = ["orchestrate", "build"].map((t) => String(readBlockScalar(dataDir, "models", t) ?? "").toLowerCase());
  if (!tiers.some((t) => /sonnet|haiku/.test(t))) return null;
  const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR.trim() : join(home, ".claude");
  let settings;
  try { settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")); } catch { return null; }
  if (settings && typeof settings.advisorModel === "string" && settings.advisorModel.trim() && settings.advisorModel.trim() !== "off") return null;
  return {
    kind: "advisor-not-configured",
    detail: "Claude Code's advisor is off while models.orchestrate/build run below opus; the decision ladder's last step before parking (rule → think-tier consult → advisor → park) is unavailable",
    hint: "Run '/advisor opus' once (saved to your user settings). The advisor reads the whole conversation; builders inherit it.",
  };
}

/** Errors (exit 1): an invalid max_session_minutes is ignored (budget off) but must be fixed. */
export function collectConfigErrors(dataDir) {
  const errors = [];
  if (!readMaxSessionMinutes(dataDir).valid) {
    errors.push({
      kind: "invalid-max-session-minutes",
      detail: "execution.max_session_minutes is negative or non-numeric; it is ignored and the session budget is off",
      hint: "Set it to a whole number of minutes (e.g. 240), or 0 to disable.",
    });
  }
  if (!readPresumedDeadMinutes(dataDir).valid) {
    errors.push({
      kind: "invalid-presumed-dead-minutes",
      detail: "execution.presumed_dead_minutes is not a positive whole number; the default 60 is used",
      hint: "Set it to a positive whole number of minutes (e.g. 60).",
    });
  }
  if (!readUiConfig(dataDir).adapter_valid) {
    errors.push({
      kind: "invalid-ui-adapter",
      detail: "ui.adapter is not none|web|frames; UI stages are skipped",
      hint: "Set ui.adapter to web (Playwright from the project's install), frames (the project's own render command, ui.frame_command) or none.",
    });
  }
  if (!readRiskMaxCriticalPerSprint(dataDir).valid) {
    errors.push({
      kind: "invalid-risk-max-critical",
      detail: "risk.max_critical_per_sprint is not a whole number; the default 3 is used",
      hint: "Set it to a whole number (0 disables the cap).",
    });
  }
  if (!readCodeReviewLevel(dataDir).valid) {
    errors.push({
      kind: "invalid-code-review-level",
      detail: `review.code_review is not one of ${CODE_REVIEW_LEVELS.join("|")} (ultra/max are user-triggered, billed levels Shipyard never selects); it is ignored (off)`,
      hint: "Set review.code_review to off, low, medium or high.",
    });
  }
  if (!readAssumedPointsPerHour(dataDir).valid) {
    errors.push({
      kind: "invalid-assumed-points-per-hour",
      detail: "execution.assumed_points_per_hour is non-numeric or not positive; it is ignored and a time budget needs a measured rate",
      hint: "Set it to a positive number (your observed pts/hr, e.g. 4.8), or leave it empty to rely on the measured rate.",
    });
  }
  return errors;
}

export function collectConfigWarnings(dataDir) {
  return [...checkModelTiers(dataDir)];
}
