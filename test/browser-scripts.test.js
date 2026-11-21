// Browser page scripts: external and module scripts, script order, history.pushState, XMLHttpRequest,
// document.write, dynamically inserted scripts and Headers. Mock vnet, as in browser.test.js.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../src/browser/browser.js';
import { KernelError } from '../src/kernel/errors.js';

const PORT = 8080;

const page = (title, body) => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
});
const js = (source) => ({ status: 200, headers: { 'content-type': 'application/javascript' }, body: source });
const json = (value) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const notFound = () => ({ status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' });

function route(method, path, headers, body) {
  const [pathname, query = ''] = path.split('?');
  switch (pathname) {
    case '/ext':
      return page('Ext', `<p id="out"></p><script src="/lib.js"></script>
        <script>document.getElementById('out').textContent = window.libValue;</script>`);
    case '/lib.js':
      return js(`window.libValue = 'from-lib';`);
    case '/order':
      return page('Order', `<script>window.log = [1];</script>
        <script defer src="/defer.js"></script>
        <script>window.log.push(2);</script>`);
    case '/defer.js':
      return js(`window.log.push('defer');`);
    case '/module':
      return page('Module', `<p id="out"></p><script type="module">
        import { v } from "/m/lib.mjs";
        document.getElementById('out').textContent = 'mod ' + v;
      </script>`);
    case '/m/lib.mjs':
      return js(`export const v = await Promise.resolve('tla');`);
    case '/module-src':
      return page('ModuleSrc', `<script type="module" src="/m/main.mjs"></script>`);
    case '/m/main.mjs':
      return js(`import { v } from './lib.mjs';\ndocument.body.setAttribute('data-v', v);\n`);
    case '/history':
      return page('History', `<p id="p">start</p><script>
        history.pushState({ n: 1 }, '', '/history/next');
        window.popped = 'none';
        window.addEventListener('popstate', (e) => { window.popped = e.state ? String(e.state.n) : 'none'; });
      </script>`);
    case '/xhr':
      return page('Xhr', `<div id="x"></div><script>
        const r = new XMLHttpRequest();
        r.open('GET', '/api/data');
        r.onload = () => { document.getElementById('x').textContent = r.status + ':' + r.responseText + ':' + r.getResponseHeader('content-type'); };
        r.send();
      </script>`);
    case '/api/data':
      return json({ ok: true });
    case '/write':
      return page('Write', `<p id="before">b</p><script>document.write('<p id="w">written</p><script>document.getElementById("w").setAttribute("data-s", "ran")<\\/script>');</script><p id="after">a</p>`);
    case '/dyn':
      return page('Dyn', `<script>
        const s = document.createElement('script');
        s.textContent = "document.body.setAttribute('data-dyn', 'yes')";
        document.body.appendChild(s);
      </script>`);
    case '/dyn-src':
      return page('DynSrc', `<script>
        const s = document.createElement('script');
        s.src = '/lib.js';
        document.head.appendChild(s);
      </script>`);
    case '/headers':
      return page('Headers', `<script>
        const h = new Headers({ 'X-A': '1' });
        h.append('x-a', '2');
        fetch('/echo', { headers: h }).then((r) => r.text()).then((t) => { document.title = t; });
      </script>`);
    case '/echo':
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: `x-a=${headers['x-a'] ?? ''}` };
    case '/bad-src':
      return page('BadSrc', `<p id="out">still here</p><script src="/missing.js"></script><script>document.title = 'after bad';</script>`);
    default:
      return query ? notFound() : notFound();
  }
}

function mockCan() {
  const vnet = {
    async request({ port, method = 'GET', path = '/', headers = {}, body }) {
      if (port !== PORT) throw new KernelError('ECONNREFUSED', `ECONNREFUSED: connection refused :${port}`, { port });
      const bodyText = body ? Buffer.from(body).toString('utf8') : '';
      const reqHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      const res = route(method, path, reqHeaders, bodyText);
      const outHeaders = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      return { status: res.status ?? 200, headers: outHeaders, body: Buffer.from(res.body ?? '') };
    },
  };
  return { id: 'scripts-can', name: 'scripts-can', vnet };
}

const base = `http://localhost:${PORT}`;
const wait = (b) => b.wait(20);

describe('page scripts: external and module scripts', () => {
  let can;
  before(() => { can = mockCan(); });

  test('an external <script src> is fetched and runs before the next inline script', async () => {
    const b = new Browser({ can, internet: false });
    await b.goto(`${base}/ext`);
    assert.equal(b.query('#out')[0].text, 'from-lib');
  });

  test('defer scripts run after classic scripts, and before load', async () => {
    const b = new Browser({ can, internet: false });
    await b.goto(`${base}/order`);
    assert.deepEqual(await b.evaluate('window.log'), [1, 2, 'defer']);
  });

  test('an inline module imports a module with top-level await from its URL', async () => {
    const b = new Browser({ can, internet: false });
    await b.goto(`${base}/module`);
    assert.equal(b.query('#out')[0].text, 'mod tla');
  });

  test('a module script with src resolves its relative imports against the file', async () => {
    const b = new Browser({ can, internet: false });
    await b.goto(`${base}/module-src`);
    assert.equal(b.query('body')[0].attrs['data-v'], 'tla');
  });

  test('a missing script file is logged and the page keeps running', async () => {
    const b = new Browser({ can, internet: false });
    await b.goto(`${base}/bad-src`);
    assert.equal(b.title, 'after bad');
    assert.ok(b.consoleLog.some((l) => /failed to load script \/missing\.js/.test(l.text)));
  });
});

describe('page scripts: history, XMLHttpRequest, document.write, dynamic scripts, Headers', () => {
  let can;
  before(() => { can = mockCan(); });

  test('history.pushState changes the URL without reloading, and back fires popstate', async () => {
    const b = new Browser({ can, internet: false });
    await b.goto(`${base}/history`);
    assert.equal(await b.evaluate('location.pathname'), '/history/next');
    assert.equal(b.url, `${base}/history/next`);
    assert.equal(await b.evaluate('history.length'), 2);
    assert.equal(b.query('#p')[0].text, 'start', 'the document stayed, so the DOM is unchanged');
    await b.back();
    assert.equal(b.url, `${base}/history`);
    assert.equal(await b.evaluate('window.popped'), 'none');
  });

  test('XMLHttpRequest sends, and its onload sees status, text and headers', async () => {
    const b = new Browser({ can, internet: false });
    await b.goto(`${base}/xhr`);
    await wait(b);
    assert.equal(b.query('#x')[0].text, '200:{"ok":true}:application/json');
  });

  test('document.write inserts markup after the running script, and its scripts run', async () => {
    const b = new Browser({ can, internet: false });
    await b.goto(`${base}/write`);
    const ids = b.query('p').map((p) => p.attrs.id);
    assert.deepEqual(ids, ['before', 'w', 'after']);
    assert.equal(await b.evaluate('document.getElementById("w").getAttribute("data-s")'), 'ran');
  });

  test('a <script> created with createElement and appended runs (inline text)', async () => {
    const b = new Browser({ can, internet: false });
    await b.goto(`${base}/dyn`);
    assert.equal(await b.evaluate('document.body.getAttribute("data-dyn")'), 'yes');
  });

  test('a <script> created with createElement and given src loads and runs', async () => {
    const b = new Browser({ can, internet: false });
    await b.goto(`${base}/dyn-src`);
    await wait(b);
    assert.equal(await b.evaluate('window.libValue'), 'from-lib');
  });

  test('Headers objects are accepted by fetch and joined with ", "', async () => {
    const b = new Browser({ can, internet: false });
    await b.goto(`${base}/headers`);
    await wait(b);
    assert.equal(b.title, 'x-a=1, 2');
  });

  test('innerHTML does not run scripts, as in a browser', async () => {
    const b = new Browser({ can, internet: false });
    await b.goto(`${base}/module`);
    await b.evaluate('document.body.innerHTML = "<script>window.ranInner = true<\\/script>"');
    assert.equal(await b.evaluate('window.ranInner === undefined'), true);
  });
});
