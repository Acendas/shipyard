/**
 * `shipyard-data infra <check|apply> [--json]` (4.0): is the project's test
 * setup as fast as it can be, and if not, set it up.
 *
 * Owner: "I would expect Shipyard to set up the test and build infrastructure
 * to be at the best level." Shipyard already had the hooks for it
 * (`test_commands.scoped` for "only the tests a change can affect",
 * `test_commands.rerun_failed` for fix loops) but left filling them to the
 * project. On a real project both were empty, so every wave boundary ran a
 * 4 to 11 minute suite, about 44 of a sprint's first 140 minutes.
 *
 * `check` reports each item and exits 3 when something can be improved now.
 * `apply` sets what the project's own tools already support (never a command
 * the tool does not have) and, when the rest needs real work and the suite is
 * slow enough to matter, files ONE land-now task (`spec/tasks/T###`) with a
 * measurable "done when". Nothing in the project is edited from here.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { detectStack } from "./init-data.mjs";
import { projectScope } from "./verify-ledger.mjs";
import { readEvents } from "./terminal-gate.mjs";
import { logEvent } from "./_hook_lib.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "shipyard-data.mjs");
export const SLOW_SUITE_SECONDS = 60;
export const TASK_MARKER = "<!-- shipyard:infra fast-test-runs -->";

const readIf = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/** `key:` inside a top-level `block:` of config.md's frontmatter, unquoted, without a trailing comment. */
function blockScalar(config, block, key) {
  const fm = (config.match(/^---\r?\n([\s\S]*?)\r?\n---/) ?? [])[1] ?? "";
  const lines = fm.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${block}:\\s*$`).test(l));
  if (start === -1) return "";
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    const m = lines[i].match(new RegExp(`^\\s+${key}:\\s*(.*)$`));
    if (!m) continue;
    let v = m[1].trim();
    const q = v[0];
    if (q === '"' || q === "'") { const end = v.indexOf(q, 1); return end > 0 ? v.slice(1, end) : v.slice(1); }
    return v.replace(/\s+#.*$/, "").trim();
  }
  return "";
}

function projectFolder(dataDir, projectDir) {
  const root = readIf(join(dataDir, ".project-root")).trim();
  if (!root) return { root: "", folder: "" };
  const scope = projectScope(root, projectDir);
  return { root, folder: scope ? join(root, scope) : root };
}

function runnerPrefix(folder) {
  const has = (p) => existsSync(join(folder, p));
  return has("pnpm-lock.yaml") ? "pnpm exec" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bunx" : "npx";
}

/** What the project's own test tool can already do. Only flags the tool really has. */
function knownTool(framework, folder) {
  const x = runnerPrefix(folder);
  switch (framework) {
    case "jest": return { failed: `${x} jest --onlyFailures`, affected: `${x} jest --changedSince={base}`, stopsEarly: /(^|\s)(--bail|-b)(\s|=|$)/ };
    case "vitest": return { affected: `${x} vitest related {files} --run`, stopsEarly: /(^|\s)--bail(\s|=|$)/ };
    case "pytest": return { failed: "python3 -m pytest -q --lf", stopsEarly: /(^|\s)(-x|--exitfirst|--maxfail[= ]1)(\s|$)/, hint: "For affected tests: the pytest-testmon plugin (`pytest --testmon`) runs only the tests a change can reach." };
    case "go test": return { native: "go caches the result of every package whose inputs did not change" };
    case "junit": return { native: "the build tool skips test tasks whose inputs did not change" };
    case "make test": return { needsKeepGoing: /(^|\s)(-k|--keep-going)(\s|$)/, hint: "For make: give each test a stamp file that depends on its binary (the rule runs the test, then touches the stamp), and one target that depends on every stamp. make then skips every test whose binary was not rebuilt, and a failed test leaves no stamp, so the same target is also the failed-only run. Builders compile in their own copy of the code, from nothing: when a compiler cache (ccache) is installed, compile through it so a file that did not change is not compiled again." };
    case "cargo test": return { hint: "cargo keeps no test results: scope by the crates a change touches (`cargo test -p <crate>`), or use cargo-nextest." };
    default: return {};
  }
}

/** Median seconds of the green runs of this exact command (newest 20). */
function measured(dataDir, command) {
  if (!command) return { runs: 0, median_seconds: null };
  const secs = readEvents(dataDir, 20000).filter((e) => e.type === "command_run" && String(e.command ?? "") === command.slice(0, 160) && Number(e.exit) === 0 && Number.isFinite(Number(e.seconds))).slice(-20).map((e) => Number(e.seconds)).sort((a, b) => a - b);
  return { runs: secs.length, median_seconds: secs.length ? secs[Math.floor(secs.length / 2)] : null };
}

/** The task this command filed, if any: { id, open }. Filed once per project: a closed one is not filed again. */
function infraTask(dataDir) {
  let names = [];
  try { names = readdirSync(join(dataDir, "spec", "tasks")); } catch { return null; }
  let found = null;
  for (const n of names) {
    const text = readIf(join(dataDir, "spec", "tasks", n));
    if (!text.includes(TASK_MARKER)) continue;
    const status = (text.match(/^status:\s*(\S+)/m) ?? [])[1] ?? "";
    const t = { id: (n.match(/^(T\d+)/) ?? [])[1] ?? n, open: !["done", "dropped"].includes(status) };
    if (t.open) return t;
    found = t;
  }
  return found;
}

/** The report. Pure over the files and the event log it reads. */
export function infraReport(dataDir, { projectDir = null } = {}) {
  const config = readIf(join(dataDir, "config.md"));
  const { folder } = projectFolder(dataDir, projectDir);
  const stack = folder ? detectStack(folder) : { testing_framework: "", unit: "" };
  const unit = blockScalar(config, "test_commands", "unit");
  const failed = blockScalar(config, "test_commands", "rerun_failed");
  const affected = blockScalar(config, "test_commands", "scoped");
  // The command itself names the tool when the project's files do not (a
  // project whose manifest sits elsewhere, a monorepo sub-folder).
  if (!stack.testing_framework && unit) {
    stack.testing_framework = /\bpytest\b/.test(unit) ? "pytest" : /\bvitest\b/.test(unit) ? "vitest" : /\bjest\b/.test(unit) ? "jest"
      : /\bgo test\b/.test(unit) ? "go test" : /\bcargo test\b/.test(unit) ? "cargo test" : /\bgradlew?\b.*\btest\b/.test(unit) ? "junit"
      : /(^|\s|\/)make\b/.test(unit) ? "make test" : "";
  }
  const tool = knownTool(stack.testing_framework, folder);
  const suite = { command: unit, ...measured(dataDir, unit) };
  const items = [];

  if (unit) items.push({ id: "test-command", title: "A command that runs the tests", state: "ok", detail: unit });
  else if (stack.unit) items.push({ id: "test-command", title: "A command that runs the tests", state: "missing", detail: `none set; this project's own files point at \`${stack.unit}\``, fix: { type: "config", key: "test-commands-unit", value: stack.unit } });
  else items.push({ id: "test-command", title: "A command that runs the tests", state: "missing", detail: "none set and none found in the project; set it with `shipyard-data config set test-commands-unit \"<command>\"`" });

  if (unit) {
    if (tool.needsKeepGoing && !tool.needsKeepGoing.test(unit)) {
      items.push({ id: "all-failures", title: "One run lists every failure", state: "missing", detail: "make stops at the first failing target without -k", fix: { type: "config", key: "test-commands-unit", value: unit.replace(/^(\S*make)\b/, "$1 -k") } });
    } else if (tool.stopsEarly && tool.stopsEarly.test(unit)) {
      items.push({ id: "all-failures", title: "One run lists every failure", state: "missing", detail: "the command stops at the first failure; remove that flag so one run shows them all" });
    } else items.push({ id: "all-failures", title: "One run lists every failure", state: "ok", detail: "" });

    for (const [id, title, value, own] of [
      ["failed-only", "After a fix, only the tests that failed run again", failed, tool.failed],
      ["affected-tests", "After a change, only the tests it can affect run", affected, tool.affected],
    ]) {
      if (value) items.push({ id, title, state: "ok", detail: value });
      else if (tool.native) items.push({ id, title, state: "native", detail: tool.native });
      else if (own) items.push({ id, title, state: "missing", detail: `not set; ${stack.testing_framework} has it`, fix: { type: "config", key: id === "failed-only" ? "test-commands-rerun-failed" : "test-commands-scoped", value: own } });
      else items.push({ id, title, state: "missing", detail: "not set, and the test tool has no such mode: it has to be built once", fix: { type: "task" } });
    }
  }
  const needsTask = items.some((i) => i.fix?.type === "task");
  const slow = suite.median_seconds !== null && suite.median_seconds >= SLOW_SUITE_SECONDS;
  return {
    folder,
    framework: stack.testing_framework || "",
    suite,
    items,
    hint: tool.hint ?? "",
    open_task: infraTask(dataDir)?.open ? infraTask(dataDir).id : null,
    // A task was filed before and is closed, yet something is still missing:
    // the rest was more than a small task (seen live: every test compiled all
    // sources, so "only the affected tests" needed a change to how tests are
    // linked). That is a story for a discussion, never a second auto-filed task.
    closed_task: infraTask(dataDir) && !infraTask(dataDir).open ? infraTask(dataDir).id : null,
    worth_a_task: needsTask && slow && !infraTask(dataDir),
    can_apply: items.some((i) => i.fix?.type === "config"),
  };
}

export function renderInfra(r) {
  const mark = { ok: "✓", native: "✓", missing: "✗" };
  const L = [`test setup${r.framework ? ` (${r.framework})` : ""}: ${r.items.filter((i) => i.state !== "missing").length} of ${r.items.length} in place`];
  for (const i of r.items) L.push(`  ${mark[i.state]} ${i.title}${i.detail ? ` — ${i.detail}` : ""}`);
  if (r.suite.command) L.push(`  whole suite: ${r.suite.median_seconds === null ? "not measured yet (measured from its next captured run)" : `about ${r.suite.median_seconds} s (${r.suite.runs} green run${r.suite.runs === 1 ? "" : "s"} measured)`}`);
  const left = r.items.some((i) => i.fix?.type === "task");
  if (r.open_task && left) L.push(`  ${r.open_task} is filed for the rest: /ship-execute --task ${r.open_task}`);
  else if (r.open_task) L.push(`  ${r.open_task} is still open though nothing is missing any more: close it (shipyard-data task set-status ${r.open_task} done)`);
  else if (r.closed_task && r.items.some((i) => i.fix?.type === "task")) L.push(`  ${r.closed_task} is closed and something is still missing: what is left is more than a small task. Plan it: /ship-discuss ${r.closed_task}`);
  else if (r.items.some((i) => i.fix?.type === "task")) L.push(r.worth_a_task ? "  worth building now: `shipyard-data infra apply` files the task" : "  the rest needs a small piece of work; it is filed once the suite is measured at 60 s or more");
  return L.join("\n");
}

function taskBody(r, id) {
  const secs = r.suite.median_seconds;
  return `---
id: "${id}"
title: "Fast test runs: only the tests a change can affect"
type: task
kind: chore
parent: ""
status: open
effort: M
dependencies: []
external_refs: []
aliases: []
created: ${new Date().toISOString().slice(0, 10)}
updated: null
---

# Fast test runs: only the tests a change can affect

${TASK_MARKER}

## What

The whole suite (\`${r.suite.command}\`) takes about ${secs} s, and it runs at every wave boundary and after fixes. Add two commands to the project and tell Shipyard about them:

1. **Affected tests:** runs only the tests whose inputs changed since they last passed.
2. **Failed only:** runs again only the tests that failed in the last run.

${r.hint ? `${r.hint}\n\n` : ""}Then set them (a command may use \`{base}\` for the commit to compare with and \`{files}\` for the changed files, or neither):

\`\`\`
shipyard-data config set test-commands-scoped "<the affected-tests command>"
shipyard-data config set test-commands-rerun-failed "<the failed-only command>"
\`\`\`

Leave the whole-suite command as it is: it still runs once per sprint, and its result is reused while the code does not change.

**If one of the two turns out to be more than a small change** (for example every test is built from all the sources, so any source change rebuilds every test): build the part that is small now, set its command, and write under Findings what the rest needs and why. Then say so and hand the rest to \`/ship-discuss\`; do not grow this task.

## Done When

- Right after a green whole-suite run, the affected-tests command runs no test and exits 0.
- After one source file is changed, it runs the tests that depend on that file, and fewer than the whole suite.
- A failing test makes both commands exit non-zero, and the failed-only command then runs only that test.
- \`shipyard-data infra check\` reports both as set.

## Findings
`;
}

/** Apply what can be set, file the task when it is worth it. Returns the lines to print. */
export function applyInfra(dataDir, { projectDir = null } = {}) {
  const out = [];
  let r = infraReport(dataDir, { projectDir });
  for (const i of r.items) {
    if (i.fix?.type !== "config") continue;
    const res = spawnSync("node", [CLI, "config", "set", i.fix.key, i.fix.value, "--data-dir", dataDir], { encoding: "utf8" });
    out.push(res.status === 0 ? `set ${i.fix.key}: ${i.fix.value}` : `could not set ${i.fix.key}: ${(res.stderr || res.stdout || "").trim().split("\n")[0]}`);
    if (res.status === 0) { try { logEvent(dataDir, "infra_applied", { key: i.fix.key }); } catch { /* best effort */ } }
  }
  r = infraReport(dataDir, { projectDir });
  if (r.worth_a_task && !r.open_task) {
    const idRes = spawnSync("node", [CLI, "next-id", "tasks", "--data-dir", dataDir], { encoding: "utf8" });
    const num = ((idRes.stdout || "").match(/\d+/) ?? [])[0]; // the allocator prints the bare number
    const id = num ? `T${num}` : "";
    if (idRes.status === 0 && id) {
      const dir = join(dataDir, "spec", "tasks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}-fast-test-runs.md`), taskBody(r, id));
      try { logEvent(dataDir, "infra_task_filed", { task: id, suite_seconds: r.suite.median_seconds }); } catch { /* best effort */ }
      out.push(`Filed ${id} — Fast test runs: only the tests a change can affect (land-now)`, `Build it with: /ship-execute --task ${id}`);
      r = infraReport(dataDir, { projectDir });
    } else out.push(`could not allocate a task id: ${(idRes.stderr || "").trim().split("\n")[0]}`);
  }
  return { lines: out, report: r };
}

export function main(dataDir, args = []) {
  const sub = args[0];
  const json = args.includes("--json");
  if (sub === "check") {
    const r = infraReport(dataDir);
    process.stdout.write(json ? JSON.stringify(r) + "\n" : renderInfra(r) + "\n");
    if (r.can_apply || (r.worth_a_task && !r.open_task)) process.exit(3);
    return;
  }
  if (sub === "apply") {
    const { lines, report } = applyInfra(dataDir);
    if (json) { process.stdout.write(JSON.stringify({ applied: lines, report }) + "\n"); return; }
    process.stdout.write((lines.length ? lines.join("\n") + "\n" : "") + renderInfra(report) + "\n");
    return;
  }
  process.stderr.write("shipyard-data infra: usage: infra check [--json] | infra apply [--json]\n");
  process.exit(2);
}
