/**
 * PreToolUse hook: verify TDD compliance on git commit.
 *
 * Node port of project-files/scripts/tdd-check.py.
 *
 * Checks that staged changes include test files alongside implementation
 * files. Blocks commits that have only implementation code with no tests
 * via exit code 2.
 *
 * STDOUT CONTRACT: PreToolUse hooks can block tool execution via exit code
 * 2. All output goes to stderr (violations, warnings). Stdout is unused —
 * PreToolUse hooks that write to stdout risk corrupting tool input
 * (Claude Code bug #40262).
 */

import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { resolveShipyardData } from "../_hook_lib.mjs";

// Path segments that indicate test directories
const TEST_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "__spec__"]);

// File name patterns that indicate test files
const TEST_SUFFIXES = [".test.", ".spec.", "_test.", "_spec."];

// File patterns considered implementation files (source code)
const IMPL_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rb", ".go",
  ".rs", ".java", ".kt", ".swift", ".dart",
];

// Extensions that are never flagged (config, docs, assets)
const EXEMPT_EXTENSIONS = [
  ".md", ".json", ".yaml", ".yml", ".toml", ".lock",
  ".css", ".scss", ".html", ".svg", ".png", ".jpg",
];

function getStagedFiles() {
  try {
    const result = execFileSync("git", ["diff", "--cached", "--name-only"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    return result.trim().split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") {
      process.stderr.write("⚠️  tdd-check: git not found on PATH\n");
    } else {
      process.stderr.write(`⚠️  tdd-check: git diff failed: ${err.message}\n`);
    }
    return [];
  }
}

function isTestFile(filepath) {
  const parts = filepath.split(/[/\\]/).map((p) => p.toLowerCase());
  for (const part of parts) {
    if (TEST_SEGMENTS.has(part)) return true;
  }
  const lower = filepath.toLowerCase();
  return TEST_SUFFIXES.some((s) => lower.includes(s));
}

function isImplFile(filepath) {
  return IMPL_EXTENSIONS.some((ext) => filepath.endsWith(ext));
}

function isExempt(filepath, exemptDirs) {
  const lower = filepath.toLowerCase();
  if (exemptDirs.some((d) => lower.startsWith(d))) return true;
  if (EXEMPT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  return false;
}

export async function run(hookInput, _env) {
  // Resolve SHIPYARD_DATA to compute exempt prefixes. When the data dir is
  // an absolute path (the plugin-data layout), Shipyard files live outside
  // the repo and only `.claude/` needs explicit exemption. When relative,
  // both `.claude/` and the data prefix are exempt.
  const shipyardData = (await resolveShipyardData()) || ".shipyard";
  const exemptDirs = isAbsolute(shipyardData)
    ? [".claude/", ".claude\\"]
    : [".claude/", ".claude\\", `${shipyardData}/`, `${shipyardData}\\`];

  const toolInput = hookInput?.tool_input;
  let command = "";
  if (typeof toolInput === "object" && toolInput !== null) {
    command = toolInput.command || "";
  } else if (toolInput !== undefined) {
    command = String(toolInput);
  }

  // Only check on actual git commit commands
  if (!/\bgit\s+commit\b/.test(command)) return 0;
  // Honor --no-verify as an explicit bypass
  if (command.includes("--no-verify")) return 0;

  const staged = getStagedFiles();
  if (staged.length === 0) return 0;

  const implFiles = [];
  const testFiles = [];

  for (const f of staged) {
    if (isExempt(f, exemptDirs)) continue;
    if (isTestFile(f)) {
      testFiles.push(f);
    } else if (isImplFile(f)) {
      implFiles.push(f);
    }
  }

  // No implementation files → fine (could be config, docs, tests-only)
  if (implFiles.length === 0) return 0;

  // Implementation files but no test files → block.
  if (implFiles.length > 0 && testFiles.length === 0) {
    process.stderr.write("❌ TDD VIOLATION: Implementation files staged without tests.\n");
    process.stderr.write("\n");
    process.stderr.write("Implementation files:\n");
    for (const f of implFiles) {
      process.stderr.write(`  ${f}\n`);
    }
    process.stderr.write("\n");
    process.stderr.write("Write failing tests first (Red), then implement (Green).\n");
    process.stderr.write("Stage test files alongside implementation files.\n");
    process.stderr.write("\n");
    process.stderr.write("If this is a legitimate exception (refactor, config), commit with:\n");
    process.stderr.write("  git commit --no-verify\n");
    return 2;
  }

  return 0;
}
