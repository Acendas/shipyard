#!/usr/bin/env node
/**
 * Cross-platform hook dispatcher for Shipyard.
 *
 * In-process Node.js implementation. Dispatches hook events directly to
 * Node modules under `bin/hooks/` via `import()`. The previous version
 * spawned a Python child process — required Python 3 on every user
 * machine and added ~80ms of process startup to every Edit/Write hook.
 *
 * Phase H4 has shipped: the Python implementation is gone. The runner
 * is purely in-process.
 *
 * Usage: node hook-runner.mjs <hook-name>
 * Stdin: hook JSON input piped through to the dispatched module.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDataDir } from "./shipyard-resolver.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const HOOKS_DIR = join(__dirname, "hooks");

const scriptName = process.argv[2];
if (!scriptName) {
  process.stderr.write("hook-runner: missing script name\n");
  process.exit(1);
}

// Defense in depth: validate the hook name against a strict allowlist
// before constructing a module path. Even though the name comes from
// hooks.json (which we trust), a misconfigured matcher or future env-var
// interpolation could feed in something unexpected.
if (!HOOK_NAME_RE.test(scriptName)) {
  process.stderr.write(`hook-runner: invalid hook name ${JSON.stringify(scriptName)}\n`);
  process.exit(1);
}

// Read stdin (hook JSON) before doing anything else. The Python path
// piped stdin into the Python child; we now parse it inline.
let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {
  // No stdin is fine for some hooks (e.g., post-compact)
}

// Compute SHIPYARD_DATA in-process and pass it to the hook via env.
// In-process import is free relative to a process spawn — the resolver's
// worktree-parent detection runs once per hook fire either way.
//
// Customer regression note: this used to be silently swallowed when
// getDataDir threw, masking the root cause for months. The stderr line
// is how customers will know which case they're in.
const env = { ...process.env };
if (!env.SHIPYARD_DATA) {
  try {
    env.SHIPYARD_DATA = getDataDir({ silent: true });
  } catch (err) {
    const errName = err?.name || "Error";
    const firstLine = (err?.message || String(err)).split("\n")[0].slice(0, 240);
    process.stderr.write(
      `shipyard hook-runner: getDataDir threw (${errName}): ${firstLine}\n`,
    );
  }
}

// Parse stdin JSON into hookInput. Hooks that need raw text get an empty
// object — they should treat absent fields as "no work to do" and exit 0.
let hookInput = {};
if (stdin) {
  try {
    hookInput = JSON.parse(stdin);
  } catch {
    hookInput = {};
  }
}

// In-process dispatch via dynamic import.
const modulePath = join(HOOKS_DIR, `${scriptName}.mjs`);
if (!existsSync(modulePath)) {
  process.stderr.write(`hook-runner: no such hook ${JSON.stringify(scriptName)}\n`);
  process.exit(1);
}
// Mirror env for the child via process.env (the in-process hook reads
// process.env directly). Restore on exit.
const origEnv = {};
for (const k of Object.keys(env)) {
  origEnv[k] = process.env[k];
  process.env[k] = env[k];
}
try {
  const url = "file://" + modulePath;
  const mod = await import(url);
  if (typeof mod.run !== "function") {
    process.stderr.write(
      `hook-runner: hook ${scriptName} does not export run()\n`,
    );
    process.exit(1);
  }
  const code = await mod.run(hookInput, env);
  process.exit(typeof code === "number" ? code : 0);
} catch (err) {
  process.stderr.write(`hook-runner: hook ${scriptName} threw: ${err?.message || err}\n`);
  process.exit(1);
} finally {
  // Restore env on exit (though we exit immediately afterward).
  for (const k of Object.keys(origEnv)) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
}
