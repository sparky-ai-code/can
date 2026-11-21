// Computer use on a can's browser (CanChromium.computer and the computer_* tools). The page logs every mouse and
// keyboard event it receives, so the tests check what the page saw, not only what the tool returned. These tests
// drive a real Chrome or Edge and are skipped when none is installed. The refusal for the built-in browser runs always.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanRegistry } from '../src/registry.js';
import { ChromiumBrowsers } from '../src/canchromium.js';
import { findBrowserExecutable } from '../src/hostbrowser.js';
import { createTools } from '../src/mcp/tools.js';
import { pngSize } from '../src/browser/png.js';
import { KernelError } from '../src/kernel/errors.js';

const executable = findBrowserExecutable();
const SKIP = executable ? false : 'no Chrome or Edge is installed';
const LONG = { timeout: 180_000 };

// The page in the can. Every mouse and key event is pushed to window.__log with its coordinates, button, click count
// and key, so the tests can read back what the page received.
const SERVER = `
const http = require('http');
const HOME = '<!doctype html><title>Pad</title>'
  + '<input id="f" style="position:absolute;left:20px;top:100px;width:200px;height:30px">'
  + '<button id="b" style="position:absolute;left:20px;top:160px;width:120px;height:40px">Press</button>'
  + '<a id="link" href="/next" style="position:absolute;left:20px;top:260px">Go next</a>'
  + '<form action="/submit" style="position:absolute;left:300px;top:100px"><input id="q" name="q" style="width:200px;height:30px"></form>'
  + '<div id="tall" style="height:3000px"></div>'
  + '<script>'
  + 'window.__log = [];'
  + 'var rec = function (e) { window.__log.push({ t: e.type, x: e.clientX, y: e.clientY, button: e.button, detail: e.detail, key: e.key, ctrl: e.ctrlKey, target: e.target.id || e.target.tagName }); };'
  + '["mousedown","mouseup","click","dblclick","contextmenu","mousemove","keydown","keyup","wheel"].forEach(function (t) { document.addEventListener(t, rec, true); });'
  + '</script>';
http.createServer(function (q, s) {
  s.setHeader('content-type', 'text/html; charset=utf-8');
  if (q.url.indexOf('/next') === 0) return s.end('<!doctype html><title>Next</title><h1>Next page</h1>');
  if (q.url.indexOf('/submit') === 0) return s.end('<!doctype html><title>Done</title><h1>Submitted</h1>');
  s.end(HOME);
}).listen(3000);
`;

describe('computer use on a real Chromium page', { skip: SKIP }, () => {
  let root;
  let registry;
  let cb;
  let b;
  const log = () => b.browse('evaluate', 'window.__log');
  const clearLog = () => b.browse('evaluate', 'window.__log = []');
  const home = () => b.browse('goto', 'http://localhost:3000/');

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'can-computer-'));
    registry = new CanRegistry({ storeDir: path.join(root, 'store') });
    const can = await registry.create('pad');
    await can.writeFile('/app/server.js', SERVER);
    await can.spawn('node /app/server.js', { background: true });
    cb = new ChromiumBrowsers();
    b = cb.for(can);
    await home();
  }, LONG);

  after(async () => {
    await cb?.closeAll();
    await registry?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }, LONG);

  test('a screenshot sets the viewport, and the PNG has that size', LONG, async () => {
    const r = await b.computer('screenshot', { width: 800, height: 600 });
    assert.deepEqual(r.viewport, { width: 800, height: 600 });
    assert.deepEqual(pngSize(r.png), { width: 800, height: 600 });
    assert.equal(r.title, 'Pad');
  });

  test('a click lands on its pixel and focuses the field under it', LONG, async () => {
    await clearLog();
    await b.computer('click', { x: 60, y: 115 });
    const events = (await log()).filter((e) => e.t !== 'keydown' && e.t !== 'keyup');
    assert.deepEqual(events.map((e) => e.t), ['mousedown', 'mouseup', 'click']);
    for (const e of events) {
      assert.deepEqual([e.x, e.y, e.button, e.target], [60, 115, 0, 'f'], JSON.stringify(e));
    }
    assert.equal(events[2].detail, 1);
    assert.equal(await b.browse('evaluate', 'document.activeElement.id'), 'f');
  });

  test('typing goes to the focused field, one key event per character', LONG, async () => {
    await clearLog();
    await b.computer('type', { text: 'Ada' });
    assert.equal(await b.browse('evaluate', 'document.getElementById("f").value'), 'Ada');
    const downs = (await log()).filter((e) => e.t === 'keydown').map((e) => e.key);
    assert.deepEqual(downs, ['A', 'd', 'a']);
  });

  test('a double click sends two clicks and a dblclick', LONG, async () => {
    await home();
    await clearLog();
    await b.computer('double_click', { x: 80, y: 180 });
    const seen = await log();
    assert.equal(seen.filter((e) => e.t === 'dblclick').length, 1);
    assert.deepEqual(seen.filter((e) => e.t === 'click').map((e) => e.detail), [1, 2]);
    assert.equal(seen.find((e) => e.t === 'click' && e.detail === 2).target, 'b');
  });

  test('a right click sends a contextmenu with button 2', LONG, async () => {
    await clearLog();
    await b.computer('right_click', { x: 80, y: 180 });
    const menu = (await log()).find((e) => e.t === 'contextmenu');
    assert.ok(menu, 'a contextmenu event');
    assert.equal(menu.button, 2);
  });

  test('a mouse move reaches the page as mousemove at that point', LONG, async () => {
    await clearLog();
    await b.computer('move', { x: 250, y: 300 });
    const moves = (await log()).filter((e) => e.t === 'mousemove');
    assert.ok(moves.length >= 1);
    assert.deepEqual([moves.at(-1).x, moves.at(-1).y], [250, 300]);
  });

  test('a drag presses at the start, moves in steps, and releases at the end', LONG, async () => {
    await clearLog();
    await b.computer('drag', { x: 300, y: 400, to_x: 300, to_y: 300 });
    const seen = await log();
    const down = seen.find((e) => e.t === 'mousedown');
    const up = seen.find((e) => e.t === 'mouseup');
    assert.deepEqual([down.x, down.y], [300, 400]);
    assert.deepEqual([up.x, up.y], [300, 300]);
    assert.ok(seen.filter((e) => e.t === 'mousemove').length >= 10, 'the pointer moved in steps');
  });

  test('a scroll moves the page by the wheel amount', LONG, async () => {
    await home();
    await b.computer('scroll', { x: 100, y: 100, delta_y: 400 });
    assert.equal(await b.browse('evaluate', 'window.scrollY'), 400);
    await b.computer('scroll', { x: 100, y: 100, delta_y: -150 });
    assert.equal(await b.browse('evaluate', 'window.scrollY'), 250);
  });

  test('a key with a modifier reaches the page with the modifier set', LONG, async () => {
    await home();
    await clearLog();
    await b.computer('key', { key: 'a', modifiers: ['ctrl'] });
    const down = (await log()).find((e) => e.t === 'keydown');
    assert.equal(down.key, 'a');
    assert.equal(down.ctrl, true);
  });

  test('a click on a link loads the page and reports it', LONG, async () => {
    await home();
    const r = await b.computer('click', { x: 30, y: 270 });
    assert.equal(r.navigated, true);
    assert.equal(r.status, 200);
    assert.equal(r.url, 'http://localhost:3000/next');
    assert.equal(r.title, 'Next');
  });

  test('Enter in a form field submits the form', LONG, async () => {
    await home();
    await b.computer('click', { x: 400, y: 115 });
    await b.computer('type', { text: 'found' });
    const r = await b.computer('key', { key: 'Enter' });
    assert.equal(r.navigated, true);
    assert.equal(r.url, 'http://localhost:3000/submit?q=found');
    assert.equal(r.title, 'Done');
  });

  test('a wait sleeps and then screenshots', LONG, async () => {
    const started = Date.now();
    const r = await b.computer('wait', { duration_ms: 300 });
    assert.ok(Date.now() - started >= 280);
    assert.ok(r.png.length > 0);
  });

  test('bad input is refused before anything is sent to the page', LONG, async () => {
    await home();
    await b.computer('screenshot', { width: 800, height: 600 });
    const refused = (fn, code) => assert.rejects(fn, (e) => e instanceof KernelError && e.code === code);
    await refused(() => b.computer('click', { x: 9000, y: 1 }), 'EINVAL');
    await refused(() => b.computer('click', { x: 10 }), 'EINVAL');
    await refused(() => b.computer('click', { x: 1.5, y: 1 }), 'EINVAL');
    await refused(() => b.computer('key', { key: 'Hyper' }), 'EINVAL');
    await refused(() => b.computer('key', { key: 'a', modifiers: ['hyper'] }), 'EINVAL');
    await refused(() => b.computer('wait', { duration_ms: 20_000 }), 'EINVAL');
    await refused(() => b.computer('fly', {}), 'EINVAL');
  }, LONG);
});

describe('computer tools', () => {
  let root;
  let registry;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'can-computer-tools-'));
    registry = new CanRegistry({ storeDir: path.join(root, 'store') });
  });
  after(async () => {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('computer actions are filmed into a running recording', { skip: SKIP, timeout: 180_000 }, async () => {
    const { Recorder } = await import('../src/recording.js');
    const can = await registry.create('filmed');
    await can.writeFile('/app/server.js', SERVER);
    await can.spawn('node /app/server.js', { background: true });
    const browsers = new ChromiumBrowsers();
    const recorder = new Recorder({ transferRoot: path.join(root, 'transfer'), ffmpeg: null });
    const tools = createTools(registry, { transferRoot: path.join(root, 'transfer'), browsers, recorder });
    const byName = (name) => tools.find((t) => t.name === name);
    try {
      recorder.start(can, { name: 'computer-run', width: 800, height: 600 });
      await byName('browser_goto').run({ can: 'filmed', url: 'http://localhost:3000/' });
      await byName('computer_action').run({ can: 'filmed', action: 'click', x: 60, y: 115 });
      await byName('computer_action').run({ can: 'filmed', action: 'type', text: 'Ada' });
      const r = await recorder.stop(can.id);
      assert.equal(r.frames, 3, 'goto, click and type are each a frame');
      const log = fs.readFileSync(r.log, 'utf8');
      assert.match(log, /computer_action \{"can":"filmed","action":"type","text":"<3 chars>"\}/);
      assert.ok(!log.includes('"Ada"'), 'typed text is not logged');
    } finally {
      await browsers.closeAll();
    }
  });

  test('the built-in browser refuses computer use and says how to turn it on', async () => {
    await registry.create('plain');
    const tools = createTools(registry, { transferRoot: path.join(root, 'transfer') });
    const action = tools.find((t) => t.name === 'computer_action');
    await assert.rejects(
      () => action.run({ can: 'plain', action: 'click', x: 1, y: 1 }),
      (e) => e.code === 'ENOTSUP' && /chromiumBrowser/.test(e.message),
    );
    const shot = tools.find((t) => t.name === 'computer_screenshot');
    await assert.rejects(() => shot.run({ can: 'plain' }), (e) => e.code === 'ENOTSUP');
  });
});
