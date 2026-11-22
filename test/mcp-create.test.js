// can_create: transactional and idempotent, environment.tools and environment.pip, and the startup sweep of the store.
// Driven through the tool handlers (src/mcp/tools.js) against a temporary store.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanRegistry, sweepStore } from '../src/registry.js';
import { createTools } from '../src/mcp/tools.js';
import { lockEntries } from '../src/toolchains.js';

const LONG = { timeout: 120_000 };
const dirs = [];
const registries = [];

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `can-${label}-`));
  dirs.push(dir);
  return dir;
}

function harness(storeDir, transferRoot) {
  const registry = new CanRegistry({ storeDir });
  registries.push(registry);
  const byName = new Map(createTools(registry, { transferRoot }).map((t) => [t.name, t]));
  const call = async (name, args = {}) => {
    try {
      return { text: await byName.get(name).run(args), isError: false };
    } catch (err) {
      return { text: err.message, isError: true, code: err.code };
    }
  };
  return { registry, call, tools: byName };
}

async function until(check, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met in time');
}

after(async () => {
  for (const r of registries) await r.shutdown({ save: false }).catch(() => {});
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('can_create is transactional and idempotent', LONG, () => {
  const storeDir = tempDir('create-store');
  const transferRoot = tempDir('create-transfer');
  const h = harness(storeDir, transferRoot);
  const spec = { env: { GREETING: 'hello' }, files: [{ path: '/home/agent/note.txt', content: 'one\n' }] };

  test('the same name and spec on a ready can is reused, not created again', async () => {
    const first = await h.call('can_create', { name: 'same', environment: spec });
    assert.equal(first.isError, false, first.text);
    const again = await h.call('can_create', { name: 'same', environment: spec });
    assert.equal(again.isError, false, again.text);
    assert.match(again.text, /can "same" already exists with the same spec; reused \(id [^,]+, state ready\)/);
    assert.equal(h.registry.list().filter((c) => c.name === 'same').length, 1);
  });

  test('the same name with a different spec is EEXIST with a Next step', async () => {
    const r = await h.call('can_create', { name: 'same', environment: { env: { GREETING: 'bye' } } });
    assert.equal(r.isError, true);
    assert.equal(r.code, 'EEXIST');
    assert.match(r.text, /^EEXIST: a can named "same" already exists with a different environment\. Next: /);
    // The original can is untouched.
    assert.equal(await h.registry.manager.get('same').readFile('/home/agent/note.txt', 'utf8'), 'one\n');
  });

  test('a crashed can with the same spec is reported, and points to can_restart', LONG, async () => {
    const can = h.registry.manager.get('same');
    process.kill(can.vmPid, 'SIGKILL');
    await until(() => can.status === 'crashed');
    const r = await h.call('can_create', { name: 'same', environment: spec });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /already exists with the same spec; not running \(state: crashed\)\. Next: call can_restart/);
  });

  test('a can on disk only with the same spec is reported without booting it', LONG, async () => {
    const fresh = harness(storeDir, transferRoot);
    const r = await fresh.call('can_create', { name: 'same', environment: spec });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /state: saved\)/);
    assert.equal(fresh.registry.manager.get('same'), undefined, 'the saved can was not loaded');
  });

  test('a failed setup step leaves no files and frees the name', LONG, async () => {
    const before = fs.readdirSync(storeDir).sort();
    const r = await h.call('can_create', {
      name: 'broken',
      environment: { files: [{ path: '/home/agent/x.txt', content: 'x' }], setup: [{ command: 'echo boom && exit 3', label: 'broken step' }] },
    });
    assert.equal(r.isError, true);
    assert.equal(r.code, 'EIO');
    assert.match(r.text, /setup step "broken step" exited with code 3/);
    assert.deepEqual(fs.readdirSync(storeDir).sort(), before, 'nothing was left in the store');
    assert.equal(h.registry.manager.get('broken'), undefined, 'the half-built can is not live');

    // The name is free again.
    const retry = await h.call('can_create', { name: 'broken', environment: { env: { RETRY: '1' } } });
    assert.equal(retry.isError, false, retry.text);
  });

  test('a save failure leaves no can behind and frees the name', LONG, async () => {
    const blocked = path.join(tempDir('blocked'), 'not-a-folder');
    fs.writeFileSync(blocked, 'this is a file, so the store cannot be a folder');
    const bad = harness(blocked, transferRoot);
    const r = await bad.call('can_create', { name: 'nosave' });
    assert.equal(r.isError, true);
    assert.match(r.text, /^EIO: could not save can "nosave"/);
    assert.equal(bad.registry.manager.get('nosave'), undefined);
    assert.equal(bad.registry.manager.list().length, 0);
  });

  test('environment.tools resolves a toolchain from the cache and can_status shows its sha256', LONG, async () => {
    const python = lockEntries().find((e) => e.name === 'python');
    const cache = tempDir('toolcache');
    fs.mkdirSync(path.join(cache, python.sha256));
    const saved = process.env.CAN_TOOLCHAIN_DIR;
    process.env.CAN_TOOLCHAIN_DIR = cache;
    try {
      const r = await h.call('can_create', { name: 'withpy', environment: { tools: { python: '3.15' } } });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, new RegExp(`toolchain: python ${python.version} \\(sha256 ${python.sha256}\\)`));
      const status = await h.call('can_status', { can: 'withpy' });
      assert.match(status.text, new RegExp(`python ${python.version} sha256 ${python.sha256}`));
    } finally {
      if (saved === undefined) delete process.env.CAN_TOOLCHAIN_DIR;
      else process.env.CAN_TOOLCHAIN_DIR = saved;
    }
  });

  test('a missing toolchain fails creation with the command that installs it', LONG, async () => {
    // Both places a toolchain is looked for (the bundled copy and the cache) are pointed at empty folders.
    const empty = tempDir('emptycache');
    const saved = { cache: process.env.CAN_TOOLCHAIN_DIR, bundle: process.env.CAN_TOOLCHAIN_BUNDLE_DIR };
    process.env.CAN_TOOLCHAIN_DIR = empty;
    process.env.CAN_TOOLCHAIN_BUNDLE_DIR = empty;
    try {
      const r = await h.call('can_create', { name: 'nopy', environment: { tools: { python: '3.15' } } });
      assert.equal(r.isError, true);
      assert.match(r.text, /^ENOENT: .*Next: run can tools fetch python/);
      assert.equal(h.registry.manager.get('nopy'), undefined);
    } finally {
      if (saved.cache === undefined) delete process.env.CAN_TOOLCHAIN_DIR;
      else process.env.CAN_TOOLCHAIN_DIR = saved.cache;
      if (saved.bundle === undefined) delete process.env.CAN_TOOLCHAIN_BUNDLE_DIR;
      else process.env.CAN_TOOLCHAIN_BUNDLE_DIR = saved.bundle;
    }
  });

  test('environment.pip takes lock lines and refuses other text', async () => {
    const bad = await h.call('can_create', { name: 'badpip', environment: { pip: ['requests'] } });
    assert.equal(bad.isError, true);
    assert.equal(bad.code, 'EINVAL');
    assert.match(bad.text, /pip\[0\] must be a lock line/);

    const badTools = await h.call('can_create', { name: 'badtools', environment: { tools: { 'python 3': '3.15' } } });
    assert.equal(badTools.isError, true);
    assert.equal(badTools.code, 'EINVAL');
  });
});

describe('startup sweep of the store', () => {
  test('removes leftovers of dead writers and stale files, keeps live and fresh ones', () => {
    const store = tempDir('sweep');
    const deadPid = 2_147_483_000; // not a live process on any system this runs on
    const writeLock = (file, pid) => fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid }));

    const deadTmp = path.join(store, 'aaa.json.1-x.tmp');
    fs.writeFileSync(deadTmp, '{"partial":');
    writeLock(deadTmp, deadPid);

    const liveTmp = path.join(store, 'bbb.json.2-x.tmp');
    fs.writeFileSync(liveTmp, '{"being written":');
    writeLock(liveTmp, process.pid);

    const oldTmp = path.join(store, 'ccc.json.3-x.tmp');
    fs.writeFileSync(oldTmp, 'old');
    const twoHoursAgo = (Date.now() - 2 * 3600e3) / 1000;
    fs.utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);

    const freshTmp = path.join(store, 'ddd.json.4-x.tmp');
    fs.writeFileSync(freshTmp, 'fresh');

    const removed = sweepStore(store);
    assert.equal(removed, 2);
    assert.equal(fs.existsSync(deadTmp), false);
    assert.equal(fs.existsSync(`${deadTmp}.lock`), false);
    assert.equal(fs.existsSync(oldTmp), false);
    assert.equal(fs.existsSync(liveTmp), true, 'a live writer keeps its file');
    assert.equal(fs.existsSync(freshTmp), true, 'a recent file without a lock is kept');

    // A new registry reports the count for can_status.
    const registry = new CanRegistry({ storeDir: store });
    assert.equal(registry.swept, 0, 'the sweep ran once, at startup, and found nothing left');
  });
});
