import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  accelCandidates, buildQemuArgs, channelEndpoint, guestArchFor, qemuEscape, vmPaths, AGENT_PORT_NAME,
} from '../src/vm/qemu.js';

const base = (extra = {}) => ({
  arch: 'x86_64', accel: 'whpx', name: 'can-1', kernel: 'K', initrd: 'I',
  agent: { chardev: 'pipe,id=agent,path=\\\\.\\pipe\\can-1' }, ...extra,
});
const pairs = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

test('accelerators: WHPX on Windows, HVF on macOS, KVM on Linux, software always last', () => {
  assert.deepEqual(accelCandidates({ platform: 'win32', env: {} }), ['whpx', 'tcg']);
  assert.deepEqual(accelCandidates({ platform: 'darwin', env: {} }), ['hvf', 'tcg']);
  assert.deepEqual(accelCandidates({ platform: 'linux', env: {}, kvmPresent: true }), ['kvm', 'tcg']);
  assert.deepEqual(accelCandidates({ platform: 'linux', env: {}, kvmPresent: false }), ['tcg']);
});

test('CAN_VM_ACCEL forces a choice, and rejects an unknown one', () => {
  assert.deepEqual(accelCandidates({ platform: 'win32', env: { CAN_VM_ACCEL: 'tcg' } }), ['tcg']);
  assert.deepEqual(accelCandidates({ platform: 'win32', env: { CAN_VM_ACCEL: 'hvf' } }), ['hvf', 'tcg']);
  assert.throws(() => accelCandidates({ platform: 'win32', env: { CAN_VM_ACCEL: 'xen' } }), /EINVAL/);
});

test('the guest architecture is always the host architecture', () => {
  assert.equal(guestArchFor('win32', 'x64'), 'x86_64');
  assert.equal(guestArchFor('darwin', 'arm64'), 'aarch64');
  assert.equal(guestArchFor('darwin', 'x64'), 'x86_64');
  assert.throws(() => guestArchFor('win32', 'ia32'), /EINVAL/);
});

test('vmPaths points into the installed app and honours overrides', () => {
  const p = vmPaths({ platform: 'win32', arch: 'x86_64', appRoot: 'C:\\app', env: {} });
  assert.equal(p.qemu, path.join('C:\\app', 'vmm', 'qemu-system-x86_64.exe'));
  assert.equal(p.kernel, path.join('C:\\app', 'guest', 'x86_64', 'vmlinuz'));
  const mac = vmPaths({ platform: 'darwin', arch: 'aarch64', appRoot: '/a', env: { CAN_QEMU: '/q' } });
  assert.equal(mac.qemu, '/q');
  assert.ok(mac.initrd.endsWith(path.join('aarch64', 'initrd.img')));
});

test('qemuEscape doubles commas', () => {
  assert.equal(qemuEscape('C:\\a,b\\c'), 'C:\\a,,b\\c');
});

test('channel: a named pipe on Windows, a private unix socket elsewhere, never a TCP port', () => {
  const win = channelEndpoint({ platform: 'win32', dir: 'x', name: 'can-1', id: 'agent' });
  assert.equal(win.connect, '\\\\.\\pipe\\can-1');
  assert.match(win.chardev, /^pipe,id=agent,path=/);
  assert.equal(win.chardev, 'pipe,id=agent,path=can-1', 'QEMU gets the pipe name; it adds the prefix itself');
  const mac = channelEndpoint({ platform: 'darwin', dir: '/tmp/can', name: 'can-1', id: 'agent' });
  assert.equal(mac.connect, '/tmp/can/can-1.sock');
  assert.match(mac.chardev, /server=on,wait=off/);
  assert.doesNotMatch(win.chardev + mac.chardev, /tcp|127\.0\.0\.1/);
  assert.throws(() => channelEndpoint({ platform: 'darwin', dir: `/${'x'.repeat(120)}`, name: 'c', id: 'a' }), /socket path length/);
  assert.throws(() => channelEndpoint({ platform: 'win32', dir: 'x', name: 'bad name', id: 'a' }), /EINVAL/);
});

test('x86_64 under WHPX: microvm, no firmware, direct kernel boot, virtio-mmio devices, agent port', () => {
  const args = buildQemuArgs(base({ memMB: 128, disks: [{ file: 'C:\\d,e.qcow2', format: 'qcow2' }, { file: 'L.sqsh', format: 'raw', readonly: true }] }));
  assert.deepEqual(pairs(args, '-M'), ['microvm,accel=whpx,pit=off,pic=off,rtc=off']);
  assert.deepEqual(pairs(args, '-m'), ['128M']);
  assert.deepEqual(pairs(args, '-kernel'), ['K']);
  assert.ok(args.includes('-nodefaults') && args.includes('-no-reboot'));
  assert.ok(!args.includes('-bios'), 'no firmware is loaded');
  assert.match(pairs(args, '-append')[0], /console=ttyS0.*pci=off/);
  assert.ok(pairs(args, '-device').includes('virtio-serial-device'));
  assert.ok(pairs(args, '-device').includes(`virtserialport,chardev=agent,name=${AGENT_PORT_NAME}`));
  const drives = pairs(args, '-drive');
  assert.equal(drives[0], 'file=C:\\d,,e.qcow2,if=none,id=disk0,format=qcow2');
  assert.equal(drives[1], 'file=L.sqsh,if=none,id=disk1,format=raw,readonly=on');
  assert.ok(pairs(args, '-device').includes('virtio-blk-device,drive=disk1'));
});

test('aarch64 under HVF: virt machine, host cpu, ttyAMA0', () => {
  const args = buildQemuArgs(base({ arch: 'aarch64', accel: 'hvf' }));
  assert.deepEqual(pairs(args, '-M'), ['virt,accel=hvf']);
  assert.deepEqual(pairs(args, '-cpu'), ['host']);
  assert.match(pairs(args, '-append')[0], /console=ttyAMA0/);
  assert.doesNotMatch(pairs(args, '-append')[0], /pci=off/);
});

test('q35 uses PCI devices', () => {
  const args = buildQemuArgs(base({ machine: 'q35' }));
  assert.ok(pairs(args, '-device').includes('virtio-net-pci,netdev=net0'));
  assert.ok(!pairs(args, '-append')[0].includes('pci=off'));
});

test('the software fallback uses cpu max', () => {
  assert.deepEqual(pairs(buildQemuArgs(base({ accel: 'tcg' })), '-cpu'), ['max']);
});

test('network: isolated unless the can allows the internet', () => {
  assert.match(pairs(buildQemuArgs(base()), '-netdev')[0], /restrict=on/);
  assert.match(pairs(buildQemuArgs(base({ internet: true })), '-netdev')[0], /restrict=off/);
});

test('balloon is on, and free-page reporting only when asked', () => {
  assert.ok(pairs(buildQemuArgs(base()), '-device').includes('virtio-balloon-device,deflate-on-oom=on'));
  assert.ok(pairs(buildQemuArgs(base({ freePageReporting: true })), '-device').some((d) => d.includes('free-page-reporting=on')));
  assert.ok(!pairs(buildQemuArgs(base({ balloon: false })), '-device').some((d) => d.startsWith('virtio-balloon')));
});

test('the control channel is added when given', () => {
  const args = buildQemuArgs(base({ qmp: { chardev: 'pipe,id=qmp,path=q' } }));
  assert.deepEqual(pairs(args, '-mon'), ['chardev=qmp,mode=control']);
});

test('bad input is refused with a next step', () => {
  assert.throws(() => buildQemuArgs(base({ memMB: 8 })), /EINVAL.*Next/);
  assert.throws(() => buildQemuArgs(base({ cpus: 0 })), /EINVAL/);
  assert.throws(() => buildQemuArgs(base({ arch: 'riscv64' })), /EINVAL/);
  assert.throws(() => buildQemuArgs(base({ accel: 'xen' })), /EINVAL/);
  assert.throws(() => buildQemuArgs(base({ name: 'bad name' })), /EINVAL/);
  assert.throws(() => buildQemuArgs({ ...base(), agent: undefined }), /EINVAL/);
});
