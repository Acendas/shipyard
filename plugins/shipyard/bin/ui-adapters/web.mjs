/**
 * Web render-target adapter (E005-S5, v4.3) — Playwright behind one interface.
 *
 *   { kind: "web", screenshot(opts), computed(opts), aria(opts), lint(opts), diff(opts), flow(opts) }
 *
 * No dependency is added to the plugin: Playwright is resolved from (1) `ui.playwright_root`
 * in config.md, (2) the project's own node_modules (`playwright` or `playwright-core`),
 * (3) `UI_PLAYWRIGHT_ROOT` in the environment. Nothing is downloaded. `doctor()` says what
 * was found and how to fix it (`npm i -D playwright` in the project).
 *
 * The screenshot diff uses the browser itself as the pixel engine (two <canvas> elements and
 * getImageData), so it needs no image library; masks are CSS selectors or rectangles.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const DEFAULT_WIDTHS = Object.freeze([375, 768, 1024]);

export function resolvePlaywright({ projectRoot, configuredRoot = null } = {}) {
  const candidates = [];
  if (configuredRoot) candidates.push({ root: configuredRoot, source: "ui.playwright_root" });
  if (projectRoot) candidates.push({ root: projectRoot, source: "project node_modules" });
  if (process.env.UI_PLAYWRIGHT_ROOT) candidates.push({ root: process.env.UI_PLAYWRIGHT_ROOT, source: "UI_PLAYWRIGHT_ROOT" });
  for (const c of candidates) {
    for (const pkg of ["playwright", "playwright-core"]) {
      const direct = join(c.root, "node_modules", pkg, "package.json");
      const asRoot = join(c.root, pkg, "package.json");
      const self = join(c.root, "package.json");
      for (const pj of [direct, asRoot]) {
        if (existsSync(pj)) return { ok: true, pkg, dir: resolve(pj, ".."), source: c.source };
      }
      if (existsSync(self)) {
        try { if (JSON.parse(readFileSync(self, "utf8")).name === pkg) return { ok: true, pkg, dir: c.root, source: c.source }; } catch { /* ignore */ }
      }
    }
  }
  return { ok: false, tried: candidates.map((c) => c.root), hint: "install Playwright in the project (`npm i -D playwright` and `npx playwright install chromium`) or set ui.playwright_root in config.md" };
}

async function loadPlaywright(found) {
  const req = createRequire(join(found.dir, "package.json"));
  const mod = req(found.dir);
  return mod.chromium ? mod : (await import(pathToFileURL(req.resolve(found.dir)).href));
}

/** One Chromium per adapter (lazy), a fresh context per call; `adapter.close()` ends it. */
async function withPage({ found, state, width, height = 900, baseURL = null }, fn) {
  if (!state.browser) {
    const pw = await loadPlaywright(found);
    state.pw = pw;
    state.browser = await pw.chromium.launch({ headless: true });
  }
  const ctx = await state.browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, baseURL: baseURL ?? undefined, reducedMotion: "reduce" });
  try {
    const page = await ctx.newPage();
    return await fn(page, state.pw);
  } finally {
    await ctx.close();
  }
}

export function createWebAdapter({ projectRoot, configuredRoot = null, baseURL = null }) {
  const found = resolvePlaywright({ projectRoot, configuredRoot });
  const state = { browser: null, pw: null };
  const need = () => { if (!found.ok) throw Object.assign(new Error(`Playwright not found (tried: ${found.tried.join(", ") || "nothing"}); ${found.hint}`), { exitCode: 4 }); };
  return {
    kind: "web",
    doctor() { return found.ok ? { ok: true, detail: `${found.pkg} at ${found.dir} (${found.source})` } : { ok: false, detail: found.hint, tried: found.tried }; },
    async close() { if (state.browser) { const b = state.browser; state.browser = null; await b.close(); } },

    /** Full-page screenshots at each width → [{width, path}]. */
    async screenshot({ url, outDir, widths = DEFAULT_WIDTHS, fullPage = true, waitFor = null }) {
      need();
      mkdirSync(outDir, { recursive: true });
      const out = [];
      for (const width of widths) {
        const path = join(outDir, `w${width}.png`);
        await withPage({ found, state, width, baseURL }, async (page) => {
          await page.goto(url, { waitUntil: "networkidle" });
          if (waitFor) await page.waitForSelector(waitFor, { timeout: 10000 });
          await page.screenshot({ path, fullPage, animations: "disabled" });
        });
        out.push({ width, path });
      }
      return out;
    },

    /** Computed styles + box + states for selectors → [{selector, count, first:{box, styles, disabled, focusable}}]. */
    async computed({ url, selectors, properties, width = 1024 }) {
      need();
      return withPage({ found, state, width, baseURL }, async (page) => {
        await page.goto(url, { waitUntil: "networkidle" });
        return page.evaluate(({ selectors, properties }) => selectors.map((sel) => {
          const els = Array.from(document.querySelectorAll(sel));
          const el = els[0];
          if (!el) return { selector: sel, count: 0 };
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const styles = {};
          for (const p of properties) styles[p] = cs.getPropertyValue(p);
          return { selector: sel, count: els.length, first: { box: { x: r.x, y: r.y, width: r.width, height: r.height }, styles, disabled: !!el.disabled, focusable: el.tabIndex >= 0, text: (el.textContent || "").trim().slice(0, 80) } };
        }), { selectors, properties });
      });
    },

    /** Accessibility tree as text (ariaSnapshot when available). */
    async aria({ url, selector = "body", width = 1024 }) {
      need();
      return withPage({ found, state, width, baseURL }, async (page) => {
        await page.goto(url, { waitUntil: "networkidle" });
        const loc = page.locator(selector).first();
        if (typeof loc.ariaSnapshot === "function") return await loc.ariaSnapshot();
        if (page.accessibility) return JSON.stringify(await page.accessibility.snapshot({ root: await loc.elementHandle() }), null, 1);
        throw Object.assign(new Error("this Playwright has neither ariaSnapshot nor accessibility.snapshot"), { exitCode: 4 });
      });
    },

    /** Deterministic layout/contrast/target lint, evaluated in the page. */
    async lint({ url, width = 375, rules }) {
      need();
      return withPage({ found, state, width, baseURL }, async (page) => {
        await page.goto(url, { waitUntil: "networkidle" });
        return page.evaluate(LINT_IN_PAGE, { rules, width });
      });
    },

    /** Scripted flow: steps [{url}|{click}|{fill:{selector,value}}|{press}|{wait:{selector|ms}}] each with an optional `screenshot` name → {shots:[{name,path}], error?}. */
    async flow({ steps, outDir, width = 375 }) {
      need();
      mkdirSync(outDir, { recursive: true });
      return withPage({ found, state, width, baseURL }, async (page) => {
        const shots = [];
        for (let i = 0; i < steps.length; i++) {
          const st = steps[i];
          try {
            if (st.url) await page.goto(st.url, { waitUntil: "networkidle" });
            if (st.click) await page.locator(st.click).first().click();
            if (st.fill) await page.locator(st.fill.selector).first().fill(String(st.fill.value ?? ""));
            if (st.press) await page.keyboard.press(st.press);
            if (st.wait?.selector) await page.waitForSelector(st.wait.selector, { timeout: st.wait.timeout ?? 10000 });
            else if (st.wait?.ms) await page.waitForTimeout(Math.min(Number(st.wait.ms) || 0, 5000));
            if (st.screenshot) {
              const name = String(st.screenshot).replace(/[^A-Za-z0-9_.-]/g, "_");
              const path = join(outDir, `${String(i + 1).padStart(2, "0")}-${name}.png`);
              await page.screenshot({ path, fullPage: st.fullPage !== false, animations: "disabled" });
              shots.push({ name, path, step: i + 1 });
            }
          } catch (e) {
            return { shots, error: { step: i + 1, message: String(e?.message ?? e).split("\n")[0].slice(0, 200) } };
          }
        }
        return { shots };
      });
    },

    /** Pixel diff of two PNGs in the browser; masks = [{selector}] (resolved on `url`) or [{x,y,w,h}]. */
    async diff({ baselinePath, currentPath, masks = [], threshold = 0.1, maxDiffRatio = 0.01, width = 1024, url = null }) {
      need();
      return withPage({ found, state, width, baseURL }, async (page) => {
        let rects = masks.filter((m) => m.x !== undefined);
        const selectorMasks = masks.filter((m) => m.selector);
        if (selectorMasks.length && url) {
          await page.goto(url, { waitUntil: "networkidle" });
          const more = await page.evaluate((sels) => sels.flatMap((s) => Array.from(document.querySelectorAll(s)).map((el) => { const r = el.getBoundingClientRect(); return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height }; })), selectorMasks.map((m) => m.selector));
          rects = rects.concat(more);
        }
        const b64 = (p) => readFileSync(p).toString("base64");
        await page.setContent("<html><body></body></html>");
        return page.evaluate(DIFF_IN_PAGE, { a: b64(baselinePath), b: b64(currentPath), rects, threshold, maxDiffRatio });
      });
    },
  };
}

/* ---------- in-page functions (serialized by Playwright; keep them self-contained) ---------- */

const LINT_IN_PAGE = ({ rules, width }) => {
  const findings = [];
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const parse = (c) => { const m = c && c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { rgb: p.slice(0, 3), a: p[3] === undefined ? 1 : p[3] }; };
  const bgOf = (el) => { let e = el; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c.rgb; e = e.parentElement; } return [255, 255, 255]; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const sel = (el) => { const id = el.id ? `#${el.id}` : ""; const tid = el.getAttribute("data-testid"); return tid ? `[data-testid="${tid}"]` : `${el.tagName.toLowerCase()}${id}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}`; };
  for (const rule of rules) {
    const p = rule.params || {};
    const sev = rule.status === "verified" ? "error" : "warning";
    const push = (el, detail) => findings.push({ rule: rule.id, check: rule.check, severity: sev, selector: el ? sel(el) : null, detail });
    if (rule.check === "touch-target-size") {
      const min = p.min ?? 44;
      for (const el of document.querySelectorAll("a[href], button, [role=button], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex='-1'])")) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < min || r.height < min) push(el, `${Math.round(r.width)}×${Math.round(r.height)}px < ${min}px`);
      }
    } else if (rule.check === "contrast") {
      const min = p.min ?? 4.5;
      for (const el of document.querySelectorAll("p, span, a, li, td, th, label, h1, h2, h3, h4, h5, h6, button, small, dd, dt")) {
        if (!visible(el) || !(el.textContent || "").trim() || el.children.length) continue;
        const cs = getComputedStyle(el);
        const fg = parse(cs.color); if (!fg) continue;
        const l1 = lum(fg.rgb), l2 = lum(bgOf(el));
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        if (ratio < min) push(el, `contrast ${ratio.toFixed(2)} < ${min}`);
      }
    } else if (rule.check === "no-horizontal-scroll") {
      if (document.documentElement.scrollWidth > window.innerWidth + 1) push(null, `scrollWidth ${document.documentElement.scrollWidth} > viewport ${window.innerWidth} at ${width}px`);
    } else if (rule.check === "font-size") {
      const min = p.min ?? 12;
      for (const el of document.querySelectorAll("p, span, a, li, td, th, label, small, button, input")) {
        if (!visible(el) || !(el.textContent || el.value || "").trim()) continue;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < min) push(el, `font-size ${fs}px < ${min}px`);
      }
    } else if (rule.check === "img-alt") {
      for (const img of document.querySelectorAll("img")) if (!img.hasAttribute("alt")) push(img, "img without alt");
    } else if (rule.check === "focus-visible") {
      for (const el of document.querySelectorAll("a[href], button, input, select, textarea")) {
        if (!visible(el)) continue;
        el.focus();
        const cs = getComputedStyle(el);
        if (cs.outlineStyle === "none" && cs.boxShadow === "none") push(el, "no visible focus indicator (outline none, no box-shadow)");
      }
    } else findings.push({ rule: rule.id, check: rule.check, severity: "warning", selector: null, detail: "unknown check — ignored" });
  }
  return { width, findings };
};

const DIFF_IN_PAGE = async ({ a, b, rects, threshold, maxDiffRatio }) => {
  const load = (b64) => new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = `data:image/png;base64,${b64}`; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
  const draw = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
  const da = draw(ia), db = draw(ib);
  const masked = new Uint8Array(w * h);
  for (const r of rects) for (let y = Math.max(0, r.y | 0); y < Math.min(h, (r.y + r.h) | 0); y++) for (let x = Math.max(0, r.x | 0); x < Math.min(w, (r.x + r.w) | 0); x++) masked[y * w + x] = 1;
  let diff = 0, total = 0;
  const t = threshold * 255 * 3;
  for (let i = 0; i < w * h; i++) {
    if (masked[i]) continue;
    total++;
    const o = i * 4;
    const d = Math.abs(da[o] - db[o]) + Math.abs(da[o + 1] - db[o + 1]) + Math.abs(da[o + 2] - db[o + 2]);
    if (d > t) diff++;
  }
  const ratio = total ? diff / total : 0;
  return { width: w, height: h, size_changed: ia.width !== ib.width || ia.height !== ib.height, compared: total, differing: diff, ratio, pass: ratio <= maxDiffRatio && ia.width === ib.width && ia.height === ib.height };
};
