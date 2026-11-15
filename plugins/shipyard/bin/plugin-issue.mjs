/**
 * `shipyard-data plugin-issue <add|list> ...` (v4.0)
 *
 * A problem that is Shipyard's, not the project's, found during a sprint
 * review. It is WRITTEN DOWN LOCALLY for the owner to report; nothing is ever
 * sent anywhere from here. The rule ("never file the issue yourself") was
 * prose, and two reviews in a row ended with "I'm sending them to the
 * maintainers". Giving the reviewer a local command with a fixed closing line
 * replaces the sentence it kept improvising.
 *
 *   add --title "<one line>" [--detail "<what happened, with evidence>"] [--sprint <id>]
 *       → appends to <dataDir>/plugin-issues.md and prints the line to show.
 *   list   the saved entries
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { pluginVersion } from "./init-data.mjs";

export const ISSUES_BASENAME = "plugin-issues.md";
export const ISSUES_URL = "https://github.com/acendas/shipyard/issues";

export function main(dataDir, args = []) {
  const sub = args[0];
  const flag = (n) => { const i = args.indexOf(n); return i === -1 ? "" : String(args[i + 1] ?? ""); };
  const path = join(dataDir, ISSUES_BASENAME);
  const cur = existsSync(path) ? readFileSync(path, "utf8") : "# Shipyard problems found in this project\n\nWritten down by the sprint review for you to report. Nothing here was sent anywhere.\nReport at " + ISSUES_URL + " and include the output of `shipyard-context diagnose`.\n";
  const count = (cur.match(/^## /gm) || []).length;
  if (sub === "list") { process.stdout.write(count ? cur : "no Shipyard problems are written down for this project\n"); return; }
  if (sub !== "add" || !flag("--title").trim()) {
    process.stderr.write("shipyard-data plugin-issue: usage: plugin-issue add --title \"<one line>\" [--detail \"...\"] [--sprint <id>] | plugin-issue list\n");
    process.exit(2);
  }
  let version = "";
  try { version = pluginVersion(); } catch { version = ""; }
  const entry = `\n## ${flag("--title").trim().slice(0, 160)}\n\n- Found: ${new Date().toISOString().slice(0, 10)}${flag("--sprint") ? `, ${flag("--sprint")}` : ""}${version ? `, Shipyard ${version}` : ""}\n${flag("--detail").trim() ? `- What happened: ${flag("--detail").trim().slice(0, 2000)}\n` : ""}`;
  atomicWrite(path, cur.replace(/\s*$/, "\n") + entry);
  try { logEvent(dataDir, "plugin_issue_noted", { title: flag("--title").trim().slice(0, 120) }); } catch { /* best-effort */ }
  process.stdout.write(`Written down for you in ${path} (${count + 1} so far). Nothing was sent. To report it yourself: ${ISSUES_URL}\n`);
}
