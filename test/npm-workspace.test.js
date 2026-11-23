// npm inside a can, for pnpm monorepo inputs: the pnpm-workspace.yaml subset, catalog: specs, overrides, the libc
// rule, workspace: specs that link a sibling package, and --omit. Planner tests use a fake registry (as in
// npm.test.js); the install tests run in a can with the network off, which works because none of these paths
// needs the registry.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VFS } from '../src/kernel/vfs.js';
import { CanManager } from '../src/manager.js';
import {
  parseSimpleYaml, workspaceConfig, overridesFrom, resolveSpec, planTree, materialize, loadWorkspace,
} from '../src/runtime/npm.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-npm-ws-'));
const manager = new CanManager({ storeDir: path.join(tmp, 'store'), mountsFile: path.join(tmp, 'none.json') });
let counter = 0;
after(async () => {
  await manager.destroyAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

/** A registry document for one package. versions: {version: {deps..., dist?}}. */
function doc(name, versions, tags) {
  const out = {};
  for (const [v, m] of Object.entries(versions)) {
    out[v] = { name, version: v, ...m, dist: { tarball: `https://reg.example/${name}/-/${v}.tgz`, ...(m.dist ?? {}) } };
  }
  const latest = tags?.latest ?? Object.keys(versions).sort().at(-1);
  return { name, 'dist-tags': { latest, ...(tags ?? {}) }, versions: out };
}

/** A fake registry: a packument per name; any name not listed is a test failure, since nothing should ask. */
const registry = (docs) => async (name) => {
  if (!(name in docs)) throw new Error(`the planner asked the registry for ${name}`);
  return docs[name];
};

const plain = (obj) => ({ ...obj });

/** Writes a text file in a VFS, creating its folders first. */
function write(vfs, p, content) {
  vfs.mkdir(path.posix.dirname(p), { recursive: true });
  vfs.writeFile(p, content);
}

/** Writes a text file in a can, creating its folders first. */
async function put(can, filePath, content) {
  await can.mkdir(path.posix.dirname(filePath), { recursive: true });
  await can.writeFile(filePath, content);
}

async function canWith(environment) {
  return manager.create({ name: `npmws-${++counter}`, environment });
}

/** A pnpm monorepo in a can: a workspace file, one linked package ui, and a folder apps/web that depends on it. */
async function monorepo(can, base) {
  await put(can, `${base}/pnpm-workspace.yaml`, "packages:\n  - 'packages/*'\n");
  await put(can, `${base}/packages/ui/package.json`, JSON.stringify({ name: 'ui', version: '1.2.3', main: 'index.js' }));
  await put(can, `${base}/packages/ui/index.js`, 'module.exports = "linked ui";\n');
  await put(can, `${base}/packages/ui/node_modules/junk/x.js`, 'junk\n');
  await put(can, `${base}/packages/ui/.git/HEAD`, 'ref: refs/heads/main\n');
  await put(can, `${base}/apps/web/package.json`, JSON.stringify({ name: 'web', dependencies: { ui: 'workspace:*' } }));
  return `${base}/apps/web`;
}

// ---------------------------------------------------------------- the YAML subset

describe('pnpm-workspace.yaml subset', () => {
  test('block lists, inline lists, quotes, comments and nested catalogs', () => {
    const config = workspaceConfig([
      '# the monorepo',
      'packages:',
      "  - 'apps/*'",
      '  - "packages/*"   # trailing comment',
      '  - tools',
      'catalog:',
      '  react: ^18.3.1',
      '  "@types/node": "20.11.0"',
      "  lodash: '4.17.21'",
      'catalogs:',
      '  solid:',
      '    react: ^17.0.2',
      'overrides:',
      '  minimist: 1.2.8',
      '  "left>right": 2.0.0',
      '',
    ].join('\n'));
    assert.deepEqual(config.packages, ['apps/*', 'packages/*', 'tools']);
    assert.deepEqual(plain(config.catalog), { react: '^18.3.1', '@types/node': '20.11.0', lodash: '4.17.21' });
    assert.deepEqual(plain(config.catalogs.solid), { react: '^17.0.2' });
    assert.deepEqual(plain(config.overrides), { minimist: '1.2.8', 'left>right': '2.0.0' });
  });

  test('an empty file is an empty workspace, and inline lists keep their order', () => {
    const empty = workspaceConfig('');
    assert.deepEqual(empty.packages, []);
    assert.deepEqual(plain(empty.catalog), {});
    assert.deepEqual(plain(parseSimpleYaml('packages: [a, "b/*"]\n')), { packages: ['a', 'b/*'] });
  });

  test('inline lists are read; tabs, nested values and bad shapes are refused', () => {
    assert.deepEqual(workspaceConfig('packages: [apps/*, "packages/*"]\n').packages, ['apps/*', 'packages/*']);
    assert.throws(() => workspaceConfig('catalog:\n\treact: 1\n'), { code: 'EINVAL', message: /tabs/ });
    assert.throws(() => workspaceConfig('catalog:\n  react: 1\n    deeper: x\n'), { code: 'EINVAL', message: /nested lines/ });
    assert.throws(() => workspaceConfig('catalog:\n  react:\n    - 1\n'), { code: 'EINVAL' });
    assert.throws(() => workspaceConfig('catalog: 1\n'), { code: 'EINVAL', message: /catalog must be a map/ });
  });
});

// ---------------------------------------------------------------- catalogs and overrides

describe('catalog: specs and overrides', () => {
  const workspace = {
    workspaceFile: '/w/pnpm-workspace.yaml',
    catalogs: { default: { react: '^18.3.1' }, named: { solid: { react: '^17.0.2' } } },
  };

  test('catalog: and catalog:<name> resolve to the listed range', () => {
    assert.equal(resolveSpec('react', 'catalog:', workspace), '^18.3.1');
    assert.equal(resolveSpec('react', 'catalog:solid', workspace), '^17.0.2');
    assert.equal(resolveSpec('react', '^1.0.0', workspace), '^1.0.0');
  });

  test('a catalog that does not list the dependency fails and names it', () => {
    assert.throws(() => resolveSpec('vue', 'catalog:', workspace), { code: 'EINVAL', message: /vue/ });
    assert.throws(() => resolveSpec('react', 'catalog:nope', workspace), { code: 'EINVAL', message: /catalog "nope"/ });
    assert.throws(() => resolveSpec('react', 'catalog:', {}), { code: 'EINVAL', message: /none found/ });
  });

  test('an override replaces the requested range, and a catalog override is resolved', () => {
    assert.equal(resolveSpec('react', '^17.0.0', { ...workspace, overrides: { react: '^18.0.0' } }), '^18.0.0');
    assert.equal(resolveSpec('react', '^17.0.0', { ...workspace, overrides: { react: 'catalog:solid' } }), '^17.0.2');
  });

  test('overridesFrom keeps plain entries and warns about parent>child, $references and nested maps', () => {
    const { overrides, warnings } = overridesFrom({
      minimist: '1.2.8', 'left>right': '2.0.0', ref: '$thing', nest: { a: '1.0.0' }, 'Bad Name': '1.0.0',
    }, 'package.json');
    assert.deepEqual(plain(overrides), { minimist: '1.2.8' });
    assert.equal(warnings.length, 4);
    assert.match(warnings[0], /parent>child/);
  });

  test('planTree: a catalog: root and a nested catalog: dependency both take the catalog range', async () => {
    const docs = {
      react: doc('react', { '17.0.2': {}, '18.3.1': {} }),
      'react-dom': doc('react-dom', { '18.3.1': { dependencies: { react: 'catalog:' } } }),
    };
    const { placed } = await planTree({
      roots: [{ name: 'react', range: 'catalog:' }, { name: 'react-dom', range: '18.3.1' }],
      getPackument: registry(docs),
      workspace: { catalogs: { default: { react: '^18.3.1' }, named: {} } },
    });
    assert.equal(placed.get('node_modules/react').version, '18.3.1');
  });

  test('planTree: a missing catalog entry fails with the dependency named and the requester', async () => {
    await assert.rejects(
      planTree({ roots: [{ name: 'react', range: 'catalog:' }], getPackument: registry({}), workspace: {} }),
      { code: 'EINVAL', message: /react@catalog:.*required by package\.json/ },
    );
  });

  test('planTree: an override applies everywhere in the tree, not only at the root', async () => {
    const docs = {
      a: doc('a', { '1.0.0': { dependencies: { c: '^2.0.0' } } }),
      c: doc('c', { '1.0.0': {}, '2.0.0': {} }),
    };
    const { placed } = await planTree({
      roots: [{ name: 'a', range: '1.0.0' }],
      getPackument: registry(docs),
      workspace: { overrides: { c: '1.0.0' } },
    });
    assert.equal(placed.get('node_modules/c').version, '1.0.0');
    const root = await planTree({
      roots: [{ name: 'c', range: '^2' }],
      getPackument: registry(docs),
      workspace: { overrides: { c: '1.0.0' } },
    });
    assert.equal(root.placed.get('node_modules/c').version, '1.0.0');
  });

  test('loadWorkspace: pnpm-workspace.yaml overrides and package.json overrides, package.json wins', () => {
    const vfs = new VFS({ cwd: '/home/agent' });
    write(vfs, '/home/agent/mono/pnpm-workspace.yaml', 'packages: []\noverrides:\n  minimist: 1.0.0\n  glob: 9.0.0\n');
    write(vfs, '/home/agent/mono/apps/web/package.json', '{"name":"web"}');
    const ws = loadWorkspace(vfs, '/home/agent/mono/apps/web', { name: 'web', overrides: { minimist: '1.2.8', 'a>b': '1' } });
    assert.equal(ws.workspaceFile, '/home/agent/mono/pnpm-workspace.yaml');
    assert.deepEqual(plain(ws.overrides), { minimist: '1.2.8', glob: '9.0.0' });
    assert.match(ws.warnings.join('\n'), /a>b/);
  });
});

// ---------------------------------------------------------------- libc

describe('libc field', () => {
  const docs = {
    app: doc('app', { '1.0.0': { optionalDependencies: { 'native-musl': '^1.0.0' } } }),
    'native-musl': doc('native-musl', { '1.0.0': { libc: ['musl'] } }),
    'needs-musl': doc('needs-musl', { '1.0.0': { libc: ['musl'] } }),
    'glibc-only': doc('glibc-only', { '1.0.0': { libc: ['glibc'] } }),
    'not-musl': doc('not-musl', { '1.0.0': { libc: ['!musl'] } }),
  };

  test('an optional package for another libc is skipped with a warning', async () => {
    const { placed, warnings } = await planTree({ roots: [{ name: 'app', range: '1.0.0' }], getPackument: registry(docs) });
    assert.equal(placed.has('node_modules/native-musl'), false);
    assert.match(warnings.join('\n'), /skipped optional native-musl@1\.0\.0: it needs libc musl, and this can has glibc/);
  });

  test('a required package for another libc is refused by name', async () => {
    await assert.rejects(
      planTree({ roots: [{ name: 'needs-musl', range: '1.0.0' }], getPackument: registry(docs) }),
      { code: 'EUNSUPPORTED', message: /needs-musl@1\.0\.0 needs libc musl, and this can has glibc/ },
    );
  });

  test('glibc and negated lists are allowed', async () => {
    const { placed } = await planTree({
      roots: [{ name: 'glibc-only', range: '1.0.0' }, { name: 'not-musl', range: '1.0.0' }],
      getPackument: registry(docs),
    });
    assert.equal(placed.has('node_modules/glibc-only'), true);
    assert.equal(placed.has('node_modules/not-musl'), true);
  });
});

// ---------------------------------------------------------------- workspace: specs

describe('workspace: specs link sibling packages', () => {
  function siblingWorkspace() {
    const packages = new Map([
      ['ui', { name: 'ui', version: '1.2.3', dir: '/home/agent/mono/packages/ui', manifest: { name: 'ui', version: '1.2.3', dependencies: { left: '^1.0.0' } } }],
    ]);
    return { packages, catalogs: {}, overrides: {} };
  }
  const docs = { left: doc('left', { '1.0.0': {}, '1.5.0': {} }) };

  test('workspace:*, workspace:^ and workspace:~ place the sibling and follow its dependencies', async () => {
    for (const spec of ['workspace:*', 'workspace:^', 'workspace:~', 'workspace:^1.0.0']) {
      const { placed } = await planTree({ roots: [{ name: 'ui', range: spec }], getPackument: registry(docs), workspace: siblingWorkspace() });
      const ui = placed.get('node_modules/ui');
      assert.equal(ui.version, '1.2.3', spec);
      assert.equal(ui.workspaceDir, '/home/agent/mono/packages/ui', spec);
      assert.equal(placed.get('node_modules/left').version, '1.5.0', spec);
    }
  });

  test('a workspace range the sibling does not satisfy is refused; a missing sibling is refused by name', async () => {
    await assert.rejects(
      planTree({ roots: [{ name: 'ui', range: 'workspace:^2' }], getPackument: registry(docs), workspace: siblingWorkspace() }),
      { code: 'ETARGET', message: /ui@workspace:\^2.*1\.2\.3/ },
    );
    await assert.rejects(
      planTree({ roots: [{ name: 'ghost', range: 'workspace:*' }], getPackument: registry(docs), workspace: siblingWorkspace() }),
      { code: 'EUNSUPPORTED', message: /ghost@workspace:\*/ },
    );
  });

  test('a linked sibling and a registry copy of the same name are placed separately', async () => {
    const { placed } = await planTree({
      roots: [{ name: 'ui', range: 'workspace:*' }, { name: 'left', range: '1.0.0' }],
      getPackument: registry({ ...docs, ui: doc('ui', { '1.2.3': {} }) }),
      workspace: siblingWorkspace(),
    });
    assert.equal(placed.get('node_modules/ui').workspaceDir, '/home/agent/mono/packages/ui');
    assert.equal(placed.get('node_modules/left').version, '1.0.0');
  });

  test('copying a sibling leaves out node_modules and .git, and reports symbolic links', async () => {
    const vfs = new VFS({ cwd: '/home/agent' });
    const base = '/home/agent/mono/packages/ui';
    write(vfs, `${base}/package.json`, JSON.stringify({ name: 'ui', version: '1.2.3', main: 'index.js' }));
    write(vfs, `${base}/index.js`, 'module.exports = 1;\n');
    write(vfs, `${base}/src/deep/a.js`, 'a\n');
    write(vfs, `${base}/dist/bundle.js`, 'built\n');
    write(vfs, `${base}/node_modules/junk/x.js`, 'junk\n');
    write(vfs, `${base}/src/node_modules/nested.js`, 'nested\n');
    write(vfs, `${base}/.git/HEAD`, 'ref\n');
    vfs.symlink('/elsewhere', `${base}/link`);
    const warnings = [];
    const { placed } = await planTree({
      roots: [{ name: 'ui', range: 'workspace:*' }],
      getPackument: async () => { throw new Error('no registry'); },
      workspace: { packages: new Map([['ui', { name: 'ui', version: '1.2.3', dir: base, manifest: { name: 'ui', version: '1.2.3' } }]]) },
    });
    await materialize({ placed, vfs, cwd: '/home/agent/app', getTarball: async () => { throw new Error('no fetch'); }, warnings });
    const root = '/home/agent/app/node_modules/ui';
    assert.equal(vfs.readFile(`${root}/index.js`, 'utf8'), 'module.exports = 1;\n');
    assert.equal(vfs.readFile(`${root}/src/deep/a.js`, 'utf8'), 'a\n');
    assert.equal(vfs.readFile(`${root}/dist/bundle.js`, 'utf8'), 'built\n');
    assert.equal(vfs.exists(`${root}/node_modules`), false);
    assert.equal(vfs.exists(`${root}/src/node_modules`), false);
    assert.equal(vfs.exists(`${root}/.git`), false);
    assert.equal(vfs.exists(`${root}/link`), false);
    assert.match(warnings.join('\n'), /did not copy the symbolic link .*link/);
  });

  test('loadWorkspace finds the sibling folders from the workspace root, even when run from a package below it', () => {
    const vfs = new VFS({ cwd: '/home/agent' });
    write(vfs, '/home/agent/mono/pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - packages/*\n  - 'nope/**'\n");
    write(vfs, '/home/agent/mono/apps/web/package.json', JSON.stringify({ name: 'web' }));
    write(vfs, '/home/agent/mono/packages/ui/package.json', JSON.stringify({ name: 'ui', version: '2.0.0' }));
    write(vfs, '/home/agent/mono/packages/bad/package.json', '{nope');
    const ws = loadWorkspace(vfs, '/home/agent/mono/apps/web', null);
    assert.deepEqual([...ws.packages.keys()].sort(), ['ui', 'web']);
    assert.equal(ws.packages.get('ui').version, '2.0.0');
    assert.equal(ws.workspaceFile, '/home/agent/mono/pnpm-workspace.yaml');
    assert.match(ws.warnings.join('\n'), /not valid JSON/);
    assert.match(ws.warnings.join('\n'), /nope\/\*\*/);
  });
});

// ---------------------------------------------------------------- --omit

describe('--omit', () => {
  test('a named package and what only it needs are not planned; shared dependencies still are', async () => {
    const docs = {
      app: doc('app', { '1.0.0': {} }),
      electron: doc('electron', { '30.0.0': { dependencies: { 'electron-helper': '^1.0.0', shared: '^1.0.0' } } }),
      'electron-helper': doc('electron-helper', { '1.0.0': {} }),
      shared: doc('shared', { '1.0.0': {} }),
    };
    const asked = [];
    const { placed } = await planTree({
      roots: [{ name: 'app', range: '1.0.0' }, { name: 'electron', range: '30.0.0', dev: true }],
      getPackument: async (name) => { asked.push(name); return registry(docs)(name); },
      omit: ['electron'],
    });
    assert.deepEqual([...placed.keys()].sort(), ['node_modules/app']);
    assert.equal(asked.includes('electron-helper'), false);
    assert.equal(asked.includes('electron'), false);
  });

  test('--omit is a name match: a shared dependency that another package needs is still installed', async () => {
    const docs = {
      app: doc('app', { '1.0.0': { dependencies: { shared: '^1.0.0' } } }),
      electron: doc('electron', { '30.0.0': { dependencies: { shared: '^1.0.0' } } }),
      shared: doc('shared', { '1.0.0': {} }),
    };
    const { placed } = await planTree({
      roots: [{ name: 'electron', range: '30.0.0' }, { name: 'app', range: '1.0.0' }],
      getPackument: registry(docs),
      omit: ['electron'],
    });
    assert.equal(placed.get('node_modules/shared').version, '1.0.0');
  });
});

// ---------------------------------------------------------------- npm in a can

describe('npm in a can with pnpm workspace inputs (network off)', () => {
  test('npm install in a package links its workspace: sibling by copying the folder, and the app can require it', async () => {
    const can = await canWith({ network: { internet: false } });
    const web = await monorepo(can, '/home/agent/mono');
    const r = await can.exec('npm install', { cwd: web });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /added 1 package/);
    assert.equal(await can.exists(`${web}/node_modules/ui/node_modules`), false);
    assert.equal(await can.exists(`${web}/node_modules/ui/.git`), false);
    const load = await can.exec(`node -e "console.log(require('ui'))"`, { cwd: web });
    assert.equal(load.stdout, 'linked ui\n');
  });

  test('--omit leaves a package out without fetching it; without --omit the same install is refused', async () => {
    const can = await canWith({ network: { internet: false } });
    const web = await monorepo(can, '/home/agent/omit');
    const pkgPath = `${web}/package.json`;
    await put(can, pkgPath, JSON.stringify({ name: 'web', dependencies: { ui: 'workspace:*', electron: '^30.0.0' } }));
    const omitted = await can.exec('npm install --omit electron', { cwd: web });
    assert.equal(omitted.exitCode, 0, omitted.stderr);
    assert.match(omitted.stdout, /added 1 package/);
    assert.equal(await can.exists(`${web}/node_modules/electron`), false);
    const second = await can.exec('npm install --omit=electron', { cwd: web });
    assert.equal(second.exitCode, 0, second.stderr);
    const refused = await can.exec('npm install', { cwd: web });
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, /network access is off/);
    const bare = await can.exec('npm install --omit', { cwd: web });
    assert.equal(bare.exitCode, 2);
    assert.match(bare.stderr, /--omit needs a package name/);
  });

  test('an overridden dependency installs from the workspace when the override names a workspace: spec', async () => {
    const can = await canWith({ network: { internet: false } });
    await put(can, '/home/agent/ov/pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    await put(can, '/home/agent/ov/packages/left/package.json', JSON.stringify({ name: 'left', version: '3.0.0', main: 'index.js' }));
    await put(can, '/home/agent/ov/packages/left/index.js', 'module.exports = "left from the workspace";\n');
    await put(can, '/home/agent/ov/app/package.json', JSON.stringify({
      name: 'app', dependencies: { left: '^1.0.0' }, overrides: { left: 'workspace:*' },
    }));
    const r = await can.exec('npm install', { cwd: '/home/agent/ov/app' });
    assert.equal(r.exitCode, 0, r.stderr);
    const load = await can.exec(`node -e "console.log(require('left'))"`, { cwd: '/home/agent/ov/app' });
    assert.equal(load.stdout, 'left from the workspace\n');
  });

  test('a catalog: dependency that the workspace catalog does not list fails and names the dependency', async () => {
    const can = await canWith({ network: { internet: false } });
    await put(can, '/home/agent/cat/pnpm-workspace.yaml', 'packages: []\ncatalog:\n  left: 1.0.0\n');
    await put(can, '/home/agent/cat/app/package.json', JSON.stringify({ name: 'app', dependencies: { react: 'catalog:' } }));
    const r = await can.exec('npm install', { cwd: '/home/agent/cat/app' });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /react@catalog:/);
  });

  test('npm ci reads only an npm lockfile; with only pnpm-lock.yaml it installs from package.json and says so', async () => {
    const can = await canWith({ network: { internet: false } });
    await put(can, '/home/agent/lock/package.json', JSON.stringify({ name: 'lock' }));
    await put(can, '/home/agent/lock/pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    const r = await can.exec('npm ci', { cwd: '/home/agent/lock' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /pnpm-lock\.yaml is not read/);
  });
});
