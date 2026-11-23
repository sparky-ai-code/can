// A VM-backed can (src/vm/vm-can.js) against a real guest, through the method shapes Can uses. Needs the VM files:
// set CAN_QEMU and CAN_GUEST_DIR (see test/vm-guest.test.js). Without them the tests are skipped.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VmCanManager } from '../src/vm/vm-can.js';
import { vmInstalled, vmPaths } from '../src/vm/qemu.js';

const SKIP = vmInstalled(vmPaths()) ? false : 'the VM is not installed (set CAN_QEMU and CAN_GUEST_DIR to run these)';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-vmcan-'));
const manager = new VmCanManager({ dir });

after(async () => {
  await manager.shutdown().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a VM can', { skip: SKIP }, () => {
  let web;

  test('create starts a guest; exec returns the output and exit code as Can does', { timeout: 120000 }, async () => {
    web = await manager.create({ name: 'web' });
    assert.equal(web.status, 'running');
    const r = await web.exec('echo hello | tr a-z A-Z');
    assert.deepEqual(
      { exitCode: r.exitCode, stdout: r.stdout, signal: r.signal, timedOut: r.timedOut },
      { exitCode: 0, stdout: 'HELLO\n', signal: null, timedOut: false },
    );
    assert.equal((await web.exec('exit 2')).exitCode, 2);
  });

  test('files: mkdir, writeFile, readFile (bytes and text), listDir, exists and rm', { timeout: 60000 }, async () => {
    await web.mkdir('project/src', { recursive: true });
    await web.writeFile('project/src/a.bin', Buffer.from([0, 255, 10]));
    assert.deepEqual(await web.readFile('project/src/a.bin'), Buffer.from([0, 255, 10]));
    await web.writeFile('project/b.txt', 'text', { mode: 0o600 });
    assert.equal(await web.readFile('project/b.txt', 'utf8'), 'text');
    assert.deepEqual(await web.listDir('project'), ['b.txt', 'src']);
    assert.equal(await web.exists('project/b.txt'), true);
    assert.equal(await web.exists('project/nope'), false);
    await web.rm('project', { recursive: true });
    assert.equal(await web.exists('project'), false);
  });

  test('background processes: spawn, ps, kill with SIGTERM, and wait for the exit', { timeout: 60000 }, async () => {
    const p = await web.spawn('sleep 30');
    assert.equal(p.status, 'running');
    const listed = (await web.ps()).find((x) => x.pid === p.pid);
    assert.equal(listed.status, 'running');
    await web.kill(p.pid, 'SIGTERM');
    const done = await web.wait(p.pid, 10000);
    assert.equal(done.status, 'exited');
    assert.equal(done.exitCode, 128 + 15);
  });

  test('network: a server in the can is listed and answers request as Can does', { timeout: 60000 }, async () => {
    await web.mkdir('www', { recursive: true });
    await web.writeFile('www/index.html', 'from the vm can\n');
    const srv = await web.spawn('/bin/busybox httpd -f -p 8080 -h /home/agent/www');
    try {
      let listed = [];
      for (let i = 0; i < 100 && !listed.some((l) => l.port === 8080); i++) {
        listed = await web.listeners();
        if (!listed.some((l) => l.port === 8080)) await sleep(100);
      }
      assert.ok(listed.some((l) => l.port === 8080), 'port 8080 is listed');
      const res = await web.request({ port: 8080, method: 'GET', path: '/' });
      assert.equal(res.status, 200);
      assert.equal(res.body.toString(), 'from the vm can\n');
    } finally {
      await web.kill(srv.pid, 'SIGKILL');
      await web.wait(srv.pid, 10000);
    }
  });

  test('what the VM does not provide yet fails with ENOTSUP, not silently', () => {
    assert.throws(() => web.openBrowser(), (err) => err.code === 'ENOTSUP');
    assert.throws(() => web.screenshot(), (err) => err.code === 'ENOTSUP');
    assert.throws(() => web.snapshot(), (err) => err.code === 'ENOTSUP');
    assert.throws(() => web.stat('x'), (err) => err.code === 'ENOTSUP');
  });

  test('the manager finds a can by name, and destroy powers its guest off', { timeout: 60000 }, async () => {
    assert.equal(manager.get('web'), web);
    assert.deepEqual(manager.list().map((c) => c.name), ['web']);
    await assert.rejects(() => manager.create({ name: 'web' }), (err) => err.code === 'EEXIST');
    await manager.destroy('web');
    assert.equal(manager.get('web'), undefined);
    assert.equal(web.status, 'stopped');
  });
});
