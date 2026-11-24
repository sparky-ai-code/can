import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { helperPath, startMemoryMonitor } from '../src/vm/memcap.js';

const MB = 1024 * 1024;

// The child waits 1.5 s (so the monitor is attached first), then allocates 20 MB chunks, filled so the pages are
// committed, up to the target. It prints DONE at the target, or ALLOC_FAILED when an allocation throws.
const ALLOCATOR = `
const MB = 1024 * 1024;
const target = Number(process.argv[1]);
const keep = [];
setTimeout(() => {
  let n = 0;
  const t = setInterval(() => {
    try {
      keep.push(Buffer.alloc(20 * MB, 1));
    } catch (err) {
      clearInterval(t);
      console.log('ALLOC_FAILED ' + n);
      process.exit(3);
    }
    n += 20;
    console.log('ALLOCATED ' + n);
    if (n >= target) {
      clearInterval(t);
      console.log('DONE');
    }
  }, 100);
}, 1500);
setInterval(() => {}, 1000);
`;

function startChild(targetMb) {
  const child = spawn(process.execPath, ['-e', ALLOCATOR, String(targetMb)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { out: '' };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    state.out += chunk;
  });
  child.stderr.resume();
  state.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, state };
}

async function waitUntil(predicate, ms, label) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('samples rise while the child allocates 300 MB', { timeout: 90000 }, async () => {
  const { child, state } = startChild(300);
  const samples = [];
  const monitor = startMemoryMonitor(child.pid, {
    limitBytes: 1024 * MB,
    onSample: (bytes) => samples.push(bytes),
    onLimit: () => {},
  });
  try {
    await waitUntil(() => state.out.includes('DONE'), 60000, 'the child to allocate 300 MB');
    await sleep(1500);
    assert.ok(samples.length >= 2, `expected several samples, got ${samples.length}`);
    const first = samples[0];
    const peak = Math.max(...samples);
    assert.ok(peak - first >= 200 * MB, `samples did not rise: first ${first}, peak ${peak}`);
    assert.ok(peak >= 280 * MB, `peak ${peak} is below the 300 MB the child allocated`);
  } finally {
    child.kill();
    await state.exited;
    monitor.stop();
  }
});

test('Windows: the job object stops the child at a 200 MB limit', {
  timeout: 90000,
  skip: process.platform !== 'win32' ? 'Windows only' : helperPath() ? false : 'native/win/build/can-memcap.exe is not built',
}, async () => {
  const { child, state } = startChild(300);
  let limitHits = 0;
  const monitor = startMemoryMonitor(child.pid, {
    limitBytes: 200 * MB,
    onSample: () => {},
    onLimit: () => {
      limitHits += 1;
    },
  });
  try {
    const { code } = await Promise.race([
      state.exited,
      sleep(60000).then(() => {
        throw new Error('the child neither finished nor died within 60 s');
      }),
    ]);
    await waitUntil(() => limitHits > 0, 5000, 'onLimit');
    assert.ok(!state.out.includes('DONE'), 'the child allocated 300 MB, so the job did not enforce the limit');
    assert.ok(state.out.includes('ALLOC_FAILED') || code !== 0, `the child should fail its allocation, got exit ${code}`);
    assert.equal(limitHits, 1, 'onLimit fires once');
    assert.equal(monitor.enforced, 'job-object');
  } finally {
    child.kill();
    await state.exited;
    monitor.stop();
  }
});

test('fallback: with the helper disabled, sampling stops the child at a 200 MB limit', { timeout: 90000 }, async () => {
  const saved = process.env.CAN_MEMCAP_DISABLE_HELPER;
  process.env.CAN_MEMCAP_DISABLE_HELPER = '1';
  const { child, state } = startChild(300);
  let limitHits = 0;
  let monitor;
  try {
    monitor = startMemoryMonitor(child.pid, {
      limitBytes: 200 * MB,
      onSample: () => {},
      onLimit: () => {
        limitHits += 1;
        child.kill();
      },
    });
  } finally {
    if (saved === undefined) delete process.env.CAN_MEMCAP_DISABLE_HELPER;
    else process.env.CAN_MEMCAP_DISABLE_HELPER = saved;
  }
  try {
    await Promise.race([
      state.exited,
      sleep(60000).then(() => {
        throw new Error('the child was not stopped within 60 s');
      }),
    ]);
    await sleep(1500);
    // On Linux the cgroup may also hold the limit (enforced 'cgroup'); the sampler is the fallback either way.
    assert.ok(['sampled', 'cgroup'].includes(monitor.enforced), `enforced is ${monitor.enforced}`);
    assert.equal(limitHits, 1, 'onLimit fires once, even while samples stay above the limit');
  } finally {
    child.kill();
    await state.exited;
    monitor.stop();
  }
});

test('invalid arguments are refused with EINVAL', () => {
  assert.throws(() => startMemoryMonitor(0, { limitBytes: MB }), /^Error: EINVAL: pid/);
  assert.throws(() => startMemoryMonitor(process.pid, { limitBytes: 0 }), /^Error: EINVAL: limitBytes/);
});
