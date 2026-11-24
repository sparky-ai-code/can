// VM-backed cans: the methods the MCP tools use on a Can, served by one guest (src/vm/guest.js). Each method runs
// inside the guest through the agent. Shapes match src/can.js, so a caller can use either. Methods the VM does not
// provide yet (browser, screenshots, snapshots, mounts, environments) fail with ENOTSUP rather than doing nothing.
//
// Save and restore work by disk. Each can has its own writable disk: a qcow2 overlay on the read-only tools disk.
// Its home folder is on that disk (/opt/can/home), so files survive. Save shuts the guest down cleanly; restore boots a
// new guest on the same disk. Processes, ports and the agent's state do not survive a save, as can_restart documents
// for the lite backend. QEMU's own VM snapshots are not used: WHPX cannot take them (see spike/README.md).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startGuest } from './guest.js';
import { vmPaths } from './qemu.js';

const HOME = '/opt/can/home';
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

  constructor({
    id, name, guest, createdAt, overlay,
  }) {
    this.id = id;
    this.name = name;
    this.createdAt = createdAt;
    this.overlay = overlay;
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

  // ---- filesystem (relative paths resolve against /opt/can/home, which is on the can's disk)

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

  snapshot() { throw notSupported('a VM snapshot (use save, which keeps the disk)'); }

  memoryInfo() { throw notSupported('memory accounting'); }

  /** Shuts the guest down cleanly, so its disk is consistent. The can is then stopped. */
  async save() {
    await this.#guest.poweroff().catch(() => this.#guest.kill());
  }

  /** Powers the guest off. Its disk is kept until the manager destroys the can. */
  async destroy() {
    await this.#guest.poweroff().catch(() => this.#guest.kill());
  }
}

/**
 * Gives a guest outbound network access: QEMU's user networking hands the guest 10.0.2.15 behind the gateway 10.0.2.2,
 * with DNS at 10.0.2.3. The guest's clock is set from the host, since the machine has no real-time clock. Without
 * this the guest has no network; a can gets it only when it is created or restored with internet: true.
 */
async function bringUpNetwork(can) {
  const r = await can.exec([
    '/bin/busybox ip link set eth0 up',
    '/bin/busybox ip addr add 10.0.2.15/24 dev eth0',
    '/bin/busybox ip route add default via 10.0.2.2',
    "echo 'nameserver 10.0.2.3' > /etc/resolv.conf",
    `/bin/busybox date -s @${Math.floor(Date.now() / 1000)}`,
  ].join(' && '));
  if (r.exitCode !== 0) throw guestError('EIO', `the guest's network did not come up: ${r.stderr.trim()}`);
}

/** Reads the index of saved and running cans, or starts an empty one. */
function readIndex(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** Makes a writable qcow2 disk for one can, on top of the tools disk (which stays read-only in effect: all writes go
 * to the overlay). */
function makeOverlay(paths, overlay) {
  execFileSync(paths.qemuImg, ['create', '-f', 'qcow2', '-b', paths.tools, '-F', 'raw', overlay], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

/**
 * Creates, saves, restores and destroys VM cans. Each can is one guest on its own disk. The index of cans is kept in
 * <dir>/cans.json, so a can that was saved can be restored by a later process.
 */
export class VmCanManager {
  #dir;
  #memMB;
  #env;
  #indexFile;
  #index;
  #cans = new Map();
  #counter = 0;

  /**
   * @param {object} o
   * @param {string} o.dir      a folder for the guests' channels, logs, disks and the index (created with mode 0700)
   * @param {number} [o.memMB=256]
   * @param {object} [o.env]    defaults to process.env; CAN_QEMU, CAN_QEMU_IMG, CAN_GUEST_DIR and CAN_TOOLS_DISK
   *                             choose the VM files
   */
  constructor({ dir, memMB = 256, env = process.env } = {}) {
    if (!dir) throw guestError('EINVAL', 'VmCanManager needs a folder for its guests');
    this.#dir = dir;
    this.#memMB = memMB;
    this.#env = env;
    this.#indexFile = path.join(dir, 'cans.json');
    this.#index = readIndex(this.#indexFile);
  }

  #writeIndex() {
    fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.#indexFile, JSON.stringify(this.#index, null, 2));
  }

  #record(id) {
    return this.#index.find((r) => r.id === id);
  }

  async #boot({
    id, name, overlay, createdAt, internet = false,
  }) {
    const guest = await startGuest({
      name: `can-${id.slice(0, 12)}`,
      dir: this.#dir,
      memMB: this.#memMB,
      env: this.#env,
      disks: [{ file: overlay, format: 'qcow2' }],
      internet,
    });
    return new VmCan({
      id, name, guest, createdAt, overlay,
    });
  }

  /**
   * Starts a guest on a new disk and returns its can. Mounts and environments are not on the VM yet, so they are
   * refused.
   */
  async create({
    name, mounts = [], environment, internet = false,
  } = {}) {
    if (mounts.length > 0) throw notSupported('mounts');
    if (environment !== undefined) throw notSupported('environments');
    const finalName = name ?? `can-${++this.#counter}`;
    if (!NAME.test(finalName)) throw guestError('EINVAL', 'a can name is 1 to 40 letters, digits, - or _');
    for (const c of this.#cans.values()) if (c.name === finalName) throw guestError('EEXIST', `a can named ${finalName} exists`);
    if (this.#index.some((r) => r.name === finalName)) throw guestError('EEXIST', `a can named ${finalName} exists`);
    const paths = vmPaths({ env: this.#env });
    if (!fs.existsSync(paths.tools)) {
      throw guestError('ENOENT', `the tools disk is missing (${paths.tools}). Next: set CAN_TOOLS_DISK, or build it with spike/build-tools-disk.sh`);
    }
    const id = randomUUID();
    const disks = path.join(this.#dir, 'disks');
    fs.mkdirSync(disks, { recursive: true, mode: 0o700 });
    const overlay = path.join(disks, `${id}.qcow2`);
    makeOverlay(paths, overlay);
    const createdAt = Date.now();
    const can = await this.#boot({
      id, name: finalName, overlay, createdAt, internet,
    });
    if (internet) await bringUpNetwork(can);
    await can.mkdir(HOME, { recursive: true });
    this.#index.push({
      id, name: finalName, overlay, createdAt, savedAt: null, internet,
    });
    this.#writeIndex();
    this.#cans.set(id, can);
    return can;
  }

  /** Shuts a running can down, keeping its disk. Its record gets the time it was saved. */
  async save(idOrName) {
    const can = this.get(idOrName);
    if (!can) throw guestError('ENOENT', `no can named ${idOrName}`);
    await can.save();
    const record = this.#record(can.id);
    if (record) record.savedAt = new Date().toISOString();
    this.#writeIndex();
    return { name: can.name, savedAt: record?.savedAt ?? null };
  }

  /** Starts a saved can again: a new guest on the same disk. Its files are as they were at the save. */
  async restore(idOrName) {
    const record = this.#index.find((r) => r.id === idOrName || r.name === idOrName);
    if (!record) throw guestError('ENOENT', `no saved can named ${idOrName}`);
    const running = this.#cans.get(record.id);
    if (running?.status === 'running') throw guestError('EEXIST', `can ${record.name} is already running`);
    const can = await this.#boot(record);
    if (record.internet) await bringUpNetwork(can);
    this.#cans.set(record.id, can);
    return can;
  }

  get(idOrName) {
    return this.#cans.get(idOrName) ?? [...this.#cans.values()].find((c) => c.name === idOrName);
  }

  /** Every can this manager knows, running or stopped. */
  list() {
    return [...this.#cans.values()];
  }

  /** Powers the guest off, and deletes the can and its disk. */
  async destroy(idOrName) {
    const can = this.get(idOrName);
    if (!can) throw guestError('ENOENT', `no can named ${idOrName}`);
    this.#cans.delete(can.id);
    await can.destroy();
    fs.rmSync(can.overlay, { force: true });
    this.#index = this.#index.filter((r) => r.id !== can.id);
    this.#writeIndex();
  }

  /** Saves every running can, so that a later process can restore them. */
  async shutdown() {
    for (const can of [...this.#cans.values()]) {
      if (can.status === 'running') await this.save(can.id);
    }
  }
}
