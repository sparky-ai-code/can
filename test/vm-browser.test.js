// Headless Chromium in a VM can (src/vm/vm-can.js): a can created with browser: true dumps a page's DOM and takes a
// screenshot, and a can without the browser refuses those calls with ENOTSUP. Needs the VM files, the tools disk and
// the browser disk (spike/build-browser-disk.sh); without them the tests are skipped.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VmCanManager } from '../src/vm/vm-can.js';
import { vmInstalled, vmPaths } from '../src/vm/qemu.js';

const paths = vmPaths();
const SKIP = vmInstalled(paths) && fs.existsSync(paths.tools) && fs.existsSync(paths.browser)
  ? false : 'the VM, the tools disk or the browser disk is not installed';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-vm-browser-'));
const manager = new VmCanManager({ dir });

after(async () => {
  for (const can of manager.list()) await manager.destroy(can.id).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the browser in a VM can', { skip: SKIP }, () => {
  test('a browser can dumps a page DOM and takes a screenshot with headless Chromium', { timeout: 400000 }, async () => {
    const can = await manager.create({ name: 'web', browser: true });
    const dom = await can.browserDom('data:text/html,<h1>dom check</h1>');
    assert.match(dom, /<h1>dom check<\/h1>/);
    const png = await can.browserScreenshot('data:text/html,<h1>shot check</h1>', { width: 400, height: 200 });
    assert.deepEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'a PNG');
    assert.ok(png.length > 1000, 'the screenshot has content');
  });

  test('a can without the browser refuses the browser with ENOTSUP', { timeout: 300000 }, async () => {
    const can = await manager.create({ name: 'plain' });
    await assert.rejects(() => can.browserDom('data:text/html,<p>x</p>'), (err) => err.code === 'ENOTSUP');
    await assert.rejects(() => can.browserScreenshot('data:text/html,<p>x</p>'), (err) => err.code === 'ENOTSUP');
  });
});
