// File transfer between the host and a can. Covers import and export in-process, the MCP tools over stdio
// (the way an agent calls them), the CLI cp, import and export commands, and the refusals: escapes out of
// the transfer root, links out of it, overwrite without the flag, and the size caps. Host fixtures live in
// a temporary directory under os.tmpdir() and are removed afterwards.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { CanRegistry } from '../src/registry.js';
import { createTools, decodeBase64 } from '../src/mcp/tools.js';
import { validate } from '../src/mcp/server.js';
import { exportFromCan, importToCan, LIMITS, writeTransferFile } from '../src/transfer.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(TEST_DIR, '..', 'bin', 'can.js');
const MCP_BIN = path.resolve(TEST_DIR, '..', 'bin', 'can-mcp.js');
const LONG = { timeout: 120_000 };
const MB = 1024 * 1024;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const randomBinary = (n) => crypto.randomBytes(n);

// ---- fixtures: a real PNG (built by hand, with CRC-32 chunks) and a gzip stream of random bytes

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A valid 8-bit RGB PNG with random pixel data (so it is not compressible text). */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const stride = 1 + width * 3;
  const raw = randomBinary(height * stride);
  for (let y = 0; y < height; y++) raw[y * stride] = 0; // filter type "none" on each row
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Every file (relative path -> sha256) and directory of a host tree, for whole-tree comparison. */
function snapshotTree(dir, rel = '', out = { files: new Map(), dirs: new Set() }) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.dirs.add(r);
      snapshotTree(full, r, out);
    } else {
      out.files.set(r, sha256(fs.readFileSync(full)));
    }
  }
  return out;
}

/** Makes a symbolic link; returns false when the OS refuses (Windows without the link privilege). */
function tryLink(target, link, kind) {
  try {
    fs.symlinkSync(target, link, kind);
    return true;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') return false;
    throw err;
  }
}
const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';

// ---- a CLI run and a small MCP client over stdio (the same protocol an agent uses)

function runCli(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

class McpStdio {
  constructor(env) {
    this.child = spawn(process.execPath, [MCP_BIN], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.nextId = 1;
    this.waiting = new Map();
    this.stderr = '';
    this.exited = new Promise((resolve) => this.child.once('exit', (code) => resolve(code)));
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line); // stdout must carry only protocol messages
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

  /** Calls a tool; a protocol error fails the test. Returns the text and whether it is a tool error. */
  async call(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    assert.equal(res.error, undefined, `protocol error from ${name}: ${JSON.stringify(res.error)}`);
    return { text: res.result.content.map((c) => c.text).join('\n'), isError: res.result.isError === true };
  }

  async close() {
    this.child.stdin.end();
    return this.exited;
  }
}

describe('file transfer between the host and a can', LONG, () => {
  let tmp;
  let hostDir;
  let root;
  let storeDir;
  let reg;
  let can;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-xfer-'));
    hostDir = path.join(tmp, 'host');
    root = path.join(tmp, 'transfer');
    storeDir = path.join(tmp, 'store');
    fs.mkdirSync(hostDir);
    fs.mkdirSync(root);
    reg = new CanRegistry({ storeDir });
    can = await reg.create('xfer');
  });

  after(async () => {
    await reg.shutdown({ save: false });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const hostFile = (rel, content) => {
    const full = path.join(hostDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  };

  test('text survives import then export byte for byte', async () => {
    const text = 'line one\r\nline two: café ✓\n';
    const src = hostFile('notes.txt', text);
    const imp = await importToCan(can, src, '/home/agent/notes.txt');
    assert.equal(imp.files, 1);
    assert.equal(imp.bytes, Buffer.byteLength(text));
    assert.equal(await can.readFile('/home/agent/notes.txt', 'utf8'), text);
    const out = await exportFromCan(can, '/home/agent/notes.txt', 'text/notes.txt', { root });
    assert.equal(out.bytes, Buffer.byteLength(text));
    assert.equal(sha256(fs.readFileSync(path.join(root, 'text', 'notes.txt'))), sha256(fs.readFileSync(src)));
  });

  test('a PNG, a gzip stream and all 256 byte values round-trip with the same sha256', async () => {
    const png = makePng(37, 23);
    const gz = zlib.gzipSync(randomBinary(200_000));
    const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const files = {
      'art/image.png': png,
      'data/archive.gz': gz,
      'data/allbytes.bin': allBytes,
    };
    for (const [rel, bytes] of Object.entries(files)) {
      const src = hostFile(rel, bytes);
      await importToCan(can, src, `/app/assets/${rel}`);
      assert.ok(sha256(await can.readFile(`/app/assets/${rel}`)) === sha256(bytes), `${rel} differs inside the can`);
      await exportFromCan(can, `/app/assets/${rel}`, `binary/${rel}`, { root });
      const back = fs.readFileSync(path.join(root, 'binary', ...rel.split('/')));
      assert.equal(sha256(back), sha256(bytes), `${rel} differs after the round trip`);
    }
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(fs.readFileSync(path.join(root, 'binary', 'art', 'image.png')).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  });

  test('a directory tree imports with its empty and nested folders, and exports back unchanged', async () => {
    const site = path.join(hostDir, 'site');
    hostFile('site/index.html', '<h1>hi</h1>\n');
    hostFile('site/css/app.css', 'body{}');
    hostFile('site/img/logo.png', makePng(8, 8));
    hostFile('site/deep/a/b/c/data.bin', randomBinary(70_000));
    fs.mkdirSync(path.join(site, 'img', 'empty'), { recursive: true });

    const r = await importToCan(can, site, '/app/site');
    const expected = snapshotTree(site);
    assert.equal(r.files, expected.files.size);
    assert.equal(r.dirs, expected.dirs.size);
    assert.equal(r.bytes, [...expected.files.keys()].reduce((n, k) => n + fs.statSync(path.join(site, k)).size, 0));
    assert.deepEqual((await can.listDir('/app/site')).map((e) => e.name).sort(), ['css', 'deep', 'img', 'index.html']);

    await exportFromCan(can, '/app/site', 'sites/site', { root });
    assert.deepEqual(snapshotTree(path.join(root, 'sites', 'site')), expected);
  });

  test('a missing host path is an ENOENT error and writes nothing', async () => {
    const missing = path.join(hostDir, 'absent.txt');
    await assert.rejects(
      importToCan(can, missing, '/app/absent.txt'),
      (err) => err.code === 'ENOENT' && /no such host file or directory/.test(err.message),
    );
    assert.equal(await can.exists('/app/absent.txt'), false);
  });

  test('import keeps an existing file unless overwrite is set', async () => {
    const src = hostFile('ov.txt', 'first');
    await importToCan(can, src, '/app/ov.txt');
    fs.writeFileSync(src, 'second');
    await assert.rejects(importToCan(can, src, '/app/ov.txt'), (err) => err.code === 'EEXIST');
    assert.equal(await can.readFile('/app/ov.txt', 'utf8'), 'first');
    await importToCan(can, src, '/app/ov.txt', { overwrite: true });
    assert.equal(await can.readFile('/app/ov.txt', 'utf8'), 'second');
  });

  test('export keeps an existing host file unless overwrite is set', async () => {
    await can.writeFile('/app/out.txt', 'v1');
    await exportFromCan(can, '/app/out.txt', 'ov/out.txt', { root });
    await can.writeFile('/app/out.txt', 'v2');
    await assert.rejects(exportFromCan(can, '/app/out.txt', 'ov/out.txt', { root }), (err) => err.code === 'EEXIST');
    assert.equal(fs.readFileSync(path.join(root, 'ov', 'out.txt'), 'utf8'), 'v1');
    await exportFromCan(can, '/app/out.txt', 'ov/out.txt', { root, overwrite: true });
    assert.equal(fs.readFileSync(path.join(root, 'ov', 'out.txt'), 'utf8'), 'v2');
  });

  test('export refuses paths that escape the transfer root', async () => {
    await can.writeFile('/app/secret.txt', 'data');
    const attempts = [
      '../escape.txt',
      'sub/../../escape.txt',
      path.join(tmp, 'escape-abs.txt'), // absolute, outside the root
      '/escape-rooted.txt', // rooted: on Windows this is the drive root, outside the root
    ];
    for (const hostPath of attempts) {
      await assert.rejects(
        exportFromCan(can, '/app/secret.txt', hostPath, { root }),
        (err) => err.code === 'EPERM' && /outside the transfer root/.test(err.message),
        `attempt ${hostPath} was not refused`,
      );
    }
    assert.equal(fs.existsSync(path.join(tmp, 'escape.txt')), false);
    assert.equal(fs.existsSync(path.join(tmp, 'escape-abs.txt')), false);
    assert.equal(fs.existsSync(path.join(root, '..', 'escape.txt')), false);

    // An absolute path that names a place inside the root is allowed.
    await exportFromCan(can, '/app/secret.txt', path.join(root, 'abs-ok.txt'), { root });
    assert.equal(fs.readFileSync(path.join(root, 'abs-ok.txt'), 'utf8'), 'data');
  });

  test('export refuses to write through a directory link that points out of the root', async (t) => {
    const outsideDir = path.join(tmp, 'outside-dir');
    fs.mkdirSync(outsideDir);
    if (!tryLink(outsideDir, path.join(root, 'linkdir'), DIR_LINK)) {
      t.skip('this account cannot create directory links');
      return;
    }
    await assert.rejects(exportFromCan(can, '/app/secret.txt', 'linkdir/x.txt', { root }), (err) => err.code === 'EPERM');
    assert.equal(fs.existsSync(path.join(outsideDir, 'x.txt')), false);
  });

  test('export does not overwrite a file through a file link that points out of the root', async (t) => {
    const outsideFile = path.join(tmp, 'outside-file.txt');
    fs.writeFileSync(outsideFile, 'keep');
    if (!tryLink(outsideFile, path.join(root, 'linkfile.txt'), 'file')) {
      t.skip('this account cannot create file links (Windows needs the link privilege)');
      return;
    }
    await assert.rejects(
      exportFromCan(can, '/app/secret.txt', 'linkfile.txt', { root, overwrite: true }),
      (err) => err.code === 'EPERM',
    );
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep');
  });

  test('import refuses a file link that resolves outside the source, and writes nothing', async (t) => {
    const secret = hostFile('elsewhere/secret.txt', 'top secret');
    const tree = path.join(hostDir, 'linked-tree');
    fs.mkdirSync(tree);
    if (!tryLink(secret, path.join(tree, 'peek.txt'), 'file')) {
      t.skip('this account cannot create file links (Windows needs the link privilege)');
      return;
    }
    fs.writeFileSync(path.join(tree, 'fine.txt'), 'fine');
    await assert.rejects(importToCan(can, tree, '/app/linked'), (err) => err.code === 'EPERM');
    assert.equal(await can.exists('/app/linked'), false);
    // The same link as a named source file: its directory is the source, so it is refused too.
    await assert.rejects(importToCan(can, path.join(tree, 'peek.txt'), '/app/peek.txt'), (err) => err.code === 'EPERM');
  });

  test('import follows a file link that stays inside the source tree', async (t) => {
    const tree = path.join(hostDir, 'inner-link');
    hostFile('inner-link/real.txt', 'the real one');
    if (!tryLink(path.join(tree, 'real.txt'), path.join(tree, 'alias.txt'), 'file')) {
      t.skip('this account cannot create file links (Windows needs the link privilege)');
      return;
    }
    await importToCan(can, tree, '/app/inner');
    assert.equal(await can.readFile('/app/inner/alias.txt', 'utf8'), 'the real one');
  });

  test('size caps are enforced per file, per call and by file count, before any write', async () => {
    const small = { ...LIMITS, maxFileBytes: 10, maxCallBytes: 50, maxCallFiles: 3 };
    const big = hostFile('cap/eleven.bin', 'x'.repeat(11));
    await assert.rejects(importToCan(can, big, '/app/cap/eleven.bin', { limits: small }), (err) => err.code === 'EFBIG');
    assert.equal(await can.exists('/app/cap/eleven.bin'), false);

    const ten = hostFile('cap/ten.bin', 'y'.repeat(10));
    await importToCan(can, ten, '/app/cap/ten.bin', { limits: small }); // exactly at the limit is allowed

    for (let i = 0; i < 4; i++) hostFile(`count/f${i}.txt`, 'abcde');
    await assert.rejects(importToCan(can, path.join(hostDir, 'count'), '/app/count', { limits: small }), (err) => err.code === 'EFBIG');
    assert.equal(await can.exists('/app/count'), false);

    for (let i = 0; i < 3; i++) hostFile(`bytes/f${i}.txt`, 'z'.repeat(20));
    const perCall = { ...small, maxFileBytes: 30 }; // 3 x 20 bytes is over the 50-byte call total, each file is fine
    await assert.rejects(importToCan(can, path.join(hostDir, 'bytes'), '/app/bytes', { limits: perCall }), (err) => err.code === 'EFBIG' && /in one call/.test(err.message));
    assert.equal(await can.exists('/app/bytes'), false);

    await can.writeFile('/app/export-big.bin', 'w'.repeat(11));
    await assert.rejects(exportFromCan(can, '/app/export-big.bin', 'cap/out.bin', { root, limits: small }), (err) => err.code === 'EFBIG');
    assert.equal(fs.existsSync(path.join(root, 'cap', 'out.bin')), false);
  });

  test('the default limit is 256 MB per file', async () => {
    const huge = path.join(hostDir, 'huge.bin');
    fs.writeFileSync(huge, Buffer.alloc(0));
    fs.truncateSync(huge, 256 * MB + 1);
    await assert.rejects(
      importToCan(can, huge, '/app/huge.bin'),
      (err) => err.code === 'EFBIG' && /268435456 bytes/.test(err.message),
    );
    assert.equal(await can.exists('/app/huge.bin'), false);
  });

  test('can_write_file and can_read_file move binary with encoding base64', async () => {
    const tools = createTools(reg, { transferRoot: root });
    const tool = (name) => tools.find((t) => t.name === name);
    const bytes = randomBinary(5000);

    const wrote = await tool('can_write_file').run({ can: 'xfer', path: '/app/b64.bin', content: bytes.toString('base64'), encoding: 'base64' });
    assert.equal(wrote, `wrote ${bytes.length} bytes to /app/b64.bin`);
    assert.ok((await can.readFile('/app/b64.bin')).equals(bytes));
    assert.equal(await tool('can_read_file').run({ can: 'xfer', path: '/app/b64.bin', encoding: 'base64' }), bytes.toString('base64'));

    // Default encoding is still utf8 text.
    await tool('can_write_file').run({ can: 'xfer', path: '/app/t.txt', content: 'héllo' });
    assert.equal(await can.readFile('/app/t.txt', 'utf8'), 'héllo');

    await assert.rejects(
      tool('can_write_file').run({ can: 'xfer', path: '/app/bad.bin', content: 'not base64!', encoding: 'base64' }),
      /not valid base64/,
    );
    assert.equal(await can.exists('/app/bad.bin'), false);

    await can.writeFile('/app/empty.bin', '');
    assert.equal(await tool('can_read_file').run({ can: 'xfer', path: '/app/empty.bin', encoding: 'base64' }), '');

    await can.writeFile('/app/large.bin', randomBinary(30 * 1024));
    await assert.rejects(
      tool('can_read_file').run({ can: 'xfer', path: '/app/large.bin', encoding: 'base64' }),
      /can_export/,
    );
  });

  test('the MCP tools are registered with schemas', () => {
    const tools = createTools(reg, { transferRoot: root });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.ok(byName.can_import && byName.can_export);
    assert.deepEqual(byName.can_import.inputSchema.required, ['can', 'hostPath', 'canPath']);
    assert.deepEqual(byName.can_export.inputSchema.required, ['can', 'canPath', 'hostPath']);
    assert.deepEqual(byName.can_write_file.inputSchema.properties.encoding.enum, ['utf8', 'base64']);
    assert.deepEqual(byName.can_read_file.inputSchema.properties.encoding.enum, ['utf8', 'base64']);
  });

  test('over stdio: tools/list shows the tools, and import, export, escape and base64 calls behave', async () => {
    const env = { ...process.env, CAN_STORE_DIR: path.join(tmp, 'mcp-store'), CAN_TRANSFER_DIR: path.join(tmp, 'mcp-root') };
    const client = new McpStdio(env);
    try {
      await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      const list = await client.request('tools/list', {});
      const names = list.result.tools.map((t) => t.name);
      assert.ok(names.includes('can_import') && names.includes('can_export'), names.join(','));

      await client.call('can_create', { name: 'mcpx' });
      const png = makePng(20, 20);
      const src = hostFile('mcp/picture.png', png);
      const imp = await client.call('can_import', { can: 'mcpx', hostPath: src, canPath: '/app/picture.png' });
      assert.equal(imp.isError, false, imp.text);
      assert.match(imp.text, /imported 1 file\(s\), 0 directories, \d+ bytes/);

      const exp = await client.call('can_export', { can: 'mcpx', canPath: '/app/picture.png', hostPath: 'mcp-out/picture.png' });
      assert.equal(exp.isError, false, exp.text);
      assert.equal(sha256(fs.readFileSync(path.join(env.CAN_TRANSFER_DIR, 'mcp-out', 'picture.png'))), sha256(png));

      const escape = await client.call('can_export', { can: 'mcpx', canPath: '/app/picture.png', hostPath: '../../escape.png' });
      assert.equal(escape.isError, true);
      assert.match(escape.text, /EPERM/);

      const missing = await client.call('can_import', { can: 'mcpx', hostPath: path.join(hostDir, 'none.png'), canPath: '/app/x' });
      assert.equal(missing.isError, true);
      assert.match(missing.text, /ENOENT/);

      const blob = randomBinary(3000);
      const written = await client.call('can_write_file', { can: 'mcpx', path: '/app/blob.bin', content: blob.toString('base64'), encoding: 'base64' });
      assert.equal(written.isError, false, written.text);
      const read = await client.call('can_read_file', { can: 'mcpx', path: '/app/blob.bin', encoding: 'base64' });
      assert.equal(Buffer.from(read.text, 'base64').equals(blob), true);
    } finally {
      await client.close();
    }
  });

  test('CLI cp works in both directions, import and export aliases work, and overwrite needs its flag', async () => {
    const env = { ...process.env, CAN_STORE_DIR: path.join(tmp, 'cli-store'), CAN_TRANSFER_DIR: path.join(tmp, 'cli-root') };
    assert.equal((await runCli(['create', 'cli-x'], env)).code, 0);

    const png = makePng(12, 9);
    const src = hostFile('cli/shot.png', png);
    const up = await runCli(['cp', src, 'cli-x:/home/agent/shot.png'], env);
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /copied \d+ bytes/);

    const down = await runCli(['cp', 'cli-x:/home/agent/shot.png', 'cli/back.png'], env);
    assert.equal(down.code, 0, down.stderr);
    assert.match(down.stdout, /to .*back\.png/);
    assert.equal(sha256(fs.readFileSync(path.join(env.CAN_TRANSFER_DIR, 'cli', 'back.png'))), sha256(png));

    const again = await runCli(['cp', src, 'cli-x:/home/agent/shot.png'], env);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /EEXIST/);
    const forced = await runCli(['cp', src, 'cli-x:/home/agent/shot.png', '--overwrite'], env);
    assert.equal(forced.code, 0, forced.stderr);

    const toParent = await runCli(['cp', 'cli-x:/home/agent/shot.png', path.join('..', 'cli-escape.png')], env);
    assert.equal(toParent.code, 1);
    assert.match(toParent.stderr, /EPERM/);

    const viaImport = await runCli(['import', src, 'cli-x:/app/dir/deeper/shot.png'], env);
    assert.equal(viaImport.code, 0, viaImport.stderr);
    const viaExport = await runCli(['export', 'cli-x:/app/dir/deeper/shot.png', 'alias/shot.png'], env);
    assert.equal(viaExport.code, 0, viaExport.stderr);
    assert.equal(sha256(fs.readFileSync(path.join(env.CAN_TRANSFER_DIR, 'alias', 'shot.png'))), sha256(png));

    const wrongWay = await runCli(['import', 'cli-x:/home/agent/shot.png', 'x.png'], env);
    assert.equal(wrongWay.code, 2);
    const noCan = await runCli(['cp', src, 'plain-name'], env);
    assert.equal(noCan.code, 2);
  });

  test('CLI export without CAN_TRANSFER_DIR writes under ~/.can/transfer', async () => {
    const fakeHome = path.join(tmp, 'home');
    fs.mkdirSync(fakeHome);
    const env = { ...process.env, CAN_STORE_DIR: path.join(tmp, 'home-store'), HOME: fakeHome, USERPROFILE: fakeHome };
    delete env.CAN_TRANSFER_DIR;
    assert.equal((await runCli(['create', 'home-x'], env)).code, 0);
    await runCli(['cp', hostFile('home/note.txt', 'in the default root'), 'home-x:/home/agent/note.txt'], env);
    const r = await runCli(['cp', 'home-x:/home/agent/note.txt', 'note.txt'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(fakeHome, '.can', 'transfer', 'note.txt'), 'utf8'), 'in the default root');
  });

  // ---- regression tests for the QA findings (one per finding)

  test('QA 1: two parallel imports to one can path with overwrite false: exactly one wins, the rest get EEXIST', async () => {
    const srcs = ['A', 'B', 'C', 'D', 'E'].map((c, i) => hostFile(`race/src${i}.txt`, c.repeat(8)));
    const results = await Promise.allSettled(srcs.map((s) => importToCan(can, s, '/app/race.txt')));
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.equal(won.length, 1, `expected one winner, got ${won.length}`);
    assert.equal(lost.length, srcs.length - 1);
    for (const r of lost) assert.equal(r.reason.code, 'EEXIST');
    const winner = won[0].value.hostPath;
    assert.equal(await can.readFile('/app/race.txt', 'utf8'), fs.readFileSync(winner, 'utf8'));

    // The same holds for parallel exports of one host path: one writes, the rest get EEXIST and write nothing new.
    const exports = await Promise.allSettled([1, 2, 3, 4].map(() => exportFromCan(can, '/app/race.txt', 'race-out/one.txt', { root })));
    assert.equal(exports.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of exports.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'EEXIST');
  });

  test('QA 2: names that differ only by case are refused before any write, for files and for directories', async () => {
    await can.mkdir('/app/case', { recursive: true });
    await can.writeFile('/app/case/A.txt', 'upper');
    await can.writeFile('/app/case/a.txt', 'lower');
    for (const overwrite of [false, true]) {
      await assert.rejects(
        exportFromCan(can, '/app/case', 'cases/out', { root, overwrite }),
        (err) => err.code === 'EINVAL' && /differ only by case/.test(err.message) && !err.message.includes(root),
      );
      assert.equal(fs.existsSync(path.join(root, 'cases')), false, 'nothing may be written when names collide');
    }

    await can.mkdir('/app/case2/Dir', { recursive: true });
    await can.writeFile('/app/case2/dir', 'a file that folds onto a directory');
    await assert.rejects(exportFromCan(can, '/app/case2', 'cases2', { root }), (err) => err.code === 'EINVAL');
    assert.equal(fs.existsSync(path.join(root, 'cases2')), false);
  });

  test('QA 3: export refuses Windows-unsafe host path segments and can names, for files and for directories', async () => {
    await can.writeFile('/app/winname.txt', 'w');
    const badHostPaths = [
      'dir:x/file.txt', // alternate data stream in a segment
      'stream.txt:ads',
      'CON',
      'nul.txt',
      'com1.log',
      'LPT9',
      'aux',
      'PRN.dat',
      'trailing.',
      'space ',
      'sub/x./y',
      'sub/z /y',
      'sub/COM¹.txt', // superscript digit device name
    ];
    for (const hostPath of badHostPaths) {
      await assert.rejects(exportFromCan(can, '/app/winname.txt', hostPath, { root }), (err) => err.code === 'EINVAL', hostPath);
    }
    assert.equal(fs.existsSync(path.join(root, 'dir:x')), false);
    assert.equal(fs.existsSync(path.join(root, 'sub')), false);

    // Reserved names inside a can directory are refused too, and nothing is written.
    await can.mkdir('/app/wdir/NUL', { recursive: true });
    await can.writeFile('/app/wdir/NUL/ok.txt', 'x');
    await assert.rejects(exportFromCan(can, '/app/wdir', 'wdir-out', { root }), (err) => err.code === 'EINVAL');
    assert.equal(fs.existsSync(path.join(root, 'wdir-out')), false);

    // The screenshot writer applies the same rule.
    assert.throws(() => writeTransferFile(Buffer.from('png'), 'shots/CON.png', { root }), (err) => err.code === 'EINVAL');
    assert.equal(fs.existsSync(path.join(root, 'shots')), false);
  });

  test('QA 4: a can path that is itself a link is refused for files and directories; links inside a directory are skipped', async () => {
    const lk = await reg.create('links');
    await lk.mkdir('/app/tree/inner', { recursive: true });
    await lk.writeFile('/app/tree/real.txt', 'real');
    await lk.writeFile('/app/target.txt', 'target');
    // The can API has no link call, so the links are added to a snapshot of this can, which is then restored.
    const snap = await lk.snapshot();
    const now = Date.now();
    const link = (target) => ({ type: 'symlink', mode: 511, mtime: now, ctime: now, birthtime: now, target });
    const app = snap.vfs.root.entries.app.entries;
    app.filelink = link('/app/target.txt');
    app.dirlink = link('/app/tree');
    app.tree.entries.inside = link('/app/tree/real.txt');
    await lk.restore(snap);

    await assert.rejects(exportFromCan(lk, '/app/filelink', 'links/file.txt', { root }), (err) => err.code === 'EPERM' && /symbolic link/.test(err.message));
    await assert.rejects(exportFromCan(lk, '/app/dirlink', 'links/dir', { root }), (err) => err.code === 'EPERM');
    assert.equal(fs.existsSync(path.join(root, 'links')), false, 'a refused link writes nothing');

    const r = await exportFromCan(lk, '/app/tree', 'links/tree', { root });
    assert.equal(r.skipped, 1, 'the link inside the directory is skipped and counted');
    assert.deepEqual([...snapshotTree(path.join(root, 'links', 'tree')).files.keys()], ['real.txt']);
    await reg.destroy('links');
  });

  test('QA 5: error text names only relative or base names, never a host path or a user folder; a file in a folder place is ENOTDIR', async () => {
    const leaks = (msg) => msg.includes(tmp) || msg.includes(hostDir) || msg.includes(root) || /[A-Za-z]:[\\/]/.test(msg) || /Users[\\/]/i.test(msg);
    const errorsOf = async (fn) => {
      try {
        await fn();
      } catch (err) {
        return err;
      }
      return assert.fail('expected an error');
    };

    const missing = await errorsOf(() => importToCan(can, path.join(hostDir, 'nope', 'missing.txt'), '/app/x'));
    assert.equal(missing.code, 'ENOENT');
    assert.equal(leaks(missing.message), false, missing.message);

    hostFile('leak/held.txt', 'held');
    await can.writeFile('/app/leak.txt', 'v1');
    await exportFromCan(can, '/app/leak.txt', 'leak/out.txt', { root });
    const eexist = await errorsOf(() => exportFromCan(can, '/app/leak.txt', 'leak/out.txt', { root }));
    assert.equal(eexist.code, 'EEXIST');
    assert.equal(leaks(eexist.message), false, eexist.message);

    const escape = await errorsOf(() => exportFromCan(can, '/app/leak.txt', path.join(tmp, 'outside.txt'), { root }));
    assert.equal(escape.code, 'EPERM');
    assert.equal(leaks(escape.message), false, escape.message);

    // A host file where a folder belongs: ENOTDIR, not a raw mkdir error.
    fs.writeFileSync(path.join(root, 'blocker'), 'a file');
    const notDir = await errorsOf(() => exportFromCan(can, '/app/leak.txt', 'blocker/x.txt', { root }));
    assert.equal(notDir.code, 'ENOTDIR');
    assert.equal(leaks(notDir.message), false, notDir.message);

    // A can file where a can folder belongs: ENOTDIR too.
    await can.writeFile('/app/notadir.txt', 'file');
    const importNotDir = await errorsOf(() => importToCan(can, hostFile('leak/in.txt', 'in'), '/app/notadir.txt/sub/f.txt'));
    assert.equal(importNotDir.code, 'ENOTDIR');
    assert.equal(await can.exists('/app/notadir.txt/sub'), false);
  });

  test('QA 6: every MCP tool schema rejects unknown arguments, so a typo such as overWrite is an error', async () => {
    const tools = createTools(reg, { transferRoot: root });
    for (const t of tools) assert.equal(t.inputSchema.additionalProperties, false, `${t.name} must set additionalProperties: false`);

    const imp = tools.find((t) => t.name === 'can_import');
    assert.match(validate(imp.inputSchema, { can: 'xfer', hostPath: '/x', canPath: '/app/x', overWrite: true }), /overWrite is not an allowed property/);
    assert.equal(validate(imp.inputSchema, { can: 'xfer', hostPath: '/x', canPath: '/app/x', overwrite: true }), null);
    const exp = tools.find((t) => t.name === 'can_export');
    assert.match(validate(exp.inputSchema, { can: 'xfer', canPath: '/app/x', hostPath: 'y', overWrite: true }), /not an allowed property/);
  });

  test('QA 7: base64 is canonical, UTF-8 writes refuse lone surrogates, and the size limit is checked before decoding', async () => {
    assert.equal(decodeBase64('QQ==').toString(), 'A');
    assert.equal(decodeBase64('QUI=').toString(), 'AB');
    assert.equal(decodeBase64('QUI=\n').toString(), 'AB', 'whitespace is ignored');
    for (const bad of ['QR==', 'QUJ=', 'QQ=Q', 'Q===', 'QUI', 'QU=I', 'QUJD\u0000']) {
      assert.throws(() => decodeBase64(bad), (err) => err.code === 'EINVAL', JSON.stringify(bad));
    }

    // Size: 13 bytes is 20 characters, over the 16-character limit for 10 bytes, so it is refused on length alone.
    assert.throws(() => decodeBase64(Buffer.alloc(13, 1).toString('base64'), 10), (err) => err.code === 'EFBIG');
    // 11 bytes is 16 characters, within the length limit, but decodes to more than 10 bytes.
    assert.throws(() => decodeBase64(Buffer.alloc(11, 1).toString('base64'), 10), (err) => err.code === 'EFBIG');
    assert.equal(decodeBase64(Buffer.alloc(10, 1).toString('base64'), 10).length, 10);

    const tool = (name) => createTools(reg, { transferRoot: root }).find((t) => t.name === name);
    await assert.rejects(tool('can_write_file').run({ can: 'xfer', path: '/app/qr.bin', content: 'QR==', encoding: 'base64' }), /not valid base64/);
    assert.equal(await can.exists('/app/qr.bin'), false);

    await assert.rejects(
      tool('can_write_file').run({ can: 'xfer', path: '/app/lone.txt', content: 'bad \uD800 text' }),
      (err) => err.code === 'EINVAL' && /well-formed/.test(err.message),
    );
    assert.equal(await can.exists('/app/lone.txt'), false, 'a lone surrogate writes nothing');
    await tool('can_write_file').run({ can: 'xfer', path: '/app/pair.txt', content: 'emoji 😀' });
    assert.equal(await can.readFile('/app/pair.txt', 'utf8'), 'emoji 😀');
  });
});
