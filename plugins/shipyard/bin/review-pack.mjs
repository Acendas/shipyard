/**
 * `shipyard-data review-pack [--sprint <id>] [--base <sha> --head <sha>] [--json]` (v4.6)
 *
 * The facts half of the sprint review. /ship-review is a review for the owner
 * (evidence, numbers, decisions, what was not done and why, what to improve),
 * and every number in it comes from here — the event log, the spec files and
 * git — never from the model's recollection of the sprint ("planner numbers
 * are CLI output" applied to the review). The skill adds the narrative: what a
 * user can do now, before/after, the proposed action items.
 *
 * Pure over what it reads; writes nothing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseFrontmatter, parseWaves, sprintStoryIds } from "./terminal-gate.mjs";
import { readEvents as readEventsWithArchive, activeTime } from "./event-report.mjs";
import { eventMatches, inSprintWindow, isStepSpawn } from "./vocab.mjs";
import { atomicWrite } from "./_hook_lib.mjs";
import { getProjectRoot } from "./shipyard-resolver.mjs";
import { readDesign } from "./design.mjs";
import { evaluateFreshness, FULL_SUITE_KEY } from "./verify-ledger.mjs";
import { hasConfiguredCommand } from "./config-read.mjs";

const TEST_RE = /(^|[\\/])(tests?|__tests__|spec|specs)([\\/]|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py|rb|kt|java|rs|c)$|(^|[\\/])test_[^\\/]+$/i;

function readIf(p) { try { return readFileSync(p, "utf8"); } catch { return null; } }
function findRecord(dataDir, dirs, id) {
  for (const sub of dirs) {
    const dir = join(dataDir, "spec", sub);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    const n = names.find((x) => x === `${id}.md` || x.startsWith(`${id}-`));
    if (n) return join(dir, n);
  }
  return null;
}
function git(args, cwd) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim(); } catch { return null; }
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * The sprint's quality gates as the planner wrote them (QUALITY-GATE.md): every
 * table row whose first cell is a number, with the section it sits under.
 * The planner writes this file for every sprint, but since 4.6 the default
 * review path never read it, so a gate could be planned and never checked.
 */
export function readQualityGates(dataDir, sprintDir = "current") {
  const text = readIf(join(dataDir, "sprints", sprintDir, "QUALITY-GATE.md"));
  if (!text) return [];
  const out = [];
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { section = h[1].trim(); continue; }
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    out.push({ section, n: c[0], gate: c[1] ?? "", source: c[2] ?? "", type: (c[3] ?? "").toLowerCase(), command: c[4] ?? "" });
  }
  return out;
}

/** Build the facts object. `events` is the full ordered log (archives included). */
export function buildReviewPack(dataDir, { sprint = null, base = null, head = null, events = null, cwd = null } = {}) {
  const currentPath = join(dataDir, "sprints", "current", "SPRINT.md");
  const currentText = readIf(currentPath);
  const currentId = currentText ? String(parseFrontmatter(currentText).id ?? "").trim() : "";
  const sprintId = sprint ?? currentId;
  const sprintText = sprintId && sprintId !== currentId ? readIf(join(dataDir, "sprints", sprintId, "SPRINT.md")) : currentText;
  if (!sprintText) return { error: sprintId ? `no SPRINT.md for ${sprintId}` : "no current sprint (pass --sprint <id> for an archived one)" };
  const fm = parseFrontmatter(sprintText);
  const all = events ?? readEventsWithArchive(dataDir).events;
  const tagged = all.filter((e) => inSprintWindow(e, sprintId)).map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  const lo = tagged.length ? Math.min(...tagged) : null;
  const hi = tagged.length ? Math.max(...tagged) : null;
  const win = lo === null ? [] : all.filter((e) => { const t = Date.parse(e.ts); return Number.isFinite(t) && t >= lo && t <= hi; });
  const of = (...names) => win.filter((e) => eventMatches(e, ...names));

  // ---- stories
  const storyIds = sprintStoryIds(sprintText);
  const stories = storyIds.map((id) => {
    const f = findRecord(dataDir, ["stories", "features", "bugs"], id);
    const text = f ? readIf(f) : null;
    const sfm = text ? parseFrontmatter(text) : {};
    const reviewed = of("story_reviewed").filter((e) => (e.story || e.feature) === id).pop() ?? null;
    const dispo = of("story_review_dispositioned").filter((e) => (e.story || e.feature) === id).pop() ?? null;
    const probe = of("acceptance_probe_completed").filter((e) => (e.feature || e.story) === id).pop() ?? null;
    const lastProof = of("user_flow_probe_confirmed", "user_flow_probe_retracted").filter((e) => (e.feature || e.story) === id).pop() ?? null;
    const confirmed = lastProof && eventMatches(lastProof, "user_flow_probe_confirmed") ? lastProof : null;
    const ui = of("ui_verified").filter((e) => e.story === id);
    const risk = of("risk_scored").filter((e) => e.story === id).map((e) => String(e.level || "")).filter(Boolean);
    const order = ["low", "medium", "high", "critical"];
    return {
      id,
      title: String(sfm.title ?? "").replace(/^"|"$/g, ""),
      status: String(sfm.status ?? ""),
      points: num(sfm.story_points),
      type: String(sfm.type ?? ""),
      scenarios: text ? (text.match(/@AC-\d+/g) || []).length : 0,
      ui: /^ui:\s*true\b/m.test(text ?? ""),
      design: (() => { const d = readDesign(text ?? ""); return !d ? null : d.waived && !d.hash ? "waived" : d.version ? `v${d.version}` : null; })(),
      review: reviewed ? { verdict: reviewed.verdict ?? "", spec: reviewed.spec ?? "", gaps: num(reviewed.gaps), code: reviewed.code ?? "", code_findings: num(reviewed.code_findings), design: reviewed.design ?? "", design_findings: num(reviewed.design_findings), disposition: dispo ? dispo.via : null } : null,
      user_flow: confirmed ? `confirmed by a person (${confirmed.verdict ?? "pass"})` : probe ? String(probe.verdict ?? (num(probe.exit_code) === 0 ? "PASS" : "FAIL")) : "not run",
      ui_verify: ui.length ? { runs: ui.length, failed: ui.filter((e) => /FAIL/i.test(String(e.verdict ?? e.result ?? ""))).length, side_by_side: [...ui].reverse().find((e) => e.side_by_side)?.side_by_side ?? null } : null,
      risk: risk.length ? risk.sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] : null,
    };
  });
  const delivered = stories.filter((s) => ["done", "deployed", "released"].includes(s.status));
  // Built and reviewed (4.13.2): at review time every story is still
  // `in-progress` (acceptance marks it done), so "delivered 0" was the first
  // line the owner read for a sprint that had built all five.
  const ready = stories.filter((s) => ["done", "deployed", "released"].includes(s.status) || (s.review && (s.review.verdict === "approve" || s.review.disposition)));

  // ---- steps
  const waves = parseWaves(sprintText);
  const planned = waves.flatMap((w) => w.tasks);
  const stepInfo = (id) => {
    const f = findRecord(dataDir, ["steps", "tasks", join("archive", "steps"), join("archive", "tasks")], id);
    const sfm = f ? parseFrontmatter(readIf(f) ?? "") : {};
    return { id, status: String(sfm.status ?? "unknown"), title: String(sfm.title ?? "").replace(/^"|"$/g, ""), reason: String(sfm.blocked_reason ?? sfm.attention_reason ?? sfm.needs_attention_reason ?? sfm.reason ?? "").replace(/^"|"$/g, "") };
  };
  const added = [...new Map(of("patch_step_created").map((e) => [String(e.step ?? e.task_id ?? e.task ?? ""), e])).entries()]
    .filter(([id]) => id).map(([id, e]) => ({ id, source: String(e.source ?? e.reason ?? ""), story: String(e.feature ?? e.story ?? "") }));
  const allSteps = [...new Set([...planned, ...added.map((a) => a.id)])].map(stepInfo);
  const parked = allSteps.filter((s) => ["blocked", "needs-attention"].includes(s.status));

  // ---- quality work done in execute
  const verify = of("wave_verify_findings");
  const sum = (k) => verify.reduce((n, e) => n + num(e[k] ?? e[k.toLowerCase()] ?? (e.classes && e.classes[k])), 0);
  const quality = {
    wave_spec_verify: { runs: verify.length, met: sum("MET"), partial: sum("PARTIAL"), missing: sum("MISSING"), over_built: sum("OVER-BUILT") },
    story_reviews: stories.filter((s) => s.review).length,
    spec_findings_stories: stories.filter((s) => s.review?.spec === "FINDINGS").length,
    gaps_found: stories.reduce((n, s) => n + (s.review?.gaps ?? 0), 0),
    code_findings: stories.reduce((n, s) => n + (s.review?.code_findings ?? 0), 0),
    patch_steps: added.length,
    dispositions: stories.reduce((m, s) => { if (s.review?.disposition) m[s.review.disposition] = (m[s.review.disposition] ?? 0) + 1; return m; }, {}),
    outside_touches: of("step_outside_touches").filter((e) => num(e.v) >= 3).map((e) => ({ step: String(e.step ?? ""), count: num(e.count), collides: String(e.collides ?? "") })),
    cross_story_code_review: of("pipeline_tick_completed").some((e) => e.pipeline === "ship-execute" && e.stage === "sprint_code_review"),
  };

  // ---- decisions made without asking
  const decisions = of("execute_decision").map((e) => ({ stage: String(e.stage ?? ""), subject: String(e.subject ?? ""), source: String(e.source ?? ""), decision: String(e.decision ?? ""), rationale: String(e.rationale ?? "") }));
  const bySource = decisions.reduce((m, d) => { m[d.source || "unspecified"] = (m[d.source || "unspecified"] ?? 0) + 1; return m; }, {});

  // ---- effort
  const claims = of("worker_queue_claimed").filter((e) => e.pipeline === "ship-execute");
  // A sprint built in place (solo) spawns its builders without the queue: count
  // those runs too, or the review says "0 builder runs" (seen in sprint-012).
  const stepSpawns = win.filter(isStepSpawn);
  const attempts = of("dispatch_attempt");
  const at = lo === null ? { activeMs: 0, spanMs: 0 } : activeTime(win);
  const waveTimes = waves.map((w) => {
    const start = win.find((e) => eventMatches(e, "pipeline_tick_started") && e.stage === `wave_${w.wave}_dispatch`);
    const end = [...win].reverse().find((e) => eventMatches(e, "pipeline_tick_completed") && e.stage === `wave_${w.wave}_gate`);
    const ms = start && end ? Date.parse(end.ts) - Date.parse(start.ts) : null;
    return { wave: w.wave, steps: w.tasks.length, minutes: ms !== null && Number.isFinite(ms) ? Math.round(ms / 60000) : null };
  });
  const effort = {
    active_minutes: Math.round(at.activeMs / 60000),
    span_minutes: Math.round((at.spanMs ?? 0) / 60000),
    builder_dispatches: Math.max(claims.length, stepSpawns.length),
    distinct_agents: new Set([...claims.map((e) => e.worker), ...of("agent_spawned").map((e) => e.agent)].filter(Boolean)).size,
    redispatches: attempts.length,
    warm_fixes: attempts.filter((e) => e.mode === "warm").length,
    consults: of("escalation_consult_dispatched").length,
    full_suite_runs: of("verification_recorded").length,
    suite_proof: (() => { try { const r = evaluateFreshness(dataDir, { key: FULL_SUITE_KEY }); return r.fresh ? { key: FULL_SUITE_KEY, fresh: true, recorded_at: String(r.entry.recordedAt ?? ""), command: String(r.entry.command ?? "") } : { key: FULL_SUITE_KEY, fresh: false, reason: r.reason }; } catch { return { key: FULL_SUITE_KEY, fresh: false, reason: "unevaluable" }; } })(),
    suite_reuses: of("verification_reused").length,
    // 4.0: every captured build and test run, with its time. The largest
    // single cost of a real sprint was invisible in its review.
    command_runs: (() => {
      const runs = of("command_run").map((e) => ({ name: String(e.name ?? ""), seconds: num(e.seconds), exit: num(e.exit), end: Date.parse(e.ts) }));
      const total = runs.reduce((n, r) => n + r.seconds, 0);
      // Builders run side by side, so the sum of run times is more than the
      // time on the clock. `wall_minutes` is the time during which at least
      // one run was going: the first live sprint printed "178 min, 50% of
      // active time" from the sum, which no clock ever showed.
      let wall = 0, hi = -Infinity;
      for (const r of runs.filter((x) => Number.isFinite(x.end)).map((x) => [x.end - x.seconds * 1000, x.end]).sort((a, b) => a[0] - b[0])) {
        if (r[1] <= hi) continue;
        wall += r[1] - Math.max(r[0], hi);
        hi = r[1];
      }
      return {
        count: runs.length,
        minutes: Math.round(total / 60),
        wall_minutes: Math.round(wall / 60000),
        failed: runs.filter((r) => r.exit !== 0).length,
        longest: [...runs].sort((a, b) => b.seconds - a.seconds).slice(0, 3).map((r) => ({ name: r.name, minutes: Math.round(r.seconds / 6) / 10 })),
        scoped_set: hasConfiguredCommand(dataDir, "test_commands", "scoped"),
        rerun_failed_set: hasConfiguredCommand(dataDir, "test_commands", "rerun_failed"),
      };
    })(),
    waves: waveTimes,
    interface_relays: of("interface_change_relayed").length,
    // v4.10: which model finished each step, and how many steps had to climb a rung.
    by_model: (() => {
      const last = new Map();
      for (const e of of("task_dispatch_returned")) { const id = String(e.task ?? e.task_id ?? ""); if (id && e.status === "complete") last.set(id, { model: String(e.model || "session"), attempt: Number(e.attempt) || 1 }); }
      const out = {};
      for (const { model, attempt } of last.values()) { out[model] ??= { steps: 0, climbed: 0 }; out[model].steps++; if (attempt > 1) out[model].climbed++; }
      return out;
    })(),
  };

  // ---- discovered, not done
  const ideasDir = join(dataDir, "spec", "ideas");
  let ideas = [];
  try {
    const since = lo === null ? null : new Date(lo).toISOString().slice(0, 10);
    ideas = readdirSync(ideasDir).filter((n) => n.endsWith(".md")).map((n) => {
      const ifm = parseFrontmatter(readIf(join(ideasDir, n)) ?? "");
      const q = (v) => String(v ?? "").replace(/^"|"$/g, "");
      return { id: String(ifm.id ?? n.split("-").slice(0, 2).join("-")), title: q(ifm.title), status: String(ifm.status ?? ""), created: String(ifm.created ?? ifm.captured ?? ""), kind: q(ifm.kind), severity: q(ifm.severity), fixed_by: q(ifm.fixed_by), reason: q(ifm.triage_reason) };
    }).filter((i) => since && i.created >= since && !["promoted", "graduated", "rejected", "landed"].includes(i.status));
  } catch { ideas = []; }
  const pendingHuman = stories.filter((s) => /PENDING_HUMAN/.test(s.user_flow)).map((s) => s.id);

  // ---- code delta
  let code = null;
  if (base && head) {
    const root = cwd ?? (() => { try { return getProjectRoot(); } catch { return process.cwd(); } })();
    const numstat = git(["diff", "--numstat", `${base}..${head}`], root);
    if (numstat !== null) {
      let files = 0, added2 = 0, deleted = 0, testFiles = 0, testAdded = 0;
      for (const line of numstat.split("\n")) {
        if (!line.trim()) continue;
        const [a, d, ...rest] = line.split("\t");
        const f = rest.join("\t");
        files++; added2 += num(a); deleted += num(d);
        if (TEST_RE.test(f)) { testFiles++; testAdded += num(a); }
      }
      code = { base, head, commits: num(git(["rev-list", "--count", `${base}..${head}`], root)), files, added: added2, deleted, test_files: testFiles, test_lines_added: testAdded };
    }
  }

  // ---- trend
  let velocity = null;
  try {
    const m = JSON.parse(readFileSync(join(dataDir, "memory", "metrics.json"), "utf8"));
    const recs = Array.isArray(m?.velocity?.recent) ? m.velocity.recent : Array.isArray(m?.sprints) ? m.sprints : null;
    if (recs) velocity = recs.slice(-5).map((r) => ({ sprint: r.sprint ?? r.id ?? "", points: num(r.velocity ?? r.points) }));
  } catch { velocity = null; }

  return {
    sprint: { id: sprintId, goal: String(fm.goal ?? "").replace(/^"|"$/g, ""), status: String(fm.status ?? ""), capacity: String(fm.capacity ?? ""), mode: String(fm.execution_mode ?? ""), started: lo === null ? null : new Date(lo).toISOString(), ended: hi === null ? null : new Date(hi).toISOString() },
    outcome: { stories_planned: stories.length, stories_delivered: delivered.length, stories_ready: ready.length, points_ready: ready.reduce((n, s) => n + s.points, 0), points_planned: stories.reduce((n, s) => n + s.points, 0), points_delivered: delivered.reduce((n, s) => n + s.points, 0), steps_planned: planned.length, steps_added: added.length, steps_parked: parked.length, steps_done: allSteps.filter((x) => x.status === "done").length, steps_total: allSteps.length },
    stories, steps_added: added, steps_parked: parked, quality, decisions, decisions_by_source: bySource, effort,
    quality_gates: readQualityGates(dataDir, sprintId === currentId ? "current" : sprintId),
    not_done: { stories: stories.filter((s) => !["done", "deployed", "released"].includes(s.status)).map((s) => ({ id: s.id, status: s.status, title: s.title })), parked_steps: parked, ideas_captured: ideas, pending_human_probes: pendingHuman },
    code, velocity,
  };
}

const proofLine = (e) => !e.suite_proof ? "not evaluated" : e.suite_proof.fresh
  ? `fresh for this tree${e.suite_proof.command ? `: \`${e.suite_proof.command}\`` : ""}, recorded ${e.suite_proof.recorded_at} — reuse it, do not re-run`
  : `stale (${e.suite_proof.reason}) — re-run and record under ${e.suite_proof.key}`;

export function renderReviewPack(p) {
  const L = [];
  const row = (...c) => L.push(`| ${c.join(" | ")} |`);
  L.push(`# Sprint review facts — ${p.sprint.id}`, "", `Goal: ${p.sprint.goal || "(none recorded)"}`, "");
  L.push("## Outcome", "");
  row("Measure", "Planned", "Built and reviewed", "Accepted (done)"); row("---", "---", "---", "---");
  row("Stories", p.outcome.stories_planned, p.outcome.stories_ready, p.outcome.stories_delivered);
  row("Points", p.outcome.points_planned, p.outcome.points_ready, p.outcome.points_delivered);
  row("Steps", p.outcome.steps_planned, "", `${p.outcome.steps_done} of ${p.outcome.steps_total} done (${p.outcome.steps_added} added in sprint, ${p.outcome.steps_parked} parked)`);
  L.push("", "## Stories and their evidence", "");
  row("Story", "Pts", "Status", "Scenarios", "Spec", "Gaps", "Code review", "User flow", "Design / UI verify", "Risk"); row("---", "---", "---", "---", "---", "---", "---", "---", "---", "---");
  for (const s of p.stories) row(`${s.id} ${s.title}`.trim().slice(0, 60), s.points, s.status, s.scenarios, s.review?.spec || "—", s.review ? s.review.gaps : "—", s.review?.code ? `${s.review.code}${s.review.code_findings ? ` (${s.review.code_findings})` : ""}` : "—", s.user_flow, `${s.design ?? (s.ui ? "none" : "n/a")}${s.review?.design ? ` · ${s.review.design === "MATCHES" ? "matches the design" : s.review.design === "DIFFERS" ? `differs from the design${s.review.design_findings ? ` (${s.review.design_findings})` : ""}` : "NOT compared with the design"}` : s.ui_verify ? ` · ${s.ui_verify.runs - s.ui_verify.failed}/${s.ui_verify.runs} verify` : ""}`, s.risk ?? "—");
  const looks = p.stories.filter((x) => x.ui_verify?.side_by_side);
  if (looks.length) {
    L.push("", "Design beside delivered (open each image: design left, delivered right):", "");
    for (const x of looks) L.push(`- ${x.id}: ${x.ui_verify.side_by_side}`);
  }
  L.push("", "## Quality work done during the sprint", "");
  const q = p.quality;
  L.push(`- Wave spec verification: ${q.wave_spec_verify.runs} runs — ${q.wave_spec_verify.met} met, ${q.wave_spec_verify.partial} partial, ${q.wave_spec_verify.missing} missing, ${q.wave_spec_verify.over_built} over-built`);
  L.push(`- Story reviews: ${q.story_reviews} — ${q.spec_findings_stories} with spec findings, ${q.gaps_found} gaps, ${q.code_findings} code-review findings`);
  L.push(`- Fixed in the sprint: ${q.patch_steps} patch step(s)${Object.keys(q.dispositions).length ? `; dispositions: ${Object.entries(q.dispositions).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`);
  L.push(`- Cross-story code review: ${q.cross_story_code_review ? "ran" : p.stories.length <= 1 ? "not needed (one story)" : "not run"}`);
  if (q.outside_touches?.length) L.push(`- Steps that changed files their plan did not list: ${q.outside_touches.map((o) => `${o.step} (${o.count})`).join(", ")}${q.outside_touches.some((o) => o.collides) ? `; a file another step of the same wave declared: ${q.outside_touches.filter((o) => o.collides).map((o) => o.collides).join("; ")}` : ""}`);
  L.push("", "## Decisions made without asking", "");
  if (!p.decisions.length) L.push("None recorded.");
  else { row("Stage", "Subject", "Source", "Decision", "Why"); row("---", "---", "---", "---", "---"); for (const d of p.decisions) row(d.stage, d.subject, d.source, d.decision, d.rationale); L.push("", `By source: ${Object.entries(p.decisions_by_source).map(([k, v]) => `${k} ${v}`).join(", ")}`); }
  L.push("", "## Effort", "");
  const e = p.effort;
  L.push(`- Active time ${e.active_minutes} min over a ${e.span_minutes} min span`);
  L.push(`- ${e.builder_dispatches} builder dispatches by ${e.distinct_agents} agents; ${e.redispatches} retries (${e.warm_fixes} warm); ${e.consults} think-tier consults; ${e.interface_relays} interface relays`);
  const bm = Object.entries(e.by_model ?? {});
  if (bm.length) L.push(`- Steps finished by model: ${bm.map(([m, v]) => `${m} ${v.steps}${v.climbed ? ` (${v.climbed} after climbing a rung)` : ""}`).join(", ")}`);
  L.push(`- Full verification runs: ${e.full_suite_runs} recorded, ${e.suite_reuses} reused`);
  if (commandRunsLine(e)) L.push(`- Build and test runs: ${commandRunsLine(e)}`);
  L.push(`- Full suite proof: ${proofLine(e)}`);
  if (e.waves.length) L.push(`- Waves: ${e.waves.map((w) => `W${w.wave} ${w.steps} steps${w.minutes !== null ? ` ${w.minutes} min` : ""}`).join(" · ")}`);
  if (p.code) L.push(`- Code: ${p.code.commits} commits, ${p.code.files} files, +${p.code.added}/−${p.code.deleted}; tests: ${p.code.test_files} files, +${p.code.test_lines_added} lines`);
  if (p.velocity?.length) L.push(`- Velocity trend: ${p.velocity.map((v) => `${v.sprint} ${v.points}`).join(" → ")}`);
  L.push("", "## Not done, and found but not done", "");
  const nd = p.not_done;
  if (!nd.stories.length && !nd.parked_steps.length && !nd.ideas_captured.length && !nd.pending_human_probes.length) L.push("Nothing outstanding.");
  for (const s of nd.stories) L.push(`- Story ${s.id} is ${s.status}: ${s.title}`);
  for (const s of nd.parked_steps) L.push(`- Step ${s.id} parked (${s.status})${s.reason ? `: ${s.reason}` : ""} — ${s.title}`);
  for (const i of nd.ideas_captured) {
    const decision = !i.kind ? "not triaged" : i.kind === "defect" ? (i.fixed_by ? `defect, ${i.severity} — fixed in the sprint by ${i.fixed_by}` : `defect, ${i.severity} — left for the backlog${i.reason ? `: ${i.reason}` : ""}`) : `${i.kind}${i.reason ? ` — ${i.reason}` : ""}`;
    L.push(`- Found, captured as ${i.id}: ${i.title} (${decision})`);
  }
  for (const id of nd.pending_human_probes) L.push(`- ${id}: waiting for a person to confirm the user flow`);
  return L.join("\n") + "\n";
}

/** The twelve sections of the sprint review, in the order they are shown. */
export const REVIEW_SECTIONS = Object.freeze([
  "Goal and outcome", "What you can do now", "Evidence, before and after", "Quality work during the sprint",
  "Decisions made without asking", "Numbers", "Not done", "Found but not done",
  "Not verified, risks and debt", "What went well, what did not", "What to improve: proposed actions", "Next",
]);
const FILL = (what) => `<!-- FILL: ${what} -->`;
/** "Build and test runs: 9 runs, 44 min (31% of active time), 3 red; longest ...". Empty when nothing was captured. */
function commandRunsLine(e) {
  const c = e.command_runs;
  if (!c || !c.count) return "";
  const wall = c.wall_minutes ?? c.minutes;
  const share = e.active_minutes > 0 ? ` (${Math.round((wall / e.active_minutes) * 100)}% of active time)` : "";
  const longest = c.longest.length ? `; longest: ${c.longest.map((r) => `${r.name} ${r.minutes} min`).join(", ")}` : "";
  const hint = !c.scoped_set && e.active_minutes > 0 && wall / e.active_minutes >= 0.2
    ? ". No affected-tests command is set (`test_commands.scoped`), so every wave ran the whole suite"
    : "";
  const sum = c.minutes > wall ? `; ${c.minutes} run-minutes in all, because builders run side by side` : "";
  return `${c.count} runs, a run was going for ${wall} min${share}${sum}, ${c.failed} red${longest}${hint}`;
}

const settled = (s) => s.review && (s.review.verdict === "approve" || s.review.disposition);

/**
 * The sprint review as ONE document (v4.12): every fact the CLI knows is
 * already in it, and each part only a reviewer can write is a FILL marker.
 * The first real review printed a good status report and left the
 * retrospective half (what went badly, the actions, what is next) in a file
 * nobody saw, because the screen text was written freehand. Now the review on
 * screen is this file, and `review-pack check` refuses one with a section
 * missing or a marker left.
 */
export function renderReviewDocument(p) {
  const L = [];
  const row = (...c) => L.push(`| ${c.map((x) => String(x ?? "").replace(/\|/g, "/").replace(/\n/g, " ")).join(" | ")} |`);
  const h = (n) => L.push("", `## ${n}. ${REVIEW_SECTIONS[n - 1]}`, "");
  const e = p.effort, q = p.quality, nd = p.not_done;
  const ready = p.stories.filter((s) => settled(s) || ["done", "deployed", "released"].includes(s.status));
  const pts = ready.reduce((n, s) => n + s.points, 0);
  const hours = e.active_minutes / 60;
  L.push(`# Sprint review — ${p.sprint.id}`);

  h(1);
  L.push(`Goal: ${p.sprint.goal || "(none recorded)"}`, "", FILL("one line: goal met / partly met / not met, and why"), "");
  row("Measure", "Planned", "Built and reviewed"); row("---", "---", "---");
  row("Stories", p.outcome.stories_planned, ready.length);
  row("Points", p.outcome.points_planned, pts);
  row("Steps", p.outcome.steps_planned, `${p.outcome.steps_done} of ${p.outcome.steps_total} done (${p.outcome.steps_added} added as fixes, ${p.outcome.steps_parked} parked)`);
  // Said once, as a fact: two reviews in a row reported "stories still
  // in-progress after their reviews settled" as a Shipyard bug.
  if (ready.some((s) => s.status === "in-progress")) L.push("", "A built and reviewed story stays `in-progress` until you accept the sprint; accepting marks it done. That is how it works, not a finding.");

  h(2);
  L.push(FILL("per story, one line a user would recognise, and how to see it yourself (a command, a scenario, device steps)"));

  h(3);
  row("Story", "Pts", "Scenarios", "Spec review", "Gaps", "Code review", "User flow", "Design"); row("---", "---", "---", "---", "---", "---", "---", "---");
  for (const s of p.stories) row(`${s.id} ${s.title}`.trim().slice(0, 60), s.points, s.scenarios, s.review?.spec || "—", s.review ? s.review.gaps : "—", s.review?.code ? `${s.review.code}${s.review.code_findings ? ` (${s.review.code_findings})` : ""}` : "—", s.user_flow, !s.ui ? "n/a" : s.review?.design === "MATCHES" ? "matches" : s.review?.design === "DIFFERS" ? "DIFFERS" : s.review?.design === "UNVERIFIED" ? "not compared" : s.design ?? "none");
  const looks = p.stories.filter((x) => x.ui_verify?.side_by_side);
  if (looks.length) { L.push("", "Design beside delivered (design left, delivered right):"); for (const x of looks) L.push(`- ${x.id}: ${x.ui_verify.side_by_side}`); }
  L.push("", FILL("before and after for each story: the frame or output before the sprint beside the one now, with paths; for a fix, the failing case before and the passing case now"));
  if ((p.quality_gates ?? []).length) {
    L.push("", "Quality gates planned for this sprint:", "");
    row("#", "Gate", "Checked by", "How"); row("---", "---", "---", "---");
    for (const g of p.quality_gates) row(g.n, g.gate.slice(0, 110), g.type === "manual" ? "a person" : "a command", (g.command || "—").replace(/\|/g, "/").slice(0, 80));
    L.push("", FILL("for each quality gate above: pass or fail, with its proof (a fresh `shipyard-data verify list` entry for the same command, the story's recorded user-flow check, or the command run now and recorded). A gate a person checks is listed in section 9 and asked in the one sitting"));
  }

  h(4);
  L.push(`- Wave spec checks: ${q.wave_spec_verify.runs} runs — ${q.wave_spec_verify.met} met, ${q.wave_spec_verify.partial} partial, ${q.wave_spec_verify.missing} missing, ${q.wave_spec_verify.over_built} over-built`);
  L.push(`- Story reviews: ${q.story_reviews} — ${q.gaps_found} gaps, ${q.code_findings} code-review findings`);
  L.push(`- Fixed inside the sprint: ${q.patch_steps} fix step(s)${Object.keys(q.dispositions).length ? ` (${Object.entries(q.dispositions).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`);
  L.push(`- Cross-story code review: ${q.cross_story_code_review ? "ran" : p.stories.length <= 1 ? "not needed (one story)" : "not run"}`);
  if (q.outside_touches?.length) L.push(`- Steps that changed files their plan did not list: ${q.outside_touches.map((o) => `${o.step} (${o.count})`).join(", ")}${q.outside_touches.some((o) => o.collides) ? `; a file another step of the same wave declared: ${q.outside_touches.filter((o) => o.collides).map((o) => o.collides).join("; ")}` : ""}`);

  h(5);
  if (!p.decisions.length) L.push("None recorded.");
  else {
    L.push(`${p.decisions.length} decision(s): ${Object.entries(p.decisions_by_source).map(([k, v]) => `${v} by ${k}`).join(", ")}.`, "");
    row("Subject", "Basis", "Decision", "Why"); row("---", "---", "---", "---");
    const cut = (t, n = 150) => (String(t ?? "").length > n ? `${String(t).slice(0, n - 1)}…` : String(t ?? ""));
    for (const d of p.decisions) row(d.subject || d.stage, d.source, cut(d.decision), cut(d.rationale));
    L.push("", "Full text of each: `execute_decision` events in the sprint's event log.", "", FILL("which of these are easy to reverse, and which the owner should look at first"));
  }

  h(6);
  row("Measure", "Value"); row("---", "---");
  row("Active time", `${e.active_minutes} min (over a ${e.span_minutes} min span)`);
  row("Points per hour", hours > 0 ? `${(pts / hours).toFixed(2)} (${pts} pts in ${hours.toFixed(1)} h)` : "n/a");
  if (p.velocity?.length) row("Points per sprint, recent", p.velocity.map((v) => `${v.sprint} ${v.points}`).join(" → "));
  row("Builder runs", `${e.builder_dispatches} (${e.redispatches} retries, ${e.warm_fixes} warm fixes)`);
  const bm = Object.entries(e.by_model ?? {});
  row("Steps finished by model", bm.length ? bm.map(([m, v]) => `${m} ${v.steps}${v.climbed ? ` (${v.climbed} after a failed first try)` : ""}`).join(", ") : "not recorded");
  row("Think-tier consults", e.consults);
  row("Full test runs", `${e.full_suite_runs} recorded, ${e.suite_reuses} reused`);
  if (commandRunsLine(e)) row("Build and test runs", commandRunsLine(e));
  row("Full suite proof", proofLine(e));
  if (e.waves.length) row("Waves", e.waves.map((w) => `W${w.wave}: ${w.steps} steps${w.minutes !== null ? `, ${w.minutes} min` : ""}`).join(" · "));
  if (p.code) row("Code", `${p.code.commits} commits, ${p.code.files} files, +${p.code.added}/−${p.code.deleted}; tests ${p.code.test_files} files, +${p.code.test_lines_added} lines`);

  h(7);
  const undone = nd.stories.filter((s) => !ready.some((r) => r.id === s.id));
  if (!undone.length && !nd.parked_steps.length && !nd.pending_human_probes.length) L.push("Every planned story is built and reviewed; no step is parked.");
  for (const s of undone) L.push(`- Story ${s.id} is ${s.status}: ${s.title}`);
  for (const s of nd.parked_steps) L.push(`- Step ${s.id} parked${s.reason ? `: ${s.reason}` : ""} — ${s.title}`);
  for (const id of nd.pending_human_probes) L.push(`- ${id}: waiting for a person to confirm the user flow`);
  if (undone.length || nd.parked_steps.length) L.push("", FILL("for each item above: why, and where it goes next"));

  h(8);
  if (!nd.ideas_captured.length) L.push("Nothing was captured during the sprint.");
  for (const i of nd.ideas_captured) {
    const decision = !i.kind ? "not triaged" : i.kind === "defect" ? (i.fixed_by ? `defect, ${i.severity}: fixed in the sprint by ${i.fixed_by}` : `defect, ${i.severity}: left for the backlog${i.reason ? ` because ${i.reason}` : ""}`) : `${i.kind}${i.reason ? `: ${i.reason}` : ""}`;
    L.push(`- ${i.id} ${i.title} — ${decision}`);
  }

  h(9); L.push(FILL("what was not checked on real hardware or by a person, assumptions still open, known limits shipped, what the next sprint inherits"));
  h(10); L.push(FILL("two short lists from the data above: went well / did not. Name tooling (Shipyard) problems separately from project problems"));
  h(11); L.push(FILL("each action with an owner (project, plugin, owner), where it lands (idea, config, rule, plugin issue) and the evidence behind it"));
  h(12); L.push(FILL("the recommended next sprint goal with the top backlog items, release readiness, and the decisions only the owner can make"));
  return L.join("\n") + "\n";
}

/** What is missing from a written review: [] when it can be shown. */
export function checkReviewDocument(text) {
  const problems = [];
  for (let n = 1; n <= REVIEW_SECTIONS.length; n++) {
    const m = text.match(new RegExp(`^## ${n}\\. .*$`, "m"));
    if (!m) { problems.push(`section ${n} (${REVIEW_SECTIONS[n - 1]}) is missing`); continue; }
    const after = text.slice(m.index + m[0].length);
    const next = after.search(/^## \d+\. /m);
    const body = (next === -1 ? after : after.slice(0, next)).trim();
    if (!body) problems.push(`section ${n} (${REVIEW_SECTIONS[n - 1]}) is empty`);
    else if (/<!-- FILL:/.test(body)) problems.push(`section ${n} (${REVIEW_SECTIONS[n - 1]}) still has a FILL marker: ${(body.match(/<!-- FILL: ([^>]*?) -->/) || [])[1] ?? ""}`);
  }
  return problems;
}

function packPath(dataDir) { return join(dataDir, "sprints", "current", "REVIEW-PACK.md"); }

export function main(dataDir, args = []) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") o.json = true;
    else if (a === "check" || a === "--write" || a === "--force") o[a.replace(/^--/, "")] = true;
    else if (["--sprint", "--base", "--head"].includes(a)) { o[a.slice(2)] = args[++i]; if (o[a.slice(2)] === undefined) { process.stderr.write(`shipyard-data review-pack: ${a} needs a value\n`); process.exit(2); } }
    else { process.stderr.write(`shipyard-data review-pack: unknown argument "${a}"\n  Usage: review-pack [--sprint <id>] [--base <sha> --head <sha>] [--json]\n         review-pack --write [--base <sha> --head <sha>] [--force]   (writes sprints/current/REVIEW-PACK.md: the facts filled in, FILL markers for the rest)\n         review-pack check                                          (exit 3 while a section is missing or a FILL marker remains)\n`); process.exit(2); }
  }
  if (o.check) {
    const text = readIf(packPath(dataDir));
    if (text === null) { process.stderr.write(`shipyard-data review-pack: no ${packPath(dataDir)} — run \`shipyard-data review-pack --write\` first\n`); process.exit(3); }
    const problems = checkReviewDocument(text);
    if (problems.length) { process.stderr.write(`shipyard-data review-pack: the review is not ready to show (${problems.length}):\n${problems.map((x) => `  - ${x}`).join("\n")}\n`); process.exit(3); }
    process.stdout.write(`review-pack: all ${REVIEW_SECTIONS.length} sections are written — show ${packPath(dataDir)} as the review, whole and in order\n`);
    return;
  }
  const pack = buildReviewPack(dataDir, o);
  if (pack.error) { process.stderr.write(`shipyard-data review-pack: ${pack.error}\n`); process.exit(3); }
  if (o.write) {
    const path = packPath(dataDir);
    const existing = readIf(path);
    if (existing !== null && !o.force && !/<!-- FILL:/.test(existing) && checkReviewDocument(existing).length === 0) { process.stderr.write(`shipyard-data review-pack: ${path} is already complete — pass --force to start it again\n`); process.exit(3); }
    atomicWrite(path, renderReviewDocument(pack));
    process.stdout.write(`${path}\nreview-pack: facts written; fill each <!-- FILL: ... --> marker, then \`shipyard-data review-pack check\`\n`);
    return;
  }
  process.stdout.write(o.json ? JSON.stringify(pack) + "\n" : renderReviewPack(pack));
}
