// Builtins that change or inspect the shell itself: export, unset, set, shift, return, break, continue,
// local, read, test and [, expr, source and ., eval, sh and bash, exit and :.
import { runScript, makeShell, finishTop } from './shell.js';
import { readAll, readLine } from './io.js';
import { evalItems, exprItems, ArithError } from './arith.js';

const errOut = (io, msg) => io.stderr.write(`${msg}\n`);
const resolveIn = (sh, p) => sh.can.vfs.resolve(p, sh.cwd);

function* exportB(args, _io, sh) {
  for (const a of args) {
    if (a.startsWith('-')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) sh.env[a.slice(0, eq)] = a.slice(eq + 1);
  }
  return 0;
}

function* unsetB(args, _io, sh) {
  let fn = false;
  for (const a of args) {
    if (a === '-f') fn = true;
    else if (a === '-v') fn = false;
    else if (fn) sh.functions.delete(a);
    else delete sh.env[a];
  }
  return 0;
}

function* exitB(args, _io, sh) {
  sh.exited = true;
  sh.exitCode = Number(args[0] ?? sh.lastStatus) & 0xff;
  return sh.exitCode;
}

/** set -e / +e turns errexit on or off; set -- args sets the positional parameters. Other options are accepted. */
function* setB(args, io, sh) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { sh.positional = args.slice(k + 1); return 0; }
    if (/^[-+][A-Za-z]+$/.test(a)) {
      const on = a[0] === '-';
      for (const ch of a.slice(1)) if (ch === 'e') sh.errexit = on;
    } else if (a === '-o' || a === '+o') {
      if (args[k + 1] === 'errexit') sh.errexit = a === '-o';
      k++;
    } else {
      sh.positional = args.slice(k);
      return 0;
    }
  }
  return 0;
}

function* shiftB(args, io, sh) {
  const n = args[0] === undefined ? 1 : Number(args[0]);
  if (!Number.isInteger(n) || n < 0 || n > sh.positional.length) {
    errOut(io, 'shift: shift count out of range');
    return 1;
  }
  sh.positional = sh.positional.slice(n);
  return 0;
}

function* returnB(args, _io, sh) {
  const n = args[0] === undefined ? sh.lastStatus : Number(args[0]) & 0xff;
  sh.jump = { type: 'return', status: n };
  return n;
}

function loopControl(type) {
  return function* (args, io, sh) {
    const levels = args[0] === undefined ? 1 : Number(args[0]);
    if (!(levels >= 1)) { errOut(io, `${type}: bad loop count`); return 1; }
    sh.jump = { type, levels };
    return 0;
  };
}

function* localB(args, _io, sh) {
  const frame = sh.localFrames.at(-1);
  for (const a of args) {
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (frame && !frame.has(name)) frame.set(name, sh.env[name]);
    if (eq > 0) sh.env[name] = a.slice(eq + 1);
    else delete sh.env[name];
  }
  return 0;
}

/** read [-r] [-p prompt] [NAME...]: one line from stdin, split on IFS whitespace; the last name takes the rest. */
function* readB(args, io, sh) {
  const names = [];
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '-p') { io.stderr.write(args[++k] ?? ''); continue; }
    if (args[k].startsWith('-') && args[k].length > 1) continue;
    names.push(args[k]);
  }
  const line = yield readLine(io.stdin);
  const vars = names.length ? names : ['REPLY'];
  if (line === null) {
    for (const n of vars) sh.env[n] = '';
    return 1;
  }
  if (names.length === 0) {
    sh.env.REPLY = line;
    return 0;
  }
  const ifs = sh.env.IFS ?? ' \t\n';
  const ws = [...ifs].filter((c) => ' \t\n'.includes(c)).join('');
  const values = [];
  let pos = 0;
  const skipWs = () => { while (pos < line.length && ws.includes(line[pos])) pos++; };
  skipWs();
  for (let k = 0; k < vars.length; k++) {
    if (k === vars.length - 1) {
      let end = line.length;
      while (end > pos && ws.includes(line[end - 1])) end--;
      values.push(line.slice(pos, end));
      break;
    }
    const start = pos;
    while (pos < line.length && !ifs.includes(line[pos])) pos++;
    values.push(line.slice(start, pos));
    if (pos < line.length) { pos++; skipWs(); }
  }
  vars.forEach((n, k) => { sh.env[n] = values[k] ?? ''; });
  return 0;
}

// ---- test and [ --------------------------------------------------------------

class TestError extends Error {}

const INT = /^[-+]?\d+$/;

function unaryTest(op, v, sh) {
  const vfs = sh.can.vfs;
  switch (op) {
    case '-z': return v === '';
    case '-n': return v !== '';
    case '-e': case '-r': case '-w': case '-x': return vfs.exists(resolveIn(sh, v));
    case '-f': return vfs.exists(resolveIn(sh, v)) && vfs.stat(resolveIn(sh, v)).isFile();
    case '-d': return vfs.exists(resolveIn(sh, v)) && vfs.stat(resolveIn(sh, v)).isDirectory();
    case '-s': return vfs.exists(resolveIn(sh, v)) && vfs.stat(resolveIn(sh, v)).size > 0;
    default: throw new TestError(`unknown unary operator '${op}'`);
  }
}

function binaryTest(l, op, r) {
  if (op === '=' || op === '==') return l === r;
  if (op === '!=') return l !== r;
  const ints = { '-eq': 1, '-ne': 1, '-lt': 1, '-gt': 1, '-le': 1, '-ge': 1 };
  if (!ints[op]) throw new TestError(`unknown operator '${op}'`);
  if (!INT.test(l.trim()) || !INT.test(r.trim())) throw new TestError('integer expression expected');
  const a = Number(l);
  const b = Number(r);
  switch (op) {
    case '-eq': return a === b;
    case '-ne': return a !== b;
    case '-lt': return a < b;
    case '-gt': return a > b;
    case '-le': return a <= b;
    default: return a >= b;
  }
}

function evalTest(a, sh) {
  if (a.length === 0) return false;
  if (a.length === 1) return a[0] !== '';
  if (a[0] === '!') return !evalTest(a.slice(1), sh);
  if (a.length === 2) return unaryTest(a[0], a[1], sh);
  const oi = a.indexOf('-o');
  if (oi > 0) return evalTest(a.slice(0, oi), sh) || evalTest(a.slice(oi + 1), sh);
  const ai = a.indexOf('-a');
  if (ai > 0) return evalTest(a.slice(0, ai), sh) && evalTest(a.slice(ai + 1), sh);
  if (a[0] === '(' && a.at(-1) === ')') return evalTest(a.slice(1, -1), sh);
  if (a.length === 3) return binaryTest(a[0], a[1], a[2]);
  throw new TestError('too many arguments');
}

function testB(args, io, sh, bracket) {
  const name = bracket ? '[' : 'test';
  let a = args;
  if (bracket) {
    if (a.at(-1) !== ']') { errOut(io, "[: missing `]'"); return 2; }
    a = a.slice(0, -1);
  }
  try {
    return evalTest(a, sh) ? 0 : 1;
  } catch (e) {
    if (e instanceof TestError) { errOut(io, `${name}: ${e.message}`); return 2; }
    throw e;
  }
}

function* exprB(args, io) {
  try {
    const v = evalItems(exprItems(args));
    io.stdout.write(`${v}\n`);
    const isNull = v === '' || v === 0 || v === '0';
    return isNull ? 1 : 0;
  } catch (e) {
    if (e instanceof ArithError) { errOut(io, `expr: ${e.message}`); return 2; }
    throw e;
  }
}

// ---- running other text as shell -------------------------------------------

/** source FILE [ARGS]: runs a file in this shell. A return inside it ends the file. */
function* sourceB(args, io, sh) {
  const name = args[0];
  if (!name) { errOut(io, 'source: filename argument required'); return 2; }
  const file = resolveIn(sh, name);
  if (!sh.can.vfs.exists(file) || !sh.can.vfs.stat(file).isFile()) {
    errOut(io, `source: ${name}: No such file or directory`);
    return 1;
  }
  const saved = sh.positional;
  if (args.length > 1) sh.positional = args.slice(1);
  try {
    const status = yield* runScript(sh.can.vfs.readFile(file, 'utf8'), sh, io, {});
    if (sh.jump && sh.jump.type === 'return') {
      const s = sh.jump.status;
      sh.jump = null;
      return s;
    }
    return status;
  } finally {
    sh.positional = saved;
  }
}

/** eval ARGS: runs the joined arguments in this shell. */
function* evalB(args, io, sh) {
  if (args.length === 0) return 0;
  return yield* runScript(args.join(' '), sh, io, {});
}

/** sh / bash: `-c 'text' [name args]`, `file [args]`, or a script on stdin. Runs in a fresh shell. */
function* shellB(args, io, sh) {
  const flags = [];
  let k = 0;
  while (k < args.length && /^-[A-Za-z]+$/.test(args[k])) {
    flags.push(args[k]);
    k++;
    if (args[k - 1].includes('c')) break;
  }
  const dashC = flags.some((f) => f.includes('c'));
  const errexit = flags.some((f) => f.includes('e'));
  let src;
  let name = 'sh';
  let positional = [];
  if (dashC) {
    if (k >= args.length) { errOut(io, 'sh: -c requires an argument'); return 2; }
    src = args[k];
    if (args.length > k + 1) name = args[k + 1];
    positional = args.slice(k + 2);
  } else if (k < args.length) {
    const file = resolveIn(sh, args[k]);
    if (!sh.can.vfs.exists(file) || !sh.can.vfs.stat(file).isFile()) {
      errOut(io, `sh: can't open ${args[k]}`);
      return 127;
    }
    src = sh.can.vfs.readFile(file, 'utf8');
    name = args[k];
    positional = args.slice(k + 1);
  } else {
    src = (yield readAll(io.stdin)).toString('utf8');
  }
  const child = makeShell({
    can: sh.can, pid: sh.pid, cwd: sh.cwd, env: { ...sh.env }, signal: sh.signal, name, positional,
  });
  child.errexit = errexit;
  const status = yield* runScript(src, child, io, {});
  return finishTop(child, status);
}

export const SHELL_BUILTINS = {
  export: exportB,
  unset: unsetB,
  exit: exitB,
  set: setB,
  shift: shiftB,
  return: returnB,
  break: loopControl('break'),
  continue: loopControl('continue'),
  local: localB,
  read: readB,
  test: (a, io, sh) => testB(a, io, sh, false),
  '[': (a, io, sh) => testB(a, io, sh, true),
  expr: exprB,
  source: sourceB,
  '.': sourceB,
  eval: evalB,
  sh: shellB,
  bash: shellB,
  ':': function* () { return 0; },
};
