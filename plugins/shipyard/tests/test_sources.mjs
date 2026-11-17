/**
 * After 4.0.3: where a project's knowledge lives, besides the code, is its owner's list.
 *
 * The owner: "shipyard is forcing jira, confluence google drive search. … [a project of mine] has non of that,
 * and another consumer may have totally differnt sources. some issues/features may require additional
 * supporting data sources to iron out or take action. but sometimes its not necessary at all."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSources, toolBelongs, contextLine } from "../bin/sources.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "src-"));
  const d = join(base, "projects", "abc123abc123");
  mkdirSync(join(d, "spec", "stories"), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  return { base, d };
}
const run = (d, ...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8" });
const events = (d) => (existsSync(join(d, ".shipyard-events.jsonl")) ? readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("a project's sources are whatever its owner names: any place, reached any way, each write with their words", () => {
  const { base, d } = fixture();
  try {
    assert.deepEqual(readSources(d), { decided: false, decided_at: "", sources: [] });
    assert.match(contextLine(d), /^not set \(asked once/);
    assert.match(run(d, "sources", "list").stdout, /SOURCES: not set\. The owner has not been asked/);
    // nothing is written without the owner's answer
    let r = run(d, "sources", "add", "Notion", "--holds", "product decisions", "--tool", "notion");
    assert.equal(r.status, 3); assert.match(r.stderr, /add records the owner's decision: add --answer "<their words>"/);
    assert.equal(readSources(d).decided, false);
    r = run(d, "sources", "add", "Notion", "--tool", "notion", "--answer", "notion and linear");
    assert.equal(r.status, 3); assert.match(r.stderr, /add needs --holds/);
    assert.equal(run(d, "sources", "add", "Notion", "--holds", "product decisions", "--tool", "notion", "--url", "https://example.test", "--answer", "x y").status, 3, "one way to reach a source");
    assert.equal(run(d, "sources", "add", "Notion", "--holds", "product decisions and meeting notes", "--tool", "Notion", "--answer", "notion and linear").status, 0);
    assert.equal(run(d, "sources", "add", "Linear", "--holds", "the issues", "--tool", "linear", "--always", "--answer", "notion and linear; linear every time").status, 0);
    assert.equal(run(d, "sources", "add", "Vendor manual", "--holds", "the reader's command set", "--url", "https://vendor.example.test/manual", "--answer", "and the vendor manual").status, 0);
    assert.equal(run(d, "sources", "add", "Contracts", "--holds", "what was promised to each client", "--answer", "the contracts are on paper, ask me").status, 0);
    const s = readSources(d);
    assert.deepEqual(s.sources.map((x) => [x.name, x.tool, x.always]), [["Notion", "notion", false], ["Linear", "linear", true], ["Vendor manual", "", false], ["Contracts", "", false]]);
    assert.ok(toolBelongs(s.sources[0], "plugin_notion_workspace__search_pages") && !toolBelongs(s.sources[0], "claude-in-chrome__get_page_text") && !toolBelongs(s.sources[3], "anything"));
    assert.match(run(d, "sources", "list").stdout, /\| Linear \| the issues \| tools named like "linear" \| every time \|\n\| Vendor manual \| the reader's command set \| https:\/\/vendor\.example\.test\/manual \| when it could matter \|\n\| Contracts \| what was promised to each client \| the owner tells what it says \| when it could matter \|/);
    assert.match(contextLine(d), /Notion: product decisions and meeting notes \(tools named like "notion"\); Linear \[always looked at\]: the issues/);
    // the owner changes their mind, in their words
    assert.equal(run(d, "sources", "always", "Linear", "off", "--answer", "only when it matters").status, 0);
    assert.equal(readSources(d).sources[1].always, false);
    assert.equal(run(d, "sources", "remove", "notion", "--answer", "we left notion").status, 0);
    assert.equal(run(d, "sources", "remove", "notion", "--answer", "again").status, 3);
    assert.equal(run(d, "sources", "none", "--answer", "this project has no data sources other than its repository").status, 0);
    assert.deepEqual(readSources(d).sources, []); assert.equal(readSources(d).decided, true);
    assert.match(contextLine(d), /^none besides the repository/);
    const log = events(d).filter((e) => e.type === "project_sources_set");
    assert.deepEqual(log.map((e) => e.action), ["add", "add", "add", "add", "always_off", "remove", "none"]);
    assert.ok(log.every((e) => e.answer.length > 3), "every change carries the owner's words");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the one-time question suggests what the project's ticket links point to, and nothing else", () => {
  const { base, d } = fixture();
  try {
    assert.match(run(d, "sources", "suggest").stdout, /\| nothing \| - \| no record in this project is linked to a ticket[\s\S]*CHOICES: 1\. Only the repository \(Recommended\) — Nothing else is ever searched   2\. I will name them/);
    const input = join(base, "in.json");
    writeFileSync(input, JSON.stringify({ source: "jira", items: [{ key: "ABC-1", title: "Offline mode", type: "Epic" }, { key: "ABC-2", title: "Pay by card", type: "Story" }] }));
    assert.equal(run(d, "tracker", "pull", "--input", input).status, 0);
    const out = run(d, "sources", "suggest").stdout;
    assert.match(out, /\| Jira \| the tickets this project's work comes from \(ABC\) \| 2 records here are linked to its tickets \|/);
    assert.match(out, /CHOICES: 1\. Jira \(Recommended\) — What this project's tickets point to   2\. Only the repository — Nothing else is ever searched   3\. I will name them/);
    assert.match(out, /Jira, as suggested:   shipyard-data sources add "Jira" --holds "the tickets this project's work comes from \(ABC\)" --tool jira --answer "<their words>"/);
    assert.match(out, /Never add a place they did not name\. Never ask them to sign in or connect anything for this\./);
    assert.equal(readSources(d).decided, false, "a suggestion is not an answer");
    // each choice fits a card
    for (const m of out.match(/CHOICES: (.*)/)[1].split(/\s{3}/)) { const [label, desc] = m.replace(/^\d\. /, "").split(" — "); assert.ok(label.length <= 40 && desc.length <= 110, m); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("sources.json has one writer: a model edit is refused with the command to use", () => {
  const { base, d } = fixture();
  try {
    const hook = spawnSync("node", [join(ROOT, "bin", "hook-runner.mjs"), "auto-approve-data"], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(d, "sources.json"), content: '{"sources":[]}' } }), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: d } });
    assert.equal(hook.status, 0, hook.stderr);
    const out = JSON.parse(hook.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny"); assert.match(out.permissionDecisionReason, /shipyard-data sources add "<name>"[\s\S]*--answer "<their words>"/); assert.doesNotMatch(out.permissionDecisionReason, /cursor advance/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
