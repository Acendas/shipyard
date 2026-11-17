/**
 * PreToolUse hook for AskUserQuestion: /ship-execute is unattended (v4.7.1).
 *
 * The owner's rule: execute runs to completion without interruptions; a
 * question in the middle of it is a gap discuss or sprint planning left. The
 * rule lived in skill prose and was skipped (an orchestrator asked about a
 * layout check the approved plan had already resolved), so it is enforced
 * here: while THIS session's execute cursor is in progress past the readiness
 * step, a question is denied and the reason names the decision ladder.
 *
 * Allowed, always:
 *   - another session (a /ship-discuss running beside the sprint);
 *   - before the builders start (preflight, salvage, load, readiness — the one
 *     place a start-of-sprint ask is legitimate);
 *   - task and hotfix modes (the user is at the keyboard for a land-now);
 *   - a paused or escalated cursor (pausing is the honest way to stop and ask:
 *     it is logged, it stops /goal, and the review counts it);
 *   - execution.unattended: false.
 *
 * Fail open: any error, missing cursor or unreadable config allows the ask.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, readEvents } from "../terminal-gate.mjs";
import { readUnattended } from "../config-read.mjs";
import { logEvent } from "../_hook_lib.mjs";
import { noteAvailable } from "./source-ledger.mjs";
import { heldSkill } from "./agent-ledger.mjs";
import { CARD_LIMITS, currentCard, recordUnlisted } from "../discuss-questions.mjs";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * What the person saw before a question (4.0.1).
 *
 * The owner's rule for every question in a Shipyard command: a summary that
 * reads in 15 seconds, then a picture, a table or a real example, written in
 * the chat; then the card. It was in every skill and in the start-up rules,
 * and it was still skipped: after the first long message a session asked card
 * after card with no text of its own, and the screen showed only the client's
 * one-line summary of its thinking. `/ship-backlog` mostly showed no board.
 *
 * A hook can check it, because its input names the transcript. Probed live
 * (CLI 2.1.325): text written in the SAME assistant message as the card is
 * not in the transcript yet when this hook runs, and a hook's own
 * `systemMessage` is not shown before the card. So the text must be in an
 * earlier message. The route is the end of a turn: the explanation is the
 * session's last message, ending with `Question follows.`; the Stop hook
 * (`ask-after-explain`) hands the turn back and the card is the next
 * message. Anything unreadable passes.
 */
const BOARD_HEADER = "BOARD ·", BOARD_FOOTER = "end of board";
export const SHIPYARD_COMMAND = /(^|:)ship-[a-z-]+$/;
/** The last line of an explanation that a question card follows. */
export const QUESTION_FOLLOWS = "Question follows.";
const MARKER_LINE = /^[\s>*_`-]*question follows\.?[\s*_`]*$/i;
export const endsWithMarker = (text) => { const lines = String(text ?? "").trim().split("\n"); return MARKER_LINE.test(lines[lines.length - 1] ?? ""); };
export const EXPLAIN_LIMITS = Object.freeze({ summary_words: 50, min_chars: 60 });

export function transcriptTail(hookInput) {
  const path = typeof hookInput?.transcript_path === "string" ? hookInput.transcript_path : "";
  if (!path) return null;
  let tail = "";
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size, want = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(want);
      readSync(fd, buf, 0, want, size - want);
      tail = buf.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return null; }
  const entries = [];
  for (const line of tail.split("\n")) { if (line.startsWith("{")) { try { entries.push(JSON.parse(line)); } catch { /* a cut first line */ } } }
  return entries;
}
export const blocksOf = (e) => (Array.isArray(e?.message?.content) ? e.message.content.filter((b) => b && typeof b === "object") : []);
export const textOf = (e) => {
  const c = e?.message?.content;
  if (typeof c === "string") return c;
  return blocksOf(e).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
};

/** Where the running command started: { start, name } or null. */
const COMMAND_NAME = /<command-name>\/?([^<]+)<\/command-name>/;
const commandOf = (e) => (e?.type === "user" ? (textOf(e).match(COMMAND_NAME) ?? [])[1]?.trim() ?? null : null);
/**
 * The command this session is running: the last slash command the person
 * typed. `entries` is only the end of the transcript (`transcriptTail` reads
 * the last 1.5 MB), and a real discussion's transcript was 3.9 MB with the
 * `/ship-discuss` line far above that window: without the fallback every
 * rule that needs the command went quiet partway through a long session, and
 * a turn ended on "Question follows." would have simply ended. So when the
 * tail does not hold the command line, the whole file is searched for it
 * from the end (`start: -1`: everything in the tail is after it).
 */
export function commandStart(entries, hookInput) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const name = commandOf(entries[i]);
    if (name) return { start: i, name };
  }
  const path = typeof hookInput?.transcript_path === "string" ? hookInput.transcript_path : "";
  if (!path) return null;
  let all = "";
  try { if (fstatSizeOf(path) <= TAIL_BYTES) return null; all = readFileSync(path, "utf8"); } catch { return null; }
  for (let at = all.lastIndexOf("<command-name>"); at !== -1; ) {
    const from = all.lastIndexOf("\n", at) + 1;
    const to = all.indexOf("\n", at);
    let name = null;
    try { name = commandOf(JSON.parse(all.slice(from, to === -1 ? all.length : to))); } catch { name = null; }
    if (name) return { start: -1, name };
    if (from === 0) break;
    at = all.lastIndexOf("<command-name>", from - 1); // a tool result or a quote that only mentions the tag: keep looking above it
  }
  return null;
}
const TAIL_BYTES = 1500000;
const fstatSizeOf = (path) => { const fd = openSync(path, "r"); try { return fstatSync(fd).size; } finally { closeSync(fd); } };

/** Index of the last entry where the person spoke or answered a card (a refused card and a hook's hand-back are neither), or `from`. */
export function lastPersonTurn(entries, from) {
  const cardIds = new Set();
  for (const e of entries) for (const b of blocksOf(e)) if (b.type === "tool_use" && b.name === "AskUserQuestion") cardIds.add(b.id);
  let boundary = from;
  for (let i = from + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e?.type !== "user") continue;
    const results = blocksOf(e).filter((b) => b.type === "tool_result");
    if (results.length) {
      const answered = results.some((b) => cardIds.has(b.tool_use_id) && b.is_error !== true && !/hook error|permission.*denied/i.test(JSON.stringify(b.content ?? "")));
      if (answered) boundary = i;
    } else if (e.isMeta !== true && textOf(e).trim() && !/^(<(system-reminder|task-notification|command-)|Stop hook feedback:)/.test(textOf(e).trim())) boundary = i; // the person typed something (a hook's hand-back is not the person)
  }
  return boundary;
}

/** The assistant's own text since the person last spoke or last answered a card (a refused card does not count as an answer). */
function textSinceLastTurn(entries, from) {
  const boundary = lastPersonTurn(entries, from);
  const after = entries.slice(boundary + 1).filter((e) => e?.type === "assistant");
  const texts = after.map(textOf).filter((t) => t && t.trim());
  const text = texts.join("\n\n");
  const last = texts.length ? texts[texts.length - 1] : "";
  // Reasoning is not a message: the client shows it as one grey summary line.
  const thought = after.some((e) => blocksOf(e).some((b) => b.type === "thinking" && String(b.thinking ?? "").trim().length > 40));
  return { text, thought, last, boundary };
}

/**
 * The last question card called since `boundary` (the person has not answered since, so it was sent back), with the
 * text written in the SAME message as that call. When the call was judged that text was not in the file yet; it is now.
 * "Same message" is the API message id; without ids, only text directly above the call with no tool call between.
 */
export function cardAbove(entries, boundary) {
  for (let i = entries.length - 1; i > boundary; i--) {
    const e = entries[i];
    const call = e?.type === "assistant" ? blocksOf(e).find((b) => b.type === "tool_use" && b.name === "AskUserQuestion") : null;
    if (!call) continue;
    const id = e.message?.id ?? null;
    const texts = [];
    for (let k = i; k > boundary; k--) {
      const p = entries[k];
      if (p?.type === "user") break;
      if (p?.type !== "assistant") continue; // bookkeeping lines between the blocks of one message
      if (id ? p.message?.id !== id : k !== i && blocksOf(p).some((b) => b.type === "tool_use")) break;
      const t = blocksOf(p).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
      if (t.trim()) texts.unshift(t);
    }
    return { question: String(call.input?.questions?.[0]?.question ?? ""), text: texts.join("\n\n") };
  }
  return null;
}
/** How many times a card was called since `boundary` (each one was sent back: the person has not answered since). */
const holdsSince = (entries, boundary) => entries.slice(boundary + 1).filter((e) => e?.type === "assistant" && blocksOf(e).some((b) => b.type === "tool_use" && b.name === "AskUserQuestion")).length;

/** What is wrong with the text written before a question, in the order the person would notice it. [] = fine. */
export function explainProblems(text) {
  const t = String(text ?? "").split("\n").filter((l) => !MARKER_LINE.test(l)).join("\n").trim();
  if (t.length < EXPLAIN_LIMITS.min_chars) return ["nothing (or almost nothing) was written in the chat before this question"];
  const out = [];
  // Acceptance criteria are explained one plain line each, never pasted as scenarios (the owner's rule):
  // a dozen Given/When/Then blocks above a card is a wall nobody reads.
  if ((t.match(/^\s*(?:[-*]\s*)?(?:Given|When|Then)\b/gm) || []).length >= 6) out.push("acceptance criteria are pasted as Given/When/Then text: give one plain line per criterion instead (its id and what a person would see; `shipyard-data story acs <id>` lists them), and name the story file for the full text");
  const hasTable = /^\s*\|.+\|\s*$/m.test(t) && /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/m.test(t);
  const hasBlock = /```[\s\S]*?```/.test(t);
  if (!hasTable && !hasBlock) out.push("there is no picture: add a table (options and what each means), or a small diagram or a real example in a code block");
  // the first paragraph of plain words: the 15-second summary
  const prose = t.replace(/```[\s\S]*?```/g, "\n\n").split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^\s*(\||#|[-*] |\d+\. |>)/.test(p));
  const words = prose.length ? prose[0].split(/\s+/).filter(Boolean).length : 0;
  if (!prose.length) out.push("there is no summary in plain words: start with what this is about and what you recommend, in 40 words or fewer");
  else if (words > EXPLAIN_LIMITS.summary_words) out.push(`the first paragraph is ${words} words: the summary must read in 15 seconds (40 words or fewer); move the rest under the picture`);
  return out;
}

/** What a session is told to do; the same words in the board's and the question list's NEXT line. */
export const HOW = `Do this, in this order: 1. Write the explanation as your message: first a summary of 40 words or fewer (what this is about, what you recommend), then show it: a table of the options and what each means, or a small diagram or a real example in a code block. 2. End that message with the line "${QUESTION_FOLLOWS}" and end your turn there (call no tool after it). Shipyard gives the turn straight back to you. 3. Then call AskUserQuestion with this one question.`;

/**
 * A held card is a red "Error: PreToolUse:AskUserQuestion hook error: …" line on the person's screen, and nothing
 * hides it (probed on CLI 2.1.325: `suppressOutput` does not). The owner met it twice on the first question of a
 * discussion, as six lines of instructions meant for the session. So the first time a card is held the reason is
 * one line a person can read, and what the session must do travels as `additionalContext`, which is delivered
 * with a deny and is not shown (same probe).
 */
export const HELD = "Shipyard: one moment. This question comes back as soon as its explanation is on screen.";
export const HELD_AGAIN = "Shipyard: one moment more. The explanation of this question is not on screen yet.";
// Run live: told "(a) if you wrote it as text in the same message, ask again at once", a session whose explanation
// was in its reasoning took (a), and was sent back a second time. A session cannot tell its reasoning from its
// messages. So the default is to write the explanation; the shortcut is one line, "Question follows.", that ends
// the turn, and the Stop hook (which can see by then what was written) either hands the card back or says, as
// quiet feedback and not as a red error, that the explanation was never on screen.
export const HELD_HOW =
  "Shipyard held this card: no explanation of it is in an earlier message. " +
  `Write its explanation as your message now: a summary of 40 words or fewer (what this is about, what you recommend), then a table, a diagram or an example. End the message with the line "${QUESTION_FOLLOWS}" and end your turn there (call no tool after it); Shipyard hands the turn back and you ask the card. ` +
  `Only if that explanation is already on screen as text of the very message that called the card: write just the line "${QUESTION_FOLLOWS}" and end your turn. ` +
  `For every later question: end your turn after "${QUESTION_FOLLOWS}", so that no card is held. Never ask in plain text instead.`;

/** { problems, reason, context? } when the card is sent back; { pass: "same_message" } when a held card comes again and its explanation was above it all along; null when there is nothing to say. */
export function explainedVerdict(hookInput) {
  if (!hookInput || hookInput.tool_name !== "AskUserQuestion") return null;
  const entries = transcriptTail(hookInput);
  if (!entries) return null;
  const cmd = commandStart(entries, hookInput);
  if (!cmd || !SHIPYARD_COMMAND.test(cmd.name)) return null;
  const { text, thought, last, boundary } = textSinceLastTurn(entries, cmd.start);
  // The explanation of THIS question is the message right before the card, the one that ends the turn with
  // "Question follows.". Text from earlier in the same stretch does not count: seen live, a card passed on the
  // strength of a plan table written minutes before, while its own explanation was a grey line of reasoning.
  const marked = endsWithMarker(last);
  const problems = marked ? explainProblems(last) : text.trim() ? [`the message right before this question does not explain it (it must be this question's own summary and picture, ending with the line "${QUESTION_FOLLOWS}")`] : explainProblems(text);
  if (!problems.length) return null;
  // Seen live on the first question of two discussions: the session wrote a good explanation, the line
  // "Question follows." and the card in ONE message. The person had all of it on screen in the right order; this
  // hook could not see the text (it is written to the file after the hook answers), held the card, and the session
  // wrote the whole explanation a second time. Now the held card may simply come again: by then the text is in the
  // file, and if it explains this same question the card passes.
  const above = cardAbove(entries, boundary);
  const question = String(hookInput.tool_input?.questions?.[0]?.question ?? "");
  if (above && above.text.trim() && sameText(above.question, question) && !explainProblems(above.text).length) return { pass: "same_message" };
  // Seen live: the session reasoned about the question, was refused, and
  // reported "the list was in the chat both times". It was in its
  // reasoning, which the person sees as one summary line at most.
  const inThought = thought && !text.trim()
    ? " Nothing about this question has been written as a message yet, and the person sees only messages. Your last message of a turn is always seen."
    : "";
  const full = `Shipyard: a question is shown only after the person has read what it is about, and ${problems.join("; and ")}.${inThought} ${HOW} Keep to the card: do not ask in plain text instead.`;
  // The first and the second time, the person reads one short line and the session gets the steps unseen. A third
  // time the steps are in the reason itself: they must reach the session even where the unseen channel does not.
  const holds = holdsSince(entries, boundary);
  if (holds === 0) return { problems, held: true, reason: HELD, context: marked ? full : `${HELD_HOW}${inThought}` };
  if (holds <= 1) return { problems, held: true, reason: HELD_AGAIN, context: full };
  return { problems, reason: full };
}
export function decideExplained(hookInput) {
  const v = explainedVerdict(hookInput);
  return v && v.problems ? v : null;
}

/** `/ship-backlog`: the board must be in the chat before the first question (the CLI prints it). */
export function decideBoard(hookInput) {
  if (!hookInput || hookInput.tool_name !== "AskUserQuestion") return null;
  const entries = transcriptTail(hookInput);
  if (!entries) return null;
  const cmd = commandStart(entries, hookInput);
  if (!cmd || !/(^|:)ship-backlog$/.test(cmd.name)) return null;
  const shown = entries.slice(cmd.start + 1).some((e) => e?.type === "assistant" && (() => { const t = textOf(e); return t.includes(BOARD_HEADER) && t.includes(BOARD_FOOTER); })());
  if (shown) return null;
  const how =
    "1. Run `shipyard-data backlog board`. 2. Write its whole output in the chat as it is, inside a code block, from the `BOARD ·` line to the `end of board` line (a tool result is not seen by the person; only your own text is), and one line under it with what you recommend. " +
    `3. End that message with the line "${QUESTION_FOLLOWS}" and end your turn there (call no tool after it). Shipyard gives the turn straight back to you. ` +
    "4. Then ask the question again. Do not summarise the board instead of printing it.";
  // The first time, one line a person can read (see HELD); the steps go to the session unseen. A board written in
  // the same message as the card is in the file when the card comes again, and the card then passes.
  const full = "Shipyard: /ship-backlog shows the board before it asks anything, and the board is not in the chat yet. " + how;
  if (holdsSince(entries, lastPersonTurn(entries, cmd.start)) <= 1) return { held: true, reason: HELD_BOARD, context: full };
  return { reason: full };
}
export const HELD_BOARD = "Shipyard: one moment. This question comes back as soon as the board is on screen.";

// CARD_LIMITS is what a session aims at (the question list checks it at `add`,
// where a miss is a draft and costs the person nothing). The hook refuses only
// a card half as long again: a refusal is a red error line on the person's
// screen and a retry, and the owner met one for a description 13 characters
// over. One question per card is refused at once.
const half = (n) => Math.round(n * 1.5);
export const ASK_LIMITS = Object.freeze({ questions: 1, question: half(CARD_LIMITS.question), label: half(CARD_LIMITS.label), description: half(CARD_LIMITS.description) });

/** Problems with the card's shape, or []. Pure. */
export function shapeProblems(toolInput) {
  const out = [];
  const qs = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  if (qs.length > ASK_LIMITS.questions) out.push(`${qs.length} questions in one card (limit ${ASK_LIMITS.questions}): write each question in the chat, then ask it on its own card, one after another`);
  qs.forEach((q, i) => {
    const n = qs.length > 1 ? `question ${i + 1}` : "the question";
    const text = String(q?.question ?? "");
    if (text.length > ASK_LIMITS.question) out.push(`${n} is ${text.length} characters (limit ${ASK_LIMITS.question})`);
    (Array.isArray(q?.options) ? q.options : []).forEach((o, k) => {
      const label = String(o?.label ?? ""), desc = String(o?.description ?? "");
      if (label.length > ASK_LIMITS.label) out.push(`${n}, choice ${k + 1}: the label is ${label.length} characters (limit ${ASK_LIMITS.label})`);
      if (desc.length > ASK_LIMITS.description) out.push(`${n}, choice ${k + 1}: the description is ${desc.length} characters (limit ${ASK_LIMITS.description})`);
    });
  });
  return out;
}

/** True when this session is inside a Shipyard command (a held lock, or a cursor it owns). */
function inShipyardCommand(dataDir, session) {
  try { if (heldSkill(dataDir, session)) return true; } catch { /* fall through */ }
  for (const f of ["EXECUTE-CURSOR.md", "REVIEW-CURSOR.md"]) {
    try {
      const fm = parseFrontmatter(readFileSync(join(dataDir, "sprints", "current", f), "utf8"));
      if (session && String(fm.session_id ?? "").trim() === session) return true;
    } catch { /* no cursor */ }
  }
  return false;
}

export function decideShape(dataDir, hookInput) {
  if (!dataDir || !hookInput || hookInput.tool_name !== "AskUserQuestion") return null;
  const session = String(hookInput.session_id ?? "").trim();
  if (!inShipyardCommand(dataDir, session)) return null; // a question outside Shipyard is none of its business
  const problems = shapeProblems(hookInput.tool_input);
  if (!problems.length) return null;
  return {
    problems,
    reason:
      "Shipyard: the question card holds only the question and the choices. " +
      `Not allowed: ${problems.join("; ")}. ` +
      "For each question: write the 15-second summary, the picture or example, the reasons and the question itself as chat text first, " +
      `then ask again with one short question (aim for ${CARD_LIMITS.question} characters) and short choices ` +
      `(label ${CARD_LIMITS.label}, description ${CARD_LIMITS.description}).`,
  };
}

/**
 * In a discussion with a question list, every card comes from the list (4.20).
 * The list is what orders questions, drops the ones research answered, counts
 * the interruptions and survives a compacted session; a card asked beside it
 * is invisible to all of that. So while THIS session holds the discuss lock
 * and a topic is current, the card's question must be one `discuss-questions
 * next` handed out. Before a topic is started (the lane confirmation) and
 * after it is paused or closed, nothing is checked.
 */
/**
 * No topic is current: the card is the session's own (a lane confirmation, a
 * triage choice, a closing "what next"). It is allowed, and recorded.
 *
 * 4.0.0 refused the third such card of a discussion and told the session to
 * start the question list first. The owner met that as an error in the middle
 * of sorting his backlog: the triage flow never starts a list, so the rule
 * punished a flow that was doing nothing wrong. What the refusal wanted, a
 * record of what was asked, needs no cooperation: the hook writes it.
 */
function freeCard(dataDir, session, hookInput) {
  try {
    const started = String(JSON.parse(readFileSync(join(dataDir, ".active-discuss.json"), "utf8")).started ?? "");
    const q = Array.isArray(hookInput?.tool_input?.questions) ? hookInput.tool_input.questions[0] : null;
    const n = started ? readEvents(dataDir, 5000).filter((e) => e.type === "discuss_card_asked" && String(e.ts ?? "") >= started.slice(0, 19) && (!e.session || !session || e.session === session)).length + 1 : 1;
    logEvent(dataDir, "discuss_card_asked", { session, n, question: String(q?.question ?? "").slice(0, 160), options: (Array.isArray(q?.options) ? q.options : []).map((o) => String(o?.label ?? "")).join(" | ").slice(0, 180) });
  } catch { /* best-effort: a card is never refused for this */ }
  return null;
}

const sameText = (a, b) => String(a ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === String(b ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function decideListed(dataDir, hookInput) {
  if (!dataDir || !hookInput || hookInput.tool_name !== "AskUserQuestion") return null;
  const session = String(hookInput.session_id ?? "").trim();
  if (heldSkill(dataDir, session) !== "ship-discuss") return null;
  const card = currentCard(dataDir);
  if (!card) return freeCard(dataDir, session, hookInput);
  const qs = Array.isArray(hookInput.tool_input?.questions) ? hookInput.tool_input.questions : [];
  if (qs.length !== 1) return null; // the shape rule answers that
  if (card.questions.some((q) => sameText(q, qs[0]?.question))) return null;
  // Nothing from the list is on the person's screen and the session asks something
  // of its own (a follow-up to an answer in their own words, a confirmation). That
  // card is recorded in the list, not refused (4.0.1): the owner met the refusal as
  // an error mid-discussion, and a recorded card keeps what the gate is for, since
  // its answer is owed before anything can be approved.
  if (!card.questions.length) return { topic: card.topic, unlisted: qs[0], session };
  return {
    topic: card.topic,
    reason:
      "Shipyard: one question at a time. The card on the list now is: " + `"${card.questions[0]}"` + " — ask it word for word, with the choices `discuss-questions next` printed, and record its answer. " +
      "To ask something else after it: add it (`shipyard-data discuss-questions add --summary … --question … --option … --checked … --confidence medium|low`, or `--kind gate` for an approval), " +
      "then run `shipyard-data discuss-questions next`.",
  };
}

export const unlistedNote = (id) => `Shipyard: this card was not in the question list, so it is recorded as ${id}. Record the person's answer: shipyard-data discuss-questions answer ${id} --choice <n> (or --text "<their own words>"). Add the next question to the list first (discuss-questions add …).`;

const ASK_OK_STAGES = /^(preflight|salvage|load|readiness|single_task|hotfix|terminal_)/;

export function decide(dataDir, hookInput) {
  if (!dataDir || !hookInput || hookInput.tool_name !== "AskUserQuestion") return null;
  let fm;
  try { fm = parseFrontmatter(readFileSync(join(dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8")); } catch { return null; }
  const status = String(fm.status ?? "").trim();
  const stage = String(fm.stage ?? "").trim();
  if (status !== "in_progress" || String(fm.terminal ?? "").trim() === "true") return null;
  if (!stage || ASK_OK_STAGES.test(stage)) return null;
  const mine = String(fm.session_id ?? "").trim();
  const asking = String(hookInput.session_id ?? "").trim();
  if (!mine || !asking || mine !== asking) return null; // not the session running this sprint
  let unattended = true;
  try { unattended = readUnattended(dataDir); } catch { return null; }
  if (!unattended) return null;
  return {
    stage,
    reason:
      `/ship-execute is unattended (stage ${stage}): it does not ask the owner mid-sprint. Decide with the ladder instead — ` +
      "(0) apply what the approved plan's Risks/decisions rows or the decision log already say; " +
      "(1) rule: a defect found in the sprint is fixed in the sprint as a patch step (only severity: low may go to the backlog); " +
      "(2) a bounded call (the options are written down): one quick light-tier decision (shipyard-data decide --question ... --option A=... --option B=...); " +
      "(3) one think-tier consult (escalating-to-thinker); (4) the advisor, when enabled; " +
      "(5) park it: shipyard-data cursor escalate execute reason=<code>. " +
      "Log the outcome: shipyard-data events emit execute_decision stage=<stage> subject=<id> source=rule|quick|consult|advisor|parked decision=\"...\" rationale=\"...\". " +
      "If only the owner can answer and nothing else can proceed, pause first (shipyard-data cursor pause execute --note \"<the question>\") — a paused sprint may ask, and the pause is reported at the sprint review as a planning gap.",
  };
}

export function run(hookInput, env) {
  const dataDir = (env && env.SHIPYARD_DATA) || process.env.SHIPYARD_DATA;
  try { noteAvailable(dataDir, hookInput); } catch { /* best-effort: which sources this session can search */ }
  let verdict = null;
  try { verdict = decide(dataDir, hookInput); } catch { verdict = null; }
  if (!verdict) {
    let shape = null;
    try { shape = decideShape(dataDir, hookInput); } catch { shape = null; }
    if (!shape) {
      let listed = null;
      try { listed = decideListed(dataDir, hookInput); } catch { listed = null; }
      if (!listed || listed.unlisted) {
        let board = null;
        try { board = decideBoard(hookInput); } catch { board = null; }
        if (board) {
          try { logEvent(dataDir, "ask_before_board_denied", {}); } catch { /* best-effort */ }
          process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: board.reason, ...(board.context ? { additionalContext: board.context } : {}) } }));
          return 0;
        }
        let explained = null;
        try { explained = explainedVerdict(hookInput); } catch { explained = null; }
        if (explained?.pass) { try { logEvent(dataDir, "ask_explained_same_message", {}); } catch { /* best-effort */ } explained = null; }
        if (!explained) {
          // The card goes through. If the list did not hand it out, record it now
          // (only now: a card another rule sends back was never shown).
          if (listed?.unlisted) {
            let rec = null;
            try { rec = recordUnlisted(dataDir, listed.unlisted); } catch { rec = null; }
            try { logEvent(dataDir, "discuss_card_unlisted", { topic: listed.topic, question: rec?.id ?? "", session: listed.session }); } catch { /* best-effort */ }
            if (rec) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: unlistedNote(rec.id) } }));
          }
          return 0;
        }
        try { logEvent(dataDir, "ask_not_explained_denied", { problems: explained.problems.length, held: explained.held === true }); } catch { /* best-effort */ }
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: explained.reason, ...(explained.context ? { additionalContext: explained.context } : {}) } }));
        return 0;
      }
      try { logEvent(dataDir, "ask_not_listed_denied", { topic: listed.topic }); } catch { /* best-effort */ }
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: listed.reason } }));
      return 0;
    }
    try { logEvent(dataDir, "ask_shape_denied", { problems: shape.problems.length }); } catch { /* best-effort */ }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: shape.reason } }));
    return 0;
  }
  try { logEvent(dataDir, "unattended_ask_denied", { stage: verdict.stage }); } catch { /* best-effort */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason } }));
  return 0;
}
