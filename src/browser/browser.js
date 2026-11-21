// Headless browser for QA-ing apps inside a can. Pages come from the can's virtual network
// (localhost, 127.0.0.1, the can's name, or a bare port number) or from the real internet.
// Everything (parser, selectors, DOM, scripts) is built in this directory without dependencies.
import { randomBytes } from 'node:crypto';
import { parseHTML } from './html.js';
import { renderPage, RENDER_LIMITS } from './render.js';
import { encodePNG } from './png.js';
import { decodeImage } from './image.js';
import { querySelector, querySelectorAll, findByText, normalizeText, matches, SelectorError } from './selector.js';
import { ScriptHost, DomEvent, makeResponse, headersToObject } from './script.js';
import { CookieJar, fetchResource } from './net.js';
import { toCommonJs } from '../runtime/esm.js';
import { KernelError } from '../kernel/errors.js';

const DEFAULT_UA = 'can-browser/0.1 (headless)';
const MAX_NAV_CHAIN = 10;
const MAX_LOG = 1000;
const TEXT = 3;
const ELEMENT = 1;

const SKIP_TEXT = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'svg']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog', 'div', 'dl',
  'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tr', 'ul']);
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img',
  'ins', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr']);
const HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const CONTAINER_ROLES = new Map([
  ['nav', 'navigation'], ['main', 'main'], ['header', 'banner'], ['footer', 'contentinfo'], ['aside', 'complementary'],
  ['section', 'region'], ['article', 'article'], ['dialog', 'dialog'], ['fieldset', 'group'],
]);
const SNAP_SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'svg', 'option']);
const SNAP_SPECIAL = 'a[href], button, input, select, textarea, summary, img[alt], h1, h2, h3, h4, h5, h6, table, form, ul, ol, '
  + 'nav, main, header, footer, aside, section, article, dialog, fieldset, [role="button"]';
const CLICK_CANDIDATES = 'a[href], button, input, summary, label, [role="button"], [role="link"]';
const FIELD_CANDIDATES = 'input, textarea, select';
const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button', 'option', 'script', 'style']);

/** A browser for one can. Tabs each keep their own history, document and scripts. */
export class Browser {
  /**
   * @param {object} opts
   * @param {import('../vm/machine.js').Machine} opts.can the can kernel whose virtual network serves local URLs
   * @param {boolean} [opts.scripts=true] run inline <script> tags
   * @param {boolean} [opts.internet=true] allow real http/https requests outside the can
   * @param {number} [opts.timeout=30000] per-request timeout in ms (0 disables)
   * @param {number} [opts.maxBytes] response size cap
   * @param {string} [opts.userAgent]
   * @param {number} [opts.scriptTimeout=5000] ms a single synchronous script run may take
   */
  constructor({ can, scripts = true, internet = true, timeout = 30000, maxBytes = 10 * 1024 * 1024, userAgent = DEFAULT_UA, scriptTimeout = 5000 } = {}) {
    if (!can || !can.vnet) throw new TypeError('Browser requires {can} with a vnet');
    this.can = can;
    this.scripts = scripts;
    this.internet = internet;
    this.timeout = timeout;
    this.maxBytes = maxBytes;
    this.userAgent = userAgent;
    this.scriptTimeout = scriptTimeout;
    this.cookies = new CookieJar();
    this.consoleLog = [];
    this._storageMaps = { local: new Map(), session: new Map() }; // kind -> Map(origin -> Map)
    this._tabs = [newTab()];
    this._active = 0;
    this._navCount = 0;
  }

  // ------------------------------------------------------------ state

  get tab() { return this._tabs[this._active]; }
  get url() { const e = this._entry(); return e ? e.url : null; }
  get status() { const e = this._entry(); return e ? e.page.status : null; }
  get title() { return this.tab.doc ? this.tab.doc.title : ''; }
  get document() { return this.tab.doc; }
  get history() {
    const t = this.tab;
    return { index: t.index, urls: t.entries.map((e) => e.url) };
  }
  get tabs() {
    return this._tabs.map((t, i) => ({
      index: i,
      url: t.index >= 0 ? t.entries[t.index].url : null,
      title: t.doc ? t.doc.title : '',
      active: i === this._active,
    }));
  }

  _entry() { const t = this.tab; return t.index >= 0 ? t.entries[t.index] : null; }
  _currentUrl() { return this.url ?? 'about:blank'; }
  _currentOrigin() { return new URL(this._currentUrl()).origin; }
  _storageFor(kind, origin) {
    const byOrigin = this._storageMaps[kind];
    let m = byOrigin.get(origin);
    if (!m) { m = new Map(); byOrigin.set(origin, m); }
    return m;
  }
  _log(level, text) {
    this.consoleLog.push({ level, text: String(text), url: this.url, time: Date.now() });
    if (this.consoleLog.length > MAX_LOG) this.consoleLog.splice(0, this.consoleLog.length - MAX_LOG);
  }
  clearConsole() { this.consoleLog.length = 0; }
  cookieList() { return this.cookies.list(); }

  _summary() { return { url: this.url, status: this.status, title: this.title }; }

  // ------------------------------------------------------------ tabs

  /** Opens a tab (optionally loading url in it) and makes it active. */
  async newTab(url) {
    this._tabs.push(newTab());
    this._active = this._tabs.length - 1;
    if (url !== undefined) return this.goto(url);
    return this._summary();
  }

  selectTab(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this._tabs.length) {
      throw new KernelError('EINVAL', `EINVAL: no tab ${index}`);
    }
    this._active = index;
    return this._summary();
  }

  closeTab(index = this._active) {
    const [t] = this._tabs.splice(index, 1);
    t?.host?.close();
    if (this._tabs.length === 0) this._tabs.push(newTab());
    if (this._active >= this._tabs.length) this._active = this._tabs.length - 1;
    else if (index < this._active) this._active -= 1;
    return this._summary();
  }

  /** Disposes of every tab's scripts and timers. */
  close() {
    for (const t of this._tabs) t.host?.close();
    this._tabs = [newTab()];
    this._active = 0;
  }

  // ------------------------------------------------------------ navigation

  /**
   * Loads a URL in the active tab (adds a history entry). Follows redirects and cookies.
   * Accepts absolute URLs, relative URLs (against the current page), "localhost:3000/x" and "3000/x".
   */
  async goto(url, { method = 'GET', body = null, headers = {} } = {}) {
    const request = {
      method: String(method).toUpperCase(),
      url: this._resolve(url),
      body: body === null ? null : toBuffer(body),
      headers,
    };
    return this._navigate(request, 'push');
  }

  async back() { return this._historyMove(-1); }
  async forward() { return this._historyMove(1); }

  /** Requests the current page again. Form POSTs are re-sent. */
  async reload() {
    const tab = this.tab;
    const e = this._entry();
    if (!e) throw new KernelError('EINVAL', 'EINVAL: nothing to reload');
    return this._navigate(e.request, 'replace', tab);
  }

  async _historyMove(delta) {
    const tab = this.tab;
    const i = tab.index + delta;
    if (i < 0 || i >= tab.entries.length) return this._summary();
    const from = tab.entries[tab.index];
    const to = tab.entries[i];
    tab.index = i;
    if (tab.host && from.page === to.page) {
      // Same document (history.pushState entries): no reload, just popstate with the entry's state.
      const ev = new DomEvent('popstate');
      ev.state = to.state ?? null;
      tab.host.fire(tab.host.sandbox, ev);
    } else {
      await this._render(to, tab);
    }
    await this._drain(tab);
    return this._summary();
  }

  /** history.back / forward / go from page scripts: runs after the current task, like the browser does. */
  _historyGo(delta) {
    Promise.resolve().then(() => this._historyMove(delta)).catch((e) => this._log('error', `history: ${errText(e)}`));
  }

  _historyLength() { return this.tab.entries.length; }
  _historyState() {
    const e = this._entry();
    return e && e.state !== undefined ? e.state : null;
  }

  /**
   * history.pushState / replaceState: a new URL for the current document with no reload. Only the URL and
   * state change, so the document and its scripts stay. The origin must match, as in a browser.
   */
  _historyChange(state, url, mode) {
    const tab = this.tab;
    const cur = tab.entries[tab.index];
    if (!cur) throw new Error('InvalidStateError: no document to change');
    let next = cur.url;
    if (url !== undefined && url !== null) {
      next = new URL(String(url), cur.url).href;
      if (new URL(next).origin !== new URL(cur.url).origin) {
        throw new Error(`SecurityError: cannot change history to ${next} from a different origin`);
      }
    }
    let copy = null;
    try {
      copy = JSON.parse(JSON.stringify(state ?? null));
    } catch {
      copy = null;
    }
    const entry = { url: next, request: { method: 'GET', url: next, headers: {} }, page: cur.page, state: copy };
    if (mode === 'replace') {
      tab.entries[tab.index] = entry;
    } else {
      tab.entries.splice(tab.index + 1);
      tab.entries.push(entry);
      tab.index = tab.entries.length - 1;
    }
  }

  async _navigate(request, mode, tab = this.tab) {
    const page = await this._fetchPage(request);
    const entry = { url: page.url, request, page };
    this._commit(entry, mode, tab);
    await this._render(entry, tab);
    await this._drain(tab);
    return this._summary();
  }

  _commit(entry, mode, tab) {
    if (mode === 'replace' && tab.index >= 0) {
      tab.entries[tab.index] = entry;
    } else {
      tab.entries.splice(tab.index + 1);
      tab.entries.push(entry);
      tab.index = tab.entries.length - 1;
    }
    this._navCount++;
  }

  /** Runs navigations queued by links, forms and scripts until none are left. */
  async _drain(tab = this.tab) {
    for (let hops = 0; tab.pending; hops++) {
      if (hops >= MAX_NAV_CHAIN) {
        this._log('error', 'too many navigations queued by page scripts; stopped');
        tab.pending = null;
        break;
      }
      const { request, mode } = tab.pending;
      tab.pending = null;
      if (this._isHashOnly(tab, request)) {
        const cur = tab.entries[tab.index];
        this._commit({ url: request.url, request, page: cur.page }, 'push', tab);
        continue;
      }
      const page = await this._fetchPage(request);
      const entry = { url: page.url, request, page };
      this._commit(entry, mode, tab);
      await this._render(entry, tab);
    }
  }

  _isHashOnly(tab, request) {
    const cur = tab.entries[tab.index];
    if (!cur || request.method !== 'GET' || !request.url.includes('#')) return false;
    const a = new URL(cur.url);
    const b = new URL(request.url);
    return !!b.hash && a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  }

  _queueNav(request, mode = 'push') {
    this.tab.pending = { request, mode };
  }

  _queueScriptNav(url, { reload = false } = {}) {
    const target = reload ? this.url : this._resolve(url);
    if (!target) return;
    this._queueNav({ method: 'GET', url: target, headers: {} }, reload ? 'replace' : 'push');
  }

  async _fetchPage(request) {
    if (request.url === 'about:blank') {
      return { url: 'about:blank', status: null, headers: { 'content-type': 'text/html' }, body: Buffer.alloc(0), redirects: 0 };
    }
    return fetchResource(this._netOpts(), {
      method: request.method ?? 'GET',
      url: request.url,
      headers: request.headers ?? {},
      body: request.body ?? null,
    });
  }

  _netOpts() {
    return {
      can: this.can,
      cookies: this.cookies,
      internet: this.internet,
      timeout: this.timeout,
      maxBytes: this.maxBytes,
      userAgent: this.userAgent,
    };
  }

  /** Builds the document for an entry and runs its scripts. Resolves once the scripts have run. */
  async _render(entry, tab = this.tab) {
    tab.host?.close();
    tab.host = null;
    const page = entry.page;
    const raw = decodeBody(page.body, page.headers['content-type']);
    const isHtml = page.url === 'about:blank' || isHtmlResponse(page.headers, raw);
    let doc;
    if (isHtml) {
      doc = parseHTML(raw);
    } else {
      doc = parseHTML('<html><head></head><body><pre></pre></body></html>');
      doc.querySelector('pre').textContent = raw;
    }
    tab.doc = doc;
    tab.refs = newRefs();
    tab.isHtml = isHtml;
    tab.raw = raw;
    // What the renderer draws with the page: its stylesheets and PNG images. Loaded once per navigation.
    tab.resources = isHtml ? await this._loadResources(doc) : null;
    if (this.scripts && isHtml) {
      const host = new ScriptHost(this, doc, { timeoutMs: this.scriptTimeout });
      tab.host = host;
      await this._runScripts(host, doc);
    }
  }

  /**
   * Runs the page's scripts in the order a browser uses: classic scripts as the parser meets them, then
   * `defer` and module scripts in document order, then `async` ones. Then DOMContentLoaded and load.
   * A navigation that replaces the page while a script file is loading stops this run.
   */
  async _runScripts(host, doc) {
    const phases = [[], [], []];
    querySelectorAll(doc, 'script').forEach((el) => {
      if (el.hasAttribute('nomodule')) return; // browsers that run modules skip these
      const type = (el.getAttribute('type') ?? '').trim().toLowerCase();
      if (type !== 'module' && type && !JS_TYPES.has(type)) return;
      if (type === 'module' || el.hasAttribute('defer')) phases[1].push(el);
      else if (el.hasAttribute('async')) phases[2].push(el);
      else phases[0].push(el);
    });
    for (const phase of phases) {
      for (const el of phase) {
        if (host.closed) return;
        await this._runScriptElement(host, el);
      }
    }
    if (host.closed) return;
    host.fire(doc, new DomEvent('DOMContentLoaded', { bubbles: true }));
    host.fire(host.sandbox, new DomEvent('load'));
  }

  /**
   * Runs one <script> element (once). External files are fetched first. Module scripts resolve their imports
   * against the file's own URL, or the page's URL for inline code. Errors are logged, as in the console.
   */
  async _runScriptElement(host, el, label = 'inline-script') {
    if (host.closed || host.ranScripts.has(el)) return;
    const type = (el.getAttribute('type') ?? '').trim().toLowerCase();
    if (el.hasAttribute('nomodule') || (type !== 'module' && type && !JS_TYPES.has(type))) return;
    host.ranScripts.add(el);
    const isModule = type === 'module';
    const src = el.getAttribute('src');
    let code = el.textContent;
    let url = this._currentUrl();
    let name = label;
    if (src !== null) {
      try {
        url = this._resolve(src);
        code = await this._fetchText(url);
      } catch (e) {
        this._log('error', `failed to load script ${src}: ${errText(e)}`);
        return;
      }
      if (host.closed) return;
      name = url;
    }
    if (isModule) {
      try {
        await this._evaluateModule(host, code, url, {});
      } catch (e) {
        this._log('error', `Uncaught ${errText(e)}`);
      }
      return;
    }
    host.currentScript = el;
    try {
      host.run(code, name);
    } catch (e) {
      this._log('error', `Uncaught ${errText(e)}`);
    } finally {
      host.currentScript = null;
    }
  }

  /**
   * Loads what the renderer draws with the page: its <link rel="stylesheet"> files (as text) and its PNG images
   * (decoded: PNG, baseline JPEG, WebP and SVG, see image.js). A file that fails is logged, and the page is drawn
   * without it, as a browser does. Other formats are drawn as outlines with their alt text.
   */
  async _loadResources(doc) {
    const css = new Map();
    const images = new Map();
    const sheets = [];
    const pics = [];
    walkElements(doc, (el) => {
      if (el.tagName === 'link' && el.getAttribute('href')
        && (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet')) {
        sheets.push(el);
      } else if (el.tagName === 'img' && el.getAttribute('src')) {
        pics.push(el);
      }
    });
    for (const el of sheets.slice(0, MAX_STYLESHEETS)) {
      const href = el.getAttribute('href');
      try {
        css.set(el, await this._fetchText(this._resolve(href)));
      } catch (e) {
        this._log('error', `failed to load stylesheet ${href}: ${errText(e)}`);
      }
    }
    for (const el of pics.slice(0, MAX_IMAGES)) {
      try {
        const res = await this._fetchRaw(el.getAttribute('src'));
        if (res.status < 200 || res.status >= 300 || res.body.length > MAX_IMAGE_BYTES) continue;
        // an SVG is drawn at the size the page gives it, so it stays sharp
        const width = Number.parseInt(el.getAttribute('width') ?? '', 10);
        const height = Number.parseInt(el.getAttribute('height') ?? '', 10);
        const pic = decodeImage(res.body, { width: width > 0 ? width : undefined, height: height > 0 ? height : undefined });
        if (pic) images.set(el, pic);
      } catch {
        // drawn as a box with its alt text
      }
    }
    return { css, images };
  }

  /** Text of a script or module file. Throws on a network error or a non-2xx status. */
  async _fetchText(url) {
    const res = await fetchResource(this._netOpts(), { method: 'GET', url, headers: {}, body: null });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} for ${url}`);
    return decodeBody(res.body, res.headers['content-type']);
  }

  /**
   * Runs module source in the page context. Imports go through `_importModule`, so a module runs once per URL and
   * its importers wait for it. The exports object is created first, so a cycle sees the partial exports.
   */
  async _evaluateModule(host, code, url, exports) {
    const fn = host.run(`${ASYNC_WRAP_HEAD}${toCommonJs(code, url, { async: true })}\n})`, url);
    const m = host.membrane;
    const module = { exports };
    const args = [exports, this._moduleRequire(host, url), module, url, url.replace(/[^/]*$/, '')].map((a) => m.sandbox(a));
    await fn.apply(undefined, args);
    return exports;
  }

  _moduleRequire(host, base) {
    const b = this;
    const req = () => { throw new Error('require() is not available in page modules; use import'); };
    req.async = (spec) => b._importModule(host, spec, base);
    req.importAsync = req.async;
    req.resolve = (spec) => b._moduleUrl(spec, base);
    return req;
  }

  /** The URL of a module specifier. Only relative and absolute URLs load in the browser (no bare names). */
  _moduleUrl(spec, base) {
    const s = String(spec);
    if (!/^(\.{0,2}\/|\.{1,2}$|[a-z][a-z0-9+.-]*:)/i.test(s)) {
      throw new Error(`Cannot find module '${s}': bare module names are not supported in the browser; use a relative URL`);
    }
    return new URL(s, base).href;
  }

  async _importModule(host, spec, base) {
    const url = this._moduleUrl(spec, base);
    let rec = host.moduleRecords.get(url);
    if (!rec) {
      rec = { exports: {}, promise: null, evaluating: false };
      host.moduleRecords.set(url, rec);
      rec.promise = (async () => {
        const text = await this._fetchText(url);
        rec.evaluating = true;
        try {
          await this._evaluateModule(host, text, url, rec.exports);
        } finally {
          rec.evaluating = false;
        }
      })();
      rec.promise.catch(() => {}); // the awaiting import below reports the error
    }
    if (!rec.evaluating) await rec.promise; // a cycle (the module is already running) gets its partial exports
    return rec.exports;
  }

  /** Resolves a user-supplied URL. Throws EINVAL when a relative URL has no base. */
  _resolve(raw) {
    let s = String(raw).trim();
    if (s === 'about:blank') return s;
    // A bare port ("3000/x" or "http://3000/x") means the can's own port. WHATWG parsing would
    // read a bare number as an IPv4 address, so rewrite it to localhost first.
    const bare = /^(\d{1,5})(?=[/?#]|$)/.exec(s);
    if (bare) s = `http://localhost:${bare[1]}${s.slice(bare[0].length)}`;
    const schemePort = /^(https?):\/\/(\d{1,5})(?=[/?#]|$)/i.exec(s);
    if (schemePort) s = `${schemePort[1]}://localhost:${schemePort[2]}${s.slice(schemePort[0].length)}`;
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(s)) {
      return new URL(`http://${s}`).href;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return new URL(s).href;
    const base = this.url;
    if (!base || base === 'about:blank') {
      throw new KernelError('EINVAL', `EINVAL: cannot resolve ${JSON.stringify(s)} without a base URL`);
    }
    return new URL(s, base).href;
  }

  // ------------------------------------------------------------ reading the page

  _requireDoc() {
    const doc = this.tab.doc;
    if (!doc) throw new KernelError('EINVAL', 'EINVAL: no page loaded; call goto() first');
    return doc;
  }

  /** Readable visible text of the page, or of `target` if given. Non-HTML responses return their raw body. */
  text(target) {
    if (!this.tab.doc) return '';
    if (!this.tab.isHtml && target === undefined) return this.tab.raw;
    const doc = this._requireDoc();
    const root = target === undefined ? (doc.body ?? doc.documentElement ?? doc) : this._find(target);
    return visibleText(root);
  }

  /** Serialized page (or the raw body for non-HTML responses). */
  html() {
    const t = this.tab;
    if (!t.doc) return '';
    if (!t.isHtml) return t.raw;
    return `<!DOCTYPE html>\n${t.doc.documentElement.outerHTML}`;
  }

  /**
   * PNG of the current page, as a Buffer. The renderer is an approximation (render.js, SPEC.md section 12.1):
   * block and inline layout with a built-in font, no CSS layout modes, no web fonts, images as grey boxes.
   * width and height default to 1280 x 800 (the viewport). fullPage grows the image to the content, up to 4096 px.
   * With no page loaded, a blank white page is drawn. Rendering runs in this process; the host decides where
   * the bytes go (Can.screenshot).
   */
  screenshot({ fullPage = false, width, height } = {}) {
    const doc = this.tab.doc ?? parseHTML('');
    const r = renderPage(doc, {
      resources: this.tab.resources ?? null,
      width: width ?? RENDER_LIMITS.defaultWidth,
      height: height ?? RENDER_LIMITS.defaultHeight,
      fullPage: fullPage === true,
    });
    return encodePNG({ width: r.width, height: r.height, data: r.data, channels: 4 });
  }

  /** Links as [{text, href}] with hrefs resolved to absolute URLs. */
  links() {
    const doc = this._requireDoc();
    return querySelectorAll(doc, 'a[href]').map((a) => {
      const raw = a.getAttribute('href');
      let href = raw;
      try { href = this._resolve(raw); } catch { /* keep raw */ }
      return { text: accessibleName(a, doc), href };
    });
  }

  /** Elements matching selector as [{tag, text, attrs}]. */
  query(selector) {
    const doc = this._requireDoc();
    return querySelectorAll(doc, selector).map((el) => ({
      tag: el.tagName,
      text: normalizeText(el.textContent),
      attrs: Object.fromEntries(el.attributes),
    }));
  }

  /**
   * Accessibility-style outline of the page for an agent. Interactive elements carry refs
   * like [e12] that stay stable for the life of the document; click, type, select and
   * submit accept them in place of a selector.
   */
  snapshot() {
    const doc = this._requireDoc();
    const t = this.tab;
    if (!t.isHtml) return `Page: (not HTML)\nURL: ${this.url}\n${t.raw.slice(0, 2000)}`;
    const ctx = { doc, labels: labelMap(doc), out: [], ref: (el) => this._ref(el) };
    ctx.out.push(`Page: ${JSON.stringify(this.title)}`);
    ctx.out.push(`URL: ${this.url}`);
    const root = doc.body ?? doc.documentElement;
    if (root) walkSnapshot(root, 0, ctx);
    return ctx.out.join('\n');
  }

  _ref(el) {
    const refs = this.tab.refs;
    let r = refs.byEl.get(el);
    if (!r) {
      r = `e${refs.next++}`;
      refs.byEl.set(el, r);
      refs.byId.set(r, el);
    }
    return r;
  }

  /**
   * Finds one element. Accepts a snapshot ref (e12), a CSS selector, or (if `fallback` is given)
   * text searched by the fallback function.
   */
  _find(target, { fallback = null } = {}) {
    if (target && typeof target === 'object' && target.nodeType) return target;
    const str = String(target ?? '').trim();
    if (!str) throw new KernelError('EINVAL', 'EINVAL: empty target');
    const doc = this._requireDoc();
    if (/^e\d+$/.test(str) && this.tab.refs.byId.has(str)) {
      const el = this.tab.refs.byId.get(str);
      if (!el.isConnected) {
        throw new KernelError('ENOENT', `ENOENT: ref ${str} is stale (element was removed); take a new snapshot`, { target: str });
      }
      return el;
    }
    let found = null;
    try {
      found = querySelector(doc, str);
    } catch (e) {
      if (!(e instanceof SelectorError)) throw e;
    }
    if (!found && fallback) found = fallback(doc, str) ?? null;
    if (!found) {
      const hint = /^e\d+$/.test(str) ? ' (unknown ref; take a snapshot first)' : '';
      throw new KernelError('ENOENT', `ENOENT: no element matches ${JSON.stringify(str)}${hint}`, { target: str });
    }
    return found;
  }

  // ------------------------------------------------------------ actions

  /**
   * Clicks an element: dispatches click to script listeners, then performs the default action
   * (follows links, submits forms via submit buttons, toggles checkboxes and radios, activates labels).
   * Target: ref, selector, or visible text of a link or button.
   */
  async click(target) {
    const el = this._find(target, { fallback: (doc, str) => findByText(querySelectorAll(doc, CLICK_CANDIDATES), str, clickText) });
    const before = this._navCount;
    this._activate(el);
    await this._drain();
    return { ...this._summary(), navigated: this._navCount !== before };
  }

  /** Replaces the value of an input or textarea. Target: ref, selector, or the field's label/placeholder/name. */
  async type(target, value) {
    const el = this._find(target, { fallback: fieldFallback });
    if (el.tagName === 'input') {
      const type = typeOf(el) || 'text';
      if (['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) {
        throw new KernelError('EINVAL', `EINVAL: cannot type into an input of type ${type}; use click or select`);
      }
      el.setAttribute('value', String(value));
    } else if (el.tagName === 'textarea' || el.getAttribute('contenteditable') !== null) {
      el.textContent = String(value);
    } else {
      throw new KernelError('EINVAL', `EINVAL: ${el.tagName} is not a text field`);
    }
    this._dispatch(el, 'input', { bubbles: true });
    this._dispatch(el, 'change', { bubbles: true });
    return { value: el.value };
  }

  /** Selects option(s) of a <select> by value or visible text. */
  async select(target, value) {
    const el = this._find(target, { fallback: fieldFallback });
    if (el.tagName !== 'select') throw new KernelError('EINVAL', `EINVAL: ${el.tagName} is not a select`);
    const multiple = el.hasAttribute('multiple');
    const wanted = [].concat(value).map(String);
    if (!multiple && wanted.length > 1) throw new KernelError('EINVAL', 'EINVAL: select without multiple takes one value');
    const opts = el.querySelectorAll('option');
    const chosen = new Set();
    for (const w of wanted) {
      const o = opts.find((x) => x.value === w) ?? opts.find((x) => normalizeText(x.textContent) === w);
      if (!o) throw new KernelError('ENOENT', `ENOENT: no option ${JSON.stringify(w)} in select`);
      chosen.add(o);
    }
    for (const o of opts) {
      if (chosen.has(o)) o.setAttribute('selected', '');
      else o.removeAttribute('selected');
    }
    this._dispatch(el, 'input', { bubbles: true });
    this._dispatch(el, 'change', { bubbles: true });
    return { value: el.value };
  }

  /**
   * Submits a form the way a user would: fires submit (cancellable), then sends the
   * urlencoded/multipart/text-plain body, or the query string for GET.
   * With no target, the first form on the page.
   */
  async submit(target) {
    const doc = this._requireDoc();
    const form = target === undefined ? querySelector(doc, 'form') : this._find(target);
    if (!form || form.tagName !== 'form') throw new KernelError('EINVAL', 'EINVAL: target is not a form');
    const before = this._navCount;
    this._submitWithEvent(form, null);
    await this._drain();
    return { ...this._summary(), navigated: this._navCount !== before };
  }

  /** Waits for `ms` (max 60s), runs any navigation that timers or scripts queued, and returns the summary. */
  async wait(ms = 0) {
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(Number(ms) || 0, 60000))));
    await this._drain();
    return this._summary();
  }

  /** Runs code in the page's script context. The result is JSON-cloned (DOM nodes become {tag, text, attrs}). */
  async evaluate(code) {
    const host = this.tab.host;
    if (!host) throw new KernelError('EINVAL', 'EINVAL: scripts are disabled or the page is not HTML');
    const value = host.run(code, 'evaluate');
    await this._drain();
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  /** Raw request for page scripts (fetch and XMLHttpRequest). Same routing, cookies and redirects as navigation. */
  async _fetchRaw(url, init = {}) {
    const abs = this._resolve(url);
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = headersToObject(init.headers);
    const body = init.body === undefined || init.body === null ? null : toBuffer(init.body);
    return fetchResource(this._netOpts(), { method, url: abs, headers, body });
  }

  /** fetch() for page scripts. No page change. */
  async _scriptFetch(url, init = {}) {
    const res = await this._fetchRaw(url, init);
    return makeResponse({ url: res.url, status: res.status, headers: res.headers, body: res.body });
  }

  // ------------------------------------------------------------ events and default actions

  /** Dispatches an event to page script listeners. Returns the event (check defaultPrevented). */
  _dispatch(node, typeOrEvent, init = {}) {
    const ev = typeof typeOrEvent === 'string' ? new DomEvent(typeOrEvent, init) : typeOrEvent;
    const host = this.tab.host;
    if (host && !host.closed) host.dispatch(node, ev);
    return ev;
  }

  _activate(el) {
    const ev = this._dispatch(el, 'click', { bubbles: true, cancelable: true });
    if (ev.defaultPrevented) return ev;
    const tag = el.tagName;
    const type = typeOf(el);
    if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) {
      this._followHref(el.getAttribute('href'));
    } else if (isSubmitter(el)) {
      const form = formOf(el, this._requireDoc());
      if (form) this._submitWithEvent(form, el);
    } else if (tag === 'input' && type === 'checkbox') {
      toggle(el);
      this._dispatch(el, 'input', { bubbles: true });
      this._dispatch(el, 'change', { bubbles: true });
    } else if (tag === 'input' && type === 'radio') {
      if (!el.hasAttribute('checked')) {
        for (const other of radioGroup(el, this._requireDoc())) other.removeAttribute('checked');
        el.setAttribute('checked', '');
        this._dispatch(el, 'input', { bubbles: true });
        this._dispatch(el, 'change', { bubbles: true });
      }
    } else if (tag === 'label') {
      const control = labelControl(el, this._requireDoc());
      if (control && control !== el) this._activate(control);
    } else if (tag === 'summary' && el.parentNode?.tagName === 'details') {
      const d = el.parentNode;
      if (d.hasAttribute('open')) d.removeAttribute('open'); else d.setAttribute('open', '');
    }
    return ev;
  }

  _followHref(href) {
    const raw = String(href).trim();
    if (/^javascript:/i.test(raw)) {
      const host = this.tab.host;
      if (!host) return;
      try {
        host.run(decodeURIComponent(raw.slice('javascript:'.length)), 'javascript-url');
      } catch (e) {
        this._log('error', `Uncaught ${errText(e)}`);
      }
      return;
    }
    this._queueScriptNav(raw);
  }

  _submitWithEvent(form, submitter) {
    const ev = new DomEvent('submit', { bubbles: true, cancelable: true });
    if (submitter) ev.submitter = this.tab.host ? this.tab.host.wrap(submitter) : null;
    this._dispatch(form, ev);
    if (ev.defaultPrevented) return;
    this._queueNav(this._formRequest(form, submitter));
  }

  /** Form request for submit()/requestSubmit()/submit buttons. Used by scripts too. */
  _queueForm(form, submitter) {
    this._queueNav(this._formRequest(form, submitter));
  }

  _formRequest(form, submitter) {
    const doc = this._requireDoc();
    const method = (form.getAttribute('method') ?? 'get').trim().toLowerCase() === 'post' ? 'POST' : 'GET';
    const action = (form.getAttribute('action') ?? '').trim();
    const url = new URL(action ? this._resolve(action) : this._currentUrl());
    url.hash = '';
    const pairs = formPairs(doc, form, submitter);

    if (method === 'GET') {
      url.search = new URLSearchParams(pairs).toString();
      return { method, url: url.href, body: null, headers: {} };
    }
    const enctype = (form.getAttribute('enctype') ?? '').trim().toLowerCase();
    if (enctype === 'multipart/form-data') {
      const boundary = `----canboundary${randomBytes(8).toString('hex')}`;
      let s = '';
      for (const [k, v] of pairs) {
        s += `--${boundary}\r\nContent-Disposition: form-data; name="${k.replace(/"/g, '%22').replace(/\r?\n/g, ' ')}"\r\n\r\n${v}\r\n`;
      }
      s += `--${boundary}--\r\n`;
      return { method, url: url.href, body: Buffer.from(s), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
    }
    if (enctype === 'text/plain') {
      const body = pairs.map(([k, v]) => `${k}=${v}\r\n`).join('');
      return { method, url: url.href, body: Buffer.from(body), headers: { 'content-type': 'text/plain' } };
    }
    return {
      method,
      url: url.href,
      body: Buffer.from(new URLSearchParams(pairs).toString()),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    };
  }
}

/** Factory form of the constructor: createBrowser({can}). */
export function createBrowser(opts) {
  return new Browser(opts);
}

// ---------------------------------------------------------------- helpers

const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript']);
const ASYNC_WRAP_HEAD = '(async function (exports, require, module, __filename, __dirname) {';
const MAX_STYLESHEETS = 20;
const MAX_IMAGES = 40;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Calls fn for every element under node, in document order. */
function walkElements(node, fn) {
  if (node.nodeType === ELEMENT) fn(node);
  for (const c of node.childNodes ?? []) walkElements(c, fn);
}

function newTab() {
  return { entries: [], index: -1, doc: null, host: null, refs: newRefs(), pending: null, isHtml: false, raw: '' };
}

function newRefs() {
  return { byEl: new WeakMap(), byId: new Map(), next: 1 };
}

function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(String(body));
}

function errText(e) {
  if (e && typeof e === 'object' && 'message' in e) return `${e.name ?? 'Error'}: ${e.message}`;
  return String(e);
}

function decodeBody(buf, contentType = '') {
  const m = /charset=([^;]+)/i.exec(String(contentType));
  const label = m ? m[1].trim().replace(/"/g, '') : 'utf-8';
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function isHtmlResponse(headers, text) {
  const ct = String(headers['content-type'] ?? '').toLowerCase();
  if (ct) return ct.includes('html');
  return /^\s*<(!doctype|html|head|body|div|p|\w)/i.test(text);
}

function typeOf(el) {
  return (el.getAttribute('type') ?? '').trim().toLowerCase();
}

function toggle(el) {
  if (el.hasAttribute('checked')) el.removeAttribute('checked');
  else el.setAttribute('checked', '');
}

function isSubmitter(el) {
  if (el.tagName === 'button') {
    const t = typeOf(el);
    return t === '' || t === 'submit';
  }
  return el.tagName === 'input' && (typeOf(el) === 'submit' || typeOf(el) === 'image');
}

function formOf(el, doc) {
  const id = el.getAttribute('form');
  if (id !== null) {
    const f = doc.getElementById(id);
    return f && f.tagName === 'form' ? f : null;
  }
  return el.closest('form');
}

function labelControl(label, doc) {
  const id = label.getAttribute('for');
  if (id !== null) return doc.getElementById(id);
  return label.querySelector('input, select, textarea, button');
}

function radioGroup(el, doc) {
  const name = el.getAttribute('name');
  if (!name) return [];
  const form = formOf(el, doc);
  return querySelectorAll(doc, `input[type="radio"][name="${name.replace(/"/g, '\\"')}"]`)
    .filter((r) => r !== el && formOf(r, doc) === form);
}

/** Successful controls of a form as [name, value] pairs. */
function formPairs(doc, form, submitter) {
  const pairs = [];
  const controls = querySelectorAll(doc, 'input, select, textarea, button').filter((el) => formOf(el, doc) === form);
  for (const el of controls) {
    if (el.hasAttribute('disabled')) continue;
    const name = el.getAttribute('name');
    if (!name) continue;
    if (el.tagName === 'input') {
      const type = typeOf(el) || 'text';
      if (['submit', 'image', 'reset', 'button'].includes(type)) {
        if (el === submitter) pairs.push([name, el.getAttribute('value') ?? '']);
      } else if (type === 'file') {
        pairs.push([name, '']);
      } else if (type === 'checkbox' || type === 'radio') {
        if (el.hasAttribute('checked')) pairs.push([name, el.getAttribute('value') ?? 'on']);
      } else {
        pairs.push([name, el.getAttribute('value') ?? '']);
      }
    } else if (el.tagName === 'textarea') {
      pairs.push([name, el.textContent]);
    } else if (el.tagName === 'select') {
      const opts = el.querySelectorAll('option').filter((o) => !o.hasAttribute('disabled'));
      const selected = opts.filter((o) => o.hasAttribute('selected'));
      if (el.hasAttribute('multiple')) {
        for (const o of selected) pairs.push([name, o.value]);
      } else {
        const pick = selected[0] ?? opts[0];
        if (pick) pairs.push([name, pick.value]);
      }
    } else if (el.tagName === 'button' && el === submitter) {
      pairs.push([name, el.getAttribute('value') ?? '']);
    }
  }
  return pairs;
}

function isHidden(el) {
  if (el.hasAttribute('hidden')) return true;
  if ((el.getAttribute('aria-hidden') ?? '').trim().toLowerCase() === 'true') return true;
  const style = el.getAttribute('style');
  if (style && /(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) return true;
  return el.tagName === 'input' && typeOf(el) === 'hidden';
}

/** Readable text with block-level line breaks, hidden content and script/style skipped. */
function visibleText(root) {
  let out = '';
  const walk = (n) => {
    if (n.nodeType === TEXT) { out += n.data.replace(/\s+/g, ' '); return; }
    if (n.nodeType !== ELEMENT) {
      for (const c of n.childNodes) walk(c);
      return;
    }
    if (SKIP_TEXT.has(n.tagName) || isHidden(n)) return;
    if (n.tagName === 'br') { out += '\n'; return; }
    if (n.tagName === 'input' && ['submit', 'button', 'reset'].includes(typeOf(n))) {
      out += ` ${n.getAttribute('value') ?? ''} `;
      return;
    }
    const block = BLOCK.has(n.tagName);
    if (block) out += '\n';
    if (n.tagName === 'li') out += '- ';
    if (n.tagName === 'td' || n.tagName === 'th') out += ' ';
    for (const c of n.childNodes) walk(c);
    if (block) out += '\n';
  };
  walk(root);
  return out.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Text of a label, ignoring text inside the controls it wraps. */
function ownText(el) {
  let out = '';
  const walk = (n) => {
    if (n.nodeType === TEXT) { out += n.data; return; }
    if (n.nodeType !== ELEMENT || CONTROL_TAGS.has(n.tagName)) return;
    for (const c of n.childNodes) walk(c);
  };
  walk(el);
  return normalizeText(out);
}

function labelMap(doc) {
  const m = new Map();
  for (const l of querySelectorAll(doc, 'label[for]')) m.set(l.getAttribute('for'), ownText(l));
  return m;
}

/** Best human name for a form control. */
function fieldName(el, doc, labels = labelMap(doc)) {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  if (ids.length) {
    const text = ids.map((id) => normalizeText(doc.getElementById(id)?.textContent ?? '')).join(' ').trim();
    if (text) return text;
  }
  const id = el.getAttribute('id');
  if (id !== null && labels.has(id) && labels.get(id)) return labels.get(id);
  const wrap = el.closest('label');
  if (wrap) {
    const t = ownText(wrap);
    if (t) return t;
  }
  return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
}

/** Name of a link or button: aria-label, then its text, then an image's alt, then title. */
function accessibleName(el, doc) {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  if (el.tagName === 'input') return el.getAttribute('value') || (doc ? fieldName(el, doc) : '');
  let text = normalizeText(el.textContent);
  if (!text) text = normalizeText(el.querySelector('img[alt]')?.getAttribute('alt') ?? '');
  return text || el.getAttribute('title') || '';
}

function clickText(el) {
  if (el.tagName === 'input') return el.getAttribute('value') ?? '';
  return normalizeText(el.textContent) || accessibleName(el, null);
}

function fieldFallback(doc, str) {
  const labels = labelMap(doc);
  return findByText(querySelectorAll(doc, FIELD_CANDIDATES).filter((el) => !isHidden(el)), str, (el) => fieldName(el, doc, labels));
}

const quote = (s) => JSON.stringify(s.length > 160 ? `${s.slice(0, 157)}...` : s);

/**
 * Lists the children of a block. Runs of plain inline text (text nodes and inline elements with no
 * interactive content, such as a <span> inside a <p>) become one text line, so "Signed in as <b>ada</b>."
 * reads as one sentence rather than three fragments.
 */
function walkSnapshot(parent, depth, ctx) {
  let run = '';
  const flush = () => {
    const s = normalizeText(run);
    if (s) ctx.out.push(`${pad(depth)}- text ${quote(s)}`);
    run = '';
  };
  for (const n of parent.childNodes) {
    if (n.nodeType === TEXT) {
      run += n.data;
      continue;
    }
    if (n.nodeType !== ELEMENT) continue;
    if (isInlineText(n)) {
      run += n.textContent;
      continue;
    }
    flush();
    snapshotElement(n, depth, ctx);
  }
  flush();
}

/** An inline element whose text can join its neighbours: no control, link, image, label or hidden content. */
function isInlineText(el) {
  const tag = el.tagName.toLowerCase();
  if (!INLINE.has(tag) || tag === 'label' || tag === 'img' || SNAP_SKIP.has(tag)) return false;
  if (isHidden(el) || matches(el, SNAP_SPECIAL)) return false;
  return !el.querySelector(SNAP_SPECIAL) && !el.querySelector('label, img[alt]');
}

const pad = (d) => '  '.repeat(d);

function snapshotElement(el, depth, ctx) {
  const tag = el.tagName;
  if (SNAP_SKIP.has(tag) || isHidden(el)) return;
  const line = (s) => ctx.out.push(`${pad(depth)}- ${s}`);
  const disabled = el.hasAttribute('disabled') ? ' disabled' : '';

  if (HEADING.has(tag)) {
    line(`heading ${quote(normalizeText(el.textContent))} level=${tag[1]}`);
    return;
  }
  if (tag === 'label') {
    // A label's text is shown as the name of its control, so only the control itself is listed.
    if (el.hasAttribute('for')) return;
    if (el.querySelector('input, select, textarea')) {
      walkSnapshot(el, depth, ctx);
      return;
    }
  }
  if (tag === 'a' && el.hasAttribute('href')) {
    line(`link ${quote(accessibleName(el, ctx.doc))} [${ctx.ref(el)}] -> ${quote(el.getAttribute('href'))}`);
    return;
  }
  if (tag === 'button' || tag === 'summary' || (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(typeOf(el)))
    || el.getAttribute('role') === 'button') {
    line(`button ${quote(accessibleName(el, ctx.doc))} [${ctx.ref(el)}]${disabled}`);
    return;
  }
  if (tag === 'input') {
    const type = typeOf(el) || 'text';
    if (type === 'checkbox' || type === 'radio') {
      const name = fieldName(el, ctx.doc, ctx.labels);
      line(`${type} ${quote(name)} [${ctx.ref(el)}] ${el.hasAttribute('checked') ? 'checked' : 'unchecked'}${disabled}`);
      return;
    }
    if (type === 'file') {
      line(`file ${quote(fieldName(el, ctx.doc, ctx.labels))} [${ctx.ref(el)}]${disabled}`);
      return;
    }
    const role = type === 'number' ? 'spinbutton' : type === 'range' ? 'slider' : 'textbox';
    const value = el.getAttribute('value') ?? '';
    const shown = value === '' ? '' : type === 'password' ? ' value=<redacted>' : ` value=${quote(value)}`;
    line(`${role} ${quote(fieldName(el, ctx.doc, ctx.labels))} [${ctx.ref(el)}]${shown}${disabled}`);
    return;
  }
  if (tag === 'textarea') {
    const value = normalizeText(el.textContent);
    line(`textbox ${quote(fieldName(el, ctx.doc, ctx.labels))} [${ctx.ref(el)}]${value ? ` value=${quote(value)}` : ''}${disabled}`);
    return;
  }
  if (tag === 'select') {
    const opts = el.querySelectorAll('option');
    const shown = opts.slice(0, 12).map((o) => quote(normalizeText(o.textContent))).join(', ');
    const more = opts.length > 12 ? ', ...' : '';
    line(`combobox ${quote(fieldName(el, ctx.doc, ctx.labels))} [${ctx.ref(el)}] value=${quote(el.value)} options=[${shown}${more}]${disabled}`);
    return;
  }
  if (tag === 'img') {
    const alt = el.getAttribute('alt');
    if (alt) line(`img ${quote(alt)}`);
    return;
  }
  if (tag === 'table') {
    const caption = normalizeText(el.querySelector('caption')?.textContent ?? '');
    line(`table${caption ? ` ${quote(caption)}` : ''}`);
    for (const row of el.querySelectorAll('tr')) {
      const cells = row.children.filter((c) => c.tagName === 'td' || c.tagName === 'th');
      if (cells.length) ctx.out.push(`${pad(depth + 1)}- row ${quote(cells.map((c) => normalizeText(c.textContent)).join(' | '))}`);
    }
    return;
  }
  if (tag === 'form') {
    line(`form ${quote(el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('id') || '')}`);
    walkSnapshot(el, depth + 1, ctx);
    return;
  }
  if (tag === 'ul' || tag === 'ol') {
    line(tag === 'ul' ? 'list' : 'ordered list');
    walkSnapshot(el, depth + 1, ctx);
    return;
  }
  if (CONTAINER_ROLES.has(tag)) {
    const label = el.getAttribute('aria-label') || (tag === 'fieldset' ? ownText(el.querySelector('legend') ?? el) : '');
    line(`${CONTAINER_ROLES.get(tag)}${label ? ` ${quote(label)}` : ''}`);
    walkSnapshot(el, depth + 1, ctx);
    return;
  }
  // Text-only blocks become one line. Anything with interactive or structural children is walked.
  const hasBlockChild = el.children.some((c) => !INLINE.has(c.tagName));
  if (!hasBlockChild && !el.querySelector(SNAP_SPECIAL)) {
    const text = normalizeText(el.textContent);
    if (text && (BLOCK.has(tag) || tag === 'span' || tag === 'label' || tag === 'b' || tag === 'i' || tag === 'strong' || tag === 'em')) {
      line(`text ${quote(text)}`);
      return;
    }
  }
  walkSnapshot(el, depth, ctx);
}
