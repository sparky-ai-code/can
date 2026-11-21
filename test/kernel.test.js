import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VFS } from '../src/kernel/vfs.js';
import { VNet, createStreamPair } from '../src/kernel/vnet.js';
import { ProcessTable, RingBuffer } from '../src/kernel/proc.js';
import { Machine } from '../src/vm/machine.js';
import { CanManager } from '../src/manager.js';
import stub from '../src/runtime/executor.js';

describe('vfs', () => {
  test('reads and writes files as Buffers and strings', () => {
    const v = new VFS();
    v.mkdir('/home/agent', { recursive: true });
    v.writeFile('/home/agent/a.txt', 'hello');
    assert.ok(Buffer.isBuffer(v.readFile('/home/agent/a.txt')));
    assert.equal(v.readFile('/home/agent/a.txt', 'utf8'), 'hello');
    v.appendFile('/home/agent/a.txt', ' world');
    assert.equal(v.readFile('/home/agent/a.txt', { encoding: 'utf8' }), 'hello world');
    v.writeFile('/home/agent/bin.dat', new Uint8Array([0, 255, 1]));
    assert.deepEqual([...v.readFile('/home/agent/bin.dat')], [0, 255, 1]);
  });

  test('resolves relative paths against cwd', () => {
    const v = new VFS({ cwd: '/home/agent' });
    v.mkdir('/home/agent/src', { recursive: true });
    v.chdir('src');
    v.writeFile('index.js', 'x');
    assert.equal(v.cwd, '/home/agent/src');
    assert.ok(v.exists('/home/agent/src/index.js'));
    assert.equal(v.resolve('../../../tmp/x'), '/tmp/x');
    assert.equal(v.resolve('/abs', '/anywhere'), '/abs');
  });

  test('errors carry Node-style codes and messages', () => {
    const v = new VFS();
    v.mkdir('/d');
    v.writeFile('/d/f', 'x');
    assert.throws(() => v.readFile('/missing'), { code: 'ENOENT', message: "ENOENT: no such file or directory, open '/missing'" });
    assert.throws(() => v.writeFile('/nodir/f', 'x'), { code: 'ENOENT' });
    assert.throws(() => v.mkdir('/d'), { code: 'EEXIST' });
    assert.throws(() => v.readFile('/d'), { code: 'EISDIR' });
    assert.throws(() => v.readFile('/d/f/x'), { code: 'ENOTDIR' });
    assert.throws(() => v.rmdir('/d'), { code: 'ENOTEMPTY' });
    assert.throws(() => v.unlink('/d'), { code: 'EISDIR' });
    assert.throws(() => v.rm('/d'), { code: 'EISDIR' });
    assert.equal(v.exists('/d/f/x'), false);
    assert.equal(v.exists('/d/f'), true);
  });

  test('mkdir recursive, readdir and stat', () => {
    const v = new VFS();
    assert.equal(v.mkdir('/a/b/c', { recursive: true }), '/a');
    assert.equal(v.mkdir('/a/b/c', { recursive: true }), undefined);
    v.writeFile('/a/z.txt', '12345');
    v.writeFile('/a/b.txt', '');
    assert.deepEqual(v.readdir('/a'), ['b', 'b.txt', 'z.txt']);
    const st = v.stat('/a/z.txt');
    assert.ok(st.isFile());
    assert.equal(st.size, 5);
    assert.ok(v.stat('/a').isDirectory());
    const entries = v.readdir('/a', { withFileTypes: true });
    assert.equal(entries.find((e) => e.name === 'b').isDirectory(), true);
    assert.throws(() => v.mkdir('/a/z.txt/x', { recursive: true }), { code: 'ENOTDIR' });
  });

  test('rename moves trees and follows POSIX replace rules', () => {
    const v = new VFS();
    v.mkdir('/src/inner', { recursive: true });
    v.writeFile('/src/inner/f.txt', 'data');
    v.rename('/src', '/moved');
    assert.equal(v.readFile('/moved/inner/f.txt', 'utf8'), 'data');
    assert.equal(v.exists('/src'), false);
    assert.throws(() => v.rename('/moved', '/moved/inner/x'), { code: 'EINVAL' });

    v.writeFile('/a', '1');
    v.writeFile('/b', '2');
    v.rename('/a', '/b');
    assert.equal(v.readFile('/b', 'utf8'), '1');
    v.mkdir('/d1');
    v.mkdir('/d2');
    v.writeFile('/d2/x', 'x');
    assert.throws(() => v.rename('/d1', '/d2'), { code: 'ENOTEMPTY' });
  });

  test('copy is deep and rm removes trees', () => {
    const v = new VFS();
    v.mkdir('/moved/inner', { recursive: true });
    v.writeFile('/moved/inner/f.txt', 'data');
    v.copy('/moved', '/copy', { recursive: true });
    v.writeFile('/moved/inner/f.txt', 'changed');
    assert.equal(v.readFile('/copy/inner/f.txt', 'utf8'), 'data');
    assert.throws(() => v.copy('/moved', '/nope'), { code: 'EISDIR' });
    assert.throws(() => v.copy('/moved', '/moved/sub', { recursive: true }), { code: 'EINVAL' });

    v.rm('/copy', { recursive: true });
    assert.equal(v.exists('/copy'), false);
    v.rm('/does-not-exist', { force: true });
    assert.throws(() => v.rm('/does-not-exist'), { code: 'ENOENT' });
  });

  test('symlinks are followed by stat and readFile but not by lstat', () => {
    const v = new VFS();
    v.mkdir('/real');
    v.writeFile('/real/f', 'orig');
    v.symlink('/real', '/link');
    assert.equal(v.readFile('/link/f', 'utf8'), 'orig');
    v.writeFile('/link/g', 'new');
    assert.equal(v.readFile('/real/g', 'utf8'), 'new');
    assert.equal(v.lstat('/link').isSymbolicLink(), true);
    assert.equal(v.stat('/link').isDirectory(), true);
    assert.equal(v.readlink('/link'), '/real');
    v.symlink('f', '/real/rel'); // relative targets resolve from the link's directory
    assert.equal(v.readFile('/real/rel', 'utf8'), 'orig');
    v.symlink('/loop2', '/loop1');
    v.symlink('/loop1', '/loop2');
    assert.throws(() => v.readFile('/loop1'), { code: 'ELOOP' });
  });

  test('serializes to JSON and back, keeping bytes, modes and links', () => {
    const v = new VFS({ cwd: '/work' });
    v.mkdir('/work');
    v.writeFile('/work/bin', Buffer.from([0, 1, 2, 250]));
    v.chmod('/work/bin', 0o755);
    v.symlink('bin', '/work/alias');
    const json = JSON.parse(JSON.stringify(v.serialize()));
    assert.equal(json.root.entries.work.entries.bin.data, Buffer.from([0, 1, 2, 250]).toString('base64'));
    const w = VFS.deserialize(json);
    assert.equal(w.cwd, '/work');
    assert.deepEqual([...w.readFile('/work/bin')], [0, 1, 2, 250]);
    assert.equal(w.stat('/work/bin').mode & 0o777, 0o755);
    assert.equal(w.readlink('/work/alias'), 'bin');
    assert.throws(() => VFS.deserialize({ format: 'other' }), { code: 'EINVAL' });
  });
});

describe('vnet', () => {
  test('HTTP requests reach the handler and return its response', async () => {
    const net = new VNet();
    let seen;
    net.listen(8080, (req) => {
      seen = req;
      return { status: 201, headers: { 'X-Test': 'yes' }, body: { ok: true } };
    });
    const res = await net.request({
      port: 8080, method: 'post', path: '/api?x=1', headers: { 'Content-Type': 'text/plain' }, body: 'hi',
    });
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api?x=1');
    assert.equal(seen.headers['content-type'], 'text/plain');
    assert.equal(seen.body.toString(), 'hi');
    assert.equal(res.status, 201);
    assert.equal(res.headers['x-test'], 'yes');
    assert.equal(res.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  });

  test('connection refused, address in use, handler errors, close', async () => {
    const net = new VNet();
    await assert.rejects(net.request({ port: 9000 }), { code: 'ECONNREFUSED' });
    net.listen(9000, () => { throw new Error('boom'); });
    assert.throws(() => net.listen(9000, () => ({})), { code: 'EADDRINUSE' });
    const res = await net.request({ port: 9000 });
    assert.equal(res.status, 500);
    assert.match(res.body.toString(), /boom/);
    assert.equal(net.close(9000), true);
    assert.equal(net.close(9000), false);
    await assert.rejects(net.request({ port: 9000 }), { code: 'ECONNREFUSED' });
  });

  test('requests time out when the handler never answers', async () => {
    const net = new VNet();
    net.listen(9001, () => new Promise(() => {}));
    await assert.rejects(net.request({ port: 9001, timeout: 20 }), { code: 'ETIMEDOUT' });
  });

  test('ephemeral ports, listing and invalid ports', () => {
    const net = new VNet();
    const listener = net.listen(0, () => ({}));
    assert.ok(listener.port >= 49152 && listener.port <= 65535);
    assert.deepEqual(net.list().map((x) => x.port), [listener.port]);
    assert.throws(() => net.listen(70000, () => ({})), { code: 'EINVAL' });
  });

  test('raw stream connections carry bytes both ways', async () => {
    const net = new VNet();
    const listener = net.listen(7000, () => ({}));
    listener.on('connection', (sock) => sock.on('data', (d) => sock.write(d.toString().toUpperCase())));
    const client = net.connect(7000);
    const reply = new Promise((resolve) => client.once('data', (d) => resolve(d.toString())));
    client.write('hello');
    assert.equal(await reply, 'HELLO');
    client.destroy();
  });

  test('connect is refused without a stream acceptor, and ports are private per VNet', () => {
    const a = new VNet();
    const b = new VNet();
    a.listen(7001, () => ({})); // HTTP-only listener
    assert.throws(() => a.connect(7001), { code: 'ECONNREFUSED' });
    assert.throws(() => b.connect(7001), { code: 'ECONNREFUSED' });
    b.listen(7001, () => ({ body: 'b' })); // same number is free in another can
  });

  test('stream pairs are bidirectional', async () => {
    const [x, y] = createStreamPair();
    const got = new Promise((resolve) => y.once('data', (d) => resolve(d.toString())));
    x.write('ping');
    assert.equal(await got, 'ping');
    x.destroy();
    y.destroy();
  });
});

describe('proc', () => {
  test('spawn captures stdout and the exit code', async () => {
    const table = new ProcessTable({
      executor: async (ctx) => { ctx.stdout.write(`ran ${ctx.command}\n`); return 0; },
    });
    const p = table.spawn('hello world');
    assert.equal(p.status, 'running');
    const done = await table.wait(p.pid);
    assert.equal(done.status, 'exited');
    assert.equal(done.exitCode, 0);
    assert.equal(table.output(p.pid).toString(), 'ran hello world\n');
  });

  test('return codes, thrown errors and stderr', async () => {
    const table = new ProcessTable({
      executor: async (ctx) => {
        if (ctx.command === 'bad') throw new Error('kaboom');
        return 3;
      },
    });
    assert.equal((await table.wait(table.spawn('ok').pid)).exitCode, 3);
    const bad = table.spawn('bad');
    assert.equal((await table.wait(bad.pid)).exitCode, 1);
    assert.match(table.output(bad.pid, 'stderr').toString(), /kaboom/);
  });

  test('a process killed before its executor starts never runs it', async () => {
    let ran = false;
    const table = new ProcessTable({ executor: async () => { ran = true; return 0; } });
    const p = table.spawn('quick');
    table.kill(p.pid);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ran, false);
    assert.equal(table.get(p.pid).exitCode, 143);
  });

  test('kill aborts the executor and reports a signal exit', async () => {
    let reason = null;
    const table = new ProcessTable({
      executor: (ctx) => new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => { reason = ctx.signal.reason; resolve(0); });
      }),
    });
    const p = table.spawn('server', { background: true });
    assert.equal(table.list({ status: 'running' }).length, 1);
    await new Promise((resolve) => setImmediate(resolve)); // let the executor start and listen
    table.kill(p.pid, 'SIGTERM');
    const done = table.get(p.pid);
    assert.equal(done.status, 'exited');
    assert.equal(done.signal, 'SIGTERM');
    assert.equal(done.exitCode, 143);
    assert.equal(done.background, true);
    assert.equal(reason, 'SIGTERM');
    assert.throws(() => table.kill(p.pid), { code: 'ESRCH' });
  });

  test('wait times out for long-running processes', async () => {
    const table = new ProcessTable({ executor: () => new Promise(() => {}) });
    const p = table.spawn('forever');
    await assert.rejects(table.wait(p.pid, 20), { code: 'ETIMEDOUT' });
    table.killAll();
  });

  test('stdin reaches the executor', async () => {
    const table = new ProcessTable({
      executor: async (ctx) => {
        let data = '';
        for await (const chunk of ctx.stdin) data += chunk;
        ctx.stdout.write(data.toUpperCase());
        return 0;
      },
    });
    const p = table.spawn('cat');
    table.writeStdin(p.pid, 'abc');
    table.writeStdin(p.pid, 'def');
    table.endStdin(p.pid);
    await table.wait(p.pid);
    assert.equal(table.output(p.pid).toString(), 'ABCDEF');
  });

  test('output is capped and the oldest bytes are dropped', async () => {
    const table = new ProcessTable({
      outputCap: 16,
      executor: async (ctx) => {
        ctx.stdout.write('a'.repeat(10));
        ctx.stdout.write('b'.repeat(10));
        return 0;
      },
    });
    const p = table.spawn('x');
    await table.wait(p.pid);
    assert.equal(table.output(p.pid).toString(), 'a'.repeat(6) + 'b'.repeat(10));

    const ring = new RingBuffer(4);
    ring.push(Buffer.from('abcdef'));
    assert.equal(ring.read().toString(), 'cdef');
    assert.equal(ring.dropped, 2);
  });
});

describe('machine (the kernel inside one can, in-process)', () => {
  test('exec collects stdout, stderr and the exit code, then forgets the process', async () => {
    const can = new Machine({
      id: 'c1',
      executor: async (ctx) => { ctx.stdout.write(`out:${ctx.command}`); ctx.stderr.write('err'); return 7; },
    });
    const r = await can.exec('ls -la');
    assert.deepEqual(r, { exitCode: 7, signal: null, stdout: 'out:ls -la', stderr: 'err', timedOut: false });
    assert.equal(can.proc.list().length, 0);
  });

  test('exec timeout kills the process and reports exit code 124', async () => {
    const can = new Machine({ id: 'c2', executor: () => new Promise(() => {}) });
    const r = await can.exec('sleep 100', { timeout: 20 });
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, 124);
    assert.equal(r.signal, 'SIGKILL');
  });

  test('default executor runs the built-in shell (unknown commands exit 127)', async () => {
    const can = new Machine({ id: 'c3' });
    const r = await can.exec('nosuchcommand');
    assert.equal(r.exitCode, 127);
    assert.match(r.stderr, /command not found/);
  });

  test('spawn validates cwd and merges env', () => {
    const can = new Machine({ id: 'c4', env: { A: '1' }, executor: stub });
    can.vfs.mkdir('/tmp', { recursive: true });
    assert.throws(() => can.spawn('x', { cwd: '/nope' }), { code: 'ENOENT' });
    const p = can.spawn('x', { cwd: '/tmp', env: { FOO: 'bar' } });
    assert.equal(p.cwd, '/tmp');
    assert.equal(p.env.FOO, 'bar');
    assert.equal(p.env.A, '1');
  });

  test('snapshot and restore round-trip the filesystem and env', () => {
    const can = new Machine({ id: 'c5', env: { A: '1' }, executor: stub });
    can.vfs.mkdir('/app');
    can.vfs.writeFile('/app/x.js', 'v1');
    const snap = JSON.parse(JSON.stringify(can.snapshot()));
    can.vfs.writeFile('/app/x.js', 'v2');
    can.env.A = '2';
    can.restore(snap);
    assert.equal(can.vfs.readFile('/app/x.js', 'utf8'), 'v1');
    assert.equal(can.env.A, '1');

    const copy = Machine.fromSnapshot(snap, { executor: stub });
    assert.equal(copy.id, 'c5');
    assert.equal(copy.vfs.readFile('/app/x.js', 'utf8'), 'v1');
    assert.throws(() => Machine.fromSnapshot({ format: 'nope' }), { code: 'EINVAL' });
  });

  test('destroy stops processes and closes ports', () => {
    const can = new Machine({ id: 'c6', executor: () => new Promise(() => {}) });
    can.vnet.listen(8080, () => ({}));
    const p = can.spawn('server', { background: true });
    can.destroy();
    assert.equal(can.proc.get(p.pid).status, 'exited');
    assert.deepEqual(can.vnet.list(), []);
  });
});

describe('manager (each can is its own VM process)', () => {
  const made = [];
  const managers = [];
  const tmpStore = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-store-'));
    made.push(dir);
    return dir;
  };
  const newManager = (opts = {}) => {
    const m = new CanManager({ storeDir: tmpStore(), ...opts });
    managers.push(m);
    return m;
  };
  after(async () => {
    for (const m of managers) await m.destroyAll();
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('create seeds the default filesystem and environment', async () => {
    const m = newManager();
    const can = await m.create({ name: 'dev' });
    assert.equal(can.name, 'dev');
    assert.equal((await can.stat('/home/agent')).type, 'dir');
    assert.equal((await can.stat('/tmp')).type, 'dir');
    assert.equal((await can.stat('/app')).type, 'dir');
    assert.match(await can.readFile('/etc/hostname', 'utf8'), /^can-/);
    assert.equal((await can.exec('pwd')).stdout, '/home/agent\n');
    assert.equal((await can.exec('echo $HOME')).stdout, '/home/agent\n');
  });

  test('get by id or name, duplicate names rejected, destroy removes', async () => {
    const m = newManager();
    const alpha = await m.create({ name: 'alpha' });
    assert.equal(m.get(alpha.id), alpha);
    assert.equal(m.get('alpha'), alpha);
    await assert.rejects(m.create({ name: 'alpha' }), { code: 'EEXIST' });
    const auto = await m.create();
    assert.ok(auto.name.startsWith('can-'));
    assert.equal(m.list().length, 2);
    await m.destroy('alpha');
    assert.equal(m.get('alpha'), undefined);
    assert.equal(m.list().length, 1);
    assert.equal(alpha.status, 'destroyed');
  });

  test('concurrent creates with the same name: exactly one wins', async () => {
    const m = newManager();
    const results = await Promise.allSettled([m.create({ name: 'race' }), m.create({ name: 'race' })]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'EEXIST').length, 1);
  });

  test('save and load persist can state under the store directory', async () => {
    const storeDir = tmpStore();
    const m1 = newManager({ storeDir });
    const can = await m1.create({ name: 'persist' });
    await can.writeFile('/app/index.js', 'console.log(1)');
    const file = await m1.save(can.id);
    assert.equal(file, path.join(storeDir, `${can.id}.json`));
    assert.ok(fs.existsSync(file));

    const m2 = newManager({ storeDir });
    const loaded = await m2.load(can.id);
    assert.equal(loaded.name, 'persist');
    assert.equal(await loaded.readFile('/app/index.js', 'utf8'), 'console.log(1)');
    assert.equal(m2.get('persist'), loaded);
    assert.equal(await m2.load(can.id), loaded);

    await m2.destroy(can.id); // also deletes the saved file
    assert.equal(fs.existsSync(file), false);
    await assert.rejects(m2.load(can.id), { code: 'ENOENT' });
  });

  test('ids used as file names are validated', async () => {
    const m = newManager();
    await assert.rejects(m.load('../escape'), { code: 'EINVAL' });
  });

  test('cans are isolated: files and processes of one are invisible to another', async () => {
    const m = newManager();
    const a = await m.create({ name: 'iso-a' });
    const b = await m.create({ name: 'iso-b' });
    await a.writeFile('/home/agent/secret.txt', 'only-a');
    assert.equal(await b.exists('/home/agent/secret.txt'), false);
    assert.notEqual(a.vmPid, b.vmPid);
    await a.spawn('node -e "setInterval(() => {}, 1000)"', { background: true });
    assert.equal((await b.ps()).length, 0);
  });
});
