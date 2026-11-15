/**
 * `shipyard-data ui <doctor|screenshot|verify|rules>` (E005, v4.3 — render-and-look loop + three-level UI verification)
 *
 *   doctor [--json]                           which adapter/engine is configured and whether it resolves
 *   screenshot --url <u> [--widths 375,768,1024] [--story S###] [--label <name>] [--json]
 *       → PNGs under <SHIPYARD_DATA>/ui/<story|adhoc>/<label>/w<width>.png; logs `ui_screenshot`
 *   verify --level component|screen|flow --spec <spec.json> [--story S###] [--json]
 *       component: computed styles / box / states / accessibility tree vs expectations
 *       screen:    tolerant screenshot diff (masks) against a baseline or the approved design snapshot,
 *                  plus the design lint rule pack at the given width
 *       flow:      scripted steps with a screenshot each, diffed against named baselines
 *       → report JSON under <SHIPYARD_DATA>/ui/reports/, exit 3 on any error-level finding; logs `ui_verified`.
 *         The CLI's verdict is the verdict: a model may flag, never approve (no --force).
 *   rules [--json]                            the effective lint rule pack (built-in + ui.rule_pack)
 *
 * Config (config.md `ui:`): adapter none|web (none skips every UI stage), base_url, playwright_root,
 * rule_pack (path to a JSON rule pack), widths. Adapter: bin/ui-adapters/web.mjs (Playwright via the
 * project's own install — nothing is downloaded by the plugin).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { getProjectRoot } from "./shipyard-resolver.mjs";
import { readUiConfig } from "./config-read.mjs";
import { createWebAdapter, DEFAULT_WIDTHS } from "./ui-adapters/web.mjs";
import { diffPng, lookCompare, writeSideBySide } from "./ui-adapters/image.mjs";
import { createFramesAdapter } from "./ui-adapters/frames.mjs";
import { readDesign } from "./design.mjs";
import { parseFlags } from "./cli-flags.mjs";

/** Built-in rule pack: the UX-KB rules that are deterministic in a browser. `verified` = error, `draft` = warning. */
export const BUILTIN_RULES = Object.freeze([
  { id: "touch-target-size", status: "verified", check: "touch-target-size", params: { min: 44 }, source: "WCAG 2.5.8 / platform HIGs (44pt)" },
  { id: "text-contrast", status: "verified", check: "contrast", params: { min: 4.5 }, source: "WCAG 1.4.3" },
  { id: "no-horizontal-scroll", status: "verified", check: "no-horizontal-scroll", params: {}, source: "WCAG 1.4.10 reflow" },
  { id: "img-alt", status: "verified", check: "img-alt", params: {}, source: "WCAG 1.1.1" },
  { id: "min-font-size", status: "draft", check: "font-size", params: { min: 12 }, source: "readability (draft)" },
  { id: "focus-visible", status: "draft", check: "focus-visible", params: {}, source: "WCAG 2.4.7 (heuristic)" },
]);

export function loadRules(dataDir, cfg) {
  let rules = [...BUILTIN_RULES];
  if (cfg.rule_pack) {
    const p = isAbsolute(cfg.rule_pack) ? cfg.rule_pack : join(dataDir, cfg.rule_pack);
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      const extra = Array.isArray(j) ? j : Array.isArray(j?.rules) ? j.rules : [];
      for (const r of extra) {
        if (!r || !r.id || !r.check) continue;
        const i = rules.findIndex((x) => x.id === r.id);
        const row = { id: String(r.id), status: r.status === "verified" ? "verified" : "draft", check: String(r.check), params: r.params ?? {}, source: r.source ?? cfg.rule_pack };
        if (i === -1) rules.push(row); else rules[i] = row;
      }
    } catch (e) {
      rules.push({ id: "rule-pack-unreadable", status: "draft", check: "noop", params: {}, source: `${cfg.rule_pack}: ${e.message}` });
    }
  }
  return rules;
}

let adapterCache = null;
function adapterFor(dataDir, cfg) {
  if (cfg.adapter === "none") return null;
  if (cfg.adapter === "frames") {
    adapterCache ??= createFramesAdapter({ projectRoot: safeProjectRoot(), frameCommand: cfg.frame_command || "" });
    return adapterCache;
  }
  if (cfg.adapter !== "web") throw Object.assign(new Error(`ui.adapter "${cfg.adapter}" is not supported (none|web|frames)`), { exitCode: 2 });
  adapterCache ??= createWebAdapter({ projectRoot: safeProjectRoot(), configuredRoot: cfg.playwright_root || null, baseURL: cfg.base_url || null });
  return adapterCache;
}
function safeProjectRoot() {
  try { return getProjectRoot(); } catch { return process.cwd(); }
}

/* ---------- pure evaluators (unit-tested without a browser) ---------- */

/** Expectation grammar: "rgb(…)" exact string; ">=44" / "<=2" / "=16px" numeric on the leading number; true/false for booleans. */
export function matchExpectation(actual, expected) {
  if (typeof expected === "boolean") return { pass: actual === expected, actual };
  const s = String(expected).trim();
  const m = s.match(/^(>=|<=|=|>|<)\s*([\d.]+)/);
  if (m) {
    const num = parseFloat(String(actual));
    const want = parseFloat(m[2]);
    if (!Number.isFinite(num)) return { pass: false, actual, reason: "not numeric" };
    const ops = { ">=": num >= want, "<=": num <= want, "=": num === want, ">": num > want, "<": num < want };
    return { pass: ops[m[1]], actual: num };
  }
  return { pass: String(actual).trim() === s, actual };
}

/** Component-level verdict from the adapter's `computed` result and the spec's expectations. */
export function evaluateComponent(spec, computed, aria = null) {
  const findings = [];
  for (const row of computed) {
    const exp = spec.selectors[row.selector] || {};
    if (row.count === 0) { findings.push({ severity: "error", selector: row.selector, detail: "no element matches" }); continue; }
    for (const [key, want] of Object.entries(exp)) {
      let actual;
      if (key === "count") actual = row.count;
      else if (key === "min-width") actual = row.first.box.width;
      else if (key === "min-height") actual = row.first.box.height;
      else if (key === "disabled" || key === "focusable") actual = row.first[key];
      else if (key === "text") actual = row.first.text;
      else actual = row.first.styles[key];
      const r = matchExpectation(actual, want);
      if (!r.pass) findings.push({ severity: "error", selector: row.selector, detail: `${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(r.actual)}` });
    }
  }
  for (const needle of spec.aria?.contains ?? []) {
    if (!aria || !aria.includes(needle)) findings.push({ severity: "error", selector: spec.aria?.selector ?? "body", detail: `accessibility tree lacks "${needle}"` });
  }
  return findings;
}

function reportPath(dataDir, level, story) {
  const dir = join(dataDir, "ui", "reports");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${story ?? "adhoc"}-${level}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
}
function readSpec(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw Object.assign(new Error(`--spec ${path}: ${e.message}`), { exitCode: 2 }); }
}
/** A story's approved design with the absolute snapshot path, or null. */
function storyDesign(dataDir, story) {
  for (const sub of ["stories", "features", "bugs"]) {
    const dir = join(dataDir, "spec", sub);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    const n = names.find((x) => x.startsWith(`${story}-`));
    if (!n) continue;
    const m = readFileSync(join(dir, n), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const d = m ? readDesign(m[1]) : null;
    return d?.path ? { ...d, abs: join(dataDir, d.path) } : null;
  }
  return null;
}
function storyDesignPath(dataDir, story) {
  return storyDesign(dataDir, story)?.abs ?? null;
}

const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * A design approved as a mockup is compared by eye (4.8): write design |
 * delivered as one image and report two similarity numbers. The numbers are a
 * verdict only when the project set its own bar (ui.min_layout / ui.min_palette).
 */
function mockupCompare({ dataDir, cfg, story, design, baseline, current, masks = [] }) {
  const look = lookCompare({ baselinePath: baseline, currentPath: current, crop: design?.crop ?? null, masks });
  const sideBySide = writeSideBySide(look, join(dataDir, "ui", story ?? "adhoc", "compare", "side-by-side.png"));
  const findings = [];
  if (cfg.min_layout !== null && look.layout < cfg.min_layout) findings.push({ severity: "error", detail: `the screen's layout agrees with the design in ${pct(look.layout)} of the frame (ui.min_layout ${pct(cfg.min_layout)}) — open ${sideBySide}` });
  if (cfg.min_palette !== null && look.palette < cfg.min_palette) findings.push({ severity: "error", detail: `the screen shares ${pct(look.palette)} of the design's colours (ui.min_palette ${pct(cfg.min_palette)}) — open ${sideBySide}` });
  return {
    findings,
    detail: { fidelity: "mockup", look: { layout: look.layout, palette: look.palette, cell_px: look.cell, cells: look.cells, differing_cells: look.differing_cells, resized: look.resized, design_size: look.design_size, frame_size: { width: look.width, height: look.height } }, side_by_side: sideBySide },
    line: `the design is a mockup, so this is compared by eye — open ${sideBySide} (design left, delivered right) and list every difference; layout ${pct(look.layout)}, colours ${pct(look.palette)} (information, not a verdict)`,
  };
}

function usage(msg) {
  process.stderr.write(
    `shipyard-data ui: ${msg}\n` +
      "  Usage: ui doctor [--json]\n" +
      "         ui screenshot --url <u> | --scene <name> [--widths 375,768,1024] [--story S###] [--label <name>] [--json]\n" +
      "         ui verify --level component|screen|flow --spec <spec.json> [--story S###] [--json]\n" +
      "         ui verify --level screen --scene <name> --story S### [--json]         (ui.adapter frames: render the scene, compare with the approved design)\n" +
      "         ui verify --level screen --image <frame.png> [--story S###] [--json]   (pre-rendered frame vs the approved design; no adapter needed)\n" +
      "         ui rules [--json]\n",
  );
  process.exit(2);
}
const flags = (args) => parseFlags(args, usage);

export async function main(dataDir, args = []) {
  const sub = args[0];
  const o = flags(args.slice(1));
  if (!sub || sub.startsWith("--")) usage(`missing subcommand`);
  const cfg = readUiConfig(dataDir);
  try {
    if (sub === "doctor") {
      const ad = adapterFor(dataDir, cfg);
      const r = { adapter: cfg.adapter, base_url: cfg.base_url || null, engine: ad ? ad.doctor() : { ok: true, detail: "ui.adapter: none — every UI stage is skipped" }, rules: loadRules(dataDir, cfg).length };
      if (o.json) { process.stdout.write(JSON.stringify(r) + "\n"); return; }
      process.stdout.write(`ui adapter: ${cfg.adapter}${cfg.base_url ? ` (base_url ${cfg.base_url})` : ""}\nengine: ${r.engine.ok ? "ok — " : "MISSING — "}${r.engine.detail}\nrules: ${r.rules}\n`);
      if (!r.engine.ok) process.exitCode = 4;
      return;
    }
    if (sub === "rules") {
      const rules = loadRules(dataDir, cfg);
      if (o.json) { process.stdout.write(JSON.stringify(rules) + "\n"); return; }
      for (const r of rules) process.stdout.write(`${r.id.padEnd(22)} ${r.status.padEnd(8)} ${r.check} ${JSON.stringify(r.params)} — ${r.source}\n`);
      return;
    }
    // Screen-level diff of a pre-rendered frame needs no adapter: a native
    // renderer's `make scenario` frame or a device screenshot vs the approved
    // design (the "delivered looks nothing like the design" check, 4.4).
    const imageSpec = sub === "verify" && o.level === "screen" ? (o.image ? { image: o.image } : (o.spec ? readSpec(o.spec) : null)) : null;
    if (imageSpec && imageSpec.image) {
      // relative to where the command was typed first (a monorepo sub-project), then the project root
      const current = isAbsolute(imageSpec.image) ? imageSpec.image : (existsSync(resolve(process.cwd(), imageSpec.image)) ? resolve(process.cwd(), imageSpec.image) : resolve(safeProjectRoot(), imageSpec.image));
      if (!existsSync(current)) usage(`image ${current} does not exist`);
      const findings = [];
      const detail = { current, lint: { skipped: "pre-rendered image — the design lint needs a DOM; run the project's own ui check" } };
      let baseline = imageSpec.baseline ? (isAbsolute(imageSpec.baseline) ? imageSpec.baseline : resolve(safeProjectRoot(), imageSpec.baseline)) : null;
      const design = !baseline && (imageSpec.design || o.story) ? storyDesign(dataDir, imageSpec.design ?? o.story) : null;
      if (design) baseline = design.abs;
      let lookLine = "";
      if (!baseline) detail.diff = { skipped: "no baseline and no approved design snapshot" };
      else if (!existsSync(baseline)) findings.push({ severity: "error", detail: `baseline ${baseline} does not exist` });
      else if (!/\.png$/i.test(baseline)) findings.push({ severity: "warning", detail: `baseline ${baseline} is not a PNG — pixel diff skipped` });
      else if (design && (design.fidelity === "mockup" || o.fidelity === "mockup")) {
        const mc = mockupCompare({ dataDir, cfg, story: o.story ?? imageSpec.design, design, baseline, current, masks: imageSpec.masks ?? [] });
        findings.push(...mc.findings); Object.assign(detail, mc.detail); lookLine = mc.line;
      } else {
        const d = diffPng({ baselinePath: baseline, currentPath: current, masks: imageSpec.masks ?? [], threshold: imageSpec.threshold ?? 0.1, maxDiffRatio: imageSpec.maxDiffRatio ?? 0.01 });
        detail.diff = d;
        if (!d.pass) findings.push({ severity: "error", detail: `screenshot differs from baseline: ${(d.ratio * 100).toFixed(2)}% of pixels (max ${(imageSpec.maxDiffRatio ?? 0.01) * 100}%)${d.size_changed ? ", size changed" : ""}` });
      }
      const errors = findings.filter((f) => f.severity === "error").length;
      const verdict = errors ? "FAIL" : lookLine ? "LOOK" : findings.length ? "WARN" : "PASS";
      try { logEvent(dataDir, "ui_verified", { story: o.story ?? "", level: "screen", verdict, result: errors ? "fail" : lookLine ? "look" : "pass", errors, warnings: findings.length - errors, source: "image", ...(detail.side_by_side ? { side_by_side: detail.side_by_side, layout: detail.look.layout.toFixed(3), palette: detail.look.palette.toFixed(3) } : {}) }); } catch { /* best-effort */ }
      if (o.json) process.stdout.write(JSON.stringify({ level: "screen", verdict, findings, detail, look: detail.look, side_by_side: detail.side_by_side }) + "\n");
      else { process.stdout.write(`ui verify screen (image): ${verdict} — ${errors} error(s), ${findings.length - errors} warning(s)\n`); if (lookLine) process.stdout.write(`  ${lookLine}\n`); for (const f of findings) process.stdout.write(`  [${f.severity}] ${f.detail}\n`); }
      if (errors) process.exitCode = 3;
      return;
    }
    const ad = adapterFor(dataDir, cfg);
    if (!ad) { process.stdout.write(`ui: skipped (ui.adapter: none)\n`); return; }
    if (sub === "screenshot") {
      o.url ??= o.scene; // a native frame is a scene, not a URL
      if (!o.url) usage("screenshot needs --url <page> (web) or --scene <name> (frames)");
      const widths = o.widths ? o.widths.split(",").map((w) => Number(w.trim())).filter((w) => Number.isInteger(w) && w > 0) : (cfg.widths?.length ? cfg.widths : [...DEFAULT_WIDTHS]);
      const label = (o.label || new Date().toISOString().replace(/[:.]/g, "-")).replace(/[^A-Za-z0-9_.-]/g, "_");
      const outDir = join(dataDir, "ui", o.story ?? "adhoc", label);
      const shots = await ad.screenshot({ url: o.url, outDir, widths });
      try { logEvent(dataDir, "ui_screenshot", { story: o.story ?? "", url: o.url, widths: widths.join(","), dir: outDir }); } catch { /* best-effort */ }
      if (o.json) { process.stdout.write(JSON.stringify({ dir: outDir, shots }) + "\n"); return; }
      for (const s of shots) process.stdout.write(`${s.width ? `${s.width}px` : "frame"} → ${s.path}\n`);
      process.stdout.write("Look at each capture with the Read tool before claiming the screen is right.\n");
      return;
    }
    if (sub === "verify") {
      if (!["component", "screen", "flow"].includes(o.level ?? "")) usage("verify needs --level component|screen|flow");
      // A native project needs no spec file: the scene name is the whole spec.
      const scene = o.scene ?? o.url ?? (o.story ? storyDesign(dataDir, o.story)?.scene || undefined : undefined);
      if (!o.spec && !(ad.kind === "frames" && scene)) usage(ad.kind === "frames" ? "verify needs --scene <name> (the frame to render and compare with the story's approved design), --spec <spec.json>, or --image <png>" : "verify needs --spec <spec.json> (or --image <png> for a screen diff of a pre-rendered frame)");
      const spec = o.spec ? readSpec(o.spec) : { url: scene };
      let findings = [];
      let detail = {};
      let lookLine = "";
      if (ad.kind === "frames" && o.level !== "screen") {
        process.stdout.write(`ui verify ${o.level}: skipped — ui.adapter frames has no DOM; the project's own checks (its ui-check / scenario tests) cover this level, and the screen level diffs frames against the approved design\n`);
        try { logEvent(dataDir, "ui_verified", { story: o.story ?? "", level: o.level, result: "SKIPPED", reason: "frames_adapter_no_dom" }); } catch { /* best-effort */ }
        return;
      }
      if (o.level === "component") {
        if (!spec.url || !spec.selectors) usage("component spec needs {url, selectors:{<selector>:{<prop>:<expectation>}}}");
        const props = [...new Set(Object.values(spec.selectors).flatMap((e) => Object.keys(e).filter((k) => !["count", "min-width", "min-height", "disabled", "focusable", "text"].includes(k))))];
        const computed = await ad.computed({ url: spec.url, selectors: Object.keys(spec.selectors), properties: props, width: spec.width ?? 1024 });
        const aria = spec.aria ? await ad.aria({ url: spec.url, selector: spec.aria.selector ?? "body", width: spec.width ?? 1024 }) : null;
        findings = evaluateComponent(spec, computed, aria);
        detail = { computed, aria: aria ? aria.slice(0, 4000) : null };
      } else if (o.level === "screen") {
        if (!spec.url) usage("screen spec needs {url, width?, baseline?|design?, masks?, maxDiffRatio?, lint?}");
        const width = spec.width ?? 375;
        const shots = await ad.screenshot({ url: spec.url, outDir: join(dataDir, "ui", o.story ?? "adhoc", "verify"), widths: [width] });
        const current = shots[0].path;
        let baseline = spec.baseline ? (isAbsolute(spec.baseline) ? spec.baseline : resolve(safeProjectRoot(), spec.baseline)) : null;
        const design = !baseline && (spec.design || o.story) ? storyDesign(dataDir, spec.design ?? o.story) : null;
        if (design) baseline = design.abs;
        if (baseline) {
          if (!existsSync(baseline)) findings.push({ severity: "error", detail: `baseline ${baseline} does not exist` });
          else if (!/\.png$/i.test(baseline)) findings.push({ severity: "warning", detail: `baseline ${baseline} is not a PNG — pixel diff skipped (approved design snapshots must be PNG screenshots for the screen level)` });
          else if (design && (design.fidelity === "mockup" || o.fidelity === "mockup")) {
            const mc = mockupCompare({ dataDir, cfg, story: o.story ?? spec.design, design, baseline, current, masks: spec.masks ?? [] });
            findings.push(...mc.findings); Object.assign(detail, mc.detail); lookLine = mc.line;
          } else {
            const d = await ad.diff({ baselinePath: baseline, currentPath: current, masks: spec.masks ?? [], threshold: spec.threshold ?? 0.1, maxDiffRatio: spec.maxDiffRatio ?? 0.01, width, url: spec.url });
            detail.diff = d;
            if (!d.pass) findings.push({ severity: "error", detail: `screenshot differs from baseline: ${(d.ratio * 100).toFixed(2)}% of pixels (max ${(spec.maxDiffRatio ?? 0.01) * 100}%)${d.size_changed ? ", size changed" : ""}` });
          }
        } else detail.diff = { skipped: "no baseline and no approved design snapshot" };
        if (spec.lint !== false && ad.kind === "frames") detail.lint = { skipped: "frames adapter has no DOM; the project's own ui check owns the design lint" };
        else if (spec.lint !== false) {
          const lint = await ad.lint({ url: spec.url, width, rules: loadRules(dataDir, cfg).filter((r) => r.check !== "noop") });
          detail.lint = lint;
          for (const f of lint.findings) findings.push({ severity: f.severity, selector: f.selector, detail: `${f.rule}: ${f.detail}` });
        }
        detail.current = current;
      } else {
        if (!Array.isArray(spec.steps) || !spec.steps.length) usage("flow spec needs {steps:[{url|click|fill|press|wait, screenshot?}], baselines?:{name:path}, width?}");
        const width = spec.width ?? 375;
        const outDir = join(dataDir, "ui", o.story ?? "adhoc", "flow");
        const run = await ad.flow({ steps: spec.steps, outDir, width });
        detail.flow = run;
        for (const shot of run.shots) {
          const b = spec.baselines?.[shot.name];
          if (!b) continue;
          const bp = isAbsolute(b) ? b : resolve(safeProjectRoot(), b);
          if (!existsSync(bp)) { findings.push({ severity: "error", detail: `baseline for "${shot.name}" missing: ${bp}` }); continue; }
          const d = await ad.diff({ baselinePath: bp, currentPath: shot.path, masks: spec.masks ?? [], threshold: spec.threshold ?? 0.1, maxDiffRatio: spec.maxDiffRatio ?? 0.01, width });
          shot.diff = d;
          if (!d.pass) findings.push({ severity: "error", detail: `"${shot.name}" differs from baseline: ${(d.ratio * 100).toFixed(2)}%` });
        }
        if (run.error) findings.push({ severity: "error", detail: `flow stopped at step ${run.error.step}: ${run.error.message}` });
      }
      const errors = findings.filter((f) => f.severity === "error").length;
      const warnings = findings.filter((f) => f.severity === "warning").length;
      const result = errors ? "fail" : lookLine ? "look" : "pass";
      const report = { level: o.level, story: o.story ?? null, spec: o.spec, result, errors, warnings, findings, detail, at: new Date().toISOString() };
      const rp = reportPath(dataDir, o.level, o.story ?? null);
      atomicWrite(rp, JSON.stringify(report, null, 2) + "\n");
      try { logEvent(dataDir, "ui_verified", { story: o.story ?? "", level: o.level, result, errors, warnings, report: rp, ...(detail.side_by_side ? { side_by_side: detail.side_by_side, layout: detail.look.layout.toFixed(3), palette: detail.look.palette.toFixed(3) } : {}) }); } catch { /* best-effort */ }
      if (o.json) process.stdout.write(JSON.stringify({ ...report, detail: undefined, look: detail.look, side_by_side: detail.side_by_side, report: rp }) + "\n");
      else {
        process.stdout.write(`ui verify ${o.level}: ${result.toUpperCase()} — ${errors} error(s), ${warnings} warning(s); report ${rp}\n`);
        if (lookLine) process.stdout.write(`  ${lookLine}\n`);
        for (const f of findings.slice(0, 30)) process.stdout.write(`  ${f.severity.padEnd(7)} ${f.selector ? f.selector + " — " : ""}${f.detail}\n`);
      }
      if (errors) process.exitCode = 3;
      return;
    }
    usage(`unknown subcommand "${sub ?? ""}"`);
  } catch (e) {
    if (typeof e?.exitCode === "number") { process.stderr.write(`shipyard-data ui: ${e.message}\n`); process.exit(e.exitCode); }
    throw e;
  } finally {
    // one browser per invocation (lazy) — always released, even on exit paths above
    await adapterCache?.close?.();
  }
}
