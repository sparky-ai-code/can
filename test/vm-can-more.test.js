// The VM can's setCwd, stat, memoryInfo and snapshot (src/vm/vm-can.js) against a real guest. Needs the VM files: set
// CAN_QEMU and CAN_GUEST_DIR (see test/vm-guest.test.js). Without them the tests are skipped.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VmCanManager } from '../src/vm/vm-can.js';
import { vmInstalled, vmPaths } from '../src/vm/qemu.js';

const SKIP = vmInstalled(vmPaths()) ? false : 'the VM is not installed (set CAN_QEMU and CAN_GUEST_DIR to run these)';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-vmmore-'));
const manager = new VmCanManager({ dir, memMB: 256 });

after(async () => {
  await manager.shutdown().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a VM can: setCwd, stat, memoryInfo, snapshot', { skip: SKIP }, () => {
  let can;

  test('create a can for these tests', { timeout: 120000 }, async () => {
    can = await manager.create({ name: 'more' });
    assert.equal(can.status, 'running');
  });

  test('setCwd makes the folder the default for exec and spawn; a missing folder or a file is refused', { timeout: 60000 }, async () => {
    await can.mkdir('work/app', { recursive: true });
    await can.writeFile('work/file.txt', 'x');
    await can.setCwd('work/app');
    assert.equal((await can.exec('pwd')).stdout, '/opt/can/home/work/app\n');
    const p = await can.spawn('pwd');
    await can.wait(p.pid, 10000);
    assert.equal(p.command, 'pwd');
    assert.equal((await can.exec('pwd', { cwd: '/' })).stdout, '/\n'); // an explicit cwd still wins
    await assert.rejects(can.setCwd('work/missing'), (e) => e.code === 'ENOENT');
    await assert.rejects(can.setCwd('work/file.txt'), (e) => e.code === 'ENOTDIR');
    assert.equal((await can.exec('pwd')).stdout, '/opt/can/home/work/app\n'); // a refused setCwd changes nothing
    await can.setCwd('/opt/can/home');
  });

  test('stat reports the type, size, mode and mtime; a missing path is ENOENT', { timeout: 60000 }, async () => {
    await can.mkdir('stat', { recursive: true });
    await can.writeFile('stat/data.bin', Buffer.alloc(1234, 7), { mode: 0o640 });
    const f = await can.stat('stat/data.bin');
    assert.equal(f.type, 'file');
    assert.equal(f.size, 1234);
    assert.equal(f.mode, 0o640);
    assert.ok(f.mtime instanceof Date && f.mtime.getTime() > 0);
    assert.equal(f.isFile(), true);
    assert.equal(f.isDirectory(), false);

    const d = await can.stat('stat');
    assert.equal(d.type, 'dir');
    assert.equal(d.isDirectory(), true);

    await assert.rejects(can.stat('stat/nothing-here'), (e) => e.code === 'ENOENT');
  });

  test('memoryInfo: the limit is the memory the can was started with, and used is inside it', { timeout: 60000 }, async () => {
    const m = await can.memoryInfo();
    assert.equal(m.limitBytes, 256 * 1024 * 1024);
    assert.equal(m.softBytes, m.limitBytes);
    assert.equal(m.enforced, 'guest');
    assert.ok(m.usedBytes > 0, 'the guest reports memory in use');
    assert.ok(m.usedBytes <= m.limitBytes, 'used memory is within the limit');
  });

  test('snapshot flushes the disk and returns the can disk path', { timeout: 60000 }, async () => {
    await can.mkdir('snap', { recursive: true });
    await can.writeFile('snap/keep.txt', 'kept');
    const s = await can.snapshot();
    assert.equal(s.disk, can.overlay);
    assert.ok(fs.existsSync(s.disk), 'the disk is on the host');
    assert.ok(!Number.isNaN(Date.parse(s.savedAt)));
  });
});
