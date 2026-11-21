// Baseline JPEG decoder (8-bit, Huffman coding, 1 or 3 components, restart intervals). Progressive and arithmetic
// JPEGs are not supported and throw. Pure JavaScript, no dependencies. Ported from the decoder the can's own texture
// tooling used, with restart-marker support added.
//
// decodeJpeg(bytes) -> { width, height, channels: 3, data } where data is RGB, row by row, top row first.

const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

// Basis for the inverse DCT: A[x*8+u] = C(u)/2 * cos((2x+1) u pi / 16)
const A = new Float64Array(64);
for (let x = 0; x < 8; x++) {
  for (let u = 0; u < 8; u++) {
    const cu = u === 0 ? Math.SQRT1_2 : 1;
    A[x * 8 + u] = (cu / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function idct(F, out) {
  const tmp = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += A[y * 8 + v] * F[v * 8 + u];
      tmp[y * 8 + u] = s;
    }
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += A[x * 8 + u] * tmp[y * 8 + u];
      out[y * 8 + x] = clamp8(Math.round(s + 128));
    }
  }
}

function buildHuffman(counts, vals) {
  const maxcode = new Int32Array(17).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    valptr[len] = k;
    mincode[len] = code;
    code += counts[len - 1];
    k += counts[len - 1];
    maxcode[len] = counts[len - 1] ? code - 1 : -1;
    code <<= 1;
  }
  return { maxcode, valptr, mincode, vals };
}

// Bit reader over entropy-coded data. FF00 is a stuffed 0xFF; any other marker stops the reader.
function bit(br) {
  if (br.n === 0) {
    let b = 0;
    if (!br.marker) {
      b = br.buf[br.pos];
      if (b === 0xff) {
        if (br.buf[br.pos + 1] === 0) br.pos += 2;
        else {
          br.marker = true;
          b = 0;
        }
      } else {
        br.pos++;
      }
    }
    br.acc = b;
    br.n = 8;
  }
  br.n--;
  return (br.acc >> br.n) & 1;
}

function bits(br, k) {
  let v = 0;
  for (let i = 0; i < k; i++) v = (v << 1) | bit(br);
  return v;
}

function huffDecode(br, t) {
  let code = 0;
  for (let len = 1; len <= 16; len++) {
    code = (code << 1) | bit(br);
    if (t.maxcode[len] >= 0 && code <= t.maxcode[len]) {
      return t.vals[t.valptr[len] + code - t.mincode[len]];
    }
  }
  throw new Error('bad Huffman code');
}

function receive(br, s) {
  const v = bits(br, s);
  return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
}

/** After a restart interval: skip to the RSTn marker, and continue after it. */
function restart(br) {
  br.n = 0;
  br.marker = false;
  let p = br.pos;
  while (p + 1 < br.buf.length && !(br.buf[p] === 0xff && br.buf[p + 1] >= 0xd0 && br.buf[p + 1] <= 0xd7)) p++;
  br.pos = p + 2;
}

function decodeScan(buf, start, frame, scomps, qt, huff, restartInterval) {
  const hmax = Math.max(...frame.comps.map((c) => c.h));
  const vmax = Math.max(...frame.comps.map((c) => c.v));
  const mcusX = Math.ceil(frame.w / (8 * hmax));
  const mcusY = Math.ceil(frame.h / (8 * vmax));
  for (const c of frame.comps) {
    c.pw = mcusX * c.h * 8;
    c.ph = mcusY * c.v * 8;
    c.plane = new Uint8Array(c.pw * c.ph);
    c.pred = 0;
  }
  const scan = scomps.map((sc) => {
    const c = frame.comps.find((cc) => cc.id === sc.id);
    if (!c) throw new Error('scan refers to an unknown component');
    return { c, dc: huff[sc.td], ac: huff[4 + sc.ta], q: qt[c.tq] };
  });
  const br = { buf, pos: start, acc: 0, n: 0, marker: false };
  const F = new Float64Array(64);
  const coef = new Int32Array(64);
  const blk = new Uint8Array(64);
  let mcu = 0;
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
        restart(br);
        for (const c of frame.comps) c.pred = 0;
      }
      mcu++;
      for (const s of scan) {
        const c = s.c;
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            coef.fill(0);
            const t = huffDecode(br, s.dc);
            const diff = t ? receive(br, t) : 0;
            c.pred += diff;
            coef[0] = c.pred;
            for (let k = 1; k < 64;) {
              const rs = huffDecode(br, s.ac);
              const r = rs >> 4;
              const sz = rs & 15;
              if (sz === 0) {
                if (r === 15) {
                  k += 16;
                  continue;
                }
                break;
              }
              k += r;
              if (k > 63) break;
              coef[ZZ[k]] = receive(br, sz);
              k++;
            }
            for (let i = 0; i < 64; i++) F[i] = coef[i] * s.q[i];
            idct(F, blk);
            const ox = (mx * c.h + bx) * 8;
            const oy = (my * c.v + by) * 8;
            for (let y = 0; y < 8; y++) {
              for (let x = 0; x < 8; x++) c.plane[(oy + y) * c.pw + ox + x] = blk[y * 8 + x];
            }
          }
        }
      }
    }
  }
  return br.pos;
}

// Full-resolution plane for one component. Half-size chroma gets libjpeg's "fancy" 2x2 upsampling (3:1 weights).
function fullRes(c, w, h, hmax, vmax) {
  const out = new Uint8Array(w * h);
  if (c.h * 2 === hmax && c.v * 2 === vmax) {
    const cwid = Math.ceil(w / 2);
    const chgt = Math.ceil(h / 2);
    const colsum = new Int32Array(cwid);
    for (let y = 0; y < h; y++) {
      const cy = y >> 1;
      const ny = y & 1 ? Math.min(cy + 1, chgt - 1) : Math.max(cy - 1, 0);
      for (let x = 0; x < cwid; x++) colsum[x] = 3 * c.plane[cy * c.pw + x] + c.plane[ny * c.pw + x];
      for (let x = 0; x < w; x++) {
        const cx = x >> 1;
        out[y * w + x] = x & 1
          ? (3 * colsum[cx] + (cx + 1 < cwid ? colsum[cx + 1] : colsum[cx]) + 7) >> 4
          : (3 * colsum[cx] + (cx > 0 ? colsum[cx - 1] : colsum[cx]) + 8) >> 4;
      }
    }
    return out;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = c.plane[Math.floor((y * c.v) / vmax) * c.pw + Math.floor((x * c.h) / hmax)];
    }
  }
  return out;
}

function toRgb(frame) {
  const { w, h, comps } = frame;
  const hmax = Math.max(...comps.map((c) => c.h));
  const vmax = Math.max(...comps.map((c) => c.v));
  const out = new Uint8Array(w * h * 3);
  if (comps.length === 1) {
    const g = fullRes(comps[0], w, h, hmax, vmax);
    for (let i = 0; i < w * h; i++) out[i * 3] = g[i];
    for (let i = 0; i < w * h; i++) out[i * 3 + 1] = g[i];
    for (let i = 0; i < w * h; i++) out[i * 3 + 2] = g[i];
    return { w, h, data: out };
  }
  const [Yc, Cbc, Crc] = comps;
  const Yf = fullRes(Yc, w, h, hmax, vmax);
  const Cbf = fullRes(Cbc, w, h, hmax, vmax);
  const Crf = fullRes(Crc, w, h, hmax, vmax);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const Y = Yf[y * w + x];
      const cb = Cbf[y * w + x] - 128;
      const cr = Crf[y * w + x] - 128;
      const i = (y * w + x) * 3;
      out[i] = clamp8(Math.round(Y + 1.402 * cr));
      out[i + 1] = clamp8(Math.round(Y - 0.344136 * cb - 0.714136 * cr));
      out[i + 2] = clamp8(Math.round(Y + 1.772 * cb));
    }
  }
  return { w, h, data: out };
}

/** Decodes a baseline JPEG. Returns {width, height, channels: 3, data} with RGB bytes, top row first. */
export function decodeJpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  const qt = [];
  const huff = [];
  let frame = null;
  let restartInterval = 0;
  let pos = 2;
  for (;;) {
    while (pos < buf.length && buf[pos] !== 0xff) pos++;
    if (pos >= buf.length) throw new Error('truncated JPEG');
    const m = buf[pos + 1];
    if (m === 0xff) {
      pos++;
      continue;
    }
    pos += 2;
    if (m === 0xd9) break; // end of image
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // markers without a length
    const len = (buf[pos] << 8) | buf[pos + 1];
    const seg = pos + 2;
    const end = pos + len;
    if (m === 0xdb) {
      let p = seg;
      while (p < end) {
        if (buf[p] >> 4) throw new Error('16-bit quantisation tables are not supported');
        const id = buf[p] & 15;
        p++;
        const t = new Int32Array(64);
        for (let k = 0; k < 64; k++) t[ZZ[k]] = buf[p + k];
        qt[id] = t;
        p += 64;
      }
    } else if (m === 0xc4) {
      let p = seg;
      while (p < end) {
        const cls = buf[p] >> 4;
        const id = buf[p] & 15;
        p++;
        const counts = [];
        let total = 0;
        for (let i = 0; i < 16; i++) {
          counts.push(buf[p + i]);
          total += buf[p + i];
        }
        p += 16;
        const vals = [];
        for (let i = 0; i < total; i++) vals.push(buf[p + i]);
        p += total;
        huff[cls * 4 + id] = buildHuffman(counts, vals);
      }
    } else if (m === 0xdd) {
      restartInterval = (buf[seg] << 8) | buf[seg + 1];
    } else if (m === 0xc0 || m === 0xc1) {
      const nc = buf[seg + 5];
      const comps = [];
      for (let c = 0; c < nc; c++) {
        const q = seg + 6 + c * 3;
        comps.push({ id: buf[q], h: buf[q + 1] >> 4, v: buf[q + 1] & 15, tq: buf[q + 2] });
      }
      frame = { h: (buf[seg + 1] << 8) | buf[seg + 2], w: (buf[seg + 3] << 8) | buf[seg + 4], comps };
    } else if (m >= 0xc2 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw new Error('progressive or arithmetic JPEG is not supported');
    } else if (m === 0xda) {
      if (!frame) throw new Error('scan before frame header');
      const ns = buf[seg];
      const scomps = [];
      for (let c = 0; c < ns; c++) {
        const tt = buf[seg + 2 + c * 2];
        scomps.push({ id: buf[seg + 1 + c * 2], td: tt >> 4, ta: tt & 15 });
      }
      pos = decodeScan(buf, end, frame, scomps, qt, huff, restartInterval);
      continue;
    }
    pos = end;
  }
  if (!frame) throw new Error('no frame');
  const rgb = toRgb(frame);
  return { width: rgb.w, height: rgb.h, channels: 3, data: rgb.data };
}
