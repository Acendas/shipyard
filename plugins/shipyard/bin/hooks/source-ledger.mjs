/**
 * PostToolUse hook (matcher: `mcp__.*|WebSearch|WebFetch`): which sources a
 * discussion really read.
 *
 * The owner's rule: discuss research looks at the organisation's own sources
 * (the wiki, the tracker, the shared drive the person has connected) as well
 * as outside ones. A live refinement recorded "looked at: memory: pricing
 * sheets (Drive)…" having called no drive, wiki or tracker tool at all.
 * What was looked at is a fact, so it is measured: while a discussion is open
 * (the discuss lock is held), each connector or web call logs one `source_read` event
 * (the tool's name and its class, never its input or its result), and
 * `discuss-questions sources` reads the counts.
 *
 * Hot path: one lock-file read and one appended line; anything else returns at once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logEvent } from "../_hook_lib.mjs";

/** The kind of source a tool reads, from its name alone (no plugin or server is assumed). */
export function sourceClass(toolName) {
  const n = String(toolName ?? "").toLowerCase();
  if (n === "websearch" || n === "webfetch" || /context7|web_search|web_fetch|browser/.test(n)) return "web";
  const tool = n.replace(/^mcp__/, "");
  if (/confluence|notion|wiki|page|knowledge/.test(tool)) return "wiki";
  if (/jira|linear|issue|ticket|sprint|backlog|qmetry/.test(tool)) return "tracker";
  if (/drive|sharepoint|onedrive|dropbox|file_content|docs?_|sheet|slides/.test(tool)) return "drive";
  if (/slack|teams|gmail|mail|message|telegram|chat/.test(tool)) return "chat";
  if (/pull_request|repositor|commit|pipeline|branch|bitbucket|github|gitlab/.test(tool)) return "code_host";
  return "other";
}

/**
 * Which kinds of source this session has tools for, logged once per session while it holds the discuss lock
 * (`sources_available`). A session's transcript lists its connector tools when they are announced; the names
 * are read from there. Why: in live runs a session recorded "shared drive: not connected" while it had 39
 * drive tools, and "not relevant" for the wiki without looking. With this on record, `discuss-questions
 * sources` knows what is connected and takes only a real search for it.
 */
export function noteAvailable(dataDir, hookInput) {
  const session = String(hookInput?.session_id ?? "").trim();
  const path = typeof hookInput?.transcript_path === "string" ? hookInput.transcript_path : "";
  if (!dataDir || !session || !path) return null;
  let lock = null;
  try { lock = JSON.parse(readFileSync(join(dataDir, ".active-discuss.json"), "utf8")); } catch { return null; }
  if (!lock || !lock.skill || lock.cleared || String(lock.session_id ?? "") !== session) return null;
  try { if (readFileSync(join(dataDir, ".shipyard-events.jsonl"), "utf8").includes(`"sources_available","session":"${session}"`)) return null; } catch { /* no log yet */ }
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const found = { wiki: "", tracker: "", drive: "" };
  for (const m of text.matchAll(/mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_]+/g)) {
    const cls = sourceClass(m[0]);
    // a tool that reads: a search, a get, a list (a write tool alone does not make a source searchable)
    if (cls in found && !found[cls] && /search|get_|list_|query|read|fetch/.test(m[0].toLowerCase())) found[cls] = m[0].split("__").pop();
    if (found.wiki && found.tracker && found.drive) break;
  }
  try { logEvent(dataDir, "sources_available", { session, wiki: found.wiki, tracker: found.tracker, drive: found.drive }); } catch { /* best-effort */ }
  return found;
}

export function run(hookInput, env) {
  const dataDir = (env && env.SHIPYARD_DATA) || process.env.SHIPYARD_DATA;
  const session = String(hookInput?.session_id ?? "").trim();
  const tool = String(hookInput?.tool_name ?? "");
  if (!dataDir || !session || !tool) return 0;
  let lock = null;
  try { lock = JSON.parse(readFileSync(join(dataDir, ".active-discuss.json"), "utf8")); } catch { return 0; }
  // Any session while a discussion is open: a deep-dive or a critic may run under a session id of its own,
  // and its searches are the discussion's. (Another command reading a connector at the same moment is counted
  // too; that errs towards believing a search happened, never towards a false refusal.)
  if (!lock || !lock.skill || lock.cleared) return 0;
  const cls = sourceClass(tool);
  if (cls === "other") return 0;
  try { logEvent(dataDir, "source_read", { source: cls, tool: tool.replace(/^mcp__/, "").split("__").pop().slice(0, 60), session }); } catch { /* best-effort */ }
  return 0;
}
