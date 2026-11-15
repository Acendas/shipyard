/**
 * `shipyard-data story-review <record|disposition|check>` (F028 — per-story review inside execute).
 *
 * When a story's last step merges at a wave boundary, /ship-execute runs spec
 * review and gap analysis for THAT story and records the outcome here. The
 * sprint gates read these records, so the sprint-level review no longer repeats
 * per-story findings (it keeps the cross-story checks, the full build, the demo
 * and the retro).
 *
 *   record <S###> --verdict <approve|changes> [--spec <PASS|FINDINGS>] [--gaps <n>] [--head <sha>] [--sprint <id>] [--note "..."]
 *     → ledger entry in sprints/current/.story-reviews.json (CLI-owned) + event `story_reviewed`.
 *   disposition <S###> --via <patch_steps|bug_story|needs_attention|accepted> [--ids <id,id>] [--sprint <id>]
 *     → event `story_review_dispositioned` (a `changes` verdict is settled only once dispositioned).
 *   check [--sprint <id>] [--json]
 *     → one line per story in SPRINT.md: steps done/total, verdict, disposition, settled?;
 *       exit 3 naming stories that are COMPLETE (every step done or parked) but not settled.
 *
 * Settled = verdict approve, or verdict changes with a later disposition.
 * The terminal gate and sprint-complete invariant 9 use the same `storySettled`
 * so the three readers never disagree. `execution.story_review: false`
 * restores the pre-4.1 behavior (no per-story requirement).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { parseFrontmatter, parseWaves, readEvents, storySettled, sprintStoryIds } from "./terminal-gate.mjs";
export { storySettled };
import { eventMatches, inSprintWindow, isBuilderRecord, isStoryId, WAVE_UNIT_ID_SRC } from "./vocab.mjs";
import { parseFlags } from "./cli-flags.mjs";
import { readExecuteCodeReview, readExecuteDesignReview } from "./config-read.mjs";
import { readDesign } from "./design.mjs";

export const LEDGER_BASENAME = ".story-reviews.json";
const VERDICTS = ["approve", "changes"];
const VIAS = ["patch_steps", "bug_story", "needs_attention", "accepted"];

function ledgerPath(dataDir) {
  return join(dataDir, "sprints", "current", LEDGER_BASENAME);
}
export function readLedger(dataDir) {
  const p = ledgerPath(dataDir);
  if (!existsSync(p)) return { version: 1, stories: {} };
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j && typeof j === "object" && j.stories ? j : { version: 1, stories: {} };
  } catch {
    return { version: 1, stories: {} };
  }
}

/** The approved (not waived) design of a `ui: true` story, or null. */
function designedUiStory(dataDir, story) {
  for (const sub of ["stories", "features", "bugs"]) {
    let names = [];
    try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
    const n = names.find((x) => x.startsWith(`${story}-`) && x.endsWith(".md"));
    if (!n) continue;
    const m = readFileSync(join(dataDir, "spec", sub, n), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m || !/^ui:\s*true\b/m.test(m[1])) return null;
    const d = readDesign(m[1]);
    return d && !d.waived && d.path ? d : null;
  }
  return null;
}

function sprintInfo(dataDir) {
  const p = join(dataDir, "sprints", "current", "SPRINT.md");
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8");
  const fm = parseFrontmatter(text);
  return { id: String(fm.id || "").trim() || null, storyIds: sprintStoryIds(text), waves: parseWaves(text), text };
}

/** Which story each sprint step belongs to, from spec/steps + legacy spec/tasks frontmatter. */
export function stepOwners(dataDir, stepIds) {
  const owners = new Map();
  for (const sub of ["steps", "tasks"]) {
    const dir = join(dataDir, "spec", sub);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".md")) continue;
      // The same id shape parseWaves accepts (P###, T###, T-P###, T-HOT1): a story
      // whose remaining steps are patch tasks must still be able to complete.
      const id = (n.match(new RegExp(`^(${WAVE_UNIT_ID_SRC})(?=-|\\.md$)`)) || [])[1];
      if (!id || !stepIds.includes(id) || owners.has(id)) continue;
      try {
        const fm = parseFrontmatter(readFileSync(join(dir, n), "utf8"));
        if (sub === "tasks" && !isBuilderRecord(fm)) continue;
        owners.set(id, { story: String(fm.story || fm.feature || "").trim(), status: String(fm.status || "").trim() });
      } catch { /* unreadable: no owner */ }
    }
  }
  return owners;
}

/** Per-story status for the current sprint. Pure over inputs read from disk. */
export function computeStoryReviewStatus(dataDir, { sprint = null } = {}) {
  const info = sprintInfo(dataDir);
  if (!info) return { sprint: null, stories: [], unsettled: [] };
  const sprintId = sprint ?? info.id;
  const stepIds = info.waves.flatMap((w) => w.tasks);
  const owners = stepOwners(dataDir, stepIds);
  const events = readEvents(dataDir);
  const rows = info.storyIds.map((story) => {
    const mine = stepIds.filter((s) => owners.get(s)?.story === story);
    const done = mine.filter((s) => ["done", "blocked", "needs-attention"].includes(owners.get(s)?.status));
    const { verdict, settled } = storySettled(events, story, sprintId);
    const complete = mine.length > 0 && done.length === mine.length;
    return { story, steps: mine.length, done: done.length, complete, verdict, settled };
  });
  return { sprint: sprintId, stories: rows, unsettled: rows.filter((r) => r.complete && !r.settled).map((r) => r.story) };
}

function usage(msg) {
  process.stderr.write(
    `shipyard-data story-review: ${msg}\n` +
      "  Usage: story-review record <S###> --verdict <approve|changes> --code <CLEAN|FINDINGS> [--code-findings <n>] [--design <MATCHES|DIFFERS|UNVERIFIED> [--design-findings <n>]] [--spec <PASS|FINDINGS>] [--gaps <n>] [--head <sha>] [--sprint <id>] [--note \"...\"]\n" +
      "         story-review disposition <S###> --via <patch_steps|bug_story|needs_attention|accepted> [--ids <id,...>] [--sprint <id>]\n" +
      "         story-review check [--sprint <id>] [--json]\n",
  );
  process.exit(2);
}

const flags = (args) => parseFlags(args, usage);

export function main(dataDir, args = []) {
  const sub = args[0];
  const o = flags(args.slice(1));
  const info = sprintInfo(dataDir);
  const sprintId = o.sprint ?? info?.id ?? "unknown";
  if (sub === "record") {
    const story = o._[0];
    if (!story || !isStoryId(story)) usage("record needs a story id (S###, or a legacy F###/B### alias)");
    if (!VERDICTS.includes(o.verdict ?? "")) usage(`--verdict must be one of ${VERDICTS.join("|")}`);
    if (o.spec !== undefined && !["PASS", "FINDINGS"].includes(o.spec)) usage("--spec must be PASS or FINDINGS");
    const gaps = o.gaps === undefined ? null : Number(o.gaps);
    if (gaps !== null && (!Number.isInteger(gaps) || gaps < 0)) usage("--gaps must be a non-negative integer");
    if (o.head !== undefined && !/^[0-9a-fA-F]{7,40}$/.test(o.head)) usage("--head must be a 7-40 hex sha");
    if (o.code !== undefined && !["CLEAN", "FINDINGS"].includes(o.code)) usage("--code must be CLEAN or FINDINGS");
    const codeFindings = o["code-findings"] === undefined ? null : Number(o["code-findings"]);
    if (codeFindings !== null && (!Number.isInteger(codeFindings) || codeFindings < 0)) usage("--code-findings must be a non-negative integer");
    // 4.6: the code review is part of the per-story review in /ship-execute.
    // A story cannot be recorded as reviewed without its code-review result
    // (execution.code_review: false restores the old sprint-end review).
    if (o.code === undefined && readExecuteCodeReview(dataDir)) {
      process.stderr.write(
        `shipyard-data story-review: ${story} has no code-review result — run the code review for this story (dispatching-code-review, scope: feature) and pass --code CLEAN|FINDINGS [--code-findings <n>]. ` +
          "Set execution.code_review: false to review code at /ship-review instead.\n",
      );
      process.exit(3);
    }
    if (o.code === "FINDINGS" && o.verdict === "approve") usage("--code FINDINGS cannot be recorded with --verdict approve; use changes and disposition the findings");
    // 4.8: a UI story with a signed-off design is not reviewed until the
    // delivered screen has been put beside that design. The owner's report:
    // "I gave the design; the delivered product looked nothing like it" — the
    // design was gated at approval and before the sprint, but nothing compared
    // what was built. The comparison itself is `ui verify --level screen`
    // (a pixel verdict for an exact snapshot; a side-by-side image for a
    // mockup); this records what it showed.
    const designed = readExecuteDesignReview(dataDir) ? designedUiStory(dataDir, story) : null;
    if (o.design !== undefined && !["MATCHES", "DIFFERS", "UNVERIFIED"].includes(o.design)) usage("--design must be MATCHES, DIFFERS or UNVERIFIED");
    const designFindings = o["design-findings"] === undefined ? null : Number(o["design-findings"]);
    if (designFindings !== null && (!Number.isInteger(designFindings) || designFindings < 0)) usage("--design-findings must be a non-negative integer");
    if (designed) {
      const refuse = (msg) => { process.stderr.write(`shipyard-data story-review: ${msg}\n`); process.exit(3); };
      const how = `shipyard-data ui verify --level screen --story ${story} ${designed.scene ? "" : "--scene <name> | --image <frame.png>"}`.trim();
      if (o.design === undefined) {
        refuse(`${story} is a UI story with an approved design (v${designed.version}) — compare the delivered screen with it (\`${how}\`), look at the result, and pass --design MATCHES|DIFFERS [--design-findings <n>]. If the screen cannot be rendered here, pass --design UNVERIFIED --note "<why>" (the sprint review lists it as not verified). Set execution.design_review: false to skip.`);
      }
      if (o.design === "UNVERIFIED") {
        if (!(o.note && o.note.trim())) refuse(`${story}: --design UNVERIFIED needs --note "<why the delivered screen could not be compared with the design>"`);
      } else {
        const events = readEvents(dataDir, 20000);
        const start = Math.min(...events.filter((e) => inSprintWindow(e, sprintId)).map((e) => Date.parse(e.ts)).filter(Number.isFinite));
        const runs = events.filter((e) => e.type === "ui_verified" && e.story === story && e.level === "screen" && (!Number.isFinite(start) || Date.parse(e.ts) >= start));
        const last = runs[runs.length - 1];
        if (!last) refuse(`${story}: no comparison of the delivered screen with the design is on record for this sprint — run \`${how}\` first`);
        const failed = last.result === "fail" || last.verdict === "FAIL";
        if (failed && o.design === "MATCHES") refuse(`${story}: the last comparison FAILED (the screen differs from the approved design) — record --design DIFFERS with --verdict changes, fix it in the sprint, and compare again`);
      }
      if (o.design === "DIFFERS" && o.verdict === "approve") usage("--design DIFFERS cannot be recorded with --verdict approve; use changes and disposition the findings (a patch step, or re-approve the design with the owner)");
    }
    const ledger = readLedger(dataDir);
    const entry = { verdict: o.verdict, spec: o.spec ?? null, gaps, code: o.code ?? null, code_findings: codeFindings, design: o.design ?? null, design_findings: designFindings, head: o.head ?? null, sprint: sprintId, note: o.note ?? "", at: new Date().toISOString() };
    ledger.stories[story] = entry;
    atomicWrite(ledgerPath(dataDir), JSON.stringify(ledger, null, 2) + "\n");
    try { logEvent(dataDir, "story_reviewed", { story, sprint: sprintId, verdict: o.verdict, spec: entry.spec ?? "", gaps: gaps ?? "", code: entry.code ?? "", code_findings: codeFindings ?? "", design: entry.design ?? "", design_findings: designFindings ?? "", head: entry.head ?? "" }); } catch { /* best-effort */ }
    process.stdout.write(`${story}: reviewed — ${o.verdict}${o.verdict === "changes" ? " (settle it with `story-review disposition` after the findings are routed)" : ""}\n`);
    return;
  }
  if (sub === "disposition") {
    const story = o._[0];
    if (!story || !isStoryId(story)) usage("disposition needs a story id");
    if (!VIAS.includes(o.via ?? "")) usage(`--via must be one of ${VIAS.join("|")}`);
    const ledger = readLedger(dataDir);
    const prior = ledger.stories[story];
    if (!prior) {
      process.stderr.write(`shipyard-data story-review: ${story} has no review record yet — run \`story-review record\` first\n`);
      process.exit(3);
    }
    ledger.stories[story] = { ...prior, disposition: { via: o.via, ids: o.ids ?? "", at: new Date().toISOString() } };
    atomicWrite(ledgerPath(dataDir), JSON.stringify(ledger, null, 2) + "\n");
    try { logEvent(dataDir, "story_review_dispositioned", { story, sprint: sprintId, via: o.via, ids: o.ids ?? "" }); } catch { /* best-effort */ }
    process.stdout.write(`${story}: findings dispositioned via ${o.via}\n`);
    return;
  }
  if (sub === "check") {
    const r = computeStoryReviewStatus(dataDir, { sprint: o.sprint ?? null });
    if (o.json) process.stdout.write(JSON.stringify(r) + "\n");
    else {
      if (!r.sprint) process.stdout.write("no current sprint\n");
      for (const s of r.stories) {
        process.stdout.write(`${s.story}: steps ${s.done}/${s.steps}${s.complete ? " complete" : ""}; review ${s.verdict ?? "none"}${s.settled ? " (settled)" : s.verdict ? " (unsettled)" : ""}\n`);
      }
    }
    if (r.unsettled.length) {
      process.stderr.write(`shipyard-data story-review check: ${r.unsettled.length} complete stor${r.unsettled.length === 1 ? "y" : "ies"} without a settled review: ${r.unsettled.join(", ")} — run spec review + gap analysis for each and record the verdict\n`);
      process.exit(3);
    }
    return;
  }
  usage(`unknown subcommand "${sub ?? ""}"`);
}
