// Read-only host folder mounts: the host allowlist, the VFS rules (reads live, every write EROFS), saving and
// loading a can with its mounts, and the permission flags of the VM process.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VFS } from '../src/kernel/vfs.js';
import { CanManager } from '../src/manager.js';
import { readMountConfig, listMounts, resolveMounts } from '../src/mounts.js';
import { vmExecArgv, SRC_DIR } from '../src/vm/supervisor.js';
import { bundleDir, cacheDir, lockFilePath } from '../src/toolchains.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-mounts-'));
const hostData = path.join(tmp, 'datasets');
const mountsFile = path.join(tmp, 'mounts.json');

function writeConfig(mounts) {
  fs.writeFileSync(mountsFile, JSON.stringify({ mounts }));
}

before(() => {
  fs.mkdirSync(path.join(hostData, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(hostData, 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(hostData, 'sub', 'b.txt'), 'nested\n');
  writeConfig({
    datasets: { path: hostData, description: 'Research data, read-only' },
    gone: { path: path.join(tmp, 'does-not-exist'), description: 'missing on purpose' },
  });
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the host allowlist (src/mounts.js)', () => {
  test('lists labels and descriptions, never host paths', () => {
    const rows = listMounts(mountsFile);
    assert.deepEqual(rows.map((r) => r.label).sort(), ['datasets', 'gone']);
    assert.ok(rows.every((r) => !JSON.stringify(r).includes(tmp)));
  });

  test('a missing mounts file means no mounts', () => {
    assert.deepEqual(readMountConfig(path.join(tmp, 'absent.json')).size, 0);
  });

  test('labels must be simple names, and each entry needs a path', () => {
    writeConfig({ 'bad label': { path: hostData } });
    assert.throws(() => readMountConfig(mountsFile), { code: 'EINVAL' });
    writeConfig({ ok: { description: 'no path' } });
    assert.throws(() => readMountConfig(mountsFile), { code: 'EINVAL' });
    writeConfig({ datasets: { path: hostData, description: 'Research data, read-only' } });
  });

  test('an unknown label is refused by name; the agent cannot name a host path', () => {
    assert.throws(() => resolveMounts([{ label: 'C-drive', canPath: '/c' }], mountsFile), (err) => {
      assert.equal(err.code, 'ENOENT');
      assert.match(err.message, /no mount "C-drive"/);
      return true;
    });
  });

  test('canPath must be absolute, not /, and mounts must not overlap', () => {
    assert.throws(() => resolveMounts([{ label: 'datasets', canPath: 'data' }], mountsFile), { code: 'EINVAL' });
    assert.throws(() => resolveMounts([{ label: 'datasets', canPath: '/' }], mountsFile), { code: 'EINVAL' });
    assert.throws(() => resolveMounts([
      { label: 'datasets', canPath: '/data' },
      { label: 'datasets', canPath: '/data/more' },
    ], mountsFile), { code: 'EINVAL' });
  });

  test('a listed folder that is missing on the host fails without showing the host path', () => {
    assert.throws(() => resolveMounts([{ label: 'gone', canPath: '/gone' }], mountsFile), (err) => {
      assert.equal(err.code, 'ENOENT');
      assert.ok(!err.message.includes(tmp));
      return true;
    });
  });
});

describe('the VFS mount (src/kernel/vfs.js)', () => {
  test('reads show the host folder; the folder is live', () => {
    const v = new VFS();
    v.mount('/data', hostData, { label: 'datasets' });
    assert.deepEqual(v.readdir('/data'), ['a.txt', 'sub']);
    assert.equal(v.readFile('/data/a.txt', 'utf8'), 'hello\n');
    assert.equal(v.readFile('/data/sub/b.txt', 'utf8'), 'nested\n');
    fs.writeFileSync(path.join(hostData, 'later.txt'), 'added after mounting');
    try {
      assert.equal(v.readFile('/data/later.txt', 'utf8'), 'added after mounting');
    } finally {
      fs.rmSync(path.join(hostData, 'later.txt'));
    }
  });

  test('every write under the mount fails with EROFS, and the host is untouched', () => {
    const v = new VFS();
    v.mount('/data', hostData, { label: 'datasets' });
    const attempts = [
      () => v.writeFile('/data/a.txt', 'changed'),
      () => v.writeFile('/data/new.txt', 'new'),
      () => v.appendFile('/data/a.txt', 'more'),
      () => v.mkdir('/data/dir'),
      () => v.mkdir('/data/x/y', { recursive: true }),
      () => v.unlink('/data/a.txt'),
      () => v.rmdir('/data/sub'),
      () => v.rm('/data/sub', { recursive: true }),
      () => v.rm('/data', { recursive: true }),
      () => v.rename('/data/a.txt', '/data/b.txt'),
      () => v.chmod('/data/a.txt', 0o600),
      () => v.utimes('/data/a.txt', new Date(0)),
      () => v.symlink('/etc', '/data/link'),
      () => v.copy('/data/a.txt', '/data/copy.txt'),
    ];
    for (const attempt of attempts) {
      // rmdir on a folder with contents reports ENOTEMPTY first, which also refuses the change.
      assert.throws(attempt, (err) => (err.code === 'EROFS' || err.code === 'ENOTEMPTY') && !err.message.includes(tmp));
    }
    assert.equal(fs.readFileSync(path.join(hostData, 'a.txt'), 'utf8'), 'hello\n');
    assert.equal(fs.existsSync(path.join(hostData, 'new.txt')), false);
  });

  test('copying out of a mount into the can is allowed; the copy is ordinary can data', () => {
    const v = new VFS();
    v.mkdir('/app', { recursive: true });
    v.mount('/data', hostData, { label: 'datasets' });
    v.copy('/data/a.txt', '/app/a.txt');
    v.writeFile('/app/a.txt', 'edited inside the can');
    assert.equal(v.readFile('/app/a.txt', 'utf8'), 'edited inside the can');
    assert.equal(fs.readFileSync(path.join(hostData, 'a.txt'), 'utf8'), 'hello\n');
  });

  test('a mount cannot sit inside another mount, and an existing folder is covered', () => {
    const v = new VFS();
    v.mkdir('/seeded', { recursive: true });
    v.writeFile('/seeded/old.txt', 'hidden by the mount');
    v.mount('/seeded', hostData, { label: 'datasets' });
    assert.deepEqual(v.readdir('/seeded'), ['a.txt', 'sub']);
    assert.throws(() => v.mount('/seeded/sub', hostData), { code: 'EEXIST' });
  });

  test('a saved VFS keeps the mount point as an empty folder, and holds no host path', () => {
    const v = new VFS();
    v.mount('/data', hostData, { label: 'datasets' });
    const saved = JSON.stringify(v.serialize());
    assert.ok(!saved.includes(hostData));
    const back = VFS.deserialize(JSON.parse(saved));
    assert.deepEqual(back.readdir('/data'), []);
  });
});

describe('a can with mounts (CanManager)', () => {
  let manager;
  let storeDir;

  before(() => {
    storeDir = path.join(tmp, 'store');
    manager = new CanManager({ storeDir, mountsFile });
  });

  test('a mounted folder reads inside the can, and the can cannot write to it', async () => {
    const can = await manager.create({ name: 'reader', mounts: [{ label: 'datasets', canPath: '/data' }] });
    const cat = await can.exec('cat /data/a.txt');
    assert.equal(cat.exitCode, 0, cat.stderr);
    assert.equal(cat.stdout, 'hello\n');
    assert.match((await can.exec('ls /data')).stdout, /a\.txt/);

    const write = await can.writeFile('/data/x.txt', 'nope').catch((e) => e);
    assert.equal(write.code, 'EROFS');
    const shell = await can.exec('echo nope > /data/x.txt');
    assert.notEqual(shell.exitCode, 0);
    assert.match(shell.stderr, /EROFS/);
    assert.equal(fs.existsSync(path.join(hostData, 'x.txt')), false);
    await manager.destroy(can.id);
  });

  test('the snapshot holds labels and can paths, and a saved can is mounted again on load', async () => {
    const can = await manager.create({ name: 'saved', mounts: [{ label: 'datasets', canPath: '/data' }] });
    const snap = await can.snapshot();
    assert.deepEqual(snap.mounts, [{ label: 'datasets', canPath: '/data' }]);
    assert.ok(!JSON.stringify(snap).includes(hostData));
    await manager.save(can.id);
    await manager.stop(can.id);

    const again = await manager.load(can.id);
    const cat = await again.exec('cat /data/sub/b.txt');
    assert.equal(cat.stdout, 'nested\n');
    await manager.destroy(again.id);
  });

  test('loading a can whose mount label is no longer listed is refused', async () => {
    const can = await manager.create({ name: 'orphan', mounts: [{ label: 'datasets', canPath: '/data' }] });
    await manager.save(can.id);
    await manager.stop(can.id);
    const original = fs.readFileSync(mountsFile, 'utf8');
    writeConfig({});
    try {
      await assert.rejects(manager.load(can.id), (err) => err.code === 'ENOENT' && /no mount "datasets"/.test(err.message));
    } finally {
      fs.writeFileSync(mountsFile, original);
    }
    fs.rmSync(path.join(storeDir, `${can.id}.json`)); // not live, so destroy() cannot reach it
  });

  test('the VM process may read a mounted folder and is given no write permission for it', () => {
    const flags = vmExecArgv({ mounts: [hostData] });
    assert.ok(flags.includes(`--allow-fs-read=${hostData}`));
    assert.ok(flags.includes(`--allow-fs-read=${SRC_DIR}`));
    assert.ok(!flags.some((f) => f.startsWith('--allow-fs-write')));
    // Exactly the source folder, the two toolchain folders (bundled and cached) and the tool lock file, nothing else.
    assert.deepEqual(vmExecArgv({}).filter((f) => f.startsWith('--allow-fs-read')), [...[SRC_DIR, bundleDir(), cacheDir(), lockFilePath()].map((d) => `--allow-fs-read=${d}`)]);
  });
});
