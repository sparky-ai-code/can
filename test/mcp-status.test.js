// can_status, can_restart and auto-save, driven through the tool handlers (src/mcp/tools.js) without the stdio server.
// Each test uses its own temporary store, so saved state is real files on disk.
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

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `can-${label}-`));
  dirs.push(dir);
  return dir;
}

/** A registry on `storeDir` with its tools as a name -> run map. Errors come back as {text, isError}. */
function harness(storeDir, transferRoot) {
  const registry = new CanRegistry({ storeDir });
  registries.push(registry);
  const byName = new Map(createTools(registry, { transferRoot }).map((t) => [t.name, t]));
  const call = async (name, args = {}) => {
    const tool = byName.get(name);
    assert.ok(tool, `no tool named ${name}`);
    try {
      return { text: await tool.run(args), isError: false };
    } catch (err) {
      return { text: err.message, isError: true, code: err.code };
    }
  };
  const ok = async (name, args) => {
    const r = await call(name, args);
    assert.equal(r.isError, false, `${name} failed: ${r.text}`);
    return r.text;
  };
  return { registry, call, ok, tools: byName };
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

describe('can_status, can_restart and auto-save', LONG, () => {
  const storeDir = tempDir('status-store');
  const transferRoot = tempDir('status-transfer');
  const h = harness(storeDir, transferRoot);

  test('can_status shows the state, memory, tools, processes, ports, sweep and last error', async () => {
    await h.ok('can_create', { name: 'st' });
    const text = await h.ok('can_status', { can: 'st' });
    assert.match(text, /^can "st" \(id /);
    assert.match(text, /state: ready/);
    assert.match(text, /memory: /);
    assert.match(text, /tools: none declared in environment\.tools/);
    assert.match(text, /processes: none/);
    assert.match(text, /ports: none/);
    assert.match(text, /startup sweep: removed \d+ leftover file\(s\)/);
    assert.match(text, /last error: none/);

    // can_ps and can_ports are kept alongside it (owner decision 7).
    assert.equal(await h.ok('can_ps', { can: 'st' }), 'no processes');
    assert.equal(await h.ok('can_ports', { can: 'st' }), 'no listening ports');
  });

  test('can_status on an unknown can is ENOENT with a Next step', async () => {
    const r = await h.call('can_status', { can: 'nobody' });
    assert.equal(r.isError, true);
    assert.match(r.text, /^ENOENT: no can "nobody"\. Next: /);
  });

  test('can_status describes a can that is only on disk without starting it', async () => {
    await h.ok('can_create', { name: 'cold' });
    await h.registry.manager.stop('cold');
    const fresh = harness(storeDir, transferRoot);
    const text = await fresh.ok('can_status', { can: 'cold' });
    assert.match(text, /state: saved/);
    assert.equal(fresh.registry.manager.get('cold'), undefined, 'can_status did not boot the VM');
  });

  test('a killed can is reported as crashed, and can_restart brings back its saved files', LONG, async () => {
    await h.ok('can_create', { name: 'crash' });
    await h.ok('can_write_file', { can: 'crash', path: '/home/agent/kept.txt', content: 'kept after crash\n' });

    const before = h.registry.manager.get('crash');
    process.kill(before.vmPid, 'SIGKILL');
    await until(() => before.status === 'crashed');

    const status = await h.ok('can_status', { can: 'crash' });
    assert.match(status, /state: crashed/);
    assert.match(status, /last error: EIO: the can's VM process exited unexpectedly\. Next: call can_restart/);

    const restarted = await h.ok('can_restart', { can: 'crash' });
    assert.match(restarted, /^can "crash" restarted \(it was crashed\) from the save made at \d{4}-\d{2}-\d{2}T[\d:.]+Z\. Processes and ports were not restored\.$/);
    assert.equal(await h.ok('can_read_file', { can: 'crash', path: '/home/agent/kept.txt' }), 'kept after crash\n');
    assert.match(await h.ok('can_status', { can: 'crash' }), /state: ready/);
  });

  test('can_restart on a ready can saves it, restarts it and says so', LONG, async () => {
    await h.ok('can_create', { name: 'ready-restart' });
    await h.ok('can_write_file', { can: 'ready-restart', path: '/home/agent/r.txt', content: 'r\n' });
    const text = await h.ok('can_restart', { can: 'ready-restart' });
    assert.match(text, /was ready: saved first, then stopped and loaded again/);
    assert.match(text, /Processes and ports were not restored\.$/);
    assert.equal(await h.ok('can_read_file', { can: 'ready-restart', path: '/home/agent/r.txt' }), 'r\n');
  });

  test('can_restart on an unknown can is ENOENT with a Next step', async () => {
    const r = await h.call('can_restart', { can: 'nobody' });
    assert.equal(r.isError, true);
    assert.equal(r.code, 'ENOENT');
    assert.match(r.text, /Next: call can_list/);
  });

  test('auto-save: a file written by can_exec is on disk before the result returns', LONG, async () => {
    await h.ok('can_create', { name: 'auto' });
    const r = await h.ok('can_exec', { can: 'auto', command: 'echo saved > /home/agent/auto.txt' });
    assert.doesNotMatch(r, /auto-save failed/);
    // Stop the VM and load the can again in a fresh registry: the file must come from disk.
    await h.registry.manager.stop('auto');
    const fresh = harness(storeDir, transferRoot);
    assert.equal(await fresh.ok('can_read_file', { can: 'auto', path: '/home/agent/auto.txt' }), 'saved\n');
  });

  test('can_exec and can_write_file describe what they support', async () => {
    const exec = h.tools.get('can_exec').description;
    assert.match(exec, /\$\(\.\.\.\)/);
    assert.match(exec, /heredocs/);
    assert.match(exec, /Not supported: case/);
    assert.match(h.tools.get('can_destroy').description, /cannot be undone/);
    assert.match(h.tools.get('can_destroy').description, /any state/);
    assert.match(h.tools.get('can_save').description, /automatically/);
  });
});
