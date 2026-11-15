/**
 * Findings captured during a sprint must be decided before the sprint moves on (v4.7.2).
 *
 * Owner rule: a bug found in the sprint belongs in the sprint; only a
 * low-severity one may go to the backlog. The rule was prose, and in a real
 * sprint a builder captured a real defect ("the player hears the host hero's
 * death cue and misses their own") as an idea, which then sat in the "new
 * ideas" list for the review. Capture stays free (`next-id ideas` never
 * refuses); the DECISION is priced here: every idea captured since the sprint
 * started is triaged with `shipyard-data idea triage`, and a defect above low
 * severity names the patch step that fixes it.
 *
 * Read by `cursor advance` out of a wave gate (the fix step must exist) and by
 * the execute terminal gate (the fix step must have returned). Parking a fix
 * step is still allowed: it then counts against the parked ratio and shows in
 * the review, which is the existing, visible path.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const scalar = (block, key) => {
  const m = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
};
const SETTLED_STATUS = new Set(["rejected"]);
export const FINDING_KINDS = ["defect", "improvement", "question"];
export const FINDING_SEVERITIES = ["low", "medium", "high"];

/** Earliest event of the sprint, as the two calendar dates it can be written as (UTC and local). */
function sprintSince(events, sprintId) {
  let lo = Infinity;
  for (const e of events) {
    if (e.sprint !== sprintId) continue;
    const t = Date.parse(e.ts);
    if (Number.isFinite(t) && t < lo) lo = t;
  }
  if (!Number.isFinite(lo)) return null;
  const d = new Date(lo);
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const utc = d.toISOString().slice(0, 10);
  return local < utc ? local : utc;
}

/**
 * @returns [{ id, title, kind, severity, fixed_by, reason, state, detail }]
 *   state: "untriaged" | "needs-fix" | "fix-open" | "settled"
 */
export function sprintFindings({ dataDir, events, sprintId, sprintStoryIds = [], stepStatus = () => null }) {
  const since = sprintId ? sprintSince(events, sprintId) : null;
  if (!since) return [];
  const dir = join(dataDir, "spec", "ideas");
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    let text = "";
    try { text = readFileSync(join(dir, n), "utf8"); } catch { continue; }
    const m = text.match(FM_RE);
    if (!m) continue;
    const b = m[1];
    const created = scalar(b, "created") || scalar(b, "captured");
    if (!created || created < since) continue;
    const status = scalar(b, "status");
    if (SETTLED_STATUS.has(status)) continue;
    // An idea captured through the front door (`/ship-discuss`, which can run
    // beside a sprint since 4.17) was not found by this sprint: the discussion
    // owns where it goes. Counting it made a running sprint triage ten ideas
    // the owner had just typed into another session before its gates would pass.
    if (/^inline capture/i.test(scalar(b, "source"))) continue;
    const f = {
      id: scalar(b, "id") || n.split("-").slice(0, 2).join("-"),
      title: scalar(b, "title"),
      kind: scalar(b, "kind"),
      severity: scalar(b, "severity"),
      fixed_by: scalar(b, "fixed_by"),
      reason: scalar(b, "triage_reason"),
      promoted_to: scalar(b, "promoted_to") || scalar(b, "graduated_to"),
    };
    if (!FINDING_KINDS.includes(f.kind)) {
      f.state = "untriaged";
      f.detail = `${f.id} was captured during this sprint and is not triaged — run \`shipyard-data idea triage ${f.id} --kind defect|improvement|question [--severity low|medium|high] [--reason "..."]\``;
    } else if (f.kind !== "defect" || f.severity === "low") {
      f.state = "settled";
    } else if (f.promoted_to && sprintStoryIds.includes(f.promoted_to)) {
      f.state = "settled";
    } else if (!f.fixed_by) {
      f.state = "needs-fix";
      f.detail = `${f.id} is a ${f.severity || "unrated"}-severity defect found in this sprint, so it is fixed in this sprint — write a patch step (\`shipyard-data next-id steps\`, the step file, \`patch_step_created\`), dispatch it, then \`shipyard-data idea triage ${f.id} --kind defect --severity ${f.severity || "medium"} --fixed-by <step id>\`. Only a low-severity defect may wait in the backlog.`;
    } else {
      const st = stepStatus(f.fixed_by);
      f.state = st === "complete" || st === "parked" ? "settled" : "fix-open";
      if (f.state === "fix-open") f.detail = `${f.id} (defect, ${f.severity}) is fixed by ${f.fixed_by}, which has not returned yet — dispatch it and accept its return (a parked fix is allowed and is reported at the review)`;
    }
    out.push(f);
  }
  return out;
}
