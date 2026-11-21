// Approximate page renderer. It turns the parsed DOM (html.js) into an RGBA pixel buffer that png.js encodes.
//
// THIS IS AN APPROXIMATION, NOT A BROWSER. It does not match Chrome, Firefox or any engine pixel for pixel.
// What it does:
//   - block flow (headings, p, div, section, lists, hr), inline flow with word wrapping, <br>, and simple tables
//     (rows, cells, equal column widths);
//   - a fixed built-in 5x7 bitmap font (font.js), scaled to the font size; bold by a 1 pixel smear, underline;
//   - links in blue and underlined, headings larger and bold, inputs, buttons, selects, textareas and checkboxes
//     drawn as boxes with their value or label, images drawn as grey boxes with their alt text;
//   - a small whitelist of CSS properties (see setProp), from UA defaults, <style> blocks and style="" attributes,
//     with simple selectors (selector.js) and the usual specificity order;
//   - display:none, the hidden attribute and visibility:hidden are honoured.
// What it does NOT do: flexbox, grid, floats, positioning, transforms, media queries (@media blocks are skipped),
// web fonts, images (never loaded), italics (recorded but drawn upright), colour gradients, borders other than a
// single 1 pixel colour, box-shadow, border-radius, opacity, text shaping, non-ASCII glyphs (they are mapped to
// ASCII or drawn as '?'). Margins: adjacent sibling margins collapse to the larger one; a child's top margin
// does not collapse through its parent, and a last child's bottom margin is dropped (it is not added to the parent).
// Scripts are not run here; the browser runs them first, so the DOM this sees is the one the page built.
import { KernelError } from '../kernel/errors.js';
import { compile, matches, normalizeText } from './selector.js';
import { glyphRows, GLYPH_COLS, GLYPH_ROWS } from './font.js';

export const RENDER_LIMITS = Object.freeze({
  defaultWidth: 1280,
  defaultHeight: 800,
  maxWidth: 3840,
  maxHeight: 4096,
  maxPixels: 8388608,
});

const ELEMENT = 1;
const TEXT = 3;
const WHITE = [255, 255, 255, 255];
const BLACK = [0, 0, 0, 255];
const SKIP = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'template', 'noscript', 'base']);
const ATOMIC = new Set(['img', 'input', 'button', 'select', 'textarea']);

// ---------------------------------------------------------------- colours

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', lime: '#00ff00',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', darkgray: '#a9a9a9', darkgrey: '#a9a9a9',
  lightgray: '#d3d3d3', lightgrey: '#d3d3d3', whitesmoke: '#f5f5f5', navy: '#000080', yellow: '#ffff00',
  orange: '#ffa500', purple: '#800080', teal: '#008080', maroon: '#800000', olive: '#808000', aqua: '#00ffff',
  cyan: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700',
  indigo: '#4b0082', violet: '#ee82ee', crimson: '#dc143c',
};

/** A CSS colour as [r, g, b, a] (0 to 255), or null when the value is not a colour this renderer knows. */
export function parseColor(value) {
  const v = String(value).trim().toLowerCase();
  if (v === 'transparent') return [0, 0, 0, 0];
  if (Object.hasOwn(NAMED, v)) return parseColor(NAMED[v]);
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const c = [0, 2, 4, 6].filter((i) => i < h.length).map((i) => parseInt(h.slice(i, i + 2), 16));
    return [c[0], c[1], c[2], c[3] ?? 255];
  }
  m = /^rgba?\((.*)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return null;
    const ch = (p) => (p.endsWith('%') ? Math.round(Number.parseFloat(p) * 2.55) : Math.round(Number.parseFloat(p)));
    const rgb = parts.slice(0, 3).map(ch);
    if (rgb.some((n) => !Number.isFinite(n))) return null;
    let a = 255;
    if (parts[3] !== undefined) {
      const n = parts[3].endsWith('%') ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3]);
      if (!Number.isFinite(n)) return null;
      a = Math.round(Math.min(1, Math.max(0, n)) * 255);
    }
    return [...rgb.map((n) => Math.min(255, Math.max(0, n))), a];
  }
  return null;
}

// ---------------------------------------------------------------- CSS text

/** Splits on a separator that is not inside parentheses or quotes. */
function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** "name: value; name: value !important" into [{name, value, important}]. */
export function parseDecls(text) {
  const out = [];
  for (const part of splitTopLevel(String(text), ';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const raw = part.slice(0, colon).trim();
    const name = raw.startsWith('--') ? raw : raw.toLowerCase(); // custom property names are case-sensitive
    let value = part.slice(colon + 1).trim();
    let important = false;
    if (/!\s*important\s*$/i.test(value)) {
      important = true;
      value = value.replace(/!\s*important\s*$/i, '').trim();
    }
    if (name && value) out.push({ name, value, important });
  }
  return out;
}

/** Approximate specificity: ids, then classes/attributes/pseudo-classes, then tags. Ties keep source order. */
function specificity(sel) {
  const s = sel.replace(/"[^"]*"|'[^']*'/g, '""').replace(/:not\(([^)]*)\)/g, ' $1');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g) || []).length;
  const tags = (s.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return ids * 10000 + classes * 100 + tags;
}

/**
 * Whether a media query list applies to the viewport. Supports screen/all, and (min-width), (max-width) and
 * (orientation) features in `and` lists, with commas as "or". Other features (print, colour scheme, hover, ...) do
 * not apply.
 */
export function mediaMatches(query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q === '') return true;
  return splitTopLevel(q, ',').some((alt) => {
    const parts = alt.trim().replace(/^only\s+/, '').split(/\s+and\s+/).map((p) => p.trim());
    return parts.every((p) => {
      if (p === 'all' || p === 'screen') return true;
      if (p === 'print' || p.startsWith('not ')) return false;
      const feature = /^\(\s*(min-width|max-width|orientation)\s*:\s*([^)]+?)\s*\)$/.exec(p);
      if (!feature) return false;
      const [, name, val] = feature;
      if (name === 'orientation') {
        return val === 'landscape' ? VIEW.width >= VIEW.height : VIEW.width < VIEW.height;
      }
      const px = parseLength(val, 16);
      if (typeof px !== 'number') return false;
      return name === 'min-width' ? VIEW.width >= px : VIEW.width <= px;
    });
  });
}

/**
 * Rules of a stylesheet, one entry per selector of each rule. @media blocks are kept when they apply to the viewport
 * (mediaMatches); other @-rules (@import, @font-face, ...) are skipped whole. Selectors this engine cannot compile
 * are dropped.
 */
export function parseStylesheet(css, orderBase = 0) {
  const text = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const counter = { order: orderBase };
  parseBlock(text, rules, counter);
  return rules;
}

function parseBlock(text, rules, counter) {
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === '@') {
      const semi = text.indexOf(';', i);
      const brace = text.indexOf('{', i);
      if (brace === -1 || (semi !== -1 && semi < brace)) {
        i = semi === -1 ? text.length : semi + 1;
        continue;
      }
      const close = matchBrace(text, brace);
      if (/^@media\b/i.test(text.slice(i, brace)) && mediaMatches(text.slice(i + 6, brace))) {
        parseBlock(text.slice(brace + 1, close), rules, counter);
      }
      i = close + 1;
      continue;
    }
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const selText = text.slice(i, open).trim();
    const close = matchBrace(text, open);
    const decls = parseDecls(text.slice(open + 1, close));
    i = close + 1;
    for (const part of splitTopLevel(selText, ',')) {
      const sel = part.trim();
      if (!sel) continue;
      try {
        compile(sel);
      } catch {
        continue; // unsupported selector: the rule is ignored
      }
      rules.push({ selector: sel, spec: specificity(sel), order: counter.order++, decls });
    }
  }
}

/** Index of the brace that closes the one at `open`, or the last index when it never closes. */
function matchBrace(text, open) {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}' && --depth === 0) return k;
  }
  return text.length - 1;
}

// The user agent defaults, written as CSS and run through the same cascade as author rules.
const UA_CSS = `
head, title, meta, link, style, script, noscript, template, base, datalist, option, optgroup, [hidden],
input[type=hidden] { display: none }
html, body, div, section, article, header, footer, nav, main, aside, address, form, fieldset, figure,
figcaption, details, summary, dialog, center, dl, dt, dd, hgroup, legend, caption, p, pre, blockquote, ul, ol,
h1, h2, h3, h4, h5, h6, hr, li, table, tbody, thead, tfoot, tr, td, th { display: block }
html { color: #000000; font-size: 16px }
body { margin: 8px }
p { margin: 1em 0 }
blockquote { margin: 1em 40px }
pre { white-space: pre; margin: 1em 0 }
ul, ol { margin: 1em 0; padding-left: 40px }
dl { margin: 1em 0 }
dd { margin-left: 40px }
h1 { font-size: 2em; font-weight: bold; margin: 0.67em 0 }
h2 { font-size: 1.5em; font-weight: bold; margin: 0.83em 0 }
h3 { font-size: 1.17em; font-weight: bold; margin: 1em 0 }
h4 { font-size: 1em; font-weight: bold; margin: 1.33em 0 }
h5 { font-size: 0.83em; font-weight: bold; margin: 1.67em 0 }
h6 { font-size: 0.67em; font-weight: bold; margin: 2.33em 0 }
fieldset { margin: 0 2px; padding: 0.35em 0.75em; border: 1px solid #c0c0c0 }
hr { height: 1px; background-color: #888888; margin: 8px 0 }
b, strong, th { font-weight: bold }
i, em, cite, var, dfn, address { font-style: italic }
u, ins { text-decoration: underline }
small { font-size: 0.83em }
big { font-size: 1.17em }
mark { background-color: #ffff00 }
a[href] { color: #0000ee; text-decoration: underline }
li { display: list-item }
table { display: table; margin: 0 }
tr { display: table-row }
td, th { display: table-cell; padding: 4px }
img, input, select, textarea, button { display: inline-block }
`;

let uaRules = null;
function userAgentRules() {
  if (!uaRules) uaRules = parseStylesheet(UA_CSS, 0);
  return uaRules;
}

// ---------------------------------------------------------------- properties

const KEYWORD_SIZES = {
  'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48,
};

/** The viewport of the render in progress (set by renderPage). vw, vh, vmin and vmax and @media use it. */
let VIEW = { width: 1280, height: 800 };

/**
 * A length in px, 'auto', a percentage string such as '50%', or null when it is not a length. Supports px, em, rem,
 * pt, vw, vh, vmin, vmax, and clamp(), min() and max() over lengths (a percentage inside them makes them null).
 */
function parseLength(value, emBase) {
  const v = String(value).trim().toLowerCase();
  if (v === 'auto') return 'auto';
  if (v === '0') return 0;
  if (/^(calc|min|max|clamp)\(/.test(v)) {
    // Without a percentage the value is a number now. With one, it is kept as an expression for the container width.
    const node = lengthExpr(v, emBase);
    if (!node) return null;
    return hasPercent(node) ? { expr: node } : evalLength(node, 0);
  }
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|em|rem|pt|%|vw|vh|vmin|vmax)?$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2] ?? 'px') {
    case 'px': return n;
    case 'em': return n * emBase;
    case 'rem': return n * 16;
    case 'pt': return (n * 4) / 3;
    case 'vw': return (n * VIEW.width) / 100;
    case 'vh': return (n * VIEW.height) / 100;
    case 'vmin': return (n * Math.min(VIEW.width, VIEW.height)) / 100;
    case 'vmax': return (n * Math.max(VIEW.width, VIEW.height)) / 100;
    default: return `${n}%`;
  }
}

/**
 * A length expression: + - * / over numbers, percentages and the functions calc(), min(), max() and clamp(). Units
 * other than % are converted when the expression is read. Returns the tree, or null when it does not parse.
 */
function lengthExpr(text, emBase) {
  const src = String(text).trim();
  const tokens = [];
  const token = /\s*(\d*\.?\d+(?:px|em|rem|pt|vw|vh|vmin|vmax|%)?|[()+\-*/,]|[a-z]+)/y;
  let pos = 0;
  while (pos < src.length) {
    token.lastIndex = pos;
    const m = token.exec(src);
    if (!m) return null;
    tokens.push(m[1]);
    pos = token.lastIndex;
  }
  let i = 0;
  const eat = (t) => {
    if (tokens[i] === t) {
      i++;
      return true;
    }
    return false;
  };
  const expr = () => {
    let node = term();
    while (tokens[i] === '+' || tokens[i] === '-') {
      const op = tokens[i++];
      node = { k: op === '+' ? 'add' : 'sub', a: node, b: term() };
    }
    return node;
  };
  const term = () => {
    let node = factor();
    while (tokens[i] === '*' || tokens[i] === '/') {
      const op = tokens[i++];
      node = { k: op === '*' ? 'mul' : 'div', a: node, b: factor() };
    }
    return node;
  };
  const factor = () => {
    const t = tokens[i++];
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') {
      const n = expr();
      if (!eat(')')) throw new Error('expected )');
      return n;
    }
    if (t === '-') return { k: 'mul', a: { k: 'num', v: -1 }, b: factor() };
    if (/^[a-z]+$/.test(t)) {
      if (!eat('(')) throw new Error('expected (');
      const args = [expr()];
      while (eat(',')) args.push(expr());
      if (!eat(')')) throw new Error('expected )');
      if (t === 'calc' && args.length === 1) return args[0];
      if ((t === 'min' || t === 'max') && args.length >= 1) return { k: t, args };
      if (t === 'clamp' && args.length === 3) return { k: 'clamp', args };
      throw new Error('bad function');
    }
    const m = /^(\d*\.?\d+)(px|em|rem|pt|vw|vh|vmin|vmax|%)?$/.exec(t);
    if (!m) throw new Error('bad token');
    const n = Number(m[1]);
    switch (m[2] ?? 'px') {
      case 'px': return { k: 'num', v: n };
      case 'em': return { k: 'num', v: n * emBase };
      case 'rem': return { k: 'num', v: n * 16 };
      case 'pt': return { k: 'num', v: (n * 4) / 3 };
      case 'vw': return { k: 'num', v: (n * VIEW.width) / 100 };
      case 'vh': return { k: 'num', v: (n * VIEW.height) / 100 };
      case 'vmin': return { k: 'num', v: (n * Math.min(VIEW.width, VIEW.height)) / 100 };
      case 'vmax': return { k: 'num', v: (n * Math.max(VIEW.width, VIEW.height)) / 100 };
      default: return { k: 'pct', v: n };
    }
  };
  try {
    const node = expr();
    return i === tokens.length ? node : null;
  } catch {
    return null;
  }
}

function hasPercent(node) {
  if (node.k === 'pct') return true;
  if (node.args) return node.args.some(hasPercent);
  return (node.a !== undefined && hasPercent(node.a)) || (node.b !== undefined && hasPercent(node.b));
}

/** Value of a length expression for a containing block of size base. */
function evalLength(node, base) {
  switch (node.k) {
    case 'num': return node.v;
    case 'pct': return (node.v * base) / 100;
    case 'add': return evalLength(node.a, base) + evalLength(node.b, base);
    case 'sub': return evalLength(node.a, base) - evalLength(node.b, base);
    case 'mul': return evalLength(node.a, base) * evalLength(node.b, base);
    case 'div': {
      const d = evalLength(node.b, base);
      return d === 0 ? 0 : evalLength(node.a, base) / d;
    }
    case 'min': return Math.min(...node.args.map((n) => evalLength(n, base)));
    case 'max': return Math.max(...node.args.map((n) => evalLength(n, base)));
    case 'clamp': {
      const [lo, mid, hi] = node.args.map((n) => evalLength(n, base));
      return Math.max(lo, Math.min(mid, hi));
    }
    default: return 0;
  }
}

/** Whether a parsed length is a usable size: a number, a percentage, or an expression. */
function isLen(v) {
  return typeof v === 'number' || (v !== null && typeof v === 'object') || (typeof v === 'string' && v !== 'auto');
}

/** One to four lengths in CSS box order: [top, right, bottom, left]. Percentages in margins count as 0. */
function boxSides(value, emBase) {
  const parts = splitTopLevel(String(value).trim().replace(/\s+/g, ' '), ' ').map((p) => parseLength(p, emBase));
  if (parts.length === 0 || parts.length > 4 || parts.some((p) => p === null)) return null;
  const [t, r = t, b = t, l = r] = parts;
  return [t, r, b, l].map((p) => (typeof p === 'string' && p !== 'auto' ? 0 : typeof p === 'object' && p !== null ? 0 : p));
}

function setProp(st, name, value) {
  const v = value.toLowerCase();
  switch (name) {
    case 'display': {
      if (v === 'none') st.display = 'none';
      else if (/^(inline-)?flex$/.test(v)) st.display = 'flex';
      else if (/^(inline-)?grid$/.test(v)) st.display = 'grid';
      else if (/^(block|flow-root|contents|table-row-group|table-header-group|table-footer-group)$/.test(v)) st.display = 'block';
      else if (v === 'inline') st.display = 'inline';
      else if (/^inline-(block|table)$/.test(v)) st.display = 'inline-block';
      else if (v === 'list-item') st.display = 'list-item';
      else if (v === 'table') st.display = 'table';
      else if (v === 'table-row') st.display = 'table-row';
      else if (v === 'table-cell') st.display = 'table-cell';
      return;
    }
    case 'color': {
      const c = parseColor(value);
      if (c) st.color = c;
      return;
    }
    case 'background-color': {
      const c = parseColor(value);
      if (c) st.bg = c[3] === 0 ? null : c;
      return;
    }
    case 'background': {
      if (v === 'none') { st.bg = null; return; }
      for (const tok of value.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|[a-z]+/gi) ?? []) {
        const c = parseColor(tok);
        if (c) { st.bg = c[3] === 0 ? null : c; return; }
      }
      return;
    }
    case 'font-weight': {
      if (/^(bold|bolder|[6-9]00)$/.test(v)) st.bold = true;
      else if (/^(normal|lighter|[1-5]00)$/.test(v)) st.bold = false;
      return;
    }
    case 'font-style': {
      if (/italic|oblique/.test(v)) st.italic = true;
      else if (v === 'normal') st.italic = false;
      return;
    }
    case 'text-decoration':
    case 'text-decoration-line': {
      if (/underline/.test(v)) st.underline = true;
      else if (/none/.test(v)) st.underline = false;
      return;
    }
    case 'text-align': {
      if (v === 'center') st.align = 'center';
      else if (v === 'right' || v === 'end') st.align = 'right';
      else if (v === 'left' || v === 'start' || v === 'justify') st.align = 'left';
      return;
    }
    case 'visibility': {
      if (/^(hidden|collapse)$/.test(v)) st.hidden = true;
      else if (v === 'visible') st.hidden = false;
      return;
    }
    // flex and grid containers and their items (not inherited)
    case 'flex-direction': {
      if (/^column/.test(v)) st.flexCol = true;
      else if (/^row/.test(v)) st.flexCol = false;
      return;
    }
    case 'flex-wrap': {
      if (v === 'wrap' || v === 'wrap-reverse') st.wrap = true;
      else if (v === 'nowrap') st.wrap = false;
      return;
    }
    case 'justify-content': {
      if (/^(flex-start|start|flex-end|end|center|space-between|space-around|space-evenly)$/.test(v)) st.justify = v;
      return;
    }
    case 'align-items': {
      if (/^(stretch|flex-start|start|flex-end|end|center|baseline)$/.test(v)) st.alignItems = v;
      return;
    }
    case 'align-self': {
      if (/^(auto|stretch|flex-start|start|flex-end|end|center)$/.test(v)) st.alignSelf = v === 'auto' ? null : v;
      return;
    }
    case 'flex-grow': {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) st.grow = n;
      return;
    }
    case 'flex-basis': {
      const len = parseLength(value, st.size);
      st.basis = isLen(len) ? len : null;
      return;
    }
    case 'flex': {
      const toks = v.split(/\s+/);
      if (toks[0] === 'none') { st.grow = 0; st.basis = null; return; }
      if (toks[0] === 'auto') { st.grow = 1; st.basis = null; return; }
      let grow = null;
      let basis;
      for (const t of toks) {
        if (/^\d*\.?\d+$/.test(t) && grow === null) { grow = Number(t); continue; }
        if (/^\d*\.?\d+$/.test(t)) continue; // flex-shrink is not used
        const len = parseLength(t, st.size);
        if (isLen(len)) basis = len;
      }
      st.grow = grow ?? 1;
      st.basis = basis ?? 0;
      return;
    }
    case 'gap': {
      const parts = v.split(/\s+/).map((p) => parseLength(p, st.size));
      if (parts.length === 0 || parts.some((p) => typeof p !== 'number')) return;
      st.gapR = parts[0];
      st.gapC = parts[1] ?? parts[0];
      return;
    }
    case 'row-gap': case 'grid-row-gap': {
      const len = parseLength(value, st.size);
      if (typeof len === 'number') st.gapR = len;
      return;
    }
    case 'column-gap': case 'grid-column-gap': {
      const len = parseLength(value, st.size);
      if (typeof len === 'number') st.gapC = len;
      return;
    }
    case 'grid-template-columns': {
      st.gridCols = parseTracks(value, st.size);
      return;
    }
    case 'white-space': {
      if (/^pre/.test(v)) st.pre = true;
      else if (v === 'normal' || v === 'nowrap') st.pre = false;
      return;
    }
    case 'margin-inline': case 'margin-block': {
      // One or two values: the start and end sides of the inline (left and right) or block (top and bottom) axis.
      const parts = splitTopLevel(String(value).trim().replace(/\s+/g, ' '), ' ').map((p) => parseLength(p, st.size));
      if (parts.length === 0 || parts.length > 2 || parts.some((p) => p === null)) return;
      const [a, b = a] = parts;
      const side = (x) => (typeof x === 'number' || x === 'auto' ? x : 0); // percentages and expressions count as 0
      if (name === 'margin-inline') {
        st.ml = side(a);
        st.mr = side(b);
      } else {
        st.mt = side(a);
        st.mb = side(b);
      }
      return;
    }
    case 'margin': {
      const s = boxSides(value, st.size); // keeps 'auto' for horizontal auto margins
      if (s) [st.mt, st.mr, st.mb, st.ml] = s;
      return;
    }
    case 'padding': {
      const s = boxSides(value, st.size);
      if (s) [st.pt, st.pr, st.pb, st.pl] = s.map((n) => n);
      return;
    }
    case 'margin-top': case 'margin-right': case 'margin-bottom': case 'margin-left': {
      const len = parseLength(value, st.size);
      if (len === null) return;
      const key = { 'margin-top': 'mt', 'margin-right': 'mr', 'margin-bottom': 'mb', 'margin-left': 'ml' }[name];
      st[key] = typeof len === 'string' && len !== 'auto' ? 0 : len;
      return;
    }
    case 'padding-top': case 'padding-right': case 'padding-bottom': case 'padding-left': {
      const len = parseLength(value, st.size);
      if (typeof len !== 'number') return;
      const key = { 'padding-top': 'pt', 'padding-right': 'pr', 'padding-bottom': 'pb', 'padding-left': 'pl' }[name];
      st[key] = len;
      return;
    }
    case 'transform': {
      // Only translate() moves a box here. Other transforms are ignored.
      const m = /translate(x|y)?\(\s*([^)]+)\)/.exec(v);
      if (!m) { st.translate = null; return; }
      const parts = splitTopLevel(m[2], ',').map((p) => parseLength(p.trim(), st.size));
      const tx = m[1] === 'y' ? 0 : parts[0];
      const ty = m[1] === 'x' ? 0 : m[1] === 'y' ? parts[0] : parts[1] ?? 0;
      st.translate = (typeof tx === 'number' || typeof tx === 'string') && (typeof ty === 'number' || typeof ty === 'string') ? { x: tx, y: ty } : null;
      return;
    }
    case 'position': {
      if (/^(static|relative|absolute|fixed)$/.test(v)) st.position = v;
      else if (v === 'sticky') st.position = 'relative'; // sticky is drawn where it sits
      return;
    }
    case 'top': case 'right': case 'bottom': case 'left': {
      const len = parseLength(value, st.size);
      st[name] = isLen(len) ? len : null;
      return;
    }
    case 'inset': {
      const s = boxSides(value, st.size);
      if (s) [st.top, st.right, st.bottom, st.left] = s.map((x) => (x === 'auto' ? null : x));
      return;
    }
    case 'aspect-ratio': {
      const m = /^(\d*\.?\d+)(?:\s*\/\s*(\d*\.?\d+))?$/.exec(v);
      if (m) st.aspect = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
      else if (v === 'auto') st.aspect = null;
      return;
    }
    case 'object-fit': {
      if (/^(fill|contain|cover|none|scale-down)$/.test(v)) st.objectFit = v;
      return;
    }
    case 'max-width': case 'min-width': {
      const len = parseLength(value, st.size);
      const key = name === 'max-width' ? 'maxW' : 'minW';
      if (len === null || len === 'auto') st[key] = null; // 'none' and 'auto' mean no limit
      else if (typeof len === 'number') st[key] = Math.max(0, len);
      else st[key] = len;
      return;
    }
    case 'width': case 'height': {
      const len = parseLength(value, st.size);
      const key = name;
      if (len === null || len === 'auto') st[key] = null;
      else if (typeof len === 'number') st[key] = len >= 0 ? len : null;
      else st[key] = len; // percentage string, resolved against the containing block
      return;
    }
    case 'border': case 'border-color': {
      const colour = (value.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|[a-z]+/gi) ?? [])
        .map(parseColor).find((c) => c && c[3] > 0);
      if (colour) { st.border = colour; return; }
      if (name !== 'border') return;
      if (/\b(solid|dashed|dotted|double)\b/.test(v)) st.border = st.color; // a visible style with no colour uses the text colour
      else if (/^(none|hidden|0|0px)(\s|$)/.test(v)) st.border = null;
      return;
    }
    default:
      return; // not in the whitelist: ignored
  }
}

function setFontSize(st, value, parentSize) {
  const v = value.trim().toLowerCase();
  if (Object.hasOwn(KEYWORD_SIZES, v)) st.size = KEYWORD_SIZES[v];
  else if (v === 'smaller') st.size = parentSize * 0.83;
  else if (v === 'larger') st.size = parentSize * 1.2;
  else {
    const len = parseLength(v, parentSize);
    if (typeof len === 'number' && len > 0) st.size = len;
    else if (typeof len === 'string' && len.endsWith('%')) st.size = (parentSize * Number.parseFloat(len)) / 100;
  }
  st.size = Math.min(96, Math.max(6, st.size));
}

/** Properties whose `inherit` keyword takes the parent's value. */
const INHERIT_FROM_PARENT = {
  color: (st, p) => { st.color = p.color; },
  'font-size': (st, p) => { st.size = p.size; },
  'font-weight': (st, p) => { st.bold = p.bold; },
  'font-style': (st, p) => { st.italic = p.italic; },
  'text-align': (st, p) => { st.align = p.align; },
  visibility: (st, p) => { st.hidden = p.hidden; },
  'white-space': (st, p) => { st.pre = p.pre; },
  'background-color': (st, p) => { st.bg = p.bg; },
  background: (st, p) => { st.bg = p.bg; },
};

/**
 * Applies declarations in cascade order. font-size goes first, because lengths in em depend on it. The rest keep their
 * order, so a later `color: inherit` overrides an earlier `color: blue`, and the other way round.
 */
function applyDecls(st, decls, parentSize, parent = null) {
  const inherits = (d) => parent !== null && INHERIT_FROM_PARENT[d.name] && d.value.toLowerCase() === 'inherit';
  for (const d of decls) {
    if (d.name !== 'font-size') continue;
    if (inherits(d)) INHERIT_FROM_PARENT[d.name](st, parent);
    else setFontSize(st, d.value, parentSize);
  }
  for (const d of decls) {
    if (d.name === 'font-size') continue;
    if (inherits(d)) INHERIT_FROM_PARENT[d.name](st, parent);
    else setProp(st, d.name, d.value);
  }
}

// ---------------------------------------------------------------- cascade

const ROOT = Object.freeze({
  display: 'block', color: BLACK, size: 16, bold: false, italic: false, underline: false, align: 'left', hidden: false, pre: false,
});

/**
 * Replaces var(--name, fallback) in a declaration value with the custom property's value (itself substituted).
 * Returns null when a variable is missing and has no fallback, which makes the declaration invalid.
 */
function substituteVars(value, vars, depth = 0) {
  if (!value.includes('var(')) return value;
  if (depth > 10) return null;
  let failed = false;
  const out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (m, name, fallback) => {
    const v = vars?.[name];
    if (v !== undefined) {
      const r = substituteVars(v, vars, depth + 1);
      if (r === null) failed = true;
      return r ?? '';
    }
    if (fallback !== undefined) return substituteVars(fallback.trim(), vars, depth + 1) ?? '';
    failed = true;
    return '';
  });
  return failed ? null : out;
}

/** The style a child starts from: inherited properties copied, box properties reset. */
function fresh(p) {
  return {
    display: 'inline', color: p.color, size: p.size, bold: p.bold, italic: p.italic, underline: p.underline,
    align: p.align, hidden: p.hidden, pre: p.pre,
    bg: null, mt: 0, mr: 0, mb: 0, ml: 0, pt: 0, pr: 0, pb: 0, pl: 0, width: null, height: null, border: null,
    maxW: null, minW: null, vars: null,
    translate: null, position: 'static', top: null, right: null, bottom: null, left: null, aspect: null, objectFit: 'fill',
    flexCol: false, wrap: false, justify: 'flex-start', alignItems: 'stretch', alignSelf: null,
    grow: 0, basis: null, gapR: 0, gapC: 0, gridCols: null,
  };
}

/**
 * grid-template-columns as a list of tracks: {kind: 'px' | 'pct' | 'fr' | 'auto', v}. repeat(n, track) is expanded.
 * Anything else (minmax(), auto-fill, named lines) returns null, which means one column.
 */
function parseTracks(value, emBase) {
  const expanded = String(value).trim().toLowerCase()
    .replace(/repeat\(\s*(\d+)\s*,\s*([^)]+)\)/g, (m, n, inner) => Array(Math.min(Number(n), 64)).fill(inner.trim()).join(' '));
  const tracks = [];
  for (const tok of expanded.split(/\s+/).filter(Boolean)) {
    if (tok === 'auto') { tracks.push({ kind: 'auto' }); continue; }
    if (/^\d*\.?\d+fr$/.test(tok)) { tracks.push({ kind: 'fr', v: Number.parseFloat(tok) }); continue; }
    const len = parseLength(tok, emBase);
    if (typeof len === 'number') tracks.push({ kind: 'px', v: len });
    else if (typeof len === 'string' && len.endsWith('%')) tracks.push({ kind: 'pct', v: Number.parseFloat(len) });
    else return null;
  }
  return tracks.length ? tracks : null;
}

function hits(el, list) {
  const out = [];
  for (const r of list) if (matches(el, r.selector)) out.push(r);
  return out.sort((a, b) => a.spec - b.spec || a.order - b.order);
}

/** Computed style of one element: UA defaults, then author rules, then the style attribute, then !important. */
function cascade(el, parent, rules) {
  const st = fresh(parent);
  const decls = [];
  for (const r of hits(el, rules.ua)) decls.push(...r.decls.filter((d) => !d.important));
  const important = [];
  for (const r of hits(el, rules.author)) {
    for (const d of r.decls) (d.important ? important : decls).push(d);
  }
  const inline = el.getAttribute('style');
  if (inline) for (const d of parseDecls(inline)) (d.important ? important : decls).push(d);
  const all = [...decls, ...important];
  // Custom properties are inherited. This element's own definitions override them, and var() reads the result.
  let vars = parent.vars ?? null;
  for (const d of all) if (d.name.startsWith('--')) vars = { ...(vars ?? {}), [d.name]: d.value };
  st.vars = vars;
  const resolved = [];
  for (const d of all) {
    if (d.name.startsWith('--')) continue;
    const value = substituteVars(d.value, vars);
    if (value !== null) resolved.push({ ...d, value });
  }
  applyDecls(st, resolved, parent.size, parent);
  if (ATOMIC.has(el.tagName) && st.display === 'inline') st.display = 'inline-block';
  if (st.display === 'inline-block' && !ATOMIC.has(el.tagName)) st.display = 'block';
  return st;
}

// ---------------------------------------------------------------- text metrics and ASCII mapping

/** Glyph box, advance and line height for a font size. The font is 5x7 cells scaled by size / 8. */
function metrics(size) {
  const s = size / 8;
  const gw = Math.max(1, Math.round(GLYPH_COLS * s));
  const gh = Math.max(1, Math.round(GLYPH_ROWS * s));
  return { s, gw, gh, adv: Math.max(1, Math.round(6 * s)), lh: Math.max(gh + 2, Math.round(size * 1.25)) };
}

const TYPOGRAPHIC = {
  '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...',
  '•': '*', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '​': '', '©': '(c)',
  '®': '(R)', '™': 'TM', '×': 'x', '·': '.', '→': '->', '←': '<-', '✓': 'v',
};

/** Maps text to the printable ASCII the font has. Accents are dropped, known symbols mapped, the rest '?'. */
export function toAscii(s) {
  let out = '';
  for (const ch of String(s).normalize('NFD')) {
    const c = ch.codePointAt(0);
    if ((c >= 32 && c <= 126) || c === 10 || c === 9) out += ch;
    else if (c === 13) continue;
    else if (c >= 0x300 && c <= 0x36f) continue;
    else out += TYPOGRAPHIC[ch] ?? '?';
  }
  return out;
}

// ---------------------------------------------------------------- pixels

class Canvas {
  constructor(width, height, bg) {
    this.width = width;
    this.height = height;
    this.px = new Uint8Array(width * height * 4);
    for (let i = 0; i < this.px.length; i += 4) {
      this.px[i] = bg[0];
      this.px[i + 1] = bg[1];
      this.px[i + 2] = bg[2];
      this.px[i + 3] = 255;
    }
  }

  blend(x, y, c) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const a = c[3] / 255;
    if (a >= 1) {
      this.px[i] = c[0];
      this.px[i + 1] = c[1];
      this.px[i + 2] = c[2];
    } else if (a > 0) {
      this.px[i] = Math.round(c[0] * a + this.px[i] * (1 - a));
      this.px[i + 1] = Math.round(c[1] * a + this.px[i + 1] * (1 - a));
      this.px[i + 2] = Math.round(c[2] * a + this.px[i + 2] * (1 - a));
    }
  }

  /**
   * Draws a decoded image in op.w x op.h (nearest neighbour), blended by its alpha channel. object-fit decides the
   * size: fill stretches it; cover and contain keep its proportions and centre it, cropping or leaving room; none
   * keeps its natural size.
   */
  drawImage(op) {
    const { img } = op;
    const fit = op.fit ?? 'fill';
    let scale = null; // image pixels per output pixel is 1/scale for fit modes other than fill
    if (fit === 'cover') scale = Math.max(op.w / img.width, op.h / img.height);
    else if (fit === 'contain') scale = Math.min(op.w / img.width, op.h / img.height);
    else if (fit === 'none') scale = 1;
    const dw = scale === null ? op.w : img.width * scale;
    const dh = scale === null ? op.h : img.height * scale;
    const offX = (op.w - dw) / 2;
    const offY = (op.h - dh) / 2;
    const x0 = Math.max(0, Math.floor(op.x));
    const y0 = Math.max(0, Math.floor(op.y));
    const x1 = Math.min(this.width, Math.floor(op.x + op.w));
    const y1 = Math.min(this.height, Math.floor(op.y + op.h));
    const ch = img.channels;
    for (let y = y0; y < y1; y++) {
      const v = Math.floor(((y - op.y - offY) * img.height) / dh);
      if (v < 0 || v >= img.height) continue;
      for (let x = x0; x < x1; x++) {
        const u = Math.floor(((x - op.x - offX) * img.width) / dw);
        if (u < 0 || u >= img.width) continue;
        const si = (v * img.width + u) * ch;
        const a = ch === 4 ? img.data[si + 3] / 255 : 1;
        if (a === 0) continue;
        const di = (y * this.width + x) * 4;
        for (let c = 0; c < 3; c++) {
          this.px[di + c] = Math.round(img.data[si + c] * a + this.px[di + c] * (1 - a));
        }
        this.px[di + 3] = 255;
      }
    }
  }

  fillRect(x, y, w, h, c) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.floor(x + w));
    const y1 = Math.min(this.height, Math.floor(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, c);
  }

  text(op) {
    const m = metrics(op.size);
    let x = op.x;
    for (const ch of op.text) {
      const rows = glyphRows(ch.codePointAt(0)) ?? glyphRows(63); // unknown characters draw as '?'
      for (let dy = 0; dy < m.gh; dy++) {
        const sy = Math.min(GLYPH_ROWS - 1, Math.floor(((dy + 0.5) * GLYPH_ROWS) / m.gh));
        for (let dx = 0; dx < m.gw; dx++) {
          const sx = Math.min(GLYPH_COLS - 1, Math.floor(((dx + 0.5) * GLYPH_COLS) / m.gw));
          if (rows[sy][sx] !== '#') continue;
          this.blend(x + dx, op.y + dy, op.color);
          if (op.bold) this.blend(x + dx + 1, op.y + dy, op.color);
        }
      }
      x += m.adv;
    }
    if (op.underline) {
      const thick = Math.max(1, Math.round(m.s / 2));
      this.fillRect(op.x, op.y + m.gh + 1, op.text.length * m.adv, thick, op.color);
    }
  }
}

// ---------------------------------------------------------------- layout

const rect = (x, y, w, h, color) => ({ t: 'rect', x, y, w, h, color });
const pxOr = (v, dflt) => (typeof v === 'number' ? v : dflt);
const num = (v) => (typeof v === 'number' ? v : 0);

function frame(ctx, x, y, w, h, color) {
  if (w <= 0 || h <= 0) return;
  ctx.ops.push(rect(x, y, w, 1, color), rect(x, y + h - 1, w, 1, color), rect(x, y, 1, h, color), rect(x + w - 1, y, 1, h, color));
}

function pushText(ctx, x, y, text, st) {
  if (st.hidden || !text) return;
  ctx.ops.push({ t: 'text', x: Math.round(x), y: Math.round(y), text, size: st.size, color: st.color, bold: st.bold, underline: st.underline });
}

/** Lays out one box (its border box, not its margin box). Returns the border-box height. */
function layoutBox(el, st, cx, top0, cw, ctx) {
  const bord = st.border ? 1 : 0;
  const ml = num(st.ml);
  const mr = num(st.mr);
  // position: relative moves the box by its offsets, and leaves its flow place where it was.
  const offset = (v, base) => (v === null ? null : resolveLength(v, base));
  const rel = st.position === 'relative';
  const relDx = rel ? (offset(st.left, cw) ?? (st.right !== null ? -offset(st.right, cw) : 0)) : 0;
  const relDy = rel ? (offset(st.top, cw) ?? (st.bottom !== null ? -offset(st.bottom, cw) : 0)) : 0;
  const top = top0 + relDy;
  const fixedWidth = st.width !== null;
  let contentW = fixedWidth ? resolveLength(st.width, cw) : cw - ml - mr - st.pl - st.pr - 2 * bord;
  if (st.maxW !== null) contentW = Math.min(contentW, resolveLength(st.maxW, cw));
  if (st.minW !== null) contentW = Math.max(contentW, resolveLength(st.minW, cw));
  contentW = Math.max(0, contentW);
  let bx = cx + ml + relDx;
  const limited = fixedWidth || st.maxW !== null;
  if (limited && st.ml === 'auto' && st.mr === 'auto') {
    bx = cx + Math.max(0, (cw - contentW - st.pl - st.pr - 2 * bord) / 2);
  }
  const innerX = bx + bord + st.pl;
  const innerY = top + bord + st.pt;
  const mark = ctx.ops.length;
  const outerCw = ctx.cw; // the containing width for percentage sizes of atomic boxes (images, controls)
  ctx.cw = contentW;
  // Absolutely positioned descendants are placed once their containing block (this box, if positioned) is laid out.
  const outerPending = ctx.absPending;
  ctx.absPending = [];
  let contentH;
  if (st.display === 'table') contentH = tableRows(el, st, innerX, innerY, contentW, ctx);
  else if (st.display === 'flex') contentH = flexChildren(el, st, innerX, innerY, contentW, ctx);
  else if (st.display === 'grid') contentH = gridChildren(el, st, innerX, innerY, contentW, ctx);
  else contentH = flowChildren(el, st, innerX, innerY, contentW, ctx);
  const mine = ctx.absPending;
  ctx.absPending = outerPending;
  ctx.cw = outerCw;
  if (typeof st.height === 'number') contentH = st.height;
  else if (st.height !== null) contentH = resolveLength(st.height, contentH);
  else if (st.aspect !== null && contentW > 0) contentH = Math.max(contentH, contentW / st.aspect);
  const boxW = contentW + st.pl + st.pr + 2 * bord;
  const boxH = contentH + st.pt + st.pb + 2 * bord;
  if (ctx.boxes) ctx.boxes.set(el, { x: bx, y: top, width: boxW, height: boxH });
  if (st.bg) ctx.ops.splice(mark, 0, rect(bx, top, boxW, boxH, st.bg));
  if (st.border) frame(ctx, bx, top, boxW, boxH, st.border);
  if (el.tagName === 'li' && st.display === 'list-item') listMarker(el, st, innerX, innerY, ctx);
  if (st.position === 'relative' || st.position === 'absolute' || st.position === 'fixed') {
    for (const it of mine) placeAbsolute(it, { x: innerX, y: innerY, w: contentW, h: contentH }, ctx);
  } else if (mine.length) {
    (ctx.absPending ??= []).push(...mine);
  }
  if (st.translate) {
    // translate() shifts everything this box drew, including its children; percentages are of the box itself.
    const dx = resolveLength(st.translate.x, boxW);
    const dy = resolveLength(st.translate.y, boxH);
    shiftOps(ctx.ops, mark, dx, dy);
  }
  return boxH;
}

/** Moves the drawing operations from index `from` on by (dx, dy). */
function shiftOps(ops, from, dx, dy) {
  for (let i = from; i < ops.length; i++) {
    const op = ops[i];
    op.x += dx;
    op.y += dy;
  }
}

/**
 * Places an absolutely positioned box inside its containing block cb ({x, y, w, h}, the padding box of the nearest
 * positioned ancestor). left/right/top/bottom position it; a width or height that is not given comes from its
 * offsets (both sides set) or its content. It is drawn after the flow, so it covers what it overlaps.
 */
function placeAbsolute(it, cb, ctx) {
  const st = it.st;
  const hasL = st.left !== null;
  const hasR = st.right !== null;
  const hasT = st.top !== null;
  const hasB = st.bottom !== null;
  const L = hasL ? resolveLength(st.left, cb.w) : 0;
  const R = hasR ? resolveLength(st.right, cb.w) : 0;
  const T = hasT ? resolveLength(st.top, cb.h) : 0;
  const B = hasB ? resolveLength(st.bottom, cb.h) : 0;
  const item = { ...it, st: { ...st } };
  // A percentage height is of the containing block, which is known here (unlike in the flow, where it is auto).
  if (st.height !== null && typeof st.height !== 'number') item.st.height = resolveLength(st.height, cb.h);
  let outerW;
  if (st.width !== null) {
    const content = Math.max(0, resolveLength(st.width, cb.w));
    item.st.width = content;
    outerW = content + st.pl + st.pr + (st.border ? 2 : 0) + num(st.ml) + num(st.mr);
  } else if (hasL && hasR) {
    outerW = cb.w - L - R;
  } else {
    outerW = outerBasis(it, cb.w, ctx);
  }
  const x = hasL ? cb.x + L : hasR ? cb.x + cb.w - R - outerW : cb.x;
  const stretchH = st.height === null && hasT && hasB ? cb.h - T - B : undefined;
  let y = cb.y;
  if (hasT) y = cb.y + T;
  else if (hasB) y = cb.y + cb.h - B - (stretchH ?? itemHeight(item, outerW, ctx, { ownWidth: true }));
  placeItem(item, x, y, outerW, ctx, { ownWidth: true, stretchH });
}

function resolveLength(v, base) {
  if (typeof v === 'number') return v;
  if (v !== null && typeof v === 'object' && v.expr) return evalLength(v.expr, base);
  return (Number.parseFloat(v) * base) / 100;
}

function listMarker(li, st, x, y, ctx) {
  const parent = li.parentNode;
  const lh = metrics(st.size).lh;
  if (parent && parent.tagName === 'ol') {
    const start = Number.parseInt(parent.getAttribute('start') ?? '1', 10) || 1;
    const index = parent.children.filter((c) => c.tagName === 'li').indexOf(li);
    const label = `${start + index}.`;
    const m = metrics(st.size);
    pushText(ctx, x - label.length * m.adv - 6, y + Math.floor((lh - m.gh) / 2), label, st);
  } else {
    const sz = Math.max(3, Math.round(st.size / 4));
    ctx.ops.push(rect(x - 12, y + Math.round(lh / 2) - Math.floor(sz / 2), sz, sz, st.color));
  }
}

/** Lays out the children of a block. Returns the height they take (a trailing margin is left to the parent). */
function flowChildren(parent, pst, x, y, w, ctx) {
  let cur = y;
  let gap = 0;
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    cur += gap;
    gap = 0;
    cur += inlineRun(run, pst, x, cur, w, ctx);
    run = [];
  };
  for (const node of parent.childNodes) {
    if (node.nodeType === TEXT) {
      run.push({ node, st: pst });
      continue;
    }
    if (node.nodeType !== ELEMENT || SKIP.has(node.tagName)) continue;
    const st = cascade(node, pst, ctx.rules);
    if (st.display === 'none') continue;
    if (outOfFlow(st)) {
      (ctx.absPending ??= []).push({ node, st });
      continue;
    }
    if (st.display === 'inline' || st.display === 'inline-block' || ATOMIC.has(node.tagName)) {
      run.push({ node, st });
      continue;
    }
    flush();
    const top = cur + Math.max(gap, num(st.mt));
    const h = layoutBox(node, st, x, top, w, ctx);
    cur = top + h;
    gap = num(st.mb);
  }
  flush();
  return cur - y;
}

// ---------------------------------------------------------------- flex and grid
//
// A simplified flexbox and grid. Items are the element children, plus each run of text (an anonymous item). The
// main size of a flex item comes from flex-basis, then width, then its content (measured with a scratch layout).
// Lines wrap with flex-wrap. Grow and shrink are proportional. Justify and align cover the common values. Grid
// places items row by row into tracks, with no spans, no minmax() and no auto-fill.

const MEASURE_WIDTH = 1e6;

/** Boxes that take no room in the flow (absolute and fixed positioning). */
function outOfFlow(st) {
  return st.position === 'absolute' || st.position === 'fixed';
}

/** The child boxes of a flex or grid container, in document order. */
function flexItems(container, cst, ctx) {
  const items = [];
  for (const node of container.childNodes) {
    if (node.nodeType === TEXT) {
      if (/\S/.test(node.data)) items.push({ node, st: cst, text: true });
      continue;
    }
    if (node.nodeType !== ELEMENT || SKIP.has(node.tagName)) continue;
    const st = cascade(node, cst, ctx.rules);
    if (st.display === 'none') continue;
    if (outOfFlow(st)) {
      (ctx.absPending ??= []).push({ node, st });
      continue;
    }
    // Images and form controls are atomic inline boxes: they are placed through the inline path, as text is.
    items.push({ node, st, text: ATOMIC.has(node.tagName) });
  }
  return items;
}

/**
 * The widest an item's content wants to be (its max-content width), from a scratch layout. The result depends only
 * on the node, so it is kept in ctx.memo for the rest of the render.
 */
function measureItem(it, ctx) {
  if (ctx.memo?.has(it.node)) return ctx.memo.get(it.node);
  const measure = { maxW: 0 };
  const scratch = { ops: [], rules: ctx.rules, memo: ctx.memo, resources: ctx.resources, cw: ctx.cw, measure };
  if (it.text) {
    inlineRun([{ node: it.node, st: it.st }], it.st, 0, 0, MEASURE_WIDTH, scratch);
  } else {
    layoutBox(it.node, { ...it.st, width: null, ml: 0, mr: 0, mt: 0, mb: 0 }, 0, 0, MEASURE_WIDTH, scratch);
  }
  ctx.memo?.set(it.node, measure.maxW);
  return measure.maxW;
}

/** Outer size along the main axis (margins included) an item asks for before flex grows or shrinks it. */
function outerBasis(it, w, ctx) {
  const st = it.st;
  const mm = num(st.ml) + num(st.mr);
  if (it.text) return measureItem(it, ctx);
  const extra = st.pl + st.pr + (st.border ? 2 : 0);
  let content;
  if (st.basis !== null) content = resolveLength(st.basis, w);
  else if (st.width !== null) content = resolveLength(st.width, w);
  else content = measureItem(it, ctx);
  return Math.max(0, content) + extra + mm;
}

/**
 * Places one item with its margin box at x, top, `outerW` wide. With ownWidth, a set width is kept (a column
 * item); otherwise the item fills outerW (a row item's main size, or a grid track). Returns the margin-box height.
 */
function placeItem(it, x, top, outerW, ctx, { ownWidth = false, stretchH } = {}) {
  const st = it.st;
  if (it.text) return inlineRun([{ node: it.node, st }], st, x, top, outerW, ctx);
  const ml = num(st.ml);
  const mr = num(st.mr);
  const mt = num(st.mt);
  const mb = num(st.mb);
  const bord = st.border ? 1 : 0;
  const extra = st.pl + st.pr + 2 * bord;
  const contentW = ownWidth && st.width !== null
    ? resolveLength(st.width, outerW)
    : Math.max(0, outerW - ml - mr - extra);
  // align-items: stretch makes an item without its own height as tall as its line.
  let height = st.height;
  if (stretchH !== undefined && st.height === null) {
    height = Math.max(0, stretchH - mt - mb - st.pt - st.pb - 2 * bord);
  }
  const sized = { ...st, width: contentW, height, ml: 0, mr: 0, mt: 0, mb: 0 };
  if (it.node.tagName === 'img') {
    // A picture is drawn by its own token (the same one a picture in the flow uses), not by the box layout.
    const pic = atomicToken(it.node, sized, ctx);
    pic.draw(x + ml, top + mt);
    return mt + pic.h + mb;
  }
  const boxH = layoutBox(it.node, sized, x + ml, top + mt, outerW - ml - mr, ctx);
  return mt + boxH + mb;
}

/** Height an item takes at a given outer width (a scratch layout, so nothing is drawn). */
function itemHeight(it, outerW, ctx, opts) {
  const scratch = { ops: [], rules: ctx.rules, memo: ctx.memo, resources: ctx.resources, cw: ctx.cw, measure: ctx.measure };
  return placeItem(it, 0, 0, outerW, scratch, opts);
}

/** Lays out a flex container. Row by default; flex-direction: column stacks the items. Returns the height. */
function flexChildren(container, cst, x, y, w, ctx) {
  const items = flexItems(container, cst, ctx);
  if (items.length === 0) return 0;
  for (const it of items) it.outer = outerBasis(it, w, ctx);
  if (ctx.measure) {
    // Max-content width of a row is the sum of its items; of a column, the widest item.
    const along = items.reduce((acc, it) => acc + it.outer, 0) + cst.gapC * (items.length - 1);
    const across = Math.max(...items.map((it) => it.outer));
    ctx.measure.maxW = Math.max(ctx.measure.maxW, cst.flexCol ? across : along);
  }
  if (cst.flexCol) {
    let cur = y;
    for (const [i, it] of items.entries()) {
      if (i > 0) cur += cst.gapR;
      cur += placeItem(it, x, cur, w, ctx, { ownWidth: true });
    }
    return cur - y;
  }
  const lines = [];
  let line = [];
  let used = 0;
  for (const it of items) {
    const gap = line.length ? cst.gapC : 0;
    if (cst.wrap && line.length && used + gap + it.outer > w) {
      lines.push(line);
      line = [];
      used = 0;
    }
    used += (line.length ? cst.gapC : 0) + it.outer;
    line.push(it);
  }
  lines.push(line);
  // A single-line row in a container with a set height fills that height on the cross axis.
  const fixedH = typeof cst.height === 'number' ? cst.height - cst.pt - cst.pb - (cst.border ? 2 : 0) : null;
  let cur = y;
  for (const [i, ln] of lines.entries()) {
    if (i > 0) cur += cst.gapR;
    const minH = lines.length === 1 && fixedH !== null ? fixedH : 0;
    cur += flexLine(ln, cst, x, cur, w, ctx, minH);
  }
  if (lines.length === 1 && fixedH !== null) return Math.max(cur - y, fixedH);
  return cur - y;
}

/** One line of a flex row: sizes the items on the main axis, justifies them, and aligns them on the cross axis. */
function flexLine(line, cst, x, top, w, ctx, minH = 0) {
  const n = line.length;
  const gap = cst.gapC;
  let sum = 0;
  let grow = 0;
  for (const it of line) {
    sum += it.outer;
    grow += it.st.grow;
  }
  const gaps = gap * (n - 1);
  const free = w - sum - gaps;
  for (const it of line) {
    let main = it.outer;
    if (free > 0 && grow > 0) main += free * (it.st.grow / grow);
    else if (free < 0 && sum > 0) main = Math.max(0, main + free * (main / sum));
    it.main = main;
  }
  const used = line.reduce((acc, it) => acc + it.main, 0) + gaps;
  const remaining = Math.max(0, w - used);
  let offset = 0;
  let between = gap;
  switch (cst.justify) {
    case 'center': offset = remaining / 2; break;
    case 'flex-end': case 'end': offset = remaining; break;
    case 'space-between': if (n > 1) between = gap + remaining / (n - 1); break;
    case 'space-around': { const e = remaining / n; offset = e / 2; between = gap + e; break; }
    case 'space-evenly': { const e = remaining / (n + 1); offset = e; between = gap + e; break; }
    default: break; // flex-start
  }
  // Along a row the main size is the flex size, so a set width does not apply here.
  const heights = line.map((it) => itemHeight(it, it.main, ctx));
  const lineH = Math.max(minH, ...heights);
  let cx = x + offset;
  for (const [i, it] of line.entries()) {
    const align = it.st.alignSelf ?? cst.alignItems;
    let dy = 0;
    if (align === 'center') dy = (lineH - heights[i]) / 2;
    else if (align === 'flex-end' || align === 'end') dy = lineH - heights[i];
    const stretchH = align === 'stretch' ? lineH : undefined;
    placeItem(it, cx, top + Math.round(dy), it.main, ctx, { stretchH });
    cx += it.main + between;
  }
  return lineH;
}

/** Lays out a grid container: tracks from grid-template-columns, items placed row by row. Returns the height. */
function gridChildren(container, cst, x, y, w, ctx) {
  const items = flexItems(container, cst, ctx);
  if (items.length === 0) return 0;
  const tracks = cst.gridCols ?? [{ kind: 'fr', v: 1 }];
  const n = tracks.length;
  const gapC = cst.gapC;
  const widths = new Array(n).fill(0);
  let fixed = 0;
  let frSum = 0;
  tracks.forEach((t, i) => {
    if (t.kind === 'px') widths[i] = t.v;
    else if (t.kind === 'pct') widths[i] = (t.v * w) / 100;
    else if (t.kind === 'fr') frSum += t.v;
    if (t.kind !== 'fr') fixed += widths[i];
  });
  // An auto track is as wide as its widest item.
  tracks.forEach((t, i) => {
    if (t.kind !== 'auto') return;
    let m = 0;
    items.forEach((it, k) => { if (k % n === i) m = Math.max(m, outerBasis(it, w, ctx)); });
    widths[i] = m;
    fixed += m;
  });
  const free = Math.max(0, w - fixed - gapC * (n - 1));
  tracks.forEach((t, i) => { if (t.kind === 'fr') widths[i] = frSum > 0 ? (free * t.v) / frSum : 0; });
  const xs = [];
  let acc = x;
  for (let i = 0; i < n; i++) {
    xs.push(acc);
    acc += widths[i] + gapC;
  }
  let cur = y;
  for (let r = 0; r * n < items.length; r++) {
    const row = items.slice(r * n, r * n + n);
    if (r > 0) cur += cst.gapR;
    const rowH = Math.max(0, ...row.map((it, c) => itemHeight(it, widths[c], ctx, { ownWidth: true })));
    row.forEach((it, c) => placeItem(it, xs[c], cur, widths[c], ctx, { ownWidth: true, stretchH: rowH }));
    cur += rowH;
  }
  return cur - y;
}

/** Table rows: each row's cells share the width equally, and a row is as tall as its tallest cell. */
function tableRows(table, tst, x, y, w, ctx) {
  const rows = [];
  for (const child of table.children) {
    if (child.tagName === 'tr') rows.push(child);
    else if (['thead', 'tbody', 'tfoot'].includes(child.tagName)) rows.push(...child.children.filter((c) => c.tagName === 'tr'));
  }
  const cellsOf = (tr) => tr.children.filter((c) => c.tagName === 'td' || c.tagName === 'th');
  const cols = Math.max(1, ...rows.map((r) => cellsOf(r).length));
  const colW = Math.floor(w / cols);
  const bordered = tst.border !== null || (table.getAttribute('border') ?? '0') !== '0';
  const grid = tst.border ?? [136, 136, 136, 255];
  let cur = y;
  for (const tr of rows) {
    const trst = cascade(tr, tst, ctx.rules);
    if (trst.display === 'none') continue;
    const rowTop = cur;
    const cells = cellsOf(tr).map((c) => ({ el: c, st: cascade(c, trst, ctx.rules) })).filter((c) => c.st.display !== 'none');
    const mark = ctx.ops.length;
    let rowH = 0;
    cells.forEach(({ el, st }, i) => {
      rowH = Math.max(rowH, layoutBox(el, st, x + i * colW, rowTop, colW, ctx));
    });
    if (trst.bg) ctx.ops.splice(mark, 0, rect(x, rowTop, colW * cols, rowH, trst.bg));
    if (bordered) cells.forEach((_, i) => frame(ctx, x + i * colW, rowTop, colW, rowH, grid));
    cur = rowTop + rowH;
  }
  return cur - y;
}

/** An inline run (text, inline elements, atomic controls) wrapped into lines. Returns its height. */
function inlineRun(items, pst, x, y, w, ctx) {
  const toks = [];
  for (const it of items) emitInline(it.node, it.st, toks, ctx);
  const lines = buildLines(toks, w, pst);
  if (ctx.measure) for (const line of lines) ctx.measure.maxW = Math.max(ctx.measure.maxW, line.w);
  let cur = y;
  for (const line of lines) {
    const lh = line.h;
    let cx = x;
    if (pst.align === 'center') cx += Math.max(0, (w - line.w) / 2);
    else if (pst.align === 'right') cx += Math.max(0, w - line.w);
    for (const it of line.items) {
      if (it.t === 'word') {
        pushText(ctx, cx, cur + Math.floor((lh - metrics(it.st.size).gh) / 2), it.text, it.st);
        cx += it.w;
      } else if (it.t === 'space') {
        cx += it.w;
      } else if (it.t === 'box') {
        if (!it.hidden) it.draw(cx, cur + Math.max(0, Math.floor((lh - it.h) / 2)));
        cx += it.w;
      }
    }
    cur += lh;
  }
  return cur - y;
}

function emitInline(node, st, toks, ctx) {
  if (node.nodeType === TEXT) {
    textTokens(node.data, st, toks);
    return;
  }
  if (node.nodeType !== ELEMENT || st.display === 'none') return;
  if (node.tagName === 'br') {
    toks.push({ t: 'br' });
    return;
  }
  if (ATOMIC.has(node.tagName)) {
    toks.push(atomicToken(node, st, ctx));
    return;
  }
  for (const child of node.childNodes) {
    if (child.nodeType === ELEMENT) {
      if (SKIP.has(child.tagName)) continue;
      emitInline(child, cascade(child, st, ctx.rules), toks, ctx);
    } else {
      emitInline(child, st, toks, ctx);
    }
  }
}

function textTokens(raw, st, toks) {
  const text = toAscii(raw);
  if (st.pre) {
    text.replace(/\t/g, '    ').split('\n').forEach((line, i) => {
      if (i > 0) toks.push({ t: 'br' });
      if (line) toks.push({ t: 'word', text: line, st });
    });
    return;
  }
  for (const m of text.matchAll(/[ \n\r\f\t]+|[^ \n\r\f\t]+/g)) {
    if (/^[ \n\r\f\t]/.test(m[0])) {
      const last = toks[toks.length - 1];
      if (last && last.t !== 'space' && last.t !== 'br') toks.push({ t: 'space', st, w: metrics(st.size).adv });
    } else {
      toks.push({ t: 'word', text: m[0], st });
    }
  }
}

/** Splits tokens into lines no wider than maxW. A long word is broken across lines by characters. */
function buildLines(toks, maxW, pst) {
  const lines = [];
  let line = newLine();
  function newLine() { return { items: [], w: 0, hasContent: false, h: 0 }; }
  const close = () => {
    while (line.items.length && line.items[line.items.length - 1].t === 'space') {
      line.w -= line.items.pop().w;
    }
    lines.push(line);
    line = newLine();
  };
  for (const tok of toks) {
    if (tok.t === 'br') {
      close();
      continue;
    }
    if (tok.t === 'space') {
      if (line.items.length) {
        line.items.push(tok);
        line.w += tok.w;
      }
      continue;
    }
    if (tok.t === 'box') {
      if (line.w + tok.w > maxW && line.hasContent) close();
      line.items.push(tok);
      line.w += tok.w;
      line.hasContent = true;
      continue;
    }
    const m = metrics(tok.st.size);
    let rest = tok.text;
    while (rest.length) {
      const full = rest.length * m.adv;
      if (line.w + full <= maxW) {
        line.items.push({ t: 'word', text: rest, st: tok.st, w: full });
        line.w += full;
        line.hasContent = true;
        break;
      }
      if (line.hasContent && full <= maxW) {
        close();
        continue;
      }
      let fit = Math.floor((maxW - line.w) / m.adv);
      if (fit < 1) {
        if (line.hasContent) { close(); continue; }
        fit = 1;
      }
      const piece = rest.slice(0, fit);
      line.items.push({ t: 'word', text: piece, st: tok.st, w: piece.length * m.adv });
      line.w += piece.length * m.adv;
      line.hasContent = true;
      rest = rest.slice(fit);
      if (rest.length) close();
    }
  }
  if (line.items.length) lines.push(line);
  for (const l of lines) {
    let h = 0;
    for (const it of l.items) {
      if (it.t === 'word') h = Math.max(h, metrics(it.st.size).lh);
      else if (it.t === 'box') h = Math.max(h, it.h);
    }
    l.h = Math.max(h, l.items.length ? 0 : metrics(pst.size).lh);
    if (l.h === 0) l.h = metrics(pst.size).lh;
  }
  return lines;
}

/** A replaced or form control, drawn as a box. Returns a token with its size and a draw(x, y) function. */
function atomicToken(node, st, ctx) {
  const tag = node.tagName;
  const m = metrics(st.size);
  const hidden = st.hidden;
  const attr = (n) => node.getAttribute(n);
  const bgOr = (c) => st.bg ?? c;
  const ink = () => st.color; // control text uses the inherited (or CSS) colour
  const drawBox = (x, y, w, h, bg, edge) => {
    ctx.ops.push(rect(x, y, w, h, bg));
    frame(ctx, x, y, w, h, edge);
  };
  const textIn = (x, y, w, h, text, color) => {
    const maxChars = Math.max(0, Math.floor((w - 8) / m.adv));
    const clipped = text.slice(0, maxChars);
    pushText(ctx, x + 4, y + Math.floor((h - m.gh) / 2), clipped, { ...st, color });
  };

  if (tag === 'img') {
    // A PNG the browser decoded is drawn with its pixels. Anything else is a grey box with its alt text.
    const pic = ctx.resources?.images?.get(node) ?? null;
    const cw = ctx.cw ?? VIEW.width;
    const intrinsicW = Number.parseInt(attr('width') ?? '', 10) || pic?.width || 150;
    const intrinsicH = Number.parseInt(attr('height') ?? '', 10) || pic?.height || 100;
    // The picture keeps its proportions unless both sides are set. A CSS percentage width is of the container.
    const ratio = pic ? pic.height / pic.width : intrinsicH / intrinsicW;
    let w = st.width !== null ? resolveLength(st.width, cw) : intrinsicW;
    if (st.width === null && typeof st.height === 'number' && ratio > 0) w = st.height / ratio;
    if (st.maxW !== null) w = Math.min(w, resolveLength(st.maxW, cw));
    if (st.width === null && w > cw) w = cw; // a picture with no size of its own shrinks to fit its container
    // A percentage height needs a definite parent height, which a flow box does not have: the aspect ratio decides.
    // Width and height attributes are used as they are when the CSS sets neither size and the width is not changed.
    const attrH = Number.parseInt(attr('height') ?? '', 10) || null;
    const attrW = Number.parseInt(attr('width') ?? '', 10) || null;
    const useAttrH = attrH !== null && attrW !== null && st.width === null && w === attrW;
    const h = typeof st.height === 'number' ? st.height : useAttrH ? attrH : w * ratio;
    const alt = toAscii(attr('alt') ?? '');
    return { t: 'box', w, h, hidden, draw: (x, y) => {
      if (pic) {
        ctx.ops.push({ t: 'image', x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), img: pic, fit: st.objectFit });
        return;
      }
      // Not decoded: an outline with its alt text, not a grey panel.
      frame(ctx, x, y, w, h, [140, 140, 140, 255]);
      textIn(x, y, w, h, alt, [140, 140, 140, 255]);
    } };
  }

  if (tag === 'input') {
    const type = (attr('type') ?? 'text').trim().toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      const checked = node.hasAttribute('checked');
      return { t: 'box', w: 13, h: 13, hidden, draw: (x, y) => {
        drawBox(x, y, 13, 13, WHITE, [118, 118, 118, 255]);
        if (checked) ctx.ops.push(rect(x + 3, y + 3, 7, 7, [0, 96, 223, 255]));
      } };
    }
    if (['submit', 'button', 'reset', 'image'].includes(type)) {
      const dflt = type === 'submit' || type === 'image' ? 'Submit' : type === 'reset' ? 'Reset' : '';
      const label = toAscii(attr('value') ?? dflt);
      const w = pxOr(st.width, Math.max(40, label.length * m.adv + 16));
      const h = pxOr(st.height, Math.max(21, m.lh + 6));
      return { t: 'box', w, h, hidden, draw: (x, y) => {
        drawBox(x, y, w, h, bgOr([239, 239, 239, 255]), [118, 118, 118, 255]);
        const color = node.hasAttribute('disabled') ? [109, 109, 109, 255] : BLACK;
        pushText(ctx, x + Math.floor((w - label.length * m.adv) / 2), y + Math.floor((h - m.gh) / 2), label, { ...st, color });
      } };
    }
    if (type === 'range') {
      const w = pxOr(st.width, 129);
      return { t: 'box', w, h: 16, hidden, draw: (x, y) => ctx.ops.push(rect(x, y + 7, w, 2, [136, 136, 136, 255])) };
    }
    if (type === 'color') {
      const c = parseColor(attr('value') ?? '') ?? [136, 136, 136, 255];
      return { t: 'box', w: 44, h: 23, hidden, draw: (x, y) => drawBox(x, y, 44, 23, c, [118, 118, 118, 255]) };
    }
    // text, search, email, url, tel, password, number, date, file and the rest: a text field
    const w = pxOr(st.width, 173);
    const h = pxOr(st.height, 21);
    const value = attr('value');
    const hasValue = value !== null && value !== '';
    const shown = hasValue ? (type === 'password' ? '*'.repeat(value.length) : toAscii(value))
      : type === 'file' ? 'No file chosen' : toAscii(attr('placeholder') ?? '');
    const color = hasValue || type === 'file' ? ink(BLACK) : [117, 117, 117, 255];
    return { t: 'box', w, h, hidden, draw: (x, y) => {
      drawBox(x, y, w, h, bgOr(WHITE), [118, 118, 118, 255]);
      textIn(x, y, w, h, shown, color);
    } };
  }

  if (tag === 'button') {
    const label = toAscii(normalizeText(node.textContent));
    const w = pxOr(st.width, Math.max(40, label.length * m.adv + 16));
    const h = pxOr(st.height, Math.max(21, m.lh + 6));
    return { t: 'box', w, h, hidden, draw: (x, y) => {
      drawBox(x, y, w, h, bgOr([239, 239, 239, 255]), [118, 118, 118, 255]);
      const color = node.hasAttribute('disabled') ? [109, 109, 109, 255] : ink(BLACK);
      pushText(ctx, x + Math.floor((w - label.length * m.adv) / 2), y + Math.floor((h - m.gh) / 2), label, { ...st, color });
    } };
  }

  if (tag === 'select') {
    const opts = node.querySelectorAll('option');
    const chosen = opts.find((o) => o.hasAttribute('selected')) ?? opts[0];
    const label = toAscii(normalizeText(chosen ? chosen.textContent : ''));
    const widest = Math.max(0, ...opts.map((o) => toAscii(normalizeText(o.textContent)).length));
    const w = pxOr(st.width, Math.min(260, Math.max(60, widest * m.adv + 30)));
    const h = pxOr(st.height, 21);
    return { t: 'box', w, h, hidden, draw: (x, y) => {
      drawBox(x, y, w, h, bgOr(WHITE), [118, 118, 118, 255]);
      textIn(x, y, w - 18, h, label, ink(BLACK));
      const ax = x + w - 12;
      const ay = y + Math.floor(h / 2) - 2;
      ctx.ops.push(rect(ax, ay, 7, 1, BLACK), rect(ax + 1, ay + 1, 5, 1, BLACK), rect(ax + 2, ay + 2, 3, 1, BLACK));
    } };
  }

  // textarea
  const rows = Math.max(1, Number.parseInt(attr('rows') ?? '2', 10) || 2);
  const text = toAscii(node.textContent);
  const w = pxOr(st.width, 220);
  const h = pxOr(st.height, rows * m.lh + 8);
  const lines = text.split('\n');
  return { t: 'box', w, h, hidden, draw: (x, y) => {
    drawBox(x, y, w, h, bgOr(WHITE), [118, 118, 118, 255]);
    lines.slice(0, rows).forEach((ln, i) => textIn(x, y + 4 + i * m.lh, w, m.lh, ln, ink()));
  } };
}

// ---------------------------------------------------------------- page

/**
 * The author rules of a document, in document order: <style> blocks, and <link rel="stylesheet"> files whose text the
 * browser loaded (resources.css, keyed by the link element). A sheet with a media attribute that does not apply is
 * skipped.
 */
function collectRules(doc, resources) {
  const parts = [];
  const walk = (n) => {
    if (n.nodeType === ELEMENT) {
      const media = n.getAttribute('media') ?? '';
      if (n.tagName === 'style' && mediaMatches(media)) {
        parts.push(n.textContent);
      } else if (n.tagName === 'link' && mediaMatches(media)
        && (n.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet')) {
        const text = resources?.css?.get(n);
        if (text) parts.push(text);
      }
    }
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(doc);
  return { ua: userAgentRules(), author: parseStylesheet(parts.join('\n'), 1e6) };
}

/**
 * Renders a parsed document to RGBA pixels.
 * @param {import('./html.js').Document} doc
 * @param {object} [opts]
 * @param {number} [opts.width=1280] viewport width in pixels
 * @param {number} [opts.height=800] viewport height; with fullPage, the canvas grows to the content
 * @param {boolean} [opts.fullPage=false]
 * @returns {{width: number, height: number, data: Uint8Array, truncated: boolean, contentHeight: number}}
 *   data is RGBA, top row first. truncated is true when the content was cut at the size limits.
 */
/**
 * Lays out a document without drawing it. The result maps each element that has a box to its border box
 * ({x, y, width, height}, in viewport pixels). Scripts use it for layout queries (getBoundingClientRect and the
 * offset and client sizes), and it is the same layout renderPage draws.
 */
export function layoutPage(doc, { width = RENDER_LIMITS.defaultWidth, height = RENDER_LIMITS.defaultHeight, resources = null } = {}) {
  VIEW = { width, height };
  const boxes = new Map();
  const rules = collectRules(doc, resources);
  const root = doc.documentElement ?? doc.querySelector('html') ?? doc.childNodes.find((n) => n.nodeType === ELEMENT);
  if (!root) return boxes;
  const ctx = { ops: [], rules, memo: new WeakMap(), resources, cw: width, absPending: [], boxes };
  layoutBox(root, cascade(root, ROOT, rules), 0, 0, width, ctx);
  for (const it of ctx.absPending) placeAbsolute(it, { x: 0, y: 0, w: width, h: height }, ctx);
  return boxes;
}

export function renderPage(doc, {
  width = RENDER_LIMITS.defaultWidth, height = RENDER_LIMITS.defaultHeight, fullPage = false, resources = null,
} = {}) {
  checkSize('width', width, RENDER_LIMITS.maxWidth);
  checkSize('height', height, RENDER_LIMITS.maxHeight);
  if (width * height > RENDER_LIMITS.maxPixels) {
    throw new KernelError('EINVAL', `EINVAL: a ${width}x${height} screenshot is larger than ${RENDER_LIMITS.maxPixels} pixels`);
  }
  VIEW = { width, height };
  const rules = collectRules(doc, resources);
  const root = doc.documentElement ?? doc.querySelector('html') ?? doc.childNodes.find((n) => n.nodeType === ELEMENT);
  const ctx = { ops: [], rules, memo: new WeakMap(), resources, cw: width, absPending: [] };
  if (!root) return { width, height, data: new Canvas(width, height, WHITE).px, truncated: false, contentHeight: 0 };

  const rootSt = cascade(root, ROOT, rules);
  const bodyEl = doc.body;
  const bodyBg = bodyEl ? cascade(bodyEl, rootSt, rules).bg : null;
  const canvasBg = (rootSt.bg ?? bodyBg ?? WHITE).slice(0, 3);
  layoutBox(root, rootSt, 0, 0, width, ctx);
  // Absolute boxes with no positioned ancestor are placed against the viewport.
  for (const it of ctx.absPending) placeAbsolute(it, { x: 0, y: 0, w: width, h: height }, ctx);

  let bottom = height;
  for (const op of ctx.ops) {
    const bottomOf = op.t === 'text' ? op.y + metrics(op.size).lh : op.t === 'rect' || op.t === 'image' ? op.y + op.h : op.y;
    bottom = Math.max(bottom, bottomOf);
  }
  const contentHeight = Math.ceil(bottom);
  let h = fullPage ? contentHeight : height;
  h = Math.min(h, RENDER_LIMITS.maxHeight, Math.floor(RENDER_LIMITS.maxPixels / width));
  const truncated = fullPage && contentHeight > h;

  const canvas = new Canvas(width, h, canvasBg);
  for (const op of ctx.ops) {
    if (op.t === 'rect') canvas.fillRect(op.x, op.y, op.w, op.h, op.color);
    else if (op.t === 'text') canvas.text(op);
    else if (op.t === 'image') canvas.drawImage(op);
  }
  return { width, height: h, data: canvas.px, truncated, contentHeight };
}

function checkSize(name, value, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new KernelError('EINVAL', `EINVAL: ${name} must be an integer from 1 to ${max} (got ${value})`);
  }
}
