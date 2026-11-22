// Isolation hardening (SPEC.md section 10.2b and 10.4):
// - no can can open a listening socket on a host port, even if a host `net` module leaked into can code
// - two cans have their own filesystems, environments, processes and virtual ports, and one cannot touch the other
// - a can's heap is capped and a foreground command has a default time limit
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CanManager } from '../src/manager.js';
import { Machine } from '../src/vm/machine.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(TEST_DIR, '..', 'src');

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-iso-'));
const scratch = [storeDir];
const managers = [];

function newManager(opts = {}) {
  const m = new CanManager({ storeDir, ...opts });
  managers.push(m);
  return m;
}

after(async () => {
  for (const m of managers) await m.destroyAll();
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

async function until(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** True if something on the host accepts a TCP connection on 127.0.0.1:port. */
function hostAccepts(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/** A TCP port that is free right now on the host (found by binding and releasing it). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function runProbe(can, src) {
  await can.writeFile('/home/agent/probe.js', src);
  return can.exec('node probe.js', { timeout: 15_000 });
}

// ---------------------------------------------------------------- the guard, in a process of its own

describe('the listen guard (guards.js) inside a process that loads it', () => {
  let port;
  let selfServer;
  let selfPort;
  let report;

  before(async () => {
    // A host server that the helper may reach as a client (outbound), but may not have listened for.
    selfServer = http.createServer((req, res) => res.end('host says hi'));
    await new Promise((r) => selfServer.listen(0, '127.0.0.1', r));
    selfPort = selfServer.address().port;
    port = await freePort();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-guard-'));
    scratch.push(dir);
    const helper = path.join(dir, 'helper.mjs');
    fs.writeFileSync(helper, `
      import net from 'node:net';
      import http from 'node:http';
      import dgram from 'node:dgram';
      import { denyHostListening } from ${JSON.stringify(pathToFileURL(path.join(SRC, 'vm', 'guards.js')).href)};
      denyHostListening();
      denyHostListening();
      const [port, selfPort] = process.argv.slice(2).map(Number);
      const out = {};
      const attempt = (name, fn) => {
        try { fn(); out[name] = 'LISTENING'; } catch (e) { out[name] = e.code; }
      };
      attempt('net.createServer', () => net.createServer().listen(port, '127.0.0.1'));
      attempt('net.Server', () => new net.Server().listen(port, '127.0.0.1'));
      attempt('http.createServer', () => http.createServer().listen(port, '127.0.0.1'));
      attempt('dgram.bind', () => new dgram.Socket('udp4').bind(port));
      attempt('dgram.createSocket', () => dgram.createSocket('udp4'));
      try { net.Server.prototype.listen = () => {}; out.overwrite = 'REPLACED'; } catch (e) { out.overwrite = e.name; }
      attempt('after the overwrite attempt', () => new net.Server().listen(port, '127.0.0.1'));
      out.outbound = await new Promise((resolve) => {
        http.get('http://127.0.0.1:' + selfPort + '/', (res) => {
          let body = '';
          res.on('data', (d) => { body += d; });
          res.on('end', () => resolve(body));
        }).on('error', (e) => resolve('error ' + e.code));
      });
      console.log(JSON.stringify(out));
    `);
    const child = spawn(process.execPath, [helper, String(port), String(selfPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(stderr, '', 'the helper must run cleanly');
    report = JSON.parse(stdout.trim().split('\n').at(-1));
  });

  after(() => { selfServer?.close(); });

  test('net, http and dgram refuse to listen or bind, with EPERM', () => {
    for (const name of ['net.createServer', 'net.Server', 'http.createServer', 'dgram.bind', 'dgram.createSocket']) {
      assert.equal(report[name], 'EPERM', `${name}: ${JSON.stringify(report)}`);
    }
  });

  test('the guards cannot be overwritten or removed', () => {
    assert.equal(report.overwrite, 'TypeError');
    assert.equal(report['after the overwrite attempt'], 'EPERM');
  });

  test('no host port was opened by the attempts', async () => {
    assert.equal(await hostAccepts(port), false);
  });

  test('outbound connections still work (the browser and curl use them)', () => {
    assert.equal(report.outbound, 'host says hi');
  });
});

// ---------------------------------------------------------------- a leaked host net, membrane off

describe('a leaked host net module cannot listen on a host port (layer 1 only, membrane off)', () => {
  let manager;
  let can;

  before(async () => {
    manager = newManager({ layer2: false });
    can = await manager.create({ name: 'leak-probe' });
  });

  test('every listen route through the leaked modules is refused and no host port opens', async () => {
    const port = await freePort();
    const r = await runProbe(can, `
      'use strict';
      const host = require('path').resolve.constructor('return process')();
      const net = host.getBuiltinModule('net');
      const http = host.getBuiltinModule('http');
      const https = host.getBuiltinModule('https');
      const dgram = host.getBuiltinModule('dgram');
      const PORT = ${port};
      const out = [];
      const attempt = (name, fn) => {
        try { fn(); out.push(name + ' LISTENING'); } catch (e) { out.push(name + ' ' + e.code); }
      };
      attempt('net.createServer', () => net.createServer().listen(PORT, '127.0.0.1'));
      attempt('new net.Server', () => new net.Server().listen(PORT, '127.0.0.1'));
      attempt('http.createServer', () => http.createServer().listen(PORT, '127.0.0.1'));
      attempt('https.createServer', () => https.createServer().listen(PORT, '127.0.0.1'));
      attempt('dgram bind', () => new dgram.Socket('udp4').bind(PORT));
      try { net.Server.prototype.listen = function () { return this; }; out.push('overwrite REPLACED'); }
      catch (e) { out.push('overwrite ' + e.name); }
      attempt('after overwrite', () => new net.Server().listen(PORT, '127.0.0.1'));
      console.log(out.join('\\n'));
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 7, r.stdout);
    for (const line of lines) assert.doesNotMatch(line, /LISTENING|REPLACED/, line);
    assert.match(r.stdout, /net\.createServer EPERM/);
    assert.match(r.stdout, /overwrite TypeError/);
    assert.equal(await hostAccepts(port), false, 'no host port may be open');
  });
});

// ---------------------------------------------------------------- outbound from a hardened can

describe('outbound network from a hardened can', () => {
  let manager;
  let can;
  let hostServer;
  let hostPort;

  before(async () => {
    manager = newManager();
    can = await manager.create({ name: 'outbound' });
    hostServer = http.createServer((req, res) => res.end('from the real network'));
    await new Promise((resolve, reject) => {
      hostServer.once('error', reject);
      hostServer.listen(0, '127.0.0.2', resolve);
    }).then(() => { hostPort = hostServer.address().port; }, () => { hostServer = null; });
  });

  after(() => { hostServer?.close(); });

  test('a can reaches a non-local host over the real network; local names stay virtual', async (t) => {
    if (!hostServer) return t.skip('cannot bind 127.0.0.2 on this host');
    const r = await runProbe(can, `
      require('http').get('http://127.0.0.2:${hostPort}/', (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => console.log('outbound', res.statusCode, body));
      });
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'outbound 200 from the real network');
  });

  test('net reaches only the can: a connection to a host address is refused', async () => {
    const r = await runProbe(can, `
      const net = require('net');
      const s = net.connect({ port: 22, host: '203.0.113.7' });
      s.on('error', (e) => console.log(e.code));
    `);
    assert.equal(r.stdout.trim(), 'ENOTSUP');
  });
});

// ---------------------------------------------------------------- two cans side by side

describe('two cans cannot see or reach each other', () => {
  let manager;
  let alpha;
  let beta;
  let alphaPid;

  before(async () => {
    manager = newManager();
    alpha = await manager.create({ name: 'alpha', env: { TOKEN: 'alpha-token' } });
    beta = await manager.create({ name: 'beta' });
    await alpha.writeFile('/app/secret.txt', 'alpha-secret');
    await beta.writeFile('/app/secret.txt', 'beta-secret');
    await alpha.writeFile('/app/alpha-only.txt', 'x');
    const server = (who, extra = '') => `
      const http = require('http');
      const fs = require('fs');
      ${extra}
      http.createServer((req, res) => {
        res.end('${who} ' + fs.readFileSync('/app/secret.txt', 'utf8'));
      }).listen(8080, () => console.log('${who} up'));
    `;
    await alpha.writeFile('/app/server.js', server('alpha', "require('http').createServer((q, s) => s.end('side')).listen(9090);"));
    await beta.writeFile('/app/server.js', server('beta'));
    alphaPid = (await alpha.spawn('node server.js alpha-marker', { cwd: '/app', background: true })).pid;
    await beta.spawn('node server.js beta-marker', { cwd: '/app', background: true });
    await until(async () => (await alpha.listeners()).some((l) => l.port === 9090) && (await beta.listeners()).some((l) => l.port === 8080));
  });

  after(async () => {
    await manager.destroyAll();
  });

  test('both cans listen on the same port 8080, each on its own virtual network', async () => {
    assert.ok((await alpha.listeners()).some((l) => l.port === 8080));
    assert.ok((await beta.listeners()).some((l) => l.port === 8080));
    assert.equal((await alpha.request({ port: 8080, path: '/' })).body.toString(), 'alpha alpha-secret');
    assert.equal((await beta.request({ port: 8080, path: '/' })).body.toString(), 'beta beta-secret');
  });

  test('a port that only alpha listens on is refused from inside beta', async () => {
    const r = await runProbe(beta, `
      require('http').get('http://localhost:9090/', () => console.log('REACHED'))
        .on('error', (e) => console.log('refused', e.code));
    `);
    assert.equal(r.stdout.trim(), 'refused ECONNREFUSED');
    assert.deepEqual((await beta.listeners()).map((l) => l.port), [8080]);
  });

  test('files written in one can are absent from the other, and writes do not cross', async () => {
    assert.equal(await beta.readFile('/app/secret.txt', 'utf8'), 'beta-secret');
    assert.equal(await alpha.readFile('/app/secret.txt', 'utf8'), 'alpha-secret');
    assert.equal(await beta.exists('/app/alpha-only.txt'), false);
    const r = await beta.exec('cat /app/alpha-only.txt');
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /ENOENT/);
  });

  test('environment variables stay with their can', async () => {
    assert.equal((await alpha.exec('echo "[$TOKEN]"')).stdout, '[alpha-token]\n');
    assert.equal((await beta.exec('echo "[$TOKEN]"')).stdout, '[]\n');
  });

  test('processes are per can: each can lists only its own process table', async () => {
    assert.ok(alphaPid > 0);
    const betaCommands = (await beta.ps()).map((p) => p.command).join(' | ');
    const alphaCommands = (await alpha.ps()).map((p) => p.command).join(' | ');
    assert.match(betaCommands, /beta-marker/);
    assert.doesNotMatch(betaCommands, /alpha-marker/);
    assert.match(alphaCommands, /alpha-marker/);
    assert.doesNotMatch(alphaCommands, /beta-marker/);
    assert.ok((await alpha.ps()).some((p) => p.pid === alphaPid));
  });

  test('destroying beta leaves alpha running and reachable', async () => {
    await manager.destroy('beta');
    assert.equal(beta.status, 'destroyed');
    assert.equal((await alpha.request({ port: 8080, path: '/' })).body.toString(), 'alpha alpha-secret');
    assert.equal((await alpha.request({ port: 9090, path: '/' })).body.toString(), 'side');
  });
});

// ---------------------------------------------------------------- resource limits

describe('resource limits: default command timeout and heap cap', () => {
  test('a foreground command without a timeout is cut off by the machine default', async () => {
    const m = new Machine({ id: 'limit-default', execTimeoutMs: 300 });
    try {
      const r = await m.exec('node -e "setInterval(() => {}, 50)"');
      assert.equal(r.timedOut, true);
      assert.equal(r.exitCode, 124);
    } finally {
      m.destroy();
    }
  });

  test('the default is 60 seconds and an explicit 0 means no limit', () => {
    assert.equal(new Machine({ id: 'limit-check' }).execTimeoutMs, 60_000);
    assert.equal(new Machine({ id: 'limit-check2', execTimeoutMs: 0 }).execTimeoutMs, 0);
  });

  test('a can that exhausts its heap is stopped with memory-limit (ENOMEM) alone; another can keeps working', async () => {
    const manager = newManager();
    const hog = await manager.create({ name: 'hog' });
    const neighbour = await manager.create({ name: 'neighbour' });
    await assert.rejects(
      hog.exec(`node -e "const a = []; for (;;) a.push('x'.repeat(1000000))"`, { timeout: 60_000 }),
      { code: 'ENOMEM' },
    );
    await until(() => hog.status === 'memory-limit');
    assert.equal((await neighbour.exec('echo still here')).stdout, 'still here\n');
    assert.equal(neighbour.status, 'running');
    await manager.destroy('hog');
  });
});

describe('worker threads are not available to can code', () => {
  // --allow-worker lets the VM process start workers (wasm runs in one), so the refusal of can code rests on the
  // built-in module allowlist (src/runtime/modules.js). These tests check that refusal from can code.
  test('require of worker_threads, with or without the node: prefix, is refused', async () => {
    const manager = newManager();
    const can = await manager.create({ name: 'no-workers' });
    await can.writeFile('/home/agent/workers.js', `
      for (const m of ['worker_threads', 'node:worker_threads']) {
        try { require(m); console.log('loaded', m); } catch (e) { console.log('refused', m, String(e.message).slice(0, 60)); }
      }
    `);
    const r = await can.exec('node workers.js', { timeout: 30_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /loaded/);
    assert.match(r.stdout, /refused worker_threads Cannot find module 'worker_threads'/);
    assert.match(r.stdout, /refused node:worker_threads Cannot find module 'node:worker_threads'/);
  });

  test('a Worker cannot be created from can code', async () => {
    const manager = newManager();
    const can = await manager.create({ name: 'no-worker-ctor' });
    await can.writeFile('/home/agent/ctor.js', `
      try { console.log('global Worker', typeof Worker); } catch (e) { console.log('global Worker error', e.message); }
      try { console.log('module.createRequire worker', typeof require('module').createRequire(__filename)('worker_threads').Worker); }
      catch (e) { console.log('createRequire refused', String(e.message).slice(0, 60)); }
    `);
    const r = await can.exec('node ctor.js', { timeout: 30_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /global Worker undefined/);
    assert.doesNotMatch(r.stdout, /worker function|worker object/);
    assert.match(r.stdout, /createRequire refused Cannot find module 'worker_threads'/);
  });
});
