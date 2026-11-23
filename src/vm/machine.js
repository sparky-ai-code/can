// Machine: one complete virtual machine = filesystem + virtual network + process table + environment.
// It runs inside a can VM process (see worker.js). The host talks to it only through the RPC in
// protocol.js; the host-side handle is src/can.js.
import { VFS, VFS_FORMAT, VFS_VERSION } from '../kernel/vfs.js';
import { VNet } from '../kernel/vnet.js';
import { ProcessTable } from '../kernel/proc.js';
import { KernelError } from '../kernel/errors.js';
import defaultExecutor from '../runtime/executor.js';
import { normalizePolicy } from './policy.js';

const SNAPSHOT_FORMAT = 'can-snapshot';
const TIMEOUT_EXIT_CODE = 124; // same convention as coreutils `timeout`
/** Foreground runs are killed after this long unless the caller asks for another limit (0 = no limit). */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

export function checkSnapshot(snap) {
  if (snap?.format !== SNAPSHOT_FORMAT || snap.version !== 1) {
    throw new KernelError('EINVAL', 'EINVAL: not a can snapshot (format can-snapshot, version 1)');
  }
  return snap;
}

export class Machine {
  /**
   * @param {object} opts
   * @param {string} opts.id unique id
   * @param {string} [opts.name] human name (defaults to id)
   * @param {VFS} [opts.vfs] filesystem (defaults to an empty one)
   * @param {Record<string,string>} [opts.env] environment variables
   * @param {number} [opts.createdAt]
   * @param {Function} [opts.executor] command executor (defaults to the runtime executor)
   * @param {number} [opts.execTimeoutMs] default exec timeout (DEFAULT_EXEC_TIMEOUT_MS)
   * @param {object} [opts.policy] network and runtime settings (see vm/policy.js); missing keys take defaults
   */
  constructor({
    id, name = id, vfs = new VFS(), env = {}, createdAt = Date.now(), executor = defaultExecutor,
    execTimeoutMs = DEFAULT_EXEC_TIMEOUT_MS, policy = {},
  } = {}) {
    if (!id) throw new TypeError('Machine requires an id');
    this.id = id;
    this.name = name;
    this.vfs = vfs;
    this.env = { ...env };
    this.createdAt = createdAt;
    this.execTimeoutMs = execTimeoutMs;
    this.policy = normalizePolicy(policy);
    this.vnet = new VNet();
    this.proc = new ProcessTable({ executor, can: this });
    this._epoch = 0; // counts restores, which replace the filesystem, env, policy and name
  }

  /**
   * A token that changes whenever the saved state (snapshotHead and the tree) may have changed: the filesystem, its
   * cwd and mounts (VFS.generation), or a restore. Processes and ports are not part of the saved state, so they do not
   * change it. Equal tokens mean the saved file already holds this state (see CanManager.save).
   */
  generation() {
    return `${this._epoch}.${this.vfs.generation}`;
  }

  /** Starts a process. Returns its view. See ProcessTable.spawn. */
  spawn(command, opts = {}) {
    return this.proc.spawn(command, opts);
  }

  /**
   * Runs a command in the foreground and collects its output.
   * Options: cwd, env, stdin (string/Buffer, then EOF), timeout (ms; on expiry the process is
   * SIGKILLed and exitCode is 124). Without a timeout the machine's execTimeoutMs applies; 0 means no limit.
   * @returns {Promise<{exitCode: number, signal: string|null, stdout: string, stderr: string, timedOut: boolean}>}
   */
  async exec(command, opts = {}) {
    const { timeout = this.execTimeoutMs, stdin, ...spawnOpts } = opts;
    const { pid } = this.proc.spawn(command, { ...spawnOpts, background: false });
    if (stdin !== undefined) this.proc.writeStdin(pid, stdin);
    this.proc.endStdin(pid);

    let timedOut = false;
    let exited;
    try {
      exited = await this.proc.wait(pid, timeout > 0 ? timeout : undefined);
    } catch (err) {
      if (err.code !== 'ETIMEDOUT') throw err;
      timedOut = true;
      if (this.proc.get(pid).status === 'running') this.proc.kill(pid, 'SIGKILL');
      exited = this.proc.get(pid);
    }
    const result = {
      exitCode: timedOut ? TIMEOUT_EXIT_CODE : exited.exitCode,
      signal: exited.signal,
      stdout: this.proc.output(pid, 'stdout').toString('utf8'),
      stderr: this.proc.output(pid, 'stderr').toString('utf8'),
      timedOut,
    };
    this.proc.remove(pid); // foreground records are not kept
    return result;
  }

  /**
   * Mounts host folders read-only (see VFS.mount). Each entry is {label, canPath, hostDir}; hostDir is used here
   * and never saved. Call after create or restore.
   */
  mountAll(mounts = []) {
    for (const m of mounts) this.vfs.mount(m.canPath, m.hostDir, { label: m.label });
  }

  /**
   * JSON-serializable state: identity, env, filesystem and mounts (labels and paths only). Processes and ports
   * are not included.
   */
  snapshot() {
    return { ...this.snapshotHead(), vfs: this.vfs.serialize() };
  }

  /**
   * The snapshot without its file tree: the fields, the tree's format and cwd, and the mounts. A paged snapshot
   * (src/vm/snapshot-pages.js) sends this first, then the tree.
   */
  snapshotHead() {
    return {
      format: SNAPSHOT_FORMAT,
      version: 1,
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      env: { ...this.env },
      policy: { ...this.policy },
      vfs: { format: VFS_FORMAT, version: VFS_VERSION, cwd: this.vfs.cwd },
      mounts: this.vfs.mountList(),
    };
  }

  /**
   * Replaces filesystem and env with the snapshot's. Stops all processes and closes all ports first. The caller
   * mounts the host folders again with mountAll.
   */
  restore(snap) {
    checkSnapshot(snap);
    this._stopAll();
    this._epoch++;
    this.name = snap.name ?? this.name;
    this.env = { ...snap.env };
    this.policy = normalizePolicy(snap.policy ?? {});
    this.vfs = snap.vfs instanceof VFS ? snap.vfs : VFS.deserialize(snap.vfs);
  }

  static fromSnapshot(snap, { executor } = {}) {
    checkSnapshot(snap);
    return new Machine({
      id: snap.id,
      name: snap.name,
      env: snap.env,
      policy: snap.policy ?? {},
      createdAt: snap.createdAt,
      vfs: snap.vfs instanceof VFS ? snap.vfs : VFS.deserialize(snap.vfs),
      executor,
    });
  }

  /** Kills all processes and closes all ports. The machine should not be used afterwards. */
  destroy() {
    this._stopAll();
  }

  _stopAll() {
    this.proc.killAll('SIGKILL');
    this.vnet.closeAll();
  }
}
