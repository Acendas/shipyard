/** 4.11: quick decisions on the light model through `claude -p` — lean call shape, forced JSON schema, only high confidence decides. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quickArgs, runQuick } from "../bin/quick-model.mjs";
import { classifyWithHaiku, CLASSIFY_SCHEMA } from "../bin/haiku-router.mjs";
import { decisionSchema, buildDecisionPrompt } from "../bin/decide.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

test("quickArgs: lean session, effort low, schema forced; no API key or SDK anywhere", () => {
  const a = quickArgs({ model: "haiku", system: "sys", prompt: "p", schema: { type: "object" } });
  assert.deepEqual(a.slice(0, 5), ["-p", "--model", "haiku", "--effort", "low"]);
  for (const flag of ["--output-format", "--json-schema", "--system-prompt", "--tools", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf("--tools") + 1], "", "no tools: the call cannot read or change anything");
  assert.equal(a[a.indexOf("--max-turns") + 1], "3", "structured output takes a second turn");
  assert.equal(a[a.length - 1], "p");
  assert.ok(!a.includes("--bare"), "--bare skips the login credential (probed: Not logged in)");
  assert.equal(quickArgs({ model: "", system: "s", prompt: "p" }).includes("--model"), false, "an empty model inherits the session's");
  const src = readFileSync(join(ROOT, "bin", "quick-model.mjs"), "utf8");
  assert.doesNotMatch(src, /ANTHROPIC_API_KEY|api\.anthropic\.com|@anthropic-ai\/sdk/);
});

test("runQuick: structured_output wins, text JSON is the fallback, every failure is reported and never thrown", () => {
  const env = (o) => ({ exec: () => ({ status: 0, stdout: JSON.stringify(o) }) });
  let r = runQuick({ system: "s", prompt: "p", ...env({ structured_output: { choice: "A" }, result: "ignored", total_cost_usd: 0.0012 }) });
  assert.deepEqual([r.ok, r.data.choice, r.structured, r.cost_usd], [true, "A", true, 0.0012]);
  r = runQuick({ system: "s", prompt: "p", ...env({ result: 'Here: {"choice":"B"}' }) });
  assert.deepEqual([r.ok, r.data.choice, r.structured], [true, "B", false]);
  assert.equal(runQuick({ system: "s", prompt: "p", ...env({ result: "I cannot" }) }).error, "no JSON object in the reply");
  assert.equal(runQuick({ system: "s", prompt: "p", ...env({ is_error: true, result: "Not logged in · Please run /login" }) }).error, "Not logged in · Please run /login");
  assert.equal(runQuick({ system: "s", prompt: "p", exec: () => ({ status: 1, stderr: "boom" }) }).error, "boom");
  assert.equal(runQuick({ system: "s", prompt: "p", exec: () => { throw new Error("ENOENT claude"); } }).error, "ENOENT claude");
});

test("the intake classifier uses the lean shape with its schema", () => {
  let seen = null;
  const r = classifyWithHaiku("add a refund button", { exec: (bin, argv) => { seen = argv; return { status: 0, stdout: JSON.stringify({ structured_output: { size: "m", ambiguity: "high", repro: "na", risk: "high", urgency: "normal", why: "money" } }) }; } });
  assert.equal(r.ok, true); assert.equal(r.inputs.risk, "high");
  assert.deepEqual(JSON.parse(seen[seen.indexOf("--json-schema") + 1]), CLASSIFY_SCHEMA);
  assert.equal(seen[seen.indexOf("--effort") + 1], "low");
});

function project(reply, config = "") {
  const base = mkdtempSync(join(tmpdir(), "decide-"));
  const d = join(base, "projects", "abc123abc123");
  mkdirSync(join(d, "templates"), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "config.md"), `---\nmodels:\n  think: opus\n  build: sonnet\n  light: haiku\n${config}---\n`);
  // a stand-in for the claude binary: records its arguments, prints the canned envelope
  const fake = join(base, "fake-claude.mjs");
  writeFileSync(fake, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(base, "argv.json"))}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(reply))});\n`);
  chmodSync(fake, 0o755);
  const run = (...args) => { const r = spawnSync("node", [CLI, "decide", ...args, "--data-dir", d], { encoding: "utf8", env: { ...process.env, SHIPYARD_CLAUDE_BIN: fake } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  return { base, d, run, argv: () => JSON.parse(readFileSync(join(base, "argv.json"), "utf8")), events: () => readFileSync(join(d, ".shipyard-events.jsonl"), "utf8"), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const Q = ["--question", "The probe stage cannot pass for a render file. Which documented route applies?", "--option", "A=park the step for the owner", "--option", "B=replace the stage with the text scan named in the plan"];

test("decide: a high-confidence answer is the decision and is logged; the model sees only the options and facts, with the schema forced", () => {
  const p = project({ structured_output: { choice: "B", reason: "The plan's risk row names the text scan for render files.", confidence: "high" }, total_cost_usd: 0.0011 });
  try {
    const facts = join(p.base, "facts.txt"); writeFileSync(facts, "SPRINT.md risks row 4: render files use the text scan.\n");
    const r = p.run(...Q, "--facts-file", facts, "--stage", "wave_2_dispatch", "--subject", "P052");
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^decided: B — replace the stage with the text scan named in the plan/);
    assert.match(r.out, /haiku, high confidence/);
    const argv = p.argv();
    assert.deepEqual(JSON.parse(argv[argv.indexOf("--json-schema") + 1]), decisionSchema(["A", "B"]));
    assert.equal(argv[argv.indexOf("--model") + 1], "haiku");
    assert.equal(argv[argv.indexOf("--tools") + 1], "");
    assert.match(argv[argv.length - 1], /render files use the text scan/);
    assert.match(p.events(), /"type":"execute_decision"[^\n]*"subject":"P052"[^\n]*"source":"quick"[^\n]*"decision":"B: replace the stage/);
    assert.match(p.events(), /"type":"quick_decision"[^\n]*"decided":true/);
  } finally { p.cleanup(); }
});

test("decide: medium confidence, an answer off the list, a dead model and the off switch all fall through (exit 3) and decide nothing", () => {
  let p = project({ structured_output: { choice: "A", reason: "unclear", confidence: "medium" } });
  try {
    const r = p.run(...Q, "--json");
    assert.equal(r.code, 3); assert.deepEqual([JSON.parse(r.out).decided, JSON.parse(r.out).reason], [false, "not_confident"]);
    assert.doesNotMatch(p.events(), /execute_decision/);
  } finally { p.cleanup(); }
  p = project({ structured_output: { choice: "C", reason: "x", confidence: "high" } });
  try { const r = p.run(...Q); assert.equal(r.code, 3); assert.match(r.out, /not one of the options/); } finally { p.cleanup(); }
  p = project({ is_error: true, result: "Not logged in · Please run /login" });
  try { const r = p.run(...Q); assert.equal(r.code, 3); assert.match(r.out, /did not answer \(Not logged in/); } finally { p.cleanup(); }
  p = project({ structured_output: { choice: "A", reason: "x", confidence: "high" } }, "routing:\n  quick_decisions: false\n");
  try { const r = p.run(...Q); assert.equal(r.code, 3); assert.match(r.out, /quick_decisions is false/); } finally { p.cleanup(); }
});

test("decide: it needs a question and at least two written-down options", () => {
  const p = project({});
  try {
    assert.equal(p.run("--question", "x", "--option", "A=only one").code, 2);
    assert.equal(p.run("--option", "A=a", "--option", "B=b").code, 2);
    assert.equal(p.run("--question", "x", "--option", "A=a", "--option", "A=again").code, 2);
    assert.match(buildDecisionPrompt({ question: "q", options: [{ label: "A", text: "a" }, { label: "B", text: "b" }], facts: "" }), /<facts>\n\(none given\)/);
  } finally { p.cleanup(); }
});
