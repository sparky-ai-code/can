// Byte inputs and outputs for the can shell. Pipes and redirects are in-memory (SyncInput / Collector /
// FileSink), so a foreground pipeline runs its stages in order. Only live streams (a process's own stdin
// and stdout) need the event loop. readAll and readLine return a plain value for in-memory inputs and a
// promise for live streams; the shell drivers accept both (see shell.js).
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

/** An in-memory input with a read position. */
export class SyncInput {
  constructor(buf) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.pos = 0;
  }
}

/** An in-memory output: collects every write. */
export class Collector {
  constructor() { this.chunks = []; }

  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  }

  end() {}

  buffer() { return Buffer.concat(this.chunks); }
}

/** /dev/null as an output: writes are discarded. */
export const NULL_SINK = { write() { return true; }, end() {} };

/** An output that appends each write to a VFS file. */
export class FileSink {
  constructor(vfs, abs) {
    this.vfs = vfs;
    this.abs = abs;
  }

  write(chunk) {
    this.vfs.appendFile(this.abs, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  }

  end() {}
}

async function readStreamAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Rest of an input as one Buffer (in-memory input: a Buffer; live stream: a promise). */
export function readAll(src) {
  if (!src) return Buffer.alloc(0);
  if (src instanceof SyncInput) {
    const rest = src.buf.subarray(src.pos);
    src.pos = src.buf.length;
    return rest;
  }
  return readStreamAll(src);
}

const lineReaders = new WeakMap();

async function readStreamLine(stream) {
  let r = lineReaders.get(stream);
  if (!r) {
    r = { it: stream[Symbol.asyncIterator](), buf: Buffer.alloc(0), done: false };
    lineReaders.set(stream, r);
  }
  for (;;) {
    const nl = r.buf.indexOf(0x0a);
    if (nl >= 0) {
      const line = r.buf.subarray(0, nl).toString('utf8');
      r.buf = r.buf.subarray(nl + 1);
      return line;
    }
    if (r.done) {
      if (r.buf.length === 0) return null;
      const line = r.buf.toString('utf8');
      r.buf = Buffer.alloc(0);
      return line;
    }
    const next = await r.it.next();
    if (next.done) r.done = true;
    else r.buf = Buffer.concat([r.buf, Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)]);
  }
}

/** Next line without its newline, or null at end of input. Same plain-or-promise rule as readAll. */
export function readLine(src) {
  if (!src) return null;
  if (src instanceof SyncInput) {
    if (src.pos >= src.buf.length) return null;
    const nl = src.buf.indexOf(0x0a, src.pos);
    const stop = nl < 0 ? src.buf.length : nl;
    const line = src.buf.subarray(src.pos, stop).toString('utf8');
    src.pos = nl < 0 ? src.buf.length : nl + 1;
    return line;
  }
  return readStreamLine(src);
}

/** A Readable over the rest of an in-memory input (for JS programs that read process.stdin). */
export function asReadable(src) {
  if (src instanceof SyncInput) {
    const rest = readAll(src);
    return Readable.from([rest]);
  }
  return src ?? Readable.from([]);
}
