// CanRegistry: the one place that knows which cans exist, either live in this process or saved on
// disk. The MCP server and the CLI both go through it. Saved cans are loaded lazily, on first use,
// so listing cans or starting the server never boots a VM that nobody asked for.
import fs from 'node:fs';
import path from 'node:path';
import { CanManager, defaultStoreDir } from './manager.js';
import { KernelError } from './kernel/errors.js';
import { environmentKey, normalizeEnvironment } from './environment.js';
import { dropEntry, scanStore } from './store-index.js';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const STALE_AFTER_MS = 60 * 60 * 1000; // a leftover without a lock file is removed after this long

/** Can names appear in `can:path` arguments and CLI output, so they are kept simple. */
export function checkName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new KernelError(
      'EINVAL',
      `EINVAL: invalid can name ${JSON.stringify(name)}: use 1-64 letters, digits, "_", "-" or "." (starting with a letter or digit). Next: pick another name.`,
    );
  }
  return name;
}

function notFound(ref) {
  return new KernelError('ENOENT', `ENOENT: no can "${ref}". Next: call can_list to see the cans, or can_create to make one.`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

function lockPid(lockPath) {
  try {
    const pid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid;
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Startup sweep (interface I6). Removes leftover write files (*.tmp and their *.lock) from an earlier run: a file whose
 * lock names a dead pid, or a file with no lock that is more than an hour old. A live pid's files are kept.
 * Returns how many leftover files were removed.
 */
export function sweepStore(storeDir, { now = Date.now() } = {}) {
  let files;
  try {
    files = fs.readdirSync(storeDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const file of files) {
    const isLock = file.endsWith('.tmp.lock');
    if (!isLock && !file.endsWith('.tmp')) continue;
    const artifact = isLock ? file.slice(0, -'.lock'.length) : file;
    if (isLock && files.includes(artifact)) continue; // handled with its .tmp file
    const artifactPath = path.join(storeDir, artifact);
    const lockPath = path.join(storeDir, `${artifact}.lock`);
    const pid = lockPid(lockPath);
    let stale;
    if (pid !== null) {
      stale = !pidAlive(pid);
    } else if (isLock) {
      stale = true; // a lock with no file and no live pid
    } else {
      try {
        stale = now - fs.statSync(artifactPath).mtimeMs > STALE_AFTER_MS;
      } catch {
        stale = false;
      }
    }
    if (!stale) continue;
    fs.rmSync(artifactPath, { force: true });
    fs.rmSync(lockPath, { force: true });
    removed++;
  }
  return removed;
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
    this._errors = new Map(); // can id -> the last error a tool gave for that can (shown by can_status)
    this.swept = sweepStore(storeDir); // leftovers removed when this registry started
  }

  /**
   * Saved cans, from the store's index, checked against the files (no VM starts, and a file is parsed only when the
   * index has no current entry for it; see store-index.js): [{id, name, createdAt, specKey, tools, savedAt}].
   */
  saved() {
    return scanStore(this.storeDir).map(({ id, name, createdAt, specKey, tools, savedAt }) => ({
      id, name, createdAt, specKey, tools, savedAt,
    }));
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
    if (typeof ref !== 'string' || ref === '') throw new KernelError('EINVAL', 'EINVAL: a can name or id is required. Next: pass the can name from can_list.');
    const live = this.manager.get(ref);
    if (live) return live;
    const entry = this._findSaved(ref);
    if (!entry) throw notFound(ref);
    return this._loadOnce(entry.id, entry);
  }

  /** Loads a saved can once, however many callers ask at the same time. `entry` may carry the file already parsed. */
  _loadOnce(id, entry) {
    if (!this._loading.has(id)) {
      this._loading.set(id, this.manager.load(id, entry?.parsed).finally(() => this._loading.delete(id)));
    }
    return this._loading.get(id);
  }

  /**
   * Creates and saves a new can. Omitted names become can-N, skipping names already in use.
   * `mounts` is an optional list of {label, canPath} (read-only host folders from the mounts file).
   * `environment` is an optional spec applied before the can starts (see src/environment.js).
   * Transactional: if any step fails, or the save fails, the VM is stopped, nothing is left on disk and the name is free.
   */
  async create(name, { mounts = [], environment } = {}) {
    const finalName = name === undefined || name === null ? this._autoName() : checkName(name);
    // The checks and the reservation run before the first await, so two creates cannot race.
    if (this.manager.get(finalName) || this._pending.has(finalName) || this.saved().some((s) => s.name === finalName)) {
      throw new KernelError('EEXIST', `EEXIST: a can named "${finalName}" already exists. Next: use another name, or can_destroy it first.`);
    }
    this._pending.add(finalName);
    try {
      const can = await this.manager.create({ name: finalName, mounts, environment });
      try {
        await this.manager.save(can.id);
      } catch (err) {
        await this.manager.destroy(can.id).catch(() => {});
        throw new KernelError(
          'EIO',
          `EIO: could not save can "${finalName}" to ${this.storeDir}: ${err.message}. Next: make sure the folder is writable, then try again.`,
        );
      }
      return can;
    } finally {
      this._pending.delete(finalName);
    }
  }

  /**
   * can_create semantics (interface I6). A name that is in use with the same environment spec and mounts is reused:
   * returns {can, reused: true, state} where state is the can's status ('running', or 'saved' when it is on disk
   * only). A different spec is EEXIST. A name that is free is created. Returns {can, reused: false, state: 'running'}.
   */
  async ensure(name, { mounts = [], environment } = {}) {
    if (name !== undefined && name !== null) {
      const finalName = checkName(name);
      const key = environmentKey(normalizeEnvironment(environment), mounts);
      const live = this.manager.get(finalName);
      const saved = live || this._pending.has(finalName) ? null : this.saved().find((s) => s.name === finalName);
      if (this._pending.has(finalName)) {
        throw new KernelError('EEXIST', `EEXIST: can "${finalName}" is being created right now. Next: wait for that call to finish, then try again.`);
      }
      if (live || saved) {
        const existingKey = live ? live.specKey : saved.specKey;
        if (existingKey !== key) {
          throw new KernelError(
            'EEXIST',
            `EEXIST: a can named "${finalName}" already exists with a different environment. `
              + 'Next: use another name, or can_destroy the old can first.',
          );
        }
        return { can: live ?? null, reused: true, state: live ? live.status : 'saved', id: live?.id ?? saved.id };
      }
    }
    const can = await this.create(name, { mounts, environment });
    return { can, reused: false, state: 'running', id: can.id };
  }

  /**
   * Starts a can again from its last save (interface I6). A crashed, exited, memory-limit or saved can is loaded from
   * disk. A ready can is saved first, so nothing is lost, then stopped and loaded again. Processes and ports are not
   * restored. Returns {can, was, savedAt}: was is the state before the call; savedAt is the ISO time of the save.
   */
  async restart(ref) {
    if (typeof ref !== 'string' || ref === '') throw new KernelError('EINVAL', 'EINVAL: a can name or id is required. Next: pass the can name from can_list.');
    const live = this.manager.get(ref);
    const entry = live ? { id: live.id, name: live.name } : this._findSaved(ref);
    if (!entry) throw notFound(ref);
    await this._loading.get(entry.id)?.catch(() => {});
    const current = this.manager.get(entry.id);
    let was = 'saved';
    if (current) {
      was = current.status;
      if (current.status === 'running') await this.manager.save(current.id);
      await this.manager.stop(current.id);
    }
    this._errors.delete(entry.id);
    const can = await this._loadOnce(entry.id, live ? null : entry);
    return { can, was, savedAt: can.savedAt ?? null };
  }

  /**
   * Writes the can's state to disk. Returns the file path. Skipped when nothing changed (see CanManager.save), unless
   * `force` is set.
   */
  async save(ref, opts) {
    const can = await this.get(ref);
    return this.manager.save(can.id, opts);
  }

  /** Records the last error a tool gave for a live can, so can_status can show it. */
  noteError(id, message) {
    this._errors.set(id, message);
  }

  /** The last error recorded for a can id, or null. */
  lastError(id) {
    return this._errors.get(id) ?? null;
  }

  /** Stops the can and deletes its saved file. Returns the can's name. */
  async destroy(ref) {
    const live = this.manager.get(ref);
    if (live) {
      await this.manager.destroy(live.id);
      this._errors.delete(live.id);
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
      dropEntry(this.storeDir, entry.id);
    }
    this._errors.delete(entry.id);
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
      throw new KernelError('EINVAL', 'EINVAL: prune needs a retention age in milliseconds (olderThanMs). Next: pass a number such as 86400000.');
    }
    const removed = [];
    for (const s of this.saved()) {
      if (!String(s.name).startsWith(prefix)) continue;
      if (this.manager.get(s.id)) continue; // loaded now, so it is in use
      const created = Number(s.createdAt);
      if (!Number.isFinite(created) || now - created < olderThanMs) continue;
      if (!dryRun) {
        fs.rmSync(path.join(this.storeDir, `${s.id}.json`), { force: true });
        dropEntry(this.storeDir, s.id);
      }
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

  /** The saved can with this id or name, or undefined. Its file is kept parsed for the load (see _loadOnce). */
  _findSaved(ref) {
    const keep = (id, name) => id === ref || name === ref;
    return scanStore(this.storeDir, { keep }).find((s) => s.id === ref || s.name === ref);
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
