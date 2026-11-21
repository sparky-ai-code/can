// Decodes the image formats the renderer can draw: PNG (8-bit RGB or RGBA), baseline JPEG, WebP (lossy and lossless,
// with alpha and the first frame of an animation) and SVG (basic shapes and paths, rasterised). The format is found
// from the file's first bytes, not its name. Other formats (GIF, progressive JPEG) return null and are drawn as
// outlines with their alt text.
import { decodePNG } from './png.js';
import { decodeJpeg } from './jpeg.js';
import { isWebP, decodeWebP } from './webp.js';
import { looksLikeSvg, decodeSvg } from './svg.js';

/**
 * @param {Uint8Array} buf the file's bytes
 * @param {{width?: number, height?: number}} [hint] the size the page shows the picture at (used by SVG only)
 * @returns {{width: number, height: number, channels: number, data: Uint8Array|Buffer} | null}
 */
export function decodeImage(buf, hint = {}) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return decodePNG(buf);
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return decodeJpeg(buf);
  if (isWebP(buf)) return decodeWebP(buf);
  if (looksLikeSvg(buf)) return decodeSvg(buf, hint);
  return null;
}
