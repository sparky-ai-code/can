// Tolerant HTML tokenizer, tree builder and a minimal DOM. Built from scratch.
// Not the WHATWG algorithm: it covers the common cases (void elements, implied end tags,
// raw text, entities, implicit html/head/body) and recovers from broken markup without throwing.
import { querySelector, querySelectorAll, matches, normalizeText } from './selector.js';

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Content is raw text (no tags, no entities) for these.
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes']);
// Content is text with entities decoded but no tags.
const RCDATA = new Set(['title', 'textarea']);
const HEAD_TAGS = new Set(['base', 'basefont', 'bgsound', 'link', 'meta', 'noframes', 'script', 'style', 'template', 'title']);
// Start tags that close an open <p>.
const P_CLOSERS = new Set(['address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'header', 'hgroup', 'main', 'menu', 'nav', 'ol', 'p', 'search', 'section',
  'summary', 'ul', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'listing', 'form', 'plaintext', 'table', 'hr', 'xmp']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// Elements that stop the upward search for an open li / dd / dt.
const SPECIAL = new Set(['address', 'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound', 'blockquote', 'body', 'br',
  'button', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dir', 'div', 'dl', 'dt', 'embed', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html',
  'iframe', 'img', 'input', 'keygen', 'li', 'link', 'listing', 'main', 'marquee', 'menu', 'meta', 'nav', 'noembed', 'noframes',
  'noscript', 'object', 'ol', 'p', 'param', 'plaintext', 'pre', 'script', 'search', 'section', 'select', 'source', 'style',
  'summary', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul', 'wbr', 'xmp']);
const BUTTON_SCOPE = new Set(['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template', 'button']);
const TABLE_BOUNDARY = new Set(['table', 'tbody', 'thead', 'tfoot', 'template', 'html']);
const A_BOUNDARY = new Set(['applet', 'marquee', 'object', 'table', 'td', 'th', 'caption', 'template', 'html', 'button']);

const LEGACY_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg']);
const ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“',
  rdquo: '”', bull: '•', middot: '·', times: '×', divide: '÷', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', para: '¶', deg: '°', plusmn: '±', frac12: '½',
  frac14: '¼', frac34: '¾', laquo: '«', raquo: '»', iexcl: '¡', iquest: '¿', micro: 'µ',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔', hearts: '♥', emsp: ' ',
  ensp: ' ', thinsp: ' ', shy: '­', check: '✓', cross: '✗',
}));

/** Decodes named (`&amp;`), decimal (`&#38;`) and hex (`&#x26;`) character references. */
export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*)(;?)/g, (whole, name, semi) => {
    if (name[0] === '#') {
      const hex = name[1] === 'x' || name[1] === 'X';
      const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    const value = ENTITIES.get(name);
    if (value === undefined) return whole;
    if (!semi && !LEGACY_ENTITIES.has(name)) return whole;
    return value;
  });
}

// ---------------------------------------------------------------- DOM

export class Node {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
  }

  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() { return this._sibling(1); }
  get previousSibling() { return this._sibling(-1); }
  get parentElement() { return this.parentNode?.nodeType === ELEMENT_NODE ? this.parentNode : null; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.nodeType === DOCUMENT_NODE;
  }

  _sibling(step) {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) return null;
    const i = siblings.indexOf(this) + step;
    return siblings[i] ?? null;
  }

  appendChild(child) {
    return this.insertBefore(child, null);
  }

  insertBefore(child, ref) {
    if (!(child instanceof Node)) throw new TypeError('argument is not a Node');
    for (let n = this; n; n = n.parentNode) {
      if (n === child) throw new Error('HierarchyRequestError: cannot insert a node into itself');
    }
    if (ref !== null && ref !== undefined && ref.parentNode !== this) {
      throw new Error('NotFoundError: reference node is not a child of this node');
    }
    child.parentNode?.removeChild(child);
    if (ref === null || ref === undefined) {
      this.childNodes.push(child);
    } else {
      this.childNodes.splice(this.childNodes.indexOf(ref), 0, child);
    }
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('NotFoundError: node is not a child of this node');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  /** Concatenated text of all descendant Text nodes (comments excluded). */
  get textContent() {
    let out = '';
    const walk = (n) => {
      if (n.nodeType === TEXT_NODE) { out += n.data; return; }
      if (n.nodeType === COMMENT_NODE) return;
      for (const c of n.childNodes) walk(c);
    };
    walk(this);
    return out;
  }

  set textContent(value) {
    this._replaceChildren(value === '' || value === null || value === undefined ? [] : [new Text(String(value))]);
  }

  _replaceChildren(nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    for (const n of nodes) this.appendChild(n);
  }

  querySelector(selector) { return querySelector(this, selector); }
  querySelectorAll(selector) { return querySelectorAll(this, selector); }
}

export class Text extends Node {
  constructor(data = '') {
    super();
    this.nodeType = TEXT_NODE;
    this.data = String(data);
  }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

export class Comment extends Node {
  constructor(data = '') {
    super();
    this.nodeType = COMMENT_NODE;
    this.data = String(data);
  }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

export class Element extends Node {
  constructor(tagName, attrs = []) {
    super();
    this.nodeType = ELEMENT_NODE;
    this.tagName = String(tagName).toLowerCase();
    this.attributes = new Map(attrs);
  }

  get nodeName() { return this.tagName.toUpperCase(); }
  get children() { return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE); }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] ?? null; }

  getAttribute(name) {
    const v = this.attributes.get(String(name).toLowerCase());
    return v === undefined ? null : v;
  }
  setAttribute(name, value) { this.attributes.set(String(name).toLowerCase(), String(value)); }
  hasAttribute(name) { return this.attributes.has(String(name).toLowerCase()); }
  removeAttribute(name) { this.attributes.delete(String(name).toLowerCase()); }

  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get classes() { return this.className.split(/\s+/).filter(Boolean); }

  matches(selector) { return matches(this, selector); }
  closest(selector) {
    for (let n = this; n && n.nodeType === ELEMENT_NODE; n = n.parentNode) {
      if (matches(n, selector)) return n;
    }
    return null;
  }

  get innerHTML() {
    return this.childNodes.map(serializeNode).join('');
  }
  set innerHTML(html) {
    const frag = parseHTML(String(html), { fragment: true });
    this._replaceChildren([...frag.childNodes]);
  }
  get outerHTML() { return serializeNode(this); }

  /** Form control value: input/textarea/select/option semantics; other elements use their value attribute. */
  get value() {
    switch (this.tagName) {
      case 'textarea': return this.textContent;
      case 'select': {
        const opts = this.querySelectorAll('option');
        const sel = opts.find((o) => o.hasAttribute('selected')) ?? opts[0];
        return sel ? sel.value : '';
      }
      case 'option': return this.getAttribute('value') ?? normalizeText(this.textContent);
      case 'input':
        if (this.getAttribute('type') && ['checkbox', 'radio'].includes(this.getAttribute('type').toLowerCase())) {
          return this.getAttribute('value') ?? 'on';
        }
        return this.getAttribute('value') ?? '';
      default: return this.getAttribute('value') ?? '';
    }
  }
  set value(v) {
    const s = String(v);
    switch (this.tagName) {
      case 'textarea': this.textContent = s; break;
      case 'select':
        for (const o of this.querySelectorAll('option')) {
          if (o.value === s) o.setAttribute('selected', ''); else o.removeAttribute('selected');
        }
        break;
      default: this.setAttribute('value', s);
    }
  }
}

export class Document extends Node {
  constructor() {
    super();
    this.nodeType = DOCUMENT_NODE;
  }

  get documentElement() { return this.childNodes.find((n) => n.nodeType === ELEMENT_NODE && n.tagName === 'html') ?? null; }
  get head() { return this.querySelector('head'); }
  get body() { return this.querySelector('body'); }
  get title() {
    const t = this.querySelector('title');
    return t ? normalizeText(t.textContent) : '';
  }
  set title(v) {
    let t = this.querySelector('title');
    if (!t) {
      t = this.createElement('title');
      (this.head ?? this.documentElement ?? this).appendChild(t);
    }
    t.textContent = String(v);
  }
  get innerHTML() { return this.childNodes.map(serializeNode).join(''); }

  getElementById(id) {
    const want = String(id);
    for (const el of querySelectorAll(this, '[id]')) if (el.getAttribute('id') === want) return el;
    return null;
  }
  createElement(tagName) { return new Element(tagName); }
  createTextNode(data) { return new Text(data); }
  createComment(data) { return new Comment(data); }
}

// ---------------------------------------------------------------- serialization

const RAW_OUTPUT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
}
function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
}

export function serializeNode(node) {
  switch (node.nodeType) {
    case TEXT_NODE:
      return node.parentNode?.nodeType === ELEMENT_NODE && RAW_OUTPUT.has(node.parentNode.tagName)
        ? node.data : escapeText(node.data);
    case COMMENT_NODE: return `<!--${node.data}-->`;
    case ELEMENT_NODE: {
      let out = `<${node.tagName}`;
      for (const [k, v] of node.attributes) out += ` ${k}="${escapeAttr(v)}"`;
      out += '>';
      if (VOID.has(node.tagName)) return out;
      for (const c of node.childNodes) out += serializeNode(c);
      return `${out}</${node.tagName}>`;
    }
    case DOCUMENT_NODE: return node.childNodes.map(serializeNode).join('');
    default: return '';
  }
}

// ---------------------------------------------------------------- parser

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isAlpha = (c) => c !== undefined && /[A-Za-z]/.test(c);

/**
 * Parses HTML into a Document. With {fragment: true} no html/head/body structure is
 * synthesized, which is what innerHTML needs.
 */
export function parseHTML(source, { fragment = false } = {}) {
  return new Parser(String(source ?? ''), fragment).run();
}

class Parser {
  constructor(src, fragment) {
    this.src = src;
    this.pos = 0;
    this.fragment = fragment;
    this.doc = new Document();
    this.stack = [];
    this.html = null;
    this.head = null;
    this.body = null;
    if (!fragment) {
      this.html = new Element('html');
      this.doc.appendChild(this.html);
      this.stack.push(this.html);
    }
  }

  run() {
    const s = this.src;
    const n = s.length;
    while (this.pos < n) {
      const lt = s.indexOf('<', this.pos);
      if (lt === -1) {
        this.text(s.slice(this.pos));
        this.pos = n;
        break;
      }
      if (lt > this.pos) this.text(s.slice(this.pos, lt));
      this.pos = lt;
      const c = s[lt + 1];
      if (s.startsWith('<!--', lt)) {
        this.comment(lt);
      } else if (c === '!' || c === '?') {
        this.skipPast('>', lt + 1); // doctype, CDATA and processing instructions are dropped
      } else if (c === '/' && isAlpha(s[lt + 2])) {
        this.endTag(lt);
      } else if (c === '/') {
        this.skipPast('>', lt + 2);
      } else if (isAlpha(c)) {
        this.startTag(lt);
      } else {
        this.text('<');
        this.pos = lt + 1;
      }
    }
    this.finish();
    return this.doc;
  }

  skipPast(token, from) {
    const i = this.src.indexOf(token, from);
    this.pos = i === -1 ? this.src.length : i + token.length;
  }

  comment(lt) {
    const end = this.src.indexOf('-->', lt + 4);
    const data = end === -1 ? this.src.slice(lt + 4) : this.src.slice(lt + 4, end);
    this.pos = end === -1 ? this.src.length : end + 3;
    this.current().appendChild(new Comment(data));
  }

  current() {
    return this.stack.length ? this.stack[this.stack.length - 1] : this.doc;
  }

  text(raw) {
    if (raw === '') return;
    if (!this.fragment && !this.body && /^[ \t\n\r\f]*$/.test(raw)) return; // whitespace before <body> is dropped
    if (!this.fragment && !this.body) this.ensureBody();
    this.insertText(decodeEntities(raw));
  }

  insertText(data) {
    const parent = this.current();
    const last = parent.lastChild;
    if (last && last.nodeType === TEXT_NODE) last.data += data;
    else parent.appendChild(new Text(data));
  }

  startTag(lt) {
    const s = this.src;
    let i = lt + 1;
    while (i < s.length && !isWs(s[i]) && s[i] !== '/' && s[i] !== '>') i++;
    const name = s.slice(lt + 1, i).toLowerCase();
    const { attrs, selfClosing, end } = this.readAttributes(i);
    if (end === -1) { this.pos = s.length; return; } // unterminated tag is dropped
    this.pos = end;

    if (!this.fragment) {
      if (name === 'html') { mergeAttrs(this.html, attrs); return; }
      if (name === 'head') {
        if (!this.head && !this.body) this.ensureHead();
        return;
      }
      if (name === 'body') {
        if (this.body) { mergeAttrs(this.body, attrs); return; }
        this.createBody(attrs);
        return;
      }
      if (!this.body && HEAD_TAGS.has(name)) {
        const el = new Element(name, attrs);
        this.ensureHead().appendChild(el);
        this.openElement(el, name, selfClosing);
        return;
      }
      if (!this.body) this.ensureBody();
    }

    this.closeImplied(name);
    const el = new Element(name, attrs);
    this.current().appendChild(el);
    this.openElement(el, name, selfClosing);
  }

  openElement(el, name, selfClosing) {
    if (VOID.has(name) || selfClosing) return;
    this.stack.push(el);
    if (RAW_TEXT.has(name) || RCDATA.has(name)) {
      const re = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
      re.lastIndex = this.pos;
      const m = re.exec(this.src);
      const end = m ? m.index : this.src.length;
      const raw = this.src.slice(this.pos, end);
      if (raw) this.insertText(RCDATA.has(name) ? decodeEntities(raw) : raw);
      this.pos = end;
    }
  }

  /** Reads attributes starting at index i. Returns the attribute pairs and the index after '>'. */
  readAttributes(i) {
    const s = this.src;
    const attrs = [];
    const seen = new Set();
    let selfClosing = false;
    for (;;) {
      while (i < s.length && (isWs(s[i]) || s[i] === '/')) {
        if (s[i] === '/' && s[i + 1] === '>') break;
        i++;
      }
      if (i >= s.length) return { attrs, selfClosing, end: -1 };
      if (s[i] === '>') return { attrs, selfClosing, end: i + 1 };
      if (s[i] === '/' && s[i + 1] === '>') { selfClosing = true; return { attrs, selfClosing, end: i + 2 }; }

      const nameStart = i;
      i++; // a leading '=' is part of the name, as in the spec
      while (i < s.length && !isWs(s[i]) && s[i] !== '/' && s[i] !== '>' && s[i] !== '=') i++;
      const name = s.slice(nameStart, i).toLowerCase();
      let j = i;
      while (j < s.length && isWs(s[j])) j++;
      let value = '';
      if (s[j] === '=') {
        j++;
        while (j < s.length && isWs(s[j])) j++;
        const q = s[j];
        if (q === '"' || q === "'") {
          const close = s.indexOf(q, j + 1);
          const stop = close === -1 ? s.length : close;
          value = s.slice(j + 1, stop);
          i = close === -1 ? s.length : close + 1;
        } else {
          const vs = j;
          while (j < s.length && !isWs(s[j]) && s[j] !== '>') j++;
          value = s.slice(vs, j);
          i = j;
        }
        value = decodeEntities(value);
      }
      if (!seen.has(name)) { // first duplicate attribute wins
        seen.add(name);
        attrs.push([name, value]);
      }
    }
  }

  endTag(lt) {
    const s = this.src;
    let i = lt + 2;
    while (i < s.length && !isWs(s[i]) && s[i] !== '/' && s[i] !== '>') i++;
    const name = s.slice(lt + 2, i).toLowerCase();
    const gt = s.indexOf('>', i);
    this.pos = gt === -1 ? s.length : gt + 1;

    if (!this.fragment) {
      if (name === 'html' || name === 'body') return;
      if (name === 'head') { this.popTo(this.head); return; }
    }
    if (VOID.has(name)) return;
    for (let k = this.stack.length - 1; k >= 0; k--) {
      if (this.stack[k].tagName === name) {
        this.stack.length = k;
        return;
      }
    }
    // no matching open element: ignored
  }

  finish() {
    if (this.fragment) return;
    if (!this.body) this.ensureBody();
    if (!this.head) {
      this.head = new Element('head');
      this.html.insertBefore(this.head, this.html.firstChild);
    }
  }

  ensureHead() {
    if (!this.head) {
      this.head = new Element('head');
      this.html.appendChild(this.head);
    }
    return this.head;
  }

  createBody(attrs = []) {
    this.body = new Element('body', attrs);
    this.stack.length = this.stack.indexOf(this.html) + 1;
    this.html.appendChild(this.body);
    this.stack.push(this.body);
  }

  ensureBody() {
    if (this.fragment || this.body) return;
    this.createBody();
  }

  popTo(el) {
    const i = this.stack.indexOf(el);
    if (i >= 0) this.stack.length = i;
  }

  /** Pops up to and including the nearest open element named in `names`, unless a boundary comes first. */
  popToOpen(names, boundaries) {
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const t = this.stack[k].tagName;
      if (names.has(t)) { this.stack.length = k; return true; }
      if (boundaries.has(t)) return false;
    }
    return false;
  }

  /** Start-tag rules that implicitly close earlier open elements. */
  closeImplied(name) {
    const top = () => this.stack[this.stack.length - 1]?.tagName;
    if (name === 'li' || name === 'dd' || name === 'dt') {
      const targets = name === 'li' ? new Set(['li']) : new Set(['dd', 'dt']);
      for (let k = this.stack.length - 1; k >= 0; k--) {
        const t = this.stack[k].tagName;
        if (targets.has(t)) { this.stack.length = k; break; }
        if (SPECIAL.has(t) && !['address', 'div', 'p'].includes(t)) break;
      }
    } else if (name === 'option') {
      if (top() === 'option') this.stack.pop();
    } else if (name === 'optgroup') {
      if (top() === 'option') this.stack.pop();
      if (top() === 'optgroup') this.stack.pop();
    } else if (name === 'td' || name === 'th') {
      this.popToOpen(new Set(['td', 'th']), new Set(['table', 'template', 'html']));
    } else if (name === 'tr') {
      this.popToOpen(new Set(['tr']), TABLE_BOUNDARY);
    } else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
      this.popToOpen(new Set(['thead', 'tbody', 'tfoot']), new Set(['table', 'template', 'html']));
    } else if (name === 'a') {
      this.popToOpen(new Set(['a']), A_BOUNDARY);
    } else if (name === 'button') {
      this.popToOpen(new Set(['button']), BUTTON_SCOPE);
    }
    if (P_CLOSERS.has(name)) this.popToOpen(new Set(['p']), BUTTON_SCOPE);
    if (HEADINGS.has(name) && HEADINGS.has(top())) this.stack.pop();
  }
}

function mergeAttrs(el, attrs) {
  for (const [k, v] of attrs) if (!el.hasAttribute(k)) el.setAttribute(k, v);
}
