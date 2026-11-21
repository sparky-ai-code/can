// Host side of a can VM: forks one child Node process per can with Node's Permission Model
// (layer 1, the real boundary) and speaks the RPC in protocol.js over IPC.
//
// Child flags: --permission --allow-fs-read=<src dir> and nothing else. Node 24 has no --allow-net,
// so network access cannot be restricted by the permission model (see SPEC.md, residual risks).
// The child env is empty; libuv adds Windows system variables, which worker.js removes at boot.
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KernelError } from '../kernel/errors.js';
import { decodeError } from './protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SRC_DIR = path.resolve(HERE, '..');
const WORKER = path.join(HERE, 'worker.js');
const START_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 3_000;
/** Heap cap of one can VM. Can code runs inside this process, so this caps the memory of the can. */
export const VM_HEAP_MB = 512;

/**
 * Node flags for a can VM. Exported so tests can show exactly what the child is given. Each mounted host folder
 * adds a read permission and no write permission, so the process cannot write there even if the VFS check were
 * bypassed.
 */
export function vmExecArgv({ layer2 = true, mounts = [] } = {}) {
  const flags = ['--permission', `--allow-fs-read=${SRC_DIR}`, `--max-old-space-size=${VM_HEAP_MB}`];
  for (const dir of mounts) flags.push(`--allow-fs-read=${dir}`);
  if (layer2) flags.push('--disallow-code-generation-from-strings');
  return flags;
}

const live = new Set();
// If the host exits for any reason, no can VM may outlive it. (The IPC disconnect also stops them.)
process.once('exit', () => {
  for (const vm of live) {
    try { vm.child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

export class VmProcess {
  /**
   * Starts a can VM and resolves once it reports ready.
   * @param {object} [opts]
   * @param {boolean} [opts.layer2=true] false only for the layer-1-only test (see test/vm.test.js)
   * @param {string[]} [opts.mounts=[]] absolute host folders the VM may read (see vmExecArgv)
   * @returns {Promise<VmProcess>}
   */
  static async start({ layer2 = true, mounts = [] } = {}) {
    const child = fork(WORKER, [layer2 ? '--layer2' : '--no-layer2'], {
      cwd: SRC_DIR,
      env: {},
      execArgv: vmExecArgv({ layer2, mounts }),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
      windowsHide: true,
    });
    const vm = new VmProcess(child);
    try {
      await vm.ready;
    } catch (err) {
      vm.child.kill('SIGKILL');
      throw err;
    }
    return vm;
  }

  constructor(child) {
    this.child = child;
    this.pid = child.pid;
    this.status = 'running'; // running -> stopping -> exited, or running -> crashed
    this.nextId = 1;
    this.pending = new Map(); // request id -> {resolve, reject}
    this.stderrTail = '';
    this.exitInfo = null;
    live.add(this);

    let markReady;
    let failReady;
    this.ready = new Promise((resolve, reject) => { markReady = resolve; failReady = reject; });
    this.exited = new Promise((resolve) => { this._resolveExit = resolve; });
    this._markReady = markReady;
    this._failReady = failReady;
    this._timer = setTimeout(() => {
      this._failReady(new KernelError('ETIMEDOUT', `ETIMEDOUT: can VM ${this.pid} did not start within ${START_TIMEOUT_MS}ms`));
    }, START_TIMEOUT_MS);
    this._timer.unref();

    child.stderr.on('data', (chunk) => { this.stderrTail = (this.stderrTail + chunk).slice(-4096); });
    child.on('message', (msg) => this._onMessage(msg));
    child.on('error', (err) => this._onExit(null, `error: ${err.message}`));
    child.on('exit', (code, signal) => this._onExit(code, signal));
  }

  /** Sends one RPC request. Rejects with ECHILD if the VM is gone. */
  request(op, args = {}) {
    if (this.status !== 'running' && this.status !== 'stopping') return Promise.reject(this._gone());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ t: 'req', id, op, args }, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(this._gone(err));
        }
      });
    });
  }

  /** Asks the VM to destroy its can and exit; falls back to SIGKILL after a grace period. */
  async shutdown() {
    if (this.status === 'running') {
      this.status = 'stopping';
      try {
        await this.request('shutdown');
      } catch { /* the VM may already be gone; the exit handler settles everything */ }
      const timer = setTimeout(() => this.child.kill('SIGKILL'), STOP_GRACE_MS);
      await this.exited;
      clearTimeout(timer);
    }
    await this.exited;
  }

  /** Forces the VM down without asking. */
  kill() {
    if (this.status === 'running') this.status = 'stopping';
    if (this.exitInfo === null) this.child.kill('SIGKILL');
    return this.exited;
  }

  _gone(cause) {
    const state = this.status === 'crashed' ? 'crashed' : this.status === 'running' ? 'unreachable' : 'stopped';
    const detail = this.exitInfo ? ` (code ${this.exitInfo.code}, signal ${this.exitInfo.signal})` : '';
    const tail = this.exitInfo?.stderr ? `\n${this.exitInfo.stderr.trim()}` : '';
    const why = cause ? `: ${cause.message}` : '';
    return new KernelError('ECHILD', `ECHILD: can VM process ${this.pid} is ${state}${detail}${why}${tail}`, { pid: this.pid });
  }

  _onMessage(msg) {
    if (msg?.t === 'ready') {
      clearTimeout(this._timer);
      this._markReady(this);
      return;
    }
    if (msg?.t !== 'res') return;
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.value);
    else waiter.reject(decodeError(msg.error));
  }

  _onExit(code, signal) {
    if (this.exitInfo) return;
    live.delete(this);
    clearTimeout(this._timer);
    const expected = this.status === 'stopping';
    this.exitInfo = { code, signal, stderr: this.stderrTail };
    this.status = expected ? 'exited' : 'crashed';
    const err = this._gone();
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
    this._failReady(err);
    this._resolveExit(this.exitInfo);
  }
}
