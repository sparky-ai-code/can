// Built-ins a can's programs import at load time, so that the Node packages they use can load. Two kinds:
//   - pure helpers, passed through from node (no host I/O): zlib, async_hooks, perf_hooks, constants, ...
//   - backed by the can: readline reads the program's stdin, timers/promises uses the can's timers, console writes to
//     the program's stdout and stderr.
// net is in net.js: it runs on the can's virtual network. Modules that can reach workers, other contexts, the
// debugger or DNS (dns, dgram, worker_threads, vm, inspector, http2) are deliberately absent. They are refused
// (see test/runtime.test.js). Nothing here touches host files, processes or ports.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { format, types as utilTypes } from 'node:util';
import nodeReadline from 'node:readline';
import nodeZlib from 'node:zlib';
import nodeAsyncHooks from 'node:async_hooks';
import nodePerfHooks from 'node:perf_hooks';
import nodeConstants from 'node:constants';
import nodeDiagnostics from 'node:diagnostics_channel';
import nodeAssertStrict from 'node:assert/strict';
import nodeStreamPromises from 'node:stream/promises';
import nodeStreamWeb from 'node:stream/web';
import { makeConsole } from './console.js';

/** `readline`: interfaces read the program's stdin. Output and cursor control are not drawn anywhere. */
function makeReadline(rt) {
  return {
    createInterface() {
      return nodeReadline.createInterface({ input: rt.stdin ?? new PassThrough(), terminal: false, crlfDelay: Infinity });
    },
    emitKeypressEvents() {},
    clearLine: () => true,
    clearScreenDown: () => true,
    cursorTo: () => true,
    moveCursor: () => true,
  };
}

/** `timers/promises`: setTimeout and setImmediate as promises, on the can's own timers. */
function makeTimersPromises(rt) {
  const after = (ms, value) => new Promise((resolve) => {
    rt.addTimer('timeout', () => resolve(value), ms, []);
  });
  return {
    setTimeout: (ms = 0, value) => after(ms, value),
    setImmediate: (value) => after(0, value),
  };
}

/** `console`: the program's own console, as a module (the same object as the global). */
function consoleModule(rt) {
  return makeConsole(rt.stdout, rt.stderr);
}

/** `tty`: no program has a terminal here. */
function makeTty() {
  return {
    isatty: () => false,
    ReadStream: class ReadStream extends PassThrough {},
    WriteStream: class WriteStream extends PassThrough {},
  };
}

function notSupported(what) {
  const err = new Error(`${what} is not available in this can`);
  err.code = 'ENOTSUP';
  return err;
}

/**
 * `tls`: loads, so packages that import it at load time (ws does) can start. Secure sockets are not offered: calling
 * connect or createServer throws ENOTSUP. Plain sockets are in net.
 */
function makeTls() {
  class TLSSocket extends EventEmitter {}
  class Server extends EventEmitter {}
  return {
    TLSSocket,
    Server,
    connect: () => { throw notSupported('tls.connect'); },
    createServer: () => { throw notSupported('tls.createServer'); },
    createSecureContext: () => { throw notSupported('tls.createSecureContext'); },
    DEFAULT_MIN_VERSION: 'TLSv1.2',
    DEFAULT_MAX_VERSION: 'TLSv1.3',
  };
}

/** Name -> factory (rt) => module, for every built-in in this file. */
export const COMPAT_FACTORIES = {
  zlib: () => nodeZlib,
  async_hooks: () => nodeAsyncHooks,
  perf_hooks: () => nodePerfHooks,
  constants: () => nodeConstants,
  diagnostics_channel: () => nodeDiagnostics,
  'assert/strict': () => nodeAssertStrict,
  'stream/promises': () => nodeStreamPromises,
  'stream/web': () => nodeStreamWeb,
  'util/types': () => utilTypes,
  readline: (rt) => makeReadline(rt),
  'timers/promises': (rt) => makeTimersPromises(rt),
  console: (rt) => consoleModule(rt),
  tty: () => makeTty(),
  tls: () => makeTls(),
};
