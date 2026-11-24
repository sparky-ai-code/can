// The VM guest client (src/vm/guest.js) against a real guest: QEMU starts it, the agent answers, and the requests run.
// Needs the VM files: set CAN_QEMU to QEMU's binary and CAN_GUEST_DIR to a folder with x86_64/vmlinuz and
// x86_64/initrd.img (built by spike/build-initramfs-canit.sh). Without them the tests are skipped.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGuest } from '../src/vm/guest.js';
import { vmInstalled, vmPaths } from '../src/vm/qemu.js';

const installed = vmInstalled(vmPaths());
const SKIP = installed ? false : 'the VM is not installed (set CAN_QEMU and CAN_GUEST_DIR to run these)';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-vm-'));
const guests = [];

after(async () => {
  for (const g of guests) await g.kill().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

async function boot(name) {
  const guest = await startGuest({ name, dir, memMB: 256 });
  guests.push(guest);
  return guest;
}

describe('a VM guest', { skip: SKIP }, () => {
  test('starts, answers HELLO, and reports its agent version and architecture', { timeout: 120000 }, async () => {
    const guest = await boot(`vm-hello-${process.pid}`);
    assert.equal(guest.running, true);
    assert.equal(guest.version, '0.1');
    assert.equal(guest.guestArch, 'x86_64');
    assert.ok(['whpx', 'hvf', 'kvm', 'tcg'].includes(guest.accel), `accelerator ${guest.accel}`);
  });

  test('exec runs a program with its output and exit code', { timeout: 60000 }, async () => {
    const guest = guests[0];
    const uname = await guest.exec(['/bin/busybox', 'uname', '-r']);
    assert.equal(uname.exitCode, 0);
    assert.equal(uname.stdout, '7.0.0-44-generic\n');
    const failed = await guest.exec(['/bin/sh', '-c', 'echo oops >&2; exit 3']);
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.stderr, 'oops\n');
  });

  test('writeFile and readFile move bytes unchanged, and a missing file is ENOENT', { timeout: 60000 }, async () => {
    const guest = guests[0];
    const bytes = Buffer.from([0, 1, 2, 127, 128, 255, 10, 13, 0]);
    await guest.writeFile('/tmp/blob.bin', bytes, { mode: 0o600 });
    assert.deepEqual(await guest.readFile('/tmp/blob.bin'), bytes);
    const stat = await guest.exec(['/bin/sh', '-c', 'stat -c %a /tmp/blob.bin']);
    assert.equal(stat.stdout.trim(), '600');
    await assert.rejects(() => guest.readFile('/tmp/does-not-exist'), (err) => err.code === 'ENOENT');
  });

  test('requests sent at once are answered in order, one at a time', { timeout: 60000 }, async () => {
    const guest = guests[0];
    const results = await Promise.all([1, 2, 3].map((n) => guest.exec(['/bin/busybox', 'echo', `n${n}`])));
    assert.deepEqual(results.map((r) => r.stdout), ['n1\n', 'n2\n', 'n3\n']);
  });

  test('poweroff syncs, powers the guest off, and exits with status 0', { timeout: 60000 }, async () => {
    const guest = guests[0];
    const code = await guest.poweroff();
    assert.equal(code, 0);
    assert.equal(guest.running, false);
    await assert.rejects(() => guest.exec(['/bin/busybox', 'true']), (err) => err.code === 'ECHILD');
  });
});
