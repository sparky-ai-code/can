// The real-Chromium backend for cans (src/canchromium.js, src/canproxy.js, src/chromium-page.js). The proxy rules are
// tested without a browser. The browser tests drive a real Chrome or Edge and are skipped when none is installed.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CanRegistry } from '../src/registry.js';
import { ChromiumBrowsers } from '../src/canchromium.js';
import { startCanProxy, isCanHost, resolveOutbound } from '../src/canproxy.js';
import { chromiumBrowserEnabled } from '../src/mounts.js';
import { findBrowserExecutable } from '../src/hostbrowser.js';
import { createTools } from '../src/mcp/tools.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-chromium-'));
const executable = findBrowserExecutable();

const SERVER = `
const http = require('http');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Home</title><h1>Hello can</h1><a href="/next">Next page</a>' +
      '<form action="/submit"><label>Search <input name="q"></label><button>Go</button></form>' +
      '<script>console.log("page script ran")</script>');
  } else if (url.pathname === '/next') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Next</title><h1>Next</h1><p>second page</p>');
  } else if (url.pathname === '/submit') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Done</title><p>you searched for ' + url.searchParams.get('q') + '</p>');
  } else if (url.pathname === '/hello') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, from: 'the can' }));
  } else {
    res.writeHead(404); res.end('nope');
  }
}).listen(8080, () => console.log('up'));
`;

async function until(check, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A raw request through the proxy. The path is the absolute URL, as a browser sends it. */
function viaProxy(proxyUrl, url, { method = 'GET' } = {}) {
  const { port } = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: new URL(url).host } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A CONNECT request through the proxy. Resolves with the status line the proxy answered with. */
function connectVia(proxyUrl, target) {
  const { port } = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the proxy: which hosts count as the can', () => {
  test('localhost, its subdomains and the loopback literals are the can', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '[::1]', '::1']) assert.equal(isCanHost(h), true, h);
    for (const h of ['example.com', '127.0.0.2', 'localhost.example.com', '10.0.0.5']) assert.equal(isCanHost(h), false, h);
  });

  test('an outbound name that resolves to this machine is refused', async () => {
    await assert.rejects(resolveOutbound('127.0.0.2'), (err) => err.status === 403);
    await assert.rejects(resolveOutbound('0.0.0.0'), (err) => err.status === 403);
    const ok = await resolveOutbound('93.184.216.34');
    assert.equal(ok.address, '93.184.216.34');
  });
});

describe('the proxy: routing into the can (no browser needed)', () => {
  let reg;
  let can;
  let proxy;
  let offline;

  before(async () => {
    reg = new CanRegistry({ storeDir: path.join(tmp, 'store-proxy') });
    can = await reg.create('proxy-can');
    await can.mkdir('/app', { recursive: true });
    await can.writeFile('/app/server.js', SERVER);
    await can.spawn('node server.js', { cwd: '/app', background: true });
    await until(async () => (await can.listeners()).some((l) => l.port === 8080));
    proxy = await startCanProxy({ canFor: () => can, internet: true });
    offline = await startCanProxy({ canFor: () => can, internet: false });
  });

  after(async () => {
    await proxy?.close();
    await offline?.close();
    await reg.shutdown({ save: false });
  });

  test('a localhost request reaches the server inside the can', async () => {
    const r = await viaProxy(proxy.url, 'http://localhost:8080/hello');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true, from: 'the can' });
  });

  test('a port with no server answers 502 and says so', async () => {
    const r = await viaProxy(proxy.url, 'http://localhost:9/');
    assert.equal(r.status, 502);
    assert.match(r.body, /nothing is listening on port 9 inside the can/);
  });

  test('a can with no internet refuses every other host, before any lookup', async () => {
    const r = await viaProxy(offline.url, 'http://example.com/');
    assert.equal(r.status, 403);
    assert.match(r.body, /no internet access/);
    assert.equal(await connectVia(offline.url, 'example.com:443'), 403);
    // The can itself still answers.
    assert.equal((await viaProxy(offline.url, 'http://localhost:8080/hello')).status, 200);
  });

  test('host services are not reachable: a loopback address is refused outbound, and CONNECT to the can is refused', async () => {
    const r = await viaProxy(proxy.url, 'http://127.0.0.2:9/');
    assert.equal(r.status, 403);
    assert.match(r.body, /this machine/);
    assert.equal(await connectVia(proxy.url, '127.0.0.2:443'), 403);
    assert.equal(await connectVia(proxy.url, 'localhost:8080'), 403, 'a can serves plain http only');
  });

  test('after close, the proxy no longer listens', async () => {
    const extra = await startCanProxy({ canFor: () => can, internet: true });
    const { port } = new URL(extra.url);
    await extra.close();
    await assert.rejects(
      new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(); });
        s.on('error', reject);
      }),
      (err) => err.code === 'ECONNREFUSED',
    );
  });
});

describe('the Chromium backend: the tools and the setting', () => {
  test('Chromium is the default browser; "chromiumBrowser": false selects the built-in one', () => {
    const file = path.join(tmp, 'mounts.json');
    fs.writeFileSync(file, JSON.stringify({ mounts: {} }));
    assert.equal(chromiumBrowserEnabled(file), true, 'no setting means Chromium');
    fs.writeFileSync(file, JSON.stringify({ chromiumBrowser: true }));
    assert.equal(chromiumBrowserEnabled(file), true);
    fs.writeFileSync(file, JSON.stringify({ chromiumBrowser: false }));
    assert.equal(chromiumBrowserEnabled(file), false);
    fs.writeFileSync(file, JSON.stringify({ chromiumBrowser: 'no' }));
    assert.equal(chromiumBrowserEnabled(file), true, 'only the boolean false turns it off');
    assert.equal(chromiumBrowserEnabled(path.join(tmp, 'missing.json')), true, 'a missing file keeps the default');
  });

  test('the browser tools use the Chromium backend when one is given, and the can browser otherwise', async () => {
    const seen = [];
    const fakeCan = { id: 'x', browse: async (a) => { seen.push(['can', a]); return 'can'; } };
    const fakeReg = { get: async () => fakeCan, save: async () => {} };
    const browsers = { for: () => ({ browse: async (a) => { seen.push(['chromium', a]); return 'chromium'; } }) };
    const text = (tools) => tools.find((t) => t.name === 'browser_text');
    await text(createTools(fakeReg, { browsers })).run({ can: 'x' });
    await text(createTools(fakeReg, {})).run({ can: 'x' });
    assert.deepEqual(seen, [['chromium', 'text'], ['can', 'text']]);
  });

  test('an unsupported action fails with ENOTSUP instead of doing nothing', async () => {
    const hb = new ChromiumBrowsers({ executable: null }).for({ id: 'nope', policy: { internet: true }, name: 'nope' });
    await assert.rejects(hb.browse('printToPdf'), (err) => err.code === 'ENOTSUP');
  });
});

describe('the Chromium backend: a real Chrome or Edge', { skip: executable ? false : 'no Chrome or Edge is installed' }, () => {
  let reg;
  let can;
  let browsers;
  let b;
  let hostServer;
  let hostPort;

  before(async () => {
    reg = new CanRegistry({ storeDir: path.join(tmp, 'store-chrome') });
    can = await reg.create('web');
    await can.mkdir('/app', { recursive: true });
    await can.writeFile('/app/server.js', SERVER);
    await can.spawn('node server.js', { cwd: '/app', background: true });
    await until(async () => (await can.listeners()).some((l) => l.port === 8080));
    // A server on this machine, outside the can. The browser must not reach it.
    hostServer = http.createServer((req, res) => res.end('HOST SECRET'));
    await new Promise((resolve) => hostServer.listen(0, '127.0.0.1', resolve));
    hostPort = hostServer.address().port;
    browsers = new ChromiumBrowsers();
    b = browsers.for(can);
  }, { timeout: 60_000 });

  after(async () => {
    await browsers?.closeAll();
    await new Promise((resolve) => (hostServer ? hostServer.close(resolve) : resolve()));
    await reg?.shutdown({ save: false });
  });

  test('goto opens a can page with its HTTP status and title', async () => {
    const s = await b.browse('goto', 'http://localhost:8080/');
    assert.equal(s.status, 200);
    assert.equal(s.title, 'Home');
    assert.equal(s.url, 'http://localhost:8080/');
  });

  test('the snapshot lists headings, links, fields and buttons with refs', async () => {
    const snap = await b.browse('snapshot');
    assert.match(snap, /^Page: "Home"/m);
    assert.match(snap, /^- heading "Hello can" level=1$/m);
    assert.match(snap, /^- link "Next page" \[e\d+\] -> "\/next"$/m);
    assert.match(snap, /^- textbox "Search" \[e\d+\]$/m);
    assert.match(snap, /^- button "Go" \[e\d+\]$/m);
  });

  test('click follows a link by its visible text and waits for the new page', async () => {
    const r = await b.browse('click', 'Next page');
    assert.equal(r.navigated, true);
    assert.equal(r.status, 200);
    assert.match(await b.browse('text'), /second page/);
  });

  test('back returns to the first page', async () => {
    const r = await b.browse('back');
    assert.equal(r.navigated, true);
    assert.equal((await b.browse('state')).title, 'Home');
  });

  test('type fills a field by its label, and submit sends the form', async () => {
    const typed = await b.browse('type', 'Search', 'cats');
    assert.deepEqual(typed, { value: 'cats' });
    const r = await b.browse('submit');
    assert.equal(r.navigated, true);
    assert.match(await b.browse('text'), /you searched for cats/);
  });

  test('evaluate runs an expression, or statements with a return', async () => {
    assert.equal(await b.browse('evaluate', 'document.title'), 'Done');
    assert.equal(await b.browse('evaluate', 'const x = 2; return x * 21;'), 42);
  });

  test('console messages from the page are kept, and clearConsole empties them', async () => {
    const state = await b.browse('state');
    assert.ok(state.consoleLog.some((m) => m.level === 'log' && m.text === 'page script ran'));
    await b.browse('clearConsole');
    assert.deepEqual((await b.browse('state')).consoleLog, []);
  });

  test('a screenshot is a real PNG of the page', async () => {
    const png = await b.screenshot({ width: 400, height: 300 });
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(png.length > 500);
  });

  test('a page cannot reach a server on this machine outside the can', async () => {
    // The proxy sends 127.0.0.1 to the can, and nothing listens there. The action fails as the built-in browser's does.
    await assert.rejects(b.browse('goto', `http://127.0.0.1:${hostPort}/`), (err) => err.code === 'ECONNREFUSED');
    assert.doesNotMatch(await b.browse('text'), /HOST SECRET/);
  });

  test('the browser tools drive the same Chromium through the MCP tool layer', async () => {
    const tools = createTools(reg, { browsers });
    const tool = (name) => tools.find((t) => t.name === name);
    const out = await tool('browser_goto').run({ can: 'web', url: 'http://localhost:8080/' });
    assert.match(out, /HTTP status: 200/);
    assert.match(out, /heading "Hello can"/);
    const shot = await tool('browser_screenshot').run({ can: 'web', path: '/tmp/shots/home.png' });
    assert.match(shot.text, /canPath: \/tmp\/shots\/home\.png/);
    assert.equal(shot.images[0].mimeType, 'image/png');
  });

  test('closeAll stops the browser and its proxy, and forgets the can', async () => {
    const chromium = browsers.entries.get(can.id).chromium;
    assert.notEqual(chromium.proc, null, 'the browser is running before the close');
    await browsers.closeAll();
    assert.equal(browsers.entries.size, 0);
    assert.equal(chromium.proc, null);
    assert.equal(chromium.canProxy, null);
    assert.equal(chromium.ws, null);
  });
});

// Live sites: they depend on the network and change over time, so they run only when asked for.
// CAN_LIVE_TESTS=1 node --test test/chromium.test.js
describe('the Chromium backend: live websites', { skip: !process.env.CAN_LIVE_TESTS ? 'set CAN_LIVE_TESTS=1 to load real websites' : (executable ? false : 'no Chrome or Edge is installed') }, () => {
  let reg;
  let browsers;
  let b;

  before(async () => {
    reg = new CanRegistry({ storeDir: path.join(tmp, 'store-live') });
    const can = await reg.create('live');
    browsers = new ChromiumBrowsers();
    b = browsers.for(can);
  }, { timeout: 60_000 });

  after(async () => {
    await browsers?.closeAll();
    await reg?.shutdown({ save: false });
  });

  test('example.com loads, and its link leads to iana.org', async () => {
    const s = await b.browse('goto', 'https://example.com/');
    assert.equal(s.status, 200);
    assert.equal(s.title, 'Example Domain');
    const r = await b.browse('click', 'Learn more');
    assert.equal(r.navigated, true);
    assert.match((await b.browse('state')).url, /^https:\/\/(www\.)?iana\.org\//);
  });

  test('Wikipedia search: type into the visible search box, submit, and land on results', async () => {
    const s = await b.browse('goto', 'https://en.wikipedia.org/wiki/Special:Search');
    assert.equal(s.status, 200);
    assert.deepEqual(await b.browse('type', 'Search Wikipedia', 'Chromium'), { value: 'Chromium' });
    const r = await b.browse('submit', 'Search Wikipedia');
    assert.equal(r.navigated, true);
    assert.match(await b.browse('text'), /Search results/);
  });
});
