// Host side of a can VM: forks one child Node process per can with Node's Permission Model
// (layer 1, the real boundary) and speaks the RPC in protocol.js over IPC.
//
// Child flags: --permission --allow-fs-read=<src dir> and nothing else. Node 24 has no --allow-net,
// so network access cannot be restricted by the permission model (see SPEC.md, residual risks).
// The child env is empty; libuv adds Windows system variables, which worker.js removes at boot.
//
// Memory (owner decision 11): each can has one limit, measured on its child process. Hard limit 700 MB: the
// monitor (memcap.js) kills the child and the can reports 'memory-limit'. Soft limit 630 MB: can.js refuses new
// exec and spawn calls with ENOMEM. V8's old space is capped at 600 MB inside the child. All sizes here use
// 1 MB = 1024 * 1024 bytes.
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KernelError } from '../kernel/errors.js';
import { decodeError } from './protocol.js';
import { startMemoryMonitor } from './memcap.js';
import { bundleDir, cacheDir, lockFilePath } from '../toolchains.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SRC_DIR = path.resolve(HERE, '..');
const WORKER = path.join(HERE, 'worker.js');
const START_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 3_000;
/**
 * Stuck watchdog: a VM with requests pending that sends nothing (not even its 250 ms memory report) for longer than
 * max(idle, longest pending timeout + 5 s) is busy-looping, so it is killed. CAN_STUCK_IDLE_MS overrides the idle
 * time (tests use a short one).
 */
const STUCK_IDLE_MS = 10_000;
const STUCK_GRACE_MS = 5_000;
const STUCK_CHECK_MS = 1_000;
const DEFAULT_EXEC_MS = 60_000; // the default exec timeout of Machine (machine.js DEFAULT_EXEC_TIMEOUT_MS)

/** One megabyte, in bytes (1 MB = 1024 * 1024 bytes everywhere in the memory code). */
export const MB = 1024 * 1024;
/** Heap cap of one can VM (V8 old space), in MB. Can code runs inside this process, so this caps the can's JS heap. */
export const VM_HEAP_MB = 600;
/** Hard memory limit of one can, in MB: its child process is killed above this. */
export const CAN_LIMIT_MB = 700;
/** Soft memory limit of one can, in MB: exec and spawn are refused at or above this. */
export const CAN_SOFT_MB = 630;
export const CAN_LIMIT_BYTES = CAN_LIMIT_MB * MB;
export const CAN_SOFT_BYTES = CAN_SOFT_MB * MB;

/** V8 prints one of these on stderr just before it aborts for lack of heap (the child then exits). */
const HEAP_LIMIT_TEXT = /Reached heap limit|JavaScript heap out of memory|ERR_MEMORY_ALLOCATION_FAILED/;

/** The error after a can was stopped for using more than its hard limit (interface I4). */
export function memoryLimitError(label) {
  return new KernelError('ENOMEM', `ENOMEM: can "${label}" used more than its ${CAN_LIMIT_MB} MB memory limit and was stopped. `
    + 'Its files from the last save are kept. Next: call can_restart, then do less at once or split the work across cans.');
}

/** The error after the stuck watchdog stopped a can that stopped responding. */
export function stuckError(label) {
  return new KernelError('ETIMEDOUT', `ETIMEDOUT: can "${label}" stopped responding (a program kept the CPU busy) and was stopped. `
    + 'Its files from the last save are kept. Next: call can_restart, and avoid busy loops or add a timeout.');
}

/** How long a request may run on its own timeout, in ms, or null when it has none (0 or no limit). */
function requestLimitMs(op, args) {
  let ms = null;
  if (op === 'exec') ms = args?.opts?.timeout ?? DEFAULT_EXEC_MS;
  else if (op === 'wait') ms = args?.timeout;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** The error from exec and spawn while a can is above its soft limit (interface I4). */
export function softLimitError(label, usedBytes) {
  return new KernelError('ENOMEM', `ENOMEM: can "${label}" is at ${Math.round(usedBytes / MB)} MB of its ${CAN_LIMIT_MB} MB limit. `
    + 'Next: can_kill a process you no longer need, then retry.');
}

/**
 * Node flags for a can VM. Exported so tests can show exactly what the child is given. Each mounted host folder
 * adds a read permission and no write permission, so the process cannot write there even if the VFS check were
 * bypassed. The two toolchain folders (bundled and cached, see toolchains.js) and the tool lock file are readable so
 * runPython can load python.wasm and its stdlib; they are read-only too.
 */
export function vmExecArgv({ layer2 = true, mounts = [] } = {}) {
  const flags = ['--permission', `--allow-fs-read=${SRC_DIR}`, `--max-old-space-size=${VM_HEAP_MB}`];
  for (const dir of [bundleDir(), cacheDir()]) flags.push(`--allow-fs-read=${dir}`);
  flags.push(`--allow-fs-read=${lockFilePath()}`); // the tool lock file (toolchains.lock.json), read by resolveTool
  for (const dir of mounts) flags.push(`--allow-fs-read=${dir}`);
  // Worker threads, for wasm execution (see runtime/wasi). Node documents that the permission model does not carry
  // over to a worker thread, so this flag is the one place where layer 1 has a known gap; see SPEC.md residual risks.
  flags.push('--allow-worker');
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
   * @param {string} [opts.label] the can's name (or id), used in ENOMEM messages
   * @returns {Promise<VmProcess>}
   */
  static async start({ layer2 = true, mounts = [], label } = {}) {
    const child = fork(WORKER, [layer2 ? '--layer2' : '--no-layer2'], {
      cwd: SRC_DIR,
      env: {},
      execArgv: vmExecArgv({ layer2, mounts }),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
      windowsHide: true,
    });
    let vm;
    try {
      vm = new VmProcess(child, label);
    } catch (err) {
      child.kill('SIGKILL');
      throw err;
    }
    try {
      await vm.ready;
    } catch (err) {
      vm.child.kill('SIGKILL');
      throw err;
    }
    return vm;
  }

  constructor(child, label) {
    this.child = child;
    this.pid = child.pid;
    this.label = label ?? String(child.pid);
    this.status = 'running'; // running -> stopping -> destroyed, or running -> crashed, or running -> memory-limit
    this.nextId = 1;
    this.pending = new Map(); // request id -> {resolve, reject}
    this.stderrTail = '';
    this.exitInfo = null;
    this.lastSeen = Date.now(); // the last message of any kind from the child (see the stuck watchdog)
    this._stuck = null;
    const idle = Number(process.env.CAN_STUCK_IDLE_MS);
    this._idleMs = idle > 0 ? idle : STUCK_IDLE_MS;
    this._watchdog = setInterval(() => this._checkStuck(), STUCK_CHECK_MS);
    this._watchdog.unref();
    // Bytes of the child: the monitor's reading (sampled) and the child's own RSS (reported over IPC). The larger
    // of the two is the used figure; peak is the highest used figure seen.
    this.memory = { sampled: 0, reported: 0, used: 0, peak: 0 };
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
    // 'close' (not 'exit') so that stderr is complete when the exit is classified (heap-limit text).
    child.on('close', (code, signal) => this._onExit(code, signal));

    this._monitor = startMemoryMonitor(child.pid, {
      limitBytes: CAN_LIMIT_BYTES,
      softBytes: CAN_SOFT_BYTES,
      onSample: (bytes) => this._noteMemory('sampled', bytes),
      onLimit: () => this._memoryLimit(),
    });
  }

  /** Sends one RPC request. Rejects with ECHILD if the VM is gone (ENOMEM if it was stopped for memory). */
  request(op, args = {}) {
    if (this.status !== 'running' && this.status !== 'stopping') return Promise.reject(this._gone());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, sentAt: Date.now(), limitMs: requestLimitMs(op, args) });
      this.child.send({ t: 'req', id, op, args }, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(this._gone(err));
        }
      });
    });
  }

  /** Memory of the can's child: {usedBytes, peakBytes, softBytes, limitBytes, enforced} (see memcap.js). */
  memoryInfo() {
    return {
      usedBytes: this.memory.used,
      peakBytes: this.memory.peak,
      softBytes: CAN_SOFT_BYTES,
      limitBytes: CAN_LIMIT_BYTES,
      enforced: this._monitor.enforced,
    };
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

  _noteMemory(kind, bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    if (kind === 'sampled') {
      this.memory.sampled = bytes;
    } else {
      this.memory.reported = bytes;
      this._monitor.report(bytes); // the monitor keeps it for macOS (see memcap.js)
    }
    this.memory.used = Math.max(this.memory.sampled, this.memory.reported);
    if (this.memory.used > this.memory.peak) this.memory.peak = this.memory.used;
  }

  /** The monitor saw the hard limit: the child is killed here (the helper and the monitor never kill). */
  _memoryLimit() {
    if (this.status !== 'running') return;
    this.status = 'memory-limit';
    this.child.kill('SIGKILL');
  }

  /** Stops a VM that kept the CPU busy: requests pending, and nothing received from it for too long. */
  _checkStuck() {
    if (this.status !== 'running' || this.pending.size === 0) return;
    let longest = 0;
    let oldestSent = Infinity;
    for (const p of this.pending.values()) {
      if (p.limitMs && p.limitMs > longest) longest = p.limitMs;
      if (p.sentAt < oldestSent) oldestSent = p.sentAt;
    }
    const threshold = Math.max(this._idleMs, longest > 0 ? longest + STUCK_GRACE_MS : 0);
    // Silence counts from the later of the last message and the oldest pending request, so a request sent to a VM
    // that was already quiet gets its full allowance.
    const silent = Date.now() - Math.max(this.lastSeen, oldestSent);
    if (silent <= threshold) return;
    this._stuck = stuckError(this.label);
    this.status = 'crashed';
    this.child.kill('SIGKILL');
  }

  _gone(cause) {
    if (this._stuck) return this._stuck;
    if (this.status === 'memory-limit') return memoryLimitError(this.label);
    const state = this.status === 'crashed' ? 'crashed' : this.status === 'running' ? 'unreachable' : 'stopped';
    const detail = this.exitInfo ? ` (code ${this.exitInfo.code}, signal ${this.exitInfo.signal})` : '';
    const tail = this.exitInfo?.stderr ? `\n${this.exitInfo.stderr.trim()}` : '';
    const why = cause ? `: ${cause.message}` : '';
    return new KernelError('ECHILD', `ECHILD: can VM process ${this.pid} is ${state}${detail}${why}${tail}`, { pid: this.pid });
  }

  _onMessage(msg) {
    this.lastSeen = Date.now();
    if (msg?.t === 'mem') {
      this._noteMemory('reported', msg.rss);
      return;
    }
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
    clearInterval(this._watchdog);
    this._monitor.stop();
    const expected = this.status === 'stopping';
    this.exitInfo = { code, signal, stderr: this.stderrTail };
    if (this.status !== 'memory-limit' && !this._stuck) {
      // A V8 heap abort is a memory stop, not a crash: same ENOMEM as the monitor's kill.
      if (!expected && HEAP_LIMIT_TEXT.test(this.stderrTail)) this.status = 'memory-limit';
      else if (expected) this.status = 'destroyed';
      else this.status = code === 0 && signal === null ? 'exited' : 'crashed';
    }
    const err = this._gone();
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
    this._failReady(err);
    this._resolveExit(this.exitInfo);
  }
}
