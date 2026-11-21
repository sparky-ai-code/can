// PNG encoder and decoder, written from the PNG specification (ISO/IEC 15948). The chunk layout and the
// CRC-32 are done here; only the DEFLATE stream comes from node:zlib. The decoder covers what this
// encoder writes and any 8-bit, non-interlaced RGB or RGBA file, so tests can read screenshots back.
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE = { 3: 2, 4: 6 }; // channels -> PNG colour type (2 = RGB, 6 = RGBA)
const MAX_DIMENSION = 0x7fffffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3, as PNG uses it) of a buffer. */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encodes pixels as a PNG file. `data` holds width*height*channels bytes, row by row, top row first.
 * channels 4 writes RGBA, channels 3 writes RGB. Every row uses filter type 0 (none).
 * @returns {Buffer}
 */
export function encodePNG({ width, height, data, channels = 4, level = 6 }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new RangeError(`PNG size must be positive integers (got ${width}x${height})`);
  }
  if (channels !== 3 && channels !== 4) throw new RangeError('PNG channels must be 3 (RGB) or 4 (RGBA)');
  const stride = width * channels;
  if (!data || data.length !== stride * height) {
    throw new RangeError(`PNG data must hold ${stride * height} bytes (got ${data ? data.length : 0})`);
  }
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter type: none
    raw.set(data.subarray(y * stride, (y + 1) * stride), row + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = COLOR_TYPE[channels];
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive (per-row byte above)
  ihdr[12] = 0; // interlace: none
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Width and height read from the IHDR of a PNG file, without decoding the pixels. */
export function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG file');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Decodes an 8-bit, non-interlaced RGB or RGBA PNG. Verifies every chunk's CRC.
 * @returns {{width: number, height: number, channels: number, data: Buffer}} data is top row first
 */
export function decodePNG(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file (bad signature)');
  let pos = 8;
  let header = null;
  const idat = [];
  let sawEnd = false;
  while (pos < buf.length) {
    if (pos + 12 > buf.length) throw new Error('truncated PNG chunk');
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (body.length !== len || pos + 12 + len > buf.length) throw new Error(`truncated ${type} chunk`);
    const stored = buf.readUInt32BE(pos + 8 + len);
    if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== stored) throw new Error(`bad CRC in ${type} chunk`);
    if (type === 'IHDR') header = parseHeader(body);
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') { sawEnd = true; break; }
    pos += 12 + len;
  }
  if (!header) throw new Error('PNG has no IHDR');
  if (!sawEnd) throw new Error('PNG has no IEND');
  const { width, height, channels } = header;
  const stride = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  if (inflated.length !== (stride + 1) * height) throw new Error('PNG pixel data has the wrong length');
  const out = Buffer.alloc(stride * height);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    const src = inflated.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    const prior = y > 0 ? row - stride : -1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = prior >= 0 ? out[prior + x] : 0;
      const c = prior >= 0 && x >= bpp ? out[prior + x - bpp] : 0;
      let predictor;
      switch (filter) {
        case 0: predictor = 0; break;
        case 1: predictor = a; break;
        case 2: predictor = b; break;
        case 3: predictor = (a + b) >> 1; break;
        case 4: predictor = paeth(a, b, c); break;
        default: throw new Error(`unknown PNG filter type ${filter}`);
      }
      out[row + x] = (src[x] + predictor) & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function parseHeader(body) {
  if (body.length !== 13) throw new Error('bad IHDR length');
  const width = body.readUInt32BE(0);
  const height = body.readUInt32BE(4);
  const depth = body[8];
  const colour = body[9];
  if (depth !== 8 || (colour !== 2 && colour !== 6) || body[12] !== 0) {
    throw new Error('unsupported PNG: only 8-bit RGB or RGBA, non-interlaced, is decoded');
  }
  return { width, height, channels: colour === 2 ? 3 : 4 };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
