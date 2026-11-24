// The Chromium browser of a VM can. It is CanChromium (src/canchromium.js) with the browser started inside the guest
// instead of on the host, and its DevTools endpoint reached through a raw stream to the guest (src/vm/ws-client.js).
// Every page action (snapshot, click, type, select, text, computer use) is inherited, so a VM can answers the same way
// a lite can does.
//
// Network: the guest's own network applies (VmCan's internet flag), so no host proxy is involved. The browser reaches
// the can's servers on the guest's localhost, as the guest itself does.
import { CanChromium, PAGE_SCRIPT } from '../canchromium.js';
import { openGuestWebSocket } from './ws-client.js';

const DEVTOOLS_PORT = 9222;
const START_TIMEOUT_MS = 30000;
const POLL_MS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function guestError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

export class VmChromium extends CanChromium {
  /** @param {object} o  o.can is the VmCan the browser runs in */
  constructor({ can }) {
    super({ canFor: () => can, internet: true, executable: null });
    this.can = can;
    this.guestPid = null;
  }

  /** Starts Chromium in the guest and attaches to its first page, as HostBrowser does on the host. */
  async _launch() {
    const profile = `/tmp/devtools-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const flags = [
      'FONTCONFIG_FILE=/opt/browser/fonts.conf', 'LD_LIBRARY_PATH=/opt/browser/lib', '/opt/browser/chrome/chrome',
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--remote-debugging-port=${DEVTOOLS_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
      'about:blank',
    ];
    const started = await this.can.spawn(flags.join(' '), { cwd: '/' });
    this.guestPid = started.pid;

    const wsPath = await this.#devtoolsPath();
    this.ws = await openGuestWebSocket(await this.can.connect(DEVTOOLS_PORT), {
      host: `127.0.0.1:${DEVTOOLS_PORT}`,
      path: wsPath,
    });
    this.ws.onclose = () => { this.ws = null; this.session = null; };
    this.ws.onmessage = (ev) => this._onMessage(JSON.parse(String(ev.data)));

    const { targetId } = await this._send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this._send('Target.attachToTarget', { targetId, flatten: true });
    this.session = sessionId;
    await this._send('Page.enable');
    await this._send('Runtime.enable');

    // The same setup CanChromium makes after its host launch (see src/canchromium.js _launch).
    const tree = await this._send('Page.getFrameTree');
    this.mainFrameId = tree.frameTree.frame.id;
    await this._send('Network.enable');
    await this._send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SCRIPT });
    await this._eval(PAGE_SCRIPT);
  }

  /**
   * GET on the DevTools port over a raw stream. Chromium's HTTP server does not close the connection after its reply, so
   * the reply is read to its Content-Length (VmCan.request waits for the end of the stream and would time out).
   */
  async #get(pathname) {
    const stream = await this.can.connect(DEVTOOLS_PORT);
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let timer = null;
      const finish = (err, value) => {
        clearTimeout(timer);
        stream.destroy();
        if (err) reject(err);
        else resolve(value);
      };
      timer = setTimeout(() => finish(guestError('ETIMEDOUT', `no reply from ${pathname} on the DevTools port`)), 3000);
      stream.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]);
        const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
        if (buf.length - (end + 4) >= length) {
          finish(null, { status, body: buf.subarray(end + 4, end + 4 + length) });
        }
      });
      stream.on('error', (err) => finish(err));
      stream.on('close', () => finish(guestError('EIO', `the DevTools port closed before ${pathname} was answered`)));
      stream.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${DEVTOOLS_PORT}\r\nConnection: close\r\n\r\n`);
    });
  }

  /** Polls the browser's DevTools HTTP endpoint until it answers; returns the browser's WebSocket path. */
  async #devtoolsPath() {
    const end = Date.now() + START_TIMEOUT_MS;
    let last = null;
    for (;;) {
      try {
        const r = await this.#get('/json/version');
        if (r.status === 200) {
          const { webSocketDebuggerUrl: url } = JSON.parse(r.body.toString('utf8'));
          return new URL(url).pathname;
        }
        last = `HTTP ${r.status}`;
      } catch (err) {
        last = err.message;
      }
      if (Date.now() > end) {
        throw guestError('ETIMEDOUT', `the browser in the can did not open its DevTools port within ${START_TIMEOUT_MS} ms (${last})`);
      }
      await sleep(POLL_MS);
    }
  }

  /** Closes the browser, then powers its guest process off. Safe to call more than once. */
  async close() {
    await super.close();
    const pid = this.guestPid;
    this.guestPid = null;
    if (pid !== null) await this.can.kill(pid, 'SIGKILL').catch(() => {});
  }
}
