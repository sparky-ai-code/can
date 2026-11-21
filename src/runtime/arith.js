// Integer arithmetic for $((...)) and expr. A small recursive-descent evaluator: no eval, no host access.
// Precedence, lowest first: || && | & (= == != < <= > >=) (+ -) (* / %) unary (! - +) primary.

export class ArithError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArithError';
  }
}

const NUMERIC = /^-?\d+$/;
const OPS = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '=', '+', '-', '*', '/', '%', '(', ')', '!', '|', '&'];
const LEX = /\s*(?:(\d+)|([A-Za-z_]\w*)|(\|\||&&|==|!=|<=|>=|[-+*/%<>()=!|&]))/y;

const isNumeric = (v) => typeof v === 'number' || NUMERIC.test(v);
const num = (v) => {
  if (typeof v === 'number') return v;
  if (NUMERIC.test(v)) return Number(v);
  throw new ArithError('non-integer argument');
};
const truthy = (v) => (typeof v === 'number' ? v !== 0 : v !== '' && v !== '0');

/** Lexes $((...)) source. Names take their value from lookup(name); unset or non-numeric names count as 0. */
export function lexArith(src, lookup) {
  const items = [];
  LEX.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    LEX.lastIndex = pos;
    const m = LEX.exec(src);
    if (!m) throw new ArithError(`syntax error in expression near '${src.slice(pos).trim()}'`);
    pos = LEX.lastIndex;
    if (m[1] !== undefined) items.push({ op: null, val: Number(m[1]) });
    else if (m[2] !== undefined) {
      const raw = lookup(m[2]);
      items.push({ op: null, val: raw !== undefined && NUMERIC.test(String(raw).trim()) ? Number(String(raw).trim()) : 0 });
    } else items.push({ op: m[3], val: null });
  }
  return items;
}

/** Builds the item list for expr: each operator-looking argument is an operator, the rest are operands. */
export function exprItems(args) {
  return args.map((a) => (OPS.includes(a) ? { op: a, val: null } : { op: null, val: NUMERIC.test(a) ? Number(a) : a }));
}

/** Evaluates a list of items from lexArith or exprItems. Returns a number or (for expr strings) a string. */
export function evalItems(items) {
  let k = 0;
  const isOp = (o) => items[k] !== undefined && items[k].op === o;
  const anyOp = (...os) => os.some(isOp);

  function primary() {
    const t = items[k];
    if (!t) throw new ArithError('syntax error: unexpected end of expression');
    if (t.op === '(') {
      k++;
      const v = logOr();
      if (!isOp(')')) throw new ArithError("syntax error: missing ')'");
      k++;
      return v;
    }
    if (t.op !== null) throw new ArithError(`syntax error near unexpected token '${t.op}'`);
    k++;
    return t.val;
  }

  function unary() {
    if (isOp('-')) { k++; return -num(unary()); }
    if (isOp('+')) { k++; return num(unary()); }
    if (isOp('!')) { k++; return truthy(unary()) ? 0 : 1; }
    return primary();
  }

  function mul() {
    let v = unary();
    while (anyOp('*', '/', '%')) {
      const o = items[k++].op;
      const r = num(unary());
      if ((o === '/' || o === '%') && r === 0) throw new ArithError('division by zero');
      const l = num(v);
      v = o === '*' ? l * r : o === '/' ? Math.trunc(l / r) : l % r;
    }
    return v;
  }

  function add() {
    let v = mul();
    while (anyOp('+', '-')) {
      const o = items[k++].op;
      const r = mul();
      v = o === '+' ? num(v) + num(r) : num(v) - num(r);
    }
    return v;
  }

  function rel() {
    let v = add();
    while (anyOp('<', '<=', '>', '>=')) {
      const o = items[k++].op;
      const r = add();
      let a = v;
      let b = r;
      if (!(isNumeric(a) && isNumeric(b))) { a = String(a); b = String(b); } else { a = num(a); b = num(b); }
      const ok = o === '<' ? a < b : o === '<=' ? a <= b : o === '>' ? a > b : a >= b;
      v = ok ? 1 : 0;
    }
    return v;
  }

  function eq() {
    let v = rel();
    while (anyOp('=', '==', '!=')) {
      const o = items[k++].op;
      const r = rel();
      const same = isNumeric(v) && isNumeric(r) ? num(v) === num(r) : String(v) === String(r);
      v = (o === '!=' ? !same : same) ? 1 : 0;
    }
    return v;
  }

  function bitAnd() {
    let v = eq();
    while (isOp('&')) {
      k++;
      const r = eq();
      v = truthy(v) && truthy(r) ? v : 0;
    }
    return v;
  }

  function bitOr() {
    let v = bitAnd();
    while (isOp('|')) {
      k++;
      const r = bitAnd();
      v = truthy(v) ? v : r;
    }
    return v;
  }

  function logAnd() {
    let v = bitOr();
    while (isOp('&&')) {
      k++;
      const r = bitOr();
      v = truthy(v) && truthy(r) ? 1 : 0;
    }
    return v;
  }

  function logOr() {
    let v = logAnd();
    while (isOp('||')) {
      k++;
      const r = logAnd();
      v = truthy(v) ? v : truthy(r) ? 1 : 0;
    }
    return v;
  }

  const value = logOr();
  if (k < items.length) throw new ArithError(`syntax error near unexpected token '${items[k].op ?? items[k].val}'`);
  return value;
}

/** $((expr)) value as a number. Names are looked up through lookup(name). */
export function evalArithmetic(src, lookup) {
  const v = evalItems(lexArith(src, lookup));
  return num(v);
}
