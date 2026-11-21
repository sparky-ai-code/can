// npm inside a can (src/runtime/npm.js and the npm/pnpm/npx commands): semver ranges, tarballs and their integrity,
// the dependency plan (hoisting, nesting, optional and platform rules), writing packages into a can, bin shims,
// and one live install from the public registry (skipped when the registry cannot be reached).
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { VFS } from '../src/kernel/vfs.js';
import { CanManager } from '../src/manager.js';
import {
  compareVersions, maxSatisfying, parseVersion, isTag, satisfies, readTarball, verifyIntegrity,
  planTree, materialize, binShim, binsOf, platformAllows, isPackageName, parseAlias,
} from '../src/runtime/npm.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-npm-'));
const manager = new CanManager({ storeDir: path.join(tmp, 'store'), mountsFile: path.join(tmp, 'none.json') });
let counter = 0;
after(async () => {
  await manager.destroyAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

/** One ustar header plus its data, padded to 512 bytes. type '0' file, '5' folder. */
function tarEntry(name, data, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  const size = data ? data.length : 0;
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (size % 512)) % 512);
  return Buffer.concat([header, data ?? Buffer.alloc(0), pad]);
}

/** A gzipped npm-style tarball: every name is under package/. A trailing "/" makes a folder. */
function tarball(files) {
  const parts = Object.entries(files).map(([p, content]) => (p.endsWith('/')
    ? tarEntry(p, null, '5')
    : tarEntry(p, Buffer.from(content))));
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

const sha512 = (bytes) => `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;

/** A registry document for one package. versions: {version: {deps..., dist?}}. */
function doc(name, versions, tags) {
  const out = {};
  for (const [v, m] of Object.entries(versions)) {
    out[v] = { name, version: v, ...m, dist: { tarball: `https://reg.example/${name}/-/${v}.tgz`, ...(m.dist ?? {}) } };
  }
  const latest = tags?.latest ?? Object.keys(versions).sort().at(-1);
  return { name, 'dist-tags': { latest, ...(tags ?? {}) }, versions: out };
}

const sorted = (list) => [...list].sort();

// ---------------------------------------------------------------- semver

describe('semver ranges', () => {
  test('exact, caret, tilde and comparator ranges', () => {
    assert.equal(satisfies('1.2.3', '1.2.3'), true);
    assert.equal(satisfies('1.2.4', '1.2.3'), false);
    assert.equal(satisfies('1.9.0', '^1.2.3'), true);
    assert.equal(satisfies('2.0.0', '^1.2.3'), false);
    assert.equal(satisfies('1.2.2', '^1.2.3'), false);
    assert.equal(satisfies('0.2.9', '^0.2.3'), true);
    assert.equal(satisfies('0.3.0', '^0.2.3'), false);
    assert.equal(satisfies('1.2.9', '~1.2.3'), true);
    assert.equal(satisfies('1.3.0', '~1.2.3'), false);
    assert.equal(satisfies('1.3.9', '>=1.2 <1.4'), true);
    assert.equal(satisfies('1.4.0', '>=1.2 <1.4'), false);
    assert.equal(satisfies('v1.2.3', '=1.2.3'), true);
  });

  test('x-ranges, partial versions, hyphen ranges and unions', () => {
    assert.equal(satisfies('1.7.0', '1.x'), true);
    assert.equal(satisfies('2.0.0', '1'), false);
    assert.equal(satisfies('1.2.9', '1.2'), true);
    assert.equal(satisfies('9.9.9', '*'), true);
    assert.equal(satisfies('9.9.9', ''), true);
    assert.equal(satisfies('1.2.5', '1.2.0 - 1.3.5'), true);
    assert.equal(satisfies('1.3.6', '1.2.0 - 1.3.5'), false);
    assert.equal(satisfies('3.1.0', '^1.0.0 || ^3.0.0'), true);
    assert.equal(satisfies('2.5.0', '^1.0.0 || ^3.0.0'), false);
  });

  test('prereleases match only when the range names a prerelease of that version', () => {
    assert.equal(satisfies('2.0.0-beta.1', '^1.0.0'), false);
    assert.equal(satisfies('2.0.0-beta.1', '>=2.0.0-alpha <2.0.0'), true);
    assert.equal(satisfies('1.9.9-beta', '^1.0.0'), false);
  });

  test('maxSatisfying picks the highest release, and tags are recognised', () => {
    assert.equal(maxSatisfying(['1.0.0', '1.5.0', '2.0.0', '1.9.9-beta'], '^1.0.0'), '1.5.0');
    assert.equal(maxSatisfying(['1.0.0'], '^2'), null);
    assert.equal(isTag('latest'), true);
    assert.equal(isTag('next'), true);
    assert.equal(isTag('^1'), false);
    assert.equal(isTag('x'), false);
    assert.equal(parseVersion('not-a-version'), null);
  });

  test('versions order like semver', () => {
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0', '1.0.1'].map(parseVersion);
    for (let i = 1; i < order.length; i++) assert.equal(compareVersions(order[i - 1], order[i]) < 0, true);
  });

  test('unsupported range syntax is an error, not a guess', () => {
    assert.throws(() => satisfies('1.0.0', '^foo'), { code: 'EINVAL' });
  });
});

// ---------------------------------------------------------------- tarballs

describe('tarballs', () => {
  test('files and folders come out under the package root, without the package/ folder', () => {
    const entries = readTarball(tarball({
      'package/': '',
      'package/package.json': '{"name":"x"}',
      'package/lib/': '',
      'package/lib/index.js': 'module.exports = 42;\n',
    }));
    assert.deepEqual(entries.map((e) => [e.path, e.type]), [
      ['package.json', 'file'],
      ['lib', 'dir'],
      ['lib/index.js', 'file'],
    ]);
    const file = entries.find((e) => e.path === 'lib/index.js');
    assert.equal(file.data.toString('utf8'), 'module.exports = 42;\n');
    assert.equal(entries.find((e) => e.path === 'package.json').type, 'file');
  });

  test('an entry that leaves the package is refused', () => {
    assert.throws(() => readTarball(tarball({ 'package/../evil.js': 'x' })), { code: 'EPERM' });
    assert.throws(() => readTarball(tarball({ '/etc/passwd': 'x' })), { code: 'EPERM' });
  });

  test('integrity: sha512 and sha1 are checked', () => {
    const bytes = tarball({ 'package/a.js': 'a' });
    verifyIntegrity(bytes, { integrity: sha512(bytes) });
    verifyIntegrity(bytes, { shasum: crypto.createHash('sha1').update(bytes).digest('hex') });
    assert.throws(() => verifyIntegrity(bytes, { integrity: sha512(Buffer.from('other')) }), { code: 'EINTEGRITY' });
    assert.throws(() => verifyIntegrity(bytes, { shasum: '0'.repeat(40) }), { code: 'EINTEGRITY' });
  });

  test('bins are read from a string or from a map, and unsafe names are dropped', () => {
    assert.deepEqual(binsOf({ name: '@s/tool', bin: './cli.js' }), [['tool', './cli.js']]);
    assert.deepEqual(binsOf({ bin: { a: 'bin/a.js', b: '../b.js', 'c d': 'x' } }), [['a', 'bin/a.js']]);
  });

  test('platform lists allow or refuse this platform', () => {
    assert.equal(platformAllows(undefined, 'linux'), true);
    assert.equal(platformAllows(['linux', 'darwin'], 'linux'), true);
    assert.equal(platformAllows(['win32'], 'linux'), false);
    assert.equal(platformAllows(['!linux'], 'linux'), false);
  });
});

// ---------------------------------------------------------------- planning

describe('dependency plan', () => {
  const registry = (docs) => async (name) => docs[name] ?? null;

  test('shared dependencies are hoisted; a conflicting version is nested under its requester', async () => {
    const docs = {
      a: doc('a', { '1.0.0': { dependencies: { c: '^1.0.0' } }, '1.1.0': { dependencies: { c: '^1.0.0' } } }),
      b: doc('b', { '1.0.0': { dependencies: { c: '^2.0.0' } } }),
      c: doc('c', { '1.0.0': {}, '2.0.0': {} }),
    };
    const { placed, warnings } = await planTree({
      roots: [{ name: 'a', range: '^1.0.0' }, { name: 'b', range: '^1.0.0' }],
      getPackument: registry(docs),
    });
    assert.deepEqual(sorted(placed.keys()), sorted([
      'node_modules/a', 'node_modules/b', 'node_modules/c', 'node_modules/b/node_modules/c',
    ]));
    assert.equal(placed.get('node_modules/a').version, '1.1.0');
    assert.equal(placed.get('node_modules/c').version, '1.0.0');
    assert.equal(placed.get('node_modules/b/node_modules/c').version, '2.0.0');
    assert.equal(placed.get('node_modules/b/node_modules/c').nmDir, 'node_modules/b/node_modules');
    assert.deepEqual(warnings, []);
  });

  test('dev dependencies are flagged; dist-tags resolve; cycles end', async () => {
    const docs = {
      x: doc('x', { '1.0.0': { dependencies: { y: '1.0.0' } } }),
      y: doc('y', { '1.0.0': { dependencies: { x: '1.0.0' } } }),
      tool: doc('tool', { '3.0.0': {}, '4.0.0-rc.1': {} }, { latest: '3.0.0', next: '4.0.0-rc.1' }),
    };
    const { placed } = await planTree({
      roots: [{ name: 'x', range: '1.0.0' }, { name: 'tool', range: 'next', dev: true }],
      getPackument: registry(docs),
    });
    assert.equal(placed.get('node_modules/tool').version, '4.0.0-rc.1');
    assert.equal(placed.get('node_modules/tool').dev, true);
    assert.equal(placed.get('node_modules/y').version, '1.0.0');
  });

  test('an optional dependency that cannot be found is skipped with a warning; a required one fails', async () => {
    const docs = {
      app: doc('app', { '1.0.0': { optionalDependencies: { ghost: '^1.0.0' } } }),
      strict: doc('strict', { '1.0.0': { dependencies: { ghost: '^1.0.0' } } }),
    };
    const { placed, warnings } = await planTree({ roots: [{ name: 'app', range: '^1' }], getPackument: registry(docs) });
    assert.equal(placed.has('node_modules/ghost'), false);
    assert.match(warnings[0], /skipped optional ghost/);
    await assert.rejects(
      planTree({ roots: [{ name: 'strict', range: '^1' }], getPackument: registry(docs) }),
      { code: 'ETARGET', message: /required by strict@1\.0\.0/ },
    );
  });

  test('a package for another platform is skipped with a warning', async () => {
    const docs = { onlywin: doc('onlywin', { '1.0.0': { os: ['win32'] } }) };
    const { placed, warnings } = await planTree({ roots: [{ name: 'onlywin', range: '*' }], getPackument: registry(docs) });
    assert.equal(placed.size, 0);
    assert.match(warnings[0], /does not support this platform/);
  });

  test('package names that could climb out of node_modules are refused before anything is fetched', async () => {
    let fetched = 0;
    const getPackument = async () => { fetched++; return null; };
    for (const name of ['../escape', 'a/../b', '/abs', 'x\\y', '.hidden', '@scope', 'Ok-Name_1.0']) {
      if (name === 'Ok-Name_1.0') continue; // a valid name, checked below
      await assert.rejects(planTree({ roots: [{ name, range: '*' }], getPackument }), { code: 'EINVAL' }, name);
    }
    assert.equal(fetched, 0);
    assert.equal(isPackageName('Ok-Name_1.0'), true);
    assert.equal(isPackageName('@scope/pkg'), true);
    assert.equal(isPackageName('@scope/a/b'), false);
  });

  test('an npm alias installs the registry package under the alias name (the @isaacs/cliui case)', async () => {
    const docs = {
      cliui: doc('cliui', { '8.0.2': { dependencies: { 'wrap-ansi-cjs': 'npm:wrap-ansi@^7.0.0' } } }),
      'wrap-ansi': doc('wrap-ansi', { '7.0.0': {}, '7.0.1': {}, '8.0.0': {} }),
      '@acme/real': doc('@acme/real', { '1.0.0': {}, '2.0.0': {} }),
    };
    const { placed, warnings } = await planTree({
      roots: [{ name: 'cliui', range: '8.0.2' }, { name: 'alias-of-scoped', range: 'npm:@acme/real' }],
      getPackument: registry({ ...docs, 'alias-of-scoped': doc('alias-of-scoped', {}) }),
    });
    const alias = placed.get('node_modules/wrap-ansi-cjs');
    assert.equal(alias.name, 'wrap-ansi-cjs');
    assert.equal(alias.real, 'wrap-ansi');
    assert.equal(alias.version, '7.0.1');
    assert.equal(alias.dist.tarball, 'https://reg.example/wrap-ansi/-/7.0.1.tgz');
    assert.equal(placed.get('node_modules/alias-of-scoped').real, '@acme/real');
    assert.equal(placed.get('node_modules/alias-of-scoped').version, '2.0.0');
    assert.deepEqual(warnings, []);
  });

  test('an npm alias with no range takes latest; a bad alias target is refused by name', async () => {
    const { placed } = await planTree({
      roots: [{ name: 'lib', range: 'npm:wrap-ansi' }],
      getPackument: registry({ 'wrap-ansi': doc('wrap-ansi', { '7.0.0': {}, '8.0.0': {} }) }),
    });
    assert.equal(placed.get('node_modules/lib').version, '8.0.0');
    await assert.rejects(
      planTree({ roots: [{ name: 'lib', range: 'npm:../escape@1' }], getPackument: registry({}) }),
      { code: 'EUNSUPPORTED', message: /\.\.\/escape/ },
    );
  });

  test('parseAlias splits names, scopes and ranges, and ignores non-aliases', () => {
    assert.deepEqual(parseAlias('npm:wrap-ansi@^7.0.0'), { real: 'wrap-ansi', range: '^7.0.0' });
    assert.deepEqual(parseAlias('npm:@scope/pkg@1.2.3'), { real: '@scope/pkg', range: '1.2.3' });
    assert.deepEqual(parseAlias('npm:pkg'), { real: 'pkg', range: 'latest' });
    assert.equal(parseAlias('^1.0.0'), null);
    assert.equal(parseAlias('github:user/repo'), null);
  });

  test('specs that are not registry ranges are refused by name', async () => {
    for (const range of ['github:user/repo', 'file:../other', 'workspace:*']) {
      await assert.rejects(
        planTree({ roots: [{ name: 'thing', range }], getPackument: registry({}) }),
        { code: 'EUNSUPPORTED', message: new RegExp(range.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) },
      );
    }
  });
});

// ---------------------------------------------------------------- writing packages

describe('writing a plan into a filesystem', () => {
  test('files, folders and bin shims are written; the integrity is checked on the way', async () => {
    const pkgBin = '#!/usr/bin/env node\nconsole.log("hi from bin", process.argv.slice(2).join(","));\n';
    const pkgTar = tarball({
      'package/': '',
      'package/package.json': JSON.stringify({ name: 'pkg', version: '1.0.0', bin: { pkg: './bin/pkg.js' } }),
      'package/bin/': '',
      'package/bin/pkg.js': pkgBin,
    });
    const manifest = { name: 'pkg', version: '1.0.0', bin: { pkg: './bin/pkg.js' }, dist: { integrity: sha512(pkgTar), tarball: 'https://reg.example/pkg.tgz' } };
    const docs = { pkg: doc('pkg', { '1.0.0': manifest }) };
    const { placed } = await planTree({ roots: [{ name: 'pkg', range: '1.0.0' }], getPackument: async (n) => docs[n] });
    const vfs = new VFS({ cwd: '/home/agent' });
    vfs.mkdir('/home/agent', { recursive: true });
    const result = await materialize({
      placed,
      vfs,
      cwd: '/home/agent/app',
      getTarball: async () => pkgTar,
    });
    assert.equal(result.count, 1);
    assert.equal(vfs.readFile('/home/agent/app/node_modules/pkg/bin/pkg.js', 'utf8'), pkgBin);
    assert.equal(vfs.readFile('/home/agent/app/node_modules/.bin/pkg', 'utf8'), binShim('/home/agent/app/node_modules/pkg/bin/pkg.js'));

    const wrong = { ...manifest, dist: { integrity: sha512(Buffer.from('x')), tarball: 'https://reg.example/pkg.tgz' } };
    const bad = await planTree({ roots: [{ name: 'pkg', range: '1.0.0' }], getPackument: async () => doc('pkg', { '1.0.0': wrong }) });
    await assert.rejects(
      materialize({ placed: bad.placed, vfs, cwd: '/home/agent/app2', getTarball: async () => pkgTar }),
      { code: 'EINTEGRITY' },
    );
  });

  test('install scripts are reported, not run', async () => {
    const t = tarball({ 'package/index.js': 'module.exports = 1\n' });
    const manifest = { name: 'scripted', version: '1.0.0', scripts: { postinstall: 'node evil.js' }, dist: { tarball: 'https://reg.example/s.tgz' } };
    const { placed } = await planTree({ roots: [{ name: 'scripted', range: '1.0.0' }], getPackument: async () => doc('scripted', { '1.0.0': manifest }) });
    const vfs = new VFS({ cwd: '/home/agent' });
    const warnings = [];
    await materialize({ placed, vfs, cwd: '/home/agent/app', getTarball: async () => t, warnings });
    assert.match(warnings[0], /scripted@1\.0\.0 has postinstall script/);
    assert.equal(vfs.exists('/home/agent/app/node_modules/scripted/index.js'), true);
  });
});

// ---------------------------------------------------------------- commands in a can (offline parts)

/** Writes a text file in a can, creating its folders first (a can, like a disk, does not do that by itself). */
async function put(can, filePath, content) {
  await can.mkdir(path.posix.dirname(filePath), { recursive: true });
  await can.writeFile(filePath, content);
}

async function canWith(environment) {
  return manager.create({ name: `npm-${++counter}`, environment });
}

describe('npm, pnpm and npx in a can (no network needed)', () => {
  test('a package with a shebang bin runs through node_modules/.bin, by name and with npx, from any folder below it', async () => {
    const can = await canWith({});
    await put(can, '/home/agent/app/node_modules/.bin/hello', binShim('/home/agent/app/node_modules/hello/bin.js'));
    await put(can, '/home/agent/app/node_modules/hello/bin.js', '#!/usr/bin/env node\nconsole.log("bin", process.argv.slice(2).join("+"));\n');
    await can.mkdir('/home/agent/app/src', { recursive: true });
    assert.equal((await can.exec('hello one two', { cwd: '/home/agent/app/src' })).stdout, 'bin one+two\n');
    assert.equal((await can.exec('npx hello three', { cwd: '/home/agent/app' })).stdout, 'bin three\n');
    const missing = await can.exec('npx nothere', { cwd: '/home/agent/app' });
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /not installed in this project/);
  });

  test('npm install with no dependencies succeeds without the network; with internet off a real install is refused', async () => {
    const can = await canWith({ network: { internet: false } });
    await put(can, '/home/agent/app/package.json', JSON.stringify({ name: 'empty', version: '1.0.0' }));
    const none = await can.exec('npm install', { cwd: '/home/agent/app' });
    assert.equal(none.exitCode, 0, none.stderr);
    assert.match(none.stdout, /added 0 packages/);
    await put(can, '/home/agent/app/package.json', JSON.stringify({ name: 'needs', dependencies: { left: '1.0.0' } }));
    const refused = await can.exec('npm install', { cwd: '/home/agent/app' });
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, /network access is off/);
  });

  test('npm uninstall takes the package out of package.json and node_modules', async () => {
    const can = await canWith({});
    await put(can, '/home/agent/app/package.json', JSON.stringify({ name: 'u', dependencies: { left: '1.0.0', right: '2.0.0' } }));
    await put(can, '/home/agent/app/node_modules/left/index.js', 'module.exports = 1\n');
    const r = await can.exec('npm uninstall left', { cwd: '/home/agent/app' });
    assert.equal(r.exitCode, 0, r.stderr);
    const manifest = JSON.parse(await can.readFile('/home/agent/app/package.json', 'utf8'));
    assert.deepEqual(manifest.dependencies, { right: '2.0.0' });
    assert.equal(await can.exists('/home/agent/app/node_modules/left'), false);
  });

  test('npm init writes a package.json once', async () => {
    const can = await canWith({});
    await can.mkdir('/home/agent/fresh', { recursive: true });
    assert.equal((await can.exec('npm init', { cwd: '/home/agent/fresh' })).exitCode, 0);
    const manifest = JSON.parse(await can.readFile('/home/agent/fresh/package.json', 'utf8'));
    assert.equal(manifest.name, 'fresh');
    assert.equal((await can.exec('npm init', { cwd: '/home/agent/fresh' })).exitCode, 1);
  });

  test('pnpm workspaces are refused, and a workspace file is called out', async () => {
    const can = await canWith({});
    await put(can, '/home/agent/mono/package.json', JSON.stringify({ name: 'mono' }));
    const r = await can.exec('pnpm install -r', { cwd: '/home/agent/mono' });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /workspaces .* are not supported in a can/);
    await put(can, '/home/agent/mono/pnpm-workspace.yaml', 'packages: [a]\n');
    const warn = await can.exec('pnpm install', { cwd: '/home/agent/mono' });
    assert.match(warn.stderr, /pnpm-workspace\.yaml found/);
  });

  test('cargo is not a command in a can', async () => {
    const can = await canWith({});
    const r = await can.exec('cargo build');
    assert.equal(r.exitCode, 127);
  });
});

// ---------------------------------------------------------------- the public registry

const online = await dns.lookup('registry.npmjs.org').then(() => true, () => false);

describe('live registry', { skip: online ? false : 'registry.npmjs.org cannot be reached from this machine' }, () => {
  test('npm install from the public registry: the package loads and is recorded in package.json', async () => {
    const can = await canWith({ requireTools: ['npm'] });
    await put(can, '/home/agent/live/package.json', JSON.stringify({ name: 'live', version: '1.0.0' }));
    const r = await can.exec('npm install semver@7.5.4', { cwd: '/home/agent/live', timeout: 300_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /added \d+ packages?/);
    const load = await can.exec(`node -e "const s = require('semver'); console.log(s.valid('1.2.3'), s.satisfies('7.5.4', '^7.5.0'))"`, { cwd: '/home/agent/live' });
    assert.equal(load.stdout, '1.2.3 true\n');
    const manifest = JSON.parse(await can.readFile('/home/agent/live/package.json', 'utf8'));
    assert.equal(manifest.dependencies.semver, '^7.5.4');
  });
});
