// `shipyard-data doctor` reads the Claude Code user settings (`advisorHint` in bin/doctor-config.mjs:
// `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`), and what it prints depends on them.
// A test that runs doctor passes this environment to the child process: CLAUDE_CONFIG_DIR points at a folder
// inside the test's own fixture that is never created, so no developer's settings reach the output.
// tests/eval-run.py runs the Node tests with settings that would change doctor's output, so a doctor run that
// skips this helper fails there.
import { join } from "node:path";

export const NO_CONFIG_DIR = ".no-claude-config";

export function withoutUserSettings(fixtureDir, env = process.env) {
  return { ...env, CLAUDE_CONFIG_DIR: join(fixtureDir, NO_CONFIG_DIR) };
}
