/**
 * After 4.0.6: a project's design system is a record its owner signed.
 *
 * The owner: a fresh project that gets its first screen has no design system, and he wants the deliverable a
 * designer hands a client (rules and constraints, typography, components and more). "clients may build
 * different apps": one of his projects is a game, another an Android app. A project may already have one,
 * have part of one, have only values typed in its code, or come with an inspiration. The signed system is
 * exported to the project, and can be looked at as a book: a page per section, each an open canvas, and one
 * page where it can be tried live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { withoutUserSettings } from "./lib/no-user-settings.mjs";
import { fillSystem } from "./lib/design-system-fixture.mjs";
import { prototypeProblems, changesSince, covers, PLATFORMS, SECTIONS, COMPONENT_PARTS, contrast, stateOf, designSystemOwed, contextLine, checkSystem, screenRules, exportTokens, readTokens, rawColours, extractFromSource, detectExisting, defaultRules, bookData, dsDir } from "../bin/design-system.mjs";
import { resolvePlaywright } from "../bin/ui-adapters/web.mjs";
import { run as runHook } from "../bin/hooks/auto-approve-data.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ds-"));
  const d = join(base, "projects", "abc123abc123");
  mkdirSync(join(d, "spec", "stories"), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  return { base, d };
}
const run = (d, ...args) => spawnSync("node", [CLI, "design-system", ...args, "--data-dir", d], { encoding: "utf8", env: withoutUserSettings(d) });
const cli = (d, ...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8", env: withoutUserSettings(d) });
const events = (d) => (existsSync(join(d, ".shipyard-events.jsonl")) ? readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const signed = (d, platform = "web", comps = "button,card") => {
  assert.equal(run(d, "init", "--platform", platform, "--name", "Ledger", "--components", comps).status, 0);
  fillSystem(d);
  const r = run(d, "approve", "--answer", "yes, this is it");
  assert.equal(r.status, 0, r.stderr);
};

test("the deliverable: twelve sections, eight parts to a component page, rules that each name where their number comes from", () => {
  assert.deepEqual(SECTIONS.map((s) => s[1]), ["Principles", "Voice and wording", "Colour", "Typography", "Space and layout", "Shape and depth", "Motion", "Icons and imagery", "Components", "Patterns", "Rules and constraints", "Handoff and change"]);
  assert.deepEqual(COMPONENT_PARTS.map((p) => p[0]), ["Purpose", "Anatomy", "Variants", "Sizes", "States", "Behaviour", "Tokens", "Do and don't"]);
  for (const p of Object.keys(PLATFORMS)) {
    const rules = defaultRules(p);
    assert.ok(rules.every((r) => r.source && ["tokens", "screen", "source", "eye"].includes(r.check) && ["verified", "draft"].includes(r.status)), p);
    assert.equal(new Set(rules.map((r) => r.id)).size, rules.length, `${p}: rule ids are unique`);
  }
  // a browser is one platform among several: only it gets rules measured on a rendered screen
  assert.ok(defaultRules("web").some((r) => r.check === "screen") && !defaultRules("android").some((r) => r.check === "screen") && !defaultRules("game").some((r) => r.check === "screen"));
  // a game has no touch target and no body line-height rule; a phone app has its platform's own numbers
  assert.ok(!defaultRules("game").some((r) => r.id === "touch-target-min" || r.id === "body-line-height"));
  assert.equal(defaultRules("android").find((r) => r.id === "touch-target-min").params.floor, 48);
  assert.equal(defaultRules("ios").find((r) => r.id === "touch-target-min").params.floor, 28);
  assert.equal(defaultRules("web").find((r) => r.id === "touch-target-min").params.floor, 24);
});

test("undecided, then a draft that says what is left, then signed with the owner's words; a change after the sign-off is seen", () => {
  const { base, d } = fixture();
  try {
    assert.equal(stateOf(d), "undecided");
    assert.match(contextLine(d), /^not set \(asked once/);
    assert.match(designSystemOwed(d), /no design system on record.*init --platform.*adopt --path.*none --answer/s);
    assert.equal(run(d, "check").status, 3, "nothing to check before a decision");
    assert.equal(run(d, "init", "--platform", "tv").status, 2);

    let r = run(d, "init", "--platform", "android", "--name", "Pocket", "--components", "Button, List Item");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /design system started for android.*the values, in dp.*12 sections to fill.*button, list-item/s);
    assert.equal(stateOf(d), "draft");
    assert.equal(readTokens(d).target.min, 48);
    assert.equal(run(d, "init", "--platform", "web").status, 3, "one decision per project");

    r = run(d, "check");
    assert.equal(r.status, 3);
    assert.match(r.stdout, /NOT READY/);
    assert.match(r.stdout, /section 1 \(Principles\) is to fill/);
    assert.match(r.stdout, /color\.primary in theme light is not chosen/);
    assert.match(r.stdout, /component button: "Purpose" is to fill/);
    r = run(d, "approve", "--answer", "looks good");
    assert.equal(r.status, 3); assert.match(r.stderr, /not ready to sign: \d+ thing\(s\) to fix first/);

    fillSystem(d);
    r = run(d, "check");
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /READY: 0 to fix/);
    assert.match(r.stdout, /rule\(s\) are judged by eye at the review and are not counted here/);
    // the sign-off is the owner's, in their words
    r = run(d, "approve");
    assert.equal(r.status, 3); assert.match(r.stderr, /approve records the owner's decision: approve --answer/);
    assert.equal(stateOf(d), "draft");
    r = run(d, "approve", "--answer", "yes, go with the green", "--artifact", "https://claude.ai/artifact/abc");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /design system v1 signed \([0-9a-f]{12}\): 2 component\(s\)/);
    assert.equal(stateOf(d), "approved");
    assert.equal(designSystemOwed(d), null);
    assert.match(contextLine(d), /Pocket \(android\) v1: `shipyard-data design-system show`/);
    assert.ok(existsSync(join(dsDir(d), "index.html")), "the book is written at the sign-off");
    const ev = events(d).find((e) => e.type === "design_system_approved");
    assert.equal(ev.answer, "yes, go with the green");
    assert.match(run(d, "approve", "--answer", "again").stdout, /already signed and unchanged/);

    // a value changed after the sign-off: seen, and owed again; the new sign-off is version 2
    fillSystem(d, (t) => { t.color.themes.light.primary = "#0B57D0"; });
    assert.equal(stateOf(d), "changed");
    assert.match(designSystemOwed(d), /changed after the owner signed it/);
    assert.match(run(d, "approve", "--answer", "ok, the bluer one").stdout, /design system v2 signed/);
    // a new component page reopens it too
    assert.equal(run(d, "component", "add", "Snackbar").status, 0);
    assert.equal(stateOf(d), "changed");
    assert.equal(run(d, "approve", "--answer", "fine").status, 3, "its eight parts are to fill first");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the values are checked with no renderer: contrast, the grid, the platform's touch floor, the system's own text minimum, tokens a component names", () => {
  const { base, d } = fixture();
  try {
    assert.equal(run(d, "init", "--platform", "android", "--components", "button").status, 0);
    assert.ok(Math.abs(contrast("#FFFFFF", "#000000") - 21) < 0.01);
    assert.ok(Math.abs(contrast("#767676", "#FFFFFF") - 4.54) < 0.01);
    const details = (change) => { fillSystem(d, change); return checkSystem(d).findings; };
    assert.deepEqual(details(), []);
    let f = details((t) => { t.color.themes.light["on-primary"] = "#9DB8F5"; });
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, "error");
    assert.match(f[0].detail, /on-primary on primary \(light\): contrast \d\.\d\d to 1, needs 4\.5/);
    // a border is held to 3 to 1, not 4.5
    f = details((t) => { t.color.themes.light.border = "#C8C8C8"; });
    assert.match(f[0].detail, /border on surface \(light\): contrast 1\.\d\d to 1, needs 3/);
    f = details((t) => { delete t.color.themes.dark.danger; });
    assert.ok(f.some((x) => /theme dark has no danger colour/.test(x.detail)));
    f = details((t) => { t.space.scale = [0, 4, 7, 16]; });
    assert.match(f[0].detail, /space\.scale steps 7 are not multiples of 2/);
    f = details((t) => { t.target.min = 40; });
    assert.match(f[0].detail, /target\.min is 40 dp, below 48/);
    f = details((t) => { t.type.roles.caption = { family: "body", size: 10, line: 14, weight: 400 }; });
    assert.match(f[0].detail, /type\.caption is 10, below the system's minimum of 12/);
    // a draft rule warns; it does not stop the sign-off
    f = details((t) => { t.type.roles.body.line = 20; });
    assert.deepEqual(f.map((x) => x.severity), ["warning"]);
    assert.match(f[0].detail, /type\.body: line height 1\.25 times its size, the rule says 1\.4/);
    f = details((t) => { delete t.radius.md; });
    assert.match(f[0].detail, /component button names `radius\.md`, which tokens\.json does not have/);
    // a project may state an exception in its own rules: pixel art keeps a 1 px step
    fillSystem(d, (t) => { t.space.scale = [1, 2, 4, 8, 16]; });
    assert.ok(checkSystem(d).findings.some((x) => x.rule === "spacing-on-grid"));
    const rp = join(dsDir(d), "rules.json");
    const rules = JSON.parse(readFileSync(rp, "utf8"));
    rules.find((r) => r.id === "spacing-on-grid").params = { allow: [1] };
    writeFileSync(rp, JSON.stringify(rules));
    assert.deepEqual(checkSystem(d).findings, []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a story that changes what a person sees owes the project's answer once: a system, the project's own, or none in the owner's words", () => {
  const { base, d } = fixture();
  const story = (id) => writeFileSync(join(d, "spec/stories", `${id}-page.md`), `---\nid: ${id}\ntitle: "Page"\ntype: feature\nstatus: proposed\nui: true\nsteps: []\nuser_flow_probe:\n  kind: manual\n  steps: ["open the page"]\n---\n\n# Page\n\n## Paths\n| Ending | Covered by |\n|---|---|\n| works | @AC-1 |\n\n## Acceptance Criteria\n\`\`\`gherkin\n@AC-1 @e2e\nScenario: works\n  Given a\n  When b\n  Then c\n\`\`\`\n`);
  try {
    writeFileSync(join(base, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
    story("S001"); story("S002"); story("S003");
    // a waived mock-up is about the picture, not the system: the first live run took "no mock-up" and built with no system
    assert.equal(cli(d, "design", "waive", "S001", "--reason", "internal page").status, 0);
    let r = cli(d, "story", "set-status", "S001", "approved");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /S001 changes what a person sees, and this project has no design system on record/);
    assert.equal(cli(d, "design", "approve", "S002", "--file", join(base, "a.png")).status, 0);
    r = cli(d, "story", "set-status", "S002", "approved");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /S002 changes what a person sees, and this project has no design system on record/);
    // a draft is not an answer yet
    assert.equal(run(d, "init", "--platform", "web", "--components", "button").status, 0);
    r = cli(d, "story", "set-status", "S002", "approved");
    assert.equal(r.status, 3); assert.match(r.stderr, /the design system is a draft/);
    fillSystem(d);
    assert.equal(run(d, "approve", "--answer", "yes").status, 0);
    assert.equal(cli(d, "story", "set-status", "S002", "approved").status, 0);
    assert.equal(cli(d, "story", "set-status", "S001", "approved").status, 0, "asked once: the second story owes nothing more");
    fillSystem(d, (t) => { t.radius.md = 6; });
    assert.equal(cli(d, "design", "approve", "S003", "--file", join(base, "a.png")).status, 0);
    r = cli(d, "story", "set-status", "S003", "approved");
    assert.equal(r.status, 3); assert.match(r.stderr, /changed after the owner signed it/);
  } finally { rmSync(base, { recursive: true, force: true }); }

  // the two other answers, each the owner's word
  for (const [verb, extra, state, line] of [["none", [], "none", /^none \(the owner's answer\)/], ["adopt", ["--path", "docs/ui/tokens.json", "--path", "src/ui"], "adopted", /the project's own: docs\/ui\/tokens\.json, src\/ui\. Design within it/]]) {
    const f = fixture();
    try {
      let r = run(f.d, verb, ...extra);
      assert.equal(r.status, 3); assert.match(r.stderr, new RegExp(`${verb} records the owner's decision`));
      assert.equal(stateOf(f.d), "undecided");
      assert.equal(run(f.d, verb, ...extra, "--answer", "we have our own already").status, 0);
      assert.equal(stateOf(f.d), state);
      assert.equal(designSystemOwed(f.d), null);
      assert.match(contextLine(f.d), line);
      assert.equal(run(f.d, "check").status, 3, "there are no values of Shipyard's to check");
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  }
  const g = fixture();
  try { assert.equal(run(g.d, "adopt", "--answer", "ours").status, 2, "adopt names what is adopted"); } finally { rmSync(g.base, { recursive: true, force: true }); }
});

test("what a project already has is found, counted, and named as the start: files, values typed in the code, an inspiration", () => {
  const { base, d } = fixture();
  const root = join(base, "repo");
  try {
    mkdirSync(join(root, "src", "components"), { recursive: true });
    mkdirSync(join(root, "node_modules", "x", "components"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x", "theme.css"), "a{color:#123456}");
    assert.deepEqual(detectExisting(root).values, []);
    writeFileSync(join(root, "src", "theme.ts"), "export const c = '#1A56DB';");
    writeFileSync(join(root, "src", "components", "Button.tsx"), "x");
    const found = detectExisting(root);
    assert.deepEqual(found.values, ["src/theme.ts"]);
    assert.deepEqual(found.components, [{ path: "src/components", entries: 1 }]);
    let r = run(d, "detect", "--root", root);
    assert.match(r.stdout, /values\s+src\/theme\.ts[\s\S]*components\s+src\/components\/ \(1 entries\)[\s\S]*it is a whole system[\s\S]*it is a start[\s\S]*--basis/);

    // values typed in the code: counted where a line says what the number is; a mask is not a colour; an issue number is not one
    writeFileSync(join(root, "src", "a.css"), ".a{color:#1A56DB;padding:16px;border-radius:8px;font-size:14px}\n.b{color:#1b57dc;padding:16px;margin:10px}\n.c{background:#fff;font-family: Inter, sans-serif}\n");
    writeFileSync(join(root, "src", "hw.c"), "#define MASK 0x00FFFF\nint fix = 123; /* see #456 */\nSDL_SetRenderDrawColor(r, 0xF0C860FF); uint32_t tint_color = 0xFFF0C860;\n");
    const x = extractFromSource(root);
    const count = (list, v) => list.find((e) => e.value === v)?.count ?? 0;
    assert.equal(count(x.colours, "#1A56DB"), 2, "the one in theme.ts and the one in a.css");
    assert.equal(count(x.colours, "#FFFFFF"), 1);
    assert.equal(count(x.colours, "#00FFFF"), 0, "a mask on a line that names no colour");
    assert.equal(count(x.colours, "#445566"), 0);
    assert.equal(count(x.colours, "#F0C860"), 2, "0xRRGGBBAA after a colour word reads as #RRGGBB, 0xAARRGGBB too");
    assert.deepEqual(x.near, [{ keep: "#1A56DB", merge: "#1B57DC", keep_count: 2, merge_count: 1 }]);
    assert.equal(count(x.space, "16px"), 2);
    assert.equal(count(x.radius, "8px"), 1);
    assert.equal(count(x.type, "14px"), 1);
    assert.equal(x.families[0].value, "Inter, sans-serif");
    r = run(d, "extract", "--root", root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\| Colours \| \d+ \| \d+ \| #1A56DB ×2/);
    assert.match(r.stdout, /#1B57DC ×1 {2}→ {2}#1A56DB ×2/);
    assert.match(r.stdout, /this is a floor, not a full count/);
    assert.ok(existsSync(join(dsDir(d), "extracted.json")));
    assert.equal(stateOf(d), "undecided", "counting is not a decision");

    // the start is named in the record, and has to be accounted for before the sign-off
    r = run(d, "init", "--platform", "web", "--components", "button", "--basis", "src/theme.ts", "--inspiration", "https://linear.app");
    assert.match(r.stdout, /Built on: src\/theme\.ts\. Read them and carry their values[\s\S]*Inspiration \(look and feel only, no component copied\): https:\/\/linear\.app/);
    const doc = readFileSync(join(dsDir(d), "DESIGN-SYSTEM.md"), "utf8");
    assert.match(doc, /## Where it comes from[\s\S]*- existing: `src\/theme\.ts`[\s\S]*No component is copied from one[\s\S]*- inspiration: https:\/\/linear\.app/);
    assert.ok(checkSystem(d).findings.some((f) => /"Where it comes from" is to fill/.test(f.detail)));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the token file is made for the code's own language, and the signed system is exported to the project", () => {
  const { base, d } = fixture();
  const root = join(base, "repo");
  try {
    mkdirSync(root, { recursive: true });
    assert.equal(run(d, "init", "--platform", "android", "--name", "Pocket", "--components", "button").status, 0);
    const t = fillSystem(d);
    assert.match(exportTokens(t, "css"), /:root \{\n {2}--color-surface: #FFFFFF;[\s\S]*--type-body-size: 16px;[\s\S]*--space-16: 16px;[\s\S]*--radius-md: 8px;[\s\S]*\[data-theme="dark"\] \{\n {2}--color-surface: #14161A;/);
    assert.match(exportTokens(t, "android"), /<color name="on_surface">#16181D<\/color>[\s\S]*<dimen name="type_body_size">16sp<\/dimen>[\s\S]*<dimen name="space_16">16dp<\/dimen>[\s\S]*<dimen name="target_min">48dp<\/dimen>/);
    assert.match(exportTokens(t, "c"), /#define COLOR_PRIMARY 0x1A56DBFFu[\s\S]*#define SPACE_16 16[\s\S]*#define MOTION_FAST_MS 100/);
    assert.match(exportTokens(t, "css", "dark"), /--color-surface: #14161A;/);
    assert.throws(() => exportTokens(t, "swift"), /is not json\|css\|android\|c/);
    assert.equal(JSON.parse(run(d, "tokens", "--format", "json").stdout).platform, "android");

    let r = run(d, "export", "--to", "docs/design-system", "--root", root);
    assert.equal(r.status, 3); assert.match(r.stderr, /only a signed system is exported/);
    assert.equal(run(d, "approve", "--answer", "yes").status, 0);
    r = run(d, "export", "--to", "../elsewhere", "--root", root);
    assert.equal(r.status, 3); assert.match(r.stderr, /is outside the project/);
    r = run(d, "export", "--to", "docs/design-system", "--root", root);
    assert.equal(r.status, 0, r.stderr);
    const out = join(root, "docs", "design-system");
    assert.match(readFileSync(join(out, "DESIGN-SYSTEM.md"), "utf8"), /^# Pocket\n\n> Version 1, signed \d{4}-\d\d-\d\d\.[\s\S]*## Values[\s\S]*COLOUR \(light\): surface #FFFFFF[\s\S]*## Rule list[\s\S]*\| Rule \| Checked \|/);
    assert.match(readFileSync(join(out, "design_tokens.xml"), "utf8"), /<color name="primary">#1A56DB<\/color>/);
    assert.ok(existsSync(join(out, "components", "button.md")) && existsSync(join(out, "design-system.html")));
    assert.ok(events(d).some((e) => e.type === "design_system_exported" && e.format === "android"));
    fillSystem(d, (x) => { x.radius.md = 6; });
    assert.match(run(d, "export", "--to", "docs/design-system", "--root", root).stderr, /changed since it was signed; sign it again before exporting/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a colour typed in the code that is not a token is found in the changes", () => {
  const { base, d } = fixture();
  const root = join(base, "repo");
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    git("init", "-q");
    writeFileSync(join(root, "src", "a.css"), ".a{color:#FFFFFF}\n");
    git("add", "-A"); git("commit", "-qm", "base");
    signed(d);
    writeFileSync(join(root, "src", "a.css"), ".a{color:#FFFFFF}\n.b{color:#1A56DB}\n.c{color:#ff00aa}\n");
    writeFileSync(join(root, "src", "theme.css"), ":root{--x:#00ff00}\n");
    git("add", "-A");
    const found = rawColours(git("diff", "--unified=0", "HEAD"), readTokens(d));
    assert.deepEqual(found.map((f) => [f.file, f.colour]), [["src/a.css", "#ff00aa"]], "a token's own colour passes; the file that holds the tokens is not scanned");
    const r = run(d, "scan", "--root", root);
    assert.equal(r.status, 0, "a warning, never a refusal");
    assert.match(r.stdout, /1 colour\(s\) typed in the changed code that are not tokens \(a warning\)\n {2}src\/a\.css: #ff00aa/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the decision file has one writer; the values and pages beside it are edited freely", async () => {
  const { base, d } = fixture();
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  const saved = process.env.SHIPYARD_DATA;
  try {
    mkdirSync(dsDir(d), { recursive: true });
    process.env.SHIPYARD_DATA = d;
    process.stdout.write = (c) => { out.push(String(c)); return true; };
    await runHook({ tool_name: "Write", tool_input: { file_path: join(dsDir(d), "design-system.json"), content: "{}" } }, process.env);
    await runHook({ tool_name: "Write", tool_input: { file_path: join(dsDir(d), "tokens.json"), content: "{}" } }, process.env);
  } finally {
    process.stdout.write = orig;
    if (saved === undefined) delete process.env.SHIPYARD_DATA; else process.env.SHIPYARD_DATA = saved;
    rmSync(base, { recursive: true, force: true });
  }
  const [deny, allow] = out.map((o) => JSON.parse(o).hookSpecificOutput);
  assert.equal(deny.permissionDecision, "deny");
  assert.match(deny.permissionDecisionReason, /design-system\.json is the owner's decision[\s\S]*design-system approve --answer/);
  assert.equal(allow.permissionDecision, "allow");
});

test("the book: a page per section, the values, the component pages and the rules as data; one file with nothing fetched", () => {
  const { base, d } = fixture();
  try {
    assert.equal(run(d, "init", "--platform", "web", "--name", "Ledger </script><b>", "--components", "button,card", "--inspiration", "https://linear.app").status, 0);
    fillSystem(d);
    const data = bookData(d);
    assert.deepEqual(data.sections.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(data.sections[0].frames.map((f) => f.title), ["Content first", "One thing at a time"], "a ### in a section is a frame of its own on the canvas");
    assert.match(data.origin, /Kept the brand blue/);
    assert.deepEqual(data.components.map((c) => [c.name, c.parts.length]), [["button", 8], ["card", 8]]);
    assert.ok(data.pairs.some((p) => p.theme === "dark" && p.fg === "on-primary" && p.min === 4.5) && data.pairs.some((p) => p.kind === "ui" && p.min === 3));
    assert.equal(data.meta.state, "draft");
    assert.equal(data.limits.floor, 24);
    const r = run(d, "render");
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(r.stdout.trim(), "utf8");
    assert.ok(!/<script[^>]+src=|<link[^>]+href=|@import|https?:\/\/(?!linear\.app|claude\.ai|www\.w3\.org\/2000\/svg)/.test(html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, "")), "no script, stylesheet or font is fetched");
    assert.equal(html.match(/<\/script>/g).length, 2, "a name cannot close the data block");
    assert.match(html, /id="stage"[\s\S]*id="world"[\s\S]*data-act="fit"[\s\S]*data-act="tidy"/);
    assert.ok(!/data-act="note"|Copy notes|Copy changes/.test(html), "the book is for reference: feedback is given on the Claude Design artifact");
    const embedded = JSON.parse(html.match(/<script type="application\/json" id="ds-data">([\s\S]*?)<\/script>/)[1]);
    assert.equal(embedded.meta.name, "Ledger </script><b>");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a signed system's rules join the screen check with its own numbers; an unsigned or changed one adds nothing", () => {
  const { base, d } = fixture();
  try {
    assert.deepEqual(screenRules(d), []);
    assert.equal(run(d, "init", "--platform", "web", "--components", "button").status, 0);
    fillSystem(d);
    assert.deepEqual(screenRules(d), [], "a draft is not the owner's yet");
    assert.equal(run(d, "approve", "--answer", "yes").status, 0);
    const rules = screenRules(d);
    assert.deepEqual(rules.map((r) => r.check).sort(), ["line-height", "line-length", "radius-family", "spacing-scale", "token-colors", "touch-target-gap", "touch-target-size", "type-scale"]);
    assert.equal(rules.find((r) => r.check === "touch-target-size").params.min, 44);
    assert.equal(rules.find((r) => r.check === "touch-target-size").status, "verified");
    assert.ok(rules.find((r) => r.check === "token-colors").params.colours.includes("26,86,219"));
    assert.deepEqual(rules.find((r) => r.check === "type-scale").params.sizes, [24, 16, 14]);
    assert.equal(rules.find((r) => r.check === "token-colors").status, "draft", "a rule with no standard behind it warns until the owner raises it");
    // `ui rules` shows them in place of the built-in of the same check
    writeFileSync(join(d, "config.md"), "---\nui:\n  adapter: web\n---\n");
    const listed = JSON.parse(cli(d, "ui", "rules", "--json").stdout);
    assert.equal(listed.filter((r) => r.check === "touch-target-size").length, 1);
    assert.equal(listed.find((r) => r.check === "touch-target-size").id, "screen-touch-target");
    assert.ok(listed.some((r) => r.check === "img-alt"), "the built-in rules it does not replace stay");
    fillSystem(d, (t) => { t.radius.md = 6; });
    assert.deepEqual(screenRules(d), [], "changed since it was signed");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the interactive page is this project's own screens: the starter is refused, a link goes to a screen, every screen can be reached", () => {
  const { base, d } = fixture();
  try {
    assert.equal(run(d, "init", "--platform", "android", "--components", "button").status, 0);
    const pp = join(dsDir(d), "prototype.json");
    const starter = JSON.parse(readFileSync(pp, "utf8"));
    assert.equal(starter.draft, true);
    assert.match(prototypeProblems(starter)[0], /still the starter \(`draft: true`\): write this project's own screens/);
    fillSystem(d);
    assert.deepEqual(checkSystem(d).findings, []);
    const write = (change) => { const p = JSON.parse(JSON.stringify(starter)); delete p.draft; change(p); writeFileSync(pp, JSON.stringify(p)); return checkSystem(d).findings.filter((f) => f.rule === "prototype").map((f) => f.detail); };
    assert.deepEqual(write(() => {}), []);
    assert.deepEqual(write((p) => { p.screens.add.blocks[2].items[0].to = "nowhere"; }), ['screen add leads to "nowhere", which is not a screen']);
    assert.deepEqual(write((p) => { p.screens.orphan = { title: "x", blocks: [{ type: "text", text: "x" }] }; }), ["nothing leads to screen orphan"]);
    assert.match(write((p) => { p.screens.home.blocks.push({ type: "carousel" }); })[0], /screen home: "carousel" is not a block \(bar, heading/);
    assert.deepEqual(write((p) => { p.start = "x"; })[0], 'the prototype\'s start screen "x" is not one of its screens');
    assert.match(write((p) => { p.screens = { home: p.screens.home }; }).join("; "), /at least two screens/);
    writeFileSync(pp, "not json");
    assert.match(checkSystem(d).findings.find((f) => f.rule === "prototype").detail, /prototype\.json is missing or has no screens/);
    // a game's starter is a game's screens
    const g = fixture();
    try { assert.equal(run(g.d, "init", "--platform", "game", "--name", "Blade").status, 0); assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dsDir(g.d), "prototype.json"), "utf8")).screens), ["title", "menu", "settings", "play", "pause"]); } finally { rmSync(g.base, { recursive: true, force: true }); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("an old system is brought up to date for the piece of work at hand: what it lacks is named, what changed is listed, the owner signs again", () => {
  const { base, d } = fixture();
  try {
    signed(d, "android", "button,card");
    // does it have what this screen needs?
    assert.deepEqual(covers(d, ["Button", "date-picker", "color.primary", "color.warning", "type.body", "space.16", "space.20"]).map((r) => [r.name, r.kind, r.have]),
      [["button", "component", true], ["date-picker", "component", false], ["color.primary", "value", true], ["color.warning", "value", false], ["type.body", "value", true], ["space.16", "value", true], ["space.20", "value", false]]);
    let r = run(d, "covers", "button", "date-picker", "color.warning", "--story", "S007");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\| date-picker \| component \| NO \|[\s\S]*2 missing\. Add only these for this piece of work[\s\S]*captured as an idea, not changed here/);
    assert.ok(events(d).some((e) => e.type === "design_system_coverage" && e.missing === "date-picker, color.warning" && e.story === "S007"));
    assert.match(run(d, "covers", "button", "color.primary").stdout, /The system covers this screen\. Design within it\./);
    assert.equal(run(d, "covers").status, 2);
    // nothing changed yet
    assert.deepEqual(changesSince(d), []);
    assert.match(run(d, "changes").stdout, /v1: unchanged since it was signed/);
    // the work adds the value and the component it needs, and loosens nothing else
    fillSystem(d, (t) => { t.color.themes.light.warning = "#8A5300"; t.color.themes.dark.warning = "#FFB95C"; t.radius.md = 12; delete t.radius.sm; });
    assert.equal(run(d, "component", "add", "date-picker").status, 0);
    fillSystem(d, (t) => { t.color.themes.light.warning = "#8A5300"; t.color.themes.dark.warning = "#FFB95C"; t.radius.md = 12; delete t.radius.sm; });
    const rp = join(dsDir(d), "rules.json");
    const rules = JSON.parse(readFileSync(rp, "utf8"));
    rules.find((x) => x.id === "radius-family").status = "verified";
    writeFileSync(rp, JSON.stringify(rules, null, 2));
    const list = changesSince(d);
    assert.deepEqual(list.filter((l) => /^value/.test(l)).sort(), ['value added: color.themes.dark.warning = "#FFB95C"', 'value added: color.themes.light.warning = "#8A5300"', "value changed: radius.md: 8 → 12", "value removed: radius.sm (was 4)"]);
    assert.ok(list.includes("rule radius-family: warns → fails a screen"));
    assert.ok(list.includes("component date-picker: added"));
    assert.ok(!list.some((l) => /component button|component card|sections in words|prototype/.test(l)), "what was not touched is not listed");
    r = run(d, "changes");
    assert.match(r.stdout, /6 change\(s\) since v1 was signed[\s\S]*Show the owner this list with the reason for each/);
    assert.equal(run(d, "approve", "--answer", "yes, add the date picker and the warning colour", "--story", "S007").status, 0);
    assert.equal(events(d).filter((e) => e.type === "design_system_approved").pop().story, "S007");
    assert.deepEqual(changesSince(d), [], "the new version is what later changes are measured against");
    // a first draft has nothing to compare with
    const f2 = fixture();
    try { assert.equal(run(f2.d, "init", "--platform", "web").status, 0); assert.match(run(f2.d, "changes").stdout, /a first draft, nothing was signed yet/); } finally { rmSync(f2.base, { recursive: true, force: true }); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

const PW_ROOT = process.env.UI_PLAYWRIGHT_ROOT || null;
const pw = PW_ROOT ? resolvePlaywright({ projectRoot: null, configuredRoot: PW_ROOT }) : { ok: false };
const SKIP = pw.ok ? false : "set UI_PLAYWRIGHT_ROOT to a dir holding node_modules/playwright to run";

test("browser: a rendered screen is measured against the signed system (colours, spacing, corners, text sizes, line height, target gap)", { skip: SKIP }, () => {
  const { base, d } = fixture();
  try {
    writeFileSync(join(d, "config.md"), `---\nui:\n  adapter: web\n  playwright_root: ${PW_ROOT}\n---\n`);
    signed(d, "web", "button");
    const page = (css, body) => { writeFileSync(join(base, "p.html"), `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;background:#FFFFFF;color:#16181D;font:16px/24px sans-serif}${css}</style></head><body>${body}</body></html>`); writeFileSync(join(base, "s.json"), JSON.stringify({ url: pathToFileURL(join(base, "p.html")).href, width: 375 })); return JSON.parse(cli(d, "ui", "verify", "--level", "screen", "--spec", join(base, "s.json"), "--json").stdout); };
    const good = page("main{padding:16px}button{min-height:44px;min-width:120px;padding:0 16px;background:#1A56DB;color:#FFFFFF;border:0;border-radius:8px;font-size:14px;line-height:20px}", "<main><p>Short.</p><button>Save</button></main>");
    assert.deepEqual(good.findings, [], JSON.stringify(good.findings));
    const bad = page("main{padding:15px}button{min-height:44px;min-width:120px;padding:0 16px;background:#FF00AA;color:#FFFFFF;border:0;border-radius:7px;font-size:13px}p{line-height:18px}a{display:inline-block;width:20px;height:20px;font-size:14px}",
      `<main><p>${"A long paragraph of running text that goes on for more than eighty characters so it counts. ".repeat(2)}</p><button>Save</button><a href="#">a</a><a href="#">b</a></main>`);
    const has = (re, sev) => bad.findings.some((f) => re.test(f.detail) && (!sev || f.severity === sev));
    assert.ok(has(/screen-token-colours: background colour rgb\(255,0,170\) is not a colour of the design system/, "warning"), JSON.stringify(bad.findings));
    assert.ok(has(/screen-spacing-scale: padding-top 15px is not a step of the spacing scale/, "warning"));
    assert.ok(has(/screen-radius-family: corner radius 7px is not a step of the radius family/, "warning"));
    assert.ok(has(/screen-type-scale: text size 13px is not the size of a type role/, "warning"));
    assert.ok(has(/screen-line-height: line height 1\.13 times the text size, the rule says 1\.5/, "warning"));
    assert.ok(has(/screen-target-gap: 20×20px control is \d+px from/, "warning"));
    assert.ok(has(/screen-touch-target: 20×20px < 44px/, "error"), "the target size is the system's own number and fails the screen");
    assert.equal(bad.result, "fail");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("browser: the book opens from disk with no error, turns pages, is clicked through like the app, switches theme and zooms; it is a reference and takes no feedback", { skip: SKIP }, async () => {
  const { base, d } = fixture();
  let browser;
  try {
    assert.equal(run(d, "init", "--platform", "game", "--name", "Blade", "--components", "ability-orb,menu-row").status, 0);
    fillSystem(d);
    const file = run(d, "render").stdout.trim();
    const { chromium } = createRequire(join(pw.dir, "package.json"))(pw.dir);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(pathToFileURL(file).href);
    assert.equal(await page.locator("#pages button").count(), 14, "cover, twelve sections, the interactive page");
    for (const id of ["cover", "principles", "colour", "typography", "space", "shape", "motion", "icons", "components", "patterns", "rules", "handoff", "play"]) {
      await page.locator(`#pages button[data-page="${id}"]`).click();
      assert.ok(await page.locator("#world .frame").count() >= 1, id);
    }
    assert.ok(await page.locator("#playds .hud").count() === 1, "a game's screens are drawn as a game's");
    // the prototype is clicked through: title, menu, play, and back again; the screens are on the canvas with arrows
    assert.match(await page.innerText("#pwhere"), /^Title · 1 of 5/);
    await page.locator("#playds [data-to]").first().click();
    assert.match(await page.innerText("#pwhere"), /^Main menu · 2 of 5/);
    await page.locator('#playds [data-to="play"]').click();
    assert.match(await page.innerText("#pwhere"), /^Play · /);
    await page.locator('[data-act="pback"]').click();
    assert.match(await page.innerText("#pwhere"), /^Main menu/);
    assert.equal(await page.locator(".mapscreen").count(), 5);
    assert.ok(await page.locator("#arrows path").count() >= 4);
    assert.equal(await page.locator(".mapscreen.current").count(), 1);
    await page.locator("#playds").click({ position: { x: 4, y: 4 } });
    assert.ok(await page.evaluate(() => document.querySelector("#playds").classList.contains("hint")), "a click on nothing shows what can be clicked");
    await page.locator('[data-act="prestart"]').click();
    assert.match(await page.innerText("#pwhere"), /^Title/);
    // a reference: it takes no feedback and changes no value
    assert.equal(await page.locator('#changes, #checks, .note, input[type="color"], input[type="number"], [data-act="note"], [data-act="notes"], [data-act="copy"]').count(), 0);
    await page.locator('[data-seg="theme"] [data-v="dark"]').click();
    assert.match(await page.locator("#playds").getAttribute("style"), /--c-surface:#14161A/, "the theme switch redraws every screen in the other theme");
    const before = await page.innerText("#zoom");
    await page.locator('[data-act="in"]').click();
    assert.notEqual(await page.innerText("#zoom"), before);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); rmSync(base, { recursive: true, force: true }); }
});
