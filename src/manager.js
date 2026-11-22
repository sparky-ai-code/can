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

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export { DEFAULT_ENV };

export function defaultStoreDir() {
  return path.join(os.homedir(), '.can', 'cans');
}

/**
 * Writes text to `file` atomically: a unique .tmp file is written next to it (with a .lock file naming this pid, so a
 * startup sweep can tell a live write from a leftover), then renamed over `file`. The .tmp and .lock are removed in
 * every case, so a failed write leaves nothing behind.
 */
export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  const lock = `${tmp}.lock`;
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(lock, { force: true });
  }
  return file;
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
   * kept on can.report; the resolved toolchains are on can.toolchains.
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

  /**
   * Writes the can's snapshot to <storeDir>/<id>.json (atomically, see writeAtomic). Returns the file path. The
   * can's savedAt is set to the time of the write.
   */
  async save(idOrName) {
    const can = this._require(idOrName);
    const snap = await can.snapshot();
    const file = this._file(can.id);
    fs.mkdirSync(this.storeDir, { recursive: true });
    const savedAt = new Date().toISOString();
    const doc = {
      ...snap,
      canMeta: { specKey: can.specKey ?? null, tools: can.toolchains ?? [], savedAt },
    };
    writeAtomic(file, JSON.stringify(doc));
    can.savedAt = savedAt;
    return file;
  }

  /** Starts a saved can in a new VM. If that id is already live, returns the live instance. */
  async load(id) {
    const file = this._file(id);
    if (this.cans.has(id)) return this.cans.get(id);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw new KernelError('ENOENT', `ENOENT: no saved can "${id}". Next: call can_list to see the cans.`, { path: file });
      throw err;
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
