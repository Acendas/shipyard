/** v4.20: the question list of an asynchronous discussion. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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
const src = (d, ...args) => spawnSync("node", [CLI, "sources", ...args, "--data-dir", d], { encoding: "utf8" });
/** The owner's answer on record: this project's knowledge is in its repository (no discussion owes a record). */
const repoOnly = (d) => writeFileSync(join(d, "sources.json"), JSON.stringify({ decided_at: "2026-11-16T00:00:00Z", sources: [] }));
const events = (d) => (existsSync(join(d, ".shipyard-events.jsonl")) ? readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const good = (question = "Should a tower bar be hidden while a hero stands in front of it?", extra = []) => [
  "add", "--summary", "A hero can stand in front of a tower. Today the tower's health bar is drawn over him. Two ways to fix it.",
  "--question", question,
  "--option", "Draw the bar first::The hero covers the bar; simplest change",
  "--option", "Move the bar up::The bar sits above the tower, never over a unit",
  "--checked", "docs/ui/rules.md, S012 decision log, src/render_bars.h", "--confidence", "medium", "--by", "deepdive-bars", ...extra,
];
const state = (d) => JSON.parse(readFileSync(join(d, QUESTIONS_BASENAME), "utf8"));

test("a bare add is a request for the usage, not a question: it leaves no empty draft", () => {
  const { base, d } = fixture();
  try {
    run(d, "start", "--topic", "t");
    const r = run(d, "add");
    assert.equal(r.status, 2); assert.match(r.stderr, /add needs at least --question/);
    assert.deepEqual(state(d).topics.t.questions, []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

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
    assert.equal(ASK_LIMITS.question, Math.round(CARD_LIMITS.question * 1.5), "the hook refuses only a card half as long again as the list's target");
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
    assert.equal(r.status, 0, "nothing waiting is an ordinary answer, not an error on the person's screen"); assert.match(r.stdout, /no question is waiting \(3 answered, 0 dropped\)/);

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
    assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).reason, "research_running");
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
    assert.match(run(d, "next").stdout, /no question is waiting/, "topic b has nothing; a's question is not shown here");
    assert.deepEqual(waitingTopics(d), { current: "b", waiting: [{ topic: "a", ids: ["Q1"] }] });
    src(d, "add", "Team wiki", "--holds", "meeting notes and decisions", "--path", "wiki/", "--answer", "the team wiki");
    const looked = (...topic) => run(d, "sources", "--skipped", "Team wiki: a wording change, nothing was decided", ...topic);
    looked();
    assert.equal(run(d, "reset").status, 0);
    assert.equal(run(d, "reset", "--topic", "a").status, 3);
    run(d, "pause");
    assert.equal(currentCard(d), null);
    assert.match(run(d, "start", "--topic", "a").stdout, /1 question\(s\) from before are waiting \(Q1\)/);
    run(d, "drop", "Q1", "--reason", "the design doc decides it");
    mkdirSync(join(d, "spec", ".questions", "a"), { recursive: true }); writeFileSync(join(d, "spec", ".questions", "a", "bars.md"), "x\n");
    looked();
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
    // The owner (4.0.1): "as part of discuss make sure research looks at datasources internal as well as the usual
    // external". The owner (after 4.0.3): "shipyard is forcing jira, confluence google drive search … [a project]
    // has non of that, and another consumer may have totally differnt sources … sometimes its not necessary at
    // all". So the sources are the project's, named by its owner, once; nothing is recorded before that.
    const status = () => run(d, "status").stdout;
    assert.match(approvalProblems(d, "S040").join("\n"), /this project has not said where its knowledge lives, besides the code[\s\S]*shipyard-data sources suggest/);
    assert.equal(run(d, "sources", "--project", "doc/").status, 3, "nothing is recorded before the owner was asked");
    assert.match(src(d, "suggest").stdout, /QUESTION \(the card, word for word\): Where does this project's knowledge live, besides the code\?\nCHOICES: 1\. Only the repository \(Recommended\)[\s\S]*Never ask them to sign in or connect anything/);
    let no = src(d, "none");
    assert.equal(no.status, 3); assert.match(no.stderr, /none records the owner's decision: add --answer/);
    assert.equal(src(d, "none", "--answer", "only the repository").status, 0);
    assert.doesNotMatch(approvalProblems(d, "S040").join("\n"), /where it looked|knowledge lives/, "a project that names no source owes no record");
    assert.equal(src(d, "add", "Team wiki", "--holds", "meeting notes and decisions", "--tool", "confluence", "--answer", "the wiki, the sheets and the tracker").status, 0);
    assert.equal(src(d, "add", "Price sheets", "--holds", "fees and limits per client", "--tool", "drive", "--always", "--answer", "always check the sheets").status, 0);
    assert.equal(src(d, "add", "Tracker", "--holds", "the tickets this work comes from", "--tool", "jira", "--answer", "the wiki, the sheets and the tracker").status, 0);
    assert.match(src(d, "list").stdout, /\| Price sheets \| fees and limits per client \| tools named like "drive" \| every time \|\n\| Tracker \| the tickets this work comes from \| tools named like "jira" \| when it could matter \|/);
    assert.match(approvalProblems(d, "S040").join("\n"), /the research has not said where it looked\. For each source this project names[\s\S]*--looked "<name>: [\s\S]*--skipped "<name>: /);
    assert.equal(run(d, "sources", "--wiki", "the kickoff meeting notes").status, 2, "the three fixed kinds are gone");
    assert.equal(run(d, "sources", "--person-said", "nothing else").status, 3, "the person is asked after the table exists");
    let part = run(d, "sources", "--skipped", "Team wiki: a wording change, nothing was decided");
    assert.equal(part.status, 3); assert.match(part.stderr, /Missing: Price sheets, Tracker\.\n  Price sheets \(looked at every time\): fees and limits per client\n  Tracker: the tickets this work comes from/);
    part = run(d, "sources", "--looked", "Browser: every page");
    assert.equal(part.status, 3); assert.match(part.stderr, /this project names no such source\. Its sources: Team wiki, Price sheets, Tracker\. A place the owner did not name is not searched for this project/);
    const rest = ["--skipped", "Team wiki: a wording change, nothing was decided", "--skipped", "Tracker: no ticket exists for this change"];
    // Seen live: "looked at: memory: pricing sheets (Drive) …" with no drive, wiki or tracker tool called.
    // What was called is counted by the source-ledger hook; a claim with nothing behind it is refused.
    let claim = run(d, "sources", ...rest, "--looked", "Price sheets: the pricing sheets, from memory");
    assert.equal(claim.status, 3); assert.match(claim.stderr, /--looked says Price sheets was searched, but no tool named like "drive" was called in this discussion \(counted: Team wiki 0, Price sheets 0, Tracker 0, web 0\)[\s\S]*Notes from memory are not a search/);
    // "Always" is the owner's: judgement does not leave such a source out, their word does.
    claim = run(d, "sources", ...rest, "--skipped", "Price sheets: no price in this story");
    assert.equal(claim.status, 3); assert.match(claim.stderr, /Price sheets is looked at in every discussion \(the owner's rule for this project\)[\s\S]*--owner-said "<their words>"[\s\S]*--unreachable "Price sheets: <why>"/);
    assert.equal(run(d, "sources", "--skipped", "Team wiki: no").status, 3, "\"not needed\" says why");
    const at = new Date().toISOString();
    appendFileSync(join(d, ".shipyard-events.jsonl"), [["wiki", "confluence_get_page", "atl__confluence_get_page"], ["drive", "search_drive_files", "google-workspace__search_drive_files"], ["drive", "get_drive_file_content", "google-workspace__get_drive_file_content"], ["tracker", "jira_search", "atl__jira_search"], ["web", "WebSearch", "WebSearch"], ["wiki", "get_page_text", "claude-in-chrome__get_page_text"]].map(([source, tool, name]) => JSON.stringify({ ts: at, type: "source_read", source, tool, name, session: "s1" })).join("\n") + "\n");
    let rs = run(d, "sources", "--looked", "Team wiki: the kickoff meeting notes: scope and dates", "--looked", "Tracker: ABC-1120 and its children", "--looked", "Price sheets: two pricing sheets: fees, limits", "--external", "the payment provider's integration guide", "--by", "deepdive-bars");
    assert.equal(rs.status, 0, rs.stderr);
    assert.match(rs.stdout, /\| Tool calls counted \| Team wiki 1, Price sheets 2, Tracker 1, web 1, connectors this project does not name 1 \|/, "a browser tool is not this project's wiki");
    // The owner: "sometimes its not necessary at all". With nothing left open the person is not asked.
    assert.doesNotMatch(rs.stdout, /Is there a document I could not reach/);
    run(d, "sources", "--project", "doc/: the checkout design note", "--by", "main");
    assert.match(status(), /LOOKED AT:\n +\| Where \| What was looked at \|[\s\S]*\| The project's own code and documents \| doc\/: the checkout design note \|\n +\| Team wiki \| searched: the kickoff meeting notes: scope and dates \|\n +\| Price sheets \| searched: two pricing sheets: fees, limits \|\n +\| Tracker \| searched: ABC-1120 and its children \|\n +\| Outside \| the payment provider's integration guide \|/);
    assert.match(status(), /OTHER DOCUMENTS \(the person, when asked\): not asked: nothing was left open/);
    assert.doesNotMatch(approvalProblems(d, "S040").join("\n"), /where it looked|document exists/);
    // The owner (4.0.1): "what if its a pdf or doc that even user session isnt aware of will shipyard request user ?"
    // Yes, when a fact is left open that such a document could settle.
    rs = run(d, "sources", "--open", "the fee for a refund is in neither sheet");
    assert.match(rs.stdout, /A fact is still open[\s\S]*OPEN: the fee for a refund is in neither sheet[\s\S]*QUESTION \(the card, word for word\): Is there a document I could not reach\?/);
    assert.match(approvalProblems(d, "S040").join("\n"), /a fact was left open and the person has not been asked whether a document exists that this session cannot reach \(a PDF, a contract, a spec sheet, an email\)/);
    assert.match(status(), /OTHER DOCUMENTS \(the person, when asked\): not asked yet/);
    assert.equal(run(d, "sources", "--person-said", "yes: ~/Downloads/payment provider guide.pdf, read it").status, 0);
    // In another piece of work: the owner's word leaves an "always" source out this once, and a source that
    // asks for a sign-in is out of reach, never a reason to make the person sign in.
    run(d, "start", "--topic", "later");
    let low = run(d, "sources", ...rest, "--skipped", "Price sheets: no price in this story", "--owner-said", "leave the sheets out this time");
    assert.equal(low.status, 0, low.stderr); assert.match(low.stdout, /\| Price sheets \| not needed: no price in this story \|/);
    low = run(d, "sources", "--unreachable", "Price sheets: the drive asks for a sign-in");
    assert.equal(low.status, 0, low.stderr); assert.match(low.stdout, /\| Price sheets \| could not reach: the drive asks for a sign-in \|/);
    run(d, "start", "--topic", "bars");
    assert.match(status(), /OTHER DOCUMENTS \(the person, when asked\): yes: ~\/Downloads\/payment provider guide\.pdf, read it/);
    assert.doesNotMatch(approvalProblems(d, "S040").join("\n"), /document exists/);
    assert.match(approvalProblems(d, "S040").join("\n"), /1 question\(s\) of this discussion are not answered yet \(Q1\)/);
    assert.deepEqual(approvalProblems(d, "S041"), []);
    // A story with no topic of its own, approved by the session that holds the discussion, owes the same record
    // (live, after 4.0.2: of two stories approved on one card, only the bound one was refused). Another session
    // approving beside the discussion owes nothing, and neither does a quick lane.
    {
      const saved = process.env.CLAUDE_CODE_SESSION_ID;
      const lockFile = join(d, ".active-discuss.json");
      const events = join(d, ".shipyard-events.jsonl");
      const before = existsSync(events) ? readFileSync(events, "utf8") : "";
      const started = new Date(Date.now() + 1000).toISOString();
      writeFileSync(lockFile, JSON.stringify({ skill: "ship-discuss", session_id: "s-own", cleared: null, started }));
      try {
        process.env.CLAUDE_CODE_SESSION_ID = "s-other";
        assert.deepEqual(approvalProblems(d, "S041"), []);
        process.env.CLAUDE_CODE_SESSION_ID = "s-own";
        assert.match(approvalProblems(d, "S041").join("\n"), /the research has not said where it looked/);
        const later = (o) => JSON.stringify({ ts: new Date(Date.now() + 5000).toISOString(), ...o }) + "\n";
        writeFileSync(events, before + later({ type: "discuss_sources_recorded", topic: "refine-s040", owed: "person", person_asked: "no" }));
        assert.match(approvalProblems(d, "S041").join("\n"), /a fact was left open and the person has not been asked whether a document exists/);
        writeFileSync(events, before + later({ type: "discuss_sources_recorded", topic: "refine-s040", owed: "", person_asked: "no" }));
        assert.deepEqual(approvalProblems(d, "S041"), []);
        writeFileSync(events, before + later({ type: "discuss_sources_recorded", topic: "refine-s040", person_asked: "yes" }));
        assert.deepEqual(approvalProblems(d, "S041"), [], "a record made before the sources were the project's own is complete");
        writeFileSync(events, before + later({ type: "intake_lane_confirmed", lane: "hotfix" }));
        assert.deepEqual(approvalProblems(d, "S041"), []);
      } finally {
        if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = saved;
        rmSync(lockFile, { force: true }); writeFileSync(events, before);
      }
    }
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
    assert.equal(v.reason, undefined, "with nothing handed out, a card of the session's own is not refused");
    assert.equal(v.unlisted.question, "Anything I feel like asking?");
    run(d, ...good("Should the bar hide?"));
    run(d, "next");
    assert.equal(decideListed(d, card("should the bar hide")), null, "the handed-out question, give or take punctuation");
    v = decideListed(d, card("A different question?"));
    assert.match(v.reason, /one question at a time/); assert.match(v.reason, /The card on the list now is: "Should the bar hide\?"/);
    assert.equal(decideListed(d, card("A different question?", "other-session")), null, "another session is not in this discussion");
    run(d, "pause");
    assert.equal(decideListed(d, card("Next item, or stop?")), null, "between items of a chained discussion nothing is checked");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a card asked before any topic exists is never refused, and is recorded (4.0.1)", () => {
  const { base, d } = fixture();
  try {
    writeFileSync(join(d, ".active-discuss.json"), JSON.stringify({ skill: "ship-discuss", session_id: "s1", pid: process.pid, started: new Date(Date.now() - 2000).toISOString() }));
    const card = (question, session = "s1") => ({ tool_name: "AskUserQuestion", session_id: session, tool_input: { questions: [{ question, header: "x", options: [{ label: "Bundle", description: "a" }, { label: "Own story", description: "b" }] }] } });
    for (const q of ["Which lane?", "Bundle these six ideas?", "IDEA-074: its own story?", "Anything else?"]) assert.equal(decideListed(d, card(q)), null, q);
    const events = readFileSync(join(d, ".shipyard-events.jsonl"), "utf8");
    assert.equal((events.match(/"type":"discuss_card_asked"/g) || []).length, 4);
    assert.match(events, /"n":3[^\n]*"question":"IDEA-074: its own story\?"[^\n]*"options":"Bundle \| Own story"/);
    // once a topic is current, the list decides again
    run(d, "start", "--topic", "t");
    assert.equal(decideListed(d, card("Something off the list?")).unlisted.question, "Something off the list?");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// The owner, 2026-11-15, on 4.0.0: "saw one error: … PreToolUse:AskUserQuestion hook error: Shipyard: in this
// discussion every question card comes from the question list. No question has been handed out yet."
// They had answered a card with a request for advice; the session confirmed with a card of its own.
test("a card the list did not hand out is recorded as a question, shown, and its answer is owed before approval", () => {
  const { base, d } = fixture();
  try {
    writeFileSync(join(d, ".active-discuss.json"), JSON.stringify({ skill: "ship-discuss", session_id: "s1", pid: process.pid, started: new Date().toISOString() }));
    writeFileSync(join(d, "spec", "stories", "S040-x.md"), `---\nid: S040\ntitle: "Story"\ntype: feature\nstatus: proposed\nrefined: true\nstory_points: 2\n---\n${BODY}`);
    run(d, "start", "--topic", "t", "--story", "S040");
    repoOnly(d);
    const input = { tool_name: "AskUserQuestion", session_id: "s1", tool_input: { questions: [{ question: "Go with a release label and a story per slice?", header: "Confirm", options: [{ label: "Yes, go (Recommended)", description: "Spec three now" }, { label: "Change it", description: "You say what" }] }] } };
    const hook = spawnSync("node", [join(ROOT, "bin", "hook-runner.mjs"), "unattended-ask"], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: d } });
    assert.equal(hook.status, 0, hook.stderr);
    const out = JSON.parse(hook.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined, "the card is not refused");
    assert.match(out.hookSpecificOutput.additionalContext, /recorded as Q1[\s\S]*discuss-questions answer Q1 --choice/);
    const q = state(d).topics.t.questions[0];
    assert.deepEqual([q.id, q.status, q.unlisted, q.options.map((o) => o.label).join("|")], ["Q1", "asked", true, "Yes, go|Change it"]);
    assert.ok(events(d).some((e) => e.type === "discuss_card_unlisted" && e.question === "Q1"));
    assert.ok(!events(d).some((e) => e.type === "ask_not_listed_denied"));
    // the same card again (a retry) is the card on the list now: allowed, not recorded twice
    spawnSync("node", [join(ROOT, "bin", "hook-runner.mjs"), "unattended-ask"], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: d } });
    assert.equal(state(d).topics.t.questions.length, 1);
    assert.match(approvalProblems(d, "S040").join("\n"), /not answered yet \(Q1\)/);
    const r = run(d, "next");
    assert.match(r.stdout, /You asked this card yourself, outside the list[\s\S]*Record the person's answer now: shipyard-data discuss-questions answer Q1/);
    assert.equal(run(d, "answer", "Q1", "--choice", "1").status, 0);
    assert.deepEqual(approvalProblems(d, "S040"), []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// Same session: the person answered "pls advice based on LeSS" and the session recorded its own advice as their answer.
test("a reply that is a question is not an answer: ask-again keeps their words and shows the question again", () => {
  const { base, d } = fixture();
  try {
    run(d, "start", "--topic", "t");
    run(d, ...good("One epic with a story per slice, or a single story?"));
    let r = run(d, "next");
    assert.match(r.stdout, /If they reply with a question or ask what you advise, that is not an answer[\s\S]*discuss-questions ask-again Q1 --their-words/);
    assert.equal(run(d, "ask-again", "Q1").status, 2, "their words are required");
    r = run(d, "ask-again", "Q1", "--their-words", "not sure, pls advise based on LeSS", "--summary", "LeSS keeps one backlog and refines just in time. I advise a release label with a story per slice.");
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Q1 is open again; their words are kept[\s\S]*Nothing is recorded as their answer/);
    let q = state(d).topics.t.questions[0];
    assert.deepEqual([q.status, q.answer, q.replies.length, q.replies[0].text], ["open", null, 1, "not sure, pls advise based on LeSS"]);
    r = run(d, "next");
    assert.match(r.stdout, /^Q1 /); assert.match(r.stdout, /LeSS keeps one backlog/);
    // an answer recorded too early can be taken back the same way
    run(d, "answer", "Q1", "--text", "my own advice, wrongly recorded as theirs");
    assert.equal(run(d, "ask-again", "Q1", "--their-words", "they only asked for advice").status, 0);
    q = state(d).topics.t.questions[0];
    assert.deepEqual([q.status, q.answer, q.answer_seq, q.replies.length], ["open", null, undefined, 2]);
    assert.ok(events(d).some((e) => e.type === "discuss_question_asked_again" && e.times === 2));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// Same session: `bind --story` was run for S001, S002, S003 and S004 and each run said "bound"; only S004 was.
test("one discussion can be bound to several stories, and each one waits for its questions", () => {
  const { base, d } = fixture();
  try {
    run(d, "start", "--topic", "t", "--story", "S001");
    let r = run(d, "bind", "--story", "S002");
    assert.match(r.stdout, /topic t is bound to S001, S002: none of them can be approved while a question waits/);
    run(d, "bind", "--story", "S003,S004"); run(d, "bind", "--story", "S002");
    assert.deepEqual(state(d).topics.t.stories, ["S001", "S002", "S003", "S004"]);
    run(d, ...good());
    for (const id of ["S001", "S002", "S003", "S004"]) assert.match(approvalProblems(d, id).join("\n"), /not answered yet \(Q1\)/, id);
    assert.deepEqual(approvalProblems(d, "S005"), []);
    assert.match(run(d, "status").stdout, /^t \(S001, S002, S003, S004\):/);
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

test("the question list cannot be closed before the research says where it looked, for a project that names sources", () => {
  const { base, d } = fixture();
  try {
    run(d, "start", "--topic", "t");
    assert.equal(run(d, "reset").status, 0, "the one-time question about the project's sources is asked at approval or at the end, not when a list closes");
    repoOnly(d);
    run(d, "start", "--topic", "t");
    assert.equal(run(d, "reset").status, 0, "a project that names no source owes no record");
    src(d, "add", "Design notes", "--holds", "what was decided and why", "--path", "doc/", "--answer", "the design notes folder");
    run(d, "start", "--topic", "t");
    let r = run(d, "reset");
    assert.equal(r.status, 3); assert.match(r.stderr, /cannot be closed yet: the research has not said where it looked/);
    run(d, "sources", "--looked", "Design notes: doc/checkout.md, the fee table", "--open", "the fee for a refund is not written down");
    r = run(d, "reset");
    assert.equal(r.status, 3); assert.match(r.stderr, /a fact was left open and the person has not been asked whether a document exists that this session cannot reach/);
    run(d, "sources", "--person-said", "nothing else");
    assert.equal(run(d, "reset").status, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a topic started before sources were recorded is not held for them", () => {
  const { base, d } = fixture();
  try {
    writeFileSync(join(d, QUESTIONS_BASENAME), JSON.stringify({ version: 2, current: "old", topics: { old: { topic: "old", story: "S040", budget: 12, seq: 0, answer_seq: 0, research: { state: "none" }, questions: [], assumptions: [] } } }));
    assert.deepEqual(approvalProblems(d, "S040"), []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the source ledger counts connector and web calls while this session holds the discuss lock, by kind, never their content", async () => {
  const { sourceClass } = await import("../bin/hooks/source-ledger.mjs");
  assert.deepEqual(["mcp__plugin_atlassian-suite_acendas-atlassian__confluence_get_page", "mcp__plugin_atlassian-suite_acendas-atlassian__jira_search", "mcp__google-workspace__search_drive_files", "mcp__google-workspace__get_drive_file_content", "WebSearch", "mcp__slack__search_messages", "mcp__easel__chart"].map(sourceClass), ["wiki", "tracker", "drive", "drive", "web", "chat", "other"]);
  const { base, d } = fixture();
  try {
    const hook = (tool, session = "s1") => spawnSync("node", [join(ROOT, "bin", "hook-runner.mjs"), "source-ledger"], { input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: tool, session_id: session, tool_input: { query: "secret words" }, tool_response: "secret result" }), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: d } });
    assert.equal(hook("mcp__google-workspace__search_drive_files").status, 0);
    assert.deepEqual(events(d), [], "no discussion: nothing is logged");
    writeFileSync(join(d, ".active-discuss.json"), JSON.stringify({ skill: "ship-discuss", session_id: "s1", cleared: null, started: new Date().toISOString() }));
    hook("mcp__google-workspace__search_drive_files"); hook("mcp__x__jira_search"); hook("mcp__easel__chart"); hook("mcp__x__confluence_get_page", "another-session");
    const ev = events(d).filter((e) => e.type === "source_read");
    assert.deepEqual(ev.map((e) => `${e.source}:${e.tool}`), ["drive:search_drive_files", "tracker:jira_search", "wiki:confluence_get_page"], "a helper under its own session id counts: its searches are the discussion's");
    assert.equal(ev[0].name, "google-workspace__search_drive_files", "the full name, so a call is matched to a source the project names");
    assert.doesNotMatch(JSON.stringify(ev), /secret/);
    // A tool of no known kind is counted once the project names a source it belongs to (any consumer's own place).
    src(d, "add", "Charts", "--holds", "the weekly numbers", "--tool", "easel", "--answer", "the charts too");
    hook("mcp__easel__chart"); hook("mcp__other__thing");
    assert.deepEqual(events(d).filter((e) => e.type === "source_read").slice(3).map((e) => `${e.source}:${e.name}`), ["other:easel__chart"]);
    const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
    assert.ok(hooks.hooks.PostToolUse.some((h) => h.matcher === "mcp__.*|WebSearch|WebFetch" && /source-ledger$/.test(h.hooks[0].command)));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// Live (4.0.1): "shared drive: not connected" from a session with 39 drive tools, so the kinds of source a
// session had tools for decided what it had to search. Live (after 4.0.3): on a project with no such sources a
// browser tool counted as a wiki and a document tool as a shared drive, a bug whose cause was in the code could
// not be approved, and the owner's "this project has no other sources" was refused. What a session can reach is
// now only a hint for the one-time question; what the project names decides.
test("the connectors a session has are a hint for the one-time question, never what a discussion must search", async () => {
  const { noteAvailable } = await import("../bin/hooks/source-ledger.mjs");
  const { base, d } = fixture();
  try {
    const t = join(base, "t.jsonl");
    writeFileSync(t, JSON.stringify({ type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: ["mcp__google-workspace__create_drive_file", "mcp__google-workspace__search_drive_files", "mcp__plugin_x_atl__confluence_search", "mcp__claude-in-chrome__get_page_text", "mcp__plugin_y_writer__add_comment", "mcp__easel__chart"] } }) + "\n");
    const input = { session_id: "s1", transcript_path: t };
    assert.equal(noteAvailable(d, input), null, "no discussion: nothing is recorded");
    writeFileSync(join(d, ".active-discuss.json"), JSON.stringify({ skill: "ship-discuss", session_id: "s1", cleared: null, started: new Date().toISOString() }));
    assert.deepEqual(noteAvailable(d, input), ["claude-in-chrome", "google-workspace", "x_atl"], "servers with a tool that reads; a write tool alone (add_comment) is not a place to search");
    assert.equal(noteAvailable(d, input), null, "once per session");
    assert.match(src(d, "suggest").stdout, /Other places this session could reach, if they belong to this project: claude-in-chrome, google-workspace, x_atl/);
    // the owner's answer: none of them
    assert.equal(src(d, "none", "--answer", "this project has no data sources other than its repository").status, 0);
    writeFileSync(join(d, "spec", "stories", "S090-x.md"), `---\nid: S090\ntitle: "A total is rounded wrong"\ntype: bug\nstatus: proposed\nrefined: true\nstory_points: 2\n---\n${BODY}`);
    run(d, "start", "--topic", "t", "--story", "S090");
    assert.deepEqual(approvalProblems(d, "S090"), [], "a defect whose cause is in the code is approved with no search of anything");
    const r = run(d, "sources", "--looked", "Wiki: searched for the project's name");
    assert.equal(r.status, 3); assert.match(r.stderr, /this project names no such source\. It names none: its knowledge is in the repository, and nothing is owed about other places/);
    assert.equal(JSON.parse(readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").trim().split("\n").find((l) => l.includes('"project_sources_set"'))).answer, "this project has no data sources other than its repository");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
