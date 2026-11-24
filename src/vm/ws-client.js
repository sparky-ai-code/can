// A WebSocket client (RFC 6455) over a raw stream to a server inside a VM can: the duplex VmCan.connect returns. Used
// for the browser's DevTools endpoint (src/vm/vm-chromium.js). It writes the handshake and the frames itself, and offers
// the same surface HostBrowser uses on a browser WebSocket: readyState, send, close, onmessage, onclose.
import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const MAX_FRAME = 512 * 1024 * 1024;
const MAX_HEAD = 64 * 1024;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function invalid(message) {
  const err = new Error(`EPROTO: ${message}`);
  err.code = 'EPROTO';
  return err;
}

/** One frame from a client: always masked, as RFC 6455 requires. */
export function encodeClientFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Reads one frame from the start of buf. Returns {fin, opcode, payload, size} (size is the bytes the frame used), or null
 * when buf does not hold a whole frame yet. Server frames are not masked; a masked one is still read correctly.
 */
export function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_FRAME)) throw invalid(`a frame of ${big} bytes is too large`);
    len = Number(big);
    off = 10;
  }
  let key = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    key = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (key) for (let i = 0; i < len; i++) payload[i] ^= key[i & 3];
  return {
    fin, opcode, payload, size: off + len,
  };
}

class GuestWebSocket {
  #stream;
  #buf = Buffer.alloc(0);
  #parts = [];
  #partOp = null;
  #queue = []; // messages that arrived before onmessage was set
  #onmessage = null;

  constructor(stream) {
    this.#stream = stream;
    this.readyState = OPEN;
    this.onclose = null;
  }

  get onmessage() { return this.#onmessage; }

  set onmessage(fn) {
    this.#onmessage = fn;
    if (fn) for (const data of this.#queue.splice(0)) fn({ data });
  }

  /** Sends one text message. */
  send(text) {
    if (this.readyState !== OPEN) throw new Error('WebSocket is not open');
    this.#stream.write(encodeClientFrame(OP_TEXT, Buffer.from(String(text), 'utf8')));
  }

  /** Sends a close frame and ends the stream. Safe to call more than once. */
  close() {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    try { this.#stream.write(encodeClientFrame(OP_CLOSE, Buffer.alloc(0))); } catch { /* the stream may be gone */ }
    this.#stream.end();
  }

  /** Feeds bytes that arrived after the handshake. Emits each complete message. */
  ingest(chunk) {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const f = decodeFrame(this.#buf);
      if (!f) break;
      this.#buf = this.#buf.subarray(f.size);
      if (f.opcode === OP_PING) {
        this.#stream.write(encodeClientFrame(OP_PONG, f.payload));
      } else if (f.opcode === OP_PONG) {
        // unsolicited pongs are allowed and ignored
      } else if (f.opcode === OP_CLOSE) {
        this.close();
        this.#finish();
        return;
      } else if (f.opcode === OP_TEXT || f.opcode === OP_BINARY || f.opcode === OP_CONT) {
        if (f.opcode !== OP_CONT) {
          this.#parts = [];
          this.#partOp = f.opcode;
        }
        this.#parts.push(f.payload);
        if (f.fin) {
          const whole = Buffer.concat(this.#parts);
          this.#parts = [];
          const data = this.#partOp === OP_TEXT ? whole.toString('utf8') : whole;
          if (this.#onmessage) this.#onmessage({ data });
          else this.#queue.push(data);
        }
      } else {
        throw invalid(`unknown frame type ${f.opcode}`);
      }
    }
  }

  /** Marks the socket closed and tells the owner. */
  finish() {
    this.#finish();
  }

  #finish() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onclose?.({ code: 1006 });
  }
}

/**
 * Performs the client handshake over the stream and resolves to the open socket. `host` is the Host header and `path` the
 * request target, for example '127.0.0.1:9222' and '/devtools/browser/<id>'. Rejects if the server does not switch
 * protocols or does not prove it read the key.
 */
export function openGuestWebSocket(stream, { host, path = '/' }) {
  const key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(key + GUID).digest('base64');
  stream.write(Buffer.from([
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '', '',
  ].join('\r\n'), 'latin1'));

  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0);
    let ws = null;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      stream.removeListener('data', onData);
      stream.destroy();
      reject(err);
    };
    const onData = (chunk) => {
      if (ws) {
        try { ws.ingest(chunk); } catch (err) { ws.close(); ws.finish(); ws.onerror?.(err); }
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > MAX_HEAD) fail(invalid('the handshake reply is too large'));
        return;
      }
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      const status = /^HTTP\/1\.1 (\d{3})/.exec(lines[0]);
      const headers = Object.fromEntries(lines.slice(1).map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
      }));
      if (!status || status[1] !== '101') {
        fail(invalid(`the server answered ${lines[0]} instead of switching protocols`));
        return;
      }
      if (headers['sec-websocket-accept'] !== expected) {
        fail(invalid('the server did not prove it read the WebSocket key'));
        return;
      }
      ws = new GuestWebSocket(stream);
      settled = true;
      stream.removeListener('data', onData);
      stream.on('data', (more) => {
        try { ws.ingest(more); } catch { ws.close(); ws.finish(); }
      });
      stream.on('close', () => ws.finish());
      stream.on('end', () => ws.finish());
      stream.on('error', () => ws.finish());
      resolve(ws);
      const rest = head.subarray(end + 4);
      if (rest.length > 0) ws.ingest(rest);
    };
    stream.on('data', onData);
    stream.on('error', (err) => fail(err));
    stream.on('close', () => fail(invalid('the connection closed before the handshake finished')));
  });
}
