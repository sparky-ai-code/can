// Agent spike: boot the guest with canit as PID 1 under QEMU/WHPX and drive it with src/vm/guest-protocol.js over a
// named pipe. Requests: HELLO, EXEC (uname, echo), POWEROFF. Each step must answer correctly, and QEMU must exit 0.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FrameDecoder, T, decodeExecResult, decodeHello, encodeExec, encodeFrame,
} from '../src/vm/guest-protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const QEMU = process.env.QEMU_EXE || 'C:/Program Files/qemu/qemu-system-x86_64.exe';
const PIPE = '//./pipe/canagent';
const t0 = Date.now();
const log = (msg) => console.log(`[${String(Date.now() - t0).padStart(5)} ms] ${msg}`);

const qemu = spawn(QEMU, [
  '-accel', 'whpx', '-machine', 'microvm', '-cpu', 'max', '-m', '256',
  '-nodefaults', '-no-user-config', '-no-reboot', '-display', 'none',
  '-kernel', path.join(here, 'vmlinuz'),
  '-initrd', path.join(here, 'initramfs-canit.cpio.gz'),
  '-append', 'console=ttyS0 panic=-1 quiet',
  '-serial', 'stdio',
  '-device', 'virtio-serial-device',
  '-chardev', 'pipe,id=agent0,path=canagent',
  '-device', 'virtserialport,chardev=agent0,name=can.agent',
], { cwd: here, stdio: ['ignore', 'pipe', 'pipe'] });
let serial = '';
qemu.stdout.on('data', (d) => { serial += d; });
qemu.stderr.on('data', (d) => { serial += `[qemu stderr] ${d}`; });
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
log('connected to the agent pipe');
const decoder = new FrameDecoder();
const waiting = new Map(); // request id -> resolve(frame)
sock.on('data', (chunk) => {
  for (const frame of decoder.push(chunk)) {
    const resolve = waiting.get(frame.id);
    if (resolve) {
      waiting.delete(frame.id);
      resolve(frame);
    }
  }
});

// One request, answered by a reply with the same id. A reply of type ERROR carries the agent's message.
function ask(id, type, payload, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`no reply to request ${id} within ${ms} ms`));
    }, ms);
    waiting.set(id, (frame) => {
      clearTimeout(timer);
      if (frame.type === T.ERROR) reject(new Error(`agent error: ${frame.payload.toString('utf8')}`));
      else resolve(frame);
    });
    sock.write(encodeFrame(type, id, payload));
  });
}

// The agent never speaks first, and the guest port may not be open yet, so HELLO is sent again until it answers.
async function hello() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await ask(1, T.HELLO, Buffer.alloc(0), 500);
    } catch {
      // not up yet; send again
    }
  }
  throw new Error('the agent did not answer HELLO');
}

const results = {};
const h = decodeHello((await hello()).payload);
log(`HELLO: canit ${h.version} on ${h.arch}`);
results.hello = { version: h.version, arch: h.arch };

for (const [id, argv] of [[2, ['/bin/busybox', 'uname', '-r']], [3, ['/bin/busybox', 'echo', 'spike-ok']]]) {
  const reply = await ask(id, T.EXEC, encodeExec({ argv, timeoutMs: 10000 }));
  const r = decodeExecResult(reply.payload);
  log(`EXEC ${argv.slice(1).join(' ')} -> exit ${r.exitCode}, stdout ${JSON.stringify(r.stdout)}`);
  results[argv.slice(1).join(' ')] = { exitCode: r.exitCode, stdout: r.stdout };
}

const off = await ask(4, T.POWEROFF, Buffer.alloc(0));
log(`POWEROFF acknowledged with type 0x${off.type.toString(16)}`);
const code = await exited;
log(`guest powered off, qemu exit=${code}`);
console.log(JSON.stringify({ results, poweroffReply: off.type.toString(16), qemuExit: code }));
sock.destroy();
