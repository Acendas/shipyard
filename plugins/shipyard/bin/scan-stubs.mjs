/**
 * scan-stubs — diff scanner for stub patterns, backing
 * `shipyard-data scan-stubs <base>..<head> [--lang <x>]`.
 *
 * Implements the pattern catalog specified in
 * `skills/anti-stub-scan/SKILL.md` (that file is now the spec; this module
 * is the runtime). Runs on the orchestrator side after a builder subagent
 * returns COMPLETE, before the task is marked done — the "second line"
 * behind the prompt-level Iron Law.
 *
 * Exit codes:
 *   0 — clean, or only MEDIUM/LOW findings (advisory).
 *   3 — at least one HIGH-confidence finding with no `shipyard:placeholder`
 *       marker. Caller re-dispatches with the printed findings.
 *
 * Only ADDED lines (`+` in a `-U0` unified diff) are scanned — untouched
 * files/lines are not the subagent's responsibility. Cross-platform Node;
 * shells out to `git diff` only (already a hard dependency everywhere else
 * in bin/).
 */

import { execFileSync } from "node:child_process";
import { logEvent } from "./_hook_lib.mjs";

// --- pattern catalog -----------------------------------------------------
// Each entry: { pattern, confidence, test(line, ctx) -> boolean }.
// `ctx` carries { file, ext, prevAdded, allAddedInFile } for patterns that
// need more than the single line.

const NOT_IMPLEMENTED_RE = /\b(not[_\s-]?implemented|unimplemented)\b/i;

const EMPTY_BODY_PATTERNS = {
  py: [/^\s*pass\s*$/, /^\s*\.\.\.\s*$/],
  generic: [/^\s*\{\s*\}\s*;?\s*$/],
};

const NOT_IMPL_PATTERNS = [
  { ext: "py", re: /raise\s+NotImplementedError\b/ },
  { ext: null, re: /throw\s+new\s+Error\(\s*["'`][^"'`]*not[_\s-]?implemented[^"'`]*["'`]/i },
  { ext: "rs", re: /\b(unimplemented|todo)!\s*\(/ },
  { ext: "go", re: /panic\(\s*["'`][^"'`]*not[_\s-]?implemented[^"'`]*["'`]/i },
  { ext: "swift", re: /fatalError\(\s*["'`][^"'`]*not implemented[^"'`]*["'`]/i },
];

const LONE_RETURN_NULL_RE =
  /^\s*return\s+(null|undefined|None|""|''|\[\]|\{\}|false)\s*;?\s*$/;

const TODO_RE = /(\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b|@todo\b|#\s*todo\b|\/\/\s*todo\b)/i;

const PLACEHOLDER_MARKER_RE = /shipyard:placeholder\s+reason=(\S+)/;

// A whole-line comment (any of the three common comment syntaxes) that
// contains what looks like a call site: `identifier(`. Catches a call that
// was wired then commented out — the "disabled wiring" false-completion
// vector. Deliberately line-scoped (not full-diff-aware) to keep the CLI's
// precision modest, per the spec's "modest precision over over-engineered
// scanner" guidance.
const COMMENTED_CALL_SITE_RE =
  /^\s*(?:\/\/|#|\/\*)\s*[A-Za-z_$][A-Za-z0-9_$.]*\s*\([^)]*\)\s*;?\s*(?:\*\/)?\s*$/;

// Test-file naming conventions across the languages scan-stubs already
// targets (python/js/ts/rust/go/swift). Used only for the file-level
// test-no-impl check below, not line scanning.
const TEST_FILE_RE =
  /(?:^|[._-])(?:test|spec)s?\.(?:[jt]sx?|py|rb)$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py)$|_spec\.rb$/i;

function extOf(file) {
  const m = /\.([A-Za-z0-9]+)$/.exec(file);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Scan a single added line (already stripped of its leading `+`) and
 * return zero or more { pattern, confidence } matches. `prevLine` is the
 * previous added line in this file's diff hunk (or the line immediately
 * above in the unified diff), used to look for the placeholder marker.
 */
function scanLine(line, ext) {
  const findings = [];

  const emptyBodyPatterns = [
    ...(EMPTY_BODY_PATTERNS[ext] ?? []),
    ...EMPTY_BODY_PATTERNS.generic,
  ];
  if (emptyBodyPatterns.some((re) => re.test(line))) {
    findings.push({ pattern: "empty-body", confidence: "HIGH" });
  }

  if (NOT_IMPLEMENTED_RE.test(line)) {
    for (const { ext: patExt, re } of NOT_IMPL_PATTERNS) {
      if ((patExt === null || patExt === ext) && re.test(line)) {
        findings.push({ pattern: "not-implemented-marker", confidence: "HIGH" });
        break;
      }
    }
  }

  if (LONE_RETURN_NULL_RE.test(line)) {
    findings.push({ pattern: "lone-return-null", confidence: "MEDIUM" });
  }

  if (TODO_RE.test(line)) {
    findings.push({ pattern: "todo-marker", confidence: "HIGH" });
  }

  if (COMMENTED_CALL_SITE_RE.test(line) && !PLACEHOLDER_MARKER_RE.test(line)) {
    findings.push({ pattern: "commented-call-site", confidence: "MEDIUM" });
  }

  return findings;
}

/**
 * Parse a `-U0` unified diff for one file into an ordered list of
 * { lineNo, text } for ADDED lines only (a "+" line that isn't the
 * `+++` file header).
 */
function parseAddedLines(diffText) {
  const lines = diffText.split("\n");
  const added = [];
  let curLine = null;

  for (const raw of lines) {
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunkMatch) {
      curLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      if (curLine === null) continue;
      added.push({ lineNo: curLine, text: raw.slice(1) });
      curLine += 1;
    }
    // context/removed lines don't advance curLine in a -U0 diff (there is
    // no context), but guard anyway: a bare removed line still consumes no
    // added-line-number slot.
  }
  return added;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Run the full scan for `base..head` and return the findings array
 * (the JSON shape documented in anti-stub-scan/SKILL.md).
 */
export function scanStubs({ base, head, cwd = process.cwd(), lang = null }) {
  const nameOnly = git(["diff", "--name-only", `${base}..${head}`], cwd);
  const files = nameOnly.split("\n").map((f) => f.trim()).filter(Boolean);

  const findings = [];

  // test-no-impl (MEDIUM, file-level): a test file was added/changed but
  // no non-test file was touched in the same diff — either the subagent
  // forgot the implementation or the test stubbed itself. File-level
  // rather than per-line since "was any prod file touched" isn't a
  // property of a single line.
  const testFiles = files.filter((f) => TEST_FILE_RE.test(f));
  const nonTestFiles = files.filter((f) => !TEST_FILE_RE.test(f));
  if (testFiles.length > 0 && nonTestFiles.length === 0) {
    for (const file of testFiles) {
      if (lang && extOf(file) !== lang) continue;
      findings.push({
        confidence: "MEDIUM",
        pattern: "test-no-impl",
        file,
        line: 1,
        snippet: "test file added/changed with no corresponding production-code change in this diff",
        placeholder_marker: null,
      });
    }
  }

  for (const file of files) {
    const ext = extOf(file);
    if (lang && ext !== lang) continue;

    let diffText;
    try {
      diffText = git(["diff", "-U0", `${base}..${head}`, "--", file], cwd);
    } catch {
      continue; // e.g. binary file or deleted file — skip rather than fail the scan
    }

    const added = parseAddedLines(diffText);

    for (let i = 0; i < added.length; i++) {
      const { lineNo, text } = added[i];
      const matches = scanLine(text, ext);
      if (matches.length === 0) continue;

      // Placeholder marker: look at nearby preceding ADDED lines (the
      // documented convention — marker comment on the line above the stub,
      // or above the function declaration when the stub body is a
      // separate line, e.g. `def g():` then `pass`). Walk back a small
      // window of added entries rather than requiring exact lineNo-1, so
      // a marker above a multi-line declaration is still found; cap the
      // window so a marker several unrelated lines up doesn't spuriously
      // suppress an unrelated finding.
      let placeholderMarker = null;
      for (let back = 1; back <= 3 && i - back >= 0; back++) {
        const prev = added[i - back];
        if (lineNo - prev.lineNo > 3) break; // too far up in the file
        const m = PLACEHOLDER_MARKER_RE.exec(prev.text);
        if (m) {
          placeholderMarker = m[1];
          break;
        }
      }

      for (const { pattern, confidence } of matches) {
        findings.push({
          confidence: placeholderMarker ? "LOW" : confidence,
          pattern,
          file,
          line: lineNo,
          snippet: text.trim().slice(0, 120),
          placeholder_marker: placeholderMarker,
        });
      }
    }
  }

  return findings;
}

function printFindings(findings) {
  process.stdout.write(JSON.stringify({ findings }, null, 2) + "\n");
}

/**
 * `shipyard-data scan-stubs <base>..<head> [--lang <x>]`
 */
export function scanStubsCmd(dataDir, args) {
  const rangeArg = args.find((a) => !a.startsWith("--") && a.includes(".."));
  const langIdx = args.indexOf("--lang");
  const lang = langIdx !== -1 ? args[langIdx + 1] : null;

  if (!rangeArg) {
    process.stderr.write(
      "shipyard-data scan-stubs: expected <base>..<head> [--lang <x>]\n",
    );
    process.exit(2);
  }

  const sepIdx = rangeArg.indexOf("..");
  const base = rangeArg.slice(0, sepIdx);
  const head = rangeArg.slice(sepIdx + 2);
  if (!base || !head) {
    process.stderr.write(
      `shipyard-data scan-stubs: malformed range "${rangeArg}" — expected <base>..<head>\n`,
    );
    process.exit(2);
  }

  let findings;
  try {
    findings = scanStubs({ base, head, lang });
  } catch (err) {
    process.stderr.write(`shipyard-data scan-stubs: ${err.message}\n`);
    process.exit(2);
    return;
  }

  const highBlocking = findings.filter(
    (f) => f.confidence === "HIGH" && !f.placeholder_marker,
  );

  printFindings(findings);

  logEvent(dataDir, "stub_scan_run", {
    findings: findings.length,
    high: highBlocking.length,
  });

  if (highBlocking.length > 0) {
    process.stderr.write(
      `\n⛔ ${highBlocking.length} HIGH-confidence stub finding(s) without a placeholder marker.\n` +
        highBlocking
          .map((f) => `  ${f.file}:${f.line}: ${f.pattern} — ${f.snippet}`)
          .join("\n") +
        "\n",
    );
    process.exit(3);
  }
}
