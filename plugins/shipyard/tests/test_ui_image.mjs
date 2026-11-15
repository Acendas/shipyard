/** E005 image adapter (4.4): screen-level diff of pre-rendered PNGs with no browser — frames and device shots of a native renderer. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, diffPng, encodePng } from "../bin/ui-adapters/image.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

// Minimal PNG encoder for fixtures: 8-bit RGBA, filter 0 rows.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}
function png(width, height, pixel /* (x,y) => [r,g,b,a] */) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; for (let x = 0; x < width; x++) { const [r, g, b, a] = pixel(x, y); raw.set([r, g, b, a], y * (width * 4 + 1) + 1 + x * 4); } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("decodePng + diffPng: identical frames pass, a 10% change fails, masks exclude, size change fails", () => {
  const base = mkdtempSync(join(tmpdir(), "uiimg-"));
  try {
    const a = join(base, "a.png"), b = join(base, "b.png"), c = join(base, "c.png"), d = join(base, "d.png");
    writeFileSync(a, png(40, 20, (x, y) => [x * 6, y * 12, 30, 255]));
    writeFileSync(b, png(40, 20, (x, y) => [x * 6, y * 12, 30, 255]));
    writeFileSync(c, png(40, 20, (x, y) => (y < 2 ? [255, 255, 255, 255] : [x * 6, y * 12, 30, 255]))); // top 2 rows = 10%, far over the threshold
    writeFileSync(d, png(40, 21, (x, y) => [x * 6, y * 12, 30, 255]));
    const img = decodePng(a);
    assert.equal(img.width, 40); assert.equal(img.height, 20); assert.equal(img.data[(3 * 40 + 5) * 4], 30); // x=5 → r=30
    assert.equal(diffPng({ baselinePath: a, currentPath: b }).pass, true);
    const r = diffPng({ baselinePath: a, currentPath: c });
    assert.equal(r.pass, false); assert.ok(Math.abs(r.ratio - 0.1) < 1e-9, String(r.ratio));
    assert.equal(diffPng({ baselinePath: a, currentPath: c, masks: [{ x: 0, y: 0, w: 40, h: 2 }] }).pass, true, "masked rows are excluded");
    assert.equal(diffPng({ baselinePath: a, currentPath: c, maxDiffRatio: 0.2 }).pass, true);
    const s = diffPng({ baselinePath: a, currentPath: d });
    assert.equal(s.size_changed, true); assert.equal(s.pass, false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("ui verify --level screen accepts {image} with ui.adapter: none and diffs against the approved design", () => {
  const base = mkdtempSync(join(tmpdir(), "uiimg-"));
  try {
    const d = join(base, "projects", "abc123abc123");
    for (const sub of ["templates", "spec/stories", "sprints/current"]) mkdirSync(join(d, sub), { recursive: true });
    writeFileSync(join(d, ".project-root"), "/nonexistent\n");
    writeFileSync(join(d, "config.md"), "---\nui:\n  adapter: none\n---\n");
    writeFileSync(join(d, "spec/stories/S001-hud.md"), "---\nid: S001\ntitle: \"HUD\"\ntype: feature\nstatus: approved\nui: true\nsteps: []\n---\n\n# HUD\n");
    const design = join(base, "design.png"), frame = join(base, "frame.png"), drifted = join(base, "drifted.png");
    writeFileSync(design, png(32, 16, (x, y) => [x * 8, y * 16, 90, 255]));
    writeFileSync(frame, png(32, 16, (x, y) => [x * 8, y * 16, 90, 255]));
    writeFileSync(drifted, png(32, 16, (x, y) => (x < 16 ? [0, 0, 0, 255] : [x * 8, y * 16, 90, 255])));
    const cli = (...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: base } });
    let r = cli("design", "approve", "S001", "--file", design);
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(join(base, "ok.json"), JSON.stringify({ image: frame }));
    writeFileSync(join(base, "bad.json"), JSON.stringify({ image: drifted }));
    r = cli("ui", "verify", "--level", "screen", "--spec", join(base, "ok.json"), "--story", "S001", "--json");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /"lint":\{"skipped"/);
    r = cli("ui", "verify", "--level", "screen", "--spec", join(base, "bad.json"), "--story", "S001", "--json");
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /differs from baseline: 50\.00%/);
    // --image on the command line is the same thing
    r = cli("ui", "verify", "--level", "screen", "--image", frame, "--story", "S001");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // component and flow still need an adapter
    r = cli("ui", "verify", "--level", "component", "--spec", join(base, "ok.json"), "--story", "S001");
    assert.match(r.stdout + r.stderr, /skipped \(ui\.adapter: none\)/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("ui.adapter frames: screenshot runs the project's frame_command, screen verify diffs the frame against the approved design, component/flow are skipped", () => {
  const base = mkdtempSync(join(tmpdir(), "uiimg-"));
  try {
    const repo = join(base, "repo"); mkdirSync(repo);
    const d = join(base, "projects", "abc123abc123");
    for (const sub of ["templates", "spec/stories", "sprints/current"]) mkdirSync(join(d, sub), { recursive: true });
    writeFileSync(join(d, ".project-root"), repo + "\n");
    // the "renderer": copies a scene PNG from the repo to {out}
    writeFileSync(join(repo, "title.png"), png(32, 16, (x, y) => [x * 8, y * 16, 90, 255]));
    writeFileSync(join(d, "config.md"), `---\nui:\n  adapter: frames\n  frame_command: "cp {scene}.png {out}"\n---\n`);
    writeFileSync(join(d, "spec/stories/S001-title.md"), "---\nid: S001\ntitle: \"Title\"\ntype: feature\nstatus: approved\nui: true\nsteps: []\n---\n\n# Title\n");
    const cli = (...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8", cwd: repo, env: { ...process.env, CLAUDE_PLUGIN_DATA: base } });
    let r = cli("ui", "doctor");
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /frames adapter/);
    r = cli("ui", "screenshot", "--url", "title", "--story", "S001", "--label", "design", "--json");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const shot = JSON.parse(r.stdout).shots[0].path;
    r = cli("design", "approve", "S001", "--file", shot);
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(join(base, "screen.json"), JSON.stringify({ url: "title", width: 375 }));
    r = cli("ui", "verify", "--level", "screen", "--spec", join(base, "screen.json"), "--story", "S001", "--json");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // the renderer drifts from the design
    writeFileSync(join(repo, "title.png"), png(32, 16, (x, y) => (y < 8 ? [0, 0, 0, 255] : [x * 8, y * 16, 90, 255])));
    r = cli("ui", "verify", "--level", "screen", "--spec", join(base, "screen.json"), "--story", "S001", "--json");
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /differs from baseline: 50\.00%/);
    r = cli("ui", "verify", "--level", "component", "--spec", join(base, "screen.json"), "--story", "S001");
    assert.equal(r.status, 0); assert.match(r.stdout, /skipped — ui\.adapter frames has no DOM/);
    // an empty frame_command is a doctor failure, not a silent skip
    writeFileSync(join(d, "config.md"), `---\nui:\n  adapter: frames\n---\n`);
    r = cli("ui", "doctor");
    assert.equal(r.status, 4, r.stdout);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("frames adapter in a monorepo sub-project: the frame command runs where it was typed, a failure says why, and --scene needs no spec file", () => {
  const base = mkdtempSync(join(tmpdir(), "uiimg-"));
  try {
    const repo = join(base, "repo"); const game = join(repo, "game"); mkdirSync(game, { recursive: true });
    const d = join(base, "projects", "abc123abc123");
    for (const sub of ["templates", "spec/stories", "sprints/current"]) mkdirSync(join(d, sub), { recursive: true });
    writeFileSync(join(d, ".project-root"), repo + "\n"); // the git root is the parent; the game lives in game/
    writeFileSync(join(game, "hud.png"), png(32, 16, (x, y) => [x * 8, y * 16, 90, 255]));
    writeFileSync(join(d, "config.md"), `---\nui:\n  adapter: frames\n  frame_command: "cp {scene}.png {out}"\n---\n`);
    writeFileSync(join(d, "spec/stories/S001-hud.md"), "---\nid: S001\ntitle: \"HUD\"\ntype: feature\nstatus: approved\nui: true\nsteps: []\n---\n\n# HUD\n");
    const cli = (...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8", cwd: game, env: { ...process.env, CLAUDE_PLUGIN_DATA: base } });
    let r = cli("ui", "screenshot", "--scene", "hud", "--story", "S001", "--label", "design");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^frame → .*design[\\/]frame\.png$/m, "one frame, no web width label");
    const shot = join(d, "ui", "S001", "design", "frame.png");
    assert.equal(cli("design", "approve", "S001", "--file", shot).status, 0);
    r = cli("ui", "verify", "--level", "screen", "--scene", "hud", "--story", "S001");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    writeFileSync(join(game, "hud.png"), png(32, 16, (x, y) => (y < 8 ? [0, 0, 0, 255] : [x * 8, y * 16, 90, 255])));
    r = cli("ui", "verify", "--level", "screen", "--scene", "hud", "--story", "S001");
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /differs from baseline: 50\.00%/);
    // a relative --image is found from the sub-project too
    r = cli("ui", "verify", "--level", "screen", "--image", "hud.png", "--story", "S001");
    assert.equal(r.status, 3, r.stdout + r.stderr);
    // a failing command reports its exit code, where it ran and what it printed
    r = cli("ui", "screenshot", "--scene", "missing", "--story", "S001");
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.match(r.stderr, /frame_command failed \(exit 1\) in .*game/);
    assert.match(r.stderr, /missing\.png/);
    r = cli("ui", "verify", "--level", "screen", "--story", "S001");
    assert.equal(r.status, 2); assert.match(r.stderr, /--scene <name>/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("encodePng round-trips through decodePng", () => {
  const base = mkdtempSync(join(tmpdir(), "uiimg-"));
  try {
    const data = new Uint8Array(6 * 4 * 4); for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const p = join(base, "a.png"); writeFileSync(p, encodePng({ width: 6, height: 4, data }));
    const back = decodePng(p);
    assert.equal(back.width, 6); assert.equal(back.height, 4);
    assert.deepEqual([...back.data], [...data]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a design approved as a mockup is compared by eye: crop + scale, a side-by-side image, numbers as information, the project's own bar as an error", () => {
  const base = mkdtempSync(join(tmpdir(), "uiimg-"));
  try {
    const repo = join(base, "repo"); mkdirSync(repo);
    const d = join(base, "projects", "abc123abc123");
    for (const sub of ["templates", "spec/stories", "sprints/current"]) mkdirSync(join(d, sub), { recursive: true });
    writeFileSync(join(d, ".project-root"), repo + "\n");
    const scene = (x, y) => (y < 4 ? [20, 20, 40, 255] : x > 24 && y > 10 ? [200, 120, 40, 255] : [60, 140, 60, 255]);
    writeFileSync(join(repo, "hud.png"), png(32, 16, scene));
    // the mockup: the same screen at 3x inside a page with a 10 px margin and a title strip
    writeFileSync(join(repo, "mock.png"), png(116, 78, (x, y) => (x >= 10 && x < 106 && y >= 20 && y < 68 ? scene(Math.floor((x - 10) / 3), Math.floor((y - 20) / 3)) : [12, 12, 12, 255])));
    writeFileSync(join(d, "config.md"), `---\nui:\n  adapter: frames\n  frame_command: "cp {scene}.png {out}"\n---\n`);
    writeFileSync(join(d, "spec/stories/S001-hud.md"), "---\nid: S001\ntitle: \"HUD\"\ntype: feature\nstatus: approved\nui: true\nsteps: []\n---\n\n# HUD\n");
    const cli = (...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8", cwd: repo, env: { ...process.env, CLAUDE_PLUGIN_DATA: base } });
    let r = cli("design", "approve", "S001", "--file", join(repo, "mock.png"), "--fidelity", "exact", "--crop", "10,20,96,48");
    assert.equal(r.status, 2); assert.match(r.stderr, /--crop applies to --fidelity mockup/);
    r = cli("design", "approve", "S001", "--file", join(repo, "mock.png"), "--crop", "10,20,96,48", "--scene", "hud");
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /mockup: compared by layout and colour, scene hud/);
    const story = readFileSync(join(d, "spec/stories/S001-hud.md"), "utf8");
    assert.match(story, /^  fidelity: mockup$/m); assert.match(story, /^  crop: "10,20,96,48"$/m); assert.match(story, /^  scene: "hud"$/m);
    assert.equal(cli("design", "check", "S001").status, 0, "the extra fields do not break the design check");
    // a second story reuses the same design: snapshot, fidelity, crop and scene come along
    writeFileSync(join(d, "spec/stories/S002-shadows.md"), "---\nid: S002\ntitle: \"Shadows\"\ntype: feature\nstatus: approved\nui: true\nsteps: []\n---\n\n# Shadows\n");
    r = cli("design", "approve", "S002", "--from", "S001");
    assert.equal(r.status, 0, r.stderr);
    const s2 = readFileSync(join(d, "spec/stories/S002-shadows.md"), "utf8");
    assert.match(s2, /^  fidelity: mockup$/m); assert.match(s2, /^  crop: "10,20,96,48"$/m); assert.match(s2, /^  scene: "hud"$/m);
    assert.match(s2, /note: "same design as S001 v1"/);
    assert.equal(cli("design", "check", "S002").status, 0);
    r = cli("design", "approve", "S002", "--from", "S001", "--scene", "lane");
    assert.match(readFileSync(join(d, "spec/stories/S002-shadows.md"), "utf8"), /^  scene: "lane"$/m, "a flag given here wins");
    assert.equal(cli("design", "approve", "S002", "--from", "S099").status, 3);
    assert.equal(cli("design", "approve", "S002", "--from", "S001", "--file", join(repo, "mock.png")).status, 2);
    // no --scene and no spec: the design names the scene
    r = cli("ui", "verify", "--level", "screen", "--story", "S001", "--json");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    let j = JSON.parse(r.stdout);
    assert.equal(j.result, "look", "a mockup comparison is not a pass");
    assert.ok(j.look.layout > 0.95 && j.look.palette > 0.95, JSON.stringify(j.look));
    const sbs = decodePng(j.side_by_side);
    assert.equal(sbs.width, 32 * 2 + 4); assert.equal(sbs.height, 16);
    r = cli("ui", "verify", "--level", "screen", "--story", "S001");
    assert.match(r.stdout, /compared by eye — open .*side-by-side\.png \(design left, delivered right\)/);
    assert.match(r.stdout, /information, not a verdict/);
    // a screen that looks nothing like the design: still no verdict by default…
    writeFileSync(join(repo, "hud.png"), png(32, 16, () => [240, 240, 240, 255]));
    r = cli("ui", "verify", "--level", "screen", "--story", "S001", "--json");
    assert.equal(r.status, 0); j = JSON.parse(r.stdout);
    assert.ok(j.look.layout < 0.3, JSON.stringify(j.look));
    // …until the project sets its own bar
    writeFileSync(join(d, "config.md"), `---\nui:\n  adapter: frames\n  frame_command: "cp {scene}.png {out}"\n  min_layout: 0.5\n---\n`);
    r = cli("ui", "verify", "--level", "screen", "--story", "S001");
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /layout agrees with the design in \d+% of the frame \(ui\.min_layout 50%\)/);
    // a pre-rendered image (a device photo) goes the same way
    r = cli("ui", "verify", "--level", "screen", "--image", join(repo, "hud.png"), "--story", "S001");
    assert.equal(r.status, 3); assert.match(r.stdout, /FAIL/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
