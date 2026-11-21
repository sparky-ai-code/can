// WebP pictures: the lossless (VP8L) and lossy (VP8) decoders, the alpha plane (ALPH) and the RIFF container. The
// expected pixels are the ones libwebp produces (the reference codec, through Pillow), so each check is bit-exact.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeWebP } from '../src/browser/webp.js';
import { decodeImage } from '../src/browser/image.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/webp/${name}`, import.meta.url)));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// name -> size and the SHA-256 of the RGBA pixels libwebp decodes
const EXPECTED = {
  'lossless.webp': { w: 67, h: 45, sha: '55ac8d385273c88c2e3bdbb494a74154df4eeb5ce3703a518e34872ebb63605c' },
  'lossless_alpha.webp': { w: 40, h: 30, sha: 'f8af62d1d0447f091af1cae15f4487153a36be6aeb24b3253ccc8bf57b993484' },
  'lossy.webp': { w: 96, h: 64, sha: 'b5880a756102da46b16e18f17d6dc81c0207c49ebfd07ab64de10292bd9eb86d' },
  'lossy_alpha.webp': { w: 80, h: 50, sha: 'f980b1b20e65ae7bb9dd27533cb8c343e1fe8b5cbab084758c0bff51b88f9b25' },
  'lossy_odd.webp': { w: 37, h: 23, sha: 'edda82360f386912b5d6826cb85dd19a432dc39018c7cf2a6716e38a0444ad93' },
  'palette_lossless.webp': { w: 240, h: 160, sha: '21e2c5ee795cb71ce51025d25018a86d640e76e8467462057658bb9c9c47456c' },
  'photo_lossy_q10.webp': { w: 240, h: 160, sha: '66b2fcd7d35ba0400bb62871b5372ba1efa257832fccf734e840c259aa16c8bd' },
  'photo_lossy_q100.webp': { w: 240, h: 160, sha: 'f451fc163d65b1b78c7ea1565ba3b398855368ac24bb2fa22af8711e8a21d110' },
  'photo_lossless.webp': { w: 240, h: 160, sha: '227fd4f75abd9bdca985ec28b5fbb7c55fb7938e8cf353088f1cb1dced0ed333' },
  'photo_alpha_lossy.webp': { w: 240, h: 160, sha: '1f646a209b610d27a29268b20322284519768f6217381fea9c205f939882fb74' },
};

describe('WebP pictures decode bit-exactly', () => {
  for (const [name, want] of Object.entries(EXPECTED)) {
    test(name, () => {
      const img = decodeWebP(fixture(name));
      assert.equal(img.width, want.w);
      assert.equal(img.height, want.h);
      assert.equal(img.channels, 4);
      assert.equal(img.data.length, want.w * want.h * 4);
      assert.equal(sha(img.data), want.sha);
    });
  }

  test('decodeImage sniffs WebP by its RIFF header', () => {
    const img = decodeImage(fixture('lossy.webp'));
    assert.equal(sha(img.data), EXPECTED['lossy.webp'].sha);
  });
});

// ---- the alpha plane

/** Inserts an ALPH chunk before the VP8 chunk of a simple (non-extended) lossy WebP file. */
function withAlpha(file, alph) {
  const chunk = Buffer.alloc(8 + alph.length + (alph.length & 1));
  chunk.write('ALPH', 0, 'latin1');
  chunk.writeUInt32LE(alph.length, 4);
  chunk.set(alph, 8);
  const head = Buffer.from(file.subarray(0, 12));
  const rest = Buffer.from(file.subarray(12));
  const out = Buffer.concat([head, chunk, rest]);
  out.writeUInt32LE(out.length - 8, 4);
  return new Uint8Array(out);
}

/** The forward prediction of each alpha filter, so a test can make the bytes an alpha plane decodes from. */
function forwardFilter(alpha, w, h, filter) {
  const raw = new Uint8Array(alpha.length);
  if (filter === 0) return raw.map((_, i) => alpha[i]); // no filter: the values are stored as they are
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let pred = 0;
      if (y === 0 && x === 0) pred = 0;
      else if (y === 0) pred = alpha[i - 1];
      else if (x === 0) pred = alpha[i - w];
      else if (filter === 1) pred = alpha[i - 1];
      else if (filter === 2) pred = alpha[i - w];
      else pred = Math.min(255, Math.max(0, alpha[i - 1] + alpha[i - w] - alpha[i - w - 1]));
      raw[i] = (alpha[i] - pred) & 0xff;
    }
  }
  return raw;
}

describe('the alpha plane (ALPH)', () => {
  const base = fixture('lossy.webp');
  const { w, h } = EXPECTED['lossy.webp'];
  // a ramp with some texture, so every predictor has something to get wrong
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = (x * 3 + y * 5 + ((x * y) % 7) * 9) & 0xff;

  for (const [filter, label] of [[0, 'none'], [1, 'horizontal'], [2, 'vertical'], [3, 'gradient']]) {
    test(`uncompressed alpha with the ${label} filter restores the alpha values`, () => {
      const raw = forwardFilter(alpha, w, h, filter);
      const alph = new Uint8Array(1 + raw.length);
      alph[0] = (filter << 2); // compression 0 (raw), no pre-processing
      alph.set(raw, 1);
      const img = decodeWebP(withAlpha(base, alph));
      const got = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) got[i] = img.data[i * 4 + 3];
      assert.deepEqual(got, alpha);
    });
  }

  test('the colour of the picture is the same with or without an alpha plane', () => {
    const plain = decodeWebP(base);
    const alph = new Uint8Array(1 + w * h).fill(128);
    alph[0] = 0;
    const withA = decodeWebP(withAlpha(base, alph));
    for (let i = 0; i < w * h; i++) {
      assert.deepEqual([...withA.data.subarray(i * 4, i * 4 + 3)], [...plain.data.subarray(i * 4, i * 4 + 3)]);
      assert.equal(withA.data[i * 4 + 3], 128);
    }
  });

  test('an alpha plane that is the wrong size is refused, not drawn wrong', () => {
    const alph = new Uint8Array(1 + 10); // too short for the picture
    assert.equal(decodeWebP(withAlpha(base, alph)).data[3], 255, 'the picture is drawn opaque');
  });
});

// ---- robustness

describe('damaged files fail with an error, quickly', () => {
  test('truncated and wrong-signature files throw', () => {
    const lossless = fixture('lossless.webp');
    assert.throws(() => decodeWebP(lossless.subarray(0, 30)));
    assert.throws(() => decodeWebP(new Uint8Array(0)), /no picture/);
    const bad = new Uint8Array(lossless);
    bad[20] = 0x00; // the VP8L signature byte
    assert.throws(() => decodeWebP(bad), /lossless/);
  });

  test('random byte damage either decodes or throws, and never hangs', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (const name of ['lossless.webp', 'lossy.webp', 'palette_lossless.webp']) {
      const original = fixture(name);
      for (let trial = 0; trial < 60; trial++) {
        const bytes = new Uint8Array(original);
        for (let k = 0; k < 4; k++) bytes[20 + (rnd() % (bytes.length - 20))] = rnd() & 0xff;
        const t = Date.now();
        try {
          decodeWebP(bytes);
        } catch (e) {
          assert.ok(e instanceof Error);
        }
        assert.ok(Date.now() - t < 2000, `${name} trial ${trial} took too long`);
      }
    }
  });
});
