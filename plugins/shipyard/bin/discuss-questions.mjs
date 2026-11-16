/**
 * `shipyard-data discuss-questions <verb>` (v4.20) — the question list of an
 * asynchronous discussion.
 *
 * Research runs in the background. When it reaches something only the person
 * can decide it ADDS a question here and carries on. The main session takes
 * the NEXT one, writes it in the chat, asks it on one card and records the
 * ANSWER; the researcher reads ANSWERS at its own checkpoints.
 *
 * Why a file and not messages (probe 2026-11-14, CLI 2.1.325): a background
 * agent keeps working after it sends a message, but a message that arrives
 * while a card is open waits for that turn to end, and a message TO a busy
 * agent is read only when the agent's own turn ends. So this list is the
 * transport in both directions, and `wait` (a background command whose exit
 * wakes the main session) replaces any reliance on the researcher's message.
 *
 * State: `<dataDir>/.discuss-questions.json` (model writes denied by the data hook).
 *   { version, current, topics: { <topic>: { story, budget, seq, answer_seq, research, questions[], assumptions[] } } }
 *   question.status: draft | open | asked | answered | dropped        kind: decision | gate
 *
 *   start --topic <slug> [--story S###] [--budget <n>]     begin or resume a topic and make it current
 *   bind --story S###                                      tie the current topic to its story (the approval gate reads it)
 *   add --summary "<=40 words" --question "<one sentence>" --option "<label>::<meaning>" (2-4, recommended FIRST)
 *       --checked "<where you looked>" --confidence <medium|low> [--parks "<research waiting on it>"] [--weight high]
 *       [--show-file <path>|--show "<text>"] [--by <who>] [--kind gate]
 *         a badly shaped question is kept as a `draft` (nothing is lost) and fixed with `revise`
 *   revise <Q#> [same flags]                               reword a draft or a not-yet-shown question
 *   assume --statement "..." --basis "..." [--by <who>]    decided without asking; shown before approval as ASSUMED
 *   next [--json]                                          the one card to show now; exit 3 with the reason when there is none
 *   answer <Q#> (--choice <n> | --text "<their words>" | --you-decide)
 *   answer-bundle (--accept | --one-by-one)                the reply to the "smaller questions" card
 *   answers [--after <cursor>] [--ack --by <who>] [--json] answers newer than the cursor; --ack records that <who> read them
 *   drop <Q#> --reason "..."                               withdraw a question that is not on the person's screen
 *   research --state <running|parked|done|abandoned> [--by <who>] [--note "..."]
 *   wait [--timeout <s>]                                   block until a card is ready, research parks or ends, or time runs out
 *   status [--json] | pause | reset [--force]
 * Every verb takes `--topic <slug>`; without it the current topic is used.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, logEvent, withLockfile } from "./_hook_lib.mjs";

export const QUESTIONS_BASENAME = ".discuss-questions.json";
export const CARD_LIMITS = Object.freeze({ question: 160, label: 40, description: 110 }); // the same numbers the card hook enforces
export const SUMMARY_WORDS = 40;
export const SHOW_CHARS = 6000;
export const DEFAULT_BUDGET = 12;
const RECOMMENDED = " (Recommended)";
const OPEN = new Set(["draft", "open", "asked"]);
const RESEARCH_STATES = ["running", "parked", "done", "abandoned"];
export const BUNDLE_OPTIONS = Object.freeze([{ label: `Yes, use them${RECOMMENDED}`, description: "Each one gets the recommended answer shown above" }, { label: "No, ask me each one", description: "Go through them one card at a time" }]);
export const bundleQuestion = (n) => `Use my recommended answers for these ${n} smaller questions?`;

export function questionsPath(dataDir) { return join(dataDir, QUESTIONS_BASENAME); }
/** Where a topic's "show" files (one picture, table or example per question) are written; removed when the list is closed. */
export function showDir(dataDir, topic) { return join(dataDir, "spec", ".questions", topic); }
const emptyTopic = (topic) => ({ topic, story: "", budget: DEFAULT_BUDGET, started_at: new Date().toISOString(), seq: 0, answer_seq: 0, one_by_one: false, bundle: null, research: { state: "none", by: "", at: "", note: "" }, questions: [], assumptions: [], needs_sources: true, sources: null });
export function readState(dataDir) {
  const empty = { version: 2, current: null, topics: {} };
  if (!existsSync(questionsPath(dataDir))) return empty;
  try {
    const s = JSON.parse(readFileSync(questionsPath(dataDir), "utf8"));
    return s && s.version === 2 && s.topics && typeof s.topics === "object" ? s : empty; // a v1 file (4.18, never used by a command) is ignored
  } catch { return empty; }
}
/** Read, change and write under one lock: the researcher and the main session write at the same time. */
function mutate(dataDir, fn) {
  let out; // withLockfile returns nothing: keep the result here
  withLockfile(`${questionsPath(dataDir)}.lock`, () => {
    const state = readState(dataDir);
    out = fn(state);
    if (!out || !out.error) atomicWrite(questionsPath(dataDir), JSON.stringify(state, null, 2) + "\n");
  }, { ttlMs: 10000, retryMs: 50, maxRetries: 200 });
  return out;
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean).length;
const secs = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null);
const now = () => new Date().toISOString();
const isOpen = (q) => OPEN.has(q.status);
/** The stories a topic is bound to. One discussion can write several (4.0.1): `bind` used to keep only the last one, so the first three of four stories could be approved with a question still open. */
export const boundTo = (t) => [...new Set([...(Array.isArray(t?.stories) ? t.stories : []), t?.story].map((x) => String(x ?? "").trim()).filter(Boolean))];
const bindStories = (t, raw) => { t.stories = [...new Set([...boundTo(t), ...String(raw).split(",").map((x) => x.trim()).filter(Boolean)])]; t.story = t.stories[0] ?? ""; return t.stories; };

/** Problems with a question as it would appear on a card, or []. Pure. */
export function questionProblems({ kind = "decision", summary, question, options, checked, confidence }) {
  const out = [];
  if (!String(summary ?? "").trim()) out.push("--summary is missing: the 15-second summary the person reads first");
  else if (words(summary) > SUMMARY_WORDS) out.push(`the summary is ${words(summary)} words (limit ${SUMMARY_WORDS})`);
  const q = String(question ?? "").trim();
  if (!q) out.push("--question is missing");
  else if (q.length > CARD_LIMITS.question) out.push(`the question is ${q.length} characters (limit ${CARD_LIMITS.question}); put the reasons in --summary or --show`);
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) out.push(`${options?.length ?? 0} options (give 2 to 4, the recommended one first)`);
  (options ?? []).forEach((o, i) => {
    const max = CARD_LIMITS.label - (i === 0 ? RECOMMENDED.length : 0);
    if (!o.label) out.push(`option ${i + 1} has no label`);
    else if (o.label.length > max) out.push(`option ${i + 1}: the label is ${o.label.length} characters (limit ${max}${i === 0 ? ", it carries \"(Recommended)\"" : ""})`);
    if (!o.description) out.push(`option ${i + 1} has no description after "::" (what choosing it means)`);
    else if (o.description.length > CARD_LIMITS.description) out.push(`option ${i + 1}: the description is ${o.description.length} characters (limit ${CARD_LIMITS.description})`);
  });
  if (kind !== "gate") {
    if (!String(checked ?? "").trim()) out.push("--checked is missing: say where you looked for the answer first (code, spec, decision logs, the person's own words)");
    if (confidence === "high") out.push("--confidence high is not a question: decide it and record it with `discuss-questions assume`");
    else if (!["medium", "low"].includes(confidence)) out.push("--confidence must be medium or low");
  }
  return out;
}

/** What `next` should hand out. Pure over one topic. */
export function pickNext(t) {
  const asked = t.questions.find((q) => q.status === "asked");
  if (asked) return { kind: "question", q: asked, reshown: true }; // shown and never answered: a compacted or restarted session
  if (t.bundle) return { kind: "bundle", ids: t.bundle.ids, reshown: true };
  const drafts = t.questions.filter((q) => q.status === "draft");
  const decisions = t.questions.filter((q) => q.status === "open" && q.kind !== "gate")
    .sort((a, b) => (b.parks ? 1 : 0) - (a.parks ? 1 : 0) || (b.weight === "high" ? 1 : 0) - (a.weight === "high" ? 1 : 0) || Date.parse(a.raised_at) - Date.parse(b.raised_at));
  if (decisions.length) {
    const shown = t.questions.filter((q) => q.kind !== "gate" && q.shown_at).length;
    const small = decisions.filter((q) => q.weight !== "high" && !q.parks);
    if (!t.one_by_one && shown >= t.budget && small.length >= 2) return { kind: "bundle", ids: small.map((q) => q.id), reshown: false };
    return { kind: "question", q: decisions[0], reshown: false };
  }
  if (drafts.length) return { kind: "none", reason: "draft", drafts };
  const gate = t.questions.find((q) => q.status === "open" && q.kind === "gate");
  if (gate) return t.research.state === "running" ? { kind: "none", reason: "research_running" } : { kind: "question", q: gate, reshown: false };
  return { kind: "none", reason: ["running", "parked"].includes(t.research.state) ? `research_${t.research.state}` : "none" };
}

export function summarize(t) {
  const qs = t.questions;
  const count = (s) => qs.filter((q) => q.status === s).length;
  const shown = qs.map((q) => secs(q.raised_at, q.shown_at)).filter((n) => n !== null);
  const answered = qs.map((q) => secs(q.shown_at, q.answered_at)).filter((n) => n !== null && true);
  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null);
  return {
    topic: t.topic, story: boundTo(t).join(", "), total: qs.length, draft: count("draft"), open: count("open"), asked: count("asked"), answered: count("answered"), dropped: count("dropped"),
    cards_shown: qs.filter((q) => q.shown_at).length, assumptions: t.assumptions.length, research: t.research.state,
    raised_to_shown_seconds: { median: median(shown), max: shown.length ? Math.max(...shown) : null },
    shown_to_answered_seconds: { median: median(answered), max: answered.length ? Math.max(...answered) : null },
    unread_answers: qs.filter((q) => q.status === "answered" && q.by && q.by !== "main" && !q.picked_up_at).map((q) => q.id),
    cursor: t.answer_seq,
  };
}

/** Why a story may not be approved yet, from the topic bound to it. [] when nothing holds it. */
export function approvalProblems(dataDir, storyId) {
  const out = [];
  for (const t of Object.values(readState(dataDir).topics)) {
    if (!storyId || !boundTo(t).includes(String(storyId))) continue;
    // Where the research looked is on record before approval (4.0.1). The owner: "as part of discuss make sure
    // research looks at datasources internal as well as the usual external". Only topics started since then.
    if (t.needs_sources && !t.sources) out.push('the research has not said where it looked: record the organisation\'s own sources (wiki, tracker, shared drive, the project\'s documents) and the outside ones with `discuss-questions sources --wiki "…" --tracker "…" --drive "…" --external "…"` (each: what was searched and found, or "not connected", or "not relevant: <why>")');
    // A session only knows the sources that are connected. A PDF on someone's disk, a contract, an email: only
    // the person knows it exists, so they are asked once, with the list of what was looked at in front of them.
    else if (t.needs_sources && !t.sources.person_said) out.push('the person has not been asked whether a document exists that this session cannot reach (a PDF, a contract, a spec sheet, an email): show them what the research looked at, ask, read what they give, and record their answer with `discuss-questions sources --person-said "<their answer>"`');
    const waiting = t.questions.filter(isOpen);
    if (waiting.length) out.push(`${waiting.length} question(s) of this discussion are not answered yet (${waiting.map((q) => q.id).join(", ")}): ask them (\`discuss-questions next\`), or \`drop\` the ones research answered`);
    if (["running", "parked"].includes(t.research.state)) out.push(`the background research is ${t.research.state}: let it finish with the answers (\`discuss-questions research --state done\`), or record \`--state abandoned --note "<why>"\``);
    else if (t.research.state !== "abandoned") { const unread = summarize(t).unread_answers; if (unread.length) out.push(`the researcher has not read the answer to ${unread.join(", ")}: resume it with those answers, or record \`research --state abandoned --note "<why>"\` and fold them in yourself`); }
  }
  return out;
}
/** Connector and web calls the `source-ledger` hook logged since `since`: { wiki, tracker, drive, chat, web, internal }. */
export function measuredSources(dataDir, since) {
  const out = { wiki: 0, tracker: 0, drive: 0, chat: 0, code_host: 0, web: 0 };
  const t0 = Date.parse(since ?? "");
  let text = "";
  try { text = readFileSync(join(dataDir, ".shipyard-events.jsonl"), "utf8"); } catch { return { ...out, internal: 0 }; }
  for (const line of text.split("\n")) {
    if (!line.includes('"source_read"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "source_read" || !(e.source in out)) continue;
    if (Number.isFinite(t0) && Date.parse(e.ts) < t0 - 1000) continue;
    out[e.source] += 1;
  }
  return { ...out, internal: out.wiki + out.tracker + out.drive + out.chat };
}
/** The last call of each kind of source ever logged in this project: { wiki: {tool, ts}, … }. */
function everRead(dataDir) {
  const out = {};
  let text = "";
  try { text = readFileSync(join(dataDir, ".shipyard-events.jsonl"), "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line.includes('"source_read"')) continue;
    try { const e = JSON.parse(line); if (e.type === "source_read") out[e.source] = { tool: e.tool, ts: e.ts }; } catch { /* a cut line */ }
  }
  return out;
}
/** The kinds of source the latest session to hold a discussion had tools for ({wiki, tracker, drive}: a tool name or ""), or null when never recorded. */
function availableSources(dataDir) {
  let text = "";
  try { text = readFileSync(join(dataDir, ".shipyard-events.jsonl"), "utf8"); } catch { return null; }
  let last = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"sources_available"')) continue;
    try { const e = JSON.parse(line); if (e.type === "sources_available") last = e; } catch { /* a cut line */ }
  }
  return last ? { wiki: last.wiki ?? "", tracker: last.tracker ?? "", drive: last.drive ?? "" } : null;
}
const sourcesTable = (x) => ["| Where | What was searched and found |", "|---|---|", `| Wiki | ${x.wiki || "-"} |`, `| Tracker | ${x.tracker || "-"} |`, `| Shared drive | ${x.drive || "-"} |`, ...(x.project ? [`| The project's own documents | ${x.project} |`] : []), `| Outside | ${x.external || "-"} |`, `| Tool calls counted | ${x.measured} |`];
const measuredLine = (m) => `wiki ${m.wiki}, tracker ${m.tracker}, shared drive ${m.drive}${m.chat ? `, chat or mail ${m.chat}` : ""}; web ${m.web}`;

/**
 * What a discussion still owes about its sources before it ends, or null. Read by `lock release discuss`:
 * a discussion that breaks an epic into a spike and draft stories never reaches an approval, so the approval
 * gate alone would let it end without saying where it looked (seen live: "I have not read the Google Drive
 * hardware documents yet").
 */
export function sourcesOwed(dataDir, since, events = []) {
  const t0 = Date.parse(since ?? "");
  const mine = Object.values(readState(dataDir).topics).filter((t) => t.needs_sources && !(Number.isFinite(t0) && Date.parse(t.started_at ?? "") < t0 - 1000));
  for (const t of mine) {
    if (t.topic === FALLBACK_TOPIC) continue;
    if (!t.sources) return { topic: t.topic, missing: "sources" };
    if (!t.sources.person_said) return { topic: t.topic, missing: "person" };
  }
  // A discussion that wrote specs without ever opening a question list owes the same (seen live: an idea was
  // refined into an epic through free cards, and nothing asked where the research had looked).
  const wrote = events.some((e) => (!Number.isFinite(t0) || Date.parse(e.ts) >= t0 - 1000) && (WROTE_SPECS.has(e.type) || (e.type === "model_state_file_write" && /[\\/]spec[\\/](epics|stories|tasks|features|bugs)[\\/]/.test(String(e.file ?? "")))));
  if (!wrote) return null;
  // The quick lanes (a thought captured, a tiny change filed to land now, a hotfix) do no research: nothing is owed.
  const lane = [...events].reverse().find((e) => e.type === "intake_lane_confirmed" && (!Number.isFinite(t0) || Date.parse(e.ts) >= t0 - 1000))?.lane;
  if (["land-now", "capture", "hotfix"].includes(lane)) return null;
  if (mine.some((t) => t.sources?.person_said)) return null;
  // A question list that was closed took its record with it; the log remembers that it was complete
  // (seen live: the session had to record its sources a second time to release the lock).
  if (events.some((e) => e.type === "discuss_sources_recorded" && e.person_asked === "yes" && (!Number.isFinite(t0) || Date.parse(e.ts) >= t0 - 1000))) return null;
  return { topic: mine.find((t) => t.sources)?.topic ?? FALLBACK_TOPIC, missing: mine.some((t) => t.sources) ? "person" : "sources" };
}
const FALLBACK_TOPIC = "discussion"; // where `sources` is kept when a discussion has no question list
const WROTE_SPECS = new Set(["idea_promoted", "idea_imported", "idea_captured", "story_imported", "task_imported", "tracker_pulled"]);
const lockStart = (dataDir) => { try { const o = JSON.parse(readFileSync(join(dataDir, ".active-discuss.json"), "utf8")); return o && o.skill && !o.cleared ? String(o.started ?? "") : ""; } catch { return ""; } };
/** Topics with something waiting (for the start-of-discussion context). */
export function waitingTopics(dataDir) {
  const s = readState(dataDir);
  return { current: s.current, waiting: Object.values(s.topics).map((t) => ({ topic: t.topic, ids: t.questions.filter(isOpen).map((q) => q.id) })).filter((x) => x.ids.length) };
}
/** The card the main session may ask right now in the current topic, or null (the card hook reads this). */
export function currentCard(dataDir) {
  const s = readState(dataDir);
  const t = s.current ? s.topics[s.current] : null;
  if (!t) return null;
  const asked = t.questions.filter((q) => q.status === "asked").map((q) => q.question);
  if (t.bundle) asked.push(bundleQuestion(t.bundle.ids.length));
  return { topic: t.topic, questions: asked };
}

/**
 * A card the main session asks that the list did not hand out (4.0.1). It is
 * recorded as a question on the person's screen, so its answer is owed like any
 * other and nothing can be approved until it is recorded. Before this the card
 * hook refused it, and the owner met that as an error in the middle of a
 * discussion. Returns { id, topic } or null (an answered or waiting question
 * already asks it, or there is no current topic).
 */
export function recordUnlisted(dataDir, card) {
  const question = String(card?.question ?? "").trim();
  if (!question) return null;
  const r = mutate(dataDir, (state) => {
    const t = state.current ? state.topics[state.current] : null;
    if (!t) return { error: "no topic" };
    if (t.questions.some((x) => x.status !== "dropped" && norm(x.question) === norm(question))) return { error: "listed" };
    const options = (Array.isArray(card.options) ? card.options : []).map((x) => ({ label: String(x?.label ?? "").replace(/\s*\(Recommended\)\s*$/i, "").trim(), description: String(x?.description ?? "").trim() })).filter((x) => x.label);
    const q = { id: `Q${++t.seq}`, kind: "decision", status: "asked", weight: "normal", by: "main", unlisted: true, confidence: "", summary: "", show: "", question, options, parks: "", checked: "", problems: [], raised_at: now(), shown_at: now(), answered_at: null, answer: null };
    t.questions.push(q);
    return { id: q.id, topic: t.topic };
  });
  return r && !r.error ? r : null;
}

function parse(args, fail) {
  const o = { _: [], option: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (["--json", "--force", "--you-decide", "--accept", "--one-by-one", "--ack"].includes(a)) { o[a.slice(2)] = true; continue; }
    if (a.startsWith("--")) {
      const v = args[++i];
      if (v === undefined) fail(`${a} needs a value`);
      if (a === "--option") o.option.push(v); else o[a.slice(2)] = v;
    } else o._.push(a);
  }
  return o;
}
function usage(msg) {
  process.stderr.write(
    `shipyard-data discuss-questions: ${msg}\n` +
      "  Usage: discuss-questions start --topic <slug> [--story S###] [--budget <n>] | bind --story S### | pause | reset [--force]\n" +
      "         discuss-questions add --summary \"...\" --question \"...\" --option \"<label>::<meaning>\" (2-4, recommended first) --checked \"...\" --confidence <medium|low> [--parks \"...\"] [--weight high] [--show-file <path>|--show \"...\"] [--by <who>] [--kind gate]\n" +
      "         discuss-questions revise <Q#> [the same flags] | assume --statement \"...\" --basis \"...\" [--by <who>]\n" +
      "         discuss-questions next [--json] | answer <Q#> (--choice <n> | --text \"...\" | --you-decide) | answer-bundle (--accept | --one-by-one)\n" +
      "         discuss-questions ask-again <Q#> --their-words \"...\" [--summary \"...\" --show-file <path> --option \"<label>::<meaning>\" ...]   (they replied with a question, or asked for advice)\n" +
      "         discuss-questions answers [--after <cursor>] [--ack --by <who>] [--json] | drop <Q#> --reason \"...\"\n" +
      "         discuss-questions sources --wiki \"...\" --tracker \"...\" --drive \"...\" --external \"...\" [--project \"...\"] [--by <who>]   (each: searched and found | not connected | not relevant: <why>)\n" +
      "         discuss-questions sources --person-said \"<their answer to: is there a document this session cannot reach?>\"\n" +
      "         discuss-questions research --state <running|parked|done|abandoned> [--by <who>] [--note \"...\"] | wait [--timeout <s>] | status [--json]\n" +
      "         (every verb takes --topic <slug>; the current topic is used without it)\n",
  );
  process.exit(2);
}
function refuse(msg) { process.stderr.write(`shipyard-data discuss-questions: ${msg}\n`); process.exit(3); }

const optionsOf = (list) => list.map((raw) => { const i = raw.indexOf("::"); return i === -1 ? { label: raw.trim(), description: "" } : { label: raw.slice(0, i).trim(), description: raw.slice(i + 2).trim() }; });
const cardOptions = (q) => q.options.map((x, i) => ({ label: `${x.label}${i === 0 ? RECOMMENDED : ""}`, description: x.description }));

function renderQuestion(q, extra) {
  const L = [`${q.id}${q.kind === "gate" ? " (approval)" : ""}${extra.waiting ? ` — ${extra.waiting} more waiting` : ""}${q.by ? ` — raised by ${q.by}` : ""}${extra.reshown ? " — SHOWN BEFORE, not answered: if the person's answer is in this conversation record it, otherwise say you are asking again" : ""}`];
  if (extra.since.length) L.push("", "Answered since this was raised (if one of these settles it, `drop` it instead of asking):", ...extra.since.map((a) => `  ${a.id} "${a.question}" → ${a.answer}`));
  if (q.unlisted && !q.summary) {
    L.push("", `You asked this card yourself, outside the list: "${q.question}"`, "", "CHOICES it had:");
    cardOptions(q).forEach((o, i) => L.push(`  ${i + 1}. ${o.label} — ${o.description}`));
    L.push("", `Record the person's answer now: shipyard-data discuss-questions answer ${q.id} --choice <n>   (--text "<their own words>" for anything else). Do not ask it again if they answered. Next time add the question to the list first (\`discuss-questions add …\`).`);
    return L.join("\n") + "\n";
  }
  L.push("", "SUMMARY (write this in the chat first):", q.summary);
  // Always something to look at (4.0.1): with no show block of its own, the choices as a table.
  const show = q.show || ["| Choice | What it means |", "|---|---|", ...cardOptions(q).map((o) => `| ${o.label} | ${o.description} |`)].join("\n");
  L.push("", "SHOW (write this in the chat too, as it is):", show);
  L.push("", `NEXT: write the SUMMARY and the SHOW block as your message, as they are (the person cannot see this tool result, and cannot see your reasoning). End the message with the line "Question follows." and end your turn there; you get the turn straight back, and then you ask the card below.`);
  L.push("", "QUESTION (the card's question, word for word):", q.question, "", "CHOICES (the card's options, in this order):");
  cardOptions(q).forEach((o, i) => L.push(`  ${i + 1}. ${o.label} — ${o.description}`));
  if (q.parks) L.push("", `Research waiting on this: ${q.parks}`);
  L.push("", `Then record it: shipyard-data discuss-questions answer ${q.id} --choice <n>   (--text "<their own words>" for anything else, --you-decide when they leave it to you)`);
  L.push(`If they reply with a question or ask what you advise, that is not an answer and your advice is not their answer: shipyard-data discuss-questions ask-again ${q.id} --their-words "<their words>" --summary "<your advice, 40 words or fewer>" [--show-file … --option …], then \`next\` shows it again with your advice above it.`);
  return L.join("\n") + "\n";
}

export function main(dataDir, args = []) {
  const sub = args[0];
  const o = parse(args.slice(1), usage);
  const log = (type, fields) => { try { logEvent(dataDir, type, fields); } catch { /* best-effort */ } };
  /** The topic a verb acts on (inside `mutate`), or an error result. */
  const topicOf = (state, { create = false } = {}) => {
    const name = o.topic ?? state.current;
    if (!name) return { error: "no topic: pass --topic <slug> or start one (`discuss-questions start --topic <slug>`)" };
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return { error: `topic "${name}" must be a lowercase slug (letters, digits, dashes)` };
    if (!state.topics[name]) { if (!create) return { error: `no topic "${name}" (start it with \`discuss-questions start --topic ${name}\`)` }; state.topics[name] = emptyTopic(name); }
    return { t: state.topics[name] };
  };
  const withTopic = (fn, opts) => { const r = mutate(dataDir, (state) => { const x = topicOf(state, opts); return x.error ? x : fn(x.t, state); }); if (r?.error) refuse(r.error); return r; };
  const fields = () => {
    let show = o.show !== undefined ? String(o.show) : undefined;
    if (o["show-file"]) { try { show = readFileSync(o["show-file"], "utf8"); } catch { usage(`--show-file ${o["show-file"]} cannot be read`); } }
    return { summary: o.summary, question: o.question, options: o.option.length ? optionsOf(o.option) : undefined, checked: o.checked, confidence: o.confidence, parks: o.parks, weight: o.weight, show: show === undefined ? undefined : show.replace(/\s+$/, "") };
  };
  const shapeOf = (q) => { const p = questionProblems(q); if ((q.show ?? "").length > SHOW_CHARS) p.push(`the show block is ${q.show.length} characters (limit ${SHOW_CHARS}): one picture, table or example`); return p; };

  if (sub === "start") {
    if (!o.topic) usage("start needs --topic <slug>");
    const r = withTopic((t, state) => {
      state.current = t.topic;
      if (o.story) bindStories(t, o.story);
      if (o.budget !== undefined) { const n = Number(o.budget); if (Number.isInteger(n) && n >= 1) t.budget = n; }
      return { t: { ...t }, waiting: t.questions.filter(isOpen).map((q) => q.id) };
    }, { create: true });
    log("discuss_questions_started", { topic: r.t.topic, waiting: r.waiting.length });
    process.stdout.write(`show files for this topic go in ${showDir(dataDir, r.t.topic)}/ (removed when the list is closed)\n`);
    process.stdout.write(`topic ${r.t.topic} is current${r.waiting.length ? `; ${r.waiting.length} question(s) from before are waiting (${r.waiting.join(", ")}): run \`discuss-questions next\`` : ""}\n`);
    return;
  }
  if (sub === "bind") {
    if (!o.story) usage("bind needs --story S###");
    const r = withTopic((t) => ({ topic: t.topic, stories: bindStories(t, o.story) }));
    process.stdout.write(`topic ${r.topic} is bound to ${r.stories.join(", ")}: ${r.stories.length > 1 ? "none of them can" : "it cannot"} be approved while a question waits\n`);
    return;
  }
  if (sub === "pause") {
    mutate(dataDir, (state) => { state.current = null; return {}; });
    process.stdout.write("no topic is current; waiting questions are kept for a later `start`\n");
    return;
  }

  if (sub === "add" || sub === "revise") {
    const f = fields();
    // A bare `add` is someone asking how the verb works, not a question: seen live, it left an empty draft Q1 behind.
    if (sub === "add" && !String(f.question ?? "").trim() && !String(f.summary ?? "").trim() && !f.options) usage("add needs at least --question (and --summary, --option, --checked, --confidence)");
    const kind = o.kind === "gate" ? "gate" : "decision";
    const r = withTopic((t) => {
      let q;
      if (sub === "revise") {
        q = t.questions.find((x) => x.id === o._[0]);
        if (!q) return { error: `${o._[0] ?? "(no id)"} is not in topic ${t.topic}` };
        if (!["draft", "open"].includes(q.status)) return { error: `${q.id} is ${q.status}: only a draft or a question not yet shown can be reworded` };
        for (const [k, v] of Object.entries(f)) if (v !== undefined) q[k] = k === "weight" ? (v === "high" ? "high" : "normal") : typeof v === "string" ? v.trim() : v;
      } else {
        q = { id: "", kind, status: "open", weight: f.weight === "high" ? "high" : "normal", by: o.by ?? "", confidence: f.confidence ?? "", summary: String(f.summary ?? "").trim(), show: f.show ?? "", question: String(f.question ?? "").trim(), options: f.options ?? [], parks: String(f.parks ?? "").trim(), checked: String(f.checked ?? "").trim(), problems: [], raised_at: now(), shown_at: null, answered_at: null, answer: null };
        const same = q.question && t.questions.find((x) => x.status !== "dropped" && norm(x.question) === norm(q.question));
        if (same) return { error: `${same.id} already asks this (${same.status}${same.answer ? `: ${same.answer.label || same.answer.text}` : ""}). Use that answer; do not ask twice.` };
        q.id = `Q${++t.seq}`;
        t.questions.push(q);
      }
      q.problems = shapeOf(q);
      q.status = q.problems.length ? "draft" : "open";
      const others = t.questions.filter((x) => x.id !== q.id && x.status !== "dropped").map((x) => `${x.id} ${x.status}: ${x.question}${x.answer ? ` → ${x.answer.label || x.answer.text}` : ""}`);
      return { q: { ...q }, others, topic: t.topic };
    });
    log(r.q.status === "draft" ? "discuss_question_drafted" : sub === "add" ? "discuss_question_added" : "discuss_question_revised", { topic: r.topic, question: r.q.id, by: r.q.by, kind: r.q.kind, parks: r.q.parks ? "yes" : "no" });
    if (r.q.status === "draft") refuse(`${r.q.id} is kept as a DRAFT (it is not lost, and nothing can be approved while it waits). It cannot be shown yet:\n  - ${r.q.problems.join("\n  - ")}\n  Fix it: shipyard-data discuss-questions revise ${r.q.id} <the corrected flags>`);
    process.stdout.write(`${r.q.id} ${sub === "add" ? "added" : "revised"}. Carry on with work that does not depend on it; read answers with: shipyard-data discuss-questions answers --after <cursor> --ack --by <you>\n`);
    if (sub === "add" && r.others.length) process.stdout.write(`Other questions in this discussion (if one already asks the same thing in other words, drop yours: discuss-questions drop ${r.q.id} --reason "same as Q#"):\n${r.others.map((x) => `  ${x}`).join("\n")}\n`);
    return;
  }

  if (sub === "assume") {
    if (!o.statement || !o.basis) usage("assume needs --statement and --basis");
    const r = withTopic((t) => { t.assumptions.push({ statement: String(o.statement).trim(), basis: String(o.basis).trim(), by: o.by ?? "", at: now() }); return { n: t.assumptions.length, topic: t.topic }; });
    log("discuss_assumption_recorded", { topic: r.topic, by: o.by ?? "" });
    process.stdout.write(`assumption ${r.n} recorded; the person sees it before approval as ASSUMED\n`);
    return;
  }

  if (sub === "next") {
    const r = withTopic((t) => {
      const p = pickNext(t);
      const waitingAfter = (id) => t.questions.filter((q) => isOpen(q) && q.id !== id).length;
      if (p.kind === "question") {
        const q = p.q, first = !q.shown_at;
        if (first) q.shown_at = now();
        q.status = "asked";
        const since = t.questions.filter((x) => x.status === "answered" && Date.parse(x.answered_at) > Date.parse(q.raised_at)).map((x) => ({ id: x.id, question: x.question, answer: x.answer.label || x.answer.text }));
        return { kind: "question", q: { ...q }, first, reshown: p.reshown, waiting: waitingAfter(q.id), since, topic: t.topic };
      }
      if (p.kind === "bundle") {
        if (!t.bundle) t.bundle = { ids: p.ids, asked_at: now() };
        const items = t.bundle.ids.map((id) => t.questions.find((q) => q.id === id)).filter(Boolean).map((q) => ({ id: q.id, question: q.question, recommended: q.options[0].label, means: q.options[0].description, summary: q.summary }));
        return { kind: "bundle", items, reshown: p.reshown, topic: t.topic, budget: t.budget };
      }
      return { kind: "none", reason: p.reason, drafts: (p.drafts ?? []).map((q) => ({ id: q.id, problems: q.problems })), s: summarize(t), topic: t.topic };
    });
    if (r.kind === "question") {
      if (r.first) log("discuss_question_shown", { topic: r.topic, question: r.q.id, kind: r.q.kind, wait_s: secs(r.q.raised_at, r.q.shown_at) ?? 0 });
      if (o.json) process.stdout.write(JSON.stringify({ question: { id: r.q.id, kind: r.q.kind, by: r.q.by, summary: r.q.summary, show: r.q.show, question: r.q.question, options: cardOptions(r.q), parks: r.q.parks }, waiting: r.waiting, reshown: r.reshown, answered_since: r.since }) + "\n");
      else process.stdout.write(renderQuestion(r.q, r));
      return;
    }
    if (r.kind === "bundle") {
      if (!r.reshown) log("discuss_bundle_shown", { topic: r.topic, questions: r.items.length });
      const question = bundleQuestion(r.items.length);
      if (o.json) { process.stdout.write(JSON.stringify({ bundle: { items: r.items, question, options: BUNDLE_OPTIONS }, reshown: r.reshown }) + "\n"); return; }
      process.stdout.write([`${r.items.length} smaller questions are left and ${r.budget} cards have been shown. Show them together:`, "", "WRITE THIS TABLE IN THE CHAT (question, recommended answer, what it means):", ...r.items.map((x) => `  ${x.id} | ${x.question} | ${x.recommended} | ${x.means}`), "", "QUESTION (the card's question, word for word):", question, "", "CHOICES:", ...BUNDLE_OPTIONS.map((x, i) => `  ${i + 1}. ${x.label} — ${x.description}`), "", "Then record it: shipyard-data discuss-questions answer-bundle --accept   (or --one-by-one)"].join("\n") + "\n");
      return;
    }
    const why = { draft: `nothing can be shown: ${r.drafts.map((d) => d.id).join(", ")} ${r.drafts.length === 1 ? "is a draft" : "are drafts"} — reword with \`discuss-questions revise <Q#> …\`:\n${r.drafts.map((d) => `  ${d.id}: ${d.problems.join("; ")}`).join("\n")}`, research_running: "an approval is waiting, but research is still running: approvals are shown once every decision is in. Wait: `shipyard-data discuss-questions wait` (run it in the background and end your turn)", research_parked: "no question is waiting; research is parked. Resume the researcher with the answers it is waiting for", none: `no question is waiting (${r.s.answered} answered, ${r.s.dropped} dropped)` }[r.reason] ?? "no question is waiting; research is still running. Wait: `shipyard-data discuss-questions wait` (run it in the background and end your turn)";
    if (o.json) process.stdout.write(JSON.stringify({ question: null, reason: r.reason, research: r.s.research, drafts: r.drafts }) + "\n"); else process.stdout.write(why + "\n");
    // Only a draft needs action. "Nothing is waiting" is an ordinary answer (4.0.1): as exit 3 it showed the person a red error after every last answer.
    process.exit(r.reason === "draft" ? 3 : 0);
  }

  if (sub === "answer") {
    const id = o._[0];
    if (!id) usage("answer needs a question id (Q#)");
    if ([o.choice !== undefined, o.text !== undefined, Boolean(o["you-decide"])].filter(Boolean).length !== 1) usage("answer needs exactly one of --choice <n>, --text \"...\" or --you-decide");
    const r = withTopic((t) => {
      const q = t.questions.find((x) => x.id === id);
      if (!q) return { error: `${id} is not in topic ${t.topic}` };
      if (q.status === "answered") return { error: `${id} is already answered (${q.answer.label || q.answer.text})` };
      if (q.status === "dropped" || q.status === "draft") return { error: `${id} is ${q.status}${q.status === "draft" ? ": revise it and ask it first" : ` (${q.drop_reason})`}` };
      let answer;
      if (o["you-decide"] && !q.options.length) return { error: `${id} has no choices to fall back on: record their words with --text` };
      if (o["you-decide"]) {
        answer = { choice: 1, label: q.options[0].label, text: "", you_decide: true };
        t.assumptions.push({ statement: `${q.question} → ${q.options[0].label}`, basis: "the person left it to Shipyard; this was the recommended answer", by: "main", at: now() });
      } else if (o.choice !== undefined) {
        const n = Number(o.choice);
        if (!Number.isInteger(n) || n < 1 || n > q.options.length) return { error: `${id} has choices 1 to ${q.options.length}` };
        answer = { choice: n, label: q.options[n - 1].label, text: "" };
      } else answer = { choice: null, label: "", text: String(o.text).trim().slice(0, 2000) };
      if (!q.shown_at) q.shown_at = now();
      Object.assign(q, { status: "answered", answered_at: now(), answer, answer_seq: ++t.answer_seq });
      return { q: { ...q }, left: t.questions.filter(isOpen).length, topic: t.topic };
    });
    log("discuss_question_answered", { topic: r.topic, question: id, choice: r.q.answer.you_decide ? "you decide" : r.q.answer.choice ?? "own words", wait_s: secs(r.q.shown_at, r.q.answered_at) ?? 0 });
    process.stdout.write(`${id} answered: ${r.q.answer.label || r.q.answer.text}${r.q.answer.you_decide ? " (left to you; recorded as ASSUMED)" : ""}. ${r.left ? `${r.left} more waiting: run \`discuss-questions next\`.` : "No question is waiting."}\n`);
    return;
  }

  if (sub === "ask-again") {
    const id = o._[0];
    if (!id || !String(o["their-words"] ?? "").trim()) usage("ask-again needs a question id (Q#) and --their-words \"<what they said>\"");
    const f = fields();
    const r = withTopic((t) => {
      const q = t.questions.find((x) => x.id === id);
      if (!q) return { error: `${id} is not in topic ${t.topic}` };
      if (!["asked", "answered"].includes(q.status)) return { error: `${id} is ${q.status}: only a question that was shown can be asked again` };
      if (q.status === "answered" && q.picked_up_at) return { error: `${id}'s answer was already read by the researcher: add a new question instead` };
      q.replies = [...(Array.isArray(q.replies) ? q.replies : []), { text: String(o["their-words"]).trim().slice(0, 2000), at: now() }];
      for (const [k, v] of Object.entries(f)) if (v !== undefined) q[k] = k === "weight" ? (v === "high" ? "high" : "normal") : typeof v === "string" ? v.trim() : v;
      Object.assign(q, { answer: null, answered_at: null, unlisted: false });
      delete q.answer_seq; // not an answer any more: `answers --after` must not list it
      q.problems = shapeOf(q);
      q.status = q.problems.length ? "draft" : "open";
      return { q: { ...q }, topic: t.topic };
    });
    log("discuss_question_asked_again", { topic: r.topic, question: id, times: r.q.replies.length });
    if (r.q.status === "draft") refuse(`${id} is open again but cannot be shown yet:\n  - ${r.q.problems.join("\n  - ")}\n  Fix it: shipyard-data discuss-questions revise ${id} <the corrected flags>`);
    process.stdout.write(`${id} is open again; their words are kept ("${r.q.replies.at(-1).text.slice(0, 120)}"). Nothing is recorded as their answer. Run \`discuss-questions next\`: write your advice above the card, then ask it.\n`);
    return;
  }

  if (sub === "answer-bundle") {
    if (Boolean(o.accept) === Boolean(o["one-by-one"])) usage("answer-bundle needs exactly one of --accept or --one-by-one");
    const r = withTopic((t) => {
      if (!t.bundle) return { error: "no bundle card is waiting" };
      const ids = t.bundle.ids;
      t.bundle = null;
      if (o["one-by-one"]) { t.one_by_one = true; return { n: ids.length, accepted: false, topic: t.topic }; }
      for (const id of ids) {
        const q = t.questions.find((x) => x.id === id);
        if (!q || q.status !== "open") continue;
        Object.assign(q, { status: "answered", shown_at: q.shown_at ?? now(), answered_at: now(), answer: { choice: 1, label: q.options[0].label, text: "", you_decide: true }, answer_seq: ++t.answer_seq });
        t.assumptions.push({ statement: `${q.question} → ${q.options[0].label}`, basis: "accepted with the other smaller questions; this was the recommended answer", by: "main", at: now() });
      }
      return { n: ids.length, accepted: true, topic: t.topic };
    });
    log("discuss_bundle_answered", { topic: r.topic, questions: r.n, accepted: r.accepted ? "yes" : "no" });
    process.stdout.write(r.accepted ? `${r.n} questions answered with their recommended option (each recorded as ASSUMED)\n` : `the ${r.n} questions will be asked one at a time: run \`discuss-questions next\`\n`);
    return;
  }

  if (sub === "answers") {
    const after = Number(o.after ?? 0) || 0;
    const r = withTopic((t) => {
      const fresh = t.questions.filter((q) => (q.answer_seq ?? 0) > after).sort((a, b) => a.answer_seq - b.answer_seq);
      if (o.ack) for (const q of fresh) if (q.status === "answered" && (!o.by || q.by === o.by) && !q.picked_up_at) q.picked_up_at = now();
      return {
        answers: fresh.map((q) => ({ id: q.id, by: q.by, question: q.question, status: q.status, answer: q.status === "answered" ? (q.answer.label || q.answer.text) : null, own_words: q.status === "answered" && !q.answer.label, left_to_you: Boolean(q.answer?.you_decide), dropped: q.status === "dropped" ? q.drop_reason : null })),
        open: t.questions.filter(isOpen).map((q) => q.id), cursor: t.answer_seq,
      };
    });
    if (o.json) { process.stdout.write(JSON.stringify(r) + "\n"); return; }
    for (const a of r.answers) process.stdout.write(a.dropped ? `${a.id} dropped: ${a.dropped}\n` : `${a.id} "${a.question}" → ${a.answer}${a.own_words ? " (their own words)" : a.left_to_you ? " (left to Shipyard: the recommended answer)" : ""}\n`);
    process.stdout.write(`${r.answers.length ? "" : "nothing new. "}still open: ${r.open.join(", ") || "none"}. cursor=${r.cursor}\n`);
    return;
  }

  if (sub === "drop") {
    const id = o._[0];
    if (!id || !String(o.reason ?? "").trim()) usage("drop needs a question id and --reason");
    const r = withTopic((t) => {
      const q = t.questions.find((x) => x.id === id);
      if (!q) return { error: `${id} is not in topic ${t.topic}` };
      if (q.kind === "gate") return { error: `${id} is an approval: it is answered, never dropped` };
      if (q.status === "asked") return { error: `${id} is on the person's screen: let them answer it` };
      if (!isOpen(q)) return { error: `${id} is already ${q.status}` };
      Object.assign(q, { status: "dropped", drop_reason: String(o.reason).trim(), answered_at: now(), answer_seq: ++t.answer_seq });
      return { topic: t.topic };
    });
    log("discuss_question_dropped", { topic: r.topic, question: id });
    process.stdout.write(`${id} dropped; it is listed before approval so the person can ask for it back\n`);
    return;
  }

  if (sub === "sources") {
    const one = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
    const began = lockStart(dataDir);
    // no question list in this discussion: the record still has a home
    if (!o.topic && !readState(dataDir).current) o.topic = FALLBACK_TOPIC;
    const given = { wiki: one(o.wiki), tracker: one(o.tracker), drive: one(o.drive) };
    const project = one(o.project), external = one(o.external), said = one(o["person-said"]);
    if (o.internal !== undefined) usage('sources takes one line per kind of source: --wiki "..." --tracker "..." --drive "..." (each: what was searched and found, or "not connected", or "not relevant: <why>"), plus --external "..." and optionally --project "<the project\'s own documents read>"');
    const any = Object.values(given).some(Boolean) || project || external;
    const r = withTopic((t) => {
      if (t.topic === FALLBACK_TOPIC && began && Date.parse(t.started_at ?? "") < Date.parse(began) - 1000) Object.assign(t, { started_at: now(), sources: null }); // an earlier discussion's record
      const prev = t.sources;
      if (!prev && said) return { error: "the person is asked after they have seen where the research looked: record --wiki, --tracker, --drive and --external first; the command prints the table and the question to show them" };
      if (!prev && (!given.wiki || !given.tracker || !given.drive || external.length < 4)) return { error: 'sources needs one line per kind of source: --wiki "..." --tracker "..." --drive "..." and --external "...". Each is what was searched and what was found, or "not connected" (this session has no such tool), or "not relevant: <why>"' };
      if (prev && !any && !said) return { error: "sources needs something to add: --wiki, --tracker, --drive, --project, --external or --person-said" };
      // What was called is a fact (the source-ledger hook counts it). A line that claims a search with no call of
      // that kind behind it is refused: notes from memory are not a search. Seen live twice: "looked at: memory:
      // pricing sheets (Drive)" with no call at all, then one tracker search standing for all three.
      const m = measuredSources(dataDir, began && Date.parse(began) < Date.parse(t.started_at ?? "") ? began : t.started_at);
      const names = { wiki: "wiki", tracker: "tracker", drive: "shared-drive" };
      const avail = availableSources(dataDir);
      for (const k of Object.keys(given)) {
        const v = given[k];
        if (!v) continue;
        // What is connected is a fact too: the hooks record which kinds of source this session has tools for
        // (`sources_available`), and a kind this project has ever called is connected.
        const tool = (avail && avail[k]) || everRead(dataDir)[k]?.tool || "";
        if (/^not connected\b/i.test(v)) {
          if (tool) return { error: `--${k} says not connected, but this session has ${names[k]} tools (for example ${tool}). Search it for the topic, the release, the ticket keys and the product and device names, then record what you found; "searched <what>: nothing relevant" is a fine answer after a real search` };
          continue;
        }
        if (/^not relevant\s*:/i.test(v)) {
          // Whether a source has anything to say is found by looking, not by deciding beforehand.
          if (tool && m[k] === 0) return { error: `--${k} says not relevant, but the ${names[k]} is connected (for example ${tool}) and was not searched. Search it first; "searched <what>: nothing relevant" is a fine answer after a real search` };
          if (v.replace(/^not relevant\s*:/i, "").trim().length < 10) return { error: `--${k}: "not relevant:" needs the reason` };
          continue;
        }
        if (m[k] === 0) return { error: `--${k} says the ${names[k]} was searched, but no ${names[k]} tool was called in this discussion (counted: ${measuredLine(m)}). Notes from memory are not a search. Search it for the topic, the release, the ticket keys and the product and device names, read what matches, then record again.${tool ? "" : ` If this session has no ${names[k]} tool: --${k} "not connected".`}` };
      }
      const merge = (a, b) => (!b ? a ?? "" : !a ? b : a.includes(b) ? a : `${a}; ${b}`).slice(0, 1200);
      t.sources = {
        measured: measuredLine(m),
        wiki: merge(prev?.wiki, given.wiki), tracker: merge(prev?.tracker, given.tracker), drive: merge(prev?.drive, given.drive), project: merge(prev?.project, project),
        external: merge(prev?.external, external), person_said: said ? said.slice(0, 1000) : prev?.person_said ?? "", by: o.by ?? prev?.by ?? "", at: now(),
      };
      return { topic: t.topic, asked: Boolean(t.sources.person_said), src: { ...t.sources } };
    }, { create: true });
    log("discuss_sources_recorded", { topic: r.topic, by: o.by ?? "", person_asked: r.asked ? "yes" : "no" });
    if (r.asked) { process.stdout.write("recorded where the research looked and what the person said about documents it could not reach\n"); return; }
    process.stdout.write([
      "recorded where the research looked. Still owed: show the person this table and ask whether a document exists that this session cannot reach (a PDF, a contract, a spec sheet, an email).",
      "", "SHOW (write this in the chat as it is, under a summary of 40 words or fewer; then the line \"Question follows.\" ends your turn):",
      ...sourcesTable(r.src),
      "", "QUESTION (the card, word for word): Is there a document I could not reach?",
      "CHOICES: 1. No, that is everything (Recommended) — Carry on with what was found   2. Yes, here is the path — Give a file path, or paste it   3. Yes, but it cannot be shared — Say what it tells us",
      "", 'Then read what they give (the Read tool opens PDFs) and record their answer: shipyard-data discuss-questions sources --person-said "<their answer>"',
    ].join("\n") + "\n");
    return;
  }

  if (sub === "research") {
    if (!RESEARCH_STATES.includes(o.state)) usage(`research needs --state ${RESEARCH_STATES.join("|")}`);
    if (o.state === "abandoned" && !String(o.note ?? "").trim()) usage("research --state abandoned needs --note \"<why>\"");
    const r = withTopic((t) => {
      if (o.state === "done") {
        const unread = t.questions.filter((q) => q.status === "answered" && q.by && q.by !== "main" && (!o.by || q.by === o.by) && !q.picked_up_at).map((q) => q.id);
        if (unread.length) return { error: `not done yet: the answer to ${unread.join(", ")} has not been read. Read them (shipyard-data discuss-questions answers --after 0 --ack${o.by ? ` --by ${o.by}` : ""}), fold them into your findings, then mark done.` };
      }
      t.research = { state: o.state, by: o.by ?? t.research.by ?? "", at: now(), note: String(o.note ?? "").trim() };
      return { topic: t.topic, open: t.questions.filter(isOpen).map((q) => q.id) };
    }, { create: true });
    log("discuss_research_state", { topic: r.topic, state: o.state, by: o.by ?? "" });
    process.stdout.write(`research is ${o.state}${r.open.length ? `; ${r.open.length} question(s) still waiting for the person (${r.open.join(", ")})` : ""}\n`);
    return;
  }

  if (sub === "wait") {
    const timeout = Math.max(1, Math.min(3600, Number(o.timeout ?? 240) || 240));
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    const start = Date.now();
    for (;;) {
      const s = readState(dataDir);
      const t = s.topics[o.topic ?? s.current ?? ""];
      if (!t) refuse("no topic to wait on: pass --topic <slug> or start one");
      const p = pickNext(t);
      if (p.kind !== "none" || p.reason === "draft") { process.stdout.write("wake: a question is ready — run `shipyard-data discuss-questions next`\n"); return; }
      if (["parked", "done", "abandoned"].includes(t.research.state)) { process.stdout.write(`wake: research is ${t.research.state}${t.research.note ? ` (${t.research.note})` : ""}\n`); return; }
      if (Date.now() - start >= timeout * 1000) { process.stdout.write(`wake: timeout — no question and no word from research in ${timeout}s. Check the researcher is still alive; if it is gone, record \`research --state abandoned --note "<why>"\` and do the research inline.\n`); return; }
      Atomics.wait(sleep, 0, 0, 1000);
    }
  }

  if (sub === "status") {
    const s = readState(dataDir);
    const name = o.topic ?? s.current;
    const t = name ? s.topics[name] : null;
    if (!t) {
      const all = Object.values(s.topics).map(summarize);
      if (o.json) process.stdout.write(JSON.stringify({ current: s.current, topics: all }) + "\n");
      else process.stdout.write(all.length ? all.map((x) => `${x.topic}: ${x.draft + x.open + x.asked} waiting, ${x.answered} answered`).join("\n") + "\n" : "no discussion has a question list\n");
      return;
    }
    const sum = summarize(t);
    if (o.json) { process.stdout.write(JSON.stringify({ ...sum, sources: t.sources ?? null, questions: t.questions.map((q) => ({ id: q.id, kind: q.kind, status: q.status, by: q.by, question: q.question, answer: q.answer ? (q.answer.label || q.answer.text) : null, drop_reason: q.drop_reason ?? null, raised_to_shown_s: secs(q.raised_at, q.shown_at), shown_to_answered_s: secs(q.shown_at, q.answered_at) })), assumed: t.assumptions }) + "\n"); return; }
    process.stdout.write(`${t.topic}${boundTo(t).length ? ` (${boundTo(t).join(", ")})` : ""}: ${sum.draft + sum.open + sum.asked} waiting, ${sum.answered} answered, ${sum.dropped} dropped; ${sum.assumptions} assumed; research ${sum.research}\n`);
    for (const q of t.questions) process.stdout.write(`  ${q.id} ${q.status.padEnd(8)} ${q.question}${q.status === "answered" ? ` → ${q.answer.label || q.answer.text}` : q.status === "dropped" ? ` (dropped: ${q.drop_reason})` : ""}\n`);
    for (const a of t.assumptions) process.stdout.write(`  ASSUMED: ${a.statement} — ${a.basis}\n`);
    if (t.sources) process.stdout.write(`  LOOKED AT:\n${sourcesTable({ ...t.sources, measured: t.sources.measured ?? "" }).map((l) => `    ${l}`).join("\n")}\n  OTHER DOCUMENTS (the person, when asked): ${t.sources.person_said || "not asked yet"}\n`);
    else if (t.needs_sources) process.stdout.write("  LOOKED AT: not recorded yet (`discuss-questions sources --wiki … --tracker … --drive … --external …`)\n");
    if (sum.raised_to_shown_seconds.median !== null) process.stdout.write(`raised to shown: median ${sum.raised_to_shown_seconds.median}s, longest ${sum.raised_to_shown_seconds.max}s; cards shown: ${sum.cards_shown}\n`);
    return;
  }

  if (sub === "reset") {
    const r = mutate(dataDir, (state) => {
      const name = o.topic ?? state.current;
      const t = name ? state.topics[name] : null;
      if (!t) return { none: true };
      const open = t.questions.filter(isOpen);
      if (open.length && !o.force) return { error: `${open.length} question(s) still waiting (${open.map((q) => q.id).join(", ")}): ask them, or \`drop <Q#> --reason\` the ones research answered. To stop for now and keep them, use \`discuss-questions pause\`.` };
      // The list is the record of where the research looked: it is not closed before that is said and the person
      // was asked about what no session can reach. Seen live: a discussion ran `reset` and then released its lock,
      // and the end-of-discussion check found no topic to read.
      if (t.needs_sources && !o.force) {
        if (!t.sources) return { error: `the question list cannot be closed yet: the research has not said where it looked. Search the organisation's own sources this session can reach (wiki, tracker, shared drive), then outside, and record: shipyard-data discuss-questions sources --wiki "…" --tracker "…" --drive "…" --external "…" (each: searched and found | not connected | not relevant: <why>)` };
        if (!t.sources.person_said) return { error: 'the question list cannot be closed yet: the person has not been asked whether a document exists that this session cannot reach. Show them what the research looked at (`discuss-questions status`), ask once, read what they give, and record: shipyard-data discuss-questions sources --person-said "<their answer>"' };
      }
      const s = summarize(t);
      delete state.topics[name];
      if (state.current === name) state.current = null;
      return { s };
    });
    if (r.error) refuse(r.error);
    if (r.none) { process.stdout.write("no question list to close\n"); return; }
    try { rmSync(showDir(dataDir, r.s.topic), { recursive: true, force: true }); } catch { /* nothing to remove */ } // a discussion leaves nothing behind
    log("discuss_questions_closed", { topic: r.s.topic, total: r.s.total, cards: r.s.cards_shown, answered: r.s.answered, dropped: r.s.dropped, assumed: r.s.assumptions, raised_to_shown_median_s: r.s.raised_to_shown_seconds.median ?? "", raised_to_shown_max_s: r.s.raised_to_shown_seconds.max ?? "" });
    process.stdout.write(`question list closed: ${r.s.cards_shown} cards shown, ${r.s.answered} answered, ${r.s.dropped} dropped, ${r.s.assumptions} assumed\n`);
    return;
  }
  usage(`unknown subcommand "${sub ?? ""}"`);
}
