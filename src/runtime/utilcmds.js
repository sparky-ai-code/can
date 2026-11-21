// Small coreutils: seq, basename, dirname, tr, cut, date, diff (normal format), tee, xargs.
import { posix } from 'node:path';
import { readAll } from './io.js';
import { invoke } from './shell.js';
import { inputsOf } from './textcmds.js';

const errOut = (io, msg) => io.stderr.write(`${msg}\n`);
const resolveIn = (sh, p) => sh.can.vfs.resolve(p, sh.cwd);

function linesOf(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const decimals = (s) => {
  const m = /\.(\d+)$/.exec(s);
  return m ? m[1].length : 0;
};

function* seqB(args, io) {
  let sep = '\n';
  let width = false;
  const nums = [];
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '-s') { sep = args[++k] ?? ''; continue; }
    if (args[k] === '-w') { width = true; continue; }
    nums.push(args[k]);
  }
  const vals = nums.map(Number);
  if (nums.length === 0 || nums.length > 3 || vals.some((v) => Number.isNaN(v))) {
    errOut(io, 'seq: invalid arguments');
    return 1;
  }
  let first = 1;
  let incr = 1;
  let last;
  if (vals.length === 1) [last] = vals;
  else if (vals.length === 2) [first, last] = vals;
  else [first, incr, last] = vals;
  if (incr === 0) { errOut(io, 'seq: zero increment'); return 1; }
  const places = Math.max(...nums.map(decimals));
  const out = [];
  for (let x = first; incr > 0 ? x <= last + 1e-9 : x >= last - 1e-9; x += incr) out.push(x.toFixed(places));
  if (width) {
    const w = Math.max(0, ...out.map((s) => s.length));
    for (let k = 0; k < out.length; k++) out[k] = out[k].padStart(w, '0');
  }
  io.stdout.write(out.length ? `${out.join(sep)}\n` : '');
  return 0;
}

function* basenameB(args, io) {
  let suffix = null;
  let rest = args;
  if (rest[0] === '-s') { suffix = rest[1] ?? null; rest = rest.slice(2); } else if (rest.length >= 2) {
    suffix = rest[1];
    rest = rest.slice(0, 1);
  }
  if (rest.length === 0) { errOut(io, 'basename: missing operand'); return 1; }
  let base = posix.basename(rest[0].replace(/\/+$/, '') || '/');
  if (suffix && base.endsWith(suffix) && base !== suffix) base = base.slice(0, -suffix.length);
  io.stdout.write(`${base}\n`);
  return 0;
}

function* dirnameB(args, io) {
  if (args.length === 0) { errOut(io, 'dirname: missing operand'); return 1; }
  for (const a of args) io.stdout.write(`${posix.dirname(a.replace(/\/+$/, '') || '/')}\n`);
  return 0;
}

const CLASSES = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digit: '0123456789',
  space: ' \t\n\r\f\v',
};
CLASSES.alpha = CLASSES.upper + CLASSES.lower;
CLASSES.alnum = CLASSES.alpha + CLASSES.digit;

/** Expands a tr set: escapes, [:class:] and a-z ranges. */
function expandSet(s) {
  const raw = s.replace(/\\(n|t|r|\\)/g, (m, c) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\' })[c]);
  const out = [];
  for (let k = 0; k < raw.length; k++) {
    const cls = /^\[:([a-z]+):\]/.exec(raw.slice(k));
    if (cls && CLASSES[cls[1]]) {
      out.push(...CLASSES[cls[1]]);
      k += cls[0].length - 1;
    } else if (raw[k + 1] === '-' && k + 2 < raw.length) {
      for (let c = raw.charCodeAt(k); c <= raw.charCodeAt(k + 2); c++) out.push(String.fromCharCode(c));
      k += 2;
    } else {
      out.push(raw[k]);
    }
  }
  return out;
}

function* trB(args, io) {
  let del = false;
  let squeeze = false;
  const sets = [];
  for (const a of args) {
    if (/^-[ds]+$/.test(a)) {
      if (a.includes('d')) del = true;
      if (a.includes('s')) squeeze = true;
    } else sets.push(a);
  }
  if (sets.length === 0 || (!del && !squeeze && sets.length < 2)) {
    errOut(io, 'tr: missing operand');
    return 1;
  }
  const s1 = expandSet(sets[0]);
  const s2 = sets[1] !== undefined && !del ? expandSet(sets[1]) : null;
  const text = (yield readAll(io.stdin)).toString('utf8');
  let out = '';
  if (del) {
    const drop = new Set(s1);
    for (const ch of text) if (!drop.has(ch)) out += ch;
  } else {
    const map = s2 ? new Map(s1.map((c, k) => [c, s2[Math.min(k, s2.length - 1)]])) : null;
    const squeezeSet = squeeze ? new Set(s2 ?? s1) : null;
    let last = null;
    for (const ch of text) {
      const t = map && map.has(ch) ? map.get(ch) : ch;
      if (squeezeSet && squeezeSet.has(t) && t === last) continue;
      out += t;
      last = t;
    }
  }
  io.stdout.write(out);
  return 0;
}

/** "1,3,5-7,2-" -> predicate over 1-based positions. */
function rangeList(spec) {
  const ranges = spec.split(',').map((p) => {
    const m = /^(\d*)(-?)(\d*)$/.exec(p);
    if (!m || (m[1] === '' && m[2] === '' )) throw new Error(`invalid range '${p}'`);
    if (m[2] === '') return [Number(m[1]), Number(m[1])];
    return [m[1] === '' ? 1 : Number(m[1]), m[3] === '' ? Infinity : Number(m[3])];
  });
  return (idx) => ranges.some(([a, b]) => idx >= a && idx <= b);
}

function* cutB(args, io, sh) {
  let delim = '\t';
  let fields = null;
  let chars = null;
  let onlySeparated = false;
  const files = [];
  try {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '-d') delim = args[++k] ?? '\t';
      else if (a.startsWith('-d')) delim = a.slice(2);
      else if (a === '-f') fields = rangeList(args[++k] ?? '');
      else if (a.startsWith('-f')) fields = rangeList(a.slice(2));
      else if (a === '-c') chars = rangeList(args[++k] ?? '');
      else if (a.startsWith('-c')) chars = rangeList(a.slice(2));
      else if (a === '-s') onlySeparated = true;
      else files.push(a);
    }
  } catch (e) {
    errOut(io, `cut: ${e.message}`);
    return 1;
  }
  if (!fields && !chars) { errOut(io, 'cut: you must specify a list of bytes, characters, or fields'); return 1; }
  const sources = yield* inputsOf(files, io, sh);
  for (const { buf } of sources) {
    for (const line of linesOf(buf.toString('utf8'))) {
      if (chars) {
        io.stdout.write(`${[...line].filter((_, idx) => chars(idx + 1)).join('')}\n`);
      } else if (!line.includes(delim)) {
        if (!onlySeparated) io.stdout.write(`${line}\n`);
      } else {
        io.stdout.write(`${line.split(delim).filter((_, idx) => fields(idx + 1)).join(delim)}\n`);
      }
    }
  }
  return 0;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

/** date(1) formats, always in UTC (a can has no time zone of its own). */
export function formatDate(d, fmt) {
  const p2 = (n) => String(n).padStart(2, '0');
  const Y = d.getUTCFullYear();
  const M = p2(d.getUTCMonth() + 1);
  const D = p2(d.getUTCDate());
  const h = p2(d.getUTCHours());
  const mi = p2(d.getUTCMinutes());
  const s = p2(d.getUTCSeconds());
  return fmt.replace(/%(.)/g, (m, c) => {
    switch (c) {
      case 'Y': return String(Y);
      case 'y': return p2(Y % 100);
      case 'm': return M;
      case 'd': return D;
      case 'e': return String(d.getUTCDate()).padStart(2, ' ');
      case 'H': return h;
      case 'I': return p2(((d.getUTCHours() + 11) % 12) + 1);
      case 'M': return mi;
      case 'S': return s;
      case 'p': return d.getUTCHours() < 12 ? 'AM' : 'PM';
      case 'a': return DAYS[d.getUTCDay()].slice(0, 3);
      case 'A': return DAYS[d.getUTCDay()];
      case 'b': case 'h': return MONTHS[d.getUTCMonth()].slice(0, 3);
      case 'B': return MONTHS[d.getUTCMonth()];
      case 'u': return String(d.getUTCDay() || 7);
      case 'w': return String(d.getUTCDay());
      case 's': return String(Math.floor(d.getTime() / 1000));
      case 'F': return `${Y}-${M}-${D}`;
      case 'T': return `${h}:${mi}:${s}`;
      case 'R': return `${h}:${mi}`;
      case 'D': return `${M}/${D}/${p2(Y % 100)}`;
      case 'Z': return 'UTC';
      case 'z': return '+0000';
      case 'n': return '\n';
      case 't': return '\t';
      case '%': return '%';
      default: return m;
    }
  });
}

function* dateB(args, io) {
  let fmt = '%a %b %e %H:%M:%S UTC %Y';
  for (const a of args) if (a.startsWith('+')) fmt = a.slice(1);
  io.stdout.write(`${formatDate(new Date(), fmt)}\n`);
  return 0;
}

/** Edit script between two line arrays as hunks {aStart, aEnd, bStart, bEnd} (0-based, end exclusive). */
export function diffHunks(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) throw new Error('files are too large to compare');
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const hunks = [];
  let i = 0;
  let j = 0;
  let cur = null;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      cur = null;
      i++;
      j++;
      continue;
    }
    if (!cur) {
      cur = { aStart: i, aEnd: i, bStart: j, bEnd: j };
      hunks.push(cur);
    }
    if (j < m && (i >= n || L[i][j + 1] > L[i + 1][j])) {
      j++;
      cur.bEnd = j;
    } else {
      i++;
      cur.aEnd = i;
    }
  }
  return hunks;
}

function* diffB(args, io, sh) {
  if (args.some((a) => a === '-u' || a === '--unified' || a.startsWith('-U'))) {
    errOut(io, 'diff: only the normal format is supported');
    return 2;
  }
  const files = args.filter((a) => !a.startsWith('-'));
  if (files.length !== 2) { errOut(io, 'diff: usage: diff FILE1 FILE2'); return 2; }
  const texts = [];
  for (const f of files) {
    if (f === '-') texts.push((yield readAll(io.stdin)).toString('utf8'));
    else texts.push(sh.can.vfs.readFile(resolveIn(sh, f), 'utf8'));
  }
  const A = linesOf(texts[0]);
  const B = linesOf(texts[1]);
  let hunks;
  try {
    hunks = diffHunks(A, B);
  } catch (e) {
    errOut(io, `diff: ${e.message}`);
    return 2;
  }
  if (hunks.length === 0) return 0;
  const range = (s, e) => (e - s === 1 ? `${s + 1}` : `${s + 1},${e}`);
  let out = '';
  for (const h of hunks) {
    const na = h.aEnd - h.aStart;
    const nb = h.bEnd - h.bStart;
    if (na && nb) out += `${range(h.aStart, h.aEnd)}c${range(h.bStart, h.bEnd)}\n`;
    else if (na) out += `${range(h.aStart, h.aEnd)}d${h.bStart}\n`;
    else out += `${h.aStart}a${range(h.bStart, h.bEnd)}\n`;
    for (const l of A.slice(h.aStart, h.aEnd)) out += `< ${l}\n`;
    if (na && nb) out += '---\n';
    for (const l of B.slice(h.bStart, h.bEnd)) out += `> ${l}\n`;
  }
  io.stdout.write(out);
  return 1;
}

function* teeB(args, io, sh) {
  let append = false;
  const files = [];
  for (const a of args) {
    if (a === '-a') append = true;
    else if (!a.startsWith('-') || a === '-') files.push(a);
  }
  const data = yield readAll(io.stdin);
  io.stdout.write(data);
  const v = sh.can.vfs;
  let status = 0;
  for (const f of files) {
    try {
      const abs = resolveIn(sh, f);
      if (append) v.appendFile(abs, data);
      else v.writeFile(abs, data);
    } catch (e) {
      errOut(io, `tee: ${f}: ${e.message}`);
      status = 1;
    }
  }
  return status;
}

/** xargs [-n N] [COMMAND [ARGS]]: runs COMMAND with the whitespace-separated words from stdin. */
function* xargsB(args, io, sh) {
  let max = Infinity;
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) {
    if (args[k] === '-n') { max = Number(args[k + 1]); k += 2; } else if (args[k] === '-r' || args[k] === '-0') k++;
    else break;
  }
  const cmd = args.slice(k);
  if (cmd.length === 0) cmd.push('echo');
  const items = (yield readAll(io.stdin)).toString('utf8').split(/\s+/).filter(Boolean);
  if (items.length === 0) return 0;
  const batch = Number.isInteger(max) && max > 0 ? max : items.length;
  let failed = false;
  for (let p = 0; p < items.length; p += batch) {
    const status = yield* invoke([...cmd, ...items.slice(p, p + batch)], io, sh);
    if (status !== 0) failed = true;
  }
  return failed ? 123 : 0;
}

export const UTIL_BUILTINS = {
  seq: seqB,
  basename: basenameB,
  dirname: dirnameB,
  tr: trB,
  cut: cutB,
  date: dateB,
  diff: diffB,
  tee: teeB,
  xargs: xargsB,
};
