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
 *
 * After 4.0.1, from the owner's own discussion: three ticket descriptions were
 * sent back in red, each with a paragraph of instructions for the session, and
 * the session then pasted eleven descriptions into the chat (2,800 words)
 * before asking once. Two changes. The line the person reads is short and
 * calm; what the session must do travels as `additionalContext` (delivered
 * with a deny and not shown: probed, CLI 2.1.325). And a long text need not be
 * pasted: it may be a file in the outbox (`tracker outbox`), let through when
 * its row was in the chat and the person has answered since.
 */
import { heldSkill } from "./agent-ledger.mjs";
import { transcriptTail, textOf, commandStart, lastPersonTurn } from "./unattended-ask.mjs";
import { trackerSyncMode, outboxFiles, outboxListedAt } from "../tracker.mjs";
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

const linesOf = (text) => String(text).split("\n").map(squash).filter((l) => l.length >= 12);
/**
 * The outbox file this text is, and whether the person was shown its row and has answered since.
 * { file, shown } or null when the text is no outbox file.
 */
export function fromOutbox(dataDir, text, entries, start) {
  const lines = linesOf(text);
  if (!lines.length) return null;
  let files = [];
  try { files = outboxFiles(dataDir); } catch { return null; }
  const f = files.find((o) => { const hay = squash(o.text); return lines.filter((l) => hay.includes(l)).length / lines.length >= 0.8; });
  if (!f) return null;
  let at = -1;
  for (let i = entries.length - 1; i > start; i--) { if (entries[i]?.type === "assistant" && textOf(entries[i]).includes(f.file)) { at = i; break; } }
  if (at !== -1 && lastPersonTurn(entries, at) > at) return { file: f.file, shown: true };
  // The table in the chat need not be the CLI's own, word for word (after 4.0.2: the session dropped the "Whole
  // text" column, and the person's "send all now" was followed by five red lines). What must be true: the CLI
  // listed this very text, the session then named the record in a message, and the person answered after that.
  const listed = Date.parse(outboxListedAt(dataDir, f));
  if (!Number.isFinite(listed) || !f.id) return { file: f.file, shown: false };
  const names = new RegExp(`(^|[^A-Za-z0-9])${f.id}([^A-Za-z0-9]|$)`);
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e?.type !== "assistant" || !(Date.parse(e.timestamp ?? "") >= listed - 1000)) continue;
    if (names.test(textOf(e)) && lastPersonTurn(entries, i) > i) return { file: f.file, shown: true };
  }
  return { file: f.file, shown: false };
}

export const HELD_WRITE = "Shipyard: not sent yet. You see what goes to the ticket first, and it is sent on your go.";
const OUTBOX_HOW = "For a description, or for more than one ticket, do not paste the texts: write each one, exactly as it will be sent, to <SHIPYARD_DATA>/tracker/outbox/<record id>.md (a comment: <record id>-comment.md), run `shipyard-data tracker outbox`, write its table in the chat under a summary of 40 words or fewer, end that message with the line \"Question follows.\" and end your turn; then ask one card (send all now / show me one in full first / not now). After their go, send each file's text word for word.";

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
  const start = cmd ? cmd.start : -1;
  const chat = entries.slice(start + 1).filter((e) => e?.type === "assistant").map(textOf).join("\n");
  let waiting = null, hidden = null;
  for (const t of texts) {
    if (wasShown(t, chat)) continue;
    const box = fromOutbox(dataDir, t, entries, start);
    if (box?.shown) continue;
    if (box) waiting = waiting ?? box; else hidden = hidden ?? t;
  }
  if (!waiting && !hidden) return null;
  const context = hidden
    ? `Shipyard held this write: its text is not on the person's screen (it begins: "${hidden.replace(/\s+/g, " ").trim().slice(0, 90)}…"). A short text (a comment, a few lines): write it in the chat word for word inside a code block, ask whether to send it, then send it unchanged. ${OUTBOX_HOW}`
    : `Shipyard held this write: its text is ready in ${waiting.file}, but the person has not seen the outbox table and answered since (or the file changed after it was listed). Run \`shipyard-data tracker outbox\`, write its table in the chat under a summary of 40 words or fewer, end that message with the line "Question follows." and end your turn; then ask one card (send all now / show me one in full first / not now). Send after their go.`;
  return { reason: HELD_WRITE, context };
}

export function run(hookInput, env) {
  const dataDir = (env && env.SHIPYARD_DATA) || process.env.SHIPYARD_DATA;
  let v = null;
  try { v = decideWrite(dataDir, hookInput); } catch { v = null; }
  if (!v) return 0;
  try { logEvent(dataDir, "tracker_write_not_shown_denied", { tool: String(hookInput.tool_name ?? "").split("__").pop().slice(0, 60) }); } catch { /* best-effort */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: v.reason, additionalContext: v.context } }));
  return 0;
}
