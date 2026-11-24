// CanManager: creates, looks up, saves, loads and destroys cans. Each can is its own VM process
// (see can.js and vm/supervisor.js). Persisted state lives only under storeDir
// (default %USERPROFILE%\.can\cans). No host path is ever mounted into a can.
//
// Saved file (<storeDir>/<id>.json): the can snapshot (see Can.snapshot) plus one extra key, canMeta:
//   { specKey, tools: [{name, version, sha256}], savedAt }
// specKey is the hash of the environment spec and mounts the can was created with (see environmentKey), so
// can_create can tell a repeat call from a conflicting one. savedAt is the ISO time of the save.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Can } from './can.js';
import { KernelError } from './kernel/errors.js';
import { DEFAULT_ENV } from './vm/seed.js';
import { resolveMounts, defaultMountsFile } from './mounts.js';
import { normalizeEnvironment, applyEnvironment, environmentKey } from './environment.js';
import { dropEntry, recordEntry, writeAtomic } from './store-index.js';
import { VmCanManager } from './vm/vm-can.js';

const BACKENDS = ['lite', 'vm'];

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export { DEFAULT_ENV, writeAtomic };

export function defaultStoreDir() {
  return path.join(os.homedir(), '.can', 'cans');
}

/** True when the file still has the size and mtime recorded at the last write or load. */
function sameFileAs(file, mark) {
  try {
    const st = fs.statSync(file);
    return st.size === mark.size && st.mtimeMs === mark.mtimeMs;
  } catch {
    return false;
  }
}

export class CanManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.storeDir] where saved can state is written
   * @param {boolean} [opts.layer2=true] false only for the layer-1-only test (see test/vm.test.js)
   * @param {string} [opts.mountsFile] the host's allowlist of read-only mounts (see src/mounts.js)
   */
  constructor({
    storeDir = defaultStoreDir(), layer2 = true, mountsFile = defaultMountsFile(), vmDir,
  } = {}) {
    this.storeDir = storeDir;
    this.layer2 = layer2;
    this.mountsFile = mountsFile;
    // Folder for the VM guests' channels and serial logs. Created on the first backend: 'vm' create (see vm/vm-can.js).
    this.vmDir = vmDir ?? path.join(storeDir, 'vm');
    this.vm = null;
    this.cans = new Map(); // id -> Can (live cans, including crashed ones until destroyed)
    this._names = new Set(); // names reserved by creates and loads still in progress
    this._autoCounter = 0;
  }

  /**
   * Creates a seeded can in its own VM. Names must be unique; omitted names become can-N.
   * `mounts` is a list of {label, canPath}: host folders from the mounts file, mounted read-only.
   * `environment` (optional, see src/environment.js) is checked before anything boots, then applied before the
   * can is returned. If any step fails the can is destroyed and the error is thrown. The result of the steps is
   * kept on can.report; the resolved toolchains are on can.toolchains.
   */
  async create({
    name, env = {}, mounts = [], environment, backend = 'lite',
  } = {}) {
    if (!BACKENDS.includes(backend)) {
      throw new KernelError('EINVAL', `EINVAL: backend is ${JSON.stringify(backend)}. Next: use "lite" (the default) or "vm".`);
    }
    if (backend === 'vm') {
      // The VM's own environment (CAN_QEMU, CAN_GUEST_DIR) comes from the process, not from the can's env.
      this.vm ??= new VmCanManager({ dir: this.vmDir });
      return this.vm.create({ name, mounts, environment });
    }
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
      can.toolchains = can.report.toolchains ?? [];
      can.specKey = environmentKey(spec, mounts);
      can.savedAt = null;
      this.cans.set(id, can);
      return can;
    } finally {
      this._names.delete(finalName);
    }
  }

  /** Looks up a live can by id or name. Returns undefined if absent. */
  get(idOrName) {
    return this.cans.get(idOrName) ?? [...this.cans.values()].find((c) => c.name === idOrName) ?? this.vm?.get(idOrName);
  }

  list() {
    return [...this.cans.values(), ...(this.vm?.list() ?? [])];
  }

  /** Stops the can's VM, removes it from memory and deletes its saved file, if any. */
  async destroy(idOrName) {
    if (!this.cans.has(idOrName) && this.vm?.get(idOrName)) {
      await this.vm.destroy(idOrName);
      return;
    }
    const can = this._require(idOrName);
    this.cans.delete(can.id);
    await can.destroy();
    fs.rmSync(this._file(can.id), { force: true });
    dropEntry(this.storeDir, can.id);
  }

  /**
   * Writes the can's snapshot to <storeDir>/<id>.json (atomically, see writeAtomic). Returns the file path. The
   * can's savedAt is set to the time of the write.
   *
   * A save is skipped when nothing has changed since the last write or load: the VM reports the same generation
   * (see Machine.generation) and the file still has the size and mtime that were written. `force` (can_save) always
   * writes. A skipped save keeps the old savedAt.
   */
  async save(idOrName, { force = false } = {}) {
    const can = this._require(idOrName);
    const file = this._file(can.id);
    const mark = can.savedMark;
    if (!force && mark && (await can.generation()) === mark.generation && sameFileAs(file, mark)) return file;
    const { snapshot: snap, generation } = await can.snapshotTagged();
    fs.mkdirSync(this.storeDir, { recursive: true });
    const savedAt = new Date().toISOString();
    const canMeta = { specKey: can.specKey ?? null, tools: can.toolchains ?? [], savedAt };
    writeAtomic(file, JSON.stringify({ ...snap, canMeta }));
    const stat = fs.statSync(file);
    can.savedAt = savedAt;
    can.savedMark = { generation, size: stat.size, mtimeMs: stat.mtimeMs };
    recordEntry(this.storeDir, can.id, { name: snap.name, createdAt: snap.createdAt, ...canMeta }, stat);
    return file;
  }

  /**
   * Starts a saved can in a new VM. If that id is already live, returns the live instance. `pre` may carry the file
   * the registry has already parsed, as {doc, stat} (see store-index.js scanStore); then the file is not read again.
   */
  async load(id, pre = {}) {
    const file = this._file(id);
    if (this.cans.has(id)) return this.cans.get(id);
    let doc = pre.doc;
    let stat = pre.stat;
    if (!doc) {
      try {
        stat = fs.statSync(file); // before the read: see scanStore
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') throw new KernelError('ENOENT', `ENOENT: no saved can "${id}". Next: call can_list to see the cans.`, { path: file });
        throw err;
      }
    }
    const { canMeta, ...snap } = doc ?? {};
    if (snap?.id !== id) throw new KernelError('EINVAL', `EINVAL: saved file ${id}.json holds can ${snap?.id}`);
    const mounts = resolveMounts(snap.mounts ?? [], this.mountsFile);
    this._reserveName(snap.name);
    try {
      const can = await Can.open({ snapshot: snap, layer2: this.layer2, mounts });
      can.specKey = canMeta?.specKey ?? null;
      can.toolchains = canMeta?.tools ?? [];
      can.savedAt = canMeta?.savedAt ?? null;
      // The loaded state is the file's state, so the next save with no change can be skipped.
      try {
        can.savedMark = { generation: await can.generation(), size: stat.size, mtimeMs: stat.mtimeMs };
      } catch (err) {
        await can.destroy().catch(() => {});
        throw err;
      }
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
      throw new KernelError('EEXIST', `EEXIST: a can named "${name}" already exists. Next: use another name, or can_destroy it first.`);
    }
    this._names.add(name);
  }

  _require(idOrName) {
    const can = this.get(idOrName);
    if (!can) throw new KernelError('ENOENT', `ENOENT: no can "${idOrName}". Next: call can_list to see the cans.`);
    return can;
  }

  _file(id) {
    // "index" is the store's own file name (store-index.js), so no can may use it as an id.
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || id === 'index') throw new KernelError('EINVAL', `EINVAL: invalid can id ${id}`);
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
