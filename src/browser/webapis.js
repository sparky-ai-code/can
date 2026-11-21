// The browser APIs a page expects when it boots. Where this engine can do the real thing (media queries, layout
// queries, DOM mutation records, DOM parsing), the API is real. Where it cannot (sensors, devices, workers, the
// network stack beyond fetch), the API is a stub that never throws and does nothing useful. The stubs are listed
// in SPEC.md section 12.2.
import { randomBytes, randomUUID } from 'node:crypto';
import { mediaMatches } from './render.js';
import { parseHTML } from './html.js';

/** Element types that get their own DOM class (HTMLDivElement and so on). Each host builds a prototype for each. */
export const DOM_TAGS = Object.freeze(['input', 'button', 'select', 'textarea', 'form', 'img', 'a', 'div', 'span',
  'canvas', 'video', 'audio', 'iframe', 'p', 'li', 'ul', 'ol', 'table', 'tr', 'td', 'th', 'label', 'option', 'script',
  'style', 'link', 'meta', 'body', 'head', 'html', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** The DOM class name of an element type, e.g. input -> HTMLInputElement. */
export function domClassName(tag) {
  return `HTML${tag[0].toUpperCase()}${tag.slice(1)}Element`;
}

/** The viewport a page sees. Screenshots of other sizes do not change what scripts are told. */
export const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/** A DOMRect-like object. */
export function rectObject({ x = 0, y = 0, width = 0, height = 0 } = {}) {
  return {
    x, y, width, height,
    top: y, left: x, right: x + width, bottom: y + height,
    toJSON() { return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }; },
  };
}

/** Event constructors for the common event types. Each one is a DomEvent that keeps the fields it is given. */
function eventClass(DomEvent, name, fields) {
  const C = class extends DomEvent {
    constructor(type, init = {}) {
      super(type, init);
      for (const f of fields) this[f] = init[f] ?? (typeof fields.defaults?.[f] === 'undefined' ? null : fields.defaults[f]);
    }
  };
  Object.defineProperty(C, 'name', { value: name });
  return C;
}

const MOUSE = ['clientX', 'clientY', 'screenX', 'screenY', 'pageX', 'pageY', 'button', 'buttons', 'altKey', 'ctrlKey', 'shiftKey', 'metaKey'];
const KEY = ['key', 'code', 'keyCode', 'which', 'altKey', 'ctrlKey', 'shiftKey', 'metaKey', 'repeat'];

/**
 * Installs the browser APIs on the page's global object `sb`. `host` is the ScriptHost (it provides wrap, rectOf,
 * mutation notifications and the timers). `env` carries DomEvent, the node symbol and the document helpers.
 */
export function installWebApis(host, sb, env) {
  const { DomEvent, NODE } = env;
  const nodeOf = (w) => (w !== null && typeof w === 'object' ? w[NODE] : undefined);

  // ---- media and viewport
  class MediaQueryList {
    constructor(media) {
      this.media = media;
      this.matches = mediaMatches(media);
      this.onchange = null;
      this._listeners = [];
    }
    addListener(fn) { if (typeof fn === 'function') this._listeners.push(fn); }
    removeListener(fn) { this._listeners = this._listeners.filter((f) => f !== fn); }
    addEventListener(type, fn) { if (type === 'change') this.addListener(fn); }
    removeEventListener(type, fn) { if (type === 'change') this.removeListener(fn); }
  }
  sb.matchMedia = (q) => new MediaQueryList(String(q));
  sb.innerWidth = VIEWPORT.width;
  sb.innerHeight = VIEWPORT.height;
  sb.outerWidth = VIEWPORT.width;
  sb.outerHeight = VIEWPORT.height;
  sb.devicePixelRatio = 1;
  sb.scrollX = 0;
  sb.scrollY = 0;
  sb.pageXOffset = 0;
  sb.pageYOffset = 0;
  sb.scrollTo = () => {};
  sb.scrollBy = () => {};
  sb.scroll = () => {};
  sb.visualViewport = { width: VIEWPORT.width, height: VIEWPORT.height, scale: 1, offsetLeft: 0, offsetTop: 0 };
  sb.screen = { width: VIEWPORT.width, height: VIEWPORT.height, availWidth: VIEWPORT.width, availHeight: VIEWPORT.height, colorDepth: 24, pixelDepth: 24 };
  sb.open = () => null;
  sb.print = () => {};
  sb.focus = () => {};
  sb.blur = () => {};

  // ---- scheduling
  sb.requestIdleCallback = (fn) => host._timer(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 1, [], false);
  sb.cancelIdleCallback = (id) => host._clearTimer(id);

  // ---- observers (mutation records are real; intersection and resize are reported once, as visible at boot)
  class MutationObserver {
    constructor(callback) {
      if (typeof callback !== 'function') throw new TypeError('MutationObserver: callback must be a function');
      this._callback = callback;
      this._entries = [];
    }
    observe(target, opts = {}) {
      const node = nodeOf(target);
      if (!node) throw new TypeError('MutationObserver.observe: target is not a Node');
      this.disconnect();
      const entry = {
        node,
        childList: Boolean(opts.childList),
        attributes: Boolean(opts.attributes || opts.attributeFilter || opts.attributeOldValue),
        attributeFilter: Array.isArray(opts.attributeFilter) ? opts.attributeFilter.map(String) : null,
        subtree: Boolean(opts.subtree),
        records: [],
        observer: this,
        scheduled: false,
      };
      this._entries.push(entry);
      host.observers.add(entry);
    }
    disconnect() {
      for (const e of this._entries) host.observers.delete(e);
      this._entries = [];
    }
    takeRecords() {
      const out = [];
      for (const e of this._entries) {
        out.push(...e.records.map((r) => host.pageRecord(r)));
        e.records = [];
      }
      return out;
    }
  }
  sb.MutationObserver = MutationObserver;

  class IntersectionObserver {
    constructor(callback, options = {}) {
      this._callback = callback;
      this._targets = [];
      this.root = null;
      this.rootMargin = String(options.rootMargin ?? '0px');
      this.thresholds = Array.isArray(options.threshold) ? options.threshold : [options.threshold ?? 0];
    }
    observe(target) {
      const node = nodeOf(target);
      if (!node || this._targets.includes(node)) return;
      this._targets.push(node);
      host._timer(() => {
        if (!this._targets.includes(node)) return;
        const r = host.rectOf(node) ?? { x: 0, y: 0, width: 0, height: 0 };
        this._callback.call(this, [{
          target: host.wrap(node), isIntersecting: true, intersectionRatio: 1,
          boundingClientRect: rectObject(r), intersectionRect: rectObject(r),
          rootBounds: rectObject({ x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height }), time: Date.now(),
        }], this);
      }, 0, [], false);
    }
    unobserve(target) { this._targets = this._targets.filter((n) => n !== nodeOf(target)); }
    disconnect() { this._targets = []; }
    takeRecords() { return []; }
  }
  sb.IntersectionObserver = IntersectionObserver;

  class ResizeObserver {
    constructor(callback) {
      this._callback = callback;
      this._targets = [];
    }
    observe(target) {
      const node = nodeOf(target);
      if (!node || this._targets.includes(node)) return;
      this._targets.push(node);
      host._timer(() => {
        if (!this._targets.includes(node)) return;
        const r = host.rectOf(node) ?? { x: 0, y: 0, width: 0, height: 0 };
        const size = { inlineSize: r.width, blockSize: r.height };
        this._callback.call(this, [{
          target: host.wrap(node), contentRect: rectObject(r),
          borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [],
        }], this);
      }, 0, [], false);
    }
    unobserve(target) { this._targets = this._targets.filter((n) => n !== nodeOf(target)); }
    disconnect() { this._targets = []; }
  }
  sb.ResizeObserver = ResizeObserver;

  // ---- DOM classes. Each class's prototype is the prototype the page's node wrappers inherit from, so
  // "node instanceof HTMLElement" follows the prototype chain (the membrane answers instanceof that way).
  const domClass = (name) => {
    const C = function () { throw new TypeError(`Illegal constructor: ${name}`); };
    Object.defineProperty(C, 'name', { value: name });
    Object.defineProperty(C, 'prototype', { value: env.protos.get(name), writable: false });
    return C;
  };
  for (const name of ['Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Document', 'DocumentFragment']) sb[name] = domClass(name);
  sb.HTMLDocument = sb.Document;
  for (const tag of DOM_TAGS) sb[domClassName(tag)] = domClass(domClassName(tag));

  // ---- events
  const Ev = (name, fields, defaults = {}) => {
    const list = [...fields];
    list.defaults = defaults;
    return eventClass(DomEvent, name, list);
  };
  sb.UIEvent = Ev('UIEvent', ['detail', 'view']);
  sb.MouseEvent = Ev('MouseEvent', MOUSE, { button: 0, buttons: 0 });
  sb.PointerEvent = Ev('PointerEvent', [...MOUSE, 'pointerId', 'pointerType'], { button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse' });
  sb.KeyboardEvent = Ev('KeyboardEvent', KEY);
  sb.FocusEvent = Ev('FocusEvent', ['relatedTarget']);
  sb.InputEvent = Ev('InputEvent', ['data', 'inputType', 'isComposing']);
  sb.WheelEvent = Ev('WheelEvent', [...MOUSE, 'deltaX', 'deltaY', 'deltaMode'], { deltaX: 0, deltaY: 0, deltaMode: 0 });
  sb.ErrorEvent = Ev('ErrorEvent', ['message', 'filename', 'lineno', 'colno', 'error']);

  // ---- layout-dependent style
  sb.getComputedStyle = (node) => computedStyle(host, nodeOf(node));
  sb.CSS = { supports: () => false, escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };

  // ---- parsing and construction
  sb.DOMParser = class DOMParser {
    parseFromString(markup) { return host.wrap(parseHTML(String(markup))); }
  };
  sb.Image = function Image(width, height) {
    const img = host.doc.createElement('img');
    if (width !== undefined) img.setAttribute('width', String(width));
    if (height !== undefined) img.setAttribute('height', String(height));
    return host.wrap(img);
  };
  sb.Option = function Option(text = '', value) {
    const o = host.doc.createElement('option');
    o.appendChild(host.doc.createTextNode(String(text)));
    if (value !== undefined) o.setAttribute('value', String(value));
    return host.wrap(o);
  };

  // ---- crypto and cloning
  sb.crypto = {
    randomUUID: () => randomUUID(),
    getRandomValues: (arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = randomBytes(4).readUInt32LE(0);
      return arr;
    },
  };
  sb.structuredClone = (value) => {
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value ?? null));
    }
  };

  // ---- navigator, performance, misc
  Object.assign(sb.navigator, {
    platform: 'Linux x86_64',
    vendor: '',
    cookieEnabled: true,
    hardwareConcurrency: 4,
    maxTouchPoints: 0,
    clipboard: { writeText: async () => {}, readText: async () => '' },
    permissions: { query: async () => ({ state: 'prompt' }) },
  });
  sb.performance.mark = () => {};
  sb.performance.measure = () => {};
  sb.performance.getEntriesByName = () => [];
  sb.performance.getEntriesByType = () => [];
  sb.performance.timeOrigin = Date.now();
  installExtras(host, sb);
  sb.AbortController = AbortController;
  sb.AbortSignal = AbortSignal;
  sb.Blob = Blob;
  sb.FormData = FormData;
  sb.Intl = Intl;
}

/**
 * Globals that pages probe at boot. Real where it is cheap (console methods, window.parent, File, the 2D canvas
 * context, media element methods); a documented stub otherwise: a WebSocket that is closed and reports an error, a
 * Worker that reports an error, an IndexedDB that fails its request, geolocation that is denied. A stub never throws
 * during boot. It reports failure the way a browser does, so the page takes its fallback path.
 */
function installExtras(host, sb) {
  // console: the methods pages call besides log, error and warn
  const info = sb.console.info;
  Object.assign(sb.console, {
    table: info,
    group: info,
    groupCollapsed: info,
    groupEnd: () => {},
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
    count: () => {},
    countReset: () => {},
    dir: info,
    trace: () => {},
    clear: () => {},
    assert: (cond, ...rest) => { if (!cond) sb.console.error('Assertion failed', ...rest); },
  });

  // window relations and document facts
  sb.frameElement = null;
  sb.opener = null;
  sb.name = '';
  sb.isSecureContext = false;
  sb.origin = 'null';
  sb.external = {};

  // File, and the reader pages use with it
  sb.File = class File extends Blob {
    constructor(parts = [], name = '', options = {}) {
      super(parts, options);
      this.name = String(name);
      this.lastModified = Date.now();
    }
  };
  sb.FileReader = class FileReader {
    constructor() {
      this.readyState = 0;
      this.result = null;
      this.error = null;
      this.onload = null;
      this.onerror = null;
      this.onloadend = null;
    }
    #finish(kind, blob, encoding) {
      this.readyState = 1;
      Promise.resolve().then(async () => {
        try {
          const buf = Buffer.from(await blob.arrayBuffer());
          if (kind === 'text') this.result = buf.toString(encoding ?? 'utf8');
          else if (kind === 'dataURL') this.result = `data:${blob.type || 'application/octet-stream'};base64,${buf.toString('base64')}`;
          else this.result = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          this.readyState = 2;
          if (typeof this.onload === 'function') this.onload({ target: this });
        } catch (e) {
          this.error = e;
          if (typeof this.onerror === 'function') this.onerror({ target: this });
        }
        if (typeof this.onloadend === 'function') this.onloadend({ target: this });
      });
    }
    readAsText(blob, encoding) { this.#finish('text', blob, encoding); }
    readAsDataURL(blob) { this.#finish('dataURL', blob); }
    readAsArrayBuffer(blob) { this.#finish('buffer', blob); }
    abort() { this.readyState = 2; }
  };

  // Failing or closed transports: the page's error path runs, and nothing throws at boot
  class WebSocket {
    constructor(url) {
      this.url = String(url);
      this.readyState = 3;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      host._timer(() => {
        if (typeof this.onerror === 'function') this.onerror({ type: 'error' });
        if (typeof this.onclose === 'function') this.onclose({ type: 'close', code: 1006, reason: '', wasClean: false });
      }, 0, [], false);
    }
    send() { throw new Error('InvalidStateError: the WebSocket is not open in this browser'); }
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }
  sb.WebSocket = WebSocket;
  sb.Worker = class Worker {
    constructor(url) {
      this.url = String(url);
      this.onerror = null;
      host._timer(() => { if (typeof this.onerror === 'function') this.onerror({ type: 'error', message: 'Workers are not available in this browser' }); }, 0, [], false);
    }
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  };
  sb.indexedDB = {
    open: () => {
      const request = { error: null, result: null, onerror: null, onsuccess: null, onupgradeneeded: null };
      host._timer(() => {
        request.error = new Error('IndexedDB is not available in this browser');
        if (typeof request.onerror === 'function') request.onerror({ target: request });
      }, 0, [], false);
      return request;
    },
    deleteDatabase: () => ({ onerror: null, onsuccess: null }),
  };
  sb.Notification = class Notification {
    constructor(title, options = {}) { this.title = String(title); this.body = options.body ?? ''; }
    static get permission() { return 'denied'; }
    static requestPermission() { return Promise.resolve('denied'); }
    close() {}
  };
  sb.navigator.geolocation = {
    getCurrentPosition: (ok, fail) => host._timer(() => {
      if (typeof fail === 'function') fail({ code: 1, message: 'Geolocation is not available in this browser' });
    }, 0, [], false),
    watchPosition: () => 0,
    clearWatch: () => {},
  };
  sb.navigator.sendBeacon = () => true;
  sb.navigator.getBattery = () => Promise.reject(new Error('Battery status is not available'));

  // Screen-related and selection stubs
  sb.getSelection = () => ({ rangeCount: 0, isCollapsed: true, toString: () => '', removeAllRanges() {}, addRange() {} });

}

/** A 2D canvas context that accepts the drawing calls. Measurements are estimates; nothing is drawn. */
export function canvasContext(canvasNode, kind) {
  if (kind !== '2d') return null;
  const noop = () => {};
  const gradient = () => ({ addColorStop: noop });
  const ctx = {
    canvas: canvasNode,
    fillStyle: '#000000', strokeStyle: '#000000', font: '10px sans-serif', lineWidth: 1, globalAlpha: 1,
    globalCompositeOperation: 'source-over', textAlign: 'start', textBaseline: 'alphabetic', lineCap: 'butt',
    lineJoin: 'miter', miterLimit: 10, shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0,
    imageSmoothingEnabled: true, filter: 'none',
    fillRect: noop, clearRect: noop, strokeRect: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    bezierCurveTo: noop, quadraticCurveTo: noop, arc: noop, arcTo: noop, ellipse: noop, rect: noop, fill: noop,
    stroke: noop, clip: noop, save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    setTransform: noop, resetTransform: noop, transform: noop, drawImage: noop, fillText: noop, strokeText: noop,
    putImageData: noop, setLineDash: noop, getLineDash: () => [],
    measureText: (text) => ({ width: String(text).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) }),
    createLinearGradient: gradient, createRadialGradient: gradient, createConicGradient: gradient,
    createPattern: () => ({}),
    isPointInPath: () => false, isPointInStroke: () => false,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  return ctx;
}

/**
 * The computed style of an element, as far as this engine knows it: inline style, then the element's default display,
 * then 'static' and 'visible'. Cascaded values from <style> rules are not included (the renderer applies them).
 */
function computedStyle(host, node) {
  const DEFAULT_INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'em', 'i', 'img', 'input', 'label',
    'small', 'span', 'strong', 'sub', 'sup', 'time', 'u']);
  const decls = new Map();
  for (const decl of (node?.getAttribute?.('style') ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) decls.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim());
  }
  const defaults = {
    display: node && node.nodeType === 1 ? (DEFAULT_INLINE.has(node.tagName) ? 'inline' : 'block') : '',
    position: 'static',
    visibility: 'visible',
  };
  const read = (name) => {
    const k = String(name).trim().toLowerCase();
    if (decls.has(k)) return decls.get(k);
    return defaults[k] ?? '';
  };
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'getPropertyValue') return (name) => read(name);
      if (typeof prop !== 'string') return undefined;
      return read(prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
    },
  });
}
