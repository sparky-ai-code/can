// Linux memory limit for one can process, through cgroup v2. Used by memcap.js.
//
// The process goes into a child cgroup of its own with memory.max = the can's limit. The kernel kills the process
// when it would go past that, and the monitor reports the kill as a memory limit (oomKills), not a crash. Using
// memory.max rather than memory.high matters: memory.high only throttles, and without swap a process can stall just
// under the line without the monitor ever seeing it reach the limit.
// memory.swap.max is 0 so that the process cannot use swap to get past the limit (swap is not counted in VmRSS).
// This needs cgroup v2 with the memory controller enabled for an ancestor directory this process may write to (root
// in a container or on WSL, or a delegated systemd slice). When that is not so, confineMemory returns null and the
// monitor keeps sampling /proc as before.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/sys/fs/cgroup';

/** This process's cgroup directory under ROOT (from the "0::<path>" line of /proc/self/cgroup), or null. */
function ownCgroupDir() {
  if (!fs.existsSync(path.join(ROOT, 'cgroup.controllers'))) return null;
  const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
  if (!line) return null;
  return path.join(ROOT, line.slice(3).trim());
}

/**
 * The nearest directory from base upward whose child cgroups may use the memory controller (its cgroup.subtree_control
 * lists memory), or null. Enabling memory in a cgroup that holds processes is not allowed, so this walks up instead.
 */
function memoryParent(base) {
  let dir = base;
  for (;;) {
    try {
      const subtree = fs.readFileSync(path.join(dir, 'cgroup.subtree_control'), 'utf8');
      if (/\bmemory\b/.test(subtree)) {
        fs.accessSync(dir, fs.constants.W_OK);
        return dir;
      }
    } catch {
      // Not readable here: try the parent.
    }
    if (dir === ROOT) return null;
    dir = path.dirname(dir);
  }
}

/** Reads the oom_kill count of a cgroup directory, or 0 when it cannot be read. */
function oomKillCount(dir) {
  try {
    const m = /^oom_kill\s+(\d+)$/m.exec(fs.readFileSync(path.join(dir, 'memory.events'), 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Confines pid to a new cgroup with memory.max = limitBytes.
 * Returns {enforced: 'cgroup', oomKills(), release()}, or null when the cgroup cannot be made here.
 * release() removes the cgroup once the process has exited (a cgroup that still holds processes is left alone).
 */
export function confineMemory(pid, { limitBytes }) {
  if (process.platform !== 'linux' || !Number.isFinite(limitBytes) || limitBytes <= 0) return null;
  let dir = null;
  try {
    const base = ownCgroupDir();
    if (!base) return null;
    const parent = memoryParent(base);
    if (!parent) return null;
    dir = path.join(parent, `can-${pid}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'memory.max'), String(Math.floor(limitBytes)));
    // Without this, the kernel pages the process out to swap past memory.max. Swapped pages are not in VmRSS, so the
    // monitor would read a process far over its limit as under it. If the swap limit cannot be set, the cgroup is not
    // a real limit, so none is used.
    fs.writeFileSync(path.join(dir, 'memory.swap.max'), '0');
    fs.writeFileSync(path.join(dir, 'cgroup.procs'), String(pid));
  } catch {
    if (dir) {
      try { fs.rmdirSync(dir); } catch { /* not created, or still in use */ }
    }
    return null;
  }
  const own = dir;
  return {
    enforced: 'cgroup',
    oomKills: () => oomKillCount(own),
    release() {
      try { fs.rmdirSync(own); } catch { /* the process has not exited yet, or the directory is already gone */ }
    },
  };
}
