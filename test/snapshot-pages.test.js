// Paged snapshots (src/vm/snapshot-pages.js). The tree moves between the host and the can VM one page at a time, so a
// large save never builds the whole tree in one message. These tests cover the page limits, the round trip of the
// saved form, names that look like object properties, and a multi-page save and load through a real can.
import { describe, test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';
import { VFS } from '../src/kernel/vfs.js';
import {
  PAGE_BYTES, MAX_RECORDS, takePage, attachEncoded, flattenEncoded, pagesFor, attachDecoded,
} from '../src/vm/snapshot-pages.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A VFS with a folder that has a file, a nested folder, a symlink and an odd name. */
function sampleVfs() {
  const vfs = new VFS({ cwd: '/home/agent' });
  vfs.mkdir('/home/agent/dir/sub', { recursive: true });
  vfs.writeFile('/home/agent/dir/a.txt', 'alpha');
  vfs.writeFile('/home/agent/dir/sub/b.bin', Buffer.from([0, 1, 2, 255]));
  vfs.symlink('/home/agent/dir/a.txt', '/home/agent/link');
  vfs.mkdir('/home/agent/__proto__');
  vfs.writeFile('/home/agent/__proto__/c.txt', 'odd name');
  return vfs;
}

describe('page limits', () => {
  test('a page never holds more than PAGE_BYTES of file data, except one record that is larger by itself', () => {
    const records = [];
    for (let i = 0; i < 6; i++) {
      records.push({ segs: [`f${i}`], type: 'file', mode: 0o644, mtime: 0, ctime: 0, birthtime: 0, data: Buffer.alloc(900 * 1024) });
    }
    const pages = [];
    let from = 0;
    while (from !== null) {
      const page = takePage(records, from);
      pages.push(page.records);
      from = page.next;
    }
    assert.ok(pages.length > 1, 'six files of 900 KB need more than one page');
    for (const page of pages) {
      const bytes = page.reduce((n, r) => n + Buffer.from(r.node.data, 'base64').length, 0);
      assert.ok(bytes <= PAGE_BYTES || page.length === 1, `page holds ${bytes} bytes`);
    }
    assert.equal(pages.flat().length, records.length, 'every record is in exactly one page, in order');
  });

  test('a page holds at most MAX_RECORDS records', () => {
    const records = Array.from({ length: MAX_RECORDS + 5 }, (_, i) => ({ segs: [`d${i}`], type: 'dir', mode: 0o755, mtime: 0, ctime: 0, birthtime: 0 }));
    const first = takePage(records, 0);
    assert.equal(first.records.length, MAX_RECORDS);
    assert.equal(first.next, MAX_RECORDS);
  });

  test('pagesFor keeps the base64 size of each page within the budget', () => {
    const flat = Array.from({ length: 5 }, (_, i) => ({
      segs: [`x${i}`], node: { type: 'file', data: 'A'.repeat(Math.ceil((PAGE_BYTES * 4) / 3) - 10) },
    }));
    const pages = pagesFor(flat);
    assert.equal(pages.length, 5, 'each near-budget file gets its own page');
    assert.deepEqual(pages.flat(), flat);
  });
});

describe('the saved form round trip', () => {
  test('flatten then attach rebuilds the same saved tree', () => {
    const saved = sampleVfs().serialize().root;
    const flat = flattenEncoded(saved);
    assert.equal(flat[0].segs.length, 0, 'the root comes first');
    let rebuilt = null;
    for (const page of pagesFor(flat)) rebuilt = attachEncoded(rebuilt, page);
    assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), JSON.parse(JSON.stringify(saved)));
  });

  test('a name such as __proto__ stays an ordinary entry', () => {
    const saved = sampleVfs().serialize().root;
    const rebuilt = attachEncoded(null, flattenEncoded(saved));
    const agent = Object.getOwnPropertyDescriptor(Object.getOwnPropertyDescriptor(rebuilt.entries, 'home').value.entries, 'agent').value;
    const folder = Object.getOwnPropertyDescriptor(agent.entries, '__proto__').value;
    assert.equal(folder.type, 'dir');
    assert.equal(Object.getPrototypeOf(agent.entries), Object.prototype, 'the prototype is untouched');
  });

  test('records decode back to a tree the VFS can read', () => {
    const vfs = sampleVfs();
    let root = null;
    for (const page of pagesFor(flattenEncoded(vfs.serialize().root))) root = attachDecoded(root, page);
    const restored = VFS.fromRoot(root, { cwd: '/home/agent' });
    assert.equal(restored.readFile('/home/agent/dir/a.txt', 'utf8'), 'alpha');
    assert.deepEqual([...restored.readFile('/home/agent/dir/sub/b.bin')], [0, 1, 2, 255]);
    assert.equal(restored.readlink('/home/agent/link'), '/home/agent/dir/a.txt');
    assert.equal(restored.readFile('/home/agent/__proto__/c.txt', 'utf8'), 'odd name');
  });

  test('snapshotRecords lists a folder before its children, with file data by reference', () => {
    const vfs = sampleVfs();
    const records = vfs.snapshotRecords();
    const at = (p) => records.findIndex((r) => r.segs.join('/') === p);
    assert.ok(at('home/agent/dir') < at('home/agent/dir/a.txt'));
    assert.ok(at('home/agent/dir') < at('home/agent/dir/sub'));
    assert.ok(at('home/agent/dir/sub') < at('home/agent/dir/sub/b.bin'));
    const file = records[at('home/agent/dir/a.txt')];
    assert.equal(file.data.toString(), 'alpha');
  });
});

describe('a multi-page save and load through a real can', () => {
  let dir;
  let manager;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-pages-'));
    manager = new CanManager({ storeDir: path.join(dir, 'store') });
  });

  after(async () => {
    await manager.destroyAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('files larger than one page survive save, stop and load', { timeout: 120_000 }, async () => {
    const can = await manager.create({ name: 'pages-save' });
    const big = [1, 2, 3].map((i) => crypto.randomBytes(1_500_000 + i));
    for (let i = 0; i < big.length; i++) await can.writeFile(`/home/agent/big${i}.bin`, big[i]);
    await can.mkdir('/home/agent/deep/er', { recursive: true });
    await can.writeFile('/home/agent/deep/er/note.txt', 'nested note');
    const hashes = big.map(sha256);

    const saved = await manager.save(can.id);
    assert.ok(fs.existsSync(saved));
    const onDisk = JSON.parse(fs.readFileSync(saved, 'utf8'));
    assert.equal(onDisk.format, 'can-snapshot', 'the saved file keeps its format');
    assert.equal(onDisk.vfs.format, 'can-vfs');

    await manager.stop(can.id);
    const again = await manager.load(can.id);
    for (let i = 0; i < big.length; i++) {
      assert.equal(sha256(await again.readFile(`/home/agent/big${i}.bin`)), hashes[i]);
    }
    assert.equal(await again.readFile('/home/agent/deep/er/note.txt', 'utf8'), 'nested note');
  });

  test('snapshot then restore on a live can brings back the same files', { timeout: 120_000 }, async () => {
    const can = await manager.create({ name: 'pages-live' });
    await can.writeFile('/home/agent/keep.bin', crypto.randomBytes(2_100_000));
    const before = sha256(await can.readFile('/home/agent/keep.bin'));
    const snap = JSON.parse(JSON.stringify(await can.snapshot()));
    await can.writeFile('/home/agent/keep.bin', 'changed');
    await can.restore(snap);
    assert.equal(sha256(await can.readFile('/home/agent/keep.bin')), before);
  });
});
