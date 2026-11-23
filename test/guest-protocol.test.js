import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameDecoder, MAX_FRAME, T, decodeExecResult, decodeHello, encodeExec, encodeFrame,
} from '../src/vm/guest-protocol.js';

test('a frame round trips, including when it arrives in pieces and several at once', () => {
  const a = encodeFrame(T.PING, 7, Buffer.from('hello'));
  const b = encodeFrame(T.POWEROFF, 8);
  const d = new FrameDecoder();
  const all = Buffer.concat([a, b]);
  const frames = [];
  for (let i = 0; i < all.length; i += 3) frames.push(...d.push(all.subarray(i, i + 3)));
  assert.deepEqual(frames.map((f) => [f.type, f.id, f.payload.toString()]), [[T.PING, 7, 'hello'], [T.POWEROFF, 8, '']]);
  assert.equal(new FrameDecoder().push(Buffer.concat([a, b])).length, 2);
});

test('the decoder refuses a bad length', () => {
  const bad = Buffer.alloc(9);
  bad.writeUInt32LE(2, 0); // shorter than type + id
  assert.throws(() => new FrameDecoder().push(bad), /EPROTO/);
  const huge = Buffer.alloc(9);
  huge.writeUInt32LE(MAX_FRAME + 1, 0);
  assert.throws(() => new FrameDecoder().push(huge), /EPROTO/);
});

test('encodeExec lays out timeout, cwd and argv as the agent reads them', () => {
  const p = encodeExec({ cwd: '/app', argv: ['/bin/sh', '-c', 'echo hi'], timeoutMs: 1500 });
  assert.equal(p.readUInt32LE(0), 1500);
  assert.deepEqual(p.subarray(4).toString().split('\0'), ['/app', '/bin/sh', '-c', 'echo hi', '']);
  assert.throws(() => encodeExec({ argv: [] }), /EPROTO/);
  assert.throws(() => encodeExec({ argv: ['a\0b'] }), /NUL/);
  assert.throws(() => encodeExec({ argv: ['a'], timeoutMs: -1 }), /EPROTO/);
});

test('decodeExecResult and decodeHello', () => {
  const out = Buffer.from('ok\n');
  const err = Buffer.from('bad');
  const head = Buffer.alloc(13);
  head.writeInt32LE(3, 0);
  head.writeUInt8(1, 4);
  head.writeUInt32LE(out.length, 5);
  head.writeUInt32LE(err.length, 9);
  assert.deepEqual(decodeExecResult(Buffer.concat([head, out, err])), { exitCode: 3, timedOut: true, stdout: 'ok\n', stderr: 'bad' });
  assert.throws(() => decodeExecResult(Buffer.concat([head, out])), /EPROTO/);
  assert.deepEqual(decodeHello(Buffer.from('canit 0.1\0x86_64\0')), { version: '0.1', arch: 'x86_64' });
  assert.throws(() => decodeHello(Buffer.from('nope')), /EPROTO/);
});
