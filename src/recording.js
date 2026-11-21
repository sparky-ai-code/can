// Recording of a can's QA session. Host side only: the can process is unchanged.
//
// While a recording runs on a can, two things are kept:
//   - a timeline of every tool call on that can: the arguments (long or private values such as typed text, file
//     content and headers are hidden) and the first line of each result, so commands and checks are on record;
//   - a video of the browser: one frame after each browser action that can change the page (goto, click, type,
//     select, submit, back, evaluate). Each frame is a real PNG from the can's browser, the built-in renderer or
//     Chromium (the default browser). Between frames the video holds the last page state.
//
// On stop the frames are encoded to H.264 MP4 when ffmpeg is installed (CAN_FFMPEG, or ffmpeg on PATH). Without
// ffmpeg they are written as an animated PNG (APNG), which browsers play, so nothing extra is needed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from './browser/png.js';
import { RENDER_LIMITS } from './browser/render.js';
import { KernelError } from './kernel/errors.js';
import { defaultTransferRoot, writeTransferFile } from './transfer.js';

export const RECORD_LIMITS = Object.freeze({
  maxFrames: 3000, // frames kept per recording; later browser actions are still logged
  minHoldMs: 1000, // every frame stays on screen at least this long, so quick actions can be seen
  maxHoldMs: 5000, // and at most this long, so a long pause does not stall the video
  fps: 15,
  encodeTimeoutMs: 300_000,
});

const RECORD_DIR = 'recordings';
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Arguments whose values stay out of the log: typed text, file content, code, headers and environment (may hold secrets).
export const REDACTED_ARGS = new Set(['content', 'text', 'body', 'code', 'headers', 'environment']);

/** The ffmpeg program to encode MP4 with, or null. CAN_FFMPEG names it; otherwise ffmpeg must be on PATH. */
export function findFfmpeg(env = process.env) {
  const cmd = env.CAN_FFMPEG || 'ffmpeg';
  const probe = spawnSync(cmd, ['-version'], { stdio: 'ignore', timeout: 10_000, windowsHide: true });
  return probe.status === 0 ? cmd : null;
}

/** The first line of a text, cut to `limit` characters. */
export function oneLine(text, limit = 200) {
  const first = String(text ?? '').split('\n')[0].trim();
  return first.length > limit ? `${first.slice(0, limit - 3)}...` : first;
}

/** A tool call's arguments as one line for the log, with redacted values shown only by their size. */
export function describeArgs(args = {}) {
  const shown = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (REDACTED_ARGS.has(key)) {
      const size = typeof value === 'string' ? value.length : JSON.stringify(value ?? null).length;
      shown[key] = `<${size} chars>`;
    } else {
      shown[key] = value;
    }
  }
  return oneLine(JSON.stringify(shown), 400);
}

/** The first line of a tool result (a string, or {text, images}). */
export function summarizeResult(out) {
  const text = typeof out === 'string' ? out : (out?.text ?? '');
  return oneLine(text, 200) || '(empty)';
}

// ---------------------------------------------------------------- APNG

function pngChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new KernelError('EINVAL', 'EINVAL: a recording frame is not a PNG');
  }
  const out = [];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    out.push({ type, data: buf.subarray(pos + 8, pos + 8 + len) });
    pos += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function frameControl(seq, width, height, delayMs) {
  const b = Buffer.alloc(26);
  b.writeUInt32BE(seq, 0);
  b.writeUInt32BE(width, 4);
  b.writeUInt32BE(height, 8);
  b.writeUInt32BE(0, 12); // x offset
  b.writeUInt32BE(0, 16); // y offset
  b.writeUInt16BE(delayMs, 20); // delay numerator (ms)
  b.writeUInt16BE(1000, 22); // delay denominator
  b[24] = 0; // dispose: none
  b[25] = 0; // blend: source
  return b;
}

/**
 * Joins PNG frames into one animated PNG (APNG). Every frame must have the same IHDR (size and format). Frame i is
 * shown for frames[i].ms milliseconds. Frame data is reused as it is: the IDAT chunks of each frame become fdAT
 * chunks, which carry a sequence number.
 * @param {Array<{png: Buffer, ms: number}>} frames
 * @returns {Buffer}
 */
export function encodeApng(frames) {
  if (!Array.isArray(frames) || frames.length === 0) throw new KernelError('EINVAL', 'EINVAL: no frames to encode');
  const parsed = frames.map((f) => pngChunks(f.png));
  const ihdr = parsed[0].find((c) => c.type === 'IHDR')?.data;
  if (!ihdr || ihdr.length !== 13) throw new KernelError('EINVAL', 'EINVAL: the first frame has no IHDR');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  parsed.forEach((chunks, i) => {
    const same = chunks.find((c) => c.type === 'IHDR')?.data.equals(ihdr);
    if (!same) throw new KernelError('EINVAL', `EINVAL: frame ${i + 1} differs in size or format from frame 1`);
  });

  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0); // number of frames
  actl.writeUInt32BE(0, 4); // plays: forever

  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('acTL', actl)];
  let seq = 0;
  parsed.forEach((chunks, i) => {
    const delayMs = Math.min(0xffff, Math.max(1, Math.round(frames[i].ms)));
    parts.push(chunk('fcTL', frameControl(seq++, width, height, delayMs)));
    const idats = chunks.filter((c) => c.type === 'IDAT');
    if (i === 0) {
      // The first frame is also the default image, so its data stays in IDAT.
      for (const c of idats) parts.push(chunk('IDAT', c.data));
    } else {
      for (const c of idats) {
        const data = Buffer.alloc(4 + c.data.length);
        data.writeUInt32BE(seq++, 0);
        c.data.copy(data, 4);
        parts.push(chunk('fdAT', data));
      }
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- MP4 through ffmpeg

function runTool(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

/**
 * Encodes frames (each {file, seconds}) to an H.264 MP4 with ffmpeg. The concat demuxer takes one duration per
 * frame, so the video keeps the timing of the recording.
 */
export async function encodeMp4({ ffmpeg, frames, outFile, workDir }) {
  const quote = (p) => `'${path.resolve(p).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
  const list = [];
  for (const f of frames) list.push(`file ${quote(f.file)}`, `duration ${f.seconds.toFixed(3)}`);
  // The concat demuxer shows the last file only for its duration when it is listed once more without one.
  list.push(`file ${quote(frames[frames.length - 1].file)}`);
  const listFile = path.join(workDir, 'frames.txt');
  fs.writeFileSync(listFile, `${list.join('\n')}\n`);
  await runTool(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `fps=${RECORD_LIMITS.fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart',
    outFile,
  ], RECORD_LIMITS.encodeTimeoutMs);
}

// ---------------------------------------------------------------- the recorder

function clock(ms) {
  return `${(ms / 1000).toFixed(2)}s`.padStart(8);
}

function renderLog(s, r) {
  const lines = [
    `Recording "${r.name}" on can "${s.canName}"`,
    `Viewport: ${s.width}x${s.height}`,
    `Length: ${(r.durationMs / 1000).toFixed(1)} s`,
    `Browser frames: ${r.frames}${r.dropped ? ` (${r.dropped} more were not kept; the limit is ${RECORD_LIMITS.maxFrames})` : ''}`,
    `Video: ${r.videoRel ?? 'none (no browser frames were taken)'}${r.encoder ? ` (${r.encoder})` : ''}`,
  ];
  if (r.note) lines.push(`Note: ${r.note}`);
  lines.push(
    '',
    'Each video frame is a page state taken after a browser action. Each one stays on screen for 1 to 5 seconds, so',
    'the video plays at a different speed from the real time shown here.',
    '',
    'Timeline (seconds since the recording started, duration of each call in brackets):',
  );
  const events = [...s.events].sort((a, b) => a.at - b.at);
  for (const e of events) lines.push(`${clock(e.at)}  [${e.ms} ms]  ${e.text}`);
  if (events.length === 0) lines.push('(no calls)');
  return `${lines.join('\n')}\n`;
}

export class Recorder {
  /**
   * @param {object} [opts]
   * @param {string} [opts.transferRoot] where recordings are written: <root>/recordings (default: the transfer root)
   * @param {string|null} [opts.ffmpeg] the ffmpeg program; null turns MP4 off (APNG only). Default: found on first use.
   * @param {string} [opts.tmpRoot] where frames wait during a recording (default: the OS temp folder)
   * @param {() => number} [opts.now] clock in ms (injected by tests)
   */
  constructor({ transferRoot = defaultTransferRoot(), ffmpeg = undefined, tmpRoot = os.tmpdir(), now = () => Date.now() } = {}) {
    this.transferRoot = transferRoot;
    this._ffmpeg = ffmpeg;
    this.tmpRoot = tmpRoot;
    this.now = now;
    this.sessions = new Map(); // can id -> session
  }

  get ffmpeg() {
    if (this._ffmpeg === undefined) this._ffmpeg = findFfmpeg();
    return this._ffmpeg;
  }

  /** The recording on a can, by name or id. Null when nothing is recording on it. */
  sessionFor(ref) {
    if (typeof ref !== 'string') return null;
    for (const s of this.sessions.values()) {
      if (s.canId === ref || s.canName === ref) return s;
    }
    return null;
  }

  /** Starts a recording on a live can. One recording per can at a time. */
  start(can, { name, width = RENDER_LIMITS.defaultWidth, height = RENDER_LIMITS.defaultHeight } = {}) {
    if (this.sessions.has(can.id)) {
      throw new KernelError('EEXIST', `EEXIST: a recording is already running on can "${can.name}"; stop it first with can_record_stop`);
    }
    const label = name ?? `${can.name}-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`;
    if (!NAME_PATTERN.test(label)) {
      throw new KernelError('EINVAL', `EINVAL: recording name ${JSON.stringify(label)} must be 1-64 letters, digits, "_", "-" or "." (starting with a letter or digit)`);
    }
    checkSize('width', width, RENDER_LIMITS.maxWidth);
    checkSize('height', height, RENDER_LIMITS.maxHeight);
    if (width * height > RENDER_LIMITS.maxPixels) {
      throw new KernelError('EINVAL', `EINVAL: a ${width}x${height} recording is larger than ${RENDER_LIMITS.maxPixels} pixels`);
    }
    const dir = fs.mkdtempSync(path.join(this.tmpRoot, 'can-recording-'));
    this.sessions.set(can.id, {
      name: label,
      canId: can.id,
      canName: can.name,
      width,
      height,
      dir,
      startedAt: this.now(),
      frames: [], // {file, at}
      events: [], // {at, ms, text}
      dropped: 0,
      chain: Promise.resolve(), // frames are taken one at a time, in order
    });
    return { name: label, canName: can.name, width, height };
  }

  /** Milliseconds since the recording on a can started, or null when nothing is recording on it. */
  elapsed(canId) {
    const s = this.sessions.get(canId);
    return s ? this.now() - s.startedAt : null;
  }

  /** Adds one timeline line for a call that began `startMs` after the recording started. */
  event(canId, startMs, text) {
    const s = this.sessions.get(canId);
    if (!s || startMs === null) return;
    s.events.push({ at: startMs, ms: Math.max(0, this.now() - s.startedAt - startMs), text });
  }

  /**
   * Films one frame of the can's browser. `grab({width, height})` returns the PNG. Resolves true when the frame was
   * kept. Does nothing when no recording runs on the can. A failed grab is noted in the timeline, not thrown.
   */
  frame(canId, grab) {
    const s = this.sessions.get(canId);
    if (!s) return Promise.resolve(false);
    const job = s.chain.then(() => this._grab(s, grab));
    s.chain = job.catch(() => {});
    return job;
  }

  async _grab(s, grab) {
    if (s.frames.length >= RECORD_LIMITS.maxFrames) {
      s.dropped++;
      return false;
    }
    const at = this.now() - s.startedAt;
    let png;
    try {
      png = await grab({ width: s.width, height: s.height });
    } catch (err) {
      s.events.push({ at, ms: 0, text: `(frame not captured: ${oneLine(err.message, 200)})` });
      return false;
    }
    const n = s.frames.length + 1;
    const file = path.join(s.dir, `frame-${String(n).padStart(6, '0')}.png`);
    fs.writeFileSync(file, png);
    s.frames.push({ file, at });
    s.events.push({ at, ms: 0, text: `(frame ${n} filmed)` });
    return true;
  }

  /**
   * Stops the recording on a can and writes <root>/recordings/<name>.mp4 (or .apng) and <name>.log.txt.
   * Resolves with the host paths and counts. A failed encode is noted in `note`; the timeline is still written.
   */
  async stop(canId) {
    const s = this.sessions.get(canId);
    if (!s) throw new KernelError('ENOENT', 'ENOENT: no recording is running on this can');
    this.sessions.delete(canId); // no new frames or calls from here on
    try {
      await s.chain;
      return await this._finish(s);
    } finally {
      try {
        fs.rmSync(s.dir, { recursive: true, force: true });
      } catch {
        // a temp folder that Windows still holds is left behind
      }
    }
  }

  /** Stops every recording (server shutdown). Returns the results and any failures. */
  async stopAll() {
    const results = [];
    const failures = [];
    for (const s of [...this.sessions.values()]) {
      try {
        results.push(await this.stop(s.canId));
      } catch (err) {
        failures.push({ name: s.name, message: err.message });
      }
    }
    return { results, failures };
  }

  async _finish(s) {
    const endAt = this.now() - s.startedAt;
    const name = this._freeName(s.name);
    const result = {
      name,
      canName: s.canName,
      frames: s.frames.length,
      dropped: s.dropped,
      durationMs: endAt,
      video: null,
      videoRel: null,
      encoder: null,
      note: '',
      log: null,
    };
    if (s.frames.length > 0) {
      // Each frame stays until the next one (clamped to the hold limits). The last one stays until the stop.
      const timed = s.frames.map((f, i) => {
        const next = i + 1 < s.frames.length ? s.frames[i + 1].at : endAt;
        const ms = Math.min(RECORD_LIMITS.maxHoldMs, Math.max(RECORD_LIMITS.minHoldMs, next - f.at));
        return { file: f.file, ms };
      });
      const ffmpeg = this.ffmpeg;
      if (ffmpeg) {
        try {
          const tmp = path.join(s.dir, 'video.mp4');
          await encodeMp4({
            ffmpeg,
            frames: timed.map((f) => ({ file: f.file, seconds: f.ms / 1000 })),
            outFile: tmp,
            workDir: s.dir,
          });
          result.video = writeTransferFile(fs.readFileSync(tmp), `${RECORD_DIR}/${name}.mp4`, { root: this.transferRoot });
          result.videoRel = `${RECORD_DIR}/${name}.mp4`;
          result.encoder = 'H.264 MP4 through ffmpeg';
        } catch (err) {
          result.note = `ffmpeg could not encode the video (${oneLine(err.message, 200)}); the frames were written as APNG instead.`;
        }
      }
      if (!result.video) {
        try {
          const apng = encodeApng(timed.map((f) => ({ png: fs.readFileSync(f.file), ms: f.ms })));
          result.video = writeTransferFile(apng, `${RECORD_DIR}/${name}.apng`, { root: this.transferRoot });
          result.videoRel = `${RECORD_DIR}/${name}.apng`;
          result.encoder = 'animated PNG (APNG); ffmpeg is not installed, or could not encode';
        } catch (err) {
          result.note = result.note || `the video could not be written (${oneLine(err.message, 200)})`;
        }
      }
    }
    result.log = writeTransferFile(
      Buffer.from(renderLog(s, result), 'utf8'),
      `${RECORD_DIR}/${name}.log.txt`,
      { root: this.transferRoot },
    );
    return result;
  }

  /** The name, or the name with -2, -3 and so on when a recording of that name already exists. */
  _freeName(name) {
    const dir = path.join(this.transferRoot, RECORD_DIR);
    const taken = (n) => ['.mp4', '.apng', '.log.txt'].some((ext) => fs.existsSync(path.join(dir, `${n}${ext}`)));
    let candidate = name;
    for (let n = 2; taken(candidate); n++) candidate = `${name}-${n}`;
    return candidate;
  }
}

function checkSize(what, value, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new KernelError('EINVAL', `EINVAL: ${what} must be a whole number from 1 to ${max} (got ${value})`);
  }
}
