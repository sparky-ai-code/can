# CI blockers: status of each problem found building Electron in a can

This records the ten problems found by running an Electron Windows build of a small app through `can ci`. For each one:
what the symptom was, what changed, which test covers it, and what still does not work. Tests are in
`test/ci-blockers.test.js` (run `node --test test/ci-blockers.test.js`) unless a row says otherwise.

**Bottom line.** Eight of the ten have a fix with a test. Two are limits by design, documented with their exact errors:
code generation from strings, and `vm` / `process.binding`. The Electron build itself is still not runnable in a can.
Its own install script fetches the Electron binary, install scripts never run in a can, and the binary is larger than
the 50 MB per-file limit. Section 11 lists what is still needed.

## Status table

| # | Symptom (as reported) | Status | Where |
|---|---|---|---|
| 1 | `npm install` fails on npm aliases: `EUNSUPPORTED ... wrap-ansi-cjs@npm:wrap-ansi@^7.0.0` | Fixed | `src/runtime/npm.js` (`parseAlias`, `planTree`) |
| 2 | `node --check main.js` fails with `Cannot find module '/app/--check'` | Fixed | `src/runtime/builtins.js` (`node`), `src/runtime/js.js` (`checkSyntax`) |
| 3 | Missing built-ins: `process.emitWarning`, `util.formatWithOptions`, `fs.createWriteStream`; `vm` and `process.binding` unavailable | Partly fixed; `vm` and `process.binding` are by design (section 3) | `src/runtime/js.js`, `src/runtime/modules.js` |
| 4 | `NODE_OPTIONS` ignored | Fixed: `--require`/`-r` and no-op flags take effect; other options fail with exit 9 | `src/runtime/builtins.js` (`readNodeOptions`) |
| 5 | `new Function` in bluebird fails: `EvalError: Code generation from strings disallowed` | By design; documented (section 5) | `SPEC.md` ("Code generation") |
| 6 | `curl` exits 0 with no output | Not reproduced against github.com or example.com. The real defect fixed: curl silently ignored `-o`, `-I`, `-v`, `-w`, `-S`, `-f`, `-L`, and took `-o`'s value as the URL | `src/runtime/builtins.js` (`curl`) |
| 7 | `res.on("data")` chunks are proxies; `Buffer.concat` throws `Received {}`; the VM crashes with `ECHILD` | Fixed | `src/vm/membrane.js` (`host`) |
| 8 | 50 MB per-file limit: `EFBIG` on `electron.exe` (188,614,144 bytes) | Raised to 256 MB per file; memory caveat in section 8 | `src/transfer.js` (`LIMITS`) |
| 9 | `sed` ranges unsupported; `du` absent; `grep -r` on a folder fails with `EISDIR` | Fixed for sed ranges, `du`, `grep -r`. `tar`, `zip`, `unzip` remain absent (section 9) | `src/runtime/textcmds.js` |
| 10 | Failed CI cans kept forever | Fixed: `can prune` and `Registry.prune`, age default 24 h | `bin/can.js` (`prune`), `src/registry.js` (`prune`) |

## 1. npm aliases

`"wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0"` installs the registry package `wrap-ansi` under the alias name
`node_modules/wrap-ansi-cjs`. An alias with no range takes `latest`. Scoped names work (`npm:@scope/pkg@1.2.3`).
A bad alias target (`npm:../escape@1`) is refused with `EUNSUPPORTED` naming the spec.

Still refused, with `EUNSUPPORTED` naming the spec: git, file, link, workspace, URL and path specs.

Tests: three `npm.test.js` cases ("an npm alias installs the registry package under the alias name", "an npm alias with
no range takes latest", "parseAlias splits names...").

## 2. `node` flags

`node --check file.js` (and `-c`) compiles the file the way a load would, without running it. It prints the SyntaxError
and exits 1 on a bad file, 0 on a good one, and it does not run the program. `node -v` prints the version the can reports
as `process.version`. `node -r file.js main.js` (and `--require=file.js`) loads a module before the main file. An unknown
option is a visible error with exit 9 (node's own code for a bad option), never a file name.

Tests: "node --check passes a valid file silently...", "node --check does not run the program...", "node -c is the short
form...", "an option a can does not honour is a visible error...", "node -r preloads a module...".

## 3. Missing built-ins

Added:
- `process.emitWarning(warning, type?, code?)` prints `(node:PID) [CODE] Type: message` to stderr.
- `util.formatWithOptions`.
- `fs.createWriteStream` (appends each chunk to the can file; `flags: 'w'` truncates at open) and `fs.createReadStream`
  (reads the file at open and emits it as one chunk). A stream keeps the program alive until it closes, since node's
  stream callbacks would otherwise run after the program had already ended. A read stream nobody reads keeps the
  program alive too; this differs from node.

By design, unchanged, and now tested to fail with exit 1 and the API named:
- `require('vm')`: `Cannot find module 'vm': built-in module 'vm' is not available in this can`.
- `process.binding(...)`: `TypeError: process.binding is not a function`. The VM removes it at boot (SPEC.md, section 10).

Not reproduced: "electron-packager with DEBUG set exits 0 and prints only `util.formatWithOptions is not a function`".
A program that catches its own error and exits 0 can still do so; the can cannot change that. The nonzero exit does
happen for an uncaught error (tested above).

## 4. NODE_OPTIONS

`NODE_OPTIONS` is read the way node reads it, at the start of each `node` call:
- `--require`/`-r <file>` takes effect. Test: `NODE_OPTIONS="--require /app/ci-polyfill.js"`.
- `--no-warnings`, `--trace-warnings`, `--no-deprecation`, `--trace-deprecation`, `--enable-source-maps` are accepted and
  change nothing.
- Anything else fails the `node` call with exit 9 and names the option. A value that names a script (not an option) is
  refused too.

NODE_OPTIONS is never ignored silently any more. A CI step that sets an option the can does not honour fails at its
first `node` call.

## 5. Code generation from strings (by design)

`new Function`, `eval` and string `setTimeout` fail inside a can with `EvalError: Code generation from strings disallowed
for this context`. The can turns this off on purpose (SPEC.md, "Code generation" and section 10): it is one of the layers
that keep host code out. Packages that call `new Function` at load time, such as bluebird's `js/release/join.js`, fail.
This will not change without a decision to weaken the membrane. Nothing in this change works around it.

## 6. curl

Now implemented: `-o/--output` (writes the body to a can file); `-I/--head`; `-i/--include`; `-v/--verbose` (trace on stderr,
approximate, not byte-for-byte curl); `-L/--location` (up to 50 redirects; 303, and 301/302 after POST, become GET);
`-f/--fail` (exit 22 on HTTP 400 and above); `-s` with `-S`; `-w/--write-out` with `%{http_code}`, `%{response_code}`,
`%{content_type}`, `%{size_download}`, `%{url_effective}`; `-X`, `-H`, `-d`, `-A`, `--url`.

Any option not in that list is an error with exit 2 (`curl: option --x: is unknown`). Two URLs are refused. Reading `-d`
from a file (`-d @file`) is refused. `-k`, `--cacert`, `-x` and `--version` are unknown options, so they fail visibly.

Tests: six `curl` cases against a server in the can.

## 7. Binary data through a stream

The membrane passed a sandbox array of proxies to host code without unwrapping its elements. A `Buffer.concat` of
`res.on("data")` chunks therefore saw proxies, failed its type check, and the VM crashed with `ECHILD`. Now an array that
holds membrane proxies goes to the host as a copy with each element unwrapped. Arrays without proxies keep their identity.

Test: a 300,000-byte binary body fetched with `http.get` inside a can, concatenated with `Buffer.concat`, compared byte
for byte. This was reproduced (failing) before the fix.

Limit: the unwrapping is one level deep. An object that holds a proxy in a field (not in an array) is still passed as is.

## 8. The per-file limit: raised from 50 MB to 256 MB

`LIMITS.maxFileBytes` is now 256 MB (`src/transfer.js`), so `electron.exe` (188,614,144 bytes) passes the import check.
The limit alone does not make the file usable: a can holds its files in memory inside a VM with a 512 MB heap cap
(SPEC.md, section 10), and each saved can is one JSON file. A 188 MB file in a can therefore needs most of the heap,
and its saved state is larger than any can in `~/.can/cans` today (those range from 11 MB to 145 MB). This has not been
measured end to end. Automatic chunking was not added; it would need a manifest, a rejoin step, and a rule for reading
a chunked file back. That is still a design decision.

## 9. Shell gaps

Added:
- `sed` line addresses (`N`, `$`, `/regex/`), ranges (`N,M`, `N,$`, `/a/,/b/`), `p`, `d`, and several `-e` scripts, with `s///`.
  `-n` is supported. Other sed commands are refused by name with exit 1.
- `grep -r`/`-R` searches the files under a folder, names shown as typed (`src/sub/b.js:...`). A folder without `-r` is
  reported (`grep: src: Is a directory`, exit 2) instead of `EISDIR`.
- `du` with `-s` and `-h`. Sizes are in KiB, each folder rounded up, shown after its contents as `du` does.

Still absent: `tar`, `zip` and `unzip` exit 127 with `command not found`. The can has no archive tools. A pipeline that
needs an archive should create it on the host, or use a JS package in `node_modules` if one fits.

Not implemented: `sed -i`, `sed` commands other than `s`, `p`, `d`, and `grep` options beyond `-i`, `-n`, `-v`, `-r`.

## 10. Kept CI cans

`keepCan` defaults to `on-failure`, so a failed run keeps its can for inspection. Those cans were never removed. Now
`can prune [--older-than <hours>] [--dry-run]` removes saved cans whose names start with `ci-` and that were created
more than `--older-than` hours ago (default 24). A loaded (running) can is never removed. Other names are never touched.
`Registry.prune({prefix, olderThanMs, dryRun})` is the same logic for code.

Retention policy, as implemented: a failed CI can is kept until `can prune` runs. Run it from a scheduled task or by hand.
The command does not run by itself after each CI run.

Tests: "prune removes only saved ci-* cans older than the age...", "can prune runs from the command line...".

## 11. What the Electron build still needs

Running `npm install` and `npx electron-packager . Notify --platform=win32 --arch=x64` in a can is not expected to work
yet, for three reasons, two of them documented above:
1. Electron's binary is fetched by its install script, and install scripts never run in a can (SPEC.md, section 14.1).
   A packager needs that binary, so the packaging step cannot succeed without it.
2. The binary is 188,614,144 bytes. The per-file limit is now 256 MB, so the import passes. The can's 512 MB heap and its JSON saved state have not been shown to hold it (section 8).
3. Some packages in the tree call `new Function` (section 5).

Each needs a decision: a chunked or larger transfer for large artifacts, a supported way to provide a binary that
install scripts would normally fetch, and whether any code generation is acceptable. None of these is made here.

## Commands used to check

```powershell
node --test test/ci-blockers.test.js   # the blocker tests (27 test cases; the last run before the ES-module case was added passed 26 of 26)
node --test test/npm.test.js           # npm, including the alias cases
node --test                            # full suite (see the result in the report for pass and fail counts)
```
