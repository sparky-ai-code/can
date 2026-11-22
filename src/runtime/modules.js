// Virtual built-in modules for the can runtime. Each factory receives the JsRuntime of one program.
// fs / child_process / os / process / timers are backed by the can. The rest are pure helpers from
// node (no host I/O). Anything not listed in ALLOWED_BUILTINS is refused by JsRuntime.require.
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { posix } from 'node:path';
import {
  format, formatWithOptions, inspect, promisify, callbackify, inherits, isDeepStrictEqual, types, deprecate,
} from 'node:util';
import { Buffer } from 'node:buffer';
import * as nodeUrl from 'node:url';
import nodeCrypto from 'node:crypto';
import nodeQuerystring from 'node:querystring';
import { StringDecoder } from 'node:string_decoder';
import nodeAssert from 'node:assert';
import { createHttpModule } from './http.js';
import { makeSqliteModule, loadSqliteEngine } from './sqlite.js';
import { COMPAT_FACTORIES } from './compat.js';
import { makeNetModule } from './net.js';
import { makeShell, runShellSync } from './shell.js';
import { Collector, SyncInput } from './io.js';

export const ALLOWED_BUILTINS = new Set([
  'fs', 'fs/promises', 'path', 'http', 'https', 'events', 'url', 'util', 'buffer', 'timers', 'os',
  'process', 'child_process', 'crypto', 'stream', 'querystring', 'string_decoder', 'assert', 'module', 'sqlite', 'net',
  ...Object.keys(COMPAT_FACTORIES),
]);

/**
 * Built-ins that finish setting up asynchronously. An import of one waits for builtinReady before it runs, and
 * a module that imports one is treated as an async module (see JsRuntime.isAsyncModule).
 */
export const ASYNC_BUILTINS = new Set(['sqlite']);

/** Resolves when an async built-in is ready for use in program `rt`. Other built-ins are ready at once. */
export function builtinReady(rt, name) {
  if (name === 'sqlite') return loadSqliteEngine(rt);
  return Promise.resolve();
}

/**
 * The `module` built-in: createRequire() gives a require bound to a file's directory, which packages such as
 * msgpackr call (inside a try block) to load optional native add-ons. Nothing here reaches the host.
 */
function makeModuleBuiltin(rt) {
  // file:// URLs are read by hand: the host's fileURLToPath would map them to host paths on Windows.
  const toPath = (p) => (typeof p === 'string' && p.startsWith('file://') ? decodeURIComponent(p.slice('file://'.length)) : p);
  return {
    createRequire(filename) {
      const file = toPath(filename);
      if (typeof file !== 'string' || !file.startsWith('/')) {
        throw Object.assign(new TypeError("The argument 'filename' must be a file URL object, file URL string, or absolute path string"), { code: 'ERR_INVALID_ARG_VALUE' });
      }
      return rt._makeRequire(posix.dirname(file), null);
    },
    builtinModules: [...ALLOWED_BUILTINS].sort(),
    isBuiltin: (name) => ALLOWED_BUILTINS.has(String(name).replace(/^node:/, '')),
  };
}

const optsOf = (o) => (typeof o === 'string' ? { encoding: o } : (o ?? {}));

function makeFs(rt) {
  const v = rt.vfs;
  const abs = (p) => {
    if (typeof p !== 'string') throw Object.assign(new TypeError('The "path" argument must be of type string'), { code: 'ERR_INVALID_ARG_TYPE' });
    return v.resolve(p, rt.cwd);
  };
  const sync = {
    readFileSync: (p, o) => v.readFile(abs(p), optsOf(o).encoding ?? undefined),
    writeFileSync: (p, d, o) => v.writeFile(abs(p), d, optsOf(o)),
    appendFileSync: (p, d, o) => v.appendFile(abs(p), d, optsOf(o)),
    existsSync: (p) => { try { return v.exists(abs(p)); } catch { return false; } },
    statSync: (p, o) => {
      try { return v.stat(abs(p)); } catch (err) {
        if (o?.throwIfNoEntry === false && err.code === 'ENOENT') return undefined;
        throw err;
      }
    },
    lstatSync: (p) => v.lstat(abs(p)),
    readdirSync: (p, o) => v.readdir(abs(p), o),
    mkdirSync: (p, o) => v.mkdir(abs(p), o),
    rmSync: (p, o) => v.rm(abs(p), o),
    rmdirSync: (p, o) => (o?.recursive ? v.rm(abs(p), { recursive: true }) : v.rmdir(abs(p))),
    unlinkSync: (p) => v.unlink(abs(p)),
    renameSync: (a, b) => v.rename(abs(a), abs(b)),
    copyFileSync: (a, b) => v.copy(abs(a), abs(b)),
    cpSync: (a, b, o) => v.copy(abs(a), abs(b), { recursive: Boolean(o?.recursive) }),
    symlinkSync: (target, p) => v.symlink(target, abs(p)),
    readlinkSync: (p) => v.readlink(abs(p)),
    chmodSync: (p, mode) => v.chmod(abs(p), mode),
    utimesSync: (p, _atime, mtime) => v.utimes(abs(p), mtime),
    accessSync: (p) => { v.stat(abs(p)); },
    // Paths are normalized but symlinks are not expanded (the VFS has no realpath walk yet).
    realpathSync: (p) => abs(p),
  };

  const callback = {};
  for (const [name, fn] of Object.entries(sync)) {
    const base = name.slice(0, -4);
    callback[base] = (...args) => {
      const cb = args.pop();
      if (typeof cb !== 'function') throw Object.assign(new TypeError('The "cb" argument must be of type function'), { code: 'ERR_INVALID_ARG_TYPE' });
      let result;
      let error = null;
      try { result = fn(...args); } catch (err) { error = err; }
      rt.addTimer('timeout', () => {
        if (base === 'exists') cb(result === true);
        else if (error) cb(error);
        else cb(null, result);
      }, 0, []);
    };
  }

  const promises = {};
  for (const [name, fn] of Object.entries(sync)) {
    const base = name.slice(0, -4);
    if (base === 'exists') continue;
    promises[base] = (...args) => Promise.resolve().then(() => fn(...args));
  }

  // Streams are backed by the can's files. A write stream appends each chunk; 'w' truncates at open, as node does.
  // A read stream reads the file at open and emits it as one chunk. Errors go to 'error', as node reports them.
  // The program stays alive until a stream closes (rt.trackRequest), since node's stream callbacks run after the
  // main module returns and would otherwise be lost. A read stream nobody reads keeps the program alive too.
  const keepAliveUntilClosed = (stream) => {
    rt.trackRequest(new Promise((resolve) => {
      stream.once('close', resolve);
      stream.once('error', resolve);
    }));
  };
  const createWriteStream = (p, o) => {
    const opt = optsOf(o);
    const file = abs(p);
    const stream = new Writable({
      write(chunk, _enc, cb) {
        try { v.appendFile(file, chunk); cb(); } catch (err) { cb(err); }
      },
    });
    stream.path = p;
    // Only a stream that is ended is waited for: its finish callback is what the program needs to run.
    const end = stream.end;
    stream.end = function endWithKeepAlive(...args) {
      keepAliveUntilClosed(stream);
      return end.apply(this, args);
    };
    try {
      if (!String(opt.flags ?? 'w').startsWith('a')) v.writeFile(file, '');
      process.nextTick(() => { stream.emit('open', 3); stream.emit('ready'); });
    } catch (err) {
      process.nextTick(() => stream.destroy(err));
    }
    return stream;
  };
  const createReadStream = (p, o) => {
    const opt = optsOf(o);
    const stream = new PassThrough();
    stream.path = p;
    keepAliveUntilClosed(stream);
    try {
      const data = v.readFile(abs(p), opt.encoding ?? undefined);
      process.nextTick(() => { stream.emit('open', 3); stream.end(data); });
    } catch (err) {
      process.nextTick(() => stream.destroy(err));
    }
    return stream;
  };

  return {
    ...sync,
    ...callback,
    promises,
    createWriteStream,
    createReadStream,
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
  };
}

/** Quotes one argument for the can's shell. */
function shellQuote(arg) {
  const s = String(arg);
  return /^[\w/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function makeChildProcess(rt) {
  const proc = () => rt.can.proc;

  /** Starts a command in the can's shell. Output streams are fed live from the process table. */
  function spawnChild(command, opts = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const cwd = opts.cwd ? rt.vfs.resolve(opts.cwd, rt.cwd) : rt.cwd;
    const view = proc().spawn(command, { cwd, env: { ...rt.env, ...(opts.env ?? {}) } });
    child.pid = view.pid;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    const onOutput = (pid, stream, buf) => {
      if (pid !== view.pid) return;
      (stream === 'stdout' ? child.stdout : child.stderr).write(buf);
    };
    const onExit = (final) => {
      if (final.pid !== view.pid) return;
      proc().off('output', onOutput);
      proc().off('exit', onExit);
      child.exitCode = final.exitCode;
      child.signalCode = final.signal;
      child.stdout.end();
      child.stderr.end();
      rt.addTimer('timeout', () => {
        child.emit('exit', final.exitCode, final.signal);
        child.emit('close', final.exitCode, final.signal);
      }, 0, []);
    };
    proc().on('output', onOutput);
    proc().on('exit', onExit);
    child.kill = (signal = 'SIGTERM') => {
      try { proc().kill(view.pid, signal); child.killed = true; return true; } catch { return false; }
    };
    return child;
  }

  function collect(child, command, cb) {
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    rt.trackRequest(done.then(({ code, signal }) => {
      if (!cb) return;
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      let error = null;
      if (code !== 0 || signal) {
        error = Object.assign(new Error(`Command failed: ${command}\n${stderr}`), {
          code, killed: child.killed, signal, cmd: command,
        });
      }
      try { cb(error, stdout, stderr); } catch (e) { rt.fail(e); }
    }));
  }

  /** Runs a command line in the can's shell to completion. Nothing reaches the host. */
  function runSync(command, opts = {}) {
    const cwd = opts.cwd ? rt.vfs.resolve(String(opts.cwd), rt.cwd) : rt.cwd;
    const sh = makeShell({ can: rt.can, pid: rt.pid, cwd, env: { ...rt.env, ...(opts.env ?? {}) } });
    const out = new Collector();
    const err = new Collector();
    const input = opts.input === undefined || opts.input === null ? Buffer.alloc(0) : Buffer.from(opts.input);
    const status = runShellSync(command, sh, { stdin: new SyncInput(input), stdout: out, stderr: err });
    return { status, stdout: out.buffer(), stderr: err.buffer() };
  }

  const asEncoded = (buf, encoding) => (encoding && encoding !== 'buffer' ? buf.toString(encoding) : buf);

  /** Shared by execSync and execFileSync: stderr goes to the caller's stderr, a non-zero status throws. */
  function finishExec(command, opts) {
    const r = runSync(command, opts);
    if (r.stderr.length) rt.stderr.write(r.stderr);
    const stdout = asEncoded(r.stdout, opts.encoding);
    if (r.status !== 0) {
      const stderr = r.stderr.toString('utf8');
      throw Object.assign(new Error(`Command failed: ${command}\n${stderr}`), {
        status: r.status, signal: null, output: [null, stdout, asEncoded(r.stderr, opts.encoding)], pid: 0,
        stdout, stderr: asEncoded(r.stderr, opts.encoding),
      });
    }
    return stdout;
  }

  return {
    exec(command, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      const child = spawnChild(String(command), opts ?? {});
      collect(child, String(command), cb);
      return child;
    },
    execFile(file, args, opts, cb) {
      if (typeof args === 'function') { cb = args; args = []; opts = {}; }
      else if (!Array.isArray(args)) { cb = opts; opts = args; args = []; }
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      const command = [file, ...(args ?? [])].map(shellQuote).join(' ');
      const child = spawnChild(command, opts ?? {});
      collect(child, command, cb);
      return child;
    },
    spawn(file, args, opts) {
      if (!Array.isArray(args)) { opts = args; args = []; }
      const command = [file, ...(args ?? [])].map(shellQuote).join(' ');
      return spawnChild(command, opts ?? {});
    },
    execSync(command, opts) {
      return finishExec(String(command), opts ?? {});
    },
    execFileSync(file, args, opts) {
      if (!Array.isArray(args)) { opts = args; args = []; }
      const command = [file, ...(args ?? [])].map(shellQuote).join(' ');
      return finishExec(command, opts ?? {});
    },
    spawnSync(file, args, opts) {
      if (!Array.isArray(args)) { opts = args; args = []; }
      const o = opts ?? {};
      const command = [file, ...(args ?? [])].map(shellQuote).join(' ');
      const r = runSync(command, o);
      const stdout = asEncoded(r.stdout, o.encoding);
      const stderr = asEncoded(r.stderr, o.encoding);
      const result = { pid: 0, output: [null, stdout, stderr], stdout, stderr, status: r.status, signal: null };
      if (r.status === 127) {
        result.error = Object.assign(new Error(`spawnSync ${file} ENOENT`), {
          code: 'ENOENT', errno: -2, syscall: `spawnSync ${file}`, path: String(file), spawnargs: args,
        });
      }
      return result;
    },
  };
}

function makeTimers(rt) {
  return {
    setTimeout: (fn, ms, ...args) => rt.addTimer('timeout', fn, ms, args),
    setInterval: (fn, ms, ...args) => rt.addTimer('interval', fn, ms, args),
    setImmediate: (fn, ...args) => rt.addTimer('timeout', fn, 0, args),
    clearTimeout: (h) => rt.clearTimer(h),
    clearInterval: (h) => rt.clearTimer(h),
    clearImmediate: (h) => rt.clearTimer(h),
  };
}

const FACTORIES = {
  ...COMPAT_FACTORIES,
  fs: (rt) => makeFs(rt),
  'fs/promises': (rt) => makeFs(rt).promises,
  path: () => posix,
  http: (rt) => createHttpModule(rt, 'http'),
  https: (rt) => createHttpModule(rt, 'https'),
  events: () => EventEmitter,
  url: () => ({
    URL, URLSearchParams, parse: nodeUrl.parse, format: nodeUrl.format, resolve: nodeUrl.resolve,
  }),
  util: () => ({
    format, formatWithOptions, inspect, promisify, callbackify, inherits, isDeepStrictEqual, deprecate,
    types, TextEncoder, TextDecoder,
  }),
  buffer: () => ({ Buffer, constants: { MAX_LENGTH: 2 ** 32 } }),
  timers: (rt) => makeTimers(rt),
  os: (rt) => ({
    hostname: () => rt.can.name,
    platform: () => 'linux',
    type: () => 'Linux',
    arch: () => 'x64',
    release: () => '6.0.0-can',
    EOL: '\n',
    endianness: () => 'LE',
    cpus: () => [],
    totalmem: () => 2 ** 30,
    freemem: () => 2 ** 29,
    uptime: () => rt.process.uptime(),
    homedir: () => rt.env.HOME ?? '/home/agent',
    tmpdir: () => rt.env.TMPDIR ?? '/tmp',
    userInfo: () => ({
      uid: 1000, gid: 1000, username: rt.env.USER ?? 'agent',
      homedir: rt.env.HOME ?? '/home/agent', shell: rt.env.SHELL ?? '/bin/sh',
    }),
    networkInterfaces: () => ({}),
  }),
  process: (rt) => rt.process,
  child_process: (rt) => makeChildProcess(rt),
  crypto: () => nodeCrypto,
  // Streams run in the can's realm, so programs can subclass them (see src/runtime/sandbox/stream.js).
  stream: (rt) => rt.loadInternal('stream'),
  'stream/promises': (rt) => rt.loadInternal('stream/promises'),
  querystring: () => nodeQuerystring,
  string_decoder: () => ({ StringDecoder }),
  assert: () => nodeAssert,
  module: (rt) => makeModuleBuiltin(rt),
  sqlite: (rt) => makeSqliteModule(rt),
  net: (rt) => makeNetModule(rt),
};

/** Builds the virtual module `name` for one program. Called once per program by JsRuntime.builtin. */
export function loadBuiltin(rt, name) {
  const make = FACTORIES[name];
  if (!make) {
    const err = new Error(`Cannot find module '${name}': built-in module not available in this can`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return make(rt);
}
