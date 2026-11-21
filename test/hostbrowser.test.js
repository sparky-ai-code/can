// The opt-in host browser (src/hostbrowser.js): off by default, only http and https, and a real Chrome or Edge on
// this machine when one is installed. The browser tests are skipped when no browser is found.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HostBrowser, checkHostUrl, findBrowserExecutable } from '../src/hostbrowser.js';
import { hostBrowserEnabled } from '../src/mounts.js';
import { createHostBrowserTools } from '../src/mcp/tools.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-hostbrowser-'));
const executable = findBrowserExecutable();
const haveBrowser = Boolean(executable);

describe('host browser: defaults and URL rules', () => {
  test('it is off unless the mounts file says "hostBrowser": true', () => {
    const file = path.join(tmp, 'off.json');
    fs.writeFileSync(file, JSON.stringify({ mounts: {} }));
    assert.equal(hostBrowserEnabled(file), false);
    fs.writeFileSync(file, JSON.stringify({ hostBrowser: 'yes' }));
    assert.equal(hostBrowserEnabled(file), false, 'only the boolean true turns it on');
    fs.writeFileSync(file, JSON.stringify({ hostBrowser: true }));
    assert.equal(hostBrowserEnabled(file), true);
    assert.equal(hostBrowserEnabled(path.join(tmp, 'missing.json')), false);
  });

  test('only http and https pages may be opened', () => {
    assert.equal(checkHostUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(checkHostUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080/');
    for (const bad of ['file:///C:/Windows/win.ini', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,x']) {
      assert.throws(() => checkHostUrl(bad), { code: 'EPERM' }, bad);
    }
    assert.throws(() => checkHostUrl('not a url'), { code: 'EINVAL' });
  });

  test('the tools exist only when a host browser is given', () => {
    assert.deepEqual(createHostBrowserTools(null), []);
    const names = createHostBrowserTools(new HostBrowser({ executable: null })).map((t) => t.name);
    assert.deepEqual(names, ['host_browser_goto', 'host_browser_text', 'host_browser_evaluate', 'host_browser_screenshot', 'host_browser_close']);
  });

  test('with no browser installed, the first use fails with a clear message', async () => {
    const hb = new HostBrowser({ executable: null });
    await assert.rejects(hb.goto('https://example.com/'), (err) => err.code === 'ENOENT' && /CAN_HOST_BROWSER/.test(err.message));
    await hb.close(); // safe to call when nothing started
  });
});

describe('host browser: a real Chrome or Edge', { skip: haveBrowser ? false : 'no Chrome or Edge is installed' }, () => {
  let server;
  let base;
  let hb;
  const transferRoot = path.join(tmp, 'transfer');

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Host page</title><body><h1>Hello from the host</h1>'
          + '<script>document.body.dataset.ready = "yes";</script></body>');
        return;
      }
      res.writeHead(404);
      res.end('no');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    fs.mkdirSync(transferRoot, { recursive: true });
    hb = new HostBrowser({ executable });
  });

  after(async () => {
    try {
      await hb?.close();
    } finally {
      server?.closeAllConnections();
      server?.close();
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  });

  test('opens a page, reads its title and text, and runs script in it', async () => {
    const s = await hb.goto(`${base}/page`);
    assert.equal(s.title, 'Host page');
    assert.equal(s.url, `${base}/page`);
    assert.match(await hb.text(), /Hello from the host/);
    assert.equal(await hb.evaluate('document.body.dataset.ready'), 'yes');
    assert.equal(await hb.evaluate('1 + 2'), 3);
  });

  test('a screenshot is a PNG under the transfer root; a file outside it is refused', async () => {
    await hb.screenshot('shot.png', { root: transferRoot });
    const bytes = fs.readFileSync(path.join(transferRoot, 'shot.png'));
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await assert.rejects(hb.screenshot('../escape.png', { root: transferRoot }), { code: 'EPERM' });
  });

  test('a page that cannot be reached is an error, not a hang', async () => {
    await assert.rejects(hb.goto('http://127.0.0.1:1/'), (err) => err.code === 'ECONNREFUSED' || err.code === 'EIO');
  });

  test('close deletes the temporary profile, and the next use starts a fresh browser', async () => {
    const profile = hb.profile;
    await hb.close();
    assert.equal(fs.existsSync(profile), false);
    const s = await hb.goto(`${base}/page`);
    assert.equal(s.title, 'Host page');
  });
});
