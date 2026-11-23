// WebSocket for pages in a can (RFC 6455, client side). A page can open ws:// connections to the can's own virtual
// hosts only. The connection is a raw vnet connection (VNet.connect), so it reaches a listener on the same routing
// as page HTTP. wss:// and any other host fail the way a browser fails a connection that cannot be made: an error
// event, then close with code 1006. Binary messages are always delivered as ArrayBuffer. No extensions (such as
// permessage-deflate) are negotiated.
import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { virtualPort } from './net.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HANDSHAKE_BYTES = 64 * 1024;
const CLOSE_TIMEOUT_MS = 5000;
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** A client frame: FIN set, masked as RFC 6455 requires of clients, with a 7, 16 or 64-bit length. */
export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

/**
 * Reads one server frame from the front of buf. Returns null while the frame is incomplete, else
 * {fin, rsv, opcode, masked, payload, size}. payload is a view into buf.
 */
export function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const rsv = buf[0] & 0x70;
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
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('frame length exceeds the safe integer range');
    len = Number(big);
    off = 10;
  }
  if (buf.length < off + len) return null;
  return { fin, rsv, opcode, masked, payload: buf.subarray(off, off + len), size: off + len };
}

/**
 * Returns the WebSocket class for one page. `host` is the page's ScriptHost: its browser supplies the can (whose vnet
 * carries the connection), the console and the origin, and its timers run the deferred failures.
 */
export function createWebSocketClass(host) {
  let makeBuffer; // the page realm's ArrayBuffer constructor (see _pageBuffer), found on first use
  const log = (text) => { host.browser?._log?.('error', text); };
  const safeOrigin = () => {
    try {
      return host.browser._currentOrigin();
    } catch {
      return null;
    }
  };
  const safely = (fn, ws, ev) => {
    try {
      fn.call(ws, ev);
    } catch (e) {
      log(`Uncaught ${e?.message ?? e}`);
    }
  };

  class WebSocket {
    constructor(url, protocols = []) {
      const u = parseUrl(url);
      this.url = u.href;
      this.readyState = WebSocket.CONNECTING;
      this.protocol = '';
      this.extensions = '';
      this.bufferedAmount = 0;
      this.binaryType = 'blob'; // binary messages are always ArrayBuffer (see the module comment)
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this._listeners = new Map();
      this._sock = null;
      this._buf = Buffer.alloc(0);
      this._handshake = true;
      this._key = randomBytes(16).toString('base64');
      this._protocols = [].concat(protocols).map(String);
      this._frag = null;
      this._closeSent = false;
      this._origin = u.origin;
      this._closeTimer = null;
      this._start(u);
    }

    _start(u) {
      if (u.protocol === 'wss:') {
        this._deferFail('wss:// is not supported in a can (only ws:// to the can\'s own virtual hosts)');
        return;
      }
      const can = host.browser?.can;
      const port = can ? virtualPort(u, can) : null;
      if (port === null) {
        this._deferFail(`${u.hostname} is not a virtual host of this can (only ws:// to the can's own hosts is supported)`);
        return;
      }
      let sock;
      try {
        sock = can.vnet.connect(port);
      } catch (e) {
        this._deferFail(String(e?.message ?? e));
        return;
      }
      this._sock = sock;
      sock.on('data', (chunk) => this._onData(chunk));
      sock.on('error', (err) => this._fail(String(err?.message ?? err)));
      sock.on('end', () => this._lost());
      sock.on('close', () => this._lost());
      const origin = safeOrigin();
      const lines = [
        `GET ${u.pathname}${u.search} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${this._key}`,
        'Sec-WebSocket-Version: 13',
      ];
      if (origin) lines.push(`Origin: ${origin}`);
      if (this._protocols.length) lines.push(`Sec-WebSocket-Protocol: ${this._protocols.join(', ')}`);
      sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    }

    _deferFail(reason) {
      host._timer(() => this._fail(reason), 0, [], false);
    }

    // ---- events

    addEventListener(type, fn, options) {
      if (typeof fn !== 'function') return;
      const list = this._listeners.get(String(type)) ?? [];
      if (!list.some((l) => l.fn === fn)) list.push({ fn, once: !!(options && typeof options === 'object' && options.once) });
      this._listeners.set(String(type), list);
    }

    removeEventListener(type, fn) {
      const list = this._listeners.get(String(type));
      if (!list) return;
      this._listeners.set(String(type), list.filter((l) => l.fn !== fn));
    }

    _dispatch(type, ev) {
      const event = { ...ev, type, target: this };
      const on = this[`on${type}`];
      if (typeof on === 'function') safely(on, this, event);
      for (const l of [...(this._listeners.get(type) ?? [])]) {
        if (l.once) this.removeEventListener(type, l.fn);
        safely(l.fn, this, event);
      }
    }

    // ---- wire

    _onData(chunk) {
      if (this.readyState === WebSocket.CLOSED) return;
      this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
      if (this._handshake) {
        const at = this._buf.indexOf('\r\n\r\n');
        if (at < 0) {
          if (this._buf.length > MAX_HANDSHAKE_BYTES) this._fail('the handshake response is too large');
          return;
        }
        const head = this._buf.subarray(0, at).toString('latin1');
        this._buf = Buffer.from(this._buf.subarray(at + 4));
        this._handshake = false;
        if (!this._checkHandshake(head)) return;
        this.readyState = WebSocket.OPEN;
        this._dispatch('open', {});
      }
      while (this.readyState === WebSocket.OPEN || this.readyState === WebSocket.CLOSING) {
        let frame;
        try {
          frame = decodeFrame(this._buf);
        } catch (e) {
          this._fail(String(e?.message ?? e), 1009);
          return;
        }
        if (!frame) return;
        this._buf = this._buf.subarray(frame.size);
        this._onFrame(frame);
      }
    }

    /** Checks the server's 101 answer. Returns false (and fails the connection) when it is not a valid answer. */
    _checkHandshake(head) {
      const lines = head.split('\r\n');
      const status = /^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? '');
      if (!status || status[1] !== '101') {
        this._fail(`the server answered "${lines[0] ?? ''}" instead of 101 Switching Protocols`);
        return false;
      }
      const h = new Map();
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':');
        if (i > 0) h.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
      }
      const connection = (h.get('connection') ?? '').toLowerCase().split(',').map((t) => t.trim());
      if ((h.get('upgrade') ?? '').toLowerCase() !== 'websocket' || !connection.includes('upgrade')) {
        this._fail('the handshake answer lacks Upgrade: websocket and Connection: Upgrade', 1002);
        return false;
      }
      const expected = createHash('sha1').update(this._key + GUID).digest('base64');
      if (h.get('sec-websocket-accept') !== expected) {
        this._fail('Sec-WebSocket-Accept does not match the key that was sent', 1002);
        return false;
      }
      if (h.has('sec-websocket-extensions')) {
        this._fail('the server negotiated an extension, and none is supported in a can', 1002);
        return false;
      }
      const protocol = h.get('sec-websocket-protocol');
      if (protocol !== undefined) {
        if (!this._protocols.includes(protocol)) {
          this._fail(`the server chose protocol "${protocol}", which was not requested`, 1002);
          return false;
        }
        this.protocol = protocol;
      }
      return true;
    }

    _onFrame(f) {
      if (f.masked) return this._fail('the server sent a masked frame', 1002);
      if (f.rsv) return this._fail('a reserved bit is set (no extensions are negotiated)', 1002);
      if (f.opcode >= 0x8) {
        if (!f.fin || f.payload.length > 125) return this._fail('a control frame is fragmented or too long', 1002);
        if (f.opcode === OP_CLOSE) return this._onClose(f.payload);
        if (f.opcode === OP_PING) {
          if (this.readyState === WebSocket.OPEN) this._write(encodeFrame(OP_PONG, f.payload));
          return undefined;
        }
        if (f.opcode === OP_PONG) return undefined;
        return this._fail(`unknown opcode ${f.opcode}`, 1002);
      }
      if (f.opcode === OP_CONT) {
        if (!this._frag) return this._fail('a continuation frame arrived with no message open', 1002);
      } else if (f.opcode === OP_TEXT || f.opcode === OP_BINARY) {
        if (this._frag) return this._fail('a new message started before the last one finished', 1002);
        this._frag = { opcode: f.opcode, parts: [] };
      } else {
        return this._fail(`unknown opcode ${f.opcode}`, 1002);
      }
      this._frag.parts.push(f.payload);
      if (!f.fin) return undefined;
      const { opcode, parts } = this._frag;
      this._frag = null;
      const message = Buffer.concat(parts);
      if (opcode === OP_TEXT) {
        let text;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(message);
        } catch {
          return this._fail('a text message is not valid UTF-8', 1007);
        }
        return this._dispatch('message', { data: text, origin: this._origin });
      }
      return this._dispatch('message', { data: this._pageBuffer(message), origin: this._origin });
    }

    /**
     * The bytes as an ArrayBuffer of the page's realm. A host-realm ArrayBuffer reaches the page behind a membrane proxy,
     * and a typed array cannot be built on a proxy, so the page would read zero bytes. The buffer is marked native instead.
     */
    _pageBuffer(bytes) {
      if (makeBuffer === undefined) makeBuffer = host.run('(n) => new ArrayBuffer(n)', 'websocket') ?? null;
      if (!makeBuffer) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const ab = makeBuffer(bytes.length);
      new Uint8Array(ab).set(bytes);
      host.membrane?.native?.add(ab);
      return ab;
    }

    /** The server's close frame: answer it if we have not sent ours, then finish with its code. */
    _onClose(payload) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? new TextDecoder('utf-8').decode(payload.subarray(2)) : '';
      if (!this._closeSent) {
        this._closeSent = true;
        this._write(encodeFrame(OP_CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0)));
      }
      this._finish(code, reason, true);
    }

    _write(frame) {
      const sock = this._sock;
      if (!sock || sock.destroyed) return;
      this.bufferedAmount += frame.length;
      sock.write(frame, () => { this.bufferedAmount = Math.max(0, this.bufferedAmount - frame.length); });
    }

    /** The connection ended without a close handshake, or failed. Fires error (for a failure) and close. */
    _lost() {
      if (this.readyState === WebSocket.CLOSED) return;
      if (this.readyState === WebSocket.CONNECTING) return this._fail('the connection closed before the handshake finished');
      if (this.readyState === WebSocket.CLOSING) return this._finish(1006, '', false);
      return this._fail('the connection closed unexpectedly');
    }

    /** Fails the connection: an error event (with the reason as message), then close. */
    _fail(reason, code = 1006) {
      if (this.readyState === WebSocket.CLOSED) return;
      log(`WebSocket ${this.url}: ${reason}`);
      this.readyState = WebSocket.CLOSED;
      this._release(true);
      this._dispatch('error', { message: reason });
      this._dispatch('close', { code, reason: '', wasClean: false });
    }

    _finish(code, reason, wasClean) {
      if (this.readyState === WebSocket.CLOSED) return;
      this.readyState = WebSocket.CLOSED;
      this._release(!wasClean);
      this._dispatch('close', { code, reason, wasClean });
    }

    /** Drops the socket. A clean end sends the bytes already written, then ends; a failure destroys it. */
    _release(destroy) {
      const sock = this._sock;
      this._sock = null;
      if (this._closeTimer !== null) {
        host._clearTimer(this._closeTimer);
        this._closeTimer = null;
      }
      if (!sock) return;
      sock.removeAllListeners('data');
      sock.on('error', () => {});
      if (destroy) sock.destroy();
      else sock.end();
    }

    // ---- page API

    send(data) {
      if (this.readyState === WebSocket.CONNECTING) throw new Error('InvalidStateError: WebSocket is still in CONNECTING state');
      if (this.readyState !== WebSocket.OPEN) return;
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        throw new TypeError('TypeError: a Blob cannot be sent in a can; send an ArrayBuffer or a string');
      }
      // An ArrayBuffer from the page is from the page's realm, so instanceof cannot see it: test the tag instead.
      if (isBinary(data)) {
        const bytes = ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : Buffer.from(data);
        this._write(encodeFrame(OP_BINARY, bytes));
      } else {
        this._write(encodeFrame(OP_TEXT, Buffer.from(String(data), 'utf8')));
      }
    }

    close(code, reason = '') {
      if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
        throw new TypeError(`InvalidAccessError: code ${code} is not 1000 or in 3000-4999`);
      }
      const reasonBytes = Buffer.from(String(reason), 'utf8');
      if (reasonBytes.length > 123) throw new SyntaxError('SyntaxError: the close reason is longer than 123 bytes');
      if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) return;
      if (this.readyState === WebSocket.CONNECTING) {
        this._fail('closed before the connection was open');
        return;
      }
      this.readyState = WebSocket.CLOSING;
      const payload = code === undefined
        ? Buffer.alloc(0)
        : Buffer.concat([Buffer.from([(code >> 8) & 0xff, code & 0xff]), reasonBytes]);
      this._closeSent = true;
      this._write(encodeFrame(OP_CLOSE, payload));
      this._closeTimer = host._timer(() => {
        this._closeTimer = null;
        if (this.readyState === WebSocket.CLOSING) this._finish(1006, '', false);
      }, CLOSE_TIMEOUT_MS, [], false);
    }
  }

  WebSocket.CONNECTING = 0;
  WebSocket.OPEN = 1;
  WebSocket.CLOSING = 2;
  WebSocket.CLOSED = 3;
  Object.defineProperty(WebSocket, 'name', { value: 'WebSocket' });
  return WebSocket;
}

function isBinary(v) {
  return ArrayBuffer.isView(v) || Object.prototype.toString.call(v) === '[object ArrayBuffer]';
}

function parseUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new SyntaxError(`SyntaxError: "${url}" is not a valid URL`);
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new SyntaxError(`SyntaxError: "${url}" must use the ws or wss scheme`);
  }
  return u;
}
