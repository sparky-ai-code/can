// WebP lossless (VP8L) decoder: the bitstream of WebP lossless pictures, and the alpha planes of lossy WebP files.
// Follows the WebP lossless bitstream specification: transforms (predictor, cross colour, subtract green, colour
// indexing), prefix codes, LZ77 backward references and the colour cache.
import { DISTANCE_MAP } from './webp-tables.js';

const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const NUM_LITERALS = 256;
const NUM_LENGTH_CODES = 24;
const NUM_DISTANCE_CODES = 40;
const MAX_PIXELS = 1 << 26; // a sanity bound on what a page can ask the decoder to allocate

export class VP8LError extends Error {}

/** Reads bits least significant first, as the format stores them. Past the end the bits are zero. */
class BitReader {
  constructor(buf, start) {
    this.buf = buf;
    this.pos = start * 8;
    this.limit = buf.length * 8;
  }

  bit() {
    const p = this.pos++;
    if (p >= this.limit) {
      if (p > this.limit + 64) throw new VP8LError('WebP lossless data ends early');
      return 0;
    }
    return (this.buf[p >> 3] >> (p & 7)) & 1;
  }

  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.bit() << i;
    return v >>> 0;
  }
}

/** A canonical prefix code. A code with one symbol takes no bits to read. */
class PrefixCode {
  /** @param {Uint8Array} lengths code length of each symbol (0 = unused) */
  constructor(lengths) {
    this.single = -1;
    const count = new Uint16Array(16);
    let used = 0;
    let last = 0;
    for (let s = 0; s < lengths.length; s++) {
      if (lengths[s]) {
        count[lengths[s]]++;
        used++;
        last = s;
      }
    }
    if (used === 0) throw new VP8LError('empty prefix code');
    if (used === 1) {
      this.single = last;
      return;
    }
    // Symbols sorted by code length, then by value: the canonical order.
    const offs = new Uint16Array(16);
    for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
    this.sorted = new Uint16Array(used);
    for (let s = 0; s < lengths.length; s++) if (lengths[s]) this.sorted[offs[lengths[s]]++] = s;
    this.count = count;
  }

  read(br) {
    if (this.single >= 0) return this.single;
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= br.bit();
      const n = this.count[len];
      if (code - first < n) return this.sorted[index + (code - first)];
      index += n;
      first = (first + n) << 1;
      code <<= 1;
    }
    throw new VP8LError('invalid prefix code');
  }
}

/** Reads one prefix code (simple or normal form) for an alphabet of the given size. */
function readPrefixCode(br, alphabetSize) {
  if (br.bit()) {
    // Simple code: one or two symbols, with 1-bit or 8-bit values
    const numSymbols = br.bit() + 1;
    const lengths = new Uint8Array(alphabetSize);
    const first = br.bit() ? br.bits(8) : br.bits(1);
    if (first >= alphabetSize) throw new VP8LError('symbol out of range');
    if (numSymbols === 1) {
      lengths[first] = 1;
      return new PrefixCode(lengths);
    }
    const second = br.bits(8);
    if (second >= alphabetSize) throw new VP8LError('symbol out of range');
    lengths[first] = 1;
    lengths[second] = 1;
    return new PrefixCode(lengths);
  }
  // Normal code: the code lengths are themselves a prefix code
  const numCodeLengths = br.bits(4) + 4;
  const clLengths = new Uint8Array(19);
  for (let i = 0; i < numCodeLengths; i++) clLengths[CODE_LENGTH_ORDER[i]] = br.bits(3);
  const clCode = new PrefixCode(clLengths);
  let maxSymbol = alphabetSize;
  if (br.bit()) {
    const lengthBits = 2 + 2 * br.bits(3);
    maxSymbol = 2 + br.bits(lengthBits);
    if (maxSymbol > alphabetSize) throw new VP8LError('code length count too large');
  }
  const lengths = new Uint8Array(alphabetSize);
  let symbol = 0;
  let prevLength = 8;
  while (symbol < alphabetSize) {
    if (maxSymbol-- === 0) break;
    const code = clCode.read(br);
    if (code < 16) {
      lengths[symbol++] = code;
      if (code) prevLength = code;
      continue;
    }
    let repeat;
    let value = 0;
    if (code === 16) {
      repeat = 3 + br.bits(2);
      value = prevLength;
    } else if (code === 17) {
      repeat = 3 + br.bits(3);
    } else {
      repeat = 11 + br.bits(7);
    }
    if (symbol + repeat > alphabetSize) throw new VP8LError('code length repeat past the alphabet');
    for (let i = 0; i < repeat; i++) lengths[symbol++] = value;
  }
  return new PrefixCode(lengths);
}

/** The five prefix codes of one group: green (with length and colour-cache symbols), red, blue, alpha, distance. */
function readGroup(br, cacheSize) {
  return {
    green: readPrefixCode(br, NUM_LITERALS + NUM_LENGTH_CODES + cacheSize),
    red: readPrefixCode(br, NUM_LITERALS),
    blue: readPrefixCode(br, NUM_LITERALS),
    alpha: readPrefixCode(br, NUM_LITERALS),
    dist: readPrefixCode(br, NUM_DISTANCE_CODES),
  };
}

/** The value of a length or distance from its prefix symbol and extra bits. */
function prefixValue(br, prefix) {
  if (prefix < 4) return prefix + 1;
  const extra = (prefix - 2) >> 1;
  const offset = (2 + (prefix & 1)) << extra;
  return offset + br.bits(extra) + 1;
}

/**
 * Decodes one entropy-coded image of w x h ARGB pixels (as 32-bit values). Sub-images (transform data, the entropy
 * image) have no meta codes; the main image may have them.
 */
function decodeEntropyImage(br, w, h, isMain) {
  const total = w * h;
  if (total > MAX_PIXELS) throw new VP8LError('image too large');
  let cacheBits = 0;
  if (br.bit()) {
    cacheBits = br.bits(4);
    if (cacheBits < 1 || cacheBits > 11) throw new VP8LError('colour cache size out of range');
  }
  const cacheSize = cacheBits ? 1 << cacheBits : 0;
  let metaBits = 0;
  let groupAt = null; // group index per tile
  let groups;
  if (isMain && br.bit()) {
    metaBits = br.bits(3) + 2;
    const tw = Math.ceil(w / (1 << metaBits));
    const th = Math.ceil(h / (1 << metaBits));
    const meta = decodeEntropyImage(br, tw, th, false);
    groupAt = new Uint16Array(meta.length);
    let maxGroup = 0;
    for (let i = 0; i < meta.length; i++) {
      const g = (meta[i] >>> 8) & 0xffff;
      groupAt[i] = g;
      if (g > maxGroup) maxGroup = g;
    }
    groups = [];
    for (let g = 0; g <= maxGroup; g++) groups.push(readGroup(br, cacheSize));
  } else {
    groups = [readGroup(br, cacheSize)];
  }

  const out = new Uint32Array(total);
  const cache = cacheBits ? new Uint32Array(cacheSize) : null;
  const cacheShift = 32 - cacheBits;
  const tilesPerRow = metaBits ? Math.ceil(w / (1 << metaBits)) : 0;
  let group = groups[0];
  let pos = 0;
  let x = 0;
  let y = 0;
  while (pos < total) {
    // A backward copy can land anywhere, so the tile's code group is looked up for every pixel.
    if (metaBits) group = groups[groupAt[(y >> metaBits) * tilesPerRow + (x >> metaBits)]];
    const g = group.green.read(br);
    if (g < NUM_LITERALS) {
      const red = group.red.read(br);
      const blue = group.blue.read(br);
      const alpha = group.alpha.read(br);
      const argb = ((alpha << 24) | (red << 16) | (g << 8) | blue) >>> 0;
      out[pos++] = argb;
      if (cache) cache[Math.imul(0x1e35a7bd, argb) >>> cacheShift] = argb;
      x++;
      if (x === w) { x = 0; y++; }
    } else if (g < NUM_LITERALS + NUM_LENGTH_CODES) {
      const length = prefixValue(br, g - NUM_LITERALS);
      const dc = group.dist.read(br);
      const distCode = prefixValue(br, dc);
      let dist;
      if (distCode > 120) {
        dist = distCode - 120;
      } else {
        dist = DISTANCE_MAP[2 * (distCode - 1)] + DISTANCE_MAP[2 * (distCode - 1) + 1] * w;
        if (dist < 1) dist = 1;
      }
      if (dist > pos || pos + length > total) throw new VP8LError('backward reference out of range');
      for (let i = 0; i < length; i++) {
        const argb = out[pos - dist];
        out[pos++] = argb;
        if (cache) cache[Math.imul(0x1e35a7bd, argb) >>> cacheShift] = argb;
      }
      x += length;
      while (x >= w) { x -= w; y++; }
    } else {
      if (!cache) throw new VP8LError('colour cache code without a cache');
      const argb = cache[g - NUM_LITERALS - NUM_LENGTH_CODES];
      out[pos++] = argb;
      cache[Math.imul(0x1e35a7bd, argb) >>> cacheShift] = argb;
      x++;
      if (x === w) { x = 0; y++; }
    }
  }
  return out;
}

/**
 * Applies the inverse of one transform. The transform records the width of the picture it works on (t.xsize);
 * colour indexing takes packed pixels of that picture's width and returns the unpacked picture.
 */
function inverseTransform(t, data, h) {
  const w = t.xsize;
  if (t.type === 'predictor') {
    const bits = t.bits;
    const tw = Math.ceil(w / (1 << bits));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (i === 0) {
          data[i] = addPixels(data[i], 0xff000000);
          continue;
        }
        const mode = (t.data[(y >> bits) * tw + (x >> bits)] >>> 8) & 0xf;
        const pred = predict(mode, data, i, x, y, w);
        data[i] = addPixels(data[i], pred);
      }
    }
    return data;
  }
  if (t.type === 'crossColor') {
    const bits = t.bits;
    const tw = Math.ceil(w / (1 << bits));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const el = t.data[(y >> bits) * tw + (x >> bits)];
        const g2r = (el << 24) >> 24; // signed 8-bit fields of the element
        const g2b = (el << 16) >> 24;
        const r2b = (el << 8) >> 24;
        const p = data[i];
        const green = (p >>> 8) & 0xff;
        let red = (p >>> 16) & 0xff;
        let blue = p & 0xff;
        red = (red + colorDelta(g2r, green)) & 0xff;
        blue = (blue + colorDelta(g2b, green) + colorDelta(r2b, red)) & 0xff;
        data[i] = ((p & 0xff00ff00) | (red << 16) | blue) >>> 0;
      }
    }
    return data;
  }
  if (t.type === 'subtractGreen') {
    for (let i = 0; i < data.length; i++) {
      const p = data[i];
      const green = (p >>> 8) & 0xff;
      const red = (((p >>> 16) & 0xff) + green) & 0xff;
      const blue = ((p & 0xff) + green) & 0xff;
      data[i] = ((p & 0xff00ff00) | (red << 16) | blue) >>> 0;
    }
    return data;
  }
  // colour indexing: each output pixel is a palette entry picked by index bits packed in the green channel
  const out = new Uint32Array(w * h);
  const bitsPerIndex = t.bitsPerIndex;
  const perByte = bitsPerIndex ? 8 / bitsPerIndex : 1;
  const mask = bitsPerIndex ? (1 << bitsPerIndex) - 1 : 0xff;
  const packedW = Math.ceil(w / perByte);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const packed = data[y * packedW + Math.floor(x / perByte)];
      const index = bitsPerIndex
        ? ((packed >>> 8) >> ((x % perByte) * bitsPerIndex)) & mask
        : (packed >>> 8) & 0xff;
      out[y * w + x] = t.palette[index];
    }
  }
  return out;
}

function addPixels(a, b) {
  const alpha = (((a >>> 24) + (b >>> 24)) & 0xff) << 24;
  const red = ((((a >>> 16) & 0xff) + ((b >>> 16) & 0xff)) & 0xff) << 16;
  const green = ((((a >>> 8) & 0xff) + ((b >>> 8) & 0xff)) & 0xff) << 8;
  const blue = (((a & 0xff) + (b & 0xff)) & 0xff);
  return (alpha | red | green | blue) >>> 0;
}

/** ColorTransformDelta: a signed 3.5 fixed-point multiple of the channel c. */
function colorDelta(t, c) {
  const cs = (c << 24) >> 24;
  return (t * cs) >> 5;
}

const chan = (p, s) => (p >>> s) & 0xff;

function avg2(a, b) {
  // per channel (a + b) / 2, rounding down
  return ((((a & 0xfefefefe) >>> 1) + ((b & 0xfefefefe) >>> 1)) + (a & b & 0x01010101)) >>> 0;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function select(L, T, TL) {
  // the neighbour (left or top) that is closer to the gradient estimate
  let pL = 0;
  let pT = 0;
  for (const s of [24, 16, 8, 0]) {
    const est = chan(L, s) + chan(T, s) - chan(TL, s);
    pL += Math.abs(est - chan(L, s));
    pT += Math.abs(est - chan(T, s));
  }
  return pL < pT ? L : T;
}

function clampAddSubtractFull(a, b, c) {
  let out = 0;
  for (const s of [24, 16, 8, 0]) out |= clamp255(chan(a, s) + chan(b, s) - chan(c, s)) << s;
  return out >>> 0;
}

function clampAddSubtractHalf(a, b) {
  let out = 0;
  for (const s of [24, 16, 8, 0]) {
    const ca = chan(a, s);
    out |= clamp255(ca + Math.trunc((ca - chan(b, s)) / 2)) << s;
  }
  return out >>> 0;
}

/** The predictor value for pixel i at (x, y), from its already decoded neighbours. */
function predict(mode, data, i, x, y, w) {
  const L = x > 0 ? data[i - 1] : 0;
  const T = y > 0 ? data[i - w] : 0;
  const TL = x > 0 && y > 0 ? data[i - w - 1] : 0;
  const TR = y > 0 ? data[i - w + 1] : 0; // for the rightmost column this is the first pixel of the current row
  if (y === 0) return x === 0 ? 0xff000000 : L;
  if (x === 0) return T;
  switch (mode) {
    case 0: return 0xff000000;
    case 1: return L;
    case 2: return T;
    case 3: return TR;
    case 4: return TL;
    case 5: return avg2(avg2(L, TR), T);
    case 6: return avg2(L, TL);
    case 7: return avg2(L, T);
    case 8: return avg2(TL, T);
    case 9: return avg2(T, TR);
    case 10: return avg2(avg2(L, TL), avg2(T, TR));
    case 11: return select(L, T, TL);
    case 12: return clampAddSubtractFull(L, T, TL);
    case 13: return clampAddSubtractHalf(avg2(L, T), TL);
    default: return 0xff000000;
  }
}

/** Reads the transforms, the entropy-coded picture and applies the inverse transforms. Returns ARGB pixels. */
function decodeArgb(br, width, height) {
  const transforms = [];
  let xsize = width;
  const used = new Set();
  while (br.bit()) {
    const type = br.bits(2);
    const names = ['predictor', 'crossColor', 'subtractGreen', 'colorIndexing'];
    const name = names[type];
    if (used.has(name)) throw new VP8LError('transform used twice');
    used.add(name);
    if (name === 'predictor' || name === 'crossColor') {
      const bits = br.bits(3) + 2;
      const tw = Math.ceil(xsize / (1 << bits));
      const th = Math.ceil(height / (1 << bits));
      transforms.push({ type: name === 'predictor' ? 'predictor' : 'crossColor', bits, data: decodeEntropyImage(br, tw, th, false), xsize });
    } else if (name === 'subtractGreen') {
      transforms.push({ type: 'subtractGreen', xsize });
    } else {
      const numColors = br.bits(8) + 1;
      const raw = decodeEntropyImage(br, numColors, 1, false);
      // palette entries are stored as differences from the previous entry, per channel
      const palette = new Uint32Array(256);
      let prev = 0;
      for (let i = 0; i < numColors; i++) {
        let argb = 0;
        for (const s of [24, 16, 8, 0]) argb |= ((chan(raw[i], s) + chan(prev, s)) & 0xff) << s;
        palette[i] = argb >>> 0;
        prev = palette[i];
      }
      const bitsPerIndex = numColors <= 2 ? 1 : numColors <= 4 ? 2 : numColors <= 16 ? 4 : 0;
      transforms.push({ type: 'colorIndexing', palette, bitsPerIndex, xsize });
      if (bitsPerIndex) xsize = Math.ceil(xsize / (8 / bitsPerIndex));
    }
  }
  let data = decodeEntropyImage(br, xsize, height, true);
  for (let k = transforms.length - 1; k >= 0; k--) data = inverseTransform(transforms[k], data, height);
  return data;
}

/**
 * Decodes a lossless WebP picture: the image stream of a VP8L chunk, with its 5-byte header.
 * @returns {{width: number, height: number, channels: 4, data: Uint8Array}}
 */
export function decodeVP8L(buf) {
  if (buf.length < 5 || buf[0] !== 0x2f) throw new VP8LError('not a lossless WebP stream');
  const br = new BitReader(buf, 1);
  const width = br.bits(14) + 1;
  const height = br.bits(14) + 1;
  br.bits(1); // alpha_is_used: the pixels carry their own alpha either way
  if (br.bits(3) !== 0) throw new VP8LError('unsupported lossless version');
  const argb = decodeArgb(br, width, height);
  return { width, height, channels: 4, data: argbToRgba(argb) };
}

/** The alpha plane of a lossy WebP file: an image stream without a header, whose green channel is the alpha. */
export function decodeVP8LAlpha(buf, width, height) {
  const br = new BitReader(buf, 0);
  const argb = decodeArgb(br, width, height);
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = (argb[i] >>> 8) & 0xff;
  return alpha;
}

function argbToRgba(argb) {
  const out = new Uint8Array(argb.length * 4);
  for (let i = 0; i < argb.length; i++) {
    const p = argb[i];
    out[4 * i] = (p >>> 16) & 0xff;
    out[4 * i + 1] = (p >>> 8) & 0xff;
    out[4 * i + 2] = p & 0xff;
    out[4 * i + 3] = (p >>> 24) & 0xff;
  }
  return out;
}
