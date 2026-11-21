// Styling in the in-can renderer (src/browser/render.js, image.js): custom properties, media queries, clamp() and
// viewport units, max-width centring, the inherit keyword, absolute and fixed positioning, translate, linked
// stylesheets, and image format detection. Each case checks pixels where a coloured box lands.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from '../src/browser/html.js';
import { renderPage } from '../src/browser/render.js';
import { decodeImage } from '../src/browser/image.js';
import { encodePNG, decodePNG } from '../src/browser/png.js';

const WHITE = [255, 255, 255];
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];

const page = (css, body) => `<!doctype html><html><head><style>body{margin:0}${css}</style></head><body>${body}</body></html>`;

function shot(html, width = 400, height = 200, resources = null) {
  return renderPage(parseHTML(html), { width, height, resources });
}

function pixel(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [...img.data.subarray(i, i + 3)];
}

/** Bounding box of the pixels of one colour (x1 and y1 inclusive), or null. */
function bbox(img, [r, g, b]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] === r && img.data[i + 1] === g && img.data[i + 2] === b) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

describe('custom properties and inheritance', () => {
  test('var() reads a custom property from :root, with a fallback when it is missing', () => {
    const img = shot(page(':root{--brand:#ff0000}.a{background:var(--brand)}.b{background:var(--nope,#00ff00)}',
      '<div class="a" style="width:50px;height:20px"></div><div class="b" style="width:50px;height:20px"></div>'));
    assert.deepEqual(pixel(img, 20, 10), RED);
    // Divs are block boxes, so the second one sits below the first.
    assert.deepEqual(pixel(img, 20, 30), GREEN);
  });

  test('a custom property defined on a parent is inherited and can be overridden', () => {
    const img = shot(page(':root{--c:#ff0000}.p{--c:#00ff00}.k{background:var(--c);width:30px;height:10px}',
      '<div class="p"><div class="k"></div></div>'));
    assert.deepEqual(pixel(img, 15, 5), GREEN);
  });

  test('color: inherit takes the parent colour over the default link blue', () => {
    const img = shot(page('body{color:#ff0000}a{color:inherit}', '<a href="#">xxxxxxxx</a>'));
    assert.ok(img.data.some((_, i) => i % 4 === 0 && img.data[i] === 255 && img.data[i + 1] === 0 && img.data[i + 2] === 0),
      'the link text is red, not blue');
    assert.equal(img.data.some((_, i) => i % 4 === 0 && img.data[i + 2] === 238 && img.data[i] === 0), false);
  });
});

describe('media queries and lengths', () => {
  test('a min-width query applies at 1280 and not at 600', () => {
    const css = '.a{width:20px;height:10px;background:#ff0000}@media (min-width: 900px){.a{background:#00ff00}}';
    assert.deepEqual(pixel(shot(page(css, '<div class="a"></div>'), 1280, 100), 5, 5), GREEN);
    assert.deepEqual(pixel(shot(page(css, '<div class="a"></div>'), 600, 100), 5, 5), RED);
  });

  test('print and colour-scheme queries do not apply to a screen', () => {
    const css = '@media print{.a{background:#ff0000}}@media (prefers-color-scheme: dark){.a{background:#ff0000}}'
      + '.a{width:20px;height:10px;background:#00ff00}';
    assert.deepEqual(pixel(shot(page(css, '<div class="a"></div>')), 5, 5), GREEN);
  });

  test('clamp(), min() and vw sizes follow the viewport', () => {
    const img = shot(page('', '<div style="width:clamp(10px, 50vw, 150px);height:20px;background:#ff0000"></div>'), 400, 100);
    // 50vw of 400 is 200, clamped to 150. The page has no margin.
    assert.deepEqual(bbox(img, RED), { x0: 0, y0: 0, x1: 149, y1: 19, w: 150, h: 20 });
  });
});

describe('boxes', () => {
  test('max-width centres a box with auto side margins', () => {
    const img = shot(page('', '<div style="max-width:100px;margin:0 auto;height:10px;background:#ff0000"></div>'), 300, 40);
    assert.deepEqual(bbox(img, RED), { x0: 100, y0: 0, x1: 199, y1: 9, w: 100, h: 10 });
  });

  test('aspect-ratio sets the height from the width', () => {
    const img = shot(page('', '<div style="width:200px;aspect-ratio:2;background:#ff0000"></div>'), 300, 200);
    assert.equal(bbox(img, RED).h, 100);
  });
});

describe('positioning and transforms', () => {
  test('an absolute box is placed from the bottom and right of its positioned parent', () => {
    const img = shot(page('.box{position:relative;width:200px;height:100px}'
      + '.over{position:absolute;right:10px;bottom:10px;width:50px;height:20px;background:#ff0000}',
    '<div class="box"><div class="over"></div></div>'), 300, 150);
    // The box is at (0, 0), 200 x 100. The overlay ends 10px from its right and bottom: x 140..189, y 70..89.
    assert.deepEqual(bbox(img, RED), { x0: 140, y0: 70, x1: 189, y1: 89, w: 50, h: 20 });
  });

  test('a fixed element moved by translateY(-160%) leaves the page', () => {
    const img = shot(page('.s{position:fixed;top:12px;left:12px;width:40px;height:20px;background:#ff0000;'
      + 'transform:translateY(-160%)}', '<a class="s" href="#">x</a>'), 200, 100);
    assert.equal(bbox(img, RED), null);
  });

  test('translate(x, y) moves a box and what it drew', () => {
    const img = shot(page('', '<div style="width:40px;height:20px;background:#00ff00;transform:translate(30px,5px)"></div>'));
    assert.deepEqual(bbox(img, GREEN), { x0: 30, y0: 5, x1: 69, y1: 24, w: 40, h: 20 });
  });
});

describe('linked stylesheets and images', () => {
  test('a stylesheet the browser loaded (a link element) applies, in document order', () => {
    const doc = parseHTML('<!doctype html><html><head><link rel="stylesheet" href="site.css"></head>'
      + '<body><div class="x" style="width:30px;height:10px"></div></body></html>');
    const link = doc.querySelector('link');
    const img = renderPage(doc, { width: 100, height: 40, resources: { css: new Map([[link, '.x{background:#00ff00}']]) } });
    assert.deepEqual(pixel(img, 15, 12), GREEN); // the page has the default 8px body margin
  });

  test('a link to a media that does not apply is skipped', () => {
    const doc = parseHTML('<!doctype html><html><head><link rel="stylesheet" media="print" href="p.css"></head>'
      + '<body><div style="width:30px;height:10px;background:#ff0000"></div></body></html>');
    const link = doc.querySelector('link');
    const img = renderPage(doc, { width: 100, height: 40, resources: { css: new Map([[link, 'body{background:#00ff00}']]) } });
    assert.deepEqual(pixel(img, 90, 30), WHITE);
  });

  test('image bytes are sniffed: PNG, WebP and SVG decode, unknown formats return null', () => {
    const png = encodePNG({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]), channels: 4 });
    assert.deepEqual(decodeImage(png), decodePNG(png));
    // a RIFF/WEBP header with no picture chunk is not a picture
    assert.throws(() => decodeImage(Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'latin1')), /no picture/);
    const svg = decodeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="2" height="1" fill="#f00"/></svg>'));
    assert.equal(svg.width, 2);
    assert.deepEqual([...svg.data.subarray(0, 4)], [255, 0, 0, 255]);
    assert.equal(decodeImage(Buffer.from('GIF89a-not-decoded-here')), null, 'GIF is not decoded');
  });

  test('an absolutely positioned picture with a percentage size fills its positioned parent', () => {
    const doc = parseHTML('<!doctype html><html><body style="margin:0"><div style="position:relative;width:40px;height:20px">'
      + '<img src="x.png" style="position:absolute;width:100%;height:100%"></div></body></html>');
    const img = doc.querySelector('img');
    const pic = { width: 1, height: 1, channels: 4, data: Uint8Array.from([255, 0, 0, 255]) };
    const out = renderPage(doc, { width: 100, height: 60, resources: { images: new Map([[img, pic]]) } });
    assert.deepEqual(pixel(out, 1, 1), [255, 0, 0], 'the top-left of the parent is painted');
    assert.deepEqual(pixel(out, 38, 18), [255, 0, 0], 'and the bottom-right');
    assert.deepEqual(pixel(out, 60, 40), WHITE, 'outside the parent is not');
  });

  test('a JPEG that is progressive is refused with a clear error', async () => {
    const { decodeJpeg } = await import('../src/browser/jpeg.js');
    // SOI, then a progressive frame marker (SOF2) with a minimal length: the decoder stops before any pixels.
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc2, 0x00, 0x08, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01]);
    assert.throws(() => decodeJpeg(bytes), /progressive or arithmetic JPEG is not supported/);
  });
});
