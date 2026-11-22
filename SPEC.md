# Can: architecture and interface spec

Status: **[impl]** implemented and tested. **[stub]** placeholder to be replaced.
**[plan]** not built yet; the interface below is binding for whoever builds it.

## 1. Principles

- Zero dependencies. Node.js built-ins only. ES modules. Tests: `node --test` (`npm test`).
- Each can is its own **child Node process** (the can VM, section 9). The filesystem, virtual network,
  process table, shell, JS runtime and browser of a can all live inside that process. Code running inside
  a can must never read or write host files, spawn host processes or see host environment variables
  (section 10 states what is enforced and what is not).
- The host holds no can state. `Can` and `CanManager` are async RPC clients over IPC.
- The only host I/O besides the VM processes is `CanManager` persisting can snapshots as JSON under
  `storeDir` (default `%USERPROFILE%\.can\cans`). No host path is ever mounted into a can, except a host folder the user has
listed by label in the mounts file, which mounts read-only (section 13.2).
- Errors are `KernelError` instances: `code` (Node-style: ENOENT, EEXIST, ENOTDIR, EISDIR, ENOTEMPTY,
  EINVAL, ELOOP, EPERM, EADDRINUSE, ECONNREFUSED, ETIMEDOUT, ESRCH, plus ECHILD when a can VM is gone),
  `message` (Node format), and `syscall`, `path`, `dest`, `port`, `pid` when relevant.

## 2. Layout

```
bin/can.js               CLI (see section 13)                 [impl]
bin/can-mcp.js           MCP server entry (stdio)             [impl]
src/registry.js          CanRegistry: live and saved cans, lazy load [impl]
src/mcp/tools.js         MCP tool definitions (text results)  [impl]
src/transfer.js          host-side import and export, transfer root, limits, excludes [impl]
src/environment.js       environment specs for can_create: checks, pre-boot steps, report [impl]
src/runtime/npm.js       npm registry client: semver, tarballs, dependency plan, bin shims [impl]
src/mounts.js           host allowlist of read-only folders (labels only), hostBrowser switch [impl]
src/recording.js        QA recordings: timeline log, browser frames, APNG and ffmpeg MP4, host side only [impl]
src/hostbrowser.js      opt-in host Chrome/Edge over DevTools (outside any can) [impl]
skills/can/SKILL.md     agent skill: how to use cans, their limits and the host tools [impl]
src/can.js               Can: async RPC handle of one can     [impl]
src/manager.js           CanManager (async), defaultStoreDir  [impl]
src/vm/supervisor.js     VmProcess: fork, permission flags, RPC client, crash/exit handling [impl]
src/vm/worker.js         can VM entry: boot hardening, RPC server [impl]
src/vm/protocol.js       IPC message and error encoding        [impl]
src/vm/machine.js        Machine: the kernel of one can (runs inside the VM) [impl]
src/vm/membrane.js       layer 2: host/sandbox membrane        [impl]
src/vm/guards.js         layer 2b: refuses every host listen   [impl]
src/vm/stacks.js         stack traces show can frames only     [impl]
src/vm/seed.js           DEFAULT_ENV, seedFilesystem           [impl]
src/vm/policy.js         per-can network and runtime policy (internet, registry, nodeVersion) [impl]
src/kernel/errors.js     KernelError, fsError                  [impl]
src/kernel/vfs.js        VFS, Stat                             [impl]
src/kernel/vnet.js       VNet, Listener, createStreamPair      [impl]
src/kernel/proc.js       ProcessTable, RingBuffer              [impl]
src/runtime/executor.js  default executor: a command line in the built-in shell [impl]
src/runtime/shell.js     tokenizer, parser, expansion, pipes, redirects         [impl]
src/runtime/builtins.js  core builtins, node, npm, curl                         [impl]
src/runtime/textcmds.js  cat grep head tail wc sort uniq sed find               [impl]
src/runtime/js.js        node:vm CommonJS runner, virtual require, timers       [impl]
src/runtime/modules.js   virtual fs, path, child_process, os, process, ...      [impl]
src/runtime/http.js      virtual http/https over vnet (outbound via node)       [impl]
src/browser/             headless virtual browser                              [impl]
src/mcp/server.js        MCP stdio JSON-RPC server            [impl]
test/kernel.test.js      vfs, vnet, proc, Machine, CanManager lifecycle
test/runtime.test.js     shell, JS runtime, background servers, browser inside a can
test/browser.test.js     HTML parser, selectors, cookies, browser (mock vnet and loopback internet)
test/vm.test.js          escape attempts, layer-1-only check, permission flags, crashes, host exit
test/mcp.test.js         MCP over stdio: handshake, tools, HTTP, browser form, persistence
test/cli.test.js         CLI smoke tests: create, exec, cp, shell, mcp
test/transfer.test.js    import and export: round trips, refusals, limits, MCP and CLI transfer
test/e2e.test.js         an agent builds, runs and tests a multi-file web app through MCP [impl]
test/isolation.test.js   listen guard, leaked host net, two cans side by side, heap cap, default timeout [impl]
```

## 3. VFS (`src/kernel/vfs.js`) [impl]

`new VFS({ cwd = '/', clock = Date.now })`. Times are ms internally.

- `cwd` (property), `chdir(p)`. Relative paths resolve against `vfs.cwd`. Processes keep their own
  cwd: the runtime calls `vfs.resolve(p, procCwd)` and passes absolute paths down.
- `resolve(p, base = cwd)` returns a normalized absolute path (no symlink expansion).
- `exists(p)`, `stat(p)`, `lstat(p)` return `Stat`: `type` ('file'|'dir'|'symlink'), `mode`, `size`,
  `mtime`/`ctime`/`birthtime` (Date), `isFile()`, `isDirectory()`, `isSymbolicLink()`.
- `readFile(p, encoding | {encoding})` returns a Buffer, or a string when an encoding is given.
- `writeFile(p, data, {mode, encoding})`, `appendFile(p, data, {encoding})`. `data` is a string,
  Buffer or Uint8Array. The parent must exist. Writes go through symlinks.
- `mkdir(p, {recursive, mode})`. Recursive returns the first path created, or undefined.
- `readdir(p, {withFileTypes})` returns sorted names, or `Stat` objects with a `name` field.
- `readlink(p)`, `symlink(target, p)`, `chmod(p, mode)`, `utimes(p, mtime)`.
- `unlink(p)`, `rmdir(p)` (must be empty), `rm(p, {recursive, force})`.
- `rename(from, to)` follows POSIX replace rules. `copy(from, to, {recursive})` deep-copies; `to`
  is the full destination path (`cp a dir/` is the shell's job). Symlinks are copied as links.
- Permission bits are not enforced. Defaults: files 0644, dirs 0755, links 0777.
- Persistence: `serialize()` returns a JSON-safe object `{format:'can-vfs', version:1, cwd, root}`
  with file bytes as base64. `VFS.deserialize(obj)` and `clone()`.

## 4. VNet (`src/kernel/vnet.js`) [impl]

One `VNet` per can, inside its VM process. Ports exist only inside it.

- `listen(port, handler) -> Listener`. Port 0 picks an ephemeral port (49152-65535). Throws
  EADDRINUSE or EINVAL. `Listener` is an EventEmitter with `port` and `createdAt`.
- HTTP handler contract: `handler(req)` returns `{status=200, headers={}, body}` or a Promise of it.
  - `req = { port, method (uppercase), url (path + query), headers (lowercase keys), body: Buffer }`
  - `body` may be a string, Buffer, or JSON-able object (objects set `content-type: application/json`).
  - A thrown error becomes a 500 response whose body is the stack text.
- `request({ port, method='GET', path='/', headers={}, body, timeout=30000 })` resolves to
  `{ status, headers (lowercase), body: Buffer }`. Rejects ECONNREFUSED (no listener) or ETIMEDOUT.
  `timeout: 0` disables the timer.
- Raw streams: `connect(port)` returns the client-side Duplex. The server end is emitted on the
  Listener's `'connection'` event. Throws ECONNREFUSED if there is no listener or no `'connection'` handler.
- `close(port) -> boolean` (emits `'close'` on the listener), `closeAll()`, `list() -> [{port, createdAt}]`.
- The virtual network never touches host sockets. Real internet access belongs to the runtime's
  http/https (curl, `require('https')`) and to the browser, and both run inside the VM process.

## 5. ProcessTable (`src/kernel/proc.js`) [impl] and the executor contract

Inside a can it is `machine.proc`. It is an EventEmitter with events `'spawn'` (view), `'exit'` (view),
and `'output'` (pid, `'stdout'|'stderr'`, Buffer).

- `spawn(command, {cwd, env, background})` returns a **view**:
  `{pid, command, cwd, env, background, status: 'running'|'exited', exitCode, signal, startedAt, endedAt}`.
  `env` is merged over the can's env. `cwd` must be an existing VFS directory and defaults to `vfs.cwd`.
  The executor starts on the next microtask, never synchronously.
- `get(pid)`, `list({status})`, `output(pid, 'stdout'|'stderr') -> Buffer` (newest 1 MiB, older bytes dropped).
- `writeStdin(pid, data)`, `endStdin(pid)`.
- `kill(pid, signal='SIGTERM'|'SIGKILL'|'SIGINT'|'SIGHUP')`. The process is marked exited at once, with
  `exitCode = 128 + signum` and `signal` set. The executor's `ctx.signal` aborts. Throws ESRCH if it has exited.
- `wait(pid, timeoutMs?) -> Promise<view>`. Rejects with ETIMEDOUT if still running after `timeoutMs`
  (the process keeps running).
- `remove(pid)` (exited only), `clearExited()`, `killAll(signal='SIGKILL')`.

**Executor contract.** `src/runtime/executor.js` default-exports `async function executor(ctx)`:

```
ctx = {
  pid, command,        // command: the raw command line, unparsed (runtime parses it)
  cwd,                 // absolute VFS path
  env,                 // merged environment
  can,                 // owning Machine: can.vfs, can.vnet, can.proc, can.env
  signal,              // AbortSignal, aborted by kill(); signal.reason is the signal name
  stdin,               // Readable; ends on endStdin() or exit
  stdout, stderr,      // Writable; bytes go to the capped ring buffers
}
```

- Return an integer exit code. `undefined` means 0. Throwing writes `err.message` to stderr and exits 1.
- After a kill, output is discarded and the result is ignored.
- Shell features (pipes, `&&`, `>`, `>>`, `&` as `proc.spawn(cmd, {background: true})`) are the runtime's job.
- Unknown commands print `sh: <name>: command not found` to stderr and return 127. See section 11.

## 6. Machine (`src/vm/machine.js`) [impl]

The kernel of one can. It is created inside the can's VM process and never seen by the host directly.
(It was the in-process `Can` before the VM split; tests of kernel behaviour use it in-process with an
injected executor.)

`new Machine({ id, name = id, vfs, env, createdAt, executor })`. Defaults: empty VFS, the runtime executor.
Fields: `id`, `name`, `vfs`, `vnet`, `proc`, `env`, `createdAt`.

- `exec(command, {cwd, env, stdin, timeout})` resolves to
  `{exitCode, signal, stdout, stderr, timedOut}` (utf8 strings). It is a foreground run whose record is removed afterward.
  On timeout (ms) it sends SIGKILL and returns `exitCode: 124, timedOut: true`. Without a `timeout`, the machine's
  `execTimeoutMs` applies (default `DEFAULT_EXEC_TIMEOUT_MS` = 60 000); `timeout: 0` means no limit.
- `spawn(command, opts)` is `proc.spawn`.
- `snapshot()` returns `{format:'can-snapshot', version:1, id, name, createdAt, env, vfs}`, which is JSON-safe.
  Processes and ports are not included.
- `restore(snap)` kills all processes, closes all ports, then replaces `vfs` and `env`.
- `Machine.fromSnapshot(snap, {executor})` creates a new machine with the same id.
- `destroy()` kills all processes and closes all ports.

## 7. Can (`src/can.js`) [impl]

Host-side handle of one can. Every method is an async RPC to that can's VM process (section 9).
Created by `CanManager`; `Can.open({id, name, env, snapshot, layer2})` starts a VM directly.

- Identity: `id`, `name`, `createdAt`, `status` (`'running' | 'crashed' | 'destroyed'`), `vmPid` (the VM process).
- Commands: `exec(command, opts)`, `spawn(command, opts)` (returns the view), `wait(pid, timeoutMs)`,
  `kill(pid, signal)`, `ps({status})`, `getProcess(pid)`, `logs(pid, 'stdout'|'stderr') -> Buffer`,
  `writeStdin(pid, data)`, `endStdin(pid)`.
- Filesystem: `readFile(path, encoding?) -> Buffer|string`, `writeFile(path, data, opts)` (string or bytes),
  `listDir(path)`, `stat(path)`, `exists(path)`, `mkdir(path, opts)`, `rm(path, opts)`.
- Network: `request({port, method, path, headers, body, timeout}) -> {status, headers, body: Buffer}`,
  `listeners() -> [{port, createdAt}]`.
- Browser: `openBrowser(options)` replaces the can's browser; `browse(action, ...args)` runs one of
  `goto reload back forward wait text html links query snapshot click type select submit evaluate
  newTab selectTab closeTab cookieList clearConsole state`. `state` returns `{url, status, title, history, tabs, consoleLog}`.
- State: `snapshot()` (JSON-safe), `restore(snapshot)` (stops processes, closes ports, replaces fs and env).
- `destroy()` stops every process, closes every port, and terminates the VM process.

## 8. CanManager (`src/manager.js`) [impl]

`new CanManager({ storeDir = ~/.can/cans, layer2 = true })`. `layer2: false` exists only for the
layer-1-only test (section 10.4). `DEFAULT_ENV` holds HOME=/home/agent, USER, SHELL, PATH, TMPDIR, LANG.

- `async create({name?, env?})` starts a new VM and returns a `Can`. Seed filesystem: `/home/agent` (cwd and HOME),
  `/tmp` (1777), `/app`, `/etc/hostname` (`can-<8 chars of id>`). Omitted names become `can-N`.
  Duplicate live names throw EEXIST, including two concurrent creates of one name (the name is reserved while pending).
- `get(idOrName)` returns the live can or undefined (synchronous). `list()` returns the live cans.
- `async save(idOrName)` writes `<storeDir>/<id>.json` atomically (tmp file, then rename) and returns the path.
- `async load(id)` starts a saved can in a new VM. If the id is already live, returns the live instance.
- `async destroy(idOrName)` destroys the can, removes it from memory, and deletes its saved file.
  Crashed cans can be destroyed the same way.
- `async destroyAll()` destroys every live can.
- `async stop(idOrName)` and `async stopAll()` stop VMs and remove them from memory, keeping saved files.
- Ids must match `/^[A-Za-z0-9_-]{1,64}$/`. Anything else throws EINVAL, so ids are safe as file names.

## 9. Can VM process and RPC [impl]

**Start** (`src/vm/supervisor.js`). Each can is `child_process.fork(src/vm/worker.js)` with:

- `execArgv`: `--permission`, `--allow-fs-read=<absolute src directory>`, `--max-old-space-size=512` (the heap cap
  of one can, since can code runs in this process), and, with layer 2, `--disallow-code-generation-from-strings`.
  Nothing else is granted: no `--allow-fs-write`,
  `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi`, `--allow-inspector`.
- `env: {}`, `stdio: ['ignore', 'ignore', 'pipe', 'ipc']`, `serialization: 'json'`, `cwd` = src directory.
  libuv still copies Windows system variables (USERPROFILE, PATH, SYSTEMROOT, ...) into any child env,
  so `worker.js` deletes every `process.env` key before any other code runs.
- The VM sends `{t:'ready'}` once booted. Start times out after 15 s.

**Protocol** (`src/vm/protocol.js`). JSON over IPC:
`host -> vm {t:'req', id, op, args}`; `vm -> host {t:'res', id, ok, value | error:{name, code, message, props}}`.
Errors with a `code` are rebuilt as `KernelError`; others as plain `Error` with the same name.

**Ops**: `create`, `restore`, `snapshot`, `exec`, `spawn`, `ps`, `getProcess`, `wait`, `kill`, `logs`,
`writeStdin`, `endStdin`, `readFile`, `writeFile`, `listDir`, `stat`, `exists`, `mkdir`, `rm`, `request`,
`listeners`, `browse`, `openBrowser`, `shutdown`. Unknown ops fail with EINVAL. Results are JSON round-tripped,
so nothing but plain data leaves the VM.

**Lifecycle.**
- `shutdown` destroys the machine and the VM process exits after replying. `destroy()` falls back to SIGKILL after 3 s.
- If the VM exits unexpectedly, every pending and later call rejects with `ECHILD` naming the pid, exit
  code, signal and the last stderr. `can.status` becomes `'crashed'`. The name stays reserved until destroyed.
- The VM stops when the host exits. Two mechanisms: the host kills its VMs in a `process 'exit'` handler,
  and the VM exits on IPC `disconnect` (covers a host that is killed without running exit handlers).

## 10. Security model [impl]

### 10.1 Layer 1: separate process with Node's Permission Model (the real boundary)

- Host file access: denied. The VM may read only the project `src` directory (its own code). Writes anywhere: denied
  (`--allow-fs-write` absent). Verified on Node 24.15.0: `require('fs')`, `process.getBuiltinModule('fs')`
  and `process.binding('fs')` all fail with `ERR_ACCESS_DENIED` for `C:/Windows/win.ini`, and writes fail.
- Host processes: denied. `child_process`, `spawnSync`, `process.binding('spawn_sync')` fail with `ERR_ACCESS_DENIED`.
- Workers, addons, inspector: denied (`ERR_ACCESS_DENIED`, `ERR_DLOPEN_DISABLED`). WASI is not granted; not tested.
- Host environment: the VM's `process.env` is empty after boot. One exception, at the OS level only: `SYSTEMROOT` is
  kept on Windows (section 10.1a).
- **10.1a SYSTEMROOT and DNS.** Windows resolves host names (`getaddrinfo`) through `%SYSTEMROOT%`. Before this
  exception, the boot scrub removed it, and every DNS lookup from a can failed with `ENOTFOUND`: the can had no internet
  access at all, so npm and curl could not reach their hosts. The boot code (`src/vm/worker.js`) now unsets every OS
  variable except `SYSTEMROOT` and replaces the JS `process.env` object with an empty one, so host-side code still sees
  zero keys (`test/vm.test.js` checks this). `SYSTEMROOT` names the Windows folder; it is not a secret.
- Node 24 has **no `--allow-net`** (checked with `node --help`). Outbound network is not restricted; host listening is
  refused in-process (section 10.2, listen guard). See section 10.4, item 1.

### 10.2 Layer 2: in-process hardening (defense in depth)

- **Membrane** (`src/vm/membrane.js`). Every host value entering can code is a Proxy (objects) or a wrapper
  function (functions). Sandbox functions passed to host code are wrapped too, so host code calls them with
  membrane values. Hidden properties: `constructor`, `__proto__`, `caller`, `callee`, `arguments`,
  and the legacy `__lookupGetter__` family, so the route to the host `Function` is closed. A blocked key yields only
  sandbox-realm values. Accessor getters and setters are wrapped like values. Host errors are copied into
  sandbox-realm errors and other thrown host objects are wrapped. Host built-in prototypes map to the sandbox's own
  (so `buf instanceof Uint8Array` holds), and `instanceof` on membrane functions is checked in the sandbox realm
  (so sandbox subclasses of host classes behave). Applied to every JS runtime global and module, and to browser page globals.
- The can's global object has no prototype. Context code generation is off (`codeGeneration: {strings: false}`
  per context, and the process-level `--disallow-code-generation-from-strings`), so `eval` and `Function(string)`
  fail in both realms.
- The VM removes `process.binding`, `process.getBuiltinModule`, `process.dlopen` and `process._linkedBinding` at boot.
- Virtual builtins expose only what the runtime implements (section 11). Module internals (`module.constructor`,
  `require.cache` of the host) are not handed out.
- **Listen guard** (`src/vm/guards.js`, applied at boot in both modes, before any can code runs). The real
  `net.Server.prototype.listen`, `dgram.Socket.prototype.bind`, and `createServer` of `net`, `http` and `https`, and
  `dgram.createSocket`, are replaced with functions that throw `EPERM`. The replacements are non-writable and
  non-configurable, so ordinary code cannot restore the originals. Can networking is virtual (section 4), so nothing
  in Can needs a host listener. Outbound connections (`net.connect`, `http.request`, `https.request`) are unaffected.
- **Stacks** (`src/vm/stacks.js`). Every can context formats error stacks with a filter that drops frames from
  Can's own host code (`file:`, `node:` and Windows drive paths). A can therefore never sees host paths or the
  user's name in an error it prints or reads.

### 10.3 What the tests check (`test/vm.test.js`)

- The original escape (`require('path').resolve.constructor` then reading `C:/Windows/win.ini`) is contained.
- Sixteen routes to a host `Function` (constructor chains, prototypes, descriptors and accessors, errors, events,
  globals, `eval`, `new Function`, legacy accessors) all fail. None reaches host code.
- Membrane unit checks (host process, fresh context): accessors, thrown objects, subclass identity, built-in
  `instanceof`, and identity round trips.
- Writes to host paths, host process spawns and host environment variables all fail. No host marker file appears.
- Browser page scripts cannot reach host intrinsics through `document`, `window`, `location`, `console`, `fetch`.
- **Layer 1 alone** (a can created with `layer2: false`, so the membrane and codegen flag are off): the host
  `Function` is reachable, and every host action is still denied by the permission model: file read, write, spawn,
  `exec`, `process.binding`, `dlopen`, worker, inspector. The host env is empty.
- The VM's real argv (Windows command line check) carries exactly the flags above.
- Crashes report ECHILD; destroy kills the VM; a host that exits, cleanly or hard-killed, takes its VMs with it.
- `test/isolation.test.js`: the listen guard in a helper process (every listen route refused with EPERM, the
  overwrite attempt throws, outbound still works, no host port opens); a **leaked host `net`** inside a layer-1-only
  VM (`host.getBuiltinModule('net')`, `new net.Server().listen`, `http`, `https`, `dgram`) refused with no host port
  open; a can cannot `require('net')`; outbound from a hardened can reaches a non-local host; two cans side by side
  (both listen on 8080, a port of one is refused from the other, files, env and process tables stay separate, and
  destroying one leaves the other running); a heap-exhausting can crashes alone; the default exec timeout.

### 10.4 Residual risks (stated plainly)

1. **Outbound network is not restricted; host listening is refused only in-process.** Node 24 has no `--allow-net`,
   so the permission model cannot restrict sockets. Outbound connections are on by design: `require('http')` to a
   non-local host, `curl` and the browser (internet access is on by default, section 12) all use the real network.
   Listening on a host port is refused by the listen guard (section 10.2), which is layer 2. If a layer-2 escape
   also restored the original functions, a can could listen on a host port. Layer 1 cannot refuse a listen on
   Node 24. Tested with a leaked host `net` in a layer-1-only VM.
2. **Layer 2 is best effort.** The membrane covers the surfaces the runtime hands out; it is not a proof.
   Layer 1 is what holds if layer 2 leaks (section 10.3 tests this directly).
3. **The VM can read the project `src` directory** (its own kernel code, no secrets). Keep secrets out of `src`.
4. **Startup window**: libuv's injected variables exist from process creation until `worker.js`'s body
   runs (its imports load first). No can code runs in that window.
5. **Verified on Node 24.15.0 only.** `package.json` still declares `engines: >=20`; the permission flags
   were not tested on other versions.
6. **Memory is capped, CPU is not.** Each can VM has a 512 MB V8 old-space cap (`--max-old-space-size=512`). A
   can that exceeds it crashes alone (`ECHILD`, other cans run on). The cap covers the JS heap only, so the process
   can use somewhat more in total. A synchronous infinite loop in can code still blocks that can's VM event loop
   (the host stays responsive, and `destroy` kills the VM). Foreground commands time out after 60 s by default.
   Browser page scripts are cut off by `scriptTimeout`. Each can is one OS process.
7. **Crash loses memory state.** A crashed can's unsaved state is gone; `load` restores the last `save`.
8. **Mounted host folders are readable by the VM process.** Each mount adds `--allow-fs-read=<folder>` (no write
   flag), and the VFS refuses every write under it with EROFS. Links on the host are not followed or shown. The
   folder's contents are read live, so a can sees what the user changes there.
9. **The host browser (opt-in, section 13.2) is not sandboxed.** It is a real Chrome or Edge on the host, with the
   host's network. It can reach localhost services. It is off unless the user sets `"hostBrowser": true`.

## 11. Runtime [impl]

- **Shell** (`shell.js`, `builtins.js`, `textcmds.js`): quotes, `$VAR`, `${VAR}`, `$?`, `|`, `&&`, `||`, `;`
  (newline too), `<`, `>`, `>>`, `2>&1` (any `N>&M`), trailing `&`, `*` and `?` globs over the VFS, `NAME=value`
  prefixes, `#` comments, `$(...)` and backticks (nested), `$((...))` integer arithmetic (with `$(...)` inside),
  `${VAR:-w}`, `${VAR:+w}`, `${#VAR}`, `$1`..`$9`, `$@`, `$#`, `$$`. Compound commands: `if`/`elif`/`else`, `for NAME in
  WORDS`, `while`, `until`, `{ ...; }`, `( ... )`, `break`, `continue`, `!` pipelines, functions (`name() {...}` and
  `function name`), heredocs (`<<EOF`, `<<'EOF'`, `<<-EOF`) and here-strings (`<<<`). Not supported: `case`, `${VAR#pat}`
  and other trimming forms, `[[ ]]`, arrays, `&>`, process substitution.
  Shell code is written as generators (`shell.js`): `runShellText` drives it on the event loop (executor path), and
  `runShellSync` drives it to completion for `execSync`. A step that must wait for the loop fails in the sync driver.
  `&` runs a job as a child process; a whole command line ending in `&` (as in `spawn('cmd &')`) runs inline,
  so the returned pid is the job itself.
  Builtins: cd pwd ls cat echo printf mkdir rm cp mv touch env export unset set shift return break continue local read
  eval source . sh bash test [ expr seq basename dirname tr cut date diff tee xargs which ps kill sleep jobs grep head
  tail wc find sed (s/// only) sort uniq true false : exit node npm curl help. `set -e` stops on a failing command.
  `sh file`, `bash file` and `./file.sh` (a `.sh` name or a sh/bash shebang) run a script from the VFS in a fresh shell.
  `echo` takes `-n` and `-e` (backslash escapes). `printf` supports `%s %d %i %f %x %o %c %%`, width, precision,
  `-` alignment, and reuses its format while arguments remain. `/dev/null` works in redirects. Pipelines run their
  stages in order over in-memory pipes; the process's own stdin and stdout stay live streams.
- **npm** (`src/runtime/npm.js`, section 14): `npm run`, `npm test` and `npm start` read the VFS `package.json`. `npm install`
  (with or without package names), `npm ci`, `npm update`, `npm uninstall` and `npm init` work against the registry named by
  the can's policy. `pnpm` runs single packages through the same code; `npx` and the shell find `node_modules/.bin`.
- **JS** (`js.js`, `modules.js`, `http.js`): CommonJS in a `node:vm` context per program, behind the membrane.
  `require` resolves relative paths, `index.js`, `package.json` `main`, and `node_modules` inside the VFS, and loads `.json`.
  ESM (`.mjs`, or a `.js` with import/export lines) is translated to CommonJS by `esm.js`: import and export
  declarations, `export *`, re-exports, destructured exports (`export const { a, b: c } = o`), `import.meta`
  (`url`, `filename`, `dirname`, `resolve`) and dynamic `import()` (also in CommonJS files). A module that uses
  top-level await, or statically imports one, is an async module (`esm.js` `hasTopLevelAwait`, `JsRuntime.isAsyncModule`):
  its body runs as an async function, its imports are awaited with `require.async`, and `require()` of it throws
  ERR_REQUIRE_ASYNC_MODULE, as in Node. The main program and `import()` wait for it. Imports are plain requires for
  other modules, so a cycle sees partial exports.
  `node -e <code>` and `node -p <expr>` (prints the value) run inline code.
  A program stays alive while it has timers, vnet listeners, or outbound requests whose response has not ended.
  `process.exit` and kill clear its timers and close the listeners it opened. An unknown built-in such as `net`
  throws with `code: 'MODULE_NOT_FOUND'`.
- **Built-in modules**: fs (sync, callback, promises), path, http and https (localhost goes to vnet; other hosts
  go out through node's http/https), events, url, util, buffer, timers, os (hostname is the can name), process,
  child_process (routed into the can; `execSync`, `execFileSync` and `spawnSync` run the can shell to completion and
  never reach the host; a command that needs the event loop, such as `sleep` or a program with timers, exits with
  status 1 and says it needs the asynchronous shell),
  crypto, stream, querystring, string_decoder, assert. Any other module, including `net`, `worker_threads`,
  `dgram`, `vm` and `inspector`, throws MODULE_NOT_FOUND with an explanation.

## 12. Browser (`src/browser/`) [impl]

`new Browser({can, scripts=true, internet=true, timeout=30000, maxBytes, userAgent, scriptTimeout=5000})`
(or `createBrowser(opts)`), where `can` is any object with a `vnet` (a Machine inside a VM, or a test double).
Files: `html.js` (tolerant parser and DOM), `selector.js` (CSS selectors, `findByText`),
`net.js` (routing, redirects, cookie jar), `script.js` (node:vm inline scripts with a DOM bridge behind the membrane),
`browser.js` (tabs, history, actions, snapshot).

- **Internet access is ON by default.** `new Browser()`, `openBrowser()` and every MCP browser tool use `internet: true`:
  any http(s) URL that is not local (for example `https://example.com/`) is fetched over the real network from the
  VM process, with cookies kept in the browser. Pass `internet: false` to `openBrowser` (or `new Browser`) to refuse
  them with `EPERM`. Local addresses never leave the can.
- **Routing.** `localhost`, `127.0.0.1`, `[::1]`, the can's name or id, and bare ports (`3000/x`, `http://3000/`) go to `can.vnet.request`. Other http(s) URLs use `node:http(s)` unless `internet: false`.
- **Navigation.** `goto`, `back`, `forward`, `reload`, `wait(ms)`. Redirects 301/302/303/307/308, at most 10 (ELOOP). Cookies live in the browser (`cookieList()`). `newTab`, `selectTab`, `closeTab` keep separate histories.
- **Reading.** `text([target])`, `html()`, `query(selector)` gives `[{tag, text, attrs}]`, `links()`, `snapshot()`.
  In a snapshot, runs of inline text (text and `<span>`-like elements with no control, link or image in them) become
  one `text` line, so `<p>Signed in as <span>ada</span>.</p>` reads `text "Signed in as ada."`. Links and controls
  keep their own lines and refs.
- **Acting.** `click`, `type`, `select`, `submit`, `evaluate`. A target is a snapshot ref (`e12`), a CSS selector, or visible text (links, buttons, field labels). Refs are stable per element for the life of a document; a removed element's ref raises ENOENT.
- **Scripts** (`browser.js` `_runScripts`, `_runScriptElement`, `_importModule`; `script.js`). Classic scripts run as the parser meets them; `defer` and `type="module"` scripts run next, in order; `async` scripts run last; then DOMContentLoaded and load. External `src` files are fetched through the same routing as navigation. Module scripts resolve their imports against their own URL (relative and absolute URLs only; bare names throw) and run once per URL. `document.write` inserts after the running script. A `<script>` that is created and inserted (`createElement`, `appendChild`) runs. `innerHTML` does not run scripts. `history.pushState` and `replaceState` change the URL without reloading, and back or forward between entries of the same document fires `popstate`. `XMLHttpRequest` (async only), `fetch` and `Headers` share one request path. Not supported: `history` across documents, bare module names, a synchronous XHR.
- **Errors** use KernelError codes: ENOENT (no match), EINVAL (bad input), ECONNREFUSED, ETIMEDOUT, EPERM (internet disabled), ELOOP, EFBIG.
  A network failure from the real internet keeps Node's code as the KernelError code, for example
  `ENOTFOUND: cannot reach example.com (getaddrinfo ENOTFOUND example.com)`.
- Page scripts run in node:vm behind the membrane (section 10.2). They are cut off by `scriptTimeout`.
- Real internet from inside a can uses the VM process's `node:https`, so it is subject to the network residual risk (10.4.1).
  Listening on a host port is refused by the listen guard (10.2); outbound requests are not affected.

### 12.1 Screenshots (`src/browser/render.js`, `png.js`, `font.js`) [impl]

- **Approximation, stated plainly.** `renderPage(doc, {width=1280, height=800, fullPage})` turns the parsed DOM into
  RGBA pixels. It is not a browser and not pixel-exact. It does block and inline flow with word wrapping, simple
  tables, lists, `<hr>`, boxes for form controls, and pictures (PNG, JPEG, WebP, SVG; other formats are grey boxes with alt text). Headings, bold, links and
  underline are drawn. Flexbox (rows and columns, wrap, justify, align, gap, grow, basis) and grid (px, %, fr, auto and
  `repeat()` tracks, gap, items placed row by row) are laid out by `flexChildren` and `gridChildren` in render.js. Their
  item widths come from a scratch layout (`measureItem`, memoised per render). There is no grid span, `minmax()`,
  `auto-fill`, floats, positioning, `@media`, web fonts, image loading or italics. Text uses a built-in 5x7 bitmap
  font written for this project (`font.js`), scaled by size / 8.
- **CSS.** Only a whitelist is applied (see `setProp` in render.js): color, background(-color), font-size,
  font-weight, font-style (recorded only), text-decoration, text-align, visibility, white-space, display (block,
  inline, inline-block, list-item, table, table-row, table-cell, none), margin, padding, width, height, and border
  colour. Sources: UA defaults (written as CSS), `<style>` blocks and `style=""`. Selectors come from selector.js with
  an approximate specificity. Unknown properties are ignored. Hidden: display none, the hidden attribute,
  visibility hidden.
- **Margins.** Adjacent sibling margins collapse to the larger one. A child's top margin does not collapse through its
  parent, and a last child's bottom margin is not added to the parent.
- **Where it runs.** `Browser.screenshot({fullPage, width, height})` in the VM child returns a PNG Buffer (with no page
  loaded, a blank page). The child sends it over IPC as base64 (replies are JSON). `Can.screenshot(opts)` on the host
  decodes it. The host writes the bytes: into the can's VFS, and with a host path, under the transfer root via
  `writeTransferFile` (transfer.js), which applies the same rules as `exportFromCan`. The child's permission
  flags and membrane are unchanged; the child only renders and encodes.
- **Limits.** width 1..3840, height 1..4096, width times height at most 8,388,608 pixels, with fullPage growing the
  height to the content up to 4096 px. Out-of-range values are EINVAL.
- **PNG** (`png.js`). Encoder: 8-bit RGB or RGBA, filter type 0 per row, one IDAT from `node:zlib`, CRC-32 by hand.
  Decoder: 8-bit RGB or RGBA, non-interlaced, all five filter types, CRCs verified (tests use it to read pixels).
- **Tests:** `test/screenshot.test.js`.

### 12.3 Pictures (`src/browser/image.js`, `webp.js`, `vp8.js`, `vp8l.js`, `svg.js`) [impl]
- **Sniffing.** `decodeImage(bytes, hint)` picks the decoder from the first bytes: PNG, JPEG, RIFF/WEBP, or an `<svg`
  element near the start. Anything else returns null (drawn as an outline with its alt text).
- **WebP lossless** (`vp8l.js`): transforms (predictor, cross colour, subtract green, colour indexing), prefix codes,
  LZ77 and the colour cache. **WebP lossy** (`vp8.js`): a VP8 key frame: boolean decoder, segments, token partitions,
  intra prediction, inverse transforms, the loop filter, and YUV to RGBA with the 9-3-3-1 chroma upsampler. Tables
  (`webp-tables.js`) are extracted from RFC 6386 and the WebP lossless specification, not typed in. **Alpha** (ALPH):
  raw or lossless, with the four filters. An animation draws its first frame. Output matches libwebp bit for bit on the
  fixtures in `test/fixtures/webp` (checked by SHA-256 of the pixels).
- **SVG** (`svg.js`): an XML reader, the document's style sheets (simple selectors), presentation attributes, the
  shapes, paths (all commands, arcs as cubics), transforms, `<use>` and `<symbol>`, opacity, colours, and
  viewBox fitting. Fills and strokes are anti-aliased (four sub-scanlines per row, exact horizontal coverage).
  Not drawn: text, `<image>` (external or data), filters, masks, clipping, patterns, dashes. A gradient paints its
  average stop colour. Its size is the page's width/height attributes when they are given, else its own.

## 13. Agent interfaces [impl]

- **Registry** (`src/registry.js`): `CanRegistry` wraps `CanManager` and is the only place that knows
  which cans exist. `list()` returns live and saved cans. `get(ref)` loads a saved can on first use (concurrent
  calls share one load). `create` saves right away, names are checked against live and saved cans, and omitted
  names become can-N. `shutdown()` saves running cans and stops every VM, keeping saved files. The store is
  `$CAN_STORE_DIR`, else `~/.can/cans`.
- **MCP** (`src/mcp/server.js`, `src/mcp/tools.js`, `bin/can-mcp.js`): JSON-RPC 2.0 over newline-delimited stdio,
  protocol 2025-06-18 (2025-03-26 and 2024-11-05 are also accepted). Methods: initialize, ping, tools/list, tools/call;
  notifications are never answered; unknown methods get -32601. Tool errors are results with isError:true. Output is
  capped at about 20 KB, keeping the head and the tail. Stdout carries protocol messages only. Stdin closing or SIGINT
  and SIGTERM saves running cans and stops their VMs. Browser tools reach the internet by default (section 12).
  Tools: can_create (with optional `mounts`), can_mounts, can_list, can_destroy, can_save, can_exec,
  can_spawn, can_ps, can_logs, can_kill, can_read_file, can_write_file, can_import, can_export, can_list_dir, can_ports, can_http, and
  (only when the user enables the host browser, section 13.2) host_browser_goto, _text, _evaluate, _screenshot, _close.
  The host browser tools use `src/hostbrowser.js`, outside any can.
  browser_goto, _snapshot, _click, _type, _select, _submit, _text, _query, _back, _evaluate, _console, _screenshot. Navigation
  and click or submit tools return the new snapshot. `browser_screenshot` returns text plus an image content block
  (`type: "image"`, base64, `image/png`) when the PNG is at most 1 MiB; it writes into the can and, with `hostPath`,
  under the transfer root (section 12.1, section 13.1).
- **CLI** (`bin/can.js`): `create (--mount label:/canPath) mounts ls rm exec spawn ps logs kill cp import export cat browse screenshot shell mcp help`. Each
  invocation is a new process: it loads only the can it names, and saves after changes. Background processes stop
  when their invocation ends. They live on in `can mcp` and `can shell`. `cp`, `import` and `export` move files in
  either direction (section 13.1).

### 13.1 File transfer (`src/transfer.js`) [impl]

- `importToCan(can, hostPath, canPath, {overwrite, limits})` reads a host file or directory (any path the host names)
  and writes it into the can, creating parent directories. `exportFromCan(can, canPath, hostPath, {overwrite, root,
  limits})` copies a can file or directory to the host. Export writes only under the transfer root.
- **Transfer root**: `$CAN_TRANSFER_DIR`, else `%USERPROFILE%\.can\transfer` (`~/.can/transfer`). `hostPath` is resolved
  against it. A path that leaves it (`..`, an absolute path outside, or a link inside that points out) is refused with
  EPERM before anything is written.
- **Limits** (`LIMITS`): 256 MB per file, 500 MB and 5000 files per call. Exceeding one is EFBIG, checked before the first
  write.
- **Links**: on import, a symlink must resolve inside the source directory (for a named file, inside its own
  directory). Links to directories are refused. On export, the walk does not follow links inside the can (they are
  counted as skipped). A canPath whose last part is a link is refused (EPERM) for files and directories alike, so
  the rule is: links inside a directory are skipped, a link named as the source is refused. Earlier parts of canPath
  resolve as the can's own paths do. A destination whose path passes through a host link is refused.
- **Existing files** are kept unless `overwrite` is set (EEXIST). The whole plan is checked before the first write.
  Transfers to one can run one at a time (a lock per can, `withCanLock`), so with overwrite false two calls that
  name one destination cannot both succeed: one wins and the others get EEXIST. The lock covers transfers in one host
  process; a can written by another process (another CLI run) is not locked against this one.
- **Names**: every name an export writes (each can segment and each host path segment) must be a valid Windows name:
  no `< > : " | ? * \` or control character, no trailing dot or space, and no reserved device name (CON, PRN, AUX, NUL,
  COM1-9, LPT1-9, with or without an extension). Failures are EINVAL, checked before the first write. Names in one
  export that differ only by case (`A.txt` and `a.txt`, or a file and a directory) are EINVAL too, on every host.
  `writeTransferFile` applies the same name rules.
- **Errors**: error text never holds a host path. Names are shown relative to the source or the transfer root, or as a
  base name. A raw Node error is rewritten to its code with the operation and a base name. A host file where a folder
  belongs is ENOTDIR, checked in the plan.
- **Binary**: transfers move Buffers over RPC as base64. `can_write_file` and `can_read_file` take
  `encoding: "utf8" | "base64"` (default utf8). A base64 read is capped at the 20 KB output limit. `decodeBase64` is
  strict: whitespace is ignored, the length must be a multiple of 4, padding only at the end, and the bytes must
  re-encode to the same text (`QR==` is EINVAL; `QQ==` is the canonical form). The 256 MB limit is checked on the
  encoded length before decoding, and again on the decoded bytes. A UTF-8 `can_write_file` refuses a lone surrogate
  (EINVAL) rather than storing U+FFFD.
- **Tool schemas**: every MCP tool input schema sets `additionalProperties: false`, so an unknown argument (a typo
  such as `overWrite`) is an "Invalid arguments" error, not silently ignored.
- **Bytes that are not a can file** (screenshots): `writeTransferFile(bytes, hostPath, {overwrite, root})` writes under
  the transfer root with the same checks as export (EPERM for an escape or a link on the way, EINVAL for Windows-unsafe
  names, EEXIST unless overwrite). Only the host calls it.


## 13.2 Mounts and the host browser [impl]

**Host allowlist** (`src/mounts.js`). The user's file, `%USERPROFILE%\.can\mounts.json` (or `$CAN_MOUNTS_FILE`), maps
labels to host folders: `{"mounts": {"<label>": {"path": "...", "description": "..."}}, "hostBrowser": false}`. A can and
an agent name only a label. `resolveMounts` checks the label, an absolute `canPath` (not `/`), that the mount points do
not overlap, and that the host folder exists. Its errors name labels and can paths, never host paths. `listMounts` (the
`can_mounts` tool and `can mounts`) returns labels and descriptions only.

**Mounting.** `CanManager.create({mounts})` and `load` resolve the labels to `{label, canPath, hostDir}`. `Can.open`
gives `hostDir` to the VM as a read permission (`vmExecArgv({mounts})`, no write permission) and sends `{label, canPath,
hostDir}` in the `create` or `restore` op. `Machine.mountAll` calls `VFS.mount`, which puts a `HostNode` at `canPath`.
A `HostNode` reads the host on every access, so changes show at once. Its setters and the `HostEntries` map refuse every
change with EROFS, and its errors name only the can path. A mount root cannot be detached or renamed over. A mount
cannot sit inside another mount. `VFS.serialize` writes a mount as an empty folder, and `Machine.snapshot` saves
`mounts: [{label, canPath}]`, so a saved can holds no host path. A load whose label is no longer in the file fails with
ENOENT.

**Host browser** (`src/hostbrowser.js`). Only when `"hostBrowser": true` is set: the MCP server then adds the
`host_browser_*` tools (`createHostBrowserTools`). `HostBrowser` finds Chrome or Edge (`CAN_HOST_BROWSER` first), starts
it headless with `--remote-debugging-port=0` and a fresh temporary profile, reads the `DevTools listening on` line from
stderr, and speaks CDP over Node's global WebSocket. `goto` accepts only http and https URLs (`checkHostUrl`, EPERM for
the rest). `screenshot` writes its PNG under the transfer root through `writeTransferFile`. `close` closes the browser,
waits for it to exit, and deletes the profile (retrying while Windows holds files; it never throws). The launch and the
server's exit both kill a browser that is still running. It is not a can, and it is outside the security model of
sections 10 and 10.4: it is a real browser on the host.

## 14. Environment specs and network policy (`src/environment.js`, `src/vm/policy.js`) [impl]

An agent can set a can up before it boots: `can_create` takes an `environment` object, and the CLI takes
`can create --spec file.json`. The spec is checked in full first (`normalizeEnvironment`, which touches nothing on
the host), so a bad value costs nothing. Then `CanManager.create` boots the can and applies the steps in this order:

1. `requireTools`: each named command must answer `which` in the can. Native toolchains (cargo) are not there, so a
   spec that needs them fails here with the reason.
2. `workdir`: created; setup commands run in it, and it becomes the folder that `exec` and `spawn` start in when they are
   not given a `cwd` (`Can.setCwd`, saved with the can).
3. `imports`: host files or folders copied in with `importToCan`. `exclude` names entries to leave out at any depth
   (`node_modules`, `.git`, `*.log`; `*` matches inside one name, and a name with "/" is refused). Symbolic links to
   folders are still refused, as in section 13.1, so exclude a folder whose links would not resolve.
4. `files`: written inline (utf8 or base64), replacing existing files unless `overwrite` is false.
5. `setup`: commands run in order in the workdir, each with its own `timeoutMs` (default 300 s, at most 600 s). A failing
   step (unless `optional`) stops the sequence.

Any failure destroys the can before it is returned, and the error carries the step's output, so no agent is left with a
half-set-up can. `can.report` keeps what happened, and `describeReport` prints it for the agent.

**Policy** (`src/vm/policy.js`) is kept on the can and in its snapshot, so a reloaded can keeps it. Keys:
- `internet` (default true): when false, the browser, `curl`, the JS `http`/`https` modules and `npm` all refuse
  outbound requests with `EPERM` (or curl exit 7). The check is in the runtime, not in the host.
- `registry` (default `https://registry.npmjs.org/`): where `npm` reads packuments and tarballs. An http or https URL.
- `nodeVersion` (default: the runtime's `v20.11.0`): what `process.version` and `process.versions.node` report. The
  can's JavaScript runs on the host's Node engine either way, so this changes what an app sees, not what the engine
  supports.

**npm** (`src/runtime/npm.js`): a small registry client. Ranges: exact, `^`, `~`, comparators, x-ranges, hyphen ranges,
`||`, dist-tags. Prereleases match only when the range names a prerelease of that version. Tarballs are gunzipped and
read as tar (ustar, pax and long-name headers); entries that leave the package are refused; sha512 or sha1 integrity
is checked before anything is written. The layout is flat: the first version of a name is hoisted to `node_modules`,
and a conflicting version is nested under the package that asked for it. Optional dependencies that cannot be
resolved are skipped with a warning. Platform lists (`os`, `cpu`) are honored for linux x64. Each package's bin entries
become shims in `node_modules/.bin` that run the bin file with `argv[1]` set to it.

Not done, and reported as warnings or errors rather than guessed at: install scripts (`preinstall`, `install`,
`postinstall`) never run; native addons cannot load (the VM may not `dlopen`); peer dependencies are not installed;
git, file and workspace specs are refused; there is no lockfile, and no pruning of packages removed from package.json
by hand. `pnpm` workspaces (`-r`, `-w`, `--filter`, `pnpm-workspace.yaml`) are refused.

**Shebangs.** A `#!` first line is blanked before a module is wrapped (`stripShebang` in `src/runtime/js.js`), so bin
scripts with `#!/usr/bin/env node` load. Line numbers are unchanged.

**Code generation.** Packages that generate code from strings (`new Function`, `eval`) fail in a can, by design: the
layer-2 flag `--disallow-code-generation-from-strings` stays on. Express loads without them (its `depd` dependency only
generates code when `deprecate.function` is called), so the load-time failure is gone, but see "Express" below.

**Express 5 works.** `require('express')` loads, a request is answered, and JSON and form bodies are parsed, so an Express
app that listens on a port boots and serves requests (`test/boot-frameworks.test.js`, live run with `CAN_LIVE_TESTS=1`). Four
faults stood in the way, and each is fixed where it lives:
- **Streams run in the can's realm.** `require('stream')` is `src/runtime/sandbox/stream.js`, a stream library written in
  JavaScript and run inside the can (`JsRuntime.loadInternal`). A host stream class cannot be subclassed the ES5 way
  (`Transform.call(this)` leaves the state on the sandbox object, which the host never sees), and iconv-lite does exactly that.
  `test/stream.test.js` covers it. `stream/promises` is the promise form of the same module.
- **Membrane getters on a replaced prototype.** After Express sets a request's prototype, a host getter such as `readable` ran
  with the proxy as receiver and answered wrongly. It now runs on the host object, and its result is still wrapped
  (`src/vm/membrane.js`, `ownerOf`).
- **The request looks like a live request.** The request's socket is an EventEmitter that is readable and writable, and the body
  is pushed on the readable side (not ended on the writable side), because on-finished checks those. `vnet.request` sets
  `Content-Length` for a body, as a real client does (`src/runtime/http.js`, `src/kernel/vnet.js`).
- **Promise work finishes.** A program ends once nothing keeps it alive, but that check now runs on a later macrotask, so
  promise continuations that are already queued run first (`JsRuntime.checkAlive`, `src/runtime/js.js`).

Native code is still out of reach: a Node addon, a program in another language, or a JVM. Running those needs a backend
that starts real processes, which the sandbox rule in section 1 forbids for a can today. That is a decision for the owner,
not something this section changes.

**Host callbacks and process.exit.** `process.exit()` inside a callback that host code runs (a response's `end` event, a
socket event) used to take the whole can VM down: the unwinding error reached host code as an uncaught exception. The
host wrapper of a sandbox function now swallows a `ProcessExit` that comes out of it, since the program has already
finished (`src/vm/membrane.js` `_hostWrapper`; `test/membrane-hosts.test.js`).

**`http` classes.** `http.IncomingMessage` (a PassThrough subclass) and `http.ServerResponse` are exported, and
`http.OutgoingMessage` is the same as `ServerResponse`. Requests are `IncomingMessage` instances with a loopback
`socket`, so `req.ip` and proxy checks work.

## 14.1 CI pipelines (`src/ci.js`, `bin/can.js ci`, `can_ci`) [impl]

`normalizeCi` checks a pipeline in full before anything runs: unknown keys, job and step limits (20 jobs, 50 steps per
job, 10 artifacts), names, `cwd` and `env` names, `timeoutMs` (1 to 600000), `keepCan` (`on-failure`, `always`,
`never`), and the environment (checked by `normalizeEnvironment`, as in section 14). `runCi(registry, spec, {transferRoot})`
then:

1. creates one can named `ci-<8 hex>` from the raw environment (`registry.create`). If the setup fails, the manager has
   already destroyed the can, and the report says `setupFailed`;
2. runs each job in order. A step is `can.exec(run, {cwd, env, timeout})` with `cwd` defaulting to the environment's
   `workdir`. A nonzero exit code or a timeout (`timedOut`, exit 124) fails it. The rest of its job is `skipped`. A job
   that fails stops the later jobs unless it has `allowFailure`; a step with `allowFailure` is `allowed-failure` and
   does not fail its job;
3. if every job passed, exports each artifact with `exportFromCan` under the transfer root (the rules of section 13.1).
   An export error fails the run;
4. keeps the can (`registry.save`) or destroys it (`registry.destroy`), by `keepCan`. A VM that dies mid-run is reported
   as `the run stopped`, and the can is kept under `on-failure`.

The report is `{ok, name, canName, kept, seconds, jobs: [{name, status, allowFailure, steps}], artifacts, error?,
setupFailed?}`. Each failing step carries the last 2 KB of its output. `describeCi` prints it for an agent or a terminal.
Tests: `test/ci.test.js` (checks, order, skips, keeping, timeouts, artifacts, report text), `test/cli.test.js` (`can ci`
exit codes), and `test/mcp.test.js` (`can_ci`).

What a pipeline does not do is what a can does not do (section 11, section 14): no native toolchains, no install scripts,
no workspaces, and no matrix over Node versions.

## 12.2 Browser APIs for boot (`src/browser/webapis.js`, `script.js`) [impl]

Pages probe the platform when they start. The page global provides these, so a page boots instead of stopping on the
first missing API.

**Real:**
- `matchMedia` (the renderer's media rules, for the 1280 x 800 viewport), `innerWidth`/`innerHeight`, `devicePixelRatio`,
  `screen`, `visualViewport`, `window.parent`/`top`/`frames` (the window itself).
- Layout queries: `getBoundingClientRect`, `getClientRects`, `offsetWidth/Height/Top/Left`, `clientWidth/Height`,
  `scrollWidth/Height`, `width`/`height` of canvases and images. They read `layoutPage` (render.js), the layout the renderer
  draws. The layout is redone after a DOM or attribute change, when a script asks for it.
- `MutationObserver` (childList and attributes, subtree optional), delivered in a microtask. `ResizeObserver` and
  `IntersectionObserver` report their targets once, as visible at the 1280 x 800 viewport.
- DOM classes for `instanceof` (`Node`, `Element`, `HTMLElement`, `HTMLDivElement` and the common tags, `Text`, `Comment`,
  `Document`, `DocumentFragment`). Each one is the prototype the wrappers inherit from.
- Element methods: `insertAdjacentHTML/Element/Text`, `cloneNode`, `before`, `after`, `replaceWith`, `toggleAttribute`,
  `getAttributeNames`, `attributes`, `innerText`. Document: `createDocumentFragment` (flattened into its parent when
  inserted), `createRange().createContextualFragment`, `importNode`, `createEvent`, `visibilityState`, `fonts`.
- `on<type>` properties (`el.onclick = fn`, `window.onload = fn`) run after the listeners on the same node.
- A 2D canvas context (`getContext('2d')`) accepts every drawing call. `measureText` estimates the width. Nothing is painted,
  so canvas content does not appear in screenshots. `getContext('webgl')` returns null.
- `FileReader`, `File`, `Blob`, `FormData`, `crypto.randomUUID`/`getRandomValues`, `structuredClone`, `console.table`,
  `console.group`, `console.time`, `navigator.clipboard`, `getComputedStyle` (inline style and default display only).

**Stubs (they never throw; they report failure the way a browser does):**
- `WebSocket` is closed and fires `error` and `close`. `Worker` fires `error`. `indexedDB.open` fires `error`.
- `navigator.geolocation` reports denial. `Notification` is denied. `navigator.sendBeacon` returns true.
- `video` and `audio` methods resolve without playing. `iframe` is not loaded.
- `getComputedStyle` does not apply `<style>` rules.

**Errors.** A failing script is logged and the next script still runs. An unhandled promise rejection in a page is logged in
the console. In the can, the VM worker keeps running (before this, one such rejection ended the can's process).
