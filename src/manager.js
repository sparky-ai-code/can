// CanManager: creates, looks up, saves, loads and destroys cans. Each can is its own VM process
// (see can.js and vm/supervisor.js). Persisted state lives only under storeDir
// (default %USERPROFILE%\.can\cans). No host path is ever mounted into a can.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Can } from './can.js';
import { KernelError } from './kernel/errors.js';
import { DEFAULT_ENV } from './vm/seed.js';
import { resolveMounts, defaultMountsFile } from './mounts.js';
import { normalizeEnvironment, applyEnvironment } from './environment.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export { DEFAULT_ENV };

export function defaultStoreDir() {
  return path.join(os.homedir(), '.can', 'cans');
}

export class CanManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.storeDir] where saved can state is written
   * @param {boolean} [opts.layer2=true] false only for the layer-1-only test (see test/vm.test.js)
   * @param {string} [opts.mountsFile] the host's allowlist of read-only mounts (see src/mounts.js)
   */
  constructor({ storeDir = defaultStoreDir(), layer2 = true, mountsFile = defaultMountsFile() } = {}) {
    this.storeDir = storeDir;
    this.layer2 = layer2;
    this.mountsFile = mountsFile;
    this.cans = new Map(); // id -> Can (live cans, including crashed ones until destroyed)
    this._names = new Set(); // names reserved by creates and loads still in progress
    this._autoCounter = 0;
  }

  /**
   * Creates a seeded can in its own VM. Names must be unique; omitted names become can-N.
   * `mounts` is a list of {label, canPath}: host folders from the mounts file, mounted read-only.
   * `environment` (optional, see src/environment.js) is checked before anything boots, then applied before the
   * can is returned. If any step fails the can is destroyed and the error is thrown. The result of the steps is
   * kept on can.report.
   */
  async create({ name, env = {}, mounts = [], environment } = {}) {
    const finalName = name ?? this._autoName();
    if (typeof finalName !== 'string' || finalName === '') throw new TypeError('name must be a non-empty string');
    const spec = normalizeEnvironment(environment);
    const resolved = resolveMounts(mounts, this.mountsFile);
    this._reserveName(finalName);
    try {
      const id = randomUUID();
      const can = await Can.open({
        id, name: finalName, env: { ...env, ...spec.env }, layer2: this.layer2, mounts: resolved, policy: spec.policy,
      });
      try {
        can.report = await applyEnvironment(can, spec);
      } catch (err) {
        await can.destroy();
        throw err;
      }
      this.cans.set(id, can);
      return can;
    } finally {
      this._names.delete(finalName);
    }
  }

  /** Looks up a live can by id or name. Returns undefined if absent. */
  get(idOrName) {
    return this.cans.get(idOrName) ?? [...this.cans.values()].find((c) => c.name === idOrName);
  }

  list() {
    return [...this.cans.values()];
  }

  /** Stops the can's VM, removes it from memory and deletes its saved file, if any. */
  async destroy(idOrName) {
    const can = this._require(idOrName);
    this.cans.delete(can.id);
    await can.destroy();
    fs.rmSync(this._file(can.id), { force: true });
  }

  /** Writes the can's snapshot to <storeDir>/<id>.json (atomically). Returns the file path. */
  async save(idOrName) {
    const can = this._require(idOrName);
    const snap = await can.snapshot();
    const file = this._file(can.id);
    fs.mkdirSync(this.storeDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, file);
    return file;
  }

  /** Starts a saved can in a new VM. If that id is already live, returns the live instance. */
  async load(id) {
    const file = this._file(id);
    if (this.cans.has(id)) return this.cans.get(id);
    let snap;
    try {
      snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw new KernelError('ENOENT', `ENOENT: no saved can "${id}"`, { path: file });
      throw err;
    }
    if (snap?.id !== id) throw new KernelError('EINVAL', `EINVAL: saved file ${id}.json holds can ${snap?.id}`);
    const mounts = resolveMounts(snap.mounts ?? [], this.mountsFile);
    this._reserveName(snap.name);
    try {
      const can = await Can.open({ snapshot: snap, layer2: this.layer2, mounts });
      this.cans.set(can.id, can);
      return can;
    } finally {
      this._names.delete(snap.name);
    }
  }

  /** Stops every live can. For shutdown paths and tests. */
  async destroyAll() {
    await Promise.all(this.list().map((c) => this.destroy(c.id)));
  }

  /** Stops a can's VM and removes it from memory. Its saved file, if any, is kept (unlike destroy). */
  async stop(idOrName) {
    const can = this._require(idOrName);
    this.cans.delete(can.id);
    await can.destroy();
  }

  /** Stops every live can without deleting saved files. */
  async stopAll() {
    await Promise.all(this.list().map((c) => this.stop(c.id)));
  }

  _reserveName(name) {
    if (this.get(name) || this._names.has(name)) {
      throw new KernelError('EEXIST', `EEXIST: a can named "${name}" already exists`);
    }
    this._names.add(name);
  }

  _require(idOrName) {
    const can = this.get(idOrName);
    if (!can) throw new KernelError('ENOENT', `ENOENT: no can "${idOrName}"`);
    return can;
  }

  _file(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new KernelError('EINVAL', `EINVAL: invalid can id ${id}`);
    return path.join(this.storeDir, `${id}.json`);
  }

  _autoName() {
    let name;
    do {
      name = `can-${++this._autoCounter}`;
    } while (this.get(name) || this._names.has(name));
    return name;
  }
}
