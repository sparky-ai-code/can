// Frames between the host and `canit`, the agent inside a canos guest (distro/canit/canit.c). Both sides must agree
// byte for byte, so the C file and this one are tested against each other (test/guest-protocol.test.js).
//
//   frame   = u32le length | u8 type | u32le id | payload        length counts type, id and payload
//   replies = request type | 0x80, same id. ERROR (0xff) answers any request that failed.
//
//   HELLO  0x01  host asks who is there. The agent never speaks first: a host that is not connected yet would miss it.
//          reply 0x81: "canit <version>\0<arch>\0"
//   PING   0x02  payload is echoed back in PONG (0x82)
//   EXEC   0x10  payload: u32le timeoutMs (0 = none) | cwd\0 | argv0\0 argv1\0 ...    cwd "" = the agent's default
//          reply 0x90: i32le exitCode (128 + n for signal n) | u8 timedOut | u32le outLen | u32le errLen | out | err
//   POWEROFF 0x20  the agent syncs, replies 0xa0, then powers the machine off
//   WRITE  0x30  payload: u32le mode | path\0 | data. Creates or replaces the file (its folder must exist). reply 0xb0, empty
//   READ   0x31  payload: path\0. reply 0xb1 carries the file's bytes. A folder or a file over one frame is an error
//   SPAWN 0x40  payload: cwd\0 argv0\0 ...  reply 0xc0: u32le program id. The program runs in the background.
//   LOGS 0x41   payload: u32le id | u8 stream (1 out, 2 err)  reply 0xc1: the kept output (last 256 KB)
//   STATUS 0x42 payload: u32le id  reply 0xc2: u8 running | i32le exit code
//   KILL 0x43   payload: u32le id | i32le signal  reply 0xc3, empty
//   PS 0x44     reply 0xc4: u32le count, then per program u32le id | u8 running | i32le code | u32le len | command
//   STDIN 0x45  payload: u32le id | data  reply 0xc5, empty
//   END_STDIN 0x46  payload: u32le id  reply 0xc6, empty
//   ERROR  0xff  payload: message text
//
// Limits: a frame is at most MAX_FRAME bytes; captured output per stream is capped by the agent (OUTPUT_CAP).
export const T = Object.freeze({
  HELLO: 0x01,
  PING: 0x02,
  EXEC: 0x10,
  POWEROFF: 0x20,
  WRITE: 0x30,
  READ: 0x31,
  SPAWN: 0x40,
  LOGS: 0x41,
  STATUS: 0x42,
  KILL: 0x43,
  PS: 0x44,
  STDIN: 0x45,
  END_STDIN: 0x46,
  REPLY: 0x80,
  ERROR: 0xff,
});

export const MAX_FRAME = 16 * 1024 * 1024;
export const OUTPUT_CAP = 1024 * 1024;
const HEADER = 5; // type + id

function protoError(message) {
  const err = new Error(`EPROTO: ${message}. Next: restart the can with can_restart.`);
  err.code = 'EPROTO';
  return err;
}

/** One frame as a Buffer. */
export function encodeFrame(type, id, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = HEADER + body.length;
  if (length > MAX_FRAME) throw protoError(`frame of ${length} bytes is over the ${MAX_FRAME} byte limit`);
  const out = Buffer.alloc(4 + length);
  out.writeUInt32LE(length, 0);
  out.writeUInt8(type, 4);
  out.writeUInt32LE(id >>> 0, 5);
  body.copy(out, 9);
  return out;
}

/** Splits a byte stream into frames. push() returns the frames completed by that chunk. */
export class FrameDecoder {
  #buf = Buffer.alloc(0);

  push(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : Buffer.from(chunk);
    const frames = [];
    for (;;) {
      if (this.#buf.length < 4) break;
      const length = this.#buf.readUInt32LE(0);
      if (length < HEADER || length > MAX_FRAME) throw protoError(`bad frame length ${length}`);
      if (this.#buf.length < 4 + length) break;
      frames.push({
        type: this.#buf.readUInt8(4),
        id: this.#buf.readUInt32LE(5),
        payload: Buffer.from(this.#buf.subarray(9, 4 + length)),
      });
      this.#buf = this.#buf.subarray(4 + length);
    }
    return frames;
  }
}

function cstr(value, what) {
  const text = String(value);
  if (text.includes('\0')) throw protoError(`${what} contains a NUL byte`);
  return Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
}

/** Payload of an EXEC request. argv is the full argument vector, for example ['/bin/sh', '-c', 'echo hi']. */
export function encodeExec({ cwd = '', argv, timeoutMs = 0 }) {
  if (!Array.isArray(argv) || argv.length === 0) throw protoError('exec needs a non-empty argv');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 0xffffffff) throw protoError('timeoutMs must be a whole number of ms');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(timeoutMs, 0);
  return Buffer.concat([head, cstr(cwd, 'cwd'), ...argv.map((a, i) => cstr(a, `argv[${i}]`))]);
}

/** A WRITE request: creates or replaces the file at path with data. mode is the file's permission bits. */
export function encodeWrite({ path, data, mode = 0o644 }) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(mode & 0o7777, 0);
  return Buffer.concat([head, cstr(path, 'path'), Buffer.from(data)]);
}

/** A READ request: the payload is the path. The reply payload is the file's bytes. */
export function encodeRead(path) {
  return cstr(path, 'path');
}

/** A SPAWN request: starts a background program. The reply payload is its u32le id. */
export function encodeSpawn({ cwd = '', argv }) {
  if (!Array.isArray(argv) || argv.length === 0) throw protoError('spawn needs argv, a non-empty list');
  return Buffer.concat([cstr(cwd, 'cwd'), ...argv.map((a, i) => cstr(a, `argv[${i}]`))]);
}

/** A request that names a background program: u32le id, then whatever the request adds (see encodeLogs and so on). */
export function encodeProgram(id, extra = Buffer.alloc(0)) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(id >>> 0, 0);
  return Buffer.concat([head, Buffer.from(extra)]);
}

/** A LOGS request payload: the program id and the stream, 1 for stdout or 2 for stderr. */
export function encodeLogs(id, stream) {
  return encodeProgram(id, Buffer.from([stream]));
}

/** A KILL request payload: the program id and a signal number. */
export function encodeKill(id, signal) {
  const sig = Buffer.alloc(4);
  sig.writeInt32LE(signal, 0);
  return encodeProgram(id, sig);
}

/** Reads a STATUS reply: whether the program is running, and its exit code (0 while it runs). */
export function decodeStatus(payload) {
  if (payload.length !== 5) throw protoError('status reply is not 5 bytes');
  return { running: payload.readUInt8(0) === 1, exitCode: payload.readInt32LE(1) };
}

/** Reads a PS reply: every program the agent knows, its state and its command. */
export function decodePs(payload) {
  if (payload.length < 4) throw protoError('ps reply is too short');
  const count = payload.readUInt32LE(0);
  const programs = [];
  let at = 4;
  for (let i = 0; i < count; i++) {
    if (at + 13 > payload.length) throw protoError('ps reply is cut short');
    const id = payload.readUInt32LE(at);
    const running = payload.readUInt8(at + 4) === 1;
    const exitCode = payload.readInt32LE(at + 5);
    const len = payload.readUInt32LE(at + 9);
    at += 13;
    if (at + len > payload.length) throw protoError('ps reply is cut short');
    programs.push({ id, running, exitCode, command: payload.subarray(at, at + len).toString('utf8') });
    at += len;
  }
  return programs;
}

/** Reads an EXEC reply payload. */
export function decodeExecResult(payload) {
  if (payload.length < 13) throw protoError('exec reply is too short');
  const exitCode = payload.readInt32LE(0);
  const timedOut = payload.readUInt8(4) === 1;
  const outLen = payload.readUInt32LE(5);
  const errLen = payload.readUInt32LE(9);
  if (13 + outLen + errLen !== payload.length) throw protoError('exec reply lengths do not add up');
  return {
    exitCode,
    timedOut,
    stdout: payload.subarray(13, 13 + outLen).toString('utf8'),
    stderr: payload.subarray(13 + outLen).toString('utf8'),
  };
}

/** Reads the HELLO payload: version and architecture the agent reports. */
export function decodeHello(payload) {
  const parts = payload.toString('utf8').split('\0');
  const m = /^canit (.+)$/.exec(parts[0] ?? '');
  if (!m) throw protoError('first frame is not a canit hello');
  return { version: m[1], arch: parts[1] ?? '' };
}
