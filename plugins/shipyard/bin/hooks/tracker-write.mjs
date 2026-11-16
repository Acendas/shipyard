/**
 * PreToolUse hook (matcher: connector tools that write a comment, a ticket or a page):
 * what is sent to a ticket was shown in the chat first.
 *
 * Shipyard never writes to a tracker without the person's answer, "and they see
 * the exact text first". The second half was prose: in a live sprint planning
 * the session asked "send both comments exactly as drafted above?" and the
 * drafts were in its reasoning, not on the screen. So, while this session runs
 * a Shipyard command, a write whose text is not in the session's own messages
 * is sent back. With `tracker_sync: auto` the owner has said updates may go
 * without asking; the check does not apply.
 *
 * Only the text is compared (most of its lines must appear in the chat); the
 * tracker's ids, fields and transitions are not this hook's business.
 */
import { heldSkill } from "./agent-ledger.mjs";
import { transcriptTail, textOf, commandStart } from "./unattended-ask.mjs";
import { trackerSyncMode } from "../tracker.mjs";
import { logEvent } from "../_hook_lib.mjs";

const TEXT_KEYS = /^(body|comment|comment_body|description|text|content|markdown|message)$/i;
const squash = (s) => String(s ?? "").replace(/[`*_>#|]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/** The long texts a write carries, from its input (two levels deep). */
export function outgoingTexts(input) {
  const out = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 2) return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") { if (TEXT_KEYS.test(k) && v.trim().length >= 40) out.push(v); }
      else if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(input, 0);
  return out;
}

/** True when most of the text's lines are in what the session wrote. */
export function wasShown(text, chat) {
  const hay = squash(chat);
  const lines = String(text).split("\n").map(squash).filter((l) => l.length >= 12);
  if (!lines.length) return true;
  return lines.filter((l) => hay.includes(l)).length / lines.length >= 0.8;
}

export function decideWrite(dataDir, hookInput) {
  if (!dataDir || !hookInput) return null;
  const session = String(hookInput.session_id ?? "").trim();
  if (!session || !heldSkill(dataDir, session)) return null; // not inside a Shipyard command
  if (trackerSyncMode(dataDir) === "auto") return null;
  const texts = outgoingTexts(hookInput.tool_input);
  if (!texts.length) return null; // a status move, a link, a field: nothing to read first
  const entries = transcriptTail(hookInput);
  if (!entries) return null;
  const cmd = commandStart(entries, hookInput);
  const chat = entries.slice(cmd ? cmd.start + 1 : 0).filter((e) => e?.type === "assistant").map(textOf).join("\n");
  const hidden = texts.find((t) => !wasShown(t, chat));
  if (!hidden) return null;
  return { reason: `Shipyard: text sent to a ticket or a page is shown in the chat first, word for word, and sent after the person's go. This one was not on the screen (it begins: "${hidden.replace(/\s+/g, " ").trim().slice(0, 90)}…"). Write the exact text as your message, inside a code block, ask whether to send it, then send it unchanged.` };
}

export function run(hookInput, env) {
  const dataDir = (env && env.SHIPYARD_DATA) || process.env.SHIPYARD_DATA;
  let v = null;
  try { v = decideWrite(dataDir, hookInput); } catch { v = null; }
  if (!v) return 0;
  try { logEvent(dataDir, "tracker_write_not_shown_denied", { tool: String(hookInput.tool_name ?? "").split("__").pop().slice(0, 60) }); } catch { /* best-effort */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: v.reason } }));
  return 0;
}
