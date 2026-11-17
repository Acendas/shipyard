// `shipyard-data backlog board` and the hook that makes /ship-backlog show it (4.0.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoard, renderBoard, BOARD_HEADER, BOARD_FOOTER } from "../bin/backlog-board.mjs";
import { decideBoard, decideExplained, explainedVerdict, explainProblems, HELD, HELD_AGAIN, HELD_BOARD, run as runAskHook } from "../bin/hooks/unattended-ask.mjs";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "board-"));
  const d = join(base, "data");
  for (const sub of ["spec/stories", "spec/epics", "spec/ideas", "spec/steps", "backlog", "sprints/current", "memory"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, "config.md"), "---\nconfig_version: 5\nproject_name: \"shop\"\n---\n");
  const story = (id, o = {}) => writeFileSync(join(d, "spec/stories", `${id}-x.md`), `---\nid: ${id}\ntitle: "Shop: ${o.title ?? "Story " + id}"\ntype: ${o.type ?? "feature"}\nstatus: ${o.status ?? "approved"}\nepic: ${o.epic ?? ""}\nstory_points: ${o.points ?? 3}\n${o.rice ? `rice_score: ${o.rice}\n` : ""}dependencies: [${(o.deps ?? []).join(", ")}]\nsteps: [${(o.steps ?? []).join(", ")}]\nupdated: 2026-11-10\n---\n`);
  writeFileSync(join(d, "spec/epics", "E001-x.md"), "---\nid: E001\ntitle: \"Checkout\"\nstatus: in-progress\n---\n");
  const backlog = (ids) => writeFileSync(join(d, "backlog/BACKLOG.md"), `---\nlast_groomed: null\n---\n\n| Rank | ID |\n|------|----|\n${ids.map((id, i) => `| ${i + 1} | ${id} |`).join("\n")}\n`);
  return { base, d, story, backlog, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("the board lists the sprint, the backlog by epic in rank order, what is not scored, proposed stories and open ideas", () => {
  const f = fixture();
  try {
    f.story("S001", { epic: "E001", points: 5, rice: 24, title: "Card payments" });
    f.story("S002", { epic: "E001", points: 8, deps: ["S001"], title: "Refunds" });
    f.story("S003", { points: 2, type: "bug", title: "Receipt shows the wrong date" });
    f.story("S004", { status: "proposed", title: "Gift cards" });
    f.story("S005", { status: "in-progress", steps: ["P001", "P002"], title: "Basket" });
    f.story("S006", { title: "Approved, never added" });
    f.story("S007", { status: "done", title: "Old" });
    f.backlog(["S002", "S001", "S003", "S007"]);
    writeFileSync(join(f.d, "spec/steps", "P001-x.md"), "---\nid: \"P001\"\nstatus: done\n---\n");
    writeFileSync(join(f.d, "spec/steps", "P002-x.md"), "---\nid: \"P002\"\nstatus: approved\n---\n");
    writeFileSync(join(f.d, "sprints/current/SPRINT.md"), "---\nid: sprint-003\nstatus: in-progress\ngoal: \"A basket that works\"\nstories: [S005]\n---\n\n## Waves\n\n### Wave 1\nTasks: [P001, P002]\n");
    writeFileSync(join(f.d, "spec/ideas", "IDEA-001-x.md"), "---\nid: IDEA-001\ntitle: \"Faster search\"\nstatus: captured\nsource: retro/sprint-002\ncreated: 2026-11-12\n---\n");
    writeFileSync(join(f.d, "spec/ideas", "IDEA-002-x.md"), "---\nid: IDEA-002\ntitle: \"Done already\"\nstatus: promoted\ncreated: 2026-11-01\n---\n");
    writeFileSync(join(f.d, "memory/metrics.md"), "Velocity average: 15 pts/sprint\n");
    const b = buildBoard(f.d);
    b.epics = new Map([["E001", "Checkout"]]);
    const out = renderBoard(b);
    assert.ok(out.startsWith(`${BOARD_HEADER} shop`));
    assert.match(out, new RegExp(`— ${BOARD_FOOTER} · 7 numbered item\\(s\\) —$`));
    assert.match(out, /IN THE SPRINT · sprint-003 · A basket that works · 1 stories · 3 pts\n  \[ 1\] S005  Basket\s+3 pts · 1\/2 steps done/);
    assert.match(out, /BACKLOG · 3 stories · 15 pts/);
    assert.match(out, / E001 Checkout · 2 · 13 pts\n  \[ 2\] S002  Refunds\s+8 pts · waits for S001\n  \[ 3\] S001  Card payments\s+5 pts · RICE 24/, "the file's rank order, the shared title prefix dropped, the open dependency named");
    assert.match(out, / \(no epic\) · 1 · 2 pts\n  \[ 4\] S003  Receipt shows the wrong date\s+2 pts · bug/);
    assert.match(out, /about 15 pts a sprint, so this is about 1 sprint\(s\) of work/);
    assert.match(out, /not scored yet \(no RICE\): S002, S003/);
    assert.match(out, /APPROVED BUT NOT ON THE BACKLOG LIST · 1[^\n]*\n  \[ 5\] S006/);
    assert.match(out, /PROPOSED · 1[\s\S]*\[ 6\] S004  Gift cards/);
    assert.match(out, /IDEAS · 1 waiting for a decision[^\n]*\n  \[ 7\] IDEA-001 Faster search  \(retro\/sprint-002\)/);
    assert.doesNotMatch(out, /S007|IDEA-002/, "finished and decided items are not on the board");
  } finally { f.cleanup(); }
});

test("an empty project still has a board with its first and last lines", () => {
  const f = fixture();
  try {
    const out = renderBoard(buildBoard(f.d));
    assert.match(out, /^BOARD · shop\n\nBACKLOG · 0 stories · 0 pts[^\n]*\n  \(empty\)\n\n— end of board · 0 numbered item\(s\) —$/);
  } finally { f.cleanup(); }
});

test("/ship-backlog may not ask before the board is in the chat; other commands and unreadable transcripts pass", () => {
  const f = fixture();
  try {
    const t = join(f.base, "t.jsonl");
    const user = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
    const say = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
    const tool = (cmd) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] } });
    const ask = { tool_name: "AskUserQuestion", transcript_path: t, tool_input: { questions: [{ question: "What next on the backlog?" }] } };
    const cmd = "<command-message>shipyard:ship-backlog</command-message>\n<command-name>/shipyard:ship-backlog</command-name>";
    writeFileSync(t, [user(cmd), tool("shipyard-data backlog board"), say("The board has 22 approved stories and no active sprint.")].join("\n") + "\n");
    const v = decideBoard(ask);
    // the first time: one line a person can read, and the steps for the session where the person does not see them
    assert.equal(v.reason, HELD_BOARD);
    assert.ok(v.reason.length < 100 && !/shipyard-data|Question follows/.test(v.reason));
    assert.match(v.context, /shipyard-data backlog board/);
    assert.match(v.context, /End that message with the line "Question follows\." and end your turn there/);
    // it came again and the board is still nowhere: still one line; a third time the steps are in the reason itself
    const heldCard = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "AskUserQuestion", input: { questions: [{ question: "What next on the backlog?" }] } }] } });
    const sentBack = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", is_error: true, content: "PreToolUse:AskUserQuestion hook error: Shipyard: one moment." }] } });
    writeFileSync(t, [user(cmd), say("The board has 22 approved stories."), heldCard, sentBack].join("\n") + "\n");
    assert.equal(decideBoard(ask).reason, HELD_BOARD);
    writeFileSync(t, [user(cmd), say("The board has 22 approved stories."), heldCard, sentBack, heldCard, sentBack].join("\n") + "\n");
    const again = decideBoard(ask);
    assert.match(again.reason, /shows the board before it asks anything/);
    assert.match(again.reason, /shipyard-data backlog board/);
    assert.equal(again.context, undefined);
    // the board was written in the same message as the held card: it is in the file now, the card passes
    writeFileSync(t, [user(cmd), say("```\nBOARD · shop\n\n— end of board · 0 numbered item(s) —\n```"), heldCard, sentBack].join("\n") + "\n");
    assert.equal(decideBoard(ask), null);
    writeFileSync(t, [user(cmd), tool("shipyard-data backlog board"), say("```\nBOARD · shop\n\nBACKLOG · 0 stories\n\n— end of board · 0 numbered item(s) —\n```")].join("\n") + "\n");
    assert.equal(decideBoard(ask), null, "the board is in the chat");
    // an earlier backlog run does not count for this one
    writeFileSync(t, [user(cmd), say("BOARD · shop\n— end of board · 0 numbered item(s) —"), user("thanks"), user(cmd), say("Short summary only.")].join("\n") + "\n");
    assert.ok(decideBoard(ask), "the board of an earlier run is not this run's board");
    // another command, no transcript, another tool
    writeFileSync(t, [user("<command-name>/shipyard:ship-review</command-name>"), say("x")].join("\n") + "\n");
    assert.equal(decideBoard(ask), null);
    assert.equal(decideBoard({ ...ask, transcript_path: join(f.base, "missing.jsonl") }), null);
    assert.equal(decideBoard({ tool_name: "AskUserQuestion", tool_input: {} }), null);
    assert.equal(decideBoard({ ...ask, tool_name: "Bash" }), null);
  } finally { f.cleanup(); }
});

// --- a question is asked only after its explanation is in the chat ----------

const GOOD = "Six of the eight ideas fit one small story. I recommend bundling them.\n\n| Option | What it means |\n|---|---|\n| Bundle six | one 3-point story |\n| Keep apart | six one-line tasks |";

test("the text before a question: a short summary first and a picture; each miss is named", () => {
  assert.deepEqual(explainProblems(GOOD), []);
  assert.deepEqual(explainProblems("Here is the flow.\n\n```\nidea -> story -> sprint\n```\n\nPick how many ideas go into the story, please, from the list."), []);
  assert.match(explainProblems("")[0], /nothing \(or almost nothing\) was written/);
  assert.match(explainProblems("Six of the eight remaining ideas fit the bundle, while IDEA-079 is already decided to move into S042 and IDEA-074 is too big to bundle, so I am leaving it for your call.").join(" "), /there is no picture/);
  const long = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");
  assert.match(explainProblems(`${long}\n\n| a | b |\n|---|---|\n| 1 | 2 |`).join(" "), /first paragraph is 70 words/);
  assert.match(explainProblems("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n| 7 | 8 |\n| 9 | 10 |\n| 11 | 12 |\n| 13 | 14 |\n| 15 | 16 |").join(" "), /no summary in plain words/);
});

test("an explanation that pastes acceptance criteria as Given/When/Then is sent back: one plain line each", () => {
  const pasted = "Two stories are ready. I recommend approving both.\n\n```gherkin\nScenario: a\n  Given x\n  When y\n  Then z\nScenario: b\n  Given x\n  When y\n  Then z\n```";
  assert.match(explainProblems(pasted).join(" "), /acceptance criteria are pasted as Given\/When\/Then text: give one plain line per criterion/);
  assert.deepEqual(explainProblems("Two stories are ready. I recommend approving both.\n\n| AC | In plain words |\n|---|---|\n| AC-1 | A failed card sale gives the money back |\n| AC-2 | The refund is kept when the bank is down |"), []);
  assert.deepEqual(explainProblems("You asked for AC-3 in full.\n\n```gherkin\nScenario: c\n  Given x\n  When y\n  Then z\n```"), [], "one criterion in full, when asked for, is fine");
});

test("inside a Shipyard command a card with no explanation since the last answer is refused; with one it passes; elsewhere nothing is checked", () => {
  const f = fixture();
  try {
    const t = join(f.base, "t.jsonl");
    const user = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
    const say = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
    const think = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } });
    const card = (id) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions: [{ question: "q" }] } }] } });
    const answered = (id) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Your questions have been answered" }] } });
    const refused = (id) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "PreToolUse:AskUserQuestion hook error: Shipyard: ..." }] } });
    const ask = { tool_name: "AskUserQuestion", transcript_path: t, tool_input: { questions: [{ question: "q" }] } };
    const cmd = "<command-name>/shipyard:ship-discuss</command-name>";
    // only thinking and a tool call since the command: what the owner saw as a one-line summary and a card
    writeFileSync(t, [user(cmd), think("Six of the eight ideas fit the bundle. " + GOOD)].join("\n") + "\n");
    let v = decideExplained(ask);
    // the first time a card is held, the person reads one calm line; what the session must do is not on their screen
    assert.equal(v.reason, HELD);
    assert.equal(v.held, true);
    assert.ok(v.reason.length < 100 && !/Question follows|AskUserQuestion|40 words/.test(v.reason), "nothing in the visible line is addressed to the session");
    assert.match(v.context, /Nothing about this question has been written as a message yet, and the person sees only messages/);
    assert.match(v.context, /End the message with the line "Question follows\." and end your turn there/);
    // Run live: offered "if you wrote it as text in the same message, ask again at once", a session whose explanation
    // was in its reasoning did exactly that. It cannot tell the two apart, so it is told to write the explanation;
    // the shortcut is the marker alone, which the Stop hook judges.
    assert.match(v.context, /Write its explanation as your message now/);
    assert.match(v.context, /Only if that explanation is already on screen as text of the very message that called the card: write just the line "Question follows\." and end your turn/);
    assert.doesNotMatch(v.context, /again at once/);
    // held once and called again with still nothing written: one short line again, the full steps unseen
    writeFileSync(t, [user(cmd), think("Six of the eight ideas fit the bundle. " + GOOD), card("c0"), refused("c0")].join("\n") + "\n");
    v = decideExplained(ask);
    assert.equal(v.reason, HELD_AGAIN);
    assert.match(v.context, /nothing \(or almost nothing\) was written in the chat/);
    assert.match(v.context, /Nothing about this question has been written as a message yet, and the person sees only messages/);
    assert.match(v.context, /End that message with the line "Question follows\." and end your turn there/);
    // a third time: the steps are in the reason itself, so they reach the session whatever the client does with context
    writeFileSync(t, [user(cmd), think("Six of the eight ideas fit the bundle. " + GOOD), card("c0"), refused("c0"), card("c1"), refused("c1")].join("\n") + "\n");
    v = decideExplained(ask);
    assert.match(v.reason, /nothing \(or almost nothing\) was written in the chat/);
    assert.match(v.reason, /End that message with the line "Question follows\." and end your turn there/);
    assert.equal(v.context, undefined);
    // the stop hook's hand-back is not the person speaking: the explanation before it still counts
    writeFileSync(t, [user(cmd), say(GOOD + "\n\nQuestion follows."), JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback: Shipyard: now ask it on a card." } })].join("\n") + "\n");
    assert.equal(decideExplained(ask), null, "explained, turn ended, handed back: the card passes");
    // the marker alone is not an explanation
    writeFileSync(t, [user(cmd), say("Question follows.")].join("\n") + "\n");
    assert.ok(decideExplained(ask));
    // explained in the message right before the card, which ends the turn with the marker: passes
    const GOODQ = GOOD + "\n\nQuestion follows.";
    writeFileSync(t, [user(cmd), say(GOODQ)].join("\n") + "\n");
    assert.equal(decideExplained(ask), null);
    // Seen live: a plan table written earlier in the same stretch let a later card through whose own explanation
    // was only reasoning. The explanation is the message right before the card, or the card is refused.
    writeFileSync(t, [user(cmd), say(GOODQ), say("All probes fail on today's code. Next I tell the tracker.")].join("\n") + "\n");
    assert.match(decideExplained(ask).problems[0], /the message right before this question does not explain it/);
    writeFileSync(t, [user(cmd), say(GOOD)].join("\n") + "\n");
    assert.match(decideExplained(ask).problems[0], /the message right before this question does not explain it/, "a good explanation that did not end the turn with the marker is not the route");
    // ...and calling the card a second time does not launder it: that text was an earlier message, not the card's own
    const sayIn = (id, text) => JSON.stringify({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] } });
    const cardIn = (id, cid, q = "q") => JSON.stringify({ type: "assistant", message: { id, role: "assistant", content: [{ type: "tool_use", id: cid, name: "AskUserQuestion", input: { questions: [{ question: q }] } }] } });
    writeFileSync(t, [user(cmd), sayIn("m1", GOOD), cardIn("m2", "c0"), refused("c0")].join("\n") + "\n");
    assert.equal(decideExplained(ask).reason, HELD_AGAIN);
    assert.match(decideExplained(ask).context, /the message right before this question does not explain it/, "the second time the full steps are given, unseen");
    // Seen live, twice, on the first question of a discussion: explanation, "Question follows." and the card in ONE
    // message. The person had it on screen; the hook could not see it yet and held the card. When the same card comes
    // again the text is in the file: it passes, and nothing is written twice.
    writeFileSync(t, [user(cmd), sayIn("m1", "Reading the tickets."), sayIn("m2", GOODQ), cardIn("m2", "c0"), refused("c0")].join("\n") + "\n");
    assert.equal(decideExplained(ask), null);
    writeFileSync(t, [user(cmd), sayIn("m2", GOOD), JSON.stringify({ type: "attachment", attachment: { type: "output_style" } }), cardIn("m2", "c0"), refused("c0")].join("\n") + "\n");
    assert.equal(decideExplained(ask), null, "without the marker too: it was right above the card");
    assert.deepEqual(explainedVerdict(ask), { pass: "same_message" });
    // the session answered the hold with the marker alone ("it is already above"): the card after it passes too
    writeFileSync(t, [user(cmd), sayIn("m2", GOOD), cardIn("m2", "c0"), refused("c0"), sayIn("m3", "Question follows.")].join("\n") + "\n");
    assert.equal(decideExplained(ask), null);
    writeFileSync(t, [user(cmd), sayIn("m2", GOOD), JSON.stringify({ type: "attachment", attachment: { type: "output_style" } }), cardIn("m2", "c0"), refused("c0")].join("\n") + "\n");
    // a different question may not ride on it
    assert.ok(decideExplained({ ...ask, tool_input: { questions: [{ question: "something else" }] } }));
    // the same message held only a short remark, or reasoning: still sent back
    writeFileSync(t, [user(cmd), sayIn("m2", "Asking now."), cardIn("m2", "c0"), refused("c0")].join("\n") + "\n");
    assert.ok(decideExplained(ask));
    writeFileSync(t, [user(cmd), JSON.stringify({ type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "thinking", thinking: GOOD }] } }), cardIn("m2", "c0"), refused("c0")].join("\n") + "\n");
    assert.ok(decideExplained(ask), "reasoning in the card's message is not an explanation");
    // the person answered that card: the next card needs its own explanation
    writeFileSync(t, [user(cmd), sayIn("m2", GOODQ), cardIn("m2", "c0"), answered("c0")].join("\n") + "\n");
    assert.equal(decideExplained(ask).reason, HELD);
    // the first card was explained and answered; the second card needs its own explanation
    writeFileSync(t, [user(cmd), say(GOODQ), card("c1"), answered("c1"), think("next one")].join("\n") + "\n");
    assert.ok(decideExplained(ask), "an explanation does not carry over to the next question");
    writeFileSync(t, [user(cmd), say(GOODQ), card("c1"), answered("c1"), say(GOODQ.replace("Six", "Two"))].join("\n") + "\n");
    assert.equal(decideExplained(ask), null);
    // a refused card is not an answer: the text written before it still counts for the retry
    writeFileSync(t, [user(cmd), say(GOODQ), card("c1"), refused("c1")].join("\n") + "\n");
    assert.equal(decideExplained(ask), null);
    // the person typed something: what was written before it no longer counts
    writeFileSync(t, [user(cmd), say(GOODQ), user("change the third one"), think("ok")].join("\n") + "\n");
    assert.ok(decideExplained(ask));
    // not a Shipyard command, no transcript: nothing is checked
    writeFileSync(t, [user("<command-name>/review</command-name>"), think("x")].join("\n") + "\n");
    assert.equal(decideExplained(ask), null);
    assert.equal(decideExplained({ tool_name: "AskUserQuestion", tool_input: {} }), null);
  } finally { f.cleanup(); }
});

// --- the explanation ends the turn; the stop hook hands the turn back for the card ---

test("a turn that ends on an explanation with 'Question follows.' is handed back for the card; never in a loop, never outside Shipyard", async () => {
  const { decideStop } = await import("../bin/hooks/ask-after-explain.mjs");
  const f = fixture();
  try {
    const t = join(f.base, "t.jsonl");
    const user = (text, meta) => JSON.stringify({ type: "user", ...(meta ? { isMeta: true } : {}), message: { role: "user", content: text } });
    const say = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
    const card = (id) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "AskUserQuestion", input: {} }] } });
    const cmd = "<command-name>/shipyard:ship-discuss</command-name>";
    const stop = (last) => decideStop({ transcript_path: t, last_assistant_message: last });
    writeFileSync(t, [user(cmd)].join("\n") + "\n");
    // the message that just ended is not in the transcript yet: the hook input carries it
    let v = stop(GOOD + "\n\nQuestion follows.");
    assert.equal(v.kind, "ask");
    assert.match(v.reason, /^Shipyard: the explanation is shown\. Ask the question card now/);
    assert.equal(stop(GOOD + "\n\n**Question follows.**").kind, "ask", "bold or without care for case is the same line");
    // no marker: an ordinary end of turn
    assert.equal(stop(GOOD), null);
    assert.equal(stop("All four ideas are adopted. Nothing else is waiting."), null);
    // a marker under a bad explanation: sent back to be written properly, with what is missing
    v = stop("Pick one of them.\n\nQuestion follows.");
    assert.equal(v.kind, "rewrite");
    assert.match(v.reason, /nothing \(or almost nothing\) was written/);
    // handed back twice for the same question and still no card: let the turn end
    const fb = JSON.stringify({ type: "attachment", attachment: { type: "hook_additional_context", hookName: "Stop", hookEvent: "Stop", content: ["Shipyard: the explanation is shown. Ask the question card now, with nothing written first."] } });
    writeFileSync(t, [user(cmd), say(GOOD + "\n\nQuestion follows."), fb, say(GOOD + "\n\nQuestion follows."), fb].join("\n") + "\n");
    assert.equal(stop(GOOD + "\n\nQuestion follows."), null);
    // a card in between starts the count again: the next question is handed back as usual
    writeFileSync(t, [user(cmd), say("x"), fb, say("x"), fb, card("c1")].join("\n") + "\n");
    assert.equal(stop(GOOD + "\n\nQuestion follows.").kind, "ask");
    // another command, or none
    writeFileSync(t, [user("<command-name>/review</command-name>")].join("\n") + "\n");
    assert.equal(stop(GOOD + "\n\nQuestion follows."), null);
    assert.equal(decideStop({ last_assistant_message: GOOD + "\n\nQuestion follows." }), null);
    assert.equal(decideStop(null), null);
  } finally { f.cleanup(); }
});

test("the hand-back hook is registered on Stop and answers with feedback, never with a block (a block reads 'Stop hook error' to the person)", async () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.Stop.some((h) => /hook-runner\.mjs" ask-after-explain$/.test(h.hooks[0].command)));
  const f = fixture();
  try {
    const t = join(f.base, "t.jsonl");
    writeFileSync(t, JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/shipyard:ship-sprint</command-name>" } }) + "\n");
    const go = (last) => spawnSync("node", [join(ROOT, "bin", "hook-runner.mjs"), "ask-after-explain"], { cwd: f.base, input: JSON.stringify({ hook_event_name: "Stop", transcript_path: t, last_assistant_message: last }), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: f.d } });
    let r = go(GOOD + "\n\nQuestion follows.");
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, undefined);
    assert.equal(out.hookSpecificOutput.hookEventName, "Stop");
    assert.match(out.hookSpecificOutput.additionalContext, /^Shipyard: the explanation is shown\. Ask the question card now/);
    assert.match(readFileSync(join(f.d, ".shipyard-events.jsonl"), "utf8"), /"ask_handed_back"/);
    r = go("The sprint is planned: 3 stories, 13 points.");
    assert.equal(r.status, 0); assert.equal(r.stdout, "", "an ordinary end of turn is left alone");
  } finally { f.cleanup(); }
});

// The owner, 2026-11-15, 4.0.0, a real discussion: "ship-discuss stopped halfway". One story waited on a fact
// only they had; the turn ended on a plain "Want that?" with the critic, the approval card and finalize not done.
test("a discussion that still holds its lock is handed back once when a turn ends with no card on its way", async () => {
  const { decideUnfinished, UNFINISHED } = await import("../bin/hooks/ask-after-explain.mjs");
  const f = fixture();
  try {
    const t = join(f.base, "t.jsonl");
    const user = (text) => ({ type: "user", message: { role: "user", content: text } });
    const say = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
    const write = (...entries) => writeFileSync(t, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const lock = (o) => writeFileSync(join(f.d, ".active-discuss.json"), JSON.stringify({ skill: "ship-discuss", session_id: "s1", cleared: null, started: new Date().toISOString(), ...o }));
    const research = (state) => writeFileSync(join(f.d, ".discuss-questions.json"), JSON.stringify({ version: 2, current: "t", topics: { t: { topic: "t", research: { state }, questions: [], assumptions: [] } } }));
    const stop = (last, session = "s1") => decideUnfinished(f.d, { hook_event_name: "Stop", session_id: session, transcript_path: t, last_assistant_message: last });
    const CMD = user("<command-name>/shipyard:ship-discuss</command-name>");
    const END = "S002 is blocked on the brand colours. I can take the other three to approval next. Want that?";

    write(CMD, say(END));
    assert.equal(stop(END), null, "no discussion lock: nothing to finish");
    lock({});
    let v = stop(END);
    assert.equal(v.kind, "unfinished");
    assert.match(v.reason, /^Shipyard: this discussion is not finished\. Do every remaining step that does not depend on the person now/);
    assert.match(v.reason, /as a question card, never as a plain-text question/);
    assert.match(v.reason, /discuss-questions pause, then shipyard-data lock release discuss/);

    assert.equal(stop(GOOD + "\n\nQuestion follows."), null, "a card is on its way: the other rule hands that back");
    assert.equal(stop(END, "s2"), null, "another session's discussion");
    lock({ cleared: new Date().toISOString(), skill: null }); assert.equal(stop(END), null, "finished or paused: the lock is released");
    lock({});
    research("running"); assert.equal(stop("The critic is reviewing in the background."), null, "waiting for a background agent is not stopping halfway");
    research("done"); assert.equal(stop(END).kind, "unfinished");

    // told once: a second stop in a row is left alone, until the person speaks again
    const handed = { type: "attachment", attachment: { type: "hook_additional_context", hookEvent: "Stop", content: [`${UNFINISHED} Do every remaining step…`] } };
    write(CMD, say(END), handed, say("I still need the brand colours from you."));
    assert.equal(stop("I still need the brand colours from you."), null);
    write(CMD, say(END), handed, say("Still waiting."), user("ok, the other three then"), say("Done with S001. Shall I go on?"));
    assert.equal(stop("Done with S001. Shall I go on?").kind, "unfinished", "after the person's next message it counts again");

    // waiting for a helper dispatched in the background in this stretch is not stopping halfway
    write(CMD, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "a1", name: "Agent", input: { name: "critic-s001", run_in_background: true, prompt: "…" } }] } }, say("The critic is reviewing S001 and S002."));
    assert.equal(stop("The critic is reviewing S001 and S002."), null);
    write(CMD, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "a1", name: "Agent", input: { name: "critic-s001", run_in_background: true, prompt: "…" } }] } }, user("the critic is back: go on"), say("Shall I continue?"));
    assert.equal(stop("Shall I continue?").kind, "unfinished", "after the person's next message a helper from before no longer explains a stop");

    // another command typed in the same session is not the discussion
    write(CMD, say(END), user("<command-name>/shipyard:ship-status</command-name>"), say("Status: 4 stories."));
    assert.equal(stop("Status: 4 stories."), null);

    // a question the list handed out and that was never asked is named
    writeFileSync(join(f.d, ".discuss-questions.json"), JSON.stringify({ version: 2, current: "t", topics: { t: { topic: "t", research: { state: "none" }, questions: [{ id: "Q7", status: "asked", question: "Which colours?" }], assumptions: [] } } }));
    write(CMD, say(END));
    assert.match(stop(END).reason, /Q7 is handed out and not asked yet: ask it\./);

    // through the hook runner: feedback, and an event
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
    const r = spawnSync("node", [join(ROOT, "bin", "hook-runner.mjs"), "ask-after-explain"], { cwd: f.base, input: JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: t, last_assistant_message: END }), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: f.d } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^Shipyard: this discussion is not finished\./);
    assert.match(readFileSync(join(f.d, ".shipyard-events.jsonl"), "utf8"), /"discuss_stop_handed_back"/);
  } finally { f.cleanup(); }
});

// A real discussion's transcript was 3.9 MB and the hooks read its last 1.5 MB: the `/ship-discuss` line was
// above the window, so every rule that needs to know the command went quiet partway through.
test("the running command is found even when its line is above the part of the transcript the hooks read", async () => {
  const { commandStart, transcriptTail } = await import("../bin/hooks/unattended-ask.mjs");
  const f = fixture();
  try {
    const t = join(f.base, "t.jsonl");
    const filler = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "a tool result that mentions <command-name>/shipyard:ship-status</command-name> " + "x".repeat(200000) }] } });
    const lines = [JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/shipyard:ship-discuss</command-name>" } }), ...Array.from({ length: 10 }, () => filler), JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: GOOD + "\n\nQuestion follows." }] } })];
    writeFileSync(t, lines.join("\n") + "\n");
    const input = { transcript_path: t, tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Bundle?", options: [] }] } };
    const entries = transcriptTail(input);
    assert.ok(entries.length < lines.length, "the fixture is larger than the window");
    assert.equal(commandStart(entries), null, "the tail alone does not hold the command line");
    assert.deepEqual(commandStart(entries, input), { start: -1, name: "shipyard:ship-discuss" }, "a tool result that only mentions the tag is not the command");
    assert.equal(decideExplained(input), null, "the explanation in the tail is still found and accepted");
    writeFileSync(t, lines.slice(0, -1).join("\n") + "\n");
    assert.equal(decideExplained(input).reason, HELD, "and a card with nothing above it is still held, deep into a long session");
  } finally { f.cleanup(); }
});

test("a held card: the person's line is the deny reason, the session's steps are additionalContext", () => {
  const f = fixture();
  try {
    const t = join(f.base, "t.jsonl");
    writeFileSync(t, JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/shipyard:ship-sprint</command-name>" } }) + "\n");
    const chunks = [], w = process.stdout.write;
    process.stdout.write = (c) => { chunks.push(String(c)); return true; };
    try { runAskHook({ tool_name: "AskUserQuestion", transcript_path: t, session_id: "s1", tool_input: { questions: [{ question: "Start the sprint?", options: [{ label: "Yes" }, { label: "No" }] }] } }, { SHIPYARD_DATA: f.data }); } finally { process.stdout.write = w; }
    const out = JSON.parse(chunks.join("")).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.equal(out.permissionDecisionReason, HELD);
    assert.match(out.additionalContext, /Shipyard held this card/);
  } finally { f.cleanup(); }
});

test("after a held card, the marker alone: handed back when the explanation was above the card as text, told plainly when it was only reasoning", async () => {
  const { decideStop, HANDED_BACK } = await import("../bin/hooks/ask-after-explain.mjs");
  const f = fixture();
  try {
    const t = join(f.base, "t.jsonl");
    const user = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
    const inMsg = (id, block) => JSON.stringify({ type: "assistant", message: { id, role: "assistant", content: [block] } });
    const cardBlock = { type: "tool_use", id: "c0", name: "AskUserQuestion", input: { questions: [{ question: "q" }] } };
    const refused = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c0", is_error: true, content: "PreToolUse:AskUserQuestion hook error: Shipyard: one moment." }] } });
    const cmd = user("<command-name>/shipyard:ship-discuss</command-name>");
    const stop = { transcript_path: t, last_assistant_message: "Question follows." };
    // the explanation was text in the held card's own message: nothing is written twice
    writeFileSync(t, [cmd, inMsg("m1", { type: "text", text: GOOD + "\n\nQuestion follows." }), inMsg("m1", cardBlock), refused].join("\n") + "\n");
    assert.deepEqual(decideStop(stop), { kind: "ask", reason: HANDED_BACK, same_message: true });
    // it was reasoning: said here, as feedback, with what to write
    writeFileSync(t, [cmd, inMsg("m1", { type: "thinking", thinking: GOOD }), inMsg("m1", cardBlock), refused].join("\n") + "\n");
    const v = decideStop(stop);
    assert.equal(v.kind, "rewrite");
    assert.match(v.reason, /the explanation of this question is not on screen yet: no message above the card holds it, and the person sees only messages\. Write it now as your message/);
    // the marker alone with no held card above it is what it always was: nothing written
    writeFileSync(t, cmd + "\n");
    assert.match(decideStop(stop).reason, /not ready for the question card: nothing \(or almost nothing\) was written/);
  } finally { f.cleanup(); }
});
