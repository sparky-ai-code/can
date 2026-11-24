// The HTTP response parser the guest client uses (src/vm/guest.js). Pure JavaScript, so it runs everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHttpResponse } from '../src/vm/guest.js';

test('a response with Content-Length keeps its status, lower-cased headers and body', () => {
  const raw = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello');
  const r = parseHttpResponse(raw);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/plain');
  assert.equal(r.body.toString(), 'hello');
});

test('a chunked response is joined into its body', () => {
  const raw = Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n');
  const r = parseHttpResponse(raw);
  assert.equal(r.body.toString(), 'hello world');
});

test('a repeated header is joined with commas', () => {
  const raw = Buffer.from('HTTP/1.1 404 Not Found\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n');
  const r = parseHttpResponse(raw);
  assert.equal(r.status, 404);
  assert.equal(r.headers['set-cookie'], 'a=1, b=2');
  assert.equal(r.body.length, 0);
});

test('bytes that are not HTTP are an EPROTO error', () => {
  assert.throws(() => parseHttpResponse(Buffer.from('not http at all\r\n\r\n')), (err) => err.code === 'EPROTO');
  assert.throws(() => parseHttpResponse(Buffer.from('HTTP/1.1 200 OK\r\n')), (err) => err.code === 'EPROTO');
});
