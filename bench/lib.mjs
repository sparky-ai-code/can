// Shared pieces of the benchmark harness. Every benchmark script writes one result file in this format, and
// bench/compare.mjs merges them into a table.
//
//   result file = {
//     schema: 1,
//     suite: string,                       e.g. "can-lite" or "containers"
//     startedAt: ISO string,
//     runner: { os, release, arch, cpus, memMB, kvm: boolean, ci: boolean, node },
//     results: [{
//       scenario: string,                  start-true | exec-echo | idle-mem | parallel-start-10 (see bench/README.md)
//       tool: string,                      docker | runc | crun | can-lite | can-vm ...
//       unit: "ms" | "KB",
//       samples: number[],
//       min, median, p95, max, mean: number,
//       ok: boolean,                       false when the scenario could not run; then `error` says why
//       error: string | null,
//       notes: string,
//     }],
//   }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/** min, median, p95, max and mean of a list of numbers (nearest-rank percentile). */
export function stats(samples) {
  if (!samples.length) return { min: 0, median: 0, p95: 0, max: 0, mean: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  const round = (n) => Math.round(n * 1000) / 1000;
  return {
    min: round(s[0]),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(s[s.length - 1]),
    mean: round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

/** Runs `fn` `warmup` times unmeasured, then `iterations` times, returning the elapsed ms of each measured run. */
export async function timeIt(fn, { iterations = 30, warmup = 3 } = {}) {
  for (let i = 0; i < warmup; i++) await fn(i);
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn(i);
    samples.push(performance.now() - t0);
  }
  return samples;
}

/** A result entry for a scenario that ran. */
export function entry({ scenario, tool, unit = 'ms', samples, notes = '' }) {
  return { scenario, tool, unit, samples, ...stats(samples), ok: true, error: null, notes };
}

/** A result entry for a scenario that could not run (missing tool, no permission). The reason is kept. */
export function skipped({ scenario, tool, unit = 'ms', error }) {
  return { scenario, tool, unit, samples: [], ...stats([]), ok: false, error: String(error), notes: '' };
}

export function runnerInfo() {
  let kvm = false;
  try { kvm = fs.existsSync('/dev/kvm'); } catch { /* not Linux */ }
  return {
    os: process.platform,
    release: os.release(),
    arch: process.arch,
    cpus: os.cpus().length,
    memMB: Math.round(os.totalmem() / 1048576),
    kvm,
    ci: Boolean(process.env.GITHUB_ACTIONS),
    node: process.version,
  };
}

export function writeResult(file, suite, results) {
  const doc = { schema: 1, suite, startedAt: new Date().toISOString(), runner: runnerInfo(), results };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

/** Reads `--out <file>` and `--iterations <n>` style flags. */
export function parseFlags(argv, defaults = {}) {
  const flags = { ...defaults };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument: ${key}`);
    const value = argv[i + 1];
    flags[key.slice(2)] = /^\d+$/.test(value) ? Number(value) : value;
  }
  return flags;
}
