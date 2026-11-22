// python, pip and .wasm commands in a can. Two layers:
//   - host-level: the shell runs in this process on a VFS (fast, and the real toolchain runs), so every builtin
//     branch is checked, including exit codes, relative paths and the pip error codes;
//   - in a can: the same commands inside a real can VM (its own child process, with the permission model on).
// The fake package index is a local HTTP server; nothing here reaches the real PyPI.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { VFS } from '../src/kernel/vfs.js';
import { makeShell, runScript, driveAsync } from '../src/runtime/shell.js';
import { Collector, SyncInput } from '../src/runtime/io.js';
import {
  readZip, parseRequirement, evalMarker, normalizeName, specifierAllows, runPip, scanInstalled, SITE_PACKAGES,
} from '../src/runtime/pip.js';
import { pythonArgs } from '../src/runtime/builtins.js';
import { CanManager } from '../src/manager.js';

// ---- the Python toolchain (skips the python tests when it is not present, as test/wasi.test.js does) -------------

async function pythonToolchain() {
  try {
    const { resolveTool } = await import('../src/toolchains.js');
    await resolveTool('python', '3.15');
    return null;
  } catch (err) {
    return err?.message ?? String(err);
  }
}
const skipPython = await pythonToolchain();
const pySkip = skipPython ? `CPython toolchain absent: ${skipPython}` : false;

// ---- hand-built zip and wheel files ----------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip file of {name, data} entries, deflated (method 8) or stored (method 0). */
function makeZip(entries, method = 8) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const raw = Buffer.from(data);
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** A wheel with a METADATA file (Requires-Dist lines) and the given module sources. */
function makeWheel({ name, version, requires = [], modules, tag = 'py3-none-any', method = 8 }) {
  const dist = `${name}-${version}.dist-info`;
  const meta = ['Metadata-Version: 2.1', `Name: ${name}`, `Version: ${version}`,
    ...requires.map((r) => `Requires-Dist: ${r}`), '', `${name} test package`, ''].join('\n');
  const entries = [
    ...Object.entries(modules).map(([p, data]) => ({ name: p, data })),
    { name: `${dist}/METADATA`, data: meta },
    { name: `${dist}/WHEEL`, data: `Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: ${tag}\n` },
    { name: `${dist}/RECORD`, data: '' },
  ];
  return { filename: `${name}-${version}-${tag}.whl`, bytes: makeZip(entries, method) };
}

// The packages the fake index serves. fakepkg needs fakedep (>=1.0), and has a Windows-only dependency and an
// undecidable one, which are skipped; nativepkg has only a platform wheel and an sdist.
const FAKEDEP_OLD = makeWheel({ name: 'fakedep', version: '1.0.0', modules: { 'fakedep/__init__.py': 'VALUE = 1\n' } });
const FAKEDEP = makeWheel({ name: 'fakedep', version: '1.2.0', modules: { 'fakedep/__init__.py': 'VALUE = 42\n' } });
const FAKEPKG = makeWheel({
  name: 'fakepkg',
  version: '1.0.0',
  requires: ['fakedep (>=1.0)', 'winonly (==1.0) ; sys_platform == "win32"', 'extraonly ; extra == "x"',
    'maybeskip ; (python_version < "3") or (sys_platform == "wasi")'],
  modules: {
    'fakepkg/__init__.py': 'import fakedep\n\ndef hello():\n    return "hi from fakepkg " + str(fakedep.VALUE)\n',
  },
});
const PLATFORM_WHEEL = { filename: 'nativepkg-1.0-cp315-cp315-wasi_wasm32.whl', bytes: Buffer.from('not a wheel') };
// badpkg: the index publishes the digest of GOOD but serves TAMPERED bytes.
const BADPKG_GOOD = makeWheel({ name: 'badpkg', version: '1.0.0', modules: { 'badpkg/__init__.py': 'x = 1\n' } });
const BADPKG_TAMPERED = makeWheel({ name: 'badpkg', version: '1.0.0', modules: { 'badpkg/__init__.py': 'x = 666\n' } });

const PROJECTS = {
  fakedep: { latest: '1.2.0', releases: { '1.0.0': [FAKEDEP_OLD], '1.2.0': [FAKEDEP] } },
  fakepkg: { latest: '1.0.0', releases: { '1.0.0': [FAKEPKG] } },
  nativepkg: {
    latest: '1.0',
    releases: { '1.0': [{ ...PLATFORM_WHEEL }, { filename: 'nativepkg-1.0.tar.gz', bytes: Buffer.from('sdist'), packagetype: 'sdist' }] },
  },
  badpkg: { latest: '1.0.0', releases: { '1.0.0': [{ ...BADPKG_GOOD, serve: BADPKG_TAMPERED.bytes }] } },
};

/** A PyPI-style JSON index on 127.0.0.1. Returns {base, close}. */
async function startIndex() {
  const files = new Map();
  const fileDoc = (base, f) => ({
    filename: f.filename,
    url: `${base}/files/${f.filename}`,
    packagetype: f.packagetype ?? 'bdist_wheel',
    digests: { sha256: sha256Hex(f.bytes) },
    yanked: false,
  });
  for (const proj of Object.values(PROJECTS)) {
    for (const list of Object.values(proj.releases)) for (const f of list) files.set(f.filename, f.serve ?? f.bytes);
  }
  const server = http.createServer((req, res) => {
    const base = `http://${req.headers.host}`;
    const parts = new URL(req.url, base).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (parts[0] === 'files') {
      const bytes = files.get(parts[1]);
      return bytes ? send(200, bytes, 'application/octet-stream') : send(404, 'not found', 'text/plain');
    }
    if (parts[0] !== 'pypi' || parts[parts.length - 1] !== 'json') return send(404, 'not found', 'text/plain');
    const proj = PROJECTS[parts[1]];
    if (!proj) return send(404, '{}');
    if (parts.length === 4) {
      const files2 = proj.releases[parts[2]];
      if (!files2) return send(404, '{}');
      return send(200, JSON.stringify({ info: { name: parts[1], version: parts[2] }, urls: files2.map((f) => fileDoc(base, f)) }));
    }
    const releases = Object.fromEntries(Object.entries(proj.releases).map(([v, list]) => [v, list.map((f) => fileDoc(base, f))]));
    return send(200, JSON.stringify({ info: { name: parts[1], version: proj.latest }, releases, urls: releases[proj.latest] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}/pypi/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A WebAssembly command: writes "hi\n" to fd 1 and exits with 3 (the same hand assembly as test/wasi.test.js). */
function helloWasm() {
  const u32 = (n) => { const out = []; let v = n; do { let b = v % 128; v = Math.floor(v / 128); if (v > 0) b |= 0x80; out.push(b); } while (v > 0); return out; };
  const name = (s) => [...u32(Buffer.byteLength(s)), ...Buffer.from(s)];
  const vec = (items) => [...u32(items.length), ...items.flat()];
  const section = (id, payload) => [id, ...u32(payload.length), ...payload];
  const body = [0x00, 0x41, 0x01, 0x41, 0x00, 0x41, 0x01, 0x41, 0x18, 0x10, 0x00, 0x1a, 0x41, 0x03, 0x10, 0x01, 0x0b];
  const data = [16, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x68, 0x69, 0x0a];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec([[0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f], [0x60, 1, 0x7f, 0], [0x60, 0, 0]])),
    ...section(2, vec([
      [...name('wasi_snapshot_preview1'), ...name('fd_write'), 0x00, 0x00],
      [...name('wasi_snapshot_preview1'), ...name('proc_exit'), 0x00, 0x01],
    ])),
    ...section(3, vec([u32(2)])),
    ...section(5, vec([[0x00, 0x01]])),
    ...section(7, vec([[...name('memory'), 0x02, 0x00], [...name('_start'), 0x00, 0x02]])),
    ...section(10, vec([[...u32(body.length), ...body]])),
    ...section(11, vec([[0x00, 0x41, 0x00, 0x0b, ...u32(data.length), ...data]])),
  ]);
}

// ---- host-level helpers ----------------------------------------------------------------------------------------

/** A shell on a VFS. The can is a stand-in with only what these builtins read (vfs, policy). */
function hostShell(vfs, env = {}, { cwd = '/app', internet = true } = {}) {
  const can = { vfs, policy: { internet, registry: 'https://registry.npmjs.org/' } };
  return makeShell({ can, cwd, env: { HOME: '/home/agent', PWD: cwd, PATH: '/usr/bin:/bin', ...env } });
}

async function run(src, sh, stdin) {
  const io = {
    stdin: stdin === undefined ? undefined : new SyncInput(Buffer.from(stdin)),
    stdout: new Collector(),
    stderr: new Collector(),
  };
  const status = await driveAsync(runScript(src, sh, io));
  return { status, out: io.stdout.buffer().toString('utf8'), err: io.stderr.buffer().toString('utf8') };
}

function newVfs() {
  const vfs = new VFS();
  vfs.mkdir('/app', { recursive: true });
  vfs.mkdir('/home/agent', { recursive: true });
  return vfs;
}

// ---- unit: parsing, markers, zip --------------------------------------------------------------------------------

describe('pip parsing and the zip reader', () => {
  test('names are normalized and specs parse: name, ==, ranges, markers', () => {
    assert.equal(normalizeName('Foo_Bar.baz'), 'foo-bar-baz');
    assert.deepEqual(parseRequirement('fakepkg==1.0.0'), { name: 'fakepkg', specs: [{ op: '==', version: '1.0.0' }], marker: null });
    assert.deepEqual(parseRequirement('fakedep (>=1.0,<2)').specs, [{ op: '>=', version: '1.0' }, { op: '<', version: '2' }]);
    assert.equal(parseRequirement('x ; sys_platform == "win32"').marker, 'sys_platform == "win32"');
    assert.throws(() => parseRequirement('bad name!'), (e) => e.code === 'EINVAL' && /Next:/.test(e.message));
    assert.throws(() => parseRequirement('x ~~ 1'), (e) => e.code === 'EINVAL');
  });

  test('specifiers compare numerically, and wildcards and ~= work', () => {
    assert.equal(specifierAllows('1.10.0', { op: '>=', version: '1.9' }), true);
    assert.equal(specifierAllows('2.0', { op: '<', version: '2' }), false);
    assert.equal(specifierAllows('1.4.9', { op: '==', version: '1.4.*' }), true);
    assert.equal(specifierAllows('1.5', { op: '~=', version: '1.4' }), true);
    assert.equal(specifierAllows('2.0', { op: '~=', version: '1.4' }), false);
    assert.equal(specifierAllows('1.4.7', { op: '~=', version: '1.4' }), true);
  });

  test('markers: false for other platforms, true for wasi, extras never apply, unknown forms are undecided', () => {
    assert.equal(evalMarker('sys_platform == "win32"'), false);
    assert.equal(evalMarker('sys_platform == "wasi"'), true);
    assert.equal(evalMarker('python_version >= "3.10"'), true);
    assert.equal(evalMarker('extra == "x"'), false);
    assert.equal(evalMarker('(python_version < "3") or (sys_platform == "wasi")'), null);
    assert.equal(evalMarker(null), true);
  });

  test('readZip reads deflated and stored entries and refuses paths that leave the folder', () => {
    const deflated = makeZip([{ name: 'a/b.txt', data: 'hello deflate' }], 8);
    const stored = makeZip([{ name: 'c.txt', data: 'hello stored' }], 0);
    assert.equal(readZip(deflated)[0].data.toString(), 'hello deflate');
    assert.equal(readZip(stored)[0].data.toString(), 'hello stored');
    assert.throws(() => readZip(makeZip([{ name: '../escape.py', data: 'x' }])), (e) => e.code === 'EINVAL');
    assert.throws(() => readZip(Buffer.from('not zip at all, just text')), (e) => e.code === 'EINVAL');
  });

  test('python sees a script path made absolute against the can folder; -c keeps its code as is', () => {
    assert.deepEqual(pythonArgs(['script.py', 'arg'], '/app'), ['/app/script.py', 'arg']);
    assert.deepEqual(pythonArgs(['-W', 'ignore', 'sub/s.py'], '/app'), ['-W', 'ignore', '/app/sub/s.py']);
    assert.deepEqual(pythonArgs(['-c', 'print(1)', 'x'], '/app'), ['-c', 'print(1)', 'x']);
  });
});

// ---- host-level: the builtins ----------------------------------------------------------------------------------

describe('python and .wasm commands (host shell, real toolchain)', () => {
  test('python -c "print(1+1)" prints 2', { skip: pySkip }, async () => {
    const r = await run('python -c "print(1+1)"', hostShell(newVfs()));
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, '2\n');
  });

  test('cd /app && python script.py: a relative script and a relative open() both work', { skip: pySkip }, async () => {
    const vfs = newVfs();
    vfs.writeFile('/app/data.txt', 'from the can');
    vfs.writeFile('/app/script.py', "print(open('data.txt').read())\nopen('made.txt', 'w').write('written')\n");
    const sh = hostShell(vfs, {}, { cwd: '/home/agent' });
    const r = await run('cd /app && python script.py', sh);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, 'from the can\n');
    assert.equal(vfs.readFile('/app/made.txt', 'utf8'), 'written');
  });

  test('python -c with a relative open() starts in the can folder (PWD)', { skip: pySkip }, async () => {
    const vfs = newVfs();
    vfs.writeFile('/app/data.txt', 'relative');
    const r = await run('cd /app && python -c "import os; print(os.getcwd()); print(open(\'data.txt\').read())"', hostShell(vfs));
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, '/app\nrelative\n');
  });

  test('the exit code of python reaches the shell (SystemExit(4) gives 4)', { skip: pySkip }, async () => {
    const r = await run('python -c "raise SystemExit(4)"; echo st=$?', hostShell(newVfs()));
    assert.equal(r.out, 'st=4\n', r.err);
  });

  test('python3 is the same command', { skip: pySkip }, async () => {
    const r = await run('python3 -c "print(6*7)"', hostShell(newVfs()));
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, '42\n');
  });

  test('a .wasm command runs with the can stdio and its exit code', async () => {
    const vfs = newVfs();
    vfs.writeFile('/app/hello.wasm', helloWasm());
    const r = await run('cd /app && ./hello.wasm; echo st=$?', hostShell(vfs));
    assert.equal(r.out, 'hi\nst=3\n', r.err);
    const bare = await run('hello.wasm', hostShell(vfs));
    assert.equal(bare.out, 'hi\n');
  });

  test('a .wasm command that is missing gives ENOENT with a Next step and status 127', async () => {
    const r = await run('./missing.wasm', hostShell(newVfs()));
    assert.equal(r.status, 127);
    assert.match(r.err, /^ENOENT: .*Next: /m);
  });

  test('a file that is not wasm gives EINVAL with a Next step', async () => {
    const vfs = newVfs();
    vfs.writeFile('/app/fake.wasm', 'plain text');
    const r = await run('./fake.wasm', hostShell(vfs));
    assert.equal(r.status, 1);
    assert.match(r.err, /EINVAL: .*Next: /);
  });
});

describe('pip (host shell against a local index)', () => {
  let index;
  before(async () => { index = await startIndex(); });
  after(async () => { await index.close(); });

  test('pip install fakepkg==1.0.0 installs the wheel and its dependencies, prints lock lines, and python imports it', { skip: pySkip }, async () => {
    const vfs = newVfs();
    const sh = hostShell(vfs, { CAN_PIP_INDEX: index.base });
    const r = await run('pip install fakepkg==1.0.0', sh);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, new RegExp(`^fakepkg==1\\.0\\.0 --hash=sha256:${sha256Hex(FAKEPKG.bytes)}$`, 'm'));
    assert.match(r.out, new RegExp(`^fakedep==1\\.2\\.0 --hash=sha256:${sha256Hex(FAKEDEP.bytes)}$`, 'm'));
    assert.match(r.err, /pip NOTE: skipped maybeskip/);
    assert.equal(vfs.readFile(`${SITE_PACKAGES}/fakepkg-1.0.0.dist-info/INSTALLER`, 'utf8'), 'can\n');
    assert.match(vfs.readFile(`${SITE_PACKAGES}/fakepkg-1.0.0.dist-info/RECORD`, 'utf8'), /^fakepkg\/__init__\.py,sha256=/m);
    assert.equal(vfs.exists(`${SITE_PACKAGES}/winonly`), false);
    const py = await run('cd /app && python -c "import fakepkg; print(fakepkg.hello())"', sh);
    assert.equal(py.out, 'hi from fakepkg 42\n', py.err);
    const list = await run('pip list', sh);
    assert.match(list.out, /^fakepkg\s+1\.0\.0$/m);
    assert.match(list.out, /^fakedep\s+1\.2\.0$/m);
  });

  test('a lock line installs the same bytes again: an already satisfied package is reported, not reinstalled', async () => {
    const vfs = newVfs();
    const sh = hostShell(vfs, { CAN_PIP_INDEX: index.base });
    await run(`pip install "fakedep==1.2.0 --hash=sha256:${sha256Hex(FAKEDEP.bytes)}"`, sh);
    const again = await run(`pip install fakedep==1.2.0 --hash=sha256:${sha256Hex(FAKEDEP.bytes)}`, sh);
    assert.equal(again.status, 0, again.err);
    assert.match(again.out, /Requirement already satisfied: fakedep==1\.2\.0/);
  });

  test('a lock line with the wrong hash is EINTEGRITY and nothing is written', { skip: pySkip }, async () => {
    const vfs = newVfs();
    const sh = hostShell(vfs, { CAN_PIP_INDEX: index.base });
    const r = await run('pip install fakedep==1.2.0 --hash=sha256:' + '0'.repeat(64), sh);
    assert.equal(r.status, 1);
    assert.match(r.err, /^EINTEGRITY: .*Next: /m);
    assert.equal(vfs.exists(`${SITE_PACKAGES}/fakedep`), false);
  });

  test('a wheel that does not match the index digest is EINTEGRITY', async () => {
    const sh = hostShell(newVfs(), { CAN_PIP_INDEX: index.base });
    const r = await run('pip install badpkg', sh);
    assert.equal(r.status, 1);
    assert.match(r.err, /^EINTEGRITY: badpkg-1\.0\.0-py3-none-any\.whl does not match/m);
  });

  test('a package with only a platform wheel and an sdist is ENOTSUP with a Next step', async () => {
    const sh = hostShell(newVfs(), { CAN_PIP_INDEX: index.base });
    const r = await run('pip install nativepkg', sh);
    assert.equal(r.status, 1);
    assert.match(r.err, /^ENOTSUP: nativepkg has no pure-Python wheel\. Next: choose a pure-Python package\./m);
  });

  test('an unknown package is ENOENT and internet off is EPERM (no request is made)', async () => {
    const sh = hostShell(newVfs(), { CAN_PIP_INDEX: index.base });
    const missing = await run('pip install no-such-package', sh);
    assert.match(missing.err, /^ENOENT: no package named no-such-package/m);
    const off = await run('pip install fakepkg', hostShell(newVfs(), { CAN_PIP_INDEX: index.base }, { internet: false }));
    assert.equal(off.status, 1);
    assert.match(off.err, /^EPERM: .*Next: /m);
  });

  test('pip -r reads a requirements file with lock lines; pip --version and an unsupported command', async () => {
    const vfs = newVfs();
    vfs.writeFile('/app/requirements.txt', `# pinned\nfakedep==1.2.0 --hash=sha256:${sha256Hex(FAKEDEP.bytes)}\n`);
    const sh = hostShell(vfs, { CAN_PIP_INDEX: index.base });
    const r = await run('pip install -r requirements.txt', sh);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^fakedep==1\.2\.0 --hash=sha256:/m);
    const ver = await run('pip --version', sh);
    assert.match(ver.out, /^pip /);
    const bad = await run('pip download fakepkg', sh);
    assert.equal(bad.status, 1);
    assert.match(bad.err, /^EINVAL: pip download is not supported/m);
  });
});

// ---- in a can: the real VM (its own child process) --------------------------------------------------------------

describe('python, pip and .wasm inside a can VM', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-python-'));
  const manager = new CanManager({ storeDir });
  let index;
  let counter = 0;
  before(async () => { index = await startIndex(); });
  after(async () => {
    await manager.destroyAll();
    await index.close();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });
  const makeCan = (env = {}) => manager.create({ name: `py-${++counter}`, env: { HOME: '/home/agent', ...env } });

  test('python -c "print(1+1)" prints 2', { skip: pySkip }, async () => {
    const can = await makeCan();
    const r = await can.exec('python -c "print(1+1)"', { timeout: 60_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '2\n');
  });

  test('cd /app && python script.py works with a relative path and a relative open()', { skip: pySkip }, async () => {
    const can = await makeCan();
    await can.exec('mkdir -p /app && echo "from app" > /app/data.txt && printf "%s\\n" "print(open(\'data.txt\').read())" > /app/script.py', { timeout: 30_000 });
    const r = await can.exec('cd /app && python script.py', { timeout: 60_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    // data.txt ends in a newline and print adds one more
    assert.equal(r.stdout, 'from app\n\n');
  });

  test('the exit code of python is the can command exit code', { skip: pySkip }, async () => {
    const can = await makeCan();
    const r = await can.exec('python -c "raise SystemExit(4)"', { timeout: 60_000 });
    assert.equal(r.exitCode, 4, r.stderr);
  });

  test('pip install from the local index prints the lock line and python imports the package', { skip: pySkip }, async () => {
    const can = await makeCan({ CAN_PIP_INDEX: index.base });
    const inst = await can.exec('pip install fakepkg==1.0.0', { timeout: 60_000 });
    assert.equal(inst.exitCode, 0, inst.stderr);
    assert.match(inst.stdout, new RegExp(`^fakepkg==1\\.0\\.0 --hash=sha256:${sha256Hex(FAKEPKG.bytes)}$`, 'm'));
    const py = await can.exec('python -c "import fakepkg; print(fakepkg.hello())"', { timeout: 60_000 });
    assert.equal(py.stdout, 'hi from fakepkg 42\n', py.stderr);
  });

  test('a bad lock hash inside the can is EINTEGRITY (exit 1)', async () => {
    const can = await makeCan({ CAN_PIP_INDEX: index.base });
    const r = await can.exec(`pip install fakedep==1.2.0 --hash=sha256:${'0'.repeat(64)}`, { timeout: 60_000 });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /EINTEGRITY: /);
  });

  test('a .wasm program runs in the can and its exit code comes back', async () => {
    const can = await makeCan();
    await can.writeFile('/app/hello.wasm', helloWasm());
    const r = await can.exec('cd /app && ./hello.wasm', { timeout: 60_000 });
    assert.equal(r.stdout, 'hi\n', r.stderr);
    assert.equal(r.exitCode, 3);
  });

  test('python -c "while True: pass" with timeout 3000 returns in about 3 s as timed out, and the can still runs', { skip: pySkip }, async () => {
    const can = await makeCan();
    const t0 = Date.now();
    const r = await can.exec('python -c "while True: pass"', { timeout: 3000 });
    const took = Date.now() - t0;
    assert.equal(r.timedOut, true);
    assert.ok(took < 5000, `returned after ${took} ms`);
    const ok = await can.exec('echo ok', { timeout: 10_000 });
    assert.equal(ok.stdout, 'ok\n');
  });

  for (const sig of ['SIGTERM', 'SIGKILL']) {
    test(`spawn a busy python, kill it with ${sig}, and the can still runs commands`, { skip: pySkip }, async () => {
      const can = await makeCan();
      const p = await can.spawn('python -c "while True: pass"');
      await can.kill(p.pid, sig);
      const ok = await can.exec('echo ok', { timeout: 10_000 });
      assert.equal(ok.stdout, 'ok\n');
    });
  }
});
