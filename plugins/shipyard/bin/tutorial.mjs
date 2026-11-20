/**
 * tutorial — the guided run (after 4.0.7): `/ship-quick --tutorial`.
 *
 * A tutorial is one quick run with narration. The run is the same four commands
 * with every gate they have, on a branch the owner made; what differs is that
 * the CLI prints a short `TUTORIAL:` block as each stage is entered, as a gate
 * refuses something, and when the run closes. The text lives in one file,
 * `project-files/references/tutorial-narration.md`, keyed by stage, so every
 * tutorial says the same thing and a golden test pins the words. Skills echo
 * the CLI's output; they carry no narration of their own.
 *
 * Keys:
 *   intro                 the first card, before any stage
 *   quick:<stage>         printed by `shipyard-data quick next` (pick, discuss, plan, build, review, finish)
 *   cursor:<stage id>     printed by `shipyard-data cursor advance` (wave numbers read as N: wave_N_gate)
 *   refusal:<gate>        printed by a gate after its refusal (probes-at-base, plan-score, task-return, story-approve, unattended-ask)
 *
 *   shipyard-data tutorial sandbox [--path <folder>]   a throwaway project to take the tutorial in
 *   shipyard-data tutorial sandbox --remove <folder>   delete one the CLI made
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOnboarding, readOnboardingRecord, writeOnboardingRecord } from "./init-data.mjs";
import { logEvent } from "./_hook_lib.mjs";
import { homeOf } from "./shipyard-resolver.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const NARRATION_FILE = join(PLUGIN_ROOT, "project-files", "references", "tutorial-narration.md");
export const SANDBOX_FIXTURE = join(PLUGIN_ROOT, "project-files", "tutorial-sandbox");
export const SANDBOX_MARKER = ".shipyard-tutorial-sandbox";
export const SANDBOX_BRANCH = "tutorial";
/** The gates that print a `refusal:<gate>` block after refusing. Each name appears as `refusal:<name>` in the gate's source. */
export const REFUSAL_KEYS = Object.freeze(["probes-at-base", "plan-score", "task-return", "story-approve", "unattended-ask"]);

const fail = (msg, code = 3) => { process.stderr.write(`shipyard-data tutorial: ${msg}\n`); process.exit(code); };

/** The narration, key → text. A `## key` heading starts an entry; the text runs to the next heading. */
export function loadNarration(file = NARRATION_FILE) {
  const map = new Map();
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return map; }
  let key = null;
  const body = [];
  const flush = () => { if (key) map.set(key, body.join("\n").trim()); body.length = 0; };
  for (const line of text.split(/\r?\n/)) {
    const m = /^##\s+(\S+)\s*$/.exec(line);
    if (m) { flush(); key = m[1]; continue; }
    if (key) body.push(line);
  }
  flush();
  return map;
}

/** Is `dataDir` a tutorial run's folder? Read from quick.json directly (quick.mjs imports this module). The run's state does not matter: the close narrates after the run is marked finished. */
export function isTutorial(dataDir) {
  try { const o = JSON.parse(readFileSync(join(dataDir, "quick.json"), "utf8")); return o?.tutorial === true; } catch { return false; }
}

/** `wave_3_gate` → `wave_N_gate`; `wave_2_redispatch_iter_4` → `wave_N_redispatch_iter_N`. */
export function normalizeCursorKey(stage) {
  return String(stage ?? "").replace(/^wave_\d+_/, "wave_N_").replace(/_iter_\d+$/, "_iter_N");
}

/** The block to print for `key` in this run, or "" when this is not a tutorial or the key has no entry. */
export function tutorialBlock(dataDir, key, narration = loadNarration()) {
  if (!isTutorial(dataDir)) return "";
  const text = narration.get(key);
  if (!text) return "";
  const lines = text.split("\n");
  return `TUTORIAL: ${lines[0]}\n${lines.slice(1).map((l) => (l ? `  ${l}` : "")).join("\n")}`.replace(/\n+$/, "") + "\n";
}

/** Print the block for `key`, when there is one. Returns true when something was printed. */
export function tutorialNote(dataDir, key, { stream = "stdout" } = {}) {
  let block = "";
  try { block = tutorialBlock(dataDir, key); } catch { block = ""; }
  if (!block) return false;
  (stream === "stderr" ? process.stderr : process.stdout).write(block);
  return true;
}

/** The run is over: the project remembers the tutorial was taken. */
export function markTutorialCompleted(dataDir, run) {
  const home = homeOf(dataDir);
  writeOnboardingRecord(home, { tutorial_completed: new Date().toISOString() });
  for (const d of [home, dataDir]) { try { logEvent(d, "tutorial_completed", { run }); } catch { /* best-effort */ } }
  return readOnboardingRecord(home);
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).trim();

function freeSandboxPath() {
  const base = tmpdir();
  let names = [];
  try { names = readdirSync(base); } catch { names = []; }
  const used = names.map((n) => /^shipyard-tutorial-(\d{3,})$/.exec(n)?.[1]).filter(Boolean).map(Number);
  const n = used.length ? Math.max(...used) + 1 : 1;
  return join(base, `shipyard-tutorial-${String(n).padStart(3, "0")}`);
}

/**
 * Copy the fixture project to `folder`, make it a git repository on branch `tutorial`
 * with one commit, set Shipyard up in it, and say where it is.
 */
export function createSandbox(folder = freeSandboxPath()) {
  const dest = resolve(folder);
  if (existsSync(dest) && readdirSync(dest).length) fail(`${dest} exists and is not empty. Name an empty or new folder: tutorial sandbox --path <folder>`);
  if (!existsSync(SANDBOX_FIXTURE)) fail(`the sandbox fixture is missing from the plugin: ${SANDBOX_FIXTURE}`, 1);
  mkdirSync(dest, { recursive: true });
  cpSync(SANDBOX_FIXTURE, dest, { recursive: true });
  writeFileSync(join(dest, SANDBOX_MARKER), `made by shipyard-data tutorial sandbox on ${new Date().toISOString()}\n`);
  writeFileSync(join(dest, ".gitignore"), `node_modules/\n.shipyard\n${SANDBOX_MARKER}\n`);
  git(["init", "-q"], dest);
  git(["symbolic-ref", "HEAD", `refs/heads/${SANDBOX_BRANCH}`], dest);
  git(["add", "-A"], dest);
  git(["-c", "user.name=Shipyard tutorial", "-c", "user.email=tutorial@shipyard.local", "commit", "-q", "-m", "A small project to learn Shipyard on"], dest);
  const { dataDir } = bootstrapOnboarding({ projectRoot: dest });
  return { path: dest, branch: SANDBOX_BRANCH, dataDir };
}

export function removeSandbox(folder) {
  const dest = resolve(folder);
  if (!existsSync(dest)) fail(`no folder at ${dest}`);
  if (!existsSync(join(dest, SANDBOX_MARKER))) fail(`${dest} was not made by \`shipyard-data tutorial sandbox\` (no ${SANDBOX_MARKER} marker). Nothing was removed.`);
  rmSync(dest, { recursive: true, force: true });
  return dest;
}

export function main(dataDir, args = []) {
  const sub = args[0];
  if (sub === "sandbox") {
    const ri = args.indexOf("--remove");
    if (ri !== -1) {
      const folder = args[ri + 1];
      if (!folder || folder.startsWith("--")) fail("which folder? tutorial sandbox --remove <folder>", 2);
      const gone = removeSandbox(folder);
      process.stdout.write(`Removed the sandbox at ${gone}.\n`);
      return;
    }
    const pi = args.indexOf("--path");
    const folder = pi !== -1 ? args[pi + 1] : undefined;
    if (pi !== -1 && (!folder || folder.startsWith("--"))) fail("tutorial sandbox --path <folder>", 2);
    const made = createSandbox(folder);
    process.stdout.write(
      `Sandbox ready at ${made.path} on branch ${made.branch}.\n` +
      `  Open a session there and run /ship-quick --tutorial:   cd ${made.path} && claude\n`,
    );
    return;
  }
  process.stderr.write("shipyard-data tutorial: sandbox [--path <folder>] | sandbox --remove <folder>\n");
  process.exit(2);
}
