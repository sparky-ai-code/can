// Shell builtins. Each is a generator `function* (args, io, sh) => exitCode`, where io = {stdin, stdout, stderr}
// and sh = shell state (can, pid, cwd, env, signal, ...). Everything works on the can's VFS, process table
// and vnet. Builtins that wait for the event loop (sleep, curl, node, ...) yield promises.
import { posix } from 'node:path';
import { Buffer } from 'node:buffer';
import nodeHttp from 'node:http';
import nodeHttps from 'node:https';
import { runScript, childShell, makeShell, finishTop } from './shell.js';
import { startJsFile, checkSyntax, nodeVersionOf } from './js.js';
import { asReadable } from './io.js';
import { TEXT_BUILTINS, splitFlags } from './textcmds.js';
import { UTIL_BUILTINS } from './utilcmds.js';
import { SHELL_BUILTINS } from './shellcmds.js';
import { STATUS_CODES } from './http.js';
import { planTree, materialize, registryName } from './npm.js';
import { KernelError } from '../kernel/errors.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const SIGNAL_NAMES = { 1: 'SIGHUP', 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' };

const errOut = (io, msg) => io.stderr.write(`${msg}\n`);
const resolveIn = (sh, p) => sh.can.vfs.resolve(p, sh.cwd);

const ESCAPES = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '"': '"', "'": "'" };

/** Interprets backslash escapes (echo -e). Unknown escapes stay as written. */
function unescapeText(s) {
  return s.replace(/\\(.)/g, (m, c) => (c in ESCAPES ? ESCAPES[c] : m));
}

const PRINTF_SPEC = /%(-?)(\d*)(?:\.(\d+))?([sdifxoc%])|\\(.)/g;

/**
 * printf(1): %s %d %i %f %x %o %c and %%, with optional width, precision and '-' (left align), and the
 * usual backslash escapes. The format is reused while arguments remain, as in POSIX printf.
 */
function formatPrintf(fmt, args) {
  const queue = [...args];
  let out = '';
  for (;;) {
    let consumed = false;
    out += fmt.replace(PRINTF_SPEC, (m, left, width, prec, conv, esc) => {
      if (esc !== undefined) return esc in ESCAPES ? ESCAPES[esc] : m;
      if (conv === '%') return '%';
      consumed = true;
      const raw = queue.length ? String(queue.shift()) : '';
      const num = Number(raw) || 0;
      let s;
      switch (conv) {
        case 'd': case 'i': s = String(Math.trunc(num)); break;
        case 'f': s = num.toFixed(prec === undefined ? 6 : Number(prec)); break;
        case 'x': s = Math.trunc(num).toString(16); break;
        case 'o': s = Math.trunc(num).toString(8); break;
        case 'c': s = raw.slice(0, 1); break;
        default: s = prec === undefined ? raw : raw.slice(0, Number(prec));
      }
      const w = Number(width || 0);
      if (s.length >= w) return s;
      return left ? s.padEnd(w) : s.padStart(w);
    });
    if (!consumed || queue.length === 0) break;
  }
  return out;
}

function modeString(st) {
  const type = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-';
  const bits = [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1];
  const chars = 'rwxrwxrwx';
  return type + bits.map((b, k) => (st.mode & b ? chars[k] : '-')).join('');
}

function longLine(name, st) {
  const when = st.mtime.toISOString().slice(0, 16).replace('T', ' ');
  return `${modeString(st)} ${String(st.size).padStart(6)} ${when} ${name}`;
}

function* ls(args, io, sh) {
  const { flags, rest } = splitFlags(args);
  const v = sh.can.vfs;
  const long = flags.has('l');
  const all = flags.has('a');
  const targets = rest.length ? rest : ['.'];
  let status = 0;
  for (const t of targets) {
    const abs = resolveIn(sh, t);
    let st;
    try {
      st = v.stat(abs);
    } catch (e) {
      errOut(io, `ls: ${e.message}`);
      status = 1;
      continue;
    }
    if (!st.isDirectory()) {
      io.stdout.write(`${long ? longLine(t, st) : t}\n`);
      continue;
    }
    let entries = v.readdir(abs, { withFileTypes: true });
    if (!all) entries = entries.filter((e) => !e.name.startsWith('.'));
    else {
      entries = [
        Object.assign(v.stat(abs), { name: '.' }),
        Object.assign(v.stat(posix.dirname(abs)), { name: '..' }),
        ...entries,
      ];
    }
    if (targets.length > 1) io.stdout.write(`${t}:\n`);
    if (long) {
      for (const e of entries) io.stdout.write(`${longLine(e.name, e)}\n`);
    } else if (entries.length) {
      io.stdout.write(`${entries.map((e) => e.name).join('  ')}\n`);
    }
    if (targets.length > 1) io.stdout.write('\n');
  }
  return status;
}

function* cd(args, io, sh) {
  const target = args[0] ?? sh.env.HOME ?? '/';
  const abs = resolveIn(sh, target);
  const v = sh.can.vfs;
  if (!v.exists(abs)) { errOut(io, `cd: no such file or directory: ${target}`); return 1; }
  if (!v.stat(abs).isDirectory()) { errOut(io, `cd: not a directory: ${target}`); return 1; }
  sh.cwd = abs;
  sh.env.PWD = abs;
  return 0;
}

function* mkdir(args, io, sh) {
  const { flags, rest } = splitFlags(args);
  let status = 0;
  for (const t of rest) {
    try { sh.can.vfs.mkdir(resolveIn(sh, t), { recursive: flags.has('p') }); } catch (e) {
      errOut(io, `mkdir: cannot create directory '${t}': ${e.message}`);
      status = 1;
    }
  }
  return status;
}

function* rm(args, io, sh) {
  const { flags, rest } = splitFlags(args);
  let status = 0;
  for (const t of rest) {
    try {
      sh.can.vfs.rm(resolveIn(sh, t), { recursive: flags.has('r') || flags.has('R'), force: flags.has('f') });
    } catch (e) {
      errOut(io, `rm: cannot remove '${t}': ${e.message}`);
      status = 1;
    }
  }
  return status;
}

function* cp(args, io, sh) {
  const { flags, rest } = splitFlags(args);
  if (rest.length < 2) { errOut(io, 'cp: missing file operand'); return 1; }
  const v = sh.can.vfs;
  const dest = resolveIn(sh, rest[rest.length - 1]);
  const destIsDir = v.exists(dest) && v.stat(dest).isDirectory();
  if (rest.length > 2 && !destIsDir) { errOut(io, `cp: target '${rest.at(-1)}' is not a directory`); return 1; }
  let status = 0;
  for (const src of rest.slice(0, -1)) {
    const from = resolveIn(sh, src);
    try {
      if (v.stat(from).isDirectory() && !flags.has('r') && !flags.has('R')) {
        errOut(io, `cp: -r not specified; omitting directory '${src}'`);
        status = 1;
        continue;
      }
      const to = destIsDir ? posix.join(dest, posix.basename(from)) : dest;
      v.copy(from, to, { recursive: true });
    } catch (e) {
      errOut(io, `cp: ${e.message}`);
      status = 1;
    }
  }
  return status;
}

function* mv(args, io, sh) {
  const { rest } = splitFlags(args);
  if (rest.length < 2) { errOut(io, 'mv: missing file operand'); return 1; }
  const v = sh.can.vfs;
  const dest = resolveIn(sh, rest[rest.length - 1]);
  const destIsDir = v.exists(dest) && v.stat(dest).isDirectory();
  let status = 0;
  for (const src of rest.slice(0, -1)) {
    const from = resolveIn(sh, src);
    try {
      v.rename(from, destIsDir ? posix.join(dest, posix.basename(from)) : dest);
    } catch (e) {
      errOut(io, `mv: ${e.message}`);
      status = 1;
    }
  }
  return status;
}

function* touch(args, io, sh) {
  const v = sh.can.vfs;
  let status = 0;
  for (const t of args) {
    const abs = resolveIn(sh, t);
    try {
      if (v.exists(abs)) v.utimes(abs, Date.now());
      else v.writeFile(abs, '');
    } catch (e) {
      errOut(io, `touch: ${e.message}`);
      status = 1;
    }
  }
  return status;
}

function* kill(args, io, sh) {
  const list = [...args];
  let signal = 'SIGTERM';
  if (list[0]?.startsWith('-')) {
    const s = list.shift().slice(1);
    signal = /^\d+$/.test(s) ? SIGNAL_NAMES[s] : (s.startsWith('SIG') ? s : `SIG${s}`);
    if (!signal) { errOut(io, 'kill: invalid signal'); return 1; }
  }
  let status = 0;
  for (const pid of list) {
    try {
      sh.can.proc.kill(Number(pid), signal);
    } catch {
      errOut(io, `kill: (${pid}) - No such process`);
      status = 1;
    }
  }
  return status;
}

function* sleep(args, io, sh) {
  const secs = Number(args[0]);
  if (!(secs >= 0)) { errOut(io, 'sleep: invalid time interval'); return 1; }
  yield new Promise((resolve) => {
    const t = setTimeout(resolve, secs * 1000);
    sh.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  return 0;
}

/** Whether a VFS file is a shell script: a .sh name or a #!sh / #!bash / #!dash shebang. */
function isShellScript(sh, file) {
  const v = sh.can.vfs;
  if (!v.exists(file) || !v.stat(file).isFile()) return false;
  if (file.endsWith('.sh')) return true;
  const head = v.readFile(file, 'utf8').slice(0, 200).split('\n')[0];
  return /^#!\s*(\S*\/)?(env\s+)?(ba|da|z|k)?sh\b/.test(head);
}

/** Runs a path like ./tool: a shell script in a fresh shell, otherwise a JS file with node. */
export function* runPathCommand(path, args, io, sh) {
  const file = resolveIn(sh, path);
  if (isShellScript(sh, file)) {
    const child = makeShell({
      can: sh.can, pid: sh.pid, cwd: sh.cwd, env: { ...sh.env }, signal: sh.signal, name: path, positional: args,
    });
    const status = yield* runScript(sh.can.vfs.readFile(file, 'utf8'), child, io, {});
    return finishTop(child, status);
  }
  return yield* node([path, ...args], io, sh);
}

/** Thrown for a node option a can does not honour. Exit code 9 is node's own code for a bad option. */
class NodeOptionError extends Error {}

/** Options node accepts that change nothing a can can observe. Anything else that is not handled is an error. */
const NODE_NOOP_OPTIONS = new Set([
  '--no-warnings', '--trace-warnings', '--no-deprecation', '--trace-deprecation', '--enable-source-maps',
]);

/** Splits NODE_OPTIONS on spaces, with double quotes grouping a value, as node does. */
export function splitNodeOptions(text) {
  return [...String(text ?? '').matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

/**
 * Reads node options from the front of `tokens` into `flags` ({check, version, preload}). Returns the index of the
 * first token that is not an option. -e and -p stop the read, so the caller can handle them. Throws NodeOptionError
 * for an option a can does not honour, rather than ignoring it.
 */
function readNodeOptions(tokens, flags, where) {
  let k = 0;
  while (k < tokens.length) {
    const a = tokens[k];
    if (a === '--') return k + 1;
    if (a === '-' || !a.startsWith('-')) return k;
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (name === '-e' || name === '--eval' || name === '-p' || name === '--print') return k;
    if (name === '-r' || name === '--require') {
      const value = eq > 0 ? a.slice(eq + 1) : tokens[++k];
      if (value === undefined || value === '') throw new NodeOptionError(`${where}: ${name} needs a module path`);
      flags.preload.push(value);
    } else if (name === '-c' || name === '--check') {
      flags.check = true;
    } else if (name === '-v' || name === '--version') {
      flags.version = true;
    } else if (!NODE_NOOP_OPTIONS.has(name)) {
      throw new NodeOptionError(`${where}: option ${a} is not supported in a can (supported: -c/--check, -v/--version, `
        + `-r/--require <file>, -e/--eval, -p/--print, ${[...NODE_NOOP_OPTIONS].join(', ')})`);
    }
    k++;
  }
  return k;
}

function* node(args, io, sh) {
  if (args.length === 0) { errOut(io, 'node: no script given (use node <file> or node -e <code>)'); return 1; }
  // NODE_OPTIONS is read like node reads it, so its options take effect (or refuse) instead of being ignored.
  const flags = { check: false, version: false, preload: [] };
  try {
    const fromEnv = splitNodeOptions(sh.env?.NODE_OPTIONS);
    if (readNodeOptions(fromEnv, flags, 'NODE_OPTIONS') !== fromEnv.length) {
      throw new NodeOptionError(`NODE_OPTIONS: only options may be set there, not "${fromEnv.join(' ')}"`);
    }
  } catch (err) {
    if (!(err instanceof NodeOptionError)) throw err;
    errOut(io, err.message);
    return 9;
  }
  let i;
  try {
    i = readNodeOptions(args, flags, 'node');
  } catch (err) {
    if (!(err instanceof NodeOptionError)) throw err;
    errOut(io, err.message);
    return 9;
  }
  if (flags.version) {
    // The same version process.version reports inside the can.
    io.stdout.write(`${nodeVersionOf(sh.can)}\n`);
    return 0;
  }
  const sources = new Map();
  let file;
  let runArgs;
  if (args[i] === '-e' || args[i] === '--eval') {
    if (args[i + 1] === undefined) { errOut(io, `node: ${args[i]} needs a code argument`); return 9; }
    file = posix.join(sh.cwd, '[eval]');
    sources.set(file, args[i + 1]);
    runArgs = args.slice(i + 2);
  } else if (args[i] === '-p' || args[i] === '--print') {
    if (args[i + 1] === undefined) { errOut(io, `node: ${args[i]} needs a code argument`); return 9; }
    // Like node -p: evaluates the expression and prints it (strings as they are, other values inspected).
    file = posix.join(sh.cwd, '[eval]');
    sources.set(file, `const __result = (${args[i + 1]});\n`
      + "console.log(typeof __result === 'string' ? __result : require('util').inspect(__result));");
    runArgs = args.slice(i + 2);
  } else {
    if (args[i] === undefined) { errOut(io, 'node: no script given (use node <file> or node -e <code>)'); return 1; }
    file = resolveIn(sh, args[i]);
    if (!sh.can.vfs.exists(file) || !sh.can.vfs.stat(file).isFile()) {
      errOut(io, `Error: Cannot find module '${file}'`);
      return 1;
    }
    if (flags.check) {
      const err = checkSyntax(sh.can.vfs.readFile(file, 'utf8'), file);
      if (err) {
        errOut(io, `${file}\n${err.name}: ${err.message}`);
        return 1;
      }
      return 0;
    }
    runArgs = args.slice(i + 1);
  }
  const preload = flags.preload.map((p) => resolveIn(sh, p));
  for (const p of preload) {
    if (!sh.can.vfs.exists(p) || !sh.can.vfs.stat(p).isFile()) {
      errOut(io, `Error: Cannot find module '${p}'`);
      return 1;
    }
  }
  const rt = startJsFile({
    can: sh.can, pid: sh.pid, file, args: runArgs, cwd: sh.cwd, env: { ...sh.env },
    stdout: io.stdout, stderr: io.stderr, stdin: asReadable(io.stdin), signal: sh.signal, sources, preload,
  });
  if (rt.finished) return rt.resultCode ?? 0;
  try {
    return yield rt.done;
  } catch (err) {
    // The shell refused to wait (execSync): stop the program so its timers do not outlive the call.
    rt.finish(130);
    throw err;
  }
}

/** The node_modules/.bin shim for a command name, searched from the working folder up. Null when none. */
export function findBin(name, sh) {
  if (!name || name.includes('/')) return null;
  let dir = sh.cwd;
  for (;;) {
    const candidate = posix.join(dir, 'node_modules', '.bin', name);
    if (sh.can.vfs.exists(candidate)) return candidate;
    if (dir === '/') return null;
    dir = posix.dirname(dir);
  }
}

function* npx(args, io, sh) {
  const [name, ...rest] = args;
  if (!name) { errOut(io, 'npx: no command given'); return 1; }
  const bin = findBin(name, sh);
  if (!bin) { errOut(io, `npx: ${name} is not installed in this project (run npm install first)`); return 1; }
  return yield* runPathCommand(bin, rest, io, sh);
}

/** GET for npm: the can's registry over the real network (or a local address inside the can). Null on 404. */
async function registryFetch(sh, url, accept) {
  if (!sh.can.policy.internet) {
    throw new KernelError('EPERM', 'EPERM: network access is off for this can (network.internet is false), so npm cannot reach the registry');
  }
  let u = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    const headers = accept ? { accept } : {};
    const res = LOCAL_HOSTS.has(u.hostname)
      ? await sh.can.vnet.request({ port: Number(u.port) || 80, method: 'GET', path: `${u.pathname}${u.search}`, headers, timeout: 60_000 })
      : await sendRemote(u, 'GET', headers, undefined);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      u = new URL(res.headers.location, u);
      continue;
    }
    if (res.status === 404) return null;
    if (res.status !== 200) throw new KernelError('EIO', `EIO: registry answered ${res.status} for ${url}`);
    return res.body;
  }
  throw new KernelError('ELOOP', `ELOOP: too many redirects from ${url}`);
}

/** Splits "name@range" (the "@" that starts a scope is part of the name). */
function parseSpec(spec) {
  const at = spec.indexOf('@', 1);
  return at === -1 ? { name: spec, range: undefined } : { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

const INSTALL_FLAGS = new Set([
  '--no-save', '--save', '-S', '--ignore-scripts', '--legacy-peer-deps', '--prefer-offline', '--no-audit',
  '--no-fund', '--silent', '-s', '--loglevel=error',
]);

/** Parses install-style arguments into options and package specs. Unknown flags are refused. */
function parseInstallArgs(args, io) {
  const opts = { packages: [], dev: false, save: true, omitDev: false, ciMode: false };
  for (const a of args) {
    if (!a.startsWith('-')) opts.packages.push(a);
    else if (a === '--save-dev' || a === '-D') opts.dev = true;
    else if (a === '--no-save') opts.save = false;
    else if (a === '--omit=dev' || a === '--production') opts.omitDev = true;
    else if (!INSTALL_FLAGS.has(a)) {
      errOut(io, `npm ERR! unknown option: ${a}`);
      return null;
    }
  }
  return opts;
}

/**
 * npm install / ci / add / update, run inside the can. Resolves from the registry named by the can's network
 * policy, writes node_modules under the project folder and keeps package.json in step (named packages are saved
 * as ^version unless --no-save). Lifecycle scripts do not run; the warnings say which packages had them.
 */
async function projectInstall(sh, io, { packages, dev, save, omitDev, ciMode }) {
  const dir = sh.cwd;
  const v = sh.can.vfs;
  const manifestPath = posix.join(dir, 'package.json');
  const pkg = v.exists(manifestPath) ? JSON.parse(v.readFile(manifestPath, 'utf8')) : null;
  if (!pkg && packages.length === 0) {
    errOut(io, `npm ERR! enoent Could not read package.json in ${dir}`);
    return 1;
  }
  const manifest = pkg ?? { name: posix.basename(dir) || 'app', version: '1.0.0' };
  const named = packages.map(parseSpec);
  const namedNames = new Set(named.map((n) => n.name));
  const roots = named.map((n) => ({ name: n.name, range: n.range ?? 'latest', dev }));
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!namedNames.has(name)) roots.push({ name, range, dev: false });
  }
  if (!omitDev) {
    for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
      if (!namedNames.has(name) && !(name in (manifest.dependencies ?? {}))) roots.push({ name, range, dev: true });
    }
  }
  const registry = sh.can.policy.registry;
  const planned = await planTree({
    roots,
    getPackument: async (name) => {
      const body = await registryFetch(sh, `${registry}${registryName(name)}`, 'application/vnd.npm.install-v1+json, application/json;q=0.8');
      return body ? JSON.parse(body.toString('utf8')) : null;
    },
  });
  const { count, warnings } = await materialize({
    placed: planned.placed,
    vfs: v,
    cwd: dir,
    getTarball: (url) => registryFetch(sh, url, undefined),
    warnings: [...planned.warnings],
  });
  const writeManifest = save && !ciMode && (named.length > 0 || !pkg);
  if (writeManifest) {
    for (const n of named) {
      const entry = planned.placed.get(`node_modules/${n.name}`);
      const field = dev ? 'devDependencies' : 'dependencies';
      const other = dev ? 'dependencies' : 'devDependencies';
      manifest[field] = { ...(manifest[field] ?? {}), [n.name]: `^${entry.version}` };
      if (manifest[other]) delete manifest[other][n.name];
    }
    v.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  for (const w of warnings) io.stderr.write(`npm WARN ${w}\n`);
  io.stdout.write(`added ${count} package${count === 1 ? '' : 's'}\n`);
  return 0;
}

function* npm(args, io, sh) {
  const [cmd, ...rest] = args;
  const pkgPath = posix.join(sh.cwd, 'package.json');
  const v = sh.can.vfs;
  const pkg = v.exists(pkgPath) ? JSON.parse(v.readFile(pkgPath, 'utf8')) : {};
  const scripts = pkg.scripts ?? {};
  if (!cmd || cmd === 'help') {
    io.stdout.write('Usage: npm install [pkg[@range]...] | npm ci | npm update | npm uninstall <pkg> | npm init -y | npm run <script> | npm test | npm start\n');
    return 0;
  }
  if (['install', 'i', 'add', 'update', 'up', 'ci'].includes(cmd)) {
    const opts = parseInstallArgs(rest, io);
    if (!opts) return 2;
    if (cmd === 'ci') {
      if (opts.packages.length) { errOut(io, 'npm ERR! `npm ci` takes no package names'); return 1; }
      opts.save = false;
      opts.ciMode = true;
    }
    try {
      return yield projectInstall(sh, io, opts);
    } catch (err) {
      errOut(io, `npm ERR! ${err.message}`);
      return 1;
    }
  }
  if (['uninstall', 'remove', 'rm', 'un'].includes(cmd)) {
    const names = rest.filter((a) => !a.startsWith('-'));
    if (names.length === 0) { errOut(io, 'npm ERR! uninstall needs a package name'); return 1; }
    for (const name of names) {
      for (const field of ['dependencies', 'devDependencies']) {
        if (pkg[field]) delete pkg[field][name];
      }
      const installed = posix.join(sh.cwd, 'node_modules', name);
      if (v.exists(installed)) v.rm(installed, { recursive: true, force: true });
    }
    v.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    io.stdout.write(`removed ${names.length} package${names.length === 1 ? '' : 's'}\n`);
    return 0;
  }
  if (cmd === 'init') {
    if (v.exists(pkgPath)) { errOut(io, 'npm ERR! package.json already exists'); return 1; }
    const name = posix.basename(sh.cwd).replace(/[^a-z0-9._-]/gi, '-').toLowerCase() || 'app';
    v.writeFile(pkgPath, `${JSON.stringify({ name, version: '1.0.0', main: 'index.js', scripts: {}, dependencies: {} }, null, 2)}\n`);
    io.stdout.write(`wrote ${pkgPath}\n`);
    return 0;
  }
  if (['run', 'run-script', 'test', 'start'].includes(cmd)) {
    const name = cmd === 'run' || cmd === 'run-script' ? rest[0] : cmd;
    if (!name) {
      io.stdout.write('Available scripts:\n');
      for (const [k, val] of Object.entries(scripts)) io.stdout.write(`  ${k}: ${val}\n`);
      return 0;
    }
    if (!(name in scripts)) { errOut(io, `npm ERR! Missing script: "${name}"`); return 1; }
    io.stdout.write(`\n> ${pkg.name ?? 'app'}@${pkg.version ?? '0.0.0'} ${name}\n> ${scripts[name]}\n\n`);
    const child = childShell(sh);
    const status = yield* runScript(scripts[name], child, io, {});
    return finishTop(child, status);
  }
  errOut(io, `npm ERR! unknown command: ${cmd}`);
  return 1;
}

/**
 * pnpm for single packages. Workspaces (-r, -w, --filter, pnpm-workspace.yaml) are refused, not guessed at:
 * a monorepo is installed one package folder at a time.
 */
function* pnpm(args, io, sh) {
  const [cmd, ...rest] = args;
  const workspace = args.some((a) => ['-r', '--recursive', '-w', '--workspace-root', '-F'].includes(a) || a.startsWith('--filter'));
  if (workspace) {
    errOut(io, 'pnpm ERR! workspaces (-r, -w, -F, --filter) are not supported in a can: install each package folder with npm');
    return 1;
  }
  if (sh.can.vfs.exists(posix.join(sh.cwd, 'pnpm-workspace.yaml'))) {
    io.stderr.write('pnpm WARN pnpm-workspace.yaml found: only this folder\'s package.json is installed\n');
  }
  if (!cmd || cmd === 'help') {
    io.stdout.write('Usage: pnpm install | pnpm add <pkg> | pnpm remove <pkg> | pnpm run <script> | pnpm test | pnpm start\n');
    return 0;
  }
  if (['install', 'i', 'add'].includes(cmd)) return yield* npm(['install', ...rest], io, sh);
  if (['remove', 'rm', 'uninstall'].includes(cmd)) return yield* npm(['uninstall', ...rest], io, sh);
  if (cmd === 'run') return yield* npm(['run', ...rest], io, sh);
  if (cmd === 'test' || cmd === 'start') return yield* npm([cmd, ...rest], io, sh);
  errOut(io, `pnpm ERR! not supported in a can: ${cmd}`);
  return 1;
}

/** Sends a request to a real host over node:http(s). Used only for non-local curl targets. */
function sendRemote(u, method, headers, body) {
  const mod = u.protocol === 'https:' ? nodeHttps : nodeHttp;
  return new Promise((resolve, reject) => {
    const r = mod.request({
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method,
      path: `${u.pathname}${u.search}`,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

// curl options a can implements. Any other option is an error (exit 2, as curl reports an unknown option), so a flag
// the can does not honour can no longer change the output silently.
const CURL_VALUE_OPTIONS = new Map([
  ['-X', 'method'], ['--request', 'method'], ['-H', 'header'], ['--header', 'header'],
  ['-d', 'data'], ['--data', 'data'], ['--data-raw', 'data'], ['--data-binary', 'data'],
  ['-o', 'output'], ['--output', 'output'], ['-w', 'writeOut'], ['--write-out', 'writeOut'],
  ['-A', 'userAgent'], ['--user-agent', 'userAgent'], ['--url', 'url'],
]);
const CURL_FLAG_OPTIONS = new Map([
  ['-s', 'silent'], ['--silent', 'silent'], ['-S', 'showError'], ['--show-error', 'showError'],
  ['-i', 'include'], ['--include', 'include'], ['-I', 'head'], ['--head', 'head'],
  ['-v', 'verbose'], ['--verbose', 'verbose'], ['-L', 'location'], ['--location', 'location'],
  ['-f', 'fail'], ['--fail', 'fail'],
]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 50;

/**
 * Reads curl's arguments. Short flags combine (-sSL), and a value option takes the rest of its word or the next word
 * (-oFILE or -o FILE). Returns {opts} or {error, code}.
 */
function parseCurlArgs(args) {
  const opts = {
    silent: false, showError: false, include: false, head: false, verbose: false, location: false, fail: false,
    method: null, data: null, headers: {}, output: null, writeOut: null, userAgent: null, url: null,
  };
  const positional = [];
  const setValue = (field, value) => {
    if (field === 'header') {
      const idx = value.indexOf(':');
      if (idx > 0) opts.headers[value.slice(0, idx).trim().toLowerCase()] = value.slice(idx + 1).trim();
    } else if (field === 'data') {
      if (value.startsWith('@')) return `curl: reading data from a file (${value}) is not supported in a can; pass the data inline`;
      opts.data = opts.data === null ? value : `${opts.data}&${value}`;
    } else if (field === 'userAgent') {
      opts.headers['user-agent'] = value;
    } else {
      opts[field] = value;
    }
    return null;
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { positional.push(...args.slice(k + 1)); break; }
    if (!a.startsWith('-') || a === '-') { positional.push(a); continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (CURL_VALUE_OPTIONS.has(name)) {
        const value = eq > 0 ? a.slice(eq + 1) : args[++k];
        if (value === undefined) return { error: `curl: option ${name}: requires parameter`, code: 2 };
        const bad = setValue(CURL_VALUE_OPTIONS.get(name), value);
        if (bad) return { error: bad, code: 2 };
      } else if (CURL_FLAG_OPTIONS.has(name)) {
        opts[CURL_FLAG_OPTIONS.get(name)] = true;
      } else {
        return { error: `curl: option ${a}: is unknown`, code: 2 };
      }
      continue;
    }
    for (let c = 1; c < a.length; c++) {
      const name = `-${a[c]}`;
      if (CURL_VALUE_OPTIONS.has(name)) {
        const value = c + 1 < a.length ? a.slice(c + 1) : args[++k];
        if (value === undefined) return { error: `curl: option ${name}: requires parameter`, code: 2 };
        const bad = setValue(CURL_VALUE_OPTIONS.get(name), value);
        if (bad) return { error: bad, code: 2 };
        break;
      }
      if (!CURL_FLAG_OPTIONS.has(name)) return { error: `curl: option ${name}: is unknown`, code: 2 };
      opts[CURL_FLAG_OPTIONS.get(name)] = true;
    }
  }
  if (opts.url !== null) {
    if (positional.length > 0) return { error: 'curl: multiple URLs are not supported in a can', code: 2 };
  } else if (positional.length === 1) {
    [opts.url] = positional;
  } else if (positional.length > 1) {
    return { error: 'curl: multiple URLs are not supported in a can', code: 2 };
  }
  return { opts };
}

/** The status line and headers, as curl prints them with -i and -I. Multi-valued headers get one line per value. */
function curlHeadBlock(res) {
  let head = `HTTP/1.1 ${res.status} ${STATUS_CODES[res.status] ?? ''}\r\n`;
  for (const [k, val] of Object.entries(res.headers ?? {})) {
    for (const v of [].concat(val)) head += `${k}: ${v}\r\n`;
  }
  return `${head}\r\n`;
}

/** The -w format: %{http_code}, %{content_type}, %{size_download}, %{url_effective}; \n and \t are escapes. */
function curlWriteOut(format, res, href) {
  const vars = {
    http_code: String(res.status), response_code: String(res.status),
    content_type: String(res.headers?.['content-type'] ?? ''),
    size_download: String(res.body.length), url_effective: href,
  };
  return format.replace(/%\{(\w+)\}/g, (m, name) => vars[name] ?? '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function* curl(args, io, sh) {
  const parsed = parseCurlArgs(args);
  if (parsed.error) { errOut(io, parsed.error); return parsed.code; }
  const o = parsed.opts;
  const showErrors = !o.silent || o.showError;
  if (!o.url) { errOut(io, 'curl: no URL specified'); return 2; }
  let u;
  try {
    u = new URL(o.url.includes('://') ? o.url : `http://${o.url}`);
  } catch {
    errOut(io, `curl: (3) URL using bad/illegal format or missing URL: ${o.url}`);
    return 3;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { errOut(io, `curl: (1) Protocol "${u.protocol}" not supported`); return 1; }
  let method = (o.head ? 'HEAD' : (o.method ?? (o.data !== null ? 'POST' : 'GET'))).toUpperCase();
  let body = o.data !== null ? Buffer.from(o.data) : undefined;
  const headers = { ...o.headers };
  if (body && !headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';
  let res;
  for (let hops = 0; ; hops++) {
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const path = `${u.pathname}${u.search}`;
    if (o.verbose) {
      errOut(io, `*   Trying ${u.hostname}:${port}...`);
      errOut(io, `> ${method} ${path} HTTP/1.1`);
      errOut(io, `> Host: ${u.host}`);
      for (const [k, v] of Object.entries(headers)) errOut(io, `> ${k}: ${v}`);
      errOut(io, '> ');
    }
    try {
      if (LOCAL_HOSTS.has(u.hostname)) {
        res = yield sh.can.vnet.request({ port, method, path, headers, body, timeout: 30_000 });
      } else if (sh.can.policy?.internet === false) {
        errOut(io, `curl: (7) network access is off for this can (network.internet is false), cannot reach ${u.hostname}`);
        return 7;
      } else {
        res = yield sendRemote(u, method, headers, body);
      }
    } catch (e) {
      const code = e.code === 'ETIMEDOUT' ? 28 : 7;
      if (showErrors) errOut(io, `curl: (${code}) Failed to connect to ${u.hostname} port ${port}: ${e.message}`);
      return code;
    }
    if (o.verbose) {
      errOut(io, `< HTTP/1.1 ${res.status} ${STATUS_CODES[res.status] ?? ''}`);
      for (const [k, v] of Object.entries(res.headers ?? {})) for (const x of [].concat(v)) errOut(io, `< ${k}: ${x}`);
      errOut(io, '< ');
    }
    if (!o.location || !REDIRECTS.has(res.status) || !res.headers?.location) break;
    if (hops >= MAX_REDIRECTS) {
      if (showErrors) errOut(io, `curl: (47) Maximum (${MAX_REDIRECTS}) redirects followed`);
      return 47;
    }
    u = new URL(String(res.headers.location), u);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
  }
  if (o.fail && res.status >= 400) {
    if (showErrors) errOut(io, `curl: (22) The requested URL returned error: ${res.status}`);
    return 22;
  }
  const headBlock = (o.include || o.head) ? curlHeadBlock(res) : '';
  const payload = o.head ? Buffer.alloc(0) : res.body;
  if (o.output !== null && o.output !== '-') {
    try {
      sh.can.vfs.writeFile(resolveIn(sh, o.output), payload);
    } catch (e) {
      if (showErrors) errOut(io, `curl: (23) Failure writing output to destination, ${e.message}`);
      return 23;
    }
    if (headBlock) io.stdout.write(headBlock);
  } else {
    if (headBlock) io.stdout.write(headBlock);
    io.stdout.write(payload);
  }
  if (o.writeOut !== null) io.stdout.write(curlWriteOut(o.writeOut, res, u.href));
  return 0;
}

function* ps(_args, io, sh) {
  const rows = sh.can.proc.list({ status: 'running' });
  io.stdout.write('  PID STATUS  COMMAND\n');
  for (const p of rows) io.stdout.write(`${String(p.pid).padStart(5)} running ${p.command}\n`);
  return 0;
}

const CORE = {
  pwd: function* (_a, io, sh) { io.stdout.write(`${sh.cwd}\n`); return 0; },
  cd,
  ls,
  echo: function* (args, io) {
    // Leading flags: -n (no newline), -e (interpret backslash escapes), combined as -ne or -en.
    let i = 0;
    let newline = true;
    let escapes = false;
    while (i < args.length && /^-[neE]+$/.test(args[i])) {
      if (args[i].includes('n')) newline = false;
      if (args[i].includes('e')) escapes = true;
      if (args[i].includes('E')) escapes = false;
      i++;
    }
    let text = args.slice(i).join(' ');
    if (escapes) text = unescapeText(text);
    io.stdout.write(`${text}${newline ? '\n' : ''}`);
    return 0;
  },
  printf: function* (args, io) {
    if (args.length === 0) { errOut(io, 'printf: usage: printf format [arguments...]'); return 1; }
    io.stdout.write(formatPrintf(args[0], args.slice(1)));
    return 0;
  },
  mkdir, rm, cp, mv, touch,
  env: function* (_a, io, sh) {
    for (const k of Object.keys(sh.env).sort()) io.stdout.write(`${k}=${sh.env[k]}\n`);
    return 0;
  },
  which: function* (args, io) {
    let status = 0;
    for (const name of args) {
      if (CORE_NAMES().has(name)) io.stdout.write(`/usr/bin/${name}\n`);
      else { errOut(io, `which: no ${name} in (${'/usr/local/bin:/usr/bin:/bin'})`); status = 1; }
    }
    return status;
  },
  ps,
  kill,
  sleep,
  jobs: function* (_a, io, sh) {
    const bg = sh.can.proc.list({ status: 'running' }).filter((p) => p.background);
    bg.forEach((p, k) => io.stdout.write(`[${k + 1}]  Running  ${p.command} (pid ${p.pid})\n`));
    return 0;
  },
  true: function* () { return 0; },
  false: function* () { return 1; },
  node,
  npm,
  pnpm,
  npx,
  curl,
  help: function* (_a, io) {
    io.stdout.write(`Built-in commands:\n  ${[...CORE_NAMES()].sort().join(' ')}\n`);
    return 0;
  },
};

/** Everything a can shell can run by name. */
export const BUILTINS = Object.assign(Object.create(null), CORE, TEXT_BUILTINS, UTIL_BUILTINS, SHELL_BUILTINS);

function CORE_NAMES() {
  return new Set(Object.keys(BUILTINS));
}
