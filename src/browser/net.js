// Browser transport: routes requests to the can's virtual network or the real internet,
// follows redirects, and keeps a cookie jar. Uses only node:http / node:https.
import http from 'node:http';
import https from 'node:https';
import { KernelError } from '../kernel/errors.js';

export const MAX_REDIRECTS = 10;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

// ---------------------------------------------------------------- cookies

export class CookieJar {
  constructor({ clock = Date.now } = {}) {
    this.clock = clock;
    this.items = new Map(); // "domain|path|name" -> cookie
  }

  /** Applies a Set-Cookie header value (string or array) received from url. */
  setFromResponse(url, setCookie) {
    for (const raw of [].concat(setCookie ?? [])) this._store(url, String(raw), false);
  }

  /** Applies document.cookie = "..." (HttpOnly cookies cannot be set from script). */
  setFromDocument(url, raw) {
    this._store(url, String(raw), true);
  }

  /** Value for a Cookie request header for url, or '' if none apply. */
  headerFor(url, { fromDocument = false } = {}) {
    const now = this.clock();
    const hits = [];
    for (const [key, c] of this.items) {
      if (c.expires !== null && c.expires <= now) { this.items.delete(key); continue; }
      if (fromDocument && c.httpOnly) continue;
      if (cookieApplies(c, url)) hits.push(c);
    }
    hits.sort((a, b) => b.path.length - a.path.length);
    return hits.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** Snapshot of live cookies, for callers and tests. */
  list() {
    const now = this.clock();
    return [...this.items.values()]
      .filter((c) => c.expires === null || c.expires > now)
      .map(({ name, value, domain, path, secure, httpOnly, expires }) => ({ name, value, domain, path, secure, httpOnly, expires }));
  }

  clear() {
    this.items.clear();
  }

  _store(url, raw, fromDocument) {
    const host = url.hostname.toLowerCase();
    const [pair, ...attrs] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    const name = pair.slice(0, eq).trim();
    if (!name) return;
    const now = this.clock();
    const cookie = {
      name,
      value: pair.slice(eq + 1).trim(),
      domain: host,
      hostOnly: true,
      path: defaultPath(url.pathname),
      expires: null,
      secure: false,
      httpOnly: false,
    };
    let maxAge = null;
    let expires = null;
    for (const attr of attrs) {
      const j = attr.indexOf('=');
      const key = (j < 0 ? attr : attr.slice(0, j)).trim().toLowerCase();
      const val = j < 0 ? '' : attr.slice(j + 1).trim();
      if (key === 'domain' && val) {
        const d = val.replace(/^\./, '').toLowerCase();
        if (host !== d && !host.endsWith(`.${d}`)) return; // a cookie may not target a foreign domain
        cookie.domain = d;
        cookie.hostOnly = false;
      } else if (key === 'path' && val.startsWith('/')) {
        cookie.path = val;
      } else if (key === 'max-age') {
        const n = Number.parseInt(val, 10);
        if (!Number.isNaN(n)) maxAge = now + n * 1000;
      } else if (key === 'expires') {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expires = t;
      } else if (key === 'secure') {
        cookie.secure = true;
      } else if (key === 'httponly') {
        cookie.httpOnly = true;
      }
    }
    if (fromDocument && cookie.httpOnly) return;
    cookie.expires = maxAge ?? expires;
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
    if (cookie.expires !== null && cookie.expires <= now) {
      this.items.delete(key);
      return;
    }
    this.items.set(key, cookie);
  }
}

function defaultPath(pathname) {
  const i = pathname.lastIndexOf('/');
  return !pathname.startsWith('/') || i === 0 ? '/' : pathname.slice(0, i);
}

function cookieApplies(c, url) {
  if (c.secure && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  const hostOk = c.hostOnly ? host === c.domain : (host === c.domain || host.endsWith(`.${c.domain}`));
  if (!hostOk) return false;
  const p = url.pathname || '/';
  return p === c.path || (p.startsWith(c.path) && (c.path.endsWith('/') || p[c.path.length] === '/'));
}

// ---------------------------------------------------------------- routing

/** Port of the can's virtual listener for this URL, or null when the URL goes to the real internet. */
export function virtualPort(url, can) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local = LOCAL_HOSTS.has(host) || host.endsWith('.localhost')
    || host === String(can.name).toLowerCase() || host === String(can.id).toLowerCase();
  if (!local) return null;
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
}

async function send(opts, method, url, headers, body) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new KernelError('EINVAL', `EINVAL: unsupported URL scheme ${url.protocol}`);
  }
  const port = virtualPort(url, opts.can);
  if (port !== null) {
    const res = await opts.can.vnet.request({
      port,
      method,
      path: url.pathname + url.search,
      headers,
      body: body ?? undefined,
      timeout: opts.timeout,
    });
    checkSize(res.body, opts.maxBytes, url);
    return { status: res.status, headers: res.headers, body: res.body };
  }
  if (!opts.internet) {
    throw new KernelError('EPERM', `EPERM: internet access is disabled, cannot reach ${url.host}`);
  }
  const res = await internetRequest(url, method, headers, body, opts);
  return res;
}

function checkSize(buf, maxBytes, url) {
  if (buf.length > maxBytes) {
    throw new KernelError('EFBIG', `EFBIG: response from ${url.href} exceeds ${maxBytes} bytes`);
  }
}

function internetRequest(url, method, headers, body, opts) {
  const { timeout, maxBytes } = opts;
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new KernelError('EFBIG', `EFBIG: response from ${url.href} exceeds ${maxBytes} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    if (timeout > 0) {
      req.setTimeout(timeout, () => {
        reject(new KernelError('ETIMEDOUT', `ETIMEDOUT: request to ${url.href} timed out after ${timeout}ms`));
        req.destroy();
      });
    }
    req.on('error', (err) => reject(netError(err, url)));
    req.end(body ?? undefined);
  });
}

/** A Node network error as a KernelError whose code leads the message, e.g. "ENOTFOUND: cannot reach example.com". */
function netError(err, url) {
  const code = typeof err?.code === 'string' ? err.code : 'EIO';
  return new KernelError(code, `${code}: cannot reach ${url.host} (${err?.message ?? 'network error'})`);
}

/**
 * Performs a request and follows redirects (301/302/303/307/308, at most MAX_REDIRECTS).
 * Cookies are sent and stored on every hop.
 * @returns {Promise<{url: string, status: number, headers: object, body: Buffer, redirects: number}>}
 */
export async function fetchResource(opts, { method = 'GET', url, headers = {}, body = null }) {
  let current = new URL(url);
  let m = String(method).toUpperCase();
  let b = body;
  let h = { ...headers };
  for (let hop = 0; ; hop++) {
    const reqHeaders = {
      'user-agent': opts.userAgent,
      accept: '*/*',
      'accept-encoding': 'identity',
      ...h,
    };
    const cookie = opts.cookies.headerFor(current);
    if (cookie) reqHeaders.cookie = cookie;
    const res = await send(opts, m, current, reqHeaders, b);
    opts.cookies.setFromResponse(current, res.headers['set-cookie']);

    const location = [].concat(res.headers.location ?? [])[0];
    if (REDIRECT_STATUS.has(res.status) && location) {
      if (hop >= MAX_REDIRECTS) {
        throw new KernelError('ELOOP', `ELOOP: too many redirects starting at ${url}`);
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === 'POST')) {
        m = 'GET';
        b = null;
        h = Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith('content-')));
      }
      current = new URL(location, current);
      continue;
    }
    return { url: current.href, status: res.status, headers: res.headers, body: res.body, redirects: hop };
  }
}
