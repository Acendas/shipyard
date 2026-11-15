/**
 * Image adapter (E005, v4.4): pixel diff of two PNG files with no browser.
 *
 * Why: a project whose screens are drawn by its own renderer (a C/SDL game, a
 * terminal UI, a native app) has frames and device screenshots, not URLs. Its
 * approved design snapshot still deserves a diff, so `ui verify --level screen`
 * accepts `{image: <png>}` in place of `{url}` and compares it here — adapter
 * `none` included. Same semantics as the web adapter's in-page diff: per-pixel
 * RGB distance over `threshold * 255 * 3`, rectangle masks excluded, pass when
 * the differing ratio is within `maxDiffRatio` and the sizes match.
 *
 * The decoder covers what screenshots and exports produce: 8-bit (and 16-bit,
 * downscaled) greyscale, RGB, palette, grey+alpha and RGBA, non-interlaced, all
 * five filter types. Interlaced PNGs are refused with a clear error.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { dirname } from "node:path";

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decode a PNG file to { width, height, data: Uint8Array(RGBA) }. */
export function decodePng(path) {
  const buf = readFileSync(path);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error(`${path}: not a PNG`);
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!width || !height) throw new Error(`${path}: missing IHDR`);
  if (interlace) throw new Error(`${path}: interlaced PNGs are not supported — re-export without Adam7 interlacing`);
  if (![1, 2, 4, 8, 16].includes(depth)) throw new Error(`${path}: unsupported bit depth ${depth}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`${path}: unsupported colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let off = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[off++];
    const line = new Uint8Array(raw.buffer, raw.byteOffset + off, stride);
    off += stride;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, x = line[i];
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error(`${path}: bad filter ${filter} on row ${y}`);
      }
      cur[i] = v & 255;
    }
    // unpack samples
    const sample = (idx) => {
      if (depth === 8) return cur[idx];
      if (depth === 16) return cur[idx * 2]; // high byte
      const perByte = 8 / depth, byte = cur[Math.floor(idx / perByte)], shift = 8 - depth * ((idx % perByte) + 1);
      const v = (byte >> shift) & ((1 << depth) - 1);
      return colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
    };
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 0) { const g = sample(x); out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = trns && trns.length >= 2 && g === trns.readUInt16BE(0) ? 0 : 255; }
      else if (colorType === 2) { out[o] = sample(x * 3); out[o + 1] = sample(x * 3 + 1); out[o + 2] = sample(x * 3 + 2); out[o + 3] = 255; }
      else if (colorType === 3) { const i = sample(x); out[o] = palette[i * 3]; out[o + 1] = palette[i * 3 + 1]; out[o + 2] = palette[i * 3 + 2]; out[o + 3] = trns && i < trns.length ? trns[i] : 255; }
      else if (colorType === 4) { const g = sample(x * 2); out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = sample(x * 2 + 1); }
      else { out[o] = sample(x * 4); out[o + 1] = sample(x * 4 + 1); out[o + 2] = sample(x * 4 + 2); out[o + 3] = sample(x * 4 + 3); }
    }
    prev = cur;
  }
  return { width, height, data: out };
}

/** Composite RGBA over white into an RGB triple (what the browser canvas does for the diff). */
function overWhite(d, o) {
  const a = d[o + 3] / 255;
  return [Math.round(d[o] * a + 255 * (1 - a)), Math.round(d[o + 1] * a + 255 * (1 - a)), Math.round(d[o + 2] * a + 255 * (1 - a))];
}

/** Diff two PNG paths. `masks` are {x,y,w,h} rectangles in pixels. Same result shape as the web adapter. */
export function diffPng({ baselinePath, currentPath, masks = [], threshold = 0.1, maxDiffRatio = 0.01 }) {
  const ia = decodePng(baselinePath), ib = decodePng(currentPath);
  const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
  const masked = new Uint8Array(w * h);
  for (const r of masks) {
    if (r.x === undefined) continue; // selector masks need a DOM; ignored here
    for (let y = Math.max(0, r.y | 0); y < Math.min(h, (r.y + r.h) | 0); y++) for (let x = Math.max(0, r.x | 0); x < Math.min(w, (r.x + r.w) | 0); x++) masked[y * w + x] = 1;
  }
  const px = (img, x, y) => (x < img.width && y < img.height ? overWhite(img.data, (y * img.width + x) * 4) : [255, 255, 255]);
  let diff = 0, total = 0;
  const t = threshold * 255 * 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (masked[y * w + x]) continue;
    total++;
    const a = px(ia, x, y), b = px(ib, x, y);
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > t) diff++;
  }
  const ratio = total ? diff / total : 0;
  return { width: w, height: h, size_changed: ia.width !== ib.width || ia.height !== ib.height, compared: total, differing: diff, ratio, pass: ratio <= maxDiffRatio && ia.width === ib.width && ia.height === ib.height };
}

// ---------------------------------------------------------------------------
// Look comparison (v4.8): a mockup is a drawing, not a frame.
//
// A design approved as a mockup (a proposal sketch, a page export, a photo of
// a device) never matches a rendered frame pixel for pixel: the first real use
// measured 91% "different" for a HUD that follows its proposal zone for zone.
// So a mockup is compared by eye, and this module makes that cheap and
// checkable: it cuts the screen out of the design (crop), scales it to the
// frame, and writes design | delivered as ONE image a reviewer and the owner
// open. It also reports two numbers in 0..1:
//   layout  — share of coarse grid cells whose mean colour is close to the design's
//   palette — overlap of the two colour histograms (5 levels per channel)
// Calibrated on a real game: for a faithful mockup (real art, real size) the
// right screens scored 42-51% / 47-77% and unrelated screens 7-17% / 9%; for
// a schematic mockup (flat boxes) the numbers did NOT separate right from
// wrong. They are therefore information, never a verdict, unless the project
// sets its own bar (ui.min_layout / ui.min_palette).
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Encode { width, height, data: RGBA } as an 8-bit RGBA PNG. */
export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); }
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const td = Buffer.concat([Buffer.from(type, "latin1"), body]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Flatten onto white and drop alpha: { width, height, rgb: Uint8Array(w*h*3) }. */
function flatten(img) {
  const rgb = new Uint8Array(img.width * img.height * 3);
  for (let i = 0, n = img.width * img.height; i < n; i++) { const p = overWhite(img.data, i * 4); rgb[i * 3] = p[0]; rgb[i * 3 + 1] = p[1]; rgb[i * 3 + 2] = p[2]; }
  return { width: img.width, height: img.height, rgb };
}
function crop(f, r) {
  const x0 = Math.max(0, r[0] | 0), y0 = Math.max(0, r[1] | 0);
  const w = Math.max(1, Math.min(f.width - x0, r[2] | 0)), h = Math.max(1, Math.min(f.height - y0, r[3] | 0));
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) rgb.set(f.rgb.subarray(((y0 + y) * f.width + x0) * 3, ((y0 + y) * f.width + x0 + w) * 3), y * w * 3);
  return { width: w, height: h, rgb };
}
/** Area-average resample to w x h (nearest when enlarging). */
function resample(f, w, h) {
  if (f.width === w && f.height === h) return f;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * f.height) / h), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * f.height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * f.width) / w), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * f.width) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < f.height; sy++) for (let sx = sx0; sx < sx1 && sx < f.width; sx++) { const o = (sy * f.width + sx) * 3; r += f.rgb[o]; g += f.rgb[o + 1]; b += f.rgb[o + 2]; n++; }
      const o = (y * w + x) * 3; rgb[o] = r / n; rgb[o + 1] = g / n; rgb[o + 2] = b / n;
    }
  }
  return { width: w, height: h, rgb };
}

/**
 * Compare a design mockup with a rendered frame by look.
 * @param {object} o  { baselinePath, currentPath, crop?: [x,y,w,h] of the design, masks?: [{x,y,w,h}] in frame pixels, cellTolerance? }
 * @returns { layout, palette, cell, cells, differing_cells, width, height, resized, design, frame, mismatch }
 */
export function lookCompare({ baselinePath, currentPath, crop: cropRect = null, masks = [], cellTolerance = 0.14 }) {
  const cur = flatten(decodePng(currentPath));
  let des = flatten(decodePng(baselinePath));
  const original = { width: des.width, height: des.height };
  if (cropRect) des = crop(des, cropRect);
  const resized = des.width !== cur.width || des.height !== cur.height;
  des = resample(des, cur.width, cur.height);
  const w = cur.width, h = cur.height;
  const cell = Math.max(4, Math.round(w / 40));
  const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
  const maskedCell = (cx, cy) => masks.some((r) => r.x !== undefined && cx * cell < r.x + r.w && (cx + 1) * cell > r.x && cy * cell < r.y + r.h && (cy + 1) * cell > r.y);
  const mean = (f, cx, cy) => { let r = 0, g = 0, b = 0, n = 0; for (let y = cy * cell; y < Math.min(h, (cy + 1) * cell); y++) for (let x = cx * cell; x < Math.min(w, (cx + 1) * cell); x++) { const o = (y * w + x) * 3; r += f.rgb[o]; g += f.rgb[o + 1]; b += f.rgb[o + 2]; n++; } return [r / n, g / n, b / n]; };
  const mismatch = new Uint8Array(cols * rows);
  let cells = 0, bad = 0;
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    if (maskedCell(cx, cy)) continue;
    cells++;
    const a = mean(des, cx, cy), b = mean(cur, cx, cy);
    if ((Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / (3 * 255) > cellTolerance) { bad++; mismatch[cy * cols + cx] = 1; }
  }
  const hist = (f) => { const hgm = new Float64Array(125); let n = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (masks.some((r) => r.x !== undefined && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) continue; const o = (y * w + x) * 3; hgm[Math.min(4, f.rgb[o] / 52 | 0) * 25 + Math.min(4, f.rgb[o + 1] / 52 | 0) * 5 + Math.min(4, f.rgb[o + 2] / 52 | 0)]++; n++; } if (n) for (let i = 0; i < 125; i++) hgm[i] /= n; return hgm; };
  const ha = hist(des), hb = hist(cur);
  let palette = 0; for (let i = 0; i < 125; i++) palette += Math.min(ha[i], hb[i]);
  return { layout: cells ? 1 - bad / cells : 1, palette, cell, cols, rows, cells, differing_cells: bad, width: w, height: h, resized, design_size: original, design: des, frame: cur, mismatch };
}

/** Write design | delivered as one PNG (the design cropped and scaled to the frame's size). Returns the path. */
export function writeSideBySide(look, outPath) {
  const { width: w, height: h, design, frame } = look;
  const gap = 4, W = w * 2 + gap;
  const data = new Uint8Array(W * h * 4).fill(255);
  const put = (f, ox) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3, d = (y * W + ox + x) * 4;
      data[d] = f.rgb[s]; data[d + 1] = f.rgb[s + 1]; data[d + 2] = f.rgb[s + 2]; data[d + 3] = 255;
    }
  };
  put(design, 0); put(frame, w + gap);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, encodePng({ width: W, height: h, data }));
  return outPath;
}
