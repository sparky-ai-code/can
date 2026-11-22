// Virtual network: per-can ports, in-memory duplex connections and a virtual HTTP layer.
// Each VNet belongs to exactly one can. Ports never map to host sockets.
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { KernelError } from './errors.js';

const PORT_MIN = 1;
const PORT_MAX = 65535;
const EPHEMERAL_MIN = 49152;
const DEFAULT_TIMEOUT_MS = 30_000;
const TIMEOUT = Symbol('timeout');

/** Two connected in-memory duplex streams: bytes written to one are read from the other. */
export function createStreamPair() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  return [joinPipes(bToA, aToB), joinPipes(aToB, bToA)];
}

/** A Duplex that reads from `readable` and writes to `writable`; end and destroy propagate. */
function joinPipes(readable, writable) {
  const sock = new Duplex({
    read() { readable.resume(); },
    write(chunk, encoding, callback) { writable.write(chunk, encoding, callback); },
    final(callback) { writable.end(); callback(); },
    destroy(err, callback) { readable.destroy(); writable.destroy(); callback(err); },
  });
  readable.on('data', (chunk) => { if (!sock.push(chunk)) readable.pause(); });
  readable.on('end', () => sock.push(null));
  // The peer went away without ending: behave like a reset connection.
  readable.on('close', () => { if (!readable.readableEnded) sock.destroy(); });
  readable.on('error', (err) => sock.destroy(err));
  writable.on('error', (err) => sock.destroy(err));
  return sock;
}

/** A listening port. Emits 'connection' (server-side duplex) for each connect() call. */
export class Listener extends EventEmitter {
  constructor(port, handler, createdAt) {
    super();
    this.port = port;
    this.handler = handler;
    this.createdAt = createdAt;
  }
}

export class VNet {
  constructor({ clock = Date.now } = {}) {
    this.clock = clock;
    this.listeners = new Map(); // port -> Listener
    this._ephemeralNext = EPHEMERAL_MIN;
  }

  /**
   * Starts listening. `handler(req)` serves HTTP requests and may return a response
   * or a Promise of one. See SPEC.md for the request/response shapes.
   * @param {number} port 1-65535, or 0 to pick a free ephemeral port
   * @returns {Listener}
   */
  listen(port, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    const p = port === 0 ? this._allocPort() : checkPort(port);
    if (this.listeners.has(p)) {
      throw new KernelError('EADDRINUSE', `EADDRINUSE: address already in use :${p}`, { port: p });
    }
    const listener = new Listener(p, handler, this.clock());
    this.listeners.set(p, listener);
    return listener;
  }

  /** Stops listening on a port. Returns false if nothing was listening there. */
  close(port) {
    const listener = this.listeners.get(port);
    if (!listener) return false;
    this.listeners.delete(port);
    listener.emit('close');
    return true;
  }

  closeAll() {
    for (const port of [...this.listeners.keys()]) this.close(port);
  }

  /** Open ports as [{port, createdAt}]. */
  list() {
    return [...this.listeners.values()].map(({ port, createdAt }) => ({ port, createdAt }));
  }

  /**
   * Opens a raw stream connection. Returns the client end; the server end is delivered to the
   * listener's 'connection' event. Throws ECONNREFUSED if nothing is listening or no one accepts streams.
   */
  connect(port) {
    const listener = this.listeners.get(Number(port));
    if (!listener || listener.listenerCount('connection') === 0) {
      throw new KernelError('ECONNREFUSED', `ECONNREFUSED: connection refused :${port}`, { port });
    }
    const [client, server] = createStreamPair();
    listener.emit('connection', server);
    return client;
  }

  /**
   * Sends one HTTP request to a virtual port. Handler exceptions become 500 responses.
   * Rejects with ECONNREFUSED (no listener) or ETIMEDOUT (timeout ms, 0 disables).
   * @returns {Promise<{status: number, headers: object, body: Buffer}>}
   */
  async request({ port, method = 'GET', path = '/', headers = {}, body, timeout = DEFAULT_TIMEOUT_MS } = {}) {
    const listener = this.listeners.get(Number(port));
    if (!listener) {
      throw new KernelError('ECONNREFUSED', `ECONNREFUSED: connection refused :${port}`, { port });
    }
    const reqHeaders = lowerKeys(headers);
    const reqBody = encodeBody(body, reqHeaders);
    // An HTTP/1.1 request with a body says how long it is. Without Content-Length a server (Express, body-parser,
    // any framework that checks the header) treats the request as having no body, as node does.
    if (reqBody.length > 0 && !('content-length' in reqHeaders)) reqHeaders['content-length'] = String(reqBody.length);
    const req = {
      port: listener.port,
      method: String(method).toUpperCase(),
      url: path,
      headers: reqHeaders,
      body: reqBody,
    };
    const outcome = await raceTimeout(
      new Promise((resolve) => resolve(listener.handler(req))).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      ),
      timeout,
    );
    if (outcome === TIMEOUT) {
      throw new KernelError('ETIMEDOUT', `ETIMEDOUT: request to port ${listener.port} timed out after ${timeout}ms`, { port: listener.port });
    }
    if (!outcome.ok) {
      return { status: 500, headers: { 'content-type': 'text/plain' }, body: Buffer.from(String(outcome.error?.stack ?? outcome.error)) };
    }
    return encodeResponse(outcome.value);
  }

  _allocPort() {
    const span = PORT_MAX - EPHEMERAL_MIN + 1;
    for (let i = 0; i < span; i++) {
      const port = this._ephemeralNext;
      this._ephemeralNext = port === PORT_MAX ? EPHEMERAL_MIN : port + 1;
      if (!this.listeners.has(port)) return port;
    }
    throw new KernelError('EADDRINUSE', 'EADDRINUSE: no free ephemeral ports');
  }
}

function checkPort(port) {
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    throw new KernelError('EINVAL', `EINVAL: invalid port ${port}`, { port });
  }
  return port;
}

function lowerKeys(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
}

/** Buffers pass through, strings are UTF-8, plain objects become JSON (typed as such if untyped). */
function encodeBody(body, headers) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string' || body instanceof Uint8Array) return Buffer.from(body);
  if (!('content-type' in headers)) headers['content-type'] = 'application/json';
  return Buffer.from(JSON.stringify(body));
}

function encodeResponse(res) {
  const r = res ?? {};
  const headers = lowerKeys(r.headers);
  return { status: r.status ?? 200, headers, body: encodeBody(r.body, headers) };
}

/** Resolves with the promise's result, or TIMEOUT after ms. ms <= 0 disables the timer. */
function raceTimeout(promise, ms) {
  if (!(ms > 0)) return promise;
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), ms); });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}
