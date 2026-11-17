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
import { readSources, findSource, toolBelongs } from "./sources.mjs";

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
  let bound = false;
  for (const t of Object.values(readState(dataDir).topics)) {
    if (!storyId || !boundTo(t).includes(String(storyId))) continue;
    bound = true;
    // Where the research looked is on record before approval (4.0.1). The owner: "as part of discuss make sure
    // research looks at datasources internal as well as the usual external". After 4.0.3 the sources are the
    // ones the project names, looked at when they could matter (`sourcesGap`). Only topics started since 4.0.1.
    if (t.needs_sources) { const gap = sourcesGap(dataDir, t.sources); if (gap && !out.includes(GAP_TEXT[gap])) out.push(GAP_TEXT[gap]); }
    const waiting = t.questions.filter(isOpen);
    if (waiting.length) out.push(`${waiting.length} question(s) of this discussion are not answered yet (${waiting.map((q) => q.id).join(", ")}): ask them (\`discuss-questions next\`), or \`drop\` the ones research answered`);
    if (["running", "parked"].includes(t.research.state)) out.push(`the background research is ${t.research.state}: let it finish with the answers (\`discuss-questions research --state done\`), or record \`--state abandoned --note "<why>"\``);
    else if (t.research.state !== "abandoned") { const unread = summarize(t).unread_answers; if (unread.length) out.push(`the researcher has not read the answer to ${unread.join(", ")}: resume it with those answers, or record \`research --state abandoned --note "<why>"\` and fold them in yourself`); }
  }
  // A story with no topic of its own, approved by the session that holds the discussion (after 4.0.2, live: two
  // stories were approved on one card; the one bound to a topic was refused for its sources, the other went
  // through, and the session reported "the approval only half went through"). The rule is the discussion's, so
  // it is keyed on the lock, as at the lock's release; a topic is optional and a gate keyed on it is skipped by
  // not making one. Another session approving beside the discussion, and the quick lanes, owe nothing.
  if (storyId && !bound) {
    let lock = null;
    try { const o = JSON.parse(readFileSync(join(dataDir, ".active-discuss.json"), "utf8")); lock = o && o.skill && !o.cleared ? o : null; } catch { lock = null; }
    const me = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
    if (lock && me && String(lock.session_id ?? "") === me) {
      const t0 = Date.parse(lock.started ?? "");
      let last = null, quick = false;
      let text = "";
      try { text = readFileSync(join(dataDir, ".shipyard-events.jsonl"), "utf8"); } catch { text = ""; }
      for (const line of text.split("\n")) {
        if (!line.includes('"discuss_sources_recorded"') && !line.includes('"intake_lane_confirmed"')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (Number.isFinite(t0) && Date.parse(e.ts) < t0 - 1000) continue;
        if (e.type === "discuss_sources_recorded") last = e;
        if (e.type === "intake_lane_confirmed") quick = ["land-now", "capture", "hotfix"].includes(e.lane);
      }
      const gap = quick ? "" : gapFromLog(dataDir, last);
      if (gap && !out.includes(GAP_TEXT[gap])) out.push(GAP_TEXT[gap]);
    }
  }
  return out;
}
const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
/**
 * Calls the `source-ledger` hook logged since `since`: per named source (by a word in the tool's name), the
 * web, and connectors that are no named source of this project (`other`: shown, so the owner sees them).
 */
export function namedCalls(dataDir, since, sources) {
  const out = { by: Object.fromEntries(sources.map((s) => [s.name, 0])), web: 0, other: 0 };
  const t0 = Date.parse(since ?? "");
  let text = "";
  try { text = readFileSync(join(dataDir, ".shipyard-events.jsonl"), "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line.includes('"source_read"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "source_read") continue;
    if (Number.isFinite(t0) && Date.parse(e.ts) < t0 - 1000) continue;
    if (e.source === "web") { out.web += 1; continue; }
    const hit = sources.filter((s) => toolBelongs(s, e.name || e.tool));
    if (hit.length) for (const s of hit) out.by[s.name] += 1; else out.other += 1;
  }
  return out;
}
const measuredLine = (c, sources) => [...sources.filter((s) => s.tool).map((s) => `${s.name} ${c.by[s.name] ?? 0}`), `web ${c.web}`, ...(c.other ? [`connectors this project does not name ${c.other}`] : [])].join(", ");
const STATE_WORD = { looked: "searched", skipped: "not needed", unreachable: "could not reach" };
/** The "looked at" table. A record made before the sources were the project's own had three fixed kinds. */
const sourcesTable = (x) => (Array.isArray(x.lines)
  ? ["| Where | What was looked at |", "|---|---|", ...(x.project ? [`| The project's own code and documents | ${x.project} |`] : []), ...x.lines.map((l) => `| ${l.name} | ${STATE_WORD[l.state] ?? l.state}: ${l.text} |`), ...(x.external ? [`| Outside | ${x.external} |`] : []), `| Tool calls counted | ${x.measured || "-"} |`]
  : ["| Where | What was searched and found |", "|---|---|", `| Wiki | ${x.wiki || "-"} |`, `| Tracker | ${x.tracker || "-"} |`, `| Shared drive | ${x.drive || "-"} |`, ...(x.project ? [`| The project's own documents | ${x.project} |`] : []), `| Outside | ${x.external || "-"} |`, `| Tool calls counted | ${x.measured} |`]);

/**
 * What a discussion's record of where it looked still lacks: "" | "registry" | "sources" | "person".
 *
 * After 4.0.3 (the owner: "shipyard is forcing jira, confluence google drive search … sometimes its not
 * necessary at all"): the sources are the ones the project names (`shipyard-data sources`), so
 *   registry  the owner was never asked where the project's knowledge lives (asked once per project);
 *   sources   the project names sources and the record does not say, for each, searched / not needed / could
 *             not reach (a project that names none owes no record);
 *   person    the research left a fact open (`--open`) and the person was not asked about a document the
 *             session cannot reach. With nothing open they are not asked.
 * A record made before this (three fixed kinds) is complete.
 */
export function sourcesGap(dataDir, rec) {
  const reg = readSources(dataDir);
  if (!reg.decided) return "registry";
  if (rec && rec.open && !rec.person_said) return "person";
  if (!reg.sources.length || (rec && !Array.isArray(rec.lines))) return "";
  if (!rec) return "sources";
  return reg.sources.some((s) => !rec.lines.some((l) => sameName(l.name, s.name))) ? "sources" : "";
}
/** The same, from the last `discuss_sources_recorded` event of a discussion (a closed list took its record with it). */
function gapFromLog(dataDir, last) {
  const reg = readSources(dataDir);
  if (!reg.decided) return "registry";
  if (last) return last.owed === "person" ? "person" : "";
  return reg.sources.length ? "sources" : "";
}
export const GAP_TEXT = Object.freeze({
  registry: 'this project has not said where its knowledge lives, besides the code. The owner is asked once: `shipyard-data sources suggest` prints the question, and their answer is recorded with `shipyard-data sources none --answer "<their words>"` or `shipyard-data sources add "<name>" … --answer "<their words>"`',
  sources: 'the research has not said where it looked. For each source this project names (`shipyard-data sources list`), one line: `shipyard-data discuss-questions sources --looked "<name>: <what was searched and found>"`, `--skipped "<name>: <why this piece of work does not need it>"` or `--unreachable "<name>: <why>"`',
  person: 'a fact was left open and the person has not been asked whether a document exists that this session cannot reach (a PDF, a contract, a spec sheet, an email): show them where the research looked, ask, read what they give, and record `shipyard-data discuss-questions sources --person-said "<their answer>"`',
});

/**
 * What a discussion still owes about its sources before it ends, or null. Read by `lock release discuss`:
 * a discussion that breaks an epic into a spike and draft stories never reaches an approval, so the approval
 * gate alone would let it end without saying where it looked (seen live: "I have not read the Google Drive
 * hardware documents yet").
 */
export function sourcesOwed(dataDir, since, events = []) {
  const t0 = Date.parse(since ?? "");
  const inWindow = (e) => !Number.isFinite(t0) || Date.parse(e.ts) >= t0 - 1000;
  const mine = Object.values(readState(dataDir).topics).filter((t) => t.needs_sources && !(Number.isFinite(t0) && Date.parse(t.started_at ?? "") < t0 - 1000));
  for (const t of mine) {
    if (t.topic === FALLBACK_TOPIC) continue;
    const gap = sourcesGap(dataDir, t.sources);
    if (gap && gap !== "registry") return { topic: t.topic, missing: gap };
  }
  // A discussion that wrote specs without ever opening a question list owes the same (seen live: an idea was
  // refined into an epic through free cards, and nothing asked where the research had looked).
  const wrote = events.some((e) => inWindow(e) && (WROTE_SPECS.has(e.type) || (e.type === "model_state_file_write" && /[\\/]spec[\\/](epics|stories|tasks|features|bugs)[\\/]/.test(String(e.file ?? "")))));
  if (!wrote) return null;
  // The quick lanes (a thought captured, a tiny change filed to land now, a hotfix) do no research: nothing is owed.
  const lane = [...events].reverse().find((e) => e.type === "intake_lane_confirmed" && inWindow(e))?.lane;
  if (["land-now", "capture", "hotfix"].includes(lane)) return null;
  // A question list that was closed took its record with it; the log remembers what it still owed
  // (seen live: the session had to record its sources a second time to release the lock).
  const gap = gapFromLog(dataDir, [...events].reverse().find((e) => e.type === "discuss_sources_recorded" && inWindow(e)) ?? null);
  return gap ? { topic: mine.find((t) => t.sources)?.topic ?? FALLBACK_TOPIC, missing: gap } : null;
}
const FALLBACK_TOPIC = "discussion"; // where `sources` is kept when a discussion has no question list
const WROTE_SPECS = new Set(["idea_promoted", "idea_imported", "idea_captured", "story_imported", "task_imported", "tracker_pulled", "story_added", "task_added", "story_refined"]);
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
      if (a === "--option") o.option.push(v); else if (["--looked", "--skipped", "--unreachable"].includes(a)) (o[a.slice(2)] ??= []).push(v); else o[a.slice(2)] = v;
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
      "         discuss-questions sources [--looked \"<source>: <searched, found>\"] [--skipped \"<source>: <why not needed>\"] [--unreachable \"<source>: <why>\"] [--project \"...\"] [--external \"...\"] [--open \"<a fact a document could settle>\"] [--by <who>]\n" +
      "                 (one line per source the project names: shipyard-data sources list; --owner-said \"<their words>\" lets an always-looked-at source be skipped this once)\n" +
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
    for (const gone of ["wiki", "tracker", "drive", "internal"]) if (o[gone] !== undefined) usage(`--${gone} is gone: the sources are the ones this project names (shipyard-data sources list), not a fixed list. One line per named source: --looked "<name>: <what was searched and found>", --skipped "<name>: <why this piece of work does not need it>" or --unreachable "<name>: <why>"`);
    const reg = readSources(dataDir);
    if (!reg.decided) refuse(GAP_TEXT.registry);
    const project = one(o.project), external = one(o.external), said = one(o["person-said"]), open = one(o.open), ownerSaid = one(o["owner-said"]);
    const named = reg.sources.length ? `Its sources: ${reg.sources.map((x) => x.name).join(", ")}` : "It names none: its knowledge is in the repository, and nothing is owed about other places";
    const given = [];
    for (const state of ["looked", "skipped", "unreachable"]) for (const raw of o[state] ?? []) {
      const i = String(raw).indexOf(":");
      const name = one(i === -1 ? raw : String(raw).slice(0, i)), text = one(i === -1 ? "" : String(raw).slice(i + 1));
      const src = findSource(reg.sources, name);
      // A place the project did not name is not one of its sources, whatever tools the session has.
      if (!src) refuse(`--${state} "${name}": this project names no such source. ${named}. A place the owner did not name is not searched for this project; when they say it belongs, \`shipyard-data sources add "<name>" --holds "…" --answer "<their words>"\``);
      if (text.length < (state === "looked" ? 4 : 10)) refuse(`--${state} "${src.name}: …" needs ${state === "looked" ? "what was searched and what was found" : "the reason, in a few words"}`);
      if (given.some((g) => sameName(g.name, src.name))) refuse(`${src.name} is given twice: one line per source`);
      given.push({ name: src.name, state, text: text.slice(0, 600) });
    }
    const any = given.length > 0 || Boolean(project || external || open);
    const r = withTopic((t) => {
      if (t.topic === FALLBACK_TOPIC && began && Date.parse(t.started_at ?? "") < Date.parse(began) - 1000) Object.assign(t, { started_at: now(), sources: null }); // an earlier discussion's record
      const prev = t.sources;
      if (!prev && said && !any) return { error: "the person is asked after they have seen where the research looked: record that first (--looked, --skipped, --unreachable, --project, --open); the command prints the table and the question to show them" };
      if (!any && !said) return { error: 'sources needs something to record: --looked, --skipped or --unreachable "<name>: …" for a source this project names, --project "<the code and documents read>", --external, --open "<a fact a document could settle>" or --person-said' };
      const prevLines = Array.isArray(prev?.lines) ? prev.lines : [];
      const all = [...prevLines.filter((l) => !given.some((g) => sameName(g.name, l.name))), ...given];
      const lines = reg.sources.map((x) => all.find((l) => sameName(l.name, x.name))).filter(Boolean); // the project's order; a removed source drops out
      if (any) {
        // Every named source gets a line: looked at, not needed for this piece of work, or out of reach. Which of
        // the three is the discussion's judgement, from what each source holds; that it says so is the rule.
        const missing = reg.sources.filter((x) => !lines.some((l) => sameName(l.name, x.name)));
        if (missing.length) return { error: `say, for each source this project names, whether this piece of work needed it. Missing: ${missing.map((x) => x.name).join(", ")}.\n${missing.map((x) => `  ${x.name}${x.always ? " (looked at every time)" : ""}: ${x.holds || "no description"}`).join("\n")}\n  --looked "<name>: <what was searched and found>" | --skipped "<name>: <why this piece of work does not need it>" | --unreachable "<name>: <why>"` };
      }
      // What was called is a fact (the source-ledger hook counts it). A line that claims a search with no call
      // behind it is refused: notes from memory are not a search. Seen live twice: "looked at: memory: pricing
      // sheets (Drive)" with no call at all, then one tracker search standing for three places.
      const c = namedCalls(dataDir, began && Date.parse(began) < Date.parse(t.started_at ?? "") ? began : t.started_at, reg.sources);
      const measured = measuredLine(c, reg.sources);
      const lowered = ownerSaid.length >= 3 ? ownerSaid : prev?.owner_said ?? "";
      for (const g of given) {
        const src = findSource(reg.sources, g.name);
        if (g.state === "looked" && src.tool && c.by[src.name] === 0) return { error: `--looked says ${src.name} was searched, but no tool named like "${src.tool}" was called in this discussion (counted: ${measured}). Notes from memory are not a search. Search it and record again; when this piece of work does not need it, --skipped "${src.name}: <why>"; when it cannot be reached, --unreachable "${src.name}: <why>"` };
        // A bar is lowered only by the owner: "always" is theirs, so only their word leaves it out.
        if (g.state === "skipped" && src.always && !lowered) return { error: `${src.name} is looked at in every discussion (the owner's rule for this project), so it is not left out by judgement. Search it; "searched <what>: nothing relevant" is a fine answer after a real search. When the owner says to leave it out this time, add --owner-said "<their words>"; when it cannot be reached, --unreachable "${src.name}: <why>"` };
      }
      const merge = (a, b) => (!b ? a ?? "" : !a ? b : a.includes(b) ? a : `${a}; ${b}`).slice(0, 1200);
      t.sources = {
        measured, lines, project: merge(prev?.project, project), external: merge(prev?.external, external),
        open: merge(prev?.open, open), owner_said: lowered.slice(0, 300),
        person_said: said ? said.slice(0, 1000) : prev?.person_said ?? "", by: o.by ?? prev?.by ?? "", at: now(),
      };
      return { topic: t.topic, owed: t.sources.open && !t.sources.person_said ? "person" : "", src: { ...t.sources } };
    }, { create: true });
    // `person_asked` is what readers before this looked for; `owed` is what is still missing ("" or "person").
    log("discuss_sources_recorded", { topic: r.topic, by: o.by ?? "", owed: r.owed, person_asked: r.src.person_said ? "yes" : "no" });
    if (r.owed === "person") {
      process.stdout.write([
        "recorded where the research looked. A fact is still open, so the person is asked whether a document exists that this session cannot reach (a PDF, a contract, a spec sheet, an email).",
        `OPEN: ${r.src.open}`,
        "", "SHOW (write this in the chat as it is, under a summary of 40 words or fewer; then the line \"Question follows.\" ends your turn):",
        ...sourcesTable(r.src),
        "", "QUESTION (the card, word for word): Is there a document I could not reach?",
        "CHOICES: 1. No, that is everything (Recommended) — Carry on with what was found   2. Yes, here is the path — Give a file path, or paste it   3. Yes, but it cannot be shared — Say what it tells us",
        "", 'Then read what they give (the Read tool opens PDFs) and record their answer: shipyard-data discuss-questions sources --person-said "<their answer>"',
      ].join("\n") + "\n");
      return;
    }
    process.stdout.write([
      said ? "recorded what the person said about documents this session could not reach" : "recorded where the research looked",
      "", "LOOKED AT (show this table in the approval summary, as it is; the person may answer \"look there too\"):",
      ...sourcesTable(r.src),
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
    if (t.sources) process.stdout.write(`  LOOKED AT:\n${sourcesTable({ ...t.sources, measured: t.sources.measured ?? "" }).map((l) => `    ${l}`).join("\n")}\n  OTHER DOCUMENTS (the person, when asked): ${t.sources.person_said || (t.sources.open || !Array.isArray(t.sources.lines) ? "not asked yet" : "not asked: nothing was left open")}\n`);
    else if (t.needs_sources) { const gap = sourcesGap(dataDir, null); if (gap) process.stdout.write(`  LOOKED AT: not recorded yet: ${GAP_TEXT[gap]}\n`); }
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
        const gap = sourcesGap(dataDir, t.sources);
        if (gap && gap !== "registry") return { error: `the question list cannot be closed yet: ${GAP_TEXT[gap]}` };
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
