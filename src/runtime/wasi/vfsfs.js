// VFS adapter for the WASI shim. The shim's file and directory objects (Fd and Inode subclasses) are implemented
// here over the can's virtual filesystem, so a write from a WASI program lands in the can VFS and survives a save.
//
// Layout of the paths a WASI program sees: each preopen maps a guest name to an absolute can path. Host folders
// can be overlaid, read-only, at can paths (see `mounts` in WasiContext). An overlay is read from the host on
// access, not copied, so a large stdlib does not enter the can's saved state. A writable sub-path inside an
// overlay (for example site-packages) is kept in the can VFS.
//
// Buffering: an open file keeps its bytes in memory and writes them back to the VFS on close, fd_sync, and before
// any path operation and the end of the run. A program that reads a file through a second open handle sees the
// last flushed state, which is what a POSIX program sees after its writes complete.

import fs from 'node:fs';
import path, { posix } from 'node:path';
import { KernelError } from '../../kernel/errors.js';
import { Fd, Inode, ConsoleStdout, wasi } from '../../vendor/browser_wasi_shim/index.js';

const LOOKUP_SYMLINK_FOLLOW = 1;
const FSTFLAGS_MTIM = 0x4;

const ERRNO_BY_CODE = {
  ENOENT: wasi.ERRNO_NOENT,
  EEXIST: wasi.ERRNO_EXIST,
  ENOTDIR: wasi.ERRNO_NOTDIR,
  EISDIR: wasi.ERRNO_ISDIR,
  ENOTEMPTY: wasi.ERRNO_NOTEMPTY,
  EINVAL: wasi.ERRNO_INVAL,
  EPERM: wasi.ERRNO_PERM,
  EROFS: wasi.ERRNO_ROFS,
  EACCES: wasi.ERRNO_ACCES,
  EBUSY: wasi.ERRNO_BUSY,
  EFBIG: wasi.ERRNO_FBIG,
  ELOOP: wasi.ERRNO_LOOP,
  ENOTSUP: wasi.ERRNO_NOTSUP,
  ENOTCAPABLE: wasi.ERRNO_NOTCAPABLE,
  ENOMEM: wasi.ERRNO_NOMEM,
  EBADF: wasi.ERRNO_BADF,
};

/** The WASI errno for a thrown error: VFS and Node fs errors carry a `code`. Anything else is an I/O error. */
export function errnoOf(err) {
  return ERRNO_BY_CODE[err?.code] ?? wasi.ERRNO_IO;
}

const notCapable = (what) => new KernelError('ENOTCAPABLE', `ENOTCAPABLE: "${what}" is outside the folder the program may use. Next: use a path inside it.`);

/** Joins a relative guest path to an absolute base. Rejects absolute paths and any ".." that leaves the base. */
export function joinGuest(base, rel) {
  if (typeof rel !== 'string') throw new KernelError('EINVAL', 'EINVAL: the path is not text. Next: check the program.');
  if (rel.includes('\0')) throw new KernelError('EINVAL', 'EINVAL: the path contains a NUL byte. Next: check the program.');
  if (rel.startsWith('/')) throw notCapable(rel);
  const parts = [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) throw notCapable(rel);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return posix.join(base, ...parts);
}

/** The overlay and VFS routing. Also the one place that knows which paths are read-only. */
export class Layers {
  /**
   * @param {object} vfs the can's VFS
   * @param {Array<{at: string, hostDir: string, writable?: string[]}>} mounts host folders shown read-only at `at`;
   *   `writable` lists can paths under `at` that stay in the can VFS
   */
  constructor(vfs, mounts = []) {
    this.vfs = vfs;
    this.mounts = mounts.map((m) => ({
      at: posix.resolve('/', m.at),
      hostDir: path.resolve(m.hostDir),
      writable: (m.writable ?? []).map((w) => posix.resolve('/', w)),
    }));
  }

  /** The host path for an absolute can path, or null when the path lives in the can VFS. */
  hostPath(abs) {
    for (const m of this.mounts) {
      if (abs !== m.at && !abs.startsWith(m.at + '/')) continue;
      if (m.writable.some((w) => abs === w || abs.startsWith(w + '/'))) return null;
      return path.join(m.hostDir, abs.slice(m.at.length));
    }
    return null;
  }

  writable(abs) { return this.hostPath(abs) === null; }

  stat(abs, follow = true) {
    const hp = this.hostPath(abs);
    if (hp !== null) {
      const st = follow ? fs.statSync(hp) : fs.lstatSync(hp);
      return {
        type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file',
        size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, birthtimeMs: st.birthtimeMs,
      };
    }
    const s = follow ? this.vfs.stat(abs) : this.vfs.lstat(abs);
    return { type: s.type, size: s.size, mtimeMs: s.mtime.getTime(), ctimeMs: s.ctime.getTime(), birthtimeMs: s.birthtime.getTime() };
  }

  /** stat, or null when the path does not exist. */
  statOrNull(abs, follow = true) {
    try {
      return this.stat(abs, follow);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
      throw err;
    }
  }

  readFile(abs) {
    const hp = this.hostPath(abs);
    return hp !== null ? fs.readFileSync(hp) : this.vfs.readFile(abs);
  }

  writeFile(abs, buf) {
    if (this.hostPath(abs) !== null) throw new KernelError('EROFS', `EROFS: read-only file system, open '${abs}'`);
    this.vfs.writeFile(abs, buf);
  }

  mkdir(abs) {
    if (this.hostPath(abs) !== null) throw new KernelError('EROFS', `EROFS: read-only file system, mkdir '${abs}'`);
    this.vfs.mkdir(abs);
  }

  rmdir(abs) {
    if (this.hostPath(abs) !== null) throw new KernelError('EROFS', `EROFS: read-only file system, rmdir '${abs}'`);
    this.vfs.rmdir(abs);
  }

  unlink(abs) {
    if (this.hostPath(abs) !== null) throw new KernelError('EROFS', `EROFS: read-only file system, unlink '${abs}'`);
    this.vfs.unlink(abs);
  }

  rename(from, to) {
    if (this.hostPath(from) !== null || this.hostPath(to) !== null) {
      throw new KernelError('EROFS', `EROFS: read-only file system, rename '${from}' -> '${to}'`);
    }
    this.vfs.rename(from, to);
  }

  readlink(abs) {
    const hp = this.hostPath(abs);
    return hp !== null ? fs.readlinkSync(hp) : this.vfs.readlink(abs);
  }

  utimes(abs, mtimeMs) {
    if (this.hostPath(abs) !== null) throw new KernelError('EROFS', `EROFS: read-only file system, utime '${abs}'`);
    this.vfs.utimes(abs, mtimeMs);
  }

  /** Names in a folder: host names (when overlaid) plus any can-VFS names under the same path, sorted, unique. */
  readdir(abs) {
    const names = new Set();
    const hp = this.hostPath(abs);
    if (hp !== null) {
      for (const n of fs.readdirSync(hp)) names.add(n);
      // The can VFS can only hold names here under a writable folder, so the probe is skipped elsewhere.
      if (this.hasWritableUnder(abs) && this.vfsIsDir(abs)) for (const n of this.vfs.readdir(abs)) names.add(n);
    } else {
      for (const n of this.vfs.readdir(abs)) names.add(n);
    }
    return [...names].sort();
  }

  /** True when some writable (can VFS) folder lies under this absolute path. */
  hasWritableUnder(abs) {
    return this.mounts.some((m) => m.writable.some((w) => w === abs || w.startsWith(abs === '/' ? '/' : abs + '/')));
  }

  vfsIsDir(abs) {
    try {
      return this.vfs.stat(abs).type === 'dir';
    } catch {
      return false;
    }
  }
}

/** Per-run state shared by all open objects: the layers, open writable files, and stable inode numbers. */
export class WasiContext {
  constructor(layers) {
    this.layers = layers;
    this.inodes = new Map();
    this.nextIno = 1n;
    this.openFiles = new Set();
  }

  inoFor(abs) {
    let ino = this.inodes.get(abs);
    if (ino === undefined) {
      ino = this.nextIno++;
      this.inodes.set(abs, ino);
    }
    return ino;
  }

  track(file) { this.openFiles.add(file); }
  forget(file) { this.openFiles.delete(file); }

  /** Writes every open file that has unsaved bytes back to the can. Throws the first error after trying all. */
  flushAll() {
    let first = null;
    for (const f of this.openFiles) {
      try {
        f.flush();
      } catch (err) {
        first ??= err;
      }
    }
    if (first) throw first;
  }
}

function filestatFor(ctx, abs, st) {
  const type = st.type === 'dir' ? wasi.FILETYPE_DIRECTORY : st.type === 'symlink' ? wasi.FILETYPE_SYMBOLIC_LINK : wasi.FILETYPE_REGULAR_FILE;
  const fsStat = new wasi.Filestat(ctx.inoFor(abs), type, BigInt(st.type === 'file' ? st.size : 0));
  fsStat.nlink = 1n;
  fsStat.mtim = BigInt(Math.trunc(st.mtimeMs * 1e6));
  fsStat.ctim = BigInt(Math.trunc(st.ctimeMs * 1e6));
  fsStat.atim = fsStat.mtim;
  return fsStat;
}

/** A regular file. Bytes are held in `buf[0..len)`; flush() writes them back to the can. */
export class WasiFile extends Fd {
  constructor(ctx, abs, data, { writable, append }) {
    super();
    this.ctx = ctx;
    this.abs = abs;
    this.buf = data;
    this.len = data.length;
    this.pos = 0;
    this.writable = writable;
    this.append = append;
    this.dirty = false;
    this.ino = ctx.inoFor(abs);
    if (writable) ctx.track(this);
  }

  ensure(size) {
    if (size <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(size, this.buf.length * 2, 4096));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  write(bytes, at) {
    const start = this.append ? this.len : at;
    this.ensure(start + bytes.length);
    if (start > this.len) this.buf.fill(0, this.len, start);
    this.buf.set(bytes, start);
    this.len = Math.max(this.len, start + bytes.length);
    this.dirty = true;
    return start + bytes.length;
  }

  flush() {
    if (!this.dirty || !this.writable) return;
    this.ctx.layers.writeFile(this.abs, Buffer.from(this.buf.subarray(0, this.len)));
    this.dirty = false;
  }

  fd_close() {
    try {
      this.flush();
      return 0;
    } catch (err) {
      return errnoOf(err);
    } finally {
      this.ctx.forget(this);
    }
  }

  fd_sync() {
    try {
      this.flush();
      return 0;
    } catch (err) {
      return errnoOf(err);
    }
  }

  fd_fdstat_get() {
    return { ret: 0, fdstat: new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, this.append ? wasi.FDFLAGS_APPEND : 0) };
  }

  fd_fdstat_set_flags(flags) {
    this.append = (flags & wasi.FDFLAGS_APPEND) !== 0;
    return 0;
  }

  fd_filestat_get() {
    const fsStat = new wasi.Filestat(this.ino, wasi.FILETYPE_REGULAR_FILE, BigInt(this.len));
    fsStat.nlink = 1n;
    return { ret: 0, filestat: fsStat };
  }

  fd_filestat_set_size(size) {
    return this.guard(() => {
      if (!this.writable) return wasi.ERRNO_BADF;
      const n = Number(size);
      this.ensure(n);
      if (n > this.len) this.buf.fill(0, this.len, n);
      this.len = n;
      this.dirty = true;
      return 0;
    });
  }

  fd_filestat_set_times() { return 0; }

  fd_allocate(offset, len) {
    return this.guard(() => {
      if (!this.writable) return wasi.ERRNO_BADF;
      const end = Number(offset + len);
      this.ensure(end);
      if (end > this.len) this.buf.fill(0, this.len, end);
      this.len = Math.max(this.len, end);
      this.dirty = true;
      return 0;
    });
  }

  fd_read(size) {
    const n = Math.max(0, Math.min(size, this.len - this.pos));
    const data = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return { ret: 0, data };
  }

  fd_pread(size, offset) {
    const at = Number(offset);
    const n = Math.max(0, Math.min(size, this.len - at));
    return { ret: 0, data: this.buf.subarray(at, at + n) };
  }

  fd_write(data) {
    if (!this.writable) return { ret: wasi.ERRNO_BADF, nwritten: 0 };
    this.pos = this.write(data, this.pos);
    return { ret: 0, nwritten: data.byteLength };
  }

  fd_pwrite(data, offset) {
    if (!this.writable) return { ret: wasi.ERRNO_BADF, nwritten: 0 };
    this.write(data, Number(offset));
    return { ret: 0, nwritten: data.byteLength };
  }

  fd_seek(offset, whence) {
    let base;
    if (whence === wasi.WHENCE_SET) base = 0n;
    else if (whence === wasi.WHENCE_CUR) base = BigInt(this.pos);
    else if (whence === wasi.WHENCE_END) base = BigInt(this.len);
    else return { ret: wasi.ERRNO_INVAL, offset: 0n };
    const next = base + offset;
    if (next < 0n) return { ret: wasi.ERRNO_INVAL, offset: 0n };
    this.pos = Number(next);
    return { ret: 0, offset: next };
  }

  fd_tell() { return { ret: 0, offset: BigInt(this.pos) }; }
}

/** A directory opened through a preopen or path_open. Path operations resolve inside `abs`. */
export class WasiDir extends Fd {
  constructor(ctx, abs, { preopenName, parentAbs } = {}) {
    super();
    this.ctx = ctx;
    this.abs = abs;
    this.preopenName = preopenName;
    this.parentAbs = parentAbs ?? posix.dirname(abs);
    this.ino = ctx.inoFor(abs);
    this.names = null;
  }

  guard(fn, fallback) {
    try {
      return fn();
    } catch (err) {
      return fallback(errnoOf(err));
    }
  }

  fd_close() { return 0; }
  fd_fdstat_get() { return { ret: 0, fdstat: new wasi.Fdstat(wasi.FILETYPE_DIRECTORY, 0) }; }

  fd_filestat_get() {
    return this.guard(() => {
      const st = this.ctx.layers.stat(this.abs, true);
      return { ret: 0, filestat: filestatFor(this.ctx, this.abs, st) };
    }, (ret) => ({ ret, filestat: null }));
  }

  fd_prestat_get() {
    if (this.preopenName === undefined) return { ret: wasi.ERRNO_BADF, prestat: null };
    return { ret: 0, prestat: wasi.Prestat.dir(this.preopenName) };
  }

  fd_readdir_single(cookie) {
    if (cookie === 0n) {
      this.names = null;
      return { ret: 0, dirent: new wasi.Dirent(1n, this.ino, '.', wasi.FILETYPE_DIRECTORY) };
    }
    if (cookie === 1n) {
      return { ret: 0, dirent: new wasi.Dirent(2n, this.ctx.inoFor(this.parentAbs), '..', wasi.FILETYPE_DIRECTORY) };
    }
    return this.guard(() => {
      if (this.names === null) this.names = this.ctx.layers.readdir(this.abs);
      const index = Number(cookie - 2n);
      if (index >= this.names.length) return { ret: 0, dirent: null };
      const name = this.names[index];
      const child = posix.join(this.abs, name);
      const st = this.ctx.layers.statOrNull(child, false);
      const type = !st ? wasi.FILETYPE_REGULAR_FILE
        : st.type === 'dir' ? wasi.FILETYPE_DIRECTORY : st.type === 'symlink' ? wasi.FILETYPE_SYMBOLIC_LINK : wasi.FILETYPE_REGULAR_FILE;
      return { ret: 0, dirent: new wasi.Dirent(cookie + 1n, this.ctx.inoFor(child), name, type) };
    }, (ret) => ({ ret, dirent: null }));
  }

  fd_read() { return { ret: wasi.ERRNO_BADF, data: new Uint8Array(0) }; }
  fd_pread() { return { ret: wasi.ERRNO_BADF, data: new Uint8Array(0) }; }
  fd_write() { return { ret: wasi.ERRNO_BADF, nwritten: 0 }; }
  fd_pwrite() { return { ret: wasi.ERRNO_BADF, nwritten: 0 }; }
  fd_seek() { return { ret: wasi.ERRNO_BADF, offset: 0n }; }
  fd_tell() { return { ret: wasi.ERRNO_BADF, offset: 0n }; }
  fd_allocate() { return wasi.ERRNO_BADF; }
  fd_filestat_set_size() { return wasi.ERRNO_BADF; }

  path(rel) { return joinGuest(this.abs, rel); }

  path_open(dirflags, rel, oflags, rightsBase, rightsInheriting, fdflags) {
    return this.guard(() => {
      const abs = this.path(rel);
      const layers = this.ctx.layers;
      this.ctx.flushAll();
      let st = layers.statOrNull(abs, true);
      const create = (oflags & wasi.OFLAGS_CREAT) !== 0;
      const exclusive = (oflags & wasi.OFLAGS_EXCL) !== 0;
      const wantDir = (oflags & wasi.OFLAGS_DIRECTORY) !== 0;
      const truncate = (oflags & wasi.OFLAGS_TRUNC) !== 0;
      if (!st) {
        if (!create) return { ret: wasi.ERRNO_NOENT, fd_obj: null };
        if (!layers.writable(abs)) return { ret: wasi.ERRNO_ROFS, fd_obj: null };
        if (wantDir) layers.mkdir(abs);
        else layers.writeFile(abs, Buffer.alloc(0));
        st = layers.stat(abs, true);
      } else if (create && exclusive) {
        return { ret: wasi.ERRNO_EXIST, fd_obj: null };
      }
      if (wantDir && st.type !== 'dir') return { ret: wasi.ERRNO_NOTDIR, fd_obj: null };
      if (st.type === 'dir') {
        if (truncate) return { ret: wasi.ERRNO_ISDIR, fd_obj: null };
        return { ret: 0, fd_obj: new WasiDir(this.ctx, abs, { parentAbs: this.abs }) };
      }
      const writable = layers.writable(abs);
      if ((truncate || create) && !writable) return { ret: wasi.ERRNO_ROFS, fd_obj: null };
      const file = new WasiFile(this.ctx, abs, Buffer.from(layers.readFile(abs)), {
        writable,
        append: (fdflags & wasi.FDFLAGS_APPEND) !== 0,
      });
      if (truncate) {
        file.len = 0;
        file.dirty = true;
      }
      return { ret: 0, fd_obj: file };
    }, (ret) => ({ ret, fd_obj: null }));
  }

  path_lookup(rel) {
    return this.guard(() => {
      const abs = this.path(rel);
      this.ctx.flushAll();
      const st = this.ctx.layers.stat(abs, false);
      return { ret: 0, inode_obj: new WasiInode(this.ctx, abs) };
    }, (ret) => ({ ret, inode_obj: null }));
  }

  path_create_directory(rel) {
    return this.guard(() => {
      const abs = this.path(rel);
      this.ctx.flushAll();
      this.ctx.layers.mkdir(abs);
      return 0;
    }, (ret) => ret);
  }

  path_filestat_get(flags, rel) {
    return this.guard(() => {
      const abs = this.path(rel);
      this.ctx.flushAll();
      const st = this.ctx.layers.stat(abs, (flags & LOOKUP_SYMLINK_FOLLOW) !== 0);
      return { ret: 0, filestat: filestatFor(this.ctx, abs, st) };
    }, (ret) => ({ ret, filestat: null }));
  }

  path_filestat_set_times(flags, rel, atim, mtim, fstFlags) {
    return this.guard(() => {
      const abs = this.path(rel);
      this.ctx.flushAll();
      if (fstFlags & FSTFLAGS_MTIM) this.ctx.layers.utimes(abs, Number(mtim) / 1e6);
      return 0;
    }, (ret) => ret);
  }

  path_link(rel, inode) {
    // Hard links are not supported. A rename reaches here with an inode from path_unlink (see below).
    if (!(inode instanceof MovedInode)) return wasi.ERRNO_NOTSUP;
    return this.guard(() => {
      const dst = this.path(rel);
      this.ctx.flushAll();
      this.ctx.layers.rename(inode.abs, dst);
      return 0;
    }, (ret) => ret);
  }

  /**
   * Used by a rename: WASI rename calls path_unlink on the source, then path_link on the target. The source is not
   * removed here. It is handed over as a MovedInode, and path_link performs the move.
   */
  path_unlink(rel) {
    return this.guard(() => {
      const abs = this.path(rel);
      this.ctx.flushAll();
      const st = this.ctx.layers.stat(abs, false);
      return { ret: 0, inode_obj: new MovedInode(this.ctx, abs, st.type) };
    }, (ret) => ({ ret, inode_obj: null }));
  }

  path_unlink_file(rel) {
    return this.guard(() => {
      const abs = this.path(rel);
      this.ctx.flushAll();
      const st = this.ctx.layers.stat(abs, false);
      if (st.type === 'dir') return wasi.ERRNO_ISDIR;
      this.ctx.layers.unlink(abs);
      return 0;
    }, (ret) => ret);
  }

  path_remove_directory(rel) {
    return this.guard(() => {
      const abs = this.path(rel);
      this.ctx.flushAll();
      this.ctx.layers.rmdir(abs);
      return 0;
    }, (ret) => ret);
  }

  path_readlink(rel) {
    return this.guard(() => {
      const abs = this.path(rel);
      this.ctx.flushAll();
      return { ret: 0, data: this.ctx.layers.readlink(abs) };
    }, (ret) => ({ ret, data: null }));
  }
}

/** A path found by path_lookup. It can be opened or stat'ed. */
export class WasiInode extends Inode {
  constructor(ctx, abs) {
    super();
    this.ctx = ctx;
    this.abs = abs;
    this.ino = ctx.inoFor(abs);
  }

  stat() {
    const st = this.ctx.layers.stat(this.abs, false);
    return filestatFor(this.ctx, this.abs, st);
  }

  path_open(oflags, rightsBase, fdflags) {
    const st = this.ctx.layers.stat(this.abs, true);
    if (st.type === 'dir') return { ret: 0, fd_obj: new WasiDir(this.ctx, this.abs) };
    const writable = this.ctx.layers.writable(this.abs);
    return {
      ret: 0,
      fd_obj: new WasiFile(this.ctx, this.abs, Buffer.from(this.ctx.layers.readFile(this.abs)), {
        writable, append: (fdflags & wasi.FDFLAGS_APPEND) !== 0,
      }),
    };
  }
}

/** The source of a rename, handed from path_unlink to path_link. Only path_link accepts it. */
export class MovedInode extends WasiInode {
  constructor(ctx, abs, type) {
    super(ctx, abs);
    this.type = type;
  }
}

/** stdin: bytes from a fixed buffer, or from a synchronous pull function that returns the next chunk or null at EOF. */
export class StdinFd extends Fd {
  constructor(source) {
    super();
    this.source = source;
    this.pending = new Uint8Array(0);
    this.eof = false;
  }

  fd_fdstat_get() { return { ret: 0, fdstat: new wasi.Fdstat(wasi.FILETYPE_UNKNOWN, 0) }; }

  fd_read(size) {
    if (this.pending.length === 0 && !this.eof) {
      const next = typeof this.source === 'function' ? this.source(size) : this.source;
      if (typeof this.source !== 'function') this.eof = true;
      if (next === null || next === undefined) this.eof = true;
      else this.pending = toBytes(next);
    }
    const n = Math.min(size, this.pending.length);
    const data = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n);
    return { ret: 0, data };
  }
}

export function toBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  throw new KernelError('EINVAL', 'EINVAL: stdin must be bytes, text, or a function returning them. Next: pass a Uint8Array.');
}

/** stdout or stderr: each write reaches the callback as a Uint8Array. */
export function stdioFd(callback) {
  return new ConsoleStdout((buf) => callback(buf));
}
