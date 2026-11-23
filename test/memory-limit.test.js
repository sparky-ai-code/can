// Per-can memory limit (owner decision 11): 700 MB hard, 630 MB soft, V8 heap 600 MB. These tests run real cans.
// Run once normally, and once with CAN_MEMCAP_DISABLE_HELPER=1 to exercise the sampling path on Windows:
//   node --test test/memory-limit.test.js
//   set CAN_MEMCAP_DISABLE_HELPER=1 && node --test test/memory-limit.test.js
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';
import { CAN_LIMIT_BYTES, CAN_SOFT_BYTES, VM_HEAP_MB, vmExecArgv } from '../src/vm/supervisor.js';

const MB = 1024 * 1024; // 1 MB = 1024 * 1024 bytes, as in the code under test
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-memlimit-'));
const managers = [];

function newManager() {
  const m = new CanManager({ storeDir });
  managers.push(m);
  return m;
}

after(async () => {
  for (const m of managers) await m.destroyAll();
  fs.rmSync(storeDir, { recursive: true, force: true });
});

async function until(pred, ms) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for a condition`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * A program that keeps allocating in the can (its own file, run as a background process). Buffers live outside
 * the V8 heap, so they reach the hard limit. `chunkMb` every `everyMs`; errors are caught so only the host stops it.
 */
function bufferHog(chunkMb, everyMs) {
  return `
const MB = 1024 * 1024;
const keep = [];
setInterval(() => { try { keep.push(Buffer.alloc(${chunkMb} * MB, 1)); } catch { /* the host stops us */ } }, ${everyMs});
`;
}

/** A program that keeps adding JS objects to the V8 heap (plain repeated strings are not retained, so they do not grow it). */
const HEAP_HOG = `
const keep = [];
setInterval(() => { keep.push(Array.from({ length: 50000 }, (_, i) => ({ i, s: 'k' + i + '-' + keep.length }))); }, 5);
`;

async function startHog(can, name, source) {
  await can.writeFile(`/home/agent/${name}`, source);
  return can.spawn(`node ${name}`);
}

describe('memory info of a can (src/can.js, src/vm/supervisor.js)', () => {
  test('memoryInfo has the I4 shape and the 700 MB hard and 630 MB soft limits', async () => {
    const can = await newManager().create({ name: 'mem-shape' });
    const info = can.memoryInfo();
    assert.deepEqual(Object.keys(info).sort(), ['enforced', 'limitBytes', 'peakBytes', 'softBytes', 'usedBytes']);
    assert.equal(info.limitBytes, 700 * MB);
    assert.equal(info.softBytes, 630 * MB);
    assert.equal(CAN_LIMIT_BYTES, 700 * MB);
    assert.equal(CAN_SOFT_BYTES, 630 * MB);
    assert.ok(['job-object', 'sampled'].includes(info.enforced), `enforced is ${info.enforced}`);
    await until(() => can.memoryInfo().usedBytes > 0, 10_000);
    const after1 = can.memoryInfo();
    assert.ok(after1.peakBytes >= after1.usedBytes, 'peak is at least the used figure');
    assert.equal(can.status, 'running');
  });

  test('the V8 heap is capped at 600 MB inside the can VM process', () => {
    assert.equal(VM_HEAP_MB, 600);
    const flags = vmExecArgv({ layer2: true });
    assert.ok(flags.includes('--max-old-space-size=600'));
  });

  test('the VM process may read the bundled and cached toolchain folders (and nothing is writable)', (t) => {
    const script = 'const r = process.argv.slice(1); console.log(JSON.stringify(r.map((d) => process.permission.has("fs.read", d))))';
    const reads = vmExecArgv({}).filter((f) => f.startsWith('--allow-fs-read=')).map((f) => f.slice('--allow-fs-read='.length));
    assert.ok(reads.length >= 4, 'the source, bundled and cache folders and the lock file are listed');
    assert.ok(reads.some((p) => p.endsWith('toolchains.lock.json')), 'the lock file is listed');
    // Node answers has() differently for grants that exist and grants that do not: for an existing folder, the
    // folder itself can answer false (when a granted file's name starts with the folder's name), but a path inside
    // it is allowed; for a missing folder or a file, the path itself is what is checked. Real reads work (see the
    // shell check below), so each grant is probed where Node answers for it.
    const probes = reads.map((p) => (fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'probe') : p));
    const res = spawnSync(process.execPath, [...vmExecArgv({}), '-e', script, ...probes], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout.trim()), probes.map(() => true));
    // The real reads the toolchain code makes: the lock file and the contents of the bundled tool folder.
    const lockDoc = JSON.parse(fs.readFileSync(reads.find((p) => p.endsWith('toolchains.lock.json')), 'utf8'));
    const bundle = path.join(reads.find((p) => p.endsWith('toolchains')), lockDoc.entries[0].sha256);
    // Tools are downloaded only by `can tools fetch` (opt-in), so a checkout or a CI runner may not have the
    // bundled CPython. The grants above are still checked; the real read needs the file, so it runs only when it exists.
    if (fs.existsSync(bundle)) {
      const real = spawnSync(process.execPath, [...vmExecArgv({}), '-e',
        'const fs = require("node:fs"); const [lock, dir] = process.argv.slice(1); console.log(fs.readFileSync(lock, "utf8").length > 0, fs.readdirSync(dir).length > 0)',
        reads.find((p) => p.endsWith('toolchains.lock.json')), bundle], { encoding: 'utf8' });
      assert.equal(real.status, 0, real.stderr);
      assert.equal(real.stdout.trim(), 'true true');

    } else {
      t.diagnostic('skipped the real read: the bundled CPython is not on this machine (fetch it with `can tools fetch python`)');
    }
    const write = spawnSync(process.execPath, [...vmExecArgv({}), '-e', 'process.permission.has("fs.write", process.argv[1]) ? console.log("W") : console.log("R")', reads[1]], { encoding: 'utf8' });
    assert.equal(write.stdout.trim(), 'R');
  });
});

describe('hard limit: a can that uses more than 700 MB is stopped', () => {
  test('buffers past the limit: status memory-limit, calls reject with ENOMEM, the host lives on', async () => {
    const manager = newManager();
    const can = await manager.create({ name: 'buffer-hog' });
    await startHog(can, 'hog.js', bufferHog(20, 50));
    await until(() => can.status !== 'running', 45_000);

    assert.equal(can.status, 'memory-limit', 'stopped for memory, not as a crash');
    assert.ok(can.memoryInfo().peakBytes >= 0.9 * CAN_LIMIT_BYTES, `peak ${can.memoryInfo().peakBytes} reached the limit`);
    await assert.rejects(can.exec('echo hi'), {
      code: 'ENOMEM',
      message: /^ENOMEM: can "buffer-hog" used more than its 700 MB memory limit and was stopped\. Its files from the last save are kept\. Next: call can_restart/,
    });
    await assert.rejects(can.readFile('/home/agent/hog.js', 'utf8'), { code: 'ENOMEM' });
    await assert.rejects(can.spawn('echo hi'), { code: 'ENOMEM' });
    assert.equal(process.pid > 0, true, 'the host test process is still alive');
  });

  test('heap growth to the limit ends as a memory stop (ENOMEM), not a crash', async () => {
    const manager = newManager();
    const can = await manager.create({ name: 'heap-hog' });
    await startHog(can, 'heap.js', HEAP_HOG);
    await until(() => can.status !== 'running', 60_000);
    assert.equal(can.status, 'memory-limit');
    await assert.rejects(can.exec('echo hi'), { code: 'ENOMEM' });
  });
});

describe('soft limit: exec and spawn are refused at 630 MB', () => {
  test('at or above the soft limit, exec and spawn reject with the soft ENOMEM text; the hard limit is not reached', async () => {
    const manager = newManager();
    const can = await manager.create({ name: 'soft-hog' });
    // 10 MB every 100 ms: the 70 MB between soft and hard takes about 0.7 s, and the host polls every 25 ms.
    await startHog(can, 'slow.js', bufferHog(10, 100));
    await until(() => can.memoryInfo().usedBytes >= CAN_SOFT_BYTES, 45_000);

    await assert.rejects(can.exec('echo hi'), {
      code: 'ENOMEM',
      message: /^ENOMEM: can "soft-hog" is at \d+ MB of its 700 MB limit\. Next: can_kill a process you no longer need, then retry\.$/,
    });
    await assert.rejects(can.spawn('echo hi'), { code: 'ENOMEM', message: /is at \d+ MB of its 700 MB limit/ });
    assert.equal(can.status, 'running', 'refused, not stopped');
    assert.ok(can.memoryInfo().usedBytes < CAN_LIMIT_BYTES);
  });
});

describe('isolation between cans', () => {
  test('another can in the same manager keeps working after one is memory-limited', async () => {
    const manager = newManager();
    const hog = await manager.create({ name: 'iso-hog' });
    const calm = await manager.create({ name: 'iso-calm' });
    await calm.writeFile('/home/agent/calm.txt', 'still here\n');
    await startHog(hog, 'hog.js', bufferHog(20, 50));
    await until(() => hog.status !== 'running', 45_000);
    assert.equal(hog.status, 'memory-limit');

    assert.equal(manager.get('iso-hog').status, 'memory-limit');
    const r = await calm.exec('cat /home/agent/calm.txt');
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, 'still here\n');
    assert.equal(calm.status, 'running');
    await manager.destroy('iso-hog');
    assert.equal(manager.get('iso-hog'), undefined);
    assert.equal((await calm.exec('echo ok')).stdout.trim(), 'ok');
  });
});
