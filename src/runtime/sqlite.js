// The `sqlite` built-in: the subset of node:sqlite that the can's programs use (DatabaseSync, StatementSync). The
// engine is sql.js, a pure JavaScript build of SQLite (vendored in src/vendor/sqljs, see its LICENSE). It runs in its
// own vm context with code generation from strings disabled, the same restriction as a can's programs.
//
// A database lives in the can's filesystem. It is written there after changes (coalesced within one tick), and
// when it is closed. The file is part of the can's saved state, so a saved can keeps its data.
//
// The engine initializes asynchronously. `sqlite` is therefore an async built-in: an import of it waits until the
// engine is ready (see ASYNC_BUILTINS in modules.js and JsRuntime.requireAsync).
import fs from 'node:fs';
import vm from 'node:vm';
import { posix } from 'node:path';
import { Buffer } from 'node:buffer';
import { TextDecoder, TextEncoder } from 'node:util';

const ENGINE_FILE = new URL('../vendor/sqljs/sql-asm-memory-growth.js', import.meta.url);
const TX_START = /^\s*(BEGIN|SAVEPOINT)\b/i;
const TX_END = /^\s*(COMMIT|END|ROLLBACK|RELEASE)\b/i;

function sqliteError(message, code = 'ERR_SQLITE_ERROR') {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Loads the engine into a fresh context and resolves with its SQL object. Runs once per program. */
async function loadEngine() {
  const src = fs.readFileSync(ENGINE_FILE, 'utf8');
  const ctx = vm.createContext({
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
  }, { codeGeneration: { strings: false, wasm: false } });
  const initSqlJs = vm.runInContext(
    `(function () {
      var module = { exports: {} };
      (function (module, exports, process, require, TextDecoder, TextEncoder) {
${src}
      })(module, module.exports, undefined, undefined, TextDecoder, TextEncoder);
      return module.exports;
    })()`,
    ctx,
    { filename: 'sql-asm-memory-growth.js' },
  );
  return initSqlJs();
}

/** Loads the engine for a program, once. The result is kept on the runtime. */
export function loadSqliteEngine(rt) {
  if (!rt.sqlite) rt.sqlite = { engine: null, promise: null };
  if (!rt.sqlite.promise) {
    rt.sqlite.promise = loadEngine().then((SQL) => { rt.sqlite.engine = SQL; return SQL; });
  }
  return rt.sqlite.promise;
}

/** The value a bound parameter takes: sql.js accepts numbers, strings, null and byte arrays. */
function bindValue(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (v === undefined) return null;
  if (v instanceof Uint8Array) return new Uint8Array(v);
  return v;
}

/** The value a row column takes: integers as BigInt when asked for, blobs as Buffers. */
function readValue(v, readBigInts) {
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (readBigInts && typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  return v;
}

/** Positional parameters, or one object of named parameters (keys without their prefix, as node takes them). */
function bindingsOf(sql, params) {
  if (params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0])
    && !(params[0] instanceof Uint8Array)) {
    const named = {};
    for (const [k, v] of Object.entries(params[0])) {
      const prefix = ['$', ':', '@'].find((p) => sql.includes(`${p}${k}`)) ?? '$';
      named[`${prefix}${k}`] = bindValue(v);
    }
    return named;
  }
  return params.map(bindValue);
}

export class StatementSync {
  #db;
  #sql;
  #stmt = null;
  #epoch = -1;
  #readBigInts = false;
  #returnArrays = false;

  constructor(db, sql) {
    this.#db = db;
    this.#sql = sql;
    this.#current(); // a syntax error is reported when the statement is prepared, as node does
  }

  get sourceSQL() { return this.#sql; }

  /** The prepared engine statement, prepared again if the database was exported (which frees them all). */
  #current() {
    this.#db._assertOpen();
    if (this.#stmt && this.#epoch === this.#db._epoch) return this.#stmt;
    if (this.#stmt) { try { this.#stmt.free(); } catch { /* already freed */ } }
    try {
      this.#stmt = this.#db._engine.prepare(this.#sql);
    } catch (err) {
      throw sqliteError(err?.message ?? String(err));
    }
    this.#epoch = this.#db._epoch;
    return this.#stmt;
  }

  #bind(params) {
    const stmt = this.#current();
    stmt.reset();
    const values = bindingsOf(this.#sql, params);
    if (Array.isArray(values) ? values.length > 0 : Object.keys(values).length > 0) stmt.bind(values);
    return stmt;
  }

  #names(stmt) { return Array.from(stmt.getColumnNames()); }

  #row(names, values) {
    if (this.#returnArrays) return values.map((v) => readValue(v, this.#readBigInts));
    const row = {};
    for (let i = 0; i < names.length; i++) row[names[i]] = readValue(values[i], this.#readBigInts);
    return row;
  }

  /** Every row of the statement. Row objects by default, arrays after setReturnArrays(true). */
  all(...params) {
    const stmt = this.#bind(params);
    const names = this.#names(stmt);
    const rows = [];
    try {
      while (stmt.step()) rows.push(this.#row(names, stmt.get()));
    } catch (err) {
      stmt.reset();
      throw sqliteError(err?.message ?? String(err));
    }
    stmt.reset();
    this.#db._noteWrite(this.#sql);
    return rows;
  }

  get(...params) {
    return this.all(...params)[0];
  }

  iterate(...params) {
    return this.all(...params)[Symbol.iterator]();
  }

  /** Runs the statement for its effect. Returns the rows changed and the last inserted row id. */
  run(...params) {
    const stmt = this.#bind(params);
    try {
      while (stmt.step()) { /* a statement that returns rows is run to the end */ }
    } catch (err) {
      stmt.reset();
      throw sqliteError(err?.message ?? String(err));
    }
    stmt.reset();
    this.#db._noteWrite(this.#sql);
    return { changes: this.#db._engine.getRowsModified(), lastInsertRowid: this.#db._lastInsertRowid() };
  }

  columns() {
    return this.#names(this.#current()).map((name) => ({ name }));
  }

  setReadBigInts(on) { this.#readBigInts = Boolean(on); }

  setReturnArrays(on) { this.#returnArrays = Boolean(on); }
}

/** A database of one program. Built per program by makeSqliteModule, so each program's files are its own. */
class DatabaseBase {
  #rt;
  #path;
  #readOnly;
  #closed = false;
  #dirty = false;
  #flushQueued = false;
  #txDepth = 0;

  constructor(rt, location, options = {}) {
    if (!rt?.sqlite?.engine) {
      throw sqliteError('node:sqlite is still loading in this can: import it, or await import("node:sqlite")', 'ERR_SQLITE_NOT_READY');
    }
    this.#rt = rt;
    this.#readOnly = Boolean(options.readOnly);
    this.#path = location === ':memory:' ? null : rt.vfs.resolve(String(location), rt.cwd);
    this._engine = new rt.sqlite.engine.Database(this.#load(location));
    this._epoch = 0;
  }

  #load(location) {
    if (location === ':memory:' || location === '') return undefined;
    const abs = this.#rt.vfs.resolve(String(location), this.#rt.cwd);
    if (!this.#rt.vfs.exists(abs)) return undefined;
    return new Uint8Array(this.#rt.vfs.readFile(abs));
  }

  get isOpen() { return !this.#closed; }

  _assertOpen() {
    if (this.#closed) throw sqliteError('database is not open', 'ERR_INVALID_STATE');
  }

  _lastInsertRowid() {
    return this._engine.exec('SELECT last_insert_rowid()')[0].values[0][0];
  }

  /** Called after each statement. Writes mark the database dirty; the file is written once the tick ends. */
  _noteWrite(sql) {
    if (TX_START.test(sql)) this.#txDepth += 1;
    if (TX_END.test(sql) && this.#txDepth > 0) this.#txDepth -= 1;
    if (/^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(sql) && !/\bRETURNING\b/i.test(sql)) return;
    this.#dirty = true;
    this.#scheduleFlush();
  }

  #scheduleFlush() {
    if (this.#readOnly || !this.#path || this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => {
      this.#flushQueued = false;
      try { this.#flush(); } catch (err) { this.#rt.stderr.write(`sqlite: could not write ${this.#path}: ${err.message}\n`); }
    });
  }

  #flush() {
    if (!this.#dirty || this.#closed || this.#txDepth > 0 || !this.#path || this.#readOnly) return;
    const bytes = this._engine.export();
    this._epoch += 1; // export frees the engine's statements; each StatementSync prepares again on next use
    this.#dirty = false;
    this.#rt.vfs.writeFile(this.#path, Buffer.from(bytes));
  }

  exec(sql) {
    this._assertOpen();
    try {
      this._engine.exec(String(sql));
    } catch (err) {
      throw sqliteError(err?.message ?? String(err));
    }
    this._noteWrite(String(sql));
  }

  prepare(sql) {
    this._assertOpen();
    return new StatementSync(this, String(sql));
  }

  close() {
    if (this.#closed) return;
    this.#txDepth = 0;
    this.#dirty = true;
    this.#flush();
    this._engine.close();
    this.#closed = true;
  }
}

/** The module object a program gets from require('sqlite'). The engine must be ready before a database opens. */
export function makeSqliteModule(rt) {
  class DatabaseSync extends DatabaseBase {
    constructor(location, options) { super(rt, location, options); }
  }
  return { DatabaseSync, StatementSync };
}
