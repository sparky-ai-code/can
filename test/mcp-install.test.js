// can_install through the tool handler. The pip path installs from a fake package index on 127.0.0.1 (CAN_PIP_INDEX),
// so nothing reaches the real PyPI or npm registry. Every failure path runs as well.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { CanRegistry } from '../src/registry.js';
import { createTools } from '../src/mcp/tools.js';

const LONG = { timeout: 120_000 };
const dirs = [];
const registries = [];

// ---- a stored (uncompressed) zip holding one wheel, and a PyPI-style JSON index that serves it ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const raw = Buffer.from(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(raw.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, raw);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(raw.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + raw.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const NAME = 'mcpfake';
const VERSION = '1.0.0';
const DIST = `${NAME}-${VERSION}.dist-info`;
const WHEEL = storedZip([
  { name: `${NAME}/__init__.py`, data: 'VALUE = 7\n' },
  { name: `${DIST}/METADATA`, data: `Metadata-Version: 2.1\nName: ${NAME}\nVersion: ${VERSION}\n` },
  { name: `${DIST}/WHEEL`, data: 'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n' },
  { name: `${DIST}/RECORD`, data: '' },
]);
const WHEEL_NAME = `${NAME}-${VERSION}-py3-none-any.whl`;
const WHEEL_SHA = crypto.createHash('sha256').update(WHEEL).digest('hex');

let index;
before(async () => {
  const server = http.createServer((req, res) => {
    const base = `http://${req.headers.host}`;
    const parts = new URL(req.url, base).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (parts[0] === 'files' && parts[1] === WHEEL_NAME) return send(200, WHEEL, 'application/octet-stream');
    if (parts[0] !== 'pypi' || parts[parts.length - 1] !== 'json' || parts[1] !== NAME) return send(404, '{}');
    const file = { filename: WHEEL_NAME, url: `${base}/files/${WHEEL_NAME}`, packagetype: 'bdist_wheel', digests: { sha256: WHEEL_SHA }, yanked: false };
    if (parts.length === 4 && parts[2] !== VERSION) return send(404, '{}');
    return send(200, JSON.stringify({ info: { name: NAME, version: VERSION }, urls: [file], releases: { [VERSION]: [file] } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  index = { base: `http://127.0.0.1:${server.address().port}/pypi/`, close: () => new Promise((resolve) => server.close(resolve)) };
});

after(async () => {
  for (const r of registries) await r.shutdown({ save: false }).catch(() => {});
  if (index) await index.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function harness() {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-install-store-'));
  const transferRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'can-install-transfer-'));
  dirs.push(storeDir, transferRoot);
  const registry = new CanRegistry({ storeDir });
  registries.push(registry);
  const byName = new Map(createTools(registry, { transferRoot }).map((t) => [t.name, t]));
  const call = async (name, args) => {
    try {
      return { text: await byName.get(name).run(args), isError: false };
    } catch (err) {
      return { text: err.message, isError: true, code: err.code };
    }
  };
  return { call };
}

describe('can_install', LONG, () => {
  const { call } = harness();

  test('pip installs from the index and prints the lock line with the wheel sha256', async () => {
    const created = await call('can_create', { name: 'inst', environment: { env: { CAN_PIP_INDEX: index.base } } });
    assert.equal(created.isError, false, created.text);
    const r = await call('can_install', { can: 'inst', manager: 'pip', packages: [NAME] });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^installed with pip in can "inst":/);
    assert.ok(r.text.includes(`${NAME}==${VERSION} --hash=sha256:${WHEEL_SHA}`), r.text);
  });

  test('the installed files are in the can and the install was auto-saved', async () => {
    const r = await call('can_exec', { can: 'inst', command: `test -f /usr/lib/python3.15/site-packages/${NAME}/__init__.py && echo present` });
    assert.match(r.text, /exit code: 0[\s\S]*--- stdout ---\npresent\n/);
    assert.doesNotMatch(r.text, /auto-save failed/);
  });

  test('environment.pip installs a pinned lock line during setup', LONG, async () => {
    const pinned = await call('can_create', {
      name: 'pinned',
      environment: { env: { CAN_PIP_INDEX: index.base }, pip: [`${NAME}==${VERSION} --hash=sha256:${WHEEL_SHA}`] },
    });
    assert.equal(pinned.isError, false, pinned.text);
    assert.match(pinned.text, /pip installed 1 lock line\(s\)/);
    const r = await call('can_exec', { can: 'pinned', command: `test -f /usr/lib/python3.15/site-packages/${NAME}/__init__.py && echo present` });
    assert.match(r.text, /--- stdout ---\npresent\n/);
  });

  test('environment.pip with the wrong hash fails creation and leaves nothing behind', LONG, async () => {
    const bad = await call('can_create', {
      name: 'badhash',
      environment: { env: { CAN_PIP_INDEX: index.base }, pip: [`${NAME}==${VERSION} --hash=sha256:${'0'.repeat(64)}`] },
    });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /pip could not install/);
    const again = await call('can_create', { name: 'badhash', environment: { env: { X: '1' } } });
    assert.equal(again.isError, false, again.text);
  });

  test('an empty package list is EINVAL', async () => {
    const r = await call('can_install', { can: 'inst', manager: 'pip', packages: [] });
    assert.equal(r.isError, true);
    assert.equal(r.code, 'EINVAL');
    assert.match(r.text, /Next: split the list/);
  });

  test('a package the index does not have is an error with the installer\'s own CODE and Next', async () => {
    const r = await call('can_install', { can: 'inst', manager: 'pip', packages: ['no-such-package-for-can-tests'] });
    assert.equal(r.isError, true);
    assert.match(r.text, /^ENOENT: no package named no-such-package-for-can-tests on the index\. Next: /);
  });

  test('an npm install that fails is an error result, not a list', async () => {
    const r = await call('can_install', { can: 'inst', manager: 'npm', packages: ['no-such-package-for-can-tests@1.0.0'] });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.text, /^installed with npm/);
  });
});
