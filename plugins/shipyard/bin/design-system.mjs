/**
 * shipyard-data design-system: the project's design system, as a record its owner signed.
 *
 * The owner's direction (4.0.7): a fresh project that gets its first screen has no design system, and
 * Shipyard had one sentence about it and nothing on record. He asked for the deliverable a designer hands a
 * client: principles, rules and constraints, typography, components and the rest. And: "clients may build
 * different apps": one project is a game, another an Android app. So nothing here assumes a browser.
 *
 * Where it lives: <data>/spec/design-system/
 *   design-system.json   CLI-owned: the decision (defined | adopted | none), version, hash, the owner's words
 *   tokens.json          the raw values, in the platform's own unit
 *   rules.json           the rules, each marked: checked on the values, on a rendered screen, in the code, by the
 *                        project's own check (`check: "project"`, `command:` names it), or by eye
 *   prototype.json       this project's screens as blocks, linked the way a person moves through them
 *   DESIGN-SYSTEM.md     the twelve sections in words
 *   components/<name>.md one page per component, the same eight parts each
 *
 *   status [--json]                      what is decided, and what is still to fill
 *   detect                               theme, token and component files the project already has
 *   extract                              the values typed in the code, counted (nothing to adopt, but screens exist)
 *   init --platform <p> [--name "<n>"] [--components a,b | --starter] [--basis <path>] [--inspiration <ref>]
 *   component add <name>
 *   check [--json]                       every section filled, every token rule held; exit 3 otherwise
 *   show                                 the brief a session or a builder reads: tokens, components, rules
 *   rules [--json]
 *   tokens --format json|css|android|c [--theme <t>]     the token file for the code, printed
 *   render                               the book, one file opened from disk: <folder>/index.html. A page per
 *                                        section, each an open canvas (pan, zoom, movable frames), and one page
 *                                        where the project's screens are clicked through. A reference: the
 *                                        owner's feedback is given on the Claude Design artifact, before signing
 *   scan [--base <ref>] [--head <ref>] [--root <dir>]    colours typed in the code that are not tokens (a warning)
 *   covers <names…>                      does the system have the components and values one screen needs
 *   changes                              what changed since the owner signed it (shown before they sign again)
 *   approve --answer "<the owner's words>" [--artifact <link>] [--story S###]
 *   export --to <folder in the project>  the signed system as the project's files: document, component pages, token file
 *   adopt --path <file or folder in the project> --answer "…"     the project has its own; it is the system
 *   none --answer "…"                    this project has no design system, the owner's word
 *
 * What is checked without any renderer (so it holds for a game and a phone app alike): contrast of every
 * text-on-surface pair, the spacing scale on its grid, the touch target against the platform's floor, type
 * roles against the system's own minimum, components naming only tokens that exist. Checks on a rendered
 * screen join `ui verify` when the project renders in a browser. A rule nobody can measure is "by eye" and
 * goes to the review as a checklist; it is never reported as passed.
 *
 * Numbers come from the standard or the platform guide named in each rule's `source`. A rule with no such
 * source is `draft` (a warning) until the owner's approval of the system makes it theirs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";

export const DS_DIR = ["spec", "design-system"];
export const dsDir = (dataDir) => join(dataDir, ...DS_DIR);
const one = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const slug = (v) => one(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const readIf = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const FILL = /<!--\s*FILL\b/;

/* ---------- platforms: units and the numbers their guides give ---------- */

const WCAG_258 = "WCAG 2.2 SC 2.5.8 (24 CSS px)";
export const PLATFORMS = Object.freeze({
  web: { unit: "px", input: ["touch", "pointer", "keyboard"], target: { min: 44, floor: 24, gap: 8, source: `${WCAG_258}; 44 is SC 2.5.5` }, line: { min: 1.5, source: "WCAG 1.4.12 (line height 1.5 times the font size)" }, base: 8,
    starter: ["button", "text-field", "select", "checkbox", "switch", "card", "list-row", "dialog", "toast", "tabs", "navigation", "badge", "progress"] },
  android: { unit: "dp", input: ["touch"], target: { min: 48, floor: 48, gap: 8, source: "Material 3 (48 dp touch target, 8 dp apart)" }, line: { min: 1.4, source: "Material 3 type scale (Body Medium 14 sp on 20 sp)" }, base: 8,
    starter: ["button", "text-field", "menu", "checkbox", "switch", "card", "list-item", "dialog", "snackbar", "tabs", "navigation-bar", "top-app-bar", "badge", "progress"] },
  ios: { unit: "pt", input: ["touch"], target: { min: 44, floor: 28, gap: 8, source: "Apple HIG (44 pt default control size, 28 pt minimum)" }, line: { min: 1.25, source: "Apple HIG type sizes (Body 17 pt on 22 pt)" }, base: 8,
    starter: ["button", "text-field", "picker", "toggle", "list-row", "sheet", "alert", "tab-bar", "navigation-bar", "badge", "progress"] },
  desktop: { unit: "px", input: ["pointer", "keyboard"], target: { min: 24, floor: 24, gap: 8, source: WCAG_258 }, line: { min: 1.5, source: "WCAG 1.4.12 (line height 1.5 times the font size)" }, base: 8,
    starter: ["button", "text-field", "select", "checkbox", "menu", "toolbar", "table", "dialog", "tabs", "status-bar"] },
  game: { unit: "px", input: ["controller", "keyboard"], target: null, line: null, base: 8, starter: ["menu", "menu-item", "hud-readout", "meter", "button-prompt", "dialog-box", "toast"] },
  terminal: { unit: "cell", input: ["keyboard"], target: null, line: null, base: 1, starter: ["prompt", "table", "status-line", "list", "message"] },
  other: { unit: "px", input: [], target: null, line: null, base: 8, starter: [] },
});

export const SECTIONS = Object.freeze([
  ["principles", "Principles", "3 to 5 statements that settle an argument about a screen. Each: the statement, one do, one don't."],
  ["voice", "Voice and wording", "Tone in one line; how buttons are labelled; how an error, an empty state and a success are worded; date, time and number formats."],
  ["colour", "Colour", "What each role in tokens.json is for and where it must not be used; which themes exist; how state (hover, pressed, disabled, error) is shown in colour."],
  ["typography", "Typography", "What each type role in tokens.json is for; weights allowed; fallback fonts; what happens when a person enlarges text."],
  ["space", "Space and layout", "How the spacing scale is used (inside a group, between groups, page margins); the grid; what changes at each size of window or screen; density."],
  ["shape", "Shape and depth", "Which radius each kind of component takes; borders; what each level of depth means and where it is allowed."],
  ["motion", "Motion", "What may move and why; which duration for which change; what a person who asked for reduced motion gets."],
  ["icons", "Icons and imagery", "The icon set and its sizes; when an icon needs a label; illustration and photo style; how the logo is used."],
  ["components", "Components", "When a new component is made instead of a variant of an existing one. The pages themselves are in components/."],
  ["patterns", "Patterns", "Components combined for a job: a form, a list, moving between screens, and how every screen shows empty, loading and error."],
  ["rules", "Rules and constraints", null],
  ["handoff", "Handoff and change", "Where the token file lives in the code and how it is produced; naming; how a change to the system is proposed and approved."],
]);

export const COMPONENT_PARTS = Object.freeze([
  ["Purpose", "What it is for, and when NOT to use it (name the component to use instead)."],
  ["Anatomy", "Its parts, by name."],
  ["Variants", "Each variant and the job it has. One variant is a fine answer."],
  ["Sizes", "Each size with its measures; for a touch target, its size and the gap around it."],
  ["States", "Every state it can be in (for example rest, focus, pressed, disabled, loading, error) and what changes in each."],
  ["Behaviour", "Keyboard or controller, what a screen reader says, long text, the narrowest width."],
  ["Tokens", "The tokens it uses, each in backticks: `color.primary`, `type.label`, `space.16`, `radius.md`."],
  ["Do and don't", "Two real examples of each."],
]);

/* ---------- colour maths (WCAG 2.x relative luminance) ---------- */

export function hexRgb(hex) {
  const m = String(hex ?? "").trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export function contrast(a, b) {
  const ra = hexRgb(a), rb = hexRgb(b);
  if (!ra || !rb) return null;
  const la = lum(ra), lb = lum(rb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* ---------- the record ---------- */

export function readSystem(dataDir) {
  const s = readJson(join(dsDir(dataDir), "design-system.json"));
  if (!s || typeof s !== "object") return { decided: false, mode: "", platform: "", version: 0 };
  return { decided: ["defined", "adopted", "none"].includes(s.mode) && (s.mode !== "defined" || Number(s.version) > 0), mode: String(s.mode ?? ""), platform: String(s.platform ?? ""), name: String(s.name ?? ""), version: Number(s.version) || 0, hash: String(s.hash ?? ""), approved_at: String(s.approved_at ?? ""), answer: String(s.answer ?? ""), artifact: String(s.artifact ?? ""), paths: Array.isArray(s.paths) ? s.paths.map(String) : [] };
}
export const readTokens = (dataDir) => readJson(join(dsDir(dataDir), "tokens.json"));
export function readRules(dataDir) {
  const r = readJson(join(dsDir(dataDir), "rules.json"));
  return Array.isArray(r) ? r.filter((x) => x && x.id && x.check) : [];
}
function componentFiles(dataDir) {
  try { return readdirSync(join(dsDir(dataDir), "components")).filter((n) => n.endsWith(".md")).sort(); } catch { return []; }
}
/** What the owner signed: every file of the record except the decision itself and the rendered page. */
export function recordHash(dataDir) {
  const h = createHash("sha256");
  const files = ["tokens.json", "rules.json", "prototype.json", "DESIGN-SYSTEM.md", ...componentFiles(dataDir).map((n) => join("components", n))];
  for (const f of files) { const t = readIf(join(dsDir(dataDir), f)); if (t !== null) h.update(`${f.replace(/\\/g, "/")}\n${t.replace(/\r\n/g, "\n")}\n`); }
  return h.digest("hex");
}
function writeSystem(dataDir, s) {
  mkdirSync(dsDir(dataDir), { recursive: true });
  atomicWrite(join(dsDir(dataDir), "design-system.json"), JSON.stringify(s, null, 2) + "\n");
}

const RECORD_FILES = (dataDir) => ["tokens.json", "rules.json", "prototype.json", "DESIGN-SYSTEM.md", ...componentFiles(dataDir).map((n) => `components/${n}`)];
/** What was signed, kept beside the record so a later change can be shown as a difference. */
function snapshot(dataDir, version) {
  const snap = {};
  for (const f of RECORD_FILES(dataDir)) { const t = readIf(join(dsDir(dataDir), f)); if (t !== null) snap[f] = t.replace(/\r\n/g, "\n"); }
  mkdirSync(join(dsDir(dataDir), ".signed"), { recursive: true });
  atomicWrite(join(dsDir(dataDir), ".signed", `v${version}.json`), JSON.stringify(snap) + "\n");
}
const flat = (o, pre = "", out = {}) => { for (const [k, v] of Object.entries(o ?? {})) { if (v && typeof v === "object" && !Array.isArray(v)) flat(v, `${pre}${k}.`, out); else out[`${pre}${k}`] = JSON.stringify(v); } return out; };
/** The difference between the version the owner signed and what is in the record now, in words. */
export function changesSince(dataDir) {
  const s = readSystem(dataDir);
  const snap = readJson(join(dsDir(dataDir), ".signed", `v${s.version}.json`));
  if (!snap) return null;
  const out = [];
  const now = (f) => (readIf(join(dsDir(dataDir), f)) ?? "").replace(/\r\n/g, "\n");
  const j = (text) => { try { return JSON.parse(text); } catch { return {}; } };
  const a = flat(j(snap["tokens.json"] ?? "{}")), b = flat(j(now("tokens.json")));
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) out.push(a[k] === undefined ? `value added: ${k} = ${b[k]}` : b[k] === undefined ? `value removed: ${k} (was ${a[k]})` : `value changed: ${k}: ${a[k]} → ${b[k]}`);
  const rules = (text) => Object.fromEntries((Array.isArray(j(text)) ? j(text) : []).map((r) => [r.id, r]));
  const ra = rules(snap["rules.json"] ?? "[]"), rb = rules(now("rules.json"));
  for (const id of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (!ra[id]) out.push(`rule added: ${id} (${rb[id].rule})`);
    else if (!rb[id]) out.push(`rule removed: ${id} (${ra[id].rule})`);
    else if (ra[id].status !== rb[id].status) out.push(`rule ${id}: ${ra[id].status === "verified" ? "fails a screen" : "warns"} → ${rb[id].status === "verified" ? "fails a screen" : "warns"}`);
    else if (JSON.stringify(ra[id]) !== JSON.stringify(rb[id])) out.push(`rule changed: ${id}`);
  }
  const files = new Set([...Object.keys(snap), ...RECORD_FILES(dataDir)]);
  for (const f of files) {
    if (f === "tokens.json" || f === "rules.json") continue;
    const was = snap[f], is = readIf(join(dsDir(dataDir), f)) === null ? undefined : now(f);
    const what = f.startsWith("components/") ? `component ${f.slice(11, -3)}` : f === "prototype.json" ? "the prototype's screens" : "the sections in words (DESIGN-SYSTEM.md)";
    if (was === undefined) out.push(`${what}: added`); else if (is === undefined) out.push(`${what}: removed`); else if (was !== is) out.push(`${what}: changed`);
  }
  return out;
}
/** Which of the named components and values the system has. A name with a dot is a value (`color.warning`), any other is a component. */
export function covers(dataDir, names) {
  const t = readTokens(dataDir) ?? {};
  const tokens = tokenNames(t), comps = new Set(componentFiles(dataDir).map((n) => n.replace(/\.md$/, "")));
  return names.map((raw) => { const isToken = raw.includes("."); const name = isToken ? raw : slug(raw); return { name, kind: isToken ? "value" : "component", have: isToken ? tokens.has(name) : comps.has(name) }; });
}

/** State in one word: undecided | none | adopted | draft | approved | changed. */
export function stateOf(dataDir) {
  const s = readSystem(dataDir);
  if (s.mode === "none" || s.mode === "adopted") return s.mode;
  if (s.mode !== "defined") return "undecided";
  if (!s.version) return "draft";
  return recordHash(dataDir) === s.hash ? "approved" : "changed";
}

/**
 * What a UI story still owes before it can be approved, or null.
 * Once per project: the owner defines a system, names the project's own, or says there is none.
 */
export function designSystemOwed(dataDir) {
  const st = stateOf(dataDir);
  if (st === "approved" || st === "adopted" || st === "none") return null;
  if (st === "undecided") return "this project has no design system on record. Asked once per project: `shipyard-data design-system init --platform <web|android|ios|desktop|game|terminal|other>` to define one (then fill it and `design-system approve --answer`), `design-system adopt --path <the project's own theme or component folder> --answer \"<the owner's words>\"` when the project has its own, or `design-system none --answer \"<the owner's words>\"`";
  if (st === "draft") return "the design system is a draft. Finish it (`shipyard-data design-system check` names what is left) and record the owner's sign-off: `design-system approve --answer \"<their words>\"`";
  return "the design system changed after the owner signed it. Show them what changed and record the sign-off again: `shipyard-data design-system approve --answer \"<their words>\"`";
}

/** One line for the start of a discussion. */
export function contextLine(dataDir) {
  const s = readSystem(dataDir);
  const st = stateOf(dataDir);
  if (st === "undecided") return "not set (asked once, at the first screen that gets a design: `shipyard-data design-system status`)";
  if (st === "none") return "none (the owner's answer)";
  if (st === "adopted") return `the project's own: ${s.paths.join(", ")}. Design within it`;
  return `${s.name || "design system"} (${s.platform}) ${st === "approved" ? `v${s.version}` : st === "draft" ? "draft, not signed" : `v${s.version}, changed since it was signed`}: \`shipyard-data design-system show\` before designing or building a screen`;
}

/* ---------- scaffolds ---------- */

function starterTokens(platform) {
  const p = PLATFORMS[platform];
  const t = {
    platform, unit: p.unit, input: p.input,
    color: { themes: { light: { surface: "", "on-surface": "", primary: "", "on-primary": "", danger: "", "on-danger": "", border: "" } }, pairs: [{ fg: "border", bg: "surface", kind: "ui" }] },
    type: { families: { body: "" }, min_size: null, roles: { heading: { family: "body", size: null, line: null, weight: 600 }, body: { family: "body", size: null, line: null, weight: 400 }, label: { family: "body", size: null, line: null, weight: 500 } } },
    space: { base: p.base, scale: [] },
    radius: {},
    elevation: {},
    motion: { durations: {}, easing: {}, reduced: "" },
    breakpoints: {},
  };
  if (p.target) t.target = { min: p.target.min, gap: p.target.gap };
  return t;
}

export function defaultRules(platform) {
  const p = PLATFORMS[platform];
  const kb = (page) => `UX knowledge base: ${page}`;
  const r = [
    { id: "contrast-text", kind: "access", rule: "Text on its surface has a contrast of at least 4.5 to 1, in every theme.", check: "tokens", status: "verified", params: { min: 4.5 }, source: "WCAG 1.4.3" },
    { id: "contrast-ui", kind: "access", rule: "A border or an icon a person needs in order to use a control has a contrast of at least 3 to 1.", check: "tokens", status: "verified", params: { min: 3 }, source: "WCAG 1.4.11" },
    { id: "spacing-on-grid", kind: "space", rule: "Every step of the spacing scale is a multiple of a quarter of the base unit.", check: "tokens", status: "verified", params: {}, source: kb("eight-point-grid, spacing-scale-tokens") },
    { id: "type-min-size", kind: "type", rule: "No type role is smaller than the system's own minimum size.", check: "tokens", status: "verified", params: {}, source: "the system's own minimum (type.min_size)" },
    { id: "component-tokens", kind: "tokens", rule: "A component names only tokens that exist.", check: "tokens", status: "verified", params: {}, source: kb("spacing-scale-tokens, consistent-radius-family") },
    { id: "radius-family", kind: "shape", rule: "Corner radii come from a small family of named steps, at most ten.", check: "tokens", status: "draft", params: { max: 10 }, source: kb("consistent-radius-family, material-3-shape-scale") },
    { id: "reduced-motion", kind: "access", rule: "The system says what a person who asked for reduced motion gets.", check: "tokens", status: "draft", params: {}, source: "WCAG 2.3.3" },
  ];
  if (p.line) r.push({ id: "body-line-height", kind: "type", rule: `Body text has a line height of at least ${p.line.min} times its size.`, check: "tokens", status: "draft", params: { min: p.line.min }, source: `${p.line.source}; ${kb("line-height")}` });
  if (p.target) r.push({ id: "touch-target-min", kind: "touch", rule: `Anything a person presses is at least ${p.target.floor} ${p.unit} on each side; the system aims for ${p.target.min}.`, check: "tokens", status: "verified", params: { floor: p.target.floor }, source: `${p.target.source}; ${kb("touch-target-size")}` });
  if (platform === "web") r.push(
    { id: "screen-touch-target", kind: "touch", rule: "On a rendered screen, every control is at least the system's target size.", check: "screen", page_check: "touch-target-size", status: "verified", params: {}, source: `${p.target.source}; ${kb("touch-target-size")}` },
    { id: "screen-target-gap", kind: "touch", rule: "Controls that are smaller than the target size are at least the system's gap apart.", check: "screen", page_check: "touch-target-gap", status: "draft", params: {}, source: `Material 3 (8 dp between targets); ${kb("touch-target-spacing")}` },
    { id: "screen-token-colours", kind: "tokens", rule: "Text and surfaces on a rendered screen use only the system's colours.", check: "screen", page_check: "token-colors", status: "draft", params: {}, source: kb("spacing-scale-tokens (the same rule, for colour)") },
    { id: "screen-spacing-scale", kind: "space", rule: "Padding and gaps on a rendered screen are steps of the spacing scale.", check: "screen", page_check: "spacing-scale", status: "draft", params: {}, source: kb("spacing-scale-tokens") },
    { id: "screen-radius-family", kind: "shape", rule: "Corner radii on a rendered screen are steps of the radius family.", check: "screen", page_check: "radius-family", status: "draft", params: {}, source: kb("consistent-radius-family") },
    { id: "screen-type-scale", kind: "type", rule: "Text sizes on a rendered screen are sizes of a type role.", check: "screen", page_check: "type-scale", status: "draft", params: {}, source: "the system's type roles" },
    { id: "screen-line-height", kind: "type", rule: "Running text on a rendered screen keeps the body line height.", check: "screen", page_check: "line-height", status: "draft", params: { min: p.line.min, min_chars: 80 }, source: `${p.line.source}; ${kb("line-height")}` },
    { id: "screen-line-length", kind: "type", rule: "A line of running text is at most 80 characters.", check: "screen", page_check: "line-length", status: "draft", params: { max: 80 }, source: `WCAG 1.4.8; ${kb("line-length")}` },
  );
  r.push(
    { id: "raw-colour-in-code", kind: "tokens", rule: "The code names a token; it does not type a colour.", check: "source", status: "draft", params: {}, source: kb("spacing-scale-tokens (the same rule, for colour)") },
    { id: "inner-outer-space", kind: "space", rule: "The space inside a group is at most the space around it.", check: "eye", status: "draft", params: {}, source: kb("internal-external-spacing-rule") },
    { id: "nested-radius", kind: "shape", rule: "A rounded shape inside a rounded shape: inner radius = outer radius minus the padding; zero or less means square.", check: "eye", status: "draft", params: {}, source: kb("nested-corner-radius") },
    { id: "one-primary-action", kind: "hierarchy", rule: "One primary action on a screen.", check: "eye", status: "draft", params: {}, source: kb("hicks-law") },
    { id: "comparable-options", kind: "choice", rule: "Options shown together can be compared at a glance; a long list is grouped or filtered.", check: "eye", status: "draft", params: {}, source: kb("choice-overload, hicks-law") },
    { id: "states-defined", kind: "content", rule: "Every screen says what it shows when it is empty, loading and failed.", check: "eye", status: "draft", params: {}, source: kb("nielsen-10-usability-heuristics (visibility of system status)") },
    { id: "state-not-shape-alone", kind: "access", rule: "A state is never shown by shape or colour alone.", check: "eye", status: "draft", params: {}, source: `WCAG 1.4.1; ${kb("shape-signals-state")}` },
  );
  if (p.input.includes("keyboard") || p.input.includes("controller")) r.push({ id: "focus-visible", kind: "access", rule: "The focused control is always visible, and its ring follows the control's shape.", check: "eye", status: "draft", params: {}, source: `WCAG 2.4.7; ${kb("focus-indicator-shape")}` });
  return r;
}

/**
 * The starter screens for the book's prototype page. `draft: true` means "the scaffold, not this project's
 * screens": the check refuses it, so a project never signs a prototype of somebody else's app.
 */
function starterPrototype(platform, name) {
  if (platform === "game") return { draft: true, start: "title", screens: {
    title: { title: "Title", blocks: [{ type: "title", text: name, sub: "PRESS START", to: "menu" }] },
    menu: { title: "Main menu", blocks: [{ type: "menu", title: name, center: true, rows: [{ label: "PLAY", to: "play" }, { label: "SETTINGS", to: "settings" }] }] },
    settings: { title: "Settings", blocks: [{ type: "menu", title: "SETTINGS", center: true, rows: [{ label: "SOUND", value: "ON" }, { label: "BACK", to: "back" }] }] },
    play: { title: "Play", blocks: [{ type: "hud", clock: "00:00", gold: "0", score: "0 / 0", pause: { label: "START", to: "pause" }, orbs: [{ label: "Y" }, { label: "X" }, { label: "B" }, { label: "A" }] }] },
    pause: { title: "Paused", blocks: [{ type: "hud", clock: "00:00", gold: "0", score: "0 / 0", orbs: [] }, { type: "menu", title: "PAUSED", rows: [{ label: "RESUME", to: "back" }, { label: "QUIT", to: "menu" }] }] },
  } };
  return { draft: true, start: "home", screens: {
    home: { title: "Home", blocks: [{ type: "bar", title: name }, { type: "heading", text: "A list" }, { type: "list", rows: [{ title: "First item", value: "1", to: "detail" }, { title: "Second item", value: "2", to: "detail" }] }, { type: "buttons", items: [{ label: "Add", to: "add" }] }] },
    add: { title: "Add", blocks: [{ type: "bar", title: "Add", back: true }, { type: "field", label: "Name", help: "What it is called" }, { type: "buttons", items: [{ label: "Save", to: "home", toast: "Saved" }, { label: "Cancel", variant: "secondary", to: "back" }] }] },
    detail: { title: "Detail", blocks: [{ type: "bar", title: "First item", back: true }, { type: "text", text: "What this item is." }, { type: "buttons", items: [{ label: "Delete", variant: "danger", to: "confirm" }] }] },
    confirm: { title: "Delete?", blocks: [{ type: "bar", title: "First item", back: true }, { type: "dialog", title: "Delete this item?", text: "This cannot be undone.", buttons: [{ label: "Cancel", to: "back" }, { label: "Delete", variant: "danger", to: "home", toast: "Deleted" }] }] },
  } };
}
export const BLOCK_TYPES = Object.freeze(["bar", "heading", "text", "total", "list", "field", "buttons", "tabs", "nav", "card", "meter", "toast", "empty", "dialog", "title", "menu", "hud"]);
export const readPrototype = (dataDir) => readJson(join(dsDir(dataDir), "prototype.json"));
/** Every place a block sends the person: its own `to`, and that of its rows, items, buttons, action, button, pause, orbs and inner blocks. */
function linksOf(b, out = []) {
  if (!b || typeof b !== "object") return out;
  if (typeof b.to === "string") out.push(b.to);
  for (const k of ["rows", "items", "buttons", "orbs", "blocks"]) for (const x of Array.isArray(b[k]) ? b[k] : []) linksOf(x, out);
  for (const k of ["action", "button", "pause"]) linksOf(b[k], out);
  return out;
}
/** Problems with the prototype: the scaffold left as it is, an unknown block, a link to no screen, a screen nothing leads to. */
export function prototypeProblems(p) {
  if (!p || typeof p !== "object" || !p.screens || typeof p.screens !== "object") return ["prototype.json is missing or has no screens: the book's interactive page is this project's screens, linked the way a person moves through them"];
  const ids = Object.keys(p.screens);
  const out = [];
  if (p.draft) out.push("prototype.json is still the starter (`draft: true`): write this project's own screens and how a person moves between them, then remove `draft`");
  if (ids.length < 2) out.push("the prototype needs at least two screens with a way from one to the other");
  if (!ids.includes(p.start)) out.push(`the prototype's start screen "${p.start ?? ""}" is not one of its screens`);
  const reached = new Set([p.start]);
  for (const id of ids) {
    const blocks = Array.isArray(p.screens[id]?.blocks) ? p.screens[id].blocks : [];
    if (!blocks.length) out.push(`screen ${id} has no blocks`);
    const walk = (b) => { if (!BLOCK_TYPES.includes(b?.type)) out.push(`screen ${id}: "${b?.type ?? ""}" is not a block (${BLOCK_TYPES.join(", ")})`); for (const x of Array.isArray(b?.blocks) ? b.blocks : []) walk(x); };
    blocks.forEach(walk);
    for (const to of blocks.flatMap((b) => linksOf(b))) { if (to === "back") continue; if (!ids.includes(to)) out.push(`screen ${id} leads to "${to}", which is not a screen`); else reached.add(to); }
  }
  for (const id of ids) if (!reached.has(id)) out.push(`nothing leads to screen ${id}`);
  return out;
}

function systemDoc(name, platform, basis = [], inspiration = []) {
  const out = [`# ${name}`, "", `Platform: ${platform}. The values are in \`tokens.json\`, the rules in \`rules.json\`, one page per component in \`components/\`.`, ""];
  out.push("## Where it comes from", "");
  if (basis.length) out.push("Built on what the project already has. Their values are the starting values here; say below what was kept and what was changed, and why.", "", ...basis.map((b) => `- existing: \`${b}\``), "");
  if (inspiration.length) out.push("Inspiration, for look and feel only. Name the qualities taken from each (for example: calm, dense, high contrast). No component is copied from one.", "", ...inspiration.map((b) => `- inspiration: ${b}`), "");
  if (!basis.length && !inspiration.length) out.push("Made new for this project: nothing existing to build on and no inspiration given.", "");
  else out.push("<!-- FILL: what was kept from the existing files, what was changed and why; the qualities taken from each inspiration. -->", "");
  SECTIONS.forEach(([, title, ask], i) => {
    out.push(`## ${i + 1}. ${title}`, "");
    out.push(ask === null ? "The rules are listed by `shipyard-data design-system rules`, each with how it is checked and where its number comes from. Say here only what this project adds or relaxes, and why." : `<!-- FILL: ${ask} -->`, "");
  });
  return out.join("\n");
}
function componentDoc(name) {
  const out = ["---", `component: ${name}`, "---", "", `# ${name}`, ""];
  for (const [part, ask] of COMPONENT_PARTS) out.push(`## ${part}`, "", `<!-- FILL: ${ask} -->`, "");
  return out.join("\n");
}

/* ---------- the check ---------- */

/** Every token a component may name: color.<role>, type.<role>, space.<value>, radius.<name>, elevation.<name>, motion.<name>, size.<name>. */
export function tokenNames(t) {
  const names = new Set();
  for (const theme of Object.values(t?.color?.themes ?? {})) for (const k of Object.keys(theme ?? {})) names.add(`color.${k}`);
  for (const k of Object.keys(t?.type?.roles ?? {})) names.add(`type.${k}`);
  for (const v of t?.space?.scale ?? []) names.add(`space.${v}`);
  for (const k of Object.keys(t?.radius ?? {})) names.add(`radius.${k}`);
  for (const k of Object.keys(t?.elevation ?? {})) names.add(`elevation.${k}`);
  for (const k of Object.keys(t?.sizes ?? {})) names.add(`size.${k}`);
  for (const k of [...Object.keys(t?.motion?.durations ?? {}), ...Object.keys(t?.motion?.easing ?? {})]) names.add(`motion.${k}`);
  return names;
}

/** Colour pairs that must be readable: every on-X on X, plus the pairs the system lists. */
export function colourPairs(t) {
  const pairs = [];
  for (const [theme, roles] of Object.entries(t?.color?.themes ?? {})) {
    for (const k of Object.keys(roles ?? {})) if (k.startsWith("on-") && roles[k.slice(3)] !== undefined) pairs.push({ theme, fg: k, bg: k.slice(3), kind: "text" });
    for (const p of t?.color?.pairs ?? []) if (p && p.fg && p.bg) pairs.push({ theme, fg: String(p.fg), bg: String(p.bg), kind: p.kind === "ui" ? "ui" : "text" });
  }
  return pairs;
}

export function checkSystem(dataDir) {
  const findings = [];
  const sections = [];
  const rules = readRules(dataDir);
  const rule = (id) => rules.find((r) => r.id === id);
  const add = (id, detail, forced) => { const r = rule(id); if (!r && !forced) return; findings.push({ rule: id, severity: forced ?? (r.status === "verified" ? "error" : "warning"), detail }); };
  const t = readTokens(dataDir);
  if (!t) { findings.push({ rule: "record", severity: "error", detail: "tokens.json is missing or is not JSON" }); return { findings, sections, components: [] }; }
  if (!rules.length) findings.push({ rule: "record", severity: "error", detail: "rules.json is missing, empty or is not a JSON list" });

  // the words
  const doc = readIf(join(dsDir(dataDir), "DESIGN-SYSTEM.md")) ?? "";
  const heads = [...doc.matchAll(/^## (\d+)\. [^\r\n]*\r?\n/gm)];
  const origin = doc.match(/^## Where it comes from[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (origin && FILL.test(origin[1])) findings.push({ rule: "sections", severity: "error", detail: "\"Where it comes from\" is to fill in DESIGN-SYSTEM.md" });
  SECTIONS.forEach(([key, title], i) => {
    const h = heads.find((m) => Number(m[1]) === i + 1);
    const body = h ? doc.slice(h.index + h[0].length, heads[heads.indexOf(h) + 1]?.index ?? doc.length) : null;
    const state = body === null ? "missing" : FILL.test(body) || !body.trim() ? "to fill" : "filled";
    sections.push({ n: i + 1, key, title, state });
    if (state !== "filled") findings.push({ rule: "sections", severity: "error", detail: `section ${i + 1} (${title}) is ${state} in DESIGN-SYSTEM.md` });
  });

  // colour
  const themes = Object.entries(t.color?.themes ?? {});
  if (!themes.length) findings.push({ rule: "tokens", severity: "error", detail: "color.themes has no theme" });
  for (const [theme, roles] of themes) {
    for (const need of ["surface", "on-surface", "primary", "on-primary"]) if (!(need in (roles ?? {}))) findings.push({ rule: "tokens", severity: "error", detail: `theme ${theme} has no ${need} colour` });
    for (const [k, v] of Object.entries(roles ?? {})) if (!hexRgb(v)) findings.push({ rule: "tokens", severity: "error", detail: `color.${k} in theme ${theme} is ${v ? `"${v}", not a #RRGGBB colour` : "not chosen"}` });
  }
  const first = themes[0]?.[1] ?? {};
  for (const [theme, roles] of themes.slice(1)) for (const k of Object.keys(first)) if (!(k in (roles ?? {}))) findings.push({ rule: "tokens", severity: "error", detail: `theme ${theme} has no ${k} colour (${themes[0][0]} has one)` });
  for (const p of colourPairs(t)) {
    const roles = t.color.themes[p.theme];
    const c = contrast(roles[p.fg], roles[p.bg]);
    if (c === null) { if (!(p.fg in roles) || !(p.bg in roles)) findings.push({ rule: "tokens", severity: "error", detail: `colour pair ${p.fg} on ${p.bg} names a role theme ${p.theme} does not have` }); continue; }
    const id = p.kind === "ui" ? "contrast-ui" : "contrast-text";
    const min = rule(id)?.params?.min ?? (p.kind === "ui" ? 3 : 4.5);
    if (c < min) add(id, `${p.fg} on ${p.bg} (${p.theme}): contrast ${c.toFixed(2)} to 1, needs ${min}`);
  }

  // type
  const roles = Object.entries(t.type?.roles ?? {});
  const minSize = Number(t.type?.min_size);
  if (!(minSize > 0)) findings.push({ rule: "tokens", severity: "error", detail: "type.min_size (the smallest text this system allows) is not chosen" });
  if (!roles.some(([k]) => k === "body")) findings.push({ rule: "tokens", severity: "error", detail: "type.roles has no body role" });
  for (const [k, r] of roles) {
    if (!(Number(r?.size) > 0) || !(Number(r?.line) > 0)) { findings.push({ rule: "tokens", severity: "error", detail: `type.${k} needs a size and a line height (in ${t.unit ?? "units"})` }); continue; }
    if (r.family && !one(t.type?.families?.[r.family])) findings.push({ rule: "tokens", severity: "error", detail: `type.${k} uses family "${r.family}", which type.families does not name` });
    if (minSize > 0 && r.size < minSize) add("type-min-size", `type.${k} is ${r.size}, below the system's minimum of ${minSize}`);
    if (r.line < r.size) findings.push({ rule: "tokens", severity: "error", detail: `type.${k}: line height ${r.line} is smaller than its size ${r.size}` });
  }
  const body = t.type?.roles?.body;
  const lh = rule("body-line-height");
  if (lh && body?.size > 0 && body?.line > 0 && body.line / body.size < lh.params.min - 1e-9) add("body-line-height", `type.body: line height ${(body.line / body.size).toFixed(2)} times its size, the rule says ${lh.params.min}`);

  // space, shape, touch, motion
  const scale = t.space?.scale ?? [];
  const base = Number(t.space?.base);
  if (!(base > 0)) findings.push({ rule: "tokens", severity: "error", detail: "space.base is not chosen" });
  if (scale.length < 3) findings.push({ rule: "tokens", severity: "error", detail: "space.scale needs at least three steps" });
  if (scale.some((v, i) => !(Number(v) >= 0) || (i && v <= scale[i - 1]))) findings.push({ rule: "tokens", severity: "error", detail: "space.scale must be numbers in rising order" });
  else if (base > 0) { const q = base / 4; const allow = new Set(rule("spacing-on-grid")?.params?.allow ?? []); const off = scale.filter((v) => !allow.has(v) && Math.abs(v / q - Math.round(v / q)) > 1e-9); if (off.length) add("spacing-on-grid", `space.scale steps ${off.join(", ")} are not multiples of ${q} (a quarter of the base ${base})`); }
  const radii = Object.entries(t.radius ?? {});
  for (const [k, v] of radii) if (!(Number(v) >= 0)) findings.push({ rule: "tokens", severity: "error", detail: `radius.${k} is not a number` });
  const rf = rule("radius-family");
  if (rf && radii.length > (rf.params.max ?? 10)) add("radius-family", `${radii.length} radius steps; the rule says at most ${rf.params.max ?? 10}`);
  const tt = rule("touch-target-min");
  if (tt && (t.input ?? []).includes("touch")) {
    if (!(Number(t.target?.min) > 0)) findings.push({ rule: "tokens", severity: "error", detail: "target.min is not chosen, and this system is used by touch" });
    else if (t.target.min < tt.params.floor) add("touch-target-min", `target.min is ${t.target.min} ${t.unit}, below ${tt.params.floor}`);
  }
  if (rule("reduced-motion") && !one(t.motion?.reduced)) add("reduced-motion", "motion.reduced does not say what a person who asked for reduced motion gets");

  // components
  const names = tokenNames(t);
  const components = [];
  for (const file of componentFiles(dataDir)) {
    const text = readFileSync(join(dsDir(dataDir), "components", file), "utf8");
    const name = file.replace(/\.md$/, "");
    const problems = [];
    for (const [part] of COMPONENT_PARTS) {
      const m = text.match(new RegExp(`^## ${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?\\n`, "m"));
      if (!m) { problems.push(`no "${part}" part`); continue; }
      const rest = text.slice(m.index + m[0].length);
      const end = rest.search(/^## /m);
      const bodyText = end === -1 ? rest : rest.slice(0, end);
      if (FILL.test(bodyText) || !bodyText.trim()) problems.push(`"${part}" is to fill`);
      else if (part === "Tokens") {
        const refs = [...bodyText.matchAll(/`((?:color|type|space|radius|elevation|motion|size)\.[A-Za-z0-9_.-]+)`/g)].map((x) => x[1]);
        if (!refs.length) problems.push("names no token");
        const unknown = [...new Set(refs.filter((x) => !names.has(x)))];
        if (unknown.length) add("component-tokens", `component ${name} names ${unknown.map((u) => `\`${u}\``).join(", ")}, which tokens.json does not have`);
      }
    }
    components.push({ name, state: problems.length ? "to fill" : "filled" });
    if (problems.length) findings.push({ rule: "components", severity: "error", detail: `component ${name}: ${problems.join("; ")}` });
  }
  for (const detail of prototypeProblems(readPrototype(dataDir))) findings.push({ rule: "prototype", severity: "error", detail });
  if (!components.length) findings.push({ rule: "components", severity: "error", detail: "no component page yet: `shipyard-data design-system component add <name>` for each component the first screens need" });
  return { findings, sections, components };
}

/* ---------- what `ui verify` adds for a signed system (a browser is the renderer) ---------- */

/** Rules for the in-page lint, with their numbers taken from the tokens. Empty unless a system is signed and unchanged. */
export function screenRules(dataDir) {
  if (stateOf(dataDir) !== "approved") return [];
  const t = readTokens(dataDir);
  if (!t) return [];
  const colours = [...new Set(Object.values(t.color?.themes ?? {}).flatMap((r) => Object.values(r ?? {})).map((h) => hexRgb(h)).filter(Boolean).map((c) => c.join(",")))];
  const sizes = [...new Set(Object.values(t.type?.roles ?? {}).map((r) => Number(r.size)).filter((v) => v > 0))];
  const fromTokens = {
    "touch-target-size": { min: t.target?.min }, "touch-target-gap": { min: t.target?.min, gap: t.target?.gap },
    "token-colors": { colours }, "spacing-scale": { scale: t.space?.scale ?? [] }, "radius-family": { radii: Object.values(t.radius ?? {}).map(Number) }, "type-scale": { sizes },
  };
  return readRules(dataDir).filter((r) => r.check === "screen" && r.page_check).map((r) => ({ id: r.id, status: r.status === "verified" ? "verified" : "draft", check: r.page_check, params: { ...(fromTokens[r.page_check] ?? {}), ...(r.params ?? {}) }, source: `design system: ${r.source ?? ""}` }));
}

/* ---------- output ---------- */

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const HOW = { tokens: "on the values", screen: "on a rendered screen", source: "in the code", project: "by the project's own check", eye: "by eye, at the review" };

function rulesTable(rules) {
  const out = ["| Rule | Checked | Fails a screen? | From |", "|---|---|---|---|"];
  for (const r of rules) out.push(`| ${r.rule} | ${HOW[r.check] ?? r.check}${r.check === "project" && r.command ? ` (\`${r.command}\`)` : ""} | ${r.check === "eye" ? "no, a checklist" : r.status === "verified" ? "yes" : "warns"} | ${r.source ?? ""} |`);
  return out.join("\n");
}

export function showText(dataDir) {
  const s = readSystem(dataDir), t = readTokens(dataDir), st = stateOf(dataDir);
  if (st === "undecided") return "DESIGN SYSTEM: not set. The owner has not been asked.\n";
  if (st === "none") return `DESIGN SYSTEM: none (the owner: "${s.answer}").\n`;
  if (st === "adopted") return `DESIGN SYSTEM: the project's own, at ${s.paths.join(", ")} (the owner: "${s.answer}"). Read it and design within it.\n`;
  const out = [`DESIGN SYSTEM: ${s.name || "unnamed"} · ${s.platform} · ${st === "approved" ? `v${s.version}, signed` : st === "draft" ? "draft, not signed" : `v${s.version}, CHANGED since it was signed`} · values in ${t?.unit ?? "?"}`, `Folder: ${dsDir(dataDir)}`, ""];
  if (s.artifact) out.push(`To look at: ${s.artifact}`, "");
  if (t) {
    for (const [theme, roles] of Object.entries(t.color?.themes ?? {})) out.push(`COLOUR (${theme}): ${Object.entries(roles).map(([k, v]) => `${k} ${v || "?"}`).join(" · ")}`);
    out.push(`TYPE: ${Object.entries(t.type?.roles ?? {}).map(([k, r]) => `${k} ${r.size ?? "?"}/${r.line ?? "?"} w${r.weight ?? "?"}`).join(" · ")}; smallest allowed ${t.type?.min_size ?? "?"}`);
    out.push(`SPACE: base ${t.space?.base ?? "?"}; scale ${(t.space?.scale ?? []).join(", ") || "?"}`);
    out.push(`RADIUS: ${Object.entries(t.radius ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
    if (Object.keys(t.sizes ?? {}).length) out.push(`SIZES: ${Object.entries(t.sizes).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    if (t.target) out.push(`TOUCH: target ${t.target.min} ${t.unit}, ${t.target.gap} apart`);
    if (one(t.motion?.reduced)) out.push(`MOTION: ${Object.entries(t.motion.durations ?? {}).map(([k, v]) => `${k} ${v} ms`).join(" · ")}; reduced: ${one(t.motion.reduced)}`);
  }
  const comps = componentFiles(dataDir).map((n) => n.replace(/\.md$/, ""));
  out.push("", `COMPONENTS (${comps.length}): ${comps.join(", ") || "none yet"}. A page each under components/. Use these; a new one is added with \`design-system component add\` and signed by the owner.`, "", "RULES", rulesTable(readRules(dataDir)), "");
  return out.join("\n");
}

const kebab = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
const snake = (s) => kebab(s).replace(/-/g, "_");
export function exportTokens(t, format, theme) {
  const themes = t.color?.themes ?? {};
  const themeName = theme ?? Object.keys(themes)[0];
  if (theme && !(theme in themes)) throw Object.assign(new Error(`no theme "${theme}" (${Object.keys(themes).join(", ")})`), { exitCode: 2 });
  const colours = Object.entries(themes[themeName] ?? {});
  const types = Object.entries(t.type?.roles ?? {});
  const spaces = t.space?.scale ?? [];
  const radii = Object.entries(t.radius ?? {});
  if (format === "json") return JSON.stringify(t, null, 2) + "\n";
  if (format === "css") {
    const block = (roles) => Object.entries(roles).map(([k, v]) => `  --color-${kebab(k)}: ${v};`).join("\n");
    const out = [":root {", block(themes[themeName] ?? {})];
    for (const [k, r] of types) out.push(`  --type-${kebab(k)}-size: ${r.size}px;`, `  --type-${kebab(k)}-line: ${r.line}px;`, `  --type-${kebab(k)}-weight: ${r.weight ?? 400};`);
    for (const [k, v] of Object.entries(t.type?.families ?? {})) out.push(`  --font-${kebab(k)}: ${v};`);
    for (const v of spaces) out.push(`  --space-${v}: ${v}px;`);
    for (const [k, v] of radii) out.push(`  --radius-${kebab(k)}: ${v}px;`);
    for (const [k, v] of Object.entries(t.motion?.durations ?? {})) out.push(`  --motion-${kebab(k)}: ${v}ms;`);
    if (t.target) out.push(`  --target-min: ${t.target.min}px;`, `  --target-gap: ${t.target.gap}px;`);
    out.push("}");
    if (!theme) for (const [name, roles] of Object.entries(themes).slice(1)) out.push(`[data-theme="${name}"] {`, block(roles), "}");
    return out.join("\n") + "\n";
  }
  if (format === "android") {
    const out = ["<!-- res/values/design_tokens.xml -->", "<resources>"];
    for (const [k, v] of colours) { const c = hexRgb(v); out.push(`    <color name="${snake(k)}">#${c ? c.map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase() : ""}</color>`); }
    for (const [k, r] of types) out.push(`    <dimen name="type_${snake(k)}_size">${r.size}sp</dimen>`, `    <dimen name="type_${snake(k)}_line">${r.line}sp</dimen>`);
    for (const v of spaces) out.push(`    <dimen name="space_${String(v).replace(".", "_")}">${v}dp</dimen>`);
    for (const [k, v] of radii) out.push(`    <dimen name="radius_${snake(k)}">${v}dp</dimen>`);
    if (t.target) out.push(`    <dimen name="target_min">${t.target.min}dp</dimen>`, `    <dimen name="target_gap">${t.target.gap}dp</dimen>`);
    out.push("</resources>");
    return out.join("\n") + "\n";
  }
  if (format === "c") {
    const up = (s) => snake(s).toUpperCase();
    const out = ["/* Design tokens. Made by `shipyard-data design-system tokens --format c`; change the design system, not this file. */", "#ifndef DESIGN_TOKENS_H", "#define DESIGN_TOKENS_H", ""];
    for (const [k, v] of colours) { const c = hexRgb(v); out.push(`#define COLOR_${up(k)} 0x${c ? c.map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase() : "000000"}FFu /* RGBA */`); }
    for (const [k, r] of types) out.push(`#define TYPE_${up(k)}_SIZE ${r.size}`, `#define TYPE_${up(k)}_LINE ${r.line}`);
    for (const v of spaces) out.push(`#define SPACE_${String(v).replace(".", "_")} ${v}`);
    for (const [k, v] of radii) out.push(`#define RADIUS_${up(k)} ${v}`);
    for (const [k, v] of Object.entries(t.motion?.durations ?? {})) out.push(`#define MOTION_${up(k)}_MS ${v}`);
    out.push("", "#endif", "");
    return out.join("\n");
  }
  throw Object.assign(new Error(`format "${format}" is not json|css|android|c`), { exitCode: 2 });
}

function mdToHtml(md) {
  const out = [];
  let list = false, code = false, table = false;
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const close = () => { if (list) { out.push("</ul>"); list = false; } if (table) { out.push("</table>"); table = false; } };
  for (const line of md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").split(/\r?\n/)) {
    if (line.startsWith("```")) { close(); out.push(code ? "</pre>" : "<pre>"); code = !code; continue; }
    if (code) { out.push(esc(line)); continue; }
    const h = line.match(/^(#{1,4}) (.*)$/);
    if (h) { close(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    if (/^\s*[-*] /.test(line)) { if (!list) { close(); out.push("<ul>"); list = true; } out.push(`<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`); continue; }
    if (/^\|.*\|\s*$/.test(line)) { if (/^\|[\s:|-]+\|\s*$/.test(line)) continue; if (!table) { close(); out.push("<table>"); table = true; } out.push(`<tr>${line.trim().slice(1, -1).split("|").map((c) => `<td>${inline(c.trim())}</td>`).join("")}</tr>`); continue; }
    close();
    if (line.trim() && !/^<!--/.test(line.trim())) out.push(`<p>${inline(line)}</p>`);
  }
  close();
  return out.join("\n");
}

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "assets");
/** A section's words as frames for the book: the text before the first `###`, then one frame per `###`. */
function sectionFrames(body) {
  const parts = body.split(/^### /m);
  const frames = [];
  if (parts[0].trim()) frames.push({ title: "", html: mdToHtml(parts[0]) });
  for (const p of parts.slice(1)) { const nl = p.indexOf("\n"); frames.push({ title: one(nl === -1 ? p : p.slice(0, nl)), html: mdToHtml(nl === -1 ? "" : p.slice(nl + 1)) }); }
  return frames.length ? frames : [{ title: "", html: "<p>Not written yet.</p>" }];
}
/** Everything the book shows, as data. Pure reading; the page draws it. */
export function bookData(dataDir) {
  const s = readSystem(dataDir), t = readTokens(dataDir) ?? {}, st = stateOf(dataDir);
  const doc = readIf(join(dsDir(dataDir), "DESIGN-SYSTEM.md")) ?? "";
  const heads = [...doc.matchAll(/^## (\d+)\. [^\r\n]*\r?\n/gm)];
  const sections = SECTIONS.map(([key, title], i) => {
    const h = heads.find((m) => Number(m[1]) === i + 1);
    const body = h ? doc.slice(h.index + h[0].length, heads[heads.indexOf(h) + 1]?.index ?? doc.length) : "";
    return { n: i + 1, key, title, frames: sectionFrames(body) };
  });
  const origin = doc.match(/^## Where it comes from[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  const rules = readRules(dataDir);
  const min = (kind) => rules.find((r) => r.id === (kind === "ui" ? "contrast-ui" : "contrast-text"))?.params?.min ?? (kind === "ui" ? 3 : 4.5);
  const components = componentFiles(dataDir).map((f) => {
    const text = readFileSync(join(dsDir(dataDir), "components", f), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    const parts = text.split(/^## /m).slice(1).map((p) => { const nl = p.indexOf("\n"); return { title: one(nl === -1 ? p : p.slice(0, nl)), html: mdToHtml(nl === -1 ? "" : p.slice(nl + 1)) }; });
    return { name: f.replace(/\.md$/, ""), parts };
  });
  return {
    meta: { name: s.name || "Design system", platform: s.platform, state: st, version: s.version, signed: s.approved_at.slice(0, 10), artifact: s.artifact },
    origin: origin ? mdToHtml(origin[1]) : "", sections, tokens: t, components, prototype: readPrototype(dataDir) ?? { screens: {} },
    pairs: colourPairs(t).map((p) => ({ ...p, min: min(p.kind) })),
    rules: rules.map((r) => ({ rule: r.rule, check: r.check, status: r.status, source: r.source ?? "", command: r.command ?? "" })),
    limits: { floor: rules.find((r) => r.id === "touch-target-min")?.params?.floor ?? null },
  };
}

/** The book: one file a person opens from disk. A page per section, each an open canvas, and a page to try the system live. */
export function renderHtml(dataDir) {
  const data = bookData(dataDir);
  const css = readFileSync(join(ASSETS, "design-system-book.css"), "utf8");
  const js = readFileSync(join(ASSETS, "design-system-book.js"), "utf8");
  // inside a <script> only "</" and "<!--" can end or confuse the block: write "<" as its escape
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(data.meta.name)}</title>
<style>
${css}</style></head>
<body>
<nav id="nav" aria-label="Pages"><header><h1></h1><div class="meta"></div></header><ul id="pages"></ul><footer>[ and ] turn the page · 0 fits it</footer></nav>
<main id="stage" aria-label="Canvas">
  <button id="menu" data-act="menu" aria-label="Pages">☰</button>
  <div id="world"></div>
  <div id="hint">Drag to move · Ctrl + scroll or pinch to zoom</div>
  <div id="tools" role="toolbar" aria-label="Canvas tools"><button data-act="out" aria-label="Zoom out">−</button><button data-act="fit" id="zoom" aria-label="Fit the page">100%</button><button data-act="in" aria-label="Zoom in">+</button><button data-act="tidy">Tidy</button></div>
</main>
<script type="application/json" id="ds-data">${json}</script>
<script>
${js}</script>
</body></html>
`;
}

const RAW_COLOUR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b|\b0x(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g;
const TOKEN_FILE = /token|theme|colou?r|palette/i;
/** Colours typed in added lines of a diff that are not one of the system's. Pure: takes the diff text. */
export function rawColours(diffText, t) {
  const known = new Set(Object.values(t?.color?.themes ?? {}).flatMap((r) => Object.values(r ?? {})).map((h) => hexRgb(h)).filter(Boolean).map((c) => c.map((x) => x.toString(16).padStart(2, "0")).join("")));
  const found = [];
  let file = "";
  for (const line of String(diffText).split(/\r?\n/)) {
    if (line.startsWith("+++ ")) { file = line.slice(4).replace(/^b\//, ""); continue; }
    if (!line.startsWith("+") || line.startsWith("+++") || TOKEN_FILE.test(file) || /\.(md|svg|png|json|lock)$/i.test(file)) continue;
    for (const m of line.matchAll(RAW_COLOUR)) {
      if (!isColour(m[0], line, file)) continue;
      const digits = m[0].replace(/^#|^0x/i, "").toLowerCase();
      // 8 digits: the alpha pair leads (0xAARRGGBB, Android) or trails (#RRGGBBAA, CSS); accept either reading
      const reads = digits.length === 8 ? [digits.slice(2), digits.slice(0, 6)] : [digits];
      if (!reads.some((d) => known.has(d))) found.push({ file, colour: m[0], line: line.slice(1).trim().slice(0, 120) });
    }
  }
  return found;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", "out", "target", ".gradle", ".idea", "vendor", "Pods", ".next", ".venv", "venv", "__pycache__", "DerivedData", ".shipyard"]);
const VALUE_FILE = /^(?:tailwind\.config\.[cm]?[jt]s|theme\.[a-z]+|themes?\.xml|colors?\.xml|dimens\.xml|styles\.xml|type\.xml|(?:design[-_.]?)?tokens?\.[a-z]+|variables\.s?css|_variables\.scss|palette\.[a-z]+|Color\.kt|Theme\.kt|Type\.kt|Shape\.kt|Colors?\.swift|Theme\.swift|Typography\.[a-z]+)$/i;
const COMPONENT_DIR = /^(?:components?|widgets?|ui|design[-_]?system|designsystem)$/i;
/** What the project already has that a design system would be made of. Facts for the choice between adopt, build on, and new. */
export function detectExisting(root, { maxEntries = 20000, maxDepth = 6 } = {}) {
  const values = [], components = [];
  let seen = 0;
  const walk = (dir, depth, rel) => {
    if (depth > maxDepth || seen > maxEntries) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > maxEntries) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        if (COMPONENT_DIR.test(e.name)) { let n = 0; try { n = readdirSync(join(dir, e.name)).length; } catch { /* unreadable */ } if (n) components.push({ path: r, entries: n }); }
        walk(join(dir, e.name), depth + 1, r);
      } else if (e.isFile() && VALUE_FILE.test(e.name)) values.push(r);
    }
  };
  walk(root, 0, "");
  return { values: values.slice(0, 40), components: components.slice(0, 20), complete: seen <= maxEntries };
}

const SOURCE_EXT = /\.(?:css|scss|sass|less|html|vue|svelte|jsx?|tsx?|mjs|kt|kts|java|xml|swift|dart|c|h|cc|cpp|hpp|m|mm|cs|py|rb|go|rs|lua|gd|qml)$/i;
const STYLE_EXT = /\.(?:css|scss|sass|less|html|vue|svelte|jsx|tsx)$/i;
const COLOUR_ANY = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b|\b0x(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/g;
const MEASURE = /(\d+(?:\.\d+)?)\s*\.?(px|rem|em|dp|sp|pt)\b/g;
const BARE = /(?:^|[^\w.#])(\d{1,3}(?:\.\d+)?)(?![\w.%])/g;
const KIND = [["type", /font|text[-_]?size|fontsize|\.sp\b|\bsp\b|letter|line[-_]?height|lineheight/i], ["radius", /radius|corner|rounded/i], ["space", /padding|margin|gap|spacing|inset|spacer|offset/i]];
const FAMILY = /font-family\s*:\s*([^;}{]+)|fontFamily\s*[=:]\s*["']?([^"',;)]+)|["']([^"'/]+\.(?:ttf|otf|woff2?))["']/g;

const COLOUR_WORD = /colou?r|rgb|tint|fill|stroke|palette|\bbg\b|\bfg\b|background|foreground/i;
const isColour = (raw, line, file) => (raw.startsWith("#") ? raw.length !== 4 || STYLE_EXT.test(file) : !/^0x/i.test(raw) || COLOUR_WORD.test(line));
function normColour(raw) {
  const m = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (m) return [m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)).toString(16).padStart(2, "0")).join("");
  let d = raw.replace(/^#|^0x/i, "").toLowerCase();
  if (d.length === 3) d = d.split("").map((c) => c + c).join("");
  // eight digits: 0xAARRGGBB (the alpha pair leads) or #RRGGBBAA (it trails)
  // (a fully opaque one says which: ff leads or ff trails)
  if (d.length === 8) d = /^0x/i.test(raw) && !(d.endsWith("ff") && !d.startsWith("ff")) ? d.slice(2) : d.slice(0, 6);
  return d;
}
const colourGap = (a, b) => Math.max(...[0, 2, 4].map((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16))));

/**
 * What the code already uses: every colour, text size, spacing value, corner radius and font typed in the
 * source, with how often and where. Counting is the CLI's; which values survive as tokens is the design
 * decision the owner signs. A number is filed by a word on its own line (font, padding, radius), so a line
 * with no such word is not counted: this under-reports, it does not invent.
 */
export function extractFromSource(root, { maxFiles = 6000, maxBytes = 400000 } = {}) {
  const bins = { colour: new Map(), type: new Map(), space: new Map(), radius: new Map(), family: new Map() };
  const hit = (kind, key, file) => { const m = bins[kind]; const e = m.get(key) ?? { value: key, count: 0, files: new Set() }; e.count++; e.files.add(file); m.set(key, e); };
  let files = 0, skipped = 0;
  const walk = (dir, depth, rel) => {
    if (depth > 10 || files >= maxFiles) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), depth + 1, r); continue; }
      if (!e.isFile() || !SOURCE_EXT.test(e.name) || /\.min\.|\.lock$|test|spec|fixture/i.test(r)) continue;
      if (files >= maxFiles) { skipped++; continue; }
      let text;
      try { text = readFileSync(join(dir, e.name), "utf8"); } catch { continue; }
      if (text.length > maxBytes) { skipped++; continue; }
      files++;
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 600) continue;
        // three digits is also how an issue is written (#123): only where a stylesheet is the language
        // and 0x… is how a mask or an address is written: a colour only on a line that says colour
        for (const m of line.matchAll(COLOUR_ANY)) if (isColour(m[0], line, e.name)) hit("colour", normColour(m[0]), r);
        for (const m of line.matchAll(FAMILY)) { const f = one(m[1] ?? m[2] ?? m[3]).replace(/["']/g, "").slice(0, 80); if (f && !/^(?:inherit|var\()/.test(f)) hit("family", f, r); }
        const kind = KIND.find(([, re]) => re.test(line))?.[0];
        if (!kind) continue;
        const withUnit = [...line.matchAll(MEASURE)];
        // several declarations on one line: each number belongs to the word nearest before it
        if (withUnit.length) for (const m of withUnit) { const seg = line.slice(Math.max(line.lastIndexOf(";", m.index), line.lastIndexOf("{", m.index)) + 1, m.index); hit(KIND.find(([, re]) => re.test(seg))?.[0] ?? kind, `${Number(m[1])}${m[2]}`, r); }
        else for (const m of line.matchAll(BARE)) { const v = Number(m[1]); if (v > 0 && v <= 200 && (v * 2) % 1 === 0) hit(kind, `${v} (no unit)`, r); }
      }
    }
  };
  walk(root, 0, "");
  const list = (m) => [...m.values()].sort((a, b) => b.count - a.count).map((e) => ({ value: e.value, count: e.count, files: e.files.size, in: [...e.files].slice(0, 3) }));
  const colours = list(bins.colour).map((c) => ({ ...c, value: `#${c.value.toUpperCase()}` }));
  // colours a hair apart are almost always one colour typed twice: the first thing to merge
  const near = [];
  for (let i = 0; i < Math.min(colours.length, 120); i++) for (let j = i + 1; j < Math.min(colours.length, 120); j++) {
    const g = colourGap(colours[i].value.slice(1), colours[j].value.slice(1));
    if (g > 0 && g <= 6) near.push({ keep: colours[i].value, merge: colours[j].value, keep_count: colours[i].count, merge_count: colours[j].count });
  }
  return { root, files, skipped, colours, near, type: list(bins.type), space: list(bins.space), radius: list(bins.radius), families: list(bins.family) };
}

/* ---------- command ---------- */

function usage(msg) {
  process.stderr.write(
    `shipyard-data design-system: ${msg}\n` +
      "  Usage: design-system status [--json]\n" +
      "         design-system detect [--root <project folder>] [--json]      what the project already has\n" +
      "         design-system extract [--root <project folder>] [--json]     the colours, sizes, spacing, radii and fonts typed in the code, counted\n" +
      `         design-system init --platform ${Object.keys(PLATFORMS).join("|")} [--name \"<name>\"] [--components a,b,c | --starter]\n` +
      "                            [--basis <existing file or folder> …] [--inspiration \"<link, file or name>\" …]\n" +
      "         design-system component add <name>\n" +
      "         design-system check [--json]\n" +
      "         design-system show | rules [--json] | render\n" +
      "         design-system covers <component or value …> [--story S###]   does the system have what this screen needs\n" +
      "         design-system changes [--json]                               what changed since the owner signed it\n" +
      "         design-system tokens --format json|css|android|c [--theme <name>]\n" +
      "         design-system scan [--base <ref>] [--head <ref>] [--root <project folder>] [--json]\n" +
      "         design-system export --to <folder in the project> [--format json|css|android|c] [--root <project folder>]\n" +
      "         design-system approve --answer \"<the owner's words>\" [--artifact <link>] [--story S###]\n" +
      "         design-system adopt --path <file or folder in the project> [--path …] --answer \"<the owner's words>\"\n" +
      "         design-system none --answer \"<the owner's words>\"\n",
  );
  process.exit(2);
}
const BOOL = new Set(["json", "starter"]);
function flags(args) {
  const o = { _: [], path: [], basis: [], inspiration: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) { o[k] = true; continue; }
    const v = args[++i];
    if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`);
    if (Array.isArray(o[k])) o[k].push(v); else o[k] = v;
  }
  return o;
}
const fail = (msg) => { process.stderr.write(`shipyard-data design-system: ${msg}\n`); process.exit(3); };
const answerOf = (o, verb) => { const a = one(o.answer); if (!a) fail(`${verb} records the owner's decision: ${verb} --answer "<their words>"`); return a; };

export async function main(dataDir, args = []) {
  const sub = args[0];
  const o = flags(args.slice(1));
  const dir = dsDir(dataDir);
  const st = stateOf(dataDir);
  const s = readSystem(dataDir);

  if (sub === "status") {
    const c = ["draft", "approved", "changed"].includes(st) ? checkSystem(dataDir) : null;
    if (o.json) { process.stdout.write(JSON.stringify({ state: st, ...s, sections: c?.sections ?? [], components: c?.components ?? [], errors: c?.findings.filter((f) => f.severity === "error").length ?? 0 }) + "\n"); return; }
    process.stdout.write(`DESIGN SYSTEM: ${contextLine(dataDir)}\n`);
    if (c) {
      process.stdout.write("\n| # | Section | State |\n|---|---|---|\n" + c.sections.map((x) => `| ${x.n} | ${x.title} | ${x.state} |`).join("\n") + "\n");
      process.stdout.write(`\nComponents: ${c.components.map((x) => `${x.name} (${x.state})`).join(", ") || "none yet"}\n`);
    } else if (st === "undecided") process.stdout.write(`${designSystemOwed(dataDir)}\n`);
    return;
  }

  if (sub === "detect") {
    let root = o.root;
    if (!root) { try { root = (await import("./shipyard-resolver.mjs")).getProjectRoot(); } catch { root = process.cwd(); } }
    const d = detectExisting(root);
    if (o.json) { process.stdout.write(JSON.stringify({ root, ...d }) + "\n"); return; }
    if (!d.values.length && !d.components.length) { process.stdout.write(`design system detect: nothing found in ${root} that looks like a theme, token or component folder.\n  the project has screens already   design-system extract   (the values typed in the code, counted)\n  it has none                       design-system init --platform …\n`); return; }
    process.stdout.write(`design system detect: found in ${root}\n`);
    for (const v of d.values) process.stdout.write(`  values      ${v}\n`);
    for (const c of d.components) process.stdout.write(`  components  ${c.path}/ (${c.entries} entries)\n`);
    process.stdout.write("Read them, then one of:\n  it is a whole system      design-system adopt --path <each> --answer \"<the owner's words>\"\n  it is a start             design-system init --platform … --basis <each>   (their values become the tokens, the gaps are filled)\n  it is not to be kept      design-system init --platform …\n");
    return;
  }

  if (sub === "extract") {
    let root = o.root;
    if (!root) { try { root = (await import("./shipyard-resolver.mjs")).getProjectRoot(); } catch { root = process.cwd(); } }
    const x = extractFromSource(root);
    mkdirSync(dir, { recursive: true });
    const out = join(dir, "extracted.json");
    atomicWrite(out, JSON.stringify({ at: new Date().toISOString(), ...x }, null, 2) + "\n");
    try { logEvent(dataDir, "design_system_extracted", { files: x.files, colours: x.colours.length, type: x.type.length, space: x.space.length, radius: x.radius.length }); } catch { /* best-effort */ }
    if (o.json) { process.stdout.write(JSON.stringify(x) + "\n"); return; }
    const top = (rows, n = 12) => rows.slice(0, n).map((r) => `${r.value} ×${r.count}`).join("   ") || "none found";
    const strays = (rows) => rows.filter((r) => r.count <= 2).length;
    process.stdout.write(`design system extract: ${x.files} source file(s) read in ${root}${x.skipped ? `, ${x.skipped} skipped (too large or past the limit)` : ""}\n\n`);
    process.stdout.write(`| What | Different values | Used once or twice | Most used |\n|---|---|---|---|\n`);
    for (const [label, rows] of [["Colours", x.colours], ["Text sizes", x.type], ["Spacing", x.space], ["Corner radii", x.radius], ["Fonts", x.families]]) process.stdout.write(`| ${label} | ${rows.length} | ${strays(rows)} | ${top(rows, 6)} |\n`);
    if (x.near.length) { process.stdout.write(`\nColours a hair apart (almost always one colour typed twice):\n`); for (const n of x.near.slice(0, 15)) process.stdout.write(`  ${n.merge} ×${n.merge_count}  →  ${n.keep} ×${n.keep_count}\n`); }
    const tk = readTokens(dataDir);
    if (tk && ["approved", "changed", "draft"].includes(st)) {
      const sys = new Set(Object.values(tk.color?.themes ?? {}).flatMap((r) => Object.values(r ?? {})).map((h) => String(h).toUpperCase().slice(0, 7)));
      const inCode = new Set(x.colours.map((c) => c.value));
      const notIn = x.colours.filter((c) => !sys.has(c.value) && c.count >= 3);
      const unused = [...sys].filter((h) => hexRgb(h) && !inCode.has(h));
      process.stdout.write(`\nAgainst the design system:\n  in the code 3 times or more, not in the system: ${notIn.slice(0, 12).map((c) => `${c.value} ×${c.count}`).join("   ") || "none"}\n  in the system, not found in the code: ${unused.slice(0, 12).join("   ") || "none"}\n`);
    }
    process.stdout.write(`\nEvery value with its files: ${out}\nA number is counted only on a line that says what it is (font, padding, radius), so this is a floor, not a full count.\nNext: \`design-system init --platform … --basis extracted.json\`, make the most used values the tokens, list for the owner what is merged into what, and sign. Replacing the typed values in the code is a story of its own.\n`);
    return;
  }

  if (sub === "init") {
    const platform = one(o.platform).toLowerCase();
    if (!PLATFORMS[platform]) usage(`init needs --platform ${Object.keys(PLATFORMS).join("|")}`);
    if (st !== "undecided") fail(`a design system decision is already on record (${st}). A defined system is changed by editing its files and approving again`);
    const name = one(o.name) || "Design system";
    const comps = o.components !== undefined ? String(o.components).split(",").map(slug).filter(Boolean) : o.starter ? PLATFORMS[platform].starter : [];
    mkdirSync(join(dir, "components"), { recursive: true });
    atomicWrite(join(dir, "tokens.json"), JSON.stringify(starterTokens(platform), null, 2) + "\n");
    atomicWrite(join(dir, "rules.json"), JSON.stringify(defaultRules(platform), null, 2) + "\n");
    atomicWrite(join(dir, "DESIGN-SYSTEM.md"), systemDoc(name, platform, o.basis.map(one), o.inspiration.map(one)));
    atomicWrite(join(dir, "prototype.json"), JSON.stringify(starterPrototype(platform, name), null, 2) + "\n");
    for (const c of comps) atomicWrite(join(dir, "components", `${c}.md`), componentDoc(c));
    writeSystem(dataDir, { mode: "defined", platform, name, version: 0, hash: "", approved_at: "", answer: "", artifact: "", paths: [] });
    try { logEvent(dataDir, "design_system_started", { platform, components: comps.length, basis: o.basis.join(", "), inspiration: o.inspiration.join(", ") }); } catch { /* best-effort */ }
    process.stdout.write(`design system started for ${platform} at ${dir}\n  tokens.json          the values, in ${PLATFORMS[platform].unit}: choose them\n  rules.json           ${defaultRules(platform).length} rules with their sources\n  DESIGN-SYSTEM.md     ${SECTIONS.length} sections to fill\n  prototype.json       the screens of the interactive page: the starter, to be replaced by this project's own\n  components/          ${comps.length ? comps.join(", ") : "none yet: `design-system component add <name>`"}\n${o.basis.length ? `Built on: ${o.basis.join(", ")}. Read them and carry their values into tokens.json before choosing anything new.\n` : ""}${o.inspiration.length ? `Inspiration (look and feel only, no component copied): ${o.inspiration.join(", ")}\n` : ""}Next: fill it, \`shipyard-data design-system check\`, show the owner, then \`design-system approve --answer\`.\n`);
    return;
  }

  if (sub === "component") {
    if (o._[0] !== "add" || !slug(o._[1])) usage("component add <name>");
    if (s.mode !== "defined") fail("there is no defined design system to add a component to: `design-system init --platform …` first");
    const f = join(dir, "components", `${slug(o._[1])}.md`);
    if (existsSync(f)) fail(`component ${slug(o._[1])} already has a page: ${f}`);
    mkdirSync(join(dir, "components"), { recursive: true });
    atomicWrite(f, componentDoc(slug(o._[1])));
    process.stdout.write(`component ${slug(o._[1])}: ${f} (eight parts to fill${s.version ? "; the system then needs the owner's sign-off again" : ""})\n`);
    return;
  }

  if (sub === "none" || sub === "adopt") {
    const answer = answerOf(o, sub);
    if (s.mode === "defined" && s.version) fail(`a design system v${s.version} is signed. Dropping it is the owner's decision and is not done by this verb`);
    if (sub === "adopt" && !o.path.length) usage("adopt needs --path <the project's own theme, token or component file or folder>");
    writeSystem(dataDir, { mode: sub === "none" ? "none" : "adopted", platform: s.platform || "", name: "", version: 0, hash: "", approved_at: new Date().toISOString(), answer, artifact: "", paths: sub === "adopt" ? o.path.map(one) : [] });
    try { logEvent(dataDir, sub === "none" ? "design_system_none" : "design_system_adopted", { answer, paths: o.path.join(", ") }); } catch { /* best-effort */ }
    process.stdout.write(sub === "none" ? "design system: none, on the owner's word. A screen is designed on its own; nothing more is asked.\n" : `design system: the project's own (${o.path.join(", ")}). Screens are designed within it.\n`);
    return;
  }

  if (!["draft", "approved", "changed"].includes(st)) fail(st === "undecided" ? designSystemOwed(dataDir) : `this project's design system is "${st}"; there are no values to ${sub ?? "read"}`);

  if (sub === "check") {
    const c = checkSystem(dataDir);
    const errors = c.findings.filter((f) => f.severity === "error");
    if (o.json) process.stdout.write(JSON.stringify({ state: st, errors: errors.length, warnings: c.findings.length - errors.length, ...c }) + "\n");
    else {
      process.stdout.write(`design system check: ${errors.length ? "NOT READY" : "READY"}: ${errors.length} to fix, ${c.findings.length - errors.length} warning(s)\n`);
      for (const f of c.findings) process.stdout.write(`  ${f.severity === "error" ? "fix " : "warn"}  ${f.detail}\n`);
      const eye = readRules(dataDir).filter((r) => r.check === "eye").length;
      if (!errors.length) process.stdout.write(`  ${eye} rule(s) are judged by eye at the review and are not counted here.\n`);
    }
    if (errors.length) process.exitCode = 3;
    return;
  }
  if (sub === "show") { process.stdout.write(showText(dataDir)); return; }
  if (sub === "rules") {
    const rules = readRules(dataDir);
    process.stdout.write(o.json ? JSON.stringify(rules) + "\n" : rulesTable(rules) + "\n");
    return;
  }
  if (sub === "tokens") {
    const t = readTokens(dataDir);
    if (!t) fail("tokens.json is missing or is not JSON");
    if (!o.format) usage("tokens needs --format json|css|android|c");
    try { process.stdout.write(exportTokens(t, o.format, o.theme)); } catch (e) { if (e.exitCode === 2) usage(e.message); throw e; }
    return;
  }
  if (sub === "render") {
    const p = join(dir, "index.html");
    atomicWrite(p, renderHtml(dataDir));
    process.stdout.write(`${p}\n`);
    return;
  }
  if (sub === "scan") {
    const t = readTokens(dataDir);
    let root = o.root;
    if (!root) { try { root = (await import("./shipyard-resolver.mjs")).getProjectRoot(); } catch { root = process.cwd(); } }
    const range = o.base ? [`${o.base}...${o.head ?? "HEAD"}`] : ["HEAD"];
    const r = spawnSync("git", ["-C", root, "diff", "--unified=0", "--no-color", ...range], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) fail(`could not read the changes in ${root}: ${one(r.stderr).slice(0, 200)}`);
    const found = rawColours(r.stdout, t);
    if (o.json) process.stdout.write(JSON.stringify({ found }) + "\n");
    else if (!found.length) process.stdout.write("design system scan: no colour typed in the changed code that is not a token\n");
    else { process.stdout.write(`design system scan: ${found.length} colour(s) typed in the changed code that are not tokens (a warning)\n`); for (const f of found.slice(0, 40)) process.stdout.write(`  ${f.file}: ${f.colour}  ${f.line}\n`); }
    return;
  }
  if (sub === "changes") {
    // What a piece of work changed in the system since the owner signed it: the list they are shown before they sign again.
    if (st === "draft") { process.stdout.write("design system: a first draft, nothing was signed yet. Everything in it is new.\n"); return; }
    const list = changesSince(dataDir);
    if (o.json) { process.stdout.write(JSON.stringify({ version: s.version, changes: list }) + "\n"); return; }
    if (list === null) { process.stdout.write(`design system v${s.version} was signed before changes were kept; ${st === "changed" ? "it has changed since, and the difference cannot be listed" : "it is unchanged"}\n`); return; }
    if (!list.length) { process.stdout.write(`design system v${s.version}: unchanged since it was signed\n`); return; }
    process.stdout.write(`design system: ${list.length} change(s) since v${s.version} was signed\n${list.map((l) => `  ${l}`).join("\n")}\nShow the owner this list with the reason for each, then: design-system approve --answer "<their words>" [--story <S###>]\n`);
    return;
  }
  if (sub === "covers") {
    // Does the system have what one screen needs? Asked before designing it, so an old system is brought up to date
    // for this piece of work and no further.
    if (!o._.length) usage("covers needs the components and values the screen uses: covers button date-picker color.warning");
    const rows = covers(dataDir, o._);
    const missing = rows.filter((r) => !r.have);
    try { logEvent(dataDir, "design_system_coverage", { asked: rows.length, missing: missing.map((r) => r.name).join(", "), ...(o.story ? { story: o.story } : {}) }); } catch { /* best-effort */ }
    if (o.json) { process.stdout.write(JSON.stringify({ rows, missing: missing.map((r) => r.name) }) + "\n"); return; }
    process.stdout.write(`| Needed | Kind | In the system |\n|---|---|---|\n${rows.map((r) => `| ${r.name} | ${r.kind} | ${r.have ? "yes" : "NO"} |`).join("\n")}\n`);
    process.stdout.write(missing.length ? `${missing.length} missing. Add only these for this piece of work (a component: \`design-system component add <name>\`; a value: tokens.json), then \`design-system check\`, \`design-system changes\`, and the owner signs the new version. Anything else that looks out of date is captured as an idea, not changed here.\n` : "The system covers this screen. Design within it.\n");
    return;
  }

  if (sub === "export") {
    // The signed system as the project's own files: the document, the component pages and the token file in
    // the code's format. Only a signed, unchanged system is exported, so the repository never holds a draft.
    if (st !== "approved") fail(st === "draft" ? "the design system is not signed yet; only a signed system is exported" : "the design system changed since it was signed; sign it again before exporting");
    if (!o.to) usage("export needs --to <folder in the project>, for example docs/design-system");
    const t = readTokens(dataDir);
    let root = o.root;
    if (!root) { try { root = (await import("./shipyard-resolver.mjs")).getProjectRoot(); } catch { root = process.cwd(); } }
    const dest = isAbsolute(o.to) ? o.to : resolve(root, o.to);
    const rel = relative(resolve(root), dest);
    if (rel.startsWith("..") || isAbsolute(rel)) fail(`${dest} is outside the project (${root})`);
    const format = o.format ?? ({ web: "css", android: "android", game: "c" }[s.platform] ?? "json");
    const ext = { css: "css", android: "xml", c: "h", json: "json" }[format];
    if (!ext) usage(`--format ${format} is not json|css|android|c`);
    mkdirSync(join(dest, "components"), { recursive: true });
    const stamp = `> Version ${s.version}, signed ${s.approved_at.slice(0, 10)}. Exported by \`shipyard-data design-system export\`: change the design system, then export again; do not edit this copy.\n`;
    const doc = (readIf(join(dir, "DESIGN-SYSTEM.md")) ?? "").replace(/^(# [^\n]*\n)/, `$1\n${stamp}`);
    const written = [];
    const put = (name, text) => { atomicWrite(join(dest, name), text); written.push(join(rel || ".", name)); };
    put("DESIGN-SYSTEM.md", `${doc.trimEnd()}\n\n## Values\n\n\`\`\`\n${showText(dataDir).split("\nCOMPONENTS")[0].split("\n").filter((l) => /^(COLOUR|TYPE|SPACE|RADIUS|SIZES|TOUCH|MOTION)/.test(l)).join("\n")}\n\`\`\`\n\n## Rule list\n\n${rulesTable(readRules(dataDir))}\n`);
    for (const f of componentFiles(dataDir)) put(join("components", f), readFileSync(join(dir, "components", f), "utf8"));
    const tokenName = format === "android" ? "design_tokens.xml" : format === "c" ? "design_tokens.h" : `tokens.${ext}`;
    put(tokenName, exportTokens(t, format));
    put("design-system.html", renderHtml(dataDir));
    try { logEvent(dataDir, "design_system_exported", { version: s.version, to: rel, format, files: written.length }); } catch { /* best-effort */ }
    process.stdout.write(`design system v${s.version} exported to ${dest}\n${written.map((w) => `  ${w}`).join("\n")}\nThese are the project's files now: put ${tokenName} where the code reads it, and commit them with the step that asked for this.\n`);
    return;
  }

  if (sub === "approve") {
    const answer = answerOf(o, "approve");
    const c = checkSystem(dataDir);
    const errors = c.findings.filter((f) => f.severity === "error");
    if (errors.length) fail(`not ready to sign: ${errors.length} thing(s) to fix first (\`shipyard-data design-system check\`). The first: ${errors[0].detail}`);
    const hash = recordHash(dataDir);
    if (st === "approved" && hash === s.hash) { process.stdout.write(`design system v${s.version} is already signed and unchanged\n`); return; }
    const version = s.version + 1;
    writeSystem(dataDir, { mode: "defined", platform: s.platform, name: s.name, version, hash, approved_at: new Date().toISOString(), answer, artifact: one(o.artifact) || s.artifact, paths: [] });
    snapshot(dataDir, version);
    atomicWrite(join(dir, "index.html"), renderHtml(dataDir));
    try { logEvent(dataDir, "design_system_approved", { version, hash, answer, components: c.components.length, ...(o.story ? { story: o.story } : {}) }); } catch { /* best-effort */ }
    process.stdout.write(`design system v${version} signed (${hash.slice(0, 12)}): ${c.components.length} component(s), ${readRules(dataDir).length} rule(s). To look at: ${join(dir, "index.html")}\n`);
    return;
  }
  usage(`unknown subcommand "${sub ?? ""}"`);
}
