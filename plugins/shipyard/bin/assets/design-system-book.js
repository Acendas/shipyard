/* The design system book: one page per section, each an open canvas, plus a page where the project's screens
   are clicked through. A reference, made after the owner signed: it takes no feedback and changes no value.
   Runs from a single file opened from disk: no network, no library. */
(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("ds-data").textContent);
  var T = DATA.tokens || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); };
  var unit = T.unit === "cell" ? "cells" : (T.unit || "px");
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem("dsbook:" + DATA.meta.name + ":" + k) || "null"); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem("dsbook:" + DATA.meta.name + ":" + k, JSON.stringify(v)); } catch (e) { /* private window: the page still works */ } }
  };

  /* ---------- colour ---------- */
  function rgb(hex) { var m = /^#([0-9a-f]{6})/i.exec(String(hex || "")); if (!m) return null; return [0, 2, 4].map(function (i) { return parseInt(m[1].slice(i, i + 2), 16); }); }
  function lum(c) { var v = c.map(function (x) { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; }
  function contrast(a, b) { var x = rgb(a), y = rgb(b); if (!x || !y) return null; var l1 = lum(x), l2 = lum(y); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }

  /* ---------- the system's values as CSS variables for anything drawn inside .ds ---------- */
  function themeNames(t) { return Object.keys((t.color && t.color.themes) || {}); }
  function nearest(list, want) { var best = null; (list || []).forEach(function (v) { if (best === null || Math.abs(v - want) < Math.abs(best - want)) best = v; }); return best; }
  function dsVars(t, theme) {
    var out = [], roles = ((t.color && t.color.themes) || {})[theme] || {};
    Object.keys(roles).forEach(function (k) { if (rgb(roles[k])) out.push("--c-" + k + ":" + roles[k]); });
    var cell = t.unit === "cell";
    Object.keys((t.type && t.type.roles) || {}).forEach(function (k) {
      var r = t.type.roles[k];
      if (!cell && r.size > 0) out.push("--t-" + k + "-size:" + r.size + "px");
      if (!cell && r.line > 0) out.push("--t-" + k + "-line:" + r.line + "px");
      if (r.weight) out.push("--t-" + k + "-weight:" + r.weight);
    });
    var fam = t.type && t.type.families && t.type.families.body; if (fam) out.push("--f-body:" + fam);
    var scale = (t.space && t.space.scale) || [];
    if (!cell && scale.length) { out.push("--pad:" + nearest(scale, 16) + "px"); out.push("--gap:" + nearest(scale, 16) + "px"); }
    var rad = t.radius || {}, vals = Object.keys(rad).map(function (k) { return Number(rad[k]); }).filter(function (v) { return v > 0 && v < 500; }).sort(function (a, b) { return a - b; });
    var ctl = rad.md != null ? Number(rad.md) : rad.sm != null ? Number(rad.sm) : vals.length ? vals[Math.min(1, vals.length - 1)] : null;
    var box = rad.lg != null ? Number(rad.lg) : vals.length ? vals[Math.min(2, vals.length - 1)] : null;
    if (ctl !== null) out.push("--r-ctl:" + ctl + "px"); else if (Object.keys(rad).length === 0 && t.platform && t.platform !== "web") out.push("--r-ctl:0px");
    if (box !== null) out.push("--r-box:" + box + "px");
    if (t.target && t.target.min > 0) out.push("--target:" + t.target.min + "px");
    return out.join(";");
  }

  /* ---------- drawings of well-known components, in the system's values ---------- */
  var PREVIEWS = [
    [/^(button|btn)$/, '<div class="row"><button class="btn first">Save</button><button class="btn sec">Cancel</button><button class="btn danger">Delete</button><button class="btn" disabled>Disabled</button></div>'],
    [/^(text-field|input|prompt)$/, '<div class="row" style="align-items:flex-start"><div class="field"><label>Name</label><input value="Ada Lovelace"><span class="help">As on your card</span></div><div data-state="error"><div class="field"><label>Email</label><input value="ada@"><span class="err">Enter a full email address</span></div></div></div>'],
    [/^(select|picker|menu)$/, '<div class="field"><label>Month</label><select><option>March</option><option>April</option></select></div>'],
    [/^(checkbox)$/, '<div class="row"><span class="check">✓</span><span>Remember this device</span></div>'],
    [/^(switch|toggle)$/, '<div class="row"><span class="switch"></span><span>Notifications</span></div>'],
    [/^(card)$/, '<div class="card col" style="max-width:320px"><p class="heading">March</p><span>Total spent 412.50</span><div class="row"><button class="btn first">Open</button></div></div>'],
    [/^(list-row|list-item|list|menu-item|table)$/, '<div style="max-width:360px"><div class="lrow"><span>Groceries</span><span>84.20</span></div><div class="lrow"><span>Transport</span><span class="badge">new</span></div><div class="lrow"><span>Rent</span><span>900.00</span></div></div>'],
    [/^(dialog|alert|sheet|dialog-box)$/, '<div class="card col" style="max-width:360px"><p class="heading">Delete this entry?</p><span>This cannot be undone.</span><div class="row" style="justify-content:flex-end"><button class="btn sec">Cancel</button><button class="btn danger">Delete</button></div></div>'],
    [/^(toast|snackbar|message)$/, '<div class="toast"><span>Entry saved</span><b>Undo</b></div>'],
    [/^(tabs|tab-bar)$/, '<div class="tabs"><span class="on">Month</span><span>Year</span><span>All</span></div>'],
    [/^(badge)$/, '<div class="row"><span class="badge">3</span><span class="badge">new</span></div>'],
    [/^(progress|meter)$/, '<div class="meter"><i></i></div>'],
    [/^(navigation|navigation-bar|top-app-bar|toolbar|status-bar|status-line)$/, '<div class="bar" style="border-radius:8px"><b>Expenses</b><span>March</span></div>'],
    [/orb/, '<div class="row" style="align-items:flex-end"><span class="orb">Y</span><span class="orb">X</span><span class="orb">B</span><span class="orb auto">A</span></div>'],
    [/^(health-bar|hp-bar)$/, '<div class="row"><div class="unit"><div class="hp"><i></i></div></div><div class="unit foe"><div class="hp"><i></i></div></div></div>'],
    [/^(menu-row)$/, '<div class="card" style="max-width:240px"><div class="mrow on">RESUME</div><div class="mrow">SETTINGS</div></div>'],
    [/^(top-strip|top-bar)$/, '<div class="hud-top" style="max-width:560px"><span class="mm"></span><span>12:40</span><span class="gold">◆ 1250</span><span>4 / 2</span></div>'],
    [/^(minimap)$/, '<div class="hud-top" style="width:148px;padding:0"><span class="mm"></span></div>'],
    [/^(hud-readout)$/, '<div class="row"><span class="badge mono">HP 82</span><span class="badge mono">x3</span><div class="meter" style="min-width:120px"><i></i></div></div>'],
    [/^(button-prompt)$/, '<div class="row"><span class="check">A</span><span>Jump</span><span class="check">B</span><span>Back</span></div>']
  ];
  function preview(name) { for (var i = 0; i < PREVIEWS.length; i++) if (PREVIEWS[i][0].test(name)) return PREVIEWS[i][1]; return ""; }
  function ds(html, t, theme, attrs) { return '<div class="ds" ' + (attrs || "") + ' style="padding:24px;' + esc(dsVars(t, theme)) + '">' + html + "</div>"; }

  /* ---------- pages ---------- */
  var THEMES = themeNames(T), THEME0 = THEMES[0] || "light";
  var HOW = { tokens: "on the values", screen: "on a rendered screen", source: "in the code", project: "by the project's own check", eye: "by eye, at the review" };

  function valueFrames(key) {
    var f = [];
    if (key === "colour") {
      THEMES.forEach(function (th) {
        var roles = T.color.themes[th];
        f.push({ title: "Colours · " + th, html: '<div class="swatches">' + Object.keys(roles).map(function (k) { return '<div class="sw"><div class="chip" style="background:' + esc(roles[k]) + '"></div><b>' + esc(k) + "</b><code>" + esc(roles[k]) + "</code></div>"; }).join("") + "</div>" });
      });
      f.push({ title: "Readable pairs", html: "<table><tr><th>Theme</th><th>Pair</th><th>Contrast</th><th></th></tr>" + (DATA.pairs || []).map(function (p) {
        var r = T.color.themes[p.theme] || {}, c = contrast(r[p.fg], r[p.bg]);
        return "<tr><td>" + esc(p.theme) + '</td><td><span class="pair" style="color:' + esc(r[p.fg]) + ";background:" + esc(r[p.bg]) + '">' + esc(p.fg) + " on " + esc(p.bg) + "</span></td><td>" + (c ? c.toFixed(2) + " to 1" : "?") + '</td><td><span class="tag ' + (c && c >= p.min ? "ok" : "bad") + '">' + (c && c >= p.min ? "passes " : "fails ") + p.min + "</span></td></tr>";
      }).join("") + "</table>" });
    }
    if (key === "typography") {
      var roles = (T.type && T.type.roles) || {};
      f.push({ title: "Type roles", cls: "wide", html: Object.keys(roles).map(function (k) {
        var r = roles[k], fam = (T.type.families || {})[r.family] || "inherit";
        return '<div style="margin-bottom:24px"><div class="mute small"><b>' + esc(k) + "</b> · " + r.size + "/" + r.line + " " + unit + " · weight " + (r.weight || 400) + '</div><div style="font-family:' + esc(fam) + ";font-size:" + (T.unit === "cell" ? 16 : Number(r.size) || 16) + "px;line-height:" + (T.unit === "cell" ? 24 : Number(r.line) || 24) + "px;font-weight:" + (Number(r.weight) || 400) + '">The quick brown fox jumps over 0123456789</div></div>';
      }).join("") + '<p class="mute small">Smallest text allowed: ' + esc(T.type && T.type.min_size) + " " + unit + ". Fonts: " + esc(Object.keys((T.type && T.type.families) || {}).map(function (k) { return k + " = " + T.type.families[k]; }).join("; ")) + "</p>" });
    }
    if (key === "space") {
      f.push({ title: "Spacing scale", html: '<p class="mute small">Base ' + esc(T.space && T.space.base) + " " + unit + "</p>" + ((T.space && T.space.scale) || []).map(function (v) { return '<div class="bar-row"><code>space.' + v + '</code><div class="bar-fill" style="width:' + Math.min(Number(v) * (T.unit === "cell" ? 8 : 1) || 0, 640) + 'px"></div><span class="mute small">' + v + " " + unit + "</span></div>"; }).join("") });
      var sz = T.sizes || {};
      if (Object.keys(sz).length) f.push({ title: "Fixed sizes", html: "<table>" + Object.keys(sz).map(function (k) { return "<tr><td><code>size." + esc(k) + "</code></td><td>" + esc(sz[k]) + "</td></tr>"; }).join("") + "</table>" });
      var bp = T.breakpoints || {};
      if (Object.keys(bp).length) f.push({ title: "Sizes of window or screen", html: "<table>" + Object.keys(bp).map(function (k) { return "<tr><td><b>" + esc(k) + "</b></td><td>" + esc(bp[k]) + " " + unit + "</td></tr>"; }).join("") + "</table>" });
      if (T.target) f.push({ title: "Touch", cls: "narrow", html: '<div style="display:flex;gap:' + T.target.gap + 'px;margin-bottom:12px"><div style="width:' + T.target.min + "px;height:" + T.target.min + 'px;background:var(--accent);border-radius:4px"></div><div style="width:' + T.target.min + "px;height:" + T.target.min + 'px;background:var(--accent);border-radius:4px"></div></div><p>Target ' + T.target.min + " " + unit + ", " + T.target.gap + " " + unit + " apart. Drawn at real size.</p>" });
    }
    if (key === "shape") {
      var rad = T.radius || {};
      f.push({ title: "Corner radii", html: Object.keys(rad).length ? '<div class="swatches">' + Object.keys(rad).map(function (k) { return '<div class="sw"><div class="chip" style="background:var(--accent);border:0;border-radius:' + Math.min(Number(rad[k]) || 0, 40) + 'px"></div><b>' + esc(k) + "</b><code>" + esc(rad[k]) + " " + unit + "</code></div>"; }).join("") + "</div>" : "<p>This system has square corners only.</p>" });
      var el = T.elevation || {};
      if (Object.keys(el).length) f.push({ title: "Depth", html: "<table>" + Object.keys(el).map(function (k) { return "<tr><td><b>" + esc(k) + "</b></td><td><code>" + esc(el[k]) + "</code></td></tr>"; }).join("") + "</table>" });
    }
    if (key === "motion") {
      var d = (T.motion && T.motion.durations) || {};
      f.push({ title: "Durations (press play)", cls: "mid", html: Object.keys(d).map(function (k) { return '<div class="mute small"><b>' + esc(k) + "</b> · " + esc(d[k]) + ' ms</div><div class="motion-track" data-ms="' + Number(d[k]) + '"><div class="motion-dot"></div></div>'; }).join("") + '<button class="action" data-act="play">Play</button><p class="mute small">Reduced motion: ' + esc((T.motion && T.motion.reduced) || "not said") + "</p>" });
    }
    if (key === "components") {
      (DATA.components || []).forEach(function (c) {
        var p = preview(c.name);
        f.push({ title: "Component · " + c.name, html: (p ? '<div class="preview">' + ds(p, T, THEME0) + '<p class="mute small" style="margin:8px 0 0">A drawing in this system\'s values. The page below is the specification.</p></div>' : "") + '<div class="parts">' + c.parts.map(function (x) { return "<section><h4 style=\"margin-top:0\">" + esc(x.title) + "</h4>" + x.html + "</section>"; }).join("") + "</div>" });
      });
    }
    if (key === "rules") {
      ["tokens", "screen", "source", "project", "eye"].forEach(function (how) {
        var rows = (DATA.rules || []).filter(function (r) { return r.check === how; });
        if (!rows.length) return;
        f.push({ title: "Checked " + HOW[how], cls: "wide", html: "<table><tr><th>Rule</th><th>Effect</th><th>From</th></tr>" + rows.map(function (r) { return "<tr><td>" + esc(r.rule) + (r.command ? '<br><code>' + esc(r.command) + "</code>" : "") + "</td><td>" + (how === "eye" ? "a checklist" : r.status === "verified" ? '<span class="tag bad">fails</span>' : '<span class="tag">warns</span>') + '</td><td class="mute small">' + esc(r.source) + "</td></tr>"; }).join("") + "</table>" });
      });
    }
    return f;
  }

  var PAGES = [{ id: "cover", n: "", label: "Cover" }].concat((DATA.sections || []).map(function (s) { return { id: s.key, n: String(s.n), label: s.title, section: s }; })).concat([{ id: "play", n: "▶", label: "Interactive design" }]);

  function framesFor(page) {
    if (page.id === "cover") {
      var m = DATA.meta, st = m.state === "approved" ? "Version " + m.version + ", signed " + m.signed : m.state === "draft" ? "Draft, not signed" : "Version " + m.version + ", changed since it was signed";
      return [
        { title: "Cover", cls: "wide cover", html: "<h2>" + esc(m.name) + '</h2><p><span class="tag">' + esc(m.platform) + '</span><span class="tag ' + (m.state === "approved" ? "ok" : "bad") + '">' + esc(st) + '</span><span class="tag">values in ' + esc(unit) + "</span></p>" + (m.artifact ? '<p class="mute small">Also at ' + esc(m.artifact) + "</p>" : "") },
        { title: "Where it comes from", cls: "mid", html: DATA.origin || "<p>Made new for this project.</p>" },
        { title: "Contents", cls: "narrow", html: "<table>" + PAGES.slice(1).map(function (p) { return "<tr><td>" + esc(p.n) + "</td><td>" + esc(p.label) + "</td></tr>"; }).join("") + "</table>" },
        { title: "How to read this", cls: "mid", html: "<ul><li>Each page is an open canvas. Drag to move around, pinch or hold Ctrl and scroll to zoom, press <b>Fit</b> to see the whole page.</li><li>Drag a frame by its title to move it; <b>Tidy</b> puts the page back.</li><li><b>Interactive design</b> is this project's screens: click through them like the app, switch theme and state, and see every screen on a map with the ways between them.</li><li>This book is the signed system, for reference. A change is asked for where the design was reviewed, and becomes a new version.</li></ul>" }
      ];
    }
    if (page.id === "play") return playFrames();
    var f = [], fr = page.section.frames, head = "<h2>" + esc(page.label) + "</h2>";
    fr.forEach(function (x, i) { f.push({ title: i === 0 ? page.n + " · " + page.label : x.title, cls: "mid", html: (i === 0 ? head : "") + (x.title ? "<h3>" + esc(x.title) + "</h3>" : "") + x.html }); });
    return f.concat(valueFrames(page.id));
  }

  /* ---------- the interactive page ---------- */
  var play = { theme: THEME0, state: "rest", width: 375 };
  function playFrames() {
    var seg = function (name, values, cur) { return '<div class="seg" data-seg="' + name + '">' + values.map(function (v) { return '<button aria-pressed="' + (String(v) === String(cur)) + '" data-v="' + esc(v) + '">' + esc(v === 0 ? "full" : v) + "</button>"; }).join("") + "</div>"; };
    var controls = "<h3>Theme</h3>" + seg("theme", THEMES, play.theme) + "<h3>State</h3>" + seg("state", DATA.meta.platform === "game" ? ["rest", "focus", "disabled"] : ["rest", "focus", "pressed", "disabled", "loading", "error"], play.state) + (DATA.meta.platform === "game" ? "" : "<h3>Width</h3>" + seg("width", [320, 375, 768, 0], play.width));
    return [
      { title: "Prototype · click through it", id: "f-proto", html: '<div class="protobar"><button class="action ghost" data-act="pback" aria-label="Back one screen">‹ Back</button><button class="action ghost" data-act="prestart">Restart</button><span class="mute small" id="pwhere"></span></div><div class="screen" id="screen"><div class="ds" id="playds"></div></div><p class="mute small" style="margin:12px 0 0;max-width:56ch">Click what you would tap. A click on nothing shows what can be clicked. ' + (DATA.meta.platform === "web" ? "" : "Drawn in the browser with this system's values; the real screens are drawn by the app (" + esc(DATA.meta.platform) + ").") + "</p>" },
      { title: "View", cls: "narrow", id: "f-controls", html: controls },
    ].concat(SCREEN_IDS.map(function (id) { return { title: "Screen · " + (SCREENS[id].title || id), id: "s-" + id, cls: "mapscreen", html: '<div class="screen" style="width:' + deviceWidth() + 'px"><div class="ds" data-map="' + esc(id) + '"></div></div>' }; }));
  }

  /* ---- the prototype: this project's screens, written as blocks, linked by `to` ---- */
  var PROTO = DATA.prototype || { screens: {} }, SCREENS = PROTO.screens || {}, SCREEN_IDS = Object.keys(SCREENS);
  var nav = { at: SCREENS[PROTO.start] ? PROTO.start : SCREEN_IDS[0], back: [], toast: "" };
  function deviceWidth() { return DATA.meta.platform === "game" ? 640 : play.width || 960; }
  function to(b) { return b && b.to ? ' data-to="' + esc(b.to) + '"' + (b.toast ? ' data-toast="' + esc(b.toast) + '"' : "") : ""; }
  function block(b) {
    var t = b.type, h = "";
    if (t === "bar") return '<div class="bar">' + (b.back ? '<span class="tap" data-to="back" aria-label="Back">‹</span>' : "") + "<b style=\"flex:1\">" + esc(b.title) + "</b>" + (b.action ? '<span class="tap"' + to(b.action) + ">" + esc(b.action.label) + "</span>" : "") + "</div>";
    if (t === "heading") return '<p class="heading">' + esc(b.text) + "</p>";
    if (t === "text") return '<p class="' + (b.muted ? "sub" : "") + '" style="margin:0">' + esc(b.text) + "</p>";
    if (t === "total") return '<div><div class="sub">' + esc(b.label) + '</div><div class="total">' + esc(b.value) + "</div></div>";
    if (t === "list") return "<div>" + (b.rows || []).map(function (r) { return '<div class="lrow' + (r.to ? " tap" : "") + '"' + to(r) + "><span>" + esc(r.title) + (r.sub ? '<br><span class="sub">' + esc(r.sub) + "</span>" : "") + "</span>" + (r.badge ? '<span class="badge">' + esc(r.badge) + "</span>" : r.switch ? '<span class="switch"></span>' : "<span class=\"num\">" + esc(r.value || "") + "</span>") + "</div>"; }).join("") + "</div>";
    if (t === "field") return '<div' + (b.error ? ' data-state="error"' : "") + '><div class="field"><label>' + esc(b.label) + '</label><input value="' + esc(b.value || "") + '" placeholder="' + esc(b.placeholder || "") + '"><span class="help">' + esc(b.help || "") + '</span><span class="err">' + esc(b.error || "") + "</span></div></div>";
    if (t === "buttons") return '<div class="row">' + (b.items || []).map(function (x, i) { return '<button class="btn ' + (x.variant === "secondary" ? "sec" : x.variant === "danger" ? "danger" : "") + (i === 0 ? " first" : "") + '"' + (x.disabled ? " disabled" : "") + to(x) + ">" + esc(x.label) + "</button>"; }).join("") + "</div>";
    if (t === "tabs") return '<div class="tabs">' + (b.items || []).map(function (x) { return '<span class="' + (x.on ? "on" : "") + (x.to ? " tap" : "") + '"' + to(x) + ">" + esc(x.label) + "</span>"; }).join("") + "</div>";
    if (t === "nav") return '<div class="navbar">' + (b.items || []).map(function (x) { return '<span class="' + (x.on ? "on" : "") + (x.to ? " tap" : "") + '"' + to(x) + ">" + esc(x.label) + "</span>"; }).join("") + "</div>";
    if (t === "card") return '<div class="card col' + (b.to ? " tap" : "") + '"' + to(b) + ">" + (b.blocks || []).map(block).join("") + "</div>";
    if (t === "meter") return "<div>" + (b.label ? '<div class="sub">' + esc(b.label) + "</div>" : "") + '<div class="meter"><i style="width:' + (Number(b.value) || 0) + '%"></i></div></div>';
    if (t === "toast") return '<div class="toast"><span>' + esc(b.text) + "</span>" + (b.action ? "<b class=\"tap\"" + to(b.action) + ">" + esc(b.action.label) + "</b>" : "") + "</div>";
    if (t === "empty") return '<div class="col" style="align-items:center;text-align:center;padding:32px 0"><p class="heading">' + esc(b.title) + '</p><p class="sub" style="margin:0">' + esc(b.text) + "</p>" + (b.button ? '<button class="btn first"' + to(b.button) + ">" + esc(b.button.label) + "</button>" : "") + "</div>";
    if (t === "dialog") return '<div class="scrim"><div class="card col dlg"><p class="heading">' + esc(b.title) + "</p><span>" + esc(b.text || "") + '</span><div class="row" style="justify-content:flex-end">' + (b.buttons || []).map(function (x) { return '<button class="btn ' + (x.variant === "danger" ? "danger" : x.variant === "primary" ? "" : "sec") + '"' + to(x) + ">" + esc(x.label) + "</button>"; }).join("") + "</div></div></div>";
    /* a game's screens */
    if (t === "title") return '<div class="gtitle"><div class="big">' + esc(b.text) + "</div>" + (b.sub ? '<div class="tap blink"' + to(b) + ">" + esc(b.sub) + "</div>" : "") + "</div>";
    if (t === "menu") return '<div class="hud-menu card col' + (b.center ? " center" : "") + '"><p class="heading">' + esc(b.title) + "</p>" + (b.rows || []).map(function (r, i) { return '<div class="mrow' + (i === 0 ? " on" : "") + (r.to ? " tap" : "") + '"' + to(r) + "><span style=\"flex:1\">" + esc(r.label) + "</span><span>" + esc(r.value || "") + "</span></div>"; }).join("") + "</div>";
    if (t === "hud") return '<div class="hud-top"><span class="mm"></span><span>' + esc(b.clock || "") + '</span><span class="gold">◆ ' + esc(b.gold || "") + "</span><span>" + esc(b.score || "") + '</span><span style="flex:1"></span>' + (b.pause ? '<span class="tap"' + to(b.pause) + ">" + esc(b.pause.label) + "</span>" : "") + '</div><div class="hud-world"><div class="unit"><div class="hp"><i></i></div><div class="body"></div><small>YOU</small></div><div class="unit foe"><div class="hp"><i></i></div><div class="body"></div></div></div><div class="hud-orbs">' + (b.orbs || []).map(function (o, i, a) { return '<span class="orb' + (i === a.length - 1 ? " auto" : "") + (o.to ? " tap" : "") + '"' + to(o) + ">" + esc(o.label) + "</span>"; }).join("") + "</div>";
    return '<p class="sub">unknown block: ' + esc(t) + "</p>";
  }
  function screenHtml(id) {
    var sc = SCREENS[id]; if (!sc) return '<p style="padding:16px">No such screen: ' + esc(id) + "</p>";
    var game = DATA.meta.platform === "game", blocks = sc.blocks || [];
    var fixed = function (b) { return b.type === "bar" || b.type === "nav" || b.type === "dialog" || b.type === "hud" || b.type === "menu" || b.type === "title"; };
    var head = blocks.filter(function (b) { return b.type === "bar"; }).map(block).join(""), foot = blocks.filter(function (b) { return b.type === "nav"; }).map(block).join("");
    var over = blocks.filter(function (b) { return b.type === "dialog"; }).map(block).join("");
    if (game) return '<div class="hud" data-state="' + esc(play.state) + '">' + blocks.map(block).join("") + "</div>";
    return '<div class="screenv" data-state="' + esc(play.state) + '">' + head + '<div class="pad col" style="flex:1">' + blocks.filter(function (b) { return !fixed(b); }).map(block).join("") + "</div>" + foot + over + "</div>";
  }
  function drawProto() {
    var el = $("#playds"); if (!el) return;
    el.innerHTML = screenHtml(nav.at) + (nav.toast ? '<div class="arrive toast"><span>' + esc(nav.toast) + "</span></div>" : "");
    $("#pwhere").textContent = (SCREENS[nav.at] && SCREENS[nav.at].title || nav.at) + " · " + (SCREEN_IDS.indexOf(nav.at) + 1) + " of " + SCREEN_IDS.length;
    document.querySelectorAll("[data-map]").forEach(function (m) { m.innerHTML = screenHtml(m.dataset.map); m.closest(".frame").classList.toggle("current", m.dataset.map === nav.at); });
    if (nav.toast) { var shown = nav.toast; setTimeout(function () { if (nav.toast === shown) { nav.toast = ""; var a = $("#playds .arrive"); if (a) a.remove(); } }, 2600); }
  }
  function go(target, toast) {
    if (target === "back") { if (nav.back.length) nav.at = nav.back.pop(); } else if (SCREENS[target]) { if (target !== nav.at) nav.back.push(nav.at); nav.at = target; }
    nav.toast = toast || ""; drawProto();
  }
  /* the arrows between screens, like the noodles of a prototype */
  function drawArrows() {
    var svg = $("#arrows"); if (svg) svg.remove();
    if (!cur || cur.id !== "play") return;
    var ns = "http://www.w3.org/2000/svg"; svg = document.createElementNS(ns, "svg"); svg.id = "arrows"; svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>';
    var seen = {};
    SCREEN_IDS.forEach(function (id) {
      var from = document.getElementById("s-" + id); if (!from) return;
      from.querySelectorAll("[data-to]").forEach(function (h) {
        // the bar that is on every screen would draw an arrow from each to each: the map shows the ways through, not those
        var tid = h.dataset.to; if (tid === "back" || tid === id || seen[id + ">" + tid] || h.closest(".navbar")) return;
        var dest = document.getElementById("s-" + tid); if (!dest) return; seen[id + ">" + tid] = 1;
        var x1 = from.offsetLeft + from.offsetWidth, y1 = from.offsetTop + Math.min(from.offsetHeight - 24, 80 + Object.keys(seen).length % 5 * 28), x2 = dest.offsetLeft, y2 = dest.offsetTop + 80;
        if (x2 < x1) { x1 = from.offsetLeft + from.offsetWidth / 2; y1 = from.offsetTop + from.offsetHeight; x2 = dest.offsetLeft + dest.offsetWidth / 2; y2 = dest.offsetTop - 26; }
        var dx = Math.max(40, Math.abs(x2 - x1) / 2), p = document.createElementNS(ns, "path");
        p.setAttribute("d", x2 >= x1 && y1 !== from.offsetTop + from.offsetHeight ? "M" + x1 + " " + y1 + " C" + (x1 + dx) + " " + y1 + " " + (x2 - dx) + " " + y2 + " " + x2 + " " + y2 : "M" + x1 + " " + y1 + " C" + x1 + " " + (y1 + 60) + " " + x2 + " " + (y2 - 60) + " " + x2 + " " + y2);
        p.setAttribute("marker-end", "url(#ah)"); svg.appendChild(p);
      });
    });
    world.insertBefore(svg, world.firstChild);
  }

  function refreshPlay() {
    var el = $("#playds"); if (!el) return;
    var vars = dsVars(T, play.theme);
    document.querySelectorAll("#playds, [data-map]").forEach(function (x) { x.setAttribute("style", vars); });
    document.querySelectorAll("#screen, .mapscreen .screen").forEach(function (x) { x.style.width = deviceWidth() + "px"; });
    drawProto();
  }

  /* ---------- canvas ---------- */
  var stage = $("#stage"), world = $("#world"), view = { x: 48, y: 72, k: 1 }, views = {}, cur = null;
  function apply() { world.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.k + ")"; $("#zoom").textContent = Math.round(view.k * 100) + "%"; stage.style.backgroundSize = (24 * view.k) + "px " + (24 * view.k) + "px"; stage.style.backgroundPosition = view.x + "px " + view.y + "px"; }
  function zoomAt(cx, cy, k) { k = Math.max(0.1, Math.min(4, k)); view.x = cx - (cx - view.x) * (k / view.k); view.y = cy - (cy - view.y) * (k / view.k); view.k = k; apply(); }
  function fit(whole) {
    var fr = world.querySelectorAll(".frame"); if (!fr.length) return;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    fr.forEach(function (f) { x0 = Math.min(x0, f.offsetLeft); y0 = Math.min(y0, f.offsetTop - 28); x1 = Math.max(x1, f.offsetLeft + f.offsetWidth); y1 = Math.max(y1, f.offsetTop + f.offsetHeight); });
    var W = stage.clientWidth, H = stage.clientHeight, k = Math.max(0.1, Math.min(1, (W - 96) / (x1 - x0), (H - 144) / (y1 - y0)));
    // a page opens readable: full size from its top-left corner, smaller only when a frame is wider than the window
    if (!whole) { var k0 = Math.max(0.5, Math.min(1, (W - 96) / (x1 - x0))); view.k = k0; view.x = 48 - x0 * k0; view.y = 48 - y0 * k0; apply(); return; }
    view.k = k; view.x = (W - (x1 - x0) * k) / 2 - x0 * k; view.y = Math.max(48, (H - (y1 - y0) * k) / 2) - y0 * k; apply();
  }
  function savePos() { var all = store.get("pos") || {}, p = {}; world.querySelectorAll(".frame").forEach(function (f, i) { p[i] = [f.offsetLeft, f.offsetTop]; }); all[cur.id] = p; store.set("pos", all); }
  function layout() {
    var saved = (store.get("pos") || {})[cur.id] || {}, x = 0, y = 32, rowH = 0, wrap = Math.max(960, stage.clientWidth - 96);
    if (cur.id === "play" && !Object.keys(saved).length) return layoutPlay();
    world.querySelectorAll(".frame").forEach(function (f, i) {
      if (saved[i]) { f.style.left = saved[i][0] + "px"; f.style.top = saved[i][1] + "px"; return; }
      if (x > 0 && x + f.offsetWidth > wrap) { x = 0; y += rowH + 72; rowH = 0; }
      f.style.left = x + "px"; f.style.top = y + "px"; x += f.offsetWidth + 48; rowH = Math.max(rowH, f.offsetHeight);
    });
  }
  /* the interactive page: the prototype and its tools in a row, then the screens as a map, a column per step away from the start */
  function layoutPlay() {
    var x = 0, top = 0;
    world.querySelectorAll(".frame:not(.mapscreen)").forEach(function (f) { f.style.left = x + "px"; f.style.top = "32px"; x += f.offsetWidth + 48; top = Math.max(top, f.offsetHeight); });
    var depth = {}, queue = [nav.at && SCREENS[PROTO.start] ? PROTO.start : SCREEN_IDS[0]]; depth[queue[0]] = 0;
    while (queue.length) {
      var id = queue.shift(), el = document.getElementById("s-" + id); if (!el) continue;
      el.querySelectorAll("[data-to]").forEach(function (h) { var t = h.dataset.to; if (t !== "back" && SCREENS[t] && depth[t] === undefined) { depth[t] = depth[id] + 1; queue.push(t); } });
    }
    var rowY = {}, y0 = top + 32 + 160;
    SCREEN_IDS.forEach(function (id) {
      var el = document.getElementById("s-" + id); if (!el) return;
      var d = depth[id] === undefined ? 0 : depth[id];
      el.style.left = d * (el.offsetWidth + 200) + "px"; el.style.top = y0 + (rowY[d] || 0) + "px"; rowY[d] = (rowY[d] || 0) + el.offsetHeight + 96;
    });
  }
  function show(id) {
    if (cur) views[cur.id] = { x: view.x, y: view.y, k: view.k };
    cur = PAGES.filter(function (p) { return p.id === id; })[0] || PAGES[0];
    world.innerHTML = "";
    framesFor(cur).forEach(function (f) {
      var el = document.createElement("div"); el.className = "frame " + (f.cls || ""); if (f.id) el.id = f.id;
      el.innerHTML = '<div class="bar">' + esc(f.title) + '</div><div class="body">' + f.html + "</div>"; world.appendChild(el);
    });
    if (cur.id === "play") refreshPlay();
    layout(); drawArrows();
    document.querySelectorAll("#pages button").forEach(function (b) { if (b.dataset.page === cur.id) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    $("#nav").classList.remove("open");
    if (views[cur.id]) { view = views[cur.id]; apply(); } else fit();
    try { history.replaceState(null, "", "#" + cur.id); } catch (e) { /* file pages may refuse */ }
  }

  /* pointer: pan the canvas, move a frame, pinch to zoom */
  var pts = {}, drag = null, pinch = null;
  var INTERACTIVE = "input, textarea, select, button, a, summary, label, [data-to], #playds";
  stage.addEventListener("pointerdown", function (e) {
    if (e.target.closest("#tools")) return;
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pts);
    if (ids.length === 2) { var a = pts[ids[0]], b = pts[ids[1]]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k }; drag = null; return; }
    var handle = e.target.closest(".frame > .bar");
    if (handle && !e.target.closest("button")) { var el = handle.parentElement; drag = { el: el, sx: e.clientX, sy: e.clientY, ox: el.offsetLeft, oy: el.offsetTop }; }
    else if (!e.target.closest(INTERACTIVE)) drag = { pan: true, sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    if (drag) { stage.setPointerCapture(e.pointerId); if (drag.pan) stage.classList.add("panning"); }
  });
  stage.addEventListener("pointermove", function (e) {
    if (!pts[e.pointerId]) return;
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pts);
    if (pinch && ids.length === 2) { var a = pts[ids[0]], b = pts[ids[1]], r = stage.getBoundingClientRect(); zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d); return; }
    if (!drag) return;
    if (drag.pan) { view.x = drag.ox + e.clientX - drag.sx; view.y = drag.oy + e.clientY - drag.sy; apply(); }
    else { drag.el.style.left = drag.ox + (e.clientX - drag.sx) / view.k + "px"; drag.el.style.top = drag.oy + (e.clientY - drag.sy) / view.k + "px"; if (drag.el.classList.contains("mapscreen")) drawArrows(); }
  });
  function up(e) {
    delete pts[e.pointerId]; if (Object.keys(pts).length < 2) pinch = null;
    if (drag && !drag.pan) savePos();
    drag = null; stage.classList.remove("panning");
  }
  stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
  stage.addEventListener("wheel", function (e) {
    e.preventDefault(); var r = stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, view.k * Math.exp(-e.deltaY * 0.0025));
    else { view.x -= e.deltaX; view.y -= e.deltaY; apply(); }
  }, { passive: false });
  document.addEventListener("click", function (e) {
    var hot = e.target.closest("[data-to]");
    if (hot && hot.closest(".ds")) { go(hot.dataset.to, hot.dataset.toast); return; }
    var proto = e.target.closest("#playds");
    if (proto && !e.target.closest("input, select")) { proto.classList.remove("hint"); void proto.offsetWidth; proto.classList.add("hint"); return; }
    var b = e.target.closest("button"); if (!b) return;
    if (b.dataset.page) return show(b.dataset.page);
    var seg = b.closest("[data-seg]");
    if (seg) {
      var name = seg.dataset.seg; play[name] = name === "width" ? Number(b.dataset.v) : b.dataset.v;
      if (name === "theme" || name === "width") { var keep = { x: view.x, y: view.y, k: view.k }; views.play = keep; cur = null; show("play"); return; }
      seg.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); refreshPlay(); return;
    }
    var act = b.dataset.act, r = stage.getBoundingClientRect();
    if (act === "in") zoomAt(r.width / 2, r.height / 2, view.k * 1.25);
    else if (act === "out") zoomAt(r.width / 2, r.height / 2, view.k / 1.25);
    else if (act === "fit") fit(true);
    else if (act === "menu") $("#nav").classList.toggle("open");
    else if (act === "tidy") { var all = store.get("pos") || {}; delete all[cur.id]; store.set("pos", all); var id = cur.id; delete views[id]; cur = null; show(id); }
    else if (act === "pback") go("back");
    else if (act === "prestart") { nav.back = []; nav.at = SCREENS[PROTO.start] ? PROTO.start : SCREEN_IDS[0]; nav.toast = ""; drawProto(); }
    else if (act === "play") { document.querySelectorAll(".motion-track").forEach(function (m) { m.classList.remove("go"); var dot = m.firstChild; dot.style.transition = "none"; void dot.offsetWidth; dot.style.transition = "left " + (Number(m.dataset.ms) || 0) + "ms ease"; m.classList.add("go"); }); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.target.closest("input, textarea, select")) return;
    var i = PAGES.indexOf(cur), r = stage.getBoundingClientRect();
    if (e.key === "]" || e.key === "PageDown") show(PAGES[Math.min(PAGES.length - 1, i + 1)].id);
    else if (e.key === "[" || e.key === "PageUp") show(PAGES[Math.max(0, i - 1)].id);
    else if (e.key === "0") fit(true);
    else if (e.key === "+" || e.key === "=") zoomAt(r.width / 2, r.height / 2, view.k * 1.25);
    else if (e.key === "-") zoomAt(r.width / 2, r.height / 2, view.k / 1.25);
  });

  /* ---------- start ---------- */
  $("#nav h1").textContent = DATA.meta.name;
  $("#nav .meta").textContent = DATA.meta.platform + " · " + (DATA.meta.state === "approved" ? "v" + DATA.meta.version + ", signed" : DATA.meta.state === "draft" ? "draft" : "v" + DATA.meta.version + ", changed");
  $("#pages").innerHTML = PAGES.map(function (p, i) { return (i === 1 || p.id === "play" ? '<li class="sep" role="separator"></li>' : "") + '<li><button data-page="' + esc(p.id) + '"><span class="n">' + esc(p.n) + "</span><span>" + esc(p.label) + "</span></button></li>"; }).join("");
  show((location.hash || "").slice(1) || "cover");
  window.addEventListener("resize", function () { apply(); });
})();
