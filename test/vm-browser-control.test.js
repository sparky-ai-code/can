// Interactive browser control in a VM can (src/vm/vm-chromium.js): the browser runs in the guest, its DevTools endpoint is
// reached over a raw stream, and the page actions (goto, snapshot, type, click, text, evaluate, screenshot) answer the
// same way they do on a lite can. Needs the VM files, the tools disk and the browser disk; without them the tests are
// skipped.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VmCanManager } from '../src/vm/vm-can.js';
import { vmInstalled, vmPaths } from '../src/vm/qemu.js';
import { ChromiumBrowsers } from '../src/canchromium.js';

const paths = vmPaths();
const SKIP = vmInstalled(paths) && fs.existsSync(paths.tools) && fs.existsSync(paths.browser)
  ? false : 'the VM, the tools disk or the browser disk is not installed';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-vm-control-'));
const manager = new VmCanManager({ dir });

after(async () => {
  for (const can of manager.list()) await manager.destroy(can.id).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

const PAGE = `<!doctype html>
<html><head><title>Form demo</title></head>
<body>
<h1>Hello form</h1>
<label>Name <input id="name" name="name"></label>
<button onclick="document.getElementById('out').textContent = 'Hi ' + document.getElementById('name').value">Save</button>
<p id="out"></p>
</body></html>`;

describe('interactive browser control in a VM can', { skip: SKIP }, () => {
  let can;

  test('a browser can serves a page and the page actions answer: goto, snapshot, type, click, text', { timeout: 400000 }, async () => {
    can = await manager.create({ name: 'ctl', browser: true });
    assert.equal(can.backend, 'vm');
    // The MCP tools reach a VM can's own browser: ChromiumBrowsers hands the can back, not a host browser.
    assert.equal(new ChromiumBrowsers({ executable: null }).for(can), can);

    await can.mkdir('site', { recursive: true });
    await can.writeFile('site/index.html', PAGE);
    await can.spawn('/bin/busybox httpd -f -p 8080 -h /opt/can/home/site', { cwd: '/' });
    for (let i = 0; i < 50; i++) {
      try {
        const r = await can.request({ port: 8080, path: '/', timeout: 2000 });
        if (r.status === 200) break;
      } catch { /* the server is still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const went = await can.browse('goto', 'http://localhost:8080/');
    assert.equal(went.status, 200);

    const snap = await can.browse('snapshot');
    assert.match(snap, /Page: "Form demo"/);
    assert.match(snap, /\[e\d+\]/, 'the snapshot lists elements with refs');

    await can.browse('type', '#name', 'Ada');
    await can.browse('click', 'Save');
    const text = await can.browse('text');
    assert.match(text, /Hi Ada/);

    const title = await can.browse('evaluate', 'document.title');
    assert.equal(title, 'Form demo');
  });

  test('a screenshot of the active page is a PNG', { timeout: 120000 }, async () => {
    const png = await can.screenshot({ width: 400, height: 300 });
    assert.deepEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'a PNG');
    assert.ok(png.length > 1000, 'the screenshot has content');
  });

  test('a can without the browser refuses the page actions with ENOTSUP', { timeout: 300000 }, async () => {
    const plain = await manager.create({ name: 'plain' });
    await assert.rejects(plain.browse('snapshot'), (e) => e.code === 'ENOTSUP');
    await assert.rejects(plain.screenshot(), (e) => e.code === 'ENOTSUP');
    await manager.destroy(plain.id);
  });

  test('destroy closes the browser and powers the guest off', { timeout: 120000 }, async () => {
    await manager.destroy(can.id);
    assert.equal(can.status, 'stopped');
  });
});
