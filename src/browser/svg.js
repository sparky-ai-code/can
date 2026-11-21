// SVG rasteriser: draws an SVG picture to RGBA pixels, so it can be shown like a bitmap. Supports the document's shapes
// (rect, circle, ellipse, line, polyline, polygon, path), groups, <use>, transforms, viewBox, fills and strokes with
// their opacity, colours (hex, rgb(), named colours, currentColor), <style> rules with simple selectors, and gradients
// drawn as their average stop colour. Text, images, filters, masks, clipping and patterns are not drawn.
// Edges are anti-aliased with four sub-scanlines per pixel row and exact horizontal coverage.

const MAX_SIDE = 4096;
const MAX_PIXELS = 1 << 24;
const MAX_USE_DEPTH = 8;
const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 150;
const SUBSAMPLES = 4;

/** True if the bytes look like an SVG document (an <svg> element near the start). */
export function looksLikeSvg(buf) {
  if (buf.length < 5 || buf.subarray(0, 512).includes(0)) return false;
  const head = Buffer.from(buf.subarray(0, Math.min(buf.length, 4096))).toString('utf8');
  return /<svg[\s>]/.test(head.replace(/^﻿/, ''));
}

// ---------------------------------------------------------------- XML

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** A small XML reader: elements, attributes, text and CDATA. Comments, processing instructions and DOCTYPE are skipped. */
function parseXml(text) {
  const root = { tag: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      stack[stack.length - 1].text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(text.slice(i, lt));
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      stack[stack.length - 1].text += text.slice(i + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
    } else if (text.startsWith('<?', i) || text.startsWith('<!', i)) {
      // processing instruction or DOCTYPE (which may carry an internal subset in brackets)
      let depth = 0;
      let j = i + 2;
      for (; j < n; j++) {
        const c = text[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (text[i + 1] === '/') {
      const end = text.indexOf('>', i);
      const name = text.slice(i + 2, end < 0 ? n : end).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? n : end + 1;
    } else {
      // a start tag
      let j = i + 1;
      while (j < n && !/[\s/>]/.test(text[j])) j++;
      const tag = text.slice(i + 1, j).replace(/^[^:]*:/, '');
      const attrs = {};
      let selfClosing = false;
      while (j < n) {
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] === '>') { j++; break; }
        if (text[j] === '/' && text[j + 1] === '>') { selfClosing = true; j += 2; break; }
        let k = j;
        while (k < n && !/[\s=/>]/.test(text[k])) k++;
        const name = text.slice(j, k);
        j = k;
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] !== '=') {
          if (name) attrs[name.replace(/^.*:(?=.)/, '')] = '';
          continue;
        }
        j++;
        while (j < n && /\s/.test(text[j])) j++;
        const quote = text[j];
        let value;
        if (quote === '"' || quote === "'") {
          const end = text.indexOf(quote, j + 1);
          value = text.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          let e = j;
          while (e < n && !/[\s>]/.test(text[e])) e++;
          value = text.slice(j, e);
          j = e;
        }
        attrs[name.replace(/^.*:(?=.)/, '')] = decodeEntities(value);
      }
      const el = { tag, attrs, children: [], text: '', parent: stack[stack.length - 1] };
      stack[stack.length - 1].children.push(el);
      if (!selfClosing) stack.push(el);
      i = j;
    }
  }
  return root;
}

// ---------------------------------------------------------------- CSS

/** Parses a stylesheet into rules: {selector, specificity, decls}. Only simple selectors are used. */
function parseCss(text) {
  const rules = [];
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const decls = parseDecls(m[2]);
    for (const sel of m[1].split(',')) {
      const selector = sel.trim();
      if (!selector || selector.startsWith('@')) continue;
      rules.push({ selector, specificity: specificity(selector), decls });
    }
  }
  return rules;
}

function specificity(selector) {
  let s = 0;
  if (/#[\w-]+/.test(selector)) s += 100;
  s += 10 * (selector.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
  s += (selector.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return s;
}

/** Whether a simple selector (tag, .class, #id, *, and compounds of them) matches an element. */
function matches(el, selector) {
  // a descendant chain: "g path" means path with a g ancestor; only the last compound is tested on the element itself
  const parts = selector.split(/\s*[>\s]\s*/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!compoundMatches(el, last)) return false;
  let node = el.parent;
  for (let k = parts.length - 2; k >= 0; k--) {
    while (node && node.tag !== '#document' && !compoundMatches(node, parts[k])) node = node.parent;
    if (!node || node.tag === '#document') return false;
    node = node.parent;
  }
  return true;
}

function compoundMatches(el, compound) {
  if (!compound || el.tag === '#document') return false;
  const re = /([.#]?)([\w-]+|\*)/g;
  let m;
  const classes = (el.attrs.class ?? '').split(/\s+/);
  while ((m = re.exec(compound))) {
    if (m[1] === '') {
      if (m[2] !== '*' && m[2] !== el.tag) return false;
    } else if (m[1] === '.') {
      if (!classes.includes(m[2])) return false;
    } else if (m[1] === '#') {
      if (el.attrs.id !== m[2]) return false;
    }
  }
  return true;
}

function parseDecls(text) {
  const out = {};
  for (const part of text.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    value = value.replace(/\s*!important\s*$/i, '');
    if (name) out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------- values

const NAMED = {
  black: '000000', silver: 'c0c0c0', gray: '808080', grey: '808080', white: 'ffffff', maroon: '800000', red: 'ff0000',
  purple: '800080', fuchsia: 'ff00ff', magenta: 'ff00ff', green: '008000', lime: '00ff00', olive: '808000', yellow: 'ffff00',
  navy: '000080', blue: '0000ff', teal: '008080', aqua: '00ffff', cyan: '00ffff', orange: 'ffa500', pink: 'ffc0cb',
  brown: 'a52a2a', gold: 'ffd700', indigo: '4b0082', violet: 'ee82ee', coral: 'ff7f50', crimson: 'dc143c', khaki: 'f0e68c',
  salmon: 'fa8072', tan: 'd2b48c', tomato: 'ff6347', turquoise: '40e0d0', plum: 'dda0dd', orchid: 'da70d6', ivory: 'fffff0',
  beige: 'f5f5dc', lavender: 'e6e6fa', linen: 'faf0e6', snow: 'fffafa', wheat: 'f5deb3', chocolate: 'd2691e',
  darkgray: 'a9a9a9', darkgrey: 'a9a9a9', lightgray: 'd3d3d3', lightgrey: 'd3d3d3', darkgreen: '006400',
  lightgreen: '90ee90', darkblue: '00008b', lightblue: 'add8e6', darkred: '8b0000', lightyellow: 'ffffe0',
  skyblue: '87ceeb', steelblue: '4682b4', royalblue: '4169e1', slategray: '708090', slategrey: '708090',
  dimgray: '696969', dimgrey: '696969', whitesmoke: 'f5f5f5', gainsboro: 'dcdcdc', aliceblue: 'f0f8ff',
  seagreen: '2e8b57', forestgreen: '228b22', limegreen: '32cd32', darkorange: 'ff8c00', goldenrod: 'daa520',
  hotpink: 'ff69b4', deeppink: 'ff1493', firebrick: 'b22222', sienna: 'a0522d', peru: 'cd853f', azure: 'f0ffff',
  mintcream: 'f5fffa', honeydew: 'f0fff0', midnightblue: '191970', darkviolet: '9400d3', darkcyan: '008b8b',
  cornflowerblue: '6495ed', dodgerblue: '1e90ff', deepskyblue: '00bfff', rebeccapurple: '663399',
};

/** A colour as {r, g, b, a} (0..255, alpha 0..1), or null if the text is not one. */
function parseColor(text, currentColor) {
  const s = text.trim().toLowerCase();
  if (s === 'currentcolor') return currentColor;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s[0] === '#') {
    const hex = s.slice(1);
    if (/^[0-9a-f]{3}$/.test(hex)) return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16), a: 1 };
    if (/^[0-9a-f]{4}$/.test(hex)) return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16), a: parseInt(hex[3] + hex[3], 16) / 255 };
    if (/^[0-9a-f]{6}$/.test(hex)) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
    if (/^[0-9a-f]{8}$/.test(hex)) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: parseInt(hex.slice(6, 8), 16) / 255 };
    return null;
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(s);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (p) => {
      const v = Number.parseFloat(p);
      if (!Number.isFinite(v)) return 0;
      return p.endsWith('%') ? (v * 255) / 100 : v;
    };
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
    const a = parts[3] === undefined ? 1 : Math.max(0, Math.min(1, parts[3].endsWith('%') ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3])));
    return { r: clamp(ch(parts[0])), g: clamp(ch(parts[1])), b: clamp(ch(parts[2])), a };
  }
  const hex = NAMED[s];
  if (hex) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
  return null;
}

/** A length in user units. Percentages are of the given reference size. Returns null when it cannot be read. */
function parseLength(text, ref = 0) {
  if (text === undefined || text === null) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?\s*$/i.exec(String(text));
  if (!m) return null;
  const v = Number.parseFloat(m[1]);
  switch ((m[2] ?? '').toLowerCase()) {
    case 'pt': return v * 4 / 3;
    case 'pc': return v * 16;
    case 'mm': return v * 96 / 25.4;
    case 'cm': return v * 96 / 2.54;
    case 'in': return v * 96;
    case 'em': return v * 16;
    case 'ex': return v * 8;
    case '%': return (v / 100) * ref;
    default: return v;
  }
}

function parseNumbers(text) {
  return (String(text ?? '').match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? []).map(Number);
}

// ---------------------------------------------------------------- transforms (2x3 matrices: [a, b, c, d, e, f])

const identity = () => [1, 0, 0, 1, 0, 0];
/** m1 then m2: the matrix that applies m2 to points already mapped by m1 (i.e. m1 × m2 in SVG's order). */
function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** The matrix of a transform attribute: matrix, translate, scale, rotate, skewX, skewY, applied left to right. */
function parseTransform(text) {
  let m = identity();
  if (!text) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(text))) {
    const a = parseNumbers(t[2]);
    let step;
    switch (t[1]) {
      case 'matrix': if (a.length === 6) step = a; break;
      case 'translate': step = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]; break;
      case 'scale': step = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const c = Math.cos(r);
        const s = Math.sin(r);
        const rot = [c, s, -s, c, 0, 0];
        if (a.length >= 3) {
          step = mul(mul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]]);
        } else {
          step = rot;
        }
        break;
      }
      case 'skewX': step = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': step = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
      default: break;
    }
    if (step) m = mul(m, step);
  }
  return m;
}

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// ---------------------------------------------------------------- paths

/** Parses path data into absolute commands: {t: 'M'|'L'|'C'|'Z', p: [...]} (quadratics become cubics, arcs too). */
function parsePath(d) {
  const cmds = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)|([,\s]+)/gy;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cmd = null;
  let lastCtrl = null; // reflected control point for S and T
  let lastType = null;
  // Tokens keep their text: an arc flag can be written glued to the next number ("a1 1 0 00.5.5"), so a token's
  // leading digit is taken as the flag and the rest is what remains.
  const toks = [];
  const src = String(d ?? '');
  const tokenRe = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)|[,\s]+|(.)/gy;
  let m;
  while (tokenRe.lastIndex < src.length) {
    m = tokenRe.exec(src);
    if (!m) break;
    if (m[3] !== undefined) break; // an unknown character ends the path
    if (m[1]) toks.push({ c: m[1] });
    else if (m[2] !== undefined) toks.push({ raw: m[2], n: Number.parseFloat(m[2]) });
  }
  let k = 0;
  const num = () => {
    const t = toks[k];
    if (!t || t.c !== undefined) return null;
    k++;
    return t.n;
  };
  while (k < toks.length) {
    if (toks[k].c !== undefined) {
      cmd = toks[k].c;
      k++;
    } else if (cmd === null) {
      break;
    } else if (cmd === 'M') {
      cmd = 'L';
    } else if (cmd === 'm') {
      cmd = 'l';
    } else if (cmd === 'Z' || cmd === 'z') {
      break;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (C) {
      case 'M': {
        const nx = num();
        const ny = num();
        if (nx === null || ny === null) return cmds;
        x = ox + nx;
        y = oy + ny;
        sx = x;
        sy = y;
        cmds.push({ t: 'M', p: [x, y] });
        lastType = 'M';
        break;
      }
      case 'L': {
        const nx = num();
        const ny = num();
        if (nx === null || ny === null) return cmds;
        x = ox + nx;
        y = oy + ny;
        cmds.push({ t: 'L', p: [x, y] });
        lastType = 'L';
        break;
      }
      case 'H': {
        const nx = num();
        if (nx === null) return cmds;
        x = (rel ? x : 0) + nx;
        cmds.push({ t: 'L', p: [x, y] });
        lastType = 'L';
        break;
      }
      case 'V': {
        const ny = num();
        if (ny === null) return cmds;
        y = (rel ? y : 0) + ny;
        cmds.push({ t: 'L', p: [x, y] });
        lastType = 'L';
        break;
      }
      case 'C': {
        const v = [num(), num(), num(), num(), num(), num()];
        if (v.includes(null)) return cmds;
        const c1 = [ox + v[0], oy + v[1]];
        const c2 = [ox + v[2], oy + v[3]];
        const e = [ox + v[4], oy + v[5]];
        cmds.push({ t: 'C', p: [c1[0], c1[1], c2[0], c2[1], e[0], e[1]] });
        lastCtrl = c2;
        [x, y] = e;
        lastType = 'C';
        break;
      }
      case 'S': {
        const v = [num(), num(), num(), num()];
        if (v.includes(null)) return cmds;
        const c1 = lastType === 'C' && lastCtrl ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
        const c2 = [ox + v[0], oy + v[1]];
        const e = [ox + v[2], oy + v[3]];
        cmds.push({ t: 'C', p: [c1[0], c1[1], c2[0], c2[1], e[0], e[1]] });
        lastCtrl = c2;
        [x, y] = e;
        lastType = 'C';
        break;
      }
      case 'Q': {
        const v = [num(), num(), num(), num()];
        if (v.includes(null)) return cmds;
        const q = [ox + v[0], oy + v[1]];
        const e = [ox + v[2], oy + v[3]];
        cmds.push(quadToCubic(x, y, q, e));
        lastCtrl = q;
        [x, y] = e;
        lastType = 'Q';
        break;
      }
      case 'T': {
        const v = [num(), num()];
        if (v.includes(null)) return cmds;
        const q = lastType === 'Q' && lastCtrl ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
        const e = [ox + v[0], oy + v[1]];
        cmds.push(quadToCubic(x, y, q, e));
        lastCtrl = q;
        [x, y] = e;
        lastType = 'Q';
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = readFlag();
        const sweep = readFlag();
        const ex = num();
        const ey = num();
        if ([rx, ry, rot, large, sweep, ex, ey].includes(null)) return cmds;
        const e = [ox + ex, oy + ey];
        for (const c of arcToCubics(x, y, Math.abs(rx), Math.abs(ry), rot, large, sweep, e[0], e[1])) cmds.push(c);
        [x, y] = e;
        lastType = 'A';
        break;
      }
      case 'Z': {
        cmds.push({ t: 'Z' });
        x = sx;
        y = sy;
        lastType = 'Z';
        break;
      }
      default:
        return cmds;
    }
  }
  return cmds;

  // An arc flag is a single 0 or 1 digit, even when written glued to the next number.
  function readFlag() {
    const t = toks[k];
    if (!t || t.c !== undefined) return null;
    const first = t.raw[0];
    if (first !== '0' && first !== '1') return null;
    const rest = t.raw.slice(1);
    if (rest === '') {
      k++;
    } else {
      toks[k] = { raw: rest, n: Number.parseFloat(rest) };
    }
    return Number(first);
  }
}

function quadToCubic(x0, y0, q, e) {
  return {
    t: 'C',
    p: [x0 + (2 / 3) * (q[0] - x0), y0 + (2 / 3) * (q[1] - y0), e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1]), e[0], e[1]],
  };
}

/** Converts an elliptical arc to cubic segments (SVG implementation notes F.6.5). */
function arcToCubics(x1, y1, rx, ry, angleDeg, large, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  if (rx === 0 || ry === 0) return [{ t: 'L', p: [x2, y2] }];
  const phi = (angleDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  let rxs = rx * rx;
  let rys = ry * ry;
  const lambda = (x1p * x1p) / rxs + (y1p * y1p) / rys;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    rxs = rx * rx;
    rys = ry * ry;
  }
  const sign = large === sweep ? -1 : 1;
  const num = rxs * rys - rxs * y1p * y1p - rys * x1p * x1p;
  const den = rxs * y1p * y1p + rys * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2) - 1e-9));
  const delta = dtheta / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const out = [];
  let th = theta1;
  const point = (a) => {
    const px = rx * Math.cos(a);
    const py = ry * Math.sin(a);
    return [cosPhi * px - sinPhi * py + cx, sinPhi * px + cosPhi * py + cy];
  };
  const deriv = (a) => {
    const px = -rx * Math.sin(a);
    const py = ry * Math.cos(a);
    return [cosPhi * px - sinPhi * py, sinPhi * px + cosPhi * py];
  };
  for (let s = 0; s < segs; s++) {
    const a2 = th + delta;
    const p1 = point(th);
    const p2 = point(a2);
    const d1 = deriv(th);
    const d2 = deriv(a2);
    const c1 = [p1[0] + t * d1[0], p1[1] + t * d1[1]];
    const c2 = [p2[0] - t * d2[0], p2[1] - t * d2[1]];
    out.push({ t: 'C', p: [c1[0], c1[1], c2[0], c2[1], s === segs - 1 ? x2 : p2[0], s === segs - 1 ? y2 : p2[1]] });
    th = a2;
  }
  return out;
}

/**
 * Flattens path commands (already in device space) into polylines: [{pts: [x, y, x, y, ...], closed}].
 */
function flatten(cmds, tolerance = 0.2) {
  const polys = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  for (const c of cmds) {
    if (c.t === 'M') {
      cur = { pts: [c.p[0], c.p[1]], closed: false };
      polys.push(cur);
      x = sx = c.p[0];
      y = sy = c.p[1];
    } else if (c.t === 'L') {
      if (!cur) { cur = { pts: [x, y], closed: false }; polys.push(cur); }
      cur.pts.push(c.p[0], c.p[1]);
      [x, y] = c.p;
    } else if (c.t === 'C') {
      if (!cur) { cur = { pts: [x, y], closed: false }; polys.push(cur); }
      const [x1, y1, x2, y2, x3, y3] = c.p;
      // enough segments that the chord error stays under the tolerance
      const len = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
      const n = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(len / tolerance) / 2)));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        const a = mt * mt * mt;
        const b = 3 * mt * mt * t;
        const cc = 3 * mt * t * t;
        const d = t * t * t;
        cur.pts.push(a * x + b * x1 + cc * x2 + d * x3, a * y + b * y1 + cc * y2 + d * y3);
      }
      [x, y] = [x3, y3];
    } else if (c.t === 'Z') {
      if (cur) {
        cur.closed = true;
        x = sx;
        y = sy;
        cur = null;
      }
    }
  }
  return polys.filter((p) => p.pts.length >= 4);
}

// ---------------------------------------------------------------- rasterising

/**
 * Coverage of polygons (flat [x, y, ...] lists in device space) under a fill rule, as a buffer over the bounding box.
 * Returns {x0, y0, w, h, cov} or null when nothing is inside the canvas.
 */
function coverage(polys, rule, canvasW, canvasH) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const edges = [];
  for (const pts of polys) {
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = pts[2 * i];
      const y0 = pts[2 * i + 1];
      const x1 = pts[2 * j];
      const y1 = pts[2 * j + 1];
      minX = Math.min(minX, x0);
      maxX = Math.max(maxX, x0);
      minY = Math.min(minY, y0);
      maxY = Math.max(maxY, y0);
      if (y0 === y1) continue;
      edges.push({ x0, y0, x1, y1, dir: y1 > y0 ? 1 : -1, ymin: Math.min(y0, y1), ymax: Math.max(y0, y1) });
    }
  }
  if (!edges.length) return null;
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(canvasW, Math.ceil(maxX) + 1);
  const y1 = Math.min(canvasH, Math.ceil(maxY) + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  const cov = new Float32Array(w * h);
  const xs = [];
  for (let row = y0; row < y1; row++) {
    for (let s = 0; s < SUBSAMPLES; s++) {
      const sy = row + (s + 0.5) / SUBSAMPLES;
      xs.length = 0;
      for (const e of edges) {
        if (sy < e.ymin || sy >= e.ymax) continue;
        const x = e.x0 + ((sy - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0);
        xs.push(x, e.dir);
      }
      // sort the crossings by x (pairs of [x, dir])
      const pairs = [];
      for (let i = 0; i < xs.length; i += 2) pairs.push([xs[i], xs[i + 1]]);
      pairs.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let i = 0; i < pairs.length - 1; i++) {
        wind += pairs[i][1];
        const inside = rule === 'evenodd' ? (wind & 1) !== 0 : wind !== 0;
        if (!inside) continue;
        addSpan(cov, w, h, x0, y0, row - y0, pairs[i][0], pairs[i + 1][0]);
      }
    }
  }
  return { x0, y0, w, h, cov };
}

/** Adds the coverage of the span [xa, xb) on one sub-scanline of row r (relative to the box) with weight 1/SUBSAMPLES. */
function addSpan(cov, w, h, bx, by, r, xa, xb) {
  if (xb <= xa) return;
  const a = Math.max(xa, bx);
  const b = Math.min(xb, bx + w);
  if (b <= a) return;
  const weight = 1 / SUBSAMPLES;
  const first = Math.floor(a);
  const last = Math.min(bx + w - 1, Math.floor(b));
  for (let px = first; px <= last; px++) {
    const ov = Math.min(b, px + 1) - Math.max(a, px);
    if (ov <= 0) continue;
    cov[r * w + (px - bx)] += ov * weight;
  }
}

/** Source-over of a colour at a coverage onto a premultiplied canvas (colour channels 0..255, alpha 0..1). */
function composite(canvas, cov, opts, colour) {
  const { x0, y0, w, h, cov: c } = cov;
  const { W, pix } = canvas;
  for (let r = 0; r < h; r++) {
    for (let q = 0; q < w; q++) {
      let a = c[r * w + q];
      if (a <= 0) continue;
      if (a > 1) a = 1;
      a *= colour.a * opts;
      if (a <= 0) continue;
      const o = ((y0 + r) * W + x0 + q) * 4;
      const inv = 1 - a;
      pix[o] = colour.r * a + pix[o] * inv;
      pix[o + 1] = colour.g * a + pix[o + 1] * inv;
      pix[o + 2] = colour.b * a + pix[o + 2] * inv;
      pix[o + 3] = a + pix[o + 3] * inv;
    }
  }
}

/** Gives every polygon the same orientation, so the union of stroke pieces is filled with the nonzero rule. */
function orientPositive(polys) {
  return polys.map((pts) => {
    let area = 0;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
    }
    if (area >= 0) return pts;
    const out = new Array(pts.length);
    for (let i = 0; i < n; i++) {
      out[2 * i] = pts[2 * (n - 1 - i)];
      out[2 * i + 1] = pts[2 * (n - 1 - i) + 1];
    }
    return out;
  });
}

/** The outline of a stroke of the given width around the polylines: a quad per segment and a round disc per vertex. */
function strokeOutline(polys, width) {
  const half = width / 2;
  const out = [];
  const disc = [];
  for (let k = 0; k < 12; k++) disc.push(Math.cos((k / 12) * 2 * Math.PI) * half, Math.sin((k / 12) * 2 * Math.PI) * half);
  for (const poly of polys) {
    const pts = poly.pts;
    const n = pts.length / 2;
    const segs = poly.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const ax = pts[2 * i];
      const ay = pts[2 * i + 1];
      const bx = pts[2 * j];
      const by = pts[2 * j + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len === 0) continue;
      const nx = (-(by - ay) / len) * half;
      const ny = ((bx - ax) / len) * half;
      out.push([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]);
    }
    for (let i = 0; i < n; i++) {
      if (!poly.closed && (i === 0 || i === n - 1)) continue; // butt caps
      const cx = pts[2 * i];
      const cy = pts[2 * i + 1];
      const d = new Array(disc.length);
      for (let k = 0; k < disc.length; k += 2) {
        d[k] = cx + disc[k];
        d[k + 1] = cy + disc[k + 1];
      }
      out.push(d);
    }
  }
  return out;
}

/** The paint of a fill or stroke: a colour, or none. A gradient paints its average stop colour. */
function resolvePaint(value, style, defs) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  if (v === 'none') return null;
  const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)\s*(.*)$/.exec(v);
  if (url) {
    const grad = defs.get(url[1]);
    if (grad && (grad.tag === 'linearGradient' || grad.tag === 'radialGradient')) return gradientColour(grad, style, defs);
    return url[2] ? resolvePaint(url[2], style, defs) : null;
  }
  return parseColor(v, style.color);
}

function gradientColour(grad, style, defs, depth = 0) {
  const stops = grad.children.filter((c) => c.tag === 'stop');
  if (!stops.length) {
    const href = grad.attrs.href ?? grad.attrs['xlink:href'];
    if (href && href[0] === '#' && depth < 4 && defs.get(href.slice(1))) return gradientColour(defs.get(href.slice(1)), style, defs, depth + 1);
    return null;
  }
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const s of stops) {
    const c = parseColor(s.styleDecls?.['stop-color'] ?? s.attrs['stop-color'] ?? 'black', style.color);
    if (!c) continue;
    r += c.r;
    g += c.g;
    b += c.b;
    n++;
  }
  if (!n) return null;
  return { r: r / n, g: g / n, b: b / n, a: 1 };
}

// ---------------------------------------------------------------- the document

const SKIPPED = new Set(['defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'pattern', 'filter', 'title', 'desc',
  'metadata', 'style', 'text', 'image', 'foreignObject', 'script', 'symbol', 'marker', 'font', 'view', 'cursor']);
// A symbol is drawn only where a <use> brings it in; otherwise it is skipped like the other definitions.
const SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);
const INHERITED = ['fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'color', 'visibility'];

/** The style of an element: its presentation attributes, the stylesheet, and its own style attribute, over the inherited. */
function elementStyle(el, parentStyle, rules) {
  const own = {};
  for (const name of Object.keys(el.attrs)) {
    if (name !== 'style') own[name] = el.attrs[name];
  }
  const matched = rules.filter((r) => matches(el, r.selector)).sort((a, b) => a.specificity - b.specificity);
  for (const r of matched) Object.assign(own, r.decls);
  if (el.attrs.style) Object.assign(own, parseDecls(el.attrs.style));
  const style = { ...parentStyle };
  for (const k of INHERITED) {
    if (own[k] !== undefined && own[k] !== 'inherit') style[k] = own[k];
  }
  if (own.color !== undefined && own.color !== 'inherit') style.color = own.color;
  // the colour property resolves currentColor for the element
  style.colorValue = parseColor(style.color ?? 'black', { r: 0, g: 0, b: 0, a: 1 }) ?? { r: 0, g: 0, b: 0, a: 1 };
  style.display = own.display ?? 'inline';
  style.opacity = own.opacity !== undefined ? Math.max(0, Math.min(1, Number.parseFloat(own.opacity))) : 1;
  style.hidden = style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
  style.groupOpacity = (parentStyle.groupOpacity ?? 1) * (Number.isFinite(style.opacity) ? style.opacity : 1);
  return { style, own };
}

/** Builds the shape's path commands in user space. */
function shapeCommands(el, own, vw, vh) {
  const a = (name) => own[name] ?? el.attrs[name];
  const len = (name, ref) => parseLength(a(name), ref) ?? 0;
  switch (el.tag) {
    case 'rect': {
      const x = len('x', vw);
      const y = len('y', vh);
      const w = len('width', vw);
      const h = len('height', vh);
      if (w <= 0 || h <= 0) return [];
      let rx = parseLength(a('rx'), vw);
      let ry = parseLength(a('ry'), vh);
      if (rx === null && ry === null) rx = ry = 0;
      else if (rx === null) rx = ry;
      else if (ry === null) ry = rx;
      rx = Math.min(Math.max(0, rx), w / 2);
      ry = Math.min(Math.max(0, ry), h / 2);
      if (rx <= 0 || ry <= 0) {
        return [{ t: 'M', p: [x, y] }, { t: 'L', p: [x + w, y] }, { t: 'L', p: [x + w, y + h] }, { t: 'L', p: [x, y + h] }, { t: 'Z' }];
      }
      const k = 0.5523;
      return [
        { t: 'M', p: [x + rx, y] },
        { t: 'L', p: [x + w - rx, y] },
        { t: 'C', p: [x + w - rx + rx * k, y, x + w, y + ry - ry * k, x + w, y + ry] },
        { t: 'L', p: [x + w, y + h - ry] },
        { t: 'C', p: [x + w, y + h - ry + ry * k, x + w - rx + rx * k, y + h, x + w - rx, y + h] },
        { t: 'L', p: [x + rx, y + h] },
        { t: 'C', p: [x + rx - rx * k, y + h, x, y + h - ry + ry * k, x, y + h - ry] },
        { t: 'L', p: [x, y + ry] },
        { t: 'C', p: [x, y + ry - ry * k, x + rx - rx * k, y, x + rx, y] },
        { t: 'Z' },
      ];
    }
    case 'circle':
      return ellipseCommands(len('cx', vw), len('cy', vh), len('r', Math.hypot(vw, vh) / Math.SQRT2), len('r', Math.hypot(vw, vh) / Math.SQRT2));
    case 'ellipse':
      return ellipseCommands(len('cx', vw), len('cy', vh), len('rx', vw), len('ry', vh));
    case 'line':
      return [{ t: 'M', p: [len('x1', vw), len('y1', vh)] }, { t: 'L', p: [len('x2', vw), len('y2', vh)] }];
    case 'polyline':
    case 'polygon': {
      const nums = parseNumbers(a('points'));
      if (nums.length < 4) return [];
      const cmds = [{ t: 'M', p: [nums[0], nums[1]] }];
      for (let i = 2; i + 1 < nums.length; i += 2) cmds.push({ t: 'L', p: [nums[i], nums[i + 1]] });
      if (el.tag === 'polygon') cmds.push({ t: 'Z' });
      return cmds;
    }
    case 'path':
      return parsePath(a('d'));
    default:
      return [];
  }
}

function ellipseCommands(cx, cy, rx, ry) {
  if (rx <= 0 || ry <= 0) return [];
  const k = 0.5523;
  return [
    { t: 'M', p: [cx + rx, cy] },
    { t: 'C', p: [cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry] },
    { t: 'C', p: [cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy] },
    { t: 'C', p: [cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry] },
    { t: 'C', p: [cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy] },
    { t: 'Z' },
  ];
}

/** Draws a shape: its fill, then its stroke. Paths go to device space first; curves are flattened there. */
function drawShape(canvas, el, own, style, M, vw, vh, defs) {
  const cmds = shapeCommands(el, own, vw, vh).map((c) => (c.t === 'Z' ? c : { t: c.t, p: pairsMap(c.p, M) }));
  const polys = flatten(cmds);
  if (!polys.length) return;
  const scale = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
  const fill = resolvePaint(style.fill ?? 'black', { ...style, color: style.colorValue }, defs);
  if (fill && (style.fill ?? 'black') !== 'none') {
    const fillOpacity = Number.parseFloat(style['fill-opacity'] ?? '1');
    const ring = polys.map((p) => p.pts);
    const cov = coverage(ring, style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero', canvas.W, canvas.H);
    if (cov) composite(canvas, cov, style.groupOpacity * (Number.isFinite(fillOpacity) ? fillOpacity : 1), fill);
  }
  const stroke = style.stroke === undefined ? null : resolvePaint(style.stroke, { ...style, color: style.colorValue }, defs);
  if (stroke && style.stroke !== 'none') {
    const widthUser = parseLength(style['stroke-width'] ?? '1', Math.hypot(vw, vh) / Math.SQRT2) ?? 1;
    const width = widthUser * scale;
    if (width > 0) {
      const strokeOpacity = Number.parseFloat(style['stroke-opacity'] ?? '1');
      const pieces = orientPositive(strokeOutline(polys, width));
      const cov = coverage(pieces, 'nonzero', canvas.W, canvas.H);
      if (cov) composite(canvas, cov, style.groupOpacity * (Number.isFinite(strokeOpacity) ? strokeOpacity : 1), stroke);
    }
  }
}

/** Applies a matrix to a flat [x, y, x, y, ...] list. */
function pairsMap(p, M) {
  const out = new Array(p.length);
  for (let i = 0; i < p.length; i += 2) {
    const q = apply(M, p[i], p[i + 1]);
    out[i] = q[0];
    out[i + 1] = q[1];
  }
  return out;
}

function renderNode(canvas, el, parentStyle, M, ctx, depth = 0) {
  if (depth > 32) return;
  const { style, own } = elementStyle(el, parentStyle, ctx.rules);
  const brought = el.tag === 'symbol' && ctx.useDepth > 0;
  if (style.hidden || (SKIPPED.has(el.tag) && !brought)) return;
  const T = parseTransform(own.transform ?? el.attrs.transform);
  const Mt = mul(M, T);
  if (SHAPES.has(el.tag)) {
    if (style.hidden) return;
    drawShape(canvas, el, own, style, Mt, ctx.vw, ctx.vh, ctx.defs);
    return;
  }
  if (el.tag === 'use') {
    const href = el.attrs.href ?? el.attrs['xlink:href'] ?? '';
    const target = href[0] === '#' ? ctx.ids.get(href.slice(1)) : null;
    if (!target || ctx.useDepth > MAX_USE_DEPTH || ctx.useStack.includes(target)) return;
    const x = parseLength(el.attrs.x, ctx.vw) ?? 0;
    const y = parseLength(el.attrs.y, ctx.vh) ?? 0;
    ctx.useStack.push(target);
    ctx.useDepth++;
    renderNode(canvas, target, style, mul(Mt, [1, 0, 0, 1, x, y]), ctx, depth + 1);
    ctx.useDepth--;
    ctx.useStack.pop();
    return;
  }
  if (el.tag === 'g' || el.tag === 'svg' || el.tag === 'a' || el.tag === 'switch' || brought) {
    let inner = Mt;
    if (el.tag === 'svg' && el !== ctx.root) {
      const x = parseLength(el.attrs.x, ctx.vw) ?? 0;
      const y = parseLength(el.attrs.y, ctx.vh) ?? 0;
      inner = mul(Mt, [1, 0, 0, 1, x, y]);
    }
    for (const child of el.children) renderNode(canvas, child, style, inner, ctx, depth + 1);
  }
}

/** Walks the document once: ids, the stylesheets, and the root. */
function indexDocument(doc) {
  const ids = new Map();
  const defs = new Map();
  const rules = [];
  let root = null;
  const walk = (el) => {
    if (el.attrs?.id) {
      ids.set(el.attrs.id, el);
      defs.set(el.attrs.id, el);
    }
    if (el.tag === 'style') rules.push(...parseCss(el.text));
    if (el.tag === 'svg' && !root) root = el;
    for (const c of el.children) walk(c);
  };
  walk(doc);
  return { ids, defs, rules, root };
}

/**
 * Rasterises an SVG document.
 * @param {Uint8Array} buf the SVG file
 * @param {{width?: number, height?: number}} [hint] the size the picture is shown at, if the page says
 * @returns {{width: number, height: number, channels: 4, data: Uint8Array}}
 */
export function decodeSvg(buf, hint = {}) {
  const text = Buffer.from(buf).toString('utf8').replace(/^﻿/, '');
  const doc = parseXml(text);
  const idx = indexDocument(doc);
  const root = idx.root;
  if (!root) throw new Error('SVG has no <svg> element');
  const vbNums = parseNumbers(root.attrs.viewBox);
  const vb = vbNums.length === 4 && vbNums[2] > 0 && vbNums[3] > 0 ? { x: vbNums[0], y: vbNums[1], w: vbNums[2], h: vbNums[3] } : null;
  // a percentage size has no meaning for a picture on its own, so it counts as not given
  const sizeAttr = (v) => (v === undefined || String(v).trim().endsWith('%') ? null : parseLength(v));
  const attrW = sizeAttr(root.attrs.width);
  const attrH = sizeAttr(root.attrs.height);
  let W;
  let H;
  if (attrW !== null && attrH !== null) {
    W = attrW;
    H = attrH;
  } else if (vb) {
    if (attrW !== null) { W = attrW; H = (attrW * vb.h) / vb.w; }
    else if (attrH !== null) { H = attrH; W = (attrH * vb.w) / vb.h; }
    else { W = vb.w; H = vb.h; }
  } else {
    W = attrW ?? DEFAULT_WIDTH;
    H = attrH ?? DEFAULT_HEIGHT;
  }
  if (!(W > 0)) W = DEFAULT_WIDTH;
  if (!(H > 0)) H = DEFAULT_HEIGHT;
  // the size the page shows it at wins; a single size keeps the picture's proportions
  if (hint.width && hint.height) {
    W = hint.width;
    H = hint.height;
  } else if (hint.width) {
    H = (hint.width * H) / W;
    W = hint.width;
  } else if (hint.height) {
    W = (hint.height * W) / H;
    H = hint.height;
  }
  W = Math.max(1, Math.min(MAX_SIDE, Math.round(W)));
  H = Math.max(1, Math.min(MAX_SIDE, Math.round(H)));
  if (W * H > MAX_PIXELS) throw new Error('SVG picture too large');

  // viewBox to the picture, centred and scaled to fit (preserveAspectRatio xMidYMid meet)
  let M = identity();
  if (vb) {
    const s = Math.min(W / vb.w, H / vb.h);
    M = [s, 0, 0, s, (W - vb.w * s) / 2 - vb.x * s, (H - vb.h * s) / 2 - vb.y * s];
  }
  const canvas = { W, H, pix: new Float32Array(W * H * 4) };
  const ctx = {
    rules: idx.rules,
    ids: idx.ids,
    defs: idx.defs,
    root,
    vw: vb ? vb.w : W,
    vh: vb ? vb.h : H,
    useStack: [],
    useDepth: 0,
  };
  const rootStyle = { groupOpacity: 1, color: 'black', colorValue: { r: 0, g: 0, b: 0, a: 1 }, fill: 'black', 'fill-rule': 'nonzero' };
  renderNode(canvas, root, rootStyle, M, ctx);

  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const a = canvas.pix[i * 4 + 3];
    if (a <= 0) continue;
    data[i * 4] = Math.round(Math.min(255, canvas.pix[i * 4] / a));
    data[i * 4 + 1] = Math.round(Math.min(255, canvas.pix[i * 4 + 1] / a));
    data[i * 4 + 2] = Math.round(Math.min(255, canvas.pix[i * 4 + 2] / a));
    data[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
  }
  return { width: W, height: H, channels: 4, data };
}
