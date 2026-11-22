// can_ci through the tool handler: the first line of the result names the outcome, and a setup failure is an error.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanRegistry } from '../src/registry.js';
import { createTools } from '../src/mcp/tools.js';

const LONG = { timeout: 120_000 };
const dirs = [];
const registries = [];

after(async () => {
  for (const r of registries) await r.shutdown({ save: false }).catch(() => {});
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function harness() {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-ci-store-'));
  const transferRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'can-ci-transfer-'));
  dirs.push(storeDir, transferRoot);
  const registry = new CanRegistry({ storeDir });
  registries.push(registry);
  const ci = createTools(registry, { transferRoot }).find((t) => t.name === 'can_ci');
  return { registry, run: (args) => ci.run({ ci: args }) };
}

describe('can_ci first line', LONG, () => {
  test('a passing pipeline starts with "pipeline: passed"', async () => {
    const { run } = harness();
    const text = await run({ name: 'green', jobs: [{ name: 'build', steps: [{ run: 'echo built', label: 'compile' }] }] });
    assert.equal(text.split('\n')[0], 'pipeline: passed');
    assert.match(text, /job build: passed/);
  });

  test('a failing step names its job and step on the first line, and keeps the can', async () => {
    const { registry, run } = harness();
    const text = await run({
      name: 'red',
      jobs: [
        { name: 'test', steps: [{ run: 'echo ok', label: 'lint' }, { run: 'echo nope >&2; exit 3', label: 'unit tests' }] },
        { name: 'docs', steps: [{ run: 'true', label: 'never runs' }] },
      ],
    });
    assert.equal(text.split('\n')[0], 'pipeline: failed at job "test", step "unit tests"');
    assert.match(text, /job docs: skipped/);
    const kept = /kept can "([^"]+)"/.exec(text);
    assert.ok(kept, 'a failed run keeps its can');
    assert.ok(registry.manager.get(kept[1]), 'the kept can is live');
  });

  test('a setup failure is an error result, not a report', LONG, async () => {
    const { run } = harness();
    await assert.rejects(
      run({ jobs: [{ name: 'test', steps: [{ run: 'true' }] }], environment: { setup: [{ command: 'exit 2', label: 'install' }] } }),
      (err) => {
        assert.equal(err.message.split('\n')[0], 'pipeline: failed at setup');
        assert.match(err.message, /setup step "install" exited with code 2/);
        return true;
      },
    );
  });
});
