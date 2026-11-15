/**
 * frontmatter-list.mjs — leaf helper: read a list-valued frontmatter key.
 *
 * parseFrontmatterList(fmBlock, key) -> { items, form, raw }
 *   form: "inline" ([a, b]) | "multiline" ([a,\n b], items complete) | "bare" (a, b)
 *         | "block" (- a lines) | "empty"
 *
 * Tolerant by design: strips BOM, CRLF, trailing `# comments` and quotes;
 * applies NO id regex (works for F-ids, T-ids, "GH-6", paths); never throws.
 * Callers decide policy (deny / warn / refuse) from `form` and `items`.
 * Imports nothing from the package (avoids cycles with terminal-gate).
 */

// Strip a trailing `# comment`, but only outside quotes (`["b # c"]` keeps `b # c`).
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      // An apostrophe inside a bare word is not a quote opener.
      if (i === 0 || /[\s,\[]/.test(s[i - 1])) q = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trim();
    }
  }
  return s.trim();
}

// Index of the first `]` outside quotes, or -1.
function closeIndex(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s,\[]/.test(s[i - 1])) q = c;
    } else if (c === "]") return i;
  }
  return -1;
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

// Split on commas that are outside quotes: `["a.c#one,two", "b.c"]` is two
// items, not three. Splitting on every comma left a stray quote on both
// halves, and a step's declared file then matched nothing (seen live).
export function splitItems(s) {
  const out = [];
  let q = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === start || /[\s,\[]/.test(s[i - 1])) q = c;
    } else if (c === ",") {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map(unquote).filter(Boolean);
}

export function parseFrontmatterList(fmBlock, key) {
  const empty = { items: [], form: "empty", raw: "" };
  try {
    if (typeof fmBlock !== "string" || typeof key !== "string" || !key) return empty;
    let text = fmBlock.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const m = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    if (m) text = m[1];
    const lines = text.split("\n");
    const prefix = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:(.*)$`);
    for (let i = 0; i < lines.length; i++) {
      const km = lines[i].match(prefix);
      if (!km) continue;
      const rawRest = km[1].trim();
      const rest = rawRest.startsWith("[") ? rawRest : stripComment(rawRest);
      if (rest === "") {
        // Possible block list: following "- item" lines.
        const items = [];
        const rawLines = [];
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (/^\s*(#.*)?$/.test(l)) continue;
          const bm = l.match(/^\s*-\s*(.*)$/);
          if (!bm) break;
          rawLines.push(l);
          const v = unquote(stripComment(bm[1]));
          if (v) items.push(v);
        }
        if (rawLines.length) return { items, form: "block", raw: rawLines.join("\n") };
        return empty;
      }
      if (rest.startsWith("[")) {
        // `#` inside the brackets is item text (`[JIRA-1, #7]`); a comment
        // only counts after the closing `]`, or on a line that never closes.
        let joined = rest.slice(1);
        let multiline = false;
        let ci = closeIndex(joined);
        if (ci === -1) joined = stripComment(joined);
        for (let j = i + 1; ci === -1 && j < lines.length; j++) {
          multiline = true;
          const cj = closeIndex(lines[j]);
          joined += " " + (cj === -1 ? stripComment(lines[j]) : lines[j].slice(0, cj + 1));
          ci = closeIndex(joined);
        }
        const inner = ci === -1 ? joined : joined.slice(0, ci);
        const items = splitItems(inner);
        if (multiline) return { items, form: "multiline", raw: joined };
        return { items, form: items.length ? "inline" : "empty", raw: rest };
      }
      const items = splitItems(rest);
      return { items, form: items.length ? "bare" : "empty", raw: rest };
    }
    return empty;
  } catch {
    return empty;
  }
}
