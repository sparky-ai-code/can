// MCP server end to end: bin/can-mcp.js runs as a child process and is driven over stdin/stdout with
// JSON-RPC, exactly as an MCP client would. Cans live in a temporary CAN_STORE_DIR.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MCP_BIN = path.resolve(TEST_DIR, '..', 'bin', 'can-mcp.js');
const LONG = { timeout: 120_000 };

const EXPECTED_TOOLS = [
  'can_create', 'can_mounts', 'can_list', 'can_destroy', 'can_save', 'can_exec', 'can_spawn', 'can_ps', 'can_logs',
  'can_kill', 'can_read_file', 'can_write_file', 'can_list_dir', 'can_ports', 'can_http', 'can_import', 'can_export', 'can_ci',
  'browser_goto', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_select', 'browser_submit',
  'browser_text', 'browser_query', 'browser_back', 'browser_evaluate', 'browser_console', 'browser_screenshot',
  'can_record_start', 'can_record_stop', 'computer_screenshot', 'computer_action',
];

/** A small MCP client over the child's stdio. Responses are matched to requests by id. */
class McpClient {
  constructor(storeDir) {
    this.child = spawn(process.execPath, [MCP_BIN], {
      env: { ...process.env, CAN_STORE_DIR: storeDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.nextId = 1;
    this.waiting = new Map();
    this.messages = []; // every parsed line the server wrote to stdout
    this.badLines = []; // stdout lines that were not JSON
    this.stderr = '';
    this.exited = new Promise((resolve) => this.child.once('exit', (code, signal) => resolve({ code, signal })));
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.badLines.push(line);
        return;
      }
      this.messages.push(msg);
      const waiter = this.waiting.get(msg.id);
      if (waiter) {
        this.waiting.delete(msg.id);
        waiter(msg);
      }
    });
  }

  /** Sends a request and resolves with the whole response object (result or error). */
  request(method, params) {
    const id = this.nextId++;
    const response = new Promise((resolve) => this.waiting.set(id, resolve));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Calls a tool and returns {text, isError}. A protocol error fails the test. */
  async tool(name, args = {}) {
    const res = await this.request('tools/call', { name, arguments: args });
    assert.equal(res.error, undefined, `protocol error from ${name}: ${JSON.stringify(res.error)}`);
    return { text: res.result.content.map((c) => c.text).join('\n'), isError: res.result.isError === true };
  }

  /** Calls a tool that must succeed. */
  async ok(name, args) {
    const r = await this.tool(name, args);
    assert.equal(r.isError, false, `${name} failed: ${r.text}`);
    return r.text;
  }

  /** Ends stdin (a clean shutdown) and resolves with the exit status. */
  close() {
    this.child.stdin.end();
    return this.exited;
  }
}

/** Polls a condition until it returns true. */
async function until(check, { ms = 15_000, every = 100 } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, every));
  }
}

// A small web app the agent writes into the can. It listens on 8080 inside the can, which is a port
// on the can's own virtual network. The host cannot see it except through the MCP tools.
const WEB_APP = [
  "const http = require('http');",
  "const qs = require('querystring');",
  "const page = '<!doctype html><title>Demo app</title><h1>Hello from can</h1>' +",
  "  '<form method=\"post\" action=\"/save\"><label for=\"who\">Your name</label>' +",
  "  '<input id=\"who\" name=\"who\">' +",
  "  '<label for=\"c\">Favourite colour</label><select id=\"c\" name=\"c\">' +",
  "  '<option value=\"red\">Red</option><option value=\"blue\">Blue</option></select>' +",
  "  '<button type=\"submit\">Save</button></form>';",
  'http.createServer((req, res) => {',
  "  let body = '';",
  "  req.on('data', (c) => { body += c; });",
  "  req.on('end', () => {",
  "    if (req.method === 'POST' && req.url === '/save') {",
  "      const who = qs.parse(body).who;",
  "      res.setHeader('content-type', 'text/html');",
  "      res.end('<title>Saved</title><p>Saved: ' + who + '</p>');",
  '      return;',
  '    }',
  "    if (req.url === '/hello') { res.end('hello from the can\\n'); return; }",
  "    res.setHeader('content-type', 'text/html');",
  '    res.end(page);',
  '  });',
  '}).listen(8080);',
  '',
].join('\n');

describe('MCP server over stdio', LONG, () => {
  let storeDir;
  let client;
  let webPid;

  before(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-mcp-'));
    client = new McpClient(storeDir);
  });

  after(async () => {
    if (client) await client.close();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  test('initialize handshake reports protocol 2025-06-18 with tools', async () => {
    const res = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    assert.equal(res.result.protocolVersion, '2025-06-18');
    assert.deepEqual(res.result.capabilities.tools, { listChanged: false });
    assert.equal(res.result.serverInfo.name, 'can');
    assert.match(res.result.instructions, /can_create/);
    client.notify('notifications/initialized');
  });

  test('ping, unknown methods, parse errors and notifications', async () => {
    assert.deepEqual((await client.request('ping', {})).result, {});

    const unknown = await client.request('resources/list', {});
    assert.equal(unknown.error.code, -32601);

    client.child.stdin.write('this is not json\n');
    await until(() => client.messages.some((m) => m.id === null && m.error?.code === -32700));

    // A notification gets no response: the next message on stdout is the ping reply.
    client.notify('notifications/cancelled', { requestId: 99 });
    const before = client.messages.length;
    await client.request('ping', {});
    assert.equal(client.messages.length, before + 1);
  });

  test('stdout carries only JSON-RPC messages', () => {
    assert.deepEqual(client.badLines, []);
    for (const m of client.messages) assert.equal(m.jsonrpc, '2.0');
  });

  test('tools/list exposes every tool with a JSON Schema', async () => {
    const res = await client.request('tools/list', {});
    const names = res.result.tools.map((t) => t.name);
    assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());
    for (const t of res.result.tools) {
      assert.ok(t.description.length > 30, `${t.name} needs a real description`);
      assert.equal(t.inputSchema.type, 'object');
    }
  });

  test('bad arguments are tool errors; unknown tools are protocol errors', async () => {
    const missing = await client.tool('can_exec', { can: 'nobody' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Invalid arguments.*command is required/);

    const tooSmall = await client.tool('can_exec', { can: 'x', command: 'true', timeoutMs: 0 });
    assert.equal(tooSmall.isError, true);
    assert.match(tooSmall.text, /timeoutMs must be >= 1/);

    const unknown = await client.request('tools/call', { name: 'can_teleport', arguments: {} });
    assert.equal(unknown.error.code, -32602);
  });

  test('create a can, write a server, run it and call it over HTTP', async () => {
    assert.match(await client.ok('can_create', { name: 'web' }), /created can "web"/);
    await client.ok('can_write_file', { can: 'web', path: '/home/agent/server.js', content: WEB_APP });

    const spawned = await client.ok('can_spawn', { can: 'web', command: 'node server.js' });
    webPid = Number(/pid (\d+)/.exec(spawned)[1]);

    const port = await until(async () => {
      const text = await client.ok('can_ports', { can: 'web' });
      return /port (\d+)/.exec(text)?.[1];
    });
    assert.equal(Number(port), 8080);

    const http = await client.ok('can_http', { can: 'web', port: 8080, path: '/hello' });
    assert.match(http, /^HTTP 200/m);
    assert.match(http, /hello from the can/);
  });

  test('browser_goto returns a snapshot of the page', async () => {
    const text = await client.ok('browser_goto', { can: 'web', url: 'http://localhost:8080/' });
    assert.match(text, /HTTP status: 200/);
    assert.match(text, /Page: "Demo app"/);
    assert.match(text, /Hello from can/);
    assert.match(text, /Your name/);
    assert.match(text, /Save/);
  });

  test('form round trip: type a name, click Save, read the result', async () => {
    const typed = await client.ok('browser_type', { can: 'web', target: 'Your name', text: 'Ada' });
    assert.match(typed, /value is now "Ada"/);

    const clicked = await client.ok('browser_click', { can: 'web', target: 'Save' });
    assert.match(clicked, /navigated: yes/);
    assert.match(clicked, /Saved: Ada/);

    assert.equal(await client.ok('browser_evaluate', { can: 'web', code: 'document.title' }), '"Saved"');
    assert.match(await client.ok('browser_query', { can: 'web', selector: 'p' }), /Saved: Ada/);
    assert.equal(await client.ok('browser_console', { can: 'web' }), 'no console messages');
  });

  test('select, back, snapshot, text and submit work on the same page', async () => {
    assert.match(await client.ok('browser_back', { can: 'web' }), /Your name/);
    assert.match(await client.ok('browser_snapshot', { can: 'web' }), /Page: "Demo app"/);
    assert.match(await client.ok('browser_text', { can: 'web', target: 'h1' }), /Hello from can/);

    const picked = await client.ok('browser_select', { can: 'web', target: 'Favourite colour', value: 'Blue' });
    assert.match(picked, /value is now "blue"/);

    const submitted = await client.ok('browser_submit', { can: 'web' });
    assert.match(submitted, /navigated: yes/);
    assert.match(submitted, /URL: http:\/\/localhost:8080\/save/);
    assert.match(submitted, /Saved:/);
  });

  test('exec returns exit code, stdout and stderr', async () => {
    const ok = await client.ok('can_exec', { can: 'web', command: 'echo hi', cwd: null, timeoutMs: null });
    assert.match(ok, /exit code: 0/);
    assert.match(ok, /--- stdout ---\nhi\n/);

    const failed = await client.tool('can_exec', { can: 'web', command: 'cat /no/such/file' });
    assert.equal(failed.isError, false);
    assert.match(failed.text, /exit code: 1/);
    assert.match(failed.text, /ENOENT/);
  });

  test('can_ci runs a pipeline in a fresh can and reports each step', async () => {
    const pass = await client.ok('can_ci', {
      ci: {
        name: 'mcp-pass',
        jobs: [
          { name: 'build', steps: [{ run: 'echo built', label: 'compile' }] },
          { name: 'test', steps: [{ run: 'echo tested', label: 'unit' }] },
        ],
      },
    });
    assert.match(pass, /^CI "mcp-pass" passed/);
    assert.match(pass, /passed\s+compile exit 0/);

    const fail = await client.tool('can_ci', {
      ci: { jobs: [{ name: 'test', steps: [{ run: 'echo nope >&2; exit 5', label: 'unit' }, { run: 'echo after' }] }] },
    });
    assert.equal(fail.isError, false);
    assert.match(fail.text, /^CI pipeline failed/);
    assert.match(fail.text, /failed\s+unit exit 5/);
    assert.match(fail.text, /\| nope/);
    assert.match(fail.text, /kept can "ci-/);

    const bad = await client.tool('can_ci', { ci: { jobs: [] } });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /at least one entry/);
  }, LONG);

  test('large output is capped at about 20 KB', async () => {
    await client.ok('can_write_file', { can: 'web', path: '/home/agent/big.txt', content: 'x'.repeat(60_000) });
    const text = await client.ok('can_read_file', { can: 'web', path: '/home/agent/big.txt' });
    assert.ok(text.length < 21 * 1024, `got ${text.length} characters`);
    assert.match(text, /bytes omitted/);
  });

  test('files: list a directory and read a file back', async () => {
    const listing = await client.ok('can_list_dir', { can: 'web', path: '/home/agent' });
    assert.match(listing, /server\.js/);
    assert.match(await client.ok('can_read_file', { can: 'web', path: '/home/agent/server.js' }), /createServer/);
  });

  test('processes: ps, logs and kill', async () => {
    const ps = await client.ok('can_ps', { can: 'web' });
    assert.match(ps, new RegExp(`pid ${webPid}: running.*command=node server\\.js`));
    assert.match(await client.ok('can_logs', { can: 'web', pid: webPid }), /--- stdout ---/);

    const killed = await client.ok('can_kill', { can: 'web', pid: webPid, signal: 'SIGKILL' });
    assert.match(killed, new RegExp(`pid ${webPid}: exited`));
    assert.equal(await client.ok('can_ports', { can: 'web' }), 'no listening ports');
  });

  test('can_create refuses a name that is in use; can_list shows the cans', async () => {
    const dup = await client.tool('can_create', { name: 'web' });
    assert.equal(dup.isError, true);
    assert.match(dup.text, /EEXIST/);

    const list = await client.ok('can_list', {});
    assert.match(list, /name=web status=running/);
  });

  test('clean shutdown saves running cans and stops their processes', async () => {
    await client.ok('can_spawn', { can: 'web', command: 'node server.js' });
    await until(async () => (await client.ok('can_ports', { can: 'web' })).includes('8080'));

    const status = await client.close();
    assert.equal(status.code, 0, client.stderr);
    assert.ok(fs.readdirSync(storeDir).some((f) => f.endsWith('.json')), 'the can was saved to disk');
    assert.match(client.stderr, /saved can "web"/);
  });

  test('a new server loads a saved can on first use; can_destroy deletes it', async () => {
    client = new McpClient(storeDir);
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });

    const before = await client.ok('can_list', {});
    assert.match(before, /name=web status=saved/);

    const file = await client.ok('can_read_file', { can: 'web', path: '/home/agent/server.js' });
    assert.match(file, /createServer/);
    assert.match(await client.ok('can_list', {}), /name=web status=running/);

    const gone = await client.ok('can_destroy', { can: 'web' });
    assert.match(gone, /destroyed can "web"/);
    // Other cans may still be saved (a failed can_ci run keeps its can on purpose), so check only this one.
    const savedNames = fs.readdirSync(storeDir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(storeDir, f), 'utf8')).name);
    assert.deepEqual(savedNames.filter((n) => n === 'web'), [], 'the destroyed can has no saved file');
    assert.equal((await client.tool('can_exec', { can: 'web', command: 'true' })).isError, true);
  });

  test('can_save writes state that a restart can read', async () => {
    await client.ok('can_create', { name: 'notes' });
    await client.ok('can_exec', { can: 'notes', command: 'mkdir -p /app/data' });
    await client.ok('can_write_file', { can: 'notes', path: '/app/data/n.txt', content: 'kept\n' });
    const saved = await client.ok('can_save', { can: 'notes' });
    assert.match(saved, /saved can "notes"/);
    await client.close();

    client = new McpClient(storeDir);
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(await client.ok('can_read_file', { can: 'notes', path: '/app/data/n.txt' }), 'kept\n');
    await client.ok('can_destroy', { can: 'notes' });
  });
});
