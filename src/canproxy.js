// Host-side HTTP proxy for a real Chrome or Edge that works inside one can. The browser sends every request here.
// A request for localhost, 127.0.0.1 or [::1] goes into the can's own network (can.request), so a server the can
// started on port 8080 is reached at http://localhost:8080/. Any other host is reached from the host, unless the can
// has no internet. Names that resolve to this machine are refused, so the page cannot reach host services.
//
// The proxy runs in the host process and listens on loopback only. The can process never opens a socket or starts
// a child process for this. The sandbox boundary (SPEC.md section 10) is the same as before.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** Hostnames that mean "this can": localhost, its subdomains, and the loopback literals. */
export function isCanHost(hostname) {
  const h = stripBrackets(hostname).toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
}

function stripBrackets(hostname) {
  return hostname.replace(/^\[|\]$/g, '');
}

function isLoopback(address, family) {
  if (family === 4) return address.startsWith('127.');
  return address === '::1' || address.startsWith('::ffff:127.');
}

/**
 * Resolves a host name for an outbound request and refuses one that points at this machine (loopback) or at
 * nothing. Returns the first address, so the request connects to the address that was checked (no second lookup).
 */
export async function resolveOutbound(hostname) {
  const h = stripBrackets(hostname);
  const family = net.isIP(h);
  const list = family ? [{ address: h, family }] : await dns.lookup(h, { all: true, verbatim: true });
  if (list.length === 0) throw Object.assign(new Error(`${hostname} has no address`), { status: 502 });
  for (const a of list) {
    if (isLoopback(a.address, a.family) || a.address === '0.0.0.0' || a.address === '::') {
      throw Object.assign(new Error(`${hostname} resolves to this machine, which the can browser may not reach`), { status: 403 });
    }
  }
  return list[0];
}

/** A lookup function that always returns the address already checked, for http.request and https.request. */
function pinnedLookup({ address, family }) {
  return (_host, options, callback) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function forwardHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function responseHeaders(headers, bodyLength) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name) || name === 'content-length') continue;
    out[name] = value;
  }
  if (bodyLength !== undefined) out['content-length'] = String(bodyLength);
  return out;
}

// A failed request is answered with a text page and an x-can-error header (the error code). The backend turns that
// header into an error, so a dead can port fails the browser action the way the built-in browser does.
function failText(res, status, message, code = null) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const headers = { 'content-type': 'text/plain; charset=utf-8' };
  if (code) headers['x-can-error'] = code;
  res.writeHead(status, headers);
  res.end(`${status} ${message}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Starts the proxy. `canFor()` returns the can to serve localhost requests (it may change if the can is reloaded).
 * `internet=false` refuses every host that is not the can.
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export async function startCanProxy({ canFor, internet = true } = {}) {
  const sockets = new Set();

  async function serveCan(req, res, target, body) {
    const can = canFor();
    const port = Number(target.port || 80);
    if (target.protocol !== 'http:') return failText(res, 400, 'a can serves plain http only');
    let r;
    try {
      r = await can.request({
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: forwardHeaders(req.headers),
        body: body.length > 0 ? body : undefined,
      });
    } catch (err) {
      if (/ECONNREFUSED/.test(err.message)) {
        return failText(res, 502, `nothing is listening on port ${port} inside the can`, 'ECONNREFUSED');
      }
      return failText(res, 502, `the can did not answer: ${err.message}`, 'EIO');
    }
    res.writeHead(r.status, responseHeaders(r.headers, r.body.length));
    res.end(r.body);
  }

  async function forwardOutside(req, res, target, body) {
    if (!internet) return failText(res, 403, 'this can has no internet access');
    let addr;
    try {
      addr = await resolveOutbound(target.hostname);
    } catch (err) {
      return failText(res, err.status ?? 502, err.message);
    }
    const lib = target.protocol === 'https:' ? https : http;
    const upstream = lib.request(target, {
      method: req.method,
      headers: forwardHeaders(req.headers),
      lookup: pinnedLookup(addr),
    }, (up) => {
      res.writeHead(up.statusCode ?? 502, responseHeaders(up.headers));
      up.pipe(res);
    });
    upstream.on('error', (err) => failText(res, 502, `could not reach ${target.hostname}: ${err.code ?? err.message}`));
    upstream.end(body);
  }

  const server = http.createServer(async (req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      return failText(res, 400, 'the proxy needs an absolute URL');
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return failText(res, 400, `the proxy carries only http and https, not ${target.protocol}`);
    }
    const body = await readBody(req);
    if (isCanHost(target.hostname)) return serveCan(req, res, target, body);
    return forwardOutside(req, res, target, body);
  });

  // HTTPS goes through CONNECT: the proxy opens a TCP tunnel and never reads the traffic. A can serves plain
  // HTTP only, so a tunnel to the can is refused.
  server.on('connect', async (req, client, head) => {
    const idx = req.url.lastIndexOf(':');
    const hostname = stripBrackets(req.url.slice(0, idx));
    const port = Number(req.url.slice(idx + 1)) || 443;
    const refuse = (status, message) => {
      client.end(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
    };
    if (!internet) return refuse(403, 'Forbidden');
    if (isCanHost(hostname)) return refuse(403, 'Forbidden');
    let addr;
    try {
      addr = await resolveOutbound(hostname);
    } catch (err) {
      return refuse(err.status ?? 502, 'Refused');
    }
    const upstream = net.connect({ host: addr.address, port }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });

  // Chrome drops idle keep-alive connections without warning, so a reset is normal. Drop that socket and go on.
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}
