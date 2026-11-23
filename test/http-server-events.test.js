// The can's http server, as node exposes it: a server with no handler answers through 'request' listeners, a handler
// given to createServer is one such listener, listen accepts the options object, and a POST body reaches a 'request'
// listener. Forms the can cannot honour (a unix path, an address other than loopback) are refused. Same setup as
// test/boot-frameworks.test.js.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-http-events-'));
const manager = new CanManager({ storeDir: path.join(tmp, 'store'), mountsFile: path.join(tmp, 'none.json') });
let counter = 0;

after(async () => {
  await manager.destroyAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function bootServer(source) {
  const can = await manager.create({ name: `http-events-${++counter}` });
  await can.writeFile('/home/agent/server.js', source);
  const proc = await can.spawn('node server.js');
  // Wait until the server has printed its ready line (or the timeout passes).
  for (let i = 0; i < 100; i++) {
    const out = String(await can.logs(proc.pid, 'stdout'));
    if (out.includes('ready')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return { can, proc };
}

describe("a server with no handler", () => {
  test("answers through a 'request' listener added after createServer()", async () => {
    const { can } = await bootServer(`
      const http = require('http');
      const srv = http.createServer();
      srv.on('request', (req, res) => res.end('via request event ' + req.method + ' ' + req.url));
      srv.listen(3040, () => console.log('ready'));
    `);
    const r = await can.request({ port: 3040, method: 'GET', path: '/a?b=1', timeout: 10_000 });
    assert.equal(r.status, 200);
    assert.equal(String(r.body), 'via request event GET /a?b=1');
  });
});

describe('listen with an options object', () => {
  test('listen({port, host, backlog}, cb) serves on that port and calls the callback', async () => {
    const { can } = await bootServer(`
      const http = require('http');
      const srv = http.createServer((req, res) => res.end('options ok'));
      srv.listen({ port: 3041, host: '127.0.0.1', backlog: 511 }, () => console.log('ready ' + srv.address().port));
    `);
    const r = await can.request({ port: 3041, path: '/', timeout: 10_000 });
    assert.equal(String(r.body), 'options ok');
  });
});

describe('a handler passed to createServer', () => {
  test('still answers requests on its own', async () => {
    const { can } = await bootServer(`
      const http = require('http');
      const srv = http.createServer((req, res) => res.end('handler ok'));
      srv.listen(3042, () => console.log('ready'));
    `);
    const r = await can.request({ port: 3042, path: '/', timeout: 10_000 });
    assert.equal(String(r.body), 'handler ok');
  });

  test("runs alongside a 'request' listener added later: both fire", async () => {
    const { can } = await bootServer(`
      const http = require('http');
      const srv = http.createServer((req, res) => res.setHeader('x-first', 'yes'));
      srv.on('request', (req, res) => res.end('second'));
      srv.listen(3043, () => console.log('ready'));
    `);
    const r = await can.request({ port: 3043, path: '/', timeout: 10_000 });
    assert.equal(r.headers['x-first'], 'yes');
    assert.equal(String(r.body), 'second');
  });
});

describe("a POST body through a 'request' listener", () => {
  test('the body arrives in full, with the Content-Length the client sent', async () => {
    const { can } = await bootServer(`
      const http = require('http');
      const srv = http.createServer();
      srv.on('request', (req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c) => { body += c; });
        req.on('end', () => res.end(req.headers['content-length'] + ':' + req.method + ':' + body));
      });
      srv.listen(3044, () => console.log('ready'));
    `);
    const r = await can.request({ port: 3044, method: 'POST', path: '/', body: 'hello body', timeout: 10_000 });
    assert.equal(String(r.body), '10:POST:hello body');
  });
});

describe('listen forms the can refuses', () => {
  test('a unix path and a non-loopback address throw ENOTSUP or EADDRNOTAVAIL before anything listens', async () => {
    const can = await manager.create({ name: `http-events-${++counter}` });
    await can.writeFile('/home/agent/refuse.js', `
      const http = require('http');
      const srv = http.createServer(() => {});
      const calls = [
        () => srv.listen('/tmp/app.sock'),
        () => srv.listen({ path: '/tmp/app.sock' }),
        () => srv.listen(3045, '10.1.2.3'),
      ];
      const codes = calls.map((call) => { try { call(); return 'no-error'; } catch (e) { return e.code; } });
      console.log(codes.join(','));
    `);
    const r = await can.exec('node refuse.js', { timeout: 30_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'ENOTSUP,ENOTSUP,EADDRNOTAVAIL');
  });
});
