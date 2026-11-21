import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseHTML, decodeEntities } from '../src/browser/html.js';
import { compile, querySelector, querySelectorAll, matches, findByText, SelectorError } from '../src/browser/selector.js';
import { CookieJar } from '../src/browser/net.js';
import { Browser } from '../src/browser/browser.js';
import { VNet } from '../src/kernel/vnet.js';
import { KernelError } from '../src/kernel/errors.js';

// ---------------------------------------------------------------- HTML parser

describe('html parser', () => {
  test('void and self-closing elements do not swallow following siblings', () => {
    const doc = parseHTML('<div><br><img src="a.png"><input name=x>after<hr/>tail</div>');
    const div = doc.querySelector('div');
    assert.deepEqual(div.children.map((c) => c.tagName), ['br', 'img', 'input', 'hr']);
    assert.equal(div.textContent, 'aftertail');
    assert.equal(doc.querySelector('img').getAttribute('src'), 'a.png');
  });

  test('implied end tags for p, li, dt/dd, option, td/tr', () => {
    const doc = parseHTML('<p>one<p>two<ul><li>a<li>b</ul><dl><dt>k<dd>v<dt>k2</dl>'
      + '<select><option>x<option selected>y</select>'
      + '<table><tr><td>1<td>2<tr><td>3</table>');
    assert.deepEqual(doc.querySelectorAll('p').map((p) => p.textContent), ['one', 'two']);
    assert.deepEqual(doc.querySelectorAll('li').map((l) => l.textContent), ['a', 'b']);
    assert.deepEqual(doc.querySelectorAll('dt').map((d) => d.textContent), ['k', 'k2']);
    assert.deepEqual(doc.querySelectorAll('dd').map((d) => d.textContent), ['v']);
    assert.deepEqual(doc.querySelectorAll('option').map((o) => o.textContent), ['x', 'y']);
    assert.equal(doc.querySelector('select').value, 'y');
    assert.deepEqual(doc.querySelectorAll('tr').map((r) => r.children.length), [2, 1]);
  });

  test('script, style and textarea content is raw or RCDATA', () => {
    const doc = parseHTML('<script>if (a<b && "</div>") go()</script>'
      + '<style>p > span { color: "red" }</style>'
      + '<textarea name=t>&lt;b&gt; <i>not a tag</i></textarea>');
    assert.equal(doc.querySelector('script').textContent, 'if (a<b && "</div>") go()');
    assert.equal(doc.querySelector('style').textContent, 'p > span { color: "red" }');
    assert.equal(doc.querySelector('textarea').textContent, '<b> <i>not a tag</i>');
    assert.equal(doc.querySelectorAll('i').length, 0);
  });

  test('entities: named, decimal, hex, legacy without semicolon, unknown left alone', () => {
    assert.equal(decodeEntities('&amp; &lt;&gt; &quot; &#65;&#x42;&#X43; &copy; &nbsp;|'), '& <> " ABC ©  |');
    assert.equal(decodeEntities('AT&amp T&T &bogus; &#0; &#x110000;'), 'AT& T&T &bogus; � �');
    const doc = parseHTML('<p title="a &amp; &quot;b&quot;">x &lt; y</p>');
    assert.equal(doc.querySelector('p').getAttribute('title'), 'a & "b"');
    assert.equal(doc.querySelector('p').textContent, 'x < y');
  });

  test('attributes: quoting styles, boolean, uppercase names, duplicates (first wins)', () => {
    const doc = parseHTML(`<INPUT Type='checkbox' NAME=agree checked data-x="1" data-x="2" value=/a/b>`);
    const el = doc.querySelector('input');
    assert.equal(el.tagName, 'input');
    assert.equal(el.getAttribute('type'), 'checkbox');
    assert.equal(el.getAttribute('name'), 'agree');
    assert.equal(el.getAttribute('checked'), '');
    assert.equal(el.getAttribute('data-x'), '1');
    assert.equal(el.getAttribute('value'), '/a/b');
  });

  test('synthesizes html, head and body, and keeps <title> in head', () => {
    const doc = parseHTML('  <title> Hi  there </title>\n<p>body</p>');
    assert.equal(doc.documentElement.tagName, 'html');
    assert.equal(doc.head.tagName, 'head');
    assert.equal(doc.body.tagName, 'body');
    assert.equal(doc.title, 'Hi there');
    assert.equal(doc.body.querySelector('p').textContent, 'body');
    const empty = parseHTML('');
    assert.ok(empty.head && empty.body);
  });

  test('comments are kept as nodes, doctype is dropped, broken markup is tolerated', () => {
    const doc = parseHTML('<!DOCTYPE html><!-- note --><div class=x><span>a</span></b></i></div><p>unclosed <b>bold <i>both</b> tail');
    assert.equal(doc.body.querySelector('div .x'), null);
    assert.equal(doc.body.querySelector('div.x > span').textContent, 'a');
    const comments = [];
    (function walk(n) { for (const c of n.childNodes) { if (c.nodeType === 8) comments.push(c.data); walk(c); } })(doc);
    assert.deepEqual(comments, [' note ']);
    assert.ok(doc.body.textContent.includes('bold'));
    // An unterminated tag at end of input is dropped; so is everything an open quote swallows.
    assert.equal(parseHTML('<p>ok</p><div class="x').body.querySelector('div'), null);
    assert.doesNotThrow(() => parseHTML('<<>> </ <!-- open <a href="'));
  });

  test('innerHTML get/set round-trips with escaping; textContent set replaces children', () => {
    const doc = parseHTML('<div id="d"><b>x</b></div>');
    const d = doc.getElementById('d');
    assert.equal(d.innerHTML, '<b>x</b>');
    d.innerHTML = '<i class="q">a &amp; b</i><br>';
    assert.equal(d.innerHTML, '<i class="q">a &amp; b</i><br>');
    assert.equal(d.querySelector('i').textContent, 'a & b');
    d.textContent = '<tag> & "quote"';
    assert.equal(d.innerHTML, '&lt;tag&gt; &amp; "quote"');
    assert.equal(d.outerHTML, '<div id="d">&lt;tag&gt; &amp; "quote"</div>');
  });
});

// ---------------------------------------------------------------- selectors

describe('selectors', () => {
  const doc = parseHTML(`
    <div id="main" class="box wide">
      <h1 class="title">Hi</h1>
      <ul>
        <li class="item first">one</li>
        <li class="item">two</li>
        <li class="item last">three</li>
      </ul>
      <form action="/go" method="post">
        <input type="text" name="user" value="ann">
        <input type="password" name="pw" disabled>
        <input type="checkbox" name="ok" checked>
        <button type="submit">Send now</button>
      </form>
      <p data-role="note">note</p>
    </div>
    <span class="box">outside</span>`);
  const ids = (sel) => querySelectorAll(doc, sel).map((e) => e.getAttribute('id') ?? e.textContent.trim().slice(0, 12));

  test('tag, id, class, and multiple classes', () => {
    assert.equal(querySelector(doc, 'h1').textContent, 'Hi');
    assert.equal(querySelector(doc, '#main').tagName, 'div');
    assert.equal(querySelectorAll(doc, '.item').length, 3);
    assert.equal(querySelectorAll(doc, '.box.wide').length, 1);
    assert.equal(querySelectorAll(doc, 'div.box').length, 1);
    assert.equal(querySelectorAll(doc, '*').length > 10, true);
  });

  test('attribute selectors: presence, equality, operators, case flag', () => {
    assert.equal(querySelectorAll(doc, '[name]').length, 3);
    assert.equal(querySelector(doc, '[name=user]').getAttribute('value'), 'ann');
    assert.equal(querySelector(doc, 'input[type="password"]').getAttribute('name'), 'pw');
    assert.equal(querySelector(doc, 'form[action^="/g"]').tagName, 'form');
    assert.equal(querySelector(doc, 'input[name$=ser]').getAttribute('name'), 'user');
    assert.equal(querySelector(doc, '[data-role*=ot]').textContent, 'note');
    assert.equal(querySelector(doc, '[type=TEXT i]').getAttribute('name'), 'user');
    assert.equal(querySelector(doc, '[type=TEXT]'), null);
    assert.equal(querySelector(doc, '[class~=wide]').id, 'main');
  });

  test('combinators: descendant, child, adjacent and general sibling', () => {
    assert.equal(querySelectorAll(doc, 'div li').length, 3);
    assert.equal(querySelectorAll(doc, 'div > li').length, 0);
    assert.equal(querySelectorAll(doc, 'ul > li').length, 3);
    assert.deepEqual(ids('li.first + li'), ['two']);
    assert.deepEqual(ids('li.first ~ li'), ['two', 'three']);
  });

  test('selector groups and pseudo-classes', () => {
    assert.equal(querySelectorAll(doc, 'h1, p').length, 2);
    assert.equal(querySelector(doc, 'li:first-child').textContent, 'one');
    assert.equal(querySelector(doc, 'li:last-child').textContent, 'three');
    assert.equal(querySelector(doc, 'li:nth-child(2)').textContent, 'two');
    assert.equal(querySelector(doc, 'li:nth-child(odd)').textContent, 'one');
    assert.equal(querySelector(doc, 'li:nth-child(-n+2)').textContent, 'one');
    assert.equal(querySelector(doc, 'li:nth-last-child(1)').textContent, 'three');
    assert.equal(querySelector(doc, 'input:nth-of-type(2)').getAttribute('name'), 'pw');
    assert.equal(querySelectorAll(doc, 'li:not(.first)').length, 2);
    assert.equal(querySelector(doc, 'li:contains("two")').textContent, 'two');
    assert.equal(querySelector(doc, 'input:checked').getAttribute('name'), 'ok');
    assert.equal(querySelector(doc, 'input:disabled').getAttribute('name'), 'pw');
    assert.equal(querySelector(doc, 'input:enabled').getAttribute('name'), 'user');
    assert.equal(querySelector(doc, 'li:empty'), null);
  });

  test('querySelector on an element searches descendants but matches against the whole tree', () => {
    const ul = querySelector(doc, 'ul');
    assert.equal(ul.querySelectorAll('li').length, 3);
    assert.equal(ul.querySelectorAll('div li').length, 3);
    assert.equal(ul.querySelector('ul'), null);
    assert.equal(matches(querySelector(doc, 'li'), 'div ul > li.first'), true);
    assert.equal(doc.getElementById('main').getAttribute('class'), 'box wide');
    assert.equal(doc.getElementById('nope'), null);
  });

  test('invalid selectors throw SelectorError', () => {
    for (const bad of ['div >', '[name', 'a[href=]', 'li:bogus', '::before', 'p)', '', '#']) {
      assert.throws(() => compile(bad), SelectorError, bad);
    }
  });

  test('findByText prefers exact matches, then substring; normalizes whitespace and case', () => {
    const links = parseHTML('<a>Sign  in now</a><a>Sign in</a><a>Log out</a>').querySelectorAll('a');
    assert.equal(findByText(links, 'sign in').textContent, 'Sign in');
    assert.equal(findByText(links, 'LOG OUT').textContent, 'Log out');
    assert.equal(findByText(links, 'now').textContent, 'Sign  in now');
    assert.equal(findByText(links, 'nope'), undefined);
  });
});

// ---------------------------------------------------------------- cookies

describe('cookie jar', () => {
  const url = (s) => new URL(s);

  test('stores, scopes by host and path, and sends the right cookies', () => {
    const jar = new CookieJar({ clock: () => 1000 });
    jar.setFromResponse(url('http://a.test/app/login'), ['sid=1; Path=/app', 'theme=dark; Path=/']);
    assert.equal(jar.headerFor(url('http://a.test/app/x')), 'sid=1; theme=dark');
    assert.equal(jar.headerFor(url('http://a.test/other')), 'theme=dark');
    assert.equal(jar.headerFor(url('http://b.test/app/x')), '');
  });

  test('Domain attribute covers subdomains; foreign domains are rejected', () => {
    const jar = new CookieJar({ clock: () => 0 });
    jar.setFromResponse(url('http://www.site.test/'), 'a=1; Domain=site.test');
    jar.setFromResponse(url('http://www.site.test/'), 'b=2; Domain=evil.test');
    assert.equal(jar.headerFor(url('http://api.site.test/')), 'a=1');
    assert.equal(jar.list().some((c) => c.name === 'b'), false);
  });

  test('Max-Age, Expires, Secure, HttpOnly and deletion', () => {
    let now = 0;
    const jar = new CookieJar({ clock: () => now });
    jar.setFromResponse(url('https://s.test/'), ['short=1; Max-Age=10', 'sec=2; Secure', 'h=3; HttpOnly']);
    // Secure is withheld over http; HttpOnly is withheld only from script (document.cookie).
    assert.equal(jar.headerFor(url('http://s.test/')), 'short=1; h=3');
    assert.equal(jar.headerFor(url('https://s.test/')), 'short=1; sec=2; h=3');
    assert.equal(jar.headerFor(url('https://s.test/'), { fromDocument: true }), 'short=1; sec=2');
    now = 11_000;
    assert.equal(jar.headerFor(url('https://s.test/')), 'sec=2; h=3');
    jar.setFromResponse(url('https://s.test/'), 'sec=; Max-Age=0');
    assert.equal(jar.headerFor(url('https://s.test/')), 'h=3');
  });
});

// ---------------------------------------------------------------- browser

const PORT_REFUSED = 9999;

/**
 * A mock vnet with the same request() shape as src/kernel/vnet.js (headers lowercased, bodies
 * encoded to Buffers, objects become JSON). Serves a small site and records every request.
 */
function mockCan() {
  const requests = [];
  const vnet = {
    async request({ port, method = 'GET', path = '/', headers = {}, body }) {
      const bodyText = body ? Buffer.from(body).toString('utf8') : '';
      const reqHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      requests.push({ port, method, path, headers: reqHeaders, body: bodyText });
      if (port === PORT_REFUSED) throw new KernelError('ECONNREFUSED', `ECONNREFUSED: connection refused :${port}`, { port });
      return encodeResponse(route(method, path, reqHeaders, bodyText));
    },
  };
  return { id: 'test-can', name: 'test-can', vnet, requests };
}

function encodeResponse(res) {
  const headers = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let body = res.body ?? '';
  if (typeof body === 'object' && !Buffer.isBuffer(body)) {
    headers['content-type'] ??= 'application/json';
    body = JSON.stringify(body);
  }
  return { status: res.status ?? 200, headers, body: Buffer.from(body) };
}

const html = (title, body) => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
});
const redirect = (status, location, extra = {}) => ({ status, headers: { location, ...extra }, body: '' });
const notFound = () => ({ status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' });

function route(method, path, headers, body) {
  const u = new URL(path, 'http://site');
  const loggedIn = (headers.cookie ?? '').includes('sid=abc123');
  switch (u.pathname) {
    case '/':
      return html('Home', '<h1>Home</h1><p>Welcome. <a href="/login">Log in</a> or <a href="/old">old page</a>.</p>');
    case '/login':
      return html('Login', `<h1>Login</h1>
        <form method="post" action="/session">
          <label>Email <input type="text" name="user"></label>
          <label for="pw">Password</label><input id="pw" type="password" name="password">
          <button type="submit">Sign in</button>
        </form>
        <p id="status">loading</p>
        <script>document.getElementById('status').textContent = 'ready';</script>`);
    case '/session':
      if (method !== 'POST') return { status: 405, headers: {}, body: '' };
      if (!body.includes('user=alice')) return { status: 401, headers: { 'content-type': 'text/plain' }, body: 'bad login' };
      return redirect(303, '/dashboard', { 'set-cookie': 'sid=abc123; Path=/; HttpOnly' });
    case '/dashboard':
      if (!loggedIn) return redirect(302, '/login');
      return html('Dashboard', `<h1>Dashboard</h1><p>Welcome alice</p>
        <form class="search" action="/search" method="get"><input name="q"><button type="submit">Go</button></form>`);
    case '/search':
      return html('Search', `<p id="result">results for ${u.searchParams.get('q') ?? ''}</p>`);
    case '/old':
      return redirect(301, '/new');
    case '/new':
      return redirect(307, '/dashboard');
    case '/loop':
      return redirect(302, '/loop');
    case '/js':
      return html('JS', `<p id="out">init</p><button id="btn">Tap</button><p id="count">0</p><p id="api"></p><div id="host"></div>
        <script>
          document.getElementById('out').textContent = 'ran ' + (1 + 2);
          let n = 0;
          document.getElementById('btn').addEventListener('click', () => {
            n++;
            document.getElementById('count').textContent = 'clicked ' + n;
          });
          fetch('/api').then((r) => r.json()).then((d) => { document.getElementById('api').textContent = d.v; });
          const made = document.createElement('span');
          made.id = 'made';
          made.textContent = 'made';
          document.getElementById('host').appendChild(made);
        </script>`);
    case '/api':
      return { status: 200, headers: { 'content-type': 'application/json' }, body: { v: 'from-api' } };
    case '/broken':
      return html('start', `<p>x</p><script>throw new Error('boom');</script><script>document.title = 'after';</script>`);
    case '/hidden':
      return html('H', `<p>shown</p><p hidden>secret</p><p style="display: none">gone</p>
        <script>var s = 'hidden-script';</script><style>p { color: red }</style>`);
    case '/form':
      return html('Form', `<form id="f" method="post" action="/submitted">
          <label>Name <input name="name" value="bo"></label>
          <label>Country <select name="country"><option value="US">United States</option><option value="CA">Canada</option></select></label>
          <label><input type="checkbox" name="agree"> Agree</label>
          <input type="radio" name="plan" value="free" id="r1"><label for="r1">Free</label>
          <input type="radio" name="plan" value="pro" id="r2" checked><label for="r2">Pro</label>
          <button type="submit">Send</button>
        </form>`);
    case '/submitted':
      return html('Submitted', `<p id="echo">${body}</p><p id="ctype">${headers['content-type'] ?? ''}</p>`);
    case '/prevent':
      return html('Prevent', `<form method="post" action="/submitted"><input name="x" value="1"><button>Go</button></form>
        <script>document.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); document.title = 'blocked'; });</script>`);
    case '/multipart':
      return html('MP', `<form method="post" action="/submitted" enctype="multipart/form-data"><input name="field" value="v"><button>Go</button></form>`);
    case '/anchors':
      return html('Anchors', `<a href="#sec">go</a><h2 id="sec">Sec</h2>`);
    case '/jsnav':
      return html('JSNav', `<p>before</p><script>location.href = '/hidden';</script>`);
    case '/spin':
      return html('Spin', `<p>start</p><script>while (true) {}</script><script>document.title = 'still';</script><p>after</p>`);
    default:
      return notFound();
  }
}

describe('browser: navigation, forms, cookies, scripts (mock vnet)', () => {
  let can;
  let b;
  const base = 'http://localhost:8080';

  before(() => {
    can = mockCan();
  });

  test('goto loads a page: url, status, title, text, links', async () => {
    b = new Browser({ can, internet: false });
    const res = await b.goto(`${base}/`);
    assert.deepEqual(res, { url: `${base}/`, status: 200, title: 'Home' });
    assert.equal(b.url, `${base}/`);
    assert.equal(b.title, 'Home');
    assert.match(b.text(), /Home\s+Welcome\. Log in or old page\./);
    assert.deepEqual(b.links(), [
      { text: 'Log in', href: `${base}/login` },
      { text: 'old page', href: `${base}/old` },
    ]);
    assert.equal(can.requests.at(-1).path, '/');
  });

  test('click on link text follows the link; query returns tag, text and attrs', async () => {
    const r = await b.click('Log in');
    assert.equal(r.navigated, true);
    assert.equal(b.url, `${base}/login`);
    assert.equal(b.status, 200);
    assert.deepEqual(b.query('input[name=user]'), [{ tag: 'input', text: '', attrs: { type: 'text', name: 'user' } }]);
    assert.equal(b.query('h1')[0].text, 'Login');
    assert.equal(b.query('#status')[0].text, 'ready', 'inline script changed the DOM before the call returned');
  });

  test('snapshot lists headings, fields and buttons with stable refs', async () => {
    const snap = b.snapshot();
    assert.match(snap, /heading "Login" level=1/);
    assert.match(snap, /textbox "Email" \[e\d+\]/);
    assert.match(snap, /textbox "Password" \[e\d+\]/);
    assert.match(snap, /button "Sign in" \[e\d+\]/);
    assert.match(snap, /text "ready"/);
    const again = b.snapshot();
    const ref = (s, re) => s.match(re)[1];
    assert.equal(ref(snap, /button "Sign in" \[(e\d+)\]/), ref(again, /button "Sign in" \[(e\d+)\]/));
    assert.doesNotMatch(snap, /<redacted>/);
  });

  test('type by label, type by selector, and password values are redacted in snapshots', async () => {
    await b.type('Email', 'alice');
    await b.type('input[name=password]', 'pw');
    const snap = b.snapshot();
    assert.match(snap, /textbox "Email" \[e\d+\] value="alice"/);
    assert.match(snap, /textbox "Password" \[e\d+\] value=<redacted>/);
  });

  test('submitting a form by clicking its submit button posts urlencoded data, follows 303, keeps cookies', async () => {
    const snap = b.snapshot();
    const ref = snap.match(/button "Sign in" \[(e\d+)\]/)[1];
    const r = await b.click(ref);
    assert.equal(r.navigated, true);
    assert.equal(b.url, `${base}/dashboard`);
    assert.match(b.text(), /Welcome alice/);
    const post = can.requests.filter((q) => q.method === 'POST').at(-1);
    assert.equal(post.path, '/session');
    assert.equal(post.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(post.body, 'user=alice&password=pw');
    const sid = b.cookieList().find((c) => c.name === 'sid');
    assert.equal(sid.value, 'abc123');
    assert.equal(sid.httpOnly, true);
    assert.equal(await b.evaluate('document.cookie'), '', 'HttpOnly cookie is hidden from scripts');
  });

  test('history: back, forward, and reload', async () => {
    assert.deepEqual(b.history.urls, [`${base}/`, `${base}/login`, `${base}/dashboard`]);
    await b.back();
    assert.equal(b.url, `${base}/login`);
    await b.back();
    assert.equal(b.url, `${base}/`);
    await b.forward();
    assert.equal(b.url, `${base}/login`);
    const before = can.requests.length;
    await b.reload();
    assert.equal(can.requests.length, before + 1);
    assert.equal(b.url, `${base}/login`);
  });

  test('redirect chains (301, 307) are followed and the final URL is recorded', async () => {
    await b.goto(`${base}/old`);
    assert.equal(b.url, `${base}/dashboard`);
    assert.equal(b.status, 200);
    assert.equal(can.requests.slice(-3).map((q) => q.path).join(' '), '/old /new /dashboard');
  });

  test('redirect loops stop after 10 hops with ELOOP', async () => {
    await assert.rejects(b.goto(`${base}/loop`), (err) => err.code === 'ELOOP');
    assert.equal(b.url, `${base}/dashboard`, 'page stays where it was');
  });

  test('GET form: type, submit with a target, query string built and page updated', async () => {
    await b.goto(`${base}/dashboard`);
    await b.type('input[name=q]', 'cats & dogs');
    const r = await b.submit('form.search');
    assert.equal(r.url, `${base}/search?q=cats+%26+dogs`);
    assert.equal(b.query('#result')[0].text, 'results for cats & dogs');
  });

  test('form fields: select, checkbox by label, radio by label, and urlencoded POST body', async () => {
    await b.goto(`${base}/form`);
    await b.select('Country', 'CA');
    await b.click('Agree');
    await b.click('Free');
    await b.click('Send');
    assert.equal(b.url, `${base}/submitted`);
    assert.equal(b.query('#echo')[0].text, 'name=bo&country=CA&agree=on&plan=free');
  });

  test('multipart/form-data encoding for enctype', async () => {
    await b.goto(`${base}/multipart`);
    await b.click('Go');
    assert.match(b.query('#ctype')[0].text, /^multipart\/form-data; boundary=/);
    assert.match(b.query('#echo')[0].text, /name="field"/);
  });

  test('a submit listener that calls preventDefault stops navigation', async () => {
    await b.goto(`${base}/prevent`);
    const r = await b.click('Go');
    assert.equal(r.navigated, false);
    assert.equal(b.url, `${base}/prevent`);
    assert.equal(b.title, 'blocked');
  });

  test('inline script: DOM changes, click listeners, fetch, and DOM API', async () => {
    await b.goto(`${base}/js`);
    assert.equal(b.query('#out')[0].text, 'ran 3');
    await b.click('#btn');
    assert.equal(b.query('#count')[0].text, 'clicked 1');
    await b.click('#btn');
    assert.equal(b.query('#count')[0].text, 'clicked 2');
    await b.wait(10);
    assert.equal(b.query('#api')[0].text, 'from-api');
    assert.equal(b.query('#made')[0].text, 'made');
    assert.equal(await b.evaluate('document.getElementById("out").textContent'), 'ran 3');
    assert.equal(await b.evaluate('1 + 2'), 3);
  });

  test('a throwing script is logged and later scripts still run', async () => {
    await b.goto(`${base}/broken`);
    assert.equal(b.title, 'after');
    const errs = b.consoleLog.filter((l) => l.level === 'error');
    assert.equal(errs.length, 1);
    assert.match(errs[0].text, /boom/);
  });

  test('text() skips hidden elements, scripts and styles', async () => {
    await b.goto(`${base}/hidden`);
    const t = b.text();
    assert.match(t, /shown/);
    assert.doesNotMatch(t, /secret|gone|hidden-script|color/);
  });

  test('stale refs are reported after the element is removed', async () => {
    await b.goto(`${base}/js`);
    const ref = b.snapshot().match(/button "Tap" \[(e\d+)\]/)[1];
    await b.click(ref);
    assert.equal(b.query('#count')[0].text, 'clicked 1');
    await b.evaluate('document.getElementById("btn").remove()');
    await assert.rejects(b.click(ref), (err) => err.code === 'ENOENT' && /stale/.test(err.message));
  });

  test('missing targets throw ENOENT; unknown ports throw ECONNREFUSED', async () => {
    await assert.rejects(b.click('Nonexistent thing'), (err) => err.code === 'ENOENT');
    await assert.rejects(b.goto(`http://localhost:${PORT_REFUSED}/`), (err) => err.code === 'ECONNREFUSED');
  });

  test('bare ports, the can name, and relative URLs resolve', async () => {
    let r = await b.goto('8080/login');
    assert.equal(r.url, `${base}/login`);
    r = await b.goto('http://test-can/');
    assert.equal(r.url, 'http://test-can/');
    r = await b.goto(`${base}/login`);
    r = await b.goto('?x=1');
    assert.equal(b.url, `${base}/login?x=1`);
  });

  test('real internet is refused when internet is disabled', async () => {
    const off = new Browser({ can, internet: false });
    await assert.rejects(off.goto('https://example.com/'), (err) => err.code === 'EPERM');
  });

  test('scripts:false leaves the DOM as served', async () => {
    const plain = new Browser({ can, internet: false, scripts: false });
    await plain.goto(`${base}/js`);
    assert.equal(plain.query('#out')[0].text, 'init');
  });

  test('snapshot of an unknown ref and a non-HTML response', async () => {
    await b.goto(`${base}/api`);
    assert.equal(b.text(), '{"v":"from-api"}');
    assert.match(b.snapshot(), /not HTML/);
    await assert.rejects(b.click('e999'), (err) => err.code === 'ENOENT');
  });

  test('scripts can set listeners on window and read location', async () => {
    const page = new Browser({ can, internet: false });
    can.requests.length = 0;
    await page.goto(`${base}/js`);
    assert.equal(await page.evaluate('location.pathname'), '/js');
    assert.equal(await page.evaluate('typeof window.setTimeout'), 'function');
  });

  test('hash links scroll within the same document without a request', async () => {
    await b.goto(`${base}/anchors`);
    const before = can.requests.length;
    const r = await b.click('go');
    assert.equal(r.url, `${base}/anchors#sec`);
    assert.equal(can.requests.length, before, 'no network request for a fragment');
    assert.equal(b.history.urls.at(-1), `${base}/anchors#sec`);
  });

  test('scripts can navigate the page with location.href', async () => {
    await b.goto(`${base}/jsnav`);
    assert.equal(b.url, `${base}/hidden`);
    assert.match(b.text(), /shown/);
  });

  test('a script that never returns is cut off; later scripts still run', async () => {
    const spin = new Browser({ can, internet: false, scriptTimeout: 100 });
    await spin.goto(`${base}/spin`);
    assert.equal(spin.title, 'still');
    assert.equal(spin.query('p')[1].text, 'after');
    assert.match(spin.consoleLog.find((l) => l.level === 'error').text, /timed out/);
    spin.close();
  });

  test('tabs keep separate history and pages', async () => {
    const tabs = new Browser({ can, internet: false });
    await tabs.goto(`${base}/`);
    await tabs.newTab(`${base}/hidden`);
    assert.equal(tabs.url, `${base}/hidden`);
    tabs.selectTab(0);
    assert.equal(tabs.url, `${base}/`);
    assert.equal(tabs.tabs.length, 2);
    tabs.closeTab(1);
    assert.equal(tabs.tabs.length, 1);
    tabs.close();
  });
});

describe('browser: real internet path (loopback 127.0.0.2, not a can port)', () => {
  test('goes through node:http, follows redirects and stores cookies', async (t) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/hop') {
        res.writeHead(302, { location: '/final', 'set-cookie': 'n=1; Path=/' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>Net ${req.method} ${req.url} cookie=${req.headers.cookie ?? ''}</title>`);
    });
    try {
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, '127.0.0.2', resolve);
      });
    } catch {
      t.skip('127.0.0.2 is not available on this host');
      return;
    }
    try {
      const { port } = srv.address();
      const b = new Browser({ can: { id: 'x', name: 'x', vnet: new VNet() }, timeout: 2000 });
      const r = await b.goto(`http://127.0.0.2:${port}/hop`);
      assert.equal(r.url, `http://127.0.0.2:${port}/final`);
      assert.equal(r.status, 200);
      assert.equal(b.title, `Net GET /final cookie=n=1`);
      assert.deepEqual(b.cookieList().map((c) => c.name).sort(), ['n']);
    } finally {
      srv.close();
    }
  });
});

describe('browser: real VNet integration', () => {
  test('serves a page listened on the can vnet through the real VNet class', async () => {
    const vnet = new VNet();
    vnet.listen(3000, (req) => ({
      headers: { 'content-type': 'text/html' },
      body: `<title>live</title><h1>hi ${req.method} ${req.url}</h1>`,
    }));
    const can = { id: 'real', name: 'real', vnet };
    const b = new Browser({ can, internet: false });
    await b.goto('http://localhost:3000/a?b=1');
    assert.equal(b.title, 'live');
    assert.equal(b.query('h1')[0].text, 'hi GET /a?b=1');
    await b.goto('http://real:3000/');
    assert.equal(b.query('h1')[0].text, 'hi GET /');
  });
});

describe('browser snapshot reads inline text as one line', () => {
  test('a paragraph with a span keeps its sentence together, and the link stays a ref', async () => {
    const html = '<title>Inline</title><p>Signed in as <span>ada</span>. <a href="/login">Log in</a> now</p>';
    const can = {
      id: 'inline-can',
      name: 'inline-can',
      vnet: {
        async request() {
          return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html) };
        },
      },
    };
    const b = new Browser({ can, internet: false });
    await b.goto('http://localhost:8080/');
    const snap = b.snapshot();
    assert.match(snap, /text "Signed in as ada\."/);
    assert.match(snap, /link "Log in" \[e\d+\] -> "\/login"/);
    assert.doesNotMatch(snap, /text "ada"/);
  });
});
