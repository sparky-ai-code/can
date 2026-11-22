// Tests for the WASI runtime: memory-limit rewriting on hand-built wasm bytes, the VFS adapter, and running
// hand-assembled WASI programs. Python tests run only when the CPython toolchain is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VFS } from '../src/kernel/vfs.js';
import { applyMemoryLimit, readMemoryLayout, sections, pagesFor } from '../src/runtime/wasi/memlimit.js';
import { runWasm, runPython, ENOMEM_TEXT, EXIT_NO_MEMORY } from '../src/runtime/wasi/run.js';
import { Layers, WasiContext, WasiDir, joinGuest } from '../src/runtime/wasi/vfsfs.js';
import { wasi } from '../src/vendor/browser_wasi_shim/index.js';

// ---- hand-assembly helpers (wasm binary format) ----------------------------------------------------------------

const MAGIC_VERSION = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const u32 = (n) => {
  const out = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
};
const name = (s) => [...u32(Buffer.byteLength(s)), ...Buffer.from(s)];
const vec = (items) => [...u32(items.length), ...items.flat()];
const section = (id, payload) => [id, ...u32(payload.length), ...payload];
const module = (...sectionsList) => new Uint8Array([...MAGIC_VERSION, ...sectionsList.flat()]);

const TYPE_FD_WRITE = [0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f];
const TYPE_I32_VOID = [0x60, 1, 0x7f, 0];
const TYPE_VOID_VOID = [0x60, 0, 0];

/** A memory section with one memory of the given limits. */
const memoryLimits = (min, max) => (max === undefined ? [0x00, ...u32(min)] : [0x01, ...u32(min), ...u32(max)]);

/** A module with a single defined memory (plus the memory export), for limit tests. */
function memoryModule(min, max) {
  return module(
    section(5, vec([memoryLimits(min, max)])),
    section(7, vec([[...name('memory'), 0x02, 0x00]])),
  );
}

/** A module that imports env.memory with the given limits and does nothing else. */
function importedMemoryModule(min, max) {
  const limits = max === undefined ? [0x00, ...u32(min)] : [0x01, ...u32(min), ...u32(max)];
  return module(section(2, vec([[...name('env'), ...name('memory'), 0x02, ...limits]])));
}

/**
 * A WASI command: imports fd_write and proc_exit, writes "hi\n" to fd 1 and exits with 3.
 * Memory layout: iovec at 0 {buf: 16, len: 3}; the text at 16; nwritten at 24.
 */
function helloModule() {
  const body = [
    0x00, // no locals
    0x41, 0x01, // fd = 1 (stdout)
    0x41, 0x00, // iovs at 0
    0x41, 0x01, // one iovec
    0x41, 0x18, // nwritten at 24
    0x10, 0x00, // call fd_write
    0x1a, // drop its errno
    0x41, 0x03, // exit code 3
    0x10, 0x01, // call proc_exit
    0x0b, // end
  ];
  const data = [16, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x68, 0x69, 0x0a];
  return module(
    section(1, vec([TYPE_FD_WRITE, TYPE_I32_VOID, TYPE_VOID_VOID])),
    section(2, vec([
      [...name('wasi_snapshot_preview1'), ...name('fd_write'), 0x00, 0x00],
      [...name('wasi_snapshot_preview1'), ...name('proc_exit'), 0x00, 0x01],
    ])),
    section(3, vec([u32(2)])),
    section(5, vec([[0x00, 0x01]])),
    section(7, vec([[...name('memory'), 0x02, 0x00], [...name('_start'), 0x00, 0x02]])),
    section(10, vec([[...u32(body.length), ...body]])),
    section(11, vec([[0x00, 0x41, 0x00, 0x0b, ...u32(data.length), ...data]])),
  );
}

/**
 * A WASI command with a 1-page memory that grows it one page at a time until memory.grow returns -1, then traps
 * (like an allocator that aborts on failure).
 */
function growUntilFailModule() {
  const body = [
    0x00, // no locals
    0x03, 0x40, // loop
    0x41, 0x01, // i32.const 1
    0x40, 0x00, // memory.grow
    0x41, 0x7f, // i32.const -1
    0x46, // i32.eq
    0x04, 0x40, // if
    0x00, // unreachable
    0x0b, // end if
    0x0c, 0x00, // br to loop start
    0x0b, // end loop
    0x0b, // end function
  ];
  return module(
    section(1, vec([TYPE_VOID_VOID])),
    section(3, vec([u32(0)])),
    section(5, vec([[0x00, 0x01]])),
    section(7, vec([[...name('memory'), 0x02, 0x00], [...name('_start'), 0x00, 0x00]])),
    section(10, vec([[...u32(body.length), ...body]])),
  );
}

const KIB256 = 256 * 1024; // 4 pages: a small limit keeps the grow test fast

// ---- (a) memory-limit parser and rewriter ----------------------------------------------------------------------

test('memlimit: a defined memory with no maximum gets the limit as its maximum', () => {
  const out = applyMemoryLimit(memoryModule(1), KIB256);
  assert.equal(out.rewritten, true);
  assert.equal(out.limitPages, 4);
  const mem = readMemoryLayout(out.bytes).memories[0];
  assert.equal(mem.min, 1);
  assert.equal(mem.max, 4);
  assert.equal(mem.shared, false);
  assert.equal(WebAssembly.validate(out.bytes), true);
});

test('memlimit: a maximum above the limit is lowered to the limit', () => {
  const out = applyMemoryLimit(memoryModule(1, 100000), KIB256);
  assert.equal(out.rewritten, true);
  const mem = readMemoryLayout(out.bytes).memories[0];
  assert.equal(mem.min, 1);
  assert.equal(mem.max, 4);
  assert.equal(WebAssembly.validate(out.bytes), true);
});

test('memlimit: a maximum within the limit leaves the bytes unchanged', () => {
  const bytes = memoryModule(1, 2);
  const out = applyMemoryLimit(bytes, KIB256);
  assert.equal(out.rewritten, false);
  assert.deepEqual(out.bytes, bytes);
});

test('memlimit: rewriting keeps every other section byte for byte', () => {
  const bytes = module(
    section(1, vec([TYPE_VOID_VOID])),
    section(3, vec([u32(0)])),
    section(5, vec([memoryLimits(1)])),
    section(7, vec([[...name('_start'), 0x00, 0x00]])),
    section(10, vec([[0x02, 0x00, 0x0b]])),
  );
  const out = applyMemoryLimit(bytes, KIB256).bytes;
  const before = sections(bytes).filter((s) => s.id !== 5).map((s) => Buffer.from(bytes.subarray(s.start, s.end)).toString('hex'));
  const after = sections(out).filter((s) => s.id !== 5).map((s) => Buffer.from(out.subarray(s.start, s.end)).toString('hex'));
  assert.deepEqual(after, before);
  assert.deepEqual(sections(out).map((s) => s.id), [1, 3, 5, 7, 10]);
});

test('memlimit: an imported memory is not rewritten; the caller gets the maximum to supply', () => {
  const out = applyMemoryLimit(importedMemoryModule(1, 50000), KIB256);
  assert.equal(out.rewritten, false);
  assert.equal(out.importMaxPages, 4);
  assert.equal(applyMemoryLimit(importedMemoryModule(1), KIB256).importMaxPages, 4);
  assert.equal(readMemoryLayout(importedMemoryModule(1, 3)).memoryImports[0].max, 3);
  assert.equal(applyMemoryLimit(importedMemoryModule(1, 3), KIB256).importMaxPages, 3);
});

test('memlimit: an initial memory above the limit is ENOMEM', () => {
  assert.throws(() => applyMemoryLimit(memoryModule(8), KIB256), (e) => e.code === 'ENOMEM' && /Next:/.test(e.message));
  assert.throws(() => applyMemoryLimit(importedMemoryModule(8), KIB256), (e) => e.code === 'ENOMEM');
});

test('memlimit: malformed input is EINVAL and memory64 is ENOTSUP', () => {
  assert.throws(() => applyMemoryLimit(new Uint8Array([1, 2, 3]), KIB256), (e) => e.code === 'EINVAL');
  assert.throws(() => applyMemoryLimit(new Uint8Array([0, 0x61, 0x73, 0x6d, 2, 0, 0, 0]), KIB256), (e) => e.code === 'EINVAL');
  const truncated = memoryModule(1).subarray(0, 12);
  assert.throws(() => applyMemoryLimit(truncated, KIB256), (e) => e.code === 'EINVAL');
  const mem64 = module(section(5, vec([[0x04, 0x01, 0x01]])));
  assert.throws(() => applyMemoryLimit(mem64, KIB256), (e) => e.code === 'ENOTSUP');
});

test('memlimit: pagesFor rounds down and refuses a limit under one page', () => {
  assert.equal(pagesFor(700 * 1024 * 1024), 11200);
  assert.equal(pagesFor(65536 * 3 + 100), 3);
  assert.throws(() => pagesFor(1000), (e) => e.code === 'EINVAL');
});

// ---- VFS adapter -----------------------------------------------------------------------------------------------

function adapter(mounts = []) {
  const vfs = new VFS();
  const ctx = new WasiContext(new Layers(vfs, mounts));
  const root = new WasiDir(ctx, '/', { preopenName: '/' });
  return { vfs, ctx, root };
}

test('adapter: a write through a WASI file descriptor lands in the can VFS', () => {
  const { vfs, root } = adapter();
  const opened = root.path_open(0, 'notes/out.txt', 0, 0n, 0n, 0);
  assert.equal(opened.ret, wasi.ERRNO_NOENT, 'the parent folder must exist');
  vfs.mkdir('/notes');
  const created = root.path_open(0, 'notes/out.txt', wasi.OFLAGS_CREAT, 0n, 0n, 0);
  assert.equal(created.ret, 0);
  const text = new TextEncoder().encode('hello');
  assert.deepEqual(created.fd_obj.fd_write(text), { ret: 0, nwritten: 5 });
  assert.equal(created.fd_obj.fd_close(), 0);
  assert.equal(vfs.readFile('/notes/out.txt', 'utf8'), 'hello');
});

test('adapter: an open file is saved on fd_sync and at the end of a run without a close', () => {
  const { vfs, ctx, root } = adapter();
  const f = root.path_open(0, 'log.txt', wasi.OFLAGS_CREAT, 0n, 0n, 0).fd_obj;
  f.fd_write(new TextEncoder().encode('one'));
  assert.equal(vfs.readFile('/log.txt', 'utf8'), '');
  f.fd_sync();
  assert.equal(vfs.readFile('/log.txt', 'utf8'), 'one');
  f.fd_write(new TextEncoder().encode('two'));
  ctx.flushAll();
  assert.equal(vfs.readFile('/log.txt', 'utf8'), 'onetwo');
});

test('adapter: reads, seeks and directory listing work on VFS files', () => {
  const { vfs, root } = adapter();
  vfs.writeFile('/a.txt', 'abcdef');
  vfs.writeFile('/b.txt', 'x');
  const f = root.path_open(0, 'a.txt', 0, 0n, 0n, 0).fd_obj;
  assert.equal(Buffer.from(f.fd_read(4).data).toString(), 'abcd');
  assert.deepEqual(f.fd_seek(-2n, wasi.WHENCE_END), { ret: 0, offset: 4n });
  assert.equal(Buffer.from(f.fd_read(10).data).toString(), 'ef');
  const names = [];
  let cookie = 0n;
  for (;;) {
    const { dirent } = root.fd_readdir_single(cookie);
    if (!dirent) break;
    names.push(new TextDecoder().decode(dirent.dir_name));
    cookie = dirent.d_next;
  }
  assert.ok(names.includes('a.txt') && names.includes('b.txt'), `listing: ${names.join(',')}`);
});

test('adapter: a rename moves the file inside the VFS', () => {
  const { vfs, root } = adapter();
  vfs.writeFile('/old.txt', 'data');
  const moved = root.path_unlink('old.txt');
  assert.equal(moved.ret, 0);
  assert.equal(root.path_link('new.txt', moved.inode_obj), 0);
  assert.equal(vfs.exists('/old.txt'), false);
  assert.equal(vfs.readFile('/new.txt', 'utf8'), 'data');
});

test('adapter: hard links are refused and escapes from the preopen are refused', () => {
  const { vfs, root } = adapter();
  vfs.writeFile('/f.txt', 'x');
  const inode = root.path_lookup('f.txt', 0).inode_obj;
  assert.equal(root.path_link('g.txt', inode), wasi.ERRNO_NOTSUP);
  assert.throws(() => joinGuest('/work', '../../etc'), (e) => e.code === 'ENOTCAPABLE');
  assert.throws(() => joinGuest('/work', '/etc/passwd'), (e) => e.code === 'ENOTCAPABLE');
  assert.equal(joinGuest('/work', './a/../b.txt'), '/work/b.txt');
});

test('adapter: a host overlay is read-only and reads from the host folder', () => {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'can-wasi-'));
  try {
    fs.writeFileSync(path.join(host, 'mod.py'), 'x = 1\n');
    const { vfs, root } = adapter([{ at: '/usr/lib/py', hostDir: host, writable: ['/usr/lib/py/site'] }]);
    vfs.mkdir('/usr/lib/py/site', { recursive: true });
    const f = root.path_open(0, 'usr/lib/py/mod.py', 0, 0n, 0n, 0);
    assert.equal(f.ret, 0);
    assert.equal(Buffer.from(f.fd_obj.fd_read(100).data).toString(), 'x = 1\n');
    assert.equal(root.path_open(0, 'usr/lib/py/new.py', wasi.OFLAGS_CREAT, 0n, 0n, 0).ret, wasi.ERRNO_ROFS);
    assert.equal(root.path_unlink_file('usr/lib/py/mod.py'), wasi.ERRNO_ROFS);
    assert.ok(fs.readdirSync(host).includes('mod.py'));
    const listing = vfs.readdir('/usr/lib/py');
    assert.deepEqual(listing, ['site']);
    // The writable folder inside the overlay stays in the VFS.
    assert.equal(root.path_open(0, 'usr/lib/py/site/pkg.txt', wasi.OFLAGS_CREAT, 0n, 0n, 0).ret, 0);
  } finally {
    fs.rmSync(host, { recursive: true, force: true });
  }
});

// ---- (b) and (c): hand-assembled WASI programs ----------------------------------------------------------------

test('runWasm: a hand-built program writes "hi" to stdout and exits with 3', async () => {
  const vfs = new VFS();
  const out = [];
  const code = await runWasm({ bytes: helloModule(), vfs, stdout: (c) => out.push(Buffer.from(c)) });
  assert.equal(code, 3);
  assert.equal(Buffer.concat(out).toString(), 'hi\n');
});

test('runWasm: a memory.grow past the limit exits 137 with the ENOMEM text on stderr', async () => {
  const vfs = new VFS();
  const err = [];
  const code = await runWasm({
    bytes: growUntilFailModule(), vfs, memoryLimitBytes: KIB256, stderr: (c) => err.push(Buffer.from(c)),
  });
  assert.equal(code, EXIT_NO_MEMORY);
  assert.equal(code, 137);
  assert.ok(Buffer.concat(err).toString().includes(ENOMEM_TEXT));
  assert.equal(ENOMEM_TEXT, 'ENOMEM: wasm memory limit reached. Next: do less at once.');
});

test('runWasm: a file that is not wasm is EINVAL with a Next step', async () => {
  await assert.rejects(runWasm({ bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), vfs: new VFS() }),
    (e) => e.code === 'EINVAL' && /Next:/.test(e.message));
});

test('runWasm: a program that imports a host function it does not have is ENOTSUP', async () => {
  const bytes = module(
    section(1, vec([TYPE_VOID_VOID])),
    section(2, vec([[...name('env'), ...name('thing'), 0x00, 0x00]])),
  );
  await assert.rejects(runWasm({ bytes, vfs: new VFS() }), (e) => e.code === 'ENOTSUP');
});

// ---- (d) CPython, only when the toolchain is present ----------------------------------------------------------

async function pythonToolchain() {
  try {
    const { resolveTool } = await import('../src/toolchains.js');
    await resolveTool('python', '3.15');
    return null;
  } catch (err) {
    return err?.message ?? String(err);
  }
}
const skipReason = await pythonToolchain();

function collect() {
  const chunks = [];
  return { chunks, write: (c) => chunks.push(Buffer.from(c)), text: () => Buffer.concat(chunks).toString() };
}

test('runPython: python -c "print(1+1)" prints 2', { skip: skipReason ? `CPython toolchain absent: ${skipReason}` : false }, async () => {
  const vfs = new VFS();
  const out = collect();
  const err = collect();
  const code = await runPython({ args: ['-c', 'print(1+1)'], vfs, stdout: out.write, stderr: err.write });
  assert.equal(code, 0, `stderr: ${err.text()}`);
  assert.equal(out.text(), '2\n');
});

test('runPython: a script writes a file that lands in the can VFS', { skip: skipReason ? `CPython toolchain absent: ${skipReason}` : false }, async () => {
  const vfs = new VFS();
  vfs.mkdir('/work');
  vfs.writeFile('/work/w.py', "open('/work/out.txt', 'w').write('written by python')\n");
  const err = collect();
  const code = await runPython({ args: ['/work/w.py'], vfs, stderr: err.write });
  assert.equal(code, 0, `stderr: ${err.text()}`);
  assert.equal(vfs.readFile('/work/out.txt', 'utf8'), 'written by python');
});

// ---- (f) the worker runner: a program that never returns can be stopped by its signal --------------------------

/** A WASI command whose _start never returns: a busy loop only worker.terminate() can stop. */
function spinModule() {
  const body = [0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b]; // no locals; loop; br 0; end; end
  return module(
    section(1, vec([TYPE_VOID_VOID])),
    section(3, vec([u32(0)])),
    section(7, vec([[...name('_start'), 0x00, 0x00]])),
    section(10, vec([[...u32(body.length), ...body]])),
  );
}

for (const [reason, code] of [['SIGTERM', 143], ['SIGKILL', 137]]) {
  test(`runWasm: a busy program stops on ${reason} with exit ${code}, and the event loop keeps running`, async () => {
    const ac = new AbortController();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    const started = Date.now();
    setTimeout(() => ac.abort(reason), 300);
    const got = await runWasm({ bytes: spinModule(), vfs: new VFS(), signal: ac.signal });
    clearInterval(timer);
    assert.equal(got, code);
    assert.ok(Date.now() - started < 5000, 'stopped well within 5 s');
    assert.ok(ticks >= 3, `the host kept running while the program spun (ticks ${ticks})`);
  });
}

test('runWasm: a signal that is already aborted gives its code without starting the program', async () => {
  const ac = new AbortController();
  ac.abort('SIGKILL');
  assert.equal(await runWasm({ bytes: spinModule(), vfs: new VFS(), signal: ac.signal }), 137);
});
