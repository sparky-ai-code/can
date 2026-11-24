// Outbound network for VM cans (src/vm/vm-can.js): a can created with internet: true reaches the internet from inside
// the guest over HTTPS, and a can without it does not. Needs the VM files and the tools disk (spike/README.md).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VmCanManager } from '../src/vm/vm-can.js';
import { vmInstalled, vmPaths } from '../src/vm/qemu.js';

const paths = vmPaths();
const SKIP = vmInstalled(paths) && fs.existsSync(paths.tools) ? false : 'the VM or the tools disk is not installed';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-vm-net-'));
const manager = new VmCanManager({ dir });
const FETCH = "fetch('https://registry.npmjs.org/').then((r) => console.log('status', r.status)).catch((e) => console.log('error', e.cause?.code ?? e.message))";

after(async () => {
  for (const can of manager.list()) await manager.destroy(can.id).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('outbound network for VM cans', { skip: SKIP }, () => {
  test('a can created with internet: true reaches the internet over HTTPS', { timeout: 300000 }, async () => {
    const can = await manager.create({ name: 'online', internet: true });
    const r = await can.exec(`/opt/can/node/bin/node -e "${FETCH}"`, { timeoutMs: 120000 });
    assert.match(r.stdout, /status 200/, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  });

  test('a can created without it has no network', { timeout: 300000 }, async () => {
    const can = await manager.create({ name: 'offline' });
    const r = await can.exec(`/opt/can/node/bin/node -e "${FETCH}"`, { timeoutMs: 120000 });
    assert.match(r.stdout, /error/, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /status/);
  });
});
