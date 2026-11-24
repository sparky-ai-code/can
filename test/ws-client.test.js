// The WebSocket client over a raw stream (src/vm/ws-client.js), against a fake server on the other end of a Duplex. No
// VM is needed: the server side writes the handshake reply and the frames by hand.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Duplex } from 'node:stream';
import { decodeFrame, encodeClientFrame, openGuestWebSocket } from '../src/vm/ws-client.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A stream the test drives: what the client writes lands in `sent`; the test pushes what the server sends. */
function fakeStream() {
  const sent = [];
  const stream = new Duplex({
    read() {},
    write(chunk, _enc, cb) { sent.push(Buffer.from(chunk)); cb(); },
  });
  stream.sent = sent;
  return stream;
}

/** A server frame, unmasked as servers send them. */
function serverFrame(opcode, payload, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, len]);
  else {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, Buffer.from(payload)]);
}

/** The reply that accepts the client's handshake, read from what it sent. */
function acceptFor(request) {
  const key = /Sec-WebSocket-Key: (\S+)/.exec(request)[1];
  return createHash('sha1').update(key + GUID).digest('base64');
}

function handshakeReply(accept) {
  return Buffer.from([
    'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`, '', '',
  ].join('\r\n'), 'latin1');
}

/** Opens the socket: the handshake reply is pushed as the server would send it. */
async function open(stream, { host = '127.0.0.1:9222', path = '/devtools/browser/x' } = {}) {
  const ready = openGuestWebSocket(stream, { host, path });
  await new Promise((resolve) => setImmediate(resolve));
  const request = stream.sent[0].toString('latin1');
  stream.push(handshakeReply(acceptFor(request)));
  return { ws: await ready, request };
}

describe('WebSocket client over a raw stream', () => {
  test('the handshake asks for the path and host, and resolves on a valid reply', async () => {
    const stream = fakeStream();
    const { ws, request } = await open(stream);
    assert.match(request, /^GET \/devtools\/browser\/x HTTP\/1\.1\r\nHost: 127\.0\.0\.1:9222\r\n/);
    assert.match(request, /Upgrade: websocket/);
    assert.match(request, /Sec-WebSocket-Version: 13/);
    assert.equal(ws.readyState, 1);
  });

  test('a reply with the wrong accept key or without 101 rejects', async () => {
    const wrongAccept = fakeStream();
    const p1 = openGuestWebSocket(wrongAccept, { host: 'h', path: '/' });
    await new Promise((resolve) => setImmediate(resolve));
    wrongAccept.push(handshakeReply('bm90IHRoZQ=='));
    await assert.rejects(p1, (e) => e.code === 'EPROTO' && /did not prove/.test(e.message));

    const notUpgraded = fakeStream();
    const p2 = openGuestWebSocket(notUpgraded, { host: 'h', path: '/' });
    await new Promise((resolve) => setImmediate(resolve));
    notUpgraded.push(Buffer.from('HTTP/1.1 404 Not Found\r\n\r\n', 'latin1'));
    await assert.rejects(p2, (e) => e.code === 'EPROTO' && /404/.test(e.message));
  });

  test('a text message from the server arrives as a string; a message sent by the client is masked', async () => {
    const stream = fakeStream();
    const { ws } = await open(stream);
    const got = new Promise((resolve) => { ws.onmessage = (ev) => resolve(ev.data); });
    stream.push(serverFrame(0x1, Buffer.from('{"id":1,"result":{}}')));
    assert.equal(await got, '{"id":1,"result":{}}');

    ws.send('{"id":2,"method":"Page.enable"}');
    const frame = stream.sent[stream.sent.length - 1];
    assert.equal(frame[1] & 0x80, 0x80, 'the mask bit is set on client frames');
    const decoded = decodeFrame(frame);
    assert.equal(decoded.payload.toString('utf8'), '{"id":2,"method":"Page.enable"}');
  });

  test('fragmented messages are joined, and a 16-bit length is read', async () => {
    const stream = fakeStream();
    const { ws } = await open(stream);
    const big = 'x'.repeat(300);
    const got = [];
    ws.onmessage = (ev) => got.push(ev.data);
    stream.push(serverFrame(0x1, Buffer.from('part-1 '), false));
    stream.push(serverFrame(0x0, Buffer.from('part-2'), true));
    stream.push(serverFrame(0x1, Buffer.from(big)));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(got, ['part-1 part-2', big]);
  });

  test('a ping from the server is answered with a pong that carries its payload', async () => {
    const stream = fakeStream();
    await open(stream);
    stream.push(serverFrame(0x9, Buffer.from('are you there')));
    await new Promise((resolve) => setImmediate(resolve));
    const pong = decodeFrame(stream.sent[stream.sent.length - 1]);
    assert.equal(pong.opcode, 0xa);
    assert.equal(pong.payload.toString('utf8'), 'are you there');
  });

  test('a message that arrives before onmessage is set is delivered when it is set', async () => {
    const stream = fakeStream();
    const { ws } = await open(stream);
    stream.push(serverFrame(0x1, Buffer.from('early')));
    await new Promise((resolve) => setImmediate(resolve));
    const got = new Promise((resolve) => { ws.onmessage = (ev) => resolve(ev.data); });
    assert.equal(await got, 'early');
  });

  test('a server close frame closes the socket and calls onclose once', async () => {
    const stream = fakeStream();
    const { ws } = await open(stream);
    let closes = 0;
    ws.onclose = () => { closes++; };
    stream.push(serverFrame(0x8, Buffer.alloc(0)));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ws.readyState, 3);
    assert.equal(closes, 1);
    assert.throws(() => ws.send('late'), /not open/);
  });

  test('encodeClientFrame and decodeFrame round-trip a payload of every length class', () => {
    for (const len of [0, 1, 125, 126, 65535, 65536]) {
      const payload = Buffer.alloc(len, 0x41);
      const d = decodeFrame(encodeClientFrame(0x1, payload));
      assert.equal(d.opcode, 0x1);
      assert.equal(d.fin, true);
      assert.equal(d.payload.length, len);
      assert.ok(d.payload.equals(payload), `payload of ${len} bytes survives masking`);
    }
  });
});
