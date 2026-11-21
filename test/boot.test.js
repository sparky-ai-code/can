// Pages boot the way they do in a browser: the browser APIs they call exist and behave (mutation records, observers,
// layout queries that follow the layout the renderer draws, fragments, ranges, instanceof, media queries, computed
// style), and a page's own errors do not stop the rest of it.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../src/browser/browser.js';

const page = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>T</title>${head}</head><body>${body}</body></html>`;

let can;
before(() => {
  can = { id: 'boot', name: 'boot', vnet: null };
});

/** Loads a page served from a fixed body and returns the browser. */
async function load(html) {
  can.vnet = {
    async request() {
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) };
    },
  };
  const b = new Browser({ can, internet: false });
  await b.goto('http://localhost:8080/');
  return b;
}

describe('observers', () => {
  test('a MutationObserver hears childList and attribute changes, delivered after the task', async () => {
    const b = await load(page('<div id="box"></div>', ''));
    await b.evaluate(`window.seen = [];
      const box = document.getElementById('box');
      new MutationObserver((records) => {
        for (const r of records) window.seen.push(r.type + ':' + (r.attributeName || r.addedNodes.length));
      }).observe(box, { childList: true, attributes: true });
      box.setAttribute('data-x', '1');
      box.appendChild(document.createElement('span'));`);
    await b.wait(5);
    assert.deepEqual(await b.evaluate('window.seen'), ['attributes:data-x', 'childList:1']);
  });

  test('an IntersectionObserver reports its targets as visible once', async () => {
    const b = await load(page('<p id="lazy">lazy content</p>', ''));
    await b.evaluate(`window.hits = [];
      new IntersectionObserver((entries) => {
        for (const e of entries) window.hits.push(e.isIntersecting + '/' + e.intersectionRatio);
      }).observe(document.getElementById('lazy'));`);
    await b.wait(5);
    assert.deepEqual(await b.evaluate('window.hits'), ['true/1']);
  });

  test('a ResizeObserver reports the size its target is laid out at', async () => {
    const b = await load(page('<div id="r" style="width:200px;height:40px"></div>', ''));
    await b.evaluate(`window.size = null;
      new ResizeObserver((entries) => { window.size = entries[0].contentRect.width + 'x' + entries[0].contentRect.height; })
        .observe(document.getElementById('r'));`);
    await b.wait(5);
    assert.equal(await b.evaluate('window.size'), '200x40');
  });
});

describe('layout queries follow the layout', () => {
  test('offsetWidth and getBoundingClientRect read the box the renderer draws', async () => {
    const b = await load(page('<div id="a" style="width:200px;height:40px;margin:0"></div>', ''));
    assert.equal(await b.evaluate('document.getElementById("a").offsetWidth'), 200);
    assert.equal(await b.evaluate('document.getElementById("a").getBoundingClientRect().height'), 40);
  });

  test('after a change to the page, the next query sees the new layout', async () => {
    const b = await load(page('<div id="a" style="width:200px;height:40px;margin:0"></div>', ''));
    assert.equal(await b.evaluate('document.getElementById("a").offsetWidth'), 200);
    await b.evaluate('document.getElementById("a").style.width = "320px"');
    assert.equal(await b.evaluate('document.getElementById("a").offsetWidth'), 320);
  });
});

describe('DOM helpers', () => {
  test('insertAdjacentHTML places markup at each position', async () => {
    const b = await load(page('<ul id="list"><li id="mid">mid</li></ul>', ''));
    await b.evaluate(`const li = document.getElementById('mid');
      li.insertAdjacentHTML('beforebegin', '<li id="before">before</li>');
      li.insertAdjacentHTML('afterend', '<li id="after">after</li>');
      li.insertAdjacentHTML('afterbegin', '<b id="first">first</b>');`);
    assert.deepEqual(b.query('#list > li').map((x) => x.attrs.id), ['before', 'mid', 'after']);
    assert.equal(b.query('#mid #first').length, 1);
  });

  test('cloneNode copies deeply and document fragments flatten into their parent', async () => {
    const b = await load(page('<div id="host"><p class="x">one</p></div>', ''));
    await b.evaluate(`const host = document.getElementById('host');
      const copy = host.firstElementChild.cloneNode(true);
      copy.id = 'copy';
      const frag = document.createDocumentFragment();
      frag.appendChild(document.createElement('i'));
      frag.appendChild(document.createElement('u'));
      host.appendChild(copy);
      host.appendChild(frag);`);
    assert.equal(b.query('#copy').length, 1);
    assert.deepEqual(b.query('#host > *').map((x) => x.tag), ['p', 'p', 'i', 'u']);
  });

  test('a range turns markup into nodes with createContextualFragment', async () => {
    const b = await load(page('<div id="h"></div>', ''));
    await b.evaluate(`const frag = document.createRange().createContextualFragment('<em>a</em><em>b</em>');
      document.getElementById('h').appendChild(frag);`);
    assert.equal(b.query('#h em').length, 2);
  });
});

describe('types, media, style', () => {
  test('instanceof works for nodes and elements', async () => {
    const b = await load(page('<span id="s">x</span>', ''));
    assert.equal(await b.evaluate('document.getElementById("s") instanceof HTMLElement'), true);
    assert.equal(await b.evaluate('document.getElementById("s") instanceof Node'), true);
    assert.equal(await b.evaluate('document.getElementById("s") instanceof HTMLInputElement'), false);
    assert.equal(await b.evaluate('document.getElementById("s").firstChild instanceof Text'), true);
  });

  test('matchMedia answers for the viewport the page sees', async () => {
    const b = await load(page('', ''));
    assert.equal(await b.evaluate('matchMedia("(min-width: 900px)").matches'), true);
    assert.equal(await b.evaluate('matchMedia("(max-width: 600px)").matches'), false);
    assert.equal(await b.evaluate('matchMedia("print").matches'), false);
    assert.equal(await b.evaluate('innerWidth'), 1280);
  });

  test('getComputedStyle reports the default display and the inline style', async () => {
    const b = await load(page('<div id="d"></div><span id="s" style="color: red"></span>', ''));
    assert.equal(await b.evaluate('getComputedStyle(document.getElementById("d")).display'), 'block');
    assert.equal(await b.evaluate('getComputedStyle(document.getElementById("s")).display'), 'inline');
    assert.equal(await b.evaluate('getComputedStyle(document.getElementById("s")).getPropertyValue("color")'), 'red');
  });

  test('crypto, structuredClone and the other common globals exist and work', async () => {
    const b = await load(page('', ''));
    assert.match(await b.evaluate('crypto.randomUUID()'), /^[0-9a-f-]{36}$/);
    assert.deepEqual(await b.evaluate('structuredClone({ a: [1, 2] })'), { a: [1, 2] });
    assert.equal(await b.evaluate('typeof navigator.clipboard.writeText'), 'function');
  });
});

describe('a failing script does not stop the page', () => {
  test('later scripts run, and the error is in the console', async () => {
    const b = await load(page('<p id="o">start</p>', `<script>throw new Error('boom in script one');</script>`)
      .replace('</body>', '<script>document.getElementById("o").textContent = "later ran";</script></body>'));
    assert.equal(b.query('#o')[0].text, 'later ran');
    assert.ok(b.consoleLog.some((l) => /boom in script one/.test(l.text)));
  });
});

describe('handlers set as properties', () => {
  test('el.onclick and window.onload run, and el.click() reaches them', async () => {
    const b = await load(page('<button id="go">go</button><p id="o">x</p>', `<script>
      window.loaded = 'no';
      window.onload = () => { window.loaded = 'yes'; };
      document.getElementById('go').onclick = () => { document.getElementById('o').textContent = 'clicked'; };
    </script>`));
    assert.equal(await b.evaluate('window.loaded'), 'yes');
    await b.click('#go');
    assert.equal(b.query('#o')[0].text, 'clicked');
  });
});

describe('pages that probe for more of the platform', () => {
  test('a canvas gives a 2D context that accepts drawing; a page can measure text', async () => {
    const b = await load(page('<canvas id="c" width="200" height="100"></canvas><p id="o"></p>', ''));
    await b.evaluate(`const ctx = document.getElementById('c').getContext('2d');
      ctx.fillStyle = '#f00';
      ctx.fillRect(0, 0, 10, 10);
      document.getElementById('o').textContent = ctx.measureText('abc').width + ':' + document.getElementById('c').width;`);
    assert.equal(b.query('#o')[0].text, '21:200');
    assert.equal(await b.evaluate('document.getElementById("c").getContext("webgl")'), null);
  });

  test('console methods, WebSocket, indexedDB and geolocation fail or do nothing without throwing', async () => {
    const b = await load(page('<p id="o">x</p>', ''));
    await b.evaluate(`console.table([1]); console.group('g'); console.groupEnd(); console.time('t'); console.timeEnd('t');
      window.wsErr = 'no';
      const ws = new WebSocket('ws://localhost:1/');
      ws.onerror = () => { window.wsErr = 'error'; };
      window.dbErr = 'no';
      const req = indexedDB.open('db');
      req.onerror = () => { window.dbErr = 'error'; };
      navigator.geolocation.getCurrentPosition(() => {}, () => { window.geo = 'denied'; });`);
    await b.wait(10);
    assert.equal(await b.evaluate('window.wsErr'), 'error');
    assert.equal(await b.evaluate('window.dbErr'), 'error');
    assert.equal(await b.evaluate('window.geo'), 'denied');
    assert.equal(await b.evaluate('window.parent === window'), true);
  });

  test('a file is read with FileReader', async () => {
    const b = await load(page('', ''));
    await b.evaluate(`window.text = 'pending';
      const reader = new FileReader();
      reader.onload = () => { window.text = reader.result; };
      reader.readAsText(new File(['hello file'], 'a.txt'));`);
    await b.wait(10);
    assert.equal(await b.evaluate('window.text'), 'hello file');
  });
});
