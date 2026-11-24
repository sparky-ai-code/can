// Kept CI cans are removed automatically once a day old: every `can ci` run prunes ci-* cans older than a day before
// it starts. A pruned can is named in the report, a newer ci-* can and a can with another name are left alone, and
// a prune never fails the run.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanRegistry } from '../src/registry.js';
import { runCi } from '../src/ci.js';

const DAY = 86_400_000;

describe('automatic retention of kept CI cans', () => {
  test('a run prunes a ci-* can older than a day, names it, and keeps newer and other cans', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'can-ci-retention-'));
    try {
      const writer = new CanRegistry({ storeDir: store });
      await writer.create('ci-old');
      await writer.create('ci-new');
      await writer.create('mine-old');
      await writer.shutdown({ save: true });
      const backdate = (name, createdAt) => {
        const row = new CanRegistry({ storeDir: store }).saved().find((s) => s.name === name);
        const file = path.join(store, `${row.id}.json`);
        const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
        snap.createdAt = createdAt;
        fs.writeFileSync(file, JSON.stringify(snap));
      };
      backdate('ci-old', Date.now() - 2 * DAY);
      backdate('mine-old', Date.now() - 2 * DAY);

      const reg = new CanRegistry({ storeDir: store });
      const report = await runCi(reg, {
        name: 'retain',
        jobs: [{ name: 'job', steps: [{ run: 'echo ok' }] }],
      });
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.deepEqual(report.pruned, ['ci-old'], 'the day-old ci-* can is pruned and named');
      assert.deepEqual(reg.saved().map((s) => s.name).sort(), ['ci-new', 'mine-old'],
        'a newer ci-* can and a can with another name are kept');
      await reg.shutdown({ save: false });
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  test('a run with nothing to prune reports no pruned cans', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'can-ci-retention-'));
    try {
      const reg = new CanRegistry({ storeDir: store });
      const report = await runCi(reg, {
        name: 'quiet',
        jobs: [{ name: 'job', steps: [{ run: 'echo ok' }] }],
      });
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.equal(report.pruned, undefined);
      await reg.shutdown({ save: false });
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });
});
