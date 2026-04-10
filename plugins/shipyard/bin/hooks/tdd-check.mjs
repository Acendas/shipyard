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
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { logEvent, resolveShipyardData } from "../_hook_lib.mjs";

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

// Match task files: any .md file under a `spec/tasks/` directory.
// Accepts `spec/tasks/T001-foo.md`, `.shipyard/spec/tasks/T001-foo.md`,
// absolute-path data dirs (`/Users/.../data/.../spec/tasks/T001.md`), etc.
export function isTaskFile(filepath) {
  return /(?:^|[/\\])spec[/\\]tasks[/\\][^/\\]+\.md$/i.test(filepath);
}

// Minimal YAML frontmatter parser — we only need to read scalar string fields
// like `kind:`, `status:`, `verify_output:`. No lists, no nesting. If the file
// has no `---` delimiters, returns an empty object (no frontmatter).
export function parseTaskFrontmatter(content) {
  const m = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    // Strip surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Treat trailing-comment-only values as empty.
    if (val.startsWith("#")) val = "";
    out[kv[1]] = val;
  }
  return out;
}

/**
 * Scan staged task files for the silent-pass failure mode and related
 * schema-drift issues. Returns:
 *   - { block: true, message: "..." } if a commit must be rejected
 *   - { block: false } otherwise (may still emit events)
 *
 * Called BEFORE the main impl/test-files TDD check so that operational
 * task status transitions are caught on a path where `implFiles.length === 0`
 * (task files are .md and classified as exempt). See README inside this file.
 */
export function checkOperationalTaskFiles(staged, shipyardData) {
  const taskFiles = staged.filter(isTaskFile);
  if (taskFiles.length === 0) return { block: false };

  for (const f of taskFiles) {
    let content = "";
    try {
      content = readFileSync(f, "utf8");
    } catch (_err) {
      // File was staged-for-delete or unreadable — skip, do not panic.
      continue;
    }
    const fm = parseTaskFrontmatter(content);
    const kind = fm.kind || "";
    const status = fm.status || "";
    const verifyOutput = fm.verify_output || "";

    // Case 1: `status: done` set on a `kind: operational` task with no
    // `verify_output`. This is the exact silent-pass failure mode — the task
    // is being marked done without captured evidence that the verify command
    // ran. Hard block with an override-able message.
    if (kind === "operational" && status === "done" && !verifyOutput) {
      logEvent(shipyardData, "operational_task_silent_pass_blocked", {
        task_file: f,
      });
      return {
        block: true,
        message:
          "❌ SILENT-PASS BLOCKED: operational task marked done without verify_output.\n" +
          "\n" +
          `Task file: ${f}\n` +
          "\n" +
          "A kind:operational task's deliverable is running a command and capturing\n" +
          "its output. Marking it done without a verify_output field means no command\n" +
          "output was recorded — this is the exact /ship-execute silent-pass bug.\n" +
          "\n" +
          "Fix: dispatch the task through the operational path in ship-execute (see\n" +
          "skills/ship-execute/references/operational-tasks.md), which populates\n" +
          "verify_output from a shipyard-logcap capture of a passing run.\n" +
          "\n" +
          "If you really need to commit this state manually (you shouldn't), override with:\n" +
          "  git commit --no-verify\n",
      };
    }

    // Case 2: `status: done` on a task with no `kind:` field at all. This is
    // a legacy (pre-schema-migration) task file. Warn via event, do NOT block
    // — backwards compatibility matters more than aggressive migration here.
    // The warning event shows up in shipyard-context diagnose so users know
    // to add the field.
    if (!fm.kind && status === "done") {
      logEvent(shipyardData, "legacy_task_no_kind", {
        task_file: f,
      });
      // Do not block.
    }
  }

  return { block: false };
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
  // Honor --no-verify as an explicit bypass. Log it — bypasses on tests are
  // the single most common root cause of "tests were passing yesterday"
  // investigations, and the timeline needs to show when they happened.
  if (command.includes("--no-verify")) {
    logEvent(shipyardData, "tdd_bypass_used", {});
    return 0;
  }

  const staged = getStagedFiles();
  if (staged.length === 0) return 0;

  // Check operational-task silent-pass BEFORE the impl/test filtering. Task
  // files are .md (exempt) so they would otherwise skip the TDD path entirely.
  // The silent-pass bug precisely lived in that gap — an operational task
  // being marked done with an empty tree, no impl files, no test files.
  let opCheck;
  try {
    opCheck = checkOperationalTaskFiles(staged, shipyardData);
  } catch (err) {
    // Defensive: never let this new check block commits on a panic.
    // Emit a diagnostic event and continue as if it didn't run.
    logEvent(shipyardData, "tdd_check_operational_crash", {
      error: String(err && err.message ? err.message : err),
    });
    opCheck = { block: false };
  }
  if (opCheck.block) {
    process.stderr.write(opCheck.message);
    return 2;
  }

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

  // No implementation files → fine (could be config, docs, tests-only).
  // The operational task check above already handled the silent-pass case
  // where this short-circuit used to be the last line of defense.
  if (implFiles.length === 0) return 0;

  // Implementation files but no test files → block.
  if (implFiles.length > 0 && testFiles.length === 0) {
    logEvent(shipyardData, "tdd_violation_detected", {
      impl_count: implFiles.length,
      test_count: 0,
      first_file: implFiles[0],
    });
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
