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
    this.socket = { remoteAddress: '127.0.0.1', remoteFamily: 'IPv4', remotePort: 0, encrypted: false, destroyed: false };
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
  req.end(data.body);
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

export function createHttpModule(rt, scheme) {
  class Server extends EventEmitter {
    constructor(handler) {
      super();
      this.handler = handler;
      this.listener = null;
    }

    listen(...args) {
      const cb = args.find((a) => typeof a === 'function');
      const first = args[0];
      const port = typeof first === 'number' ? first
        : typeof first === 'string' && /^\d+$/.test(first) ? Number(first) : 0;
      const handler = this.handler;
      const listener = rt.vnet.listen(port, (data) => new Promise((resolve, reject) => {
        const req = makeIncomingRequest(data);
        const res = new ServerResponse(resolve);
        try {
          if (handler) handler(req, res);
        } catch (err) {
          reject(err);
        }
      }));
      this.listener = listener;
      rt.addPort(listener.port);
      rt.addTimer('timeout', () => {
        this.emit('listening');
        if (cb) cb();
      }, 0, []);
      return this;
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
    createServer: (handler) => new Server(handler),
    request,
    get,
    ClientRequest,
    ServerResponse,
    IncomingMessage,
    OutgoingMessage: ServerResponse,
  };
}
