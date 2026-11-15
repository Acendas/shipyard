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
import { heldSkill } from "./agent-ledger.mjs";
import { CARD_LIMITS, currentCard } from "../discuss-questions.mjs";

/**
 * The question card holds the question and the choices, nothing else (4.16).
 * The owner's rule: explanations, examples and reasons belong in the chat
 * above the card, where they can be read; the card's own space is small.
 * "Render before asking" said so in prose and live questions still carried a
 * paragraph and an example inside the card. Limits are in characters.
 */
export const ASK_LIMITS = Object.freeze({ questions: 1, ...CARD_LIMITS }); // one set of numbers: the question list refuses the same shapes at `add`

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
      `then ask again with one short question (${ASK_LIMITS.question} characters or fewer) and short choices ` +
      `(label ${ASK_LIMITS.label}, description ${ASK_LIMITS.description}).`,
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
 * No topic is current. A discussion gets FREE_CARDS cards of its own (the lane
 * confirmation and one follow-up); after that the list must be started (4.0).
 * Once a topic has been started in this discussion and closed again, cards are
 * free (the closing "what next").
 *
 * Why: "every card comes from the list" was only checked once a topic was
 * current, and starting the topic was a sentence in a skill. A discussion over
 * 26 open items never started one and asked "Q1 of 7" as free cards: no record
 * of the answers, nothing to resume from, no approval waiting on them.
 */
export const FREE_CARDS = 2;
function freeCard(dataDir, session) {
  let started = "";
  try { started = String(JSON.parse(readFileSync(join(dataDir, ".active-discuss.json"), "utf8")).started ?? ""); } catch { return null; }
  if (!started) return null;
  const since = readEvents(dataDir, 5000).filter((e) => String(e.ts ?? "") >= started.slice(0, 19));
  if (since.some((e) => e.type === "discuss_questions_started")) return null;
  const used = since.filter((e) => e.type === "discuss_free_card" && (!e.session || !session || e.session === session)).length;
  if (used < FREE_CARDS) {
    try { logEvent(dataDir, "discuss_free_card", { session, n: used + 1 }); } catch { /* best-effort */ }
    return null;
  }
  return {
    topic: "",
    reason:
      `Shipyard: this discussion has already asked ${used} question(s) without the question list. From here every card comes from the list. ` +
      "Start it: `shipyard-data discuss-questions start --topic <lowercase-slug> --budget <how many questions you have, plus a few>`. " +
      "Add every question you have (`shipyard-data discuss-questions add --by main --summary … --question … --option \"<recommended>::<what it means>\" --option … --checked \"<where you looked first>\" --confidence medium|low`; an approval: `--kind gate`). " +
      "Then run `shipyard-data discuss-questions next`, write its summary and picture in the chat, ask the question it prints, and record the answer with `discuss-questions answer`. " +
      "Answers the person already gave in this conversation: add those questions too and record their answers, so the list is the whole record.",
  };
}

const sameText = (a, b) => String(a ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === String(b ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function decideListed(dataDir, hookInput) {
  if (!dataDir || !hookInput || hookInput.tool_name !== "AskUserQuestion") return null;
  const session = String(hookInput.session_id ?? "").trim();
  if (heldSkill(dataDir, session) !== "ship-discuss") return null;
  const card = currentCard(dataDir);
  if (!card) return freeCard(dataDir, session);
  const qs = Array.isArray(hookInput.tool_input?.questions) ? hookInput.tool_input.questions : [];
  if (qs.length !== 1) return null; // the shape rule answers that
  if (card.questions.some((q) => sameText(q, qs[0]?.question))) return null;
  return {
    topic: card.topic,
    reason:
      "Shipyard: in this discussion every question card comes from the question list. " +
      (card.questions.length ? `The card to ask now is: "${card.questions[0]}" — ask it word for word, with the choices \`discuss-questions next\` printed. ` : "No question has been handed out yet. ") +
      "To ask something else: add it (`shipyard-data discuss-questions add --summary … --question … --option … --checked … --confidence medium|low`, or `--kind gate` for an approval), " +
      "then run `shipyard-data discuss-questions next`, write its summary and picture in the chat, and ask the question it prints.",
  };
}

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
  let verdict = null;
  try { verdict = decide(dataDir, hookInput); } catch { verdict = null; }
  if (!verdict) {
    let shape = null;
    try { shape = decideShape(dataDir, hookInput); } catch { shape = null; }
    if (!shape) {
      let listed = null;
      try { listed = decideListed(dataDir, hookInput); } catch { listed = null; }
      if (!listed) return 0;
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
