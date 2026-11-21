// Recording a can's QA session: the APNG writer, the recorder (frames, timeline, names, refusals, redaction, the
// ffmpeg path) and an end-to-end run through bin/can-mcp.js with can_record_start and can_record_stop.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { crc32, decodePNG, encodePNG } from '../src/browser/png.js';
import { describeArgs, encodeApng, findFfmpeg, Recorder, summarizeResult } from '../src/recording.js';
import { KernelError } from '../src/kernel/errors.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MCP_BIN = path.resolve(TEST_DIR, '..', 'bin', 'can-mcp.js');
const LONG = { timeout: 120_000 };

/** A solid-ish RGBA PNG of a given shade (distinct frames, so frame order can be checked). */
function frame(width, height, shade) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = shade;
    data[i * 4 + 1] = (i * 7 + shade) % 256;
    data[i * 4 + 2] = 255 - shade;
    data[i * 4 + 3] = 255;
  }
  return encodePNG({ width, height, data, channels: 4 });
}

/** Splits a PNG or APNG file into chunks, checking every CRC. */
function chunksOf(buf) {
  const out = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    assert.equal(crc32(buf.subarray(pos + 4, pos + 8 + len)), buf.readUInt32BE(pos + 8 + len), `bad CRC in ${type}`);
    out.push({ type, data: body });
    pos += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

function mkChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A test clock the recorder reads, so timings in the tests are exact. */
function clockAt(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('APNG writer', () => {
  test('frames keep their pixels, delays and sequence numbers', () => {
    const shades = [10, 80, 200];
    const delays = [1000, 2500, 1200];
    const frames = shades.map((s, i) => ({ png: frame(4, 3, s), ms: delays[i] }));
    const apng = encodeApng(frames);
    const chunks = chunksOf(apng);

    assert.equal(chunks[0].type, 'IHDR');
    const actl = chunks.find((c) => c.type === 'acTL');
    assert.equal(actl.data.readUInt32BE(0), 3, 'frame count');
    assert.equal(actl.data.readUInt32BE(4), 0, 'loops forever');

    // Frame control and frame data share one sequence, in file order: 0, 1, 2, ...
    const seqs = chunks.filter((c) => c.type === 'fcTL' || c.type === 'fdAT').map((c) => c.data.readUInt32BE(0));
    assert.deepEqual(seqs, seqs.map((_, i) => i));

    const controls = chunks.filter((c) => c.type === 'fcTL');
    assert.deepEqual(controls.map((c) => c.data.readUInt16BE(20)), delays);
    assert.deepEqual(controls.map((c) => c.data.readUInt16BE(22)), [1000, 1000, 1000]);

    // Rebuild each frame as an ordinary PNG from its own data and check that it decodes to the same pixels.
    const ihdr = chunks[0];
    const perFrame = [];
    for (const c of chunks) {
      if (c.type === 'fcTL') perFrame.push([]);
      else if (c.type === 'IDAT') perFrame.at(-1).push(c.data);
      else if (c.type === 'fdAT') perFrame.at(-1).push(c.data.subarray(4));
    }
    perFrame.forEach((parts, i) => {
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        mkChunk('IHDR', ihdr.data),
        mkChunk('IDAT', Buffer.concat(parts)),
        mkChunk('IEND', Buffer.alloc(0)),
      ]);
      assert.deepEqual(decodePNG(png).data, decodePNG(frames[i].png).data, `frame ${i + 1} pixels`);
    });
  });

  test('frames of different sizes are refused', () => {
    assert.throws(
      () => encodeApng([{ png: frame(4, 3, 1), ms: 1000 }, { png: frame(5, 3, 1), ms: 1000 }]),
      (err) => err instanceof KernelError && err.code === 'EINVAL',
    );
  });

  test('no frames and non-PNG frames are refused', () => {
    assert.throws(() => encodeApng([]), KernelError);
    assert.throws(() => encodeApng([{ png: Buffer.from('not a png'), ms: 1000 }]), KernelError);
  });
});

describe('describeArgs and summarizeResult', () => {
  test('typed text, file content and headers show only their size', () => {
    const line = describeArgs({ can: 'demo', target: 'Password', text: 'hunter2', headers: { authorization: 'Bearer x' } });
    assert.ok(line.includes('"text":"<7 chars>"'), line);
    assert.ok(!line.includes('hunter2'), line);
    assert.ok(!line.includes('Bearer'), line);
    assert.ok(line.includes('"target":"Password"'), line);
  });

  test('a result is its first line, shortened', () => {
    assert.equal(summarizeResult('exit code: 0\n--- stdout ---\nhi'), 'exit code: 0');
    assert.equal(summarizeResult({ text: 'x'.repeat(500) }).length, 200);
    assert.equal(summarizeResult(''), '(empty)');
  });
});

describe('Recorder', () => {
  let root;
  let tmp;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'can-rec-root-'));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-rec-tmp-'));
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const can = { id: 'cid1', name: 'demo' };

  test('a recording without ffmpeg is an APNG with a timeline, in the transfer root', async () => {
    const clock = clockAt();
    const rec = new Recorder({ transferRoot: root, tmpRoot: tmp, ffmpeg: null, now: clock.now });
    rec.start(can, { name: 'login-test', width: 4, height: 3 });

    // A call, a film, a call that fails, a film that fails, and a pause before the stop.
    let started = rec.elapsed(can.id);
    clock.advance(40);
    rec.event(can.id, started, 'can_exec {"can":"demo","command":"echo hi"} -> exit code: 0');
    clock.advance(500);
    let shade = 30;
    assert.equal(await rec.frame(can.id, async ({ width, height }) => frame(width, height, shade)), true);
    clock.advance(3000);
    shade = 90;
    await rec.frame(can.id, async () => { throw new KernelError('ECONNREFUSED', 'ECONNREFUSED: nothing there'); });
    clock.advance(200);
    await rec.frame(can.id, async ({ width, height }) => frame(width, height, 150));
    started = rec.elapsed(can.id);
    clock.advance(100);
    rec.event(can.id, started, 'browser_click {"can":"demo","target":"Go"} -> ERROR no element matches "Go"');
    clock.advance(100);

    const r = await rec.stop(can.id);
    assert.equal(r.name, 'login-test');
    assert.equal(r.frames, 2, 'the failed grab is not a frame');
    assert.equal(r.videoRel, 'recordings/login-test.apng');
    assert.equal(r.encoder.startsWith('animated PNG'), true);
    assert.equal(r.note, '');

    const apng = fs.readFileSync(r.video);
    const actl = chunksOf(apng).find((c) => c.type === 'acTL');
    assert.equal(actl.data.readUInt32BE(0), 2);

    const log = fs.readFileSync(r.log, 'utf8');
    assert.match(log, /Recording "login-test" on can "demo"/);
    assert.match(log, /can_exec \{"can":"demo","command":"echo hi"\} -> exit code: 0/);
    assert.match(log, /\(frame 1 filmed\)/);
    assert.match(log, /\(frame not captured: ECONNREFUSED: nothing there\)/);
    assert.match(log, /browser_click .* -> ERROR no element matches "Go"/);
    assert.match(log, /Browser frames: 2/);
    // The frame folder is gone once the recording is stopped.
    assert.equal(rec.sessionFor('demo'), null);
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('can-recording-')), []);
  });

  test('the second recording with the same name gets a new name, and a recording can be restarted after stop', async () => {
    const clock = clockAt();
    const rec = new Recorder({ transferRoot: root, tmpRoot: tmp, ffmpeg: null, now: clock.now });
    rec.start(can, { name: 'twice', width: 4, height: 3 });
    const first = await rec.stop(can.id);
    rec.start(can, { name: 'twice', width: 4, height: 3 });
    const second = await rec.stop(can.id);
    assert.equal(first.name, 'twice');
    assert.equal(second.name, 'twice-2');
    assert.equal(second.video, null, 'no frames, so no video');
    assert.ok(fs.existsSync(second.log));
  });

  test('refusals: a second start, a stop with nothing running, bad names and sizes', async () => {
    const clock = clockAt();
    const rec = new Recorder({ transferRoot: root, tmpRoot: tmp, ffmpeg: null, now: clock.now });
    rec.start({ id: 'cid2', name: 'other' }, { name: 'ok-name', width: 4, height: 3 });
    assert.throws(() => rec.start({ id: 'cid2', name: 'other' }), (e) => e.code === 'EEXIST');
    assert.throws(() => rec.start({ id: 'cid3', name: 'x' }, { name: '../evil' }), (e) => e.code === 'EINVAL');
    assert.throws(() => rec.start({ id: 'cid3', name: 'x' }, { name: '..' }), (e) => e.code === 'EINVAL');
    assert.throws(() => rec.start({ id: 'cid3', name: 'x' }, { name: 'a/b' }), (e) => e.code === 'EINVAL');
    assert.throws(() => rec.start({ id: 'cid3', name: 'x' }, { width: 0 }), (e) => e.code === 'EINVAL');
    assert.throws(() => rec.start({ id: 'cid3', name: 'x' }, { width: 1.5 }), (e) => e.code === 'EINVAL');
    assert.throws(() => rec.start({ id: 'cid3', name: 'x' }, { width: 100000 }), (e) => e.code === 'EINVAL');
    await assert.rejects(() => rec.stop('nobody'), (e) => e.code === 'ENOENT');
    await rec.stop('cid2');
  });

  test('stopAll writes every running recording', async () => {
    const clock = clockAt();
    const rec = new Recorder({ transferRoot: root, tmpRoot: tmp, ffmpeg: null, now: clock.now });
    rec.start({ id: 'a1', name: 'alpha' }, { name: 'shutdown-a', width: 4, height: 3 });
    rec.start({ id: 'b1', name: 'beta' }, { name: 'shutdown-b', width: 4, height: 3 });
    const out = await rec.stopAll();
    assert.deepEqual(out.failures, []);
    assert.deepEqual(out.results.map((r) => r.name).sort(), ['shutdown-a', 'shutdown-b']);
    assert.equal(rec.sessions.size, 0);
  });

  test('an ffmpeg that cannot run falls back to APNG and says why', async () => {
    const clock = clockAt();
    const rec = new Recorder({ transferRoot: root, tmpRoot: tmp, ffmpeg: path.join(tmp, 'no-such-ffmpeg'), now: clock.now });
    rec.start(can, { name: 'fallback', width: 4, height: 3 });
    await rec.frame(can.id, async ({ width, height }) => frame(width, height, 60));
    clock.advance(1500);
    await rec.frame(can.id, async ({ width, height }) => frame(width, height, 120));
    const r = await rec.stop(can.id);
    assert.equal(r.videoRel, 'recordings/fallback.apng');
    assert.match(r.note, /ffmpeg could not encode the video/);
    assert.equal(chunksOf(fs.readFileSync(r.video)).find((c) => c.type === 'acTL').data.readUInt32BE(0), 2);
  });

  test('ffmpeg encodes an MP4 that starts with an ftyp box', { skip: findFfmpeg() ? false : 'ffmpeg is not installed' }, async () => {
    const clock = clockAt();
    const rec = new Recorder({ transferRoot: root, tmpRoot: tmp, now: clock.now });
    rec.start(can, { name: 'mp4-check', width: 320, height: 240 });
    for (let i = 0; i < 3; i++) {
      await rec.frame(can.id, async ({ width, height }) => frame(width, height, 40 * (i + 1)));
      clock.advance(1200);
    }
    const r = await rec.stop(can.id);
    assert.equal(r.videoRel, 'recordings/mp4-check.mp4');
    assert.equal(r.encoder, 'H.264 MP4 through ffmpeg');
    const bytes = fs.readFileSync(r.video);
    assert.equal(bytes.toString('latin1', 4, 8), 'ftyp');
  }, LONG);
});

describe('can_record tools through the MCP server', () => {
  let work;
  let transfer;
  let store;
  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'can-rec-e2e-'));
    transfer = path.join(work, 'transfer');
    store = path.join(work, 'store');
    fs.mkdirSync(transfer);
    fs.mkdirSync(store);
  });
  after(() => fs.rmSync(work, { recursive: true, force: true }));

  test('a QA run is recorded and the video and timeline land in the transfer root', LONG, async () => {
    const child = spawn(process.execPath, [MCP_BIN], {
      // CAN_FFMPEG names a program that does not exist, so this run takes the APNG path on every machine.
      env: { ...process.env, CAN_STORE_DIR: store, CAN_TRANSFER_DIR: transfer, CAN_FFMPEG: path.join(work, 'no-ffmpeg') },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const waiting = new Map();
    let nextId = 1;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    });
    const call = (name, args) => new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    }).then((res) => ({ text: res.result.content[0].text, isError: res.result.isError === true }));

    const server = `const http = require('http');
const page = '<!doctype html><title>Login</title><h1>Sign in</h1><form action="/done" method="get">'
  + '<label>Name <input name="who"></label><button>Go</button></form>';
http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(req.url.startsWith('/done') ? '<!doctype html><title>Done</title><h1>Welcome</h1>' : page);
}).listen(3000);
`;

    try {
      assert.equal((await call('can_create', { name: 'qa' })).isError, false);
      const started = await call('can_record_start', { can: 'qa', name: 'qa-run' });
      assert.equal(started.isError, false, started.text);
      assert.match(started.text, /recording "qa-run" started on can "qa"/);
      const again = await call('can_record_start', { can: 'qa' });
      assert.equal(again.isError, true);
      assert.match(again.text, /EEXIST/);

      assert.equal((await call('can_write_file', { can: 'qa', path: '/app/server.js', content: server })).isError, false);
      assert.equal((await call('can_spawn', { can: 'qa', command: 'node /app/server.js' })).isError, false);
      const wentTo = await call('browser_goto', { can: 'qa', url: 'http://localhost:3000/' });
      assert.match(wentTo.text, /Sign in/);
      assert.equal((await call('browser_type', { can: 'qa', target: 'Name', text: 'tester-secret' })).isError, false);
      const clicked = await call('browser_click', { can: 'qa', target: 'Go' });
      assert.match(clicked.text, /Welcome/);
      assert.match((await call('can_exec', { can: 'qa', command: 'echo qa-check-passed' })).text, /qa-check-passed/);

      const stopped = await call('can_record_stop', { can: 'qa' });
      assert.equal(stopped.isError, false, stopped.text);
      assert.match(stopped.text, /recording "qa-run" stopped on can "qa": 3 browser frame\(s\)/);
      assert.match(stopped.text, /video: .*qa-run\.apng/);

      const video = fs.readFileSync(path.join(transfer, 'recordings', 'qa-run.apng'));
      assert.equal(chunksOf(video).find((c) => c.type === 'acTL').data.readUInt32BE(0), 3);

      const log = fs.readFileSync(path.join(transfer, 'recordings', 'qa-run.log.txt'), 'utf8');
      assert.match(log, /can_write_file \{"can":"qa","path":"\/app\/server.js","content":"<\d+ chars>"\}/);
      assert.match(log, /can_exec \{"can":"qa","command":"echo qa-check-passed"\} -> exit code: 0/);
      assert.match(log, /browser_goto \{"can":"qa","url":"http:\/\/localhost:3000\/"\} -> HTTP status: 200/);
      assert.match(log, /browser_type \{"can":"qa","target":"Name","text":"<13 chars>"\} -> ok \(typed text not logged\)/);
      assert.ok(!log.includes('tester-secret'), 'typed text must not reach the log');

      // A stop with nothing running is a clear error, not a crash.
      const nothing = await call('can_record_stop', { can: 'qa' });
      assert.equal(nothing.isError, true);
      assert.match(nothing.text, /ENOENT: no recording is running/);

      // Destroying a can that is recording saves the recording first.
      await call('can_record_start', { can: 'qa', name: 'before-destroy' });
      await call('browser_goto', { can: 'qa', url: 'http://localhost:3000/' });
      const destroyed = await call('can_destroy', { can: 'qa' });
      assert.equal(destroyed.isError, false, destroyed.text);
      assert.match(destroyed.text, /recording "before-destroy" was saved first: recordings\/before-destroy\.apng/);
      assert.ok(fs.existsSync(path.join(transfer, 'recordings', 'before-destroy.log.txt')));
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
});
