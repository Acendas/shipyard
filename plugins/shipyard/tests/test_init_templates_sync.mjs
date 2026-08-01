/**
 * Regression tests for the template sync inside `ensureInitializedDataDir`.
 *
 * Why this exists: `ensureInitializedDataDir` runs on the hot path of nearly
 * every Shipyard CLI invocation. During an active `ship-execute` run (which
 * drives hooks that shell out to `shipyard-context`/`shipyard-data`) a
 * concurrently invoked skill like `/ship-discuss` triggers a second init
 * against the SAME project data dir. The old implementation copied `templates/`
 * with `cpSync(..., { force: true })`, which per file does
 * stat → `unlinkSync(dest)` → copy; when a sibling process replaced a template
 * between the stat and the unlink, `unlinkSync` threw `ENOENT` and crashed the
 * whole command (observed as a `/shipyard:ship-discuss` failure). The sync must
 * instead be idempotent and safe under concurrent writers.
 *
 * Run: node --test tests/test_init_templates_sync.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INIT_DATA = join(PLUGIN_ROOT, "bin", "init-data.mjs");
const TEMPLATES_SRC = join(PLUGIN_ROOT, "project-files", "templates");

/**
 * Run `ensureInitializedDataDir` in a fresh child process against an explicit
 * projectRoot + dataDir (bypassing git-based resolution). Returns a promise
 * that rejects if the process exits non-zero — i.e. if the copy crashed.
 */
function runInit(projectRoot, dataDir) {
  const script =
    `import { ensureInitializedDataDir } from ${JSON.stringify(INIT_DATA)};` +
    `ensureInitializedDataDir({ projectRoot: ${JSON.stringify(projectRoot)}, dataDir: ${JSON.stringify(dataDir)} });`;
  return execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "init-templates-sync-"));
  const projectRoot = join(root, "project");
  const dataDir = join(root, "data");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return { projectRoot, dataDir };
}

test("copies every canonical template into the data dir", async () => {
  const { projectRoot, dataDir } = makeFixture();
  await runInit(projectRoot, dataDir);

  const expected = readdirSync(TEMPLATES_SRC);
  assert.ok(expected.length > 0, "fixture sanity: source templates exist");
  for (const name of expected) {
    const dest = join(dataDir, "templates", name);
    assert.ok(existsSync(dest), `template ${name} was copied`);
    assert.equal(
      readFileSync(dest, "utf8"),
      readFileSync(join(TEMPLATES_SRC, name), "utf8"),
      `template ${name} content matches source`,
    );
  }
});

test("concurrent inits against one data dir never crash (cpSync ENOENT race)", async () => {
  const { projectRoot, dataDir } = makeFixture();

  // Many processes racing on the same templates/ dir reproduces the
  // stat-then-unlink window that used to throw ENOENT. All must exit cleanly.
  const runs = Array.from({ length: 12 }, () => runInit(projectRoot, dataDir));
  const results = await Promise.allSettled(runs);

  const failures = results.filter((r) => r.status === "rejected");
  assert.equal(
    failures.length,
    0,
    `all concurrent inits should succeed; failures:\n${failures
      .map((f) => String(f.reason?.stderr || f.reason))
      .join("\n---\n")}`,
  );

  // The templates dir is still complete and correct after the storm.
  const configDest = join(dataDir, "templates", "config.md");
  assert.ok(existsSync(configDest), "templates/config.md survives concurrent inits");
  assert.equal(
    readFileSync(configDest, "utf8"),
    readFileSync(join(TEMPLATES_SRC, "config.md"), "utf8"),
    "templates/config.md content is intact after concurrent inits",
  );
});
