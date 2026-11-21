// Text and file-inspection builtins: cat, grep, head, tail, wc, sort, uniq, sed (s/// only), find.
// Input comes from the named VFS files, or from stdin when no file is given ("-" also means stdin).
// Every builtin is a generator (see shell.js): `yield readAll(...)` waits only for live streams.
import { posix } from 'node:path';
import { readAll } from './io.js';

const err = (io, msg) => io.stderr.write(`${msg}\n`);

/** Splits args into single-letter flags (-abc) and the remaining operands. "--" ends flags. */
export function splitFlags(args) {
  const flags = new Set();
  const rest = [];
  let endOpts = false;
  for (const a of args) {
    if (!endOpts && a === '--') { endOpts = true; continue; }
    if (!endOpts && a.length > 1 && a[0] === '-' && !/^-\d/.test(a)) {
      for (const ch of a.slice(1)) flags.add(ch);
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

/** Loads inputs as [{name, buf}]. name is null for stdin. */
export function* inputsOf(files, io, sh) {
  if (files.length === 0) return [{ name: null, buf: yield readAll(io.stdin) }];
  const list = [];
  for (const f of files) {
    if (f === '-') list.push({ name: null, buf: yield readAll(io.stdin) });
    else list.push({ name: f, buf: sh.can.vfs.readFile(sh.can.vfs.resolve(f, sh.cwd)) });
  }
  return list;
}

/** Splits text into lines without the trailing empty line produced by a final newline. */
function linesOf(buf) {
  const lines = buf.toString('utf8').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const asLines = (lines) => lines.map((l) => `${l}\n`).join('');

function* cat(args, io, sh) {
  const files = args.length ? args : ['-'];
  let status = 0;
  for (const f of files) {
    try {
      const buf = f === '-' ? yield readAll(io.stdin) : sh.can.vfs.readFile(sh.can.vfs.resolve(f, sh.cwd));
      io.stdout.write(buf);
    } catch (e) {
      err(io, `cat: ${e.message}`);
      status = 1;
    }
  }
  return status;
}

/** The name of an entry under a folder as grep shows it: "." is the working folder, so its entries have no prefix. */
const childName = (base, name) => (base === '.' ? name : `${base.replace(/\/$/, '')}/${name}`);

/**
 * The inputs grep -r reads: each named file, and every file under each named folder in name order. Names are shown as
 * typed (a folder's files as folder/file). With no operand, the working folder is searched. A missing operand is
 * reported and skipped, and sets `failed`.
 */
function* recursiveInputs(names, io, sh, state) {
  const v = sh.can.vfs;
  const list = [];
  const walk = (shown, abs) => {
    if (v.stat(abs).isDirectory()) {
      for (const entry of v.readdir(abs)) walk(childName(shown, entry), posix.join(abs, entry));
    } else {
      list.push({ name: shown, buf: v.readFile(abs) });
    }
  };
  for (const n of names.length ? names : ['.']) {
    if (n === '-') { list.push({ name: null, buf: yield readAll(io.stdin) }); continue; }
    try {
      walk(n, v.resolve(n, sh.cwd));
    } catch (e) {
      err(io, `grep: ${n}: ${e.code === 'ENOENT' ? 'No such file or directory' : e.message}`);
      state.failed = true;
    }
  }
  return list;
}

function* grep(args, io, sh) {
  const { flags, rest } = splitFlags(args);
  if (rest.length === 0) { err(io, 'grep: no pattern given'); return 2; }
  let re;
  try {
    re = new RegExp(rest[0], flags.has('i') ? 'i' : '');
  } catch (e) {
    err(io, `grep: ${e.message}`);
    return 2;
  }
  const recursive = flags.has('r') || flags.has('R');
  const state = { failed: false };
  let sources;
  if (recursive) {
    sources = yield* recursiveInputs(rest.slice(1), io, sh, state);
  } else {
    // A folder is not searched without -r (grep's own message), and the other operands still are.
    const operands = [];
    for (const f of rest.slice(1)) {
      if (f !== '-' && sh.can.vfs.exists(sh.can.vfs.resolve(f, sh.cwd)) && sh.can.vfs.stat(sh.can.vfs.resolve(f, sh.cwd)).isDirectory()) {
        err(io, `grep: ${f}: Is a directory`);
        state.failed = true;
      } else {
        operands.push(f);
      }
    }
    sources = yield* inputsOf(operands, io, sh);
  }
  const multi = sources.length > 1 || recursive;
  let matched = false;
  for (const { name, buf } of sources) {
    linesOf(buf).forEach((line, idx) => {
      if (re.test(line) === flags.has('v')) return;
      matched = true;
      const prefix = `${multi && name ? `${name}:` : ''}${flags.has('n') ? `${idx + 1}:` : ''}`;
      io.stdout.write(`${prefix}${line}\n`);
    });
  }
  if (state.failed && !matched) return 2;
  return matched ? 0 : 1;
}

/** Parses head/tail options: -n N or -N. Returns {n, rest}. */
function countOption(args, defaultN) {
  let n = defaultN;
  const rest = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-n') n = Number(args[++k]);
    else if (/^-\d+$/.test(a)) n = Number(a.slice(1));
    else rest.push(a);
  }
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid number of lines`);
  return { n, rest };
}

function* headTail(args, io, sh, which) {
  const { n, rest } = countOption(args, 10);
  const sources = yield* inputsOf(rest, io, sh);
  sources.forEach(({ name, buf }, idx) => {
    if (sources.length > 1) io.stdout.write(`${idx ? '\n' : ''}==> ${name ?? 'standard input'} <==\n`);
    const lines = linesOf(buf);
    let picked;
    if (which === 'head') picked = lines.slice(0, n);
    else picked = n === 0 ? [] : lines.slice(-n);
    io.stdout.write(asLines(picked));
  });
  return 0;
}

function* wc(args, io, sh) {
  const { flags, rest } = splitFlags(args);
  const sources = yield* inputsOf(rest, io, sh);
  const onlyLines = flags.has('l');
  for (const { name, buf } of sources) {
    const text = buf.toString('utf8');
    const lines = (text.match(/\n/g) ?? []).length;
    const words = text.split(/\s+/).filter(Boolean).length;
    const cols = onlyLines ? [lines] : [lines, words, buf.length];
    const suffix = name ? ` ${name}` : '';
    io.stdout.write(`${cols.map((c) => String(c).padStart(7)).join('')}${suffix}\n`);
  }
  return 0;
}

function* sort(args, io, sh) {
  const { flags, rest } = splitFlags(args);
  const sources = yield* inputsOf(rest, io, sh);
  let lines = sources.flatMap(({ buf }) => linesOf(buf));
  if (flags.has('n')) {
    lines.sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0));
  } else {
    lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  if (flags.has('r')) lines.reverse();
  if (flags.has('u')) lines = [...new Set(lines)];
  io.stdout.write(asLines(lines));
  return 0;
}

function* uniq(args, io, sh) {
  const { flags, rest } = splitFlags(args);
  const [{ buf }] = yield* inputsOf(rest.slice(0, 1), io, sh);
  const out = [];
  for (const line of linesOf(buf)) {
    const last = out[out.length - 1];
    if (last && last.line === line) last.count++;
    else out.push({ line, count: 1 });
  }
  io.stdout.write(out.map(({ line, count }) => (flags.has('c') ? `${String(count).padStart(7)} ${line}\n` : `${line}\n`)).join(''));
  return 0;
}

/** Turns an s/PATTERN/REPLACEMENT/FLAGS script into a function over lines. Only s/// is supported. */
/** The s/PATTERN/REPLACEMENT/[gi] command as a function over one line, or null when the script is not one. */
function parseSubstitute(script) {
  if (script[0] !== 's' || script.length < 4) return null;
  const delim = script[1];
  const fields = [];
  let cur = '';
  for (let k = 2; k < script.length; k++) {
    const ch = script[k];
    if (ch === '\\' && script[k + 1] === delim) { cur += delim; k++; }
    else if (ch === delim) { fields.push(cur); cur = ''; }
    else cur += ch;
  }
  if (fields.length !== 2) return null;
  const [pattern, replacement] = fields;
  const flags = cur; // whatever follows the final delimiter
  if (![...flags].every((f) => f === 'g' || f === 'i')) return null;
  const re = new RegExp(pattern, `${flags.includes('g') ? 'g' : ''}${flags.includes('i') ? 'i' : ''}`);
  const rep = replacement.replace(/\\(\d)/g, '$$$1');
  return (line) => line.replace(re, rep);
}

/** One sed address at script[k]: a line number, $ (the last line) or /regex/. Returns [address, next index] or null. */
function readSedAddress(script, k) {
  if (script[k] === '$') return [{ kind: 'last' }, k + 1];
  const num = /^\d+/.exec(script.slice(k));
  if (num) return [{ kind: 'line', n: Number(num[0]) }, k + num[0].length];
  if (script[k] === '/') {
    const end = script.indexOf('/', k + 1);
    if (end < 0) return null;
    try {
      return [{ kind: 'regex', re: new RegExp(script.slice(k + 1, end)) }, end + 1];
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * One sed command: an optional address or range (N, $, /re/, or a pair of them joined by a comma), then p, d or
 * s///. Null when the script is not one of these. Ranges keep their state (active) on the command.
 */
function parseSedCommand(script) {
  let k = 0;
  let from = null;
  let to = null;
  const first = readSedAddress(script, 0);
  if (first) [from, k] = first;
  if (from && script[k] === ',') {
    const second = readSedAddress(script, k + 1);
    if (!second) return null;
    [to, k] = second;
  }
  const rest = script.slice(k);
  let action;
  if (rest === 'p' || rest === 'd') {
    action = { op: rest };
  } else if (rest[0] === 's') {
    const fn = parseSubstitute(rest);
    if (!fn) return null;
    action = { op: 's', fn };
  } else {
    return null;
  }
  return { from, to, action, active: false };
}

/** True when a command applies to the current line. A range opens on its first address and closes on its second (inclusive). */
function sedSelected(c, line, lineNo, isLast) {
  const hit = (addr) => (addr.kind === 'line' ? lineNo === addr.n : addr.kind === 'last' ? isLast : addr.re.test(line));
  if (!c.from) return true;
  if (!c.to) return hit(c.from);
  if (!c.active) {
    if (!hit(c.from)) return false;
    // A range whose end is a line number not after its start covers this one line only.
    c.active = !(c.to.kind === 'line' && c.to.n <= lineNo);
    return true;
  }
  if (c.to.kind === 'line') {
    if (lineNo >= c.to.n) c.active = false;
  } else if (hit(c.to)) {
    c.active = false;
  }
  return true;
}

/** Runs sed commands over the lines of all inputs and returns the output text. `quiet` is -n. */
function runSed(commands, lines, quiet) {
  let out = '';
  lines.forEach((original, idx) => {
    const isLast = idx === lines.length - 1;
    let text = original;
    let deleted = false;
    for (const c of commands) {
      if (!sedSelected(c, text, idx + 1, isLast)) continue;
      if (c.action.op === 'd') { deleted = true; break; }
      if (c.action.op === 'p') out += `${text}\n`;
      else text = c.action.fn(text);
    }
    if (!quiet && !deleted) out += `${text}\n`;
  });
  return out;
}

function* sed(args, io, sh) {
  // sed [-n] [-e script]... [script] [file...]. Supported commands: s///, p and d, each with an optional address.
  const scripts = [];
  let quiet = false;
  let k = 0;
  for (; k < args.length; k++) {
    if (args[k] === '-n') quiet = true;
    else if (args[k] === '-e') {
      if (args[k + 1] === undefined) { err(io, 'sed: -e needs a script'); return 1; }
      scripts.push(args[++k]);
    } else break;
  }
  if (scripts.length === 0) {
    if (args[k] === undefined) { err(io, 'sed: no script given'); return 1; }
    scripts.push(args[k++]);
  }
  const commands = [];
  for (const script of scripts) {
    const c = parseSedCommand(script);
    if (!c) {
      err(io, `sed: unsupported expression ${JSON.stringify(script)} (supported: s/PATTERN/REPLACEMENT/[gi], p and d, `
        + 'each with an optional line number, $ or /regex/ address, or a range N,M)');
      return 1;
    }
    commands.push(c);
  }
  const sources = yield* inputsOf(args.slice(k), io, sh);
  const lines = sources.flatMap(({ buf }) => linesOf(buf));
  io.stdout.write(runSed(commands, lines, quiet));
  return 0;
}

/** du [-s] [-h] [path...]: disk use in 1 KiB blocks (or human units with -h), each folder after its contents. */
function* du(args, io, sh) {
  const { flags, rest } = splitFlags(args);
  const v = sh.can.vfs;
  const human = flags.has('h');
  const summarize = flags.has('s');
  const show = (bytes) => {
    if (!human) return String(Math.ceil(bytes / 1024));
    if (bytes < 1024) return String(bytes);
    let n = bytes / 1024;
    let unit = 0;
    const units = ['K', 'M', 'G', 'T'];
    while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++; }
    return `${(Math.ceil(n * 10) / 10).toFixed(1)}${units[unit]}`;
  };
  // Post-order walk: a folder's line comes after its contents, as du prints it.
  const walk = (abs, shown, out) => {
    const st = v.stat(abs);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const entry of v.readdir(abs)) total += walk(posix.join(abs, entry), `${shown}/${entry}`, out);
    out.push([total, shown]);
    return total;
  };
  let status = 0;
  for (const target of rest.length ? rest : ['.']) {
    try {
      const lines = [];
      const total = walk(v.resolve(target, sh.cwd), target.replace(/\/$/, '') || '/', lines);
      if (summarize) io.stdout.write(`${show(total)}\t${target}\n`);
      else for (const [bytes, name] of lines) io.stdout.write(`${show(bytes)}\t${name}\n`);
    } catch (e) {
      err(io, `du: cannot access '${target}': ${e.code === 'ENOENT' ? 'No such file or directory' : e.message}`);
      status = 1;
    }
  }
  return status;
}

/** Converts a find -name glob (* and ?) to a RegExp. */
function nameRegex(pattern) {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`);
}

function* find(args, io, sh) {
  const v = sh.can.vfs;
  const roots = [];
  let k = 0;
  while (k < args.length && !args[k].startsWith('-')) roots.push(args[k++]);
  if (roots.length === 0) roots.push('.');
  let namePat = null;
  let type = null;
  for (; k < args.length; k++) {
    if (args[k] === '-name') namePat = nameRegex(args[++k] ?? '');
    else if (args[k] === '-type') type = args[++k];
    else { err(io, `find: unsupported predicate ${args[k]}`); return 1; }
  }
  let status = 0;
  const walk = (abs, display) => {
    const st = v.stat(abs);
    const base = display === '.' ? '.' : posix.basename(display);
    const typeOk = !type || (type === 'f' && st.isFile()) || (type === 'd' && st.isDirectory());
    if (typeOk && (!namePat || namePat.test(base))) io.stdout.write(`${display}\n`);
    if (st.isDirectory()) {
      for (const name of v.readdir(abs)) {
        const childDisplay = display === '.' ? `./${name}` : display.endsWith('/') ? display + name : `${display}/${name}`;
        walk(posix.join(abs, name), childDisplay);
      }
    }
  };
  for (const r of roots) {
    try {
      walk(v.resolve(r, sh.cwd), r);
    } catch (e) {
      err(io, `find: ${e.message}`);
      status = 1;
    }
  }
  return status;
}

export const TEXT_BUILTINS = {
  cat, grep, head: (a, io, sh) => headTail(a, io, sh, 'head'), tail: (a, io, sh) => headTail(a, io, sh, 'tail'),
  wc, sort, uniq, sed, find, du,
};
