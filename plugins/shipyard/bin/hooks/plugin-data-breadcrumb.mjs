/**
 * SessionStart hook: writes CLAUDE_PLUGIN_DATA to a breadcrumb file.
 *
 * Problem: Claude Code sets CLAUDE_PLUGIN_DATA and CLAUDE_PLUGIN_ROOT as
 * environment variables for hook processes and MCP/LSP subprocesses, but
 * NOT for skill `!` backtick subprocesses. Backtick commands only get
 * inline text substitution of ${CLAUDE_PLUGIN_DATA} in the command string,
 * not the env var. Since shipyard-context and shipyard-data read
 * process.env.CLAUDE_PLUGIN_DATA, they fail on first install when no
 * legacy data dir exists.
 *
 * Fix: this SessionStart hook writes the CLAUDE_PLUGIN_DATA value to a
 * per-project breadcrumb file at a deterministic path in $TMPDIR. The
 * resolver reads it as a probe step when env vars are absent. The hook
 * fires before any skill backtick commands run, so the breadcrumb is
 * always available.
 *
 * Breadcrumb path: $TMPDIR/shipyard-<projectHash>.plugindata
 * Content: the raw CLAUDE_PLUGIN_DATA path (no newline, no JSON)
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectRoot, getProjectHash } from "../shipyard-resolver.mjs";

export function run(_hookInput, env) {
  const pluginData = env.CLAUDE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginData) return 0; // nothing to write — let resolver handle it

  let hash;
  try {
    hash = getProjectHash(getProjectRoot());
  } catch {
    return 0; // can't compute hash — non-fatal, don't block session start
  }

  const breadcrumb = join(tmpdir(), `shipyard-${hash}.plugindata`);
  try {
    writeFileSync(breadcrumb, pluginData, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Non-fatal — skill backtick commands will try other resolver probes.
  }
  return 0;
}
