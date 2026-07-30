import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDataDir, getProjectRoot } from "./shipyard-resolver.mjs";
import { releaseLock } from "./skill-lock.mjs";

const SUBDIRS = [
  ["spec", "epics"],
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

export function ensureInitializedDataDir(opts = {}) {
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const dataDir = opts.dataDir ?? getDataDir({ projectRoot, silent: true });

  for (const parts of SUBDIRS) {
    mkdirSync(join(dataDir, ...parts), { recursive: true });
  }

  writeFileSync(join(dataDir, ".project-root"), projectRoot + "\n");

  const templatesSrc = join(pluginRoot(), "project-files", "templates");
  if (existsSync(templatesSrc)) {
    cpSync(templatesSrc, join(dataDir, "templates"), {
      recursive: true,
      force: true,
    });
  }

  for (const f of [".loop-state.json", ".test-output.tmp"]) {
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

export function renderOnboardingLines(dataDir, out) {
  const status = onboardingStatus(dataDir);
  out(`SHIPYARD_ONBOARDING_REQUIRED=${status.required ? "true" : "false"}`);
  out(`SHIPYARD_ONBOARDING_REASON=${status.reason}`);
  if (status.command) out(`SHIPYARD_ONBOARDING_COMMAND=${status.command}`);
  if (status.required) {
    out("SHIPYARD_ONBOARDING_MESSAGE:");
    out(status.message);
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
    writeFileSync(configPath, config, "utf8");
  }

  return { dataDir, status: onboardingStatus(dataDir) };
}
