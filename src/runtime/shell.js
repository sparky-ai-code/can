// Built-in shell: tokenizer, parser and interpreter for a POSIX-like subset (SPEC.md section 11).
// The interpreter is written as generators. A step that must wait for the event loop (a live stream,
// a timer, network) yields a promise. runShellText drives the generator asynchronously (executor path);
// runShellSync drives it synchronously (child_process.execSync and friends), where such a step fails
// with ERR_NOT_SUPPORTED. Builtins are generator functions too: `yield readAll(io.stdin)` works in both.
import { Buffer } from 'node:buffer';
import { BUILTINS, runPathCommand, findBin } from './builtins.js';
import { SyncInput, Collector, FileSink, NULL_SINK } from './io.js';
import { evalArithmetic } from './arith.js';

export class ShellSyntaxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShellSyntaxError';
  }
}

const WORD_END = ' \t\r\n;&|<>()';
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until',
  '{', '}', '!', 'function', 'case', 'esac']);
const COMPOUND = new Set(['if', 'while', 'for', 'group', 'subshell']);
const FD_KEYS = ['stdin', 'stdout', 'stderr'];

const unexpectedEof = (what) => new ShellSyntaxError(`unexpected EOF while looking for matching \`${what}'`);

// ---- scanning helpers ------------------------------------------------------

/** Index of the backtick that closes a backtick substitution starting at j (just after the opener). */
function findBacktickEnd(src, j) {
  for (; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === '`') return j;
  }
  throw unexpectedEof('`');
}

/** Index of the double quote that closes a string whose content starts at j. Skips nested $( ). */
function findDqEnd(src, j) {
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') j++;
    else if (c === '"') return j;
    else if (c === '$' && src[j + 1] === '(') j = findClose(src, j + 2);
    else if (c === '`') j = findBacktickEnd(src, j + 1);
  }
  throw unexpectedEof('"');
}

/** Index of the ')' that closes a '(' whose content starts at i (just after it). */
function findClose(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') j++;
    else if (c === "'") {
      const e = src.indexOf("'", j + 1);
      if (e < 0) break;
      j = e;
    } else if (c === '"') j = findDqEnd(src, j + 1);
    else if (c === '`') j = findBacktickEnd(src, j + 1);
    else if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) return j;
      depth--;
    }
  }
  throw unexpectedEof(')');
}

const unescapeBackticks = (s) => s.replace(/\\([`\\$])/g, '$1');

/** Reads a ${...} parameter at src[i] (which is "$" followed by "{"). */
function readBraced(src, i) {
  const close = src.indexOf('}', i + 2);
  if (close < 0) throw new ShellSyntaxError('unterminated ${');
  const body = src.slice(i + 2, close);
  let m = /^#([A-Za-z_][A-Za-z0-9_]*)$/.exec(body);
  if (m) return { part: { type: 'var', name: m[1], op: 'length' }, end: close + 1 };
  m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?$#@*])(:?[-+])([\s\S]*)$/.exec(body);
  if (m) {
    return { part: { type: 'var', name: m[1], op: m[2], word: readDq(m[3], 0, null).parts }, end: close + 1 };
  }
  m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?$#@*])$/.exec(body);
  if (m) return { part: { type: 'var', name: m[1] }, end: close + 1 };
  throw new ShellSyntaxError(`bad substitution: \${${body}}`);
}

/** Reads a $ construct at src[i] === '$'. Returns {part, end} or null when the $ is literal. */
function readDollar(src, i) {
  const c = src[i + 1];
  if (c === '(') {
    if (src[i + 2] === '(') {
      let depth = 0;
      for (let j = i + 3; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') {
          if (depth === 0) {
            if (src[j + 1] !== ')') throw new ShellSyntaxError('syntax error: expected "))" after arithmetic');
            return { part: { type: 'arith', src: src.slice(i + 3, j) }, end: j + 2 };
          }
          depth--;
        }
      }
      throw new ShellSyntaxError("unexpected EOF while looking for matching `))'");
    }
    const close = findClose(src, i + 2);
    return { part: { type: 'cmd', src: src.slice(i + 2, close) }, end: close + 1 };
  }
  if (c === '{') return readBraced(src, i);
  if (c !== undefined && /[0-9?$#@*]/.test(c)) return { part: { type: 'var', name: c }, end: i + 2 };
  if (c !== undefined && NAME_START.test(c)) {
    let j = i + 1;
    while (j < src.length && NAME_CHAR.test(src[j])) j++;
    return { part: { type: 'var', name: src.slice(i + 1, j) }, end: j };
  }
  return null;
}

/**
 * Reads double-quote content from start. With closer '"' it stops before the closing quote (end points at
 * it). With closer null it reads to the end (heredoc bodies). Parts: lit (q) | var | cmd | arith (q).
 */
function readDq(src, start, closer) {
  const parts = [];
  let buf = '';
  let i = start;
  const flush = () => {
    if (buf !== '') { parts.push({ type: 'lit', text: buf, q: true }); buf = ''; }
  };
  const escapable = closer ? '"\\$`' : '\\$`';
  for (;;) {
    if (i >= src.length) {
      if (closer) throw unexpectedEof(closer);
      break;
    }
    const d = src[i];
    if (closer && d === closer) break;
    if (d === '\\' && i + 1 < src.length && escapable.includes(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
    } else if (d === '$' && readDollar(src, i)) {
      flush();
      const r = readDollar(src, i);
      parts.push({ ...r.part, q: true });
      i = r.end;
    } else if (d === '`') {
      flush();
      const e = findBacktickEnd(src, i + 1);
      parts.push({ type: 'cmd', src: unescapeBackticks(src.slice(i + 1, e)), q: true });
      i = e + 1;
    } else {
      buf += d;
      i++;
    }
  }
  flush();
  return { parts, end: i };
}

/** Reads one word starting at `start`. Parts: lit {text, q}, var, cmd, arith (q marks quoted). */
function readWord(src, start) {
  const parts = [];
  let lit = '';
  let i = start;
  const flush = () => {
    if (lit !== '') { parts.push({ type: 'lit', text: lit, q: false }); lit = ''; }
  };
  while (i < src.length && !WORD_END.includes(src[i])) {
    const c = src[i];
    if (c === "'") {
      flush();
      const close = src.indexOf("'", i + 1);
      if (close < 0) throw unexpectedEof("'");
      parts.push({ type: 'lit', text: src.slice(i + 1, close), q: true });
      i = close + 1;
    } else if (c === '"') {
      flush();
      const r = readDq(src, i + 1, '"');
      parts.push({ type: 'lit', text: '', q: true });
      parts.push(...r.parts);
      i = r.end + 1;
    } else if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      flush();
      if (i + 1 < src.length) parts.push({ type: 'lit', text: src[i + 1], q: true });
      i += 2;
    } else if (c === '`') {
      flush();
      const e = findBacktickEnd(src, i + 1);
      parts.push({ type: 'cmd', src: unescapeBackticks(src.slice(i + 1, e)), q: false });
      i = e + 1;
    } else {
      const r = c === '$' ? readDollar(src, i) : null;
      if (r) {
        flush();
        parts.push({ ...r.part, q: false });
        i = r.end;
      } else {
        lit += c;
        i++;
      }
    }
  }
  flush();
  return { parts, end: i };
}

/** Fills the bodies of pending heredocs from src[i]. Returns the index after the last body. */
function readHeredocBodies(src, i, pending) {
  for (const h of pending) {
    const lines = [];
    let j = i;
    while (j < src.length) {
      let eol = src.indexOf('\n', j);
      if (eol < 0) eol = src.length;
      const line = src.slice(j, eol);
      j = eol + 1;
      const cmp = h.strip ? line.replace(/^\t+/, '') : line;
      if (cmp === h.delim) break;
      lines.push(h.strip ? cmp : line);
    }
    h.body = lines.map((l) => `${l}\n`).join('');
    h.parts = h.quoted ? [{ type: 'lit', text: h.body, q: true }] : readDq(h.body, 0, null).parts;
    i = Math.min(j, src.length);
  }
  pending.length = 0;
  return i;
}

/** Splits source into tokens: {t:'word', parts} | {t:'op', v} | {t:'redir', op, fd, heredoc?}. */
export function tokenize(src) {
  const toks = [];
  const pending = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const start = i;
    if (c === '\n') {
      i++;
      toks.push({ t: 'op', v: ';', start, end: i });
      if (pending.length) i = readHeredocBodies(src, i, pending);
      continue;
    }
    if (c === ';') {
      i++;
      toks.push({ t: 'op', v: ';', start, end: i });
      continue;
    }
    if (c === '&' || c === '|') {
      const v = src[i + 1] === c ? c + c : c;
      i += v.length;
      toks.push({ t: 'op', v, start, end: i });
      continue;
    }
    if (c === '(' || c === ')') {
      i++;
      toks.push({ t: 'op', v: c, start, end: i });
      continue;
    }
    let fd = null;
    if (c >= '0' && c <= '9' && (src[i + 1] === '>' || src[i + 1] === '<')) {
      fd = Number(c);
      i++;
    }
    const d = src[i];
    if (d === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
      i += 3;
      toks.push({ t: 'redir', op: '<<<', fd, start, end: i });
      continue;
    }
    if (d === '<' && src[i + 1] === '<') {
      const strip = src[i + 2] === '-';
      i += strip ? 3 : 2;
      while (src[i] === ' ' || src[i] === '\t') i++;
      const { parts, end } = readWord(src, i);
      if (parts.length === 0) throw new ShellSyntaxError("syntax error near unexpected token `newline'");
      i = end;
      const heredoc = {
        delim: parts.filter((p) => p.type === 'lit').map((p) => p.text).join(''),
        quoted: parts.some((p) => p.q),
        strip,
        body: null,
        parts: null,
      };
      pending.push(heredoc);
      toks.push({ t: 'redir', op: '<<', fd, heredoc, start, end: i });
      continue;
    }
    if (d === '>' || d === '<') {
      let op = '>';
      if (d === '<') op = '<';
      else if (src[i + 1] === '>') op = '>>';
      else if (src[i + 1] === '&') op = '>&';
      i += op.length;
      toks.push({ t: 'redir', op, fd, start, end: i });
      continue;
    }
    const { parts, end } = readWord(src, i);
    toks.push({ t: 'word', parts, start, end });
    i = end;
  }
  if (pending.length) readHeredocBodies(src, src.length, pending);
  return toks;
}

const isLitWord = (t) => Boolean(t) && t.t === 'word' && t.parts.length === 1 && t.parts[0].type === 'lit' && !t.parts[0].q;

/** Keyword text of a word token that is a bare unquoted keyword, else null. */
function kwOf(t) {
  if (!isLitWord(t)) return null;
  const text = t.parts[0].text;
  return KEYWORDS.has(text) ? text : null;
}

/**
 * Parses source into entries: [{node, sep, text}] where node = {first: pipeline, rest: [{op, pipeline}]},
 * pipeline = array of commands (with .negate for a leading !), sep is ';', '&' or null, and text is the
 * entry's source (for background jobs). Commands are {words, redirs} or compound nodes with a `kind`.
 */
export function parse(src) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (t, v) => Boolean(t) && t.t === 'op' && t.v === v;
  const unexpected = (t) => {
    const shown = !t ? 'newline' : t.t === 'op' ? t.v : t.t === 'redir' ? t.op : 'word';
    return new ShellSyntaxError(`syntax error near unexpected token '${shown}'`);
  };
  const skipSemis = () => { while (isOp(peek(), ';')) i++; };
  const expectKw = (name) => {
    if (kwOf(peek()) !== name) throw unexpected(peek());
    i++;
  };
  const stopHit = (t, stops) => (t.t === 'op' ? stops.includes(t.v) : kwOf(t) !== null && stops.includes(kwOf(t)));

  function parseList(stops) {
    const entries = [];
    for (;;) {
      skipSemis();
      const t = peek();
      if (!t || stopHit(t, stops)) break;
      const node = parseAndOr();
      const endTok = toks[i - 1];
      let sep = null;
      if (isOp(peek(), ';')) { sep = ';'; i++; } else if (isOp(peek(), '&')) { sep = '&'; i++; }
      entries.push({ node, sep, text: src.slice(t.start, endTok.end) });
    }
    return entries;
  }

  function parseRedir() {
    const t = peek();
    i++;
    if (t.op === '<<') return { op: '<<', fd: t.fd ?? 0, heredoc: t.heredoc };
    if (t.op === '<<<') {
      const w = peek();
      if (!w || w.t !== 'word') throw unexpected(w);
      i++;
      return { op: '<<<', fd: 0, target: w.parts };
    }
    const target = peek();
    if (!target || target.t !== 'word') throw unexpected(target);
    i++;
    return { op: t.op, fd: t.fd ?? (t.op === '<' ? 0 : 1), target: target.parts };
  }

  function withRedirs(node) {
    node.redirs = node.redirs ?? [];
    while (peek() && peek().t === 'redir') node.redirs.push(parseRedir());
    return node;
  }

  function parseIf() {
    i++;
    const clauses = [];
    let cond = parseList(['then']);
    expectKw('then');
    let body = parseList(['elif', 'else', 'fi']);
    clauses.push({ cond, body });
    while (kwOf(peek()) === 'elif') {
      i++;
      cond = parseList(['then']);
      expectKw('then');
      body = parseList(['elif', 'else', 'fi']);
      clauses.push({ cond, body });
    }
    let elseBody = null;
    if (kwOf(peek()) === 'else') {
      i++;
      elseBody = parseList(['fi']);
    }
    expectKw('fi');
    return { kind: 'if', clauses, elseBody };
  }

  function parseLoop(until) {
    i++;
    const cond = parseList(['do']);
    expectKw('do');
    const body = parseList(['done']);
    expectKw('done');
    return { kind: 'while', until, cond, body };
  }

  function parseFor() {
    i++;
    const nameTok = peek();
    if (!isLitWord(nameTok) || !NAME_RE.test(nameTok.parts[0].text)) throw unexpected(nameTok);
    i++;
    let words = null;
    if (kwOf(peek()) === 'in') {
      i++;
      words = [];
      while (peek() && peek().t === 'word' && kwOf(peek()) !== 'do') {
        words.push(peek().parts);
        i++;
      }
    }
    while (isOp(peek(), ';')) i++;
    expectKw('do');
    const body = parseList(['done']);
    expectKw('done');
    return { kind: 'for', name: nameTok.parts[0].text, words, body };
  }

  function parseFuncDef() {
    let name;
    if (kwOf(peek()) === 'function') {
      i++;
      const w = peek();
      if (!isLitWord(w) || !NAME_RE.test(w.parts[0].text)) throw unexpected(w);
      name = w.parts[0].text;
      i++;
      if (isOp(peek(), '(')) {
        i++;
        if (!isOp(peek(), ')')) throw unexpected(peek());
        i++;
      }
    } else {
      name = peek().parts[0].text;
      i += 3;
    }
    skipSemis();
    const body = parseCommand();
    if (!COMPOUND.has(body.kind)) throw new ShellSyntaxError(`function '${name}': body must be a compound command`);
    return { kind: 'def', name, body };
  }

  function parseCommand() {
    const t = peek();
    if (!t) throw unexpected(t);
    const kw = kwOf(t);
    if (kw === 'case' || kw === 'esac') throw new ShellSyntaxError('case statements are not supported in this can');
    if (kw === 'if') return withRedirs(parseIf());
    if (kw === 'while' || kw === 'until') return withRedirs(parseLoop(kw === 'until'));
    if (kw === 'for') return withRedirs(parseFor());
    if (kw === '{') {
      i++;
      const body = parseList(['}']);
      expectKw('}');
      return withRedirs({ kind: 'group', body });
    }
    if (isOp(t, '(')) {
      i++;
      const body = parseList([')']);
      if (!isOp(peek(), ')')) throw unexpected(peek());
      i++;
      return withRedirs({ kind: 'subshell', body });
    }
    if (kw === 'function') return withRedirs(parseFuncDef());
    if (t.t === 'word' && isLitWord(t) && !kw && isOp(toks[i + 1], '(') && isOp(toks[i + 2], ')')) {
      return withRedirs(parseFuncDef());
    }
    if (kw) throw unexpected(t);
    const words = [];
    const redirs = [];
    for (;;) {
      const cur = peek();
      if (!cur) break;
      if (cur.t === 'word') { words.push(cur.parts); i++; } else if (cur.t === 'redir') redirs.push(parseRedir());
      else break;
    }
    if (words.length === 0 && redirs.length === 0) throw unexpected(peek());
    return { words, redirs };
  }

  function parsePipeline() {
    let negate = false;
    if (kwOf(peek()) === '!') {
      negate = true;
      i++;
    }
    const cmds = [parseCommand()];
    while (isOp(peek(), '|')) {
      i++;
      skipSemis();
      cmds.push(parseCommand());
    }
    if (negate) cmds.negate = true;
    return cmds;
  }

  function parseAndOr() {
    const first = parsePipeline();
    const rest = [];
    while (isOp(peek(), '&&') || isOp(peek(), '||')) {
      const op = toks[i++].v;
      skipSemis();
      rest.push({ op, pipeline: parsePipeline() });
    }
    return { first, rest };
  }

  const entries = parseList([]);
  if (i < toks.length) throw unexpected(peek());
  return entries;
}

// ---- expansion -------------------------------------------------------------

/** Regex for one path segment. A leading unquoted wildcard does not match dot-files. */
function segmentRegex(seg) {
  let re = seg[0].g ? '(?!\\.)' : '';
  for (const { c, g } of seg) {
    if (g && c === '*') re += '[^/]*';
    else if (g && c === '?') re += '[^/]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Expands an unquoted glob field against the VFS. Keeps the literal text when nothing matches. */
function globField(field, sh) {
  const vfs = sh.can.vfs;
  const absolute = field[0]?.c === '/';
  const segs = [[]];
  for (const ch of field) {
    if (ch.c === '/') segs.push([]);
    else segs[segs.length - 1].push(ch);
  }
  const parts = segs.filter((s) => s.length > 0);
  const out = [];
  const listDir = (abs) => {
    try { return vfs.readdir(abs); } catch { return []; }
  };
  const walk = (dirAbs, prefix, idx) => {
    if (idx === parts.length) { out.push(prefix); return; }
    const seg = parts[idx];
    const last = idx === parts.length - 1;
    const names = seg.some((x) => x.g)
      ? listDir(dirAbs).filter((n) => segmentRegex(seg).test(n))
      : [seg.map((x) => x.c).join('')];
    for (const name of names) {
      const abs = dirAbs === '/' ? `/${name}` : `${dirAbs}/${name}`;
      if (!vfs.exists(abs)) continue;
      if (!last && !vfs.stat(abs).isDirectory()) continue;
      const shown = prefix === '' ? name : prefix.endsWith('/') ? prefix + name : `${prefix}/${name}`;
      walk(abs, shown, idx + 1);
    }
  };
  walk(absolute ? '/' : sh.cwd, absolute ? '/' : '', 0);
  if (out.length === 0) return [field.map((x) => x.c).join('')];
  return out.sort();
}

/** The text of one variable-like part, with ${...} operators applied. */
function partValue(part, sh) {
  if (part.type === 'val') return part.value;
  if (part.type === 'arith') return String(arithValue(part.src, sh));
  if (part.type === 'cmd') throw new ShellSyntaxError('command substitution is not supported in this context');
  const name = part.name;
  let set = true;
  let value;
  if (name === '?') value = String(sh.lastStatus);
  else if (name === '$') value = String(sh.pid ?? 0);
  else if (name === '#') value = String(sh.positional.length);
  else if (name === '@' || name === '*') value = sh.positional.join(' ');
  else if (/^\d+$/.test(name)) {
    if (name === '0') value = sh.name ?? 'sh';
    else {
      set = sh.positional[Number(name) - 1] !== undefined;
      value = sh.positional[Number(name) - 1] ?? '';
    }
  } else {
    set = sh.env[name] !== undefined;
    value = sh.env[name] ?? '';
  }
  if (part.op === 'length') return String(value.length);
  if (part.op) {
    const colon = part.op[0] === ':';
    const empty = !set || (colon && value === '');
    const useWord = part.op.endsWith('-') ? empty : !empty;
    if (part.op.endsWith('-')) return useWord ? expandTextSync(part.word, sh) : value;
    return useWord ? expandTextSync(part.word, sh) : '';
  }
  return value;
}

/** $((...)): $NAME and $N references are expanded first, then the integer expression is evaluated. */
function arithValue(src, sh) {
  const expanded = src.replace(/\$(\{)?([A-Za-z_]\w*|\d+|[?#$])\}?/g, (m, brace, name) => partValue({ type: 'var', name }, sh));
  return evalArithmetic(expanded, (n) => sh.env[n]);
}

/** Plain text of parts without field splitting or globbing (for ${x:-word} words). */
function expandTextSync(parts, sh) {
  return parts.map((p) => (p.type === 'lit' ? p.text : partValue(p, sh))).join('');
}

/** Expands one word into zero or more argument strings (variables, quotes, globs). Command substitutions
 * must be resolved first (expandWordAsync). */
export function expandWord(parts, sh) {
  const fields = [];
  let cur = null;
  const push = (c, q, g) => {
    cur ??= [];
    cur.push({ c, q, g });
  };
  for (const part of parts) {
    if (part.type === 'lit') {
      cur ??= [];
      for (const c of part.text) push(c, part.q, !part.q && (c === '*' || c === '?'));
    } else if (part.type === 'var' && part.q && (part.name === '@') && !part.op) {
      // "$@": one field per positional parameter.
      sh.positional.forEach((a, k) => {
        if (k > 0) { fields.push(cur ?? []); cur = null; }
        cur ??= [];
        for (const c of a) push(c, true, false);
      });
    } else {
      const value = partValue(part, sh);
      if (part.q) {
        cur ??= [];
        for (const c of value) push(c, true, false);
      } else {
        // Unquoted expansions split on whitespace.
        for (const c of value) {
          if (/\s/.test(c)) {
            if (cur) { fields.push(cur); cur = null; }
          } else {
            push(c, false, false);
          }
        }
      }
    }
  }
  if (cur) fields.push(cur);
  return fields.flatMap((f) => (f.some((x) => x.g) ? globField(f, sh) : [f.map((x) => x.c).join('')]));
}

// ---- interpreter -----------------------------------------------------------

/** Shell state for one running command line. `cwd` and `env` are per process. */
export function makeShell({ can, pid = 0, cwd, env, signal, name = 'sh', positional = [] }) {
  return {
    can, pid, cwd, env, signal, name, positional,
    functions: new Map(),
    localFrames: [],
    jump: null,
    lastStatus: 0,
    exited: false,
    exitCode: 0,
    errexit: false,
    suppress: 0,
  };
}

/** A subshell's state: its own copies of cwd, variables, functions and positional parameters. */
export function childShell(sh) {
  return {
    ...sh,
    env: { ...sh.env },
    functions: new Map(sh.functions),
    positional: sh.positional.slice(),
    localFrames: [],
    jump: null,
    exited: false,
    exitCode: 0,
  };
}

const isGen = (v) => Boolean(v) && typeof v.next === 'function' && typeof v[Symbol.iterator] === 'function';

/** Resolves word parts to fields, running command substitutions first. */
function* expandWordAsync(parts, sh, io) {
  const needs = (p) => p.type === 'cmd' || (p.type === 'arith' && p.src.includes('$('));
  let resolved = parts;
  if (parts.some(needs)) {
    resolved = [];
    for (const p of parts) {
      if (p.type === 'cmd') resolved.push({ type: 'val', value: yield* commandSubst(p.src, sh, io), q: p.q });
      else if (needs(p)) resolved.push({ ...p, src: yield* resolveArithSubst(p.src, sh, io) });
      else resolved.push(p);
    }
  }
  return expandWord(resolved, sh);
}

/** Replaces $(...) inside arithmetic source with the output of that command. */
function* resolveArithSubst(src, sh, io) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '$' && src[i + 1] === '(' && src[i + 2] !== '(') {
      const close = findClose(src, i + 2);
      out += yield* commandSubst(src.slice(i + 2, close), sh, io);
      i = close + 1;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

/** Expands parts to one string with no splitting (heredoc bodies, redirect text). */
function* expandTextAsync(parts, sh, io) {
  const fields = yield* expandWordAsync(parts.map((p) => ({ ...p, q: true })), sh, io);
  return fields.join(' ');
}

/** Runs `$(...)` / backticks: output of a child shell, trailing newlines removed. */
function* commandSubst(src, sh, io) {
  const entries = parse(src);
  const sub = childShell(sh);
  const out = new Collector();
  yield* runList(entries, sub, { stdin: io.stdin, stdout: out, stderr: io.stderr });
  return out.buffer().toString('utf8').replace(/\n+$/, '');
}

/** Runs source text in the shell. Returns the status; syntax errors print to stderr and return 2. */
export function* runScript(src, sh, io, { inlineBackground = false } = {}) {
  let entries;
  try {
    entries = parse(src);
  } catch (err) {
    if (!(err instanceof ShellSyntaxError)) throw err;
    io.stderr.write(`sh: ${err.message}\n`);
    return 2;
  }
  if (inlineBackground && entries.length === 1 && entries[0].sep === '&') entries[0].sep = null;
  const status = yield* runList(entries, sh, io);
  return sh.exited ? sh.exitCode : status;
}

/** Ends a top-level program: a pending `return` supplies its status, stray break/continue are dropped. */
export function finishTop(sh, status) {
  if (sh.jump) {
    if (sh.jump.type === 'return') status = sh.jump.status;
    sh.jump = null;
  }
  return sh.exited ? sh.exitCode : status;
}

function* runTop(src, sh, io, opts) {
  const status = yield* runScript(src, sh, io, opts);
  return finishTop(sh, status);
}

function* runList(entries, sh, io) {
  let status = 0;
  for (const entry of entries) {
    if (sh.signal?.aborted) return 130;
    if (entry.sep === '&') {
      const view = sh.can.proc.spawn(entry.text, { cwd: sh.cwd, env: { ...sh.env }, background: true });
      io.stdout.write(`[${view.pid}]\n`);
      status = 0;
    } else {
      status = yield* runAndOr(entry.node, sh, io);
    }
    sh.lastStatus = status;
    if (sh.exited || sh.jump) return status;
  }
  return status;
}

function* runAndOr(node, sh, io) {
  const items = [{ op: null, pipeline: node.first }, ...node.rest];
  const last = items.length - 1;
  let status = 0;
  let lastRan = -1;
  for (let k = 0; k < items.length; k++) {
    const { op, pipeline } = items[k];
    if (k > 0 && (op === '&&') !== (status === 0)) continue;
    lastRan = k;
    if (k < last) sh.suppress++;
    try {
      status = yield* runPipeline(pipeline, sh, io);
    } finally {
      if (k < last) sh.suppress--;
    }
    if (sh.exited || sh.jump) return status;
  }
  // set -e: a failing command ends the shell unless it is a condition or part of an && / || list.
  if (status !== 0 && sh.errexit && sh.suppress === 0 && lastRan === last) {
    sh.exited = true;
    sh.exitCode = status;
  }
  return status;
}

function* runPipeline(cmds, sh, io) {
  if (!cmds.negate) return yield* runStages(cmds, sh, io);
  sh.suppress++;
  try {
    return (yield* runStages(cmds, sh, io)) === 0 ? 1 : 0;
  } finally {
    sh.suppress--;
  }
}

/** Stages run in order; each stage's output becomes the next stage's input (in memory). */
function* runStages(cmds, sh, io) {
  let input = io.stdin;
  let status = 0;
  for (let k = 0; k < cmds.length; k++) {
    const last = k === cmds.length - 1;
    const stage = { stdin: input, stdout: last ? io.stdout : new Collector(), stderr: io.stderr };
    status = yield* runCommand(cmds[k], sh, stage);
    if (!last) {
      input = stage.stdout instanceof Collector ? new SyncInput(stage.stdout.buffer()) : new SyncInput(Buffer.alloc(0));
    }
    if (sh.exited) break;
  }
  return status;
}

const isAssignWord = (parts) => parts[0]?.type === 'lit' && !parts[0].q && ASSIGN.test(parts[0].text);

function* runCommand(cmd, sh, io) {
  try {
    for (const r of cmd.redirs) yield* applyRedirect(r, sh, io);
  } catch (err) {
    io.stderr.write(`sh: ${err.message}\n`);
    return 1;
  }
  if (cmd.kind) return yield* runCompound(cmd, sh, io);
  try {
    // Leading NAME=value words: assignments. With no command they persist; with one they are temporary.
    const assigns = [];
    let k = 0;
    while (k < cmd.words.length && isAssignWord(cmd.words[k])) {
      const parts = cmd.words[k];
      const eq = parts[0].text.indexOf('=');
      const name = parts[0].text.slice(0, eq);
      const rest = [{ type: 'lit', text: parts[0].text.slice(eq + 1), q: true }, ...parts.slice(1).map((p) => ({ ...p, q: true }))];
      const value = (yield* expandWordAsync(rest, sh, io)).join('');
      assigns.push([name, value]);
      k++;
    }
    const argv = [];
    for (const w of cmd.words.slice(k)) argv.push(...(yield* expandWordAsync(w, sh, io)));
    if (argv.length === 0) {
      for (const [name, value] of assigns) sh.env[name] = value;
      return 0;
    }
    const saved = assigns.map(([name]) => [name, sh.env[name]]);
    for (const [name, value] of assigns) sh.env[name] = value;
    try {
      return yield* invoke(argv, io, sh);
    } finally {
      for (const [name, prev] of saved) {
        if (prev === undefined) delete sh.env[name];
        else sh.env[name] = prev;
      }
    }
  } catch (err) {
    io.stderr.write(`sh: ${err.message}\n`);
    return 1;
  }
}

/** Runs one command by name: a shell function, a builtin, or a path (script or JS file). */
export function* invoke(argv, io, sh) {
  const [name, ...args] = argv;
  const fn = sh.functions.get(name);
  if (fn) return yield* callFunction(fn, args, io, sh);
  let handler = BUILTINS[name];
  if (!handler && name.includes('/')) handler = (a, i, s) => runPathCommand(name, a, i, s);
  // Like PATH: a package bin in node_modules/.bin (searched up from the working folder) runs by its bare name.
  const bin = handler ? null : findBin(name, sh);
  if (bin) handler = (a, i, s) => runPathCommand(bin, a, i, s);
  if (!handler) {
    io.stderr.write(`sh: ${name}: command not found\n`);
    return 127;
  }
  const r = handler(args, io, sh);
  const status = isGen(r) ? yield* r : r;
  return status ?? 0;
}

function* callFunction(body, args, io, sh) {
  const savedPos = sh.positional;
  sh.positional = args;
  sh.localFrames.push(new Map());
  let status;
  try {
    status = yield* runCompound(body, sh, io);
  } finally {
    sh.positional = savedPos;
    const frame = sh.localFrames.pop();
    for (const [name, prev] of frame) {
      if (prev === undefined) delete sh.env[name];
      else sh.env[name] = prev;
    }
  }
  if (sh.jump && sh.jump.type === 'return') {
    status = sh.jump.status;
    sh.jump = null;
  }
  return status;
}

function* condition(entries, sh, io) {
  sh.suppress++;
  try {
    return yield* runList(entries, sh, io);
  } finally {
    sh.suppress--;
  }
}

/** Decides what a loop does after its body: 'break', 'continue', 'exit' (leave the loop) or null. */
function loopJump(sh) {
  const j = sh.jump;
  if (!j) return null;
  if (j.type === 'return') return 'exit';
  if (j.levels > 1) {
    j.levels--;
    return 'exit';
  }
  sh.jump = null;
  return j.type;
}

function* runCompound(node, sh, io) {
  switch (node.kind) {
    case 'group':
      return yield* runList(node.body, sh, io);
    case 'subshell': {
      const sub = childShell(sh);
      const status = yield* runList(node.body, sub, io);
      return sub.exited ? sub.exitCode : status;
    }
    case 'if': {
      for (const clause of node.clauses) {
        const c = yield* condition(clause.cond, sh, io);
        if (sh.exited) return sh.exitCode;
        if (c === 0) return yield* runList(clause.body, sh, io);
      }
      if (node.elseBody) return yield* runList(node.elseBody, sh, io);
      return 0;
    }
    case 'while': {
      let status = 0;
      for (;;) {
        const c = yield* condition(node.cond, sh, io);
        if (sh.exited) return sh.exitCode;
        if (sh.jump) return status;
        if (node.until ? c === 0 : c !== 0) break;
        status = yield* runList(node.body, sh, io);
        if (sh.exited) return sh.exitCode;
        const j = loopJump(sh);
        if (j === 'break') break;
        if (j === 'exit') return status;
      }
      return status;
    }
    case 'for': {
      const values = node.words === null
        ? sh.positional.slice()
        : (yield* expandWordsAll(node.words, sh, io));
      let status = 0;
      for (const v of values) {
        sh.env[node.name] = v;
        status = yield* runList(node.body, sh, io);
        if (sh.exited) return sh.exitCode;
        const j = loopJump(sh);
        if (j === 'break') break;
        if (j === 'exit') return status;
      }
      return status;
    }
    case 'def':
      sh.functions.set(node.name, node.body);
      return 0;
    default:
      throw new ShellSyntaxError(`unknown command kind ${node.kind}`);
  }
}

function* expandWordsAll(words, sh, io) {
  const out = [];
  for (const w of words) out.push(...(yield* expandWordAsync(w, sh, io)));
  return out;
}

function* applyRedirect(r, sh, io) {
  const key = FD_KEYS[r.fd];
  if (!key) throw new Error(`Bad file descriptor ${r.fd}`);
  if (r.op === '<<') {
    io[key] = new SyncInput(Buffer.from(yield* expandTextAsync(r.heredoc.parts, sh, io)));
    return;
  }
  if (r.op === '<<<') {
    const text = (yield* expandWordsAll([r.target], sh, io)).join(' ');
    io[key] = new SyncInput(Buffer.from(`${text}\n`));
    return;
  }
  const target = (yield* expandWordAsync(r.target, sh, io)).join(' ');
  if (r.op === '>&') {
    const src = FD_KEYS[Number(target)];
    if (!src) throw new Error(`Bad file descriptor ${target}`);
    io[key] = io[src];
    return;
  }
  const v = sh.can.vfs;
  const abs = v.resolve(target, sh.cwd);
  if (abs === '/dev/null') {
    io[key] = r.op === '<' ? new SyncInput(Buffer.alloc(0)) : NULL_SINK;
    return;
  }
  if (r.op === '<') {
    io[key] = new SyncInput(v.readFile(abs));
    return;
  }
  if (r.op === '>>') {
    if (!v.exists(abs)) v.writeFile(abs, '');
  } else {
    v.writeFile(abs, '');
  }
  io[key] = new FileSink(v, abs);
}

// ---- drivers ---------------------------------------------------------------

/** Drives a shell generator on the event loop. Yielded promises are awaited; errors are thrown into it. */
export async function driveAsync(gen) {
  let step = gen.next();
  for (;;) {
    if (step.done) return step.value;
    let v;
    try {
      v = await step.value;
    } catch (err) {
      step = gen.throw(err);
      continue;
    }
    step = gen.next(v);
  }
}

/** Drives a shell generator synchronously. A step that needs the event loop fails with ERR_NOT_SUPPORTED. */
export function driveSync(gen) {
  let step = gen.next();
  while (!step.done) {
    const v = step.value;
    if (v && typeof v.then === 'function') {
      v.then(() => {}, () => {});
      const err = new Error('this command needs the asynchronous shell (timers, network, background jobs or live streams)');
      err.code = 'ERR_NOT_SUPPORTED';
      step = gen.throw(err);
    } else {
      step = gen.next(v);
    }
  }
  return step.value;
}

/**
 * Runs source text in the shell. Returns the exit status. Syntax errors print to stderr and return 2.
 * With inlineBackground, a line that is a single command ending in & runs in this process (no child
 * job), so the pid the caller holds is the job itself. Used for spawn('cmd &').
 */
export function runShellText(src, sh, io, opts = {}) {
  return driveAsync(runTop(src, sh, io, opts));
}

/** Synchronous variant for child_process.execSync and friends. */
export function runShellSync(src, sh, io) {
  // A nested program started from here cannot be waited for (no event loop), so it must report its end at once.
  sh.syncDriver = true;
  return driveSync(runTop(src, sh, io, {}));
}
