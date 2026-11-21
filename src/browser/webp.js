// WebP files: the RIFF container, the still picture in it (lossless VP8L or lossy VP8), its alpha plane (ALPH) and the
// first frame of an animation. Pictures are decoded to RGBA, the same as every other format the renderer draws.
import { decodeVP8L, decodeVP8LAlpha } from './vp8l.js';
import { decodeVP8 } from './vp8.js';

const str = (buf, at, n) => String.fromCharCode(...buf.subarray(at, at + n));
const u32 = (buf, at) => (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0;

/** True if the bytes are a WebP file ("RIFF....WEBP"). */
export function isWebP(buf) {
  return buf.length >= 12 && str(buf, 0, 4) === 'RIFF' && str(buf, 8, 4) === 'WEBP';
}

/** The picture chunks of a run of RIFF chunks: the first VP8 or VP8L, and the ALPH that goes with it. */
function findPicture(buf, start, end, out = { alph: null, vp8: null, vp8l: null }) {
  let pos = start;
  while (pos + 8 <= end) {
    const tag = str(buf, pos, 4);
    const size = u32(buf, pos + 4);
    const body = pos + 8;
    const bodyEnd = Math.min(end, body + size);
    if (tag === 'VP8L' && !out.vp8l && !out.vp8) out.vp8l = buf.subarray(body, bodyEnd);
    else if (tag === 'VP8 ' && !out.vp8l && !out.vp8) out.vp8 = buf.subarray(body, bodyEnd);
    else if (tag === 'ALPH' && !out.alph) out.alph = buf.subarray(body, bodyEnd);
    else if (tag === 'ANMF' && !out.vp8l && !out.vp8) {
      // An animation frame: 16 bytes of frame header, then its own chunks. Only the first frame is drawn.
      findPicture(buf, body + 16, bodyEnd, out);
    }
    pos = body + size + (size & 1);
  }
  return out;
}

/**
 * The alpha plane from an ALPH chunk: optional filtering of the values, and either raw bytes or a lossless stream.
 * Returns null when the chunk cannot be used, so the picture is drawn opaque.
 */
function decodeAlpha(alph, width, height) {
  if (!alph || alph.length < 1) return null;
  const compression = alph[0] & 0x3;
  const filter = (alph[0] >> 2) & 0x3;
  let plane;
  if (compression === 0) {
    if (alph.length < 1 + width * height) return null;
    plane = Uint8Array.from(alph.subarray(1, 1 + width * height));
  } else if (compression === 1) {
    plane = decodeVP8LAlpha(alph.subarray(1), width, height);
  } else {
    return null;
  }
  unfilter(plane, width, height, filter);
  return plane;
}

/** Undoes the spatial prediction of the alpha values (none, horizontal, vertical, gradient). */
function unfilter(plane, w, h, filter) {
  if (filter === 0) return;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (y === 0 && x === 0) continue; // the first value is stored as it is
      let pred;
      if (y === 0) pred = plane[i - 1]; // top row: from the left
      else if (x === 0) pred = plane[i - w]; // left column: from above
      else if (filter === 1) pred = plane[i - 1]; // horizontal
      else if (filter === 2) pred = plane[i - w]; // vertical
      else {
        // gradient: left + above - above-left, clipped to 0..255
        const g = plane[i - 1] + plane[i - w] - plane[i - w - 1];
        pred = g < 0 ? 0 : g > 255 ? 255 : g;
      }
      plane[i] = (plane[i] + pred) & 0xff;
    }
  }
}

/**
 * Decodes a WebP file's first picture to RGBA.
 * @returns {{width: number, height: number, channels: 4, data: Uint8Array}}
 */
export function decodeWebP(buf) {
  const pic = findPicture(buf, 12, buf.length);
  if (pic.vp8l) return decodeVP8L(pic.vp8l);
  if (pic.vp8) return decodeVP8(pic.vp8, (w, h) => decodeAlpha(pic.alph, w, h));
  throw new Error('WebP file has no picture');
}
