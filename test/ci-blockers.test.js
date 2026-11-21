// Blockers found by running an Electron build of a small app through can_ci (see SPEC.md section 14.1, "CI
// blockers"). Each describe block is one blocker, in the order they were reported. Every check runs inside a can.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanManager } from '../src/manager.js';

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-blockers-'));
const manager = new CanManager({ storeDir });
let counter = 0;
async function makeCan(env = {}) {
  return manager.create({ name: `blk-${++counter}`, env: { HOME: '/home/agent', ...env } });
}
after(async () => {
  await manager.destroyAll();
  fs.rmSync(storeDir, { recursive: true, force: true });
});

const run = (can, cmd) => can.exec(cmd, { timeout: 20_000 });

// ---------------------------------------------------------------- 2. node passes flags through

describe('node flags (blocker 2): node --check and friends do what node does', () => {
  test('node --check passes a valid file silently and fails a broken one with exit 1', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/main.js', "const x = 1;\nconsole.log(x);\n");
    const ok = await run(can, 'node --check main.js');
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.equal(ok.stderr, '');
    await can.writeFile('/home/agent/broken.js', 'const = ;\n');
    const bad = await run(can, 'node --check broken.js');
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /SyntaxError/);
    assert.doesNotMatch(bad.stderr, /Cannot find module/);
  });

  test('node --check does not run the program (no output, no side effects)', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/effect.js', "require('fs').writeFileSync('/home/agent/ran.txt', 'yes');\n");
    const r = await run(can, 'node --check effect.js');
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
    const listing = await run(can, 'ls /home/agent');
    assert.doesNotMatch(listing.stdout, /ran\.txt/);
  });

  test('node -c is the short form; node -v prints a version; a missing file is still Cannot find module', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/a.js', 'module.exports = 1;\n');
    assert.equal((await run(can, 'node -c a.js')).exitCode, 0);
    const v = await run(can, 'node -v');
    assert.equal(v.exitCode, 0);
    assert.match(v.stdout, /^v\d+\.\d+\.\d+/);
    // The version node -v prints is the one process.version reports inside the can.
    assert.equal(v.stdout, (await run(can, 'node -p "process.version"')).stdout);
    const missing = await run(can, 'node --check nothere.js');
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /Cannot find module/);
  });

  test('an option a can does not honour is a visible error with exit 9, not a file name', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/a.js', 'console.log("hi");\n');
    const r = await run(can, 'node --inspect a.js');
    assert.equal(r.exitCode, 9);
    assert.match(r.stderr, /option --inspect is not supported in a can/);
    assert.doesNotMatch(r.stderr, /Cannot find module/);
    assert.equal(r.stdout, '');
  });

  test('node -r preloads a module before the main file; a missing preload fails with exit 1', async () => {
    const can = await makeCan();
    await can.writeFile('/app/ci-polyfill.js', "globalThis.POLYFILLED = 'yes';\n");
    await can.writeFile('/app/main.js', 'console.log(globalThis.POLYFILLED);\n');
    const ok = await run(can, 'node -r /app/ci-polyfill.js /app/main.js');
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.equal(ok.stdout, 'yes\n');
    const missing = await run(can, 'node -r /app/none.js /app/main.js');
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /Cannot find module '\/app\/none\.js'/);
  });
});

// ---------------------------------------------------------------- 4. NODE_OPTIONS is honoured or refused

describe('NODE_OPTIONS (blocker 4): read like node reads it, never silently ignored', () => {
  test('NODE_OPTIONS="--require /app/ci-polyfill.js" takes effect', async () => {
    const can = await makeCan({ NODE_OPTIONS: '--require /app/ci-polyfill.js' });
    await can.writeFile('/app/ci-polyfill.js', "globalThis.FROM_ENV = 42;\n");
    await can.writeFile('/app/main.js', 'console.log(globalThis.FROM_ENV);\n');
    const r = await run(can, 'node /app/main.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '42\n');
  });

  test('NODE_OPTIONS with an option a can does not honour fails the node call with exit 9', async () => {
    const can = await makeCan({ NODE_OPTIONS: '--no-warnings --inspect' });
    await can.writeFile('/app/main.js', "console.log('should not run');\n");
    const r = await run(can, 'node /app/main.js');
    assert.equal(r.exitCode, 9);
    assert.match(r.stderr, /NODE_OPTIONS: option --inspect is not supported in a can/);
    assert.equal(r.stdout, '');
  });

  test('NODE_OPTIONS options a can accepts as no-ops (--no-warnings) let the program run', async () => {
    const can = await makeCan({ NODE_OPTIONS: '--no-warnings' });
    await can.writeFile('/app/main.js', "console.log('ran');\n");
    const r = await run(can, 'node /app/main.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'ran\n');
  });

  test('NODE_OPTIONS that names a script is refused, since only options belong there', async () => {
    const can = await makeCan({ NODE_OPTIONS: 'main.js' });
    const r = await run(can, 'node -v');
    assert.equal(r.exitCode, 9);
    assert.match(r.stderr, /only options may be set there/);
  });
});

// ---------------------------------------------------------------- 6. curl says what it does

const SERVER = `const http = require('http');
http.createServer((q, s) => {
  if (q.url === '/moved') { s.writeHead(301, { location: '/final' }); s.end(); return; }
  if (q.url === '/final') { s.writeHead(200, { 'content-type': 'text/plain' }); s.end('final body'); return; }
  if (q.url === '/missing') { s.writeHead(404, { 'content-type': 'text/plain' }); s.end('nope'); return; }
  let body = ''; q.on('data', (c) => { body += c; }); q.on('end', () => {
    s.writeHead(200, { 'content-type': 'text/plain' }); s.end('hello ' + q.method + (body ? ' ' + body : ''));
  });
}).listen(8080);
`;

async function canWithServer() {
  const can = await makeCan();
  await can.writeFile('/app/server.js', SERVER);
  await can.spawn('node /app/server.js', { cwd: '/app', background: true });
  for (let i = 0; i < 50; i++) {
    const probe = await run(can, 'curl -s http://localhost:8080/');
    if (probe.exitCode === 0) return can;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the test server did not start');
}

describe('curl (blocker 6): flags work or fail visibly, never silently', () => {
  test('-o writes the body to a file; -w prints the status; -v traces to stderr', async () => {
    const can = await canWithServer();
    const out = await run(can, 'curl -s -o /home/agent/out.txt -w "%{http_code}" http://localhost:8080/');
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stdout, '200');
    assert.equal(await can.readFile('/home/agent/out.txt', 'utf8'), 'hello GET');
    const v = await run(can, 'curl -v http://localhost:8080/');
    assert.match(v.stderr, /> GET \/ HTTP\/1\.1/);
    assert.match(v.stderr, /< HTTP\/1\.1 200/);
    assert.equal(v.stdout, 'hello GET');
  });

  test('-I prints headers only; -i prints headers then the body', async () => {
    const can = await canWithServer();
    const head = await run(can, 'curl -sI http://localhost:8080/');
    assert.equal(head.exitCode, 0);
    assert.match(head.stdout, /^HTTP\/1\.1 200 /);
    assert.doesNotMatch(head.stdout, /hello/);
    const both = await run(can, 'curl -si http://localhost:8080/');
    assert.match(both.stdout, /^HTTP\/1\.1 200 [\s\S]*\r\n\r\nhello GET$/);
  });

  test('-L follows a redirect; without it the redirect body is what you get (as curl does)', async () => {
    const can = await canWithServer();
    const followed = await run(can, 'curl -sL http://localhost:8080/moved');
    assert.equal(followed.exitCode, 0);
    assert.equal(followed.stdout, 'final body');
    const plain = await run(can, 'curl -s http://localhost:8080/moved');
    assert.equal(plain.exitCode, 0);
    assert.equal(plain.stdout, '');
  });

  test('-f fails with exit 22 on an HTTP error; -sS shows the reason, -s alone does not', async () => {
    const can = await canWithServer();
    const loud = await run(can, 'curl -sSf http://localhost:8080/missing');
    assert.equal(loud.exitCode, 22);
    assert.equal(loud.stdout, '');
    assert.match(loud.stderr, /\(22\) The requested URL returned error: 404/);
    const quiet = await run(can, 'curl -sf http://localhost:8080/missing');
    assert.equal(quiet.exitCode, 22);
    assert.equal(quiet.stderr, '');
  });

  test('POST with -d sends the body; -X sets the method', async () => {
    const can = await canWithServer();
    const r = await run(can, 'curl -s -d a=1 http://localhost:8080/');
    assert.equal(r.stdout, 'hello POST a=1');
    const x = await run(can, 'curl -s -X PUT -H "x-test: 1" -d z http://localhost:8080/');
    assert.equal(x.stdout, 'hello PUT z');
  });

  test('an unknown option is an error with exit 2, not a URL and not silence', async () => {
    const can = await canWithServer();
    const r = await run(can, 'curl --bogus-flag http://localhost:8080/');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /option --bogus-flag: is unknown/);
    assert.equal(r.stdout, '');
    const twoUrls = await run(can, 'curl http://localhost:8080/ http://localhost:8080/final');
    assert.equal(twoUrls.exitCode, 2);
    assert.match(twoUrls.stderr, /multiple URLs/);
  });
});

// ---------------------------------------------------------------- 7. binary data through a stream

describe('binary chunks (blocker 7): Buffer.concat of data chunks works inside a can', () => {
  test('res.on("data") chunks of binary bodies concatenate into the same bytes', async () => {
    const can = await makeCan();
    await can.writeFile('/app/bin-server.js', `const http = require('http');
const bytes = Buffer.alloc(300000); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'application/octet-stream' }); s.end(bytes); }).listen(8081);
`);
    await can.writeFile('/app/bin-client.js', `const http = require('http');
const crypto = require('crypto');
const expected = Buffer.alloc(300000); for (let i = 0; i < expected.length; i++) expected[i] = (i * 31) & 255;
const attempt = () => new Promise((resolve, reject) => {
  http.get('http://localhost:8081/', (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('error', reject);
    res.on('end', () => resolve(Buffer.concat(chunks)));
  }).on('error', reject);
});
(async () => {
  let body = null;
  for (let i = 0; i < 50 && body === null; i++) {
    try { body = await attempt(); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const same = body !== null && body.length === expected.length && body.equals(expected);
  console.log(JSON.stringify({ length: body?.length ?? -1, same, sha: crypto.createHash('sha256').update(body ?? '').digest('hex').slice(0, 16) }));
})().catch((e) => { console.log('ERR ' + e.message); process.exitCode = 1; });
`);
    await can.spawn('node /app/bin-server.js', { cwd: '/app', background: true });
    const r = await run(can, 'node /app/bin-client.js');
    assert.equal(r.exitCode, 0, r.stderr);
    const got = JSON.parse(r.stdout.trim());
    assert.equal(got.length, 300000);
    assert.equal(got.same, true);
  });
});

// ---------------------------------------------------------------- 3. the APIs packaging tools reach for

describe('built-ins a packager reaches for (blocker 3)', () => {
  test('process.emitWarning prints a node-style warning and the program goes on', async () => {
    const can = await makeCan();
    await can.writeFile('/app/warn.js', "process.emitWarning('careful', 'DeprecationWarning', 'DEP0999');\nconsole.log('after');\n");
    const r = await run(can, 'node /app/warn.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'after\n');
    assert.match(r.stderr, /\(node:\d+\) \[DEP0999\] DeprecationWarning: careful/);
  });

  test('util.formatWithOptions formats like util.format', async () => {
    const can = await makeCan();
    await can.writeFile('/app/fmt.js', "const util = require('util');\nconsole.log(util.formatWithOptions({ colors: false }, '%s=%d', 'x', 7));\n");
    const r = await run(can, 'node /app/fmt.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'x=7\n');
  });

  test('fs.createWriteStream writes through to the file; fs.createReadStream reads it back', async () => {
    const can = await makeCan();
    await can.writeFile('/app/streams.js', `const fs = require('fs');
const out = fs.createWriteStream('/home/agent/streamed.txt');
out.write('one\\n');
out.end('two\\n', () => {
  const back = [];
  const input = fs.createReadStream('/home/agent/streamed.txt', 'utf8');
  input.on('data', (c) => back.push(c));
  input.on('end', () => console.log('read:' + back.join('').replace(/\\n/g, '|')));
});
`);
    const r = await run(can, 'node /app/streams.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(await can.readFile('/home/agent/streamed.txt', 'utf8'), 'one\ntwo\n');
    assert.equal(r.stdout, 'read:one|two|\n');
  });

  test('an API the can does not offer fails the program with exit 1 and names the API', async () => {
    const can = await makeCan();
    await can.writeFile('/app/vm.js', "require('vm');\nconsole.log('not reached');\n");
    const vm = await run(can, 'node /app/vm.js');
    assert.equal(vm.exitCode, 1);
    assert.match(vm.stderr, /built-in module 'vm' is not available in this can/);
    assert.equal(vm.stdout, '');
    await can.writeFile('/app/binding.js', "process.binding('fs');\nconsole.log('not reached');\n");
    const binding = await run(can, 'node /app/binding.js');
    assert.equal(binding.exitCode, 1);
    assert.match(binding.stderr, /process\.binding is not a function/);
    assert.equal(binding.stdout, '');
  });
});

// ---------------------------------------------------------------- 9. shell gaps

describe('shell gaps (blocker 9): sed ranges, grep -r, du', () => {
  test('sed takes line numbers, $ and /regex/ ranges, and several -e scripts', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/lines.txt', 'one\ntwo\nthree\nfour\nfive\n');
    assert.equal((await run(can, 'sed -n 2,4p lines.txt')).stdout, 'two\nthree\nfour\n');
    assert.equal((await run(can, 'sed 1,2d lines.txt')).stdout, 'three\nfour\nfive\n');
    assert.equal((await run(can, "sed '$d' lines.txt")).stdout, 'one\ntwo\nthree\nfour\n');
    assert.equal((await run(can, 'sed -n /three/p lines.txt')).stdout, 'three\n');
    assert.equal((await run(can, 'sed "/two/,/four/d" lines.txt')).stdout, 'one\nfive\n');
    assert.equal((await run(can, 'sed -e "s/o/0/" -e 3d lines.txt')).stdout, '0ne\ntw0\nf0ur\nfive\n');
    assert.equal((await run(can, 'sed s/one/ONE/ lines.txt')).stdout, 'ONE\ntwo\nthree\nfour\nfive\n');
  });

  test('a sed script the can does not implement is refused with exit 1 and the supported forms', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/x.txt', 'abc\n');
    const r = await run(can, 'sed "y/abc/xyz/" x.txt');
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /sed: unsupported expression "y\/abc\/xyz\/"/);
    assert.equal(r.stdout, '');
  });

  test('grep -r searches the files under a folder, with names as typed; a folder without -r is named and refused', async () => {
    const can = await makeCan();
    await run(can, 'mkdir -p /app/src/sub');
    await can.writeFile('/app/src/a.js', 'const needle = 1;\nnothing\n');
    await can.writeFile('/app/src/sub/b.js', 'needle again\n');
    await can.writeFile('/app/src/c.txt', 'no match\n');
    const r = await run(can, 'cd /app && grep -r needle src');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'src/a.js:const needle = 1;\nsrc/sub/b.js:needle again\n');
    const here = await run(can, 'cd /app/src && grep -r needle');
    assert.equal(here.stdout, 'a.js:const needle = 1;\nsub/b.js:needle again\n');
    const none = await run(can, 'cd /app && grep -r absent src');
    assert.equal(none.exitCode, 1);
    const folder = await run(can, 'cd /app && grep needle src');
    assert.equal(folder.exitCode, 2);
    assert.match(folder.stderr, /grep: src: Is a directory/);
  });

  test('du prints sizes in KiB for each folder, -s prints the total, -h prints human units', async () => {
    const can = await makeCan();
    await run(can, 'mkdir -p /app/tree/sub');
    await can.writeFile('/app/tree/one.bin', Buffer.alloc(3000, 1));
    await can.writeFile('/app/tree/sub/two.bin', Buffer.alloc(100, 2));
    const all = await run(can, 'cd /app && du tree');
    assert.equal(all.exitCode, 0, all.stderr);
    // 3000 + 100 bytes: each folder is rounded up to whole KiB, so tree/sub is 1 and tree is 4.
    assert.equal(all.stdout, '1\ttree/sub\n4\ttree\n');
    const total = await run(can, 'cd /app && du -s tree');
    assert.equal(total.stdout, '4\ttree\n');
    const human = await run(can, 'cd /app && du -sh tree');
    assert.equal(human.stdout, '3.1K\ttree\n');
    const missing = await run(can, 'du /nope');
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /du: cannot access '\/nope': No such file or directory/);
  });
});

// ---------------------------------------------------------------- 10. kept CI cans have a retention

describe('kept CI cans (blocker 10): a retention age and a cleanup command', () => {
  test('prune removes only saved ci-* cans older than the age; never a newer one, another name, or a loaded can', async () => {
    const { CanRegistry } = await import('../src/registry.js');
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'can-prune-'));
    const DAY = 86_400_000;
    const writer = new CanRegistry({ storeDir: store });
    await writer.create('ci-old');
    await writer.create('ci-new');
    await writer.create('mine-old');
    await writer.shutdown({ save: true });
    const backdate = (name, createdAt) => {
      const row = new CanRegistry({ storeDir: store }).saved().find((s) => s.name === name);
      const file = path.join(store, `${row.id}.json`);
      const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
      snap.createdAt = createdAt;
      fs.writeFileSync(file, JSON.stringify(snap));
    };
    backdate('ci-old', Date.now() - 2 * DAY);
    backdate('mine-old', Date.now() - 2 * DAY);
    const reg = new CanRegistry({ storeDir: store });
    assert.deepEqual(reg.prune({ prefix: 'ci-', olderThanMs: DAY, dryRun: true }), ['ci-old']);
    assert.equal(reg.saved().length, 3, 'a dry run deletes nothing');
    assert.deepEqual(reg.prune({ prefix: 'ci-', olderThanMs: DAY }), ['ci-old']);
    assert.deepEqual(reg.saved().map((s) => s.name).sort(), ['ci-new', 'mine-old']);
    assert.throws(() => reg.prune({ olderThanMs: -1 }), { code: 'EINVAL' });
    fs.rmSync(store, { recursive: true, force: true });
  });

  test('can prune runs from the command line, reports what it removed, and rejects a bad age', async () => {
    const { CanRegistry } = await import('../src/registry.js');
    const { execFileSync } = await import('node:child_process');
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'can-prune-cli-'));
    const writer = new CanRegistry({ storeDir: store });
    await writer.create('ci-cli');
    await writer.shutdown({ save: true });
    const row = new CanRegistry({ storeDir: store }).saved()[0];
    const file = path.join(store, `${row.id}.json`);
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    snap.createdAt = Date.now() - 3 * 86_400_000;
    fs.writeFileSync(file, JSON.stringify(snap));
    const bin = fileURLToPath(new URL('../bin/can.js', import.meta.url));
    const env = { ...process.env, CAN_STORE_DIR: store };
    const dry = execFileSync(process.execPath, [bin, 'prune', '--dry-run'], { env, encoding: 'utf8' });
    assert.match(dry, /would remove 1 kept CI can\(s\): ci-cli/);
    const out = execFileSync(process.execPath, [bin, 'prune'], { env, encoding: 'utf8' });
    assert.match(out, /removed 1 kept CI can\(s\): ci-cli/);
    assert.equal(new CanRegistry({ storeDir: store }).saved().length, 0);
    const none = execFileSync(process.execPath, [bin, 'prune'], { env, encoding: 'utf8' });
    assert.match(none, /no kept CI cans older than 24 hours/);
    assert.throws(() => execFileSync(process.execPath, [bin, 'prune', '--older-than', 'soon'], { env, stdio: 'pipe' }), /takes a number of hours/);
    fs.rmSync(store, { recursive: true, force: true });
  });
});

describe('node --check on modules (blocker 2, ES modules)', () => {
  test('an ES module with import/export passes --check; one with top-level await passes too; a bad one fails', async () => {
    const can = await makeCan();
    await can.writeFile('/app/esm.mjs', "import fs from 'fs';\nexport const x = fs.existsSync('/');\n");
    assert.equal((await run(can, 'node --check /app/esm.mjs')).exitCode, 0);
    await can.writeFile('/app/tla.mjs', "const v = await Promise.resolve(3);\nconsole.log(v);\n");
    assert.equal((await run(can, 'node --check /app/tla.mjs')).exitCode, 0);
    await can.writeFile('/app/badesm.mjs', "import { from 'fs';\n");
    const bad = await run(can, 'node --check /app/badesm.mjs');
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /SyntaxError/);
  });
});
