// Opt-in host browser. It drives a Chrome or Edge already installed on this machine through the Chrome DevTools
// Protocol. This browser is real: it runs on the host, uses the host's network, and can reach anything the host can
// reach, including services on localhost. It is not a sandbox, so it is off unless the user sets
// "hostBrowser": true in the mounts file (src/mounts.js). It uses a fresh temporary profile, so it shares no cookies
// or logins with the user's own browser. It only loads http and https URLs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KernelError } from './kernel/errors.js';
import { writeTransferFile, defaultTransferRoot } from './transfer.js';

const COMMAND_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 20_000;

/** Where to look for a browser executable. CAN_HOST_BROWSER, if set, is tried first. */
export function browserCandidates(env = process.env) {
  const pf = env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA ?? '';
  return [
    env.CAN_HOST_BROWSER,
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
}

export function findBrowserExecutable(env = process.env) {
  return browserCandidates(env).find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) ?? null;
}

/** Only http and https pages may be opened. file:, chrome:, data: and the rest are refused. */
export function checkHostUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new KernelError('EINVAL', `EINVAL: not a URL: ${JSON.stringify(String(raw))}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new KernelError('EPERM', `EPERM: the host browser opens only http and https URLs, not ${url.protocol}`);
  }
  return url.href;
}

export class HostBrowser {
  /**
   * @param {object} [opts]
   * @param {string|null} [opts.executable] browser to start (default: findBrowserExecutable())
   * @param {string|null} [opts.proxyUrl] HTTP proxy the browser sends every request through (see src/canproxy.js);
   *   localhost is not bypassed, so the proxy decides where each request goes
   */
  constructor({ executable = findBrowserExecutable(), proxyUrl = null } = {}) {
    this.executable = executable;
    this.proxyUrl = proxyUrl;
    this.proc = null;
    this.ws = null;
    this.session = null;
    this.profile = null;
    this.nextId = 1;
    this.pending = new Map(); // command id -> {resolve, reject, timer}
    this.waiters = []; // {method, sessionId, resolve, timer}
    this.launching = null;
  }

  /** Starts the browser on first use. Concurrent calls share one launch. */
  _ensure() {
    if (this.ws && this.ws.readyState === 1) return Promise.resolve();
    this.launching ??= this._launch()
      .catch(async (err) => {
        await this.close(); // do not leave a half-started browser running
        throw err;
      })
      .finally(() => { this.launching = null; });
    return this.launching;
  }

  async _launch() {
    if (!this.executable) {
      throw new KernelError('ENOENT', 'ENOENT: no Chrome or Edge was found. Set CAN_HOST_BROWSER to the browser program.');
    }
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'can-host-browser-'));
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      ...(this.proxyUrl ? [`--proxy-server=${this.proxyUrl}`, '--proxy-bypass-list=<-loopback>'] : []),
      'about:blank',
    ];
    const proc = spawn(this.executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.once('exit', () => { this.ws?.close(); this.ws = null; });
    // If this host process exits without closing the browser, the browser must not outlive it.
    process.once('exit', () => { if (proc.exitCode === null) proc.kill(); });
    const wsUrl = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new KernelError('ETIMEDOUT', 'ETIMEDOUT: the browser did not start')), LAUNCH_TIMEOUT_MS);
      proc.stderr.on('data', (chunk) => {
        text += chunk;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new KernelError('EIO', `EIO: the browser exited (${code}) before it started`));
      });
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new KernelError('ECONNREFUSED', 'ECONNREFUSED: cannot reach the browser over DevTools'));
    });
    ws.onmessage = (ev) => this._onMessage(JSON.parse(String(ev.data)));
    ws.onclose = () => { this.ws = null; this.session = null; };
    this.ws = ws;
    const page = await this._attachNewPage();
    this.targetId = page.targetId;
    this.session = page.sessionId;
  }

  /**
   * Creates a blank page target and attaches to it with its own session. The browser-level commands here take no
   * session, so this works while another page is active (the Chromium driver opens its tabs this way).
   */
  async _attachNewPage() {
    const { targetId } = await this._send('Target.createTarget', { url: 'about:blank' }, null);
    const { sessionId } = await this._send('Target.attachToTarget', { targetId, flatten: true }, null);
    await this._send('Page.enable', {}, sessionId);
    await this._send('Runtime.enable', {}, sessionId);
    return { targetId, sessionId };
  }

  _onMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new KernelError('EIO', `EIO: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      this.waiters = this.waiters.filter((w) => {
        if (w.method !== msg.method || (w.sessionId ?? null) !== (msg.sessionId ?? null)) return true;
        clearTimeout(w.timer);
        w.resolve(msg.params ?? {});
        return false;
      });
    }
  }

  _send(method, params = {}, sessionId = this.session) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new KernelError('ECONNRESET', 'ECONNRESET: the host browser has closed'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new KernelError('ETIMEDOUT', `ETIMEDOUT: ${method} did not finish in ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }

  /** Resolves with the params of the next matching DevTools event, or rejects on timeout. */
  _waitFor(method, timeoutMs = COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const w = { method, sessionId: this.session, resolve };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new KernelError('ETIMEDOUT', `ETIMEDOUT: no ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  async _eval(expression) {
    const res = await this._send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new KernelError('EVAL', `EVAL: ${d.exception?.description ?? d.text ?? 'script error'}`);
    }
    return res.result?.value;
  }

  /** Opens an http or https URL and waits for the page to load. Returns {url, title, status}. */
  async goto(url) {
    const href = checkHostUrl(url);
    await this._ensure();
    const loaded = this._waitFor('Page.loadEventFired', COMMAND_TIMEOUT_MS).catch(() => null);
    const res = await this._send('Page.navigate', { url: href });
    if (res.errorText) throw new KernelError('ECONNREFUSED', `ECONNREFUSED: ${res.errorText}`);
    await loaded;
    return this.state();
  }

  async state() {
    await this._ensure();
    return this._eval('({ url: location.href, title: document.title })');
  }

  /** Visible text of the page. */
  async text() {
    await this._ensure();
    return String((await this._eval('document.body ? document.body.innerText : ""')) ?? '');
  }

  /** Runs JavaScript in the page; the result is returned as JSON-compatible data. */
  async evaluate(code) {
    await this._ensure();
    return this._eval(String(code));
  }

  /**
   * PNG of the page, written under the transfer root (the same rules as can export). Returns the write result.
   * fullPage captures beyond the viewport.
   */
  async screenshot(hostPath, { overwrite = false, fullPage = false, root = defaultTransferRoot() } = {}) {
    await this._ensure();
    const { data } = await this._send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    return writeTransferFile(Buffer.from(data, 'base64'), hostPath, { overwrite, root });
  }

  /**
   * Closes the browser, waits for it to exit, and deletes its temporary profile. Safe to call more than once.
   * It never throws: a profile Windows still holds open is left in the temp folder.
   */
  async close() {
    if (this.ws && this.ws.readyState === 1) {
      try { await this._send('Browser.close', {}, null); } catch { /* the process may already be gone */ }
    }
    this.ws?.close();
    this.ws = null;
    this.session = null;
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill();
      const limit = new Promise((resolve) => setTimeout(resolve, 5000).unref());
      await Promise.race([exited, limit]);
    }
    const dir = this.profile;
    this.profile = null;
    for (let attempt = 0; dir && attempt < 75; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
}
