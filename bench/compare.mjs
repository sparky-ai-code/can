#!/usr/bin/env node
// Merges result files (format at the top of bench/lib.mjs) into GitHub-flavoured markdown.
//
//   node bench/compare.mjs <result.json>...
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCENARIO_ORDER = ['start-true', 'exec-echo', 'idle-mem', 'parallel-start-10'];

const fmt = (n) => String(n);
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function scenarioRank(name) {
  const i = SCENARIO_ORDER.indexOf(name);
  return i === -1 ? SCENARIO_ORDER.length : i;
}

/** Renders the parsed result documents as markdown. Pure: no I/O. */
export function renderMarkdown(docs) {
  const out = ['# Benchmark results', ''];
  if (docs.length === 0) return `${out.join('\n')}No result files.\n`;

  out.push('## Runners', '');
  for (const doc of docs) {
    const r = doc.runner ?? {};
    out.push(`### ${doc.suite}: ${r.os}, ${r.arch}, ${r.cpus} CPUs, ${r.memMB} MB RAM, KVM ${r.kvm ? 'yes' : 'no'}`, '');
  }

  // scenario -> rows, each row labelled with its file's suite and os
  const byScenario = new Map();
  for (const doc of docs) {
    for (const res of doc.results ?? []) {
      if (!byScenario.has(res.scenario)) byScenario.set(res.scenario, []);
      byScenario.get(res.scenario).push({ ...res, origin: `${doc.suite} / ${doc.runner?.os}` });
    }
  }

  const scenarios = [...byScenario.keys()].sort((a, b) => scenarioRank(a) - scenarioRank(b) || a.localeCompare(b));
  for (const scenario of scenarios) {
    const rows = byScenario.get(scenario);
    const oks = rows.filter((r) => r.ok);
    const unit = rows[0].unit ?? 'ms';
    const fastest = oks.length ? Math.min(...oks.map((r) => r.median)) : 0;
    const ratio = (r) => (fastest > 0 ? `${(r.median / fastest).toFixed(1)}x` : 'n/a');

    out.push(`## ${scenario}`, '');
    out.push(`| Tool | Suite / OS | Median (${unit}) | p95 | Min | Max | x slower than fastest |`);
    out.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');

    const sortedOks = [...oks].sort((a, b) => a.median - b.median);
    for (const r of sortedOks) {
      out.push(`| ${cell(r.tool)} | ${cell(r.origin)} | ${fmt(r.median)} | ${fmt(r.p95)} | ${fmt(r.min)} | ${fmt(r.max)} | ${ratio(r)} |`);
    }
    for (const r of rows.filter((x) => !x.ok)) {
      out.push(`| ${cell(r.tool)} | ${cell(r.origin)} | ${cell(`error: ${r.error ?? 'unknown'}`)} | - | - | - | - |`);
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

function readDoc(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc?.schema !== 1) throw new Error(`${file}: unsupported schema ${doc?.schema}`);
  return doc;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node bench/compare.mjs <result.json>...');
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(renderMarkdown(files.map(readDoc)));
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  }
}
