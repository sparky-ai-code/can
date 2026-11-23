import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  entry, parseFlags, skipped, stats, timeIt, writeResult,
} from '../bench/lib.mjs';

test('stats uses nearest-rank percentiles', () => {
  const s = stats([5, 1, 3, 2, 4]);
  assert.deepEqual(s, { min: 1, median: 3, p95: 5, max: 5, mean: 3 });
  assert.deepEqual(stats([]), { min: 0, median: 0, p95: 0, max: 0, mean: 0 });
});

test('timeIt runs warmups unmeasured and returns one sample per iteration', async () => {
  let calls = 0;
  const samples = await timeIt(async () => { calls++; }, { iterations: 4, warmup: 2 });
  assert.equal(samples.length, 4);
  assert.equal(calls, 6);
});

test('entry and skipped have the same shape; a skip keeps its reason', () => {
  const ok = entry({ scenario: 'start-true', tool: 'x', samples: [1, 2, 3] });
  const no = skipped({ scenario: 'start-true', tool: 'y', error: 'no docker' });
  assert.deepEqual(Object.keys(ok).sort(), Object.keys(no).sort());
  assert.equal(ok.ok, true);
  assert.equal(no.ok, false);
  assert.equal(no.error, 'no docker');
});

test('writeResult writes the schema and runner info', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'can-bench-')), 'sub', 'r.json');
  writeResult(file, 'unit', [entry({ scenario: 's', tool: 't', samples: [1] })]);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.schema, 1);
  assert.equal(doc.suite, 'unit');
  assert.ok(doc.runner.cpus > 0);
  assert.equal(doc.results.length, 1);
});

test('parseFlags reads pairs and numbers, and refuses a dangling flag', () => {
  assert.deepEqual(parseFlags(['--out', 'a.json', '--iterations', '5'], { x: 1 }), { x: 1, out: 'a.json', iterations: 5 });
  assert.throws(() => parseFlags(['--out']), /bad argument/);
});
