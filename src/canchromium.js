// The can's browser as a real Chrome or Edge on the host, one browser per can. It has the same surface as the can's
// built-in browser (Can.browse). It is the browser of the MCP browser tools and the CLI by default; the mounts file's
// "chromiumBrowser": false selects the built-in one.
//
// Navigation is real: pages, scripts, layout and cookies come from Chromium. localhost requests go into the can
// through the proxy in src/canproxy.js, so http://localhost:<port>/ is the can's own server. Other hosts are reached
// from the host (or refused, when the can has no internet). The can process itself is unchanged.
//
// Not supported yet: links, cookie and tab actions, waits, and WebSockets to the can (those go through the proxy,
// which carries plain HTTP only). Unsupported actions fail with ENOTSUP.
import { HostBrowser, checkHostUrl, findBrowserExecutable } from './hostbrowser.js';
import { startCanProxy } from './canproxy.js';
import { canBrowserPage } from './chromium-page.js';
import { KernelError } from './kernel/errors.js';

// Chrome runs this in every new document. The guard inside makes a second run a no-op.
const PAGE_SCRIPT = `(${canBrowserPage.toString()})();`;
const WAIT_MS = 15_000;
const START_MS = 300; // how long a click may take to start a navigation before we call it "no navigation"
const MAX_LOG = 200;
const SUPPORTED = new Set([
  'goto', 'reload', 'back', 'forward', 'snapshot', 'text', 'html', 'query', 'click', 'submit', 'type', 'select',
  'evaluate', 'state', 'clearConsole', 'screenshot',
]);

// Computer use (CanChromium.computer). Coordinates are CSS pixels of the viewport, which is the screenshot's size.
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const MODIFIER_BITS = Object.freeze({ alt: 1, ctrl: 2, meta: 4, shift: 8 }); // the CDP modifier bit for each key
const BUTTON_BITS = Object.freeze({ left: 1, right: 2, middle: 4 }); // CDP "buttons" bit while a button is held
const CLICKS = Object.freeze({
  click: { button: 'left', count: 1 },
  double_click: { button: 'left', count: 2 },
  right_click: { button: 'right', count: 1 },
  middle_click: { button: 'middle', count: 1 },
});
const NAMED_KEYS = Object.freeze({
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Insert: { code: 'Insert', vk: 45 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  Space: { code: 'Space', vk: 32, text: ' ' },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { code: `F${i + 1}`, vk: 112 + i }])),
});
const DRAG_STEPS = 12;
const WAIT_MAX_MS = 10_000;

/** Describes one key name for CDP: a named key (Enter, ArrowDown, F5...) or a single character. */
function keyInfo(name) {
  if (Object.hasOwn(NAMED_KEYS, name)) return { key: name, ...NAMED_KEYS[name] };
  const chars = [...name];
  if (chars.length !== 1) {
    throw new KernelError('EINVAL', `EINVAL: unknown key ${JSON.stringify(name)}; use one character or a name such as Enter, Tab, Escape or ArrowDown`);
  }
  const c = chars[0];
  const letter = /^[a-zA-Z]$/.test(c);
  const digit = /^[0-9]$/.test(c);
  return {
    key: c,
    code: letter ? `Key${c.toUpperCase()}` : digit ? `Digit${c}` : '',
    vk: letter ? c.toUpperCase().charCodeAt(0) : digit ? c.charCodeAt(0) : 0,
    text: c,
  };
}

function modifierBits(names = []) {
  let bits = 0;
  for (const n of names) {
    if (!Object.hasOwn(MODIFIER_BITS, n)) throw new KernelError('EINVAL', `EINVAL: unknown modifier ${JSON.stringify(n)} (use alt, ctrl, meta or shift)`);
    bits |= MODIFIER_BITS[n];
  }
  return bits;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (cond()) return true;
    if (Date.now() >= end) return false;
    await sleep(20);
  }
}

export class CanChromium extends HostBrowser {
  /**
   * @param {object} opts
   * @param {() => object} opts.canFor returns the can whose localhost the browser uses
   * @param {boolean} [opts.internet=true] false refuses every host except the can
   * @param {string|null} [opts.executable] Chrome or Edge (default: findBrowserExecutable())
   */
  constructor({ canFor, internet = true, executable = findBrowserExecutable() }) {
    super({ executable });
    this.canFor = canFor;
    this.internet = internet;
    this.canProxy = null;
    this.mainFrameId = null;
    this.navCount = 0; // main-frame documents committed (and same-document navigations)
    this.loadStarts = 0; // main-frame loads started
    this.docStatus = null; // HTTP status of the last main-frame document
    this.docError = null; // {code, url} when the proxy could not reach the can for that document
    this.consoleLog = [];
    this.viewport = null; // {width, height} that computer-use coordinates refer to (null: the default size)
  }

  async _launch() {
    await this.canProxy?.close();
    this.canProxy = await startCanProxy({ canFor: this.canFor, internet: this.internet });
    this.proxyUrl = this.canProxy.url;
    await super._launch();
    const tree = await this._send('Page.getFrameTree');
    this.mainFrameId = tree.frameTree.frame.id;
    await this._send('Network.enable');
    await this._send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SCRIPT });
    await this._eval(PAGE_SCRIPT);
  }

  _onMessage(msg) {
    if (msg.method && msg.sessionId !== undefined && msg.sessionId === this.session) {
      this._track(msg.method, msg.params ?? {});
    }
    super._onMessage(msg);
  }

  _track(method, p) {
    switch (method) {
      case 'Page.frameNavigated':
        if (!p.frame?.parentId) {
          this.mainFrameId = p.frame.id;
          this.navCount++;
        }
        break;
      case 'Page.navigatedWithinDocument':
        if (p.frameId === this.mainFrameId) this.navCount++;
        break;
      case 'Page.frameStartedLoading':
        if (p.frameId === this.mainFrameId) this.loadStarts++;
        break;
      case 'Network.responseReceived':
        if (p.type === 'Document' && p.frameId === this.mainFrameId) {
          this.docStatus = p.response?.status ?? null;
          const headers = Object.fromEntries(Object.entries(p.response?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
          this.docError = headers['x-can-error'] ? { code: headers['x-can-error'], url: p.response.url } : null;
        }
        break;
      case 'Runtime.consoleAPICalled':
        this._log(p.type === 'warning' ? 'warn' : p.type, (p.args ?? [])
          .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type)))
          .join(' '));
        break;
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {};
        this._log('error', d.exception?.description ?? d.text ?? 'uncaught error');
        break;
      }
      default:
    }
  }

  _log(level, text) {
    this.consoleLog.push({ level, text: String(text).slice(0, 2000) });
    if (this.consoleLog.length > MAX_LOG) this.consoleLog.splice(0, this.consoleLog.length - MAX_LOG);
  }

  /** Same shape as Can.browse: browse(action, ...args) resolves with the same results as the can's own browser. */
  async browse(action, ...args) {
    if (!SUPPORTED.has(action)) {
      throw new KernelError('ENOTSUP', `ENOTSUP: the Chromium browser does not support "${action}" yet`);
    }
    await this._ensure();
    switch (action) {
      case 'goto': return this._goto(args[0]);
      case 'reload': return this._navigateBy(() => this._send('Page.reload'));
      case 'back': return this._history(-1);
      case 'forward': return this._history(1);
      case 'snapshot': return this._page('snapshot');
      case 'text': return this._page('text', args[0]);
      case 'html': return this._page('html', args[0]);
      case 'query': return this._page('query', args[0]);
      case 'click': return this._acting(() => this._page('click', args[0]));
      case 'submit': return this._acting(() => this._page('submit', args[0]));
      case 'type': return { value: await this._page('type', args[0], args[1]) };
      case 'select': return { value: await this._page('select', args[0], args[1]) };
      case 'evaluate': return this._evaluate(args[0]);
      case 'state': return this._state();
      case 'clearConsole': this.consoleLog = []; return { ok: true };
      case 'screenshot': return this._screenshot(args[0] ?? {});
      default: throw new KernelError('ENOTSUP', `ENOTSUP: the Chromium browser does not support "${action}" yet`);
    }
  }

  /** Runs one action on the page API (see src/chromium-page.js) and unwraps its {value} or {error, code}. */
  async _page(method, ...args) {
    const call = `window.__canBrowser.${method}(${args.map((a) => JSON.stringify(a ?? null)).join(', ')})`;
    await this._eval(PAGE_SCRIPT);
    const r = await this._eval(call);
    if (!r || typeof r !== 'object') throw new KernelError('EIO', `EIO: the page did not answer ${method}`);
    if (r.error !== undefined) {
      const code = r.code ?? 'EINVAL';
      throw new KernelError(code, `${code}: ${r.error}`);
    }
    return r.value;
  }

  async _goto(raw) {
    let s = String(raw ?? '').trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `http://${s}`;
    const href = checkHostUrl(s);
    return this._navigateBy(async () => {
      const res = await this._send('Page.navigate', { url: href });
      if (res.errorText) throw new KernelError('ECONNREFUSED', `ECONNREFUSED: ${res.errorText}`);
    });
  }

  /** Runs a navigation start, then waits until the new document has committed and finished loading. */
  async _navigateBy(start) {
    const before = this.navCount;
    this.docStatus = null;
    this.docError = null;
    await start();
    const navigated = await until(() => this.navCount !== before, WAIT_MS);
    if (navigated) await this._waitReady();
    this._throwIfRefused();
    const s = await this._state();
    return { status: this.docStatus, navigated, url: s.url, title: s.title };
  }

  /** Runs a page action that may follow a link or submit. It waits for any navigation it starts. */
  async _acting(act) {
    const loadsBefore = this.loadStarts;
    const navsBefore = this.navCount;
    this.docStatus = null;
    this.docError = null;
    await act();
    const moved = await until(() => this.loadStarts !== loadsBefore || this.navCount !== navsBefore, START_MS);
    if (moved) {
      await until(() => this.navCount !== navsBefore, WAIT_MS);
      await this._waitReady();
    }
    this._throwIfRefused();
    return { navigated: moved, status: moved ? this.docStatus : null };
  }

  /** The proxy could not reach the can for the page that just loaded: fail like the built-in browser does. */
  _throwIfRefused() {
    const e = this.docError;
    if (!e) return;
    const port = new URL(e.url).port || '80';
    if (e.code === 'ECONNREFUSED') {
      throw new KernelError('ECONNREFUSED', `ECONNREFUSED: nothing is listening on port ${port} inside the can`);
    }
    throw new KernelError(e.code, `${e.code}: the can did not answer on port ${port}`);
  }

  async _waitReady() {
    const end = Date.now() + WAIT_MS;
    while (Date.now() < end) {
      try {
        if ((await this._eval('document.readyState')) === 'complete') return;
      } catch {
        // The page may be swapping documents. Try again.
      }
      await sleep(50);
    }
  }

  async _history(delta) {
    const { currentIndex, entries } = await this._send('Page.getNavigationHistory');
    const target = entries[currentIndex + delta];
    if (!target) return { status: null, navigated: false, url: entries[currentIndex]?.url ?? null };
    return this._navigateBy(() => this._send('Page.navigateToHistoryEntry', { entryId: target.id }));
  }

  /** Runs JavaScript in the page. Expressions give their value; statements need a return statement. */
  async _evaluate(code) {
    const src = String(code);
    let isExpression = true;
    try {
      new Function(`return (\n${src}\n);`); // compile only; nothing runs
    } catch {
      isExpression = false;
    }
    return this._eval(isExpression ? `(\n${src}\n)` : `(async () => {\n${src}\n})()`);
  }

  async _state() {
    const s = await this._page('state');
    return { ...s, status: this.docStatus, consoleLog: this.consoleLog.slice() };
  }

  /**
   * Computer use: a pointer and keyboard acting on the page as a person would, at pixel coordinates of the viewport.
   * Actions: screenshot {width, height} (sets the viewport), move {x, y}, click, double_click, right_click, middle_click
   * {x, y, modifiers}, drag {x, y, to_x, to_y}, scroll {x, y, delta_x, delta_y}, type {text}, key {key, modifiers},
   * wait {duration_ms}. Each action resolves with the new screenshot as a PNG (`png`), the viewport size, the page URL
   * and title, and navigated/status when the action started a page load.
   */
  async computer(action, a = {}) {
    await this._ensure();
    if (action === 'screenshot' && (a.width !== undefined || a.height !== undefined)) {
      this.viewport = { width: a.width ?? this._vp().width, height: a.height ?? this._vp().height };
    }
    const vp = this._vp();
    // Set the size before every action: a recording frame may have changed it since the last one.
    await this._send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false });
    const point = (x, y, name = 'x,y') => {
      if (!Number.isInteger(x) || !Number.isInteger(y)) throw new KernelError('EINVAL', `EINVAL: ${name} must be whole pixel numbers`);
      if (x < 0 || y < 0 || x >= vp.width || y >= vp.height) {
        throw new KernelError('EINVAL', `EINVAL: (${x}, ${y}) is outside the ${vp.width}x${vp.height} viewport`);
      }
      return { x, y };
    };
    const need = (value, what) => {
      if (value === undefined || value === null) throw new KernelError('EINVAL', `EINVAL: ${action} needs ${what}`);
      return value;
    };
    let result = {};
    switch (action) {
      case 'screenshot':
        break;
      case 'move': {
        const p = point(need(a.x, 'x'), need(a.y, 'y'));
        await this._mouse('mouseMoved', p.x, p.y, 0, 'none', 0, 0);
        break;
      }
      case 'click':
      case 'double_click':
      case 'right_click':
      case 'middle_click': {
        const p = point(need(a.x, 'x'), need(a.y, 'y'));
        const { button, count } = CLICKS[action];
        const modifiers = modifierBits(a.modifiers);
        result = await this._acting(async () => {
          for (let n = 1; n <= count; n++) {
            await this._mouse('mousePressed', p.x, p.y, BUTTON_BITS[button], button, n, modifiers);
            await this._mouse('mouseReleased', p.x, p.y, 0, button, n, modifiers);
          }
        });
        break;
      }
      case 'drag': {
        const from = point(need(a.x, 'x'), need(a.y, 'y'));
        const to = point(need(a.to_x, 'to_x'), need(a.to_y, 'to_y'), 'to_x,to_y');
        await this._mouse('mousePressed', from.x, from.y, BUTTON_BITS.left, 'left', 1, 0);
        for (let i = 1; i <= DRAG_STEPS; i++) {
          const x = Math.round(from.x + ((to.x - from.x) * i) / DRAG_STEPS);
          const y = Math.round(from.y + ((to.y - from.y) * i) / DRAG_STEPS);
          await this._mouse('mouseMoved', x, y, BUTTON_BITS.left, 'left', 0, 0);
        }
        await this._mouse('mouseReleased', to.x, to.y, 0, 'left', 1, 0);
        break;
      }
      case 'scroll': {
        const p = a.x === undefined && a.y === undefined
          ? { x: Math.floor(vp.width / 2), y: Math.floor(vp.height / 2) }
          : point(need(a.x, 'x'), need(a.y, 'y'));
        const dx = a.delta_x ?? 0;
        const dy = a.delta_y ?? 0;
        if (!Number.isInteger(dx) || !Number.isInteger(dy) || (dx === 0 && dy === 0)) {
          throw new KernelError('EINVAL', 'EINVAL: scroll needs a whole-number delta_x or delta_y (pixels; positive scrolls down)');
        }
        await this._send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: dx, deltaY: dy });
        await sleep(150); // give the page a moment to scroll before the screenshot
        break;
      }
      case 'type': {
        const text = String(need(a.text, 'text'));
        if ([...text].length > 10_000) throw new KernelError('EINVAL', 'EINVAL: type takes at most 10,000 characters');
        result = await this._acting(async () => {
          for (const ch of text) {
            if (ch === '\n') await this._press('Enter', 0);
            else await this._press(ch, 0);
          }
        });
        break;
      }
      case 'key': {
        const name = need(a.key, 'key');
        result = await this._acting(() => this._press(name, modifierBits(a.modifiers)));
        break;
      }
      case 'wait': {
        const ms = need(a.duration_ms, 'duration_ms');
        if (!Number.isInteger(ms) || ms < 0 || ms > WAIT_MAX_MS) {
          throw new KernelError('EINVAL', `EINVAL: duration_ms must be a whole number from 0 to ${WAIT_MAX_MS}`);
        }
        await sleep(ms);
        break;
      }
      default:
        throw new KernelError('EINVAL', `EINVAL: unknown computer action ${JSON.stringify(action)}`);
    }
    const state = await this._page('state');
    return {
      navigated: false,
      status: null,
      ...result,
      viewport: { ...vp },
      url: state.url,
      title: state.title,
      png: Buffer.from(await this._screenshot(vp), 'base64'),
    };
  }

  _vp() {
    return this.viewport ?? DEFAULT_VIEWPORT;
  }

  async _mouse(type, x, y, buttons, button, clickCount, modifiers) {
    await this._send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount, modifiers });
  }

  /** One key press: key down (with its text, unless a Ctrl or Meta shortcut), then key up. */
  async _press(name, modifiers) {
    const info = keyInfo(name);
    const shifted = (modifiers & MODIFIER_BITS.shift) !== 0;
    const text = info.text === undefined ? undefined : (shifted && /^[a-z]$/.test(info.text) ? info.text.toUpperCase() : info.text);
    const key = text !== undefined && !Object.hasOwn(NAMED_KEYS, name) ? text : info.key;
    const base = { key, code: info.code, windowsVirtualKeyCode: info.vk, modifiers };
    const withText = text !== undefined && (modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta)) === 0;
    await this._send('Input.dispatchKeyEvent', withText
      ? { type: 'keyDown', text, unmodifiedText: text, ...base }
      : { type: 'rawKeyDown', ...base });
    await this._send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** PNG of the page as base64 (Can.browse('screenshot') returns it this way). */
  async _screenshot({ fullPage = false, width = 1280, height = 800 }) {
    await this._send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const { data } = await this._send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage === true });
    return data;
  }

  async close() {
    await super.close();
    await this.canProxy?.close();
    this.canProxy = null;
  }
}

/**
 * One CanChromium per can, made on first use. `for(can)` returns the browser calls the MCP tools make on a can:
 * {browse, screenshot}, with the same shapes as Can.browse and Can.screenshot.
 */
export class ChromiumBrowsers {
  constructor({ executable = findBrowserExecutable() } = {}) {
    this.executable = executable;
    this.entries = new Map(); // can id -> {can, chromium}
  }

  for(can) {
    let entry = this.entries.get(can.id);
    if (!entry) {
      entry = { can, chromium: null };
      entry.chromium = new CanChromium({
        canFor: () => entry.can,
        internet: can.policy?.internet !== false,
        executable: this.executable,
      });
      this.entries.set(can.id, entry);
    }
    entry.can = can; // a reloaded can is a new object with the same id
    const { chromium } = entry;
    return {
      browse: (action, ...args) => chromium.browse(action, ...args),
      screenshot: async (opts) => Buffer.from(await chromium.browse('screenshot', opts), 'base64'),
      computer: (action, args) => chromium.computer(action, args),
    };
  }

  /** Closes the browser of one can (by id) and deletes its temporary profile. */
  async close(id) {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    await entry?.chromium.close();
  }

  async closeAll() {
    for (const id of [...this.entries.keys()]) await this.close(id);
  }
}
