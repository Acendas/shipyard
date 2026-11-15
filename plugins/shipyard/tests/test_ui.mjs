/** E005: ui CLI — pure evaluators always; the browser path only when a Playwright install is resolvable (UI_PLAYWRIGHT_ROOT or ui.playwright_root). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { matchExpectation, evaluateComponent, loadRules, BUILTIN_RULES } from "../bin/ui.mjs";
import { resolvePlaywright } from "../bin/ui-adapters/web.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

test("matchExpectation: numeric operators on the leading number, exact strings, booleans", () => {
  assert.equal(matchExpectation("48px", ">=44").pass, true);
  assert.equal(matchExpectation("40px", ">=44").pass, false);
  assert.equal(matchExpectation("16px", "=16").pass, true);
  assert.equal(matchExpectation("rgb(0, 0, 0)", "rgb(0, 0, 0)").pass, true);
  assert.equal(matchExpectation("rgb(1, 0, 0)", "rgb(0, 0, 0)").pass, false);
  assert.equal(matchExpectation(true, true).pass, true);
  assert.equal(matchExpectation("auto", ">=1").pass, false);
});

test("evaluateComponent: missing element, failed style, box and aria expectations become error findings", () => {
  const spec = { selectors: { "button.primary": { "min-height": ">=44", color: "rgb(255, 255, 255)", count: ">=1", focusable: true }, ".gone": { count: ">=1" } }, aria: { selector: "main", contains: ["button \"Pay\""] } };
  const computed = [
    { selector: "button.primary", count: 2, first: { box: { width: 120, height: 40 }, styles: { color: "rgb(255, 255, 255)" }, disabled: false, focusable: true, text: "Pay" } },
    { selector: ".gone", count: 0 },
  ];
  const f = evaluateComponent(spec, computed, '- main:\n  - button "Pay"');
  assert.deepEqual(f.map((x) => x.detail), ["min-height: expected \">=44\", got 40", "no element matches"]);
  const f2 = evaluateComponent(spec, computed, "- main:\n  - link \"Home\"");
  assert.ok(f2.some((x) => /accessibility tree lacks/.test(x.detail)));
});

test("rule pack: built-ins ship verified/draft; a user pack overrides by id and adds rules; unreadable packs degrade to a warning rule", () => {
  const base = mkdtempSync(join(tmpdir(), "ui-rules-"));
  try {
    assert.ok(BUILTIN_RULES.some((r) => r.id === "touch-target-size" && r.status === "verified"));
    let rules = loadRules(base, { rule_pack: null });
    assert.equal(rules.length, BUILTIN_RULES.length);
    writeFileSync(join(base, "pack.json"), JSON.stringify({ rules: [{ id: "touch-target-size", status: "verified", check: "touch-target-size", params: { min: 48 } }, { id: "big-type", status: "draft", check: "font-size", params: { min: 14 } }] }));
    rules = loadRules(base, { rule_pack: "pack.json" });
    assert.equal(rules.find((r) => r.id === "touch-target-size").params.min, 48, "override by id");
    assert.ok(rules.some((r) => r.id === "big-type"));
    rules = loadRules(base, { rule_pack: "missing.json" });
    assert.ok(rules.some((r) => r.id === "rule-pack-unreadable" && r.status === "draft"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("resolvePlaywright: configured root, project node_modules, env; nothing downloaded", () => {
  const base = mkdtempSync(join(tmpdir(), "ui-pw-"));
  const savedEnv = process.env.UI_PLAYWRIGHT_ROOT;
  delete process.env.UI_PLAYWRIGHT_ROOT;
  try {
    const miss = resolvePlaywright({ projectRoot: base, configuredRoot: null });
    assert.equal(miss.ok, false);
    assert.match(miss.hint, /npm i -D playwright/);
    mkdirSync(join(base, "node_modules", "playwright-core"), { recursive: true });
    writeFileSync(join(base, "node_modules", "playwright-core", "package.json"), '{"name":"playwright-core","version":"0.0.0"}');
    const hit = resolvePlaywright({ projectRoot: base, configuredRoot: null });
    assert.equal(hit.ok, true);
    assert.equal(hit.pkg, "playwright-core");
    assert.equal(hit.source, "project node_modules");
    process.env.UI_PLAYWRIGHT_ROOT = hit.dir;
    const viaEnv = resolvePlaywright({ projectRoot: null, configuredRoot: null });
    assert.equal(viaEnv.ok, true);
    assert.equal(viaEnv.source, "UI_PLAYWRIGHT_ROOT");
  } finally {
    if (savedEnv === undefined) delete process.env.UI_PLAYWRIGHT_ROOT; else process.env.UI_PLAYWRIGHT_ROOT = savedEnv;
    rmSync(base, { recursive: true, force: true });
  }
});

function dataDir() {
  const base = mkdtempSync(join(tmpdir(), "ui-cli-"));
  const d = join(base, "projects", "abc123abc123");
  for (const sub of ["templates", "spec/stories"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  return { base, d };
}
const run = (d, env, ...args) => spawnSync("node", [CLI, "ui", ...args, "--data-dir", d], { encoding: "utf8", env: { ...process.env, ...env } });

test("ui doctor: adapter none skips; adapter web without Playwright exits 4 with the install hint", () => {
  const { base, d } = dataDir();
  try {
    writeFileSync(join(d, "config.md"), "---\nui:\n  adapter: none\n---\n");
    let r = run(d, {}, "doctor");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /adapter: none/);
    r = run(d, {}, "screenshot", "--url", "http://127.0.0.1:1/");
    assert.match(r.stdout, /skipped \(ui.adapter: none\)/);
    writeFileSync(join(d, "config.md"), "---\nui:\n  adapter: web\n  playwright_root: /nonexistent\n---\n");
    r = run(d, { UI_PLAYWRIGHT_ROOT: "" }, "doctor");
    assert.equal(r.status, 4);
    assert.match(r.stdout, /MISSING/);
    r = run(d, {}, "rules", "--json");
    assert.equal(JSON.parse(r.stdout).length, BUILTIN_RULES.length);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

const PW_ROOT = process.env.UI_PLAYWRIGHT_ROOT || null;
const pw = PW_ROOT ? resolvePlaywright({ projectRoot: null, configuredRoot: PW_ROOT }) : { ok: false };

test("browser path: screenshot, component, screen (lint + diff against an approved design), flow — real Playwright", { skip: pw.ok ? false : "set UI_PLAYWRIGHT_ROOT to a dir holding node_modules/playwright to run" }, async () => {
  const { base, d } = dataDir();
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
    body{margin:0;font-family:sans-serif;color:#222;background:#fff}
    main{padding:16px}
    button.primary{min-height:48px;min-width:120px;background:#0b57d0;color:#fff;border:0;border-radius:8px;font-size:16px}
    a.tiny{display:inline-block;width:20px;height:20px;font-size:10px;color:#bbb}
    </style></head><body><main><h1>Pay</h1><button class="primary" id="pay">Pay now</button><a class="tiny" href="#">?</a><img src="x.png"></main></body></html>`;
  // Served from a file: the CLI runs through spawnSync, which blocks this process's event loop,
  // so an in-process http server could never answer the browser.
  writeFileSync(join(base, "page.html"), html);
  const url = pathToFileURL(join(base, "page.html")).href;
  try {
    writeFileSync(join(d, "config.md"), `---\nui:\n  adapter: web\n  playwright_root: ${PW_ROOT}\n---\n`);
    writeFileSync(join(d, "spec/stories/S001-pay.md"), "---\nid: S001\ntitle: \"Pay\"\ntype: feature\nstatus: approved\nui: true\nsteps: []\n---\n\n# Pay\n");

    let r = run(d, {}, "doctor");
    assert.equal(r.status, 0, r.stdout + r.stderr);

    r = run(d, {}, "screenshot", "--url", url, "--story", "S001", "--label", "first", "--widths", "375,768", "--json");
    assert.equal(r.status, 0, r.stderr);
    const shots = JSON.parse(r.stdout).shots;
    assert.equal(shots.length, 2);
    assert.ok(existsSync(shots[0].path));

    // the 375px capture becomes the approved design snapshot
    r = spawnSync("node", [CLI, "design", "approve", "S001", "--file", shots[0].path, "--data-dir", d], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);

    writeFileSync(join(base, "component.json"), JSON.stringify({ url, selectors: { "button.primary": { "min-height": ">=44", color: "rgb(255, 255, 255)", count: "=1", focusable: true, text: "Pay now" }, "a.tiny": { "min-height": ">=44" } }, aria: { selector: "main", contains: ["Pay now"] } }));
    r = run(d, {}, "verify", "--level", "component", "--spec", join(base, "component.json"), "--story", "S001", "--json");
    assert.equal(r.status, 3, "the 20px link fails the component expectation");
    let j = JSON.parse(r.stdout);
    assert.equal(j.errors, 1);
    assert.match(j.findings[0].detail, /min-height/);

    writeFileSync(join(base, "screen.json"), JSON.stringify({ url, width: 375, maxDiffRatio: 0.001 }));
    r = run(d, {}, "verify", "--level", "screen", "--spec", join(base, "screen.json"), "--story", "S001", "--json");
    j = JSON.parse(r.stdout);
    assert.equal(j.result, "fail", "lint catches the 20px target and the alt-less image even though the pixel diff passes");
    assert.ok(j.findings.some((f) => /touch-target-size/.test(f.detail) && f.severity === "error"));
    assert.ok(j.findings.some((f) => /img-alt/.test(f.detail)));
    assert.ok(!j.findings.some((f) => /differs from baseline/.test(f.detail)), "same page == approved snapshot");

    writeFileSync(join(base, "flow.json"), JSON.stringify({ width: 375, steps: [{ url, screenshot: "start" }, { click: "#pay", screenshot: "after-pay" }], baselines: { start: shots[0].path } }));
    r = run(d, {}, "verify", "--level", "flow", "--spec", join(base, "flow.json"), "--story", "S001", "--json");
    j = JSON.parse(r.stdout);
    assert.equal(j.result, "pass", JSON.stringify(j.findings));
    assert.ok(existsSync(join(d, "ui", "S001", "flow", "02-after-pay.png")));

    const ev = readFileSync(join(d, ".shipyard-events.jsonl"), "utf8");
    assert.ok(/ui_screenshot/.test(ev) && /ui_verified/.test(ev) && /design_approved/.test(ev));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
