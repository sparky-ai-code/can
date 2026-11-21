// CanRegistry: the one place that knows which cans exist, either live in this process or saved on
// disk. The MCP server and the CLI both go through it. Saved cans are loaded lazily, on first use,
// so listing cans or starting the server never boots a VM that nobody asked for.
import fs from 'node:fs';
import path from 'node:path';
import { CanManager, defaultStoreDir } from './manager.js';
import { KernelError } from './kernel/errors.js';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Can names appear in `can:path` arguments and CLI output, so they are kept simple. */
export function checkName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new KernelError(
      'EINVAL',
      `EINVAL: invalid can name ${JSON.stringify(name)}: use 1-64 letters, digits, "_", "-" or "." (starting with a letter or digit)`,
    );
  }
  return name;
}

function notFound(ref) {
  return new KernelError('ENOENT', `ENOENT: no can "${ref}" (see can_list)`);
}

export class CanRegistry {
  /**
   * @param {object} [opts]
   * @param {string} [opts.storeDir] saved-state directory; defaults to $CAN_STORE_DIR, else ~/.can/cans
   * @param {boolean} [opts.layer2=true] false only for the layer-1-only test
   */
  constructor({ storeDir = process.env.CAN_STORE_DIR || defaultStoreDir(), layer2 = true } = {}) {
    this.storeDir = storeDir;
    this.manager = new CanManager({ storeDir, layer2 });
    this._loading = new Map(); // can id -> Promise<Can>, so a saved can is never booted twice
    this._pending = new Set(); // names of cans being created
  }

  /** Saved cans, read from their files (no VM starts): [{id, name, createdAt}]. */
  saved() {
    let files;
    try {
      files = fs.readdirSync(this.storeDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      if (!ID_PATTERN.test(id)) continue;
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(this.storeDir, file), 'utf8'));
        if (snap?.format === 'can-snapshot' && snap.id === id) {
          out.push({ id, name: snap.name, createdAt: snap.createdAt });
        }
      } catch {
        // unreadable or partial file: not a can this registry can use
      }
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  /** Every can the registry knows: live cans with their status, then saved cans that are not loaded. */
  list() {
    const live = this.manager.list();
    const liveIds = new Set(live.map((c) => c.id));
    const rows = live.map((c) => ({ id: c.id, name: c.name, status: c.status, createdAt: c.createdAt }));
    for (const s of this.saved()) {
      if (!liveIds.has(s.id)) rows.push({ id: s.id, name: s.name, status: 'saved', createdAt: s.createdAt });
    }
    return rows;
  }

  /** The live can for a name or id. A saved can is loaded into a new VM first. ENOENT if neither. */
  async get(ref) {
    if (typeof ref !== 'string' || ref === '') throw new KernelError('EINVAL', 'EINVAL: a can name or id is required');
    const live = this.manager.get(ref);
    if (live) return live;
    const entry = this._findSaved(ref);
    if (!entry) throw notFound(ref);
    if (!this._loading.has(entry.id)) {
      this._loading.set(entry.id, this.manager.load(entry.id).finally(() => this._loading.delete(entry.id)));
    }
    return this._loading.get(entry.id);
  }

  /**
   * Creates and saves a new can. Omitted names become can-N, skipping names already in use.
   * `mounts` is an optional list of {label, canPath} (read-only host folders from the mounts file).
   * `environment` is an optional spec applied before the can starts (see src/environment.js).
   */
  async create(name, { mounts = [], environment } = {}) {
    const finalName = name === undefined || name === null ? this._autoName() : checkName(name);
    // The checks and the reservation run before the first await, so two creates cannot race.
    if (this.manager.get(finalName) || this._pending.has(finalName) || this.saved().some((s) => s.name === finalName)) {
      throw new KernelError('EEXIST', `EEXIST: a can named "${finalName}" already exists`);
    }
    this._pending.add(finalName);
    try {
      const can = await this.manager.create({ name: finalName, mounts, environment });
      await this.manager.save(can.id);
      return can;
    } finally {
      this._pending.delete(finalName);
    }
  }

  /** Writes the can's state to disk. Returns the file path. */
  async save(ref) {
    const can = await this.get(ref);
    return this.manager.save(can.id);
  }

  /** Stops the can and deletes its saved file. Returns the can's name. */
  async destroy(ref) {
    const live = this.manager.get(ref);
    if (live) {
      await this.manager.destroy(live.id);
      return live.name;
    }
    const entry = this._findSaved(ref);
    if (!entry) throw notFound(ref);
    await this._loading.get(entry.id)?.catch(() => {});
    const now = this.manager.get(entry.id);
    if (now) {
      await this.manager.destroy(now.id);
    } else {
      fs.rmSync(path.join(this.storeDir, `${entry.id}.json`), { force: true });
    }
    return entry.name;
  }

  /**
   * Deletes saved cans whose names start with `prefix` and that were created more than `olderThanMs` ago. A live
   * (loaded) can is never deleted, and cans with other names are left alone. This is the retention for the cans a
   * failed `can ci` run keeps: they stay until `can prune`. Returns the names removed (or, with dryRun, that would be).
   * Nothing is loaded into a VM, so this is cheap even for large saved states.
   */
  prune({ prefix = 'ci-', olderThanMs, dryRun = false, now = Date.now() } = {}) {
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new KernelError('EINVAL', 'EINVAL: prune needs a retention age in milliseconds (olderThanMs)');
    }
    const removed = [];
    for (const s of this.saved()) {
      if (!String(s.name).startsWith(prefix)) continue;
      if (this.manager.get(s.id)) continue; // loaded now, so it is in use
      const created = Number(s.createdAt);
      if (!Number.isFinite(created) || now - created < olderThanMs) continue;
      if (!dryRun) fs.rmSync(path.join(this.storeDir, `${s.id}.json`), { force: true });
      removed.push(s.name);
    }
    return removed;
  }

  /** Saves every running live can. A failure on one can does not stop the others. */
  async saveAll() {
    const result = { saved: [], failed: [] };
    for (const can of this.manager.list()) {
      if (can.status !== 'running') continue;
      try {
        await this.manager.save(can.id);
        result.saved.push(can.name);
      } catch (err) {
        result.failed.push({ name: can.name, message: err.message });
      }
    }
    return result;
  }

  /**
   * Clean shutdown: saves running cans (unless save is false), then stops every VM.
   * Saved files are kept, so the cans load again next time. Processes die with their VM.
   */
  async shutdown({ save = true } = {}) {
    await Promise.allSettled([...this._loading.values()]);
    const result = save ? await this.saveAll() : { saved: [], failed: [] };
    await this.manager.stopAll();
    return result;
  }

  _findSaved(ref) {
    return this.saved().find((s) => s.id === ref || s.name === ref);
  }

  _autoName() {
    const taken = new Set([
      ...this.manager.list().map((c) => c.name),
      ...this.saved().map((s) => s.name),
      ...this._pending,
    ]);
    let n = 1;
    while (taken.has(`can-${n}`)) n++;
    return `can-${n}`;
  }
}
