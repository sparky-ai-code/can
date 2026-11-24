// VM-backed cans: the methods the MCP tools use on a Can, served by one guest (src/vm/guest.js). Each method runs
// inside the guest through the agent. Shapes match src/can.js, so a caller can use either. Methods the VM does not
// provide yet (browser, screenshots, snapshots, mounts, environments) fail with ENOTSUP rather than doing nothing.
//
// This is the first step of CanManager integration. The MCP layer still uses the registry and the lite backend; that
// switch is a later change, after save and restore exist for the VM.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { startGuest } from './guest.js';

const HOME = '/home/agent';
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGUSR1: 10, SIGUSR2: 12, SIGTERM: 15 };
const NAME = /^[A-Za-z0-9_-]{1,40}$/;

function guestError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

function notSupported(what) {
  return guestError('ENOTSUP', `${what} is not on the VM backend yet. Next: use the lite backend for this, or wait for the VM step that adds it.`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class VmCan {
  #guest;

  constructor({ id, name, guest, createdAt }) {
    this.id = id;
    this.name = name;
    this.createdAt = createdAt;
    this.#guest = guest;
  }

  /** 'running' while the guest runs, 'stopped' after it has powered off. */
  get status() {
    return this.#guest.running ? 'running' : 'stopped';
  }

  /** The guest's agent version and architecture, for diagnostics. */
  get info() {
    return { version: this.#guest.version, arch: this.#guest.guestArch, accel: this.#guest.accel };
  }

  // ---- commands and processes

  /** Runs a shell line in the guest. Resolves to {exitCode, signal, stdout, stderr, timedOut}, as Can.exec does. */
  async exec(command, opts = {}) {
    const r = await this.#guest.exec(['/bin/sh', '-c', String(command)], {
      cwd: opts.cwd ?? HOME,
      timeoutMs: opts.timeoutMs ?? 0,
    });
    return { exitCode: r.exitCode, signal: null, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
  }

  /** Starts a shell line in the background. Resolves to the process view at once, with its pid. */
  async spawn(command, opts = {}) {
    const pid = await this.#guest.spawn(['/bin/sh', '-c', String(command)], { cwd: opts.cwd ?? HOME });
    return this.#view(pid, String(command));
  }

  async #view(pid, command) {
    const st = await this.#guest.status(pid);
    return {
      pid,
      command,
      status: st.running ? 'running' : 'exited',
      exitCode: st.running ? null : st.exitCode,
    };
  }

  /** Resolves with the process view once it has exited. Rejects with ETIMEDOUT after timeoutMs. */
  async wait(pid, timeoutMs = 60000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const st = await this.#guest.status(pid);
      if (!st.running) return this.#view(pid, '');
      if (Date.now() > end) throw guestError('ETIMEDOUT', `process ${pid} did not exit within ${timeoutMs} ms`);
      await sleep(50);
    }
  }

  /** Sends a signal to a process: 'SIGTERM' by default, or any name in SIGNALS. */
  kill(pid, signal = 'SIGTERM') {
    const num = SIGNALS[signal];
    if (num === undefined) throw guestError('EINVAL', `unknown signal ${signal}. Use one of ${Object.keys(SIGNALS).join(', ')}`);
    return this.#guest.killProgram(pid, num);
  }

  /** The processes this can has started: {pid, command, status, exitCode}. */
  async ps() {
    return (await this.#guest.ps()).map((p) => ({
      pid: p.id,
      command: p.command,
      status: p.running ? 'running' : 'exited',
      exitCode: p.running ? null : p.exitCode,
    }));
  }

  /** The view of one process, or undefined once the agent has dropped it. */
  async getProcess(pid) {
    try {
      return await this.#view(pid, '');
    } catch (err) {
      if (err.code === 'ENOENT' || /no such background program/.test(err.message)) return undefined;
      throw err;
    }
  }

  /** Output a process has written so far: its last 256 KB, as a Buffer. */
  async logs(pid, stream = 'stdout') {
    return Buffer.from(await this.#guest.logs(pid, stream), 'utf8');
  }

  writeStdin(pid, data) {
    return this.#guest.writeStdin(pid, data);
  }

  endStdin(pid) {
    return this.#guest.endStdin(pid);
  }

  // ---- filesystem (relative paths resolve against /home/agent)

  #abs(p) {
    return path.posix.resolve(HOME, String(p));
  }

  /** A Buffer, or a string when an encoding is given. */
  async readFile(file, encoding) {
    const bytes = await this.#guest.readFile(this.#abs(file));
    return encoding ? bytes.toString(encoding) : bytes;
  }

  /** Creates or replaces a file. The folder must exist. options.mode sets its permission bits. */
  writeFile(file, data, options = {}) {
    return this.#guest.writeFile(this.#abs(file), data, { mode: options.mode });
  }

  /** Runs a busybox applet in the guest and returns its result. */
  #applet(argv) {
    return this.#guest.exec(['/bin/busybox', ...argv], { cwd: HOME, timeoutMs: 30000 });
  }

  async mkdir(dir, options = {}) {
    const r = await this.#applet(['mkdir', ...(options.recursive ? ['-p'] : []), this.#abs(dir)]);
    if (r.exitCode !== 0) throw guestError('EIO', r.stderr.trim() || `mkdir exited ${r.exitCode}`);
  }

  async rm(target, options = {}) {
    const r = await this.#applet(['rm', ...(options.recursive || options.force ? ['-rf'] : []), this.#abs(target)]);
    if (r.exitCode !== 0 && !options.force) throw guestError('EIO', r.stderr.trim() || `rm exited ${r.exitCode}`);
  }

  /** True when the path exists in the guest. */
  async exists(target) {
    return (await this.#applet(['test', '-e', this.#abs(target)])).exitCode === 0;
  }

  /** The names in a folder, sorted, without . and ..  */
  async listDir(dir) {
    const r = await this.#applet(['ls', '-1A', this.#abs(dir)]);
    if (r.exitCode !== 0) throw guestError('ENOENT', r.stderr.trim() || `cannot list ${dir}`);
    return r.stdout.split('\n').filter(Boolean).sort();
  }

  // ---- network

  /** Ports the guest listens on: [{port, createdAt}]. createdAt is null; the VM does not record when a port opened. */
  async listeners() {
    return (await this.#guest.ports()).map((port) => ({ port, createdAt: null }));
  }

  /** One HTTP request to a server in the guest. Resolves to {status, headers, body: Buffer}, as Can.request does. */
  request({
    port, method = 'GET', path: target = '/', headers = {}, body, timeout,
  } = {}) {
    return this.#guest.request({ port, method, path: target, headers, body, timeoutMs: timeout });
  }

  // ---- not on the VM yet

  setCwd() { throw notSupported('setCwd'); }

  stat() { throw notSupported('stat'); }

  openBrowser() { throw notSupported('the browser'); }

  browse() { throw notSupported('the browser'); }

  screenshot() { throw notSupported('screenshots'); }

  snapshot() { throw notSupported('save (snapshot)'); }

  restore() { throw notSupported('restore'); }

  memoryInfo() { throw notSupported('memory accounting'); }

  /** Powers the guest off. The can is stopped; its files are gone (save and restore are not on the VM yet). */
  async destroy() {
    await this.#guest.poweroff().catch(() => this.#guest.kill());
  }
}

/** Creates, finds and destroys VM cans. Each can is one guest. */
export class VmCanManager {
  #dir;
  #memMB;
  #env;
  #cans = new Map();
  #counter = 0;

  /**
   * @param {object} o
   * @param {string} o.dir      a folder for each guest's channel and serial log (created with mode 0700)
   * @param {number} [o.memMB=256]
   * @param {object} [o.env]    defaults to process.env; CAN_QEMU and CAN_GUEST_DIR choose the VM files
   */
  constructor({ dir, memMB = 256, env = process.env } = {}) {
    if (!dir) throw guestError('EINVAL', 'VmCanManager needs a folder for its guests');
    this.#dir = dir;
    this.#memMB = memMB;
    this.#env = env;
  }

  /** Starts a guest and returns its can. Mounts and environments are not on the VM yet, so they are refused. */
  async create({ name, mounts = [], environment } = {}) {
    if (mounts.length > 0) throw notSupported('mounts');
    if (environment !== undefined) throw notSupported('environments');
    const finalName = name ?? `can-${++this.#counter}`;
    if (!NAME.test(finalName)) throw guestError('EINVAL', 'a can name is 1 to 40 letters, digits, - or _');
    for (const c of this.#cans.values()) if (c.name === finalName) throw guestError('EEXIST', `a can named ${finalName} exists`);
    const id = randomUUID();
    const guest = await startGuest({ name: `can-${id.slice(0, 12)}`, dir: this.#dir, memMB: this.#memMB, env: this.#env });
    const can = new VmCan({ id, name: finalName, guest, createdAt: Date.now() });
    this.#cans.set(id, can);
    return can;
  }

  get(idOrName) {
    return this.#cans.get(idOrName) ?? [...this.#cans.values()].find((c) => c.name === idOrName);
  }

  list() {
    return [...this.#cans.values()];
  }

  /** Powers the guest off and forgets the can. */
  async destroy(idOrName) {
    const can = this.get(idOrName);
    if (!can) throw guestError('ENOENT', `no can named ${idOrName}`);
    this.#cans.delete(can.id);
    await can.destroy();
  }

  async shutdown() {
    for (const can of [...this.#cans.values()]) await this.destroy(can.id);
  }
}
