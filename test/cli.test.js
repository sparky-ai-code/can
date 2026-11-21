// CLI smoke tests: bin/can.js runs as a child process, one invocation per command, the way a shell would.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(TEST_DIR, '..', 'bin', 'can.js');
const MCP = path.resolve(TEST_DIR, '..', 'bin', 'can-mcp.js');
const LONG = { timeout: 120_000 };

/** Runs the CLI (or another bin script) with args and optional stdin. Resolves with code, stdout, stderr. */
function run(args, { storeDir, input = '', script = CLI } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, CAN_STORE_DIR: storeDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('can CLI', LONG, () => {
  let storeDir;
  let scratch;
  const can = 'cli-one';

  before(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-cli-store-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'can-cli-host-'));
  });

  after(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const cli = (args, opts = {}) => run(args, { storeDir, ...opts });

  test('help lists the commands and exits 0', async () => {
    const r = await cli(['help']);
    assert.equal(r.code, 0);
    for (const word of ['create', 'exec', 'spawn', 'cp', 'shell', 'mcp']) assert.match(r.stdout, new RegExp(word));
  });

  test('an unknown command exits 2 with usage', async () => {
    const r = await cli(['frobnicate']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown command "frobnicate"/);
  });

  test('create and ls', async () => {
    const created = await cli(['create', can]);
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /created can "cli-one"/);

    const listed = await cli(['ls']);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /cli-one\s+saved/);
  });

  test('create refuses a duplicate name and an invalid name', async () => {
    const dup = await cli(['create', can]);
    assert.equal(dup.code, 1);
    assert.match(dup.stderr, /EEXIST/);

    const bad = await cli(['create', 'has space']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /invalid can name/);
  });

  test('exec prints stdout and passes arguments through the shell intact', async () => {
    const r = await cli(['exec', can, '--', 'echo', 'hello world']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'hello world\n');

    const quoted = await cli(['exec', can, '--', 'echo', "it's", 'fine']);
    assert.equal(quoted.stdout, "it's fine\n");
  });

  test('exec exits with the command exit code, and a single argument is a shell line', async () => {
    const r = await cli(['exec', can, '--', 'exit 4']);
    assert.equal(r.code, 4);
  });

  test('state persists between separate CLI processes', async () => {
    const w = await cli(['exec', can, '--', 'mkdir -p /app/data && echo persisted > /app/data/note.txt']);
    assert.equal(w.code, 0, w.stderr);
    const r = await cli(['cat', can, '/app/data/note.txt']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'persisted\n');
  });

  test('cp copies a host file into the can (host to can only)', async () => {
    const hostFile = path.join(scratch, 'data.txt');
    fs.writeFileSync(hostFile, 'from the host\n');
    const r = await cli(['cp', hostFile, `${can}:/home/agent/copied.txt`]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /copied 14 bytes/);
    assert.equal((await cli(['cat', can, 'copied.txt'])).stdout, 'from the host\n');
  });

  test('cp rejects a bad destination and a missing host file', async () => {
    const noColon = await cli(['cp', path.join(scratch, 'data.txt'), 'nope']);
    assert.equal(noColon.code, 2);
    const missing = await cli(['cp', path.join(scratch, 'absent.txt'), `${can}:/x`]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /ENOENT/);
  });

  test('shell runs each line in the can and tracks cd', async () => {
    const r = await cli(['shell', can], { input: 'echo from-shell\ncd /app\npwd\nexit\n' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /from-shell/);
    assert.match(r.stdout, /\/app\n/);
  });

  test('shell keeps going after a failing line and reports its exit code', async () => {
    const r = await cli(['shell', can], { input: 'false\necho still-here\nexit\n' });
    assert.match(r.stdout, /\[exit 1\]/);
    assert.match(r.stdout, /still-here/);
  });

  test('browse reports a refused local port', async () => {
    const r = await cli(['browse', can, 'http://localhost:9/']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ECONNREFUSED/);
  });

  test('ps and logs work on a can with no processes', async () => {
    assert.match((await cli(['ps', can])).stdout, /no processes/);
  });

  test('rm deletes the can and its saved state', async () => {
    const r = await cli(['rm', can]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /removed can "cli-one"/);
    assert.match((await cli(['ls'])).stdout, /no cans/);
    const gone = await cli(['cat', can, '/app/data/note.txt']);
    assert.equal(gone.code, 1);
    assert.match(gone.stderr, /ENOENT/);
  });

  test('exec without a command is a usage error', async () => {
    await cli(['create', 'cli-two']);
    const r = await cli(['exec', 'cli-two']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /missing command/);
    await cli(['rm', 'cli-two']);
  });

  test('mcp serves the protocol on stdin/stdout and exits when stdin closes', async () => {
    const init = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli-test', version: '0' } },
    });
    const r = await run(['mcp'], { storeDir, input: `${init}\n`, script: CLI });
    assert.equal(r.code, 0, r.stderr);
    const reply = JSON.parse(r.stdout.trim().split('\n')[0]);
    assert.equal(reply.result.protocolVersion, '2025-06-18');
  });

  test('bin/can-mcp.js exits 0 when stdin closes with no traffic', async () => {
    const r = await run([], { storeDir, input: '', script: MCP });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
  });
});

describe('can ci (CLI)', LONG, () => {
  let storeDir;
  let scratch;

  before(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-cli-ci-store-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'can-cli-ci-host-'));
  });

  after(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const writePipeline = (name, spec) => {
    const file = path.join(scratch, name);
    fs.writeFileSync(file, typeof spec === 'string' ? spec : JSON.stringify(spec));
    return file;
  };
  const ci = (args) => run(['ci', ...args], { storeDir });

  test('a passing pipeline exits 0 and prints its steps', async () => {
    const file = writePipeline('pass.json', { jobs: [{ name: 'test', steps: [{ run: 'echo hello', label: 'greet' }] }] });
    const r = await ci([file]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^CI pipeline passed/m);
    assert.match(r.stdout, /passed\s+greet exit 0/);
  });

  test('a failing step exits 1, and --json prints the report', async () => {
    const file = writePipeline('fail.json', { name: 'broken', jobs: [{ name: 'test', steps: [{ run: 'exit 9', label: 'boom' }] }], keepCan: 'never' });
    const text = await ci([file]);
    assert.equal(text.code, 1, text.stderr);
    assert.match(text.stdout, /CI "broken" failed/);
    const json = await ci([file, '--json']);
    assert.equal(json.code, 1);
    const report = JSON.parse(json.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.jobs[0].steps[0].exitCode, 9);
  });

  test('a bad file is a usage error (exit 2) and no can is made', async () => {
    const bad = writePipeline('bad.json', { jobs: [{ name: 'a', steps: [{ run: 'true', timout: 5 }] }] });
    const r = await ci([bad]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown jobs\[0\].steps\[0\] setting "timout"/);
    const missing = await ci([path.join(scratch, 'nope.json')]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /no such file/);
    const none = await ci([]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /takes a pipeline file/);
  });
});
