// CSS selector engine. Selectors are parsed once (cached) into a list of complex selectors and
// matched right to left against the DOM. Works on any node tree that exposes nodeType,
// tagName, childNodes, parentNode and getAttribute (the html.js DOM does).
//
// Supported: type, *, #id, .class, [attr], [attr=v] [attr~=v] [attr|=v] [attr^=v] [attr$=v] [attr*=v] (with i flag),
// combinators (descendant, >, +, ~), selector lists (a, b), and pseudo-classes :first-child, :last-child,
// :only-child, :first-of-type, :last-of-type, :only-of-type, :nth-child(an+b|odd|even),
// :nth-last-child, :nth-of-type, :nth-last-of-type, :not(list), :empty, :root, :checked, :disabled,
// :enabled, :link, and :contains("text") (jQuery style, case-sensitive substring of normalized text).

export class SelectorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SelectorError';
    this.code = 'EINVAL';
  }
}

const ELEMENT = 1;
const COMMENT = 8;
const cache = new Map();

/** Parses a selector list. Results are cached; invalid selectors throw SelectorError. */
export function compile(selector) {
  if (Array.isArray(selector)) return selector;
  const src = String(selector);
  let list = cache.get(src);
  if (!list) {
    const p = { s: src, i: 0 };
    skipWs(p);
    list = parseList(p);
    if (p.i < src.length) throw err(p, `unexpected "${src[p.i]}"`);
    if (cache.size > 500) cache.clear();
    cache.set(src, list);
  }
  return list;
}

/** True if the element matches the selector. */
export function matches(el, selector) {
  if (!el || el.nodeType !== ELEMENT) return false;
  return matchList(el, compile(selector));
}

/** All descendant elements of root (not root itself) matching selector, in document order. */
export function querySelectorAll(root, selector) {
  const list = compile(selector);
  return descendants(root).filter((el) => matchList(el, list));
}

/** First descendant element matching selector, or null. */
export function querySelector(root, selector) {
  const list = compile(selector);
  for (const el of descendants(root)) if (matchList(el, list)) return el;
  return null;
}

/** Collapses whitespace runs to single spaces and trims. */
export function normalizeText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Text match helper. Returns the first candidate whose normalized text equals `query`
 * (case-insensitive); failing that, the first whose text contains it. Undefined if neither.
 * `textFor` picks the string to compare (defaults to textContent).
 */
export function findByText(candidates, query, textFor = (el) => el.textContent) {
  const q = normalizeText(query).toLowerCase();
  if (!q) return undefined;
  let partial;
  for (const el of candidates) {
    const t = normalizeText(textFor(el)).toLowerCase();
    if (t === q) return el;
    if (partial === undefined && t.includes(q)) partial = el;
  }
  return partial;
}

// ---------------------------------------------------------------- matching

function descendants(root) {
  const out = [];
  const stack = [];
  for (let i = root.childNodes.length - 1; i >= 0; i--) stack.push(root.childNodes[i]);
  while (stack.length) {
    const n = stack.pop();
    if (n.nodeType !== ELEMENT) continue;
    out.push(n);
    for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]);
  }
  return out;
}

function matchList(el, list) {
  for (const parts of list) if (matchParts(el, parts, parts.length - 1)) return true;
  return false;
}

function matchParts(el, parts, i) {
  if (!matchCompound(el, parts[i].compound)) return false;
  if (i === 0) return true;
  switch (parts[i].comb) {
    case '>': {
      const p = parentEl(el);
      return !!p && matchParts(p, parts, i - 1);
    }
    case ' ':
      for (let p = parentEl(el); p; p = parentEl(p)) if (matchParts(p, parts, i - 1)) return true;
      return false;
    case '+': {
      const s = prevEl(el);
      return !!s && matchParts(s, parts, i - 1);
    }
    case '~':
      for (let s = prevEl(el); s; s = prevEl(s)) if (matchParts(s, parts, i - 1)) return true;
      return false;
    default: return false;
  }
}

function matchCompound(el, c) {
  if (el.nodeType !== ELEMENT) return false;
  if (c.tag !== null && c.tag !== el.tagName) return false;
  for (const test of c.tests) if (!test(el)) return false;
  return true;
}

function parentEl(el) {
  const p = el.parentNode;
  return p && p.nodeType === ELEMENT ? p : null;
}

function prevEl(el) {
  const sibs = el.parentNode?.childNodes;
  if (!sibs) return null;
  let i = sibs.indexOf(el) - 1;
  while (i >= 0 && sibs[i].nodeType !== ELEMENT) i--;
  return i >= 0 ? sibs[i] : null;
}

/** 1-based position of el among its element siblings (optionally same tag, optionally from the end). */
function position(el, ofType, fromEnd) {
  const parent = el.parentNode;
  const sibs = (parent ? parent.childNodes : [el])
    .filter((n) => n.nodeType === ELEMENT && (!ofType || n.tagName === el.tagName));
  let idx = sibs.indexOf(el) + 1;
  if (fromEnd) idx = sibs.length - idx + 1;
  return idx;
}

function nthMatch(idx, a, b) {
  if (a === 0) return idx === b;
  const n = (idx - b) / a;
  return Number.isInteger(n) && n >= 0;
}

function classesOf(el) {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

const FORM_CONTROLS = new Set(['button', 'input', 'select', 'textarea', 'option', 'optgroup', 'fieldset']);

// ---------------------------------------------------------------- parsing

function err(p, msg) {
  return new SelectorError(`invalid selector "${p.s}" at ${p.i}: ${msg}`);
}

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

function skipWs(p) {
  const start = p.i;
  while (p.i < p.s.length && isWs(p.s[p.i])) p.i++;
  return p.i > start;
}

/** Comma-separated list of complex selectors. Stops (without consuming) at ')' or end. */
function parseList(p) {
  const list = [];
  for (;;) {
    list.push(parseComplex(p));
    skipWs(p);
    if (p.s[p.i] === ',') {
      p.i++;
      skipWs(p);
      continue;
    }
    return list;
  }
}

/** Returns [{compound, comb}], where comb is the combinator before that compound (null for the first). */
function parseComplex(p) {
  const parts = [];
  const first = parseCompound(p);
  if (!first) throw err(p, 'expected a selector');
  parts.push({ compound: first, comb: null });
  for (;;) {
    const ws = skipWs(p);
    const ch = p.s[p.i];
    if (ch === undefined || ch === ',' || ch === ')') break;
    let comb;
    if (ch === '>' || ch === '+' || ch === '~') {
      comb = ch;
      p.i++;
      skipWs(p);
    } else if (ws) {
      comb = ' ';
    } else {
      throw err(p, `unexpected "${ch}"`);
    }
    const compound = parseCompound(p);
    if (!compound) throw err(p, 'expected a selector after combinator');
    parts.push({ compound, comb });
  }
  return parts;
}

function parseCompound(p) {
  const s = p.s;
  let tag = null;
  const tests = [];
  let any = false;
  if (s[p.i] === '*') {
    p.i++;
    any = true;
  } else if (isIdentChar(s[p.i])) {
    tag = readIdent(p).toLowerCase();
    any = true;
  }
  for (;;) {
    const ch = s[p.i];
    if (ch === '#') {
      p.i++;
      const id = readIdent(p);
      tests.push((el) => el.getAttribute('id') === id);
    } else if (ch === '.') {
      p.i++;
      const cls = readIdent(p);
      tests.push((el) => classesOf(el).includes(cls));
    } else if (ch === '[') {
      tests.push(parseAttr(p));
    } else if (ch === ':') {
      tests.push(parsePseudo(p));
    } else {
      break;
    }
    any = true;
  }
  return any ? { tag, tests } : null;
}

function isIdentChar(c) {
  return c !== undefined && (/[\w-]/.test(c) || c.charCodeAt(0) > 127 || c === '\\');
}

function readIdent(p) {
  let out = '';
  while (p.i < p.s.length) {
    const c = p.s[p.i];
    if (c === '\\') {
      if (p.i + 1 >= p.s.length) throw err(p, 'dangling escape');
      out += p.s[p.i + 1];
      p.i += 2;
    } else if (/[\w-]/.test(c) || c.charCodeAt(0) > 127) {
      out += c;
      p.i++;
    } else {
      break;
    }
  }
  if (!out) throw err(p, 'expected an identifier');
  return out;
}

function readValue(p) {
  const q = p.s[p.i];
  if (q === '"' || q === "'") {
    p.i++;
    let out = '';
    while (p.i < p.s.length && p.s[p.i] !== q) {
      if (p.s[p.i] === '\\' && p.i + 1 < p.s.length) p.i++;
      out += p.s[p.i++];
    }
    if (p.s[p.i] !== q) throw err(p, 'unterminated string');
    p.i++;
    return out;
  }
  const start = p.i;
  while (p.i < p.s.length && !isWs(p.s[p.i]) && p.s[p.i] !== ']' && p.s[p.i] !== ')') p.i++;
  if (p.i === start) throw err(p, 'expected a value');
  return p.s.slice(start, p.i);
}

function parseAttr(p) {
  p.i++; // [
  skipWs(p);
  const name = readIdent(p).toLowerCase();
  skipWs(p);
  if (p.s[p.i] === ']') {
    p.i++;
    return (el) => el.hasAttribute(name);
  }
  const m = /^(~=|\|=|\^=|\$=|\*=|=)/.exec(p.s.slice(p.i));
  if (!m) throw err(p, 'bad attribute selector');
  const op = m[1];
  p.i += op.length;
  skipWs(p);
  const value = readValue(p);
  skipWs(p);
  let ci = false;
  if ((p.s[p.i] === 'i' || p.s[p.i] === 'I') && (isWs(p.s[p.i + 1]) || p.s[p.i + 1] === ']')) {
    ci = true;
    p.i++;
    skipWs(p);
  }
  if (p.s[p.i] !== ']') throw err(p, 'expected "]"');
  p.i++;
  return attrTest(name, op, value, ci);
}

function attrTest(name, op, value, ci) {
  const norm = ci ? (x) => x.toLowerCase() : (x) => x;
  const want = norm(value);
  return (el) => {
    const got = el.getAttribute(name);
    if (got === null) return false;
    const v = norm(got);
    switch (op) {
      case '=': return v === want;
      case '~=': return want !== '' && !/\s/.test(want) && v.split(/\s+/).includes(want);
      case '|=': return v === want || v.startsWith(`${want}-`);
      case '^=': return want !== '' && v.startsWith(want);
      case '$=': return want !== '' && v.endsWith(want);
      case '*=': return want !== '' && v.includes(want);
      default: return false;
    }
  };
}

function readUntilClose(p) {
  const end = p.s.indexOf(')', p.i);
  if (end === -1) throw err(p, 'expected ")"');
  const raw = p.s.slice(p.i, end);
  p.i = end + 1;
  return raw;
}

function parseNth(expr, p) {
  const e = expr.replace(/\s+/g, '').toLowerCase();
  if (e === 'odd') return { a: 2, b: 1 };
  if (e === 'even') return { a: 2, b: 0 };
  let m = /^([+-]?\d*)n([+-]\d+)?$/.exec(e);
  if (m) {
    const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
    return { a, b: m[2] ? Number(m[2]) : 0 };
  }
  m = /^[+-]?\d+$/.exec(e);
  if (m) return { a: 0, b: Number(e) };
  throw err(p, `bad nth expression "${expr}"`);
}

function parsePseudo(p) {
  p.i++; // :
  if (p.s[p.i] === ':') throw err(p, 'pseudo-elements are not supported');
  const name = readIdent(p).toLowerCase();

  if (p.s[p.i] === '(') {
    p.i++;
    skipWs(p);
    switch (name) {
      case 'not': {
        const list = parseList(p);
        skipWs(p);
        if (p.s[p.i] !== ')') throw err(p, 'expected ")"');
        p.i++;
        return (el) => !matchList(el, list);
      }
      case 'nth-child':
      case 'nth-last-child':
      case 'nth-of-type':
      case 'nth-last-of-type': {
        const { a, b } = parseNth(readUntilClose(p), p);
        const ofType = name.includes('of-type');
        const fromEnd = name.includes('last');
        return (el) => nthMatch(position(el, ofType, fromEnd), a, b);
      }
      case 'contains':
      case '-soup-contains': {
        skipWs(p);
        let arg;
        if (p.s[p.i] === '"' || p.s[p.i] === "'") arg = readValue(p);
        else arg = readUntilClose(p).trim();
        skipWs(p);
        if (p.s[p.i] !== ')') throw err(p, 'expected ")"');
        p.i++;
        return (el) => normalizeText(el.textContent).includes(arg);
      }
      default:
        throw err(p, `unsupported pseudo-class ":${name}()"`);
    }
  }

  switch (name) {
    case 'first-child': return (el) => position(el, false, false) === 1;
    case 'last-child': return (el) => position(el, false, true) === 1;
    case 'only-child': return (el) => position(el, false, false) === 1 && position(el, false, true) === 1;
    case 'first-of-type': return (el) => position(el, true, false) === 1;
    case 'last-of-type': return (el) => position(el, true, true) === 1;
    case 'only-of-type': return (el) => position(el, true, false) === 1 && position(el, true, true) === 1;
    case 'empty': return (el) => el.childNodes.every((n) => n.nodeType === COMMENT);
    case 'root': return (el) => el.parentNode?.nodeType === 9;
    case 'checked':
      return (el) => (el.tagName === 'input' && ['checkbox', 'radio'].includes((el.getAttribute('type') ?? '').toLowerCase()) && el.hasAttribute('checked'))
        || (el.tagName === 'option' && el.hasAttribute('selected'));
    case 'disabled': return (el) => FORM_CONTROLS.has(el.tagName) && el.hasAttribute('disabled');
    case 'enabled': return (el) => FORM_CONTROLS.has(el.tagName) && !el.hasAttribute('disabled');
    case 'link':
    case 'any-link': return (el) => (el.tagName === 'a' || el.tagName === 'area') && el.hasAttribute('href');
    // User-state pseudo-classes. The renderer has no pointer, keyboard focus or history state, so these never match:
    // a page's hover or focus rules simply do not apply, as they do not for a page that has not been touched.
    case 'hover':
    case 'active':
    case 'focus':
    case 'focus-visible':
    case 'focus-within':
    case 'visited':
    case 'target':
      return () => false;
    default:
      throw err(p, `unsupported pseudo-class ":${name}"`);
  }
}
