// What a web framework needs from a can to boot and serve requests. These cover the four faults that kept Express
// from working in a can (see SPEC.md section 14): the request body needs a Content-Length, the request needs a live
// socket and an unfinished message, host getters must still see their host state after Express replaces a request's
// prototype, and a program that only awaits promises must run to the end of its work. The live Express test needs
// the npm registry and runs only with CAN_LIVE_TESTS=1.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-boot-'));
const manager = new CanManager({ storeDir: path.join(tmp, 'store'), mountsFile: path.join(tmp, 'none.json') });
let counter = 0;

after(async () => {
  await manager.destroyAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function bootServer(source) {
  const can = await manager.create({ name: `boot-${++counter}` });
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

describe('a request body through the can', () => {
  test('a POST body arrives at the server, with a Content-Length it can read', async () => {
    const { can } = await bootServer(`
      const http = require('http');
      const srv = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c) => { body += c; });
        req.on('end', () => res.end(req.headers['content-length'] + ':' + body));
      });
      srv.listen(3020, () => console.log('ready'));
    `);
    const r = await can.request({ port: 3020, method: 'POST', path: '/', body: 'hello body', timeout: 10_000 });
    assert.equal(String(r.body), '10:hello body');
  });
});

describe('the request object a framework receives', () => {
  test('the request is readable, unfinished, and has a live socket that can be listened to', async () => {
    const { can } = await bootServer(`
      const http = require('http');
      const srv = http.createServer((req, res) => {
        const info = {
          readable: req.readable,
          writableEnded: req.writableEnded,
          socketReadable: req.socket.readable,
          socketWritable: req.socket.writable,
          socketOn: typeof req.socket.on,
        };
        res.end(JSON.stringify(info));
      });
      srv.listen(3021, () => console.log('ready'));
    `);
    const r = await can.request({ port: 3021, method: 'POST', path: '/', body: 'x', timeout: 10_000 });
    assert.deepEqual(JSON.parse(String(r.body)), {
      readable: true, writableEnded: false, socketReadable: true, socketWritable: true, socketOn: 'function',
    });
  });

  test('a host getter still reads the host state after a sandbox prototype replaces the prototype', async () => {
    // Express 5 does exactly this to each request: Object.setPrototypeOf(req, appRequest).
    const { can } = await bootServer(`
      const http = require('http');
      const srv = http.createServer((req, res) => {
        const appRequest = Object.create(Object.create(http.IncomingMessage.prototype));
        Object.setPrototypeOf(req, appRequest);
        res.end(String(req.readable));
      });
      srv.listen(3022, () => console.log('ready'));
    `);
    const r = await can.request({ port: 3022, method: 'GET', path: '/', timeout: 10_000 });
    assert.equal(String(r.body), 'true');
  });
});

describe('a program that only awaits', () => {
  test('finishes the work its promises queue, then exits with code 0', async () => {
    const can = await manager.create({ name: `boot-${++counter}` });
    await can.writeFile('/home/agent/await.js', `
      const steps = [];
      (async () => {
        for (let i = 0; i < 3; i++) {
          await null;
          steps.push(i);
        }
        console.log('steps', steps.join(','));
      })();
    `);
    const r = await can.exec('node await.js', { timeout: 30_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'steps 0,1,2');
  });

  test('a promise that never settles does not keep the program alive', async () => {
    const can = await manager.create({ name: `boot-${++counter}` });
    await can.writeFile('/home/agent/forever.js', `
      console.log('start');
      new Promise(() => {});
    `);
    const r = await can.exec('node forever.js', { timeout: 30_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'start');
  });
});

const LIVE = process.env.CAN_LIVE_TESTS === '1';

describe('Express 5 (needs the npm registry; CAN_LIVE_TESTS=1)', { skip: !LIVE && 'set CAN_LIVE_TESTS=1' }, () => {
  test('an Express app boots, parses JSON and form bodies, routes params, and answers 404', async () => {
    const can = await manager.create({ name: `boot-${++counter}` });
    const install = await can.exec('mkdir -p /app && cd /app && npm init -y >/dev/null && npm install express', { timeout: 600_000 });
    assert.equal(install.exitCode, 0, install.stderr);
    await can.writeFile('/app/server.js', `
      const express = require('express');
      const app = express();
      const items = new Map();
      app.use(express.json());
      app.use(express.urlencoded({ extended: false }));
      app.get('/', (req, res) => res.send('hello from express'));
      app.get('/api/items/:id', (req, res) => {
        const it = items.get(req.params.id);
        if (!it) return res.status(404).json({ error: 'nope' });
        res.json(it);
      });
      app.post('/api/items', (req, res) => { items.set(req.body.id, req.body); res.status(201).json(req.body); });
      app.post('/form', (req, res) => res.send('form:' + req.body.name));
      app.listen(3000, () => console.log('ready'));
    `);
    await can.spawn('node server.js', { cwd: '/app' });
    await new Promise((r) => setTimeout(r, 1500));
    const get = (p) => can.request({ port: 3000, path: p, timeout: 10_000 });
    const post = (p, type, body) => can.request({
      port: 3000, method: 'POST', path: p, headers: { 'content-type': type }, body, timeout: 10_000,
    });
    assert.equal((await get('/')).status, 200);
    const created = await post('/api/items', 'application/json', JSON.stringify({ id: 'a1', name: 'widget' }));
    assert.equal(created.status, 201);
    assert.deepEqual(JSON.parse(String((await get('/api/items/a1')).body)), { id: 'a1', name: 'widget' });
    assert.equal((await get('/api/items/zz')).status, 404);
    assert.equal(String((await post('/form', 'application/x-www-form-urlencoded', 'name=ada')).body), 'form:ada');
    assert.equal((await get('/nothing')).status, 404);
  });
});
