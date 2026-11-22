// Memory limits for WebAssembly modules, enforced before the module is compiled.
//
// A wasm module either imports its memory or defines one. Both carry limits {min, max}. This file reads the
// import and memory sections of the module bytes and, when a defined memory has no maximum or a larger one than
// the can allows, rewrites that memory's limits to the allowed maximum. Every other byte of the module is copied
// unchanged. Only the wasm binary format is handled: function bodies are skipped, not parsed.

import { KernelError } from '../../kernel/errors.js';

export const WASM_PAGE = 65536;
const MAGIC = [0x00, 0x61, 0x73, 0x6d];
const VERSION = [0x01, 0x00, 0x00, 0x00];
const SECTION_IMPORT = 2;
const SECTION_MEMORY = 5;

const LIMIT_HAS_MAX = 0x01;
const LIMIT_SHARED = 0x02;
const LIMIT_MEMORY64 = 0x04;

const bad = (what) => new KernelError('EINVAL', `EINVAL: the WebAssembly module is malformed (${what}). Next: check the file is a valid .wasm build for wasm32-wasip1.`);
const unsupported = (what) => new KernelError('ENOTSUP', `ENOTSUP: the WebAssembly module uses ${what}, which the runtime does not support. Next: use a wasm32-wasip1 build.`);

/** Pages for a byte count, rounded down. The limit is always a whole number of 64 KiB pages. */
export function pagesFor(bytes) {
  if (!Number.isFinite(bytes) || bytes < WASM_PAGE) throw new KernelError('EINVAL', `EINVAL: memory limit ${bytes} is too small. Next: give a limit of at least 64 KiB.`);
  return Math.floor(bytes / WASM_PAGE);
}

class Reader {
  constructor(bytes, offset = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = offset;
    this.end = end;
  }
  eof() { return this.pos >= this.end; }
  byte() {
    if (this.pos >= this.end) throw bad('unexpected end');
    return this.bytes[this.pos++];
  }
  /** Unsigned LEB128, at most 5 bytes for u32 (the wasm limit). */
  u32() {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) {
        if (result > 0xffffffff) throw bad('integer too large');
        return result;
      }
      shift += 7;
    }
    throw bad('integer too long');
  }
  skip(n) {
    if (this.pos + n > this.end) throw bad('unexpected end');
    this.pos += n;
  }
  name() {
    const len = this.u32();
    const start = this.pos;
    this.skip(len);
    return Buffer.from(this.bytes.subarray(start, start + len)).toString('utf8');
  }
  /** Reads limits; returns {flags, min, max, start, end} where start/end bound the encoded bytes. */
  limits() {
    const start = this.pos;
    const flags = this.byte();
    if (flags & LIMIT_MEMORY64) throw unsupported('64-bit memory');
    if (flags & ~(LIMIT_HAS_MAX | LIMIT_SHARED)) throw bad('unknown limits flags');
    const min = this.u32();
    const max = flags & LIMIT_HAS_MAX ? this.u32() : undefined;
    return { flags, min, max, start, end: this.pos };
  }
}

function checkHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) throw bad('too short');
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw bad('bad magic number');
  for (let i = 0; i < 4; i++) if (bytes[4 + i] !== VERSION[i]) throw bad('unsupported version');
}

/** Splits the module into sections: [{id, start, end, payloadStart, payloadEnd}]. */
export function sections(bytes) {
  checkHeader(bytes);
  const out = [];
  const r = new Reader(bytes, 8);
  while (!r.eof()) {
    const start = r.pos;
    const id = r.byte();
    const size = r.u32();
    const payloadStart = r.pos;
    r.skip(size);
    out.push({ id, start, end: r.pos, payloadStart, payloadEnd: r.pos });
  }
  return out;
}

/** Reads one table type (inside an import or a table section) and returns nothing; only skips it correctly. */
function skipTableType(r) {
  if (r.bytes[r.pos] === 0x40) { // typed table with an init expression: 0x40 0x00 <tabletype>
    r.skip(2);
  }
  r.byte(); // reference type
  r.limits();
}

/**
 * Reads the module's imports and memory definitions.
 * Returns { imports: [{module, name, kind, min?, max?}], memoryImports: [{module, name, min, max}],
 *           memories: [{index, flags, min, max, shared}] } where memories are the defined ones.
 */
export function readMemoryLayout(bytes) {
  const imports = [];
  const memoryImports = [];
  const memories = [];
  for (const s of sections(bytes)) {
    if (s.id === SECTION_IMPORT) {
      const r = new Reader(bytes, s.payloadStart, s.payloadEnd);
      const count = r.u32();
      for (let i = 0; i < count; i++) {
        const module = r.name();
        const name = r.name();
        const kind = r.byte();
        if (kind === 0x00) { r.u32(); imports.push({ module, name, kind: 'func' }); }
        else if (kind === 0x01) { skipTableType(r); imports.push({ module, name, kind: 'table' }); }
        else if (kind === 0x02) {
          const lim = r.limits();
          const entry = { module, name, kind: 'memory', min: lim.min, max: lim.max, shared: !!(lim.flags & LIMIT_SHARED) };
          imports.push(entry);
          memoryImports.push(entry);
        } else if (kind === 0x03) { r.byte(); r.byte(); imports.push({ module, name, kind: 'global' }); }
        else if (kind === 0x04) { r.byte(); r.u32(); imports.push({ module, name, kind: 'tag' }); }
        else throw bad(`unknown import kind ${kind}`);
      }
    } else if (s.id === SECTION_MEMORY) {
      const r = new Reader(bytes, s.payloadStart, s.payloadEnd);
      const count = r.u32();
      for (let i = 0; i < count; i++) {
        const lim = r.limits();
        memories.push({ index: i, flags: lim.flags, min: lim.min, max: lim.max, shared: !!(lim.flags & LIMIT_SHARED), start: lim.start, end: lim.end });
      }
    }
  }
  return { imports, memoryImports, memories };
}

function encodeU32(n) {
  const out = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

/**
 * Applies a memory limit to a module before it is compiled.
 *
 * - A defined memory with no maximum, or one above the limit, gets maximum = limit (in pages). The module bytes are
 *   rewritten: only the memory section changes, its size is rewritten to match, and all other sections are copied.
 * - A memory with a maximum at or below the limit is left as it is.
 * - An imported memory is not rewritten. The caller supplies the memory and uses `importMaxPages`.
 * - A module whose initial memory is already above the limit throws ENOMEM (the run reports exit 137).
 *
 * Returns { bytes, rewritten, limitPages, importMaxPages } where importMaxPages is the maximum the caller must
 * give an imported memory (or undefined when the module imports no memory).
 */
export function applyMemoryLimit(bytes, limitBytes) {
  const limitPages = pagesFor(limitBytes);
  const layout = readMemoryLayout(bytes);
  if (layout.memoryImports.length > 0) {
    const imp = layout.memoryImports[0];
    if (imp.min > limitPages) {
      throw new KernelError('ENOMEM', `ENOMEM: the module needs ${imp.min} wasm pages up front, above the ${limitPages}-page limit. Next: raise the can memory limit or use a smaller build.`);
    }
    const importMaxPages = imp.max === undefined ? limitPages : Math.min(imp.max, limitPages);
    return { bytes, rewritten: false, limitPages, importMaxPages };
  }
  if (layout.memories.length === 0) return { bytes, rewritten: false, limitPages, importMaxPages: undefined };

  let changed = false;
  const parts = [];
  for (const mem of layout.memories) {
    if (mem.min > limitPages) {
      throw new KernelError('ENOMEM', `ENOMEM: the module needs ${mem.min} wasm pages up front, above the ${limitPages}-page limit. Next: raise the can memory limit or use a smaller build.`);
    }
    if (mem.max !== undefined && mem.max <= limitPages) {
      parts.push(...bytes.subarray(mem.start, mem.end));
      continue;
    }
    changed = true;
    parts.push((mem.flags & LIMIT_SHARED) | LIMIT_HAS_MAX, ...encodeU32(mem.min), ...encodeU32(limitPages));
  }
  if (!changed) return { bytes, rewritten: false, limitPages, importMaxPages: undefined };

  // Rebuild the memory section: count, then the memories (kept or rewritten), with a new size prefix.
  const memSection = sections(bytes).find((s) => s.id === SECTION_MEMORY);
  const countBytes = encodeU32(layout.memories.length);
  const payload = [...countBytes, ...parts];
  const header = [SECTION_MEMORY, ...encodeU32(payload.length)];
  const out = new Uint8Array(memSection.start + header.length + payload.length + (bytes.length - memSection.end));
  out.set(bytes.subarray(0, memSection.start), 0);
  out.set(header, memSection.start);
  out.set(payload, memSection.start + header.length);
  out.set(bytes.subarray(memSection.end), memSection.start + header.length + payload.length);
  return { bytes: out, rewritten: true, limitPages, importMaxPages: undefined };
}
