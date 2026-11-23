// tar, gzip, gunzip, zip and unzip inside a can. Archives are checked against the host's own tar (bsdtar, which
// reads ustar and zip) when it is present, so a can's archive is known to be a real one, not just a can's own format.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { CanManager } from '../src/manager.js';

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-archive-'));
const hostTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-archive-host-'));
const manager = new CanManager({ storeDir });
let counter = 0;
async function makeCan() {
  return manager.create({ name: `ar-${++counter}`, env: { HOME: '/home/agent' } });
}
after(async () => {
  await manager.destroyAll();
  fs.rmSync(storeDir, { recursive: true, force: true });
  fs.rmSync(hostTmp, { recursive: true, force: true });
});

const sh = (can, cmd) => can.exec(cmd, { timeout: 20_000 });

// The host tar used to check archives. On Windows that is System32's bsdtar, which reads zip as well as tar; the
// tar on PATH there may be GNU tar, which reads no zip and mistakes a drive letter for a host name. Tests that need
// it skip when it is absent.
const HOST_TAR = (() => {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')]
    : ['tar'];
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch { /* try the next */ }
  }
  return null;
})();

/** A ustar archive built by hand, for members a can's own tar would refuse to write. */
function ustarOf(members) {
  const parts = [];
  for (const { name, type = '0', data = Buffer.alloc(0), linkname = '' } of members) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100, 8, 'latin1');
    h.write('0000000\0', 108, 8, 'latin1');
    h.write('0000000\0', 116, 8, 'latin1');
    h.write(`${(type === '0' ? data.length : 0).toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
    h.write('00000000000\0', 136, 12, 'latin1');
    h.write('        ', 148, 8, 'latin1');
    h.write(type, 156, 1, 'latin1');
    h.write(linkname, 157, 100, 'utf8');
    h.write('ustar\0', 257, 6, 'latin1');
    h.write('00', 263, 2, 'latin1');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
    parts.push(h);
    if (type === '0' && data.length) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A stored zip of {name, data} entries, built by hand. */
function zipOf(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

describe('tar', () => {
  test('czf packs a folder tree and xzf unpacks it under -C', async () => {
    const can = await makeCan();
    const r = await sh(can, 'mkdir -p src/sub && echo one > src/a.txt && echo two > src/sub/b.txt && tar czf out.tgz src && mkdir dst && tar xzf out.tgz -C dst');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(await can.readFile('/home/agent/dst/src/a.txt', 'utf8'), 'one\n');
    assert.equal(await can.readFile('/home/agent/dst/src/sub/b.txt', 'utf8'), 'two\n');
  });

  test('tf lists the members; tar reads a gzip archive without being told', async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p p && echo x > p/x.txt && tar cf plain.tar p');
    const list = await sh(can, 'tar tf plain.tar');
    assert.equal(list.exitCode, 0, list.stderr);
    assert.match(list.stdout, /^p\/$/m);
    assert.match(list.stdout, /^p\/x\.txt$/m);
    await sh(can, 'gzip -c plain.tar > plain.tar.gz');
    assert.equal((await sh(can, 'tar tf plain.tar.gz')).stdout, list.stdout);
  });

  test('a name longer than 100 bytes round-trips through the ustar prefix', async () => {
    const can = await makeCan();
    const deep = `${'a'.repeat(60)}/${'b'.repeat(60)}/c.txt`;
    await sh(can, `mkdir -p ${path.posix.dirname(deep)}`);
    await can.writeFile(`/home/agent/${deep}`, 'long\n');
    const r = await sh(can, `tar cf long.tar ${deep} && mkdir out && tar xf long.tar -C out`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(await can.readFile(`/home/agent/out/${deep}`, 'utf8'), 'long\n');
  });

  test('a member with ".." in its name is refused and writes nothing outside', async () => {
    const can = await makeCan();
    const evil = ustarOf([{ name: '../escape.txt', data: Buffer.from('bad') }, { name: 'ok.txt', data: Buffer.from('ok') }]);
    await can.writeFile('/home/agent/evil.tar', evil);
    await sh(can, 'mkdir dst');
    const r = await sh(can, 'tar xf evil.tar -C dst');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /outside the destination/);
    assert.equal(await can.readFile('/home/agent/dst/ok.txt', 'utf8'), 'ok');
    await assert.rejects(() => can.readFile('/home/agent/escape.txt'), /ENOENT/);
  });

  test('a symbolic link to an absolute path or through ".." is refused', async () => {
    const can = await makeCan();
    const links = ustarOf([
      { name: 'abs', type: '2', linkname: '/etc/passwd' },
      { name: 'up', type: '2', linkname: '../../secret' },
    ]);
    await can.writeFile('/home/agent/links.tar', links);
    await sh(can, 'mkdir dst');
    const r = await sh(can, 'tar xf links.tar -C dst');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /refusing a symbolic link to \/etc\/passwd/);
    assert.match(r.stderr, /refusing a symbolic link to \.\.\/\.\.\/secret/);
  });

  test('a symbolic link inside the archive is recreated when it stays inside', async () => {
    const can = await makeCan();
    const inside = ustarOf([
      { name: 's/', type: '5' },
      { name: 's/real.txt', data: Buffer.from('t\n') },
      { name: 's/alias.txt', type: '2', linkname: 'real.txt' },
    ]);
    await can.writeFile('/home/agent/inside.tar', inside);
    await sh(can, 'mkdir dst && tar xf inside.tar -C dst');
    assert.equal(await can.readFile('/home/agent/dst/s/alias.txt', 'utf8'), 't\n');
  });

  test('no mode, or two modes, is an error', async () => {
    const can = await makeCan();
    const none = await sh(can, 'tar f a.tar x');
    assert.equal(none.exitCode, 2);
    assert.match(none.stderr, /must specify one of/);
    const two = await sh(can, 'tar -cx -f a.tar x');
    assert.equal(two.exitCode, 2);
    assert.match(two.stderr, /only specify one of/);
  });

  test('a can archive is readable by the host tar', { skip: HOST_TAR ? false : 'no tar on the host' }, async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p hostcheck/d && echo for-the-host > hostcheck/d/f.txt && tar czf host.tgz hostcheck');
    const bytes = await can.readFile('/home/agent/host.tgz');
    const file = path.join(hostTmp, 'host.tgz');
    fs.writeFileSync(file, bytes);
    const listing = execFileSync(HOST_TAR, ['-tzf', file], { encoding: 'utf8' });
    assert.match(listing, /hostcheck\/d\/f\.txt/);
    const dir = path.join(hostTmp, 'unpacked');
    fs.mkdirSync(dir);
    execFileSync(HOST_TAR, ['-xzf', file, '-C', dir]);
    assert.equal(fs.readFileSync(path.join(dir, 'hostcheck/d/f.txt'), 'utf8'), 'for-the-host\n');
  });

  test('the host tar writes an archive the can reads', { skip: HOST_TAR ? false : 'no tar on the host' }, async () => {
    const can = await makeCan();
    const src = path.join(hostTmp, 'hsrc');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'h.txt'), 'from the host\n');
    const file = path.join(hostTmp, 'fromhost.tar');
    execFileSync(HOST_TAR, ['-cf', file, '-C', src, 'h.txt']);
    await can.writeFile('/home/agent/fromhost.tar', fs.readFileSync(file));
    await sh(can, 'mkdir out && tar xf fromhost.tar -C out');
    assert.equal(await can.readFile('/home/agent/out/h.txt', 'utf8'), 'from the host\n');
  });
});

describe('gzip and gunzip', () => {
  test('gzip replaces the file; gunzip puts it back', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/g.txt', 'compress me\n'.repeat(50));
    assert.equal((await sh(can, 'gzip g.txt')).exitCode, 0);
    await assert.rejects(() => can.readFile('/home/agent/g.txt'), /ENOENT/);
    const gz = await can.readFile('/home/agent/g.txt.gz');
    assert.equal(zlib.gunzipSync(gz).toString(), 'compress me\n'.repeat(50));
    assert.equal((await sh(can, 'gunzip g.txt.gz')).exitCode, 0);
    assert.equal(await can.readFile('/home/agent/g.txt', 'utf8'), 'compress me\n'.repeat(50));
  });

  test('gzip -k keeps the original and -c writes to stdout', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/k.txt', 'keep\n');
    await sh(can, 'gzip -k k.txt');
    assert.equal(await can.readFile('/home/agent/k.txt', 'utf8'), 'keep\n');
    await sh(can, 'gzip -c k.txt > k.txt.gz');
    assert.equal(zlib.gunzipSync(await can.readFile('/home/agent/k.txt.gz')).toString(), 'keep\n');
  });

  test('gunzip refuses a file without a .gz suffix', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/plain.txt', 'x');
    const r = await sh(can, 'gunzip plain.txt');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /unknown suffix/);
  });
});

describe('zip and unzip', () => {
  test('zip -r packs a tree that unzip -d unpacks, with content intact', async () => {
    const can = await makeCan();
    const body = 'deflate me please. '.repeat(40);
    await sh(can, 'mkdir -p zsrc/dir');
    await can.writeFile('/home/agent/zsrc/dir/big.txt', body);
    await can.writeFile('/home/agent/zsrc/tiny.txt', 'hi');
    const r = await sh(can, 'zip -r -q pack.zip zsrc && mkdir out && unzip -q pack.zip -d out');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(await can.readFile('/home/agent/out/zsrc/dir/big.txt', 'utf8'), body);
    assert.equal(await can.readFile('/home/agent/out/zsrc/tiny.txt', 'utf8'), 'hi');
  });

  test('unzip -l lists the members', async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p l');
    await can.writeFile('/home/agent/l/a.txt', 'aaa');
    await sh(can, 'zip -r -q l.zip l');
    const r = await sh(can, 'unzip -l l.zip');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /l\/a\.txt/);
  });

  test('unzip does not overwrite without -o, and does with it', async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p w');
    await can.writeFile('/home/agent/w/one.txt', 'new');
    await sh(can, 'zip -q w.zip w/one.txt');
    await sh(can, 'mkdir -p target/w');
    await can.writeFile('/home/agent/target/w/one.txt', 'old');
    const kept = await sh(can, 'unzip -q w.zip -d target');
    assert.equal(kept.exitCode, 1);
    assert.match(kept.stderr, /not overwritten/);
    assert.equal(await can.readFile('/home/agent/target/w/one.txt', 'utf8'), 'old');
    await sh(can, 'unzip -q -o w.zip -d target');
    assert.equal(await can.readFile('/home/agent/target/w/one.txt', 'utf8'), 'new');
  });

  test('unzip refuses a member name with ".." and extracts nothing outside', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/bad.zip', zipOf([{ name: '../zip-escape.txt', data: Buffer.from('x') }, { name: 'safe.txt', data: Buffer.from('y') }]));
    await sh(can, 'mkdir dst');
    const r = await sh(can, 'unzip -q bad.zip -d dst');
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /outside the destination/);
    assert.equal(await can.readFile('/home/agent/dst/safe.txt', 'utf8'), 'y');
    await assert.rejects(() => can.readFile('/home/agent/zip-escape.txt'), /ENOENT/);
  });

  test('the host tar lists a zip the can wrote', { skip: HOST_TAR ? false : 'no tar on the host' }, async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p hz');
    await can.writeFile('/home/agent/hz/x.txt', 'zipped for the host');
    await sh(can, 'zip -q hz.zip hz/x.txt');
    const file = path.join(hostTmp, 'hz.zip');
    fs.writeFileSync(file, await can.readFile('/home/agent/hz.zip'));
    const listing = execFileSync(HOST_TAR, ['-tf', file], { encoding: 'utf8' });
    assert.match(listing, /hz\/x\.txt/);
  });
});
