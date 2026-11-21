// Virtual process table. Every spawn gets a pid and buffered stdout/stderr, and runs through the
// pluggable executor (contract in SPEC.md). Nothing here starts host processes.
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { KernelError } from './errors.js';

export const OUTPUT_CAP_BYTES = 1024 * 1024;
const SIGNUM = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

/** Byte-capped buffer that keeps the newest bytes and counts what it dropped. */
export class RingBuffer {
  constructor(capBytes = OUTPUT_CAP_BYTES) {
    this.cap = capBytes;
    this.chunks = [];
    this.size = 0;
    this.dropped = 0;
  }

  push(buf) {
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.size += buf.length;
    while (this.size > this.cap) {
      const excess = this.size - this.cap;
      const first = this.chunks[0];
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
        this.dropped += first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
        this.dropped += excess;
      }
    }
  }

  read() {
    return Buffer.concat(this.chunks, this.size);
  }
}

/** Public, copyable view of a process entry. */
function view(e) {
  return {
    pid: e.pid,
    command: e.command,
    cwd: e.cwd,
    env: { ...e.env },
    background: e.background,
    status: e.status,
    exitCode: e.exitCode,
    signal: e.signal,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
  };
}

export class ProcessTable extends EventEmitter {
  /**
   * @param {object} opts
   * @param {(ctx: object) => Promise<number|void>} opts.executor runs commands (see SPEC.md)
   * @param {object} [opts.can] owning Can; supplies default cwd, env and the vfs used to validate cwd
   * @param {number} [opts.outputCap] per-stream output cap in bytes
   */
  constructor({ executor, can = null, outputCap = OUTPUT_CAP_BYTES } = {}) {
    super();
    if (typeof executor !== 'function') throw new TypeError('ProcessTable requires an executor function');
    this.executor = executor;
    this.can = can;
    this.outputCap = outputCap;
    this.procs = new Map(); // pid -> internal entry
    this._nextPid = 1;
  }

  /**
   * Starts a process. Returns its view immediately; the executor runs asynchronously.
   * Background processes are not awaited by exec(); they are tracked like any other.
   */
  spawn(command, opts = {}) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new TypeError('command must be a non-empty string');
    }
    const cwd = this._checkCwd(opts.cwd ?? this.can?.vfs.cwd ?? '/');
    const pid = this._nextPid++;
    const controller = new AbortController();
    const entry = {
      pid,
      command,
      cwd,
      env: { ...this.can?.env, ...opts.env },
      background: Boolean(opts.background),
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      endedAt: null,
      stdoutBuf: new RingBuffer(this.outputCap),
      stderrBuf: new RingBuffer(this.outputCap),
      controller,
      stdin: new PassThrough(),
      done: null,
      resolveDone: null,
    };
    entry.stdin.on('error', () => {}); // writes after exit must not crash the host process
    entry.done = new Promise((resolve) => { entry.resolveDone = resolve; });
    this.procs.set(pid, entry);
    this.emit('spawn', view(entry));

    const ctx = {
      pid,
      command,
      cwd,
      env: entry.env,
      can: this.can,
      signal: controller.signal,
      stdin: entry.stdin,
      stdout: this._sink(entry, 'stdout'),
      stderr: this._sink(entry, 'stderr'),
    };
    // Deferred so the executor never runs synchronously inside spawn(). A process killed before
    // it started never runs at all.
    Promise.resolve()
      .then(() => (entry.status === 'running' ? this.executor(ctx) : undefined))
      .then(
        (code) => this._exit(entry, Number.isInteger(code) ? code : 0),
        (err) => {
          this._write(entry, 'stderr', Buffer.from(`${err?.message ?? err}\n`));
          this._exit(entry, 1);
        },
      );
    return view(entry);
  }

  get(pid) {
    const e = this.procs.get(pid);
    return e ? view(e) : undefined;
  }

  list({ status } = {}) {
    return [...this.procs.values()].filter((e) => !status || e.status === status).map(view);
  }

  /** Buffered output (newest 1 MiB at most) as a Buffer. */
  output(pid, stream = 'stdout') {
    const e = this._entry(pid);
    if (stream !== 'stdout' && stream !== 'stderr') throw new KernelError('EINVAL', `EINVAL: unknown stream ${stream}`);
    return (stream === 'stdout' ? e.stdoutBuf : e.stderrBuf).read();
  }

  writeStdin(pid, data) {
    const e = this._entry(pid);
    if (e.status !== 'running') throw new KernelError('ESRCH', `ESRCH: process ${pid} has exited`, { pid });
    return e.stdin.write(data);
  }

  endStdin(pid) {
    const e = this._entry(pid);
    if (e.status === 'running') e.stdin.end();
  }

  /**
   * Sends a signal. The process is marked exited at once (exitCode 128 + signal number) and the
   * executor's ctx.signal aborts so it can clean up. Throws ESRCH if the process already exited.
   */
  kill(pid, signal = 'SIGTERM') {
    const e = this._entry(pid);
    if (!Object.hasOwn(SIGNUM, signal)) throw new KernelError('EINVAL', `EINVAL: unsupported signal ${signal}`);
    if (e.status === 'exited') throw new KernelError('ESRCH', `ESRCH: process ${pid} has exited`, { pid });
    e.controller.abort(signal);
    this._exit(e, null, signal);
    return true;
  }

  /**
   * Resolves with the process view once it exits. With timeoutMs, rejects with ETIMEDOUT
   * if the process is still running after that long (the process itself keeps running).
   */
  wait(pid, timeoutMs) {
    const e = this._entry(pid);
    if (timeoutMs === undefined || timeoutMs === null) return e.done;
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new KernelError(
        'ETIMEDOUT', `ETIMEDOUT: process ${pid} still running after ${timeoutMs}ms`, { pid })), timeoutMs);
    });
    return Promise.race([e.done, timedOut]).finally(() => clearTimeout(timer));
  }

  /** Forgets an exited process. */
  remove(pid) {
    const e = this._entry(pid);
    if (e.status === 'running') throw new KernelError('EINVAL', `EINVAL: process ${pid} is still running`, { pid });
    this.procs.delete(pid);
    return true;
  }

  /** Forgets all exited processes. Returns how many were removed. */
  clearExited() {
    let n = 0;
    for (const e of [...this.procs.values()]) {
      if (e.status === 'exited') { this.procs.delete(e.pid); n++; }
    }
    return n;
  }

  killAll(signal = 'SIGKILL') {
    for (const e of [...this.procs.values()]) {
      if (e.status === 'running') this.kill(e.pid, signal);
    }
  }

  // ---- internals ----------------------------------------------------------

  _entry(pid) {
    const e = this.procs.get(pid);
    if (!e) throw new KernelError('ESRCH', `ESRCH: no such process ${pid}`, { pid });
    return e;
  }

  _checkCwd(cwd) {
    const vfs = this.can?.vfs;
    if (!vfs) return cwd;
    const abs = vfs.resolve(cwd);
    if (!vfs.stat(abs).isDirectory()) throw new KernelError('ENOTDIR', `ENOTDIR: not a directory, chdir '${cwd}'`);
    return abs;
  }

  /** A Writable that feeds the entry's stdout or stderr buffer. */
  _sink(entry, name) {
    return new Writable({
      write: (chunk, _encoding, callback) => {
        this._write(entry, name, chunk);
        callback();
      },
    });
  }

  _write(entry, name, chunk) {
    if (entry.status !== 'running') return; // output after exit or kill is discarded
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    (name === 'stdout' ? entry.stdoutBuf : entry.stderrBuf).push(buf);
    this.emit('output', entry.pid, name, buf);
  }

  _exit(entry, exitCode, signal = null) {
    if (entry.status === 'exited') return;
    entry.status = 'exited';
    entry.exitCode = signal ? 128 + SIGNUM[signal] : exitCode;
    entry.signal = signal;
    entry.endedAt = Date.now();
    entry.stdin.destroy();
    const final = view(entry);
    this.emit('exit', final);
    entry.resolveDone(final);
  }
}
