import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDataDir, getProjectRoot } from "./shipyard-resolver.mjs";
import { releaseLock } from "./skill-lock.mjs";
import { logEvent } from "./_hook_lib.mjs";

// v4 (F022): stories and steps are the written directories; features, tasks
// (legacy builder units) and bugs stay so legacy records keep resolving.
const SUBDIRS = [
  ["spec", "epics"],
  ["spec", "stories"],
  ["spec", "steps"],
  ["spec", "features"],
  ["spec", "tasks"],
  ["spec", "bugs"],
  ["spec", "ideas"],
  ["spec", "references"],
  ["backlog"],
  ["sprints", "current"],
  ["verify"],
  ["debug", "resolved"],
  ["memory"],
  ["releases"],
  ["templates"],
];

function pluginRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function escapeYamlDoubleQuoted(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Concurrency-safe, idempotent template sync.
 *
 * `ensureInitializedDataDir` runs on the hot path of nearly every Shipyard CLI
 * invocation, so several processes (an active `ship-execute` run driving hooks
 * plus a concurrently invoked skill) routinely refresh `templates/` at the same
 * time. Node's `cpSync(..., { force: true })` copies each file as
 * stat → `unlinkSync(dest)` → copy; when a sibling process replaces a template
 * between the stat and the unlink, the unlink throws `ENOENT` and crashes the
 * whole command. This sync avoids that: it stats first and only writes files
 * that are missing or changed (steady state = zero writes, no race window), and
 * when it does write it uses `copyFileSync`, which overwrites the destination in
 * a single syscall with no separate `unlink` step.
 */
function syncTemplatesDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      syncTemplatesDir(srcPath, destPath);
      continue;
    }
    if (!entry.isFile()) continue;
    let needsCopy = true;
    try {
      const srcStat = statSync(srcPath);
      const destStat = statSync(destPath);
      needsCopy = destStat.size !== srcStat.size || destStat.mtimeMs < srcStat.mtimeMs;
    } catch {
      needsCopy = true;
    }
    if (!needsCopy) continue;
    try {
      copyFileSync(srcPath, destPath);
    } catch (err) {
      // A sibling process copying the same template can briefly race us; the
      // destination still ends up with the canonical content, so tolerate the
      // transient failure rather than crashing the caller.
      if (err && err.code !== "ENOENT" && err.code !== "EEXIST") throw err;
    }
  }
}

export function ensureInitializedDataDir(opts = {}) {
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const dataDir = opts.dataDir ?? getDataDir({ projectRoot, silent: true });

  for (const parts of SUBDIRS) {
    mkdirSync(join(dataDir, ...parts), { recursive: true });
  }

  writeFileSync(join(dataDir, ".project-root"), projectRoot + "\n");

  const templatesSrc = join(pluginRoot(), "project-files", "templates");
  if (existsSync(templatesSrc)) {
    syncTemplatesDir(templatesSrc, join(dataDir, "templates"));
  }

  // backlog/BACKLOG.md is CLI-owned (backlog add|remove|rank|set refuse to run
  // without it) yet nothing seeded it after /ship-init was removed: a fresh
  // project's first `backlog add` failed with "run onboarding bootstrap first"
  // right after bootstrap had run (found by the v3.27.0 CLI e2e). Seed it once
  // from the template; never overwrite an existing index.
  const backlogPath = join(dataDir, "backlog", "BACKLOG.md");
  const backlogTemplate = join(templatesSrc, "BACKLOG.md");
  if (!existsSync(backlogPath) && existsSync(backlogTemplate)) {
    try {
      copyFileSync(backlogTemplate, backlogPath);
    } catch (err) {
      if (err && err.code !== "EEXIST") throw err;
    }
  }

  for (const f of [".test-output.tmp"]) {
    rmSync(join(dataDir, f), { force: true });
  }
  rmSync(join(dataDir, "scripts"), { recursive: true, force: true });

  const resetLocks = opts.resetLocks === true;
  if (resetLocks || !existsSync(join(dataDir, ".active-session.json"))) {
    releaseLock(dataDir, "planning", { force: true, bestEffort: true });
  }
  if (resetLocks || !existsSync(join(dataDir, ".active-execution.json"))) {
    releaseLock(dataDir, "execution", { force: true, bestEffort: true });
  }
  if (resetLocks || !existsSync(join(dataDir, ".active-discuss.json"))) {
    releaseLock(dataDir, "discuss", { force: true, bestEffort: true });
  }

  return dataDir;
}

export function onboardingStatus(dataDir) {
  const configPath = join(dataDir, "config.md");
  if (!existsSync(configPath)) {
    return {
      required: true,
      reason: "missing_config",
      command: "shipyard-data onboarding bootstrap",
      message: "Shipyard storage is ready, but project configuration has not been created yet.",
    };
  }
  return {
    required: false,
    reason: "ready",
    command: "",
    message: "Shipyard onboarding is complete.",
  };
}

/** The running plugin's version, from its manifest; "" when unreadable. */
export function pluginVersion() {
  try { return String(JSON.parse(readFileSync(join(pluginRoot(), ".claude-plugin", "plugin.json"), "utf8")).version ?? ""); } catch { return ""; }
}

/**
 * Upgrade notice (4.6). The data dir remembers the plugin version that last
 * worked on it (`.shipyard-version`, CLI-owned). When a skill starts under a
 * different version it says so once, with where to read what changed, and
 * re-stamps. Without this an upgrade was silent: new gates simply started
 * refusing things the previous version allowed.
 */
export function renderUpgradeNotice(dataDir, out) {
  const now = pluginVersion();
  if (!now) return;
  const stamp = join(dataDir, ".shipyard-version");
  let was = "";
  try { was = readFileSync(stamp, "utf8").trim(); } catch { was = ""; }
  if (was === now) return;
  if (!existsSync(join(dataDir, "config.md"))) return; // not onboarded yet: nothing to upgrade
  if (was) {
    out(`SHIPYARD_UPGRADED=${was} -> ${now}`);
    out(`SHIPYARD_UPGRADE_NOTE: This project was last worked on with Shipyard ${was}. Tell the user in one line that Shipyard is now ${now} and that what changed is in UPGRADING.md of the plugin (${join(pluginRoot(), "..", "..", "UPGRADING.md")}); then run \`shipyard-data doctor\` and \`shipyard-data reconcile\` once and report anything they print before continuing.`);
    try { logEvent(dataDir, "plugin_upgraded", { from: was, to: now }); } catch { /* best-effort */ }
  }
  try { writeFileSync(stamp, now + "\n", "utf8"); } catch { /* read-only data dir: say it again next time */ }
}

export function renderOnboardingLines(dataDir, out) {
  renderUpgradeNotice(dataDir, out);
  const status = onboardingStatus(dataDir);
  out(`SHIPYARD_ONBOARDING_REQUIRED=${status.required ? "true" : "false"}`);
  out(`SHIPYARD_ONBOARDING_REASON=${status.reason}`);
  if (status.command) out(`SHIPYARD_ONBOARDING_COMMAND=${status.command}`);
  if (status.required) {
    out("SHIPYARD_ONBOARDING_MESSAGE:");
    out(status.message);
    out(
      "SHIPYARD_ONBOARDING_INSTRUCTION: Run the exact SHIPYARD_ONBOARDING_COMMAND once with Bash (it writes only " +
        "Shipyard's own config.md — do not ask first), say in one line what it set up, then re-run the shipyard-context " +
        "command this skill's preamble ran and CONTINUE the skill in this same turn — never tell the user to re-type the " +
        "command. Do not infer setup state by reading or writing Shipyard state files; onboarding decisions are CLI-owned.",
    );
  }
  return status;
}

export function bootstrapOnboarding(opts = {}) {
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const dataDir = ensureInitializedDataDir({ projectRoot, dataDir: opts.dataDir });
  const configPath = join(dataDir, "config.md");

  if (!existsSync(configPath)) {
    const templatePath = join(pluginRoot(), "project-files", "templates", "config.md");
    let config = readFileSync(templatePath, "utf8");
    config = config.replace(
      'project_name: ""',
      `project_name: "${escapeYamlDoubleQuoted(basename(projectRoot))}"`,
    );
    // Seed what the repo already says about itself. Bootstrap used to leave
    // test_commands empty even with a package.json `test` script, so the first
    // sprint stalled until someone typed the command into config.md.
    const detected = detectStack(projectRoot);
    if (detected.project_type) config = config.replace('project_type: ""', `project_type: "${detected.project_type}"`);
    if (detected.tech_stack.length) config = config.replace("tech_stack: []", `tech_stack: [${detected.tech_stack.map((t) => `"${t}"`).join(", ")}]`);
    if (detected.testing_framework) config = config.replace('testing_framework: ""', `testing_framework: "${detected.testing_framework}"`);
    if (detected.unit) config = config.replace(/^(\s*unit:\s*)""/m, `$1"${escapeYamlDoubleQuoted(detected.unit)}"`);
    if (detected.build) config = config.replace(/^(\s*full:\s*)""/m, `$1"${escapeYamlDoubleQuoted(detected.build)}"`);
    writeFileSync(configPath, config, "utf8");
  }

  return { dataDir, status: onboardingStatus(dataDir) };
}

/**
 * Best-effort stack detection from the project's own manifests. Returns only
 * what a manifest states (a `test` script, a known test runner, a build tool);
 * never guesses a command the repo does not declare.
 */
export function detectStack(projectRoot) {
  const out = { project_type: "", tech_stack: [], testing_framework: "", unit: "", build: "" };
  const has = (p) => existsSync(join(projectRoot, p));
  if (has("package.json")) {
    let pkg = {};
    try { pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")); } catch { pkg = {}; }
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    out.project_type = "node";
    out.tech_stack.push(pkg.type === "module" ? "node-esm" : "node");
    if (deps.typescript || has("tsconfig.json")) out.tech_stack.push("typescript");
    for (const fw of ["react", "next", "vue", "svelte", "express", "fastify", "nestjs"]) if (deps[fw] || deps[`@${fw}/core`]) out.tech_stack.push(fw);
    if (deps.vitest) out.testing_framework = "vitest";
    else if (deps.jest) out.testing_framework = "jest";
    else if (deps.mocha) out.testing_framework = "mocha";
    else if (/node --test/.test(String(scripts.test || ""))) out.testing_framework = "node:test";
    if (scripts.test && !/no test specified/.test(scripts.test)) out.unit = `${pm} test`;
    if (scripts.build) out.build = `${pm} run build`;
    return out;
  }
  if (has("pyproject.toml") || has("setup.py") || has("pytest.ini") || has("requirements.txt")) {
    out.project_type = "python"; out.tech_stack.push("python");
    const py = has("pyproject.toml") ? readFileSync(join(projectRoot, "pyproject.toml"), "utf8") : "";
    if (/pytest/.test(py) || has("pytest.ini") || has("tests") || has("test")) { out.testing_framework = "pytest"; out.unit = "python3 -m pytest -q"; }
    return out;
  }
  if (has("Makefile") || has("makefile") || has("GNUmakefile")) {
    // Keep-going so one run lists every failing target, not just the first.
    let mk = "";
    try { mk = readFileSync(join(projectRoot, has("Makefile") ? "Makefile" : has("makefile") ? "makefile" : "GNUmakefile"), "utf8"); } catch { mk = ""; }
    if (/^test\s*:/m.test(mk)) { out.project_type = "make"; out.tech_stack.push("make"); out.testing_framework = "make test"; out.unit = "make -k test"; if (/^(all|build)\s*:/m.test(mk)) out.build = "make"; return out; }
  }
  if (has("go.mod")) { out.project_type = "go"; out.tech_stack.push("go"); out.testing_framework = "go test"; out.unit = "go test ./..."; out.build = "go build ./..."; return out; }
  if (has("Cargo.toml")) { out.project_type = "rust"; out.tech_stack.push("rust"); out.testing_framework = "cargo test"; out.unit = "cargo test"; out.build = "cargo build"; return out; }
  if (has("gradlew") || has("build.gradle") || has("build.gradle.kts")) {
    out.project_type = has("app/src/main/AndroidManifest.xml") ? "android" : "jvm";
    out.tech_stack.push(has("build.gradle.kts") ? "gradle-kotlin" : "gradle");
    const w = has("gradlew") ? "./gradlew" : "gradle";
    out.testing_framework = "junit"; out.unit = `${w} test`; out.build = `${w} assemble`;
    return out;
  }
  if (has("pom.xml")) { out.project_type = "jvm"; out.tech_stack.push("maven"); out.testing_framework = "junit"; out.unit = "mvn -q test"; out.build = "mvn -q package -DskipTests"; return out; }
  if (has("Package.swift")) { out.project_type = "swift"; out.tech_stack.push("swift"); out.testing_framework = "xctest"; out.unit = "swift test"; out.build = "swift build"; return out; }
  return out;
}
