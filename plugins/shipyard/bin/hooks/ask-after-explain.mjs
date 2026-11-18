/**
 * Stop hook: the explanation is in the chat, now the card.
 *
 * The owner's rule: a 15-second summary and a picture in the chat, then the
 * question card. The card hook (`unattended-ask`) can only see text that is
 * in an EARLIER message than the card. Two ways of getting it there were
 * tried live and both failed often:
 *
 *   - "write the text, run a small command, then ask": the session wrote the
 *     explanation in its reasoning (the person sees one grey summary line of
 *     it), or sent text, command and card as one message; either way the
 *     card was refused, twice in a row, and the session gave up and asked in
 *     plain text.
 *   - a command that hands the text back "to be written as it is": the tool
 *     result was taken for the chat.
 *
 * What a session does reliably is write its last message as text. So the
 * route is: end the turn on the explanation, with `Question follows.` as its
 * last line. This hook sees that line, refuses the stop, and the session
 * asks the card in its next message.
 *
 * Probed (CLI 2.1.325): the Stop input carries `last_assistant_message`
 * (that message is not in the transcript file yet). `decision: "block"`
 * continues the turn but the person sees "Stop hook error: …" and
 * `suppressOutput` does not hide it; `hookSpecificOutput.additionalContext`
 * continues it too, shows "Stop hook feedback: …" and is recorded as an
 * attachment (`hook_additional_context`), not as a user entry. So that is
 * what this hook returns, and the text is one short line.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptTail, textOf, blocksOf, commandStart, explainProblems, lastPersonTurn, cardAbove, SHIPYARD_COMMAND, QUESTION_FOLLOWS, endsWithMarker } from "./unattended-ask.mjs";
import { readState, sourcesOwed } from "../discuss-questions.mjs";
import { readEvents } from "../terminal-gate.mjs";
import { logEvent } from "../_hook_lib.mjs";
import { noteAvailable } from "./source-ledger.mjs";

export const HANDED_BACK = "Shipyard: the explanation is shown. Ask the question card now, with nothing written first.";
const handBack = (e) => (e?.type === "attachment" && e.attachment?.type === "hook_additional_context" && e.attachment?.hookEvent === "Stop" && (e.attachment.content ?? []).some((c) => /^Shipyard:/.test(String(c))))
  || (e?.type === "user" && /^Stop hook feedback:\s*Shipyard:/.test(textOf(e).trim()));
const MAX_HAND_BACKS = 2; // per question: never a loop

export function decideStop(hookInput) {
  if (!hookInput) return null;
  const last = String(hookInput.last_assistant_message ?? "").trim();
  if (!endsWithMarker(last)) return null;
  const entries = transcriptTail(hookInput) ?? [];
  const cmd = commandStart(entries, hookInput);
  if (!cmd || !SHIPYARD_COMMAND.test(cmd.name)) return null;
  // hand-backs since the last card (or since the command began)
  let from = cmd.start;
  for (let i = entries.length - 1; i > cmd.start; i--) { if (blocksOf(entries[i]).some((b) => b.type === "tool_use" && b.name === "AskUserQuestion")) { from = i; break; } }
  const handed = entries.slice(from + 1).filter(handBack).length;
  if (handed >= MAX_HAND_BACKS) return null;
  const problems = explainProblems(last);
  // The marker alone, after a held card: "my explanation is already above that card". By now the file holds what
  // was written in the held card's own message, so this hook can tell. It was there as text: the card is handed
  // back and nothing is written twice. It was not (it was reasoning): say so here, as feedback, not as a second
  // red error on the card.
  if (problems.length && !last.split("\n").some((l) => l.trim() && !endsWithMarker(l))) {
    const above = cardAbove(entries, lastPersonTurn(entries, cmd.start));
    if (above && above.text.trim() && !explainProblems(above.text).length) return { kind: "ask", reason: HANDED_BACK, same_message: true };
    if (above) return { kind: "rewrite", problems, reason: `Shipyard: the explanation of this question is not on screen yet: no message above the card holds it, and the person sees only messages. Write it now as your message (a summary of 40 words or fewer first, then a table, a diagram or an example), ending with the line "${QUESTION_FOLLOWS}".` };
  }
  if (problems.length) {
    return { kind: "rewrite", problems, reason: `Shipyard: not ready for the question card: ${problems.join("; and ")}. Write it again as your message (summary of 40 words or fewer first, then a table, diagram or example), ending with the line "${QUESTION_FOLLOWS}".` };
  }
  return { kind: "ask", reason: HANDED_BACK };
}

/**
 * A discussion does not stop halfway (4.0.1).
 *
 * The owner, on a real discussion: "ship-discuss stopped halfway". One story
 * was waiting on a fact only they had; the session ended its turn on a plain
 * "Want that?" with the critic not run, no approval card shown and nothing
 * finalized, though none of that depended on the open point. Asked why, it
 * answered "the remaining steps don't depend on S002" and carried on.
 *
 * So: while this session holds the discuss lock, a turn that ends without a
 * question card on its way is handed back once. The lock is the state: a
 * finished or paused discussion has released it. Not handed back: research or
 * a critic still running in the background (the session is woken when it
 * returns), another command typed since, and a second time in a row (the
 * session has been told; it may have a reason this hook cannot see).
 */
export const UNFINISHED = "Shipyard: this discussion is not finished.";
const STOP_PLAIN = "To stop here on purpose, pause it: shipyard-data discuss-questions pause, then shipyard-data lock release discuss --skill ship-discuss.";
// What `lock release discuss` asks for before it lets go, keyed by `sourcesOwed(...).missing`.
const STOP_OWED = Object.freeze({
  registry: "To stop here on purpose, first ask the owner once where this project's knowledge lives (shipyard-data sources suggest prints the question) and record the answer, then shipyard-data lock release discuss --skill ship-discuss.",
  sources: "To stop here on purpose, first record where the research looked, one line per source this project names (shipyard-data discuss-questions sources --looked|--skipped|--unreachable \"<name>: …\"), then shipyard-data lock release discuss --skill ship-discuss.",
  person: "To stop here on purpose, first ask the person whether a document exists that this session cannot reach and record the answer (shipyard-data discuss-questions sources --person-said \"<their answer>\"), then shipyard-data lock release discuss --skill ship-discuss.",
});
export function decideUnfinished(dataDir, hookInput) {
  if (!dataDir || !hookInput) return null;
  const session = String(hookInput.session_id ?? "").trim();
  if (!session) return null;
  let lock = null;
  try { lock = JSON.parse(readFileSync(join(dataDir, ".active-discuss.json"), "utf8")); } catch { return null; }
  if (!lock || !lock.skill || lock.cleared || String(lock.session_id ?? "") !== session) return null;
  if (endsWithMarker(String(hookInput.last_assistant_message ?? "").trim())) return null; // the card is on its way
  const entries = transcriptTail(hookInput) ?? [];
  const cmd = commandStart(entries, hookInput);
  if (cmd && !/(^|:)ship-discuss$/.test(cmd.name)) return null; // the person ran something else in this session
  const state = readState(dataDir);
  const topic = state.current ? state.topics[state.current] : null;
  if (topic?.research?.state === "running") return null; // waiting for a background agent, not for nothing
  const since = lastPersonTurn(entries, cmd ? cmd.start : -1);
  // A helper started in the background in this stretch (a critic, a deep-dive) will wake the session when it
  // returns: ending the turn to wait for it is not stopping halfway. Seen live: the hand-back fired while the
  // session waited for the critic it had just dispatched.
  if (entries.slice(since + 1).some((e) => blocksOf(e).some((b) => b.type === "tool_use" && b.name === "Agent" && (b.input?.run_in_background === true || b.input?.run_in_background === "true")))) return null;
  if (entries.slice(since + 1).some((e) => handBack(e) && JSON.stringify(e).includes(UNFINISHED))) return null;
  const asked = topic?.questions?.find((q) => q.status === "asked");
  let owed = null;
  try { owed = sourcesOwed(dataDir, lock.owed_since ?? lock.started ?? null, readEvents(dataDir, 5000)); } catch { owed = null; }
  return {
    kind: "unfinished",
    reason:
      `${UNFINISHED} ${asked ? `${asked.id} is handed out and not asked yet: ask it. ` : ""}` +
      "Do every remaining step that does not depend on the person now (when one story is waiting on them, carry on with the others: critic, approval, finalize). " +
      "Ask what only they can decide as a question card, never as a plain-text question at the end of a turn. " +
      (STOP_OWED[owed?.missing] ?? STOP_PLAIN),
  };
}

export function run(hookInput, env) {
  const dataDir = (env && env.SHIPYARD_DATA) || process.env.SHIPYARD_DATA;
  try { noteAvailable(dataDir, hookInput); } catch { /* best-effort: which sources this session can search */ }
  let v = null;
  try { v = decideStop(hookInput); } catch { v = null; }
  if (!v) { try { v = decideUnfinished(dataDir, hookInput); } catch { v = null; } }
  if (!v) return 0;
  try { if (dataDir) logEvent(dataDir, v.kind === "ask" ? "ask_handed_back" : v.kind === "unfinished" ? "discuss_stop_handed_back" : "explanation_sent_back", v.problems ? { problems: v.problems.length } : {}); } catch { /* best-effort */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: v.reason } }));
  return 0;
}
