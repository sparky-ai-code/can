#!/usr/bin/env node
// Smoke test for an installed copy of Can. CI runs it after each installer is installed, and you can run it by hand.
//
//   node packaging/smoke-test.mjs --can <can command> --can-mcp <can-mcp command> --node <node> --setup <agent-setup.js>
//
// It checks: the CLI runs a can (create, exec, rm); the MCP server answers initialize and lists the can tools over
// stdio; and agent-setup.js reports the skill and the Claude Code entry in place. Exits 0 when every check passes.
// Cans and transfers go to a temporary folder, so the test leaves no saved cans behind.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const key of ['can', 'can-mcp', 'node', 'setup']) {
    if (!opts[key]) throw new Error(`missing --${key}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'can-smoke-'));
const env = { ...process.env, CAN_STORE_DIR: path.join(work, 'cans'), CAN_TRANSFER_DIR: path.join(work, 'transfer') };
const failures = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
}

/** Runs a command line through the shell (the installed shims are .cmd files on Windows) and returns its result. */
function run(command, args) {
  const quoted = [command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  return spawnSync(quoted, { shell: true, env, encoding: 'utf8', timeout: 120000 });
}

function checkCli() {
  const help = run(opts.can, ['help']);
  check('can help exits 0 and prints usage', help.status === 0 && /usage: can/.test(help.stdout), help.stderr);

  const created = run(opts.can, ['create', 'smoke']);
  check('can create makes a can', created.status === 0, created.stderr || created.stdout);

  const exec = run(opts.can, ['exec', 'smoke', '--', 'echo', 'hello-from-can']);
  check('can exec runs a command in the can', exec.status === 0 && exec.stdout.includes('hello-from-can'), exec.stderr || exec.stdout);

  const failing = run(opts.can, ['exec', 'smoke', '--', 'exit 3']);
  check('can exec passes the command exit code through', failing.status === 3, `exit ${failing.status}`);

  const removed = run(opts.can, ['rm', 'smoke']);
  check('can rm deletes the can', removed.status === 0, removed.stderr || removed.stdout);
}

/** Speaks MCP over stdio: initialize, list the tools, and check that the can tools are there. */
function checkMcp() {
  return new Promise((resolve) => {
    const child = spawn(opts['can-mcp'], [], { shell: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = new Map();
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 60000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) replies.set(msg.id, msg);
        } catch {
          stderr += `non-JSON stdout line: ${line}\n`;
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const waitFor = async (id) => {
      for (let i = 0; i < 600 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 100));
      return replies.get(id);
    };

    (async () => {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-test', version: '0' } } });
      const init = await waitFor(1);
      check('can-mcp answers initialize', Boolean(init?.result?.serverInfo), stderr);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const list = await waitFor(2);
      const names = (list?.result?.tools ?? []).map((t) => t.name);
      check('can-mcp lists the can tools', names.includes('can_create') && names.includes('can_exec') && names.includes('browser_goto'), names.join(', ') || stderr);
      child.stdin.end();
      child.on('exit', () => { clearTimeout(timer); resolve(); });
      setTimeout(() => { child.kill(); resolve(); }, 20000).unref();
    })();
  });
}

function checkSetup() {
  const status = spawnSync(opts.node, [opts.setup, 'status'], { encoding: 'utf8', env, timeout: 60000 });
  check('agent setup reports the skill and Claude Code entry in place', status.status === 0, status.stdout || status.stderr);
  if (status.stdout) for (const line of status.stdout.trim().split('\n')) console.log(`      ${line}`);
}

try {
  checkCli();
  await checkMcp();
  checkSetup();
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nall smoke checks passed');
