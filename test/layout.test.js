// Flexbox and grid in the in-can renderer (src/browser/render.js). Each case draws coloured boxes and checks the
// pixels where they land, so the test checks the layout rules and not the glyphs.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from '../src/browser/html.js';
import { renderPage } from '../src/browser/render.js';

const WHITE = [255, 255, 255];
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];

/** A page with no body margin, the given CSS, and the body markup. */
const page = (css, body) => `<!doctype html><html><head><style>body{margin:0}${css}</style></head><body>${body}</body></html>`;
const box = (style) => `<div style="${style}"></div>`;

function shot(html) {
  return renderPage(parseHTML(html), { width: 400, height: 200 });
}

function pixel(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [...img.data.subarray(i, i + 3)];
}

describe('flexbox', () => {
  test('a row lays its items out left to right at their widths', () => {
    const img = shot(page('', `<div style="display:flex">${box('width:100px;height:20px;background:#f00')}`
      + `${box('width:50px;height:20px;background:#0f0')}</div>`));
    assert.deepEqual(pixel(img, 50, 10), RED);
    assert.deepEqual(pixel(img, 120, 10), GREEN);
    assert.deepEqual(pixel(img, 160, 10), WHITE);
  });

  test('justify-content: center puts the free space on both sides', () => {
    const img = shot(page('', `<div style="display:flex;justify-content:center;width:300px;height:20px">`
      + `${box('width:100px;height:20px;background:#f00')}${box('width:100px;height:20px;background:#0f0')}</div>`));
    assert.deepEqual(pixel(img, 10, 5), WHITE);
    assert.deepEqual(pixel(img, 60, 5), RED); // red runs 50..150
    assert.deepEqual(pixel(img, 200, 5), GREEN); // green runs 150..250
  });

  test('justify-content: space-between pins the first and last items to the ends', () => {
    const img = shot(page('', `<div style="display:flex;justify-content:space-between;width:300px;height:20px">`
      + `${box('width:50px;height:20px;background:#f00')}${box('width:50px;height:20px;background:#0f0')}</div>`));
    assert.deepEqual(pixel(img, 20, 5), RED);
    assert.deepEqual(pixel(img, 270, 5), GREEN);
    assert.deepEqual(pixel(img, 120, 5), WHITE);
  });

  test('flex-grow shares the free space in the ratio of the grow values', () => {
    const img = shot(page('', `<div style="display:flex;width:300px;height:20px">`
      + `${box('flex:1;height:20px;background:#f00')}${box('flex:2;height:20px;background:#0f0')}</div>`));
    assert.deepEqual(pixel(img, 50, 5), RED); // 0..100
    assert.deepEqual(pixel(img, 200, 5), GREEN); // 100..300
  });

  test('gap leaves space between items, not around them', () => {
    const img = shot(page('', `<div style="display:flex;gap:20px">`
      + `${box('width:50px;height:20px;background:#f00')}${box('width:50px;height:20px;background:#0f0')}</div>`));
    assert.deepEqual(pixel(img, 25, 5), RED);
    assert.deepEqual(pixel(img, 60, 5), WHITE); // the gap, 50..70
    assert.deepEqual(pixel(img, 90, 5), GREEN); // 70..120
  });

  test('align-items: center centres items in a container with a set height', () => {
    const img = shot(page('', `<div style="display:flex;align-items:center;height:100px">`
      + box('width:50px;height:20px;background:#f00') + '</div>'));
    assert.deepEqual(pixel(img, 25, 50), RED); // 40..60
    assert.deepEqual(pixel(img, 25, 30), WHITE);
    assert.deepEqual(pixel(img, 25, 70), WHITE);
  });

  test('align-items: stretch makes an item as tall as the line', () => {
    const img = shot(page('', `<div style="display:flex">`
      + `${box('width:50px;height:60px;background:#00f')}${box('width:50px;background:#f00')}</div>`));
    assert.deepEqual(pixel(img, 75, 55), RED, 'the red item has no height, so it stretches to 60px');
    assert.deepEqual(pixel(img, 75, 70), WHITE);
  });

  test('flex-direction: column stacks the items', () => {
    const img = shot(page('', `<div style="display:flex;flex-direction:column;width:200px">`
      + `${box('height:20px;background:#f00')}${box('height:30px;background:#0f0')}</div>`));
    assert.deepEqual(pixel(img, 5, 10), RED);
    assert.deepEqual(pixel(img, 5, 30), GREEN); // 20..50
    assert.deepEqual(pixel(img, 5, 60), WHITE);
  });

  test('flex-wrap: wrap starts a new line when the items do not fit', () => {
    const img = shot(page('', `<div style="display:flex;flex-wrap:wrap;width:100px">`
      + `${box('width:60px;height:20px;background:#f00')}${box('width:60px;height:20px;background:#0f0')}</div>`));
    assert.deepEqual(pixel(img, 5, 5), RED);
    assert.deepEqual(pixel(img, 5, 25), GREEN);
  });

  test('a flex item without a width is as wide as its content, so its neighbours sit after it', () => {
    const img = shot(page('', `<div style="display:flex">`
      + `<div style="display:flex"><div style="width:30px;height:10px;background:#f00"></div>`
      + `<div style="width:30px;height:10px;background:#0f0"></div></div>`
      + `${box('width:10px;height:10px;background:#00f')}</div>`));
    assert.deepEqual(pixel(img, 45, 5), GREEN);
    assert.deepEqual(pixel(img, 65, 5), BLUE, 'the blue item starts after the inner row (60px wide)');
  });

  test('text in a flex container is an anonymous item after the boxes before it', () => {
    const img = shot(page('', `<div style="display:flex">${box('width:20px;height:10px;background:#f00')}`
      + 'label</div>'));
    assert.deepEqual(pixel(img, 10, 5), RED);
    let ink = 0;
    for (let x = 22; x < 120; x++) for (let y = 0; y < 14; y++) if (pixel(img, x, y).join() !== '255,255,255') ink++;
    assert.ok(ink > 20, `expected the word to draw after the red box (ink pixels: ${ink})`);
  });

  test('inline-flex is a flex container too', () => {
    const img = shot(page('', `<div style="display:inline-flex">${box('width:40px;height:20px;background:#f00')}`
      + `${box('width:40px;height:20px;background:#0f0')}</div>`));
    assert.deepEqual(pixel(img, 60, 5), GREEN);
  });
});

describe('grid', () => {
  test('grid-template-columns sets the tracks, and items fill them row by row', () => {
    const img = shot(page('', `<div style="display:grid;grid-template-columns:100px 1fr;width:300px">`
      + `${box('height:20px;background:#f00')}${box('height:20px;background:#0f0')}`
      + `${box('height:20px;background:#00f')}</div>`));
    assert.deepEqual(pixel(img, 50, 5), RED);
    assert.deepEqual(pixel(img, 150, 5), GREEN);
    assert.deepEqual(pixel(img, 50, 25), BLUE, 'the third item starts a second row');
  });

  test('repeat() and column-gap make equal tracks with space between them', () => {
    const img = shot(page('', `<div style="display:grid;grid-template-columns:repeat(2,1fr);column-gap:20px;width:220px">`
      + `${box('height:20px;background:#f00')}${box('height:20px;background:#0f0')}</div>`));
    assert.deepEqual(pixel(img, 50, 5), RED); // 0..100
    assert.deepEqual(pixel(img, 110, 5), WHITE); // the gap, 100..120
    assert.deepEqual(pixel(img, 150, 5), GREEN); // 120..220
  });

  test('a grid row is as tall as its tallest item, and the next row starts below it', () => {
    const img = shot(page('', `<div style="display:grid;grid-template-columns:50px 50px;row-gap:10px;width:100px">`
      + `${box('height:40px;background:#f00')}${box('height:10px;background:#0f0')}`
      + `${box('height:10px;background:#00f')}</div>`));
    assert.deepEqual(pixel(img, 25, 30), RED);
    assert.deepEqual(pixel(img, 60, 5), GREEN);
    assert.deepEqual(pixel(img, 25, 55), BLUE, 'row 2 starts at 40 + the 10px row gap');
  });

  test('a grid with no template is one column', () => {
    const img = shot(page('', `<div style="display:grid;width:100px">`
      + `${box('height:10px;background:#f00')}${box('height:10px;background:#0f0')}</div>`));
    assert.deepEqual(pixel(img, 50, 5), RED);
    assert.deepEqual(pixel(img, 50, 15), GREEN);
  });
});
