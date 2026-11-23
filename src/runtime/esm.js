// A small ESM-to-CommonJS transform for modules inside a can. It handles the common statement forms
// (import / export declarations, re-exports, destructured exports, dynamic import(), import.meta and top-level
// await) with regular expressions over statements that start a line. Anything else that looks like module syntax
// it cannot translate safely throws a SyntaxError that names the file and line. Line numbers are kept (prelude
// code goes on line 1).
//
// Modules that use top-level await, or that statically import one, are translated to an async function body
// (`isAsync`). The runtime loads them with `require.async`, which waits for their evaluation. A plain
// `require()` of such a module throws ERR_REQUIRE_ASYNC_MODULE, as Node does.
//
// Semantics that differ from real ESM: a cycle sees partial exports, and `import.meta` is a plain object.

// The clause may span lines (multi-line named imports) but never a quote or semicolon, so a bare `import "x";`
// is not joined to the next statement's `from`.
// The whitespace is optional where JavaScript allows none, and the statement may follow a `;` on the same line:
// minified bundles write `...;import{a as b}from"./x.js";...`.
const IMPORT_RE = /^([ \t]*)import(?:\s+|(?=[{*'"]))(?:([^;'"]*?)\s*from\s*)?(['"])([^'"\n]+)\3(?:\s*(?:with|assert)\s*\{[^}]*\})?[ \t]*;?/gm;
const EXPORT_DECL_RE = /^([ \t]*)export\s+(const|let|var|async\s+function\*?|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_PATTERN_RE = /^([ \t]*)export\s+(const|let|var)\s+(?=[\[{])/gm;
const EXPORT_DEFAULT_NAMED_RE = /^([ \t]*)export\s+default\s+((?:async\s+)?function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_DEFAULT_RE = /^([ \t]*)export\s+default\s+/gm;
// The list may hold comments, and a comment may hold a brace (JSDoc `{@link ...}`), so comments are matched whole.
const EXPORT_LIST_RE = /^([ \t]*)export\s*\{((?:\/\*[\s\S]*?\*\/|\/\/[^\n]*|[^}])*)\}(?:\s*from\s*(['"])([^'"\n]+)\3)?[ \t]*;?/gm;
const EXPORT_STAR_RE = /^([ \t]*)export\s*\*(?:\s*as\s+([A-Za-z_$][\w$]*))?\s*from\s*(['"])([^'"\n]+)\3[ \t]*;?/gm;
const DYNAMIC_IMPORT_RE = /(^|[^\w$.])import\s*\(/gm;
const IMPORT_META_RE = /\bimport\.meta\b/g;

/** True when the source has module syntax at the start of a line. */
export function needsEsm(file, src) {
  if (file.endsWith('.mjs')) return true;
  if (file.endsWith('.cjs')) return false;
  return /^[ \t]*(import|export)\s/m.test(src);
}

/** Module specifiers of the static import and re-export statements (not dynamic import()). */
export function staticSpecs(src) {
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) out.push(m[4]);
  for (const m of src.matchAll(EXPORT_LIST_RE)) if (m[4] !== undefined) out.push(m[4]);
  for (const m of src.matchAll(EXPORT_STAR_RE)) out.push(m[4]);
  return out;
}

/**
 * CommonJS source with dynamic import() calls routed through the runtime. Used for files without module syntax,
 * which Node also lets call import(). The helper goes on line 1, so line numbers do not move.
 */
export function withDynamicImport(src) {
  if (!/(^|[^\w$.])import\s*\(/m.test(src)) return src;
  const helper = 'const __can_import = (s) => require.importAsync(s).then((m) => (m && m.__esModule ? m : { default: m, ...m }));';
  return helper + src.replace(DYNAMIC_IMPORT_RE, (m, pre) => `${pre}__can_import(`);
}

/** Skips a string or template literal that starts at index i. Returns the index of its closing quote. */
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === q) return j;
  }
  return src.length;
}

/** Removes block and line comments, keeping the text around them apart. Used inside import and export lists. */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

function fail(file, src, index, what) {
  return new SyntaxError(`${file}:${lineOf(src, index)}: unsupported ES module syntax in this can: ${what}`);
}

// Minified bundles put several statements on one line (`...;import{a}from"./x.js";...`), so a statement can start
// after a `;`. A caller that reads such code passes statementStarts: true to toCommonJs.
function statementStart(re) {
  return new RegExp(re.source.replace(/^\^/, '(?<=^|[;}\\n])'), re.flags);
}

/** Replaces matches of re in src, keeping every newline so line numbers do not move. */
function blankAll(src, re, fn) {
  return src.replace(re, (...args) => {
    const match = args[0];
    const offset = args[args.length - 2];
    const groups = args.slice(1, -2);
    const newlines = match.split('\n').length - 1;
    return fn(groups, offset) + '\n'.repeat(newlines);
  });
}

/** Parses an import clause: default name, namespace name and named bindings. */
function parseClause(clause, file, src, index) {
  const out = { def: null, ns: null, named: [] };
  let s = stripComments(clause ?? '').trim();
  const brace = /\{([\s\S]*)\}/.exec(s);
  if (brace) {
    out.named = brace[1].split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const m = /^([A-Za-z_$][\w$]*|default|'[^']*'|"[^"]*")(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(p);
      if (!m) throw fail(file, src, index, `import specifier '${p}'`);
      const from = m[1].replace(/^['"]|['"]$/g, '');
      return { from, to: m[2] ?? from };
    });
    s = s.replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim();
  }
  const star = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(s);
  if (star) out.ns = star[1];
  else if (s) out.def = s.replace(/,$/, '').trim();
  return out;
}

/** Splits text at commas that are outside brackets and quotes. */
function splitTop(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\') { cur += s[++i] ?? ''; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Index of the first character `ch` outside brackets and quotes, or -1. */
function topIndex(s, ch) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

function targetNames(t, file) {
  const s = t.trim();
  if (s[0] === '{' || s[0] === '[') return patternNames(s, file);
  if (/^[A-Za-z_$][\w$]*$/.test(s)) return [s];
  throw new SyntaxError(`${file}: unsupported binding pattern '${s}' in an exported destructuring declaration`);
}

/** Binding names of a destructuring pattern such as `{ a, b: c, d = 1, ...rest }` or `[x, [y]]`. */
function patternNames(pat, file) {
  const kind = pat[0];
  const names = [];
  for (let part of splitTop(pat.slice(1, -1))) {
    if (part.startsWith('...')) { names.push(...targetNames(part.slice(3), file)); continue; }
    const eq = topIndex(part, '=');
    if (eq >= 0) part = part.slice(0, eq).trim();
    if (kind === '{') {
      const colon = topIndex(part, ':');
      if (colon >= 0) part = part.slice(colon + 1).trim();
    }
    names.push(...targetNames(part, file));
  }
  return names;
}

/** Index just past the bracket that closes the one at `start`. */
function matchClose(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/**
 * Converts ES module syntax to CommonJS. `opts.async` wraps the body for top-level await: the prelude then awaits
 * each import with `require.async`. Throws SyntaxError for syntax it does not translate.
 */
export function toCommonJs(src, file, opts = {}) {
  const rx = (re) => (opts.statementStarts ? statementStart(re) : re);
  const isAsync = Boolean(opts.async);
  // The prelude reaches require and exports through __can_req and __can_exports, captured before the module's own
  // block, so an imported binding called `require` or `exports` cannot shadow them.
  const load = (spec) => (isAsync
    ? `await __can_req.async(${JSON.stringify(spec)})`
    : `__can_req(${JSON.stringify(spec)})`);

  const prelude = [];
  let n = 0;
  let body = src;

  body = blankAll(body, rx(IMPORT_RE), ([indent, clause, , spec], offset) => {
    const { def, ns, named } = parseClause(clause, file, src, offset);
    const id = `__can_m${n++}`;
    prelude.push(`const ${id} = ${load(spec)};`);
    if (def) prelude.push(`const ${def} = __can_default(${id});`);
    if (ns) prelude.push(`const ${ns} = ${id};`);
    if (named.length) {
      prelude.push(`const { ${named.map((b) => (b.from === b.to ? b.to : `${b.from}: ${b.to}`)).join(', ')} } = ${id};`);
    }
    return '';
  });

  body = blankAll(body, rx(EXPORT_LIST_RE), ([indent, list, , spec], offset) => {
    const items = stripComments(list).split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(p);
      if (!m) throw fail(file, src, offset, `export specifier '${p}'`);
      return { from: m[1], to: m[2] ?? m[1] };
    });
    if (spec !== undefined) {
      const id = `__can_m${n++}`;
      prelude.push(`const ${id} = ${load(spec)};`);
      for (const { from, to } of items) {
        prelude.push(`Object.defineProperty(__can_exports,${JSON.stringify(to)}, { enumerable: true, get: () => ${id}[${JSON.stringify(from)}] });`);
      }
    } else {
      for (const { from, to } of items) {
        prelude.push(`Object.defineProperty(__can_exports,${JSON.stringify(to)}, { enumerable: true, get: () => ${from} });`);
      }
    }
    return '';
  });

  body = blankAll(body, rx(EXPORT_STAR_RE), ([, asName, , spec], offset) => {
    const id = `__can_m${n++}`;
    prelude.push(`const ${id} = ${load(spec)};`);
    if (asName) {
      prelude.push(`Object.defineProperty(__can_exports,${JSON.stringify(asName)}, { enumerable: true, get: () => ${id} });`);
    } else {
      prelude.push(`__can_reexportAll(__can_exports, ${id});`);
    }
    return '';
  });

  body = blankAll(body, rx(EXPORT_DEFAULT_NAMED_RE), ([indent, kind, name], offset) => {
    prelude.push(`Object.defineProperty(__can_exports,'default', { enumerable: true, get: () => ${name} });`);
    return `${indent}${kind.replace(/\s+/, ' ')} ${name}`;
  });

  // export const { a, b: c } = obj;  -> const { a, b: c } = obj;  with live getters for a and c.
  // The pattern is left in place, so only the `export` keyword goes and the line count does not change.
  {
    let out = '';
    let last = 0;
    const patternRe = rx(EXPORT_PATTERN_RE); patternRe.lastIndex = 0;
    let m;
    while ((m = patternRe.exec(body)) !== null) {
      const start = m.index + m[0].length;
      const end = matchClose(body, start);
      const names = patternNames(body.slice(start, end), file);
      for (const name of names) {
        prelude.push(`Object.defineProperty(__can_exports,${JSON.stringify(name)}, { enumerable: true, get: () => ${name} });`);
      }
      out += body.slice(last, m.index) + `${m[1]}${m[2]} `;
      last = start;
    }
    body = out + body.slice(last);
  }

  body = blankAll(body, rx(EXPORT_DECL_RE), ([indent, kind, name], offset) => {
    prelude.push(`Object.defineProperty(__can_exports,${JSON.stringify(name)}, { enumerable: true, get: () => ${name} });`);
    return `${indent}${kind} ${name}`;
  });

  body = body.replace(EXPORT_DEFAULT_RE, (m, indent, offset) => `${indent}__can_exports.default = `);

  body = body.replace(DYNAMIC_IMPORT_RE, (m, pre) => `${pre}__can_import(`);

  body = body.replace(IMPORT_META_RE, '__can_meta');

  const leftover = /^[ \t]*export\s/m.exec(body);
  if (leftover) throw fail(file, src, leftover.index, 'this export form');

  const head = [
    'const __can_exports = exports; const __can_req = require;',
    'Object.defineProperty(__can_exports, "__esModule", { value: true });',
    'const __can_default = (m) => (m && m.__esModule ? m.default : m);',
    'const __can_reexportAll = (dst, src) => { for (const k of Object.keys(src)) if (k !== "default" && !(k in dst)) '
      + 'Object.defineProperty(dst, k, { enumerable: true, get: () => src[k] }); };',
    // main is true only in the program's entry module, as in node (import.meta.main, node 24.2 and later). Page
    // modules in the browser have no process, so there it is always false.
    'const __can_meta = { url: "file://" + __filename, filename: __filename, dirname: __dirname, resolve: (s) => require.resolve(s), '
      + 'main: typeof process !== "undefined" && __filename === process.argv[1] };',
    'const __can_import = (s) => require.importAsync(s).then((m) => (m && m.__esModule ? m : { default: m, ...m }));',
  ];
  // Everything goes on line 1 so the body keeps its line numbers. The module's own bindings go in a block, so a
  // declaration such as `import * as module from 'module'` may shadow the wrapper's `module`, `exports` or `require`.
  // The closing brace goes on its own line: a body that ends in a line comment with no newline would swallow it.
  return `${head.join(' ')} {${prelude.join(' ')}${body}\n}`;
}
