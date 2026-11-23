// Virtual http / https for a can. Requests to localhost, 127.0.0.1, ::1 or 0.0.0.0 go to the can's
// vnet (in-memory ports). Any other host goes out through the real node:http / node:https stack.
// Servers only ever listen on vnet ports; https.createServer serves plain HTTP on a vnet port.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import nodeHttp from 'node:http';
import nodeHttps from 'node:https';
import { Buffer } from 'node:buffer';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const DEFAULT_TIMEOUT_MS = 30_000;

export const STATUS_CODES = Object.freeze({
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently',
  302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 500: 'Internal Server Error',
  502: 'Bad Gateway', 503: 'Service Unavailable',
});

/** Writable-style response object handed to request handlers. Resolves the vnet request on end(). */
class ServerResponse extends EventEmitter {
  constructor(finish) {
    super();
    this.statusCode = 200;
    this.statusMessage = '';
    this.finished = false;
    this.headersSent = false;
    this._headers = new Map();
    this._chunks = [];
    this._finish = finish;
  }

  setHeader(name, value) { this._headers.set(String(name).toLowerCase(), value); return this; }
  getHeader(name) { return this._headers.get(String(name).toLowerCase()); }
  hasHeader(name) { return this._headers.has(String(name).toLowerCase()); }
  removeHeader(name) { this._headers.delete(String(name).toLowerCase()); }
  getHeaders() { return Object.fromEntries(this._headers); }

  writeHead(status, message, headers) {
    this.statusCode = status;
    const h = typeof message === 'object' ? message : headers;
    if (typeof message === 'string') this.statusMessage = message;
    for (const [k, v] of Object.entries(h ?? {})) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }

  write(chunk, encoding, cb) {
    const enc = typeof encoding === 'string' ? encoding : undefined;
    this._chunks.push(Buffer.from(chunk, enc));
    this.headersSent = true;
    if (typeof encoding === 'function') encoding();
    else if (typeof cb === 'function') cb();
    return true;
  }

  end(data, encoding, cb) {
    if (typeof data === 'function') { cb = data; data = undefined; }
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    if (data !== undefined && data !== null) this.write(data, encoding);
    if (this.finished) return this;
    this.finished = true;
    this._finish({ status: this.statusCode, headers: this.getHeaders(), body: Buffer.concat(this._chunks) });
    this.emit('finish');
    if (cb) cb();
    return this;
  }
}

/**
 * Readable request object for server handlers. Carries method, url, headers and the full body. It is an
 * IncomingMessage (exported as http.IncomingMessage), because frameworks such as Express build their request
 * objects from its prototype: `Object.create(http.IncomingMessage.prototype)`.
 */
export class IncomingMessage extends PassThrough {
  constructor() {
    super();
    this.method = 'GET';
    this.url = '/';
    this.headers = {};
    this.rawHeaders = [];
    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.complete = false;
    // A stand-in socket on the loopback address: req.ip and proxy checks read it, and it has no host behind it.
    // It is an EventEmitter, as a real socket is: on-finished (Express) calls socket.on(). It is readable and
    // writable, because on-finished treats a request whose socket is not readable as already finished.
    this.socket = Object.assign(new EventEmitter(), {
      remoteAddress: '127.0.0.1', remoteFamily: 'IPv4', remotePort: 0, encrypted: false, destroyed: false,
      readable: true, writable: true,
    });
    this.connection = this.socket;
  }
}

function makeIncomingRequest(data) {
  const req = new IncomingMessage();
  req.method = data.method;
  req.url = data.url;
  req.headers = data.headers;
  req.rawHeaders = Object.entries(data.headers ?? {}).flatMap(([k, v]) => [k, String(v)]);
  req.complete = true;
  // The body goes on the readable side only. Ending the writable side would make on-finished (Express) take this
  // for a finished response message, and body-parser would then skip the body.
  if (data.body && data.body.length > 0) req.push(data.body);
  req.push(null);
  return req;
}

/** Readable response object for client requests (its body is already complete). */
function makeIncomingResponse(result) {
  const res = new PassThrough();
  res.statusCode = result.status;
  res.statusMessage = STATUS_CODES[result.status] ?? '';
  res.headers = result.headers;
  res.end(result.body);
  return res;
}

const MAX_UPGRADE_HEAD = 64 * 1024;

/** True when headers (lower-case names) ask to switch to a WebSocket: Connection: Upgrade and Upgrade: websocket. */
export function isWebSocketUpgrade(headers) {
  const connection = String(headers.connection ?? '').toLowerCase().split(',').map((t) => t.trim());
  return connection.includes('upgrade') && String(headers.upgrade ?? '').trim().toLowerCase() === 'websocket';
}

/** Parses an HTTP/1.x request head ("METHOD target HTTP/1.1" then "name: value" lines). Null when malformed. */
function parseRequestHead(text) {
  const [line, ...lines] = text.split('\r\n');
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line ?? '');
  if (!m) return null;
  const headers = new Map();
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i <= 0) return null;
    const name = l.slice(0, i).trim().toLowerCase();
    const value = l.slice(i + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return { method: m[1], url: m[2], headers: Object.fromEntries(headers) };
}

/** The net.Socket members that node's ws library and frameworks call on an upgraded socket. Same duplex, more shape. */
function netSocketShape(sock) {
  return Object.assign(sock, {
    remoteAddress: '127.0.0.1', remoteFamily: 'IPv4', remotePort: 0, encrypted: false,
    setNoDelay() { return this; },
    setKeepAlive() { return this; },
    setTimeout() { return this; },
    ref() { return this; },
    unref() { return this; },
  });
}

/** A listen() form the can cannot honour is refused up front, with a code and a message that names it. */
function unsupported(what) {
  return Object.assign(new Error(`ENOTSUP: listen ${what} is not supported in a can (only ports on the can's virtual network)`), { code: 'ENOTSUP' });
}

function portOf(value) {
  if (value === undefined || value === null || typeof value === 'function') return 0;
  const port = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof port !== 'number' || !Number.isInteger(port)) {
    throw Object.assign(new RangeError(`ERR_SOCKET_BAD_PORT: port must be an integer, got ${String(value)}`), { code: 'ERR_SOCKET_BAD_PORT' });
  }
  return port;
}

// The can's vnet has no interfaces: a port answers on every loopback name and on all addresses. Any other host
// would need a real interface, so it is refused rather than silently ignored. backlog is accepted and has no effect.
const BIND_HOSTS = new Set([undefined, '', '0.0.0.0', '::', '127.0.0.1', '::1', 'localhost']);

/** Reads listen([port][, host][, cb]) and listen(options[, cb]) as node does. Throws for forms the can cannot honour. */
function parseListenArgs(args) {
  const [first, second] = args;
  let port;
  let host;
  if (first !== null && typeof first === 'object') {
    if (first.fd !== undefined || first.handle !== undefined) throw unsupported('on a file descriptor or handle');
    if (first.path !== undefined) throw unsupported('on a unix socket path');
    if (first.signal !== undefined) throw unsupported('with an AbortSignal');
    port = portOf(first.port);
    host = first.host;
  } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
    throw unsupported(`on a unix socket path (${first})`);
  } else {
    port = portOf(first);
    host = typeof second === 'string' ? second : undefined;
  }
  if (!BIND_HOSTS.has(host)) {
    throw Object.assign(new Error(`EADDRNOTAVAIL: cannot listen on ${host}; a can listens on loopback or all addresses only`), { code: 'EADDRNOTAVAIL' });
  }
  return port;
}

export function createHttpModule(rt, scheme) {
  class Server extends EventEmitter {
    constructor(requestListener) {
      super();
      this.listener = null;
      // As in node, a handler given to createServer is a 'request' listener, and it runs alongside any others.
      if (typeof requestListener === 'function') this.on('request', requestListener);
    }

    listen(...args) {
      const cb = args.find((a) => typeof a === 'function');
      const port = parseListenArgs(args);
      const listener = rt.vnet.listen(port, (data) => new Promise((resolve, reject) => {
        const res = new ServerResponse(resolve);
        // An upgrade needs the raw connection (see acceptRaw). A request that arrives whole cannot switch protocols.
        if (isWebSocketUpgrade(data.headers ?? {})) {
          res.writeHead(426, { 'content-type': 'text/plain', connection: 'Upgrade', upgrade: 'websocket' });
          res.end('Upgrade Required: a WebSocket upgrade must arrive as a raw connection');
          return;
        }
        const req = makeIncomingRequest(data);
        try {
          this.emit('request', req, res);
        } catch (err) {
          reject(err);
        }
      }));
      // A raw connection (vnet.connect) carries an upgrade request. The vnet only delivers it when this listener exists.
      listener.on('connection', (sock) => this.acceptRaw(sock));
      this.listener = listener;
      rt.addPort(listener.port);
      rt.addTimer('timeout', () => {
        this.emit('listening');
        if (cb) cb();
      }, 0, []);
      return this;
    }

    /**
     * A raw connection carries one HTTP upgrade request. Its head is read here; the socket then goes to 'upgrade'
     * listeners as (req, socket, head), where head holds the bytes that followed the head in the same packet. As in
     * node, a socket with no 'upgrade' listener is destroyed, and a connection that is not an upgrade gets a 400.
     * The 101 answer is written by the listener (the ws library does this), so the bytes reach the client as written.
     */
    acceptRaw(sock) {
      let pending = Buffer.alloc(0);
      const onError = () => sock.destroy();
      sock.on('error', onError);
      const onData = (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        const at = pending.indexOf('\r\n\r\n');
        if (at < 0) {
          if (pending.length > MAX_UPGRADE_HEAD) {
            sock.removeListener('data', onData);
            sock.end('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          }
          return;
        }
        sock.removeListener('data', onData);
        const parsed = parseRequestHead(pending.subarray(0, at).toString('latin1'));
        if (!parsed || !isWebSocketUpgrade(parsed.headers)) {
          sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        const head = Buffer.from(pending.subarray(at + 4));
        pending = null;
        if (this.listenerCount('upgrade') === 0) {
          sock.destroy();
          return;
        }
        netSocketShape(sock);
        const req = makeIncomingRequest({ method: parsed.method, url: parsed.url, headers: parsed.headers, body: null });
        req.socket = req.connection = sock;
        // Listeners must attach their 'data' listener synchronously (ws does), or bytes that arrive later are lost.
        try {
          this.emit('upgrade', req, sock, head);
        } catch (err) {
          sock.destroy();
          rt.fail(err);
        }
      };
      sock.on('data', onData);
    }

    address() {
      if (!this.listener) return null;
      return { address: '127.0.0.1', family: 'IPv4', port: this.listener.port };
    }

    close(cb) {
      if (this.listener) {
        const port = this.listener.port;
        this.listener = null;
        rt.vnet.close(port);
        rt.removePort(port);
      }
      rt.addTimer('timeout', () => {
        this.emit('close');
        if (cb) cb();
      }, 0, []);
      return this;
    }
  }

  /** Collects body writes; sends on end(). Emits 'response' and calls the callback with the response. */
  class ClientRequest extends EventEmitter {
    constructor(send) {
      super();
      this._send = send;
      this._chunks = [];
      this._headers = {};
      this.ended = false;
    }

    setHeader(name, value) { this._headers[String(name).toLowerCase()] = value; return this; }
    getHeader(name) { return this._headers[String(name).toLowerCase()]; }

    write(chunk, encoding, cb) {
      this._chunks.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
      if (typeof encoding === 'function') encoding();
      else if (typeof cb === 'function') cb();
      return true;
    }

    end(chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
      if (this.ended) return this;
      this.ended = true;
      this._send(Buffer.concat(this._chunks));
      if (cb) cb();
      return this;
    }

    setTimeout() { return this; }
    destroy(err) { if (err) this.emit('error', err); return this; }
  }

  function toOptions(args) {
    let [target, opts, cb] = args;
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    let base = {};
    if (typeof target === 'string' || target instanceof URL) {
      const u = new URL(String(target));
      base = {
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port,
        path: `${u.pathname}${u.search}`,
      };
    } else {
      base = { ...(target ?? {}) };
    }
    const merged = { ...base, ...(opts ?? {}) };
    const proto = (merged.protocol ?? `${scheme}:`).replace(/:$/, '');
    const hostname = String(merged.hostname ?? merged.host ?? 'localhost').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const port = Number(merged.port) || (proto === 'https' ? 443 : 80);
    return {
      protocol: proto,
      hostname,
      port,
      method: String(merged.method ?? 'GET').toUpperCase(),
      path: merged.path ?? '/',
      headers: merged.headers ?? {},
      timeout: merged.timeout ?? DEFAULT_TIMEOUT_MS,
      cb,
    };
  }

  function sendRemote(o, body) {
    if (rt.can?.policy?.internet === false) {
      return Promise.reject(Object.assign(new Error(`EPERM: network access is off for this can (network.internet is false), cannot reach ${o.hostname}`), { code: 'EPERM' }));
    }
    const mod = o.protocol === 'https' ? nodeHttps : nodeHttp;
    return new Promise((resolve, reject) => {
      const r = mod.request({
        hostname: o.hostname, port: o.port, method: o.method, path: o.path, headers: o.headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      r.on('error', reject);
      r.setTimeout(o.timeout || 0, () => r.destroy(new Error('ETIMEDOUT')));
      r.end(body);
    });
  }

  function request(...args) {
    const o = toOptions(args);
    const isLocal = LOCAL_HOSTS.has(o.hostname);
    const headers = { ...o.headers };
    const req = new ClientRequest((body) => {
      if (body.length > 0 && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
        headers['content-length'] = String(body.length);
      }
      const inFlight = isLocal
        ? rt.vnet.request({ port: o.port, method: o.method, path: o.path, headers, body, timeout: o.timeout })
        : sendRemote({ ...o, headers }, body);
      // The program stays alive until the response has been read to its end: the callback's 'data' and
      // 'end' listeners run after this callback returns, so settling earlier could end the program first.
      rt.trackRequest(inFlight.then((result) => {
        const res = makeIncomingResponse(result);
        const done = new Promise((resolve) => { res.once('end', resolve); res.once('error', resolve); });
        try {
          req.emit('response', res);
          if (o.cb) o.cb(res);
          // Nobody reads the body: drain it, or 'end' never comes.
          if (res.listenerCount('data') === 0 && res.listenerCount('readable') === 0) res.resume();
        } catch (err) {
          rt.fail(err);
        }
        return done;
      }, (err) => {
        try {
          if (req.listenerCount('error') === 0 && !o.cb) throw err;
          req.emit('error', err);
        } catch (e) {
          rt.fail(e);
        }
      }));
    });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    return req;
  }

  function get(...args) {
    const req = request(...args);
    req.end();
    return req;
  }

  return {
    Server,
    STATUS_CODES,
    METHODS: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
    // createServer([options][, requestListener]). The options object is accepted and ignored.
    createServer: (options, requestListener) => new Server(typeof options === 'function' ? options : requestListener),
    request,
    get,
    ClientRequest,
    ServerResponse,
    IncomingMessage,
    OutgoingMessage: ServerResponse,
  };
}
