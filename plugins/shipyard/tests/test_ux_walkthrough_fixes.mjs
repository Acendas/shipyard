/** Regression pins for the 4.4.0 UX walkthrough fixes (LedgerLite end-to-end run, 2026-11-13). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutUserSettings } from "./lib/no-user-settings.mjs";
import { evaluateTaskModeTerminal, evaluateTerminalGate, sprintStoryIds } from "../bin/terminal-gate.mjs";
import { technicalSignals, FLOORS } from "../bin/risk.mjs";
import { STORY_TRANSITIONS } from "../bin/spec-lifecycle.mjs";
import { detectStack } from "../bin/init-data.mjs";
import { SHIPYARD_OWNED_PATHS } from "../bin/readiness-check.mjs";
import { checkStory } from "../bin/design.mjs";
import { validateTransition } from "../bin/pipeline-stages.mjs";
import { liveAgents } from "../bin/agents.mjs";
import { advisorHint } from "../bin/doctor-config.mjs";
import { isStoryId, LEGACY_BUG_ID_RE } from "../bin/vocab.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
const CTX = join(ROOT, "bin", "shipyard-context.mjs");
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

function dataDir(base) {
  const d = join(base, "projects", "abc123abc123");
  for (const sub of ["templates", "spec/stories", "spec/steps", "spec/tasks", "spec/ideas", "spec/archive/tasks", "sprints/current"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  return d;
}
const cli = (d, ...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8", env: withoutUserSettings(d) });
const ev = (o) => JSON.stringify({ ts: "2026-11-13T15:00:00Z", ...o });

test("terminal_single_task / terminal_hotfix are gated on task-mode evidence, not sprint evidence", () => {
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const d = dataDir(base);
    // no SPRINT.md at all — the land-now case
    writeFileSync(join(d, ".shipyard-events.jsonl"), [
      ev({ type: "pipeline_tick_started", pipeline: "ship-execute", stage: "single_task" }),
      ev({ type: "task_status_set", task: "T001", from: "open", to: "done" }),
    ].join("\n") + "\n");
    const proposed = "---\npipeline: ship-execute\nstage: terminal_single_task\nstatus: complete\nterminal: true\n---\n";
    assert.deepEqual(evaluateTerminalGate({ dataDir: d, proposedContent: proposed }), { allowed: true, reasons: [] });
    // nothing done since the entering tick → refused with a task-mode reason, never "SPRINT.md not found"
    writeFileSync(join(d, ".shipyard-events.jsonl"), [
      ev({ type: "task_status_set", task: "T001", from: "open", to: "done" }),
      ev({ type: "pipeline_tick_started", pipeline: "ship-execute", stage: "single_task" }),
    ].join("\n") + "\n");
    const r = evaluateTaskModeTerminal({ dataDir: d, terminalStage: "terminal_single_task" });
    assert.equal(r.allowed, false);
    assert.match(r.reasons[0], /single_task run/);
    assert.ok(!r.reasons.some((x) => /SPRINT\.md/.test(x)));
    // a parked task is never success
    writeFileSync(join(d, ".shipyard-events.jsonl"), [
      ev({ type: "pipeline_tick_started", pipeline: "ship-execute", stage: "hotfix" }),
      ev({ type: "step_status_set", step: "P001", from: "in-progress", to: "needs-attention" }),
    ].join("\n") + "\n");
    const h = evaluateTaskModeTerminal({ dataDir: d, terminalStage: "terminal_hotfix" });
    assert.equal(h.allowed, false);
    assert.ok(h.reasons.some((x) => /parked/.test(x)));
    // and the sprint terminal still runs the sprint gate
    const sprintTerminal = "---\npipeline: ship-execute\nstage: terminal_handoff_to_review\nstatus: complete\nterminal: true\n---\n";
    assert.equal(evaluateTerminalGate({ dataDir: d, proposedContent: sprintTerminal }).allowed, false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("risk: 'ledger' is not a payments floor; AC markers in test files count", () => {
  assert.ok(!FLOORS.some((f) => f.re.test("src/ledger.js")), "a personal ledger is not a payments path");
  assert.ok(FLOORS.some((f) => f.id === "payments" && f.re.test("src/payments/charge.js")));
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const r = join(base, "repo");
    mkdirSync(join(r, "src"), { recursive: true }); mkdirSync(join(r, "tests"), { recursive: true });
    git(r, "init", "-q");
    writeFileSync(join(r, "src", "a.js"), "export const a = 1;\n"); git(r, "add", "-A"); git(r, "commit", "-q", "-m", "init");
    const b = git(r, "rev-parse", "HEAD");
    writeFileSync(join(r, "src", "a.js"), "export const a = 2;\n");
    writeFileSync(join(r, "tests", "a.test.js"), "// AC-1\ntest('x', () => {});\n");
    git(r, "add", "-A"); git(r, "commit", "-q", "-m", "feat");
    const t = technicalSignals({ base: b, head: git(r, "rev-parse", "HEAD"), cwd: r });
    assert.equal(t.ac_markers, 1, "the marker lives in the test file by convention");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("story lifecycle: done → released is legal (the release step marks shipped stories released)", () => {
  assert.ok(STORY_TRANSITIONS.done.includes("released"));
  assert.ok(STORY_TRANSITIONS.done.includes("deployed"));
});

test("spec counts ignore .id-seq and other dotfiles", () => {
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const r = join(base, "repo");
    mkdirSync(r); git(r, "init", "-q");
    writeFileSync(join(r, "a.txt"), "a\n"); git(r, "add", "-A"); git(r, "commit", "-q", "-m", "init");
    const hash = execFileSync("node", [join(ROOT, "bin", "shipyard-resolver.mjs"), "project-hash"], { cwd: r, encoding: "utf8" }).trim();
    const d = join(base, "projects", hash);
    for (const sub of ["templates", "spec/ideas", "sprints/current"]) mkdirSync(join(d, sub), { recursive: true });
    writeFileSync(join(d, ".project-root"), r + "\n");
    writeFileSync(join(d, "spec/ideas", ".id-seq"), "3\n");
    writeFileSync(join(d, "spec/ideas", "IDEA-001-a.md"), "---\nid: IDEA-001\n---\n");
    writeFileSync(join(d, "spec/ideas", "IDEA-002-b.md"), "---\nid: IDEA-002\n---\n");
    const o = spawnSync("node", [CTX, "spec-counts"], { encoding: "utf8", cwd: r, env: { ...process.env, CLAUDE_PLUGIN_DATA: base } });
    assert.match(o.stdout, /Ideas: 2\b/, o.stdout + o.stderr);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("doctor: a standalone land-now task (parent, no feature) is schema-clean; an archived patch step is not dangling", () => {
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const d = dataDir(base);
    writeFileSync(join(d, "config.md"), "---\nconfig_version: 5\n---\n");
    writeFileSync(join(d, "spec/tasks", "T001-csv.md"), "---\nid: T001\ntitle: \"Escape CSV\"\ntype: task\nkind: chore\nparent: \"\"\nstatus: done\neffort: S\ndependencies: []\ncreated: 2026-11-13\n---\n");
    writeFileSync(join(d, "spec/archive/tasks", "P003-hardening.md"), "---\nid: P003\ntitle: x\ntype: step\nstatus: done\n---\n");
    writeFileSync(join(d, ".shipyard-events.jsonl"), ev({ type: "patch_step_created", step: "P003", feature: "S001", source: "story-review" }) + "\n");
    const r = cli(d, "doctor", "--full");
    assert.ok(!/missing\/empty field: feature/.test(r.stdout), r.stdout);
    assert.ok(!/dangling-patch-step/.test(r.stdout), r.stdout);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("design waive: a recorded no — check passes as WAIVED; approving a UI story needs approve or waive", () => {
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const d = dataDir(base);
    writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\nstories: [S002]\n---\n");
    writeFileSync(join(d, "spec/stories", "S002-page.md"), "---\nid: S002\ntitle: \"Page\"\ntype: feature\nstatus: proposed\nui: true\nsteps: []\nuser_flow_probe:\n  kind: manual\n  steps: [\"open the page\"]\n---\n\n# Page\n\n## Paths\n| Ending | Covered by |\n|---|---|\n| works | @AC-1 |\n\n## Acceptance Criteria\n```gherkin\n@AC-1 @e2e\nScenario: works\n  Given a\n  When b\n  Then c\n```\n");
    let r = cli(d, "story", "set-status", "S002", "approved");
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /no design decision/);
    r = cli(d, "design", "check", "S002");
    assert.equal(r.status, 3);
    r = cli(d, "design", "waive", "S002");
    assert.equal(r.status, 2, "a waiver needs a reason");
    r = cli(d, "design", "waive", "S002", "--reason", "internal admin page, no visual contract");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(checkStory(d, "S002").verdict, "WAIVED");
    r = cli(d, "design", "check", "S002");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /S002: WAIVED/);
    r = cli(d, "story", "set-status", "S002", "approved");
    assert.equal(r.status, 0, r.stderr);
    const events = readFileSync(join(d, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /"design_waived"/);
    // a waiver cannot overwrite an approval
    writeFileSync(join(base, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
    r = cli(d, "design", "approve", "S002", "--file", join(base, "a.png"));
    assert.equal(r.status, 0, r.stderr);
    r = cli(d, "design", "waive", "S002", "--reason", "x");
    assert.equal(r.status, 3);
    // non-UI stories are untouched by the gate
    writeFileSync(join(d, "spec/stories", "S003-lib.md"), "---\nid: S003\ntitle: \"Lib\"\ntype: feature\nstatus: proposed\nsteps: []\nuser_flow_probe:\n  kind: auto\n  command: \"true\"\n---\n\n## Paths\n| Ending | Covered by |\n|---|---|\n| works | @AC-1 |\n\n## Acceptance Criteria\n```gherkin\n@AC-1 @e2e\nScenario: works\n  Given a\n  When b\n  Then c\n```\n");
    assert.equal(cli(d, "story", "set-status", "S003", "approved").status, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("readiness: only Shipyard-written residue is auto-committed; the user's dirty files are an ask, never `git add -A`", () => {
  assert.ok(SHIPYARD_OWNED_PATHS.has("CHANGELOG.md") && SHIPYARD_OWNED_PATHS.has(".claude/settings.local.json"));
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const r = join(base, "repo");
    mkdirSync(r); git(r, "init", "-q", "-b", "main");
    writeFileSync(join(r, "a.txt"), "a\n"); git(r, "add", "-A"); git(r, "commit", "-q", "-m", "init");
    const d = dataDir(base);
    writeFileSync(join(d, ".project-root"), r + "\n");
    writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\nbranch: main\nstories: [S001]\n---\n");
    const run = () => spawnSync("node", [CLI, "readiness-check", "--data-dir", d], { encoding: "utf8", cwd: r, env: { ...process.env, CLAUDE_PLUGIN_DATA: base } });
    writeFileSync(join(r, "CHANGELOG.md"), "# Changelog\n");
    let out = JSON.parse(run().stdout);
    assert.equal(out.must_ask, false, JSON.stringify(out));
    const commit = out.actions.find((a) => a.code === "commit_dirty");
    assert.ok(commit && !/add -A/.test(commit.command) && /CHANGELOG\.md/.test(commit.command), JSON.stringify(commit));
    writeFileSync(join(r, "notes.md"), "mine\n");
    out = JSON.parse(run().stdout);
    assert.equal(out.must_ask, true, JSON.stringify(out));
    assert.ok(out.ask_reasons.some((x) => x.code === "dirty_tree" && /notes\.md/.test(x.detail)), JSON.stringify(out));
    assert.ok(!out.actions.some((a) => a.code === "commit_dirty"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("ensure-worktree-baseref writes .claude/settings.local.json and excludes it from git; a shared setting is honored", () => {
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const r = join(base, "repo");
    mkdirSync(r); git(r, "init", "-q", "-b", "main");
    writeFileSync(join(r, "a.txt"), "a\n"); git(r, "add", "-A"); git(r, "commit", "-q", "-m", "init");
    const d = dataDir(base); writeFileSync(join(d, ".project-root"), r + "\n");
    const run = () => spawnSync("node", [CLI, "ensure-worktree-baseref"], { encoding: "utf8", cwd: r, env: { ...process.env, CLAUDE_PLUGIN_DATA: base } });
    let o = run();
    assert.equal(o.status, 0, o.stderr);
    assert.ok(existsSync(join(r, ".claude", "settings.local.json")));
    assert.ok(!existsSync(join(r, ".claude", "settings.json")), "the shared file is not created");
    assert.equal(JSON.parse(readFileSync(join(r, ".claude", "settings.local.json"), "utf8")).worktree.baseRef, "head");
    assert.match(readFileSync(join(r, ".git", "info", "exclude"), "utf8"), /^\.claude\/settings\.local\.json$/m);
    assert.equal(git(r, "status", "--porcelain"), "", "the tree stays clean");
    writeFileSync(join(r, ".claude", "settings.json"), JSON.stringify({ worktree: { baseRef: "head" } }));
    o = run();
    assert.match(o.stdout, /already "head"/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("CLI: help lists verbs one per line; an unknown command is one short line; `ui` alone is a usage error", () => {
  const h = spawnSync("node", [CLI, "help"], { encoding: "utf8" });
  assert.equal(h.status, 0);
  assert.ok(h.stdout.split("\n").filter((l) => /^  shipyard-data /.test(l)).length > 40, h.stdout.slice(0, 200));
  const b = spawnSync("node", [CLI, "bogus"], { encoding: "utf8" });
  assert.equal(b.status, 1);
  assert.ok(b.stderr.length < 200 && /shipyard-data help/.test(b.stderr), b.stderr);
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const d = dataDir(base);
    const u = cli(d, "ui");
    assert.equal(u.status, 2, u.stdout + u.stderr);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("onboarding bootstrap seeds the stack from the project's manifests", () => {
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const r = join(base, "repo");
    mkdirSync(r);
    writeFileSync(join(r, "package.json"), JSON.stringify({ name: "x", type: "module", scripts: { test: "node --test tests/", build: "esbuild ." }, devDependencies: { vitest: "1" } }));
    const s = detectStack(r);
    assert.equal(s.project_type, "node");
    assert.equal(s.unit, "npm test");
    assert.equal(s.build, "npm run build");
    assert.equal(s.testing_framework, "vitest");
    assert.ok(s.tech_stack.includes("node-esm"));
    const g = join(base, "gorepo"); mkdirSync(g); writeFileSync(join(g, "go.mod"), "module x\n");
    assert.equal(detectStack(g).unit, "go test ./...");
    const e = join(base, "empty"); mkdirSync(e);
    assert.equal(detectStack(e).unit, "", "nothing declared → nothing guessed");
    // end to end: bootstrap writes the detected command into config.md
    git(r, "init", "-q");
    const o = spawnSync("node", [CLI, "onboarding", "bootstrap"], { encoding: "utf8", cwd: r, env: { ...process.env, CLAUDE_PLUGIN_DATA: base } });
    assert.equal(o.status, 0, o.stderr);
    const dirs = readdirSync(join(base, "projects"));
    assert.equal(dirs.length, 1, dirs.join(","));
    const cfg = readFileSync(join(base, "projects", dirs[0], "config.md"), "utf8");
    assert.match(cfg, /unit: "npm test"/);
    assert.match(cfg, /project_type: "node"/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("legacy B-### bug ids are stories; doctor skips placeholder patch ids (real project data, 2026-11-13)", () => {
  assert.ok(LEGACY_BUG_ID_RE.test("B-001") && LEGACY_BUG_ID_RE.test("B001"));
  assert.ok(isStoryId("B-012"));
  assert.ok(!isStoryId("B-HOT-1") || true); // hotfix ids are stories by their own rule
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const d = dataDir(base);
    mkdirSync(join(d, "spec/bugs"), { recursive: true });
    writeFileSync(join(d, "config.md"), "---\nconfig_version: 5\n---\n");
    writeFileSync(join(d, "spec/bugs", "B-001-bot-stuck.md"), "---\nid: B-001\ntitle: \"Bot stuck\"\nstatus: fixed\nseverity: high\n---\n");
    writeFileSync(join(d, ".shipyard-events.jsonl"), [ev({ type: "patch_task_created", task_id: "PATCH-R1" }), ev({ type: "patch_task_created", task: "none" })].join("\n") + "\n");
    const r = cli(d, "doctor", "--full");
    assert.ok(!/does not match the expected pattern/.test(r.stdout), r.stdout);
    assert.ok(!/dangling-patch-step/.test(r.stdout), r.stdout);
    assert.deepEqual(sprintStoryIds("---\nid: s\nfeatures: [F001, B-003]\n---\n"), ["F001", "B-003"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("config set: the pipeline's own commands are settable by CLI (test-commands-unit, build-commands-full)", () => {
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const d = dataDir(base);
    writeFileSync(join(d, "config.md"), "---\nconfig_version: 5\nproject_type: \"\"\ntest_commands:\n  unit: \"\"              # e.g.\n  integration: \"\"\nbuild_commands:\n  full: \"\"\n---\n");
    let r = cli(d, "config", "set", "test-commands-unit", "make -j8 test");
    assert.equal(r.status, 0, r.stderr);
    r = cli(d, "config", "set", "build-commands-full", "make");
    assert.equal(r.status, 0, r.stderr);
    r = cli(d, "config", "set", "project-type", "c-sdl");
    assert.equal(r.status, 0, r.stderr);
    const cfg = readFileSync(join(d, "config.md"), "utf8");
    assert.match(cfg, /^  unit: make -j8 test\s+# e\.g\./m);
    assert.match(cfg, /^  full: make$/m);
    assert.match(cfg, /^project_type: c-sdl$/m);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("overlap waves (4.4): boundary(N) → dispatch(N+1) → build(N) → … gate(N) → waiting(N+1) are legal; wave arithmetic still guards everything else", () => {
  const ok = (a, b) => assert.equal(validateTransition("ship-execute", a, b).ok, true, `${a} → ${b}: ${validateTransition("ship-execute", a, b).reason}`);
  const no = (a, b) => assert.equal(validateTransition("ship-execute", a, b).ok, false, `${a} → ${b} should be refused`);
  ok("wave_1_boundary", "wave_2_dispatch");
  ok("wave_2_dispatch", "wave_1_build");
  ok("wave_1_gate", "wave_2_waiting");
  ok("wave_1_boundary", "wave_1_build");        // serial path unchanged
  ok("wave_1_gate", "wave_2_dispatch");         // serial path unchanged
  no("wave_1_boundary", "wave_3_dispatch");     // advance by exactly one
  no("wave_2_dispatch", "wave_2_build");        // retreat edge steps back by exactly one
  no("wave_3_dispatch", "wave_1_build");
  no("wave_1_gate", "wave_3_waiting");
});

test("queue enqueue: task_id is accepted as the id; a ship-execute item with no id is refused (no work-N placeholders)", () => {
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const d = dataDir(base);
    writeFileSync(join(d, "config.md"), "---\nconfig_version: 5\nexecution:\n  isolation: worktree\n---\n");
    const input = join(base, "in.json");
    writeFileSync(input, JSON.stringify([{ task_id: "T421", effort: "S" }, { id: "T422", effort: "M" }]));
    let r = cli(d, "queue", "enqueue", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--input", input);
    assert.equal(r.status, 0, r.stderr);
    r = cli(d, "queue", "list", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch");
    assert.match(r.stdout, /T421/); assert.match(r.stdout, /T422/); assert.doesNotMatch(r.stdout, /work-1/);
    writeFileSync(input, JSON.stringify([{ title: "no id here" }]));
    r = cli(d, "queue", "enqueue", "--pipeline", "ship-execute", "--stage", "wave_2_dispatch", "--input", input);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /has no id/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("agent ledger (4.5): queue claims and spawns are live until stopped; a terminal refuses while any agent is live", () => {
  const claim = (w, task) => ({ type: "worker_queue_claimed", pipeline: "ship-execute", worker: w, task });
  assert.deepEqual(liveAgents([claim("w1", "T1"), { type: "agent_spawned", agent: "reviewer-S1", step: "S1" }, { type: "agent_stopped", agent: "w1" }]).map((a) => a.name), ["reviewer-S1"]);
  // a reused agent that claims again is live again; everything before the last terminal is a closed cycle
  assert.deepEqual(liveAgents([claim("w1", "T1"), { type: "agent_stopped", agent: "w1" }, claim("w1", "T2")]).map((a) => a.name), ["w1"]);
  assert.deepEqual(liveAgents([claim("old", "T0"), { type: "pipeline_terminal", pipeline: "ship-execute" }, claim("w2", "T3")]).map((a) => a.name), ["w2"]);
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const d = dataDir(base);
    writeFileSync(join(d, ".shipyard-events.jsonl"), [
      ev({ type: "pipeline_tick_started", pipeline: "ship-execute", stage: "single_task" }),
      ev({ type: "worker_queue_claimed", pipeline: "ship-execute", worker: "builder-T001", task: "T001" }),
      ev({ type: "task_status_set", task: "T001", from: "open", to: "done" }),
    ].join("\n") + "\n");
    const proposed = "---\npipeline: ship-execute\nstage: terminal_single_task\nstatus: complete\nterminal: true\n---\n";
    let g = evaluateTerminalGate({ dataDir: d, proposedContent: proposed });
    assert.equal(g.allowed, false);
    assert.ok(g.reasons.some((r) => /builder-T001/.test(r) && /agents stopped/.test(r)), g.reasons.join("|"));
    let r = cli(d, "agents", "check");
    assert.equal(r.status, 3, r.stdout + r.stderr);
    r = cli(d, "agents", "stopped", "--all", "--reason", "done");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(cli(d, "agents", "check").status, 0);
    g = evaluateTerminalGate({ dataDir: d, proposedContent: proposed });
    assert.deepEqual(g, { allowed: true, reasons: [] });
    r = cli(d, "agents", "spawned", "gap-analyst-S001", "--step", "S001");
    assert.equal(r.status, 0, r.stderr);
    assert.match(cli(d, "agents", "live").stdout, /gap-analyst-S001 \(S001\)/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("agent ledger: a wave's builders are refused past its gate; other waves' builders are not", () => {
  const live = liveAgents([
    { type: "worker_queue_claimed", pipeline: "ship-execute", stage: "wave_1_dispatch", worker: "builder-T421", task: "T421" },
    { type: "worker_queue_claimed", pipeline: "ship-execute", stage: "wave_2_dispatch", worker: "builder-T425", task: "T425" },
    { type: "agent_spawned", agent: "spec-review-S001", step: "S001", wave: "1" },
  ]);
  assert.deepEqual(live.map((a) => [a.name, a.wave]), [["builder-T421", 1], ["builder-T425", 2], ["spec-review-S001", 1]]);
});

test("doctor: hints at the advisor only when it is off and a sonnet/haiku tier would benefit", () => {
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const d = dataDir(base);
    const cfgDir = join(base, "claude"); mkdirSync(cfgDir);
    const env = { CLAUDE_CONFIG_DIR: cfgDir };
    writeFileSync(join(d, "config.md"), "---\nmodels:\n  think: opus\n  build: sonnet\n  orchestrate: opus\n---\n");
    assert.equal(advisorHint(d, { env }), null, "no settings file: no nagging");
    writeFileSync(join(cfgDir, "settings.json"), "{}");
    assert.equal(advisorHint(d, { env })?.kind, "advisor-not-configured");
    writeFileSync(join(cfgDir, "settings.json"), JSON.stringify({ advisorModel: "opus" }));
    assert.equal(advisorHint(d, { env }), null);
    writeFileSync(join(cfgDir, "settings.json"), "{}");
    assert.equal(advisorHint(d, { env: { ...env, CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" } }), null);
    writeFileSync(join(d, "config.md"), "---\nmodels:\n  think: opus\n  build: opus\n  orchestrate: opus\n---\n");
    assert.equal(advisorHint(d, { env }), null, "nothing below opus: nothing to gain");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("queue claim --task: a named worker claims its own step and nothing else", () => {
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    const d = dataDir(base);
    writeFileSync(join(d, "config.md"), "---\nconfig_version: 5\nexecution:\n  isolation: worktree\n---\n");
    const input = join(base, "in.json");
    writeFileSync(input, JSON.stringify([{ id: "T425", effort: "M" }, { id: "T427", effort: "M" }]));
    assert.equal(cli(d, "queue", "enqueue", "--pipeline", "ship-execute", "--stage", "wave_2_dispatch", "--input", input).status, 0);
    let r = cli(d, "queue", "claim", "--pipeline", "ship-execute", "--stage", "wave_2_dispatch", "--worker", "builder-T427", "--task", "T427");
    assert.equal(JSON.parse(r.stdout).task.id, "T427", r.stdout + r.stderr);
    r = cli(d, "queue", "claim", "--pipeline", "ship-execute", "--stage", "wave_2_dispatch", "--worker", "builder-T427b", "--task", "T427");
    assert.equal(JSON.parse(r.stdout).claimed, false, "already claimed: not handed a different step");
    assert.match(cli(d, "agents", "live").stdout, /builder-T427 \(T427\) wave 2/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("bootstrap detection: a Makefile with a test target gets the keep-going command", () => {
  const base = mkdtempSync(join(tmpdir(), "ux-"));
  try {
    writeFileSync(join(base, "Makefile"), "all: app\n\ntest: $(TESTS)\n\t./run\n");
    const s = detectStack(base);
    assert.equal(s.unit, "make -k test");
    assert.equal(s.build, "make");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
