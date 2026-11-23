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

// The ws library's shape: a sandbox class extends a host class (EventEmitter), and its instances hold host objects
// (the server, the socket) and call methods that write to them. Each of these failed before the membrane fix.
describe('a sandbox subclass of a host class, as the ws library uses it', () => {
  test('instances keep their own state, and a listener survives building another instance', async () => {
    const { r } = await runProgram(`
      const EE = require('events');
      class Server extends EE { constructor() { super(); this.tag = 'server'; } }
      class Conn extends EE { constructor(tag) { super(); this.tag = tag; } }
      const s = new Server();
      s.on('connection', () => console.log('listener fired'));
      const a = new Conn('a');
      const b = new Conn('b');
      console.log('tags', a.tag, b.tag, s.tag, 'listeners', s.listenerCount('connection'));
      s.emit('connection');
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /tags a b server listeners 1/);
    assert.match(r.stdout, /listener fired/);
  });

  test('a host object stored on an instance reads back as that same object', async () => {
    const { r } = await runProgram(`
      const EE = require('events');
      const http = require('http');
      class Holder extends EE { constructor(o) { super(); this.server = o.server; } }
      const srv = http.createServer(() => {});
      const h = new Holder({ server: srv });
      console.log('same server', h.server === srv, 'listen is a function', typeof h.server.listen);
      process.exit(0);
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /same server true listen is a function function/);
  });

  test('a method of an instance writes a sandbox Buffer, with a callback, to the upgrade socket the instance holds', async () => {
    const { r } = await runProgram(`
      const EE = require('events');
      const http = require('http');
      const net = require('net');
      class Conn extends EE {
        constructor(sock) { super(); this.sock = sock; }
        send(text) {
          // The header is built here, in the sandbox, as ws builds its frame header, then written as it is.
          const head = Buffer.from([0x81, text.length]);
          this.sock.write(head, () => {});
          this.sock.write(text, () => {});
        }
      }
      const srv = http.createServer(() => {});
      srv.on('upgrade', (req, sock) => { new Conn(sock).send('hi'); });
      srv.listen(3014, () => {
        const client = net.connect(3014, 'localhost', () => {
          client.write('GET / HTTP/1.1\\r\\nHost: x\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n');
        });
        let got = Buffer.alloc(0);
        client.on('data', (d) => {
          got = Buffer.concat([got, d]);
          if (got.length === 4) { console.log('received', got.toString('hex')); process.exit(0); }
        });
      });
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    // Both bytes arrive only if both writes reached the socket, so the bytes are the proof.
    assert.match(r.stdout, /received 81026869/);
  });
});
