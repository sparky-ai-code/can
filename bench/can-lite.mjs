#!/usr/bin/env node
// Times today's JS can (tool "can-lite") for the four scenarios in bench/README.md.
//
//   node bench/can-lite.mjs --out <file> [--iterations N]
//
// --iterations overrides the measured iteration count of every scenario (the README counts are the defaults).
// The cans live in a temporary store, so ~/.can is never touched. Exit code is 1 only when the result file could
// not be written; a scenario that fails is recorded with ok: false and the error text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';
import { entry, parseFlags, skipped, timeIt, writeResult } from './lib.mjs';

const TOOL = 'can-lite';
const SUITE = 'can-lite';
const PARALLEL = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** create a can, run `true`, destroy it: the whole cycle is timed */
async function startTrue(manager, iterations) {
  const samples = await timeIt(async () => {
    const can = await manager.create();
    try {
      const r = await can.exec('true');
      if (r.exitCode !== 0) throw new Error(`true exited with ${r.exitCode}`);
    } finally {
      await manager.destroy(can.id);
    }
  }, { iterations: iterations ?? 30, warmup: 3 });
  return entry({ scenario: 'start-true', tool: TOOL, samples });
}

/** one running can; only exec('echo hi') is timed */
async function execEcho(manager, iterations) {
  const can = await manager.create();
  try {
    const samples = await timeIt(async () => {
      const r = await can.exec('echo hi');
      const out = String(r.stdout);
      if (out !== 'hi\n') throw new Error(`echo hi printed ${JSON.stringify(out)}, expected "hi\\n"`);
    }, { iterations: iterations ?? 100, warmup: 10 });
    return entry({ scenario: 'exec-echo', tool: TOOL, samples });
  } finally {
    await manager.destroy(can.id);
  }
}

/** a fresh started can each time, memory read 500 ms after it is up; in KB */
async function idleMem(manager, iterations) {
  const samples = [];
  for (let i = 0; i < (iterations ?? 5); i++) {
    const can = await manager.create();
    try {
      await sleep(500);
      samples.push(Math.round(can.memoryInfo().usedBytes / 1024));
    } finally {
      await manager.destroy(can.id);
    }
  }
  return entry({ scenario: 'idle-mem', tool: TOOL, unit: 'KB', samples });
}

/** start 10 cans at once, each running `true`; time until all are done and destroyed */
async function parallelStart(manager, iterations) {
  const samples = await timeIt(async () => {
    const settled = await Promise.allSettled(Array.from({ length: PARALLEL }, () => manager.create()));
    const cans = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    try {
      const failed = settled.find((s) => s.status === 'rejected');
      if (failed) throw failed.reason;
      await Promise.all(cans.map(async (can) => {
        const r = await can.exec('true');
        if (r.exitCode !== 0) throw new Error(`true exited with ${r.exitCode}`);
      }));
    } finally {
      await Promise.all(cans.map((can) => manager.destroy(can.id)));
    }
  }, { iterations: iterations ?? 10, warmup: 0 });
  return entry({ scenario: 'parallel-start-10', tool: TOOL, samples });
}

const SCENARIOS = [
  ['start-true', startTrue, 'ms'],
  ['exec-echo', execEcho, 'ms'],
  ['idle-mem', idleMem, 'KB'],
  ['parallel-start-10', parallelStart, 'ms'],
];

function usage(message) {
  console.error(`${message}\nusage: node bench/can-lite.mjs --out <file> [--iterations N]`);
  process.exitCode = 1;
}

async function main() {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (err) {
    return usage(err.message);
  }
  if (typeof flags.out !== 'string') return usage('--out <file> is required');
  if (flags.iterations !== undefined && !(Number.isInteger(flags.iterations) && flags.iterations > 0)) {
    return usage('--iterations must be a positive integer');
  }
  const iterations = flags.iterations;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-lite-bench-'));
  const manager = new CanManager({ storeDir: path.join(tmp, 'store'), mountsFile: path.join(tmp, 'none.json') });
  const results = [];
  try {
    for (const [scenario, run, unit] of SCENARIOS) {
      try {
        results.push(await run(manager, iterations));
      } catch (err) {
        results.push(skipped({ scenario, tool: TOOL, unit, error: err?.message ?? String(err) }));
      }
    }
  } finally {
    await manager.destroyAll().catch((err) => console.error(`cleanup: ${err.message}`));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  let doc;
  try {
    doc = writeResult(flags.out, SUITE, results);
  } catch (err) {
    console.error(`could not write ${flags.out}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  for (const r of doc.results) {
    if (r.ok) {
      console.log(`${r.scenario}: median ${r.median} ${r.unit}, p95 ${r.p95} ${r.unit}`);
    } else {
      console.log(`${r.scenario}: skipped (${r.error})`);
    }
  }
  console.log(`wrote ${path.resolve(flags.out)}`);
}

await main();
