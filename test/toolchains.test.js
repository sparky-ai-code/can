// Tests for src/toolchains.js. Everything runs against a local http server and temp folders: no test touches the network.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import * as tc from '../src/toolchains.js';

// ---- a stored (uncompressed) zip writer, so the fixture needs no tools ------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x21, 12); // date 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- fixtures ---------------------------------------------------------------------------------------------------

const FILE = 'python-3.15.2-wasi_sdk-33.zip';
const GOOD_ZIP = makeZip([
  { name: 'python.wasm', data: Buffer.from('\0asm\x01\0\0\0fixture') },
  { name: 'lib/python3.15/os.py', data: Buffer.from('# fixture\n') },
]);
const GOOD_SHA = sha256(GOOD_ZIP);
const GOOD = { name: 'python', version: '3.15.2', file: FILE, size: GOOD_ZIP.length, sha256: GOOD_SHA };
const TRAVERSAL_ZIP = makeZip([{ name: '../escaped.txt', data: Buffer.from('nope') }]);
const TRAVERSAL = { name: 'evil', version: '1.0.0', file: 'evil.zip', size: TRAVERSAL_ZIP.length, sha256: sha256(TRAVERSAL_ZIP) };

let root;
let base;
let server;
let hits = 0;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'can-toolchains-test-'));
  const served = new Map([[`/${FILE}`, GOOD_ZIP], ['/evil.zip', TRAVERSAL_ZIP]]);
  server = http.createServer((req, res) => {
    const body = served.get(decodeURIComponent(req.url.split('?')[0]));
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    hits++;
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

const ENV_KEYS = ['CAN_TOOLCHAIN_LOCK', 'CAN_TOOLCHAIN_BUNDLE_DIR', 'CAN_TOOLCHAIN_DIR', 'CAN_CONFIG_FILE'];
let savedEnv;
let counter = 0;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** A new empty folder under the temp root. */
function fresh(label) {
  const dir = path.join(root, `${label}-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a lock file with the given entries and points CAN_TOOLCHAIN_LOCK at it. */
function useLock(entries) {
  const file = path.join(root, `lock-${++counter}.json`);
  fs.writeFileSync(file, JSON.stringify({ lockVersion: 1, entries }));
  process.env.CAN_TOOLCHAIN_LOCK = file;
  return file;
}

const goodEntry = (extra = {}) => ({ ...GOOD, sources: { github: `${base}/${FILE}` }, ...extra });

/** Lists a folder, or [] when it does not exist. */
const listing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

// ---- version matching and resolution ----------------------------------------------------------------------------

test('resolveTool matches "3.15" to 3.15.2 and refuses "3.9" with the available version', async () => {
  useLock([goodEntry()]);
  const bundle = fresh('bundle');
  fs.mkdirSync(path.join(bundle, GOOD_SHA));
  process.env.CAN_TOOLCHAIN_BUNDLE_DIR = bundle;
  process.env.CAN_TOOLCHAIN_DIR = fresh('cache');

  const byPrefix = await tc.resolveTool('python', '3.15');
  assert.equal(byPrefix.version, '3.15.2');
  assert.equal(byPrefix.dir, path.join(bundle, GOOD_SHA));
  assert.equal((await tc.resolveTool('python', '3.15.2')).version, '3.15.2');

  for (const spec of ['3.9', '3.1', '3.15.3']) {
    await assert.rejects(tc.resolveTool('python', spec), (err) => {
      assert.equal(err.code, 'ENOTSUP');
      assert.match(err.message, /3\.15\.2/);
      assert.match(err.message, /Next: /);
      return true;
    }, spec);
  }
});

test('resolveTool prefers the bundled copy, falls back to the cache, and never downloads', async () => {
  useLock([goodEntry()]);
  const bundle = fresh('bundle');
  const cache = fresh('cache');
  process.env.CAN_TOOLCHAIN_BUNDLE_DIR = bundle;
  process.env.CAN_TOOLCHAIN_DIR = cache;

  await assert.rejects(tc.resolveTool('python', '3.15'), (err) => {
    assert.equal(err.code, 'ENOENT');
    assert.match(err.message, /can tools fetch python/);
    return true;
  });

  fs.mkdirSync(path.join(cache, GOOD_SHA));
  assert.equal((await tc.resolveTool('python', '3.15')).dir, path.join(cache, GOOD_SHA));

  fs.mkdirSync(path.join(bundle, GOOD_SHA));
  assert.equal((await tc.resolveTool('python', '3.15')).dir, path.join(bundle, GOOD_SHA));

  const hitsBefore = hits;
  await assert.rejects(tc.resolveTool('nosuch'), { code: 'ENOENT' });
  assert.equal(hits, hitsBefore);
});

test('the committed toolchains.lock.json names CPython 3.15.2 with its sha256', () => {
  const entries = tc.lockEntries();
  const py = entries.find((e) => e.name === 'python');
  assert.ok(py, 'python entry');
  assert.equal(py.version, '3.15.2');
  assert.equal(py.file, 'python-3.15.2-wasi_sdk-33.zip');
  assert.equal(py.size, 15528008);
  assert.equal(py.sha256, 'b8a63559c56760bbdc310dedb74fd69d10bcbafae26b705bea0ad353ad256888');
  assert.match(py.sources.github, /^https:\/\/github\.com\/brettcannon\/cpython-wasi-build\/releases\/download\/v3\.15\.2\//);
});

// ---- fetch, verify, mirror --------------------------------------------------------------------------------------

test('fetchTools downloads from a mirror, verifies, unpacks, and then reuses the copy', async () => {
  useLock([goodEntry()]);
  const into = fresh('into');
  const before0 = hits;

  const first = await tc.fetchTools({ source: base, names: ['python'], into, lockTimeoutMs: 5000 });
  assert.equal(first[0].status, 'fetched');
  assert.equal(first[0].dir, path.join(into, GOOD_SHA));
  assert.equal(hits, before0 + 1);
  assert.equal(fs.readFileSync(path.join(into, GOOD_SHA, 'python.wasm'), 'utf8').slice(0, 4), '\0asm');
  assert.equal(fs.readFileSync(path.join(into, GOOD_SHA, 'lib/python3.15/os.py'), 'utf8'), '# fixture\n');
  assert.deepEqual(listing(into), [GOOD_SHA], 'no .tmp or .locks left behind');

  const verified = await tc.verifyDir(path.join(into, GOOD_SHA), goodEntry());
  assert.equal(verified.ok, true, verified.problems.join('; '));
  assert.equal(verified.files, 2);

  const second = await tc.fetchTools({ source: base, names: ['python'], into, lockTimeoutMs: 5000 });
  assert.equal(second[0].status, 'present');
  assert.equal(hits, before0 + 1, 'a present copy is not downloaded again');
});

test('a wrong sha256 is refused with EINTEGRITY and leaves no files', async () => {
  useLock([goodEntry({ sha256: '0'.repeat(64) })]);
  const into = fresh('bad-sha');
  await assert.rejects(tc.fetchTools({ source: base, names: ['python'], into, lockTimeoutMs: 5000 }), (err) => {
    assert.equal(err.code, 'EINTEGRITY');
    assert.match(err.message, /Next: /);
    return true;
  });
  assert.deepEqual(listing(into), []);
});

test('a wrong size is refused with EINTEGRITY and leaves no files', async () => {
  useLock([goodEntry({ size: GOOD.size + 1 })]);
  const into = fresh('bad-size');
  await assert.rejects(tc.fetchTools({ source: base, names: ['python'], into, lockTimeoutMs: 5000 }), { code: 'EINTEGRITY' });
  assert.deepEqual(listing(into), []);
});

test('an unreachable source is ENETUNREACH with a Next step and leaves no files', async () => {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  useLock([goodEntry()]);
  const into = fresh('offline');
  await assert.rejects(tc.fetchTools({ source: `http://127.0.0.1:${port}`, names: ['python'], into, lockTimeoutMs: 5000 }), (err) => {
    assert.equal(err.code, 'ENETUNREACH');
    assert.match(err.message, /Next: /);
    return true;
  });
  assert.deepEqual(listing(into), []);
});

test('a live lock held by another process times out with EBUSY and is not removed', async () => {
  useLock([goodEntry()]);
  const into = fresh('busy');
  fs.mkdirSync(path.join(into, '.locks'), { recursive: true });
  const lock = path.join(into, '.locks', `${GOOD_SHA}.lock`);
  fs.writeFileSync(lock, String(process.pid)); // this test process is alive
  const hitsBefore = hits;
  const started = Date.now();
  await assert.rejects(tc.fetchTools({ source: base, names: ['python'], into, lockTimeoutMs: 400 }), (err) => {
    assert.equal(err.code, 'EBUSY');
    assert.match(err.message, /Next: /);
    return true;
  });
  assert.ok(Date.now() - started >= 350, 'it waited for the timeout');
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  assert.equal(hits, hitsBefore, 'it did not download while locked');
});

test('a lock left by a dead process is cleared and the fetch goes ahead', async () => {
  useLock([goodEntry()]);
  const into = fresh('stale');
  fs.mkdirSync(path.join(into, '.locks'), { recursive: true });
  fs.writeFileSync(path.join(into, '.locks', `${GOOD_SHA}.lock`), '2147483646');
  const [r] = await tc.fetchTools({ source: base, names: ['python'], into, lockTimeoutMs: 5000 });
  assert.equal(r.status, 'fetched');
  assert.deepEqual(listing(into), [GOOD_SHA]);
});

test('an archive entry that leaves its folder is refused with EINVAL and writes nothing outside', async () => {
  useLock([TRAVERSAL]);
  const into = path.join(fresh('traversal'), 'into');
  await assert.rejects(tc.fetchTools({ source: base, names: ['evil'], into, lockTimeoutMs: 5000 }), { code: 'EINVAL' });
  assert.equal(fs.existsSync(path.join(path.dirname(into), 'escaped.txt')), false);
  assert.equal(fs.existsSync(path.join(into, 'escaped.txt')), false);
  assert.deepEqual(listing(into), []);
});

test('--from uses a verified archive already on disk, with no download', async () => {
  useLock([goodEntry()]);
  const archives = fresh('archives');
  fs.writeFileSync(path.join(archives, FILE), GOOD_ZIP);
  const into = fresh('from');
  const hitsBefore = hits;
  const [r] = await tc.fetchTools({ source: base, names: ['python'], into, from: archives, lockTimeoutMs: 5000 });
  assert.equal(r.status, 'fetched');
  assert.equal(hits, hitsBefore);
  assert.deepEqual(listing(into), [GOOD_SHA]);
});

test('an unknown tool name is ENOENT before anything is downloaded', async () => {
  useLock([goodEntry()]);
  const into = fresh('unknown');
  const hitsBefore = hits;
  await assert.rejects(tc.fetchTools({ source: base, names: ['ruby'], into }), (err) => {
    assert.equal(err.code, 'ENOENT');
    assert.match(err.message, /Next: /);
    return true;
  });
  assert.equal(hits, hitsBefore);
});

test('mirrorTools writes verified archives that fetchTools can read back with --from', async () => {
  useLock([goodEntry()]);
  const dir = fresh('mirror');
  const first = await tc.mirrorTools(dir, { source: 'github' });
  assert.equal(first[0].status, 'fetched');
  assert.equal(sha256(fs.readFileSync(path.join(dir, FILE))), GOOD_SHA);
  assert.deepEqual(fs.readdirSync(dir), [FILE], 'no .part files left behind');
  const again = await tc.mirrorTools(dir, { source: 'github' });
  assert.equal(again[0].status, 'present');
});

test('the default source is github, and tools source stores a mirror in the config file', () => {
  process.env.CAN_CONFIG_FILE = path.join(fresh('config'), 'config.json');
  assert.equal(tc.configuredSource(), 'github');
  fs.writeFileSync(process.env.CAN_CONFIG_FILE, JSON.stringify({ keep: 1 }));
  assert.equal(tc.setConfiguredSource('https://mirror.example.test/tools/'), 'https://mirror.example.test/tools');
  assert.equal(tc.configuredSource(), 'https://mirror.example.test/tools');
  assert.equal(JSON.parse(fs.readFileSync(process.env.CAN_CONFIG_FILE, 'utf8')).keep, 1);
  assert.throws(() => tc.setConfiguredSource('ftp://example.test/x'), { code: 'EINVAL' });
});
