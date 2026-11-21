// In-memory, POSIX-like virtual filesystem. Pure JavaScript: never touches the host disk.
// Nodes are plain objects: {type: 'file'|'dir'|'symlink', mode, mtime, ctime, birthtime, ...}
// Times are epoch milliseconds internally; Stat exposes them as Date objects.
import fs from 'node:fs';
import { posix, join as joinHost } from 'node:path';
import { KernelError, fsError } from './errors.js';

const MAX_SYMLINK_HOPS = 40;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
/** The saved form of a tree: format name and version (see VFS.serialize). */
export const VFS_FORMAT = 'can-vfs';
export const VFS_VERSION = 1;
const LINK_MODE = 0o777;
/** Largest host file a mount will read into a can in one call. */
const MAX_MOUNT_READ = 64 * 1024 * 1024;

/** Stat-like object returned by stat(), lstat() and readdir({ withFileTypes: true }). */
export class Stat {
  constructor(node) {
    this.type = node.type;
    this.mode = node.mode;
    this.size = node.type === 'file' ? (node.size ?? node.data.length)
      : node.type === 'symlink' ? Buffer.byteLength(node.target) : 0;
    this.mtime = new Date(node.mtime);
    this.ctime = new Date(node.ctime);
    this.birthtime = new Date(node.birthtime);
  }
  isFile() { return this.type === 'file'; }
  isDirectory() { return this.type === 'dir'; }
  isSymbolicLink() { return this.type === 'symlink'; }
}

// Error context: which syscall failed, on which path (and destination for two-path calls).
const ctx = (syscall, path, dest) => ({ syscall, path, dest });
const fail = (code, c) => fsError(code, c.syscall, c.path, c.dest);

/**
 * A child-name table of a mounted host folder. Reading works; any change throws EROFS.
 */
class HostEntries extends Map {
  constructor(canPath) {
    super();
    this.canPath = canPath;
  }
  _load(name, node) { return Map.prototype.set.call(this, name, node); }
  set(name) { throw fsError('EROFS', 'open', posix.join(this.canPath, String(name))); }
  delete(name) { throw fsError('EROFS', 'unlink', posix.join(this.canPath, String(name))); }
  clear() { throw fsError('EROFS', 'rmdir', this.canPath); }
}

/**
 * A view of a host file or folder inside the tree, made by VFS.mount. It reads the host on every access, so the
 * can sees the folder as it is now. Every change throws EROFS: the setters and HostEntries refuse writes. Errors
 * name the can path only, never the host path. Symbolic links on the host are not shown.
 */
class HostNode {
  #hostPath;
  #mode;
  #mtime;
  #ctime;
  #birthtime;
  #size;

  constructor(hostPath, canPath, st, { isRoot = false } = {}) {
    this.#hostPath = hostPath;
    this.canPath = canPath;
    this.isRoot = isRoot; // the mount point itself: it cannot be removed, renamed or replaced
    this.type = st.isDirectory() ? 'dir' : 'file';
    this.#mode = this.type === 'dir' ? DIR_MODE : FILE_MODE;
    this.#mtime = st.mtimeMs;
    this.#ctime = st.ctimeMs;
    this.#birthtime = st.birthtimeMs;
    this.#size = st.size;
  }

  get mode() { return this.#mode; }
  set mode(_) { throw fsError('EROFS', 'chmod', this.canPath); }
  get mtime() { return this.#mtime; }
  set mtime(_) { throw fsError('EROFS', 'utime', this.canPath); }
  get ctime() { return this.#ctime; }
  set ctime(_) { throw fsError('EROFS', 'utime', this.canPath); }
  get birthtime() { return this.#birthtime; }
  get size() { return this.#size; }

  get data() {
    if (this.type !== 'file') return undefined;
    if (this.#size > MAX_MOUNT_READ) throw fsError('EFBIG', 'read', this.canPath);
    try {
      return fs.readFileSync(this.#hostPath);
    } catch (err) {
      throw hostFail(err, 'open', this.canPath);
    }
  }
  set data(_) { throw fsError('EROFS', 'open', this.canPath); }

  get entries() {
    if (this.type !== 'dir') return undefined;
    let names;
    try {
      names = fs.readdirSync(this.#hostPath);
    } catch (err) {
      throw hostFail(err, 'scandir', this.canPath);
    }
    const map = new HostEntries(this.canPath);
    for (const name of names) {
      const hp = joinHost(this.#hostPath, name);
      let st;
      try {
        st = fs.lstatSync(hp);
      } catch {
        continue; // vanished between readdir and lstat
      }
      if (!st.isFile() && !st.isDirectory()) continue; // links, sockets and devices are not shown
      map._load(name, new HostNode(hp, posix.join(this.canPath, name), st));
    }
    return map;
  }
}

/** A host error as a can error: the code is kept, the message names the can path. */
function hostFail(err, syscall, canPath) {
  const code = typeof err?.code === 'string' ? err.code : 'EIO';
  return fsError(code, syscall, canPath);
}

function makeNode(type, now, mode, extra) {
  return { type, mode, mtime: now, ctime: now, birthtime: now, ...extra };
}
const newDir = (now, mode = DIR_MODE) => makeNode('dir', now, mode, { entries: new Map() });

function cloneLeaf(node, now) {
  return node.type === 'file'
    ? makeNode('file', now, node.mode, { data: Buffer.from(node.data) })
    : makeNode('symlink', now, node.mode, { target: node.target });
}

function toBuffer(data, encoding) {
  if (typeof data === 'string') return Buffer.from(data, encoding ?? 'utf8');
  if (data instanceof Uint8Array) return Buffer.from(data); // also copies Buffers
  throw new TypeError('data must be a string, Buffer or Uint8Array');
}

function encodeNode(node) {
  // A mount is saved as an empty folder. The host folder is re-mounted when the can is loaded.
  if (node instanceof HostNode) {
    return { type: 'dir', mode: DIR_MODE, mtime: node.mtime, ctime: node.ctime, birthtime: node.birthtime, entries: {} };
  }
  const meta = { type: node.type, mode: node.mode, mtime: node.mtime, ctime: node.ctime, birthtime: node.birthtime };
  if (node.type === 'file') return { ...meta, data: node.data.toString('base64') };
  if (node.type === 'symlink') return { ...meta, target: node.target };
  return { ...meta, entries: Object.fromEntries([...node.entries].map(([k, v]) => [k, encodeNode(v)])) };
}

/** One saved node (its children, if a folder, in `entries`) to a tree node. File data is decoded from base64. */
export function decodeNode(obj) {
  const meta = { mode: obj.mode, mtime: obj.mtime, ctime: obj.ctime, birthtime: obj.birthtime };
  switch (obj.type) {
    case 'file': return { type: 'file', ...meta, data: Buffer.from(obj.data, 'base64') };
    case 'symlink': return { type: 'symlink', ...meta, target: obj.target };
    case 'dir':
      return {
        type: 'dir', ...meta,
        entries: new Map(Object.entries(obj.entries ?? {}).map(([k, v]) => [k, decodeNode(v)])),
      };
    default: throw new KernelError('EINVAL', `EINVAL: unknown node type ${obj.type}`);
  }
}

export class VFS {
  /**
   * @param {object} [opts]
   * @param {string} [opts.cwd='/'] working directory (need not exist yet)
   * @param {() => number} [opts.clock=Date.now] time source in ms
   */
  constructor({ cwd = '/', clock = Date.now } = {}) {
    this.clock = clock;
    this.root = newDir(clock());
    this.cwd = posix.resolve('/', cwd);
    this.mounts = []; // [{path, label}] host folders mounted read-only (see mount)
  }

  /**
   * Mounts a host folder read-only at p. The can then sees the folder's current contents at p, and every
   * write under p fails with EROFS. An existing folder at p is covered, as on Linux. A mount cannot sit inside
   * another mount. The caller checks hostDir (src/mounts.js); the VM process may read it (see vm/supervisor.js).
   */
  mount(p, hostDir, { label } = {}) {
    const abs = this.resolve(p);
    const c = ctx('mount', p);
    if (abs === '/') throw fail('EINVAL', c);
    this._mkdirp(posix.dirname(abs), c, DIR_MODE);
    const { dir, name } = this._parentOf(abs, c);
    const existing = dir.entries.get(name);
    if (existing instanceof HostNode) throw fail('EEXIST', c);
    if (existing && existing.type !== 'dir') throw fail('ENOTDIR', c);
    let st;
    try {
      st = fs.statSync(hostDir);
    } catch (err) {
      throw hostFail(err, 'mount', p);
    }
    if (!st.isDirectory()) throw fail('ENOTDIR', c);
    dir.entries.set(name, new HostNode(hostDir, abs, st, { isRoot: true }));
    this.mounts.push({ path: abs, label: label ?? posix.basename(abs) });
    this._touch(dir);
  }

  /** The mounts as {label, canPath}. Host paths are not included, so a saved can holds no host paths. */
  mountList() {
    return this.mounts.map((m) => ({ label: m.label, canPath: m.path }));
  }

  // ---- paths --------------------------------------------------------------

  /** Normalizes p against base (default: cwd) into an absolute path. Does not follow symlinks. */
  resolve(p, base = this.cwd) {
    if (typeof p !== 'string') throw new TypeError('path must be a string');
    if (p === '') throw fsError('ENOENT', 'stat', p);
    return posix.resolve('/', base, p);
  }

  chdir(p) {
    const c = ctx('chdir', p);
    const abs = this.resolve(p);
    if (this._lookup(abs, true, c).type !== 'dir') throw fail('ENOTDIR', c);
    this.cwd = abs;
  }

  exists(p) {
    try {
      this._lookup(this.resolve(p), true, ctx('stat', p));
      return true;
    } catch (err) {
      if (err instanceof KernelError) return false;
      throw err;
    }
  }

  // ---- reading ------------------------------------------------------------

  stat(p) { return new Stat(this._lookup(this.resolve(p), true, ctx('stat', p))); }
  lstat(p) { return new Stat(this._lookup(this.resolve(p), false, ctx('lstat', p))); }

  /** Returns a Buffer, or a string when an encoding is given (string or {encoding}). */
  readFile(p, opts) {
    const node = this._lookup(this.resolve(p), true, ctx('open', p));
    if (node.type === 'dir') throw fail('EISDIR', ctx('read', p));
    const buf = Buffer.from(node.data);
    const encoding = typeof opts === 'string' ? opts : opts?.encoding;
    return encoding ? buf.toString(encoding) : buf;
  }

  readdir(p, opts = {}) {
    const c = ctx('scandir', p);
    const dir = this._lookup(this.resolve(p), true, c);
    if (dir.type !== 'dir') throw fail('ENOTDIR', c);
    const names = [...dir.entries.keys()].sort();
    if (!opts.withFileTypes) return names;
    return names.map((name) => Object.assign(new Stat(dir.entries.get(name)), { name }));
  }

  readlink(p) {
    const c = ctx('readlink', p);
    const node = this._lookup(this.resolve(p), false, c);
    if (node.type !== 'symlink') throw fail('EINVAL', c);
    return node.target;
  }

  // ---- writing ------------------------------------------------------------

  /** Creates or replaces a file. The parent directory must exist. Writes through symlinks. */
  writeFile(p, data, opts = {}) { this._write(p, toBuffer(data, opts.encoding), opts, false); }

  appendFile(p, data, opts = {}) { this._write(p, toBuffer(data, opts.encoding), opts, true); }

  _write(p, buf, opts, append) {
    const abs = this.resolve(p);
    const c = ctx('open', p);
    const node = this._find(abs, true, c);
    const now = this.clock();
    if (node) {
      if (node.type === 'dir') throw fail('EISDIR', c);
      node.data = append ? Buffer.concat([node.data, buf]) : Buffer.from(buf);
      node.mtime = node.ctime = now;
      return;
    }
    this._create(abs, c, makeNode('file', now, (opts.mode ?? FILE_MODE) & 0o7777, { data: Buffer.from(buf) }));
  }

  /** mkdir; with {recursive: true} returns the first directory created (or undefined). */
  mkdir(p, opts = {}) {
    const abs = this.resolve(p);
    const c = ctx('mkdir', p);
    if (opts.recursive) return this._mkdirp(abs, c, opts.mode);
    if (abs === '/') throw fail('EEXIST', c);
    this._create(abs, c, newDir(this.clock(), (opts.mode ?? DIR_MODE) & 0o7777));
  }

  symlink(target, p) {
    const c = ctx('symlink', target, p);
    if (typeof target !== 'string' || target === '') throw fail('EINVAL', c);
    this._create(this.resolve(p), c, makeNode('symlink', this.clock(), LINK_MODE, { target }));
  }

  chmod(p, mode) {
    const node = this._lookup(this.resolve(p), true, ctx('chmod', p));
    node.mode = mode & 0o7777;
    node.ctime = this.clock();
  }

  utimes(p, mtime) {
    const node = this._lookup(this.resolve(p), true, ctx('utime', p));
    node.mtime = new Date(mtime).getTime();
    node.ctime = this.clock();
  }

  // ---- removing and moving ------------------------------------------------

  unlink(p) {
    const c = ctx('unlink', p);
    const { dir, name } = this._parentOf(this.resolve(p), c);
    const node = dir.entries.get(name);
    if (!node) throw fail('ENOENT', c);
    if (node.type === 'dir') throw fail('EISDIR', c);
    this._detach(dir, name);
  }

  rmdir(p) {
    const c = ctx('rmdir', p);
    const { dir, name } = this._parentOf(this.resolve(p), c);
    const node = dir.entries.get(name);
    if (!node) throw fail('ENOENT', c);
    if (node.type !== 'dir') throw fail('ENOTDIR', c);
    if (node.entries.size > 0) throw fail('ENOTEMPTY', c);
    this._detach(dir, name);
  }

  /** Removes a file, symlink (the link itself) or, with {recursive: true}, a directory tree. */
  rm(p, opts = {}) {
    const c = ctx('rm', p);
    let parent;
    try {
      parent = this._parentOf(this.resolve(p), c);
    } catch (err) {
      if (opts.force && err.code === 'ENOENT') return;
      throw err;
    }
    const node = parent.dir.entries.get(parent.name);
    if (!node) {
      if (opts.force) return;
      throw fail('ENOENT', c);
    }
    if (node.type === 'dir' && !opts.recursive) throw fail('EISDIR', c);
    this._detach(parent.dir, parent.name);
  }

  /** POSIX rename: replaces files, and replaces directories only when the target is empty. */
  rename(from, to) {
    const c = ctx('rename', from, to);
    const fromAbs = this.resolve(from);
    const toAbs = this.resolve(to);
    const src = this._parentOf(fromAbs, c);
    const node = src.dir.entries.get(src.name);
    if (!node) throw fail('ENOENT', c);
    if (fromAbs === toAbs) return;
    if (node.type === 'dir' && toAbs.startsWith(fromAbs + '/')) throw fail('EINVAL', c);

    const dst = this._parentOf(toAbs, c);
    const existing = dst.dir.entries.get(dst.name);
    if (existing?.isRoot) throw fail('EROFS', c);
    if (existing) {
      if (node.type === 'dir') {
        if (existing.type !== 'dir') throw fail('ENOTDIR', c);
        if (existing.entries.size > 0) throw fail('ENOTEMPTY', c);
      } else if (existing.type === 'dir') {
        throw fail('EISDIR', c);
      }
    }
    this._detach(src.dir, src.name);
    dst.dir.entries.set(dst.name, node);
    this._touch(dst.dir);
  }

  /**
   * Deep-copies a file, symlink or (with {recursive: true}) a directory tree.
   * `to` is the full destination path. Symlinks are copied as links.
   */
  copy(from, to, opts = {}) {
    const c = ctx('copyfile', from, to);
    const fromAbs = this.resolve(from);
    const toAbs = this.resolve(to);
    const src = this._lookup(fromAbs, false, c);
    if (src.type === 'dir') {
      if (!opts.recursive) throw fail('EISDIR', c);
      if (toAbs === fromAbs || toAbs.startsWith(fromAbs + '/')) throw fail('EINVAL', c);
    }
    this._copyNode(src, toAbs, c);
  }

  _copyNode(src, abs, c) {
    const now = this.clock();
    const { dir, name } = this._parentOf(abs, c);
    const existing = dir.entries.get(name);
    if (src.type === 'dir') {
      if (!existing) dir.entries.set(name, newDir(now, src.mode));
      else if (existing.type !== 'dir') throw fail('ENOTDIR', c);
      for (const [child, node] of src.entries) this._copyNode(node, posix.join(abs, child), c);
    } else {
      if (existing?.type === 'dir') throw fail('EISDIR', c);
      dir.entries.set(name, cloneLeaf(src, now));
    }
    this._touch(dir);
  }

  // ---- persistence --------------------------------------------------------

  /** Plain JSON-serializable object (file contents are base64). */
  serialize() {
    return { format: VFS_FORMAT, version: VFS_VERSION, cwd: this.cwd, root: encodeNode(this.root) };
  }

  static deserialize(obj, { clock } = {}) {
    if (obj?.format !== VFS_FORMAT || obj.version !== VFS_VERSION) {
      throw new KernelError('EINVAL', 'EINVAL: not a can-vfs v1 snapshot');
    }
    return VFS.fromRoot(decodeNode(obj.root), { cwd: obj.cwd, clock });
  }

  /** A VFS whose tree is `root`, already decoded (a Map of children per folder). Used by paged restores. */
  static fromRoot(root, { cwd = '/', clock } = {}) {
    if (root?.type !== 'dir') throw new KernelError('EINVAL', 'EINVAL: snapshot root is not a directory');
    const vfs = new VFS({ cwd, clock });
    vfs.root = root;
    return vfs;
  }

  /**
   * The tree as records in pre-order, for a paged snapshot (see src/vm/snapshot-pages.js). A folder's record comes
   * before its children's. File data is referenced, not copied: a write replaces a file's buffer, so the list is one
   * consistent view of the tree at this moment. A mounted host folder is listed as an empty folder, as serialize()
   * saves it.
   */
  snapshotRecords() {
    const out = [];
    const walk = (node, segs) => {
      if (node instanceof HostNode) {
        out.push({ segs, type: 'dir', mode: DIR_MODE, mtime: node.mtime, ctime: node.ctime, birthtime: node.birthtime });
        return;
      }
      const meta = { segs, type: node.type, mode: node.mode, mtime: node.mtime, ctime: node.ctime, birthtime: node.birthtime };
      if (node.type === 'file') out.push({ ...meta, data: node.data });
      else if (node.type === 'symlink') out.push({ ...meta, target: node.target });
      else {
        out.push(meta);
        for (const [name, child] of node.entries) walk(child, [...segs, name]);
      }
    };
    walk(this.root, []);
    return out;
  }

  clone() { return VFS.deserialize(this.serialize(), { clock: this.clock }); }

  // ---- internals ----------------------------------------------------------

  /**
   * Walks an absolute path from the root, expanding symlinks (intermediate ones always,
   * the final one only when `follow` is true). Throws ENOENT / ENOTDIR / ELOOP.
   */
  _lookup(abs, follow, c, hops = 0) {
    const parts = abs.split('/').filter(Boolean);
    let node = this.root;
    for (let i = 0; i < parts.length; i++) {
      if (node.type !== 'dir') throw fail('ENOTDIR', c);
      const child = node.entries.get(parts[i]);
      if (!child) throw fail('ENOENT', c);
      const isLast = i === parts.length - 1;
      if (child.type === 'symlink' && (follow || !isLast)) {
        if (hops >= MAX_SYMLINK_HOPS) throw fail('ELOOP', c);
        const prefix = '/' + parts.slice(0, i).join('/');
        const next = posix.resolve(prefix, child.target, ...parts.slice(i + 1));
        return this._lookup(next, follow, c, hops + 1);
      }
      node = child;
    }
    return node;
  }

  /** Like _lookup but returns null when the path does not exist. */
  _find(abs, follow, c) {
    try {
      return this._lookup(abs, follow, c);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Returns the parent directory node and the final name of an absolute path. */
  _parentOf(abs, c) {
    if (abs === '/') throw fail('EPERM', c);
    const dir = this._lookup(posix.dirname(abs), true, c);
    if (dir.type !== 'dir') throw fail('ENOTDIR', c);
    return { dir, name: posix.basename(abs) };
  }

  /** Attaches a new node at abs. Fails with EEXIST if the name is taken (dangling links included). */
  _create(abs, c, node) {
    const { dir, name } = this._parentOf(abs, c);
    if (dir.entries.has(name)) throw fail('EEXIST', c);
    dir.entries.set(name, node);
    this._touch(dir);
  }

  _detach(dir, name) {
    const node = dir.entries.get(name);
    if (node?.isRoot) throw fsError('EROFS', 'rm', node.canPath);
    dir.entries.delete(name);
    this._touch(dir);
  }

  _mkdirp(abs, c, mode) {
    const parts = abs.split('/').filter(Boolean);
    let first;
    for (let i = 1; i <= parts.length; i++) {
      const sub = '/' + parts.slice(0, i).join('/');
      const node = this._find(sub, true, c);
      if (node) {
        if (node.type !== 'dir') throw fail(i === parts.length ? 'EEXIST' : 'ENOTDIR', c);
        continue;
      }
      this._create(sub, c, newDir(this.clock(), (mode ?? DIR_MODE) & 0o7777));
      first ??= sub;
    }
    return first;
  }

  _touch(dir) {
    dir.mtime = dir.ctime = this.clock();
  }
}
