// Runs WASI (wasm32-wasip1) programs for the can. Runs in the can's child process (src/vm), not inside the can's vm
// context. Each program runs in its own worker thread (wasm-worker.js), so a program that never returns can be
// stopped: the kill signal and the exec timeout call worker.terminate(). The can's files stay in this thread: the
// worker asks for each VFS call (see wasm-worker.js). Read-only host overlays are read by the worker directly.
//
// Exit codes: the program's own code from proc_exit; 137 when the program ran into its memory limit (stderr says
// so) or was killed with SIGKILL; 143 when it was killed with SIGTERM; 134 for any other trap; 5 when a file the
// program wrote could not be saved when the program ended.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, MessageChannel } from 'node:worker_threads';
import { Buffer } from 'node:buffer';
import { KernelError } from '../../kernel/errors.js';
import { applyMemoryLimit } from './memlimit.js';

/** The default memory limit for one program: the same as one can's limit (owner decision 11). */
export const DEFAULT_MEMORY_LIMIT_BYTES = 700 * 1024 * 1024;
export const EXIT_NO_MEMORY = 137;
export const EXIT_TRAP = 134;
export const EXIT_SAVE_FAILED = 5;
export const EXIT_TERMINATED = 143;
export const ENOMEM_TEXT = 'ENOMEM: wasm memory limit reached. Next: do less at once.';

const WORKER_FILE = fileURLToPath(new URL('./wasm-worker.js', import.meta.url));
/** The heap of the worker's JS is small (the program's memory is a wasm memory, outside the JS heap). */
const WORKER_HEAP_MB = 64;
const KILL_CODES = { SIGHUP: 129, SIGINT: 130, SIGKILL: 137, SIGTERM: 143 };
const PYTHON_HOME = '/usr';
const PYTHON_LIB = '/usr/lib/python3.15';
const VFS_OPS = ['stat', 'lstat', 'readFile', 'writeFile', 'mkdir', 'rmdir', 'unlink', 'rename', 'readlink', 'utimes', 'readdir'];
const noop = () => {};

const isWasm = (bytes) => bytes.length >= 8 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;

/** Reads the module from `bytes`, or from a host file path (read by this process). */
function loadBytes({ bytes, path: file }) {
  if (bytes !== undefined) {
    if (!(bytes instanceof Uint8Array)) throw new KernelError('EINVAL', 'EINVAL: bytes must be a Uint8Array. Next: pass the module bytes.');
    return bytes;
  }
  if (typeof file !== 'string' || file === '') throw new KernelError('EINVAL', 'EINVAL: runWasm needs bytes or a path. Next: pass the module.');
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new KernelError('ENOENT', `ENOENT: no such wasm file ${path.basename(file)}. Next: check the path.`);
    throw new KernelError('EIO', `EIO: cannot read the wasm file ${path.basename(file)} (${err.code}). Next: check the file.`);
  }
}

/** stdin as a pull function: bytes or a string are handed out once, then end of file. */
function stdinSource(stdin) {
  if (typeof stdin === 'function') return stdin;
  let given = false;
  const bytes = stdin === undefined ? new Uint8Array(0) : Buffer.from(stdin);
  return () => {
    if (given) return null;
    given = true;
    return bytes;
  };
}

/** A VFS request from the worker, answered on the main thread. Stat results are plain data (no class to copy). */
function serve(job, m) {
  if (m.op === 'stdin') return job.stdinNext(m.args[0]);
  if (!VFS_OPS.includes(m.op)) throw new KernelError('EINVAL', `EINVAL: the program asked for ${m.op}, which the can does not offer. Next: check the program.`);
  const r = job.vfs[m.op](...m.args);
  if (m.op === 'stat' || m.op === 'lstat') {
    return { type: r.type, size: r.size, mtime: r.mtime, ctime: r.ctime, birthtime: r.birthtime };
  }
  return r ?? null;
}

/** Adds the worker's VFS round trips to o.stats.rpcs (only when a caller asks for the counts). */
function countRoundTrips(job, m) {
  if (job.stats) job.stats.rpcs = (job.stats.rpcs ?? 0) + (m.rpcs ?? 0);
}

/**
 * Runs the prepared job in a worker thread. Resolves with the exit code; rejects with KernelError for a start-up
 * failure. An abort (kill or exec timeout) terminates the worker and resolves with 128 + the signal number.
 */
function runInWorker(job) {
  return new Promise((resolve, reject) => {
    if (job.signal?.aborted) {
      resolve(KILL_CODES[job.signal.reason] ?? EXIT_TERMINATED);
      return;
    }
    const shared = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(WORKER_FILE, {
      workerData: { sab: shared.buffer, replyPort: port2, config: job.config },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    let settled = false;
    const finish = (action) => {
      if (settled) return;
      settled = true;
      job.signal?.removeEventListener('abort', onAbort);
      port1.close();
      action();
    };
    const onAbort = () => {
      const code = KILL_CODES[job.signal.reason] ?? EXIT_TERMINATED;
      finish(() => {
        worker.terminate();
        resolve(code);
      });
    };
    job.signal?.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (m) => {
      if (settled) return;
      if (m.t === 'req') {
        let reply;
        try {
          reply = { value: serve(job, m) };
        } catch (err) {
          reply = { err: { code: err?.code ?? 'EIO', message: err?.message ?? String(err) } };
        }
        // The reply is queued before the flag is set, so the worker finds it as soon as it wakes.
        port1.postMessage(reply);
        Atomics.store(shared, 0, 1);
        Atomics.notify(shared, 0);
      } else if (m.t === 'out') {
        const out = m.fd === 1 ? job.stdout : job.stderr;
        try {
          out(Buffer.from(m.chunk.buffer, m.chunk.byteOffset, m.chunk.byteLength));
        } catch {
          // a closed pipe on the far side does not stop the program here
        }
      } else if (m.t === 'done') {
        countRoundTrips(job, m);
        finish(() => resolve(m.code));
      } else if (m.t === 'fatal') {
        countRoundTrips(job, m);
        finish(() => reject(new KernelError(m.code, m.message)));
      }
    });
    worker.on('error', (err) => finish(() => reject(new KernelError(
      'EIO', `EIO: the program's thread failed (${err.message}). Next: run the program again.`))));
    worker.on('exit', (code) => finish(() => reject(new KernelError(
      'EIO', `EIO: the program ended without a result (thread exit ${code}). Next: run the program again.`))));
  });
}

/**
 * Runs a wasm32-wasip1 program.
 *
 * @param {object} o
 * @param {Uint8Array} [o.bytes] the module (or give path)
 * @param {string} [o.path] a host path to the module
 * @param {string[]} [o.args] argv; args[0] is the program name
 * @param {object} [o.env] environment variables
 * @param {string} [o.cwd] stored as PWD. WASI has no working directory: relative paths start at a preopen.
 * @param {object} o.vfs the can's VFS
 * @param {Uint8Array|string|(() => Uint8Array|null)} [o.stdin] fixed bytes, or a pull function
 * @param {(chunk: Uint8Array) => void} [o.stdout]
 * @param {(chunk: Uint8Array) => void} [o.stderr]
 * @param {{rpcs?: number}} [o.stats] when given, gets the count of VFS round trips to the main thread (a debug count)
 * @param {boolean} [o.vfsCache] false turns the per-run read cache off (for measuring)
 * @param {AbortSignal} [o.signal] aborting it stops the program (reason "SIGKILL" gives 137, "SIGTERM" 143)
 * @param {Array<{guest: string, canPath: string}>} [o.preopens] guest folders mapped to can paths (default "/" to "/")
 * @param {Array<{at: string, hostDir: string, writable?: string[]}>} [o.hostMounts] host folders shown read-only
 * @param {number} [o.memoryLimitBytes] the most memory the program may use (default 700 MiB)
 * @returns {Promise<number>} the exit code
 */
export async function runWasm(o) {
  const vfs = o.vfs;
  if (!vfs || typeof vfs.readFile !== 'function') throw new KernelError('EINVAL', 'EINVAL: runWasm needs the can VFS. Next: pass vfs.');
  const stderr = o.stderr ?? noop;
  const writeErr = (text) => stderr(Buffer.from(`${text}\n`));

  const raw = loadBytes(o);
  if (!isWasm(raw)) {
    throw new KernelError('EINVAL', `EINVAL: ${o.path ? path.basename(o.path) : 'the file'} is not a WebAssembly module (exec format error). Next: check it is a wasm32-wasip1 .wasm build.`);
  }
  const limitBytes = o.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
  let limited;
  try {
    limited = applyMemoryLimit(raw, limitBytes);
  } catch (err) {
    if (err?.code !== 'ENOMEM') throw err;
    writeErr(err.message);
    return EXIT_NO_MEMORY;
  }

  const preopens = o.preopens ?? [{ guest: '/', canPath: '/' }];
  const preopenList = preopens.map((p) => ({ guest: p.guest, canPath: path.posix.resolve('/', p.canPath) }));
  for (const p of preopenList) {
    if (!vfs.exists(p.canPath)) throw new KernelError('ENOENT', `ENOENT: the folder ${p.canPath} does not exist in the can. Next: create it first.`);
  }
  const env = { ...(o.env ?? {}) };
  if (o.cwd !== undefined && env.PWD === undefined) env.PWD = o.cwd;
  const args = o.args ?? [path.basename(o.path ?? 'program')];

  return runInWorker({
    vfs,
    signal: o.signal,
    stdout: o.stdout ?? noop,
    stderr,
    stdinNext: stdinSource(o.stdin),
    stats: o.stats,
    config: {
      vfsCache: o.vfsCache !== false,
      limited: { bytes: limited.bytes, importMaxPages: limited.importMaxPages },
      args,
      env,
      preopens: preopenList,
      hostMounts: o.hostMounts ?? [],
      memoryLimitBytes: limitBytes,
    },
  });
}

/**
 * Runs CPython (wasm32-wasip1). The toolchain is found by resolveTool('python', '3.15') in src/toolchains.js,
 * which never downloads. The stdlib is shown read-only at /usr/lib/python3.15 (a host overlay, not copied into the
 * can). Its site-packages folder stays in the can VFS so pip can install there. Python sees the can VFS as "/".
 *
 * @param {object} o the same options as runWasm; args are the arguments after "python"
 * @returns {Promise<number>}
 */
export async function runPython(o) {
  let toolchain;
  try {
    const { resolveTool } = await import('../../toolchains.js');
    toolchain = await resolveTool('python', '3.15');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new KernelError('ENOENT', 'ENOENT: the Python toolchain module is missing. Next: reinstall can.');
    }
    throw err;
  }
  const wasmFile = path.join(toolchain.dir, 'python.wasm');
  const libDir = path.join(toolchain.dir, 'lib', 'python3.15');
  if (!fs.existsSync(wasmFile) || !fs.existsSync(libDir)) {
    throw new KernelError('ENOENT', 'ENOENT: the Python toolchain is incomplete. Next: reinstall or re-fetch the python tool.');
  }
  const sitePackages = `${PYTHON_LIB}/site-packages`;
  if (!o.vfs.exists(sitePackages)) o.vfs.mkdir(sitePackages, { recursive: true });
  return runWasm({
    ...o,
    path: wasmFile,
    args: ['python', ...(o.args ?? [])],
    env: {
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      ...(o.env ?? {}),
      PYTHONHOME: PYTHON_HOME,
      PYTHONPATH: sitePackages,
    },
    preopens: [{ guest: '/', canPath: '/' }],
    hostMounts: [{ at: PYTHON_LIB, hostDir: libDir, writable: [sitePackages] }],
  });
}
