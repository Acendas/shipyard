/** 4.7.1: three rules that were prose and are now enforced — overlap, no mid-execute questions, a builder claims its own step. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, decideShape, shapeProblems, ASK_LIMITS } from "../bin/hooks/unattended-ask.mjs";
import { evaluateExecuteTerminal } from "../bin/terminal-gate.mjs";
import { encodePng } from "../bin/ui-adapters/image.mjs";
import { record as ledgerRecord, wrongBuilderModel } from "../bin/hooks/agent-ledger.mjs";
import { liveAgents, readEvents } from "../bin/terminal-gate.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function project(config = "") {
  const root = mkdtempSync(join(tmpdir(), "enf-"));
  const repo = join(root, "repo"); const data = join(root, "data");
  mkdirSync(repo, { recursive: true }); mkdirSync(data, { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  g("init", "-q", "-b", "main"); writeFileSync(join(repo, "a.txt"), "a\n"); g("add", "-A"); g("commit", "-q", "-m", "init");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_CODE_SESSION_ID: "S1" };
  delete env.SHIPYARD_DATA; delete env.CLAUDE_PID;
  const run = (args, extra = {}) => { const r = spawnSync("node", [CLI, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: "utf8" }); return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" }; };
  assert.equal(run(["onboarding", "bootstrap"]).code, 0);
  const dataDir = run([]).out.trim();
  if (config) { const p = join(dataDir, "config.md"); writeFileSync(p, readFileSync(p, "utf8").replace(/^execution:\n/m, `execution:\n${config}`)); }
  for (const sub of ["spec/stories", "spec/steps"]) mkdirSync(join(dataDir, sub), { recursive: true });
  writeFileSync(join(dataDir, "spec/stories/S001-x.md"), "---\nid: S001\ntitle: \"x\"\ntype: feature\nstatus: in-progress\nstory_points: 1\nsteps: []\n---\n");
  for (const id of ["P001", "P002"]) writeFileSync(join(dataDir, "spec/steps", `${id}-x.md`), `---\nid: "${id}"\ntitle: "x"\ntype: step\nkind: feature\nstory: S001\nstatus: approved\neffort: S\ndependencies: []\n---\n`);
  assert.equal(run(["init-sprint", "sprint-001"]).code, 0);
  assert.equal(run(["sprint", "set", "stories", "S001"]).code, 0);
  const sp = join(dataDir, "sprints", "current", "SPRINT.md");
  writeFileSync(sp, readFileSync(sp, "utf8").replace(/\n## Waves[\s\S]*$/, "") + "\n## Waves\n\n### Wave 1\n- P001\n\n### Wave 2\n- P002\n");
  assert.equal(run(["sprint", "set", "execution_mode", "task"]).code, 0);
  assert.equal(run(["sprint", "set", "status", "in-progress"]).code, 0);
  const adv = (stage, ...extra) => run(["cursor", "advance", "execute", stage, "sprint=sprint-001", ...extra]);
  return { root, repo, dataDir, run, adv, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const toBoundary = (p) => { for (const st of ["preflight", "salvage", "load", "readiness", "wave_1_dispatch", "wave_1_boundary"]) assert.equal(p.adv(st).code, 0, st); };

test("overlap is a CLI gate: wave 1's build is refused until wave 2 is dispatched; then the retreat edge and the gate → waiting edge work", () => {
  const p = project();
  try {
    toBoundary(p);
    let r = p.adv("wave_1_build");
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err + r.out, /dispatch wave 2 first/);
    assert.match(r.err + r.out, /wave_2_dispatch/);
    assert.equal(p.adv("wave_2_dispatch", "wave_number=2").code, 0);
    assert.equal(p.adv("wave_1_build", "wave_number=1").code, 0, "the trailing lane of wave 1 now runs beside wave 2");
    for (const st of ["wave_1_refactor", "wave_1_tests", "wave_1_verify", "wave_1_gate"]) assert.equal(p.adv(st).code, 0, st);
    assert.equal(p.adv("wave_2_waiting", "wave_number=2").code, 0);
  } finally { p.cleanup(); }
});

test("overlap gate exemptions: the last wave, overlap_waves: false, and in-place (isolation none) work", () => {
  const off = project("  overlap_waves: false\n");
  try { toBoundary(off); assert.equal(off.adv("wave_1_build").code, 0); } finally { off.cleanup(); }
  const solo = project("  isolation: none\n");
  try { toBoundary(solo); assert.equal(solo.adv("wave_1_build").code, 0, "sequential in-place work cannot overlap"); } finally { solo.cleanup(); }
  const last = project();
  try {
    const sp = join(last.dataDir, "sprints", "current", "SPRINT.md");
    writeFileSync(sp, readFileSync(sp, "utf8").replace(/\n### Wave 2\n- P002\n/, "\n"));
    toBoundary(last);
    assert.equal(last.adv("wave_1_build").code, 0, "no next wave to dispatch");
  } finally { last.cleanup(); }
});

test("unattended hook: this session's question is denied past readiness; other sessions, early stages, a paused cursor and unattended:false are allowed", () => {
  const p = project();
  try {
    const ask = (session = "S1") => decide(p.dataDir, { tool_name: "AskUserQuestion", session_id: session });
    assert.equal(ask(), null, "no cursor yet");
    for (const st of ["preflight", "salvage", "load", "readiness"]) { assert.equal(p.adv(st).code, 0); assert.equal(ask(), null, `${st}: a start-of-sprint ask is allowed`); }
    assert.equal(p.adv("wave_1_dispatch").code, 0);
    const d = ask();
    assert.ok(d && /unattended/.test(d.reason) && /cursor escalate execute/.test(d.reason) && /execute_decision/.test(d.reason), JSON.stringify(d));
    assert.equal(ask("OTHER"), null, "a /ship-discuss in another session is not this sprint's question");
    assert.equal(decide(p.dataDir, { tool_name: "Bash", session_id: "S1" }), null);
    assert.equal(p.run(["cursor", "pause", "execute", "--note", "owner must choose the palette"]).code, 0);
    assert.equal(ask(), null, "a paused sprint may ask");
    assert.equal(p.run(["cursor", "resume", "execute"]).code, 0);
    assert.ok(ask());
    const cfg = join(p.dataDir, "config.md");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^execution:\n/m, "execution:\n  unattended: false\n"));
    assert.equal(ask(), null);
  } finally { p.cleanup(); }
});

test("the hook is registered for AskUserQuestion and prints a deny decision", () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.PreToolUse.some((h) => h.matcher === "AskUserQuestion" && /unattended-ask/.test(h.hooks[0].command)));
  const p = project();
  try {
    for (const st of ["preflight", "salvage", "load", "readiness", "wave_1_dispatch"]) assert.equal(p.adv(st).code, 0);
    const r = spawnSync("node", [join(ROOT, "bin", "hook-runner.mjs"), "unattended-ask"], { cwd: p.repo, input: JSON.stringify({ tool_name: "AskUserQuestion", session_id: "S1" }), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: p.dataDir } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"unattended_ask_denied"/);
  } finally { p.cleanup(); }
});

test("a worker named after a step claims that step without being told; other names take the next item", () => {
  const p = project();
  try {
    const items = join(p.root, "w.json"); writeFileSync(items, JSON.stringify([{ id: "P001", effort: "S" }, { id: "P002", effort: "S" }]));
    assert.equal(p.run(["queue", "enqueue", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--input", items]).code, 0);
    let r = p.run(["queue", "claim", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--worker", "w2-P002"]);
    assert.equal(JSON.parse(r.out).task.id, "P002", "the name decides, not the queue order");
    r = p.run(["queue", "claim", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--worker", "builder-P002"]);
    assert.equal(JSON.parse(r.out).claimed, false, "its step is already claimed: it is not handed P001 instead");
    r = p.run(["queue", "claim", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--worker", "worker-9"]);
    assert.equal(JSON.parse(r.out).task.id, "P001", "an unnamed worker takes the next item");
  } finally { p.cleanup(); }
});

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const idea = (p, id, created = today()) => { mkdirSync(join(p.dataDir, "spec/ideas"), { recursive: true }); writeFileSync(join(p.dataDir, "spec/ideas", `${id}-x.md`), `---\nid: ${id}\ntitle: "cue follows the wrong hero"\ntype: idea\ncreated: ${created}\nstatus: captured\n---\n\nbody\n`); };
const toGate = (p) => { toBoundary(p); for (const st of ["wave_2_dispatch", "wave_1_build", "wave_1_refactor", "wave_1_tests", "wave_1_verify", "wave_1_gate"]) assert.equal(p.adv(st, st.startsWith("wave_2") ? "wave_number=2" : "wave_number=1").code, 0, st); };

test("a finding captured in the sprint is decided before the wave closes: untriaged refuses, a defect above low needs a fix step, low needs a reason", () => {
  const p = project();
  try {
    idea(p, "IDEA-001", "2020-01-01"); // captured long before the sprint: not this sprint's business
    toGate(p);
    idea(p, "IDEA-002");
    // typed into a discussion running beside the sprint today: not this sprint's finding (4.0)
    writeFileSync(join(p.dataDir, "spec/ideas", "IDEA-003-x.md"), `---\nid: IDEA-003\ntitle: "the minimap dots are too big"\ntype: idea\nsource: "inline capture (--idea)"\ncreated: ${today()}\nstatus: captured\n---\n`);
    let r = p.adv("wave_2_waiting", "wave_number=2");
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err + r.out, /IDEA-002 was captured during this sprint and is not triaged/);
    assert.doesNotMatch(r.err + r.out, /IDEA-001/);
    assert.doesNotMatch(r.err + r.out, /IDEA-003/, "a discussion's capture does not hold up the sprint");
    assert.equal(p.run(["idea", "triage", "IDEA-002", "--kind", "defect"]).code, 3, "a defect needs a severity");
    r = p.run(["idea", "triage", "IDEA-002", "--kind", "defect", "--severity", "low"]);
    assert.equal(r.code, 3); assert.match(r.err, /say why in --reason/);
    assert.equal(p.run(["idea", "triage", "IDEA-002", "--kind", "defect", "--severity", "medium"]).code, 0);
    r = p.adv("wave_2_waiting", "wave_number=2");
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err + r.out, /medium-severity defect found in this sprint, so it is fixed in this sprint/);
    r = p.run(["idea", "triage", "IDEA-002", "--kind", "defect", "--severity", "medium", "--fixed-by", "P999"]);
    assert.equal(r.code, 3); assert.match(r.err, /write the patch step first/);
    writeFileSync(join(p.dataDir, "spec/steps/P003-fix.md"), `---\nid: "P003"\ntitle: "fix the cue"\ntype: step\nkind: bug\nstory: S001\nstatus: approved\neffort: S\ndependencies: []\n---\n`);
    assert.equal(p.run(["idea", "triage", "IDEA-002", "--kind", "defect", "--severity", "medium", "--fixed-by", "P003"]).code, 0);
    assert.equal(p.adv("wave_2_waiting", "wave_number=2").code, 0, "the fix step exists, so the wave may close");
    // the terminal still waits for the fix to return
    let reasons = evaluateExecuteTerminal({ dataDir: p.dataDir }).reasons.join("\n");
    assert.match(reasons, /IDEA-002 \(defect, medium\) is fixed by P003, which has not returned yet/);
    assert.equal(p.run(["events", "emit", "task_dispatch_returned", "pipeline=ship-execute", "task_id=P003", "status=complete"]).code, 0);
    reasons = evaluateExecuteTerminal({ dataDir: p.dataDir }).reasons.join("\n");
    assert.doesNotMatch(reasons, /IDEA-002/);
    const text = readFileSync(join(p.dataDir, "spec/ideas/IDEA-002-x.md"), "utf8");
    assert.match(text, /^kind: defect$/m); assert.match(text, /^severity: medium$/m); assert.match(text, /^fixed_by: P003$/m);
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"idea_triaged"/);
  } finally { p.cleanup(); }
});

test("sprint findings: an improvement and a reasoned low defect settle with no fix; the check can be turned off", () => {
  const p = project();
  try {
    toGate(p);
    idea(p, "IDEA-003"); idea(p, "IDEA-004");
    assert.equal(p.run(["idea", "triage", "IDEA-003", "--kind", "improvement"]).code, 0);
    assert.equal(p.run(["idea", "triage", "IDEA-004", "--kind", "defect", "--severity", "low", "--reason", "wording in a debug overlay only; costs $0 to leave"]).code, 0);
    assert.match(readFileSync(join(p.dataDir, "spec/ideas/IDEA-004-x.md"), "utf8"), /triage_reason: "wording in a debug overlay only; costs \$0 to leave"/);
    assert.equal(p.adv("wave_2_waiting", "wave_number=2").code, 0);
  } finally { p.cleanup(); }
  const off = project("  triage_sprint_findings: false\n");
  try { toGate(off); idea(off, "IDEA-005"); assert.equal(off.adv("wave_2_waiting", "wave_number=2").code, 0); } finally { off.cleanup(); }
});

const flat = (w, h, rgb) => { const data = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4); return encodePng({ width: w, height: h, data }); };
const uiProject = (config = "") => {
  const p = project(config);
  assert.equal(p.run(["config", "set", "ui-adapter", "frames"]).code, 0);
  assert.equal(p.run(["config", "set", "ui-frame-command", "cp {scene}.png {out}"]).code, 0);
  writeFileSync(join(p.repo, "hud.png"), flat(16, 8, [60, 140, 60]));
  writeFileSync(join(p.repo, "design.png"), flat(16, 8, [60, 140, 60]));
  for (const st of ["preflight", "salvage", "load", "readiness", "wave_1_dispatch"]) assert.equal(p.adv(st).code, 0, st);
  return p;
};
const rec = (p, ...extra) => p.run(["story-review", "record", "S001", "--code", "CLEAN", ...extra]);

test("a UI story with an approved design is not reviewed until the delivered screen was compared with it", () => {
  const p = uiProject();
  try {
    assert.equal(rec(p, "--verdict", "approve").code, 0, "no design on the story yet: nothing to compare");
    assert.equal(p.run(["design", "approve", "S001", "--file", join(p.repo, "design.png"), "--fidelity", "mockup", "--scene", "hud"]).code, 0);
    let r = rec(p, "--verdict", "approve");
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /UI story with an approved design \(v1\) — compare the delivered screen with it/);
    assert.match(r.err, /ui verify --level screen --story S001/);
    r = rec(p, "--verdict", "approve", "--design", "MATCHES");
    assert.equal(r.code, 3); assert.match(r.err, /no comparison of the delivered screen with the design is on record/);
    r = rec(p, "--verdict", "approve", "--design", "UNVERIFIED");
    assert.equal(r.code, 3); assert.match(r.err, /UNVERIFIED needs --note/);
    assert.equal(p.run(["ui", "verify", "--level", "screen", "--story", "S001"]).code, 0);
    assert.equal(rec(p, "--verdict", "approve", "--design", "DIFFERS").code, 2, "a screen that differs is not approved");
    assert.equal(rec(p, "--verdict", "changes", "--design", "DIFFERS", "--design-findings", "2").code, 0);
    assert.equal(rec(p, "--verdict", "approve", "--design", "MATCHES").code, 0);
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"type":"story_reviewed"[^\n]*"design":"MATCHES"/);
    assert.equal(rec(p, "--verdict", "approve", "--design", "UNVERIFIED", "--note", "needs the handheld; none attached").code, 0);
  } finally { p.cleanup(); }
});

test("design review: an exact snapshot that fails the pixel diff cannot be recorded as MATCHES; a waived design and design_review: false ask for nothing", () => {
  const p = uiProject();
  try {
    assert.equal(p.run(["design", "approve", "S001", "--file", join(p.repo, "design.png"), "--scene", "hud"]).code, 0);
    writeFileSync(join(p.repo, "hud.png"), flat(16, 8, [240, 240, 240]));
    assert.equal(p.run(["ui", "verify", "--level", "screen", "--story", "S001"]).code, 3, "exact fidelity: the pixel diff is the verdict");
    const r = rec(p, "--verdict", "approve", "--design", "MATCHES");
    assert.equal(r.code, 3); assert.match(r.err, /the last comparison FAILED/);
    writeFileSync(join(p.repo, "hud.png"), flat(16, 8, [60, 140, 60]));
    assert.equal(p.run(["ui", "verify", "--level", "screen", "--story", "S001"]).code, 0);
    assert.equal(rec(p, "--verdict", "approve", "--design", "MATCHES").code, 0);
  } finally { p.cleanup(); }
  const waived = uiProject();
  try {
    assert.equal(waived.run(["design", "waive", "S001", "--reason", "text-only change"]).code, 0);
    assert.equal(rec(waived, "--verdict", "approve").code, 0, "a waived design has nothing to compare");
  } finally { waived.cleanup(); }
  const off = uiProject("  design_review: false\n");
  try {
    assert.equal(off.run(["design", "approve", "S001", "--file", join(off.repo, "design.png")]).code, 0);
    assert.equal(rec(off, "--verdict", "approve").code, 0);
  } finally { off.cleanup(); }
});

test("a long design note does not make the design block readers backtrack (review-pack, story approval, design check stay fast)", () => {
  const p = uiProject();
  try {
    const note = "owner world look mockup (day), docs/ui/mockups; the game frame cut out of the preview page; its HUD is superseded by the newer proposal; " + "more words here ".repeat(40);
    assert.equal(p.run(["design", "approve", "S001", "--file", join(p.repo, "design.png"), "--fidelity", "mockup", "--crop", "0,0,16,8", "--scene", "hud", "--note", note]).code, 0);
    const timed = (args) => { const t0 = Date.now(); const r = p.run(args); return { ...r, ms: Date.now() - t0 }; };
    for (const args of [["review-pack", "--json"], ["design", "check", "S001"], ["design", "status"]]) {
      const r = timed(args);
      assert.equal(r.code, 0, args.join(" ") + ": " + r.err);
      assert.ok(r.ms < 5000, `${args.join(" ")} took ${r.ms} ms`);
    }
    const pack = JSON.parse(p.run(["review-pack", "--json"]).out);
    assert.equal(pack.stories.find((x) => x.id === "S001").design, "v1");
    // re-approval rewrites the whole block, long note included
    assert.equal(p.run(["design", "approve", "S001", "--file", join(p.repo, "design.png"), "--note", "short"]).code, 0);
    const text = readFileSync(join(p.dataDir, "spec/stories/S001-x.md"), "utf8");
    assert.equal((text.match(/^design:/gm) || []).length, 1);
    assert.doesNotMatch(text, /more words here/);
    assert.match(text, /^  version: 2$/m);
  } finally { p.cleanup(); }
});

test("the agent ledger keeps itself: a named helper started under a Shipyard lock is recorded, and the command cannot end while it is still listed", () => {
  const p = project();
  try {
    const agent = (name, session = "S1") => ledgerRecord(p.dataDir, { tool_name: "Agent", session_id: session, tool_input: { name, description: "Day-world look deep-dive", prompt: "..." } });
    const stop = (id, session = "S1") => ledgerRecord(p.dataDir, { tool_name: "TaskStop", session_id: session, tool_input: { task_id: id } });
    assert.equal(agent("stray-helper"), null, "no Shipyard command is running: the user's own agent is not ours to record");
    assert.equal(p.run(["lock", "acquire", "planning", "--skill", "ship-discuss"]).code, 0);
    assert.equal(agent("stray-helper", "OTHER"), null, "another session's agent");
    assert.equal(ledgerRecord(p.dataDir, { tool_name: "Agent", session_id: "S1", tool_input: { description: "unnamed", prompt: "..." } }), null, "an unnamed agent cannot be addressed or stopped by name");
    assert.deepEqual(agent("deepdive-day-world"), { type: "agent_spawned", agent: "deepdive-day-world" });
    const live = liveAgents(readEvents(p.dataDir));
    assert.deepEqual(live.map((a) => [a.name, a.via, a.session]), [["deepdive-day-world", "hook", "S1"]]);
    let r = p.run(["lock", "release", "planning", "--skill", "ship-discuss"]);
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /1 agent\(s\) this command started are still listed: deepdive-day-world/);
    assert.match(r.err, /TaskStop <name>/);
    assert.equal(JSON.parse(r.out).reason, "agents_live");
    assert.equal(stop("not-in-the-ledger"), null);
    assert.deepEqual(stop("deepdive-day-world"), { type: "agent_stopped", agent: "deepdive-day-world" });
    r = p.run(["lock", "release", "planning", "--skill", "ship-discuss"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(JSON.parse(r.out).released, true);
    // a later command is not held up by what an earlier one left recorded and stopped
    assert.equal(p.run(["lock", "acquire", "planning", "--skill", "ship-sprint"]).code, 0);
    assert.equal(p.run(["lock", "release", "planning", "--skill", "ship-sprint"]).code, 0);
  } finally { p.cleanup(); }
});

test("agent-ledger hook is registered for Agent and TaskStop, never blocks, and --force still releases", () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.PreToolUse.some((h) => h.matcher === "Agent|TaskStop" && /agent-ledger/.test(h.hooks[0].command)));
  const p = project();
  try {
    assert.equal(p.run(["lock", "acquire", "planning", "--skill", "ship-discuss"]).code, 0);
    const r = spawnSync("node", [join(ROOT, "bin", "hook-runner.mjs"), "agent-ledger"], { cwd: p.repo, input: JSON.stringify({ tool_name: "Agent", session_id: "S1", tool_input: { name: "critic-1", description: "critic" } }), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: p.dataDir } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "", "the hook records; it never returns a permission decision");
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"agent_spawned"[^\n]*"critic-1"[^\n]*"via":"hook"/);
    assert.equal(p.run(["lock", "release", "planning", "--skill", "ship-discuss"]).code, 3);
    assert.equal(p.run(["lock", "release", "planning", "--skill", "ship-discuss", "--force"]).code, 0, "the escape hatch for a helper that cannot be stopped");
  } finally { p.cleanup(); }
});

test("a builder's return is one command: task-return writes the artifact, sets capture_file and closes the queue item", () => {
  const p = project();
  try {
    const items = join(p.root, "w.json"); writeFileSync(items, JSON.stringify([{ id: "P001", effort: "S" }, { id: "P002", effort: "S" }]));
    assert.equal(p.run(["queue", "enqueue", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--input", items]).code, 0);
    assert.match(p.run(["queue", "claim", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--worker", "builder-P001"]).out, /"claimed":true/);
    assert.match(p.run(["queue", "claim", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--worker", "builder-P002"]).out, /"claimed":true/);
    const tail = join(p.root, "tail.txt"); writeFileSync(tail, "ok 12 checks\n");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.repo, encoding: "utf8" }).trim();
    let r = p.run(["task-return", "P001", "status=COMPLETE", `commit=${sha}`, "probe-exit=0", `output-tail-file=${tail}`, "--data-dir", p.dataDir]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /queue item P001 closed \(complete\)/);
    const artifact = JSON.parse(readFileSync(r.out.trim(), "utf8"));
    assert.equal(artifact.capture_file, tail);
    let q = JSON.parse(p.run(["queue", "list", "--json"]).out);
    const item = (id) => (q.tasks ?? q).find((t) => t.id === id);
    assert.equal(item("P001").status, "complete");
    assert.equal(item("P001").artifact_status, "COMPLETE");
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"worker_queue_completed"[^\n]*"P001"[^\n]*"via":"task-return"/);
    // a blocked return closes the item too, with its own status; no tail file: the artifact is its own evidence
    r = p.run(["task-return", "P002", "status=BLOCKED", "probe-exit=1", "escalation-code=check_needs_owner", "--data-dir", p.dataDir]);
    assert.equal(r.code, 0, r.err);
    q = JSON.parse(p.run(["queue", "list", "--json"]).out);
    assert.equal((q.tasks ?? q).find((t) => t.id === "P002").artifact_status, "BLOCKED");
    // a return for a step with no queue item (solo mode, a patch step) is still recorded quietly
    r = p.run(["task-return", "P009", "status=COMPLETE", `commit=${sha}`, "probe-exit=0", `output-tail-file=${tail}`, "--data-dir", p.dataDir]);
    assert.equal(r.code, 0); assert.equal(r.err, "");
  } finally { p.cleanup(); }
});

test("queue reconcile accepts a CLI-written return with no capture_file, and can be re-run on an item it failed for a bad artifact", () => {
  const p = project();
  try {
    const items = join(p.root, "w.json"); writeFileSync(items, JSON.stringify([{ id: "P001", effort: "S" }]));
    assert.equal(p.run(["queue", "enqueue", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--input", items]).code, 0);
    assert.match(p.run(["queue", "claim", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--worker", "builder-P001"]).out, /"claimed":true/);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.repo, encoding: "utf8" }).trim();
    // what a pre-4.9.2 task-return wrote: no capture_file; and the builder could not close the item
    const dir = join(p.dataDir, "sprints", "current", ".subagent-returns"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "P001.json"), "{ not json");
    assert.equal(p.run(["events", "emit", "subagent_completed", "pipeline=ship-execute", "task=P001", "status=COMPLETE"]).code, 0);
    let r = p.run(["queue", "reconcile", "P001"]);
    assert.equal(JSON.parse(r.out).outcome, "failed", r.out + r.err);
    writeFileSync(join(dir, "P001.json"), JSON.stringify({ task: "P001", status: "COMPLETE", commit_sha: sha, probe_exit_code: 0, escalation_code: null, output_tail: "ok\n", recorded_at: new Date().toISOString() }));
    r = p.run(["queue", "reconcile", "P001"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(JSON.parse(r.out).outcome, "complete");
    assert.equal(JSON.parse(r.out).task.reason, undefined);
  } finally { p.cleanup(); }
});

test("a builder is spawned on the model its step is routed to: the hook refuses any other, and follows the ladder", () => {
  const p = project();
  try {
    const cfg = join(p.dataDir, "config.md");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^  light: .*$/m, "  light: haiku").replace(/^  build: .*$/m, "  build: sonnet").replace(/^  think: .*$/m, "  think: opus"));
    assert.equal(p.run(["lock", "acquire", "execution", "--skill", "ship-execute"]).code, 0);
    const spawn = (name, model, type = "shipyard:shipyard-disciplined-builder") => wrongBuilderModel(p.dataDir, { tool_name: "Agent", session_id: "S1", tool_input: { name, model, subagent_type: type, prompt: "..." } });
    // P001 is a size-S feature step → light → haiku
    let w = spawn("builder-P001", "sonnet");
    assert.ok(w, "a reused model is refused");
    assert.equal(w.expected, "haiku");
    assert.match(w.reason, /builder-P001 must run on haiku: step P001 is routed to the light tier, and this spawn asks for sonnet/);
    assert.match(w.reason, /resolve-model build --subject P001/);
    assert.equal(spawn("builder-P001", "haiku"), null);
    assert.ok(spawn("builder-P001", undefined), "no model at all would inherit the session's");
    // after a failed attempt the same step is expected one rung up
    assert.equal(p.run(["events", "emit", "dispatch_attempt", "pipeline=ship-execute", "sprint=sprint-001", "subject=P001"]).code, 0);
    assert.equal(spawn("builder-P001", "sonnet"), null);
    assert.equal(spawn("builder-P001", "haiku").expected, "sonnet");
    // not our business: other agent types, names without a step, unknown steps, other sessions, no execute lock
    assert.equal(spawn("review-S001", "opus", "shipyard:shipyard-spec-reviewer"), null);
    assert.equal(spawn("helper", "sonnet"), null);
    assert.equal(spawn("builder-P999", "sonnet"), null);
    assert.equal(wrongBuilderModel(p.dataDir, { tool_name: "Agent", session_id: "OTHER", tool_input: { name: "builder-P002", model: "opus", subagent_type: "shipyard:shipyard-disciplined-builder" } }), null);
    // through the runner: a deny decision and an event; nothing is recorded as spawned
    const r = spawnSync("node", [join(ROOT, "bin", "hook-runner.mjs"), "agent-ledger"], { cwd: p.repo, input: JSON.stringify({ tool_name: "Agent", session_id: "S1", tool_input: { name: "builder-P002", model: "opus", subagent_type: "shipyard:shipyard-disciplined-builder" } }), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: p.dataDir } });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
    const ev = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(ev, /"builder_model_refused"[^\n]*"step":"P002"[^\n]*"expected":"haiku"/);
    assert.doesNotMatch(ev, /"agent_spawned"[^\n]*builder-P002/);
  } finally { p.cleanup(); }
});

test("the owner's question is not reachable until the review document is complete", () => {
  const p = project();
  try {
    const adv = (stage) => p.run(["cursor", "advance", "review", stage, "sprint=sprint-001"]);
    assert.equal(adv("preflight").code, 0);
    assert.equal(adv("review_pack").code, 0);
    let r = adv("demo_user");
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err + r.out, /the sprint review is not complete/);
    assert.match(r.err + r.out, /REVIEW-PACK\.md does not exist/);
    assert.equal(p.run(["review-pack", "--write"]).code, 0);
    r = adv("demo_user");
    assert.equal(r.code, 3); assert.match(r.err + r.out, /still has a FILL marker/);
    const path = join(p.dataDir, "sprints/current/REVIEW-PACK.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(/<!-- FILL: [^>]*? -->/g, "Written by the reviewer."));
    r = adv("demo_user");
    assert.equal(r.code, 0, r.out + r.err);
  } finally { p.cleanup(); }
});

test("an idea a builder filed as new, pending or open can be promoted, parked or triaged like any captured one", () => {
  const p = project();
  try {
    mkdirSync(join(p.dataDir, "spec/ideas"), { recursive: true });
    for (const [id, st] of [["IDEA-031", "new"], ["IDEA-032", "pending"], ["IDEA-033", "open"]]) writeFileSync(join(p.dataDir, "spec/ideas", `${id}-x.md`), `---\nid: ${id}\ntitle: "x"\ntype: idea\ncreated: 2026-11-14\nstatus: ${st}\n---\n`);
    let r = p.run(["idea", "set-status", "IDEA-031", "promoted", "--to", "S001"]);
    assert.equal(r.code, 0, r.err); assert.match(r.out, /IDEA-031: captured -> promoted \(-> S001\)/);
    assert.equal(p.run(["idea", "set-status", "IDEA-032", "parked"]).code, 0);
    assert.equal(p.run(["idea", "set-status", "IDEA-033", "landed"]).code, 0);
    assert.match(readFileSync(join(p.dataDir, "spec/ideas/IDEA-032-x.md"), "utf8"), /^status: parked$/m);
  } finally { p.cleanup(); }
});

test("the question card holds only the question and the choices: a long card is refused inside a Shipyard command, never outside one", () => {
  const short = { questions: [{ question: "How strict should the sign-in cookie be?", header: "Cookie", options: [{ label: "Strict (Recommended)", description: "Safest; a link from another site asks to sign in again" }, { label: "Lax", description: "Links from other sites keep working" }] }] };
  assert.deepEqual(shapeProblems(short.questions ? short : {}), []);
  const long = { questions: [{ question: "x".repeat(ASK_LIMITS.question + 1), options: [{ label: "y".repeat(ASK_LIMITS.label + 1), description: "z".repeat(ASK_LIMITS.description + 1) }, { label: "ok", description: "ok" }] }] };
  const probs = shapeProblems(long);
  assert.equal(probs.length, 3, probs.join("\n"));
  const two = { questions: [short.questions[0], short.questions[0]] };
  assert.match(shapeProblems(two).join("|"), /2 questions in one card \(limit 1\): write each question in the chat/);
  assert.match(probs[0], /the question is 241 characters \(limit 240\)/);
  // what a session aims at is shorter than what is refused: a few characters over is not worth a red error on the person's screen
  const bit = { questions: [{ question: "How strict should the sign-in cookie be?", options: [{ label: "Strict (Recommended)", description: "d".repeat(123) }, { label: "Lax", description: "ok" }] }] };
  assert.deepEqual(shapeProblems(bit), [], "the owner met a refusal for a description of 123 characters");
  const p = project();
  try {
    const ask = (input) => decideShape(p.dataDir, { tool_name: "AskUserQuestion", session_id: "S1", tool_input: input });
    assert.equal(ask(long), null, "no Shipyard command is running in this session: not Shipyard's business");
    assert.equal(p.run(["lock", "acquire", "planning", "--skill", "ship-discuss"], { CLAUDE_CODE_SESSION_ID: "S1" }).code, 0);
    const v = ask(long);
    assert.ok(v, "inside a Shipyard command the long card is refused");
    assert.match(v.reason, /the question card holds only the question and the choices/);
    assert.match(v.reason, /as chat text first/);
    assert.equal(ask(short), null, "a short card passes");
    // through the registered hook: a deny decision and an event
    const r = spawnSync("node", [join(ROOT, "bin", "hook-runner.mjs"), "unattended-ask"], { cwd: p.repo, input: JSON.stringify({ tool_name: "AskUserQuestion", session_id: "S1", tool_input: long }), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: p.dataDir } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"ask_shape_denied"/);
  } finally { p.cleanup(); }
});
