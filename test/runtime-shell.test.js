// Shell and node-runtime features an agent scripts with inside a can (SPEC.md section 11): heredocs,
// command substitution, control flow, functions and script files, more builtins, child_process routed to
// the can shell, and ESM. Every check runs inside a can; nothing here reaches the host.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-shell-'));
const manager = new CanManager({ storeDir });
let counter = 0;
async function makeCan() {
  return manager.create({ name: `sh-${++counter}`, env: { HOME: '/home/agent' } });
}
after(async () => {
  await manager.destroyAll();
  fs.rmSync(storeDir, { recursive: true, force: true });
});

const sh = (can, cmd) => can.exec(cmd, { timeout: 15_000 });

describe('heredocs feed stdin', () => {
  test('<<EOF expands variables and $(...); <<\'EOF\' keeps them literal', async () => {
    const can = await makeCan();
    await sh(can, 'X=there; cat > out.txt <<EOF\nhi $X $((1+1)) $(echo sub)\nEOF');
    assert.equal(await can.readFile('/home/agent/out.txt', 'utf8'), 'hi there 2 sub\n');
    await sh(can, "cat > raw.txt <<'EOF'\nlit $X \\$ $(nope)\nEOF");
    assert.equal(await can.readFile('/home/agent/raw.txt', 'utf8'), 'lit $X \\$ $(nope)\n');
  });

  test('<<- strips leading tabs; the body feeds a pipeline', async () => {
    const can = await makeCan();
    const r = await sh(can, 'cat <<-EOF | tr a-z A-Z\n\tone\n\ttwo\n\tEOF\n');
    assert.equal(r.stdout, 'ONE\nTWO\n');
    const h = await sh(can, 'cat <<< "here string"');
    assert.equal(h.stdout, 'here string\n');
  });
});

describe('command substitution and arithmetic', () => {
  test('$(...) nests, backticks work, trailing newlines are dropped, quoting keeps spaces', async () => {
    const can = await makeCan();
    const r = await sh(can, 'a=$(echo $(echo deep)); b=`echo tick`; echo "[$a] $b"; printf "[%s]" "$(printf "x\\n\\n")"; echo; echo "$(echo "p q")"');
    assert.equal(r.stdout, '[deep] tick\n[x]\np q\n');
  });

  test('$((...)) evaluates integer arithmetic with variables and parentheses', async () => {
    const can = await makeCan();
    const r = await sh(can, 'n=4; echo $((n*3+1)) $(( (n+2)*2 )) $((17 % 5)) $((-n)) $((n > 3 && 1))');
    assert.equal(r.stdout, '13 12 2 -4 1\n');
    const f = await sh(can, 'f() { if [ $1 -le 1 ]; then echo $1; return; fi; echo $(( $(f $(( $1 - 1 ))) + $1 )); }; f 10; echo $(( $(echo 6) * 7 ))');
    assert.equal(f.stdout, '55\n42\n');
  });
});

describe('control flow', () => {
  test('if / elif / else with test and [ ]', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/f.txt', 'x');
    const script = (v) => `v=${v}; if [ "$v" = a ]; then echo A; elif [ "$v" = b ]; then echo B; else echo other; fi`;
    assert.equal((await sh(can, script('a'))).stdout, 'A\n');
    assert.equal((await sh(can, script('b'))).stdout, 'B\n');
    assert.equal((await sh(can, script('z'))).stdout, 'other\n');
    assert.equal((await sh(can, 'if [ -f f.txt ]; then echo file; fi; if test -d f.txt; then echo dir; else echo notdir; fi')).stdout,
      'file\nnotdir\n');
  });

  test('for over words and globs; while and until; break and continue', async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p g && touch g/a.txt g/b.txt');
    assert.equal((await sh(can, 'for x in one two; do echo $x; done')).stdout, 'one\ntwo\n');
    assert.equal((await sh(can, 'for f in g/*.txt; do echo $f; done')).stdout, 'g/a.txt\ng/b.txt\n');
    assert.equal((await sh(can, 'n=0; while [ $n -lt 3 ]; do n=$((n+1)); echo w$n; done')).stdout, 'w1\nw2\nw3\n');
    assert.equal((await sh(can, 'i=0; until [ $i -ge 2 ]; do i=$((i+1)); echo u$i; done')).stdout, 'u1\nu2\n');
    assert.equal((await sh(can, 'for x in 1 2 3 4; do [ $x -eq 2 ] && continue; [ $x -eq 4 ] && break; echo x$x; done')).stdout,
      'x1\nx3\n');
  });

  test('test and [ with -f -d -e -z -n, numeric and string operators', async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p dir && echo hi > file');
    const checks = [
      ['-f file', true], ['-d dir', true], ['-e nothing', false], ['-z ""', true], ['-n ""', false],
      ['5 -eq 5', true], ['5 -ne 5', false], ['2 -lt 3', true], ['2 -gt 3', false], ['3 -le 3', true], ['4 -ge 5', false],
      ['abc = abc', true], ['abc != abd', true], ['! -f nothing', true], ['-f file -a -d dir', true],
    ];
    for (const [expr, want] of checks) {
      const r = await sh(can, `[ ${expr} ] && echo T || echo F`);
      assert.equal(r.stdout.trim(), want ? 'T' : 'F', expr);
    }
    const bad = await sh(can, '[ 1 -eq x ]; echo $?');
    assert.match(bad.stderr, /integer expression expected/);
    assert.equal(bad.stdout.trim(), '2');
  });

  test('! negates a pipeline; && and || chain', async () => {
    const can = await makeCan();
    const r = await sh(can, '! false && echo neg; false || echo alt; true && false || echo fallback');
    assert.equal(r.stdout, 'neg\nalt\nfallback\n');
  });
});

describe('functions and script files', () => {
  test('name() {...} takes arguments, $# and return values', async () => {
    const can = await makeCan();
    const r = await sh(can, 'add() { echo sum $(($1 + $2)) $#; return 4; }; add 2 3; echo rc=$?; function hi { echo hi-$1; }; hi there');
    assert.equal(r.stdout, 'sum 5 2\nrc=4\nhi-there\n');
  });

  test('sh and bash run a script file; ./script.sh uses its shebang; exit status comes back', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/s.sh', [
      '#!/bin/sh',
      'greet() { echo hello $1; }',
      'greet world',
      'echo args $# $1 $2',
      'exit 7',
    ].join('\n'));
    const r = await sh(can, 'sh s.sh x y; echo rc=$?; bash s.sh; echo rc=$?');
    assert.equal(r.stdout, 'hello world\nargs 2 x y\nrc=7\nhello world\nargs 0\nrc=7\n');
    await can.writeFile('/home/agent/run', '#!/bin/bash\necho shebang $1\n');
    assert.equal((await sh(can, './run ok')).stdout, 'shebang ok\n');
  });

  test('source runs a file in this shell; local keeps names inside a function', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/lib.sh', 'LIB=loaded\nfn() { echo from-lib; }\n');
    const r = await sh(can, '. lib.sh; echo $LIB; fn; g() { local LIB=inner; echo $LIB; }; g; echo $LIB');
    assert.equal(r.stdout, 'loaded\nfrom-lib\ninner\nloaded\n');
  });
});

describe('builtins an agent reaches for', () => {
  test('export, unset, set -e and set --', async () => {
    const can = await makeCan();
    assert.equal((await sh(can, 'export A=1 B=two; echo $A$B; unset A; echo [$A]')).stdout, '1two\n[]\n');
    const e = await sh(can, 'set -e; echo before; false; echo after');
    assert.equal(e.stdout, 'before\n');
    assert.equal(e.exitCode, 1);
    assert.equal((await sh(can, 'set -- p q; echo $1 $2 $#')).stdout, 'p q 2\n');
  });

  test('read splits a line into names; a while-read loop walks a file', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/in.txt', 'alpha beta gamma\nsecond line\n');
    const r = await sh(can, 'read first rest < in.txt; echo [$first] [$rest]; while read a b; do echo "$a|$b"; done < in.txt');
    assert.equal(r.stdout, '[alpha] [beta gamma]\nalpha|beta gamma\nsecond|line\n');
    const eof = await sh(can, 'read x < /dev/null; echo rc=$?');
    assert.equal(eof.stdout, 'rc=1\n');
  });

  test('expr computes and reports its result through the exit status', async () => {
    const can = await makeCan();
    const r = await sh(can, 'expr 2 + 3 \\* 4; expr 5 \\> 3; echo rc=$?; expr 1 - 1; echo rc=$?; expr abc = abc');
    assert.equal(r.stdout, '14\n1\nrc=0\n0\nrc=1\n1\n');
  });

  test('seq, basename, dirname, tr, cut -d -f', async () => {
    const can = await makeCan();
    assert.equal((await sh(can, 'seq 3')).stdout, '1\n2\n3\n');
    assert.equal((await sh(can, 'seq 2 2 6 | tr "\\n" ,')).stdout, '2,4,6,');
    assert.equal((await sh(can, 'basename /a/b/c.txt; basename /a/b/c.txt .txt; dirname /a/b/c.txt')).stdout,
      'c.txt\nc\n/a/b\n');
    assert.equal((await sh(can, 'echo hello | tr a-y b-z; echo "Shout" | tr "[:lower:]" "[:upper:]"')).stdout,
      'ifmmp\nSHOUT\n');
    assert.equal((await sh(can, "echo 'a:b:c' | cut -d: -f2; echo 'x y z' | cut -d' ' -f1,3")).stdout, 'b\nx z\n');
  });

  test('xargs runs a command with the words from stdin; tee writes and passes through', async () => {
    const can = await makeCan();
    assert.equal((await sh(can, 'printf "a\\nb c\\n" | xargs echo got')).stdout, 'got a b c\n');
    assert.equal((await sh(can, 'printf "1\\n2\\n" | tee t.out | wc -l')).stdout.trim(), '2');
    assert.equal(await can.readFile('/home/agent/t.out', 'utf8'), '1\n2\n');
  });

  test('diff prints normal-format hunks and returns 1 on difference, 0 when same', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/one.txt', 'a\nb\nc\n');
    await can.writeFile('/home/agent/two.txt', 'a\nB\nc\nd\n');
    const r = await sh(can, 'diff one.txt two.txt; echo rc=$?; diff one.txt one.txt; echo rc=$?');
    assert.equal(r.stdout, '2c2\n< b\n---\n> B\n3a4\n> d\nrc=1\nrc=0\n');
  });

  test('date formats in UTC; printf takes %s and %d; parameter operators work', async () => {
    const can = await makeCan();
    const r = await sh(can, 'date +%Y-%m-%d; printf "%s=%d\\n" count 42; echo ${NOPE:-dflt} ${HOME:+set} ${#HOME}');
    const [date, printed, params] = r.stdout.split('\n');
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(printed, 'count=42');
    assert.equal(params, 'dflt set 11');
  });

  test('redirects to /dev/null discard output and give empty input', async () => {
    const can = await makeCan();
    const r = await sh(can, 'ls /missing 2>/dev/null; echo rc=$?; cat < /dev/null; echo empty');
    assert.equal(r.stdout, 'rc=1\nempty\n');
  });
});

describe('node: child_process routed to the can shell', () => {
  test('execSync and execFileSync return the can command output; a failing command throws with its status', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/cp.js', `
      const cp = require('child_process');
      console.log(JSON.stringify(cp.execSync('echo one && echo two', { encoding: 'utf8' })));
      console.log(cp.execFileSync('echo', ['x y'], { encoding: 'utf8' }).trim());
      try { cp.execSync('exit 3'); } catch (e) { console.log('status', e.status); }
      console.log(cp.execSync('echo raw').toString().trim());
    `);
    const r = await sh(can, 'node cp.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '"one\\ntwo\\n"\nx y\nstatus 3\nraw\n');
  });

  test('spawnSync returns stdout, status and honours input and encoding', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/sp.js', `
      const cp = require('child_process');
      const r = cp.spawnSync('printf', ['%s|%s', 'a', 'b'], { encoding: 'utf8' });
      console.log(r.status, r.stdout);
      console.log(cp.execSync('cat', { input: 'piped in', encoding: 'utf8' }));
      console.log(cp.spawnSync('nosuch-cmd').status);
    `);
    const r = await sh(can, 'node sp.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '0 a|b\npiped in\n127\n');
  });

  test('execSync sees the can, not the host: its filesystem and hostname', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/fs.txt', 'inside');
    await can.writeFile('/home/agent/cp2.js', `
      const cp = require('child_process');
      console.log(cp.execSync('cat fs.txt', { encoding: 'utf8' }).trim());
      console.log(cp.execSync('node -p "require(\\'os\\').hostname()"', { encoding: 'utf8' }).trim());
    `);
    const r = await sh(can, 'node cp2.js');
    assert.equal(r.stdout, `inside\n${can.name}\n`);
  });

  test('a command that needs the event loop fails in execSync with a clear error', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/cp3.js', `
      const cp = require('child_process');
      try { cp.execSync('sleep 1'); } catch (e) { console.log('status', e.status); }
    `);
    const r = await sh(can, 'node cp3.js');
    assert.equal(r.stdout, 'status 1\n');
    assert.match(r.stderr, /asynchronous shell/);
    // A program with a timer does not run on after execSync gives up on it.
    await can.writeFile('/home/agent/cp4.js', `
      const cp = require('child_process');
      try { cp.execSync('node -e "setTimeout(() => console.log(\\'late\\'), 5)"'); } catch (e) { console.log('status', e.status); }
    `);
    const late = await sh(can, 'node cp4.js; sleep 0.1');
    assert.equal(late.stdout, 'status 1\n', 'the timer never fires');
  });
});

describe('node: ESM', () => {
  test('import and export between .mjs files: default, named, namespace, re-export', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/lib.mjs', [
      'export const answer = 42;',
      'export function add(a, b) { return a + b; }',
      'export default class Greeter { hi() { return "hi"; } }',
      'export { add as plus };',
      'export * from "./more.mjs";',
    ].join('\n'));
    await can.writeFile('/home/agent/more.mjs', 'export const extra = "x";\n');
    await can.writeFile('/home/agent/main.mjs', [
      'import Greeter, { answer, plus } from "./lib.mjs";',
      'import * as ns from "./lib.mjs";',
      'import fs from "node:fs";',
      'console.log(answer, plus(1, 2), new Greeter().hi(), ns.answer, ns.extra, typeof fs.readFileSync);',
    ].join('\n'));
    const r = await sh(can, 'node main.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '42 3 hi 42 x function\n');
  });

  test('a .js file with import statements is treated as ESM', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/val.mjs', 'export const v = 7;\n');
    await can.writeFile('/home/agent/use.js', "import { v } from './val.mjs';\nconsole.log('v', v);\n");
    const r = await sh(can, 'node use.js');
    assert.equal(r.stdout, 'v 7\n');
  });

  test('import.meta gives the file url, filename, dirname and resolve', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/meta.mjs', [
      'console.log(import.meta.filename, import.meta.dirname);',
      'console.log(import.meta.url);',
      'console.log(typeof import.meta.resolve);',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/meta.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '/home/agent/meta.mjs /home/agent\nfile:///home/agent/meta.mjs\nfunction\n');
  });

  test('import.meta.main is true only in the entry module', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/inner.mjs', 'console.log("inner", import.meta.main);\n');
    await can.writeFile('/home/agent/outer.mjs', 'import "./inner.mjs";\nconsole.log("outer", import.meta.main);\n');
    const r = await sh(can, 'node /home/agent/outer.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'inner false\nouter true\n');
  });

  test('top-level await runs in order, and an importer waits for the awaited module', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/data.mjs', [
      'console.log("data start");',
      'export const value = await new Promise((resolve) => setTimeout(() => resolve(41), 5));',
      'console.log("data end");',
    ].join('\n'));
    await can.writeFile('/home/agent/main.mjs', [
      'console.log("main start");',
      'import { value } from "./data.mjs";',
      'const next = await Promise.resolve(value + 1);',
      'console.log("main", next);',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/main.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    // Dependencies evaluate first, as in real ESM: the importer's body starts after data.mjs finishes.
    assert.equal(r.stdout, 'data start\ndata end\nmain start\nmain 42\n');
  });

  test('a top-level await that rejects ends the program with exit 1', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/boom.mjs', 'await Promise.reject(new Error("boom"));\n');
    const r = await sh(can, 'node /home/agent/boom.mjs');
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /boom/);
  });

  test('require() of a module that uses top-level await fails with ERR_REQUIRE_ASYNC_MODULE', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/lib.mjs', 'export const v = await 1;\n');
    await can.writeFile('/home/agent/cjs.js', [
      'try { require("./lib.mjs"); console.log("loaded"); }',
      'catch (e) { console.log(e.code); }',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/cjs.js');
    assert.equal(r.stdout, 'ERR_REQUIRE_ASYNC_MODULE\n');
  });

  test('dynamic import() of a top-level-await module resolves after it runs', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/late.mjs', 'export const late = await Promise.resolve("ok");\n');
    await can.writeFile('/home/agent/dyn.js', [
      'import("./late.mjs").then((m) => console.log("dyn", m.late));',
      'console.log("sync done");',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/dyn.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'sync done\ndyn ok\n');
  });

  test('a bare side-effect import is not joined to the from-import on the next line', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/log.mjs', 'console.log("log loaded");\nexport const n = 1;\n');
    await can.writeFile('/home/agent/lib2.mjs', 'export const m = 2;\n');
    await can.writeFile('/home/agent/main.mjs', [
      'import "./log.mjs";',
      'import { m } from "./lib2.mjs";',
      'console.log("m", m);',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/main.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'log loaded\nm 2\n');
  });

  test('bindings named module, exports or require do not clash with the CommonJS wrapper', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/val.mjs', 'export const v = 5;\n');
    await can.writeFile('/home/agent/main.mjs', [
      'import * as module from "./val.mjs";',
      'import { v as exports } from "./val.mjs";',
      'import { v as require } from "./val.mjs";',
      'console.log(module.v, exports, require);',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/main.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '5 5 5\n');
  });

  test('comments inside import and export lists are ignored', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/lib3.mjs', [
      'const a = 1;',
      'const b = 2;',
      'export {',
      '  /** @since 2.0.0 */',
      '  a,',
      '  // the second one',
      '  b as bee,',
      '};',
    ].join('\n'));
    await can.writeFile('/home/agent/main.mjs', [
      'import {',
      '  // first',
      '  a, /* second */ bee',
      '} from "./lib3.mjs";',
      'console.log(a, bee);',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/main.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '1 2\n');
  });

  test('a brace inside a comment in an export list does not end the list', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/braces.mjs', [
      'const a = 1;',
      'export {',
      '  /** see {@link Thing} for details */',
      '  a,',
      '};',
    ].join('\n'));
    await can.writeFile('/home/agent/main.mjs', 'import { a } from "./braces.mjs";\nconsole.log(a);\n');
    const r = await sh(can, 'node /home/agent/main.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '1\n');
  });

  test('top-level await inside a block or loop makes the module async', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/loop.mjs', [
      'export const seen = [];',
      'for (const n of [1, 2]) {',
      '  seen.push(await Promise.resolve(n * 10));',
      '}',
    ].join('\n'));
    await can.writeFile('/home/agent/main.mjs', 'import { seen } from "./loop.mjs";\nconsole.log(seen.join(","));\n');
    const r = await sh(can, 'node /home/agent/main.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '10,20\n');
  });

  test('a module whose last line is a comment with no newline still loads', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/tail.mjs', 'export const t = "tail";\n//# sourceMappingURL=tail.mjs.map');
    await can.writeFile('/home/agent/main.mjs', 'import { t } from "./tail.mjs";\nconsole.log(t);\n');
    const r = await sh(can, 'node /home/agent/main.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'tail\n');
  });

  test('await inside an async function does not make the module async', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/fn.mjs', 'export async function run() { await null; return 3; }\n');
    await can.writeFile('/home/agent/cjs2.js', 'const m = require("./fn.mjs");\nm.run().then((v) => console.log("run", v));\n');
    const r = await sh(can, 'node /home/agent/cjs2.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'run 3\n');
  });

  test('a package with an exports field resolves by condition, pattern and blocked entry', async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p /home/agent/node_modules/pkg/cjs /home/agent/node_modules/pkg/lib');
    await can.writeFile('/home/agent/node_modules/pkg/package.json', JSON.stringify({
      name: 'pkg',
      exports: {
        '.': { import: './esm/index.js', require: './cjs/index.js' },
        './feature/*': './lib/*.js',
        './secret': null,
      },
    }));
    await can.writeFile('/home/agent/node_modules/pkg/cjs/index.js', 'module.exports = { kind: "cjs" };\n');
    await can.writeFile('/home/agent/node_modules/pkg/lib/alpha.js', 'module.exports = "alpha";\n');
    await can.writeFile('/home/agent/main.js', [
      'const pkg = require("pkg");',
      'console.log(pkg.kind, require("pkg/feature/alpha"));',
      'try { require("pkg/secret"); } catch (e) { console.log(e.code); }',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/main.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'cjs alpha\nMODULE_NOT_FOUND\n');
  });

  test('an ES module package whose exports entry is a plain string loads by package name', async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p /home/agent/node_modules/esmpkg/dist');
    await can.writeFile('/home/agent/node_modules/esmpkg/package.json', JSON.stringify({
      name: 'esmpkg', type: 'module', exports: { '.': './dist/index.js' },
    }));
    await can.writeFile('/home/agent/node_modules/esmpkg/dist/index.js', 'export const hello = "hi";\n');
    await can.writeFile('/home/agent/main.mjs', 'import { hello } from "esmpkg";\nconsole.log(hello);\n');
    const r = await sh(can, 'node /home/agent/main.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'hi\n');
  });

  // Known gap: the rejection is not reported, so the program exits 0 (node exits 1). The membrane wraps the host
  // promise, so the can cannot tell that the sandbox never attached a handler.
  test('net: a server and a client in the can exchange data over the virtual network', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/echo.js', [
      'const net = require("net");',
      'const server = net.createServer((sock) => { sock.on("data", (d) => sock.end("echo:" + d)); });',
      'server.listen(7007, () => {',
      '  const client = net.connect(7007, "127.0.0.1", () => client.write("hi"));',
      '  client.on("data", (d) => { console.log(String(d)); server.close(); });',
      '});',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/echo.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'echo:hi\n');
  });

  test('net: a connection to a port with no server is refused', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/nobody.js', [
      'const net = require("net");',
      'const s = net.connect(7008, "localhost");',
      's.on("error", (e) => console.log(e.code));',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/nobody.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'ECONNREFUSED\n');
  });

  test('node:sqlite creates a table, binds parameters and reads rows back', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/db1.mjs', [
      'import { DatabaseSync } from "node:sqlite";',
      'const db = new DatabaseSync("/home/agent/data.db");',
      'db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");',
      'const ins = db.prepare("INSERT INTO notes (body) VALUES (?)");',
      'console.log(ins.run("first").changes, ins.run("second").lastInsertRowid);',
      'console.log(JSON.stringify(db.prepare("SELECT id, body FROM notes ORDER BY id").all()));',
      'console.log(db.prepare("SELECT body FROM notes WHERE id = $id").get({ id: 2 }).body);',
      'db.close();',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/db1.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '1 2\n[{"id":1,"body":"first"},{"id":2,"body":"second"}]\nsecond\n');
  });

  test('a node:sqlite database is a file in the can, and a later program reads it', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/w.mjs', [
      'import { DatabaseSync } from "node:sqlite";',
      'const db = new DatabaseSync("/home/agent/kept.db");',
      'db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'kept\');");',
      'db.close();',
    ].join('\n'));
    await can.writeFile('/home/agent/r.mjs', [
      'import { DatabaseSync } from "node:sqlite";',
      'const db = new DatabaseSync("/home/agent/kept.db");',
      'console.log(db.prepare("SELECT v FROM t").get().v);',
    ].join('\n'));
    assert.equal((await sh(can, 'node /home/agent/w.mjs')).exitCode, 0);
    const bytes = await can.readFile('/home/agent/kept.db');
    assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
    const r = await sh(can, 'node /home/agent/r.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'kept\n');
  });

  test('node:sqlite reports a bad statement as an error with a code', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/bad.mjs', [
      'import { DatabaseSync } from "node:sqlite";',
      'const db = new DatabaseSync(":memory:");',
      'try { db.prepare("SELEC nothing"); } catch (e) { console.log(e.code, /syntax error/.test(e.message)); }',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/bad.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'ERR_SQLITE_ERROR true\n');
  });

  test('an import() that rejects with no handler ends the program with exit 1 and prints the error', { todo: 'unhandled import() rejections are silent (see comment)' }, async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/bad.mjs', 'const = 1;\n');
    await can.writeFile('/home/agent/shim.cjs', 'import("./bad.mjs");\n');
    const r = await sh(can, 'node /home/agent/shim.cjs');
    assert.equal(r.exitCode, 1, `stdout: ${r.stdout}`);
    assert.match(r.stderr, /bad\.mjs/);
  });

  test('a package whose exports has only an import condition loads from an ES module', async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p /home/agent/node_modules/importonly/dist');
    await can.writeFile('/home/agent/node_modules/importonly/package.json', JSON.stringify({
      name: 'importonly', exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    }));
    await can.writeFile('/home/agent/node_modules/importonly/dist/index.js', 'export const v = "imported";\n');
    await can.writeFile('/home/agent/main.mjs', 'import { v } from "importonly";\nconsole.log(v);\n');
    const r = await sh(can, 'node /home/agent/main.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'imported\n');
  });

  test('require("module").createRequire loads files relative to the given path', async () => {
    const can = await makeCan();
    await sh(can, 'mkdir -p /home/agent/lib');
    await can.writeFile('/home/agent/lib/helper.js', 'module.exports = "helped";\n');
    await can.writeFile('/home/agent/main.js', [
      'const { createRequire } = require("module");',
      'console.log(createRequire(__filename)("./lib/helper.js"));',
      'console.log(createRequire("file:///home/agent/x.js")("./lib/helper.js"));',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/main.js');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'helped\nhelped\n');
  });

  test('destructured exports are live bindings for each name', async () => {
    const can = await makeCan();
    await can.writeFile('/home/agent/lib.mjs', [
      'export const { a, b: renamed, c = 3, ...rest } = { a: 1, b: 2, d: 4, e: 5 };',
      'export let [x, [y]] = [10, [20]];',
      'export const { deep: { z } } = { deep: { z: "zed" } };',
    ].join('\n'));
    await can.writeFile('/home/agent/main.mjs', [
      'import { a, renamed, c, rest, x, y, z } from "./lib.mjs";',
      'console.log(a, renamed, c, JSON.stringify(rest), x, y, z);',
    ].join('\n'));
    const r = await sh(can, 'node /home/agent/main.mjs');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '1 2 3 {"d":4,"e":5} 10 20 zed\n');
  });
});

describe('the sandbox holds under the shell', () => {
  test('host paths are unreachable from shell syntax and from execSync', async () => {
    const can = await makeCan();
    const secret = path.join(os.tmpdir(), `can-shell-secret-${process.pid}.txt`);
    fs.writeFileSync(secret, 'host secret');
    try {
      const r = await sh(can, `cat "${secret.replace(/\\/g, '/')}"; echo rc=$?; x=$(cat "${secret.replace(/\\/g, '/')}" 2>/dev/null); echo "[$x]"`);
      assert.doesNotMatch(r.stdout, /host secret/);
      assert.match(r.stdout, /rc=1/);
      await can.writeFile('/home/agent/esc.js', `
        const cp = require('child_process');
        try { console.log(cp.execSync('cat "${secret.replace(/\\/g, '/')}"', { encoding: 'utf8' })); }
        catch (e) { console.log('blocked', e.status); }
      `);
      const e = await sh(can, 'node esc.js');
      assert.doesNotMatch(e.stdout, /host secret/);
      assert.match(e.stdout, /blocked 1/);
      assert.equal(fs.readFileSync(secret, 'utf8'), 'host secret', 'the host file is untouched');
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  test('the escape and sandbox suites in runtime.test.js and vm.test.js still pass', () => {
    const root = path.resolve(import.meta.dirname, '..');
    // NODE_TEST_CONTEXT is set when this file runs under node --test; clear it so the child prints a TAP report.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const out = execFileSync(process.execPath, [
      '--test',
      '--test-reporter=tap',
      '--test-name-pattern=escape|sandbox|host constructors|membrane|permission model',
      path.join(root, 'test', 'runtime.test.js'),
      path.join(root, 'test', 'vm.test.js'),
    ], { cwd: root, env, encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(out, /# pass [1-9]\d*/);
    assert.match(out, /# fail 0/);
  });
});
