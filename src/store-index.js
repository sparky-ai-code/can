// The saved-cans store. Each can is <storeDir>/<id>.json, and that file is the only authority for the can. The store
// also keeps <storeDir>/index.json: a cache of what each file says (name, environment key, tools, save time), with the
// file's size and mtime, so that listing the cans does not parse every file. Each lookup checks the index against the
// folder: a file whose size or mtime differs from its entry, or that has no entry, is read again; an entry with no file
// is dropped. So a deleted or wrong index only costs a re-read, and the index is never the only copy of anything.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const INDEX_FILE = 'index.json';
const INDEX_FORMAT = 'can-store-index';
const INDEX_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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

/** The index entries as an object keyed by can id. A missing, unreadable or foreign index counts as empty. */
function readEntries(storeDir) {
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(path.join(storeDir, INDEX_FILE), 'utf8'));
  } catch {
    return {};
  }
  if (obj?.format !== INDEX_FORMAT || obj.version !== INDEX_VERSION || !obj.entries || typeof obj.entries !== 'object') return {};
  return obj.entries;
}

/** The index is a cache, so a store that cannot hold one still works: a failed write is ignored. */
function writeEntries(storeDir, entries) {
  try {
    writeAtomic(path.join(storeDir, INDEX_FILE), JSON.stringify({ format: INDEX_FORMAT, version: INDEX_VERSION, entries }));
  } catch {
    // read-only or full store: every lookup reads the files instead
  }
}

function isEntry(e, stat) {
  return e !== null && typeof e === 'object' && typeof e.name === 'string' && e.size === stat.size && e.mtimeMs === stat.mtimeMs;
}

function rowOf(id, e) {
  return { id, name: e.name, createdAt: e.createdAt, specKey: e.specKey ?? null, tools: e.tools ?? [], savedAt: e.savedAt ?? null };
}

/**
 * The saved cans, sorted by name: [{id, name, createdAt, specKey, tools, savedAt}]. A can file is read only when the
 * index has no entry matching its size and mtime. `keep(id, name)` may ask for the parsed file back: such a row gets
 * `parsed: {doc, stat}`, so a load can use it without reading the file again. The index is rewritten only when it
 * changed.
 */
export function scanStore(storeDir, { keep = () => false } = {}) {
  let files;
  try {
    files = fs.readdirSync(storeDir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return []; // a store that is not a folder holds no cans
    throw err;
  }
  const old = readEntries(storeDir);
  const next = {};
  const rows = [];
  for (const file of files) {
    if (!file.endsWith('.json') || file === INDEX_FILE) continue;
    const id = file.slice(0, -'.json'.length);
    if (!ID_PATTERN.test(id)) continue;
    const filePath = path.join(storeDir, file);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue; // removed since the listing
    }
    if (isEntry(old[id], stat)) {
      next[id] = old[id];
      rows.push(rowOf(id, old[id]));
      continue;
    }
    // stat comes before the read: if the file changes in between, the stat is the older one and the entry is read again.
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue; // unreadable or partial file: not a can this store can use
    }
    if (doc?.format !== 'can-snapshot' || doc.id !== id) continue;
    const entry = {
      name: doc.name,
      createdAt: doc.createdAt,
      specKey: doc.canMeta?.specKey ?? null,
      tools: doc.canMeta?.tools ?? [],
      savedAt: doc.canMeta?.savedAt ?? null,
      status: 'saved',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    next[id] = entry;
    const row = rowOf(id, entry);
    if (keep(id, entry.name)) row.parsed = { doc, stat: { size: stat.size, mtimeMs: stat.mtimeMs } };
    rows.push(row);
  }
  const changed = Object.keys(old).length !== Object.keys(next).length
    || Object.keys(next).some((id) => next[id] !== old[id]);
  if (changed) writeEntries(storeDir, next);
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Records the entry of a can that was just written. `stat` is the stat of its file after the write. */
export function recordEntry(storeDir, id, { name, createdAt, specKey, tools, savedAt }, stat) {
  const entries = readEntries(storeDir);
  entries[id] = {
    name,
    createdAt,
    specKey: specKey ?? null,
    tools: tools ?? [],
    savedAt: savedAt ?? null,
    status: 'saved',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  writeEntries(storeDir, entries);
}

/** Removes the entry of a can whose file was deleted. */
export function dropEntry(storeDir, id) {
  const entries = readEntries(storeDir);
  if (!Object.hasOwn(entries, id)) return;
  delete entries[id];
  writeEntries(storeDir, entries);
}
