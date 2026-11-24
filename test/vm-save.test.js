// Save and restore of a VM can (src/vm/vm-can.js): save shuts the guest down, restore boots a new guest on the same
// disk, and a file written before the save is there after the restore. Needs the VM files and the tools disk (see
// spike/README.md); without them the tests are skipped.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VmCanManager } from '../src/vm/vm-can.js';
import { vmInstalled, vmPaths } from '../src/vm/qemu.js';

const paths = vmPaths();
const SKIP = vmInstalled(paths) && fs.existsSync(paths.tools) ? false : 'the VM or the tools disk is not installed';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-vm-save-'));
const manager = new VmCanManager({ dir });

after(async () => {
  await manager.shutdown().catch(() => {});
  for (const can of manager.list()) await manager.destroy(can.id).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('save and restore a VM can', { skip: SKIP }, () => {
  test('a file survives a save and a restore, and the can is stopped in between', { timeout: 240000 }, async () => {
    const can = await manager.create({ name: 'keep' });
    await can.writeFile('notes.txt', 'kept across save\n');
    assert.equal(await can.readFile('notes.txt', 'utf8'), 'kept across save\n');

    await manager.save('keep');
    assert.equal(can.status, 'stopped', 'a saved can is stopped');

    const again = await manager.restore('keep');
    assert.equal(again.status, 'running');
    assert.equal(again.id, can.id, 'the same can, on the same disk');
    assert.equal(await again.readFile('notes.txt', 'utf8'), 'kept across save\n', 'the file came back');
  });

  test('restore refuses a can that is still running, and destroy removes its disk', { timeout: 240000 }, async () => {
    const can = manager.get('keep');
    await assert.rejects(() => manager.restore('keep'), (err) => err.code === 'EEXIST');
    const overlay = can.overlay;
    assert.ok(fs.existsSync(overlay), 'the can has a disk');
    await manager.destroy('keep');
    assert.equal(fs.existsSync(overlay), false, 'destroy removes the disk');
    assert.equal(manager.get('keep'), undefined);
  });
});
