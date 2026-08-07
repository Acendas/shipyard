/**
 * idea-backlog — the undispositioned-IDEA backlog counter and the sprint-open
 * gate built on it.
 *
 * WHY THE GATE IS HERE AND NOT ON `next-id ideas`
 *
 * The original deferral guard refused to ALLOCATE an IDEA id once the
 * undispositioned backlog hit `execution.max_ideas_per_sprint`. That put the
 * teeth on the capture path, which is exactly backwards, and it cost a real
 * project its findings: at 156 undispositioned against a cap of 12, `next-id
 * ideas` refused every allocation. Four builders hit the refusal and — with no
 * `--force` guidance anywhere in their agent body — correctly declined to
 * override, so their findings landed in task-scoped filenames and return notes
 * instead of the backlog. An inert config field and ~30 misleading spec
 * references went unindexed.
 *
 * Two things were wrong:
 *
 *   1. Failing closed on capture destroys information. An untidy backlog is a
 *      chore; a lost finding is gone. Capture must never be the failure point.
 *   2. The guard priced the wrong act. The intent (from the deferral-pricing
 *      work) was to stop the pipeline PARKING its way to green. But refusing
 *      allocation doesn't stop any deferral — the sprint still completes, only
 *      the record of what was found is destroyed. Nothing downstream ever read
 *      the cap.
 *
 * So: `next-id ideas` always allocates and merely warns, and the cap becomes a
 * gate on OPENING THE NEXT SPRINT — the moment where an ungroomed backlog is
 * actually a decision to defer, and where grooming is the natural next action.
 *
 * THE ACCEPTANCE ESCAPE HATCH IS SIZE-SCOPED, NOT A KILL SWITCH
 *
 * The events log is a single append-only project-wide file, so a bare
 * `idea_backlog_accepted` event would disable the gate permanently after one
 * use. Instead the event records the count it accepted (`count: 156`), and the
 * gate honors it only while the current count has not GROWN past it. Accept at
 * 156 and you may plan at 156 or below; let it drift to 157 and the gate is
 * live again. Same shape as `terminal_parked_accepted` (explicit, logged, human
 * acknowledgement) without the permanence.
 *
 * COUNT SEMANTICS
 *
 * "Undispositioned" means an `IDEA-*.md` whose frontmatter `status` is neither
 * `graduated` nor `rejected`. This is a LIFETIME count over `spec/ideas/`, not
 * a per-sprint one — which is why the config key is
 * `execution.max_undispositioned_ideas`. The legacy `max_ideas_per_sprint`
 * name described a scoping that was never implemented and read as a
 * per-sprint throttle when it was in fact a permanent ceiling; it is still
 * honored as a fallback so existing configs keep working.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Matches an idea file: IDEA-<anything>.md */
const IDEA_FILE_RE = /^IDEA-.*\.md$/;

/** Statuses that mean an idea has been dealt with and no longer counts. */
const DISPOSITIONED = new Set(["graduated", "rejected"]);

/**
 * Count `IDEA-*.md` files under `<dataDir>/spec/ideas` that are still awaiting
 * disposition. An unreadable or frontmatter-less file counts as
 * undispositioned — conservative, since we cannot prove it was handled.
 *
 * Returns `{ count, total }` where `total` is every idea file seen.
 */
export function countUndispositionedIdeas(dataDir) {
  const kindDir = join(dataDir, "spec", "ideas");
  let files = [];
  try {
    files = readdirSync(kindDir);
  } catch {
    return { count: 0, total: 0 };
  }
  let count = 0;
  let total = 0;
  for (const f of files) {
    if (!IDEA_FILE_RE.test(f)) continue;
    total += 1;
    let status = "";
    try {
      const c = readFileSync(join(kindDir, f), "utf8");
      const m = c.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (m) {
        const sm = m[1].match(/^status:\s*(\S+)/m);
        if (sm) status = sm[1].replace(/^["']|["']$/g, "").toLowerCase();
      }
    } catch {
      /* unreadable → count as undispositioned (conservative) */
    }
    if (!DISPOSITIONED.has(status)) count += 1;
  }
  return { count, total };
}

/**
 * The sprint-open gate verdict.
 *
 * @returns {{
 *   allowed: boolean,
 *   count: number,
 *   total: number,
 *   cap: number,
 *   over_cap: boolean,
 *   accepted_at: number|null,
 *   reason: string|null
 * }}
 */
export function checkIdeaBacklog(dataDir, events, cap) {
  const { count, total } = countUndispositionedIdeas(dataDir);
  if (!Number.isFinite(cap)) {
    return { allowed: true, count, total, cap, over_cap: false, accepted_at: null, reason: null };
  }
  const overCap = count > cap;

  // Highest count any acceptance event has covered. An event with no usable
  // `count` field is treated as covering the backlog as it stood when emitted,
  // which we cannot reconstruct — so it covers nothing and the gate stays live.
  // That is the safe direction: a malformed acceptance must not silently
  // disable the gate.
  let acceptedAt = null;
  for (const ev of events || []) {
    if (ev.type !== "idea_backlog_accepted") continue;
    const n = Number(ev.count);
    if (!Number.isFinite(n)) continue;
    if (acceptedAt == null || n > acceptedAt) acceptedAt = Math.floor(n);
  }

  if (!overCap) {
    return { allowed: true, count, total, cap, over_cap: false, accepted_at: acceptedAt, reason: null };
  }
  if (acceptedAt != null && count <= acceptedAt) {
    return { allowed: true, count, total, cap, over_cap: true, accepted_at: acceptedAt, reason: null };
  }

  const grew =
    acceptedAt != null
      ? ` A prior acceptance covered ${acceptedAt}, but the backlog has grown past it.`
      : "";
  return {
    allowed: false,
    count,
    total,
    cap,
    over_cap: true,
    accepted_at: acceptedAt,
    reason:
      `Idea backlog: ${count} undispositioned idea(s) exceeds cap ${cap} (${total} total).${grew} ` +
      `Groom via /ship-backlog — \`shipyard-data idea set-status <IDEA-NNN> graduated --to F<NNN>\` or ` +
      `\`... rejected\` — until the count is at or under ${cap}, raise \`execution.max_undispositioned_ideas\`, ` +
      `or record explicit user acceptance with \`shipyard-data events emit idea_backlog_accepted count=${count}\` ` +
      `(only after confirming with the user — this is the deliberate escape hatch, not a rubber stamp, and it ` +
      `stops covering you as soon as the backlog grows past ${count}).`,
  };
}

/**
 * `shipyard-data check-idea-backlog [--data-dir <path>] [--json]`
 *
 * Exit 0 when planning may proceed, 3 when the backlog gate refuses. Unlike
 * readiness-check this IS a gate, so the exit code carries the verdict and
 * /ship-sprint can branch on it without parsing.
 */
export function checkIdeaBacklogCmd(dataDir, events, cap, argv) {
  const result = checkIdeaBacklog(dataDir, events, cap);
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else if (result.allowed) {
    const note =
      result.over_cap && result.accepted_at != null
        ? ` (over cap ${result.cap}, accepted at ${result.accepted_at})`
        : ` (cap ${result.cap === Infinity ? "disabled" : result.cap})`;
    process.stdout.write(`IDEA_BACKLOG_OK undispositioned=${result.count}${note}\n`);
  } else {
    process.stderr.write(result.reason + "\n");
  }
  process.exit(result.allowed ? 0 : 3);
}
