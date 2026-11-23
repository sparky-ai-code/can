// End to end, the way an AI agent uses the product: bin/can-mcp.js runs as a child process and is driven
// over stdin/stdout with JSON-RPC. The agent builds a small multi-file Node app inside a can (a package.json
// with a start script, a routes module, a JSON "db" file, an HTML page with a form and an inline script,
// a POST handler that redirects, and a cookie login), runs it, tests it with the browser tools, kills it,
// restarts the MCP server and checks that the can and its files survived.
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
const LONG = { timeout: 180_000 };
const APP = '/home/agent/shop';

/** A small MCP client over the child's stdio, the same way an MCP host talks to the server. */
class McpClient {
  constructor(storeDir) {
    this.child = spawn(process.execPath, [MCP_BIN], {
      env: { ...process.env, CAN_STORE_DIR: storeDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.nextId = 1;
    this.waiting = new Map();
    this.messages = [];
    this.badLines = [];
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

  request(method, params) {
    const id = this.nextId++;
    const response = new Promise((resolve) => this.waiting.set(id, resolve));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }

  /** Calls a tool; resolves {text, isError}. A protocol error fails the test. */
  async tool(name, args = {}) {
    const res = await this.request('tools/call', { name, arguments: args });
    assert.equal(res.error, undefined, `protocol error from ${name}: ${JSON.stringify(res.error)}`);
    return { text: res.result.content.map((c) => c.text).join('\n'), isError: res.result.isError === true };
  }

  /** Calls a tool that must succeed; resolves its text. */
  async ok(name, args) {
    const r = await this.tool(name, args);
    assert.equal(r.isError, false, `${name} failed: ${r.text}`);
    return r.text;
  }

  async handshake() {
    const res = await this.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-agent', version: '0.0.0' },
    });
    assert.equal(res.result.serverInfo.name, 'can');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  /** Ends stdin: a clean shutdown that saves running cans. */
  close() {
    this.child.stdin.end();
    return this.exited;
  }
}

async function until(check, { ms = 15_000, every = 100 } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, every));
  }
}

// ---------------------------------------------------------------- the app the agent writes

const PACKAGE_JSON = JSON.stringify({
  name: 'shop',
  version: '1.0.0',
  private: true,
  main: 'server.js',
  scripts: { start: 'node server.js', test: 'node -e "process.exit(0)"' },
}, null, 2) + '\n';

// server.js: listens on an ephemeral port (0), logs the port it got, and hands requests to routes.js.
const SERVER_JS = `const http = require('http');
const { handle } = require('./routes');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    Promise.resolve(handle(req, res, body)).catch((err) => {
      res.statusCode = 500;
      res.end('server error: ' + err.message);
    });
  });
});
server.listen(0, () => {
  console.log('shop listening on port ' + server.address().port);
});
`;

// routes.js: pages, a JSON db file, a POST that redirects, a cookie login.
const ROUTES_JS = `const fs = require('fs');
const path = require('path');
const qs = require('querystring');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'data', 'db.json');
const PAGE_FILE = path.join(__dirname, 'public', 'index.html');
const LOGIN_FILE = path.join(__dirname, 'public', 'login.html');
const sessions = new Map();

function readDb() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2) + '\\n'); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function send(res, status, type, body) { res.writeHead(status, { 'content-type': type }); res.end(body); }
function redirect(res, location, extraHeaders = {}) { res.writeHead(303, { location, ...extraHeaders }); res.end(); }
function cookieJar(req) {
  const jar = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return jar;
}
function userOf(req) { return sessions.get(cookieJar(req).sid) ?? null; }

function handle(req, res, body) {
  const url = new URL(req.url, 'http://localhost');
  const user = userOf(req);

  if (req.method === 'GET' && url.pathname === '/') {
    const items = readDb().items.map((i) => '<li>' + escapeHtml(i.title) + ' (by ' + escapeHtml(i.by) + ')</li>').join('');
    const html = fs.readFileSync(PAGE_FILE, 'utf8')
      .split('{{ITEMS}}').join(items)
      .split('{{COUNT}}').join(String(readDb().items.length))
      .split('{{USER}}').join(escapeHtml(user ?? 'guest'));
    return send(res, 200, 'text/html; charset=utf-8', html);
  }
  if (req.method === 'GET' && url.pathname === '/login') {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(LOGIN_FILE, 'utf8'));
  }
  if (req.method === 'POST' && url.pathname === '/login') {
    const name = String(qs.parse(body).user || '').trim();
    if (!name) return send(res, 400, 'text/plain', 'user is required');
    const token = crypto.randomUUID();
    sessions.set(token, name);
    return redirect(res, '/', { 'set-cookie': 'sid=' + token + '; Path=/; HttpOnly' });
  }
  if (req.method === 'GET' && url.pathname === '/me') {
    if (!user) return send(res, 401, 'text/plain', 'not logged in');
    return send(res, 200, 'text/plain', 'hello ' + user);
  }
  if (req.method === 'POST' && url.pathname === '/items') {
    const title = String(qs.parse(body).title || '').trim();
    if (!title) return redirect(res, '/');
    const db = readDb();
    db.items.push({ id: db.items.length + 1, title, by: user ?? 'guest' });
    writeDb(db);
    return redirect(res, '/');
  }
  if (req.method === 'GET' && url.pathname === '/api/items') {
    return send(res, 200, 'application/json', JSON.stringify(readDb().items));
  }
  return send(res, 404, 'text/plain', 'no route for ' + req.method + ' ' + url.pathname);
}

module.exports = { handle };
`;

const PAGE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Shop</title></head>
<body>
  <h1>Shop</h1>
  <p>Signed in as <span id="who">{{USER}}</span>. <a href="/login">Log in</a></p>
  <p id="status">waiting for script</p>
  <form method="post" action="/items" id="add">
    <label for="title">Item title</label>
    <input id="title" name="title" type="text">
    <button type="submit">Add item</button>
  </form>
  <ul id="items">{{ITEMS}}</ul>
  <script>
    var count = document.querySelectorAll('#items li').length;
    document.getElementById('status').textContent = 'script ran: ' + count + ' items';
    document.getElementById('who').setAttribute('data-ready', 'yes');
  </script>
</body>
</html>
`;

const LOGIN_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Log in</title></head>
<body>
  <h1>Log in</h1>
  <form method="post" action="/login">
    <label for="user">Username</label>
    <input id="user" name="user" type="text">
    <button type="submit">Log in</button>
  </form>
</body>
</html>
`;

const SEED_DB = JSON.stringify({ items: [{ id: 1, title: 'seed item', by: 'guest' }] }, null, 2) + '\n';

// ---------------------------------------------------------------- the scenario

describe('end to end: an agent builds, runs and tests a multi-file web app in a can', LONG, () => {
  let storeDir;
  let client;
  let serverPid;
  let port;

  before(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-e2e-'));
    client = new McpClient(storeDir);
  });

  after(async () => {
    if (client) await client.close();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  test('handshake and tool discovery', async () => {
    await client.handshake();
    const res = await client.request('tools/list', {});
    assert.ok(res.result.tools.some((t) => t.name === 'can_ports'));
  });

  test('create the can and write the app files', async () => {
    assert.match(await client.ok('can_create', { name: 'shop' }), /created can "shop"/);
    await client.ok('can_exec', { can: 'shop', command: `mkdir -p ${APP}/data ${APP}/public` });
    await client.ok('can_write_file', { can: 'shop', path: `${APP}/package.json`, content: PACKAGE_JSON });
    await client.ok('can_write_file', { can: 'shop', path: `${APP}/server.js`, content: SERVER_JS });
    await client.ok('can_write_file', { can: 'shop', path: `${APP}/routes.js`, content: ROUTES_JS });
    await client.ok('can_write_file', { can: 'shop', path: `${APP}/data/db.json`, content: SEED_DB });
    await client.ok('can_write_file', { can: 'shop', path: `${APP}/public/index.html`, content: PAGE_HTML });
    await client.ok('can_write_file', { can: 'shop', path: `${APP}/public/login.html`, content: LOGIN_HTML });

    const listing = await client.ok('can_list_dir', { can: 'shop', path: APP });
    assert.match(listing, /routes\.js/);
    assert.match(listing, /package\.json/);
  });

  test('npm test and npm run read the package.json', async () => {
    const r = await client.tool('can_exec', { can: 'shop', command: `cd ${APP} && npm test`, timeoutMs: 20_000 });
    assert.match(r.text, /exit code: 0/, r.text);
    const scripts = await client.ok('can_read_file', { can: 'shop', path: `${APP}/package.json` });
    assert.match(scripts, /"start": "node server.js"/);
  });

  test('npm start runs in the background and listens on a port', async () => {
    const spawned = await client.ok('can_spawn', { can: 'shop', command: 'npm run start', cwd: APP });
    serverPid = Number(/pid (\d+)/.exec(spawned)[1]);
    port = await until(async () => {
      const text = await client.ok('can_ports', { can: 'shop' });
      return Number(/port (\d+)/.exec(text)?.[1]) || 0;
    });
    assert.ok(port >= 49152, `ephemeral port expected, got ${port}`);
    assert.match(await client.ok('can_ps', { can: 'shop' }), new RegExp(`pid ${serverPid}: running`));
    const logs = await until(async () => {
      const text = await client.ok('can_logs', { can: 'shop', pid: serverPid });
      return /shop listening on port/.test(text) ? text : '';
    });
    assert.match(logs, new RegExp(`shop listening on port ${port}`));
  });

  test('plain HTTP: the GET page, the JSON API and a 404 from can_http', async () => {
    const page = await client.ok('can_http', { can: 'shop', port, path: '/' });
    assert.match(page, /^HTTP 200/m);
    assert.match(page, /seed item/);
    const api = await client.ok('can_http', { can: 'shop', port, path: '/api/items' });
    assert.match(api, /"title":"seed item"/);
    const missing = await client.ok('can_http', { can: 'shop', port, path: '/nope' });
    assert.match(missing, /^HTTP 404/m);
  });

  test('browser: the script updates the DOM on load', async () => {
    const snap = await client.ok('browser_goto', { can: 'shop', url: `http://localhost:${port}/` });
    assert.match(snap, /HTTP status: 200/);
    assert.match(snap, /Shop/);
    // The snapshot reads a paragraph of inline text as one line and keeps its link as a ref.
    assert.match(snap, /text "Signed in as guest\."/);
    assert.match(snap, /link "Log in" \[e\d+\] -> "\/login"/);
    assert.equal(
      await client.ok('browser_text', { can: 'shop', target: '#status' }),
      'script ran: 1 items',
    );
    assert.equal(await client.ok('browser_evaluate', { can: 'shop', code: 'document.getElementById("who").getAttribute("data-ready")' }), '"yes"');
    assert.equal(await client.ok('browser_console', { can: 'shop' }), 'no console messages');
  });

  test('browser: a cookie login, then the session is visible on later pages', async () => {
    const logged = await client.ok('can_http', {
      can: 'shop', port, method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=ghost',
    });
    assert.match(logged, /^HTTP 303/m);
    assert.match(logged, /set-cookie: sid=/);

    assert.match(await client.ok('browser_goto', { can: 'shop', url: `http://localhost:${port}/me` }), /not logged in/);
    await client.ok('browser_goto', { can: 'shop', url: `http://localhost:${port}/login` });
    await client.ok('browser_type', { can: 'shop', target: 'Username', text: 'ada' });
    const after = await client.ok('browser_submit', { can: 'shop' });
    assert.match(after, /navigated: yes/);
    assert.match(after, /Signed in as ada/);
    assert.match(await client.ok('browser_goto', { can: 'shop', url: `http://localhost:${port}/me` }), /hello ada/);
  });

  test('browser: the add-item form posts, redirects back, and the script counts the new row', async () => {
    await client.ok('browser_goto', { can: 'shop', url: `http://localhost:${port}/` });
    await client.ok('browser_type', { can: 'shop', target: 'Item title', text: 'milk' });
    const clicked = await client.ok('browser_click', { can: 'shop', target: 'Add item' });
    assert.match(clicked, /navigated: yes/);
    assert.match(clicked, /URL: http:\/\/localhost:\d+\/$/m, 'the POST redirected back to /');
    assert.match(clicked, /milk \(by ada\)/);
    assert.equal(await client.ok('browser_text', { can: 'shop', target: '#status' }), 'script ran: 2 items');
    assert.equal(await client.ok('browser_query', { can: 'shop', selector: '#items li' }).then((t) => JSON.parse(t).length), 2);
  });

  test('the db file on disk reflects the POST', async () => {
    const db = JSON.parse(await client.ok('can_read_file', { can: 'shop', path: `${APP}/data/db.json` }));
    assert.deepEqual(db.items.map((i) => i.title), ['seed item', 'milk']);
    assert.equal(db.items[1].by, 'ada');
  });

  test('the logs record the requests', async () => {
    const logs = await client.ok('can_logs', { can: 'shop', pid: serverPid, tail: 500 });
    assert.match(logs, /shop listening on port/);
    assert.doesNotMatch(logs, /server error/);
  });

  test('kill the server with SIGTERM: the port closes and the browser cannot reach it', async () => {
    const killed = await client.ok('can_kill', { can: 'shop', pid: serverPid, signal: 'SIGTERM' });
    assert.match(killed, new RegExp(`pid ${serverPid}: exited`));
    assert.equal(await client.ok('can_ports', { can: 'shop' }), 'no listening ports');
    const dead = await client.tool('browser_goto', { can: 'shop', url: `http://localhost:${port}/` });
    assert.equal(dead.isError, true, dead.text);
    assert.match(dead.text, /ECONNREFUSED/);
  });

  test('graceful offline handling: a real internet page via the browser', async (t) => {
    const r = await client.tool('browser_goto', { can: 'shop', url: 'https://example.com/' });
    if (r.isError) {
      if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|ECONNRESET|getaddrinfo/i.test(r.text)) {
        t.skip(`no network: ${r.text.split('\n')[0]}`);
        return;
      }
      assert.fail(`unexpected browser error: ${r.text}`);
    }
    assert.match(r.text, /HTTP status: 200/);
    assert.match(r.text, /Example Domain/);
  });

  test('clean shutdown saves the can and its files', async () => {
    const status = await client.close();
    assert.equal(status.code, 0, client.stderr);
    assert.match(client.stderr, /saved can "shop"/);
  });

  test('a restarted MCP server finds the can saved and its files intact', async () => {
    client = new McpClient(storeDir);
    await client.handshake();
    assert.match(await client.ok('can_list', {}), /name=shop status=saved/);

    const db = JSON.parse(await client.ok('can_read_file', { can: 'shop', path: `${APP}/data/db.json` }));
    assert.equal(db.items.length, 2);
    assert.match(await client.ok('can_read_file', { can: 'shop', path: `${APP}/routes.js` }), /handle\(req, res, body\)/);
    assert.match(await client.ok('can_read_file', { can: 'shop', path: `${APP}/package.json` }), /"start"/);
    assert.equal(await client.ok('can_ps', { can: 'shop' }), 'no processes');
  });

  test('the restarted can runs the app again from the same files', async () => {
    const spawned = await client.ok('can_spawn', { can: 'shop', command: 'npm run start', cwd: APP });
    serverPid = Number(/pid (\d+)/.exec(spawned)[1]);
    port = await until(async () => Number(/port (\d+)/.exec(await client.ok('can_ports', { can: 'shop' }))?.[1]) || 0);
    const page = await client.ok('browser_goto', { can: 'shop', url: `http://localhost:${port}/` });
    assert.match(page, /milk \(by ada\)/);
    assert.equal(await client.ok('browser_text', { can: 'shop', target: '#status' }), 'script ran: 2 items');
    // Sessions live in the server's memory, so a restart signs everyone out.
    assert.match(await client.ok('browser_goto', { can: 'shop', url: `http://localhost:${port}/me` }), /not logged in/);
    await client.ok('can_kill', { can: 'shop', pid: serverPid });
  });

  test('destroy the can at the end', async () => {
    assert.match(await client.ok('can_destroy', { can: 'shop' }), /destroyed can "shop"/);
    // index.json is the store's cache of the can files (src/store-index.js), not a can, so it does not count.
    assert.equal(fs.readdirSync(storeDir).filter((f) => f.endsWith('.json') && f !== 'index.json').length, 0);
  });
});
