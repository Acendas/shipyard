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
 * per-project breadcrumb file. The resolver reads it as a probe step when
 * env vars are absent. The hook fires before any skill backtick commands
 * run, so the breadcrumb is always available.
 *
 * Why we write to *every* `breadcrumbCandidates()` path, not just $TMPDIR:
 * Claude Code does not hand the SessionStart hook process and the skill `!`
 * backtick subprocess the same TMPDIR. Observed on macOS (2026-05-28): the
 * hook ran with the default user tmpdir (`/var/folders/.../T`) while the
 * skill subprocess had `TMPDIR=/tmp/claude-501`, so a breadcrumb written only
 * to the hook's `os.tmpdir()` was invisible to the skill and `/ship-discuss`
 * failed with "cannot resolve plugin data directory". Writing to the shared
 * POSIX `/tmp` candidate as well closes the gap. The resolver reads from the
 * same candidate list (single source of truth in shipyard-resolver.mjs).
 *
 * Breadcrumb name: shipyard-<projectHash>.plugindata
 * Content: the raw CLAUDE_PLUGIN_DATA path (no newline, no JSON)
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getProjectRoot,
  getProjectHash,
  breadcrumbCandidates,
  ensureDataDirLink,
} from "../shipyard-resolver.mjs";

export function run(_hookInput, env) {
  const pluginData = env.CLAUDE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginData) return 0; // nothing to write — let resolver handle it

  let projectRoot, hash;
  try {
    projectRoot = getProjectRoot();
    hash = getProjectHash(projectRoot);
  } catch {
    return 0; // can't compute root/hash — non-fatal, don't block session start
  }

  // Write to every candidate so the breadcrumb is found regardless of which
  // TMPDIR the reading subprocess resolves. Each write is independent and
  // best-effort — one failing (e.g. a permission-denied /tmp) must not stop
  // the others or block session start.
  for (const breadcrumb of breadcrumbCandidates(hash)) {
    try {
      writeFileSync(breadcrumb, pluginData, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Non-fatal — other candidates / resolver probes still apply.
    }
  }

  // Ensure the env/TMPDIR-independent `<projectRoot>/.shipyard` fallback exists
  // so a later session can resolve the data dir even if the breadcrumb is
  // stranded by a TMPDIR split (the failure this guards against). Never drop a
  // link into a project that was never `/ship-init`-ed — `ensureDataDirLink`
  // now enforces that itself via `dirLooksInitialized` and returns
  // 'uninitialized' without writing.
  //
  // This used to gate on `existsSync(dataDir)`, which was the wrong test: the
  // diagnostic-log writers in `_hook_lib` mkdir the data dir recursively, so
  // merely EDITING a file in any git repo with Shipyard installed minted one,
  // and the next session planted a stray `.shipyard` symlink there (observed
  // 2026-07-28 in the plugin's own repo). The intent was always right; the
  // predicate wasn't.
  //
  // Best-effort: a real .shipyard entry comes back 'blocked' (left untouched)
  // and any fs error is swallowed; the link is a convenience + fallback, never
  // required for correctness.
  try {
    ensureDataDirLink(projectRoot, join(pluginData, "projects", hash));
  } catch {
    // Non-fatal.
  }
  return 0;
}
