// Host objects inside a can: the cases the membrane must handle without losing the can. A process.exit() inside a
// callback that host code runs (a response's 'end' event) ends that program with its code and leaves the VM alive.
// Express-style code may set the prototype of a request object to its own sandbox object; a host prototype is
// still refused. The http module exports the classes frameworks build on (IncomingMessage, ServerResponse).
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-membrane-'));
const manager = new CanManager({ storeDir: path.join(tmp, 'store'), mountsFile: path.join(tmp, 'none.json') });
let counter = 0;

after(async () => {
  await manager.destroyAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function runProgram(source) {
  const can = await manager.create({ name: `membrane-${++counter}` });
  await can.writeFile('/home/agent/prog.js', source);
  const r = await can.exec('node prog.js', { timeout: 30_000 });
  return { can, r };
}

describe('process.exit inside host callbacks', () => {
  test('exit inside a response callback ends the program with its code, and the can survives', async () => {
    const { can, r } = await runProgram(`
      const http = require('http');
      const srv = http.createServer((req, res) => res.end('hi'));
      srv.listen(3010, () => {
        http.get('http://localhost:3010/', (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => { console.log('got', res.statusCode, body); process.exit(3); });
        });
      });
    `);
    assert.equal(r.exitCode, 3, r.stderr);
    assert.match(r.stdout, /got 200 hi/);
    assert.equal(can.status, 'running', 'the can VM is still running');
    const after = await can.exec('echo still here');
    assert.equal(after.stdout, 'still here\n');
  });
});

describe('http classes frameworks build on', () => {
  test('IncomingMessage and ServerResponse are exported, and a request accepts a sandbox prototype', async () => {
    const { r } = await runProgram(`
      const http = require('http');
      console.log(typeof http.IncomingMessage, typeof http.ServerResponse, typeof http.OutgoingMessage);
      const framework = { hello() { return 'from the framework'; } };
      const srv = http.createServer((req, res) => {
        Object.setPrototypeOf(req, framework);
        res.end(req.hello() + ' ' + (req.method));
      });
      srv.listen(3011, () => {
        http.get('http://localhost:3011/', (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => { console.log(body); process.exit(0); });
        });
      });
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /function function function/);
    assert.match(r.stdout, /from the framework GET/);
  });

  test('a host prototype is still refused as a new prototype', async () => {
    const { r } = await runProgram(`
      const http = require('http');
      const srv = http.createServer((req, res) => {
        try { Object.setPrototypeOf(req, http.ServerResponse.prototype); console.log('accepted'); }
        catch (e) { console.log('refused'); }
        res.end('x');
      });
      srv.listen(3012, () => {
        http.get('http://localhost:3012/', (res) => { res.resume(); res.on('end', () => process.exit(0)); });
      });
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /refused/);
  });
});

describe('a sandbox prototype on a host object reaches no host intrinsic', () => {
  test('constructor chains from a re-prototyped request end in sandbox code', async () => {
    const { r } = await runProgram(`
      const http = require('http');
      const srv = http.createServer((req, res) => {
        Object.setPrototypeOf(req, { own: 1 });
        const reached = [];
        const probe = (label, fn) => { try { reached.push(label + '=' + fn()); } catch (e) { reached.push(label + ':threw'); } };
        probe('proto.constructor', () => typeof Object.getPrototypeOf(req).constructor);
        probe('req.constructor', () => typeof req.constructor);
        probe('req.__proto__', () => String(req.__proto__ === undefined));
        probe('fnFromCtor', () => req.constructor.constructor('return typeof process')());
        probe('ownFromProto', () => req.own);
        console.log(reached.join(' '));
        res.end('x');
      });
      srv.listen(3013, () => {
        http.get('http://localhost:3013/', (res) => { res.resume(); res.on('end', () => process.exit(0)); });
      });
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /fnFromCtor=(object|undefined|function)/);
    assert.match(r.stdout, /fnFromCtor:threw/);
    assert.match(r.stdout, /ownFromProto=1/);
  });
});
