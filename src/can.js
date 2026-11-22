// Can: the host-side handle of one virtual machine. Every method is an async RPC to the can's own
// child process (see vm/supervisor.js). The filesystem, network, processes and browser all live in
// that child; this class only sends requests and decodes replies.
import { VmProcess, softLimitError } from './vm/supervisor.js';
import { KernelError } from './kernel/errors.js';
import { attachEncoded, flattenEncoded, pagesFor } from './vm/snapshot-pages.js';

const toBase64 = (data) => Buffer.from(data).toString('base64');
const isBytes = (v) => v instanceof Uint8Array;

/**
 * Reads a can's snapshot from its VM a page at a time, and joins the pages into the saved form (the same object
 * a single-message snapshot would have been).
 */
async function pullSnapshot(vm) {
  const head = await vm.request('snapshotHead');
  let root = null;
  try {
    let from = 0;
    while (from !== null) {
      const page = await vm.request('snapshotPage', { from });
      root = attachEncoded(root, page.records);
      from = page.next;
    }
  } finally {
    await vm.request('snapshotEnd').catch(() => {});
  }
  return { ...head, vfs: { ...head.vfs, root } };
}

/** Sends a saved-form snapshot into a VM a page at a time, then restores it there. Returns the VM's meta. */
async function pushSnapshot(vm, snapshot, mounts) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.vfs?.root) {
    throw new KernelError('EINVAL', 'EINVAL: not a can snapshot');
  }
  const { vfs, ...rest } = snapshot;
  await vm.request('restoreHead', { head: { ...rest, vfs: { format: vfs.format, version: vfs.version, cwd: vfs.cwd } } });
  for (const records of pagesFor(flattenEncoded(vfs.root))) {
    await vm.request('restorePage', { records });
  }
  return vm.request('restoreEnd', { mounts });
}

export class Can {
  /**
   * Starts a can VM. Use CanManager.create or CanManager.load in normal code.
   * @param {object} opts
   * @param {string} [opts.id]
   * @param {string} [opts.name]
   * @param {Record<string,string>} [opts.env]
   * @param {object} [opts.snapshot] state to restore (see snapshot())
   * @param {boolean} [opts.layer2=true]
   * @param {Array<{label: string, canPath: string, hostDir: string}>} [opts.mounts=[]] host folders to mount
   *   read-only (resolved by src/mounts.js; the host path is given to the VM only)
   * @param {object} [opts.policy] network and runtime settings (see vm/policy.js); a snapshot brings its own
   * @returns {Promise<Can>}
   */
  static async open({ id, name, env, snapshot, layer2 = true, mounts = [], policy } = {}) {
    const label = name ?? snapshot?.name ?? id;
    const vm = await VmProcess.start({ layer2, mounts: mounts.map((m) => m.hostDir), label });
    try {
      const wire = mounts.map(({ label, canPath, hostDir }) => ({ label, canPath, hostDir }));
      const meta = snapshot
        ? await pushSnapshot(vm, snapshot, wire)
        : await vm.request('create', { id, name, env, mounts: wire, policy });
      return new Can(vm, meta);
    } catch (err) {
      await vm.kill();
      throw err;
    }
  }

  constructor(vm, meta) {
    this._vm = vm;
    this.id = meta.id;
    this.name = meta.name;
    this.createdAt = meta.createdAt;
    this.policy = meta.policy ?? null; // network and runtime settings (see vm/policy.js)
  }

  /**
   * 'running' | 'exited' | 'crashed' | 'memory-limit' | 'destroyed' (interface I4). 'destroyed' is a can stopped on
   * purpose (destroy, stop, or a host shutting down). 'exited' is reserved for a VM that ended without being asked.
   */
  get status() {
    const s = this._vm.status;
    if (s === 'running' || s === 'exited' || s === 'crashed' || s === 'memory-limit') return s;
    return 'destroyed'; // stopping or destroyed on purpose
  }

  /**
   * Memory of this can, measured on its child process: {usedBytes, peakBytes, softBytes, limitBytes, enforced}.
   * limitBytes is 700 MB and softBytes 630 MB (1 MB = 1024 * 1024 bytes). enforced is 'job-object' when the Windows
   * helper holds the hard limit, else 'sampled' (see src/vm/memcap.js).
   */
  memoryInfo() {
    return this._vm.memoryInfo();
  }

  /** Refuses new work while the can is at or above its soft limit (kill still works). See softLimitError. */
  _checkSoftLimit() {
    if (this._vm.status !== 'running') return;
    const m = this._vm.memoryInfo();
    if (m.usedBytes >= m.softBytes) throw softLimitError(this.name ?? this.id, m.usedBytes);
  }

  /** PID of the can's VM process (for diagnostics only; it is not a can pid). */
  get vmPid() { return this._vm.pid; }

  // ---- commands and processes

  /** Foreground run. Resolves to {exitCode, signal, stdout, stderr, timedOut}. */
  async exec(command, opts = {}) {
    this._checkSoftLimit();
    return this._vm.request('exec', { command, opts: wireOpts(opts) });
  }

  /** Starts a process and returns its view immediately. See ProcessTable.spawn. */
  async spawn(command, opts = {}) {
    this._checkSoftLimit();
    return this._vm.request('spawn', { command, opts: wireOpts(opts) });
  }

  /** Resolves with the process view once it exits; rejects with ETIMEDOUT after timeoutMs. */
  wait(pid, timeoutMs) {
    return this._vm.request('wait', { pid, timeout: timeoutMs });
  }

  kill(pid, signal = 'SIGTERM') {
    return this._vm.request('kill', { pid, signal });
  }

  ps(filter = {}) {
    return this._vm.request('ps', { status: filter.status });
  }

  /** The view of one process, or undefined once it has been removed. */
  async getProcess(pid) {
    return (await this._vm.request('getProcess', { pid })) ?? undefined;
  }

  /** Buffered output of a process (newest 1 MiB) as a Buffer. */
  async logs(pid, stream = 'stdout') {
    return Buffer.from(await this._vm.request('logs', { pid, stream }), 'base64');
  }

  writeStdin(pid, data) {
    return this._vm.request('writeStdin', { pid, data: toBase64(data) });
  }

  endStdin(pid) {
    return this._vm.request('endStdin', { pid });
  }

  // ---- filesystem (paths are inside the can; relative paths resolve against /home/agent)

  /** Returns a Buffer, or a string when an encoding is given. */
  async readFile(path, encoding) {
    const r = await this._vm.request('readFile', { path, encoding: encoding ?? null });
    return encoding ? r : Buffer.from(r, 'base64');
  }

  writeFile(path, data, options = {}) {
    if (isBytes(data)) return this._vm.request('writeFile', { path, data: toBase64(data), binary: true, options });
    return this._vm.request('writeFile', { path, data: String(data), binary: false, options });
  }

  listDir(path) {
    return this._vm.request('listDir', { path });
  }

  stat(path) {
    return this._vm.request('stat', { path });
  }

  exists(path) {
    return this._vm.request('exists', { path });
  }

  /** Sets the folder that exec and spawn start in when they are not given a cwd. The folder must exist. */
  setCwd(path) {
    return this._vm.request('setCwd', { path });
  }

  mkdir(path, options = {}) {
    return this._vm.request('mkdir', { path, options });
  }

  rm(path, options = {}) {
    return this._vm.request('rm', { path, options });
  }

  // ---- network

  /** Sends one HTTP request to a port inside the can. Resolves to {status, headers, body: Buffer}. */
  async request({ port, method = 'GET', path = '/', headers = {}, body, timeout } = {}) {
    const binary = isBytes(body);
    const r = await this._vm.request('request', {
      port,
      method,
      path,
      headers,
      body: binary ? toBase64(body) : body,
      binary,
      timeout,
    });
    return { status: r.status, headers: r.headers, body: Buffer.from(r.body, 'base64') };
  }

  /** Ports the can is listening on, as [{port, createdAt}]. */
  listeners() {
    return this._vm.request('listeners');
  }

  // ---- browser (headless, inside the can; see SPEC.md section 10)

  /** Replaces the can's browser with one using these options (see Browser constructor). */
  openBrowser(options = {}) {
    return this._vm.request('openBrowser', { options });
  }

  /**
   * Runs one browser action: goto, reload, back, forward, wait, text, html, links, query, snapshot,
   * click, type, select, submit, evaluate, newTab, selectTab, closeTab, cookieList, clearConsole, state, screenshot
   * (screenshot returns base64; use Can.screenshot for bytes).
   */
  browse(action, ...args) {
    return this._vm.request('browse', { action, args });
  }

  /**
   * PNG of the page the can's browser is showing, as a Buffer (see Browser.screenshot for the options:
   * fullPage, width, height). The VM child renders it; this side only decodes the base64 reply.
   */
  async screenshot(opts = {}) {
    return Buffer.from(await this.browse('screenshot', opts), 'base64');
  }

  // ---- state

  snapshot() {
    return pullSnapshot(this._vm);
  }

  /** Replaces the can's filesystem and env. Processes are stopped and ports closed first. */
  async restore(snapshot) {
    const meta = await pushSnapshot(this._vm, snapshot, []);
    this.name = meta.name;
    this._vm.label = meta.name;
    return meta;
  }

  /** Stops every process, closes every port and terminates the can VM. */
  async destroy() {
    await this._vm.shutdown();
  }
}

/** Buffers in exec/spawn options (stdin) travel as strings. */
function wireOpts(opts) {
  if (opts.stdin === undefined || typeof opts.stdin === 'string') return opts;
  return { ...opts, stdin: Buffer.from(opts.stdin).toString('utf8') };
}
