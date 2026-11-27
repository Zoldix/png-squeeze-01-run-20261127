// png-squeeze: rewrite each 1280x720 RGBA screenshot in /input/<id>/image.png as the smallest
// lossless PNG we can build with Node's built-in zlib, and write it to /output/<id>/image.png.
//
// Method (all decisions are pure functions of the pixels, so two runs write the same bytes):
//   1. Decode the stored PNG to raw RGBA.
//   2. Analyse it: is every pixel opaque? grey? at most 256 distinct colours? is there a single
//      fully transparent colour that no opaque pixel uses (a tRNS key)?
//   3. Screen the lossless forms those answers allow (palette in two orders, grey, grey+alpha,
//      RGB, RGBA, with a tRNS key where one exists). Each form's rows are filtered several ways:
//      each fixed filter, the minimum-sum heuristic, the fewest-distinct-pairs heuristic, and for
//      narrow forms a per-row brute force that weighs each filter by deflating the row against
//      the bytes already written. Forms are weighed by a level-6 zlib stream of their data.
//   4. The best few filtered data sets are re-deflated at level 9 (memLevel 8 and 9, default
//      and filtered strategies) and the smallest verified stream wins.
//   5. The winning PNG is decoded again and compared pixel by pixel with the source; only an
//      exact match is written. If anything goes wrong the input file is copied instead, which
//      is always exact, so every instance stays answered.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ PNG basics */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(data.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function pngOf(chunks) {
  let total = 8;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function ihdr(width, height, colourType) {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Filter one row of samples into out (without the filter byte). prev may be null. */
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
    return;
  }
  for (let x = 0; x < n; x++) {
    const left = x >= bpp ? cur[x - bpp] : 0;
    const up = prev === null ? 0 : prev[x];
    const upLeft = prev === null || x < bpp ? 0 : prev[x - bpp];
    let pred = 0;
    if (type === 1) pred = left;
    else if (type === 2) pred = up;
    else if (type === 3) pred = (left + up) >> 1;
    else pred = paeth(left, up, upLeft);
    out[x] = (cur[x] - pred) & 0xff;
  }
}

/** Undo one row's filter in place: row holds filtered bytes, prev the row above (or null). */
function unfilterRow(type, row, prev, bpp) {
  const n = row.length;
  if (type === 0) return;
  for (let x = 0; x < n; x++) {
    const left = x >= bpp ? row[x - bpp] : 0;
    const up = prev === null ? 0 : prev[x];
    const upLeft = prev === null || x < bpp ? 0 : prev[x - bpp];
    let pred = 0;
    if (type === 1) pred = left;
    else if (type === 2) pred = up;
    else if (type === 3) pred = (left + up) >> 1;
    else pred = paeth(left, up, upLeft);
    row[x] = (row[x] + pred) & 0xff;
  }
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decode a PNG the contest accepts (bit depth 8, colour types 0/2/3/4/6, no interlace)
 * to raw RGBA bytes. Returns null when the file does not read.
 */
function decodePng(bytes) {
  try {
    if (bytes.length < 8) return null;
    for (let i = 0; i < 8; i++) if (bytes[i] !== [137, 80, 78, 71, 13, 10, 26, 10][i]) return null;
    let pos = 8;
    let head = null;
    let plte = null;
    let trns = null;
    const idat = [];
    let idatLen = 0;
    while (pos + 12 <= bytes.length) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset + pos);
      const len = dv.getUint32(0);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      const data = bytes.subarray(pos + 8, pos + 8 + len);
      if (type === 'IHDR') head = data;
      else if (type === 'PLTE') plte = data;
      else if (type === 'tRNS') trns = data;
      else if (type === 'IDAT') {
        idat.push(data);
        idatLen += len;
      } else if (type === 'IEND') break;
      pos += 12 + len;
    }
    if (head === null) return null;
    const hv = new DataView(head.buffer, head.byteOffset);
    const width = hv.getUint32(0);
    const height = hv.getUint32(4);
    if (head[8] !== 8 || head[12] !== 0) return null;
    const ct = head[9];
    const ch = CHANNELS[ct];
    if (ch === undefined) return null;
    const joined = new Uint8Array(idatLen);
    let at = 0;
    for (const part of idat) {
      joined.set(part, at);
      at += part.length;
    }
    const raw = inflateSync(joined);
    const stride = width * ch;
    if (raw.length < height * (stride + 1)) return null;
    const samples = new Uint8Array(height * stride);
    let prev = null;
    for (let y = 0; y < height; y++) {
      const rowAt = y * (stride + 1);
      const row = raw.subarray(rowAt + 1, rowAt + 1 + stride);
      const out = samples.subarray(y * stride, (y + 1) * stride);
      out.set(row);
      unfilterRow(raw[rowAt], out, prev, ch);
      prev = out;
    }
    // Expand to RGBA.
    const rgba = new Uint8Array(width * height * 4);
    const n = width * height;
    if (ct === 6) {
      rgba.set(samples);
    } else if (ct === 2) {
      const key = trns !== null && trns.length >= 6
        ? [trns[1], trns[3], trns[5]]
        : null;
      for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
        rgba[d] = samples[s];
        rgba[d + 1] = samples[s + 1];
        rgba[d + 2] = samples[s + 2];
        rgba[d + 3] = key !== null && samples[s] === key[0] && samples[s + 1] === key[1] && samples[s + 2] === key[2] ? 0 : 255;
      }
    } else if (ct === 0) {
      const key = trns !== null && trns.length >= 2 ? trns[1] : -1;
      for (let i = 0, d = 0; i < n; i++, d += 4) {
        const g = samples[i];
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = g === key ? 0 : 255;
      }
    } else if (ct === 4) {
      for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
        const g = samples[s];
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = samples[s + 1];
      }
    } else {
      // Colour type 3: palette indices.
      if (plte === null) return null;
      for (let i = 0, d = 0; i < n; i++, d += 4) {
        const idx = samples[i];
        rgba[d] = plte[idx * 3];
        rgba[d + 1] = plte[idx * 3 + 1];
        rgba[d + 2] = plte[idx * 3 + 2];
        rgba[d + 3] = trns !== null && idx < trns.length ? trns[idx] : 255;
      }
    }
    return { rgba, width, height };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ Analysis */

function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

/** What the image holds: opaque? grey? its colours when there are at most 256. */
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many
    ? null
    : [...counts.keys()].map((c) => {
        const b = new Uint8Array(Uint32Array.of(c).buffer);
        return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
      });
  return { opaque, grey, colours };
}

/**
 * The single fully transparent value (a grey level, or an RGB packed as r<<16|g<<8|b) that
 * every non-opaque pixel holds and no opaque pixel uses, or null when there is none.
 */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The image's samples in colour type 0, 2, 4 or 6 (6 is the RGBA itself). */
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ Filtering */

/** Sum of |signed byte| over a filtered row: the PNG spec's minimum-sum cost. */
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const b = row[i];
    s += b < 128 ? b : 256 - b;
  }
  return s;
}

const pairSeen = new Uint32Array(65536);
let pairStamp = 0;

/** How many distinct neighbouring byte pairs a filtered row holds. */
function pairCount(row) {
  pairStamp++;
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const p = (row[i - 1] << 8) | row[i];
    if (pairSeen[p] !== pairStamp) {
      pairSeen[p] = pairStamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;

/**
 * Write `samples` (height rows of width*bpp) into `raw`, each row behind its filter byte.
 * choice is a fixed filter type (0..4), 'minsum', 'pairs', or 'brute' (per-row deflate trial).
 */
function filteredSamples(samples, width, height, bpp, choice, raw) {
  const stride = width * bpp;
  const size = height * (stride + 1);
  if (raw === undefined || raw.length !== size) raw = new Uint8Array(size);
  const trial = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairCount(trial[t].subarray(1));
      else {
        const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
        cost = deflateSync(
          trial[t],
          before.length === 0
            ? { level: 4, memLevel: 9 }
            : { level: 4, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

/* ------------------------------------------------------------------ Forms */

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0
    ? null
    : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

/** The lossless forms worth screening for this image. */
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push({ ...paletteForm(rgba, colours, 'count'), narrow: true, filterChoices: [0, 'minsum'] });
    forms.push({ ...paletteForm(rgba, colours, 'luminance'), narrow: true, filterChoices: [0, 'minsum', 'pairs', 'brute'] });
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  const choices = [0, 1, 2, 4, 'minsum', 'pairs'];
  if (bpp === 1) choices.push('brute');
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    narrow: bpp <= 2,
    filterChoices: choices,
  });
  return forms;
}

const chunkBytes = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

/* ------------------------------------------------------------------ Squeeze */

const SCREEN_OPTS = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
// memLevel 8 leads: on the drawn screenshots a level-9 stream at memLevel 9 repeatedly came out
// larger than the same data at memLevel 8, so the memLevel-9 variants are only extra candidates.
const FINAL_OPTS_BIG = [
  { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 8, strategy: constants.Z_FILTERED },
  { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
];
const FINAL_OPTS_SMALL = [
  { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 8, strategy: constants.Z_FILTERED },
  { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
];

function buildPng(width, height, form, idat) {
  const parts = [chunk('IHDR', ihdr(width, height, form.colourType))];
  if (form.plte !== null) parts.push(chunk('PLTE', form.plte));
  if (form.trns !== null) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return pngOf(parts);
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The smallest verified lossless PNG we can build for one decoded image. */
function squeeze(image) {
  const { rgba, width, height } = image;
  const forms = formsOf(rgba);
  // Stage 1: weigh every (form, filter choice) with a level-6 stream.
  const weighed = [];
  for (const form of forms) {
    const overhead = chunkBytes(form);
    for (const choice of form.filterChoices) {
      const data = filteredSamples(form.samples, width, height, form.bpp, choice);
      const stream = deflateSync(data, SCREEN_OPTS);
      weighed.push({ form, data, stream: new Uint8Array(stream.buffer, stream.byteOffset, stream.length), weight: stream.length + overhead });
    }
  }
  weighed.sort((a, b) => a.weight - b.weight);
  // Stage 2: re-deflate the three best distinct data sets at level 9 (the level-6 ranking can
  // mis-order them: a set that screens third can hold the smallest level-9 stream).
  const finalists = [];
  for (const w of weighed) {
    if (finalists.length >= 3) break;
    if (finalists.some((f) => sameBytes(f.data, w.data))) continue;
    finalists.push(w);
  }
  let best = null;
  const consider = (form, stream) => {
    const png = buildPng(width, height, form, stream);
    if (best !== null && png.length >= best.length) return;
    const back = decodePng(png);
    if (back === null || back.width !== width || back.height !== height) return;
    if (!sameBytes(back.rgba, rgba)) return;
    best = png;
  };
  for (const f of finalists) {
    consider(f.form, f.stream);
    const opts = f.data.length >= 2_500_000 ? FINAL_OPTS_BIG : FINAL_OPTS_SMALL;
    for (const o of opts) {
      const stream = deflateSync(f.data, o);
      consider(f.form, new Uint8Array(stream.buffer, stream.byteOffset, stream.length));
    }
  }
  return best;
}

/* ------------------------------------------------------------------ Main */

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const src = join(I, id, 'image.png');
  const dir = join(O, id);
  mkdirSync(dir, { recursive: true });
  const inputBytes = new Uint8Array(readFileSync(src));
  let out = null;
  try {
    const image = decodePng(inputBytes);
    if (image !== null) out = squeeze(image);
  } catch {
    out = null;
  }
  writeFileSync(join(dir, 'image.png'), out ?? inputBytes);
}
