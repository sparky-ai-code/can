// Runs the real canit agent (distro/canit/canit.c) in --stdio mode and talks to it with src/vm/guest-protocol.js, so
// the C and JavaScript halves of the frame format are checked against each other. Needs Linux with gcc; on Windows it
// uses WSL. Skipped (with the reason) when neither is available. The PID 1 path is not covered: it needs a real boot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FrameDecoder, T, decodeExecResult, decodeHello, encodeExec, encodeFrame, OUTPUT_CAP,
} from '../src/vm/guest-protocol.js';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'distro', 'canit', 'canit.c');
const BIN = '/tmp/canit-test-bin';

/** [program, ...args] that runs `cmd` on Linux: directly, or through WSL on Windows. */
function linux(...cmd) {
  return process.platform === 'win32' ? ['wsl', ...cmd] : cmd;
}

function wslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p;
}

function build() {
  if (process.platform === 'darwin') return 'canit runs on Linux only';
  const [prog, ...args] = linux('gcc', '-std=gnu11', '-Wall', '-Wextra', '-Werror', '-O2', '-o', BIN, wslPath(SOURCE));
  const r = spawnSync(prog, args, { encoding: 'utf8' });
  if (r.error) return `no ${prog}: ${r.error.message}`;
  if (r.status !== 0) throw new Error(`canit failed to compile:\n${r.stdout}${r.stderr}`);
  return null;
}

const skip = build() ?? false;

class Agent {
  constructor() {
    const [prog, ...args] = linux(BIN, '--stdio');
    this.child = spawn(prog, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.decoder = new FrameDecoder();
    this.waiting = new Map();
    this.nextId = 1;
    this.exited = new Promise((resolve) => this.child.on('exit', (code) => resolve(code)));
    this.child.stdout.on('data', (chunk) => {
      for (const frame of this.decoder.push(chunk)) this.waiting.get(frame.id)?.(frame);
    });
  }

  request(type, payload) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(encodeFrame(type, id, payload));
    });
  }

  async exec(argv, opts = {}) {
    const reply = await this.request(T.EXEC, encodeExec({ argv, ...opts }));
    assert.equal(reply.type, T.EXEC | T.REPLY, `exec reply was ${reply.type}: ${reply.payload}`);
    return decodeExecResult(reply.payload);
  }

  close() {
    this.child.stdin.end();
    return this.exited;
  }
}

test('hello reports the version and the architecture', { skip }, async () => {
  const a = new Agent();
  const r = await a.request(T.HELLO);
  assert.equal(r.type, T.HELLO | T.REPLY);
  const hello = decodeHello(r.payload);
  assert.match(hello.version, /^\d+\.\d+$/);
  assert.match(hello.arch, /^(x86_64|aarch64)$/);
  await a.close();
});

test('ping echoes its payload, even a large one', { skip }, async () => {
  const a = new Agent();
  const big = Buffer.alloc(300_000, 7);
  const r = await a.request(T.PING, big);
  assert.equal(r.type, T.PING | T.REPLY);
  assert.ok(r.payload.equals(big));
  await a.close();
});

test('exec returns stdout, stderr and the exit code', { skip }, async () => {
  const a = new Agent();
  assert.deepEqual(await a.exec(['/bin/sh', '-c', 'echo out; echo err >&2; exit 3']), { exitCode: 3, timedOut: false, stdout: 'out\n', stderr: 'err\n' });
  await a.close();
});

test('exec uses the cwd and does not give the command our stdin', { skip }, async () => {
  const a = new Agent();
  assert.equal((await a.exec(['/bin/pwd'], { cwd: '/tmp' })).stdout, '/tmp\n');
  const r = await a.exec(['/bin/sh', '-c', 'cat; echo done']);
  assert.equal(r.stdout, 'done\n');
  await a.close();
});

test('exec: a missing program is 127, a bad cwd is 126, a signal is 128 + n', { skip }, async () => {
  const a = new Agent();
  const missing = await a.exec(['/no/such/program']);
  assert.equal(missing.exitCode, 127);
  assert.match(missing.stderr, /cannot run/);
  assert.equal((await a.exec(['/bin/true'], { cwd: '/no/such/dir' })).exitCode, 126);
  assert.equal((await a.exec(['/bin/sh', '-c', 'kill -9 $$'])).exitCode, 137);
  await a.close();
});

test('exec: a command that outlives its timeout is killed and reported as 124', { skip }, async () => {
  const a = new Agent();
  const started = Date.now();
  const r = await a.exec(['/bin/sleep', '30'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, 124);
  assert.ok(Date.now() - started < 10_000);
  await a.close();
});

test('exec: output over the cap is read and dropped, and the command still finishes', { skip }, async () => {
  const a = new Agent();
  const r = await a.exec(['/bin/sh', '-c', 'head -c 3000000 /dev/zero | tr "\\0" x; echo']);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.length, OUTPUT_CAP);
  await a.close();
});

test('an unknown request type gets an ERROR reply and the agent keeps serving', { skip }, async () => {
  const a = new Agent();
  const bad = await a.request(0x55, Buffer.alloc(0));
  assert.equal(bad.type, T.ERROR);
  assert.match(bad.payload.toString(), /unknown request type 85/);
  assert.equal((await a.request(T.PING, Buffer.from('x'))).type, T.PING | T.REPLY);
  await a.close();
});

test('a malformed exec payload is an ERROR, not a crash', { skip }, async () => {
  const a = new Agent();
  const r = await a.request(T.EXEC, Buffer.from([1, 0, 0, 0, 0x61])); // no NUL terminator
  assert.equal(r.type, T.ERROR);
  assert.equal((await a.request(T.PING)).type, T.PING | T.REPLY);
  await a.close();
});

test('poweroff replies, then the agent exits', { skip }, async () => {
  const a = new Agent();
  const r = await a.request(T.POWEROFF);
  assert.equal(r.type, T.POWEROFF | T.REPLY);
  assert.equal(await a.exited, 0);
});

test('the agent exits when the host closes the channel', { skip }, async () => {
  const a = new Agent();
  assert.equal(await a.close(), 0);
});
