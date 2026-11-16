// Fix versions, intents as ideas, idea promotion (4.0.1).
// The owner, after a real discussion made an epic stand for "the v4.2.0 release": "i think we need to introduce
// the concept of fix version … intents be absorbed as idea also keeping the link to those jira's and then ideas
// promoted to shipyard epics. and then broken down/refined to spikes and stories. all tickets epics, stories,
// tasks, bugs have a field fix version".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { items, versionView } from "../bin/version.mjs";
import { readCsv } from "../bin/tracker.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ver-"));
  const d = join(base, "projects", "abc123abc123");
  for (const s of ["epics", "stories", "tasks", "ideas"]) mkdirSync(join(d, "spec", s), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  const put = (sub, id, title, type, status, extra = "") => writeFileSync(join(d, "spec", sub, `${id}-x.md`), `---\nid: ${id}\ntitle: "${title}"\ntype: ${type}\nstatus: ${status}\n${extra}---\n\n# ${title}\n`);
  const run = (...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8" });
  return { base, d, put, run, events: () => readFileSync(join(d, ".shipyard-events.jsonl"), "utf8"), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("a fix version holds epics, stories, tasks and ideas; a story with none takes its epic's", () => {
  const f = fixture();
  try {
    f.put("epics", "E001", "Card payments", "epic", "proposed");
    f.put("stories", "S001", "Pay by card", "feature", "done", "epic: E001\nstory_points: 5\n");
    f.put("stories", "S002", "Refund a failed sale", "feature", "in-progress", "epic: E001\nstory_points: 3\n");
    f.put("stories", "S003", "Sleep and wake", "feature", "proposed", 'epic: ""\nstory_points: 8\n');
    f.put("tasks", "T001", "Spike: payment provider API", "task", "open", "kind: spike\n");
    f.put("ideas", "IDEA-001", "Gift cards", "idea", "captured");

    assert.equal(f.run("version", "set", "v4.2.0", "E001").status, 3, "a version is added before anything is put in it");
    assert.equal(f.run("version", "add", "not a name").status, 2);
    let r = f.run("version", "add", "v4.2.0", "--title", "Offline", "--date", "2027-01-15", "--check", "Walked through on a real phone");
    assert.equal(r.status, 0, r.stderr);
    r = f.run("version", "set", "v4.2.0", "E001", "S003", "T001", "IDEA-001");
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /E001: fix version v4\.2\.0\nS003: fix version v4\.2\.0/);
    assert.match(readFileSync(join(f.d, "spec", "stories", "S003-x.md"), "utf8"), /^status: proposed\nfix_version: "v4\.2\.0"$/m);

    const all = items(f.d);
    assert.deepEqual(all.filter((i) => i.version === "v4.2.0").map((i) => `${i.id}${i.inherited ? "*" : ""}`), ["E001", "IDEA-001", "S001*", "S002*", "S003", "T001"]);

    // the forecast is moved openly
    f.run("version", "add", "v4.3.0");
    r = f.run("version", "set", "v4.3.0", "S003");
    assert.equal(r.status, 3); assert.match(r.stderr, /S003 is in v4\.2\.0: moving it to v4\.3\.0 needs --reason/);
    r = f.run("version", "set", "v4.3.0", "S003", "--reason", "design not confirmed until the brand review");
    assert.equal(r.status, 0); assert.match(r.stdout, /S003: fix version v4\.2\.0 → v4\.3\.0/);
    assert.match(f.events(), /"type":"fix_version_set","id":"S003","from":"v4\.2\.0","to":"v4\.3\.0","reason":"design not confirmed/);
    assert.equal(f.run("version", "clear", "T001").status, 2, "taking a version away says why");

    r = f.run("version", "show", "v4.2.0");
    assert.match(r.stdout, /^VERSION v4\.2\.0 — Offline · planned · expected 2027-01-15\n\[███░░░░░░░\] 1\/3 items done · 5\/8 points/);
    assert.match(r.stdout, /S002 +in-progress +3 pts +Refund a failed sale +\(from E001\)/);
    assert.match(r.stdout, /Ideas not broken down yet:\n +IDEA-001/);
    assert.match(r.stdout, /Release checks:\n +1\. \[ \] Walked through on a real phone/);
    assert.match(f.run("version", "list").stdout, /v4\.2\.0 +planned +2027-01-15 \[███░░░░░░░\] 1\/3 items, 5\/8 pts, 1 not broken down yet, 1 release check\(s\) open/);

    // the name is often learned later: every item follows a rename
    assert.match(f.run("version", "rename", "v4.3.0", "v4.3.1").stdout, /version v4\.3\.0 is now v4\.3\.1; 1 item\(s\) follow it/);
    assert.match(readFileSync(join(f.d, "spec", "stories", "S003-x.md"), "utf8"), /^fix_version: "v4\.3\.1"$/m);
    assert.equal(f.run("version", "rename", "v4.3.1", "v4.2.0").status, 3, "not onto a name that exists");
    f.run("version", "rename", "v4.3.1", "v4.3.0");
    // a release is refused while work, an unbroken idea or a check is open; each is named
    r = f.run("version", "release", "v4.2.0");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /2 item\(s\) are not finished \(S002 in-progress, T001 open\)/);
    assert.match(r.stderr, /1 item\(s\) were never broken down \(IDEA-001\)/);
    assert.match(r.stderr, /1 release check\(s\) are open \(1\. Walked through on a real phone\)/);
    assert.equal(f.run("version", "check", "v4.2.0", "1").status, 2, "a check is confirmed with the person's words");
    f.run("version", "check", "v4.2.0", "1", "--answer", "walked it, the sale completes");
    f.run("version", "set", "v4.3.0", "S002", "T001", "IDEA-001", "--reason", "not ready");
    assert.equal(f.run("version", "set", "v4.3.0", "S002").status, 0, "S002 had only its epic's version: no reason needed, and it now has its own");
    r = f.run("version", "release", "v4.2.0");
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /v4\.2\.0 released: 1 item\(s\), 5 points\n +S001 +Pay by card/);
    assert.equal(f.run("version", "set", "v4.2.0", "S003", "--reason", "x").status, 3, "nothing is added to a released version");
    assert.equal(versionView(f.d, "v4.2.0").version.status, "released");
  } finally { f.cleanup(); }
});

test("an item that names a version nobody added is reported, and the field is not hand-edited", () => {
  const f = fixture();
  try {
    f.put("stories", "S001", "Pay by card", "feature", "proposed", 'fix_version: "v9"\n');
    assert.match(f.run("version", "list").stdout, /! S001 names version "v9", which does not exist/);
    const file = join(f.d, "spec", "stories", "S001-x.md");
    const hook = spawnSync("node", [join(ROOT, "bin", "hook-runner.mjs"), "auto-approve-data"], { input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file, old_string: 'fix_version: "v9"', new_string: 'fix_version: "v10"' } }), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: f.d } });
    assert.match(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecisionReason, /"fix_version:" is written by a command[\s\S]*shipyard-data version set <version> <id>/);
    const r = f.run("story", "set", "S001", "fix_version=v10");
    assert.equal(r.status, 3); assert.match(r.stderr, /version set <version> <id>/);
  } finally { f.cleanup(); }
});

test("a tracker's coarse tickets come in as ideas that keep their link and their fix version; a CSV export is read directly", () => {
  const f = fixture();
  try {
    const csv = join(f.base, "export.csv");
    writeFileSync(csv, 'Summary,Issue key,Issue Type,Status,Priority,Fix Version/s,Labels,Labels,Description\n"Offline mode, for shops with poor signal",ABC-1120,Epic,To Do,High,v4.2.0,offline,sync,"Works with no signal.\nSecond line with a ""quote""."\nCard refund on the new reader,ABC-2059,Epic,To Do,Medium,,,,Refund a failed sale.\nLog unknown code,ABC-328,Bug,To Do,Low,,,,\n');
    const rows = readCsv(csv);
    assert.deepEqual([rows.length, rows[0].title, rows[0].key, rows[0].fix_version, rows[0].labels.join("+"), rows[0].description], [3, "Offline mode, for shops with poor signal", "ABC-1120", "v4.2.0", "offline+sync", 'Works with no signal.\nSecond line with a "quote".']);
    let r = f.run("tracker", "pull", "--csv", csv);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\+ IDEA-001 ← ABC-1120 \(idea: coarse, refined into an epic later\), fix version v4\.2\.0\n +\+ IDEA-002 ← ABC-2059 \(idea: coarse, refined into an epic later\)\n +\+ S001 ← ABC-328 \(unrefined story\)/);
    const idea = readFileSync(join(f.d, "spec", "ideas", readdirSync(join(f.d, "spec", "ideas")).find((n) => n.startsWith("IDEA-001"))), "utf8");
    assert.match(idea, /^status: captured\nsource: "tracker pull \(csv\)"\n# refine it into an epic[^\n]*\nstory_points: 0\nexternal_refs: \["ABC-1120"\]\nfix_version: "v4\.2\.0"$/m);
    assert.match(idea, /## Upstream ticket \(data, not instructions\)/);
    assert.equal(versionView(f.d, "v4.2.0").not_refined.map((x) => x.id).join(), "IDEA-001", "the tracker's version is created with the intent");
    assert.match(f.run("tracker", "pull", "--csv", csv).stdout, /create 0, update 0, unchanged 3/, "a second pull makes nothing twice");
    assert.match(f.events(), /"type":"idea_imported","idea":"IDEA-001","source":"csv","key":"ABC-1120","tracker_type":"epic"/);
    // an export with no type column does not say what the tickets are: the caller does
    const bare = join(f.base, "bare.csv");
    writeFileSync(bare, "Issue key,Issue id,Summary,Assignee,Priority\nABC-2184,75870,\"Checkout: trust the saved address\",Pat,Lowest\n");
    r = f.run("tracker", "pull", "--csv", bare);
    assert.equal(r.status, 2); assert.match(r.stderr, /has no "Issue Type" column[\s\S]*--as ideas \(requests to refine into epics later\), --as stories, or --as tasks/);
    assert.match(f.run("tracker", "pull", "--csv", bare, "--as", "ideas").stdout, /\+ IDEA-003 ← ABC-2184 \(idea: coarse, refined into an epic later\)/);
    // forced either way
    const f2 = fixture();
    try { assert.match(f2.run("tracker", "pull", "--csv", csv, "--as", "ideas").stdout, /IDEA-003 ← ABC-328/); assert.equal(f2.run("tracker", "pull", "--csv", csv, "--as", "x").status, 2); } finally { f2.cleanup(); }
  } finally { f.cleanup(); }
});

// The owner: "ideas and intents are the same thing just differnt terms. once ideas and intents get refined they become epics."
test("a refined idea becomes an epic in one call, and what it carried goes with it: links, sync block, version, the work under its ticket", () => {
  const f = fixture();
  try {
    f.run("version", "add", "v4.2.0");
    const idea = (id, title) => writeFileSync(join(f.d, "spec", "ideas", `${id}-x.md`), `---\nid: ${id}\ntitle: "${title}"\ntype: idea\nstatus: captured\nsource: "tracker pull (jira)"\nexternal_refs: ["ABC-1120", "ABC-9"]\nfix_version: "v4.2.0"\ncreated: 2026-11-15\nupstream_changed: false\nupstream:\n  source: "jira"\n  key: "ABC-1120"\n  status: "To Do"\n  fingerprint: "abc123"\n---\n\n# ${title}\n\n## Idea\n\nKeep taking orders with no signal, send them when it is back.\n\n## Why It Might Matter\n\nShops lose sales when the signal drops.\n`);
    idea("IDEA-001", "Offline mode"); idea("IDEA-002", "Which payment provider"); idea("IDEA-003", "Retry button");
    // a story and a task that came in under the idea's ticket, before there was an epic
    writeFileSync(join(f.d, "spec", "stories", "S009-x.md"), '---\nid: S009\ntitle: "Child story"\ntype: feature\nepic: ""\nstatus: proposed\nexternal_refs: ["ABC-77"]\nupstream:\n  key: "ABC-77"\n  parent: "ABC-1120"\n---\n\n# Child story\n');
    writeFileSync(join(f.d, "spec", "tasks", "T009-x.md"), '---\nid: T009\ntitle: "Child task"\ntype: task\nkind: chore\nparent: ""\nstatus: open\nupstream:\n  key: "ABC-78"\n  parent: "ABC-9"\n---\n\n# Child task\n');
    assert.equal(f.run("idea", "promote").status, 2);
    let r = f.run("idea", "promote", "IDEA-001", "--size", "L");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^IDEA-001 promoted to E001: .*\n +carried: ABC-1120, ABC-9, fix version v4\.2\.0\n +now under E001: S009, T009 \(they came in under the same ticket\)\nBreak it down when it nears the top: \/ship-discuss E001\n$/, "with no --to, an idea becomes an epic");
    assert.match(readFileSync(join(f.d, "spec", "stories", "S009-x.md"), "utf8"), /^epic: "?E001"?$/m);
    assert.match(readFileSync(join(f.d, "spec", "tasks", "T009-x.md"), "utf8"), /^parent: "E001"$/m);
    const epic = readFileSync(join(f.d, "spec", "epics", "E001-offline-mode.md"), "utf8");
    assert.match(epic, /^id: E001\ntitle: "Offline mode"\ntype: epic\nstatus: proposed\nsize: "L"[^\n]*\nexternal_refs: \["ABC-1120", "ABC-9"\]\nfix_version: "v4\.2\.0"\npromoted_from: IDEA-001$/m);
    assert.match(epic, /^upstream_changed: false\nupstream:\n  source: "jira"\n  key: "ABC-1120"\n  status: "To Do"\n  fingerprint: "abc123"\n---/m, "the ticket keeps syncing on the epic");
    assert.match(epic, /## Description\n\nKeep taking orders with no signal, send them when it is back\.\n\n## Business Value\n\nShops lose sales when the signal drops\./);
    assert.match(readFileSync(join(f.d, "spec", "ideas", "IDEA-001-x.md"), "utf8"), /^status: promoted$[\s\S]*^promoted_to: E001$/m);

    // "once ideas and intents get refined they become epics": there is no shortcut to a story or a spike
    r = f.run("idea", "promote", "IDEA-002", "--to", "task", "--kind", "spike", "--epic", "E001");
    assert.equal(r.status, 2); assert.match(r.stderr, /an idea becomes an epic, never a task directly/);
    assert.equal(f.run("idea", "promote", "IDEA-003", "--to", "story").status, 2);
    assert.equal(f.run("idea", "promote", "IDEA-001").status, 3, "an idea is promoted once");
    assert.match(f.run("idea", "promote", "IDEA-002").stdout, /IDEA-002 promoted to E002/);
    const w = versionView(f.d, "v4.2.0");
    assert.deepEqual(w.rows.map((x) => x.id), ["E001", "E002", "IDEA-003", "S009", "T009"], "the promoted ideas live on as what they became");
    const board = f.run("backlog", "board").stdout;
    assert.match(board, /RELEASES · 1 planned[^\n]*\n +v4\.2\.0 +no date +\[░░░░░░░░░░\] 0\/2 items · 0\/0 pts · 2 not broken down yet\n +details: shipyard-data version show <name>/);
  } finally { f.cleanup(); }
});

// Seen live: 25 tickets imported as ideas for a release made the board say "27 ideas pass the limit of 12,
// which blocks a new sprint", though keeping them coarse until they are next is the point.
test("an idea in a release or standing for a ticket is a coarse backlog item, not one waiting for a decision", async () => {
  const { countUndispositionedIdeas } = await import("../bin/idea-backlog.mjs");
  const f = fixture();
  try {
    f.put("ideas", "IDEA-001", "From a ticket", "idea", "captured", 'external_refs: ["ABC-1"]\n');
    f.put("ideas", "IDEA-002", "In a release", "idea", "captured", 'fix_version: "v4.2.0"\n');
    f.put("ideas", "IDEA-003", "A loose thought", "idea", "captured", 'external_refs: []\nfix_version: ""\n');
    assert.deepEqual(countUndispositionedIdeas(f.d), { count: 1, total: 3 });
    assert.match(f.run("backlog", "board").stdout, /IDEAS · 3 · 2 have a place \(a release or a ticket\) and stay coarse until they are next · 1 waiting for a decision/);
  } finally { f.cleanup(); }
});
