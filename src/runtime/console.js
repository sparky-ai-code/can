// The console a program sees, shared by the global `console` and the `console` module.
// It has the full Node surface a server needs at boot (group, table, count, time, assert, trace, dir), each method
// writing to the can's own stdout or stderr. Nothing here reaches the host.
import { format, inspect } from 'node:util';

export function makeConsole(stdout, stderr) {
  let indent = '';
  const counts = new Map();
  const timers = new Map();
  const emit = (stream, text) => {
    const lines = String(text).split('\n');
    for (const line of lines) stream.write(`${indent}${line}\n`);
  };
  const out = (...args) => emit(stdout, format(...args));
  const err = (...args) => emit(stderr, format(...args));
  const group = (...args) => {
    if (args.length) out(...args);
    indent += '  ';
  };
  const groupEnd = () => { indent = indent.slice(0, Math.max(0, indent.length - 2)); };
  const label = (value) => (value === undefined ? 'default' : String(value));
  return {
    log: out,
    info: out,
    debug: out,
    error: err,
    warn: err,
    dir: (value, options) => emit(stdout, formatDir(value, options)),
    dirxml: out,
    trace: (...args) => emit(stderr, `Trace${args.length ? `: ${format(...args)}` : ''}\n    at <can>`),
    assert: (value, ...args) => {
      if (!value) emit(stderr, args.length ? `Assertion failed: ${format(...args)}` : 'Assertion failed');
    },
    group,
    groupCollapsed: group,
    groupEnd,
    count: (name) => {
      const key = label(name);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      out(`${key}: ${n}`);
    },
    countReset: (name) => { counts.delete(label(name)); },
    time: (name) => { timers.set(label(name), Date.now()); },
    timeLog: (name, ...data) => {
      const key = label(name);
      if (!timers.has(key)) return;
      out(`${key}: ${Date.now() - timers.get(key)}ms`, ...data);
    },
    timeEnd: (name) => {
      const key = label(name);
      if (!timers.has(key)) return;
      out(`${key}: ${Date.now() - timers.get(key)}ms`);
      timers.delete(key);
    },
    table: (data, columns) => {
      if (data === null || typeof data !== 'object') return out(data);
      emit(stdout, formatTable(data, columns));
    },
    clear: () => {},
  };
}

function formatDir(value, options) {
  return inspect(value, options);
}

// A plain table: one row per key, one column per property, with an Index column, as console.table prints.
function formatTable(data, columns) {
  const rows = Object.keys(data);
  const cols = [];
  let hasValues = false;
  for (const key of rows) {
    const row = data[key];
    if (row !== null && typeof row === 'object') {
      for (const c of Object.keys(row)) if (!cols.includes(c)) cols.push(c);
    } else {
      hasValues = true;
    }
  }
  const useCols = Array.isArray(columns) ? columns : cols;
  const header = ['(index)', ...useCols, ...(hasValues ? ['Values'] : [])];
  const body = rows.map((key) => {
    const row = data[key];
    const cells = [key];
    for (const c of useCols) cells.push(row !== null && typeof row === 'object' && c in row ? cellText(row[c]) : '');
    if (hasValues) cells.push(row !== null && typeof row === 'object' ? '' : cellText(row));
    return cells;
  });
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)) + 2);
  const line = (cells) => `│${cells.map((c, i) => centre(c, widths[i])).join('│')}│`;
  const rule = (l, m, r) => `${l}${widths.map((w) => '─'.repeat(w)).join(m)}${r}`;
  return [
    rule('┌', '┬', '┐'),
    line(header),
    rule('├', '┼', '┤'),
    ...body.map(line),
    rule('└', '┴', '┘'),
  ].join('\n') + '\n';
}

function cellText(value) {
  if (typeof value === 'string') return `'${value}'`;
  if (value !== null && typeof value === 'object') return Array.isArray(value) ? `[Array]` : `[Object]`;
  return String(value);
}

function centre(text, width) {
  const space = width - text.length;
  const left = Math.floor(space / 2);
  return ' '.repeat(left) + text + ' '.repeat(space - left);
}
