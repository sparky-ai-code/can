// Host side of one VM guest: starts QEMU (WHPX on Windows, HVF on macOS, KVM on Linux, software as the fallback),
// connects to the guest's agent (distro/canit/canit.c) over the agent channel, and runs requests on it.
//
// One request runs at a time: the agent serves one request at a time, so this client queues the rest. The channel is
// a named pipe on Windows and a unix socket elsewhere, in a folder only the user can open. No host TCP port is used.
// The guest has no network unless `internet` is set (qemu.js: restrict=on), and that is off by default.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  FrameDecoder, T, decodeExecResult, decodeHello, encodeExec, encodeFrame, encodeRead, encodeWrite,
} from './guest-protocol.js';
import {
  accelCandidates, buildQemuArgs, channelEndpoint, guestArchFor, vmInstalled, vmPaths,
} from './qemu.js';

const CONNECT_MS = 20_000; // how long QEMU may take to create the channel
const HELLO_MS = 1_000; // one HELLO attempt; the agent may not be up yet, so attempts repeat
const HELLO_TRIES = 60;
const DEFAULT_REQUEST_MS = 60_000;
const STOP_MS = 10_000;

function guestError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Maps an ERROR reply's text to a code the callers can test, such as ENOENT for a missing file. */
function errorFromReply(text) {
  if (/No such file or directory/.test(text)) return guestError('ENOENT', text);
  if (/Permission denied/.test(text)) return guestError('EACCES', text);
  if (/is a folder/.test(text)) return guestError('EISDIR', text);
  return guestError('EIO', text);
}

export class Guest {
  #child;
  #exited;
  #sock;
  #decoder = new FrameDecoder();
  #waiting = new Map(); // request id -> resolve(frame)
  #nextId = 2; // id 1 is HELLO
  #tail = Promise.resolve(); // the request queue
  #stopped = false;
  #exitCode = null;
  #stderr = '';
  #endpoint;

  constructor({ child, sock, endpoint, accel, arch, version, serialLog }) {
    this.#child = child;
    this.#sock = sock;
    this.#endpoint = endpoint;
    this.accel = accel;
    this.arch = arch;
    this.version = version;
    this.serialLog = serialLog;
    this.pid = child.pid;
    this.#exited = new Promise((resolve) => {
      child.on('exit', (code) => {
        this.#exitCode = code;
        this.#stopped = true;
        this.#sock?.destroy();
        resolve(code);
      });
    });
    child.stderr?.on('data', (chunk) => { this.#stderr = (this.#stderr + chunk).slice(-4000); });
    sock.on('data', (chunk) => {
      for (const frame of this.#decoder.push(chunk)) this.#waiting.get(frame.id)?.(frame);
    });
    sock.on('error', () => { /* the exit handler reports the stop */ });
  }

  /** HELLO, sent again until the agent answers. Returns {version, arch} from the agent. */
  async handshake() {
    for (let i = 0; i < HELLO_TRIES; i++) {
      try {
        const reply = await this.#ask(T.HELLO, Buffer.alloc(0), HELLO_MS);
        return decodeHello(reply.payload);
      } catch (err) {
        if (this.#stopped) throw err;
      }
    }
    throw guestError('ETIMEDOUT', 'the agent did not answer HELLO');
  }

  /** True while QEMU runs and the agent answers. */
  get running() {
    return !this.#stopped;
  }

  get exitCode() {
    return this.#exitCode;
  }

  /** The last lines QEMU wrote to stderr (for error reports). */
  get stderrTail() {
    return this.#stderr;
  }

  /** One request, answered by the reply with the same id. An ERROR reply rejects. */
  #ask(type, payload, ms) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(guestError('ETIMEDOUT', `the guest did not answer request ${type.toString(16)} within ${ms} ms`));
      }, ms);
      this.#waiting.set(id, (frame) => {
        clearTimeout(timer);
        this.#waiting.delete(id);
        if (frame.type === T.ERROR) reject(errorFromReply(frame.payload.toString('utf8')));
        else resolve(frame);
      });
      if (this.#stopped) {
        clearTimeout(timer);
        this.#waiting.delete(id);
        reject(guestError('ECHILD', 'the guest has stopped'));
        return;
      }
      this.#sock.write(encodeFrame(type, id, payload));
    });
  }

  /** Runs fn after every request queued before it has finished. */
  #queued(fn) {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.catch(() => {});
    return run;
  }

  /** Runs a program in the guest. Returns {exitCode, timedOut, stdout, stderr}. */
  exec(argv, { cwd = '', timeoutMs = 0 } = {}) {
    if (!Array.isArray(argv) || argv.length === 0) throw guestError('EINVAL', 'exec needs argv, a non-empty list');
    const waitMs = (timeoutMs > 0 ? timeoutMs : DEFAULT_REQUEST_MS) + 5000;
    return this.#queued(async () => {
      const reply = await this.#ask(T.EXEC, encodeExec({ cwd, argv, timeoutMs }), waitMs);
      return decodeExecResult(reply.payload);
    });
  }

  /** Writes a file in the guest. Its folder must exist. mode is the permission bits (default 0644). */
  writeFile(file, data, { mode = 0o644 } = {}) {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return this.#queued(async () => {
      await this.#ask(T.WRITE, encodeWrite({ path: file, data: bytes, mode }), DEFAULT_REQUEST_MS);
    });
  }

  /** Reads a file from the guest. Returns a Buffer. */
  readFile(file) {
    return this.#queued(async () => {
      const reply = await this.#ask(T.READ, encodeRead(file), DEFAULT_REQUEST_MS);
      return Buffer.from(reply.payload);
    });
  }

  /** Powers the guest off: the agent syncs and replies, then QEMU exits. Waits for the exit, then closes the channel. */
  async poweroff() {
    if (this.#stopped) return this.#exitCode;
    await this.#queued(() => this.#ask(T.POWEROFF, Buffer.alloc(0), STOP_MS));
    const timer = setTimeout(() => this.kill(), STOP_MS);
    const code = await this.#exited;
    clearTimeout(timer);
    return code;
  }

  /** Stops QEMU at once, without waiting for the guest to sync. */
  kill() {
    if (!this.#stopped) this.#child.kill();
    this.#sock?.destroy();
    return this.#exited;
  }
}

/** Creates the channel's folder with mode 0700 (unix sockets need a folder only this user can reach). */
function ensureChannelDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}

/** Connects to the agent channel, retrying until QEMU has created it. */
async function connectChannel(target, child) {
  const end = Date.now() + CONNECT_MS;
  let lastError = null;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw guestError('EIO', `QEMU exited (${child.exitCode}) before the agent channel opened`);
    try {
      return await new Promise((resolve, reject) => {
        const s = net.connect(target);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
    } catch (err) {
      lastError = err;
      await sleep(100);
    }
  }
  throw guestError('ETIMEDOUT', `the agent channel did not open: ${lastError?.message ?? 'no answer'}`);
}

/** One launch with one accelerator. Throws (and kills QEMU) when the guest does not come up. */
async function launch({ name, dir, paths, accel, arch, memMB, platform, log }) {
  const endpoint = channelEndpoint({ platform, dir, name: `${name}-agent`, id: 'agent0' });
  if (platform !== 'win32') fs.rmSync(endpoint.connect, { force: true });
  const serialLog = path.join(dir, `${name}-serial.log`);
  const args = buildQemuArgs({
    arch,
    accel,
    name,
    kernel: paths.kernel,
    initrd: paths.initrd,
    memMB,
    agent: { chardev: endpoint.chardev },
    serialLog,
    internet: false,
    shareDir: fs.existsSync(paths.shareDir) ? paths.shareDir : undefined,
  });
  log(`starting QEMU with ${accel}`);
  const child = spawn(paths.qemu, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const exitInfo = { stderr: '' };
  child.stderr.on('data', (chunk) => { exitInfo.stderr = (exitInfo.stderr + chunk).slice(-4000); });
  try {
    const sock = await connectChannel(endpoint.connect, child);
    const guest = new Guest({ child, sock, endpoint, accel, arch, serialLog });
    const hello = await guest.handshake();
    guest.version = hello.version;
    guest.guestArch = hello.arch;
    return guest;
  } catch (err) {
    child.kill();
    err.message = `${err.message}${exitInfo.stderr ? `; QEMU said: ${exitInfo.stderr.trim()}` : ''}`;
    throw err;
  }
}

/**
 * Starts a guest and returns it once its agent answers HELLO.
 * @param {object} o
 * @param {string} o.name      guest name (letters, digits, - and _)
 * @param {string} o.dir       a folder for the channel and the serial log; created with mode 0700
 * @param {number} [o.memMB=256]
 * @param {string} [o.platform] defaults to the host's
 * @param {object} [o.env]      defaults to process.env (CAN_QEMU and CAN_GUEST_DIR override the bundled VM)
 * @param {function} [o.log]
 */
export async function startGuest({
  name, dir, memMB = 256, platform = process.platform, env = process.env, log = () => {},
} = {}) {
  const paths = vmPaths({ platform, env });
  if (!vmInstalled(paths)) {
    const missing = [paths.qemu, paths.kernel, paths.initrd].filter((f) => !fs.existsSync(f));
    throw guestError('ENOENT', `the VM is not installed (missing ${missing.join(', ')}). Next: set CAN_QEMU and CAN_GUEST_DIR, or install Can's VM files`);
  }
  ensureChannelDir(dir);
  const arch = guestArchFor(platform);
  const failures = [];
  for (const accel of accelCandidates({ platform, env, kvmPresent: fs.existsSync('/dev/kvm') })) {
    try {
      return await launch({ name, dir, paths, accel, arch, memMB, platform, log });
    } catch (err) {
      failures.push(`${accel}: ${err.message}`);
      log(`the ${accel} accelerator did not start the guest: ${err.message}`);
    }
  }
  throw guestError('EIO', `the guest did not start with any accelerator. ${failures.join(' | ')}`);
}

export { AGENT_PORT_NAME } from './qemu.js';
