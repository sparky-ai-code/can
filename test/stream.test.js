// The `stream` module inside a can. Programs subclass its classes the ES5 way (as iconv-lite and many packages do),
// and the classes must behave like node's: flowing and paused modes, backpressure, finish and close ordering,
// errors, pipe, setEncoding, async iteration, pipeline and finished. See src/runtime/sandbox/stream.js.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-stream-'));
const manager = new CanManager({ storeDir: path.join(tmp, 'store'), mountsFile: path.join(tmp, 'none.json') });
let counter = 0;

after(async () => {
  await manager.destroyAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function runProgram(source) {
  const can = await manager.create({ name: `stream-${++counter}` });
  await can.writeFile('/home/agent/prog.js', source);
  const r = await can.exec('node prog.js', { timeout: 60_000 });
  return { can, r };
}

describe('subclassing the stream classes (ES5 style)', () => {
  test('a Transform subclass that calls Transform.call(this) works end to end', async () => {
    const { r } = await runProgram(`
      const { Transform } = require('stream');
      function Upper(options) { this.seen = 0; Transform.call(this, options); }
      Upper.prototype = Object.create(Transform.prototype, { constructor: { value: Upper } });
      Upper.prototype._transform = function (chunk, enc, done) {
        this.seen += chunk.length;
        done(null, chunk.toString().toUpperCase());
      };
      Upper.prototype._flush = function (done) { done(null, '!' + this.seen); };
      const u = new Upper();
      let out = '';
      u.on('data', (c) => { out += c; });
      u.on('end', () => { console.log(out); });
      u.write('abc');
      u.end('def');
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'ABCDEF!6');
  });

  test('a Writable subclass that calls Writable.call(this) and implements _write', async () => {
    const { r } = await runProgram(`
      const { Writable } = require('stream');
      function Collect(opts) { this.parts = []; Writable.call(this, opts); }
      Collect.prototype = Object.create(Writable.prototype, { constructor: { value: Collect } });
      Collect.prototype._write = function (chunk, enc, cb) { this.parts.push(chunk.toString()); cb(); };
      const c = new Collect();
      c.on('finish', () => console.log('finish', c.parts.join('|')));
      c.write('a'); c.write('b'); c.end('c');
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'finish a|b|c');
  });
});

describe('readable and writable behaviour', () => {
  test('push, end and the order of data, end and close', async () => {
    const { r } = await runProgram(`
      const { Readable } = require('stream');
      const events = [];
      const src = new Readable({ read() {} });
      src.on('data', (c) => events.push('data:' + c));
      src.on('end', () => events.push('end'));
      src.on('close', () => { events.push('close'); console.log(events.join(' ')); });
      src.push('one'); src.push('two'); src.push(null);
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'data:one data:two end close');
  });

  test('write reports backpressure and emits drain once the buffer empties', async () => {
    const { r } = await runProgram(`
      const { Writable } = require('stream');
      const w = new Writable({ highWaterMark: 4, write(chunk, enc, cb) { setTimeout(cb, 5); } });
      const first = w.write('123456');
      console.log('first write returns', first);
      w.on('drain', () => console.log('drain'));
      w.end();
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /first write returns false/);
    assert.match(r.stdout, /drain/);
  });

  test('read() in paused mode returns buffered data, and readable fires', async () => {
    const { r } = await runProgram(`
      const { Readable } = require('stream');
      const src = new Readable({ read() {} });
      src.on('readable', () => {
        let chunk;
        while ((chunk = src.read()) !== null) console.log('read', chunk.toString());
      });
      src.on('end', () => console.log('ended'));
      src.push('x'); src.push('y'); src.push(null);
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /read x[\s\S]*read y[\s\S]*ended|read xy[\s\S]*ended/);
  });

  test('pipe moves data through a Transform into a Writable and ends the destination', async () => {
    const { r } = await runProgram(`
      const { Readable, Writable, PassThrough } = require('stream');
      const chunks = [];
      const src = Readable.from(['a', 'b', 'c']);
      const mid = new PassThrough();
      const dst = new Writable({ write(c, e, cb) { chunks.push(c.toString()); cb(); } });
      dst.on('finish', () => console.log('dst', chunks.join('')));
      src.pipe(mid).pipe(dst);
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'dst abc');
  });

  test('setEncoding turns chunks into strings, even when a multi-byte character is split', async () => {
    const { r } = await runProgram(`
      const { Readable } = require('stream');
      const bytes = Buffer.from('é€');
      const src = new Readable({ read() {} });
      src.setEncoding('utf8');
      let text = '';
      src.on('data', (c) => { if (typeof c !== 'string') throw new Error('not a string'); text += c; });
      src.on('end', () => console.log('text', text));
      src.push(bytes.subarray(0, 1)); src.push(bytes.subarray(1)); src.push(null);
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'text é€');
  });

  test('async iteration yields every chunk and then stops', async () => {
    const { r } = await runProgram(`
      const { Readable } = require('stream');
      (async () => {
        const got = [];
        for await (const chunk of Readable.from([1, 2, 3], { objectMode: true })) got.push(chunk);
        console.log('got', got.join(','));
      })();
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'got 1,2,3');
  });
});

describe('errors and teardown', () => {
  test('a transform error is emitted as error, then close', async () => {
    const { r } = await runProgram(`
      const { Transform } = require('stream');
      const t = new Transform({ transform(c, e, cb) { cb(new Error('boom')); } });
      t.on('error', (err) => console.log('error', err.message));
      t.on('close', () => console.log('close'));
      t.write('x');
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'error boom\nclose');
  });

  test('pushing after end is an error', async () => {
    const { r } = await runProgram(`
      const { Readable } = require('stream');
      const src = new Readable({ read() {} });
      src.on('error', (err) => console.log('error', err.code));
      src.push(null);
      src.push('late');
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'error ERR_STREAM_PUSH_AFTER_EOF');
  });

  test('pipeline calls back with null on success and with the error on failure', async () => {
    const { r } = await runProgram(`
      const { Readable, Transform, Writable, pipeline } = require('stream');
      pipeline(
        Readable.from(['a']),
        new Transform({ transform(c, e, cb) { cb(null, c); } }),
        new Writable({ write(c, e, cb) { cb(); } }),
        (err) => console.log('ok', err),
      );
      pipeline(
        Readable.from(['a']),
        new Transform({ transform(c, e, cb) { cb(new Error('mid failed')); } }),
        new Writable({ write(c, e, cb) { cb(); } }),
        (err) => console.log('failed', err && err.message),
      );
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /ok null|ok undefined/);
    assert.match(r.stdout, /failed mid failed/);
  });

  test('stream/promises pipeline resolves when the chain has finished', async () => {
    const { r } = await runProgram(`
      const { pipeline } = require('stream/promises');
      const { Readable, Writable } = require('stream');
      let total = 0;
      pipeline(Readable.from(['ab', 'cd']), new Writable({ write(c, e, cb) { total += c.length; cb(); } }))
        .then(() => console.log('total', total), (err) => console.log('rejected', err.message));
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'total 4');
  });

  test('the program is not kept alive by an idle stream, and exits cleanly', async () => {
    const { r } = await runProgram(`
      const { PassThrough } = require('stream');
      const p = new PassThrough();
      p.end('done');
      p.resume();
      p.on('end', () => console.log('ended'));
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'ended');
  });
});

describe('the classes an http server uses', () => {
  test('a request body read through a sandbox Transform reaches the handler', async () => {
    const { r } = await runProgram(`
      const http = require('http');
      const { Transform } = require('stream');
      const srv = http.createServer((req, res) => {
        const upper = new Transform({ transform(c, e, cb) { cb(null, c.toString().toUpperCase()); } });
        let out = '';
        req.pipe(upper);
        upper.on('data', (c) => { out += c; });
        upper.on('end', () => { res.end(out); srv.close(); });
      });
      srv.listen(3011, () => {
        const body = 'hello body';
        const req = http.request({ port: 3011, method: 'POST', path: '/', headers: { 'content-length': Buffer.byteLength(body) } }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => console.log('reply', text));
        });
        req.end(body);
      });
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'reply HELLO BODY');
  });
});
