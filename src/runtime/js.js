// JS runtime: runs CommonJS files from a can's VFS inside node:vm contexts with a virtual `require`.
// Nothing here touches host files, processes or ports. Built-in modules come from modules.js and are
// backed by the can (VFS, vnet, process table). Host-side I/O for outbound http(s) is in modules.js.
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { format } from 'node:util';
import { posix } from 'node:path';
import { builtinModules } from 'node:module';
import { URL, URLSearchParams } from 'node:url';
import { TextEncoder, TextDecoder } from 'node:util';
import { webcrypto } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { loadBuiltin, ALLOWED_BUILTINS, ASYNC_BUILTINS, builtinReady } from './modules.js';
import { needsEsm, toCommonJs, staticSpecs, withDynamicImport } from './esm.js';
import { Membrane, hardening } from '../vm/membrane.js';
import { installStackFilter, hostFreeStack } from '../vm/stacks.js';

/** The version the can reports as process.version: the policy's nodeVersion, else the runtime default. */
export function nodeVersionOf(can) {
  return can?.policy?.nodeVersion ?? NODE_VERSION;
}

/** A "#!/usr/bin/env node" first line is for the shell, not JavaScript. It is blanked, so line numbers stay put. */
export function stripShebang(source) {
  return source.startsWith('#!') ? source.replace(/^#![^\n]*/, '') : source;
}

const WRAP_HEAD = '(function (exports, require, module, __filename, __dirname) {';
const ASYNC_WRAP_HEAD = '(async function (exports, require, module, __filename, __dirname) {';
const WRAP_TAIL = '\n})';
const NODE_PATH = '/usr/local/bin/node';
const NODE_VERSION = 'v20.11.0';

/** Thrown by process.exit() to unwind synchronous user code. Never reaches the host. */
export class ProcessExit extends Error {
  constructor(code) {
    super(`process exited with code ${code}`);
    this.name = 'ProcessExit';
    this.code = code;
  }
}

class Timeout {
  constructor(key) { this._key = key; }
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
  refresh() { return this; }
  [Symbol.toPrimitive]() { return this._key; }
}

function notFound(spec) {
  const err = new Error(`Cannot find module '${spec}'`);
  err.code = 'MODULE_NOT_FOUND';
  return err;
}

function asyncRequireError(file) {
  const err = new Error(`require() cannot load '${file}': the module uses top-level await. Import it from an ES module or with import().`);
  err.code = 'ERR_REQUIRE_ASYNC_MODULE';
  return err;
}

const PATH_SPEC_RE = /^(\.{1,2}\/|\/|\.$|\.\.$)/;
const isPathSpec = (spec) => PATH_SPEC_RE.test(spec);

/** Conditions a package's `exports` field matches when a file is loaded (CommonJS-style, like require()). */
const EXPORT_CONDITIONS = new Set(['require', 'node', 'default']);
/** Conditions for an ES module's import (and dynamic import()). */
const IMPORT_CONDITIONS = new Set(['import', 'node', 'default']);

/** Splits `pkg/sub` and `@scope/pkg/sub` into the package name and a package.json subpath (`.` or `./sub`). */
export function splitPackageSpec(spec) {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  const rest = parts.slice(n).join('/');
  return { name: parts.slice(0, n).join('/'), subpath: rest ? `./${rest}` : '.' };
}

/** The target of one `exports` entry for a match (the text a `*` pattern captured). Returns a './' path, or null. */
function exportTarget(target, match, conditions) {
  if (typeof target === 'string') return target.startsWith('./') ? target.replaceAll('*', match) : null;
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = exportTarget(t, match, conditions);
      if (r) return r;
    }
    return null;
  }
  if (target && typeof target === 'object') {
    for (const [cond, value] of Object.entries(target)) {
      if (!conditions.has(cond)) continue;
      const r = exportTarget(value, match, conditions);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Resolves a package.json `exports` field for one subpath ('.' or './x'). Returns the './' path inside the package,
 * null when the field blocks the subpath (`"./x": null`, or no condition matches), or undefined when the field has
 * no entry for it at all.
 */
export function resolveExportsField(exportsField, subpath, conditions = EXPORT_CONDITIONS) {
  const isMap = exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)
    && Object.keys(exportsField).some((k) => k.startsWith('.'));
  if (!isMap) return subpath === '.' ? exportTarget(exportsField, '', conditions) : undefined;
  if (Object.prototype.hasOwnProperty.call(exportsField, subpath)) {
    return exportTarget(exportsField[subpath], '', conditions);
  }
  let best = null;
  for (const key of Object.keys(exportsField)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length < prefix.length + suffix.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (!best || prefix.length > best.prefixLength) {
      best = { key, prefixLength: prefix.length, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
    }
  }
  return best ? exportTarget(exportsField[best.key], best.match, conditions) : undefined;
}

/** Parsed package.json of a directory in the VFS, or null when there is none or it is not valid JSON. */
function readPackageJson(vfs, dir) {
  const p = posix.join(dir, 'package.json');
  try {
    if (!vfs.exists(p) || !vfs.stat(p).isFile()) return null;
    return JSON.parse(vfs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Compiled-as-a-function probe results, keyed by absolute path. A module is re-probed only if its source changes. */
const awaitProbeCache = new Map();

/**
 * True when an ES module uses `await` outside every function (top-level await). The engine's own parser decides:
 * the body is compiled as a plain function, and the one error it reports for a top-level await is what counts.
 * Nothing is run.
 */
export function awaitsAtTopLevel(src, file) {
  const cached = awaitProbeCache.get(file);
  if (cached && cached.src === src) return cached.result;
  // The module needs the async path exactly when its async form compiles and its plain form does not. Only `await`
  // (and `for await`) can make that difference, so this does not depend on the wording of the engine's error.
  const compiles = (head, code) => {
    try {
      new vm.Script(head + code + WRAP_TAIL, { filename: file });
      return true;
    } catch {
      return false;
    }
  };
  let result = false;
  try {
    const plain = toCommonJs(src, file, { async: false });
    if (!compiles(WRAP_HEAD, plain)) {
      result = compiles(ASYNC_WRAP_HEAD, toCommonJs(src, file, { async: true }));
    }
  } catch {
    result = false; // a syntax problem that the real load reports
  }
  awaitProbeCache.set(file, { src, result });
  return result;
}

/** True when `abs` is `module` or one of its importers (a cycle, so waiting on it would deadlock). */
function inChain(module, abs) {
  for (let m = module; m; m = m.parent) if (m.id === abs) return true;
  return false;
}

/** One running JS program. Owns its vm context, module cache, timers and listening ports. */
export class JsRuntime {
  /**
   * @param {object} opts
   * @param {object} opts.can owning Can
   * @param {number} opts.pid
   * @param {string} opts.cwd absolute VFS path
   * @param {Record<string,string>} opts.env
   * @param {string[]} [opts.args] arguments after the script path
   * @param {import('node:stream').Writable} opts.stdout
   * @param {import('node:stream').Writable} opts.stderr
   * @param {import('node:stream').Readable} [opts.stdin]
   * @param {Map<string,string>} [opts.sources] in-memory source overrides keyed by absolute path (node -e)
   */
  constructor({ can, pid, cwd, env, args = [], stdout, stderr, stdin, sources = new Map(), preload = [] }) {
    this.sources = sources;
    this.preload = preload; // absolute paths run as CommonJS before the main file (node --require)
    this.can = can;
    this.vfs = can.vfs;
    this.vnet = can.vnet;
    this.pid = pid;
    this.cwd = cwd;
    this.env = env;
    this.args = args;
    this.argv = [];
    this.stdout = stdout;
    this.stderr = stderr;
    this.stdin = stdin;
    this.exitCodeValue = undefined;
    this.timers = new Map(); // key -> { handle, repeat }
    this.nextKey = 1;
    this.ports = new Set(); // vnet ports this program listens on
    this.pending = 0; // in-flight outbound requests
    this.cache = new Map(); // abs path -> Module
    this.builtinCache = new Map();
    this.finished = false;
    this.mainDone = false;
    this.done = new Promise((resolve) => { this._resolveDone = resolve; });
    this.process = this._makeProcess();
    this.context = this._makeContext();
  }

  /** Runs an absolute VFS script. Resolves with the exit code once no timers, ports or requests remain. */
  start(file) {
    this.argv = [NODE_PATH, file, ...this.args];
    this.process.argv = [...this.argv];
    let mod;
    try {
      for (const pre of this.preload) this.loadModule(pre, null, true);
      this.loadModule(file, null, false);
      mod = this.cache.get(file);
    } catch (err) {
      this.fail(err);
      return this.done;
    }
    // An entry that uses top-level await finishes later; its errors end the program.
    if (mod?.evaluation) {
      mod.evaluation.then(() => { this.mainDone = true; this.checkAlive(); }, (err) => this.fail(err));
    } else {
      this.mainDone = true;
      this.checkAlive();
    }
    return this.done;
  }

  // ---- lifecycle ----------------------------------------------------------

  isAlive() {
    return this.timers.size > 0 || this.ports.size > 0 || this.pending > 0;
  }

  checkAlive() {
    if (!this.finished && this.mainDone && !this.isAlive()) this.finish(this.exitCodeValue ?? 0);
  }

  /** Ends the program: clears timers, closes its ports, emits 'exit' and resolves `done`. */
  finish(code) {
    if (this.finished) return;
    this.finished = true;
    this.resultCode = code;
    for (const { handle, repeat } of this.timers.values()) {
      if (repeat) clearInterval(handle); else clearTimeout(handle);
    }
    this.timers.clear();
    for (const port of this.ports) this.vnet.close(port);
    this.ports.clear();
    try {
      this.process.emit('exit', code);
    } catch (err) {
      this.stderr.write(`${hostFreeStack(err?.stack) ?? err}\n`);
    }
    this._resolveDone(code);
  }

  /** process.exit: finishes the program and unwinds the current synchronous call stack. */
  exit(code) {
    const c = code === undefined || code === null ? (this.exitCodeValue ?? 0) : Number(code) | 0;
    this.finish(c);
    throw new ProcessExit(c);
  }

  /** Uncaught error: print it like node does and exit 1. */
  fail(err) {
    // A ProcessExit that crossed the membrane arrives as a sandbox-realm copy with the same name.
    if (err instanceof ProcessExit || err?.name === 'ProcessExit') return;
    this.stderr.write(`${hostFreeStack(err?.stack) ?? String(err)}\n`);
    this.finish(1);
  }

  // ---- timers, ports, requests (called by builtins) -----------------------

  addTimer(kind, fn, ms, args) {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
    const key = this.nextKey++;
    const repeat = kind === 'interval';
    const run = () => {
      if (this.finished) return;
      if (!repeat) this.timers.delete(key);
      try {
        fn(...args);
      } catch (err) {
        this.fail(err);
        return;
      }
      this.checkAlive();
    };
    const delay = Math.max(1, Number(ms) || 1);
    const handle = repeat ? setInterval(run, delay) : setTimeout(run, delay);
    this.timers.set(key, { handle, repeat });
    return new Timeout(key);
  }

  clearTimer(h) {
    const key = typeof h === 'object' && h !== null ? h._key : h;
    const entry = this.timers.get(key);
    if (!entry) return;
    clearTimeout(entry.handle);
    this.timers.delete(key);
    this.checkAlive();
  }

  addPort(port) { this.ports.add(port); }

  removePort(port) {
    this.ports.delete(port);
    this.checkAlive();
  }

  /** Tracks an outbound request so the program stays alive until it settles. */
  trackRequest(promise) {
    this.pending++;
    const settle = () => { this.pending--; this.checkAlive(); };
    promise.then(settle, settle);
    return promise;
  }

  // ---- modules ------------------------------------------------------------

  /**
   * Runs a file as a CommonJS module (or parses JSON). Returns module.exports. An ES module that uses top-level
   * await, or imports one, is async: its exports come back before it finishes, and `module.evaluation` settles
   * when it does. With `sync` (a plain require()), such a module is refused.
   */
  loadModule(abs, parent, sync = false) {
    const cached = this.cache.get(abs);
    if (cached) {
      if (sync && cached.async && !cached.loaded) throw asyncRequireError(abs);
      return cached.exports;
    }
    const module = { id: abs, filename: abs, exports: {}, loaded: false, parent, async: false };
    this.cache.set(abs, module);
    try {
      const raw = this.sources.get(abs) ?? this.vfs.readFile(abs, 'utf8');
      const src = raw.replace(/^﻿/, '');
      if (abs.endsWith('.json')) {
        module.exports = vm.runInContext('JSON.parse', this.context)(src);
      } else {
        const dir = posix.dirname(abs);
        const esm = needsEsm(abs, src);
        const isAsync = esm && this.isAsyncModule(abs, src);
        if (isAsync && sync) throw asyncRequireError(abs);
        module.async = isAsync;
        const body = stripShebang(src);
        const code = esm ? toCommonJs(body, abs, { async: isAsync }) : withDynamicImport(body);
        const script = new vm.Script((isAsync ? ASYNC_WRAP_HEAD : WRAP_HEAD) + code + WRAP_TAIL, { filename: abs });
        const fn = script.runInContext(this.context);
        // Host values cross into the sandbox only through the membrane (layer 2).
        const m = this.membrane;
        const args = [module.exports, this._makeRequire(dir, module, esm), module, abs, dir].map((a) => m.sandbox(a));
        const ret = fn.apply(m.sandbox(module.exports), args);
        if (isAsync) {
          module.evaluation = Promise.resolve(ret).then(() => {
            module.loaded = true;
          }, (err) => {
            this.cache.delete(abs);
            throw err;
          });
          // Whoever awaits `evaluation` sees the error. This stops it being reported as unhandled first.
          module.evaluation.catch(() => {});
          return module.exports;
        }
      }
    } catch (err) {
      this.cache.delete(abs);
      throw err;
    }
    module.loaded = true;
    return module.exports;
  }

  /** True when an ES module must run as async: it has top-level await, or it imports such a module. */
  isAsyncModule(abs, src, seen = new Set()) {
    if (seen.has(abs)) return false;
    seen.add(abs);
    if (awaitsAtTopLevel(src, abs)) return true;
    const dir = posix.dirname(abs);
    for (const spec of staticSpecs(src)) {
      if (ASYNC_BUILTINS.has(spec.startsWith('node:') ? spec.slice(5) : spec)) return true;
      let target;
      try {
        target = this.resolveSpec(spec, dir, true);
      } catch {
        continue; // a builtin, or a missing module that fails when the import runs
      }
      const cached = this.cache.get(target);
      if (cached) {
        if (cached.async) return true;
        continue;
      }
      if (target.endsWith('.json')) continue;
      let text;
      try {
        text = this.sources.get(target) ?? this.vfs.readFile(target, 'utf8');
      } catch {
        continue;
      }
      if (needsEsm(target, text) && this.isAsyncModule(target, text, seen)) return true;
    }
    return false;
  }

  /** require() that waits for an async ES module to finish. Used by `import` and dynamic `import()`. */
  async requireAsync(spec, dir, parent, esm = false) {
    if (typeof spec !== 'string') return this.require(spec, dir, parent);
    const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
    if (!isPathSpec(spec) && (ALLOWED_BUILTINS.has(bare) || builtinModules.includes(bare))) {
      // Builtins are synchronous, except the few that finish setting up first (see ASYNC_BUILTINS).
      if (ASYNC_BUILTINS.has(bare)) await builtinReady(this, bare);
      return this.require(spec, dir, parent);
    }
    const target = this.resolveSpec(spec, dir, esm);
    const exports = this.loadModule(target, parent, false);
    const mod = this.cache.get(target);
    if (mod?.evaluation && !mod.loaded && !inChain(parent, target)) await mod.evaluation;
    return exports;
  }

  _makeRequire(dir, module, esm = false) {
    const req = (spec) => this.require(spec, dir, module, esm);
    req.resolve = (spec) => this.resolveSpec(spec, dir, esm);
    req.async = (spec) => this.requireAsync(spec, dir, module, esm);
    // A pending import() keeps the program alive until it settles, like an outbound request does.
    req.importAsync = (spec) => this.trackRequest(this.requireAsync(spec, dir, module, true));
    req.cache = Object.create(null);
    req.main = this.cache.get(this.argv[1]) ?? undefined;
    return req;
  }

  require(spec, dir, parent, esm = false) {
    if (typeof spec !== 'string') {
      const err = new TypeError('The "id" argument must be of type string');
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    const isPath = isPathSpec(spec);
    if (!isPath) {
      const name = spec.startsWith('node:') ? spec.slice(5) : spec;
      if (ALLOWED_BUILTINS.has(name)) return this.builtin(name);
      if (builtinModules.includes(name)) {
        const err = new Error(`Cannot find module '${spec}': built-in module '${name}' is not available in this can`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
    }
    return this.loadModule(this.resolveSpec(spec, dir, esm), parent, true);
  }

  builtin(name) {
    if (!this.builtinCache.has(name)) this.builtinCache.set(name, loadBuiltin(this, name));
    return this.builtinCache.get(name);
  }

  /** Resolves a relative/absolute path or a node_modules package to an absolute VFS file. */
  resolveSpec(spec, dir, esm = false) {
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || spec === '.' || spec === '..') {
      const abs = this.vfs.resolve(spec, dir);
      const found = this._tryFile(abs) ?? this._tryDir(abs);
      if (found) return found;
      throw notFound(spec);
    }
    const { name, subpath } = splitPackageSpec(spec);
    let d = dir;
    for (;;) {
      // A package with an `exports` field resolves through it, as node does. A subpath the field blocks is not found.
      const pkgDir = posix.join(d, 'node_modules', name);
      const pkg = readPackageJson(this.vfs, pkgDir);
      if (pkg && pkg.exports !== undefined) {
        // The importer's own conditions first (import for an ES module, require otherwise), then the other set.
        const primary = esm ? IMPORT_CONDITIONS : EXPORT_CONDITIONS;
        const secondary = esm ? EXPORT_CONDITIONS : IMPORT_CONDITIONS;
        let target = resolveExportsField(pkg.exports, subpath, primary);
        if (target === null || target === undefined) target = resolveExportsField(pkg.exports, subpath, secondary);
        if (target === null) throw notFound(spec);
        if (typeof target === 'string') {
          const found = this._tryFile(posix.join(pkgDir, target));
          if (found) return found;
        }
      }
      const candidate = posix.join(d, 'node_modules', spec);
      const found = this._tryFile(candidate) ?? this._tryDir(candidate);
      if (found) return found;
      if (d === '/') break;
      d = posix.dirname(d);
    }
    throw notFound(spec);
  }

  _isFile(p) { return this.vfs.exists(p) && this.vfs.stat(p).isFile(); }
  _isDir(p) { return this.vfs.exists(p) && this.vfs.stat(p).isDirectory(); }

  _tryFile(abs) {
    for (const cand of [abs, `${abs}.js`, `${abs}.cjs`, `${abs}.json`]) {
      if (this._isFile(cand)) return cand;
    }
    return null;
  }

  _tryDir(abs) {
    if (!this._isDir(abs)) return null;
    const pkgPath = posix.join(abs, 'package.json');
    if (this._isFile(pkgPath)) {
      const pkg = JSON.parse(this.vfs.readFile(pkgPath, 'utf8'));
      if (typeof pkg.main === 'string' && pkg.main !== '') {
        const main = posix.resolve(abs, pkg.main);
        const found = this._tryFile(main) ?? this._tryDir(main);
        if (found) return found;
      }
    }
    return this._tryFile(posix.join(abs, 'index'));
  }

  // ---- globals ------------------------------------------------------------

  _makeProcess() {
    const rt = this;
    const p = new EventEmitter();
    Object.assign(p, {
      argv: [],
      env: this.env,
      pid: this.pid,
      ppid: 0,
      platform: 'linux',
      arch: 'x64',
      version: nodeVersionOf(rt.can),
      versions: { node: nodeVersionOf(rt.can).slice(1) },
      execPath: NODE_PATH,
      title: 'node',
      execArgv: [],
      cwd: () => rt.cwd,
      chdir(dir) {
        const abs = rt.vfs.resolve(dir, rt.cwd);
        if (!rt._isDir(abs)) throw Object.assign(new Error(`ENOENT: no such file or directory, chdir '${dir}'`), { code: 'ENOENT' });
        rt.cwd = abs;
      },
      exit: (code) => rt.exit(code),
      nextTick(fn, ...args) {
        Promise.resolve().then(() => fn(...args)).catch((err) => rt.fail(err));
      },
      uptime: () => (Date.now() - rt.startedAt) / 1000,
      hrtime: Object.assign((prev) => {
        const ns = process.hrtime.bigint();
        const [s, n] = [ns / 1000000000n, ns % 1000000000n];
        if (!prev) return [Number(s), Number(n)];
        let ds = s - BigInt(prev[0]);
        let dn = n - BigInt(prev[1]);
        if (dn < 0n) { ds -= 1n; dn += 1000000000n; }
        return [Number(ds), Number(dn)];
      }, { bigint: () => process.hrtime.bigint() }),
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      umask: () => 0o22,
      // Prints a warning to stderr in node's form: "(node:PID) [CODE] Type: message". Node's --trace-warnings is not
      // offered, so the stack line that follows it is not printed.
      emitWarning(warning, typeOrOptions, code) {
        let type = 'Warning';
        let warnCode = code;
        if (typeof typeOrOptions === 'string') type = typeOrOptions;
        else if (typeOrOptions && typeof typeOrOptions === 'object') {
          type = typeOrOptions.type ?? type;
          warnCode = typeOrOptions.code ?? warnCode;
        }
        const isError = warning instanceof Error;
        const name = isError ? warning.name : type;
        const message = isError ? warning.message : String(warning);
        rt.stderr.write(`(node:${rt.pid}) ${warnCode ? `[${warnCode}] ` : ''}${name}: ${message}\n`);
      },
      getuid: () => 1000,
      getgid: () => 1000,
      stdout: { write: (s) => { rt.stdout.write(s); return true; }, isTTY: false },
      stderr: { write: (s) => { rt.stderr.write(s); return true; }, isTTY: false },
      stdin: rt.stdin,
    });
    Object.defineProperty(p, 'exitCode', {
      enumerable: true,
      get: () => rt.exitCodeValue,
      set: (v) => { rt.exitCodeValue = v; },
    });
    this.startedAt = Date.now();
    return p;
  }

  _makeContext() {
    const rt = this;
    const writer = (stream) => (...args) => { stream.write(`${format(...args)}\n`); };
    const globals = {
      console: {
        log: writer(this.stdout), info: writer(this.stdout), debug: writer(this.stdout),
        error: writer(this.stderr), warn: writer(this.stderr),
      },
      process: this.process,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      // Web globals that are pure (no host I/O): cancellation, events, copying, base64, timing and random values.
      AbortController,
      AbortSignal,
      Event,
      EventTarget,
      structuredClone,
      atob,
      btoa,
      performance,
      crypto: webcrypto,
      setTimeout: (fn, ms, ...args) => rt.addTimer('timeout', fn, ms, args),
      setInterval: (fn, ms, ...args) => rt.addTimer('interval', fn, ms, args),
      setImmediate: (fn, ...args) => rt.addTimer('timeout', fn, 0, args),
      clearTimeout: (h) => rt.clearTimer(h),
      clearInterval: (h) => rt.clearTimer(h),
      clearImmediate: (h) => rt.clearTimer(h),
      queueMicrotask: (fn) => { Promise.resolve().then(fn).catch((err) => rt.fail(err)); },
    };
    // The global starts with no prototype, so nothing from the host Object.prototype is reachable.
    // Context code generation (eval, Function from strings) is off in hardened mode.
    const sandbox = Object.create(null);
    const options = { name: `can:${this.can.name}` };
    if (hardening.enabled) options.codeGeneration = { strings: false, wasm: false };
    const context = vm.createContext(sandbox, options);
    installStackFilter(context);
    this.membrane = new Membrane(context);
    for (const [key, value] of Object.entries(globals)) sandbox[key] = this.membrane.sandbox(value);
    sandbox.global = sandbox;
    return context;
  }
}

/**
 * Starts a JS file from the VFS as the main program of a process. The main module runs before this
 * returns, so `rt.finished` tells a caller whether the program already ended (rt.resultCode). Otherwise
 * `rt.done` resolves with the exit code. `signal` aborts (kill): timers and ports are closed at once.
 */
export function startJsFile({ file, signal, ...opts }) {
  // `file` may be a virtual path that exists only in opts.sources (used by node -e).
  const rt = new JsRuntime(opts);
  if (signal) {
    if (signal.aborted) rt.finish(130);
    else signal.addEventListener('abort', () => rt.finish(130), { once: true });
  }
  if (!rt.finished) rt.start(file);
  return rt;
}

/**
 * Syntax check for node --check: compiles the source the way a load would, without running it. Returns null when it
 * compiles, else the SyntaxError.
 */
export function checkSyntax(src, file) {
  const body = stripShebang(src.replace(/^﻿/, ''));
  try {
    if (needsEsm(file, body)) {
      const isAsync = awaitsAtTopLevel(body, file);
      const head = isAsync ? ASYNC_WRAP_HEAD : WRAP_HEAD;
      new vm.Script(head + toCommonJs(body, file, { async: isAsync }) + WRAP_TAIL, { filename: file });
    } else {
      new vm.Script(WRAP_HEAD + withDynamicImport(body) + WRAP_TAIL, { filename: file });
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** Runs a JS file and resolves with its exit code. */
export function runJsFile(opts) {
  return startJsFile(opts).done;
}
