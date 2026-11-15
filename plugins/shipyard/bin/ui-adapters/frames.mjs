/**
 * Frames adapter (E005, v4.4): the project's own renderer is the pixel source.
 *
 * A game drawn by a C harness, a terminal UI, a native app on a device — none
 * has a URL for Playwright, but each can write a PNG of a scene on demand.
 * `ui.frame_command` is that command; `{scene}` is whatever `ui screenshot
 * --url <scene>` (or a screen spec's `url`) names and `{out}` is the PNG path
 * Shipyard wants written. Widths are the renderer's business: one frame per
 * scene, the file is copied under the requested width label unchanged.
 *
 * No DOM: component and flow verification are the project's own checks; the
 * screen level diffs the frame against the approved design with the pure
 * image diff (no browser). `doctor` only confirms a command is configured.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { diffPng } from "./image.mjs";

export function createFramesAdapter({ projectRoot, frameCommand }) {
  const render = (scene, out) => {
    if (!frameCommand) throw Object.assign(new Error("ui.adapter is frames but ui.frame_command is empty — set it with `shipyard-data config set ui-frame-command \"<cmd with {scene} and {out}>\"`"), { exitCode: 4 });
    const cmd = frameCommand.replaceAll("{scene}", scene).replaceAll("{out}", out);
    mkdirSync(join(out, ".."), { recursive: true });
    // Run where the command was typed, not at the git root: in a monorepo the
    // project is a sub-folder (its Makefile lives there), and a builder runs
    // this from its own worktree so the frame is of ITS code. Found live:
    // `make scenario` failed at the repository root with no reason shown.
    const cwd = process.cwd() || projectRoot;
    try {
      execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" ? undefined : "/bin/sh", timeout: 600000 });
    } catch (e) {
      const tail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim().split("\n").slice(-6).join("\n  ");
      throw Object.assign(new Error(`frame_command failed (exit ${e.status ?? "?"}) in ${cwd}\n  $ ${cmd}${tail ? `\n  ${tail}` : "\n  (no output — if the command silences itself with >/dev/null, drop that to see why)"}`), { exitCode: 4 });
    }
    if (!existsSync(out) || statSync(out).size === 0) throw Object.assign(new Error(`frame_command ran but wrote no PNG at ${out}: ${cmd}`), { exitCode: 4 });
    return out;
  };
  return {
    kind: "frames",
    doctor() {
      return frameCommand
        ? { ok: true, detail: `frames adapter — frame_command: ${frameCommand}` }
        : { ok: false, detail: "ui.adapter is frames but ui.frame_command is empty (set ui-frame-command)" };
    },
    async close() {},
    // One frame per scene: a native renderer has its own fixed size, so web
    // widths do not apply (a "375px" label on a 320x240 game frame misleads).
    async screenshot({ url: scene, outDir }) {
      mkdirSync(outDir, { recursive: true });
      return [{ width: null, label: "frame", path: render(scene, join(outDir, "frame.png")) }];
    },
    async diff({ baselinePath, currentPath, masks = [], threshold = 0.1, maxDiffRatio = 0.01 }) {
      return diffPng({ baselinePath, currentPath, masks, threshold, maxDiffRatio });
    },
    async computed() { throw Object.assign(new Error("frames adapter has no DOM (component level is the project's own check)"), { exitCode: 2 }); },
    async aria() { return null; },
    async lint() { return { findings: [] }; },
    async flow() { throw Object.assign(new Error("frames adapter has no DOM (flow level is the project's own scenario)"), { exitCode: 2 }); },
  };
}
