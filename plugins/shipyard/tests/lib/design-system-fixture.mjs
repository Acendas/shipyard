/** A design system filled in the way a discussion would fill it: values chosen, every section and page written. */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dsDir, PLATFORMS } from "../../bin/design-system.mjs";

export const LIGHT = { surface: "#FFFFFF", "on-surface": "#16181D", primary: "#1A56DB", "on-primary": "#FFFFFF", danger: "#B3261E", "on-danger": "#FFFFFF", border: "#767B86" };
export const DARK = { surface: "#14161A", "on-surface": "#E8EAEE", primary: "#8FB0FF", "on-primary": "#0C1220", danger: "#FFB4AB", "on-danger": "#410002", border: "#8B93A1" };

/** Fill the scaffold `design-system init` wrote. `change(tokens)` may alter the values before they are written. */
export function fillSystem(dataDir, change = null) {
  const dir = dsDir(dataDir);
  const t = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8"));
  t.color.themes = { light: { ...LIGHT }, dark: { ...DARK } };
  t.type.families = { body: "system-ui, sans-serif" };
  t.type.min_size = 12;
  t.type.roles = { heading: { family: "body", size: 24, line: 32, weight: 600 }, body: { family: "body", size: 16, line: 24, weight: 400 }, label: { family: "body", size: 14, line: 20, weight: 500 } };
  t.space.scale = [0, 4, 8, 12, 16, 24, 32, 48];
  t.radius = { none: 0, sm: 4, md: 8, lg: 16, full: 999 };
  t.motion = { durations: { fast: 100, base: 200 }, easing: { standard: "ease" }, reduced: "Changes happen at once, with no movement." };
  if (t.target) t.target.min = PLATFORMS[t.platform].target.min;
  if (change) change(t);
  writeFileSync(join(dir, "tokens.json"), JSON.stringify(t, null, 2) + "\n");

  const proto = JSON.parse(readFileSync(join(dir, "prototype.json"), "utf8"));
  delete proto.draft;
  writeFileSync(join(dir, "prototype.json"), JSON.stringify(proto, null, 2) + "\n");

  const doc = readFileSync(join(dir, "DESIGN-SYSTEM.md"), "utf8")
    .replace(/<!-- FILL: what was kept[^>]*-->/, "Kept the brand blue from the existing colours file. From the inspiration: calm and dense.")
    .replace(/<!-- FILL: [^>]*-->/g, (m) => (/3 to 5 statements/.test(m) ? "### Content first\n\nThe numbers a person came for are the largest thing on the screen.\n\n- Do: show the total above the list.\n- Don't: put a logo above it.\n\n### One thing at a time\n\nA screen asks for one decision." : "Written for the test: this section says how the values are used."));
  writeFileSync(join(dir, "DESIGN-SYSTEM.md"), doc);

  for (const f of readdirSync(join(dir, "components"))) {
    const text = readFileSync(join(dir, "components", f), "utf8")
      .replace(/<!-- FILL: The tokens it uses[^>]*-->/, "`color.primary`, `color.on-primary`, `type.label`, `space.16`, `radius.md`")
      .replace(/<!-- FILL: [^>]*-->/g, "Written for the test.");
    writeFileSync(join(dir, "components", f), text);
  }
  return t;
}
