// Inline <script> execution. Each page gets a fresh node:vm context with a small DOM bridge:
// `document`, `window`, `location`, `console`, timers, `fetch`, storage and DOM events.
// Page code sees the bridge only through the layer-2 membrane (src/vm/membrane.js). node:vm is not a
// security boundary by itself: the real boundary is the can VM process around this code.
// Scripts that loop forever are cut off by the per-run timeout.
import vm from 'node:vm';
import { parseHTML } from './html.js';
import { normalizeText, querySelector, querySelectorAll, matches } from './selector.js';
import { Membrane, hardening } from '../vm/membrane.js';
import { installStackFilter } from '../vm/stacks.js';
import { installWebApis, rectObject, DOM_TAGS, domClassName, canvasContext } from './webapis.js';
import { layoutPage } from './render.js';

const NODE = Symbol('node');
const HOST = Symbol('host');
const ELEMENT = 1;
const DOCUMENT = 9;

/** Event object handed to listeners. Browser-initiated events use this too. */
export class DomEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;
    this.timeStamp = Date.now();
    this._stop = false;
    this._stopNow = false;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; this._stopNow = true; }
}

export class CustomEvent extends DomEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.detail = init.detail ?? null;
  }
}

/** Headers, as the page sees it: names are case-insensitive and repeated values are joined by ", ". */
export class PageHeaders {
  constructor(init) {
    this._m = new Map();
    if (init && typeof init.forEach === 'function' && typeof init.get === 'function') {
      init.forEach((v, k) => this.append(k, v));
    } else if (Array.isArray(init)) {
      for (const [k, v] of init) this.append(k, v);
    } else if (init && typeof init === 'object') {
      for (const [k, v] of Object.entries(init)) this.append(k, v);
    }
  }
  get(name) {
    const v = this._m.get(String(name).toLowerCase());
    return v === undefined ? null : v.join(', ');
  }
  set(name, value) { this._m.set(String(name).toLowerCase(), [String(value)]); }
  append(name, value) {
    const k = String(name).toLowerCase();
    this._m.set(k, [...(this._m.get(k) ?? []), String(value)]);
  }
  has(name) { return this._m.has(String(name).toLowerCase()); }
  delete(name) { this._m.delete(String(name).toLowerCase()); }
  forEach(cb, thisArg) { for (const [k, v] of this._m) cb.call(thisArg, v.join(', '), k, this); }
  *entries() { for (const [k, v] of this._m) yield [k, v.join(', ')]; }
  *keys() { yield* this._m.keys(); }
  *values() { for (const v of this._m.values()) yield v.join(', '); }
  [Symbol.iterator]() { return this.entries(); }
}

/** Header object (plain, PageHeaders or anything with forEach) as a lower-case plain object. */
export function headersToObject(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && typeof h.get === 'function') {
    h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = String(v);
  return out;
}

/** A fetch() Response-like object built from an already-received response. */
export function makeResponse({ url, status, headers, body }) {
  const text = () => body.toString('utf8');
  const h = new PageHeaders();
  for (const [k, v] of Object.entries(headers)) h.append(k, [].concat(v).join(', '));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    url,
    headers: h,
    text: async () => text(),
    json: async () => JSON.parse(text()),
    arrayBuffer: async () => new Uint8Array(body).buffer,
  };
}

/**
 * XMLHttpRequest for page scripts. Asynchronous only (open's third argument is ignored). The request goes through
 * the browser's fetch path, so cookies, redirects and the can's virtual network behave as they do for fetch().
 */
function makeXHR(host) {
  const b = host.browser;
  return class XMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.responseText = '';
      this.response = '';
      this.responseURL = '';
      this.responseType = '';
      this.timeout = 0;
      this.withCredentials = false;
      this.onreadystatechange = null;
      this.onload = null;
      this.onerror = null;
      this.onloadend = null;
      this.onabort = null;
      this._method = 'GET';
      this._url = '';
      this._reqHeaders = {};
      this._resHeaders = {};
      this._listeners = new Map();
      this._seq = 0;
    }
    open(method, url) {
      this._method = String(method).toUpperCase();
      this._url = String(url);
      this._reqHeaders = {};
      this._setState(1);
    }
    setRequestHeader(name, value) {
      if (this.readyState !== 1) throw new Error('InvalidStateError: open() must be called first');
      this._reqHeaders[String(name).toLowerCase()] = String(value);
    }
    getResponseHeader(name) {
      const v = this._resHeaders[String(name).toLowerCase()];
      return v === undefined ? null : v;
    }
    getAllResponseHeaders() {
      return Object.entries(this._resHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    }
    overrideMimeType() {}
    abort() {
      this._seq++;
      if (this.readyState === 0) return;
      this.readyState = 0;
      this._fire('abort');
      this._fire('loadend');
    }
    send(body = null) {
      if (this.readyState !== 1) throw new Error('InvalidStateError: open() must be called first');
      const seq = ++this._seq;
      b._fetchRaw(this._url, { method: this._method, headers: this._reqHeaders, body })
        .then((res) => {
          if (seq !== this._seq) return;
          this.status = res.status;
          this.responseURL = res.url;
          this._resHeaders = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, [].concat(v).join(', ')]));
          const text = res.body.toString('utf8');
          this.responseText = text;
          if (this.responseType === 'json') {
            try { this.response = JSON.parse(text); } catch { this.response = null; }
          } else {
            this.response = text;
          }
          this._setState(2);
          this._setState(3);
          this._setState(4);
          this._fire('load');
          this._fire('loadend');
        }, () => {
          if (seq !== this._seq) return;
          this.status = 0;
          this._setState(4);
          this._fire('error');
          this._fire('loadend');
        });
    }
    addEventListener(type, fn) {
      const t = String(type);
      if (!this._listeners.has(t)) this._listeners.set(t, []);
      this._listeners.get(t).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this._listeners.get(String(type));
      const i = list ? list.indexOf(fn) : -1;
      if (i >= 0) list.splice(i, 1);
    }
    _setState(state) {
      this.readyState = state;
      this._fire('readystatechange');
    }
    _fire(type) {
      const ev = new DomEvent(type);
      ev.target = this;
      const handlers = [this[`on${type}`], ...(this._listeners.get(type) ?? [])];
      for (const fn of handlers) {
        if (typeof fn !== 'function') continue;
        try { fn.call(this, ev); } catch (e) { host._error(e); }
      }
    }
  };
}

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object' && 'message' in a && 'name' in a) return `${a.name}: ${a.message}`;
  try {
    const j = JSON.stringify(a);
    return j === undefined ? String(a) : j;
  } catch {
    return String(a);
  }
}

function describeError(e) {
  if (e && typeof e === 'object' && 'message' in e) return `${e.name ?? 'Error'}: ${e.message}`;
  return String(e);
}

function unwrap(w) {
  if (w && typeof w === 'object' && w[NODE]) return w[NODE];
  throw new TypeError('argument is not a Node');
}

/**
 * The prototype chain of node wrappers, one prototype per DOM class: Node > Element > HTMLElement > HTMLInputElement
 * and so on, with Node's methods (NodeWrapper.prototype) at the root. A wrapper's prototype is set to the one for its
 * node, so instanceof answers the way a browser does.
 */
function makeProtos(root) {
  const protos = new Map();
  const make = (name, parent) => { const p = Object.create(parent); protos.set(name, p); return p; };
  const node = make('Node', root);
  const element = make('Element', node);
  const htmlElement = make('HTMLElement', element);
  make('Text', node);
  make('Comment', node);
  make('Document', node);
  make('DocumentFragment', node);
  for (const tag of DOM_TAGS) make(domClassName(tag), htmlElement);
  return protos;
}

/** Whether node is ancestor itself or lies somewhere under it. */
function isWithin(node, ancestor) {
  for (let n = node; n; n = n.parentNode) if (n === ancestor) return true;
  return false;
}

/** Puts a node (or a fragment's children) into parent before ref, then runs any scripts it brings in. */
function placeNode(host, parent, n, ref = null) {
  if (n.isFragment) {
    for (const c of [...n.childNodes]) {
      parent.insertBefore(c, ref);
      host.inserted(c);
    }
    return;
  }
  parent.insertBefore(n, ref);
  host.inserted(n);
}

/** A deep copy of a node in the same document. */
function cloneNode(doc, node, deep) {
  if (node.nodeType === 3) return doc.createTextNode(node.data);
  if (node.nodeType === 8) return doc.createComment(node.data);
  const copy = doc.createElement(node.tagName);
  for (const [k, v] of node.attributes) copy.setAttribute(k, v);
  if (deep) for (const c of node.childNodes) copy.appendChild(cloneNode(doc, c, true));
  return copy;
}

function styleProxy(node, host = null) {
  const read = () => {
    const map = new Map();
    for (const decl of (node.getAttribute('style') ?? '').split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) map.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim());
    }
    return map;
  };
  const write = (map) => {
    const text = [...map].map(([k, v]) => `${k}: ${v}`).join('; ');
    if (text) node.setAttribute('style', text); else node.removeAttribute('style');
    host?.attrChanged(node, 'style');
  };
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'cssText') return node.getAttribute('style') ?? '';
      if (prop === 'setProperty') return (k, v) => { const m = read(); m.set(String(k).toLowerCase(), String(v)); write(m); };
      if (prop === 'getPropertyValue') return (k) => read().get(String(k).toLowerCase()) ?? '';
      if (prop === 'removeProperty') return (k) => { const m = read(); m.delete(String(k).toLowerCase()); write(m); };
      return read().get(kebab(prop)) ?? '';
    },
    set(_, prop, value) {
      if (prop === 'cssText') { node.setAttribute('style', String(value)); host?.attrChanged(node, 'style'); return true; }
      const m = read();
      if (value === '' || value === null || value === undefined) m.delete(kebab(prop)); else m.set(kebab(prop), String(value));
      write(m);
      return true;
    },
  });
}

function datasetProxy(node) {
  const key = (p) => `data-${kebab(p)}`;
  return new Proxy({}, {
    get: (_, p) => (typeof p === 'string' ? node.getAttribute(key(p)) ?? undefined : undefined),
    set: (_, p, v) => { node.setAttribute(key(p), String(v)); return true; },
    has: (_, p) => typeof p === 'string' && node.hasAttribute(key(p)),
    deleteProperty: (_, p) => { if (typeof p === 'string') node.removeAttribute(key(p)); return true; },
  });
}

/** Creates the JS-facing wrapper class for one ScriptHost (it closes over the host). */
function makeWrapperClass() {
  return class NodeWrapper {
    constructor(host, node) {
      Object.defineProperties(this, {
        [HOST]: { value: host },
        [NODE]: { value: node },
      });
    }

    get nodeType() { return this[NODE].nodeType; }
    get nodeName() {
      const n = this[NODE];
      if (n.nodeType === ELEMENT) return n.tagName.toUpperCase();
      if (n.nodeType === DOCUMENT) return '#document';
      return n.nodeType === 3 ? '#text' : '#comment';
    }
    get tagName() { return this[NODE].nodeType === ELEMENT ? this[NODE].tagName.toUpperCase() : undefined; }
    get id() { return this[NODE].getAttribute?.('id') ?? ''; }
    set id(v) { this[NODE].setAttribute('id', v); }
    get className() { return this[NODE].getAttribute?.('class') ?? ''; }
    set className(v) { this[NODE].setAttribute('class', v); }
    get name() { return this[NODE].getAttribute?.('name') ?? ''; }
    set name(v) { this[NODE].setAttribute('name', v); }
    get type() { return this[NODE].getAttribute?.('type') ?? ''; }
    set type(v) { this[NODE].setAttribute('type', v); }
    get value() { return this[NODE].nodeType === ELEMENT ? this[NODE].value : undefined; }
    set value(v) { if (this[NODE].nodeType === ELEMENT) this[NODE].value = v; }
    get checked() { return this[NODE].hasAttribute?.('checked') ?? false; }
    set checked(v) { if (v) this[NODE].setAttribute('checked', ''); else this[NODE].removeAttribute('checked'); }
    get disabled() { return this[NODE].hasAttribute?.('disabled') ?? false; }
    set disabled(v) { if (v) this[NODE].setAttribute('disabled', ''); else this[NODE].removeAttribute('disabled'); }
    get selected() { return this[NODE].hasAttribute?.('selected') ?? false; }
    set selected(v) { if (v) this[NODE].setAttribute('selected', ''); else this[NODE].removeAttribute('selected'); }
    get href() { return this[HOST].absoluteUrl(this[NODE].getAttribute?.('href')); }
    set href(v) { this[NODE].setAttribute('href', v); }
    get src() { return this[HOST].absoluteUrl(this[NODE].getAttribute?.('src')); }
    set src(v) { this[NODE].setAttribute('src', v); }
    get action() { return this[HOST].absoluteUrl(this[NODE].getAttribute?.('action')); }
    set action(v) { this[NODE].setAttribute('action', v); }

    get textContent() { return this[NODE].textContent; }
    set textContent(v) { this[NODE].textContent = String(v); this[HOST].childChanged(this[NODE]); }
    get innerHTML() { return this[NODE].innerHTML; }
    set innerHTML(v) { this[NODE].innerHTML = String(v); this[HOST].childChanged(this[NODE]); }
    get outerHTML() { return this[NODE].outerHTML ?? this[NODE].innerHTML; }

    get parentNode() { return this[HOST].wrap(this[NODE].parentNode); }
    get parentElement() { return this[HOST].wrap(this[NODE].parentElement); }
    get childNodes() { return this[NODE].childNodes.map((c) => this[HOST].wrap(c)); }
    get children() { return this[NODE].children?.map((c) => this[HOST].wrap(c)) ?? []; }
    get firstChild() { return this[HOST].wrap(this[NODE].firstChild); }
    get lastChild() { return this[HOST].wrap(this[NODE].lastChild); }
    get firstElementChild() { return this[HOST].wrap(this[NODE].children?.[0] ?? null); }
    get lastElementChild() { const c = this[NODE].children ?? []; return this[HOST].wrap(c[c.length - 1] ?? null); }
    get nextSibling() { return this[HOST].wrap(this[NODE].nextSibling); }
    get previousSibling() { return this[HOST].wrap(this[NODE].previousSibling); }
    get nextElementSibling() { return this[HOST].wrap(siblingEl(this[NODE], 1)); }
    get previousElementSibling() { return this[HOST].wrap(siblingEl(this[NODE], -1)); }
    get isConnected() { return this[NODE].isConnected; }

    get classList() {
      const node = this[NODE];
      const list = () => (node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
      const write = (l) => { node.setAttribute('class', l.join(' ')); this[HOST].attrChanged(node, 'class'); };
      return {
        add: (...c) => { const l = list(); for (const x of c) if (!l.includes(x)) l.push(x); write(l); },
        remove: (...c) => write(list().filter((x) => !c.includes(x))),
        toggle: (c) => { const l = list(); if (l.includes(c)) write(l.filter((x) => x !== c)); else { l.push(c); write(l); } return l.includes(c); },
        contains: (c) => list().includes(c),
        get length() { return list().length; },
      };
    }
    get dataset() { return datasetProxy(this[NODE]); }
    get style() { return styleProxy(this[NODE], this[HOST]); }

    // Document-only accessors
    get documentElement() { return this[HOST].wrap(this[NODE].documentElement ?? null); }
    get head() { return this[HOST].wrap(this[NODE].head ?? null); }
    get body() { return this[HOST].wrap(this[NODE].body ?? null); }
    get title() { return this[NODE].title ?? ''; }
    set title(v) { if (this[NODE].nodeType === DOCUMENT) this[NODE].title = v; }
    get cookie() { return this[HOST].browser.cookies.headerFor(this[HOST].browser._currentUrl(), { fromDocument: true }); }
    set cookie(v) { this[HOST].browser.cookies.setFromDocument(this[HOST].browser._currentUrl(), String(v)); }
    get readyState() { return 'complete'; }
    get URL() { return this[HOST].browser.url ?? 'about:blank'; }

    getAttribute(n) { return this[NODE].getAttribute(n); }
    setAttribute(n, v) {
      this[NODE].setAttribute(n, v);
      this[HOST].attrChanged(this[NODE], String(n).toLowerCase());
    }
    removeAttribute(n) {
      this[NODE].removeAttribute(n);
      this[HOST].attrChanged(this[NODE], String(n).toLowerCase());
    }
    hasAttribute(n) { return this[NODE].hasAttribute(n); }
    getAttributeNames() { return [...this[NODE].attributes.keys()]; }
    hasAttributes() { return this[NODE].attributes.size > 0; }
    get attributes() { return [...this[NODE].attributes].map(([name, value]) => ({ name, value, nodeName: name })); }
    toggleAttribute(name, force) {
      const has = this[NODE].hasAttribute(name);
      const want = force === undefined ? !has : Boolean(force);
      if (want && !has) this.setAttribute(name, '');
      if (!want && has) this.removeAttribute(name);
      return want;
    }
    get hidden() { return this[NODE].hasAttribute?.('hidden') ?? false; }
    set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get tabIndex() { return Number(this[NODE].getAttribute?.('tabindex') ?? -1); }
    set tabIndex(v) { this.setAttribute('tabindex', String(v)); }
    get nodeValue() { return this[NODE].nodeType === 3 || this[NODE].nodeType === 8 ? this[NODE].data : null; }
    set nodeValue(v) { if (this[NODE].nodeType === 3 || this[NODE].nodeType === 8) { this[NODE].data = String(v); this[HOST].childChanged(this[NODE].parentNode); } }
    get innerText() { return this[NODE].textContent; }
    set innerText(v) { this.textContent = v; }
    get ownerDocument() { return this[HOST].wrap(this[HOST].doc); }

    // Layout queries. They read the layout the renderer draws (layoutPage), so a page can size itself.
    get offsetWidth() { return this[HOST].boxOf(this[NODE]).width; }
    get offsetHeight() { return this[HOST].boxOf(this[NODE]).height; }
    get offsetTop() { return this[HOST].boxOf(this[NODE]).y; }
    get offsetLeft() { return this[HOST].boxOf(this[NODE]).x; }
    get offsetParent() { const p = this[NODE].parentNode; return this[HOST].wrap(p && p.nodeType === 1 ? p : null); }
    get clientWidth() { return this.offsetWidth; }
    get clientHeight() { return this.offsetHeight; }
    get clientTop() { return 0; }
    get clientLeft() { return 0; }
    get scrollWidth() { return this.offsetWidth; }
    get scrollHeight() { return this.offsetHeight; }
    get scrollTop() { return 0; }
    set scrollTop(_) {}
    get scrollLeft() { return 0; }
    set scrollLeft(_) {}
    getBoundingClientRect() { return rectObject(this[HOST].boxOf(this[NODE])); }

    // Canvas and media elements. A canvas context accepts drawing; media does not play, but its methods resolve.
    getContext(kind) { return canvasContext(this[NODE], String(kind)); }
    toDataURL() { return 'data:image/png;base64,iVBORw0KGgo='; }
    toBlob(callback) { if (typeof callback === 'function') callback(null); }
    get width() {
      const n = this[NODE];
      const attr = Number.parseInt(n.getAttribute?.('width') ?? '', 10);
      if (Number.isFinite(attr)) return attr;
      return n.tagName === 'canvas' ? 300 : 0;
    }
    set width(v) { this.setAttribute('width', String(v)); }
    get height() {
      const n = this[NODE];
      const attr = Number.parseInt(n.getAttribute?.('height') ?? '', 10);
      if (Number.isFinite(attr)) return attr;
      return n.tagName === 'canvas' ? 150 : 0;
    }
    set height(v) { this.setAttribute('height', String(v)); }
    play() { return Promise.resolve(); }
    pause() {}
    load() {}
    get paused() { return true; }
    get currentTime() { return 0; }
    get duration() { return Number.NaN; }
    getClientRects() { return [this.getBoundingClientRect()]; }
    scrollIntoView() {}

    cloneNode(deep = false) { return this[HOST].wrap(cloneNode(this[HOST].doc, this[NODE], Boolean(deep))); }
    before(...nodes) {
      const p = this[NODE].parentNode;
      if (!p) return;
      for (const x of nodes) placeNode(this[HOST], p, typeof x === 'string' ? this[HOST].doc.createTextNode(x) : unwrap(x), this[NODE]);
    }
    after(...nodes) {
      const p = this[NODE].parentNode;
      if (!p) return;
      let ref = this[NODE].nextSibling;
      for (const x of nodes) {
        const n = typeof x === 'string' ? this[HOST].doc.createTextNode(x) : unwrap(x);
        placeNode(this[HOST], p, n, ref);
      }
    }
    replaceWith(...nodes) {
      this.before(...nodes);
      this.remove();
    }
    insertAdjacentHTML(position, html) {
      const nodes = [...parseHTML(String(html), { fragment: true }).childNodes];
      this.#insertAdjacent(position, nodes);
    }
    insertAdjacentElement(position, el) {
      const n = unwrap(el);
      this.#insertAdjacent(position, [n]);
      return el;
    }
    insertAdjacentText(position, text) {
      this.#insertAdjacent(position, [this[HOST].doc.createTextNode(String(text))]);
    }
    #insertAdjacent(position, nodes) {
      const where = String(position).toLowerCase();
      if (where === 'beforebegin') this.before(...nodes.map((n) => this[HOST].wrap(n)));
      else if (where === 'afterend') this.after(...nodes.map((n) => this[HOST].wrap(n)));
      else if (where === 'afterbegin') {
        const first = this[NODE].firstChild;
        for (const n of nodes) placeNode(this[HOST], this[NODE], n, first);
      } else if (where === 'beforeend') {
        for (const n of nodes) placeNode(this[HOST], this[NODE], n, null);
      } else {
        throw new Error(`SyntaxError: insertAdjacent position "${position}" is not valid`);
      }
    }

    // Inserted <script> elements run, as in a browser. innerHTML does not run them.
    appendChild(child) {
      placeNode(this[HOST], this[NODE], unwrap(child), null);
      return child;
    }
    insertBefore(child, ref) {
      placeNode(this[HOST], this[NODE], unwrap(child), ref ? unwrap(ref) : null);
      return child;
    }
    removeChild(child) {
      const c = unwrap(child);
      this[NODE].removeChild(c);
      this[HOST].childChanged(this[NODE], [], [c]);
      return child;
    }
    remove() {
      const p = this[NODE].parentNode;
      this[NODE].remove();
      if (p) this[HOST].childChanged(p, [], [this[NODE]]);
    }
    append(...nodes) {
      for (const x of nodes) {
        const n = typeof x === 'string' ? this[HOST].doc.createTextNode(x) : unwrap(x);
        this[NODE].appendChild(n);
        this[HOST].inserted(n);
      }
    }
    prepend(...nodes) {
      const first = this[NODE].firstChild;
      for (const x of nodes) {
        const n = typeof x === 'string' ? this[HOST].doc.createTextNode(x) : unwrap(x);
        this[NODE].insertBefore(n, first);
        this[HOST].inserted(n);
      }
    }
    write(...parts) { this[HOST].documentWrite(parts.map(String).join('')); }
    writeln(...parts) { this[HOST].documentWrite(`${parts.map(String).join('')}\n`); }
    get currentScript() { return this[HOST].wrap(this[HOST].currentScript); }
    createDocumentFragment() {
      const f = this[HOST].doc.createElement('div');
      f.isFragment = true; // flattened into its parent when inserted (see placeNode)
      return this[HOST].wrap(f);
    }
    importNode(node, deep = false) { return this[HOST].wrap(cloneNode(this[HOST].doc, unwrap(node), Boolean(deep))); }
    adoptNode(node) { return node; }
    createEvent() { return new DomEvent(''); }
    get visibilityState() { return 'visible'; }
    get activeElement() { return this[HOST].wrap(this[HOST].doc.body ?? null); }
    get scrollingElement() { return this[HOST].wrap(this[HOST].doc.documentElement ?? null); }
    get defaultView() { return this[HOST].sandbox; }
    get fonts() { return { ready: Promise.resolve(), check: () => true, addEventListener() {}, removeEventListener() {} }; }
    createRange() {
      const host = this[HOST];
      return {
        startContainer: null, endContainer: null, collapsed: true,
        setStart() {}, setEnd() {}, collapse() {}, selectNode() {}, selectNodeContents() {},
        cloneRange() { return this; }, detach() {},
        getBoundingClientRect: () => rectObject({}), getClientRects: () => [],
        createContextualFragment: (html) => {
          const f = host.doc.createElement('div');
          f.isFragment = true;
          for (const n of [...parseHTML(String(html), { fragment: true }).childNodes]) f.appendChild(n);
          return host.wrap(f);
        },
      };
    }
    contains(other) {
      for (let n = other ? unwrap(other) : null; n; n = n.parentNode) if (n === this[NODE]) return true;
      return false;
    }

    querySelector(sel) { return this[HOST].wrap(querySelector(this[NODE], sel)); }
    querySelectorAll(sel) { return querySelectorAll(this[NODE], sel).map((n) => this[HOST].wrap(n)); }
    getElementById(id) { return this[HOST].wrap(this[NODE].getElementById(id)); }
    getElementsByTagName(tag) {
      const t = String(tag).toLowerCase();
      return querySelectorAll(this[NODE], t === '*' ? '*' : t).map((n) => this[HOST].wrap(n));
    }
    getElementsByClassName(cls) {
      return querySelectorAll(this[NODE], `.${cls}`).map((n) => this[HOST].wrap(n));
    }
    matches(sel) { return matches(this[NODE], sel); }
    closest(sel) {
      for (let n = this[NODE]; n && n.nodeType === ELEMENT; n = n.parentNode) if (matches(n, sel)) return this[HOST].wrap(n);
      return null;
    }
    createElement(tag) { return this[HOST].wrap(this[HOST].doc.createElement(tag)); }
    createTextNode(text) { return this[HOST].wrap(this[HOST].doc.createTextNode(text)); }
    createComment(text) { return this[HOST].wrap(this[HOST].doc.createComment(text)); }

    addEventListener(type, fn, opts) { this[HOST].addListener(this[NODE], type, fn, opts); }
    removeEventListener(type, fn) { this[HOST].removeListener(this[NODE], type, fn); }
    dispatchEvent(event) { return this[HOST].dispatch(this[NODE], event); }

    click() { this[HOST].browser._activate(this[NODE]); }
    focus() {}
    blur() {}
    submit() { this[HOST].browser._queueForm(this[NODE], null); }
    requestSubmit(submitter) {
      this[HOST].browser._submitWithEvent(this[NODE], submitter ? unwrap(submitter) : null);
    }

    toJSON() {
      const n = this[NODE];
      if (n.nodeType !== ELEMENT) return { nodeType: n.nodeType };
      const attrs = Object.fromEntries(n.attributes);
      return { tag: n.tagName, text: normalizeText(n.textContent), attrs };
    }
  };
}

function siblingEl(node, step) {
  const sibs = node.parentNode?.childNodes;
  if (!sibs) return null;
  let i = sibs.indexOf(node) + step;
  while (i >= 0 && i < sibs.length && sibs[i].nodeType !== ELEMENT) i += step;
  return sibs[i] ?? null;
}

export class ScriptHost {
  /**
   * @param {object} browser the owning Browser (provides url, cookies, navigation hooks)
   * @param {Document} doc the page document
   * @param {{timeoutMs?: number}} opts
   */
  constructor(browser, doc, { timeoutMs = 5000 } = {}) {
    this.browser = browser;
    this.doc = doc;
    this.timeoutMs = timeoutMs;
    this.wrappers = new WeakMap();
    this.listeners = new WeakMap(); // target -> Map(type -> [{fn, once}])
    this.timers = new Map();
    this.nextTimer = 1;
    this.closed = false;
    this.ranScripts = new WeakSet(); // script elements that have already run (or started to)
    this.moduleRecords = new Map(); // module URL -> { exports, promise, evaluating }
    this.currentScript = null; // the script element that is running, for document.currentScript and write()
    this.observers = new Set(); // MutationObserver registrations (see webapis.js)
    this.layoutDirty = true; // a DOM or style change since the last layout
    this.boxes = null; // the last layout: element -> border box
    this.Wrapper = makeWrapperClass();
    this.protos = makeProtos(this.Wrapper.prototype);
    this.sandbox = this._makeSandbox();
    this.context = this._makeContext(this.sandbox);
  }

  /**
   * The page's global: a prototype-less copy of the bridge whose values all sit behind the membrane.
   * `this.sandbox` stays the host-side object that event targets are keyed by.
   */
  _makeContext(bridge) {
    const global = Object.create(null);
    this.global = global; // window: where the page keeps window.onload and its other on<type> handlers
    const options = {};
    if (hardening.enabled) options.codeGeneration = { strings: false, wasm: false };
    const context = vm.createContext(global, options);
    installStackFilter(context);
    this.membrane = new Membrane(context);
    for (const [key, value] of Object.entries(bridge)) {
      if (key !== 'window' && key !== 'self') global[key] = this.membrane.sandbox(value);
    }
    global.window = global;
    global.self = global;
    global.parent = global; // window.parent and window.top are the window itself, for a top-level page
    global.top = global;
    global.frames = global;
    return context;
  }

  /** Runs code in the page context. Throws whatever the script throws. */
  run(code, filename = 'inline-script') {
    if (this.closed) return undefined;
    return vm.runInContext(String(code), this.context, { filename, timeout: this.timeoutMs });
  }

  /** Fires the script-visible listeners for a browser-initiated event. Returns the event. */
  fire(target, event) {
    this.dispatch(target, event);
    return event;
  }

  close() {
    this.closed = true;
    for (const t of this.timers.values()) (t.repeat ? clearInterval : clearTimeout)(t.handle);
    this.timers.clear();
  }

  /** An attribute changed: the layout may change, and mutation observers hear about it. */
  attrChanged(node, attributeName) {
    this.layoutDirty = true;
    this.mutated(node, { type: 'attributes', attributeName });
  }

  /** Children of parent changed: the layout may change, and mutation observers hear about it. */
  childChanged(parent, added = [], removed = []) {
    if (!parent) return;
    this.layoutDirty = true;
    this.mutated(parent, { type: 'childList', added, removed });
  }

  /** Queues a mutation record for every observer that watches target. Records are delivered in a microtask. */
  mutated(target, info) {
    if (this.observers.size === 0) return;
    for (const entry of this.observers) {
      if (info.type === 'attributes') {
        if (!entry.attributes) continue;
        if (entry.attributeFilter && !entry.attributeFilter.includes(info.attributeName)) continue;
      } else if (!entry.childList) {
        continue;
      }
      if (!(target === entry.node || (entry.subtree && isWithin(target, entry.node)))) continue;
      entry.records.push({ ...info, target });
      if (!entry.scheduled) {
        entry.scheduled = true;
        Promise.resolve().then(() => this._deliver(entry));
      }
    }
  }

  _deliver(entry) {
    entry.scheduled = false;
    if (entry.records.length === 0 || !this.observers.has(entry)) return;
    const records = entry.records.map((r) => this.pageRecord(r));
    entry.records = [];
    try {
      entry.observer._callback.call(entry.observer, records, entry.observer);
    } catch (e) {
      this._error(e);
    }
  }

  /** A mutation record as a page sees it: nodes wrapped, and the fields a page reads. */
  pageRecord(r) {
    return {
      type: r.type,
      target: this.wrap(r.target),
      addedNodes: (r.added ?? []).map((n) => this.wrap(n)),
      removedNodes: (r.removed ?? []).map((n) => this.wrap(n)),
      attributeName: r.attributeName ?? null,
      attributeNamespace: null,
      oldValue: null,
      previousSibling: null,
      nextSibling: null,
    };
  }

  /** The border box of an element in the current layout (zeros when it has none). */
  boxOf(node) {
    return this.rectOf(node) ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  /** The border box of an element, from the layout the renderer uses. The layout is redone after a change. */
  rectOf(node) {
    if (!node || node.nodeType !== ELEMENT || this.closed) return null;
    if (this.layoutDirty || !this.boxes) {
      this.boxes = layoutPage(this.doc, { resources: this.browser.tab.resources ?? null });
      this.layoutDirty = false;
    }
    return this.boxes.get(node) ?? null;
  }

  /** Called after a node is inserted into the page: runs any <script> it brings in. */
  inserted(node) {
    if (this.closed || !node || node.nodeType !== 1) return;
    this.childChanged(node.parentNode, [node], []);
    const els = node.tagName === 'script' ? [node] : querySelectorAll(node, 'script');
    for (const el of els) {
      if (el.isConnected) void this.browser._runScriptElement(this, el, 'inserted-script');
    }
  }

  /**
   * document.write: parses the markup and inserts it right after the script that is running (as a parser
   * does), or at the end of the body when no script is running. Scripts in the markup run.
   */
  documentWrite(html) {
    if (this.closed) return;
    const nodes = [...parseHTML(html, { fragment: true }).childNodes];
    let parent;
    let ref = null;
    if (this.currentScript?.parentNode) {
      parent = this.currentScript.parentNode;
      ref = this.currentScript.nextSibling;
    } else {
      parent = this.doc.body ?? this.doc.documentElement ?? this.doc;
    }
    for (const n of nodes) {
      parent.insertBefore(n, ref);
      this.inserted(n);
    }
  }

  // ---- wrappers

  /** The prototype a node's wrapper gets, from its node type and tag. */
  protoFor(node) {
    if (node.nodeType === 1) return this.protos.get(domClassName(node.tagName)) ?? this.protos.get('HTMLElement');
    if (node.nodeType === 3) return this.protos.get('Text');
    if (node.nodeType === 8) return this.protos.get('Comment');
    if (node.nodeType === 9) return this.protos.get('Document');
    if (node.nodeType === 11) return this.protos.get('DocumentFragment');
    return this.protos.get('Node');
  }

  wrap(node) {
    if (node === null || node === undefined) return null;
    if (node === this.sandbox) return node;
    let w = this.wrappers.get(node);
    if (!w) {
      w = new this.Wrapper(this, node);
      Object.setPrototypeOf(w, this.protoFor(node));
      this.wrappers.set(node, w);
    }
    return w;
  }

  absoluteUrl(href) {
    if (href === null || href === undefined) return '';
    try {
      return new URL(href, this.browser._currentUrl()).href;
    } catch {
      return String(href);
    }
  }

  // ---- events

  addListener(target, type, fn, opts) {
    if (!fn) return;
    let byType = this.listeners.get(target);
    if (!byType) {
      byType = new Map();
      this.listeners.set(target, byType);
    }
    const list = byType.get(String(type)) ?? [];
    byType.set(String(type), list);
    if (list.some((l) => l.fn === fn)) return;
    list.push({ fn, once: !!(opts && typeof opts === 'object' && opts.once) });
  }

  removeListener(target, type, fn) {
    const list = this.listeners.get(target)?.get(String(type));
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn);
    if (i >= 0) list.splice(i, 1);
  }

  /** Dispatches to listeners along the path target -> ancestors -> document -> window. */
  dispatch(target, event) {
    if (!event || typeof event.type !== 'string') throw new TypeError('dispatchEvent needs an Event');
    const path = [];
    if (target === this.sandbox) {
      path.push(this.sandbox);
    } else {
      for (let n = target; n; n = n.parentNode) path.push(n);
      if (path[path.length - 1].nodeType === DOCUMENT) path.push(this.sandbox);
    }
    event.target = this._wrapTarget(target);
    event.eventPhase = 2;
    for (const n of path) {
      if (event._stop) break;
      event.currentTarget = this._wrapTarget(n);
      const list = this.listeners.get(n)?.get(event.type);
      if (list) {
        for (const l of [...list]) {
          if (l.once) list.splice(list.indexOf(l), 1);
          try {
            if (typeof l.fn === 'function') l.fn.call(event.currentTarget, event);
            else if (typeof l.fn?.handleEvent === 'function') l.fn.handleEvent(event);
          } catch (e) {
            this._error(e);
          }
          if (event._stopNow) break;
        }
      }
      // The on<type> property (el.onclick = fn, window.onload = fn) runs after the listeners on that node.
      const holder = n === this.sandbox ? this.global : event.currentTarget;
      const onHandler = holder?.["on" + event.type];
      if (typeof onHandler === "function" && !event._stopNow) {
        try {
          onHandler.call(event.currentTarget, event);
        } catch (e) {
          this._error(e);
        }
      }
      if (!event.bubbles && n === target) break;
    }
    event.currentTarget = null;
    return !event.defaultPrevented;
  }

  _wrapTarget(n) {
    return n === this.sandbox ? this.sandbox : this.wrap(n);
  }

  _error(e) {
    this.browser._log('error', `Uncaught ${describeError(e)}`);
  }

  // ---- timers

  _timer(fn, ms, args, repeat) {
    const id = this.nextTimer++;
    const delay = Math.max(0, Number(ms) || 0);
    const fire = () => {
      if (!repeat) this.timers.delete(id);
      this._invoke(fn, args);
    };
    const handle = repeat ? setInterval(fire, Math.max(1, delay)) : setTimeout(fire, delay);
    this.timers.set(id, { handle, repeat });
    return id;
  }

  _clearTimer(id) {
    const t = this.timers.get(id);
    if (!t) return;
    (t.repeat ? clearInterval : clearTimeout)(t.handle);
    this.timers.delete(id);
  }

  _invoke(fn, args) {
    try {
      if (typeof fn === 'function') {
        const r = fn(...args);
        if (r && typeof r.then === 'function') r.then(undefined, (e) => this._error(e));
      } else if (typeof fn === 'string') {
        this.run(fn, 'timer');
      }
    } catch (e) {
      this._error(e);
    }
  }

  // ---- globals

  _storage(kind) {
    const b = this.browser;
    const map = () => b._storageFor(kind, b._currentOrigin());
    return {
      getItem: (k) => (map().has(String(k)) ? map().get(String(k)) : null),
      setItem: (k, v) => { map().set(String(k), String(v)); },
      removeItem: (k) => { map().delete(String(k)); },
      clear: () => { map().clear(); },
      key: (i) => [...map().keys()][i] ?? null,
      get length() { return map().size; },
    };
  }

  _history() {
    const b = this.browser;
    return {
      get length() { return b._historyLength(); },
      get state() { return b._historyState(); },
      scrollRestoration: 'auto',
      pushState: (state, title, url) => b._historyChange(state, url, 'push'),
      replaceState: (state, title, url) => b._historyChange(state, url, 'replace'),
      back: () => b._historyGo(-1),
      forward: () => b._historyGo(1),
      go: (n) => b._historyGo(Number(n) || 0),
    };
  }

  _location() {
    const b = this.browser;
    const loc = {
      get href() { return b.url ?? 'about:blank'; },
      set href(v) { b._queueScriptNav(String(v)); },
      get origin() { return new URL(loc.href).origin; },
      get protocol() { return new URL(loc.href).protocol; },
      get host() { return new URL(loc.href).host; },
      get hostname() { return new URL(loc.href).hostname; },
      get port() { return new URL(loc.href).port; },
      get pathname() { return new URL(loc.href).pathname; },
      get search() { return new URL(loc.href).search; },
      get hash() { return new URL(loc.href).hash; },
      assign(v) { b._queueScriptNav(String(v)); },
      replace(v) { b._queueScriptNav(String(v)); },
      reload() { b._queueScriptNav(loc.href, { reload: true }); },
      toString() { return loc.href; },
    };
    return loc;
  }

  _makeSandbox() {
    const host = this;
    const b = this.browser;
    const sb = {};
    const log = (level) => (...args) => b._log(level, args.map(formatArg).join(' '));

    sb.window = sb;
    sb.self = sb;
    sb.document = this.wrap(this.doc);
    sb.location = this._location();
    sb.navigator = { userAgent: b.userAgent, language: 'en-US', languages: ['en-US'], onLine: true };
    sb.console = { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
    sb.alert = (msg) => { b._log('alert', formatArg(msg)); };
    sb.confirm = (msg) => { b._log('confirm', formatArg(msg)); return true; };
    sb.prompt = (msg) => { b._log('prompt', formatArg(msg)); return null; };

    sb.setTimeout = (fn, ms, ...args) => host._timer(fn, ms, args, false);
    sb.setInterval = (fn, ms, ...args) => host._timer(fn, ms, args, true);
    sb.clearTimeout = (id) => host._clearTimer(id);
    sb.clearInterval = (id) => host._clearTimer(id);
    sb.queueMicrotask = (fn) => { Promise.resolve().then(() => host._invoke(fn, [])); };
    sb.requestAnimationFrame = (fn) => host._timer(fn, 16, [], false);
    sb.cancelAnimationFrame = (id) => host._clearTimer(id);

    sb.fetch = (input, init) => b._scriptFetch(String(input?.url ?? input), init ?? {});
    sb.Headers = PageHeaders;
    sb.XMLHttpRequest = makeXHR(this);
    sb.history = this._history();
    sb.localStorage = this._storage('local');
    sb.sessionStorage = this._storage('session');

    sb.Event = DomEvent;
    sb.CustomEvent = CustomEvent;
    sb.addEventListener = (t, fn, o) => host.addListener(sb, t, fn, o);
    sb.removeEventListener = (t, fn) => host.removeListener(sb, t, fn);
    sb.dispatchEvent = (ev) => host.dispatch(sb, ev);

    sb.URL = URL;
    sb.URLSearchParams = URLSearchParams;
    sb.TextEncoder = TextEncoder;
    sb.TextDecoder = TextDecoder;
    sb.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');
    sb.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
    sb.performance = { now: () => performance.now() };
    installWebApis(this, sb, { DomEvent, NODE, protos: this.protos });
    return sb;
  }
}
