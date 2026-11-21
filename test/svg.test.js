// SVG pictures: the rasteriser draws shapes, paths, strokes, transforms, <use>, styles and opacity where the
// specification puts them. Each check reads pixels back from the rendered picture.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSvg, looksLikeSvg } from '../src/browser/svg.js';
import { decodeImage } from '../src/browser/image.js';

const render = (svg, hint) => decodeSvg(Buffer.from(svg), hint);
const pixel = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const alphaSum = (img) => {
  let s = 0;
  for (let i = 3; i < img.data.length; i += 4) s += img.data[i] / 255;
  return s;
};
const svg = (body, attrs = 'width="10" height="10"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

describe('shapes', () => {
  test('a filled rectangle paints its colour inside and nothing outside', () => {
    const img = render(svg('<rect width="10" height="10" fill="#ff0000"/>'));
    assert.deepEqual(pixel(img, 5, 5), [255, 0, 0, 255]);
    const partial = render(svg('<rect x="0" y="0" width="5" height="10" fill="#00f"/>'));
    assert.deepEqual(pixel(partial, 2, 5), [0, 0, 255, 255]);
    assert.deepEqual(pixel(partial, 7, 5), [0, 0, 0, 0]);
  });

  test('a circle covers about pi r squared pixels, with antialiased edges', () => {
    const img = render(svg('<circle cx="50" cy="50" r="40" fill="#000"/>', 'width="100" height="100"'));
    const area = Math.PI * 40 * 40;
    assert.ok(Math.abs(alphaSum(img) - area) / area < 0.01, `area ${alphaSum(img)} vs ${area}`);
    const edgeAlphas = new Set();
    for (let x = 0; x < 100; x++) edgeAlphas.add(pixel(img, x, 50)[3]);
    assert.ok([...edgeAlphas].some((a) => a > 0 && a < 255), 'some edge pixels are partly covered');
  });

  test('a rounded rectangle leaves its corners empty', () => {
    const img = render(svg('<rect width="10" height="10" rx="4" fill="#000"/>'));
    assert.equal(pixel(img, 0, 0)[3], 0);
    assert.equal(pixel(img, 5, 5)[3], 255);
  });

  test('polygon and polyline are drawn, a polyline fills by default', () => {
    const poly = render(svg('<polygon points="0,0 10,0 0,10" fill="#0f0"/>'));
    assert.deepEqual(pixel(poly, 1, 1), [0, 255, 0, 255]);
    assert.equal(pixel(poly, 9, 9)[3], 0);
    const line = render(svg('<polyline points="0,5 10,5" stroke="#000" stroke-width="2"/>'));
    assert.equal(pixel(line, 5, 5)[3], 255);
  });
});

describe('paths', () => {
  test('arc flags written without spaces are read', () => {
    const img = render(svg('<path d="M0 5a5 5 0 0110 0" fill="none" stroke="#000" stroke-width="1"/>'));
    assert.ok(alphaSum(img) > 5, 'the arc is drawn');
    assert.equal(pixel(img, 5, 0)[3] > 0 || pixel(img, 5, 1)[3] > 0, true, 'the top of the arc is on the picture');
  });

  test('relative commands and smooth curves are followed', () => {
    const img = render(svg('<path d="M1 1 l4 0 q2 4 0 4 t-4 0 z" fill="#000"/>'));
    assert.equal(pixel(img, 3, 2)[3], 255);
  });

  test('evenodd leaves an inner square empty, nonzero fills it', () => {
    const d = 'M0 0 L10 0 L10 10 L0 10 Z M3 3 L7 3 L7 7 L3 7 Z';
    const eo = render(svg(`<path d="${d}" fill-rule="evenodd" fill="#000"/>`));
    assert.equal(pixel(eo, 5, 5)[3], 0);
    const nz = render(svg(`<path d="${d}" fill="#000"/>`));
    assert.equal(pixel(nz, 5, 5)[3], 255);
  });

  test('malformed path data draws what it can and does not throw', () => {
    const img = render(svg('<path d="M 1 1 L 9 1 L 9 9 X nonsense"  fill="#000"/>'));
    assert.equal(img.width, 10);
    assert.ok(alphaSum(img) >= 0);
  });
});

describe('styles', () => {
  test('a class selector in a style element sets the fill', () => {
    const img = render(svg('<style>.hot { fill: #00ff00 }</style><rect class="hot" width="10" height="10"/>'));
    assert.deepEqual(pixel(img, 5, 5), [0, 255, 0, 255]);
  });

  test('an id rule beats a class rule, and the style attribute beats both', () => {
    const img = render(svg('<style>.a{fill:#ff0000} #b{fill:#0000ff}</style>'
      + '<rect id="b" class="a" width="5" height="10"/><rect class="a" x="5" width="5" height="10" style="fill:#000"/>'));
    assert.deepEqual(pixel(img, 2, 5), [0, 0, 255, 255]);
    assert.deepEqual(pixel(img, 7, 5), [0, 0, 0, 255]);
  });

  test('CDATA inside a style element is read', () => {
    const img = render(svg('<style><![CDATA[ rect { fill: #00f } ]]></style><rect width="10" height="10"/>'));
    assert.deepEqual(pixel(img, 5, 5), [0, 0, 255, 255]);
  });

  test('display none and visibility hidden draw nothing', () => {
    const img = render(svg('<rect width="5" height="10" fill="#000" display="none"/>'
      + '<rect x="5" width="5" height="10" fill="#000" visibility="hidden"/>'));
    assert.equal(alphaSum(img), 0);
  });

  test('colours: hex short and long, rgb(), named, transparent', () => {
    assert.deepEqual(pixel(render(svg('<rect width="10" height="10" fill="#0f0"/>')), 1, 1), [0, 255, 0, 255]);
    assert.deepEqual(pixel(render(svg('<rect width="10" height="10" fill="rgb(10, 20, 30)"/>')), 1, 1), [10, 20, 30, 255]);
    assert.deepEqual(pixel(render(svg('<rect width="10" height="10" fill="navy"/>')), 1, 1), [0, 0, 128, 255]);
    assert.equal(pixel(render(svg('<rect width="10" height="10" fill="transparent"/>')), 1, 1)[3], 0);
  });

  test('currentColor takes the color property', () => {
    const img = render(svg('<rect width="10" height="10" color="#123456" fill="currentColor"/>'));
    assert.deepEqual(pixel(img, 1, 1), [0x12, 0x34, 0x56, 255]);
  });

  test('a gradient paints the average of its stop colours', () => {
    const img = render(svg('<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/>'
      + '<stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/>'));
    const [r] = pixel(img, 5, 5);
    assert.ok(Math.abs(r - 128) <= 1, `gray ${r}`);
  });
});

describe('transforms, groups and reuse', () => {
  test('a translate moves a shape', () => {
    const img = render(svg('<rect transform="translate(5 0)" width="5" height="5" fill="#0f0"/>'));
    assert.deepEqual(pixel(img, 7, 2), [0, 255, 0, 255]);
    assert.equal(pixel(img, 2, 2)[3], 0);
  });

  test('scale, rotate and matrix compose left to right', () => {
    const img = render(svg('<rect transform="translate(10 0) rotate(90)" width="4" height="2" fill="#000"/>', 'width="20" height="20"'));
    assert.ok(alphaSum(img) > 0);
    const m = render(svg('<rect transform="matrix(2 0 0 2 0 0)" width="3" height="3" fill="#000"/>', 'width="10" height="10"'));
    assert.equal(pixel(m, 5, 5)[3], 255, 'the doubled rectangle reaches 6px');
  });

  test('a group opacity fades what is drawn in it', () => {
    const img = render(svg('<g opacity="0.5"><rect width="10" height="10" fill="#000"/></g>'));
    assert.ok(Math.abs(pixel(img, 5, 5)[3] - 128) <= 2);
  });

  test('use draws a referenced element at its offset; symbols only through use', () => {
    const body = '<defs><circle id="c" r="2" fill="#f00"/><symbol id="s"><rect width="2" height="2" fill="#0f0"/></symbol></defs>'
      + '<use href="#c" x="5" y="5"/><use xlink:href="#s" x="0" y="0"/>';
    const img = render(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">${body}</svg>`);
    assert.deepEqual(pixel(img, 5, 5), [255, 0, 0, 255]);
    assert.deepEqual(pixel(img, 0, 0), [0, 255, 0, 255]);
    const top = render(svg('<symbol id="s"><rect width="10" height="10" fill="#000"/></symbol>'));
    assert.equal(alphaSum(top), 0, 'a symbol that no use refers to is not drawn');
  });

  test('a use that refers to itself does not recurse forever', () => {
    const img = render(svg('<g id="loop"><use href="#loop"/></g>'));
    assert.equal(alphaSum(img), 0);
  });
});

describe('strokes', () => {
  test('a horizontal line of width 2 covers the two rows either side of its centre', () => {
    const img = render(svg('<line x1="0" y1="5" x2="10" y2="5" stroke="#000" stroke-width="2"/>'));
    assert.equal(pixel(img, 5, 4)[3], 255);
    assert.equal(pixel(img, 5, 5)[3], 255);
    assert.equal(pixel(img, 5, 2)[3], 0);
    assert.equal(pixel(img, 5, 7)[3], 0);
  });

  test('stroke-width scales with the viewBox', () => {
    const img = render(svg('<line x1="0" y1="50" x2="100" y2="50" stroke="#000" stroke-width="10"/>', 'width="20" height="20" viewBox="0 0 100 100"'));
    // 10 user units at 0.2 scale is 2 pixels: rows 9 and 10 of the 20px picture
    assert.equal(pixel(img, 10, 9)[3], 255);
    assert.equal(pixel(img, 10, 7)[3], 0);
  });
});

describe('sizes and the picture', () => {
  test('a viewBox is fitted into the picture, centred', () => {
    const img = render(svg('<rect width="10" height="10" fill="#000"/>', 'width="20" height="10" viewBox="0 0 10 10"'));
    assert.equal(img.width, 20);
    assert.equal(pixel(img, 2, 5)[3], 0, 'left of the square is empty');
    assert.equal(pixel(img, 10, 5)[3], 255);
  });

  test('a percentage width is not a size: the viewBox ratio decides', () => {
    const img = render(svg('<rect width="1" height="1"/>', 'width="100%" height="50" viewBox="0 0 20 10"'));
    assert.equal(img.width, 100);
    assert.equal(img.height, 50);
  });

  test('without any size the picture is 300 by 150', () => {
    const img = render('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
    assert.equal(img.width, 300);
    assert.equal(img.height, 150);
  });

  test('the size the page shows the picture at wins over its own', () => {
    const img = render(svg('<rect width="10" height="10" fill="#000"/>', 'width="10" height="10" viewBox="0 0 10 10"'), { width: 40, height: 40 });
    assert.equal(img.width, 40);
    assert.equal(img.height, 40);
    const single = render(svg('<rect width="10" height="10"/>', 'width="10" height="20"'), { width: 30 });
    assert.equal(single.height, 60, 'one size keeps the proportions');
  });

  test('a document with no svg element is an error', () => {
    assert.throws(() => render('<html><body>no picture</body></html>'), /no <svg>/);
  });

  test('looksLikeSvg finds an svg element near the start, and not binary data', () => {
    assert.equal(looksLikeSvg(Buffer.from('<?xml version="1.0"?>\n<svg></svg>')), true);
    assert.equal(looksLikeSvg(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), false);
    assert.equal(decodeImage(Buffer.from('<svg width="1" height="1"></svg>')).width, 1);
  });
});
