'use strict';
// The `stream` module for a can's programs, written to run INSIDE the can's realm (see JsRuntime.loadInternal).
//
// Why this exists: node's own stream classes are host objects. A program that subclasses them the ES5 way
// (`function X(o) { Transform.call(this, o); }`, which iconv-lite and many packages do) gets a sandbox object whose
// state the host constructor never sees, so the first use throws. The classes here are sandbox functions, so
// `Transform.call(this)` initialises the object the program holds. Host code still works with them: it calls their
// methods (write, end, on, emit, pipe) through the membrane, as it does with any sandbox object.
//
// Scope: the behaviour Express, body-parser, raw-body, iconv-lite, compression-style middleware and the usual
// pipeline code rely on: flowing and paused modes, read(), push(), write() with backpressure, cork, end, finish,
// destroy with 'error' then 'close', pipe and unpipe, setEncoding, async iteration, Readable.from, pipeline and
// finished. Node's internal state fields are not reproduced; the public properties are.

const nextTick = (typeof process !== 'undefined' && process && typeof process.nextTick === 'function')
  ? (fn, ...args) => process.nextTick(fn, ...args)
  : (fn, ...args) => { Promise.resolve().then(() => fn(...args)); };

// Host buffers reach this realm as membrane proxies. ArrayBuffer.isView is false for a Proxy, but Buffer.isBuffer
// unwraps its argument, so it is the check to use.
function isBinary(chunk) {
  return Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk);
}
function toBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function codedError(Ctor, code, message) {
  const err = new Ctor(message);
  err.code = code;
  return err;
}

// ---- EventEmitter (ES5-callable, so subclasses can call it) -----------------------------------------------

function EventEmitter(options) {
  EventEmitter.init.call(this, options);
}
EventEmitter.defaultMaxListeners = 10;
EventEmitter.init = function init() {
  if (!this._events) {
    this._events = Object.create(null);
    this._eventsCount = 0;
  }
  if (this._maxListeners === undefined) this._maxListeners = undefined;
};

function wrapOnce(target, type, listener) {
  const state = { fired: false, target, type, listener };
  const wrapped = function onceWrapper(...args) {
    if (state.fired) return undefined;
    state.target.removeListener(state.type, wrapped);
    state.fired = true;
    return state.listener.apply(state.target, args);
  };
  wrapped.listener = listener;
  return wrapped;
}

function addListener(target, type, listener, prepend, once) {
  if (typeof listener !== 'function') {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "listener" argument must be of type function. Received ${typeof listener}`);
  }
  if (!target._events) EventEmitter.init.call(target);
  if (target._events.newListener !== undefined) {
    target.emit('newListener', type, listener.listener ?? listener);
  }
  const entry = once ? wrapOnce(target, type, listener) : listener;
  const existing = target._events[type];
  if (existing === undefined) {
    target._events[type] = entry;
    target._eventsCount++;
  } else if (typeof existing === 'function') {
    target._events[type] = prepend ? [entry, existing] : [existing, entry];
  } else if (prepend) {
    existing.unshift(entry);
  } else {
    existing.push(entry);
  }
  return target;
}

EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) { this._maxListeners = n; return this; };
EventEmitter.prototype.getMaxListeners = function getMaxListeners() { return this._maxListeners ?? EventEmitter.defaultMaxListeners; };
EventEmitter.prototype.on = function on(type, listener) { return addListener(this, type, listener, false, false); };
EventEmitter.prototype.addListener = EventEmitter.prototype.on;
EventEmitter.prototype.prependListener = function prependListener(type, listener) { return addListener(this, type, listener, true, false); };
EventEmitter.prototype.once = function once(type, listener) { return addListener(this, type, listener, false, true); };
EventEmitter.prototype.prependOnceListener = function prependOnceListener(type, listener) { return addListener(this, type, listener, true, true); };

EventEmitter.prototype.removeListener = function removeListener(type, listener) {
  const events = this._events;
  if (!events) return this;
  const list = events[type];
  if (list === undefined) return this;
  if (list === listener || list.listener === listener) {
    if (--this._eventsCount === 0) this._events = Object.create(null);
    else delete events[type];
  } else if (typeof list !== 'function') {
    let index = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === listener || list[i].listener === listener) { index = i; break; }
    }
    if (index < 0) return this;
    list.splice(index, 1);
    if (list.length === 1) events[type] = list[0];
  } else {
    return this;
  }
  if (events.removeListener) this.emit('removeListener', type, listener);
  return this;
};
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

EventEmitter.prototype.removeAllListeners = function removeAllListeners(type) {
  if (!this._events) return this;
  if (type === undefined) {
    this._events = Object.create(null);
    this._eventsCount = 0;
  } else if (this._events[type] !== undefined) {
    if (--this._eventsCount === 0) this._events = Object.create(null);
    else delete this._events[type];
  }
  return this;
};

EventEmitter.prototype.emit = function emit(type, ...args) {
  const events = this._events;
  if (type === 'error' && (!events || events.error === undefined)) {
    const er = args[0];
    if (er instanceof Error) throw er;
    const err = new Error(`Unhandled error. (${er})`);
    err.code = 'ERR_UNHANDLED_ERROR';
    err.context = er;
    throw err;
  }
  if (!events) return false;
  const handler = events[type];
  if (handler === undefined) return false;
  if (typeof handler === 'function') {
    handler.apply(this, args);
  } else {
    for (const fn of handler.slice()) fn.apply(this, args);
  }
  return true;
};

function listenersOf(target, type, unwrap) {
  const list = target._events && target._events[type];
  if (list === undefined) return [];
  if (typeof list === 'function') return [unwrap ? list.listener ?? list : list];
  return list.map((fn) => (unwrap ? fn.listener ?? fn : fn));
}
EventEmitter.prototype.listeners = function listeners(type) { return listenersOf(this, type, true); };
EventEmitter.prototype.rawListeners = function rawListeners(type) { return listenersOf(this, type, false); };
EventEmitter.prototype.listenerCount = function listenerCount(type) {
  const list = this._events && this._events[type];
  if (list === undefined) return 0;
  return typeof list === 'function' ? 1 : list.length;
};
EventEmitter.prototype.eventNames = function eventNames() {
  return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
};
EventEmitter.EventEmitter = EventEmitter;

// ---- shared helpers ----------------------------------------------------------------------------------------

function Stream(options) {
  EventEmitter.call(this, options);
}
Stream.prototype = Object.create(EventEmitter.prototype, { constructor: { value: Stream, writable: true, configurable: true } });

function destroyImpl(stream, err, cb) {
  const r = stream._readableState;
  const w = stream._writableState;
  if ((r && r.destroyed) || (w && w.destroyed)) {
    if (typeof cb === 'function') cb(err ?? null);
    return stream;
  }
  if (r) r.destroyed = true;
  if (w) w.destroyed = true;
  let finished = false;
  const finish = (e) => {
    if (finished) return;
    finished = true;
    const error = e ?? err ?? null;
    if (error && r) r.errored = error;
    if (error && w) w.errored = error;
    if (typeof cb === 'function') cb(error);
    nextTick(() => {
      if (error) stream.emit('error', error);
      if (!r || r.emitClose !== false) {
        if (r) r.closed = true;
        if (w) w.closed = true;
        stream.emit('close');
      }
    });
  };
  if (typeof stream._destroy === 'function') stream._destroy(err ?? null, finish);
  else finish(null);
  return stream;
}

function autoDestroyIfDone(stream) {
  const r = stream._readableState;
  const w = stream._writableState;
  const readDone = !r || r.endEmitted;
  const writeDone = !w || w.finished;
  if (readDone && writeDone && ((r && r.autoDestroy) || (w && w.autoDestroy)) && !(r && r.destroyed) && !(w && w.destroyed)) {
    destroyImpl(stream, null);
  }
}

// ---- Readable ----------------------------------------------------------------------------------------------

function ReadableState(options) {
  const objectMode = !!(options && (options.objectMode || options.readableObjectMode));
  this.objectMode = objectMode;
  this.highWaterMark = (options && (options.readableHighWaterMark ?? options.highWaterMark)) ?? (objectMode ? 16 : 16384);
  this.buffer = [];
  this.length = 0;
  this.pipes = [];
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;
  this.sync = true;
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;
  this.readingMore = false;
  this.destroyed = false;
  this.errored = null;
  this.closed = false;
  this.encoding = null;
  this.decoder = null;
  this.autoDestroy = !options || options.autoDestroy !== false;
  this.emitClose = !options || options.emitClose !== false;
}

function Readable(options) {
  this._readableState = new ReadableState(options);
  if (options) {
    if (typeof options.read === 'function') this._read = options.read;
    if (typeof options.destroy === 'function') this._destroy = options.destroy;
  }
  EventEmitter.init.call(this, options);
  Stream.call(this, options);
}
Readable.prototype = Object.create(Stream.prototype, { constructor: { value: Readable, writable: true, configurable: true } });

Readable.prototype._read = function _read() {
  const err = codedError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', 'The _read() method is not implemented');
  destroyImpl(this, err);
};

function sizeOf(chunk, state) {
  return state.objectMode ? 1 : chunk.length;
}

function emitReadable(stream) {
  const state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    state.emittedReadable = true;
    nextTick(emitReadableNT, stream);
  }
}

function emitReadableNT(stream) {
  const state = stream._readableState;
  state.emittedReadable = false;
  if (!state.destroyed && (state.length || state.ended)) {
    stream.emit('readable');
    flow(stream);
  }
}

function maybeReadMore(stream) {
  const state = stream._readableState;
  if (state.readingMore) return;
  state.readingMore = true;
  nextTick(() => {
    while (!state.reading && !state.ended && !state.destroyed
      && (state.length < state.highWaterMark || (state.flowing && state.length === 0))) {
      const before = state.length;
      stream.read(0);
      if (before === state.length) break;
    }
    state.readingMore = false;
  });
}

function flow(stream) {
  const state = stream._readableState;
  while (state.flowing && stream.read() !== null) { /* each read emits 'data' */ }
}

function onEofChunk(stream, state) {
  if (state.ended) return;
  if (state.decoder) {
    const tail = state.decoder.end();
    if (tail && tail.length) {
      state.buffer.push(tail);
      state.length += tail.length;
    }
  }
  state.ended = true;
  if (state.sync) {
    emitReadable(stream);
  } else {
    state.needReadable = false;
    state.emittedReadable = true;
    nextTick(emitReadableNT, stream);
  }
}

function addChunk(stream, state, chunk, addToFront) {
  if (state.flowing && state.length === 0 && !state.sync && stream.listenerCount('data') > 0) {
    stream.emit('data', chunk);
  } else {
    state.length += sizeOf(chunk, state);
    if (addToFront) state.buffer.unshift(chunk);
    else state.buffer.push(chunk);
    if (state.needReadable) emitReadable(stream);
  }
  maybeReadMore(stream);
}

function readableAddChunk(stream, chunk, encoding, addToFront) {
  const state = stream._readableState;
  if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
    return false;
  }
  if (!state.objectMode) {
    if (typeof chunk === 'string') {
      if (state.encoding === null || state.encoding === undefined) {
        chunk = Buffer.from(chunk, encoding || 'utf8');
      }
    } else if (isBinary(chunk)) {
      chunk = toBuffer(chunk);
    } else if (chunk !== undefined) {
      throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "chunk" argument must be of type string or an instance of Buffer or Uint8Array');
    }
  }
  if (state.destroyed) return false;
  if (state.ended && !addToFront) {
    destroyImpl(stream, codedError(Error, 'ERR_STREAM_PUSH_AFTER_EOF', 'stream.push() after EOF'));
    return false;
  }
  if (chunk === undefined) {
    state.reading = false;
    return true;
  }
  if (!state.objectMode && state.decoder && typeof chunk !== 'string') {
    chunk = state.decoder.write(chunk);
    if (chunk.length === 0) {
      state.reading = false;
      return state.length < state.highWaterMark;
    }
  }
  if (!addToFront) state.reading = false;
  if (state.objectMode || chunk.length) addChunk(stream, state, chunk, addToFront);
  else maybeReadMore(stream);
  return state.length < state.highWaterMark;
}

Readable.prototype.push = function push(chunk, encoding) {
  return readableAddChunk(this, chunk, encoding, false);
};
Readable.prototype.unshift = function unshift(chunk, encoding) {
  return readableAddChunk(this, chunk, encoding, true);
};

function howMuch(n, state) {
  if (state.length === 0) return 0;
  if (state.objectMode) return 1;
  if (Number.isNaN(n)) {
    if (state.flowing && state.buffer.length) return state.buffer[0].length;
    return state.length;
  }
  if (n <= state.length) return n;
  return state.ended ? state.length : 0;
}

function takeFromBuffer(n, state) {
  const buffer = state.buffer;
  if (state.objectMode) return buffer.shift();
  const isText = typeof buffer[0] === 'string';
  if (!n || n >= state.length) {
    if (buffer.length === 1) {
      const only = buffer[0];
      state.buffer = [];
      return only;
    }
    const all = isText ? buffer.join('') : Buffer.concat(buffer, state.length);
    state.buffer = [];
    return all;
  }
  const parts = [];
  let need = n;
  while (need > 0 && buffer.length) {
    const head = buffer[0];
    if (head.length <= need) {
      parts.push(head);
      need -= head.length;
      buffer.shift();
    } else {
      parts.push(isText ? head.slice(0, need) : head.subarray(0, need));
      buffer[0] = isText ? head.slice(need) : head.subarray(need);
      need = 0;
    }
  }
  if (parts.length === 1) return parts[0];
  return isText ? parts.join('') : Buffer.concat(parts, n);
}

function endReadable(stream) {
  const state = stream._readableState;
  if (!state.endEmitted) {
    state.ended = true;
    nextTick(endReadableNT, stream);
  }
}

function endReadableNT(stream) {
  const state = stream._readableState;
  if (!state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.emit('end');
    autoDestroyIfDone(stream);
  }
}

Readable.prototype.read = function read(n) {
  const state = this._readableState;
  if (n === undefined) n = NaN;
  else if (!Number.isInteger(n)) n = Number.parseInt(n, 10);
  if (n === 0 && state.needReadable && (state.length >= state.highWaterMark || state.ended)) {
    if (state.length === 0 && state.ended) endReadable(this);
    else emitReadable(this);
    return null;
  }
  n = howMuch(n, state);
  if (n === 0 && state.ended) {
    if (state.length === 0) endReadable(this);
    return null;
  }
  let doRead = state.needReadable || state.length === 0 || state.length - n < state.highWaterMark;
  if (state.ended || state.reading || state.destroyed) doRead = false;
  if (doRead) {
    state.reading = true;
    state.sync = true;
    if (state.length === 0) state.needReadable = true;
    this._read(state.highWaterMark);
    state.sync = false;
    if (!state.reading) n = howMuch(n, state);
  }
  let ret = null;
  if (n > 0) ret = takeFromBuffer(n, state);
  if (ret === null) {
    state.needReadable = state.length <= state.highWaterMark;
    return null;
  }
  state.length -= state.objectMode ? 1 : ret.length;
  if (state.length === 0) {
    if (!state.ended) state.needReadable = true;
    if (state.ended) endReadable(this);
  }
  this.emit('data', ret);
  return ret;
};

Readable.prototype.setEncoding = function setEncoding(encoding) {
  const { StringDecoder } = require('string_decoder');
  const state = this._readableState;
  state.decoder = new StringDecoder(encoding);
  state.encoding = encoding;
  state.buffer = state.buffer.map((c) => (typeof c === 'string' ? c : state.decoder.write(c)));
  state.length = state.buffer.reduce((sum, c) => sum + c.length, 0);
  return this;
};

Readable.prototype.resume = function resume() {
  const state = this._readableState;
  if (!state.flowing) {
    state.flowing = !state.readableListening;
    nextTick(() => {
      if (!state.reading) this.read(0);
      this.emit('resume');
      flow(this);
    });
  }
  state.flowing = true;
  return this;
};

Readable.prototype.pause = function pause() {
  const state = this._readableState;
  if (state.flowing !== false) {
    state.flowing = false;
    this.emit('pause');
  }
  return this;
};

Readable.prototype.isPaused = function isPaused() {
  return this._readableState.flowing === false;
};

Readable.prototype.on = function on(type, listener) {
  const result = EventEmitter.prototype.on.call(this, type, listener);
  const state = this._readableState;
  if (type === 'data') {
    if (state.flowing !== false) this.resume();
  } else if (type === 'readable') {
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = true;
      state.needReadable = true;
      state.flowing = false;
      state.emittedReadable = false;
      if (state.length) emitReadable(this);
      else if (!state.reading) nextTick(() => this.read(0));
    }
  }
  return result;
};
Readable.prototype.addListener = Readable.prototype.on;

Readable.prototype.unpipe = function unpipe(dest) {
  const state = this._readableState;
  const records = dest ? state.pipes.filter((p) => p.dest === dest) : state.pipes.slice();
  for (const record of records) {
    state.pipes.splice(state.pipes.indexOf(record), 1);
    this.removeListener('data', record.ondata);
    record.dest.removeListener('drain', record.ondrain);
    record.dest.removeListener('error', record.onerror);
    record.dest.removeListener('unpipe', record.onunpipe);
    this.removeListener('end', record.onend);
    record.dest.emit('unpipe', this);
  }
  if (state.pipes.length === 0) this.pause();
  return this;
};

Readable.prototype.pipe = function pipe(dest, options) {
  const src = this;
  const state = src._readableState;
  const doEnd = !(options && options.end === false);
  const record = {
    dest,
    ondata: (chunk) => {
      if (dest.write(chunk) === false) src.pause();
    },
    ondrain: () => { src.resume(); },
    onend: () => { if (doEnd) dest.end(); else src.unpipe(dest); },
    onerror: (er) => {
      src.unpipe(dest);
      if (dest.listenerCount('error') === 0) dest.emit('error', er);
    },
    onunpipe: () => src.unpipe(dest),
  };
  state.pipes.push(record);
  src.on('data', record.ondata);
  dest.on('drain', record.ondrain);
  dest.prependListener('error', record.onerror);
  dest.on('unpipe', record.onunpipe);
  if (state.endEmitted) nextTick(record.onend);
  else src.once('end', record.onend);
  dest.emit('pipe', src);
  if (state.flowing !== false) src.resume();
  return dest;
};

Readable.prototype.destroy = function destroy(err, cb) {
  return destroyImpl(this, err, cb);
};

Readable.prototype[Symbol.asyncIterator] = function asyncIterator() {
  const stream = this;
  const queue = [];
  let done = false;
  let failure = null;
  let wake = null;
  const notify = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  stream.on('data', (chunk) => { queue.push(chunk); notify(); });
  stream.on('end', () => { done = true; notify(); });
  stream.on('error', (er) => { failure = er; notify(); });
  stream.on('close', () => { done = true; notify(); });
  const iterator = {
    async next() {
      for (;;) {
        if (queue.length) return { value: queue.shift(), done: false };
        if (failure) throw failure;
        if (done) return { value: undefined, done: true };
        stream.resume();
        await new Promise((resolve) => { wake = resolve; });
      }
    },
    async return() {
      stream.destroy();
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() { return this; },
  };
  return iterator;
};

Readable.from = function from(iterable, options) {
  const readable = new Readable({ objectMode: true, ...options, read() {} });
  if (typeof iterable === 'string' || (iterable && isBinary(iterable))) {
    readable.push(iterable);
    readable.push(null);
    return readable;
  }
  let iterator;
  if (iterable && typeof iterable[Symbol.asyncIterator] === 'function') iterator = iterable[Symbol.asyncIterator]();
  else if (iterable && typeof iterable[Symbol.iterator] === 'function') iterator = iterable[Symbol.iterator]();
  else throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "iterable" argument must be an instance of Iterable');
  let pumping = false;
  readable._read = function pump() {
    if (pumping) return;
    pumping = true;
    (async () => {
      try {
        for (;;) {
          const { value, done } = await iterator.next();
          if (done) { readable.push(null); break; }
          const value2 = await value;
          if (value2 === null) throw codedError(TypeError, 'ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
          if (!readable.push(value2)) break;
        }
      } catch (err) {
        readable.destroy(err);
      } finally {
        pumping = false;
      }
    })();
  };
  return readable;
};

Object.defineProperties(Readable.prototype, {
  readable: { get() { const s = this._readableState; return !!s && !s.destroyed && !s.endEmitted; }, set(v) { if (this._readableState) this._readableState.readable = v; } },
  readableEnded: { get() { return !!this._readableState && this._readableState.endEmitted; } },
  readableFlowing: { get() { return this._readableState ? this._readableState.flowing : null; } },
  readableLength: { get() { return this._readableState ? this._readableState.length : 0; } },
  readableHighWaterMark: { get() { return this._readableState ? this._readableState.highWaterMark : 0; } },
  readableObjectMode: { get() { return !!this._readableState && this._readableState.objectMode; } },
  destroyed: {
    get() { return !!((this._readableState && this._readableState.destroyed) || (this._writableState && this._writableState.destroyed)); },
    set(v) { if (this._readableState) this._readableState.destroyed = v; if (this._writableState) this._writableState.destroyed = v; },
  },
  closed: { get() { return !!((this._readableState && this._readableState.closed) || (this._writableState && this._writableState.closed)); } },
  errored: { get() { return (this._readableState && this._readableState.errored) || (this._writableState && this._writableState.errored) || null; } },
});

// ---- Writable ----------------------------------------------------------------------------------------------

function WritableState(options) {
  const objectMode = !!(options && (options.objectMode || options.writableObjectMode));
  this.objectMode = objectMode;
  this.highWaterMark = (options && (options.writableHighWaterMark ?? options.highWaterMark)) ?? (objectMode ? 16 : 16384);
  this.length = 0;
  this.writing = false;
  this.corked = 0;
  this.buffer = [];
  this.sync = false;
  this.ended = false;
  this.finishing = false;
  this.finished = false;
  this.needDrain = false;
  this.destroyed = false;
  this.errored = null;
  this.closed = false;
  this.decodeStrings = !(options && options.decodeStrings === false);
  this.defaultEncoding = (options && options.defaultEncoding) || 'utf8';
  this.autoDestroy = !options || options.autoDestroy !== false;
  this.emitClose = !options || options.emitClose !== false;
}

function Writable(options) {
  this._writableState = new WritableState(options);
  if (options) {
    if (typeof options.write === 'function') this._write = options.write;
    if (typeof options.writev === 'function') this._writev = options.writev;
    if (typeof options.final === 'function') this._final = options.final;
    if (typeof options.destroy === 'function') this._destroy = options.destroy;
  }
  EventEmitter.init.call(this, options);
  Stream.call(this, options);
}
Writable.prototype = Object.create(Stream.prototype, { constructor: { value: Writable, writable: true, configurable: true } });

Writable.prototype._write = function _write(chunk, encoding, cb) {
  cb(codedError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', 'The _write() method is not implemented'));
};

function doWrite(stream, state, chunk, encoding, cb, len) {
  state.writing = true;
  state.sync = true;
  let called = false;
  const onwrite = (er) => {
    if (called) return;
    called = true;
    state.writing = false;
    state.length -= len;
    if (er) {
      nextTick(() => {
        if (cb) cb(er);
        destroyImpl(stream, er);
      });
      return;
    }
    if (state.needDrain && state.length === 0 && state.buffer.length === 0) {
      state.needDrain = false;
      if (state.sync) nextTick(() => stream.emit('drain'));
      else stream.emit('drain');
    }
    if (cb) {
      if (state.sync) nextTick(cb, null);
      else cb(null);
    }
    if (state.buffer.length) clearBuffer(stream, state);
    else finishMaybe(stream, state);
  };
  stream._write(chunk, encoding, onwrite);
  state.sync = false;
}

function clearBuffer(stream, state) {
  while (state.buffer.length && !state.writing && !state.corked && !state.errored && !state.destroyed) {
    const entry = state.buffer.shift();
    doWrite(stream, state, entry.chunk, entry.encoding, entry.cb, entry.len);
  }
}

Writable.prototype.write = function write(chunk, encoding, cb) {
  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }
  const state = this._writableState;
  encoding = encoding || state.defaultEncoding;
  if (!state.objectMode) {
    if (typeof chunk === 'string') {
      if (state.decodeStrings) {
        chunk = Buffer.from(chunk, encoding);
        encoding = 'buffer';
      }
    } else if (isBinary(chunk)) {
      chunk = toBuffer(chunk);
      encoding = 'buffer';
    } else {
      throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "chunk" argument must be of type string or an instance of Buffer or Uint8Array');
    }
  }
  const fail = (err) => {
    nextTick(() => {
      if (typeof cb === 'function') cb(err);
      destroyImpl(this, err);
    });
    return false;
  };
  if (state.ended) return fail(codedError(Error, 'ERR_STREAM_WRITE_AFTER_END', 'write after end'));
  if (state.destroyed) {
    if (typeof cb === 'function') nextTick(cb, codedError(Error, 'ERR_STREAM_DESTROYED', 'Cannot call write after a stream was destroyed'));
    return false;
  }
  const len = state.objectMode ? 1 : chunk.length;
  state.length += len;
  const ret = state.length < state.highWaterMark;
  if (!ret) state.needDrain = true;
  if (state.writing || state.corked || state.errored || state.buffer.length) {
    state.buffer.push({ chunk, encoding, cb, len });
  } else {
    doWrite(this, state, chunk, encoding, cb, len);
  }
  return ret && !state.errored && !state.destroyed;
};

function needFinish(state) {
  return state.ended && state.length === 0 && state.buffer.length === 0 && !state.finished && !state.writing && !state.errored && !state.destroyed;
}

function finishMaybe(stream, state) {
  if (!needFinish(state) || state.finishing) return;
  state.finishing = true;
  const complete = (err) => {
    if (err) {
      destroyImpl(stream, err);
      return;
    }
    state.finished = true;
    nextTick(() => {
      stream.emit('finish');
      autoDestroyIfDone(stream);
    });
  };
  if (typeof stream._final === 'function') stream._final(complete);
  else complete(null);
}

Writable.prototype.end = function end(chunk, encoding, cb) {
  if (typeof chunk === 'function') {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }
  const state = this._writableState;
  if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }
  if (!state.ended) {
    state.ended = true;
    if (typeof cb === 'function') {
      if (state.finished) nextTick(cb, null);
      else this.once('finish', () => cb(null));
    }
    finishMaybe(this, state);
  }
  return this;
};

Writable.prototype.cork = function cork() { this._writableState.corked++; };
Writable.prototype.uncork = function uncork() {
  const state = this._writableState;
  if (state.corked) {
    state.corked--;
    if (!state.corked && !state.writing) clearBuffer(this, state);
  }
};
Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
  this._writableState.defaultEncoding = encoding;
  return this;
};
Writable.prototype.destroy = function destroy(err, cb) {
  return destroyImpl(this, err, cb);
};

Object.defineProperties(Writable.prototype, {
  writable: { get() { const s = this._writableState; return !!s && !s.destroyed && !s.ended; } },
  writableEnded: { get() { return !!this._writableState && this._writableState.ended; } },
  writableFinished: { get() { return !!this._writableState && this._writableState.finished; } },
  writableLength: { get() { return this._writableState ? this._writableState.length : 0; } },
  writableHighWaterMark: { get() { return this._writableState ? this._writableState.highWaterMark : 0; } },
  writableObjectMode: { get() { return !!this._writableState && this._writableState.objectMode; } },
  writableNeedDrain: { get() { return !!this._writableState && this._writableState.needDrain; } },
  writableCorked: { get() { return this._writableState ? this._writableState.corked : 0; } },
});

// ---- Duplex and Transform ----------------------------------------------------------------------------------

function Duplex(options) {
  Readable.call(this, options);
  Writable.call(this, options);
  this.allowHalfOpen = !options || options.allowHalfOpen !== false;
  if (options && options.readable === false) this._readableState.ended = true;
  if (options && options.writable === false) this._writableState.ended = true;
}
Duplex.prototype = Object.create(Readable.prototype, { constructor: { value: Duplex, writable: true, configurable: true } });
for (const name of Object.getOwnPropertyNames(Writable.prototype)) {
  if (name === 'constructor' || name in Duplex.prototype) continue;
  Object.defineProperty(Duplex.prototype, name, Object.getOwnPropertyDescriptor(Writable.prototype, name));
}

function Transform(options) {
  Duplex.call(this, options);
  this._readableState.sync = false;
  if (options) {
    if (typeof options.transform === 'function') this._transform = options.transform;
    if (typeof options.flush === 'function') this._flush = options.flush;
  }
}
Transform.prototype = Object.create(Duplex.prototype, { constructor: { value: Transform, writable: true, configurable: true } });

Transform.prototype._read = function _read() { /* data is pushed by _write, so there is nothing to fetch */ };
Transform.prototype._transform = function _transform(chunk, encoding, cb) {
  cb(codedError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', 'The _transform() method is not implemented'));
};
Transform.prototype._write = function _write(chunk, encoding, cb) {
  this._transform(chunk, encoding, (err, value) => {
    if (err) {
      cb(err);
      return;
    }
    if (value !== undefined && value !== null) this.push(value);
    cb();
  });
};
Transform.prototype._final = function _final(cb) {
  const done = (err, value) => {
    if (err) {
      cb(err);
      return;
    }
    if (value !== undefined && value !== null) this.push(value);
    this.push(null);
    cb();
  };
  if (typeof this._flush === 'function') this._flush(done);
  else done(null);
};

function PassThrough(options) {
  Transform.call(this, options);
}
PassThrough.prototype = Object.create(Transform.prototype, { constructor: { value: PassThrough, writable: true, configurable: true } });
PassThrough.prototype._transform = function _transform(chunk, encoding, cb) { cb(null, chunk); };

// `x instanceof stream.Writable` is true for duplex streams, as in node.
for (const Ctor of [Readable, Writable]) {
  const key = '_' + Ctor.name.toLowerCase() + 'State';
  Object.defineProperty(Ctor, Symbol.hasInstance, {
    value(obj) {
      if (Function.prototype[Symbol.hasInstance].call(this, obj)) return true;
      return !!(obj && typeof obj === 'object' && obj[key]);
    },
  });
}

// ---- pipeline and finished ---------------------------------------------------------------------------------

function finished(stream, options, cb) {
  if (typeof options === 'function') {
    cb = options;
    options = {};
  }
  let called = false;
  const writable = !!stream._writableState;
  const done = (err) => {
    if (called) return;
    called = true;
    cleanup();
    cb(err ?? null);
  };
  const onFinish = () => done(null);
  const onEnd = () => done(null);
  const onError = (err) => done(err);
  const onClose = () => {
    const r = stream._readableState;
    const w = stream._writableState;
    const premature = (writable && w && !w.finished) || (!writable && r && !r.endEmitted);
    done(premature ? codedError(Error, 'ERR_STREAM_PREMATURE_CLOSE', 'Premature close') : null);
  };
  const cleanup = () => {
    stream.removeListener('finish', onFinish);
    stream.removeListener('end', onEnd);
    stream.removeListener('error', onError);
    stream.removeListener('close', onClose);
  };
  if (writable) stream.on('finish', onFinish);
  else stream.on('end', onEnd);
  stream.on('error', onError);
  stream.on('close', onClose);
  return cleanup;
}

function pipeline(...streams) {
  const cb = typeof streams[streams.length - 1] === 'function' ? streams.pop() : null;
  if (Array.isArray(streams[0])) streams = streams[0];
  if (streams.length < 2) {
    throw codedError(TypeError, 'ERR_MISSING_ARGS', 'The "streams" argument must be specified with at least two streams');
  }
  let error = null;
  let done = false;
  const finish = (err) => {
    if (done) return;
    if (err && !error) error = err;
    if (err) {
      done = true;
      for (const s of streams) {
        if (s && typeof s.destroy === 'function') s.destroy();
      }
      if (cb) cb(error);
    }
  };
  const chain = [];
  for (let i = 0; i < streams.length; i++) {
    let s = streams[i];
    if (typeof s === 'function') {
      // A generator stage: the last one consumes its input and returns a promise; the others return iterables.
      const input = i === 0 ? undefined : chain[chain.length - 1];
      const out = s(input);
      if (i === streams.length - 1) {
        Promise.resolve(out).then(() => { if (!done) { done = true; if (cb) cb(null); } }, (err) => { finish(err); });
        return undefined;
      }
      s = Readable.from(out);
    }
    chain.push(s);
  }
  const last = chain[chain.length - 1];
  for (let i = 0; i < chain.length - 1; i++) {
    chain[i].pipe(chain[i + 1]);
  }
  for (const s of chain) {
    finished(s, (err) => { if (err) finish(err); });
  }
  finished(last, (err) => {
    if (!err && !done) {
      done = true;
      if (cb) cb(null);
    }
  });
  return last;
}

const promises = {
  pipeline: (...streams) => new Promise((resolve, reject) => {
    pipeline(...streams, (err) => (err ? reject(err) : resolve()));
  }),
  finished: (stream, options) => new Promise((resolve, reject) => {
    finished(stream, options ?? {}, (err) => (err ? reject(err) : resolve()));
  }),
};

Stream.Stream = Stream;
Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Duplex = Duplex;
Stream.Transform = Transform;
Stream.PassThrough = PassThrough;
Stream.EventEmitter = EventEmitter;
Stream.pipeline = pipeline;
Stream.finished = finished;
Stream.promises = promises;
Stream.isReadable = (s) => !!(s && s._readableState && !s._readableState.endEmitted && !s._readableState.destroyed);
Stream.isErrored = (s) => !!(s && ((s._readableState && s._readableState.errored) || (s._writableState && s._writableState.errored)));

module.exports = Stream;
