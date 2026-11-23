// Container benchmark: Docker (through the daemon) and runc / crun (OCI runtimes called directly, no daemon).
// Linux only. Writes one result file in the lib.mjs format, suite "containers".
//
//   node bench/containers.mjs --out <file> [--iterations N] [--tools docker,runc,crun]
//
// --iterations sets the start-true count (default 30). exec-echo (100 runs after 10 warmups), idle-mem (5 reads) and
// parallel-start-10 (10 runs) use the counts in bench/README.md. A scenario that cannot run is recorded as skipped
// with the reason; no number is ever made up. On other operating systems every scenario is skipped.
import { execFile as execFileCallback, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { entry, parseFlags, skipped, timeIt, writeResult } from './lib.mjs';

const execFile = promisify(execFileCallback);

const SCENARIOS = ['start-true', 'exec-echo', 'idle-mem', 'parallel-start-10'];
const KNOWN_TOOLS = ['docker', 'runc', 'crun'];
const IMAGE = 'busybox:latest';
const EXEC_ITERATIONS = 100;
const EXEC_WARMUP = 10;
const IDLE_READS = 5;
const PARALLEL_COUNT = 10;

const unitOf = (scenario) => (scenario === 'idle-mem' ? 'KB' : 'ms');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs a program with an argument list (no shell). A failure names the command and the last lines of its stderr. */
async function run(cmd, args, opts = {}) {
  try {
    const { stdout } = await execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout: 300_000, ...opts });
    return stdout;
  } catch (err) {
    const tail = String(err.stderr || err.message || err).trim().split('\n').slice(-3).join(' | ');
    throw new Error(`${cmd} ${args[0] ?? ''} failed: ${tail}`);
  }
}

/**
 * Starts a detached runc or crun container. With `run -d` the container's init inherits the caller's stdio, so reading
 * the client's output through pipes (execFile) would wait for the container to exit. Discard stdio and wait only for
 * the client process, which exits once the container is started.
 */
function runDetached(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} ${args[0]} timed out`)); }, 60_000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args[0]} -d exited with ${code}`));
    });
  });
}

/** True when `<runtime> state <id>` succeeds, i.e. the container still exists. */
async function exists(runtime, id) {
  try {
    await execFile(runtime, ['state', id], { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

function newId(label) {
  return `bench-${label}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Converts docker's MemUsage text ("1.5MiB / 7.6GiB") to KB (1024 bytes). */
const BYTES = { B: 1, kB: 1e3, KB: 1e3, KiB: 1024, MB: 1e6, MiB: 1024 ** 2, GB: 1e9, GiB: 1024 ** 3, TB: 1e12, TiB: 1024 ** 4 };
export function parseMemUsageKB(text) {
  const used = String(text).split('/')[0].trim();
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(used);
  if (!m || !Object.hasOwn(BYTES, m[2])) throw new Error(`cannot parse docker MemUsage "${String(text).trim()}"`);
  return (Number(m[1]) * BYTES[m[2]]) / 1024;
}

/**
 * One OCI bundle shared by runc and crun: rootfs from `docker export` of busybox:latest. Built once per run.
 * config.json is written per tool and per scenario by writeSpec().
 */
function ensureBundle(shared) {
  shared.bundle ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-bench-'));
    shared.dir = dir;
    const rootfs = path.join(dir, 'rootfs');
    fs.mkdirSync(rootfs);
    let cid;
    try {
      cid = (await run('docker', ['create', IMAGE])).trim();
      const tar = path.join(dir, 'busybox.tar');
      await run('docker', ['export', '-o', tar, cid]);
      await run('tar', ['-xf', tar, '-C', rootfs]);
      fs.rmSync(tar, { force: true });
    } catch (err) {
      throw new Error(`building the rootfs from ${IMAGE} needs docker: ${err.message}`);
    } finally {
      if (cid) await run('docker', ['rm', cid]).catch(() => {});
    }
    return dir;
  })();
  return shared.bundle;
}

/** Writes config.json from `<runtime> spec`, with the given process args, no tty, and the network namespace kept. */
async function writeSpec(runtime, bundle, args) {
  const file = path.join(bundle, 'config.json');
  fs.rmSync(file, { force: true });
  await run(runtime, ['spec'], { cwd: bundle });
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.process.args = args;
  config.process.terminal = false;
  config.linux ??= {};
  config.linux.namespaces ??= [];
  if (!config.linux.namespaces.some((ns) => ns.type === 'network')) config.linux.namespaces.push({ type: 'network' });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** Reads memory.current (cgroup v2) of the container's init process, in KB. */
async function cgroupMemoryKB(runtime, id) {
  const state = JSON.parse(await run(runtime, ['state', id]));
  if (!state.pid) throw new Error(`${runtime} state reports no pid for ${id}`);
  const cgroupLines = fs.readFileSync(`/proc/${state.pid}/cgroup`, 'utf8').split('\n');
  const v2 = cgroupLines.find((line) => line.startsWith('0::'));
  if (!v2) throw new Error('cgroup v2 is not in use (no "0::" entry in /proc/<pid>/cgroup)');
  const file = path.join('/sys/fs/cgroup', v2.slice(3), 'memory.current');
  if (!fs.existsSync(file)) throw new Error(`memory.current not found at ${file}`);
  return Number(fs.readFileSync(file, 'utf8').trim()) / 1024;
}

// ---- docker ----

async function dockerScenarios(iterations) {
  const tool = 'docker';
  const out = [];

  out.push(await scenario('start-true', tool, async () => {
    const samples = await timeIt(() => run('docker', ['run', '--rm', IMAGE, 'true']), { iterations, warmup: 3 });
    return entry({ scenario: 'start-true', tool, samples, notes: `docker run --rm ${IMAGE} true` });
  }));

  out.push(await scenario('exec-echo', tool, async () => {
    const name = newId('docker-exec');
    try {
      await run('docker', ['run', '-d', '--name', name, IMAGE, 'sleep', '3600']);
      const samples = await timeIt(() => run('docker', ['exec', name, 'echo', 'hi']), {
        iterations: EXEC_ITERATIONS, warmup: EXEC_WARMUP,
      });
      return entry({ scenario: 'exec-echo', tool, samples, notes: 'docker exec <running sleep container> echo hi' });
    } finally {
      await run('docker', ['rm', '-f', name]).catch(() => {});
    }
  }));

  out.push(await scenario('idle-mem', tool, async () => {
    const name = newId('docker-idle');
    try {
      await run('docker', ['run', '-d', '--name', name, IMAGE, 'sleep', '3600']);
      const samples = [];
      for (let i = 0; i < IDLE_READS; i++) {
        if (i) await sleep(200);
        samples.push(parseMemUsageKB(await run('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', name])));
      }
      return entry({ scenario: 'idle-mem', tool, unit: 'KB', samples, notes: 'docker stats MemUsage of one idle sleep container' });
    } finally {
      await run('docker', ['rm', '-f', name]).catch(() => {});
    }
  }));

  out.push(await scenario('parallel-start-10', tool, async () => {
    const samples = await timeIt(
      () => Promise.all(Array.from({ length: PARALLEL_COUNT }, () => run('docker', ['run', '--rm', IMAGE, 'true']))),
      { iterations: 10, warmup: 0 },
    );
    return entry({ scenario: 'parallel-start-10', tool, samples, notes: `${PARALLEL_COUNT} docker run --rm at once` });
  }));

  return out;
}

// ---- runc / crun ----

async function startTrue(runtime, bundle) {
  const id = newId(`${runtime}-true`);
  try {
    await run(runtime, ['run', '--bundle', bundle, id]);
  } finally {
    if (await exists(runtime, id)) await run(runtime, ['delete', '-f', id]).catch(() => {});
  }
}

async function runtimeScenarios(runtime, iterations, shared) {
  const tool = runtime;
  const bundleNote = `OCI bundle from ${IMAGE} (docker export), network namespace kept`;
  const out = [];

  out.push(await scenario('start-true', tool, async () => {
    const bundle = await ensureBundle(shared);
    await writeSpec(runtime, bundle, ['true']);
    const samples = await timeIt(() => startTrue(runtime, bundle), { iterations, warmup: 3 });
    return entry({ scenario: 'start-true', tool, samples, notes: `${runtime} run, then delete -f if present. ${bundleNote}` });
  }));

  out.push(await scenario('exec-echo', tool, async () => {
    const bundle = await ensureBundle(shared);
    await writeSpec(runtime, bundle, ['sleep', '3600']);
    const id = newId(`${runtime}-exec`);
    try {
      await runDetached(runtime, ['run', '-d', '--bundle', bundle, id]);
      const samples = await timeIt(() => run(runtime, ['exec', id, 'echo', 'hi']), {
        iterations: EXEC_ITERATIONS, warmup: EXEC_WARMUP,
      });
      return entry({ scenario: 'exec-echo', tool, samples, notes: `${runtime} exec on a running sleep container` });
    } finally {
      await run(runtime, ['kill', id, 'KILL']).catch(() => {});
      await run(runtime, ['delete', '-f', id]).catch(() => {});
    }
  }));

  out.push(await scenario('idle-mem', tool, async () => {
    const bundle = await ensureBundle(shared);
    await writeSpec(runtime, bundle, ['sleep', '3600']);
    const id = newId(`${runtime}-idle`);
    try {
      await runDetached(runtime, ['run', '-d', '--bundle', bundle, id]);
      const samples = [];
      for (let i = 0; i < IDLE_READS; i++) {
        if (i) await sleep(200);
        samples.push(await cgroupMemoryKB(runtime, id));
      }
      return entry({ scenario: 'idle-mem', tool, unit: 'KB', samples, notes: 'cgroup v2 memory.current of one idle sleep container' });
    } finally {
      await run(runtime, ['kill', id, 'KILL']).catch(() => {});
      await run(runtime, ['delete', '-f', id]).catch(() => {});
    }
  }));

  out.push(await scenario('parallel-start-10', tool, async () => {
    const bundle = await ensureBundle(shared);
    await writeSpec(runtime, bundle, ['true']);
    const samples = await timeIt(
      () => Promise.all(Array.from({ length: PARALLEL_COUNT }, () => startTrue(runtime, bundle))),
      { iterations: 10, warmup: 0 },
    );
    return entry({ scenario: 'parallel-start-10', tool, samples, notes: `${PARALLEL_COUNT} ${runtime} run true at once, distinct ids` });
  }));

  return out;
}

// ---- driver ----

/** Runs one scenario; any failure becomes a skipped entry with the reason. */
async function scenario(name, tool, fn) {
  try {
    return await fn();
  } catch (err) {
    return skipped({ scenario: name, tool, unit: unitOf(name), error: err.message });
  }
}

function skipAll(tool, error) {
  return SCENARIOS.map((name) => skipped({ scenario: name, tool, unit: unitOf(name), error }));
}

async function runTool(tool, iterations, shared) {
  if (!KNOWN_TOOLS.includes(tool)) return skipAll(tool, `unknown tool "${tool}"`);
  try {
    await execFile(tool, ['--version'], { timeout: 60_000 });
  } catch (err) {
    const reason = err.code === 'ENOENT'
      ? `${tool} binary not found on PATH`
      : `${tool} --version failed: ${String(err.stderr || err.message).trim().split('\n')[0]}`;
    return skipAll(tool, reason);
  }
  return tool === 'docker'
    ? dockerScenarios(iterations)
    : runtimeScenarios(tool, iterations, shared);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), {
    out: 'bench/out/containers.json',
    iterations: 30,
    tools: KNOWN_TOOLS.join(','),
  });
  if (!Number.isInteger(flags.iterations) || flags.iterations < 1) throw new Error('--iterations must be a positive integer');
  const tools = String(flags.tools).split(',').map((t) => t.trim()).filter(Boolean);

  const results = [];
  const shared = {};
  try {
    if (process.platform !== 'linux') {
      for (const tool of tools) results.push(...skipAll(tool, 'containers need Linux'));
    } else {
      for (const tool of tools) results.push(...await runTool(tool, flags.iterations, shared));
    }
  } finally {
    if (shared.dir) fs.rmSync(shared.dir, { recursive: true, force: true });
  }

  writeResult(flags.out, 'containers', results);
  for (const r of results) {
    console.log(r.ok
      ? `${r.tool} ${r.scenario}: median ${r.median} ${r.unit} (n=${r.samples.length})`
      : `${r.tool} ${r.scenario}: skipped (${r.error})`);
  }
  console.log(`wrote ${flags.out}`);
}

await main();
