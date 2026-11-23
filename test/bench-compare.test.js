import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../bench/compare.mjs';

const runner = { os: 'linux', release: '6.1', arch: 'x64', cpus: 4, memMB: 8192, kvm: true, ci: true, node: 'v22.0.0' };

const canDoc = {
  schema: 1,
  suite: 'can-lite',
  startedAt: '2026-01-01T00:00:00.000Z',
  runner,
  results: [
    { scenario: 'start-true', tool: 'can-lite', unit: 'ms', samples: [100], min: 90, median: 100, p95: 120, max: 130, mean: 105, ok: true, error: null, notes: '' },
    { scenario: 'idle-mem', tool: 'can-lite', unit: 'KB', samples: [51200], min: 51200, median: 51200, p95: 51200, max: 51200, mean: 51200, ok: true, error: null, notes: '' },
  ],
};

const containerDoc = {
  schema: 1,
  suite: 'containers',
  startedAt: '2026-01-01T00:00:00.000Z',
  runner,
  results: [
    { scenario: 'start-true', tool: 'docker', unit: 'ms', samples: [250], min: 200, median: 250, p95: 300, max: 310, mean: 255, ok: true, error: null, notes: '' },
    { scenario: 'start-true', tool: 'crun', unit: 'ms', samples: [], min: 0, median: 0, p95: 0, max: 0, mean: 0, ok: false, error: 'crun not installed', notes: '' },
  ],
};

const rowFor = (md, tool) => md.split('\n').find((line) => line.startsWith(`| ${tool} |`));

test('renderMarkdown: fastest row is 1.0x and a slower row gets its ratio', () => {
  const md = renderMarkdown([canDoc, containerDoc]);
  assert.match(rowFor(md, 'can-lite'), /\| 1\.0x \|$/);
  assert.match(rowFor(md, 'docker'), /\| 2\.5x \|$/);
  assert.match(rowFor(md, 'docker'), /\| containers \/ linux \|/);
});

test('renderMarkdown: a skipped row shows its error text instead of numbers', () => {
  const md = renderMarkdown([canDoc, containerDoc]);
  const row = rowFor(md, 'crun');
  assert.ok(row.includes('error: crun not installed'), row);
  assert.ok(!row.includes('x slower'), row);
});

test('renderMarkdown: one heading per file with the runner, and one section per scenario', () => {
  const md = renderMarkdown([canDoc, containerDoc]);
  assert.match(md, /### can-lite: linux, x64, 4 CPUs, 8192 MB RAM, KVM yes/);
  assert.match(md, /### containers: linux, x64, 4 CPUs, 8192 MB RAM, KVM yes/);
  assert.match(md, /^## start-true$/m);
  assert.match(md, /^## idle-mem$/m);
});
