/**
 * Post-commit hook: reset loop detection and trigger learning capture.
 *
 * Node port of project-files/scripts/on-commit.py.
 *
 * After a successful git commit:
 *  1. Reset the loop detection counter for committed files
 *  2. Detect if a struggle just resolved
 *  3. Signal the agent to capture learnings into .claude/rules/learnings/
 *
 * STDOUT CONTRACT: PostToolUse hook — stdout becomes a conversation
 * message to Claude. Learning prompts go to stdout intentionally.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, resolveShipyardData, sanitizeForLog } from "../_hook_lib.mjs";

const DOMAIN_PATTERNS = [
  [["auth", "login", "session", "token", "jwt", "oauth"], "auth"],
  [["api", "route", "endpoint", "handler", "controller"], "api"],
  [["test", "spec", "__test", ".test.", ".spec."], "testing"],
  [["component", "page", "layout", "view", "ui"], "ui"],
  [["style", "css", "scss", "tailwind", "theme"], "styling"],
  [["model", "schema", "migration", "database", "db", "query", "supabase", "prisma"], "data"],
  [["hook", "context", "provider", "store", "state", "redux", "zustand"], "state"],
  [["config", "env", ".config", "setting"], "config"],
  [["util", "helper", "lib", "service", "action"], "logic"],
];

function detectDomain(filePath) {
  const lower = filePath.toLowerCase();
  for (const [keywords, domain] of DOMAIN_PATTERNS) {
    if (keywords.some((kw) => lower.includes(kw))) return domain;
  }
  return "general";
}

function getCommittedFiles() {
  try {
    const result = execFileSync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
    );
    return new Set(result.trim().split("\n").map((s) => s.trim()).filter(Boolean));
  } catch (err) {
    if (err.code === "ENOENT") {
      process.stderr.write("⚠️  on-commit: git not found on PATH\n");
    } else {
      process.stderr.write(`⚠️  on-commit: git diff-tree failed: ${err.message}\n`);
    }
    return new Set();
  }
}

function resetLoopState(loopStatePath) {
  if (!existsSync(loopStatePath)) return [];

  const committedFiles = getCommittedFiles();
  if (committedFiles.size === 0) return [];

  let state;
  try {
    state = JSON.parse(readFileSync(loopStatePath, "utf8"));
  } catch (err) {
    process.stderr.write(`⚠️  on-commit: Corrupt loop state, skipping reset: ${err.message}\n`);
    return [];
  }
  if (!state || typeof state !== "object") return [];
  if (!state.edits) state.edits = {};
  if (!state.struggles) state.struggles = {};

  const resolved = [];
  for (const filePath of committedFiles) {
    if (state.struggles[filePath]) {
      resolved.push({
        file: filePath,
        edit_count: state.struggles[filePath].edit_count || 0,
      });
    }
  }

  for (const f of committedFiles) {
    delete state.edits[f];
    delete state.struggles[f];
  }

  try {
    atomicWrite(loopStatePath, JSON.stringify(state, null, 2));
  } catch (err) {
    process.stderr.write(`⚠️  on-commit: Failed to save loop state: ${err.message}\n`);
  }

  return resolved;
}

function signalLearningCapture(resolved) {
  if (resolved.length === 0) return;

  const files = resolved.map((s) => s.file);
  const maxEdits = Math.max(...resolved.map((s) => s.edit_count));
  const domains = new Set(files.map(detectDomain));
  const domainHint = [...domains].sort().join(", ");
  const safeFiles = files.map((f) => sanitizeForLog(f, 200));

  process.stdout.write("\n");
  process.stdout.write("📝 LEARNING OPPORTUNITY — You just resolved a struggle.\n");
  process.stdout.write(`   Files: ${safeFiles.join(", ")}\n`);
  process.stdout.write(`   Edits before resolution: ${maxEdits}\n`);
  process.stdout.write(`   Suggested domain(s): ${domainHint}\n`);
  process.stdout.write("\n");
  process.stdout.write("   Append what you learned to .claude/rules/learnings/<domain>.md\n");
  process.stdout.write("   (create the file if it doesn't exist)\n");
  process.stdout.write("\n");
  process.stdout.write("   Format each entry as:\n");
  process.stdout.write("   ### [Short title]\n");
  process.stdout.write("   **Symptom:** [What the error looked like]\n");
  process.stdout.write("   **Cause:** [What was actually wrong]\n");
  process.stdout.write("   **Fix:** [What solved it]\n");
  process.stdout.write("\n");
  process.stdout.write("   The file needs paths: frontmatter so it auto-loads for relevant files.\n");
  process.stdout.write("   Keep entries to 3 lines. These load into context automatically via Claude rules.\n");
}

export async function run(hookInput, _env) {
  const shipyardData = (await resolveShipyardData()) || ".shipyard";
  const loopStatePath = join(shipyardData, ".loop-state.json");

  const toolInput = hookInput?.tool_input;
  let command = "";
  if (toolInput && typeof toolInput === "object") {
    command = toolInput.command || "";
  } else if (toolInput !== undefined && toolInput !== null) {
    command = String(toolInput);
  }

  if (!/\bgit\s+commit\b/.test(command)) return 0;

  const toolResponse = hookInput?.tool_response;
  const responseStr = toolResponse ? String(toolResponse).toLowerCase() : "";
  if (responseStr.includes("nothing to commit") || responseStr.includes("no changes added")) {
    return 0;
  }

  const resolved = resetLoopState(loopStatePath);
  signalLearningCapture(resolved);
  return 0;
}
