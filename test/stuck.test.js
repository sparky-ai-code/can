// Stuck watchdog (src/vm/supervisor.js): a can whose program keeps the CPU busy is stopped with ETIMEDOUT, and the
// rest of the host keeps working. CAN_STUCK_IDLE_MS is set short so the test is quick.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-stuck-'));
const managers = [];
const savedIdle = process.env.CAN_STUCK_IDLE_MS;
process.env.CAN_STUCK_IDLE_MS = '1000';

function newManager() {
  const m = new CanManager({ storeDir });
  managers.push(m);
  return m;
}

after(async () => {
  for (const m of managers) await m.destroyAll();
  if (savedIdle === undefined) delete process.env.CAN_STUCK_IDLE_MS;
  else process.env.CAN_STUCK_IDLE_MS = savedIdle;
  fs.rmSync(storeDir, { recursive: true, force: true });
});

describe('stuck watchdog (src/vm/supervisor.js)', () => {
  test('a busy loop is stopped with ETIMEDOUT and status crashed; another can is unaffected', async () => {
    const manager = newManager();
    const spinner = await manager.create({ name: 'spinner' });
    const calm = await manager.create({ name: 'calm' });

    // With a 1 s idle time and a 1 s exec timeout, the stop comes after max(1 s, 1 s + 5 s) of silence.
    await assert.rejects(spinner.exec('node -e "for(;;){}"', { timeout: 1000 }), {
      code: 'ETIMEDOUT',
      message: /^ETIMEDOUT: can "spinner" stopped responding \(a program kept the CPU busy\) and was stopped\. Its files from the last save are kept\. Next: call can_restart, and avoid busy loops or add a timeout\.$/,
    });
    assert.equal(spinner.status, 'crashed');
    await assert.rejects(spinner.exec('echo hi'), { code: 'ETIMEDOUT' });

    const r = await calm.exec('echo still here');
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, 'still here\n');
    assert.equal(calm.status, 'running');
  });

  test('a long program that does not busy-loop is not stopped', async () => {
    const manager = newManager();
    const can = await manager.create({ name: 'patient' });
    // Waits 3 s on a timer with no timeout: the VM stays responsive, so its memory reports keep it alive.
    const r = await can.exec('node -e "setTimeout(() => console.log(\'done\'), 3000)"', { timeout: 0 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'done\n');
    assert.equal(can.status, 'running');
  });
});
