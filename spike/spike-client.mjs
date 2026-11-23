// Phase 0 spike: boot the guest under QEMU/WHPX and drive its agent over a named pipe (virtio-serial port).
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Path to QEMU's Windows build. Set QEMU_EXE to override.
const QEMU = process.env.QEMU_EXE || 'C:/Program Files/qemu/qemu-system-x86_64.exe';
const PIPE = '//./pipe/canagent';
const t0 = Date.now();

const qemu = spawn(QEMU, [
  '-accel', 'whpx', '-machine', 'microvm', '-cpu', 'max', '-m', '256',
  '-nodefaults', '-no-user-config', '-no-reboot', '-display', 'none',
  '-kernel', path.join(here, 'vmlinuz'),
  '-initrd', path.join(here, 'initramfs.cpio.gz'),
  '-append', 'console=ttyS0 panic=-1 quiet',
  '-serial', 'stdio',
  '-device', 'virtio-serial-device',
  '-chardev', 'pipe,id=agent0,path=canagent',
  '-device', 'virtserialport,chardev=agent0,name=can.agent',
], { cwd: here, stdio: ['ignore', 'pipe', 'pipe'] });
let console_ = '';
qemu.stdout.on('data', (d) => { console_ += d; });
qemu.stderr.on('data', (d) => { console_ += `[qemu stderr] ${d}`; });
const exited = new Promise((resolve) => qemu.on('exit', (code) => resolve(code)));

async function connect() {
  for (let i = 0; i < 300; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const s = net.connect(PIPE);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('the agent pipe never appeared');
}

const sock = await connect();
console.log(`connected to the agent pipe after ${Date.now() - t0} ms`);
let buf = '';
const lines = [];
sock.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    lines.push(buf.slice(0, i).replace(/\r$/, ''));
    buf = buf.slice(i + 1);
  }
});
let cursor = 0; // replies are consumed in order, so a later wait never matches an earlier reply
const waitFor = (pred, ms = 30000) => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const tick = () => {
    const idx = lines.findIndex((l, i) => i >= cursor && pred(l));
    if (idx >= 0) { cursor = idx + 1; return resolve(lines[idx]); }
    if (Date.now() > end) return reject(new Error('timed out waiting for the agent'));
    setTimeout(tick, 20);
  };
  tick();
});

const ready = await waitFor((l) => l === 'CAN-READY');
console.log(`agent ready: ${ready} after ${Date.now() - t0} ms`);
if (process.env.SPIKE_HOLD_MS) await new Promise((r) => setTimeout(r, Number(process.env.SPIKE_HOLD_MS)));
const results = {};
for (const [cmd, expect] of [['ping', 'CAN-REPLY pong'], ['uname -r', 'CAN-REPLY 7.0.0-44-generic'], ['echo spike-ok', 'CAN-REPLY spike-ok']]) {
  sock.write(`${cmd}\n`);
  const got = await waitFor((l) => l === expect || l.startsWith('CAN-REPLY'));
  results[cmd] = got === expect ? 'ok' : `unexpected: ${got}`;
  console.log(`${cmd} -> ${got}`);
}
sock.write('exit\n');
await waitFor((l) => l === 'CAN-REPLY bye');
const code = await exited;
console.log(`guest powered off, qemu exit=${code}, total ${Date.now() - t0} ms`);
console.log(JSON.stringify({ results, exitCode: code }));
sock.destroy();
