/**
 * Regression coverage for dynamic imports from plugin paths containing
 * URL-reserved characters. Bare `import("/tmp/a#b/bin/x.mjs")` treats `#b` as
 * a URL fragment; callers must use pathToFileURL().
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function withCopiedPlugin(fn) {
  const root = mkdtempSync(join(tmpdir(), "shipyard-url-path-"));
  const copied = join(root, "a#b shipyard");
  try {
    mkdirSync(copied, { recursive: true });
    mkdirSync(join(copied, ".claude-plugin"), { recursive: true });
    writeFileSync(join(copied, ".claude-plugin", "plugin.json"), "{}\n");
    cpSync(join(PLUGIN_ROOT, "bin"), join(copied, "bin"), { recursive: true });
    return await fn(copied, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("dynamic imports work from plugin paths containing # and spaces", async () => {
  await withCopiedPlugin(async (pluginRoot, tempRoot) => {
    const hookLib = await import(pathToFileURL(join(pluginRoot, "bin", "_hook_lib.mjs")).href);
    const progress = await import(pathToFileURL(join(pluginRoot, "bin", "progress-render.mjs")).href);

    assert.equal(typeof hookLib.resolveShipyardData, "function");
    assert.equal(typeof progress.renderProgress, "function");

    const env = { ...process.env };
    delete env.SHIPYARD_DATA;
    env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    const resolved = await hookLib.resolveShipyardData();
    assert.equal(typeof resolved, "string");

    const dataDir = join(tempRoot, "data");
    mkdirSync(dataDir, { recursive: true });
    execFileSync(
      "node",
      [join(pluginRoot, "bin", "hook-runner.mjs"), "plugin-data-breadcrumb"],
      {
        cwd: PLUGIN_ROOT,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: dataDir, SHIPYARD_DATA: dataDir },
        input: "{}\n",
      },
    );
  });
});
