// The Chromium driver's links, wait, cookie and tab actions (src/canchromium.js), against a real Chrome or Edge.
// Like the other browser tests, these are skipped when no Chrome or Edge is installed.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanRegistry } from '../src/registry.js';
import { ChromiumBrowsers } from '../src/canchromium.js';
import { findBrowserExecutable } from '../src/hostbrowser.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-chromium-tabs-'));
const executable = findBrowserExecutable();

const SERVER = `
const http = require('http');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Home</title><h1>Hello can</h1>' +
      '<a href="/next">Next page</a><a href="rel/child">Relative</a><a href="https://example.com/x">Away</a>');
  } else if (url.pathname === '/next') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Next</title><h1>Next</h1><p>second page</p>');
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

describe('the Chromium driver: links, wait, cookies and tabs', { skip: executable ? false : 'no Chrome or Edge is installed' }, () => {
  let reg;
  let browsers;
  let b;

  before(async () => {
    reg = new CanRegistry({ storeDir: path.join(tmp, 'store') });
    const can = await reg.create('tabs');
    await can.mkdir('/app', { recursive: true });
    await can.writeFile('/app/server.js', SERVER);
    await can.spawn('node server.js', { cwd: '/app', background: true });
    await until(async () => (await can.listeners()).some((l) => l.port === 8080));
    browsers = new ChromiumBrowsers();
    b = browsers.for(can);
    await b.browse('goto', 'http://localhost:8080/');
  }, { timeout: 60_000 });

  after(async () => {
    await browsers?.closeAll();
    await reg?.shutdown({ save: false });
  });

  test('links lists each link with its absolute href', async () => {
    const links = await b.browse('links');
    const byText = Object.fromEntries(links.map((l) => [l.text, l.href]));
    assert.equal(byText['Next page'], 'http://localhost:8080/next');
    assert.equal(byText.Relative, 'http://localhost:8080/rel/child');
    assert.equal(byText.Away, 'https://example.com/x');
  });

  test('wait sleeps for the time asked and returns the page summary', async () => {
    const started = Date.now();
    const s = await b.browse('wait', 300);
    assert.ok(Date.now() - started >= 250, 'waited');
    assert.equal(new URL(s.url).pathname, '/');
    assert.equal(s.title, 'Home');
  });

  test('cookieList returns a cookie the page sets', async () => {
    await b.browse('evaluate', 'document.cookie = "greet=hello; path=/"');
    const cookies = await b.browse('cookieList');
    const greet = cookies.find((c) => c.name === 'greet');
    assert.ok(greet, 'the cookie is listed');
    assert.equal(greet.value, 'hello');
    assert.equal(greet.path, '/');
    assert.equal(greet.expires, null, 'a session cookie has no expiry');
  });

  test('tabs open, switch and close, and each keeps its own page', async () => {
    const opened = await b.browse('newTab', 'http://localhost:8080/next');
    assert.equal(opened.tabs.length, 2);
    assert.equal(opened.activeTab, 1);
    assert.equal(opened.title, 'Next');

    const home = await b.browse('selectTab', 0);
    assert.equal(home.activeTab, 0);
    assert.equal(home.title, 'Home');
    assert.match(await b.browse('text'), /Hello can/);

    const next = await b.browse('selectTab', 1);
    assert.equal(next.title, 'Next');

    const closed = await b.browse('closeTab', 1);
    assert.equal(closed.tabs.length, 1);
    assert.equal(closed.activeTab, 0);
    assert.equal(closed.title, 'Home');
  });

  test('selecting a tab that does not exist is EINVAL', async () => {
    await assert.rejects(b.browse('selectTab', 5), (err) => err.code === 'EINVAL');
  });

  test('closing the last tab opens a blank one, as the built-in browser does', async () => {
    const last = await b.browse('closeTab');
    assert.equal(last.tabs.length, 1);
    assert.equal(last.activeTab, 0);
  });
});
