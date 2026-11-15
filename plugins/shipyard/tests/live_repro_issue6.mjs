/**
 * Live repro for GH #6: a sprint whose frontmatter quotes its feature ids
 * (features: ["F003"]) with an approve verdict and a fresh full-suite ledger
 * entry must be ALLOWed by `shipyard-context terminal-gate ship-review`.
 *
 * Runs entirely in a throwaway git repo + temp plugin data root; never
 * touches a real project's data dir.
 *
 *   node tests/live_repro_issue6.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_CLI = join(PLUGIN_ROOT, "bin", "shipyard-data.mjs");
const CTX_CLI = join(PLUGIN_ROOT, "bin", "shipyard-context.mjs");

const root = mkdtempSync(join(tmpdir(), "live-repro-issue6-"));
let code = 1;
try {
  const repo = join(root, "repo");
  const pluginData = join(root, "plugin-data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(pluginData, { recursive: true });
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "content\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  delete env.SHIPYARD_DATA;
  const run = (cli, args) => spawnSync("node", [cli, ...args], { cwd: repo, env, encoding: "utf8" });

  const dataDir = run(DATA_CLI, []).stdout.trim();
  if (!dataDir) throw new Error("could not resolve data dir");
  mkdirSync(join(dataDir, "sprints", "current"), { recursive: true });
  mkdirSync(join(dataDir, "verify"), { recursive: true });
  writeFileSync(join(dataDir, "sprints", "current", "SPRINT.md"),
    `---\nid: sprint-001\nstatus: in-progress\nfeatures: ["F003"]\nstarted_at: 2026-05-19T00:00:00Z\n---\n\n## Waves\n\n### Wave 1\nTasks: [T001]\n`);
  writeFileSync(join(dataDir, "verify", "F003-verdict.md"), "---\nrecommendation: approve\n---\n");
  writeFileSync(join(dataDir, ".shipyard-events.jsonl"),
    JSON.stringify({ type: "pipeline_tick_completed", pipeline: "ship-review", stage: "demo_user", ts: new Date().toISOString() }) + "\n");

  const capture = join(root, "capture.log"); // outside the repo: keeps the tree clean
  writeFileSync(capture, "all green\n");
  const rec = run(DATA_CLI, ["verify", "record", "--key", "sprint_full_tests", "--command", "full test suite", "--exit", "0", "--capture", capture]);
  if (rec.status !== 0) throw new Error(`verify record failed: ${rec.stderr}`);

  const gate = run(CTX_CLI, ["terminal-gate", "ship-review"]);
  process.stdout.write(gate.stdout + gate.stderr);
  if (gate.status === 0 && /^ALLOW/.test(gate.stdout)) {
    console.log("PASS: quoted features [\"F003\"] -> ALLOW");
    code = 0;
  } else {
    console.error("FAIL: expected ALLOW");
  }
} catch (e) {
  console.error(`live repro error: ${e.message}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(code);
