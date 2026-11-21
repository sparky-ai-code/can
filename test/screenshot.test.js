// Screenshots: the PNG encoder, the approximate renderer, the browser and can side, the MCP tool over stdio
// (image block, file written into the can and to the transfer root, refused escapes) and the CLI command.
// The renderer is an approximation, so these tests check known pixels and rules, not a browser's output.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { encodePNG, decodePNG, crc32, pngSize } from '../src/browser/png.js';
import { glyphRows, GLYPH_COUNT, FIRST_CHAR, LAST_CHAR } from '../src/browser/font.js';
import { parseHTML } from '../src/browser/html.js';
import { parseColor, renderPage, RENDER_LIMITS } from '../src/browser/render.js';
import { Browser } from '../src/browser/browser.js';
import { VNet } from '../src/kernel/vnet.js';
import { KernelError } from '../src/kernel/errors.js';
import { CanRegistry } from '../src/registry.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(TEST_DIR, '..', 'bin', 'can.js');
const MCP_BIN = path.resolve(TEST_DIR, '..', 'bin', 'can-mcp.js');
const LONG = { timeout: 120_000 };
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GREEN = [0, 255, 0];
const BLACK = [0, 0, 0];

// ---------------------------------------------------------------- helpers

/** Splits a PNG file into its chunks, checking each CRC with zlib.crc32 (independent of png.js). */
function readChunks(buf) {
  assert.deepEqual(buf.subarray(0, 8), SIGNATURE, 'PNG signature');
  const chunks = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const crc = buf.readUInt32BE(pos + 8 + len);
    assert.equal(zlib.crc32(buf.subarray(pos + 4, pos + 8 + len)), crc, `CRC of ${type}`);
    chunks.push({ type, data });
    pos += 12 + len;
  }
  return chunks;
}

/** Renders HTML with the default author-less setup (scripts are not run here, the DOM is parsed as is). */
function render(html, opts = {}) {
  return renderPage(parseHTML(html), opts);
}

const pixel = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [...img.data.subarray(i, i + 3)];
};

function countColor(img, [r, g, b]) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] === r && img.data[i + 1] === g && img.data[i + 2] === b) n++;
  }
  return n;
}

/** Bounding box of the pixels of one exact colour, or null. */
function bbox(img, [r, g, b]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] === r && img.data[i + 1] === g && img.data[i + 2] === b) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const STYLED_PAGE = `<!doctype html><html><head><style>
  .box { background-color: #00ff00; width: 100px; height: 50px; }
</style></head><body><div class="box"></div></body></html>`;

const PAGE = `<!doctype html><html><head><title>Shot</title><style>
  .box { background-color: #00ff00; width: 100px; height: 50px; }
</style></head><body>
  <h1>Shot OK</h1>
  <div class="box"></div>
  <p>hello world, <a href="/next">the link</a></p>
</body></html>`;

// A page server for the can: serves /home/agent/index.html on port 8080.
const SERVER_JS = "require('http').createServer((q, s) => { s.setHeader('content-type', 'text/html');"
  + " s.end(require('fs').readFileSync('/home/agent/index.html')); }).listen(8080);";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'can-shot-test-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** Makes a symbolic link (junction on Windows); false when the OS refuses (Windows without the link privilege). */
function tryLink(target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') return false;
    throw err;
  }
}

/** Runs the CLI and returns its exit status and output. */
function cli(args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 120_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A small MCP client over the server's stdio, the way an agent calls the tools. */
class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [MCP_BIN], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.nextId = 1;
    this.waiting = new Map();
    this.stderr = '';
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      const waiter = this.waiting.get(msg.id);
      if (waiter) {
        this.waiting.delete(msg.id);
        waiter(msg);
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const response = new Promise((resolve) => this.waiting.set(id, resolve));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }

  /** The whole tools/call result: {content, isError}. */
  async call(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    assert.equal(res.error, undefined, `protocol error from ${name}: ${JSON.stringify(res.error)}`);
    return res.result;
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => this.child.once('exit', resolve));
  }
}

// ---------------------------------------------------------------- PNG encoder and decoder

describe('PNG encoder and decoder (src/browser/png.js)', () => {
  test('CRC-32 matches the standard check value and zlib.crc32', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    const sample = Buffer.from('IDAT some bytes for the check');
    assert.equal(crc32(sample), zlib.crc32(sample));
  });

  test('RGBA output has a valid signature, IHDR, one IDAT that inflates to filtered rows, and IEND', () => {
    const data = Uint8Array.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      0, 0, 0, 0, 255, 255, 255, 255, 128, 128, 128, 255,
    ]); // 3 x 2 pixels
    const png = encodePNG({ width: 3, height: 2, data, channels: 4 });
    const chunks = readChunks(png);
    assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
    const ihdr = chunks[0].data;
    assert.equal(ihdr.length, 13);
    assert.equal(ihdr.readUInt32BE(0), 3);
    assert.equal(ihdr.readUInt32BE(4), 2);
    assert.deepEqual([...ihdr.subarray(8)], [8, 6, 0, 0, 0], 'bit depth 8, colour type 6 (RGBA), deflate, adaptive, no interlace');
    assert.equal(chunks[2].data.length, 0);
    const raw = zlib.inflateSync(chunks[1].data);
    assert.equal(raw.length, 2 * (1 + 3 * 4));
    assert.equal(raw[0], 0, 'row 0 filter: none');
    assert.deepEqual([...raw.subarray(1, 5)], [255, 0, 0, 255]);
    assert.equal(raw[1 + 12], 0, 'row 1 filter: none');
    assert.deepEqual(pngSize(png), { width: 3, height: 2 });
  });

  test('decodes back to the same pixels, for RGBA and RGB', () => {
    const rgba = Uint8Array.from({ length: 5 * 4 * 4 }, (_, i) => (i * 37) & 0xff);
    const back = decodePNG(encodePNG({ width: 5, height: 4, data: rgba, channels: 4 }));
    assert.equal(back.channels, 4);
    assert.deepEqual([...back.data], [...rgba]);
    const rgb = Uint8Array.from({ length: 7 * 2 * 3 }, (_, i) => (i * 11) & 0xff);
    const back3 = decodePNG(encodePNG({ width: 7, height: 2, data: rgb, channels: 3 }));
    assert.equal(back3.channels, 3);
    assert.deepEqual([...back3.data], [...rgb]);
  });

  test('refuses a corrupted chunk, a wrong data length and a non-PNG', () => {
    const png = encodePNG({ width: 2, height: 2, data: new Uint8Array(16).fill(9), channels: 4 });
    const bad = Buffer.from(png);
    bad[20] ^= 0xff; // a byte inside the IHDR data (the first chunk starts at byte 8)
    assert.throws(() => decodePNG(bad), /CRC|truncated|inflate|IDAT|bad/i);
    assert.throws(() => encodePNG({ width: 2, height: 2, data: new Uint8Array(3), channels: 4 }), RangeError);
    assert.throws(() => decodePNG(Buffer.from('GIF89a....')), /signature/);
  });
});

describe('font and colours (src/browser/font.js, render.js)', () => {
  test('every printable ASCII glyph is seven rows of five cells', () => {
    assert.equal(GLYPH_COUNT, LAST_CHAR - FIRST_CHAR + 1);
    for (let c = FIRST_CHAR; c <= LAST_CHAR; c++) {
      const rows = glyphRows(c);
      assert.equal(rows.length, 7, `rows of ${String.fromCharCode(c)}`);
      for (const row of rows) assert.match(row, /^[#.]{5}$/, `row of ${String.fromCharCode(c)}`);
    }
    assert.equal(glyphRows(127), null);
  });

  test('parseColor reads hex, rgb(), rgba(), names and transparent, and rejects junk', () => {
    assert.deepEqual(parseColor('#f00'), [255, 0, 0, 255]);
    assert.deepEqual(parseColor('#102030'), [16, 32, 48, 255]);
    assert.deepEqual(parseColor('rgb(0, 128, 255)'), [0, 128, 255, 255]);
    assert.deepEqual(parseColor('rgba(0 0 0 / 50%)'), [0, 0, 0, 128]);
    assert.deepEqual(parseColor('Silver'), [192, 192, 192, 255]);
    assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0]);
    assert.equal(parseColor('notacolour'), null);
    assert.equal(parseColor('#12345'), null);
  });
});

// ---------------------------------------------------------------- renderer

describe('approximate renderer (src/browser/render.js)', () => {
  test('a styled block paints its exact box: 100 x 50 at the body margin', () => {
    const img = render(STYLED_PAGE, { width: 300, height: 200 });
    assert.equal(img.width, 300);
    assert.equal(img.height, 200);
    assert.equal(countColor(img, GREEN), 100 * 50);
    assert.deepEqual(bbox(img, GREEN), { x0: 8, y0: 8, x1: 107, y1: 57, w: 100, h: 50 });
    assert.deepEqual(pixel(img, 8, 8), GREEN, 'known corner is the background colour');
    assert.deepEqual(pixel(img, 7, 8), [255, 255, 255], 'outside the box is the white page');
    assert.deepEqual(pixel(img, 108, 8), [255, 255, 255]);
  });

  test('text draws ink, headings are bigger than paragraphs, bold is heavier', () => {
    const p = bbox(render('<p>HI</p>', { width: 200, height: 100 }), BLACK);
    const h1 = bbox(render('<h1>HI</h1>', { width: 200, height: 100 }), BLACK);
    assert.ok(p && p.h > 0, 'paragraph text has ink');
    assert.ok(h1.h > p.h * 1.5, `h1 ${h1.h}px tall should be well over p ${p.h}px`);
    const plain = countColor(render('<p>IIIIII</p>', { width: 200, height: 60 }), BLACK);
    const bold = countColor(render('<p><b>IIIIII</b></p>', { width: 200, height: 60 }), BLACK);
    assert.ok(bold > plain, `bold ink ${bold} should exceed plain ${plain}`);
  });

  test('links are blue and underlined', () => {
    const img = render('<p><a href="/x">go now</a></p>', { width: 200, height: 80 });
    assert.ok(countColor(img, [0, 0, 238]) > 40, 'link text and underline are #0000ee');
  });

  test('text wraps at word boundaries inside the viewport width', () => {
    const text = 'one two three four five six seven eight nine ten';
    const wide = render(`<p>${text}</p>`, { width: 600, height: 60, fullPage: true });
    const narrow = render(`<p>${text}</p>`, { width: 110, height: 60, fullPage: true });
    assert.ok(narrow.contentHeight > wide.contentHeight + 40, 'narrow layout is several lines taller');
  });

  test('buttons, text inputs and checkboxes are drawn as boxes with their text', () => {
    const img = render('<button>Go</button> <input type="text" value="abc"> <input type="checkbox" checked>',
      { width: 400, height: 80 });
    assert.ok(countColor(img, [239, 239, 239]) > 100, 'button face');
    assert.ok(countColor(img, [118, 118, 118]) > 40, 'control borders');
    assert.ok(countColor(img, [0, 96, 223]) > 0, 'checked checkbox mark');
    assert.ok(countColor(img, BLACK) > 20, 'button label and input value are drawn in ink');
  });

  test('display:none, the hidden attribute and visibility:hidden draw nothing', () => {
    const img = render(`<p style="color:#010203;display:none">GONE ONE</p>
      <p hidden style="color:#010204">GONE TWO</p>
      <span style="color:#fe0102;visibility:hidden">GONE THREE</span>
      <p style="color:#040506">shown</p>`, { width: 300, height: 120 });
    assert.equal(countColor(img, [1, 2, 3]), 0);
    assert.equal(countColor(img, [1, 2, 4]), 0);
    assert.equal(countColor(img, [254, 1, 2]), 0);
    assert.ok(countColor(img, [4, 5, 6]) > 0, 'the visible paragraph is drawn in its colour');
  });

  test('an image that is not decoded is an outline with its alt text; size comes from width and height', () => {
    const img = render('<img src="x.png" alt="pic" width="60" height="40">', { width: 200, height: 100 });
    assert.deepEqual(pixel(img, 8, 8), [140, 140, 140], 'frame corner');
    assert.deepEqual(pixel(img, 60, 44), [255, 255, 255], 'no grey fill inside the frame');
    assert.deepEqual(bbox(img, [140, 140, 140]), { x0: 8, y0: 8, x1: 67, y1: 47, w: 60, h: 40 });
  });

  test('a PNG the browser decoded is drawn with its pixels, stretched by object-fit: fill', () => {
    // Two opaque pixels, red then green, decoded from a real PNG and drawn 40 x 20.
    const data = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
    const decoded = decodePNG(encodePNG({ width: 2, height: 1, data, channels: 4 }));
    const doc = parseHTML('<img src="x.png" width="40" height="20">');
    const img = renderPage(doc, { width: 100, height: 40, resources: { images: new Map([[doc.querySelector('img'), decoded]]) } });
    // the image sits at (8, 8) after the default body margin
    assert.deepEqual(pixel(img, 10, 10), [255, 0, 0], 'left half is red');
    assert.deepEqual(pixel(img, 30, 10), [0, 255, 0], 'right half is green');
  });

  test('object-fit: cover keeps proportions and crops; contain keeps them and letterboxes', () => {
    // A 2 x 1 red and green image in a 40 x 40 box: cover fills the box and crops the top and bottom; contain letterboxes.
    const data = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
    const decoded = decodePNG(encodePNG({ width: 2, height: 1, data, channels: 4 }));
    const run = (fit) => {
      const doc = parseHTML(`<img src="x.png" width="40" height="40" style="object-fit:${fit}">`);
      return renderPage(doc, { width: 60, height: 50, resources: { images: new Map([[doc.querySelector('img'), decoded]]) } });
    };
    const cover = run('cover');
    assert.deepEqual(pixel(cover, 10, 28), [255, 0, 0], 'cover: the left of the box is red');
    assert.deepEqual(pixel(cover, 45, 28), [0, 255, 0], 'cover: the right of the box is green');
    const contain = run('contain');
    assert.deepEqual(pixel(contain, 10, 10), [255, 255, 255], 'contain: the band above the picture is blank');
    assert.deepEqual(pixel(contain, 14, 28), [255, 0, 0], 'contain: the left half of the picture is red');
    assert.deepEqual(pixel(contain, 38, 28), [0, 255, 0], 'contain: the right half is green');
  });

  test('a table with a border draws grid lines around its cells', () => {
    const img = render('<table border="1"><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
      { width: 200, height: 120 });
    assert.ok(countColor(img, [136, 136, 136]) > 50, 'grid lines are drawn');
  });

  test('a style-block class and an inline style both apply, the inline style winning', () => {
    const img = render(`<style>.a { color: #010101; background-color: #0000ff; }</style>
      <div class="a" style="color:#020202">mixed</div>`, { width: 200, height: 80 });
    assert.ok(countColor(img, [0, 0, 255]) > 200, 'class background applies');
    assert.ok(countColor(img, [2, 2, 2]) > 0, 'inline colour wins over the class colour');
    assert.equal(countColor(img, [1, 1, 1]), 0);
  });

  test('fullPage grows the image to the content and keeps the page in bounds', () => {
    const img = render('<div style="height:1000px;background-color:#123456"></div>', { width: 200, height: 100, fullPage: true });
    assert.ok(img.height >= 1000, `height ${img.height}`);
    assert.equal(img.truncated, false);
    assert.deepEqual(pixel(img, 10, 900), [0x12, 0x34, 0x56]);
    const short = render('<p>short</p>', { width: 200, height: 100 });
    assert.equal(short.height, 100, 'without fullPage the viewport height is used');
  });

  test('rejects sizes outside the limits, and a blank page is white', () => {
    const doc = parseHTML('<p>x</p>');
    assert.throws(() => renderPage(doc, { width: 0 }), (e) => e instanceof KernelError && e.code === 'EINVAL');
    assert.throws(() => renderPage(doc, { width: RENDER_LIMITS.maxWidth + 1 }), KernelError);
    assert.throws(() => renderPage(doc, { width: 3840, height: 4096 }), KernelError, 'over the pixel budget');
    const blank = renderPage(parseHTML(''), { width: 64, height: 32 });
    assert.equal(countColor(blank, [255, 255, 255]), 64 * 32);
  });
});

// ---------------------------------------------------------------- browser

describe('Browser.screenshot', () => {
  test('a blank browser draws a white 1280x800 page', () => {
    const b = new Browser({ can: { id: 'blank', name: 'blank', vnet: new VNet() } });
    const png = b.screenshot();
    assert.deepEqual(pngSize(png), { width: 1280, height: 800 });
    const img = decodePNG(png);
    assert.deepEqual([...img.data.subarray(0, 3)], [255, 255, 255]);
  });

  test('screenshots the page served on the can vnet, with options for size', async () => {
    const vnet = new VNet();
    vnet.listen(3000, () => ({ headers: { 'content-type': 'text/html' }, body: PAGE }));
    const b = new Browser({ can: { id: 'shot', name: 'shot', vnet }, internet: false });
    await b.goto('http://localhost:3000/');
    const full = decodePNG(b.screenshot());
    assert.equal(full.width, 1280);
    assert.equal(full.height, 800);
    assert.deepEqual(pixel(full, 8, 8), [255, 255, 255], 'the heading is below the first pixels');
    const small = decodePNG(b.screenshot({ width: 300, height: 180 }));
    assert.equal(small.width, 300);
    assert.equal(small.height, 180);
    assert.equal(countColor(small, GREEN), 100 * 50, 'the styled box is in the screenshot');
    const tall = decodePNG(b.screenshot({ fullPage: true, width: 300, height: 100 }));
    assert.ok(tall.height > 100, 'fullPage is taller than the viewport');
  });
});

// ---------------------------------------------------------------- can, MCP and CLI (real VM children)

describe('can side: the VM child renders, the host gets the bytes', LONG, () => {
  let reg;
  let storeDir;
  let transferDir;

  before(() => {
    storeDir = path.join(tmpRoot, 'store');
    transferDir = path.join(tmpRoot, 'transfer');
    reg = new CanRegistry({ storeDir });
  });

  after(async () => {
    await reg.shutdown({ save: false });
  });

  test('Can.screenshot returns the PNG of the page served by a process in the can', async () => {
    const can = await reg.create('shotcan');
    await can.writeFile('/home/agent/index.html', PAGE);
    await can.writeFile('/home/agent/server.js', SERVER_JS);
    await can.spawn('node server.js', { background: true });
    await waitForPort(can, 8080);
    await can.browse('goto', 'http://localhost:8080/');
    const png = await can.screenshot({ width: 300, height: 180 });
    assert.deepEqual(pngSize(png), { width: 300, height: 180 });
    const img = decodePNG(png);
    assert.equal(countColor(img, GREEN), 100 * 50);
  });

  test('MCP browser_screenshot: image block, PNG in the can, copy in the transfer root, refused escapes', async () => {
    const env = { CAN_STORE_DIR: storeDir, CAN_TRANSFER_DIR: transferDir };
    const client = new McpClient(env);
    try {
      await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      await client.call('can_create', { name: 'mcpshot' });
      await client.call('can_write_file', { can: 'mcpshot', path: '/home/agent/index.html', content: PAGE });
      await client.call('can_write_file', { can: 'mcpshot', path: '/home/agent/server.js', content: SERVER_JS });
      await client.call('can_spawn', { can: 'mcpshot', command: 'node server.js' });
      await waitForPortMcp(client, 'mcpshot', 8080);
      await client.call('browser_goto', { can: 'mcpshot', url: 'http://localhost:8080/' });

      const res = await client.call('browser_screenshot', {
        can: 'mcpshot', width: 300, height: 180, hostPath: 'shots/page.png', path: '/home/agent/out/page.png',
      });
      assert.equal(res.isError, false, res.content[0].text);
      const text = res.content[0].text;
      assert.match(text, /canPath: \/home\/agent\/out\/page\.png/);
      assert.match(text, /width: 300/);
      assert.match(text, /height: 180/);
      const image = res.content.find((c) => c.type === 'image');
      assert.equal(image.mimeType, 'image/png');
      const inline = Buffer.from(image.data, 'base64');
      assert.deepEqual(pngSize(inline), { width: 300, height: 180 });

      const hostFile = path.join(transferDir, 'shots', 'page.png');
      assert.deepEqual(fs.readFileSync(hostFile), inline, 'the transfer root copy is the same PNG');
      const check = await client.call('can_read_file', { can: 'mcpshot', path: '/home/agent/out/page.png', encoding: 'base64' });
      assert.equal(Buffer.from(check.content[0].text, 'base64').equals(inline), true, 'the can copy is the same PNG');

      const default_ = await client.call('browser_screenshot', { can: 'mcpshot' });
      assert.match(default_.content[0].text, /canPath: \/tmp\/screenshots\/\S+\.png/);

      // Refused: a relative escape, an absolute path, and a second write without overwrite.
      const outside = path.join(tmpRoot, 'escape-shot.png');
      const esc = await client.call('browser_screenshot', { can: 'mcpshot', hostPath: '../escape-shot.png' });
      assert.equal(esc.isError, true);
      assert.match(esc.content[0].text, /EPERM/);
      assert.equal(fs.existsSync(path.join(transferDir, '..', 'escape-shot.png')), false);
      const abs = await client.call('browser_screenshot', { can: 'mcpshot', hostPath: outside });
      assert.equal(abs.isError, true);
      assert.match(abs.content[0].text, /EPERM/);
      assert.equal(fs.existsSync(outside), false);
      const again = await client.call('browser_screenshot', { can: 'mcpshot', hostPath: 'shots/page.png' });
      assert.equal(again.isError, true);
      assert.match(again.content[0].text, /EEXIST/);
      const replaced = await client.call('browser_screenshot', { can: 'mcpshot', hostPath: 'shots/page.png', overwrite: true });
      assert.equal(replaced.isError, false);
    } finally {
      await client.close();
    }
  });

  test('a link inside the transfer root that points outside is refused', async (t) => {
    const outsideDir = path.join(tmpRoot, 'outside-target');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(transferDir, { recursive: true });
    const link = path.join(transferDir, 'linked');
    if (!tryLink(outsideDir, link)) {
      t.diagnostic('symbolic links are not permitted here; the link check was skipped');
      return;
    }
    const client = new McpClient({ CAN_STORE_DIR: storeDir, CAN_TRANSFER_DIR: transferDir });
    try {
      await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      const r = await client.call('browser_screenshot', { can: 'mcpshot', hostPath: 'linked/x.png' });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /EPERM/);
      assert.deepEqual(fs.readdirSync(outsideDir), [], 'nothing was written through the link');
    } finally {
      await client.close();
    }
  });

  test('CLI screenshot writes into the transfer root; escapes and bad flags are refused', () => {
    const env = { CAN_STORE_DIR: storeDir, CAN_TRANSFER_DIR: path.join(tmpRoot, 'cli-transfer') };
    assert.equal(cli(['create', 'clishot'], env).code, 0);
    const ok = cli(['screenshot', 'clishot', '--out', 'cli.png', '--width', '320', '--height', '200'], env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /saved 320x200 PNG/);
    const file = path.join(env.CAN_TRANSFER_DIR, 'cli.png');
    assert.deepEqual(pngSize(fs.readFileSync(file)), { width: 320, height: 200 });

    const esc = cli(['screenshot', 'clishot', '--out', '../cli-escape.png'], env);
    assert.equal(esc.code, 1);
    assert.match(esc.stderr, /EPERM/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'cli-escape.png')), false);

    const exists = cli(['screenshot', 'clishot', '--out', 'cli.png'], env);
    assert.equal(exists.code, 1);
    assert.match(exists.stderr, /EEXIST/);

    assert.equal(cli(['screenshot', 'clishot', '--width', '0'], env).code, 2);
    assert.equal(cli(['screenshot'], env).code, 2);
    assert.equal(cli(['screenshot', 'clishot', '--bogus'], env).code, 2);
  });

  test('can help lists the screenshot command', () => {
    const r = cli(['help'], {});
    assert.equal(r.code, 0);
    assert.match(r.stdout, /can screenshot <can>/);
  });
});

/** Polls the can until a port is listening (its own process may take a moment to bind). */
async function waitForPort(can, port) {
  for (let i = 0; i < 100; i++) {
    const list = await can.listeners();
    if (list.some((l) => l.port === port)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`port ${port} never opened in the can`);
}

async function waitForPortMcp(client, can, port) {
  for (let i = 0; i < 100; i++) {
    const r = await client.call('can_ports', { can });
    if (r.content[0].text.includes(`port ${port} `)) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`port ${port} never opened in the can`);
}
