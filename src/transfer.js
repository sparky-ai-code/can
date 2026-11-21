// File transfer between the host and a can. importToCan reads host files and writes them into a can.
// exportFromCan reads a can and writes host files, but only under the transfer root. Both directions
// move bytes, so binary files survive. This module is the only place that touches host files for a
// transfer, and it is reached only from the host side (MCP server and CLI), never from can code.
//
// Error text never holds a host path: names are shown relative to the source or the transfer root, or as
// a base name. Each transfer runs under a lock on its can (withCanLock), so the checks and writes of one call
// cannot interleave with another transfer to the same can.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KernelError } from './kernel/errors.js';

const MB = 1024 * 1024;
// 256 MB per file fits a 188 MB Electron binary. A can holds its files in memory (VM heap cap 512 MB), so a
// file this size is only practical in a can with little else in it; see docs/can-ci-blockers.md, section 8.
export const LIMITS = Object.freeze({ maxFileBytes: 256 * MB, maxCallBytes: 500 * MB, maxCallFiles: 5000 });
const CAN_HOME = '/home/agent';
// Characters Windows refuses in file names. Can names may contain them, so exports check first.
// eslint-disable-next-line no-control-regex
const WINDOWS_BAD_NAME = /[<>:"|?*\\\x00-\x1f]/;
// Device names Windows reserves, with or without an extension (CON.txt is still CON).
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;

/** Where exports land: $CAN_TRANSFER_DIR, else %USERPROFILE%\.can\transfer (~/.can/transfer elsewhere). */
export function defaultTransferRoot() {
  return path.resolve(process.env.CAN_TRANSFER_DIR || path.join(os.homedir(), '.can', 'transfer'));
}

// ---- locks, names and errors

const canLocks = new Map(); // can id -> the tail of the queue of transfers on that can

/** Runs fn once every earlier transfer on the same can has finished, so transfers on one can never interleave. */
function withCanLock(can, fn) {
  const key = String(can.id);
  const prev = canLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(() => {}, () => {}); // never rejects, so the queue keeps moving
  canLocks.set(key, tail);
  tail.then(() => { if (canLocks.get(key) === tail) canLocks.delete(key); });
  return run;
}

/** Why a path segment cannot be a Windows file name, or null. Applied to every name an export writes. */
function windowsNameProblem(seg) {
  if (WINDOWS_BAD_NAME.test(seg)) return 'contains a character Windows does not allow';
  if (/[. ]$/.test(seg)) return 'ends with a dot or a space';
  if (WINDOWS_RESERVED.test(seg.split('.')[0].trim())) return 'is a reserved Windows device name';
  return null;
}

function checkWindowsName(seg) {
  const why = windowsNameProblem(seg);
  if (why) throw new KernelError('EINVAL', `EINVAL: '${seg}' ${why}, so it cannot be written on Windows`);
}

/** A host path as messages show it: relative to base when inside it, else the base name only. */
function shownHost(base, p) {
  const rel = path.relative(base, p);
  return rel && isInside(base, p) ? rel.split(path.sep).join('/') : path.basename(p);
}

/** Any error that leaves this module. A KernelError is already safe; a raw Node error is rewritten to name only label. */
function scrubError(err, label) {
  if (err instanceof KernelError) return err;
  const code = typeof err?.code === 'string' ? err.code : 'EIO';
  return new KernelError(code, `${code}: ${err?.syscall ?? 'transfer'} failed for '${label}'`);
}

const bytesOf = (n) => `${n} bytes`;

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** True when target is root or lies inside it. A lexical check: links are checked separately. */
function isInside(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Refuses a destination whose path below root goes through a symbolic link or junction. */
function refuseLinksBelow(root, dest) {
  let cur = root;
  for (const seg of path.relative(root, dest).split(path.sep)) {
    if (!seg) continue;
    cur = path.join(cur, seg);
    const st = lstatOrNull(cur);
    if (!st) return;
    if (st.isSymbolicLink()) {
      throw new KernelError('EPERM', `EPERM: refusing to write through a symbolic link at '${shownHost(root, cur)}'`);
    }
  }
}

/** Refuses when a directory the transfer needs is a file on the host (ENOTDIR), before anything is written. */
function checkHostDirs(base, dirs, files) {
  const need = new Set(dirs);
  for (const f of files) need.add(path.dirname(f));
  for (const d of [...need]) {
    for (let cur = d; cur !== base && isInside(base, cur); cur = path.dirname(cur)) need.add(cur);
  }
  for (const d of need) {
    const cur = lstatOrNull(d);
    if (cur && !cur.isDirectory()) {
      throw new KernelError('ENOTDIR', `ENOTDIR: ${shownHost(base, d)} exists on the host and is not a directory`);
    }
  }
}

/** The directories above a can path, nearest first, up to and including '/'. */
function ancestorsOf(p) {
  const out = [];
  for (let cur = path.posix.dirname(p); ; cur = path.posix.dirname(cur)) {
    out.push(cur);
    if (cur === '/') return out;
  }
}

/** Adds one file to a transfer plan, enforcing the per-file, per-call size and count limits. */
function addFile(state, rel, abs, size, shown) {
  const { maxFileBytes, maxCallBytes, maxCallFiles } = state.limits;
  if (size > maxFileBytes) {
    throw new KernelError('EFBIG', `EFBIG: '${shown}' is ${bytesOf(size)}; the limit is ${bytesOf(maxFileBytes)} per file`);
  }
  state.files.push({ rel, abs, size, shown });
  state.bytes += size;
  if (state.files.length > maxCallFiles) {
    throw new KernelError('EFBIG', `EFBIG: more than ${maxCallFiles} files in one call`);
  }
  if (state.bytes > maxCallBytes) {
    throw new KernelError('EFBIG', `EFBIG: more than ${bytesOf(maxCallBytes)} in one call`);
  }
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Turns exclude names into a test. An entry is excluded when its name matches one of them at any depth.
 * "*" matches any run of characters inside one name, so "*.log" and ".env*" work. Names with "/" are refused,
 * which keeps the rule simple: it names entries, not paths.
 */
export function excludeMatcher(exclude = []) {
  if (!Array.isArray(exclude)) throw new KernelError('EINVAL', 'EINVAL: exclude must be a list of file or folder names');
  const tests = exclude.map((pattern) => {
    if (typeof pattern !== 'string' || pattern === '' || pattern.includes('/') || pattern === '.' || pattern === '..') {
      throw new KernelError('EINVAL', 'EINVAL: each exclude entry is one file or folder name, such as node_modules or *.log');
    }
    const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    const re = new RegExp(`^${source}$`);
    return (name) => re.test(name);
  });
  return (name) => tests.some((test) => test(name));
}

/** Walks a host directory. Symlinks must resolve inside base; links to directories are refused. */
function collectHost(dir, segs, base, state) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const full = path.join(dir, ent.name);
    const rel = [...segs, ent.name];
    const shown = rel.join('/');
    if (state.excluded(ent.name)) {
      state.skipped.push(shown);
      continue;
    }
    if (ent.isSymbolicLink()) {
      const target = fs.realpathSync.native(full);
      if (!isInside(base, target)) {
        throw new KernelError('EPERM', `EPERM: refusing to import '${shown}': the symbolic link resolves outside the source`);
      }
      const st = fs.statSync(target);
      if (st.isDirectory()) {
        throw new KernelError('EPERM', `EPERM: refusing to import '${shown}': symbolic links to directories are not followed`);
      }
      if (!st.isFile()) throw new KernelError('EINVAL', `EINVAL: '${shown}' is not a regular file`);
      addFile(state, rel, target, st.size, shown);
    } else if (ent.isDirectory()) {
      state.dirs.push(rel);
      collectHost(full, rel, base, state);
    } else if (ent.isFile()) {
      addFile(state, rel, full, fs.statSync(full).size, shown);
    } else {
      throw new KernelError('EINVAL', `EINVAL: '${shown}' is not a regular file or directory`);
    }
  }
}

/** The stat of a can path, or null when it does not exist. */
async function canStatOrNull(can, p) {
  return (await can.exists(p)) ? can.stat(p) : null;
}

// ---- host to can

/**
 * Copies a host file or directory tree into a can. Nothing is written unless every check passes.
 * Transfers to one can run one at a time, so overwrite:false is exclusive: of two calls that name the same
 * destination, one succeeds and the other fails with EEXIST.
 * @param {import('./can.js').Can} can
 * @param {string} hostPath host file or directory (absolute, or relative to the host process cwd)
 * @param {string} canPath destination inside the can (relative paths start in /home/agent)
 * @param {{overwrite?: boolean, limits?: typeof LIMITS, exclude?: string[]}} [opts] exclude: names of files or
 *   folders to leave out of a directory import (see excludeMatcher); the result lists what was skipped
 * @returns {Promise<{files: number, dirs: number, bytes: number, hostPath: string, canPath: string, skipped: string[]}>}
 */
export async function importToCan(can, hostPath, canPath, { overwrite = false, limits = LIMITS, exclude = [] } = {}) {
  const src = path.resolve(hostPath);
  const label = path.basename(src) || 'source';
  const excluded = excludeMatcher(exclude);
  try {
    return await withCanLock(can, () => importLocked(can, src, label, canPath, overwrite, limits, excluded));
  } catch (err) {
    throw scrubError(err, label);
  }
}

async function importLocked(can, src, label, canPath, overwrite, limits, excluded) {
  if (!lstatOrNull(src)) throw new KernelError('ENOENT', `ENOENT: no such host file or directory '${label}'`);
  let real;
  try {
    real = fs.realpathSync.native(src);
  } catch (err) {
    if (err.code === 'ENOENT') throw new KernelError('ENOENT', `ENOENT: dangling symbolic link '${label}'`);
    throw err;
  }
  const st = fs.statSync(real);
  // A directory bounds its own links. A file bounds its link by the directory that holds it.
  const base = st.isDirectory() ? real : fs.realpathSync.native(path.dirname(src));
  if (!isInside(base, real)) {
    throw new KernelError('EPERM', `EPERM: refusing to import '${label}': it resolves outside the directory that bounds it`);
  }

  const isDir = st.isDirectory();
  const state = { dirs: [], files: [], bytes: 0, limits, excluded, skipped: [] };
  const canDest = path.posix.resolve(CAN_HOME, canPath);
  if (isDir) {
    state.dirs.push([]);
    collectHost(real, [], base, state);
  } else {
    addFile(state, [], real, st.size, label);
  }

  // Check the whole plan in the can before the first write.
  const dirPaths = state.dirs.map((segs) => path.posix.join(canDest, ...segs));
  const filePaths = state.files.map((f) => path.posix.join(canDest, ...f.rel));
  for (const anc of ancestorsOf(canDest)) {
    const cur = await canStatOrNull(can, anc);
    if (cur && cur.type !== 'dir') throw new KernelError('ENOTDIR', `ENOTDIR: ${anc} exists in the can and is not a directory`);
  }
  for (const d of dirPaths) {
    const cur = await canStatOrNull(can, d);
    if (cur && cur.type !== 'dir') throw new KernelError('ENOTDIR', `ENOTDIR: ${d} exists in the can and is not a directory`);
  }
  for (const p of filePaths) {
    const cur = await canStatOrNull(can, p);
    if (!cur) continue;
    if (cur.type === 'dir') throw new KernelError('EISDIR', `EISDIR: ${p} is a directory in the can`);
    if (!overwrite) throw new KernelError('EEXIST', `EEXIST: ${p} already exists in the can (pass overwrite to replace it)`);
  }

  if (!isDir) await can.mkdir(path.posix.dirname(canDest), { recursive: true });
  for (const d of dirPaths) await can.mkdir(d, { recursive: true });
  for (let i = 0; i < state.files.length; i++) {
    const bytes = fs.readFileSync(state.files[i].abs);
    if (bytes.length > limits.maxFileBytes) {
      throw new KernelError('EFBIG', `EFBIG: '${state.files[i].shown}' grew past the ${bytesOf(limits.maxFileBytes)} limit`);
    }
    await can.writeFile(filePaths[i], bytes);
  }
  return {
    files: state.files.length,
    dirs: state.dirs.length - (isDir ? 1 : 0),
    bytes: state.bytes,
    hostPath: src,
    canPath: canDest,
    skipped: state.skipped,
  };
}

// ---- can to host

/** Walks a can directory with listDir. Symlinks inside the can are skipped and counted. */
async function collectCan(can, dirAbs, segs, state) {
  const entries = (await can.listDir(dirAbs)).sort(byName);
  for (const e of entries) {
    const abs = path.posix.join(dirAbs, e.name);
    const rel = [...segs, e.name];
    if (e.type === 'symlink') {
      state.skipped++;
    } else if (e.type === 'dir') {
      state.dirs.push(rel);
      await collectCan(can, abs, rel, state);
    } else {
      addFile(state, rel, abs, e.size, rel.join('/'));
    }
  }
}

/**
 * The source path itself must not be a link: stat would follow it, and links are never exported. Only the last
 * part is checked; the can resolves the directories above it as its own shell does.
 */
async function refuseCanLink(can, canSrc) {
  if (canSrc === '/') return;
  let entries;
  try {
    entries = await can.listDir(path.posix.dirname(canSrc));
  } catch {
    return; // a missing or non-directory parent: stat reports it
  }
  const ent = entries.find((e) => e.name === path.posix.basename(canSrc));
  if (ent?.type === 'symlink') {
    throw new KernelError('EPERM', `EPERM: '${canSrc}' is a symbolic link in the can; links are not exported`);
  }
}

/**
 * Copies a can file or directory tree to the host. Writes happen only under the transfer root.
 * Symlinks inside the can are not followed; they are counted in `skipped`. A canPath that is itself a link is
 * refused. Names Windows cannot hold, and names that differ only by case, are refused before any write.
 * @param {import('./can.js').Can} can
 * @param {string} canPath source inside the can (relative paths start in /home/agent)
 * @param {string} hostPath destination, relative to the transfer root (or absolute, inside it)
 * @param {{overwrite?: boolean, root?: string, limits?: typeof LIMITS}} [opts]
 * @returns {Promise<{files: number, dirs: number, bytes: number, skipped: number, hostPath: string, canPath: string}>}
 */
export async function exportFromCan(can, canPath, hostPath, { overwrite = false, root = defaultTransferRoot(), limits = LIMITS } = {}) {
  const base = path.resolve(root);
  const target = path.resolve(base, hostPath);
  const label = path.basename(target) || 'transfer root';
  if (!isInside(base, target)) {
    throw new KernelError('EPERM', `EPERM: refusing to export to '${label}': it is outside the transfer root`);
  }
  try {
    return await withCanLock(can, () => exportLocked(can, canPath, base, target, overwrite, limits));
  } catch (err) {
    throw scrubError(err, label);
  }
}

async function exportLocked(can, canPath, base, target, overwrite, limits) {
  const canSrc = path.posix.resolve(CAN_HOME, canPath);
  await refuseCanLink(can, canSrc);
  const st = await can.stat(canSrc);

  const isDir = st.type === 'dir';
  const state = { dirs: [], files: [], bytes: 0, skipped: 0, limits };
  if (isDir) {
    state.dirs.push([]);
    await collectCan(can, canSrc, [], state);
  } else {
    addFile(state, [], canSrc, st.size, path.posix.basename(canSrc));
  }

  // Every name must be writable on Windows, the host path's own segments included.
  const names = [...state.dirs, ...state.files.map((f) => f.rel)];
  for (const segs of names) for (const seg of segs) checkWindowsName(seg);
  for (const seg of path.relative(base, target).split(path.sep)) if (seg) checkWindowsName(seg);

  // Names that differ only by case are one name on a case-insensitive host, so refuse the set before any write.
  const folded = new Map();
  for (const segs of names) {
    const name = segs.join('/');
    const prior = folded.get(name.toLowerCase());
    if (prior !== undefined && prior !== name) {
      throw new KernelError('EINVAL', `EINVAL: '${prior}' and '${name}' in the can differ only by case; a Windows host cannot keep both`);
    }
    folded.set(name.toLowerCase(), name);
  }

  // Check every destination before the first write.
  const dirDests = state.dirs.map((segs) => path.join(target, ...segs));
  const fileDests = state.files.map((f) => path.join(target, ...f.rel));
  for (const d of [...dirDests, ...fileDests]) {
    if (!isInside(base, d)) {
      throw new KernelError('EPERM', `EPERM: refusing to write '${shownHost(base, d)}': it is outside the transfer root`);
    }
    refuseLinksBelow(base, d);
  }
  checkHostDirs(base, dirDests, fileDests);
  for (const d of fileDests) {
    const cur = lstatOrNull(d);
    if (!cur) continue;
    if (cur.isDirectory()) throw new KernelError('EISDIR', `EISDIR: ${shownHost(base, d)} is a directory on the host`);
    if (!overwrite) throw new KernelError('EEXIST', `EEXIST: ${shownHost(base, d)} already exists (pass overwrite to replace it)`);
  }

  fs.mkdirSync(base, { recursive: true });
  for (const d of dirDests) fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < state.files.length; i++) {
    const f = state.files[i];
    const bytes = await can.readFile(f.abs);
    if (bytes.length > limits.maxFileBytes) {
      throw new KernelError('EFBIG', `EFBIG: '${f.shown}' is ${bytesOf(bytes.length)}; the limit is ${bytesOf(limits.maxFileBytes)} per file`);
    }
    fs.mkdirSync(path.dirname(fileDests[i]), { recursive: true });
    fs.writeFileSync(fileDests[i], bytes, { flag: overwrite ? 'w' : 'wx' });
  }
  return {
    files: state.files.length,
    dirs: state.dirs.length - (isDir ? 1 : 0),
    bytes: state.bytes,
    skipped: state.skipped,
    hostPath: target,
    canPath: canSrc,
  };
}

/**
 * Writes bytes to a host file under the transfer root, with the rules of exportFromCan: the path may not leave the
 * root, no link on the way may be followed, Windows-unsafe names are refused, and an existing file is kept unless
 * overwrite is set. Used for bytes that are not a can file (screenshots). Returns the host path written.
 */
export function writeTransferFile(bytes, hostPath, { overwrite = false, root = defaultTransferRoot() } = {}) {
  const base = path.resolve(root);
  const target = path.resolve(base, String(hostPath));
  const label = path.basename(target) || 'transfer root';
  try {
    if (target === base || !isInside(base, target)) {
      throw new KernelError('EPERM', `EPERM: refusing to write '${label}': it is outside the transfer root`);
    }
    for (const seg of path.relative(base, target).split(path.sep)) checkWindowsName(seg);
    refuseLinksBelow(base, target);
    checkHostDirs(base, [], [target]);
    const cur = lstatOrNull(target);
    if (cur && cur.isDirectory()) throw new KernelError('EISDIR', `EISDIR: ${label} is a directory on the host`);
    if (cur && !overwrite) throw new KernelError('EEXIST', `EEXIST: ${label} already exists (pass overwrite to replace it)`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: overwrite ? 'w' : 'wx' });
    return target;
  } catch (err) {
    throw scrubError(err, label);
  }
}
