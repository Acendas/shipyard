#!/usr/bin/env node
/**
 * Cross-platform hook launcher for Shipyard.
 *
 * Node.js is guaranteed on all platforms (Claude Code requires it).
 * This thin wrapper finds Python and calls hook-runner.py with the
 * correct interpreter, eliminating python3/python/py portability issues.
 *
 * Usage: node hook-runner.mjs <script-name>
 * Stdin is piped through to the Python process (hook JSON input).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDataDir } from "./shipyard-resolver.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookRunner = join(__dirname, "hook-runner.py");

// Find a working Python 3 interpreter
function findPython() {
  const candidates =
    process.platform === "win32"
      ? ["python", "python3", "py"]
      : ["python3", "python"];

  for (const cmd of candidates) {
    try {
      const version = execFileSync(cmd, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (version.startsWith("Python 3")) return cmd;
    } catch {
      // Not found or not Python 3, try next
    }
  }
  return null;
}

const scriptName = process.argv[2];
if (!scriptName) {
  process.stderr.write("hook-runner: missing script name\n");
  process.exit(1);
}

const python = findPython();
if (!python) {
  process.stderr.write(
    "hook-runner: Python 3 not found. Install Python 3 and ensure it is on PATH.\n"
  );
  process.exit(1);
}

// Read stdin (hook JSON) and pipe to Python process
let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {
  // No stdin is fine for some hooks
}

// Compute SHIPYARD_DATA in-process and pass it to the python child via env.
// Previously hook-runner.py would subprocess-call shipyard-resolver.mjs to
// resolve the data dir, adding a third process spawn (~80ms) to every Edit
// hook chain. Doing it here keeps the resolver in-process — Node ESM import
// is free relative to a process spawn — and the python side prefers the env
// var when set, falling back to its own subprocess only for direct invocation
// (tests, manual runs).
const env = { ...process.env };
if (!env.SHIPYARD_DATA) {
  try {
    env.SHIPYARD_DATA = getDataDir({ silent: true });
  } catch {
    // Resolver failed (e.g. no git, no Node env). Let the python side handle
    // the missing env var with its existing subprocess fallback + hard-fail.
  }
}

try {
  const result = execFileSync(python, [hookRunner, scriptName], {
    input: stdin,
    encoding: "utf8",
    timeout: 30000,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result) process.stdout.write(result);
} catch (err) {
  if (err.stderr) process.stderr.write(err.stderr);
  if (err.stdout) process.stdout.write(err.stdout);
  process.exit(err.status || 1);
}
