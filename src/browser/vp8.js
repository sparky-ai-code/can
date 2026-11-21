// WebP lossy decoder: a VP8 key frame (RFC 6386). It reads the frame header, the per-macroblock modes and the
// quantised coefficients, rebuilds the picture (intra prediction, inverse transforms), applies the loop filter and
// converts the result from YUV 4:2:0 to RGBA. Inter frames do not occur in still WebP pictures and are rejected.
import { DC_Q_LOOKUP, AC_Q_LOOKUP, KF_BMODE_PROBS, COEFF_UPDATE_PROBS, DEFAULT_COEFF_PROBS } from './webp-tables.js';

export class VP8Error extends Error {}

const MAX_MACROBLOCKS = 1 << 16; // 4096 x 4096 pixels: a sanity bound on what one picture may ask for

// Macroblock luma modes (the first five are the whole-block modes; B_PRED has a mode for each subblock)
const DC_PRED = 0;
const V_PRED = 1;
const H_PRED = 2;
const TM_PRED = 3;
const B_PRED = 4;

// Subblock modes, in the order the probability table is indexed by
const B_DC = 0;
const B_TM = 1;
const B_VE = 2;
const B_HE = 3;
const B_LD = 4;
const B_RD = 5;
const B_VR = 6;
const B_VL = 7;
const B_HD = 8;
const B_HU = 9;

// Trees (RFC 6386, section 8.1): positive entries index the tree, other entries are negated leaves
const KF_YMODE_TREE = [-B_PRED, 2, 4, 6, -DC_PRED, -V_PRED, -H_PRED, -TM_PRED];
const UV_MODE_TREE = [-DC_PRED, 2, -V_PRED, 4, -H_PRED, -TM_PRED];
const B_MODE_TREE = [-B_DC, 2, -B_TM, 4, -B_VE, 6, 8, 12, -B_HE, 10, -B_RD, -B_VR, -B_LD, 14, -B_VL, 16, -B_HD, -B_HU];
const KF_YMODE_PROBS = [145, 156, 163, 128];
const KF_UV_MODE_PROBS = [142, 114, 183];
// The subblock mode a whole-block mode implies, for the contexts of neighbouring subblocks
const IMPLIED_BMODE = [B_DC, B_VE, B_HE, B_TM];

const ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
const COEFF_BANDS = [0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7];
const PCAT = [
  [159],
  [165, 145],
  [173, 148, 140],
  [176, 155, 140, 135],
  [180, 157, 141, 134, 130],
  [254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129],
];
const DCT_CAT_BASE = [5, 7, 11, 19, 35, 67];

/** The boolean entropy decoder of RFC 6386, section 7. */
class BoolDecoder {
  constructor(buf, start, end) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
    this.value = (this.byte() << 8) | this.byte();
    this.range = 255;
    this.bitCount = 0;
  }

  byte() {
    return this.pos < this.end ? this.buf[this.pos++] : (this.pos++, 0); // past the end, zeros are read
  }

  bool(prob) {
    const split = 1 + (((this.range - 1) * prob) >> 8);
    const bigSplit = split << 8;
    let bit;
    if (this.value >= bigSplit) {
      bit = 1;
      this.range -= split;
      this.value -= bigSplit;
    } else {
      bit = 0;
      this.range = split;
    }
    while (this.range < 128) {
      this.value <<= 1;
      this.range <<= 1;
      if (++this.bitCount === 8) {
        this.bitCount = 0;
        this.value |= this.byte();
      }
    }
    return bit;
  }

  /** An unsigned n-bit literal, most significant bit first. */
  literal(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bool(128);
    return v;
  }

  /** An n-bit magnitude then a sign. */
  magSigned(n) {
    const v = this.literal(n);
    return this.bool(128) ? -v : v;
  }

  /** A flag, then (if set) a magnitude and sign. Absent values are zero. */
  signed(n) {
    return this.bool(128) ? this.magSigned(n) : 0;
  }
}

/** Reads a tree-coded value. probs[i >> 1] is the probability at tree node i. */
function treeRead(bd, tree, probs, probOffset = 0) {
  let i = 0;
  do {
    i = tree[i + bd.bool(probs[probOffset + (i >> 1)])];
  } while (i > 0);
  return -i;
}

const clampQ = (q) => (q < 0 ? 0 : q > 127 ? 127 : q);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Reads the frame header: everything the first partition holds before the macroblock records. */
function readHeader(bd) {
  const hdr = {};
  bd.literal(1); // colour space: always YUV
  bd.literal(1); // clamping type: the decoder clamps anyway
  hdr.seg = { enabled: false, updateMap: false, abs: false, quant: [0, 0, 0, 0], lf: [0, 0, 0, 0], probs: [255, 255, 255] };
  if (bd.bool(128)) {
    hdr.seg.enabled = true;
    hdr.seg.updateMap = bd.bool(128) === 1;
    const updateData = bd.bool(128) === 1;
    if (updateData) {
      hdr.seg.abs = bd.bool(128) === 1;
      for (let i = 0; i < 4; i++) hdr.seg.quant[i] = bd.signed(7);
      for (let i = 0; i < 4; i++) hdr.seg.lf[i] = bd.signed(6);
    }
    if (hdr.seg.updateMap) {
      for (let i = 0; i < 3; i++) hdr.seg.probs[i] = bd.bool(128) ? bd.literal(8) : 255;
    }
  }
  hdr.simpleFilter = bd.bool(128) === 1;
  hdr.filterLevel = bd.literal(6);
  hdr.sharpness = bd.literal(3);
  hdr.lfDeltas = { enabled: bd.bool(128) === 1, ref: [0, 0, 0, 0], mode: [0, 0, 0, 0] };
  if (hdr.lfDeltas.enabled && bd.bool(128)) {
    for (let i = 0; i < 4; i++) if (bd.bool(128)) hdr.lfDeltas.ref[i] = bd.magSigned(6);
    for (let i = 0; i < 4; i++) if (bd.bool(128)) hdr.lfDeltas.mode[i] = bd.magSigned(6);
  }
  hdr.partitions = 1 << bd.literal(2);
  hdr.qIndex = bd.literal(7);
  hdr.qDeltas = {
    y1dc: bd.signed(4),
    y2dc: bd.signed(4),
    y2ac: bd.signed(4),
    uvdc: bd.signed(4),
    uvac: bd.signed(4),
  };
  bd.literal(1); // refresh_entropy_probs: a single frame has no later frames to affect
  // Coefficient probabilities, with the updates the header carries
  hdr.coeffProbs = Uint8Array.from(DEFAULT_COEFF_PROBS);
  for (let i = 0; i < hdr.coeffProbs.length; i++) {
    if (bd.bool(COEFF_UPDATE_PROBS[i])) hdr.coeffProbs[i] = bd.literal(8);
  }
  hdr.skipEnabled = bd.bool(128) === 1;
  hdr.probSkip = hdr.skipEnabled ? bd.literal(8) : 0;
  return hdr;
}

/** Dequantisation factors for each segment: [y1dc, y1ac, y2dc, y2ac, uvdc, uvac]. */
function dequantFactors(hdr) {
  const out = [];
  for (let s = 0; s < 4; s++) {
    let q = hdr.qIndex;
    if (hdr.seg.enabled) q = hdr.seg.abs ? hdr.seg.quant[s] : q + hdr.seg.quant[s];
    const d = hdr.qDeltas;
    const y2ac = Math.floor((AC_Q_LOOKUP[clampQ(q + d.y2ac)] * 155) / 100);
    out.push({
      y1dc: DC_Q_LOOKUP[clampQ(q + d.y1dc)],
      y1ac: AC_Q_LOOKUP[clampQ(q)],
      y2dc: DC_Q_LOOKUP[clampQ(q + d.y2dc)] * 2,
      y2ac: y2ac < 8 ? 8 : y2ac,
      uvdc: Math.min(DC_Q_LOOKUP[clampQ(q + d.uvdc)], 132),
      uvac: AC_Q_LOOKUP[clampQ(q + d.uvac)],
    });
  }
  return out;
}

/**
 * Reads the quantised coefficients of one block into out (16 values, natural order, dequantised).
 * Type 0: luma after a Y2 block (starts at index 1); 1: Y2; 2: chroma; 3: luma with its own DC.
 * Returns true if the block had any token before its end-of-block.
 */
function readBlock(bd, probs, type, ctx, dc, ac, out, outOff) {
  const first = type === 0 ? 1 : 0;
  let c = first;
  let p = ((type * 8 + COEFF_BANDS[c]) * 3 + ctx) * 11;
  let checkEob = true;
  while (c < 16) {
    if (checkEob && !bd.bool(probs[p])) break; // end of block
    if (!bd.bool(probs[p + 1])) {
      // a zero: no end-of-block check follows it
      c++;
      checkEob = false;
      if (c < 16) p = ((type * 8 + COEFF_BANDS[c]) * 3 + 0) * 11;
      continue;
    }
    let v;
    let nextCtx;
    if (!bd.bool(probs[p + 2])) {
      v = 1;
      nextCtx = 1;
    } else {
      nextCtx = 2;
      if (!bd.bool(probs[p + 3])) {
        if (!bd.bool(probs[p + 4])) v = 2;
        else v = 3 + bd.bool(probs[p + 5]);
      } else if (!bd.bool(probs[p + 6])) {
        if (!bd.bool(probs[p + 7])) v = DCT_CAT_BASE[0] + extra(bd, 0);
        else v = DCT_CAT_BASE[1] + extra(bd, 1);
      } else if (!bd.bool(probs[p + 8])) {
        if (!bd.bool(probs[p + 9])) v = DCT_CAT_BASE[2] + extra(bd, 2);
        else v = DCT_CAT_BASE[3] + extra(bd, 3);
      } else if (!bd.bool(probs[p + 10])) {
        v = DCT_CAT_BASE[4] + extra(bd, 4);
      } else {
        v = DCT_CAT_BASE[5] + extra(bd, 5);
      }
    }
    if (bd.bool(128)) v = -v;
    out[outOff + ZIGZAG[c]] = v * (c === 0 ? dc : ac);
    c++;
    checkEob = true;
    if (c < 16) p = ((type * 8 + COEFF_BANDS[c]) * 3 + nextCtx) * 11;
  }
  return c > first;
}

/** The extra bits of a category token, most significant first. */
function extra(bd, cat) {
  const probs = PCAT[cat];
  let v = 0;
  for (let i = 0; i < probs.length; i++) v = (v << 1) | bd.bool(probs[i]);
  return v;
}

/**
 * The inverse Walsh-Hadamard transform of the Y2 block: its 16 outputs are the DC values of the 16 luma blocks.
 * Written into coeffs at each luma block's first position.
 */
function inverseWht(input, inOff, coeffs) {
  const t = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    const a1 = input[inOff + i] + input[inOff + 12 + i];
    const b1 = input[inOff + 4 + i] + input[inOff + 8 + i];
    const c1 = input[inOff + 4 + i] - input[inOff + 8 + i];
    const d1 = input[inOff + i] - input[inOff + 12 + i];
    t[i] = a1 + b1;
    t[4 + i] = c1 + d1;
    t[8 + i] = a1 - b1;
    t[12 + i] = d1 - c1;
  }
  for (let i = 0; i < 4; i++) {
    const a1 = t[4 * i] + t[4 * i + 3];
    const b1 = t[4 * i + 1] + t[4 * i + 2];
    const c1 = t[4 * i + 1] - t[4 * i + 2];
    const d1 = t[4 * i] - t[4 * i + 3];
    coeffs[(4 * i) * 16] = (a1 + b1 + 3) >> 3;
    coeffs[(4 * i + 1) * 16] = (c1 + d1 + 3) >> 3;
    coeffs[(4 * i + 2) * 16] = (a1 - b1 + 3) >> 3;
    coeffs[(4 * i + 3) * 16] = (d1 - c1 + 3) >> 3;
  }
}

const mulCos = (x) => x + Math.floor((x * 20091) / 65536);
const mulSin = (x) => Math.floor((x * 35468) / 65536);

/** The inverse DCT of one 4x4 block of coefficients, added to the prediction in plane. */
function addInverseDct(coeffs, off, plane, pos, stride) {
  const t = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    const i0 = coeffs[off + i];
    const i4 = coeffs[off + 4 + i];
    const i8 = coeffs[off + 8 + i];
    const i12 = coeffs[off + 12 + i];
    const a1 = i0 + i8;
    const b1 = i0 - i8;
    const c1 = mulSin(i4) - mulCos(i12);
    const d1 = mulCos(i4) + mulSin(i12);
    t[i] = a1 + d1;
    t[12 + i] = a1 - d1;
    t[4 + i] = b1 + c1;
    t[8 + i] = b1 - c1;
  }
  for (let r = 0; r < 4; r++) {
    const i0 = t[4 * r];
    const i1 = t[4 * r + 1];
    const i2 = t[4 * r + 2];
    const i3 = t[4 * r + 3];
    const a1 = i0 + i2;
    const b1 = i0 - i2;
    const c1 = mulSin(i1) - mulCos(i3);
    const d1 = mulCos(i1) + mulSin(i3);
    const row = pos + r * stride;
    plane[row] = clamp255(plane[row] + ((a1 + d1 + 4) >> 3));
    plane[row + 3] = clamp255(plane[row + 3] + ((a1 - d1 + 4) >> 3));
    plane[row + 1] = clamp255(plane[row + 1] + ((b1 + c1 + 4) >> 3));
    plane[row + 2] = clamp255(plane[row + 2] + ((b1 - c1 + 4) >> 3));
  }
}

/** Whole-block prediction (16x16 luma or 8x8 chroma) written into plane at (x0, y0). */
function predictBlock(plane, stride, x0, y0, size, mode) {
  const at = (x, y) => y * stride + x;
  const haveAbove = y0 > 0;
  const haveLeft = x0 > 0;
  const above = (i) => (haveAbove ? plane[at(x0 + i, y0 - 1)] : 127);
  const left = (i) => (haveLeft ? plane[at(x0 - 1, y0 + i)] : 129);
  const corner = haveAbove ? (haveLeft ? plane[at(x0 - 1, y0 - 1)] : 129) : 127;
  const shift = size === 16 ? 4 : 3;
  if (mode === DC_PRED) {
    let sum = 0;
    let v = 128;
    if (haveAbove && haveLeft) {
      for (let i = 0; i < size; i++) sum += above(i) + left(i);
      v = (sum + size) >> (shift + 1);
    } else if (haveAbove) {
      for (let i = 0; i < size; i++) sum += above(i);
      v = (sum + size / 2) >> shift;
    } else if (haveLeft) {
      for (let i = 0; i < size; i++) sum += left(i);
      v = (sum + size / 2) >> shift;
    }
    for (let y = 0; y < size; y++) plane.fill(v, at(x0, y0 + y), at(x0, y0 + y) + size);
    return;
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v;
      if (mode === V_PRED) v = above(x);
      else if (mode === H_PRED) v = left(y);
      else v = clamp255(left(y) + above(x) - corner); // TM_PRED
      plane[at(x0 + x, y0 + y)] = v;
    }
  }
}

const avg3 = (x, y, z) => (x + 2 * y + z + 2) >> 2;
const avg2 = (x, y) => (x + y + 1) >> 1;

/**
 * Subblock prediction (RFC 6386, section 12.3). e holds the edge: e[0..3] = left column bottom to top, e[4] = the
 * corner, e[5..12] = the above row and the four pixels above and to the right. Writes 4x4 values into b (row-major).
 */
function predictSubblock(e, mode, b) {
  const A = (i) => e[5 + i];
  const L = (i) => e[3 - i];
  const P = e[4];
  const set = (r, c, v) => { b[r * 4 + c] = v; };
  switch (mode) {
    case B_DC: {
      let v = 4;
      for (let i = 0; i < 4; i++) v += A(i) + L(i);
      v >>= 3;
      for (let i = 0; i < 16; i++) b[i] = v;
      break;
    }
    case B_TM:
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) set(r, c, clamp255(L(r) + A(c) - P));
      break;
    case B_VE:
      for (let c = 0; c < 4; c++) {
        const v = avg3(e[4 + c], e[5 + c], e[6 + c]);
        for (let r = 0; r < 4; r++) set(r, c, v);
      }
      break;
    case B_HE: {
      const rows = [avg3(P, L(0), L(1)), avg3(L(0), L(1), L(2)), avg3(L(1), L(2), L(3)), avg3(L(2), L(3), L(3))];
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) set(r, c, rows[r]);
      break;
    }
    case B_LD:
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const s = r + c;
          set(r, c, s < 6 ? avg3(A(s), A(s + 1), A(s + 2)) : avg3(A(6), A(7), A(7)));
        }
      }
      break;
    case B_RD:
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) set(r, c, avg3(e[3 - r + c], e[4 - r + c], e[5 - r + c]));
      break;
    case B_VR:
      set(3, 0, avg3(e[1], e[2], e[3]));
      set(2, 0, avg3(e[2], e[3], e[4]));
      set(3, 1, avg3(e[3], e[4], e[5])); set(1, 0, avg3(e[3], e[4], e[5]));
      set(2, 1, avg2(e[4], e[5])); set(0, 0, avg2(e[4], e[5]));
      set(3, 2, avg3(e[4], e[5], e[6])); set(1, 1, avg3(e[4], e[5], e[6]));
      set(2, 2, avg2(e[5], e[6])); set(0, 1, avg2(e[5], e[6]));
      set(3, 3, avg3(e[5], e[6], e[7])); set(1, 2, avg3(e[5], e[6], e[7]));
      set(2, 3, avg2(e[6], e[7])); set(0, 2, avg2(e[6], e[7]));
      set(1, 3, avg3(e[6], e[7], e[8]));
      set(0, 3, avg2(e[7], e[8]));
      break;
    case B_VL:
      set(0, 0, avg2(A(0), A(1)));
      set(1, 0, avg3(A(0), A(1), A(2)));
      set(2, 0, avg2(A(1), A(2))); set(0, 1, avg2(A(1), A(2)));
      set(1, 1, avg3(A(1), A(2), A(3))); set(3, 0, avg3(A(1), A(2), A(3)));
      set(2, 1, avg2(A(2), A(3))); set(0, 2, avg2(A(2), A(3)));
      set(3, 1, avg3(A(2), A(3), A(4))); set(1, 2, avg3(A(2), A(3), A(4)));
      set(2, 2, avg2(A(3), A(4))); set(0, 3, avg2(A(3), A(4)));
      set(3, 2, avg3(A(3), A(4), A(5))); set(1, 3, avg3(A(3), A(4), A(5)));
      set(2, 3, avg3(A(4), A(5), A(6)));
      set(3, 3, avg3(A(5), A(6), A(7)));
      break;
    case B_HD:
      set(3, 0, avg2(e[0], e[1]));
      set(3, 1, avg3(e[0], e[1], e[2]));
      set(2, 0, avg2(e[1], e[2])); set(3, 2, avg2(e[1], e[2]));
      set(2, 1, avg3(e[1], e[2], e[3])); set(3, 3, avg3(e[1], e[2], e[3]));
      set(2, 2, avg2(e[2], e[3])); set(1, 0, avg2(e[2], e[3]));
      set(2, 3, avg3(e[2], e[3], e[4])); set(1, 1, avg3(e[2], e[3], e[4]));
      set(1, 2, avg2(e[3], e[4])); set(0, 0, avg2(e[3], e[4]));
      set(1, 3, avg3(e[3], e[4], e[5])); set(0, 1, avg3(e[3], e[4], e[5]));
      set(0, 2, avg3(e[4], e[5], e[6]));
      set(0, 3, avg3(e[5], e[6], e[7]));
      break;
    case B_HU:
      set(0, 0, avg2(L(0), L(1)));
      set(0, 1, avg3(L(0), L(1), L(2)));
      set(0, 2, avg2(L(1), L(2))); set(1, 0, avg2(L(1), L(2)));
      set(0, 3, avg3(L(1), L(2), L(3))); set(1, 1, avg3(L(1), L(2), L(3)));
      set(1, 2, avg2(L(2), L(3))); set(2, 0, avg2(L(2), L(3)));
      set(1, 3, avg3(L(2), L(3), L(3))); set(2, 1, avg3(L(2), L(3), L(3)));
      set(2, 2, L(3)); set(2, 3, L(3)); set(3, 0, L(3)); set(3, 1, L(3)); set(3, 2, L(3)); set(3, 3, L(3));
      break;
    default:
      throw new VP8Error('unknown subblock mode');
  }
}

/** Decodes a VP8 key frame. Returns {width, height, y, u, v, stride, cstride} with the planes padded to macroblocks. */
function decodeFrame(buf) {
  if (buf.length < 10) throw new VP8Error('VP8 data too short');
  const tag = buf[0] | (buf[1] << 8) | (buf[2] << 16);
  if (tag & 1) throw new VP8Error('not a key frame');
  if (buf[3] !== 0x9d || buf[4] !== 0x01 || buf[5] !== 0x2a) throw new VP8Error('bad VP8 start code');
  const firstSize = (tag >> 5) & 0x7ffff;
  const width = (buf[6] | (buf[7] << 8)) & 0x3fff;
  const height = (buf[8] | (buf[9] << 8)) & 0x3fff;
  if (!width || !height) throw new VP8Error('empty VP8 picture');
  const mbCols = (width + 15) >> 4;
  const mbRows = (height + 15) >> 4;
  if (mbCols * mbRows > MAX_MACROBLOCKS) throw new VP8Error('VP8 picture too large');
  const firstEnd = Math.min(buf.length, 10 + firstSize);
  const bd = new BoolDecoder(buf, 10, firstEnd);
  const hdr = readHeader(bd);

  // Token partitions follow the first one: a table of 3-byte sizes, then the data
  const count = hdr.partitions;
  let p = firstEnd;
  const sizesAt = p;
  p += 3 * (count - 1);
  const parts = [];
  for (let i = 0; i < count; i++) {
    let size;
    if (i < count - 1) {
      const s = sizesAt + 3 * i;
      size = s + 2 < buf.length ? buf[s] | (buf[s + 1] << 8) | (buf[s + 2] << 16) : 0;
    } else {
      size = buf.length - p;
    }
    const end = Math.min(buf.length, p + Math.max(0, size));
    parts.push(new BoolDecoder(buf, Math.min(p, buf.length), end));
    p = end;
  }

  const dq = dequantFactors(hdr);
  const yStride = mbCols * 16;
  const cStride = mbCols * 8;
  const Y = new Uint8Array(yStride * mbRows * 16);
  const U = new Uint8Array(cStride * mbRows * 8);
  const V = new Uint8Array(cStride * mbRows * 8);

  // Per-macroblock records the loop filter needs afterwards
  const mbCount = mbCols * mbRows;
  const filterLevel = new Uint8Array(mbCount);
  const innerEdges = new Uint8Array(mbCount);
  const bmodes = new Uint8Array(mbCount * 16);
  const ymodes = new Uint8Array(mbCount);

  // Non-zero flags of the blocks above (per macroblock column: 4 Y, 2 U, 2 V, Y2) and to the left
  const aboveNz = new Uint8Array(mbCols * 9);
  const leftNz = new Uint8Array(9);
  const coeffs = new Int32Array(25 * 16);
  const edge = new Int32Array(13);
  const sub = new Int32Array(16);

  for (let mby = 0; mby < mbRows; mby++) {
    const tokens = parts[mby % count];
    leftNz.fill(0);
    for (let mbx = 0; mbx < mbCols; mbx++) {
      const mb = mby * mbCols + mbx;
      // Macroblock header (first partition)
      let segment = 0;
      if (hdr.seg.enabled && hdr.seg.updateMap) {
        segment = bd.bool(hdr.seg.probs[0]) ? 2 + bd.bool(hdr.seg.probs[2]) : bd.bool(hdr.seg.probs[1]);
      }
      const skip = hdr.skipEnabled ? bd.bool(hdr.probSkip) : 0;
      const ymode = treeRead(bd, KF_YMODE_TREE, KF_YMODE_PROBS);
      ymodes[mb] = ymode;
      const modes = bmodes.subarray(mb * 16, mb * 16 + 16);
      if (ymode === B_PRED) {
        for (let b = 0; b < 16; b++) {
          const bx = b & 3;
          const by = b >> 2;
          const above = by > 0 ? modes[b - 4] : mby > 0 ? bmodes[((mb - mbCols) * 16) + 12 + bx] : B_DC;
          const left = bx > 0 ? modes[b - 1] : mbx > 0 ? bmodes[((mb - 1) * 16) + by * 4 + 3] : B_DC;
          modes[b] = treeRead(bd, B_MODE_TREE, KF_BMODE_PROBS, (above * 10 + left) * 9);
        }
      } else {
        modes.fill(IMPLIED_BMODE[ymode]);
      }
      const uvmode = treeRead(bd, UV_MODE_TREE, KF_UV_MODE_PROBS);

      // Coefficients (token partition)
      const f = dq[segment];
      coeffs.fill(0);
      const ctxBase = mbx * 9;
      const hasY2 = ymode !== B_PRED;
      let anyTokens = false;
      if (!skip) {
        if (hasY2) {
          const ctx = aboveNz[ctxBase + 8] + leftNz[8];
          const nz = readBlock(tokens, hdr.coeffProbs, 1, ctx, f.y2dc, f.y2ac, coeffs, 24 * 16);
          aboveNz[ctxBase + 8] = leftNz[8] = nz ? 1 : 0;
          anyTokens = anyTokens || nz;
          inverseWht(coeffs, 24 * 16, coeffs);
        }
        const yType = hasY2 ? 0 : 3;
        for (let b = 0; b < 16; b++) {
          const bx = b & 3;
          const by = b >> 2;
          const ctx = aboveNz[ctxBase + bx] + leftNz[by];
          const nz = readBlock(tokens, hdr.coeffProbs, yType, ctx, f.y1dc, f.y1ac, coeffs, b * 16);
          aboveNz[ctxBase + bx] = leftNz[by] = nz ? 1 : 0;
          anyTokens = anyTokens || nz;
        }
        for (let b = 0; b < 8; b++) {
          // U blocks 16..19, V blocks 20..23: contexts 4..5 (U) and 6..7 (V)
          const plane = b < 4 ? 4 : 6;
          const bx = b & 1;
          const by = (b >> 1) & 1;
          const ctx = aboveNz[ctxBase + plane + bx] + leftNz[plane + by];
          const nz = readBlock(tokens, hdr.coeffProbs, 2, ctx, f.uvdc, f.uvac, coeffs, (16 + b) * 16);
          aboveNz[ctxBase + plane + bx] = leftNz[plane + by] = nz ? 1 : 0;
          anyTokens = anyTokens || nz;
        }
      } else {
        // No coefficients: the contexts clear, except Y2 which a macroblock without Y2 leaves alone
        for (let i = 0; i < 8; i++) {
          aboveNz[ctxBase + i] = 0;
          leftNz[i] = 0;
        }
        if (hasY2) {
          aboveNz[ctxBase + 8] = 0;
          leftNz[8] = 0;
        }
      }

      filterLevel[mb] = filterLevelFor(hdr, segment, ymode);
      innerEdges[mb] = ymode === B_PRED || anyTokens ? 1 : 0;

      // Reconstruction: prediction, then the residue added block by block
      const x0 = mbx * 16;
      const y0 = mby * 16;
      if (ymode === B_PRED) {
        for (let b = 0; b < 16; b++) {
          const bx = b & 3;
          const by = b >> 2;
          const X = x0 + bx * 4;
          const Yp = y0 + by * 4;
          // edge pixels for this subblock
          for (let i = 0; i < 4; i++) edge[5 + i] = Yp > 0 ? Y[(Yp - 1) * yStride + X + i] : 127;
          for (let i = 0; i < 4; i++) edge[3 - i] = X > 0 ? Y[(Yp + i) * yStride + X - 1] : 129;
          edge[4] = Yp === 0 ? 127 : X === 0 ? 129 : Y[(Yp - 1) * yStride + X - 1];
          for (let i = 4; i < 8; i++) {
            let v;
            if (bx < 3) v = Yp > 0 ? Y[(Yp - 1) * yStride + X + i] : 127;
            else if (mby === 0) v = 127;
            else if (mbx === mbCols - 1) v = Y[(y0 - 1) * yStride + x0 + 15];
            else v = Y[(y0 - 1) * yStride + x0 + 16 + (i - 4)];
            edge[5 + i] = v;
          }
          predictSubblock(edge, modes[b], sub);
          for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) Y[(Yp + r) * yStride + X + c] = sub[r * 4 + c];
          if (anyTokens) addInverseDct(coeffs, b * 16, Y, Yp * yStride + X, yStride);
        }
      } else {
        predictBlock(Y, yStride, x0, y0, 16, ymode);
        if (anyTokens) {
          for (let b = 0; b < 16; b++) {
            addInverseDct(coeffs, b * 16, Y, (y0 + (b >> 2) * 4) * yStride + x0 + (b & 3) * 4, yStride);
          }
        }
      }
      const cx = mbx * 8;
      const cy = mby * 8;
      predictBlock(U, cStride, cx, cy, 8, uvmode);
      predictBlock(V, cStride, cx, cy, 8, uvmode);
      if (anyTokens) {
        for (let b = 0; b < 4; b++) {
          const ox = cx + (b & 1) * 4;
          const oy = cy + (b >> 1) * 4;
          addInverseDct(coeffs, (16 + b) * 16, U, oy * cStride + ox, cStride);
          addInverseDct(coeffs, (20 + b) * 16, V, oy * cStride + ox, cStride);
        }
      }
    }
  }

  if (hdr.filterLevel) loopFilter(hdr, { Y, U, V, yStride, cStride, mbCols, mbRows, filterLevel, innerEdges });
  return { width, height, Y, U, V, yStride, cStride };
}

/** The loop filter level of a macroblock: the frame's, adjusted by its segment and its mode and reference. */
function filterLevelFor(hdr, segment, ymode) {
  let level = hdr.filterLevel;
  if (hdr.seg.enabled) level = hdr.seg.abs ? hdr.seg.lf[segment] : level + hdr.seg.lf[segment];
  level = level < 0 ? 0 : level > 63 ? 63 : level;
  if (hdr.lfDeltas.enabled) {
    level += hdr.lfDeltas.ref[0]; // intra macroblock
    if (ymode === B_PRED) level += hdr.lfDeltas.mode[0];
    level = level < 0 ? 0 : level > 63 ? 63 : level;
  }
  return level;
}

// ---- loop filter (RFC 6386, section 15)

const s8 = (v) => (v < -128 ? -128 : v > 127 ? 127 : v); // the clamp "c" of the spec
const u2s = (v) => v - 128;
const s2u = (v) => s8(v) + 128;

/**
 * common_adjust: moves p0 and q0 towards each other and returns the adjustment applied to q0. The pixels are given by
 * index: i is q0, i - step is p0, i - 2 * step is p1 and i + step is q1.
 */
function commonAdjustAt(useOuterTaps, pix, i, step) {
  const p1 = u2s(pix[i - 2 * step]);
  const p0 = u2s(pix[i - step]);
  const q0 = u2s(pix[i]);
  const q1 = u2s(pix[i + step]);
  let a = s8((useOuterTaps ? s8(p1 - q1) : 0) + 3 * (q0 - p0));
  const b = s8(a + 3) >> 3;
  a = s8(a + 4) >> 3;
  pix[i] = s2u(q0 - a);
  pix[i - step] = s2u(p0 + b);
  return a;
}

/** The simple filter for one segment across an edge (section 15.2). */
function simpleSegment(pix, i, step, edgeLimit) {
  const p1 = pix[i - 2 * step];
  const p0 = pix[i - step];
  const q0 = pix[i];
  const q1 = pix[i + step];
  if (Math.abs(p0 - q0) * 2 + (Math.abs(p1 - q1) >> 1) <= edgeLimit) commonAdjustAt(true, pix, i, step);
}

/** The normal filter for one segment across an edge (section 15.3): pix[i] is q0, pix[i - step] is p0. */
function normalSegment(pix, i, step, edgeLimit, interior, hevThreshold, mbEdge) {
  const p3 = pix[i - 4 * step];
  const p2 = pix[i - 3 * step];
  const p1 = pix[i - 2 * step];
  const p0 = pix[i - step];
  const q0 = pix[i];
  const q1 = pix[i + step];
  const q2 = pix[i + 2 * step];
  const q3 = pix[i + 3 * step];
  const filterYes = Math.abs(p0 - q0) * 2 + (Math.abs(p1 - q1) >> 1) <= edgeLimit
    && Math.abs(p3 - p2) <= interior && Math.abs(p2 - p1) <= interior && Math.abs(p1 - p0) <= interior
    && Math.abs(q3 - q2) <= interior && Math.abs(q2 - q1) <= interior && Math.abs(q1 - q0) <= interior;
  if (!filterYes) return;
  const hev = Math.abs(p1 - p0) > hevThreshold || Math.abs(q1 - q0) > hevThreshold;
  if (mbEdge) {
    if (!hev) {
      const sp1 = u2s(p1);
      const sp0 = u2s(p0);
      const sq0 = u2s(q0);
      const sq1 = u2s(q1);
      const sq2 = u2s(q2);
      const sp2 = u2s(p2);
      const w = s8(s8(sp1 - sq1) + 3 * (sq0 - sp0));
      let a = s8((27 * w + 63) >> 7);
      pix[i] = s2u(sq0 - a);
      pix[i - step] = s2u(sp0 + a);
      a = s8((18 * w + 63) >> 7);
      pix[i + step] = s2u(sq1 - a);
      pix[i - 2 * step] = s2u(sp1 + a);
      a = s8((9 * w + 63) >> 7);
      pix[i + 2 * step] = s2u(sq2 - a);
      pix[i - 3 * step] = s2u(sp2 + a);
    } else {
      commonAdjustAt(true, pix, i, step);
    }
  } else {
    const sp1 = u2s(p1);
    const sq1 = u2s(q1);
    const a = (commonAdjustAt(hev, pix, i, step) + 1) >> 1;
    if (!hev) {
      pix[i + step] = s2u(sq1 - a);
      pix[i - 2 * step] = s2u(sp1 + a);
    }
  }
}

/** The loop filter over the whole picture, macroblock by macroblock in raster order (section 15.1). */
function loopFilter(hdr, pic) {
  const { Y, U, V, yStride, cStride, mbCols, mbRows, filterLevel, innerEdges } = pic;
  const sharp = hdr.sharpness;
  for (let mby = 0; mby < mbRows; mby++) {
    for (let mbx = 0; mbx < mbCols; mbx++) {
      const mb = mby * mbCols + mbx;
      const level = filterLevel[mb];
      if (!level) continue;
      let interior = level;
      if (sharp) {
        interior >>= sharp > 4 ? 2 : 1;
        if (interior > 9 - sharp) interior = 9 - sharp;
      }
      if (!interior) interior = 1;
      let hevThreshold = 0;
      if (level >= 40) hevThreshold = 2;
      else if (level >= 15) hevThreshold = 1;
      const mbLimit = (level + 2) * 2 + interior;
      const subLimit = level * 2 + interior;
      const inner = innerEdges[mb] === 1;

      if (hdr.simpleFilter) {
        const base = mby * 16 * yStride + mbx * 16;
        if (mbx > 0) for (let r = 0; r < 16; r++) simpleSegment(Y, base + r * yStride, 1, mbLimit);
        if (inner) for (let x = 4; x < 16; x += 4) for (let r = 0; r < 16; r++) simpleSegment(Y, base + r * yStride + x, 1, subLimit);
        if (mby > 0) for (let c = 0; c < 16; c++) simpleSegment(Y, base + c, yStride, mbLimit);
        if (inner) for (let y = 4; y < 16; y += 4) for (let c = 0; c < 16; c++) simpleSegment(Y, base + y * yStride + c, yStride, subLimit);
        continue;
      }
      const yBase = mby * 16 * yStride + mbx * 16;
      const cBase = mby * 8 * cStride + mbx * 8;
      // Order within a macroblock: left edge, inner vertical edges, top edge, inner horizontal edges
      const filterPlane = (pix, base, stride, size) => {
        if (mbx > 0) for (let r = 0; r < size; r++) normalSegment(pix, base + r * stride, 1, mbLimit, interior, hevThreshold, true);
        if (inner) {
          for (let x = 4; x < size; x += 4) {
            for (let r = 0; r < size; r++) normalSegment(pix, base + r * stride + x, 1, subLimit, interior, hevThreshold, false);
          }
        }
        if (mby > 0) for (let c = 0; c < size; c++) normalSegment(pix, base + c, stride, mbLimit, interior, hevThreshold, true);
        if (inner) {
          for (let y = 4; y < size; y += 4) {
            for (let c = 0; c < size; c++) normalSegment(pix, base + y * stride + c, stride, subLimit, interior, hevThreshold, false);
          }
        }
      };
      filterPlane(Y, yBase, yStride, 16);
      filterPlane(U, cBase, cStride, 8);
      filterPlane(V, cBase, cStride, 8);
    }
  }
}

/** YUV to RGB, with the fixed-point coefficients the WebP reference uses. */
const mulHi = (v, coeff) => (v * coeff) >> 8;
function yuvToRgba(frame, alpha) {
  const { width, height, Y, U, V, yStride, cStride } = frame;
  const out = new Uint8Array(width * height * 4);
  const cw = (width + 1) >> 1;
  const ch = (height + 1) >> 1;
  // Chroma is sampled at half resolution and interpolated with the 9-3-3-1 kernel: each picture pixel takes most of
  // its chroma from the nearest chroma sample, a quarter-weight share from the neighbour on its side horizontally and
  // vertically, and the rest from the diagonal neighbour.
  const chroma = (plane, x, y) => {
    const cx = x >> 1;
    const cy = y >> 1;
    const nx = Math.min(cw - 1, Math.max(0, (x & 1) ? cx + 1 : cx - 1));
    const ny = Math.min(ch - 1, Math.max(0, (y & 1) ? cy + 1 : cy - 1));
    const a = plane[cy * cStride + cx];
    const b = plane[cy * cStride + nx];
    const c = plane[ny * cStride + cx];
    const d = plane[ny * cStride + nx];
    return (9 * a + 3 * b + 3 * c + d + 8) >> 4;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const yy = Y[y * yStride + x];
      const uu = chroma(U, x, y);
      const vv = chroma(V, x, y);
      const o = (y * width + x) * 4;
      // the sums carry 6 extra bits of precision: shift them out, then clip to a byte
      out[o] = clamp255((mulHi(yy, 19077) + mulHi(vv, 26149) - 14234) >> 6);
      out[o + 1] = clamp255((mulHi(yy, 19077) - mulHi(uu, 6419) - mulHi(vv, 13320) + 8708) >> 6);
      out[o + 2] = clamp255((mulHi(yy, 19077) + mulHi(uu, 33050) - 17685) >> 6);
      out[o + 3] = alpha ? alpha[y * width + x] : 255;
    }
  }
  return out;
}

/**
 * Decodes a lossy WebP picture: the VP8 frame of a VP8 chunk.
 * @param {Uint8Array} buf the frame data
 * @param {(width: number, height: number) => Uint8Array|null} [makeAlpha] gives the alpha plane (one byte per pixel)
 *   once the picture size is known, for files with an ALPH chunk
 * @returns {{width: number, height: number, channels: 4, data: Uint8Array}}
 */
export function decodeVP8(buf, makeAlpha = null) {
  const frame = decodeFrame(buf);
  const alpha = makeAlpha ? makeAlpha(frame.width, frame.height) : null;
  if (alpha && alpha.length !== frame.width * frame.height) throw new VP8Error('alpha plane size does not match');
  return { width: frame.width, height: frame.height, channels: 4, data: yuvToRgba(frame, alpha) };
}
