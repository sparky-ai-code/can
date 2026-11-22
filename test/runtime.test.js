import { describe, test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';
import { Machine } from '../src/vm/machine.js';
import { tokenize, parse, expandWord, makeShell } from '../src/runtime/shell.js';

// Every can here is its own VM process. Each test file gets one manager and one store directory.
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-rt-'));
const manager = new CanManager({ storeDir });
let counter = 0;
async function makeCan() {
  return manager.create({ name: `rt-${++counter}`, env: { HOME: '/home/agent' } });
}
after(async () => {
  await manager.destroyAll();
  fs.rmSync(storeDir, { recursive: true, force: true });
});

const sh = (can, cmd) => can.exec(cmd, { timeout: 10_000 });

/** Waits until an (async) predicate holds, polling every 10 ms. */
async function until(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('shell parser', () => {
  test('tokenizes quotes, variables, redirects and operators', () => {
    const toks = tokenize('echo "a b" \'$X\' ${Y}z 2>&1 >> f && g || h | i & j; k');
    assert.deepEqual(toks.map((t) => (t.t === 'op' ? t.v : t.t === 'redir' ? t.op : 'w')),
      ['w', 'w', 'w', 'w', '>&', 'w', '>>', 'w', '&&', 'w', '||', 'w', '|', 'w', '&', 'w', ';', 'w']);
    assert.equal(toks[4].fd, 2);
  });

  test('parse reports syntax errors and keeps background entry text', () => {
    assert.throws(() => parse('echo |'), /syntax error near unexpected token 'newline'/);
    assert.throws(() => parse('> '), /syntax error/);
    const entries = parse('sleep 9 & echo x');
    assert.equal(entries[0].sep, '&');
    assert.equal(entries[0].text, 'sleep 9');
    assert.equal(entries[1].sep, null);
  });

  test('expansion: quoting, $? and unquoted splitting', () => {
    // Expansion is pure host-side code, so an in-process Machine (no VM process) is enough here.
    const can = new Machine({ id: 'expansion-test' });
    const shell = makeShell({ can, pid: 0, cwd: '/home/agent', env: { A: 'x  y', E: '' } });
    const word = (s) => parse(`echo ${s}`)[0].node.first[0].words[1];
    assert.deepEqual(expandWord(word('$A'), shell), ['x', 'y']);
    assert.deepEqual(expandWord(word('"$A"'), shell), ['x  y']);
    assert.deepEqual(expandWord(word('"$E"'), shell), ['']);
    assert.deepEqual(expandWord(word('$E'), shell), []);
    assert.deepEqual(expandWord(word("'$A'"), shell), ['$A']);
  });
});

describe('shell execution', () => {
  test('pipes, redirects, && || ; and exit status', async () => {
    const can = await makeCan();
    assert.equal((await sh(can, 'echo hi | cat')).stdout, 'hi\n');
    await sh(can, 'echo one > f.txt; echo two >> f.txt');
    assert.equal(await can.readFile('/home/agent/f.txt', 'utf8'), 'one\ntwo\n');
    assert.equal((await sh(can, 'cat < f.txt | wc -l')).stdout.trim(), '2');
    const r = await sh(can, 'false && echo no || echo yes; echo done');
    assert.equal(r.stdout, 'yes\ndone\n');
    const e = await sh(can, 'ls /missing 2>&1');
    assert.equal(e.exitCode, 1);
    assert.match(e.stdout, /ENOENT/);
    assert.equal((await sh(can, 'nosuchcmd')).exitCode, 127);
  });

  test('globbing over the VFS and variable expansion', async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p src && touch src/a.js src/b.js src/c.txt .hidden.js');
    assert.equal((await sh(can, 'echo src/*.js')).stdout, 'src/a.js src/b.js\n');
    assert.equal((await sh(can, 'echo nomatch*.zzz')).stdout, 'nomatch*.zzz\n');
    assert.equal((await sh(can, 'cd src && echo *.js')).stdout, 'a.js b.js\n', 'dot-files are not matched by *');
    // Each exec is its own process with its own env copy, so assignments and exports stay in one line.
    assert.equal((await sh(can, 'export GREET=hello; echo "$GREET ${GREET}!" $?')).stdout, 'hello hello! 0\n');
  });

  test('builtins: fs operations and text tools', async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p proj/inner && echo alpha > proj/a.txt && echo BETA > proj/inner/b.txt');
    assert.equal((await sh(can, 'cat proj/a.txt')).stdout, 'alpha\n');
    assert.equal((await sh(can, 'grep -i beta proj/inner/b.txt')).stdout, 'BETA\n');
    assert.equal((await sh(can, 'grep -v alpha proj/a.txt')).exitCode, 1);
    assert.equal((await sh(can, 'grep -n a proj/a.txt')).stdout, '1:alpha\n');
    assert.equal((await sh(can, 'find proj -name "*.txt"')).stdout, 'proj/a.txt\nproj/inner/b.txt\n');
    assert.equal((await sh(can, 'sed s/alpha/omega/ proj/a.txt')).stdout, 'omega\n');
    assert.equal((await sh(can, 'head -n 1 proj/a.txt')).stdout, 'alpha\n');
    assert.equal((await sh(can, 'cp -r proj copy')).exitCode, 0);
    assert.equal(await can.readFile('/home/agent/copy/inner/b.txt', 'utf8'), 'BETA\n');
    await sh(can, 'mv copy moved && rm -rf proj');
    assert.equal(await can.exists('/home/agent/proj'), false);
    assert.equal(await can.exists('/home/agent/moved/a.txt'), true);
    assert.equal((await sh(can, 'cd moved && pwd')).stdout, '/home/agent/moved\n');
    assert.equal((await sh(can, 'cd moved && wc -l a.txt')).stdout.trim(), '1 a.txt');
    assert.equal((await sh(can, 'cd moved && sort a.txt inner/b.txt | uniq -c')).stdout.trim().split('\n').length, 2);
    assert.equal((await sh(can, 'env')).stdout.includes('HOME=/home/agent'), true);
    assert.equal((await sh(can, 'which ls')).stdout, '/usr/bin/ls\n');
  });

  test('npm run executes package.json scripts; npm install is refused when the network is off', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/package.json', JSON.stringify({ name: 'demo', scripts: { hello: 'echo from-script' } }));
    const r = await sh(can, 'npm run hello');
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /from-script/);
    // Installs reach the registry (see test/npm.test.js); an offline can refuses them with the reason.
    const offline = await manager.create({ name: `rt-offline-${++counter}`, environment: { network: { internet: false } } });
    await offline.writeFile('/home/agent/package.json', JSON.stringify({ name: 'demo', dependencies: { 'left-pad': '1.3.0' } }));
    const i = await sh(offline, 'npm install');
    assert.equal(i.exitCode, 1);
    assert.match(i.stderr, /network access is off/);
  });
});

describe('javascript runtime', () => {
  test('fs sync, callback and promises APIs operate on the VFS', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/fs.js', `
      const fs = require('fs');
      fs.mkdirSync('out/deep', { recursive: true });
      fs.writeFileSync('out/deep/x.txt', 'sync');
      console.log(fs.readFileSync('out/deep/x.txt', 'utf8'), fs.existsSync('out/nope'), fs.readdirSync('out'));
      fs.readFile('/home/agent/out/deep/x.txt', 'utf8', (err, data) => console.log('cb', err, data));
      fs.promises.readFile('out/deep/x.txt', 'utf8').then((d) => console.log('promise', d));
      try { fs.readFileSync('/nope'); } catch (e) { console.log('code', e.code); }
    `);
    const r = await sh(can, 'node fs.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /sync false \[ 'deep' \]/);
    assert.match(r.stdout, /cb null sync/);
    assert.match(r.stdout, /promise sync/);
    assert.match(r.stdout, /code ENOENT/);
    assert.equal(await can.readFile('/home/agent/out/deep/x.txt', 'utf8'), 'sync');
  });

  test('require resolves relative files, index.js, package main and node_modules inside the VFS', async () => {
    const can = await makeCan();
    await can.mkdir('/app/lib/util', { recursive: true });
    await can.mkdir('/app/node_modules/dep', { recursive: true });
    await can.writeFile('/app/lib/util/index.js', 'module.exports = { add: (a, b) => a + b };');
    await can.writeFile('/app/lib/value.js', 'exports.v = 42;');
    await can.writeFile('/app/lib/data.json', '{"k": "json"}');
    await can.writeFile('/app/node_modules/dep/package.json', '{"main": "lib/main.js"}');
    await can.mkdir('/app/node_modules/dep/lib', { recursive: true });
    await can.writeFile('/app/node_modules/dep/lib/main.js', 'module.exports = "dep:" + require("../../../lib/value.js").v;');
    await can.writeFile('/app/main.js', `
      const u = require('./lib/util');
      const v = require('./lib/value');
      const d = require('./lib/data.json');
      console.log(u.add(2, 3), v.v, d.k, require('dep'));
      console.log(require('path').basename(__filename), require.resolve('./lib/value') === '/app/lib/value.js');
    `);
    const r = await sh(can, 'cd /app && node main.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, "5 42 json dep:42\nmain.js true\n");
  });

  test('unlisted and dangerous built-ins are refused with a clear error', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/bad.js', `
      for (const m of ['worker_threads', 'dgram', 'vm', 'inspector']) {
        try { require(m); console.log('loaded', m); } catch (e) { console.log(e.message.split(':')[0]); }
      }
    `);
    const r = await sh(can, 'node bad.js');
    assert.equal(r.stdout.trim().split('\n').filter((l) => l.startsWith('loaded')).length, 0, r.stdout);
    assert.match(r.stdout, /Cannot find module 'worker_threads'/);
  });

  test('child_process routes into the can, not the host', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/cp.js', `
      const cp = require('child_process');
      cp.exec('echo inside-can', (err, out) => console.log('exec:', err, out.trim()));
      cp.exec('node -e "console.log(require(\\'os\\').hostname())"', (err, out) => console.log('host:', out.trim()));
      cp.exec('whoami', (err) => console.log('whoami code', err && err.code));
      console.log('sync:', cp.execSync('echo sync-inside', { encoding: 'utf8' }).trim());
      try { cp.execSync('C:\\\\Windows\\\\System32\\\\cmd.exe /c echo hi', { encoding: 'utf8' }); console.log('host binary: RAN'); }
      catch (e) { console.log('host binary status', e.status); }
    `);
    const r = await sh(can, 'node cp.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /exec: null inside-can/);
    assert.match(r.stdout, new RegExp(`host: ${can.name}`));
    assert.match(r.stdout, /whoami code 127/);
    assert.match(r.stdout, /sync: sync-inside/);
    // A host binary named by its absolute Windows path is not on the can's PATH and is not a can file: it must not run.
    assert.doesNotMatch(r.stdout, /host binary: RAN/);
    assert.match(r.stdout, /host binary status 127/);
  });

  test('process.exit stops the program, clears timers and closes its listeners', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/exit.js', `
      require('http').createServer(() => {}).listen(7001);
      setInterval(() => console.log('tick'), 5);
      setTimeout(() => { console.log('bye'); process.exit(3); console.log('unreachable'); }, 30);
    `);
    const r = await sh(can, 'node exit.js');
    assert.equal(r.exitCode, 3);
    assert.match(r.stdout, /bye/);
    assert.doesNotMatch(r.stdout, /unreachable/);
    assert.deepEqual(await can.listeners(), []);
  });
});

describe('vnet http and background processes', () => {
  const SERVER = `
    const http = require('http');
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'text/plain');
        res.end(req.method + ' ' + req.url + ' ' + body);
      });
    });
    srv.listen(8080, () => console.log('listening on 8080'));
  `;

  test('a background server answers curl and request, then kill stops it', async () => {
    const can = await makeCan();
    await can.writeFile('/app/server.js', SERVER);
    const job = await can.spawn('node /app/server.js &', { background: true, cwd: '/app' });
    await until(async () => (await can.listeners()).some((p) => p.port === 8080));
    assert.equal((await can.getProcess(job.pid)).status, 'running');
    assert.equal((await can.getProcess(job.pid)).command, 'node /app/server.js &');

    const curl = await sh(can, 'curl -s http://localhost:8080/hello?x=1');
    assert.equal(curl.stdout, 'GET /hello?x=1 ');
    const post = await sh(can, 'curl -s -X POST -d payload 127.0.0.1:8080/p');
    assert.equal(post.stdout, 'POST /p payload');
    const withHeaders = await sh(can, 'curl -i localhost:8080/h');
    assert.match(withHeaders.stdout, /^HTTP\/1\.1 200 OK/);

    const direct = await can.request({ port: 8080, method: 'PUT', path: '/direct', body: 'b' });
    assert.equal(direct.status, 200);
    assert.equal(direct.body.toString(), 'PUT /direct b');

    assert.match((await can.logs(job.pid)).toString(), /listening on 8080/);
    const k = await sh(can, `kill ${job.pid}`);
    assert.equal(k.exitCode, 0);
    assert.equal((await can.getProcess(job.pid)).status, 'exited');
    assert.deepEqual(await can.listeners(), []);
    const after = await sh(can, 'curl -s localhost:8080/');
    assert.equal(after.exitCode, 7);
  });

  test('jobs and ps list background work; spawn with background option returns a pid immediately', async () => {
    const can = await makeCan();
    await can.writeFile('/app/tick.js', 'setInterval(() => {}, 1000);');
    const view = await can.spawn('node /app/tick.js', { background: true });
    assert.equal(typeof view.pid, 'number');
    await until(async () => (await can.getProcess(view.pid)).status === 'running');
    const ps = await sh(can, 'ps');
    assert.match(ps.stdout, /node \/app\/tick\.js/);
    await can.kill(view.pid, 'SIGTERM');
    assert.equal((await can.getProcess(view.pid)).status, 'exited');
  });
});

describe('browser inside a can', () => {
  const PAGE_SERVER = `
    const http = require('http');
    http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<title>Inside</title><h1 id="h">can page</h1><a href="/next">go next</a>'
        + '<p id="out">waiting</p><script>document.getElementById("out").textContent = "ran in can";</script>');
    }).listen(8081);
  `;
  let can;
  let hostServer;
  let hostPort;

  before(async () => {
    can = await makeCan();
    await can.writeFile('/app/page.js', PAGE_SERVER);
    await can.spawn('node /app/page.js &', { background: true, cwd: '/app' });
    await until(async () => (await can.listeners()).some((p) => p.port === 8081));

    // A real host server on loopback, reached from inside the can over the real network.
    hostServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Real</title><p>from the host network</p>');
    });
    await new Promise((resolve, reject) => {
      hostServer.once('error', reject);
      hostServer.listen(0, '127.0.0.2', resolve);
    }).then(() => { hostPort = hostServer.address().port; }, () => { hostServer = null; });
  });

  after(() => { hostServer?.close(); });

  test('the browser loads a page served by the can, runs its script and follows links', async () => {
    await can.openBrowser({ internet: false });
    const r = await can.browse('goto', 'http://localhost:8081/');
    assert.equal(r.title, 'Inside');
    assert.equal(r.status, 200);
    assert.match(await can.browse('text'), /can page/);
    assert.equal((await can.browse('query', '#out'))[0].text, 'ran in can');
    await can.browse('click', 'go next');
    const state = await can.browse('state');
    assert.equal(state.url, 'http://localhost:8081/next');
    assert.equal(state.history.urls.length, 2);
  });

  test('the browser snapshot exposes refs that click accepts', async () => {
    await can.browse('goto', 'http://localhost:8081/');
    const snap = await can.browse('snapshot');
    assert.match(snap, /link "go next" \[e\d+\]/);
    const ref = snap.match(/link "go next" \[(e\d+)\]/)[1];
    await can.browse('click', ref);
    assert.equal((await can.browse('state')).url, 'http://localhost:8081/next');
  });

  test('the browser reaches the real network from inside the can', async (t) => {
    if (!hostServer) { t.skip('127.0.0.2 is not available on this host'); return; }
    await can.openBrowser({ internet: true });
    const r = await can.browse('goto', `http://127.0.0.2:${hostPort}/`);
    assert.equal(r.title, 'Real');
    assert.equal(r.status, 200);
    await can.openBrowser({ internet: false });
  });

  test('the browser refuses the internet when internet is disabled', async () => {
    await can.openBrowser({ internet: false });
    await assert.rejects(can.browse('goto', 'https://example.com/'), (err) => err.code === 'EPERM');
  });
});

describe('sandbox boundary (functional)', () => {
  test('fs cannot reach host paths', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/host.js', `
      const fs = require('fs');
      for (const p of ['C:\\\\Windows\\\\win.ini', '/c/Windows/win.ini', '/etc/passwd', process.env.USERPROFILE + '/.can']) {
        try { fs.readFileSync(p); console.log('READ', p); } catch (e) { console.log('denied', e.code); }
      }
    `);
    const r = await sh(can, 'node host.js');
    assert.doesNotMatch(r.stdout, /READ/);
    assert.equal(r.stdout.split('\n').filter((l) => l === 'denied ENOENT').length, 4);
  });

  test('a can has no view of host processes or host ports', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/ports.js', `
      console.log(process.pid, process.ppid, typeof process.binding, typeof process.getBuiltinModule);
    `);
    const r = await sh(can, 'node ports.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /^\d+ 0 undefined undefined/m);
  });
});

describe('host API (the RPC surface of one can)', () => {
  test('filesystem calls: stat, listDir, exists, mkdir, rm and binary round trips', async () => {
    const can = await makeCan();
    await can.mkdir('/home/agent/tree/inner', { recursive: true });
    await can.writeFile('/home/agent/tree/a.txt', 'alpha');
    await can.writeFile('/home/agent/tree/bin.dat', new Uint8Array([0, 255, 7]));
    assert.equal((await can.stat('/home/agent/tree/a.txt')).size, 5);
    assert.equal((await can.stat('/home/agent/tree')).type, 'dir');
    const entries = await can.listDir('/home/agent/tree');
    assert.deepEqual(entries.map((e) => [e.name, e.type]), [['a.txt', 'file'], ['bin.dat', 'file'], ['inner', 'dir']]);
    assert.deepEqual([...(await can.readFile('/home/agent/tree/bin.dat'))], [0, 255, 7]);
    assert.equal(await can.exists('/home/agent/tree/missing'), false);
    await can.rm('/home/agent/tree', { recursive: true });
    assert.equal(await can.exists('/home/agent/tree'), false);
    await assert.rejects(can.stat('/home/agent/tree'), { code: 'ENOENT' });
  });

  test('stdin reaches a background process; logs keep its output after it exits', async () => {
    const can = await makeCan();
    const view = await can.spawn('cat', { background: true });
    await can.writeStdin(view.pid, 'piped ');
    await can.writeStdin(view.pid, Buffer.from('bytes'));
    await can.endStdin(view.pid);
    const done = await can.wait(view.pid, 5000);
    assert.equal(done.exitCode, 0);
    assert.equal((await can.logs(view.pid)).toString(), 'piped bytes');
    await can.kill(view.pid).catch(() => {}); // already exited: ESRCH is expected here, nothing to stop
    await can.exec('echo fg'); // foreground runs leave no record behind
    assert.equal(await can.getProcess(999999), undefined);
  });

  test('snapshot and restore on a live can replace files and stop its processes', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/state.txt', 'before');
    const snap = JSON.parse(JSON.stringify(await can.snapshot()));
    await can.writeFile('/home/agent/state.txt', 'after');
    await can.spawn('node -e "setInterval(() => {}, 1000)"', { background: true });
    await can.restore(snap);
    assert.equal(await can.readFile('/home/agent/state.txt', 'utf8'), 'before');
    assert.deepEqual((await can.ps({ status: 'running' })).map((p) => p.command), []);
    await assert.rejects(can.restore({ format: 'nope' }), { code: 'EINVAL' });
  });

  test('a can is created with the env it was given; bad spawn arguments are refused', async () => {
    const can = await manager.create({ name: `rt-env-${++counter}`, env: { GREETING: 'hi', HOME: '/home/agent' } });
    assert.equal((await sh(can, 'echo $GREETING')).stdout, 'hi\n');
    await assert.rejects(can.spawn('x', { cwd: '/nope' }), { code: 'ENOENT' });
    await assert.rejects(can.exec(''), /command must be a non-empty string/);
  });
});

describe('builtins an agent reaches for: printf, echo -e, node -p', () => {
  test('printf formats %s %d %f %x %c and %%, reuses the format, and pads', async () => {
    const can = await makeCan();
    assert.equal((await sh(can, 'printf "%s-%d\x5cn" a 1 b 2')).stdout, 'a-1\nb-2\n');
    assert.equal((await sh(can, 'printf "%5s|%-4d|%.2f|%x|%c|100%%\x5cn" hi 7 3.14159 255 zed')).stdout, '   hi|7   |3.14|ff|z|100%\n');
    assert.equal((await sh(can, 'printf "tab\x5cthere\x5cn"')).stdout, 'tab\there\n');
    assert.equal((await sh(can, 'printf "no args\x5cn"')).stdout, 'no args\n');
    assert.equal((await sh(can, 'printf')).exitCode, 1);
  });

  test('echo -e interprets escapes, echo -n drops the newline, and plain echo is unchanged', async () => {
    const can = await makeCan();
    assert.equal((await sh(can, 'echo -e "a\x5cnb"')).stdout, 'a\nb\n');
    assert.equal((await sh(can, 'echo -n hi')).stdout, 'hi');
    assert.equal((await sh(can, 'echo -ne "x\x5cty"')).stdout, 'x\ty');
    assert.equal((await sh(can, 'echo -e "a\x5cnb" > /home/agent/e.txt && cat /home/agent/e.txt')).stdout, 'a\nb\n');
    assert.equal((await sh(can, 'echo plain \x5cn stays')).stdout, 'plain n stays\n');
    assert.equal((await sh(can, 'echo plain')).stdout, 'plain\n');
  });

  test('node -p evaluates an expression and prints it', async () => {
    const can = await makeCan();
    assert.equal((await sh(can, 'node -p "1 + 1"')).stdout, '2\n');
    assert.equal((await sh(can, 'node -p "\'str\' + 1"')).stdout, 'str1\n');
    assert.equal((await sh(can, 'node -p "({a: [1, 2]})"')).stdout, "{ a: [ 1, 2 ] }\n");
  });
});

describe('stack traces show can frames only', () => {
  test('an uncaught error prints its can frames and no host path', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/boom.js', "function inner() { throw new Error('boom in can'); }\ninner();\n");
    const r = await can.exec('node boom.js', { timeout: 10_000 });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /Error: boom in can/);
    assert.match(r.stderr, /boom\.js/, 'the can frame is kept');
    assert.doesNotMatch(r.stderr, /file:|node:internal|src[\x5c/]|Users[\x5c/]|Downloads/, r.stderr);
  });

  test('a stack read inside can code shows no host frame either', async () => {
    const can = await makeCan();
    const r = await sh(can, `node -e "try { require('fs').readFileSync('/no/such/file') } catch (e) { console.log(e.stack) }"`);
    assert.match(r.stdout, /ENOENT/);
    assert.doesNotMatch(r.stdout, /file:|node:internal|Users[\x5c/]|Downloads/, r.stdout);
  });
});
