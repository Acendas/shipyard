/** v4.20: the question list of an asynchronous discussion. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { questionProblems, pickNext, QUESTIONS_BASENAME, CARD_LIMITS, approvalProblems, currentCard, bundleQuestion, waitingTopics } from "../bin/discuss-questions.mjs";
import { ASK_LIMITS, shapeProblems, decideListed } from "../bin/hooks/unattended-ask.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
const BODY = "\n## Paths\n| Ending | Covered by |\n|---|---|\n| works | @AC-1 |\n\n## Acceptance Criteria\n```gherkin\n@AC-1 @e2e\nScenario: works\n  Given a\n  When b\n  Then c\n```\n";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "dq-"));
  const d = join(base, "projects", "abc123abc123");
  mkdirSync(join(d, "spec", "stories"), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  return { base, d };
}
const run = (d, ...args) => spawnSync("node", [CLI, "discuss-questions", ...args, "--data-dir", d], { encoding: "utf8" });
const events = (d) => (existsSync(join(d, ".shipyard-events.jsonl")) ? readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const good = (question = "Should a tower bar be hidden while a hero stands in front of it?", extra = []) => [
  "add", "--summary", "A hero can stand in front of a tower. Today the tower's health bar is drawn over him. Two ways to fix it.",
  "--question", question,
  "--option", "Draw the bar first::The hero covers the bar; simplest change",
  "--option", "Move the bar up::The bar sits above the tower, never over a unit",
  "--checked", "docs/ui/rules.md, S012 decision log, src/render_bars.h", "--confidence", "medium", "--by", "deepdive-bars", ...extra,
];
const state = (d) => JSON.parse(readFileSync(join(d, QUESTIONS_BASENAME), "utf8"));

test("a topic is started first; a well-shaped question is added; a badly shaped one is kept as a draft, not lost", () => {
  const { base, d } = fixture();
  try {
    assert.equal(run(d, ...good()).status, 3, "no topic yet");
    assert.match(run(d, "start", "--topic", "tower-bars").stdout, /topic tower-bars is current/);
    let r = run(d, ...good());
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Q1 added\. Carry on with work that does not depend on it/);

    // the same words again: refused, pointing at the first
    r = run(d, ...good("should a TOWER bar be hidden while a hero stands in front of it"));
    assert.equal(r.status, 3); assert.match(r.stderr, /Q1 already asks this \(open\)/);

    // a bad shape is recorded as a draft with what is wrong, then fixed
    r = run(d, "add", "--summary", "x", "--question", "y".repeat(CARD_LIMITS.question + 1), "--option", "A::a", "--confidence", "high", "--by", "deepdive-bars");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /Q2 is kept as a DRAFT/); assert.match(r.stderr, /the question is 161 characters \(limit 160\)/);
    assert.match(r.stderr, /1 options \(give 2 to 4/); assert.match(r.stderr, /--checked is missing/); assert.match(r.stderr, /high is not a question/);
    assert.equal(state(d).topics["tower-bars"].questions[1].status, "draft");
    r = run(d, "revise", "Q2", "--question", "Is the bar 2 px or 3 px tall?", "--option", "2 px::As every other bar", "--option", "3 px::Easier to read on the device", "--checked", "render_bars.h", "--confidence", "low");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(state(d).topics["tower-bars"].questions[1].status, "open");

    // a new question lists the others, so the same thing in other words can be dropped by its author
    r = run(d, ...good("Third question?"));
    assert.match(r.stdout, /Other questions in this discussion[\s\S]*Q1 open: Should a tower bar/);
    assert.deepEqual(questionProblems({ summary: "s", question: "q?", checked: "c", confidence: "low", options: [{ label: "x".repeat(30), description: "d" }, { label: "y".repeat(30), description: "d" }] }), ['option 1: the label is 30 characters (limit 26, it carries "(Recommended)")']);
    assert.deepEqual(questionProblems({ kind: "gate", summary: "s", question: "Approve?", options: [{ label: "Approve", description: "d" }, { label: "Edit", description: "d" }] }), [], "an approval needs no --checked or --confidence");
    assert.equal(ASK_LIMITS.question, CARD_LIMITS.question, "one set of numbers for the hook and the list");
    assert.deepEqual(events(d).filter((e) => /^discuss_question_(added|drafted|revised)$/.test(e.type)).map((e) => e.type), ["discuss_question_added", "discuss_question_drafted", "discuss_question_revised", "discuss_question_added"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("next hands out one card: research-blocking first, then weight, then age; answers are read by cursor and acknowledged", () => {
  const { base, d } = fixture();
  try {
    run(d, "start", "--topic", "t");
    const show = join(base, "show.txt");
    writeFileSync(show, "  before          after\n  [hero]▓▓▓       ▓▓▓[hero]\n");
    run(d, ...good("First question?"));
    run(d, ...good("Second, a one-way door?", ["--weight", "high"]));
    run(d, ...good("Third, which parks research?", ["--parks", "the save-format branch", "--show-file", show]));

    let j = JSON.parse(run(d, "next", "--json").stdout);
    assert.equal(j.question.id, "Q3"); assert.equal(j.waiting, 2);
    assert.match(j.question.show, /before +after/);
    assert.deepEqual(j.question.options.map((o) => o.label), ["Draw the bar first (Recommended)", "Move the bar up"]);
    assert.deepEqual(shapeProblems({ questions: [{ question: j.question.question, options: j.question.options }] }), [], "what next prints passes the card hook as it is");
    j = JSON.parse(run(d, "next", "--json").stdout);
    assert.deepEqual([j.question.id, j.reshown], ["Q3", true], "asked again before an answer: the same question");
    assert.match(run(d, "next").stdout, /SHOWN BEFORE, not answered[\s\S]*SUMMARY \(write this in the chat first\)[\s\S]*SHOW[\s\S]*QUESTION[\s\S]*1\. Draw the bar first \(Recommended\) — /);
    assert.equal(run(d, "drop", "Q3", "--reason", "x").status, 3, "a question on the person's screen is answered, not dropped");

    assert.equal(run(d, "answer", "Q3").status, 2);
    assert.equal(run(d, "answer", "Q3", "--choice", "3").status, 3);
    let r = run(d, "answer", "Q3", "--choice", "2");
    assert.match(r.stdout, /Q3 answered: Move the bar up\. 2 more waiting/);
    assert.equal(run(d, "answer", "Q3", "--choice", "1").status, 3, "an answer is not overwritten");

    r = run(d, "next");
    assert.match(r.stdout, /^Q2 /, "the one-way door before the older plain question");
    assert.match(r.stdout, /Answered since this was raised[\s\S]*Q3 "Third, which parks research\?" → Move the bar up/);
    run(d, "answer", "Q2", "--text", "Neither. Hide the bar while a hero overlaps it.");
    assert.equal(JSON.parse(run(d, "next", "--json").stdout).question.id, "Q1");
    r = run(d, "answer", "Q1", "--you-decide");
    assert.match(r.stdout, /Q1 answered: Draw the bar first \(left to you; recorded as ASSUMED\)/);
    r = run(d, "next");
    assert.equal(r.status, 3); assert.match(r.stdout, /no question is waiting \(3 answered, 0 dropped\)/);

    j = JSON.parse(run(d, "answers", "--json").stdout);
    assert.deepEqual(j.answers.map((a) => [a.id, a.answer, a.own_words, a.left_to_you]), [["Q3", "Move the bar up", false, false], ["Q2", "Neither. Hide the bar while a hero overlaps it.", true, false], ["Q1", "Draw the bar first", false, true]]);
    assert.equal(j.cursor, 3);
    assert.deepEqual(JSON.parse(run(d, "answers", "--after", "1", "--json").stdout).answers.map((a) => a.id), ["Q2", "Q1"], "the cursor counts answers, not question numbers");
    // the researcher cannot call its work done before it has read its answers
    run(d, "research", "--state", "running", "--by", "deepdive-bars");
    r = run(d, "research", "--state", "done", "--by", "deepdive-bars");
    assert.equal(r.status, 3); assert.match(r.stderr, /the answer to Q1, Q2, Q3 has not been read/);
    run(d, "answers", "--after", "0", "--ack", "--by", "deepdive-bars");
    assert.equal(run(d, "research", "--state", "done", "--by", "deepdive-bars").status, 0);
    const s = JSON.parse(run(d, "status", "--json").stdout);
    assert.deepEqual([s.answered, s.cards_shown, s.assumptions, s.research, s.unread_answers], [3, 3, 1, "done", []]);
    assert.match(run(d, "status").stdout, /ASSUMED: First question\? → Draw the bar first — the person left it to Shipyard/);
    assert.equal(events(d).find((e) => e.type === "discuss_question_answered" && e.question === "Q2").choice, "own words");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("an approval is shown last: after every decision, and not while research is still running", () => {
  const { base, d } = fixture();
  try {
    run(d, "start", "--topic", "t");
    let r = run(d, "add", "--kind", "gate", "--summary", "The story is written: four scenarios, one open risk.", "--question", "Approve S040 as written?", "--option", "Approve::Ready for a sprint", "--option", "Edit::Say what to change", "--by", "main");
    assert.equal(r.status, 0, r.stderr);
    run(d, ...good("A late question from the critic?", ["--by", "critic-s040"]));
    assert.equal(JSON.parse(run(d, "next", "--json").stdout).question.id, "Q2", "the decision goes before the approval, though the approval is older");
    run(d, "answer", "Q2", "--choice", "1");
    run(d, "research", "--state", "running", "--by", "critic-s040");
    r = run(d, "next", "--json");
    assert.equal(r.status, 3); assert.equal(JSON.parse(r.stdout).reason, "research_running");
    assert.equal(run(d, "drop", "Q1", "--reason", "x").status, 3, "an approval is never dropped");
    run(d, "answers", "--ack", "--by", "critic-s040"); run(d, "research", "--state", "done", "--by", "critic-s040");
    const j = JSON.parse(run(d, "next", "--json").stdout);
    assert.deepEqual([j.question.id, j.question.kind, j.question.options[0].label], ["Q1", "gate", "Approve (Recommended)"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("past the budget, the smaller questions that are left become one table and one card", () => {
  const { base, d } = fixture();
  try {
    run(d, "start", "--topic", "t", "--budget", "2");
    for (let i = 1; i <= 5; i++) run(d, ...good(`Question ${i}?`, i === 5 ? ["--weight", "high"] : []));
    for (const id of ["Q5", "Q1"]) { assert.equal(JSON.parse(run(d, "next", "--json").stdout).question.id, id); run(d, "answer", id, "--choice", "1"); }
    let r = run(d, "next", "--json");
    let j = JSON.parse(r.stdout);
    assert.deepEqual(j.bundle.items.map((x) => x.id), ["Q2", "Q3", "Q4"]);
    assert.equal(j.bundle.question, bundleQuestion(3));
    assert.deepEqual(shapeProblems({ questions: [{ question: j.bundle.question, options: j.bundle.options }] }), []);
    assert.match(run(d, "next").stdout, /WRITE THIS TABLE IN THE CHAT[\s\S]*Q2 \| Question 2\? \| Draw the bar first/);
    assert.deepEqual(currentCard(d).questions, [bundleQuestion(3)]);
    r = run(d, "answer-bundle", "--accept");
    assert.match(r.stdout, /3 questions answered with their recommended option/);
    const s = JSON.parse(run(d, "status", "--json").stdout);
    assert.deepEqual([s.answered, s.assumptions, s.open], [5, 3, 0]);
  } finally { rmSync(base, { recursive: true, force: true }); }
  const g = fixture();
  try {
    run(g.d, "start", "--topic", "t", "--budget", "1");
    for (let i = 1; i <= 3; i++) run(g.d, ...good(`Question ${i}?`));
    run(g.d, "next"); run(g.d, "answer", "Q1", "--choice", "1");
    assert.ok(JSON.parse(run(g.d, "next", "--json").stdout).bundle);
    run(g.d, "answer-bundle", "--one-by-one");
    assert.equal(JSON.parse(run(g.d, "next", "--json").stdout).question.id, "Q2", "the person asked for each one: no more bundling");
  } finally { rmSync(g.base, { recursive: true, force: true }); }
});

test("topics do not leak into each other; a paused topic keeps its questions; reset refuses while one waits", () => {
  const { base, d } = fixture();
  try {
    run(d, "start", "--topic", "a"); run(d, ...good("Question in a?"));
    run(d, "start", "--topic", "b");
    assert.equal(run(d, "next").status, 3, "topic b has nothing; a's question is not shown here");
    assert.deepEqual(waitingTopics(d), { current: "b", waiting: [{ topic: "a", ids: ["Q1"] }] });
    assert.equal(run(d, "reset").status, 0);
    assert.equal(run(d, "reset", "--topic", "a").status, 3);
    run(d, "pause");
    assert.equal(currentCard(d), null);
    assert.match(run(d, "start", "--topic", "a").stdout, /1 question\(s\) from before are waiting \(Q1\)/);
    run(d, "drop", "Q1", "--reason", "the design doc decides it");
    mkdirSync(join(d, "spec", ".questions", "a"), { recursive: true }); writeFileSync(join(d, "spec", ".questions", "a", "bars.md"), "x\n");
    const r = run(d, "reset");
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /question list closed: 0 cards shown, 0 answered, 1 dropped, 0 assumed/);
    assert.ok(!existsSync(join(d, "spec", ".questions", "a")), "the topic's show files go when the list is closed");
    assert.deepEqual(Object.keys(state(d).topics), []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the approval gate reads only the topic bound to that story", () => {
  const { base, d } = fixture();
  try {
    const story = (id) => writeFileSync(join(d, "spec", "stories", `${id}-x.md`), `---\nid: ${id}\ntitle: "Story ${id}"\ntype: feature\nstatus: proposed\nrefined: true\nstory_points: 2\n---\n${BODY}`);
    story("S040"); story("S041");
    run(d, "start", "--topic", "bars", "--story", "S040");
    run(d, ...good());
    assert.match(approvalProblems(d, "S040").join("\n"), /1 question\(s\) of this discussion are not answered yet \(Q1\)/);
    assert.deepEqual(approvalProblems(d, "S041"), []);
    const set = (id) => spawnSync("node", [CLI, "story", "set-status", id, "approved", "--data-dir", d], { encoding: "utf8" });
    let r = set("S040");
    assert.equal(r.status, 3); assert.match(r.stderr, /S040 cannot be approved yet — its discussion is not finished/);
    assert.equal(set("S041").status, 0, "another story is not held by this discussion");
    run(d, "next"); run(d, "answer", "Q1", "--choice", "1");
    run(d, "research", "--state", "parked", "--by", "deepdive-bars");
    assert.match(approvalProblems(d, "S040").join("\n"), /the background research is parked/);
    run(d, "research", "--state", "abandoned", "--note", "the agent was stopped");
    assert.deepEqual(approvalProblems(d, "S040"), []);
    assert.equal(set("S040").status, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("inside a discussion with a current topic, a card must be the one the list handed out", () => {
  const { base, d } = fixture();
  try {
    writeFileSync(join(d, ".active-discuss.json"), JSON.stringify({ skill: "ship-discuss", session_id: "s1", pid: process.pid, started: new Date().toISOString() }));
    const card = (question, session = "s1") => ({ tool_name: "AskUserQuestion", session_id: session, tool_input: { questions: [{ question, header: "x", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] } });
    assert.equal(decideListed(d, card("Which lane?")), null, "before a topic is started (the lane confirmation) nothing is checked");
    run(d, "start", "--topic", "t");
    let v = decideListed(d, card("Anything I feel like asking?"));
    assert.match(v.reason, /every question card comes from the question list/); assert.match(v.reason, /No question has been handed out yet/);
    run(d, ...good("Should the bar hide?"));
    run(d, "next");
    assert.equal(decideListed(d, card("should the bar hide")), null, "the handed-out question, give or take punctuation");
    v = decideListed(d, card("A different question?"));
    assert.match(v.reason, /The card to ask now is: "Should the bar hide\?"/);
    assert.equal(decideListed(d, card("A different question?", "other-session")), null, "another session is not in this discussion");
    run(d, "pause");
    assert.equal(decideListed(d, card("Next item, or stop?")), null, "between items of a chained discussion nothing is checked");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a discussion gets two cards of its own; the third needs the question list (4.0)", () => {
  const { base, d } = fixture();
  try {
    writeFileSync(join(d, ".active-discuss.json"), JSON.stringify({ skill: "ship-discuss", session_id: "s1", pid: process.pid, started: new Date(Date.now() - 2000).toISOString() }));
    const card = (question, session = "s1") => ({ tool_name: "AskUserQuestion", session_id: session, tool_input: { questions: [{ question, header: "x", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] } });
    assert.equal(decideListed(d, card("Which lane?")), null, "the lane confirmation");
    assert.equal(decideListed(d, card("In the running sprint: edit anyway?")), null, "one follow-up");
    const v = decideListed(d, card("Q1 of 7: how should the check happen?"));
    assert.match(v.reason, /already asked 2 question\(s\) without the question list/);
    assert.match(v.reason, /discuss-questions start --topic/);
    assert.equal(decideListed(d, card("Something", "other-session")), null, "another session is not this discussion");
    // once the list has run in this discussion, cards after it closes are free again
    run(d, "start", "--topic", "t");
    run(d, "reset");
    assert.equal(decideListed(d, card("Next item, or stop?")), null);
    assert.equal(decideListed(d, card("Really stop?")), null);
    assert.equal(decideListed(d, card("One more?")), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("wait returns when a question is ready, when research parks, and on timeout", async () => {
  const { base, d } = fixture();
  try {
    run(d, "start", "--topic", "t"); run(d, "research", "--state", "running", "--by", "r");
    let r = run(d, "wait", "--timeout", "1");
    assert.match(r.stdout, /wake: timeout — no question and no word from research in 1s/);
    const waiting = new Promise((resolve) => { const c = spawn("node", [CLI, "discuss-questions", "wait", "--timeout", "30", "--data-dir", d]); let out = ""; c.stdout.on("data", (b) => { out += b; }); c.on("close", () => resolve(out)); });
    await new Promise((res) => setTimeout(res, 400));
    run(d, ...good("A question raised while main waits?"));
    assert.match(await waiting, /wake: a question is ready/);
    run(d, "next"); run(d, "answer", "Q1", "--choice", "1");
    run(d, "research", "--state", "parked", "--by", "r", "--note", "waiting on nothing else");
    assert.match(run(d, "wait", "--timeout", "5").stdout, /wake: research is parked \(waiting on nothing else\)/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("two writers at the same moment lose nothing: every add gets its own id", async () => {
  const { base, d } = fixture();
  try {
    run(d, "start", "--topic", "t");
    const one = (i) => new Promise((resolve) => { const c = spawn("node", [CLI, "discuss-questions", ...good(`Concurrent question ${i}?`), "--data-dir", d]); c.on("close", (code) => resolve(code)); });
    assert.deepEqual(await Promise.all(Array.from({ length: 8 }, (_, i) => one(i))), Array(8).fill(0));
    assert.deepEqual(state(d).topics.t.questions.map((q) => q.id).sort(), ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("pickNext: a shown and unanswered question first; drafts are named when nothing else can be shown", () => {
  const t = (questions, extra = {}) => ({ budget: 12, one_by_one: false, bundle: null, research: { state: "none" }, questions, ...extra });
  const q = (id, status, more = {}) => ({ id, status, kind: "decision", weight: "normal", parks: "", raised_at: `2026-11-14T10:00:0${id.slice(1)}Z`, ...more });
  assert.equal(pickNext(t([q("Q1", "open"), q("Q2", "open", { parks: "x" }), q("Q3", "asked")])).q.id, "Q3");
  assert.equal(pickNext(t([q("Q1", "open"), q("Q2", "open", { parks: "x" })])).q.id, "Q2");
  assert.deepEqual([pickNext(t([q("Q1", "draft")])).kind, pickNext(t([q("Q1", "draft")])).reason], ["none", "draft"]);
  assert.equal(pickNext(t([q("Q1", "answered"), q("Q2", "dropped")])).reason, "none");
  assert.equal(pickNext(t([], { research: { state: "running" } })).reason, "research_running");
});
