// CanManager's opt-in VM backend: create({backend: 'vm'}) makes a VM can, and get, list and destroy find it next to the
// lite cans. Without a backend argument, cans are lite as before. The VM tests need the VM files (see
// test/vm-guest.test.js); the argument checks run anywhere.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';
import { vmInstalled, vmPaths } from '../src/vm/qemu.js';

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-manager-vm-'));
const manager = new CanManager({ storeDir });

after(async () => {
  await manager.destroy('vmweb').catch(() => {});
  fs.rmSync(storeDir, { recursive: true, force: true });
});

test('an unknown backend is refused before anything starts', async () => {
  await assert.rejects(() => manager.create({ name: 'x', backend: 'docker' }), (err) => err.code === 'EINVAL');
});

describe('CanManager with the VM backend', { skip: vmInstalled(vmPaths()) ? false : 'the VM is not installed (set CAN_QEMU and CAN_GUEST_DIR to run these)' }, () => {
  test('create with backend vm returns a VM can that get, list and destroy find', { timeout: 120000 }, async () => {
    const can = await manager.create({ name: 'vmweb', backend: 'vm' });
    assert.equal(can.status, 'running');
    assert.equal(manager.get('vmweb'), can);
    assert.ok(manager.list().includes(can), 'list includes the VM can');
    const r = await can.exec('echo through the manager');
    assert.equal(r.stdout, 'through the manager\n');
    await manager.destroy('vmweb');
    assert.equal(manager.get('vmweb'), undefined);
    assert.equal(can.status, 'stopped');
  });

  test('a VM can refuses mounts and environments, which the VM does not provide yet', async () => {
    await assert.rejects(() => manager.create({ name: 'vmbad', backend: 'vm', mounts: [{ label: 'x', canPath: '/x' }] }),
      (err) => err.code === 'ENOTSUP');
  });
});
