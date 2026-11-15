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

// ---------------------------------------------------------------------------
// Weakened tests (v4.9). A builder may not loosen a check to make it pass.
// In one real sprint builders did it twice (a brightness floor halved, a
// bottom-margin check dropped) and the orchestrator found both only by
// reading the diffs. These three signals make that reading unnecessary. They
// are flags for the reviewer (MEDIUM, never a hard stop): an expected value
// can change for a good reason, and the step's spec says whether it did.
//   test-number-changed    a line in an EXISTING test file differs only in its numbers
//   test-assertion-removed a hunk in an existing test file removes more assertions than it adds
//   test-file-deleted      an existing test file is gone
// ---------------------------------------------------------------------------
const ASSERT_RE = /\b(assert\w*|expect\w*|EXPECT\w*|ASSERT\w*|CHECK\w*|REQUIRE\w*|should\w*|verify\w*|t\.(?:Error|Fatal)\w*)\s*[(.!]|\bassert\b/;
const NUM_RE = /(?<![A-Za-z_])-?\d+(?:\.\d+)?/g;
// Any language: a file under a tests/spec folder, or named like a test.
const isTestFile = (f) => TEST_FILE_RE.test(f) || /(?:^|\/)(?:tests?|__tests__|specs?)\//i.test(f) || /(?:^|\/)(?:test_[^/]+|[^/]+_test|[^/]+Tests?|[^/]+\.(?:test|spec))\.[A-Za-z0-9]+$/.test(f);

/** Split a -U0 diff into hunks of removed and added lines. */
function parseHunks(diffText) {
  const hunks = [];
  let cur = null, line = null;
  for (const raw of diffText.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { cur = { removed: [], added: [] }; hunks.push(cur); line = Number(h[1]); continue; }
    if (!cur || raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("-")) cur.removed.push(raw.slice(1));
    else if (raw.startsWith("+")) { cur.added.push({ lineNo: line, text: raw.slice(1) }); line += 1; }
  }
  return hunks;
}

function weakenedTestFindings({ base, head, cwd, lang }) {
  const out = [];
  const list = (filter) => git(["diff", `--diff-filter=${filter}`, "--name-only", `${base}..${head}`], cwd).split("\n").map((f) => f.trim()).filter((f) => f && isTestFile(f) && (!lang || extOf(f) === lang));
  for (const file of list("D")) out.push({ confidence: "MEDIUM", pattern: "test-file-deleted", file, line: 1, snippet: "an existing test file was deleted", placeholder_marker: null });
  for (const file of list("M")) {
    let diffText;
    try { diffText = git(["diff", "-U0", `${base}..${head}`, "--", file], cwd); } catch { continue; }
    for (const hunk of parseHunks(diffText)) {
      const at = hunk.added[0]?.lineNo ?? 1;
      // numbers-only edits, paired in order
      for (let i = 0; i < Math.min(hunk.removed.length, hunk.added.length); i++) {
        const a = hunk.removed[i], b = hunk.added[i].text;
        if (a === b || !/\d/.test(a)) continue;
        if (a.replace(NUM_RE, "#").trim() !== b.replace(NUM_RE, "#").trim()) continue;
        out.push({ confidence: "MEDIUM", pattern: "test-number-changed", file, line: hunk.added[i].lineNo, snippet: `${a.trim().slice(0, 70)}  →  ${b.trim().slice(0, 70)}`, placeholder_marker: null });
      }
      const gone = hunk.removed.filter((t) => ASSERT_RE.test(t));
      const back = hunk.added.filter((t) => ASSERT_RE.test(t.text));
      if (gone.length > back.length) out.push({ confidence: "MEDIUM", pattern: "test-assertion-removed", file, line: at, snippet: `${gone.length - back.length} assertion(s) removed, e.g. ${gone[0].trim().slice(0, 90)}`, placeholder_marker: null });
    }
  }
  return out;
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

  try { findings.push(...weakenedTestFindings({ base, head, cwd, lang })); } catch { /* a diff git cannot produce is not a scan failure */ }

  return findings;
}

function printFindings(findings) {
  process.stdout.write(JSON.stringify({ findings }, null, 2) + "\n");
}

/**
 * `shipyard-data scan-stubs <base>..<head> [--lang <x>]`
 */
export function scanStubsCmd(dataDir, args) {
  const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
  const lang = flag("--lang");
  // Both spellings every other diff verb takes: `<base>..<head>` and `--base <b> --head <h>`.
  let rangeArg = args.find((a) => !a.startsWith("--") && a.includes(".."));
  if (!rangeArg && flag("--base") && flag("--head")) rangeArg = `${flag("--base")}..${flag("--head")}`;

  if (!rangeArg) {
    process.stderr.write(
      "shipyard-data scan-stubs: no commit range given\n  Usage: scan-stubs <base>..<head> [--lang <ext>]\n         scan-stubs --base <ref> --head <ref> [--lang <ext>]\n",
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

  const weakened = findings.filter((f) => f.pattern.startsWith("test-") && f.pattern !== "test-no-impl");
  if (weakened.length > 0) {
    process.stderr.write(
      `\n⚠ ${weakened.length} change(s) to existing tests removed an assertion, deleted a test or changed a number. A check is never loosened to make it pass: confirm each against the step's spec, and send the step back if the spec does not ask for it.\n` +
        weakened.map((f) => `  ${f.file}:${f.line}: ${f.pattern} — ${f.snippet}`).join("\n") + "\n",
    );
    try { logEvent(dataDir, "test_weakening_flagged", { count: weakened.length, files: [...new Set(weakened.map((f) => f.file))].join(",") }); } catch { /* best-effort */ }
  }

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
