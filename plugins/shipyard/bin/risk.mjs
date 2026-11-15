/**
 * `shipyard-data risk <profile|score|drift>` (E004 — v4.2: business risk profile + technical risk score)
 *
 * profile status [--json]                       missing | present (harms=N); baseline floors always apply
 * profile show [--json]
 * profile add-harm --name "<harm>" --severity <low|medium|high|critical>
 *                  [--paths <glob,glob>] [--tables <t,t>] [--endpoints <e,e>] [--stories <S###,…>]
 *                  [--check "<required check>"]... [--human-gate <true|false>]
 * profile remove-harm <H###>
 * score (--base <ref> --head <ref> | --paths <p,p>) [--story S###] [--step P###] [--repo <dir>] [--cap] [--json]
 *      → level low|medium|high|critical, review_level, human_gate, reasons; logs `risk_scored`.
 *        Signals combine by MAX, never average. With `--story`, the score covers the files that
 *        story's own steps changed (every step of the story, so splitting a story cannot lower
 *        its level); with no story, or when no commit can be attributed, the whole range.
 * drift --base <ref> --head <ref> [--repo <dir>] [--json]   files that look risky (floor patterns) but match no harm area.
 * `--repo` names the git checkout to diff (default: the resolved project root) — a worktree, or a test fixture.
 *
 * The profile is `<dataDir>/risk-profile.json` (schema_version 1), captured LAZILY: the first
 * /ship-sprint or /ship-review that needs a level runs the short capture. Unconfigured fails SAFE:
 * baseline floors for auth, migrations, secrets and payments apply with or without a profile.
 * The builder never self-assesses: this CLI reads git.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { getProjectRoot } from "./shipyard-resolver.mjs";
import { readEvents, currentSprintId } from "./terminal-gate.mjs";
import { stepOwners } from "./story-review.mjs";
import { readRiskMaxCriticalPerSprint } from "./config-read.mjs";

export const PROFILE_BASENAME = "risk-profile.json";
export const LEVELS = Object.freeze(["low", "medium", "high", "critical"]);
const RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
export const maxLevel = (...ls) => ls.filter(Boolean).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "low");

/** Closed severity → gate map (the user's harm vocabulary is open; this table is not). */
export const GATE = Object.freeze({
  low: { review_level: "low", human_gate: false },
  medium: { review_level: "medium", human_gate: false },
  high: { review_level: "high", human_gate: false },
  critical: { review_level: "high", human_gate: true },
});

/** Baseline floors: path patterns that are risky in every project, profile or not. */
export const FLOORS = Object.freeze([
  { id: "auth", level: "high", re: /(^|[\\/._-])(auth|authn|authz|login|logout|session|oauth|sso|password|passwd|credential|token|jwt|permission|rbac|acl)([\\/._-]|$)/i },
  { id: "secrets", level: "high", re: /(^|[\\/])(\.env(\..*)?|.*secret.*|.*\.pem|.*\.key|id_rsa.*|.*keystore.*|.*vault.*)$/i },
  { id: "migrations", level: "high", re: /(^|[\\/])(migrations?|migrate|schema|alembic|flyway|liquibase)([\\/._-]|.*\.sql$)/i },
  { id: "payments", level: "high", re: /(^|[\\/._-])(payment|payments|billing|charge|checkout|invoice|refund|wallet|payout|stripe|braintree)([\\/._-]|$)/i },
  { id: "deploy", level: "medium", re: /(^|[\\/])(\.github[\\/]workflows|\.gitlab-ci\.yml|bitbucket-pipelines\.yml|Dockerfile.*|docker-compose.*|k8s|helm|terraform|deploy.*|infra)([\\/.]|$)/i },
  { id: "dependencies", level: "medium", re: /(^|[\\/])(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements.*\.txt|Pipfile.*|poetry\.lock|pyproject\.toml|Cargo\.(toml|lock)|go\.(mod|sum)|build\.gradle(\.kts)?|pom\.xml|Gemfile.*|composer\.(json|lock))$/i },
]);

export function profilePath(dataDir) {
  return join(dataDir, PROFILE_BASENAME);
}
export function readProfile(dataDir) {
  const p = profilePath(dataDir);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j && Array.isArray(j.harms) ? j : null;
  } catch {
    return null;
  }
}
function writeProfile(dataDir, prof) {
  prof.updated_at = new Date().toISOString();
  atomicWrite(profilePath(dataDir), JSON.stringify(prof, null, 2) + "\n");
}

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char; a bare dir prefix matches below it. */
export function globToRe(glob) {
  let g = String(glob).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!g) return null;
  if (!/[*?]/.test(g) && !/\.[a-z0-9]+$/i.test(g)) g = g.replace(/\/$/, "") + "/**";
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${re}$`, "i");
}

export function matchHarms(profile, files, { story = null, endpoints = [], tables = [] } = {}) {
  const hits = [];
  for (const h of profile?.harms ?? []) {
    const a = h.areas ?? {};
    const pathRes = (a.paths ?? []).map(globToRe).filter(Boolean);
    const matchedFiles = files.filter((f) => pathRes.some((re) => re.test(f.replace(/\\/g, "/"))));
    const matchedStory = story && (a.stories ?? []).includes(story);
    const matchedEndpoints = endpoints.filter((e) => (a.endpoints ?? []).includes(e));
    const matchedTables = tables.filter((t) => (a.tables ?? []).includes(t));
    if (matchedFiles.length || matchedStory || matchedEndpoints.length || matchedTables.length) {
      hits.push({ id: h.id, name: h.name, severity: h.severity, human_gate: h.human_gate !== false && GATE[h.severity].human_gate || h.human_gate === true, files: matchedFiles.slice(0, 10), story: !!matchedStory, required_checks: h.required_checks ?? [] });
    }
  }
  return hits;
}

export function matchFloors(files) {
  const out = [];
  for (const f of files) {
    const norm = f.replace(/\\/g, "/");
    for (const fl of FLOORS) if (fl.re.test(norm)) out.push({ floor: fl.id, level: fl.level, file: f });
  }
  return out;
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 }).trim();
  } catch {
    return null;
  }
}

const TEST_RE = /(^|[\\/])(tests?|__tests__|spec|specs)([\\/]|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py|rb|kt|java|rs|c)$|(^|[\\/])test_[^\\/]+$|Test[A-Za-z]*\.(kt|java|cs|swift)$/i;
const DOC_RE = /\.(md|mdx|txt|rst|adoc)$/i;

/**
 * The files a story's own steps changed inside `base..head` (4.17.2), or null
 * when nothing can be attributed (then the caller scores the whole range).
 *
 * Why: the boundary scored every story with `--base <sprint base> --head HEAD`,
 * so in a three-story wave a 46-line documentation audit was "high" because a
 * sibling story touched hot source files, and its small fix step was routed
 * one model tier up. A story answers for its own change.
 *
 * A step's own commits are those reachable from its anchored commit but not
 * from the base or from an earlier step's anchor. When history was rewritten
 * at a boundary an earlier step's commits can stay attributed to a later one:
 * that over-counts, which only ever raises a level.
 */
export function storyOwnFiles(dataDir, story, { base, head, cwd }) {
  if (!story) return null;
  const anchors = new Map(); // step id -> latest anchored sha
  for (const e of readEvents(dataDir)) {
    if (e.type !== "task_commit_anchored" || !/^[0-9a-f]{7,40}$/i.test(String(e.sha ?? ""))) continue;
    anchors.set(String(e.task ?? e.step ?? ""), String(e.sha));
  }
  anchors.delete("");
  if (!anchors.size) return null;
  const owners = stepOwners(dataDir, [...anchors.keys()]);
  const mine = [...anchors].filter(([id]) => owners.get(id)?.story === story).map(([, sha]) => sha);
  if (!mine.length) return null;
  // One walk over everything newer than the base: `<sha> <parent>...` per line.
  const exists = [...new Set(anchors.values())].filter((sha) => git(["cat-file", "-e", `${sha}^{commit}`], cwd) !== null);
  const walked = git(["rev-list", "--parents", head, ...exists, "--not", base], cwd);
  if (walked === null) return null;
  const parents = new Map();
  for (const line of walked.split("\n")) {
    const [c, ...ps] = line.trim().split(/\s+/);
    if (c) parents.set(c, ps);
  }
  const full = (sha) => [...parents.keys()].find((c) => c.startsWith(sha)) ?? null;
  const reach = (start) => {
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const c = stack.pop();
      if (!c || seen.has(c) || !parents.has(c)) continue;
      seen.add(c);
      stack.push(...parents.get(c));
    }
    return seen;
  };
  const anchorSet = new Set(exists.map(full).filter(Boolean));
  const own = new Set();
  for (const sha of mine) {
    const a = full(sha);
    if (!a) continue; // older than the base, or gone
    const r = reach(a);
    const earlier = new Set();
    for (const x of r) if (x !== a && anchorSet.has(x)) for (const y of reach(x)) earlier.add(y);
    for (const c of r) if (!earlier.has(c) && parents.get(c).length <= 1) own.add(c);
  }
  if (!own.size) return null;
  const names = git(["log", "--no-walk", "--name-only", "--format=", ...own], cwd);
  if (names === null) return null;
  const files = [...new Set(names.split("\n").map((l) => l.trim()).filter(Boolean))];
  return files.length ? files : null;
}

/** Technical signals read from git. Pure over the diff; never from the builder's claim. `only` limits it to those files. */
export function technicalSignals({ base, head, cwd, only = null }) {
  // `:(top)` because git prints paths from the repository root but reads a
  // pathspec from the current folder.
  const top = (f) => `:(top)${f}`;
  const numstat = git(["diff", "--numstat", `${base}..${head}`, ...(only ? ["--", ...only.slice(0, 500).map(top)] : [])], cwd);
  if (numstat === null) return { error: `git diff ${base}..${head} failed` };
  const files = [];
  let added = 0;
  let deleted = 0;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split("\t");
    const file = rest.join("\t");
    files.push(file);
    added += a === "-" ? 0 : Number(a) || 0;
    deleted += d === "-" ? 0 : Number(d) || 0;
  }
  const lines = added + deleted;
  const source = files.filter((f) => !TEST_RE.test(f) && !DOC_RE.test(f));
  const tests = files.filter((f) => TEST_RE.test(f));
  const signals = [];
  const sizeLevel = lines < 50 ? "low" : lines < 300 ? "medium" : lines < 1000 ? "high" : "critical";
  signals.push({ signal: "diff_size", level: sizeLevel, detail: `${lines} lines changed across ${files.length} files` });
  // A source change with no test touched is a signal once it is more than a one-liner.
  if (source.length && !tests.length && lines >= 20) signals.push({ signal: "no_tests_touched", level: source.length >= 3 ? "high" : "medium", detail: `${source.length} source files changed (${lines} lines), 0 test files` });
  // An empty pathspec would make `git log` count every commit in the repo, so a
  // docs-only or tests-only change scored `churn=high` in any active repo.
  const added30 = source.length ? git(["log", "--since=30.days", "--format=%H", "--", ...source.slice(0, 200).map(top)], cwd) : "";
  const churn = added30 ? added30.split("\n").filter(Boolean).length : 0;
  if (churn >= 50) signals.push({ signal: "churn", level: "high", detail: `${churn} commits touched these files in 30 days` });
  else if (churn >= 20) signals.push({ signal: "churn", level: "medium", detail: `${churn} commits touched these files in 30 days` });
  // AC markers live in tests by convention (`// AC-<n>` next to the scenario's
  // test), so count them over the test files too — scanning source alone
  // reported `no_ac_markers` on a diff whose tests carried all eight.
  const marked = [...source, ...tests].slice(0, 200);
  const diffText = marked.length ? git(["diff", "-U0", `${base}..${head}`, "--", ...marked.map(top)], cwd) || "" : "";
  const acMarkers = (diffText.match(/^\+.*\bAC-\d+\b/gm) || []).length;
  return { files, source, tests, lines, added, deleted, churn, ac_markers: acMarkers, signals };
}

/** The score. `paths` is the planning-time alternative to a diff (no technical signals yet). */
export function scoreRisk(dataDir, { base = null, head = null, paths = null, story = null, step = null, cwd = null }) {
  const profile = readProfile(dataDir);
  const reasons = [];
  let files = [];
  let tech = null;
  let scope = "range";
  if (base && head) {
    const root = cwd ?? getProjectRoot();
    const own = storyOwnFiles(dataDir, story, { base, head, cwd: root });
    if (own) scope = "story";
    tech = technicalSignals({ base, head, cwd: root, only: own });
    if (tech.error) return { error: tech.error };
    files = tech.files;
    reasons.push(...tech.signals);
    if (story && tech.source.length && tech.ac_markers === 0) reasons.push({ signal: "no_ac_markers", level: "medium", detail: `no // AC-<n> marker in the diff for ${story}` });
  } else if (paths) {
    files = paths;
    reasons.push({ signal: "paths_only", level: "low", detail: "planning-time score from paths; no diff yet" });
  }
  const floors = matchFloors(files);
  for (const f of floors) reasons.push({ signal: `floor:${f.floor}`, level: f.level, detail: f.file });
  const harms = matchHarms(profile, files, { story });
  for (const h of harms) reasons.push({ signal: `harm:${h.id}`, level: h.severity, detail: `${h.name}${h.files.length ? ` (${h.files.slice(0, 3).join(", ")})` : ""}` });
  const level = maxLevel("low", ...reasons.map((r) => r.level));
  const gate = GATE[level];
  const human = gate.human_gate || harms.some((h) => h.human_gate);
  const required = [...new Set(harms.flatMap((h) => h.required_checks))];
  return {
    level,
    review_level: gate.review_level,
    human_gate: human,
    profile: profile ? "present" : "missing (baseline floors only)",
    files: files.length,
    scope,
    story,
    step,
    reasons: reasons.sort((a, b) => RANK[b.level] - RANK[a.level]),
    harms: harms.map((h) => h.id),
    required_checks: required,
  };
}

export function drift(dataDir, { base, head, cwd = null }) {
  const profile = readProfile(dataDir);
  const tech = technicalSignals({ base, head, cwd: cwd ?? getProjectRoot() });
  if (tech.error) return { error: tech.error };
  const floors = matchFloors(tech.files);
  const covered = new Set(matchHarms(profile, tech.files).flatMap((h) => h.files));
  const unmapped = floors.filter((f) => !covered.has(f.file));
  return { profile: profile ? "present" : "missing", risky_files: floors.length, unmapped: unmapped.map((f) => ({ file: f.file, floor: f.floor, level: f.level })) };
}

/** Distinct critical SUBJECTS this sprint (a story/step re-scored at planning, boundary and review is one). */
function criticalScoresThisSprint(dataDir, subjectKey) {
  const sprint = currentSprintId(dataDir);
  if (!sprint) return 0;
  const keys = new Set();
  for (const e of readEvents(dataDir)) {
    if (e.type !== "risk_scored" || e.level !== "critical" || e.sprint !== sprint) continue;
    keys.add(e.story || e.step || `${e.base}..${e.head}`);
  }
  keys.delete(subjectKey);
  return keys.size;
}

function usage(msg) {
  process.stderr.write(
    `shipyard-data risk: ${msg}\n` +
      "  Usage: risk profile status|show [--json]\n" +
      "         risk profile add-harm --name \"<harm>\" --severity <low|medium|high|critical> [--paths g,g] [--tables t,t] [--endpoints e,e] [--stories S###,…] [--check \"...\"]... [--human-gate true|false]\n" +
      "         risk profile remove-harm <H###>\n" +
      "         risk score (--base <ref> --head <ref> | --paths <p,p>) [--story S###] [--step P###] [--repo <dir>] [--cap] [--json]\n" +
      "         risk drift --base <ref> --head <ref> [--repo <dir>] [--json]\n",
  );
  process.exit(2);
}
function parseFlags(args) {
  const o = { _: [], check: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json" || a === "--cap") { o[a.slice(2)] = true; continue; }
    if (a.startsWith("--")) {
      const v = args[++i];
      if (v === undefined || (v.startsWith("--") && v !== "--")) usage(`${a} needs a value`);
      if (a === "--check") o.check.push(v); else o[a.slice(2)] = v;
    } else o._.push(a);
  }
  return o;
}
const list = (v) => (v === undefined ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean));

export function main(dataDir, args = []) {
  const sub = args[0];
  const o = parseFlags(args.slice(1));
  if (sub === "profile") {
    const verb = o._[0];
    const prof = readProfile(dataDir);
    if (verb === "status") {
      const r = { status: prof ? "present" : "missing", harms: prof?.harms.length ?? 0, schema_version: prof?.schema_version ?? null, floors: FLOORS.map((f) => `${f.id}=${f.level}`) };
      if (o.json) { process.stdout.write(JSON.stringify(r) + "\n"); return; }
      process.stdout.write(prof ? `risk profile: present (${r.harms} harm${r.harms === 1 ? "" : "s"}); baseline floors always apply\n` : "risk profile: missing — baseline floors apply (auth, secrets, migrations, payments = high; deploy, dependencies = medium). Capture harms with `risk profile add-harm` at the first sprint or review that needs a level.\n");
      return;
    }
    if (verb === "show") {
      if (!prof) { process.stdout.write(o.json ? "null\n" : "risk profile: missing\n"); return; }
      if (o.json) { process.stdout.write(JSON.stringify(prof) + "\n"); return; }
      for (const h of prof.harms) process.stdout.write(`${h.id} ${h.severity.padEnd(8)} ${h.name}${h.human_gate ? " [human gate]" : ""} — paths ${(h.areas?.paths ?? []).join(", ") || "-"}; checks ${(h.required_checks ?? []).join("; ") || "-"}\n`);
      return;
    }
    if (verb === "add-harm") {
      if (!o.name) usage("add-harm needs --name");
      if (!LEVELS.includes(o.severity ?? "")) usage(`--severity must be one of ${LEVELS.join("|")}`);
      if (o["human-gate"] !== undefined && !["true", "false"].includes(o["human-gate"])) usage("--human-gate must be true or false");
      const p = prof ?? { schema_version: 1, created_at: new Date().toISOString(), harms: [] };
      const n = p.harms.reduce((m, h) => Math.max(m, Number((h.id || "").slice(1)) || 0), 0) + 1;
      const harm = {
        id: `H${String(n).padStart(3, "0")}`,
        name: String(o.name).trim().slice(0, 120),
        severity: o.severity,
        areas: { paths: list(o.paths), tables: list(o.tables), endpoints: list(o.endpoints), stories: list(o.stories) },
        required_checks: o.check.map((c) => c.slice(0, 200)),
        human_gate: o["human-gate"] === undefined ? GATE[o.severity].human_gate : o["human-gate"] === "true",
        added_at: new Date().toISOString(),
      };
      p.harms.push(harm);
      writeProfile(dataDir, p);
      try { logEvent(dataDir, "risk_harm_added", { harm: harm.id, severity: harm.severity, paths: harm.areas.paths.length, human_gate: harm.human_gate }); } catch { /* best-effort */ }
      process.stdout.write(`${harm.id}: ${harm.name} (${harm.severity}${harm.human_gate ? ", human gate" : ""})\n`);
      return;
    }
    if (verb === "remove-harm") {
      const id = o._[1];
      if (!prof || !id || !prof.harms.some((h) => h.id === id)) { process.stderr.write(`shipyard-data risk: ${id ?? ""} is not in the profile\n`); process.exit(3); }
      prof.harms = prof.harms.filter((h) => h.id !== id);
      writeProfile(dataDir, prof);
      try { logEvent(dataDir, "risk_harm_removed", { harm: id }); } catch { /* best-effort */ }
      process.stdout.write(`${id}: removed\n`);
      return;
    }
    usage(`unknown profile verb "${verb ?? ""}"`);
  }
  if (sub === "score") {
    const paths = o.paths ? list(o.paths) : null;
    if (!((o.base && o.head) || paths)) usage("score needs --base <ref> --head <ref>, or --paths <p,p> at planning time");
    const r = scoreRisk(dataDir, { base: o.base ?? null, head: o.head ?? null, paths, story: o.story ?? null, step: o.step ?? null, cwd: o.repo ?? null });
    if (r.error) { process.stderr.write(`shipyard-data risk score: ${r.error}\n`); process.exit(1); }
    const sprint = currentSprintId(dataDir);
    let capExceeded = false;
    if (o.cap && r.level === "critical") {
      const cap = readRiskMaxCriticalPerSprint(dataDir).value;
      const n = criticalScoresThisSprint(dataDir, r.story || r.step || `${o.base ?? ""}..${o.head ?? ""}`);
      capExceeded = Number.isFinite(cap) && cap > 0 && n >= cap;
      r.cap = { max_critical_per_sprint: cap, critical_so_far: n, exceeded: capExceeded };
    }
    try { logEvent(dataDir, "risk_scored", { sprint: sprint ?? "", story: r.story ?? "", step: r.step ?? "", level: r.level, review_level: r.review_level, human_gate: r.human_gate, files: r.files, scope: r.scope, base: o.base ?? "", head: o.head ?? "", reasons: r.reasons.map((x) => `${x.signal}=${x.level}`).join(",").slice(0, 200) }); } catch { /* best-effort */ }
    if (o.json) process.stdout.write(JSON.stringify(r) + "\n");
    else {
      process.stdout.write(`risk: ${r.level} → review ${r.review_level}${r.human_gate ? ", HUMAN GATE" : ""} (${r.files} files${r.scope === "story" ? ` changed by ${r.story}'s own steps` : ""}; profile ${r.profile})\n`);
      for (const x of r.reasons.slice(0, 12)) process.stdout.write(`  ${x.level.padEnd(8)} ${x.signal}: ${x.detail}\n`);
      if (r.required_checks.length) process.stdout.write(`required checks: ${r.required_checks.join("; ")}\n`);
    }
    if (capExceeded) {
      process.stderr.write(`shipyard-data risk score: ${r.cap.critical_so_far} other critical change(s) already this sprint (cap ${r.cap.max_critical_per_sprint}) — split the sprint or raise risk.max_critical_per_sprint; this change still needs the human gate\n`);
      process.exit(3);
    }
    return;
  }
  if (sub === "drift") {
    if (!o.base || !o.head) usage("drift needs --base <ref> --head <ref>");
    const r = drift(dataDir, { base: o.base, head: o.head, cwd: o.repo ?? null });
    if (r.error) { process.stderr.write(`shipyard-data risk drift: ${r.error}\n`); process.exit(1); }
    if (o.json) { process.stdout.write(JSON.stringify(r) + "\n"); return; }
    if (!r.unmapped.length) { process.stdout.write(`risk drift: none (${r.risky_files} risky-looking files, all covered by a harm area; profile ${r.profile})\n`); return; }
    process.stdout.write(`risk drift: ${r.unmapped.length} risky-looking file(s) match no harm area (profile ${r.profile}):\n`);
    for (const u of r.unmapped) process.stdout.write(`  ${u.level.padEnd(8)} ${u.floor}: ${u.file}\n`);
    return;
  }
  usage(`unknown subcommand "${sub ?? ""}"`);
}
