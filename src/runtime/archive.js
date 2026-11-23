// Archive builtins: tar (ustar, with -z for gzip), gzip and gunzip, zip and unzip (stored or deflated).
// Archives use the formats host tools read, so a can's tar or zip can be unpacked on the host and back.
// Extraction never writes outside the destination folder: a member name with ".." is refused, and so is
// a symbolic link whose target is absolute or contains "..". Leading slashes in member names are dropped.
import { posix } from 'node:path';
import zlib from 'node:zlib';
import { readAll } from './io.js';
import { splitFlags } from './textcmds.js';

const BLOCK = 512;
const errOut = (io, msg) => io.stderr.write(`${msg}\n`);
const resolveIn = (sh, p) => sh.can.vfs.resolve(p, sh.cwd);
const msgOf = (e) => (e.code === 'ENOENT' ? 'No such file or directory' : e.message);

/** Path segments of a member name, or null when the name would leave the destination. */
function safeSegments(name) {
  const segs = name.split('/').filter((s) => s !== '' && s !== '.');
  return segs.includes('..') ? null : segs;
}

/** True when a symbolic link target stays inside its folder tree: relative, with no "..". */
function linkIsSafe(target) {
  return target !== '' && !target.startsWith('/') && !target.split('/').includes('..');
}

function ensureDir(v, dir) {
  if (!v.exists(dir)) v.mkdir(dir, { recursive: true });
}

/** Removes a symbolic link at abs so that a write creates a regular file there rather than following it. */
function removeIfSymlink(v, abs) {
  try {
    if (v.lstat(abs).isSymbolicLink()) v.unlink(abs);
  } catch {
    // Nothing is there yet.
  }
}

function setMode(v, abs, mode) {
  if (!mode) return;
  try { v.chmod(abs, mode & 0o7777); } catch { /* best effort, as tar is when it cannot set a mode */ }
}

// ---------------------------------------------------------------- tar

/** Splits a name into ustar's name (up to 100 bytes) and prefix (up to 155), or throws when it cannot. */
function ustarName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  const parts = name.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('/');
    const rest = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix };
  }
  throw new Error(`file name too long for tar: ${name}`);
}

const octal = (n, len) => `${Math.trunc(n).toString(8).padStart(len - 1, '0')}\0`;

/** One 512-byte ustar header for an entry. */
function tarHeader(e, size) {
  const { name, prefix } = ustarName(e.name);
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(e.mode & 0o7777, 8), 100, 8, 'latin1');
  h.write(octal(0, 8), 108, 8, 'latin1');
  h.write(octal(0, 8), 116, 8, 'latin1');
  h.write(octal(size, 12), 124, 12, 'latin1');
  h.write(octal(Math.floor(e.mtime / 1000), 12), 136, 12, 'latin1');
  h.write('        ', 148, 8, 'latin1'); // the checksum counts as spaces
  h.write(e.type, 156, 1, 'latin1');
  h.write(e.linkname ?? '', 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return h;
}

function writeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const size = e.type === '0' ? e.data.length : 0;
    parts.push(tarHeader(e, size));
    if (e.type === '0') {
      parts.push(e.data);
      const pad = (BLOCK - (size % BLOCK)) % BLOCK;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** Reads a NUL-terminated field. */
function cString(buf, off, len) {
  const slice = buf.subarray(off, off + len);
  const nul = slice.indexOf(0);
  return slice.toString('utf8', 0, nul < 0 ? slice.length : nul);
}

/** Reads an octal number field; an empty field is 0. */
function octalField(buf, off, len) {
  const s = buf.toString('latin1', off, off + len).replace(/[\0 ]/g, '');
  if (s === '') return 0;
  const n = parseInt(s, 8);
  if (Number.isNaN(n)) throw new Error('invalid header');
  return n;
}

/** Key/value records of a pax extended header ("<len> key=value\n"). */
function parsePax(data) {
  const out = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const len = parseInt(data.toString('latin1', pos, space), 10);
    if (!(len > 0)) break;
    const record = data.toString('utf8', space + 1, pos + len - 1); // without the trailing newline
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

/** Parses a tar archive (ustar, GNU long names and pax headers) into entries. Throws on a damaged header. */
function parseTar(buf) {
  const entries = [];
  let off = 0;
  let longName = null;
  let longLink = null;
  let pax = {};
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (octalField(h, 148, 8) !== sum) throw new Error('invalid tar header (checksum)');
    const size = octalField(h, 124, 12);
    const typeByte = h[156];
    const type = typeByte === 0 || typeByte === 0x37 ? '0' : String.fromCharCode(typeByte); // NUL and '7' are files
    const body = off + BLOCK;
    if (body + size > buf.length) throw new Error('truncated archive');
    const data = buf.subarray(body, body + size);
    off = body + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') { longName = cString(data, 0, data.length); continue; }
    if (type === 'K') { longLink = cString(data, 0, data.length); continue; }
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'g') continue;
    const isUstar = h.toString('latin1', 257, 262) === 'ustar';
    const name = cString(h, 0, 100);
    const prefix = isUstar ? cString(h, 345, 155) : '';
    entries.push({
      name: pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name),
      type,
      mode: octalField(h, 100, 8),
      size,
      mtime: octalField(h, 136, 12) * 1000,
      linkname: pax.linkpath ?? longLink ?? cString(h, 157, 100),
      data,
    });
    longName = null;
    longLink = null;
    pax = {};
  }
  return entries;
}

/** Parses the tar options, both classic (tar czf a.tgz dir) and dashed (tar -czf a.tgz dir). */
function parseTarArgs(args) {
  const out = { mode: null, gz: false, verbose: false, archive: null, dir: null, operands: [], error: null };
  const letters = [];
  const rest = [];
  let k = 0;
  if (args.length && !args[0].startsWith('-') && /^[a-zA-Z]+$/.test(args[0])) {
    letters.push(...args[0]);
    k = 1;
  }
  const longLetters = { '--create': 'c', '--extract': 'x', '--get': 'x', '--list': 't', '--gzip': 'z', '--gunzip': 'z', '--verbose': 'v' };
  for (; k < args.length; k++) {
    const a = args[k];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq < 0 ? a : a.slice(0, eq);
      const value = eq < 0 ? null : a.slice(eq + 1);
      if (key === '--file' || key === '--directory') {
        const v = value ?? args[++k];
        if (v === undefined) { out.error = `option '${key}' requires an argument`; return out; }
        if (key === '--file') out.archive = v;
        else out.dir = v;
      } else if (longLetters[key]) {
        letters.push(longLetters[key]);
      } else {
        out.error = `unrecognized option '${a}'`;
        return out;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      letters.push(...a.slice(1));
    } else {
      rest.push(a);
    }
  }
  let ri = 0;
  for (const ch of letters) {
    if (ch === 'c' || ch === 'x' || ch === 't') {
      if (out.mode && out.mode !== ch) { out.error = 'You may only specify one of -c, -x, -t'; return out; }
      out.mode = ch;
    } else if (ch === 'z') out.gz = true;
    else if (ch === 'v') out.verbose = true;
    else if (ch === 'f' || ch === 'C') {
      if (ri >= rest.length) { out.error = `option requires an argument -- '${ch}'`; return out; }
      if (ch === 'f') out.archive = rest[ri++];
      else out.dir = rest[ri++];
    } else {
      out.error = `invalid option -- '${ch}'`;
      return out;
    }
  }
  out.operands = rest.slice(ri);
  return out;
}

/** Collects the entries for one path, recursively. Names are relative, as they will be stored. */
function collectTree(v, abs, name, out) {
  const st = v.lstat(abs);
  const mtime = st.mtime.getTime();
  if (st.isSymbolicLink()) {
    ustarName(name);
    out.push({ name, type: '2', mode: st.mode, mtime, linkname: v.readlink(abs) });
  } else if (st.isDirectory()) {
    if (name) {
      ustarName(`${name}/`);
      out.push({ name: `${name}/`, type: '5', mode: st.mode, mtime });
    }
    for (const e of v.readdir(abs).sort()) collectTree(v, posix.join(abs, e), name ? `${name}/${e}` : e, out);
  } else if (st.isFile()) {
    ustarName(name);
    out.push({ name, type: '0', mode: st.mode, mtime, data: v.readFile(abs) });
  }
}

/** Puts extracted entries under dest. only: member names to take (a name also takes everything under it). */
function extractTar(v, entries, dest, io, { verbose, only }) {
  let status = 0;
  const onlySegs = only.map(safeSegments).filter(Boolean);
  const wanted = (segs) => onlySegs.length === 0
    || onlySegs.some((b) => b.length <= segs.length && b.every((s, i) => s === segs[i]));
  for (const e of entries) {
    const segs = safeSegments(e.name);
    if (!segs) { errOut(io, `tar: ${e.name}: refusing to extract a name outside the destination`); status = 2; continue; }
    if (!wanted(segs)) continue;
    const target = posix.join(dest, ...segs);
    try {
      if (e.type === '5') {
        ensureDir(v, target);
        setMode(v, target, e.mode);
      } else if (e.type === '0') {
        ensureDir(v, posix.dirname(target));
        removeIfSymlink(v, target);
        v.writeFile(target, e.data);
        setMode(v, target, e.mode);
      } else if (e.type === '2') {
        if (!linkIsSafe(e.linkname)) {
          errOut(io, `tar: ${e.name}: refusing a symbolic link to ${e.linkname}`);
          status = 2;
          continue;
        }
        ensureDir(v, posix.dirname(target));
        removeIfSymlink(v, target);
        v.symlink(e.linkname, target);
      } else {
        errOut(io, `tar: ${e.name}: unsupported entry type '${e.type}', skipped`);
        status = 2;
        continue;
      }
      if (verbose) io.stdout.write(`${e.name}\n`);
    } catch (err) {
      errOut(io, `tar: ${e.name}: ${msgOf(err)}`);
      status = 2;
    }
  }
  return status;
}

function* tarB(args, io, sh) {
  const p = parseTarArgs(args);
  if (p.error) { errOut(io, `tar: ${p.error}`); return 2; }
  if (!p.mode) { errOut(io, 'tar: You must specify one of the -c, -t, -x options'); return 2; }
  const v = sh.can.vfs;
  const toStdio = !p.archive || p.archive === '-';

  if (p.mode === 'c') {
    if (p.operands.length === 0) { errOut(io, 'tar: Cowardly refusing to create an empty archive'); return 2; }
    const entries = [];
    let status = 0;
    const base = p.dir ? resolveIn(sh, p.dir) : sh.cwd;
    for (const op of p.operands) {
      const name = op.replace(/^\/+/, '').replace(/\/+$/, '') || '.';
      if (!safeSegments(name)) { errOut(io, `tar: ${op}: refusing a name with ".."`); status = 2; continue; }
      try {
        collectTree(v, resolveIn(sh, p.dir ? posix.join(base, op) : op), name === '.' ? '' : name, entries);
      } catch (e) {
        errOut(io, `tar: ${op}: Cannot stat: ${msgOf(e)}`);
        status = 2;
      }
    }
    let data;
    try {
      data = writeTar(entries);
    } catch (e) {
      errOut(io, `tar: ${e.message}`);
      return 2;
    }
    if (p.gz) data = zlib.gzipSync(data);
    if (toStdio) io.stdout.write(data);
    else v.writeFile(resolveIn(sh, p.archive), data);
    if (p.verbose) {
      const log = toStdio ? io.stderr : io.stdout;
      for (const e of entries) log.write(`${e.name}\n`);
    }
    return status;
  }

  let raw;
  if (toStdio) {
    raw = yield readAll(io.stdin);
  } else {
    try {
      raw = v.readFile(resolveIn(sh, p.archive));
    } catch (e) {
      errOut(io, `tar: ${p.archive}: Cannot open: ${msgOf(e)}`);
      return 2;
    }
  }
  try {
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
    const entries = parseTar(raw);
    if (p.mode === 't') {
      const only = p.operands.map(safeSegments).filter(Boolean).map((s) => s.join('/'));
      for (const e of entries) {
        if (only.length && !only.some((o) => e.name.replace(/\/+$/, '') === o || e.name.startsWith(`${o}/`))) continue;
        io.stdout.write(p.verbose ? `${String(e.size).padStart(10)} ${e.name}\n` : `${e.name}\n`);
      }
      return 0;
    }
    const dest = p.dir ? resolveIn(sh, p.dir) : sh.cwd;
    ensureDir(v, dest);
    return extractTar(v, entries, dest, io, { verbose: p.verbose, only: p.operands });
  } catch (e) {
    errOut(io, `tar: ${p.archive ?? 'stdin'}: ${e.message}`);
    return 2;
  }
}

// ---------------------------------------------------------------- gzip, gunzip

function* gzipCmd(args, io, sh, asGunzip, name) {
  const { flags, rest } = splitFlags(args);
  const decompress = asGunzip || flags.has('d');
  const toStdout = flags.has('c');
  const keep = toStdout || flags.has('k');
  const force = flags.has('f');
  const v = sh.can.vfs;
  const convert = (data) => {
    if (decompress) return zlib.gunzipSync(data);
    return zlib.gzipSync(data);
  };
  const explain = (e) => (/header|format/.test(e.message) ? 'not in gzip format' : e.message);

  if (rest.length === 0) {
    const data = yield readAll(io.stdin);
    try {
      io.stdout.write(convert(data));
      return 0;
    } catch (e) {
      errOut(io, `${name}: stdin: ${explain(e)}`);
      return 1;
    }
  }
  let status = 0;
  for (const f of rest) {
    const abs = resolveIn(sh, f);
    let outPath;
    if (decompress) {
      if (!f.endsWith('.gz') && !f.endsWith('.tgz')) {
        errOut(io, `${name}: ${f}: unknown suffix -- ignored`);
        status = 2;
        continue;
      }
      outPath = f.endsWith('.tgz') ? `${f.slice(0, -4)}.tar` : f.slice(0, -3);
    } else {
      if (f.endsWith('.gz') && !force) {
        errOut(io, `${name}: ${f} already has .gz suffix -- unchanged`);
        status = 2;
        continue;
      }
      outPath = `${f}.gz`;
    }
    try {
      const result = convert(v.readFile(abs));
      if (toStdout) {
        io.stdout.write(result);
        continue;
      }
      const outAbs = resolveIn(sh, outPath);
      if (v.exists(outAbs) && !force) {
        errOut(io, `${name}: ${outPath} already exists; not overwritten`);
        status = 1;
        continue;
      }
      v.writeFile(outAbs, result);
      setMode(v, outAbs, v.stat(abs).mode);
      if (!keep) v.unlink(abs);
    } catch (e) {
      errOut(io, `${name}: ${f}: ${e.code === 'ENOENT' ? 'No such file or directory' : explain(e)}`);
      status = 1;
    }
  }
  return status;
}

// ---------------------------------------------------------------- zip, unzip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date and time (local time, as zip writes it). */
function dosDateTime(ms) {
  const d = new Date(ms);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Builds a zip file from members {name, isDir, mode, mtime, data}. Each file is deflated when that is smaller. */
function buildZip(members) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const m of members) {
    const nameBuf = Buffer.from(m.name, 'utf8');
    const data = m.isDir ? Buffer.alloc(0) : m.data;
    const crc = crc32(data);
    let method = 0;
    let body = data;
    if (!m.isDir && data.length > 0) {
      const deflated = zlib.deflateRawSync(data);
      if (deflated.length < data.length) { method = 8; body = deflated; }
    }
    const { time, date } = dosDateTime(m.mtime);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // names are UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4); // made by Unix, version 3.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(((m.isDir ? 0o040000 : 0o100000) | ((m.mode ?? 0o644) & 0o7777)) * 65536 + (m.isDir ? 0x10 : 0) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Reads the members of a zip file, checking each one's CRC. Throws on a damaged or unsupported file. */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported compression method ${method} for ${name}`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`bad checksum for ${name}`);
    out.push({ name, data, mode: (extAttr >>> 16) & 0o7777 });
  }
  return out;
}

function* zipB(args, io, sh) {
  const { flags, rest } = splitFlags(args);
  if (rest.length < 2) { errOut(io, 'zip: usage: zip [-r] [-q] archive.zip file ...'); return 2; }
  const v = sh.can.vfs;
  const [archive, ...inputs] = rest;
  const recurse = flags.has('r');
  const members = [];
  let status = 0;
  const add = (abs, name) => {
    const st = v.stat(abs);
    const mtime = st.mtime.getTime();
    if (st.isDirectory()) {
      if (!recurse) {
        errOut(io, `zip: ${name || '.'} is a directory (use -r)`);
        status = 12;
        return;
      }
      if (name) members.push({ name: `${name}/`, isDir: true, mode: st.mode, mtime });
      for (const e of v.readdir(abs).sort()) add(posix.join(abs, e), name ? `${name}/${e}` : e);
    } else if (st.isFile()) {
      members.push({ name, isDir: false, mode: st.mode, mtime, data: v.readFile(abs) });
      if (!flags.has('q')) io.stdout.write(`  adding: ${name}\n`);
    }
  };
  for (const op of inputs) {
    const segs = safeSegments(op);
    if (!segs) { errOut(io, `zip: ${op}: refusing a name with ".."`); status = 12; continue; }
    try {
      add(resolveIn(sh, op), segs.join('/'));
    } catch (e) {
      errOut(io, `zip: ${op}: ${msgOf(e)}`);
      status = 12;
    }
  }
  v.writeFile(resolveIn(sh, archive), buildZip(members));
  return status;
}

function* unzipB(args, io, sh) {
  const flagSet = new Set();
  const operands = [];
  let dir = null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-d') dir = args[++k] ?? null;
    else if (a.startsWith('-') && a.length > 1) for (const ch of a.slice(1)) flagSet.add(ch);
    else operands.push(a);
  }
  if (operands.length === 0) { errOut(io, 'unzip: usage: unzip [-l] [-o] [-q] [-d dir] archive.zip [file ...]'); return 2; }
  const [archive, ...only] = operands;
  const v = sh.can.vfs;
  let entries;
  try {
    entries = readZip(v.readFile(resolveIn(sh, archive)));
  } catch (e) {
    errOut(io, `unzip: ${archive}: ${msgOf(e)}`);
    return 9;
  }
  if (flagSet.has('l')) {
    io.stdout.write('  Length      Name\n');
    for (const e of entries) io.stdout.write(`${String(e.data.length).padStart(8)}  ${e.name}\n`);
    return 0;
  }
  const onlySegs = only.map(safeSegments).filter(Boolean);
  const wanted = (segs) => onlySegs.length === 0
    || onlySegs.some((b) => b.length <= segs.length && b.every((s, i) => s === segs[i]));
  const dest = dir ? resolveIn(sh, dir) : sh.cwd;
  ensureDir(v, dest);
  let status = 0;
  for (const e of entries) {
    const segs = safeSegments(e.name);
    if (!segs) { errOut(io, `unzip: ${e.name}: refusing a name outside the destination`); status = 1; continue; }
    if (!wanted(segs)) continue;
    const target = posix.join(dest, ...segs);
    try {
      if (e.name.endsWith('/')) {
        ensureDir(v, target);
        continue;
      }
      if (v.exists(target) && !flagSet.has('o')) {
        errOut(io, `unzip: ${e.name} already exists; not overwritten (use -o)`);
        status = 1;
        continue;
      }
      ensureDir(v, posix.dirname(target));
      removeIfSymlink(v, target);
      v.writeFile(target, e.data);
      setMode(v, target, e.mode);
      if (!flagSet.has('q')) io.stdout.write(`  inflating: ${e.name}\n`);
    } catch (err) {
      errOut(io, `unzip: ${e.name}: ${msgOf(err)}`);
      status = 1;
    }
  }
  return status;
}

export const ARCHIVE_BUILTINS = {
  tar: tarB,
  gzip: function* gzipB(args, io, sh) { return yield* gzipCmd(args, io, sh, false, 'gzip'); },
  gunzip: function* gunzipB(args, io, sh) { return yield* gzipCmd(args, io, sh, true, 'gunzip'); },
  zip: zipB,
  unzip: unzipB,
};
