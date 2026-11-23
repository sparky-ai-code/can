// WebSocket in a can, end to end. The server side is a Node http server in the can that answers the upgrade by hand
// (no npm: the handshake, the frames and the close are written out in the server source), the way Sparky's ws-based
// server does it. The client side is the page's own WebSocket, run through the can's browser. Each server also
// answers a plain GET on its port, so a test shows that upgrades and ordinary requests share the port.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CanManager } from '../src/manager.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-websocket-'));
const manager = new CanManager({ storeDir: path.join(tmp, 'store'), mountsFile: path.join(tmp, 'none.json') });
let counter = 0;

after(async () => {
  await manager.destroyAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// RFC 6455 section 1.3: the sample key and the accept value the server must answer with.
const SAMPLE_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const SAMPLE_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';

/** Frame helpers and an echo server, as the server source of every test below. Written out, with no npm. */
const FRAMES = `
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(op, p, fin = true) {
  const n = p.length;
  let h;
  if (n < 126) h = Buffer.from([(fin ? 0x80 : 0) | op, n]);
  else if (n < 65536) h = Buffer.from([(fin ? 0x80 : 0) | op, 126, n >> 8, n & 255]);
  else { h = Buffer.alloc(10); h[0] = (fin ? 0x80 : 0) | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
function parse(b) {
  if (b.length < 2) return null;
  let n = b[1] & 127;
  let off = 2;
  if (n === 126) { if (b.length < 4) return null; n = b.readUInt16BE(2); off = 4; }
  else if (n === 127) { if (b.length < 10) return null; n = Number(b.readBigUInt64BE(2)); off = 10; }
  const masked = (b[1] & 128) !== 0;
  if (masked) off += 4;
  if (b.length < off + n) return null;
  const payload = Buffer.from(b.subarray(off, off + n));
  if (masked) { const k = b.subarray(off - 4, off); for (let i = 0; i < n; i++) payload[i] ^= k[i & 3]; }
  return { op: b[0] & 15, payload, size: off + n };
}
`;

const ECHO_SERVER = `
const http = require('http');
${FRAMES}
const srv = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>ws</title><p>page</p>');
});
srv.on('upgrade', (req, socket, head) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  let buf = Buffer.alloc(0);
  const onFrame = (f) => {
    if (f.op === 1) {
      const text = f.payload.toString('utf8');
      if (text === 'frag') { socket.write(frame(1, Buffer.from('frag-'), false)); socket.write(frame(0, Buffer.from('part2'))); }
      else if (text === 'ping') { socket.write(frame(9, Buffer.from('p1'))); socket.write(frame(1, Buffer.from('after-ping'))); }
      else socket.write(frame(1, f.payload));
    } else if (f.op === 2) socket.write(frame(2, f.payload));
    else if (f.op === 10) socket.write(frame(1, Buffer.from('pong:' + f.payload.toString())));
    else if (f.op === 8) { socket.write(frame(8, f.payload)); socket.end(); }
  };
  const drain = () => {
    for (;;) {
      const f = parse(buf);
      if (!f) return;
      buf = buf.subarray(f.size);
      onFrame(f);
    }
  };
  socket.on('data', (c) => { buf = Buffer.concat([buf, c]); drain(); });
  socket.on('error', () => {});
  buf = Buffer.from(head);
  drain();
});
srv.listen(PORT, () => console.log('ready'));
`;

const NO_UPGRADE_SERVER = `
const http = require('http');
const srv = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>plain</title><p>plain only</p>');
});
srv.listen(PORT, () => console.log('ready'));
`;

const WRONG_ACCEPT_SERVER = `
const http = require('http');
const srv = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>wrong</title><p>wrong</p>');
});
srv.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\\r\\n\\r\\n');
});
srv.listen(PORT, () => console.log('ready'));
`;

async function bootServer(source) {
  const can = await manager.create({ name: `ws-${++counter}` });
  await can.writeFile('/home/agent/server.js', source);
  const proc = await can.spawn('node server.js');
  for (let i = 0; i < 100; i++) {
    const out = String(await can.logs(proc.pid, 'stdout'));
    if (out.includes('ready')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return can;
}

/** Polls the page until the expression is true (evaluated in the page). */
async function until(can, expr, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await can.browse('evaluate', `!!(${expr})`)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('the server side: an upgrade on a can port', () => {
  test('a hand-written handshake gets 101 and the RFC 6455 Sec-WebSocket-Accept', async () => {
    const port = 3050;
    const can = await bootServer(ECHO_SERVER.replace('PORT', String(port)));
    await can.writeFile('/home/agent/raw.js', `
      const net = require('net');
      const s = net.connect(${port}, 'localhost', () => {
        s.write('GET /echo HTTP/1.1\\r\\nHost: localhost:${port}\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n'
          + 'Sec-WebSocket-Key: ${SAMPLE_KEY}\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n');
      });
      let got = '';
      s.on('data', (c) => {
        got += c.toString('latin1');
        if (got.includes('\\r\\n\\r\\n')) { console.log(got.split('\\r\\n').join('|')); s.destroy(); }
      });
      s.on('error', (e) => console.log('error ' + e.message));
    `);
    const r = await can.exec('node raw.js', { timeout: 30_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    const lines = r.stdout.trim().split('|');
    assert.equal(lines[0], 'HTTP/1.1 101 Switching Protocols');
    assert.ok(lines.includes(`Sec-WebSocket-Accept: ${SAMPLE_ACCEPT}`), r.stdout);
    assert.equal(SAMPLE_ACCEPT, createHash('sha1').update(SAMPLE_KEY + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'));
  });

  test('a plain GET on the same port still gets its ordinary response', async () => {
    const port = 3051;
    const can = await bootServer(ECHO_SERVER.replace('PORT', String(port)));
    const r = await can.request({ port, path: '/', timeout: 10_000 });
    assert.equal(r.status, 200);
    assert.match(String(r.body), /<p>page<\/p>/);
  });

  test('an upgrade-headed request that arrives whole gets 426, not a request event', async () => {
    const port = 3052;
    const can = await bootServer(ECHO_SERVER.replace('PORT', String(port)));
    const r = await can.request({
      port, path: '/echo', headers: { Connection: 'Upgrade', Upgrade: 'websocket' }, timeout: 10_000,
    });
    assert.equal(r.status, 426);
  });
});

describe('a raw connection that is not an upgrade', () => {
  test('gets 400 and is closed', async () => {
    const port = 3058;
    const can = await bootServer(ECHO_SERVER.replace('PORT', String(port)));
    await can.writeFile('/home/agent/plain.js', `
      const net = require('net');
      const s = net.connect(${port}, 'localhost', () => s.write('GET / HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n'));
      let got = '';
      s.on('data', (c) => { got += c.toString('latin1'); });
      s.on('close', () => console.log(got.split('\\r\\n')[0]));
    `);
    const r = await can.exec('node plain.js', { timeout: 30_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'HTTP/1.1 400 Bad Request');
  });
});

describe('the client side: page WebSocket to a can server', () => {
  test('a text frame round-trips, fragments and a ping are handled, and close completes with code 1000', async () => {
    const port = 3053;
    const can = await bootServer(ECHO_SERVER.replace('PORT', String(port)));
    await can.browse('goto', `http://localhost:${port}/`);
    await can.browse('evaluate', `
      window.__r = { msgs: [], events: [] };
      const ws = new WebSocket('ws://localhost:${port}/echo');
      window.__ws = ws;
      __r.start = ws.readyState;
      ws.onopen = () => { __r.events.push('open'); ws.send('hello \\u2713 \\ud83d\\ude00'); ws.send('frag'); ws.send('ping'); };
      ws.onmessage = (e) => {
        __r.msgs.push(e.data);
        if (__r.msgs.length === 4) ws.close(1000, 'bye');
      };
      ws.onerror = (e) => __r.events.push('error:' + e.message);
      ws.onclose = (e) => { __r.close = [e.code, e.reason, e.wasClean]; __r.done = true; };
    `);
    await until(can, 'window.__r && window.__r.done');
    const r = await can.browse('evaluate', 'window.__r');
    assert.equal(r.start, 0, 'CONNECTING before the handshake');
    assert.deepEqual(r.events, ['open']);
    // The server echoes the text, joins a fragmented message, and after a ping sends a text then reports the pong.
    assert.deepEqual(r.msgs, ['hello ✓ 😀', 'frag-part2', 'after-ping', 'pong:p1']);
    assert.deepEqual(r.close, [1000, 'bye', true]);
  });

  test('a 70 KB binary message round-trips intact and arrives as an ArrayBuffer', async () => {
    const port = 3054;
    const can = await bootServer(ECHO_SERVER.replace('PORT', String(port)));
    await can.browse('goto', `http://localhost:${port}/`);
    await can.browse('evaluate', `
      window.__b = null;
      const N = 70 * 1024;
      const src = new Uint8Array(N);
      for (let i = 0; i < N; i++) src[i] = (i * 7 + (i >> 8)) & 255;
      const ws = new WebSocket('ws://localhost:${port}/echo');
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(src.buffer);
      ws.onmessage = (e) => {
        const got = new Uint8Array(e.data);
        let firstBad = -1;
        for (let i = 0; i < N; i++) { if (got[i] !== src[i]) { firstBad = i; break; } }
        __b = { isArrayBuffer: e.data instanceof ArrayBuffer, length: got.length, firstBad };
        ws.close();
      };
    `);
    await until(can, 'window.__b !== null');
    const b = await can.browse('evaluate', 'window.__b');
    assert.equal(b.length, 70 * 1024);
    assert.equal(b.firstBad, -1, `first differing byte at ${b.firstBad}`);
    assert.equal(b.isArrayBuffer, true);
  });

  test('a server with no upgrade listener makes the page see error then close 1006, not a hang', async () => {
    const port = 3055;
    const can = await bootServer(NO_UPGRADE_SERVER.replace('PORT', String(port)));
    await can.browse('goto', `http://localhost:${port}/`);
    await can.browse('evaluate', `
      window.__d = { events: [] };
      const ws = new WebSocket('ws://localhost:${port}/');
      ws.onopen = () => __d.events.push('open');
      ws.onerror = (e) => __d.events.push('error');
      ws.onclose = (e) => { __d.events.push('close:' + e.code); __d.state = ws.readyState; __d.done = true; };
    `);
    await until(can, 'window.__d && window.__d.done');
    const d = await can.browse('evaluate', 'window.__d');
    assert.deepEqual(d.events, ['error', 'close:1006']);
    assert.equal(d.state, 3);
  });

  test('a wrong Sec-WebSocket-Accept fails the connection with close 1002', async () => {
    const port = 3057;
    const can = await bootServer(WRONG_ACCEPT_SERVER.replace('PORT', String(port)));
    await can.browse('goto', `http://localhost:${port}/`);
    await can.browse('evaluate', `
      window.__x = { events: [] };
      const ws = new WebSocket('ws://localhost:${port}/');
      ws.onopen = () => __x.events.push('open');
      ws.onerror = () => __x.events.push('error');
      ws.onclose = (e) => { __x.events.push('close:' + e.code); __x.done = true; };
    `);
    await until(can, 'window.__x && window.__x.done');
    const x = await can.browse('evaluate', 'window.__x');
    assert.deepEqual(x.events, ['error', 'close:1002']);
  });

  test('wss:// and a host other than the can fail with error then close 1006', async () => {
    const port = 3056;
    const can = await bootServer(ECHO_SERVER.replace('PORT', String(port)));
    await can.browse('goto', `http://localhost:${port}/`);
    await can.browse('evaluate', `
      window.__w = [];
      const a = new WebSocket('wss://localhost:${port}/');
      a.onerror = (e) => __w.push('wss:' + e.message);
      a.onclose = (e) => __w.push('wss-close:' + e.code);
      const b = new WebSocket('ws://example.com/');
      b.onerror = (e) => __w.push('host:' + e.message);
      b.onclose = (e) => __w.push('host-close:' + e.code);
    `);
    await until(can, 'window.__w && window.__w.length === 4');
    const w = await can.browse('evaluate', 'window.__w');
    assert.equal(w[1], 'wss-close:1006');
    assert.match(w[0], /^wss:wss:\/\/ is not supported/);
    assert.equal(w[3], 'host-close:1006');
    assert.match(w[2], /^host:example\.com is not a virtual host/);
  });
});

// The ws library itself (8.18.0, from the npm registry). It runs only with CAN_LIVE_TESTS=1, as the Express test does.
// Its send path once failed inside a can: a header buffer the library built reached the host socket as a proxy.
const LIVE = process.env.CAN_LIVE_TESTS === '1';
describe('the ws library 8.18.0 (needs the npm registry; CAN_LIVE_TESTS=1)', { skip: !LIVE && 'set CAN_LIVE_TESTS=1' }, () => {
  test('a ws server sends a text and a binary message on connect, and a raw client reads both frames', async () => {
    const can = await manager.create({ name: `wsecho-${++counter}` });
    const install = await can.exec('npm install ws@8.18.0', { timeout: 170_000 });
    assert.equal(install.exitCode, 0, install.stderr);
    await can.writeFile('/home/agent/echo.js', `
      const http = require('http');
      const net = require('net');
      const { WebSocketServer } = require('ws');
      const server = http.createServer((req, res) => res.end('page'));
      const wss = new WebSocketServer({ server });
      wss.on('connection', (ws) => {
        ws.send('hello text');
        ws.send(Buffer.from([1, 2, 3, 4]), { binary: true });
      });
      server.listen(3015, () => {
        const sock = net.connect(3015, 'localhost', () => {
          sock.write('GET / HTTP/1.1\\r\\nHost: localhost:3015\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n'
            + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n');
        });
        let got = Buffer.alloc(0);
        sock.on('data', (d) => {
          got = Buffer.concat([got, d]);
          const at = got.indexOf('\\r\\n\\r\\n');
          if (at < 0) return;
          // Server frames are unmasked: opcode, a length (7 bits, 16 bits or 64 bits), the payload.
          let body = got.subarray(at + 4);
          const frames = [];
          for (;;) {
            if (body.length < 2) break;
            let n = body[1] & 127;
            let off = 2;
            if (n === 126) { if (body.length < 4) break; n = body.readUInt16BE(2); off = 4; }
            if (body.length < off + n) break;
            frames.push({ op: body[0] & 15, hex: body.subarray(off, off + n).toString('hex') });
            body = body.subarray(off + n);
          }
          if (frames.length === 2) { console.log(JSON.stringify(frames)); process.exit(0); }
        });
      });
    `);
    const r = await can.exec('node echo.js', { timeout: 30_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    const frames = JSON.parse(r.stdout.trim());
    assert.deepEqual(frames, [
      { op: 1, hex: Buffer.from('hello text').toString('hex') },
      { op: 2, hex: '01020304' },
    ]);
  });
});
