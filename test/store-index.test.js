// The saved-can store: a save is skipped when nothing changed (CanManager.save), and the store index (src/store-index.js)
// is a cache that is checked against the files. These tests run real cans, each in its own VM process.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanRegistry } from '../src/registry.js';
import { INDEX_FILE } from '../src/store-index.js';

const LONG = { timeout: 180_000 };
const NAME = 'store-can';

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('saved-can store: save skip and index', LONG, () => {
  let storeDir;
  let file; // the can's saved file
  let id;
  const registries = [];

  /** A registry as a new process would have it: nothing loaded, nothing cached. */
  function open() {
    const reg = new CanRegistry({ storeDir });
    registries.push(reg);
    return reg;
  }

  before(async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-store-index-'));
    const first = open();
    const can = await first.create(NAME);
    id = can.id;
    file = path.join(storeDir, `${id}.json`);
    await first.shutdown({ save: false });
  });

  after(async () => {
    for (const reg of registries) await reg.shutdown({ save: false });
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  test('a read-only exec does not rewrite the can file', async () => {
    const reg = open();
    const can = await reg.get(NAME);
    const before = { mtimeMs: fs.statSync(file).mtimeMs, sha: hash(file), gen: await can.generation() };
    const r = await can.exec('echo hi', { timeout: 0 });
    assert.equal(r.stdout, 'hi\n');
    await reg.save(can.id);
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs, 'the file was rewritten');
    assert.equal(hash(file), before.sha, 'the file content changed');
    assert.equal(await can.generation(), before.gen, 'a read-only exec moved the generation');
  });

  test('a write made by exec is still saved, and a write through the API moves the generation', async () => {
    const reg = open();
    const can = await reg.get(NAME);
    const sha = hash(file);
    const gen = await can.generation();
    await can.exec('echo written > /home/agent/w.txt', { timeout: 0 });
    assert.notEqual(await can.generation(), gen, 'a shell write did not move the generation');
    await reg.save(can.id);
    assert.notEqual(hash(file), sha, 'the shell write was not saved');
    await can.writeFile('/home/agent/api.txt', 'api');
    assert.notEqual(await can.generation(), gen);
    await reg.save(can.id);
    await reg.shutdown({ save: false });

    const again = open();
    const back = await again.get(NAME);
    assert.equal((await back.exec('cat /home/agent/w.txt', { timeout: 0 })).stdout, 'written\n');
    assert.equal(await back.readFile('/home/agent/api.txt', 'utf8'), 'api');
  });

  test('a skipped save keeps savedAt; a forced save (can_save) writes again', async () => {
    const reg = open();
    const can = await reg.get(NAME);
    const savedAt = readJson(file).canMeta.savedAt;
    await reg.save(can.id);
    assert.equal(readJson(file).canMeta.savedAt, savedAt, 'an unchanged save wrote the file');
    await pause(5);
    await reg.manager.save(can.id, { force: true });
    assert.notEqual(readJson(file).canMeta.savedAt, savedAt, 'a forced save did not write');
  });

  test('a deleted index is rebuilt from the files', async () => {
    const indexFile = path.join(storeDir, INDEX_FILE);
    fs.rmSync(indexFile, { force: true });
    const reg = open();
    const names = reg.saved().map((s) => s.name);
    assert.ok(names.includes(NAME), `saved() lost the can: ${names}`);
    const index = readJson(indexFile);
    assert.equal(index.entries[id].name, NAME);
    assert.equal(index.entries[id].size, fs.statSync(file).size);
    assert.equal(index.entries[id].mtimeMs, fs.statSync(file).mtimeMs);
    // a name lookup still finds the can through the rebuilt entry
    assert.equal((await reg.get(NAME)).id, id);
  });

  test('an index that disagrees with a file is corrected', async () => {
    const indexFile = path.join(storeDir, INDEX_FILE);
    const index = readJson(indexFile);
    index.entries[id].size = 1; // no longer matches the file
    index.entries[id].name = 'wrong-name';
    fs.writeFileSync(indexFile, JSON.stringify(index));
    const reg = open();
    const row = reg.saved().find((s) => s.id === id);
    assert.equal(row.name, NAME, 'the stale entry was trusted');
    const fixed = readJson(indexFile);
    assert.equal(fixed.entries[id].name, NAME);
    assert.equal(fixed.entries[id].size, fs.statSync(file).size);
  });

  test('an index entry with no file is dropped, and a can file with no entry is listed', async () => {
    const indexFile = path.join(storeDir, INDEX_FILE);
    const index = readJson(indexFile);
    index.entries['ghost-id'] = { name: 'ghost', createdAt: 0, specKey: null, tools: [], savedAt: null, status: 'saved', size: 3, mtimeMs: 1 };
    delete index.entries[id];
    fs.writeFileSync(indexFile, JSON.stringify(index));
    const reg = open();
    const rows = reg.saved();
    assert.deepEqual(rows.map((s) => s.name), [NAME]);
    const after = readJson(indexFile);
    assert.equal(Object.hasOwn(after.entries, 'ghost-id'), false);
    assert.equal(after.entries[id].name, NAME);
  });

  test('the index file is not a can, and a corrupt index is ignored', async () => {
    fs.writeFileSync(path.join(storeDir, INDEX_FILE), '{not json');
    const reg = open();
    assert.deepEqual(reg.saved().map((s) => s.name), [NAME]);
    assert.equal(readJson(path.join(storeDir, INDEX_FILE)).entries[id].name, NAME);
  });
});
