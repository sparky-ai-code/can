// A page reads el.constructor.prototype (React's property setters do). The DOM constructor it gets is inert, and the
// membrane keeps the host reachable only through it: no path from it to Function, so no code generation.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../src/browser/browser.js';

function pageCan(html) {
  return {
    id: 'dom-ctor', name: 'dom-ctor',
    vnet: { async request() { return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) }; } },
  };
}

async function runPage(script) {
  const html = `<!doctype html><html><body><div id="out"></div><script>${script}</script></body></html>`;
  const b = new Browser({ can: pageCan(html), internet: false });
  await b.goto('http://localhost:8080/');
  return { text: await b.text('#out'), errors: b.consoleLog.filter((m) => m.level === 'error') };
}

describe('DOM constructors seen by page code', () => {
  test('el.constructor is a function whose prototype is the element prototype', async () => {
    const r = await runPage(`
      var d = document.createElement('div');
      var c = d.constructor;
      document.getElementById('out').textContent = [typeof c, typeof c.prototype, c.prototype.constructor === c, d instanceof c.prototype.constructor].join(',');
    `);
    assert.deepEqual(r.errors, []);
    assert.equal(r.text, 'function,object,true,true');
  });

  test('the constructor does not reach Function (no constructor-of-constructor, no code generation)', async () => {
    const r = await runPage(`
      var c = document.createElement('div').constructor;
      var fromCtor = typeof c.constructor;
      var generated = 'no';
      try { generated = String(c.constructor('return 1')()); } catch (e) { generated = 'blocked'; }
      document.getElementById('out').textContent = fromCtor + ',' + generated;
    `);
    assert.deepEqual(r.errors, []);
    assert.equal(r.text, 'undefined,blocked');
  });

  test('calling the constructor throws, as a browser refuses `new` on an element class', async () => {
    const r = await runPage(`
      var c = document.createElement('div').constructor;
      var result = 'none';
      try { c(); result = 'returned'; } catch (e) { result = 'threw'; }
      document.getElementById('out').textContent = result;
    `);
    assert.equal(r.text, 'threw');
  });
});
