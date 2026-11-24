// Linux: a child process confined to its own cgroup v2 memory limit (src/vm/cgroup.js). These tests run only on Linux
// and only when this process may create a cgroup (root in a container or on WSL, or a delegated slice). Elsewhere
// they are skipped, and the sampling tests in memcap.test.js cover the monitor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startMemoryMonitor } from '../src/vm/memcap.js';

const MB = 1024 * 1024;
const LINUX = process.platform === 'linux';
const SKIP = LINUX ? false : 'Linux only';

// Allocates and touches 16 MB at a time until it holds 300 MB, then says DONE and sleeps.
const HOG = `
const keep = [];
const t = setInterval(() => {
  keep.push(Buffer.alloc(16 * 1024 * 1024, 1));
  if (keep.length * 16 >= 300) { clearInterval(t); console.log('DONE'); setInterval(() => {}, 1000); }
}, 20);
`;

// The guarantee the cgroup gives: a child that wants 300 MB under a 200 MB cgroup limit never gets to 300 MB. It is held
// at the limit, killed by the kernel, or stopped by the monitor, whichever comes first. (The monitor's own report is
// not asserted here: a process the kernel holds just under the line, with the page cache filling the budget, never
// shows RSS at the limit, so the monitor cannot see it. See src/vm/cgroup.js.)
test('a child that wants more than its cgroup limit never gets there', { skip: SKIP, timeout: 90000 }, async (t) => {
  const child = spawn(process.execPath, ['-e', HOG], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const samples = [];
  let limitFired = false;
  const monitor = startMemoryMonitor(child.pid, {
    limitBytes: 200 * MB,
    onSample: (bytes) => samples.push(bytes),
    onLimit: () => {
      limitFired = true;
      child.kill();
    },
  });
  try {
    if (monitor.enforced !== 'cgroup') {
      t.skip('this process cannot create a cgroup here (cgroup v2 with the memory controller, writable)');
      return;
    }
    const end = Date.now() + 30000;
    while (child.exitCode === null && child.signalCode === null && !out.includes('DONE') && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(out.includes('DONE'), false, 'the child never allocated the 300 MB it asked for');
    const peak = samples.length ? Math.max(...samples) : 0;
    assert.ok(peak < 260 * MB, `peak ${peak} bytes is above the 200 MB limit plus a small margin`);
    // The kernel kills the process at the limit (no swap, see src/vm/cgroup.js); the monitor reports that as a limit.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(limitFired, true, 'the monitor reports the limit when the kernel stops the child');
    assert.equal(monitor.enforced, 'cgroup');
  } finally {
    child.kill();
    monitor.stop();
  }
});

test('a child under its limit runs to the end and is not stopped', { skip: SKIP, timeout: 60000 }, async (t) => {
  const small = `console.log('small'); setTimeout(() => {}, 300);`;
  const child = spawn(process.execPath, ['-e', small], { stdio: ['ignore', 'pipe', 'pipe'] });
  let limitFired = false;
  const monitor = startMemoryMonitor(child.pid, { limitBytes: 500 * MB, onLimit: () => { limitFired = true; } });
  try {
    if (monitor.enforced !== 'cgroup') {
      t.skip('this process cannot create a cgroup here');
      return;
    }
    await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(limitFired, false);
  } finally {
    child.kill();
    monitor.stop();
  }
});
