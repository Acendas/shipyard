/**
 * `shipyard-data design <approve|check|status>` (E005-S3, v4.3 — design sign-off for UI stories)
 *
 *   approve <S###> --file <snapshot> [--note "..."]
 *     → copies the snapshot to spec/designs/<S###>-v<n>.<ext>, records version + sha256 in the
 *       story's `design:` block and logs `design_approved`. A changed design is a NEW version
 *       (re-approve); the hash makes drift detectable.
 *   check [<S###> ...] [--json]
 *     → every UI story (`ui: true`) must carry an approved design whose file still hashes to the
 *       recorded value; exit 3 naming MISSING / DRIFTED / FILE-MISSING stories. Non-UI stories are OK.
 *       With no ids: every story in sprints/current/SPRINT.md.
 *   status [--json]      one line per story with a design block.
 *
 * Why a CLI gate: look-and-feel acceptance used to live only in `user_flow_probe: manual`. A UI step
 * now needs an approved design ref the way a feature step needs an `acceptance_probe` — /ship-sprint
 * and /ship-execute pre-flight call `design check`, never trust prose.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { parseFrontmatter, sprintStoryIds as sprintStoryIdsOf } from "./terminal-gate.mjs";
import { isStoryId } from "./vocab.mjs";
import { parseFlags } from "./cli-flags.mjs";

const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf", ".html", ".json", ".md"]);

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function storyFile(dataDir, id) {
  for (const sub of ["stories", "features", "bugs"]) {
    const dir = join(dataDir, "spec", sub);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    const n = names.find((x) => x.startsWith(`${id}-`) || x === `${id}.md`);
    if (n) return join(dir, n);
  }
  return null;
}
function parseFm(content) {
  const m = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  return m ? { open: m[1], block: m[2], close: m[3], rest: content.slice(m[0].length) } : null;
}
function isUiStory(block) {
  return /^ui:\s*true\b/m.test(block);
}
// CRLF-safe: a Windows or CRLF-normalized story file must read back the block
// it was written with, or `design check` reports MISSING right after approve.
// Linear by construction: every indented line ends at a newline or the end
// of the text before the next one starts. The earlier form made the newline
// optional, so a line could be re-split at any inner space; a lazy copy of it
// in the review pack backtracked exponentially on a long `note:` and took
// five minutes on a real project (4.8.1).
const DESIGN_BLOCK_RE = /^design:[ \t]*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|(?![\s\S])))*)/m;
export function readDesign(block) {
  const m = block.match(DESIGN_BLOCK_RE);
  if (!m) return null;
  const get = (k) => (m[1].match(new RegExp(`^[ \\t]+${k}:\\s*"?([^"\\r\\n]*)"?`, "m")) || [])[1] ?? "";
  const waived = /^[ \t]+waived:\s*true\b/m.test(m[1]);
  const cropRaw = get("crop").split(",").map((v) => Number(v.trim()));
  return {
    version: Number(get("version")) || 0, hash: get("hash"), path: get("path"), approved_at: get("approved_at"), note: get("note"), waived, waived_reason: waived ? get("reason") : "",
    // 4.8: how the snapshot is compared with a rendered screen. `exact` (default) is a
    // frame-accurate snapshot (pixel diff); `mockup` is a drawing (layout and colour similarity).
    fidelity: get("fidelity") === "mockup" ? "mockup" : "exact",
    crop: cropRaw.length === 4 && cropRaw.every((v) => Number.isInteger(v) && v >= 0) ? cropRaw : null,
    scene: get("scene"),
  };
}
function waiverBlock(reason, eol = "\n") {
  return ["design:", "  waived: true", `  reason: ${JSON.stringify(reason)}`, `  waived_at: "${new Date().toISOString()}"`].join(eol);
}
function designBlock(d, eol = "\n") {
  const lines = ["design:", `  version: ${d.version}`, `  hash: "${d.hash}"`, `  path: "${d.path}"`, `  approved_at: "${d.approved_at}"`, `  note: ${JSON.stringify(d.note ?? "")}`];
  if (d.fidelity === "mockup") lines.push("  fidelity: mockup");
  if (d.crop) lines.push(`  crop: "${d.crop.join(",")}"`);
  if (d.scene) lines.push(`  scene: "${d.scene}"`);
  return lines.join(eol);
}
function writeDesign(block, d) {
  const eol = block.includes("\r\n") ? "\r\n" : "\n";
  const nb = designBlock(d, eol) + eol;
  let out = DESIGN_BLOCK_RE.test(block) ? block.replace(DESIGN_BLOCK_RE, nb) : `${block}${eol}${nb.trimEnd()}`;
  if (!/^ui:\s*/m.test(out)) out += `${eol}ui: true`;
  return out;
}

/** Verdict for one story: OK | NOT-UI | MISSING | FILE-MISSING | DRIFTED | NO-FRONTMATTER | MISSING-FILE */
export function checkStory(dataDir, id) {
  const f = storyFile(dataDir, id);
  if (!f) return { story: id, verdict: "MISSING-FILE" };
  const fm = parseFm(readFileSync(f, "utf8"));
  if (!fm) return { story: id, verdict: "NO-FRONTMATTER" };
  if (!isUiStory(fm.block)) return { story: id, verdict: "NOT-UI" };
  const d = readDesign(fm.block);
  if (d?.waived && !d.hash) return { story: id, verdict: "WAIVED", reason: d.waived_reason };
  if (!d || !d.hash) return { story: id, verdict: "MISSING", hint: `shipyard-data design approve ${id} --file <snapshot>, or design waive ${id} --reason "<why no design>"` };
  const abs = join(dataDir, d.path);
  if (!existsSync(abs)) return { story: id, verdict: "FILE-MISSING", path: d.path, version: d.version };
  const now = sha256(abs);
  if (now !== d.hash) return { story: id, verdict: "DRIFTED", path: d.path, version: d.version, hint: `the snapshot changed after sign-off — re-approve as v${d.version + 1}` };
  return { story: id, verdict: "OK", version: d.version, path: d.path };
}

function sprintStoryIds(dataDir) {
  const p = join(dataDir, "sprints", "current", "SPRINT.md");
  if (!existsSync(p)) return [];
  return sprintStoryIdsOf(readFileSync(p, "utf8"));
}

function usage(msg) {
  process.stderr.write(
    `shipyard-data design: ${msg}\n` +
      "  Usage: design approve <S###> --file <snapshot> [--note \"...\"] [--fidelity exact|mockup] [--crop x,y,w,h] [--scene <name>]\n" +
      "         design approve <S###> --from <S###>      (reuse that story's approved design: snapshot, fidelity, crop and scene)\n" +
      "           exact (default): a frame-accurate snapshot, compared pixel for pixel\n" +
      "           mockup: a drawing or page export, compared by layout and colour; --crop cuts the screen out of a larger image;\n" +
      "           --scene names the frame `ui verify` renders for this story (ui.adapter frames)\n" +
      "         design waive <S###> --reason \"...\"      (recorded decision: this UI story ships without a design)\n" +
      "         design check [<S###> ...] [--json]\n" +
      "         design status [--json]\n",
  );
  process.exit(2);
}
const flags = (args) => parseFlags(args, usage);

export function main(dataDir, args = []) {
  const sub = args[0];
  const o = flags(args.slice(1));
  if (sub === "approve") {
    const id = o._[0];
    if (!id || !isStoryId(id)) usage("approve needs a story id");
    // --from <story>: reuse another story's approved design (4.11.3). The
    // snapshot is copied and its fidelity, crop and scene come along; a flag
    // given here still wins. Seen live: one mockup was attached to four new
    // stories by --file alone, so the crop was lost and the side-by-side
    // showed the whole preview page beside the game frame.
    let inherited = null;
    if (o.from !== undefined) {
      if (o.file) usage("give --from <story> or --file <snapshot>, not both");
      if (!isStoryId(o.from)) usage("--from needs a story id");
      const sf = storyFile(dataDir, o.from);
      const sfm = sf ? parseFm(readFileSync(sf, "utf8")) : null;
      const src = sfm ? readDesign(sfm.block) : null;
      if (!src || !src.hash || !src.path || !existsSync(join(dataDir, src.path))) { process.stderr.write(`shipyard-data design: ${o.from} has no approved design snapshot to reuse\n`); process.exit(3); }
      inherited = src;
      o.file = join(dataDir, src.path);
    }
    if (!o.file) usage("approve needs --file <snapshot> (or --from <story> to reuse that story's approved design)");
    if (!existsSync(o.file)) { process.stderr.write(`shipyard-data design: ${o.file} does not exist\n`); process.exit(2); }
    const ext = extname(o.file).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) usage(`snapshot type ${ext || "(none)"} is not accepted (${[...ALLOWED_EXT].join(" ")})`);
    const f = storyFile(dataDir, id);
    if (!f) { process.stderr.write(`shipyard-data design: ${id} not found under spec/\n`); process.exit(3); }
    const text = readFileSync(f, "utf8");
    const fm = parseFm(text);
    if (!fm) { process.stderr.write(`shipyard-data design: ${id} has no frontmatter\n`); process.exit(3); }
    const prev = readDesign(fm.block);
    const version = (prev?.version ?? 0) + 1;
    const rel = join("spec", "designs", `${id}-v${version}${ext}`);
    mkdirSync(join(dataDir, "spec", "designs"), { recursive: true });
    copyFileSync(o.file, join(dataDir, rel));
    if (o.fidelity !== undefined && !["exact", "mockup"].includes(o.fidelity)) usage(`--fidelity ${o.fidelity} is not exact|mockup`);
    let cropRect = null;
    if (o.crop !== undefined) {
      cropRect = String(o.crop).split(",").map((v) => Number(v.trim()));
      if (cropRect.length !== 4 || !cropRect.every((v) => Number.isInteger(v) && v >= 0) || !cropRect[2] || !cropRect[3]) usage("--crop needs x,y,w,h (whole pixels of the snapshot)");
    }
    // a crop only makes sense for a drawing; say so instead of silently storing it
    if (!cropRect && inherited?.crop) cropRect = inherited.crop;
    const fidelity = o.fidelity ?? (cropRect ? "mockup" : inherited?.fidelity ?? prev?.fidelity ?? "exact");
    if (cropRect && fidelity !== "mockup") usage("--crop applies to --fidelity mockup (an exact snapshot is compared as it is)");
    const d = { version, hash: sha256(join(dataDir, rel)), path: rel, approved_at: new Date().toISOString(), note: o.note ?? "", fidelity, crop: cropRect, scene: o.scene ?? inherited?.scene ?? prev?.scene ?? "" };
    if (inherited && !o.note) d.note = `same design as ${o.from} v${inherited.version}`;
    atomicWrite(f, `${fm.open}${writeDesign(fm.block, d)}${fm.close}${fm.rest}`);
    try { logEvent(dataDir, "design_approved", { story: id, version, hash: d.hash, path: rel, source: basename(o.file) }); } catch { /* best-effort */ }
    process.stdout.write(`${id}: design v${version} approved (${d.hash.slice(0, 12)}, ${rel})${fidelity === "mockup" ? " — mockup: compared by layout and colour" : ""}${d.scene ? `, scene ${d.scene}` : ""}\n`);
    return;
  }
  if (sub === "waive") {
    // The DESIGN stage's recorded "no": a UI story may skip the design, but the
    // decision is made in /ship-discuss and written by the CLI — never a
    // silent skip that /ship-sprint's Check 25 then turns into a dead end.
    const id = o._[0];
    if (!id || !isStoryId(id)) usage("waive needs a story id");
    if (!o.reason || !String(o.reason).trim()) usage("waive needs --reason \"<why this UI story ships without a design>\"");
    const f = storyFile(dataDir, id);
    if (!f) { process.stderr.write(`shipyard-data design: ${id} not found under spec/\n`); process.exit(3); }
    const text = readFileSync(f, "utf8");
    const fm = parseFm(text);
    if (!fm) { process.stderr.write(`shipyard-data design: ${id} has no frontmatter\n`); process.exit(3); }
    const prev = readDesign(fm.block);
    if (prev?.hash) { process.stderr.write(`shipyard-data design: ${id} already has an approved design (v${prev.version}) — a waiver cannot replace an approval; approve a new version instead\n`); process.exit(3); }
    const eol = fm.block.includes("\r\n") ? "\r\n" : "\n";
    const nb = waiverBlock(String(o.reason).trim(), eol) + eol;
    let block = DESIGN_BLOCK_RE.test(fm.block) ? fm.block.replace(DESIGN_BLOCK_RE, nb) : `${fm.block}${eol}${nb.trimEnd()}`;
    if (!/^ui:\s*/m.test(block)) block += `${eol}ui: true`;
    atomicWrite(f, `${fm.open}${block}${fm.close}${fm.rest}`);
    try { logEvent(dataDir, "design_waived", { story: id, reason: String(o.reason).trim() }); } catch { /* best-effort */ }
    process.stdout.write(`${id}: design waived — ${String(o.reason).trim()} (look-and-feel stays a manual probe; ui verify --level screen has no baseline)\n`);
    return;
  }
  if (sub === "check") {
    const ids = o._.length ? o._ : sprintStoryIds(dataDir);
    for (const id of ids) if (!isStoryId(id)) usage(`not a story id: ${id}`);
    const rows = ids.map((id) => checkStory(dataDir, id));
    const bad = rows.filter((r) => !["OK", "NOT-UI", "WAIVED"].includes(r.verdict));
    if (o.json) process.stdout.write(JSON.stringify({ stories: rows, failing: bad.map((r) => r.story) }) + "\n");
    else for (const r of rows) process.stdout.write(`${r.story}: ${r.verdict}${r.version ? ` v${r.version}` : ""}${r.reason ? ` — ${r.reason}` : ""}${r.hint ? ` — ${r.hint}` : ""}\n`);
    if (bad.length) {
      process.stderr.write(`shipyard-data design check: ${bad.length} UI stor${bad.length === 1 ? "y" : "ies"} without a valid approved design: ${bad.map((r) => `${r.story} (${r.verdict})`).join(", ")}\n`);
      process.exit(3);
    }
    return;
  }
  if (sub === "status") {
    const rows = [];
    for (const sub2 of ["stories", "features", "bugs"]) {
      const dir = join(dataDir, "spec", sub2);
      let names = [];
      try { names = readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith(".md")) continue;
        const fm = parseFm(readFileSync(join(dir, n), "utf8"));
        if (!fm) continue;
        const d = readDesign(fm.block);
        if (!d && !isUiStory(fm.block)) continue;
        rows.push({ story: n.split("-")[0], ui: isUiStory(fm.block), ...(d ?? { version: 0 }) });
      }
    }
    if (o.json) { process.stdout.write(JSON.stringify(rows) + "\n"); return; }
    if (!rows.length) { process.stdout.write("no UI stories\n"); return; }
    for (const r of rows) process.stdout.write(`${r.story}: ${r.ui ? "ui" : "non-ui"}${r.version ? ` design v${r.version} (${String(r.hash).slice(0, 12)})` : r.waived ? ` design waived (${r.waived_reason})` : " no design"}\n`);
    return;
  }
  usage(`unknown subcommand "${sub ?? ""}"`);
}
