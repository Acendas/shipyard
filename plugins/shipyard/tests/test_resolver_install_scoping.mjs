/**
 * Install-scoping tests for bin/shipyard-resolver.mjs.
 *
 * Run: node --test tests/test_resolver_install_scoping.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  breadcrumbCandidates,
  configTagForPluginsDir,
  deriveDataRootFromResolverPath,
  deriveInstallInfoFromResolverPath,
  getProjectHash,
} from "../bin/shipyard-resolver.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RESOLVER = join(PLUGIN_ROOT, "bin", "shipyard-resolver.mjs");

function withTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), "sy-resolver-install-"));
  let cleanupNow = true;
  try {
    const result = fn(root);
    if (result && typeof result.then === "function") {
      cleanupNow = false;
      return result.finally(() => rmSync(root, { recursive: true, force: true }));
    }
    return result;
  } finally {
    if (cleanupNow) rmSync(root, { recursive: true, force: true });
  }
}

function setupRepo(root) {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "hello\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    { cwd: repo },
  );
  return repo;
}

function fakeInstall(root, configName, marketplace = "acendas", plugin = "shipyard") {
  const configRoot = join(root, configName);
  const resolverPath = join(
    configRoot,
    "plugins",
    "cache",
    marketplace,
    plugin,
    "1.2.3",
    "bin",
    "shipyard-resolver.mjs",
  );
  mkdirSync(dirname(resolverPath), { recursive: true });
  copyFileSync(RESOLVER, resolverPath);
  const dataRoot = join(configRoot, "plugins", "data", `${plugin}-${marketplace}`);
  mkdirSync(dataRoot, { recursive: true });
  return {
    configRoot,
    configPluginsDir: join(configRoot, "plugins"),
    resolverPath,
    dataRoot,
  };
}

async function importResolver(resolverPath, suffix = "") {
  return import(`${pathToFileURL(resolverPath).href}?${suffix || Date.now()}`);
}

test("deriveDataRootFromResolverPath derives data root from a real cache-shaped path", () => {
  withTemp((root) => {
    const install = fakeInstall(root, ".claude-work");
    assert.equal(
      deriveDataRootFromResolverPath(install.resolverPath),
      install.dataRoot,
    );
  });
});

test("deriveInstallInfoFromResolverPath handles hyphens in marketplace and plugin segments", () => {
  withTemp((root) => {
    const install = fakeInstall(root, ".claude-work", "my-market", "shipyard-pro");
    const info = deriveInstallInfoFromResolverPath(install.resolverPath);
    assert.equal(info.marketplace, "my-market");
    assert.equal(info.plugin, "shipyard-pro");
    assert.equal(
      deriveDataRootFromResolverPath(install.resolverPath),
      install.dataRoot,
    );
  });
});

test("deriveDataRootFromResolverPath returns null for dev paths and missing data roots", () => {
  withTemp((root) => {
    assert.equal(deriveDataRootFromResolverPath(join(root, "shipyard", "bin", "shipyard-resolver.mjs")), null);
    const install = fakeInstall(root, ".claude-work");
    rmSync(install.dataRoot, { recursive: true, force: true });
    assert.equal(deriveDataRootFromResolverPath(install.resolverPath), null);
  });
});

test("deriveDataRootFromResolverPath parses Windows-style cache paths", () => {
  const resolverPath = "C:\\Users\\me\\.claude-work\\plugins\\cache\\my-market\\shipyard-pro\\1.0.0\\bin\\shipyard-resolver.mjs";
  assert.equal(
    deriveDataRootFromResolverPath(resolverPath, { requireExists: false }),
    "C:\\Users\\me\\.claude-work\\plugins\\data\\shipyard-pro-my-market",
  );
});

test("env-absent cache resolver resolves to its own install, not a foreign breadcrumb", async () => {
  await withTemp(async (root) => {
    const repo = setupRepo(root);
    const personal = fakeInstall(root, ".claude");
    const work = fakeInstall(root, ".claude-work");
    const hash = getProjectHash(realpathSync(repo));

    const personalTag = configTagForPluginsDir(personal.configPluginsDir);
    for (const p of breadcrumbCandidates(hash, { configTag: personalTag })) {
      writeFileSync(p, personal.dataRoot, { encoding: "utf8", mode: 0o600 });
    }
    for (const p of breadcrumbCandidates(hash, { legacy: true })) {
      writeFileSync(p, personal.dataRoot, { encoding: "utf8", mode: 0o600 });
    }

    const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    const prevPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PROJECT_DIR = repo;
    delete process.env.CLAUDE_PLUGIN_DATA;
    try {
      const resolver = await importResolver(work.resolverPath, "work");
      assert.equal(resolver.getDataDir(), join(realpathSync(work.dataRoot), "projects", hash));
    } finally {
      if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
      if (prevPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
      for (const p of breadcrumbCandidates(hash, { configTag: personalTag })) rmSync(p, { force: true });
      for (const p of breadcrumbCandidates(hash, { legacy: true })) rmSync(p, { force: true });
    }
  });
});
