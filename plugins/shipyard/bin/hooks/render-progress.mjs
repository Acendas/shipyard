/**
 * PostToolUse hook — regenerate PROGRESS.md after every cursor write.
 *
 * Closes the dual-authority gap that triggered the v2.5.0 /ship-review
 * "state is inconsistent" complaints. Previously PROGRESS.md was treated
 * as "confirmatory" by ship-execute (so it got out of sync with the
 * cursor) but "authoritative drift mirror" by ship-review (so the drift
 * was flagged). After v2.6.0, PROGRESS.md is a derived artifact and no
 * skill Writes or Edits it. This hook is the writer.
 *
 * Trigger: PostToolUse on Edit/Write/MultiEdit targeting
 * `sprints/current/EXECUTE-CURSOR.md` or
 * `sprints/current/REVIEW-CURSOR.md` (any change to either cursor
 * regenerates the human-readable progress view). The renderer pulls from
 * the event log, so it reflects whatever events fired during the work
 * that led up to the cursor write, not the cursor body itself.
 *
 * Fail-silent. Diagnostics breadcrumb to `.auto-approve.log` (sharing the
 * existing log because PostToolUse-from-PreToolUse is a narrow inversion
 * of the same approve action). If rendering fails, the next cursor write
 * gets another chance — no user-visible interruption.
 */

import { basename } from "node:path";
import { logBreadcrumb, resolveShipyardData } from "../_hook_lib.mjs";
import { writeProgress } from "../progress-render.mjs";

const LOG_NAME = ".auto-approve.log";
const CURSOR_BASENAMES = new Set(["EXECUTE-CURSOR.md", "REVIEW-CURSOR.md"]);
const GUARDED_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

export async function run(hookInput, _env) {
  const toolName = hookInput?.tool_name || "";
  if (!GUARDED_TOOLS.has(toolName)) return 0;

  const filePathRaw = hookInput?.tool_input?.file_path || "";
  if (!filePathRaw) return 0;

  const base = basename(filePathRaw);
  if (!CURSOR_BASENAMES.has(base)) return 0;

  const shipyardData = await resolveShipyardData();
  if (!shipyardData) return 0;

  try {
    const wrote = writeProgress(shipyardData);
    logBreadcrumb(shipyardData, LOG_NAME, "render-progress", [
      toolName,
      base,
      wrote ? "ok" : "noop",
    ]);
  } catch (err) {
    // Diagnostics only — never break a user tool call because the
    // human-readable mirror failed to update.
    logBreadcrumb(shipyardData, LOG_NAME, "render-progress", [
      toolName,
      base,
      "error",
      err?.message || String(err),
    ]);
  }
  return 0;
}
