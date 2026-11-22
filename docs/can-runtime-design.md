# Can runtime design

Status: draft for review. Nothing here is implemented.
Date: 2026-11-22.
Base: worktree `claude/app-boot-infrastructure-c4e589`, including its uncommitted Express 5 fixes.
Scope: the runtime tier, how tools get into a can, the 500 MB memory ceiling, reliability, and the MCP surface. Minecraft is out of scope.

Conventions:
- `file:line` references point into that worktree.
- Web sources are linked inline and listed in section 8.
- "UNVERIFIED" marks a claim that no current primary source or local test confirmed. Treat it as an assumption to test, not a fact.
- Error texts and example outputs are proposed wording unless they quote the code.

## 1. Summary

- Adds a WASI tier to each can. It runs in the same child process as the JS tier, so one process has one memory budget and one lifecycle.
- Does not add a microVM. It is unavailable on Windows 11 Home, needs admin rights and a reboot on Pro, and needs signed entitlements on macOS. It stays a possible later Linux tier.
- Python: pinned CPython 3.15.2 built for WASI 0.1 (SDK 33). `pip` installs pure-Python wheels only. Environment installs need a hash lock. Interactive installs are checked against the registry's hash but are not pinned (question 15).
- Rust: a can runs prebuilt `wasm32-wasip1` programs. It cannot compile Rust or run Cargo. This is a limit of this design, and the owner decides.
- Memory: 500 MB per can, measured on the child process. It is a true OS-enforced cap only on Windows with the native helper (question 4) and on Linux later. On macOS it is enforced by sampling and can overshoot briefly (question 5). Proposed V8 heap cap: 256 MB, cut from the current 512 MB. Wasm memory capped at 160 MiB. A watchdog refuses new work at 450 MB and stops the can at 500 MB.
- Tools come from a shipped `toolchains.lock.json`. Every runtime download has a pinned version, size and sha256 in the manifest. Bundled items (Node, the WASI shim) are verified when the installer is built and are never downloaded at runtime.
- MCP: add `can_status`. Make `can_create` transactional and idempotent, and let it restart a crashed can from its last save. Fix the `can_destroy`, `can_exec` and `can_ci` contracts. Fold `can_ps` and `can_ports` into `can_status` if the owner agrees.
- Unchanged: the JS tier, the bundled Node, and the browser, computer and record tools.

## 2. Runtime tier

### 2.1 Constraints recap

- No Docker, Podman, WSL, QEMU or other installed software. The task brief sets this rule.
- Platforms: macOS and Windows first, Linux later.
- Memory: 500 MB per can. Today the V8 heap cap alone is 512 MB, and CPU is not capped (SPEC.md:313-315, current worktree).
- It must work on first run, with no manual steps.

### 2.2 Options considered

- **A.** Keep the JS tier only. It uses Node built-ins only. Native toolchains fail in `requireTools`, and native addons cannot load (SPEC.md:536-537, 560-568).
- **B.** JS tier plus an in-process WASI tier (the chosen design).
- **C.** A minimal Linux microVM per can.

### 2.3 Comparison

| Criterion | B: JS tier + WASI tier | C: Linux microVM per can | Winner |
|---|---|---|---|
| Reliability: first run, manual steps | No manual steps. Pure JS in the existing child process. | Windows Home: not available. Windows Pro: admin rights, a feature toggle and a reboot ([Hyper-V install](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v)). | B |
| Startup | UNVERIFIED (no measurement). | Firecracker states a boot target of 125 ms or less and 5 MiB or less of VMM overhead. Both hold only under specific conditions, and on Linux only ([spec](https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/SPECIFICATION.md)). No macOS or Windows figure (UNVERIFIED). | tie/unknown |
| Memory enforcement | Watchdog on the child process: soft limit 450 MB, hard limit 500 MB. Worker `resourceLimits` do not bound ArrayBuffers, so they do not bound wasm memory ([worker_threads](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)). No usable OS hard cap on macOS (UNVERIFIED). | A fixed guest RAM size is a true hard cap. | C |
| Fits 500 MB | Yes, by the budget split in 4.2. | Yes, by guest RAM set at boot: a 384 MB guest plus Firecracker's 5 MiB or less VMM overhead fits. Linux figure only; UNVERIFIED for macOS and Windows VMMs. | tie/unknown |
| Cross-platform effort | Pure JS on macOS and Windows, Home and Pro. A Windows hard cap needs a small native helper (open). | macOS: needs the virtualization entitlement, so the app must be signed ([Apple](https://developer.apple.com/documentation/virtualization/adding-the-virtualization-entitlement-to-your-project)). The installers are unsigned (README.md:28). Windows: no Windows-hosted VMM found that meets the constraints (UNVERIFIED). Linux: Cloud Hypervisor needs KVM or MSHV and kernel 6.8 or later ([repo](https://github.com/cloud-hypervisor/cloud-hypervisor)). Firecracker uses KVM (or AWS Nitro); no macOS or Windows host support documented ([repo](https://github.com/firecracker-microvm/firecracker)). | B |
| Compatibility: Python | Pinned CPython WASI build. Pure-Python packages only. Subprocess, threads and sockets are unavailable ([CPython docs](https://docs.python.org/3/library/intro.html)). Running CPython under browser_wasi_shim: UNVERIFIED. | Yes, real Linux. | C |
| Compatibility: Rust compile | No. | Yes, real Linux. | C |
| Compatibility: Rust run | Yes, for `wasm32-wasip1` `.wasm` files ([rustc](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip1.html)). | Yes. | C |
| Compatibility: Cargo | No. | Yes, real Linux. | C |
| Compatibility: pip C extensions | No. PEP 783 defines only Emscripten wheel tags, so no WASI wheel tag exists ([PEP 783](https://peps.python.org/pep-0783/)). | Yes. | C |
| Compatibility: subprocess | No ([CPython docs](https://docs.python.org/3/library/intro.html)). | Yes. | C |
| Security boundary | Node process permissions, not a VM. Node says the permission model gives no guarantees against malicious code ([permissions](https://nodejs.org/docs/latest-v24.x/api/permissions.html)). | Hypervisor guest boundary. How it compares with B: UNVERIFIED. | tie/unknown |

### 2.4 Decision

B wins. C loses for these reasons. It is unavailable on Windows 11 Home. On Pro it needs admin rights, a feature toggle and a reboot, which breaks first-run success. No Windows-hosted VMM was found that meets the constraints (UNVERIFIED). On macOS it needs signed entitlements and a native helper. Microsoft does not test or support Hyper-V running inside a non-Microsoft hypervisor, so a Windows machine that is itself a VMware or VirtualBox guest cannot be relied on to host a microVM ([Microsoft](https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/user-guide/nested-virtualization)).

C wins on compatibility (real Linux for Cargo, pip C extensions and subprocess) and on a true hard memory cap. B accepts both gaps. C stays a possible later tier for Linux hosts. It is not part of this design.

### 2.5 How the WASI tier works

- The WASI tier runs in the same can child process. It needs no `--allow-wasi` flag.
- Syscalls are served by a pure-JS `wasi_snapshot_preview1` implementation over the can's virtual filesystem. The candidate is `@bjorn3/browser_wasi_shim` 0.4.2, vendored and pinned. It has an in-memory filesystem and covers `fd_*`, `path_*`, clocks, random and `proc_exit` ([src/wasi.ts](https://github.com/bjorn3/browser_wasi_shim)). It has no runtime dependencies ([npm registry](https://registry.npmjs.org/@bjorn3/browser_wasi_shim)). Whether it runs CPython: UNVERIFIED.
- Why not `node:wasi`. Node marks it experimental. Its docs say not to rely on it to run untrusted code. They also say filesystem sandboxing can be escaped. Its preopens map to real host directories ([Node WASI docs](https://nodejs.org/docs/latest-v24.x/api/wasi.html)).
- Compile and instantiate run in the child process's main realm (src/vm/worker.js), outside the can's `vm` context. The can's JS code can then keep `codeGeneration.wasm: false` ([vm docs](https://nodejs.org/api/vm.html) describe the setting). In a `vm` context with that setting, the local test below threw `CompileError: WebAssembly.Module(): Wasm code generation disallowed by embedder`.
- Local test, Node v24.15.0 on Windows 11 (Node 20 not tested). Plain WebAssembly `Module`, `compile` and `instantiate` succeeded in four runs: plain, `--disallow-code-generation-from-strings`, `--permission --allow-fs-read=<dir>`, and all of those with `--max-old-space-size=256`. A module that declares a memory with maximum 2 pages also instantiated. `Memory.grow` past its maximum throws `RangeError`. The test also ran a `vm` context: `vm.createContext({}, {codeGeneration:{strings:false, wasm:false}})` threw `CompileError: WebAssembly.Module(): Wasm code generation disallowed by embedder`, and `wasm:true` worked. Conclusion: the current child flags do not block the WASI tier. Not tested: `node:wasi` under `--permission`, which this design does not use.

- In the can shell, a command whose path ends in `.wasm` runs that file in the WASI tier, with the given arguments, stdio and the can's working directory.
- `python` and `pip` are built-in commands that run the pinned `python.wasm`.
- `environment.tools` version resolution: `"3.15"` picks the single lock entry with that prefix. An exact version must match a lock entry exactly. Anything else fails with `ENOTSUP: no python matching "3.9" in this build. Next: use one of: 3.15.2.`

### 2.6 What each tier can and cannot run

| Workload | JS tier (today) | WASI tier (proposed) | Source |
|---|---|---|---|
| JS and npm packages | Node built-ins only. Native addons cannot load. | Not in scope. | SPEC.md:560-568 |
| Python programs | No. | Yes, pure-Python code and wheels only. | 3.3 |
| Prebuilt Rust programs | No. | Yes, `wasm32-wasip1` `.wasm` files. | 3.4 |
| Rust compile | No. | No. | 3.4 |
| Cargo | No. `requireTools` fails for cargo. | No. | 3.4, SPEC.md:536-537 |

Lesson from the Express 5 fixes (uncommitted, in `src/runtime/sandbox/`, `js.js`, `membrane.js`, `http.js`, `vnet.js`): every host built-in that npm code subclasses or probes needs its own treatment. The JS tier is compatible case by case, not by design.

## 3. Getting tools into a can

### 3.1 The toolchain manifest

`toolchains.lock.json` ships inside the app.

```json
{
  "toolchains": [
    {
      "name": "cpython",
      "version": "3.15.2",
      "url": "https://github.com/brettcannon/cpython-wasi-build/releases/download/v3.15.2/python-3.15.2-wasi_sdk-33.zip",
      "sha256": "<filled by release CI before ship>",
      "size": 15528008
    },
    {
      "name": "node",
      "version": "<BUNDLED_NODE_VERSION>",
      "url": "bundled in the installer; not downloaded",
      "source": "bundled",
      "size": "bundled"
    }
  ]
}
```

- The CPython URL resolved with HTTP 200 on 2026-11-22. Its size is exactly 15528008 bytes ([GitHub API](https://api.github.com/repos/brettcannon/cpython-wasi-build/releases/tags/v3.15.2)).
- Upstream publishes no checksums. The release has two zip assets only, and its body is empty ([GitHub API](https://api.github.com/repos/brettcannon/cpython-wasi-build/releases/tags/v3.15.2)). The project computes the sha256 once, at release time, and release CI re-verifies it.
- The zip layout was not checked (UNVERIFIED).
- The build refuses any downloadable manifest entry with no sha256. The runtime never downloads anything that has no pinned sha256 and size.
- Bundled entries are checked at installer build time against nodejs.org SHA256SUMS (README.md:460-461). The "no sha256, no entry" rule applies to runtime downloads only.
- `browser_wasi_shim` 0.4.2 is not in the manifest. It is vendored into the app source at a pinned version. Its pinned npm integrity is `sha512-/iHkCVUG3VbcbmEHn5iIUpIrh7a7WPiwZ3sHy4HZKZzBdSadwdddYDZAII2zBvQYV0Lfi8naZngPCN7WPHI/hA==` ([npm registry](https://registry.npmjs.org/@bjorn3/browser_wasi_shim), read 2026-11-22). It is never downloaded at runtime.
- If the owner chooses to bundle CPython (section 7, question 2), the installer pre-seeds `~/.can/toolchains/<sha256>/` with the same verified file, so the code path is identical.

### 3.2 Download and verify

1. Take the per-entry file lock. Wait up to 120 s; then fail with EBUSY.
2. Check `~/.can/toolchains/<sha256>/`. On a hit, release the lock and use it. No network. Cans read the cache read-only.
3. Download to a temp file.
4. Check the size against the manifest.
5. Check the sha256 against the manifest.
6. Rename the temp file atomically into `~/.can/toolchains/<sha256>/`.
7. Release the lock.

Each failure deletes the temp file, so no partial file is left. The messages below are proposed wording, not sourced facts.

- Network failure: `EIO: could not download python 3.15.2. Next: check the network, then run can_create again. Nothing was installed.`
- Wrong size: `EINTEGRITY: download of python 3.15.2 has the wrong size. Next: run can_create again. The download was discarded.`
- Wrong hash: `EINTEGRITY: python 3.15.2 failed its sha256 check. Next: run can_create again. If it fails twice, the manifest or the release is wrong; report it.`
- Move or disk error: `EIO: could not move python 3.15.2 into the toolchain cache. Next: free disk space or fix permissions on ~/.can, then run can_create again.`
- Lock held too long: `EBUSY: another server is installing python 3.15.2. Next: call can_create again in a minute.`

### 3.3 Python

- Pin CPython 3.15.2, built for WASI 0.1 with WASI SDK 33. PEP 11 lists the 3.15 WASI row this way ([PEP 11](https://peps.python.org/pep-0011/)). The builds come from an unofficial project, MIT licensed ([repo](https://github.com/brettcannon/cpython-wasi-build), [releases](https://github.com/brettcannon/cpython-wasi-build/releases)).
- Not 3.16. PEP 11's Tier 2 row now names `wasm32-unknown-wasip3`. The 3.16.0a2 build ships a wasip3 archive ([releases](https://github.com/brettcannon/cpython-wasi-build/releases)). wasip3 builds are WebAssembly components; the preview1 shim does not implement the component model (inference; UNVERIFIED for this build).
- PEP 816 has no 3.15 row. Whether 3.15 on WASI 0.1 is supported by policy: UNVERIFIED ([PEP 816](https://peps.python.org/pep-0816/)).
- Stdlib location and PYTHONHOME in the zip: UNVERIFIED (the zip was not downloaded).
- CPython's own WASI runner expects Wasmtime. This design does not use it. Running CPython under browser_wasi_shim: UNVERIFIED ([CPython WASI README](https://github.com/python/cpython/blob/main/Platforms/WASI/README.md)).
- The can gets `python` and `pip` as shell commands.
- `pip` rules:
  - Pure-Python wheels only (`py3-none-any`). No WASI wheel tag exists ([PEP 783](https://peps.python.org/pep-0783/)).
  - The hash in the lock is the authority. PyPI's `digests.sha256` ([PyPI JSON API](https://docs.pypi.org/api/json/)) is used only to report a mismatch.
  - Repeatable installs (anything in `environment`) require a requirements lock in pip's hash-checking form: `name==1.2.3 --hash=sha256:<hex>`.
  - An interactive `pip install name` inside can_exec is allowed. It verifies against PyPI's digest and prints the exact `name==version --hash=sha256:...` line, so the agent can put it in a lock. Interactive installs are outside the repeatable setup. They are checked against the registry's published hash, but are not pinned.
  - Source distributions and platform wheels are refused: `ENOTSUP: pip refused "<name>" (needs a build step or C code). Next: use a pure-Python wheel.`
- Unsupported modules: the CPython docs say the subprocess module is importable but does not work. Modules for processes, threads, networking, signals and other IPC are unavailable or may not work. Under preview 1, sockets come only from an existing file descriptor ([CPython docs](https://docs.python.org/3/library/intro.html)).
- Python programs cannot listen on ports or accept network connections. Preview 1 sockets come only from an existing file descriptor. To serve HTTP, use the JS tier (node).

### 3.4 Rust

What works:
- Programs built for `wasm32-wasip1` run as `.wasm` files. The target is Tier 2, ships with rustup, and has a self-contained sysroot ([platform support](https://doc.rust-lang.org/rustc/platform-support.html), [wasm32-wasip1](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip1.html)).
- Use the name `wasm32-wasip1`. `wasm32-wasi` was renamed in Rust 1.78 and removed in 1.84 ([Rust blog](https://blog.rust-lang.org/2024/04/09/updates-to-rusts-wasi-targets/)).

No Rust toolchain is downloaded into a can. `.wasm` programs arrive through can_import or can_write_file. They are the user's own files, so no manifest entry applies.

Not offered, for four reasons:
1. No supported rustc runs on WASI. The target spec sets host tools to false ([target spec](https://doc.rust-lang.org/nightly/nightly-rustc/src/rustc_target/spec/targets/wasm32_wasip1.rs.html)). A browser_wasi_shim demo needs wasm rustc artifacts. Where they are hosted and their limits: UNVERIFIED ([repo](https://github.com/bjorn3/browser_wasi_shim)).
2. Cargo needs process spawning. WASI has no process-spawning proposal, and sockets are Phase 3 ([WASI proposals](https://github.com/WebAssembly/WASI/blob/main/docs/Proposals.md)). Cargo shells out to rustc: UNVERIFIED as a sourced statement.
3. Running a host toolchain runs untrusted build code on the host (our inference). Cargo compiles and runs a build script before building the package ([Cargo reference](https://doc.rust-lang.org/cargo/reference/build-scripts.html)). Run natively, that is host code. Procedural macros run inside the compiler ([Rust reference](https://doc.rust-lang.org/reference/procedural-macros.html)).
4. Native Windows Rust needs Visual Studio for the MSVC toolchain ([rustup](https://rust-lang.github.io/rustup/installation/windows.html)). That breaks the no-installed-software rule.

The owner chooses one of three options: accept the limit, track rustc on WASI, or a later microVM tier.

### 3.5 Node and npm

- Installers bundle Node, pinned by `BUNDLED_NODE_VERSION` and checked against nodejs.org `SHA256SUMS` (README.md:460-461). SPEC.md:553-556 says can code runs on "the host's Node". In an installed copy that is the bundled Node, so nothing changes. A developer running from a source checkout uses whatever Node they have; that path is out of scope for the first-run guarantee.
- npm already checks integrity: sha512, sha384, sha256 or sha1, and fails with `EINTEGRITY` (runtime/npm.js:270-281). There is no lockfile, and install scripts never run (SPEC.md:560-568).
- Environment installs require an npm lockfile with exact versions and integrity values, so they repeat exactly. Interactive installs are outside the repeatable setup. They are checked against the registry's published hash, but are not pinned.
- `nodeVersion` changes only the reported `process.version` (default v20.11.0). Document it as cosmetic (SPEC.md:553-556).

## 4. Memory: the 500 MB ceiling

### 4.1 What is measured

The limit applies to each can's child process, created with `child_process.fork(src/vm/worker.js)` (`SPEC.md:9`, `205`, `216-218`). The limit is 500 MB per can, measured on that child.

The current child already breaks this ceiling. It runs with `--max-old-space-size=512` (`SPEC.md:207-213`, `src/vm/supervisor.js:19`). That flag caps only the V8 JS heap (`SPEC.md:313-314`). The 512 MB heap cap alone is above 500 MB. Buffers, wasm memory, code and native memory sit outside it.

### 4.2 Budget split

| Part | Size | Source |
|---|---|---|
| V8 old space (JS heap) | 256 MB | proposed default |
| Wasm linear memory | 160 MiB = 2560 pages of 64 KiB | proposed default |
| Remainder: code, buffers, native | about 60 MiB | arithmetic |

Arithmetic: 500 MB = 476.8 MiB. 256 + 160 = 416 MiB. 476.8 - 416 = 60.8 MiB left. The V8 flag unit (MB or MiB) is UNVERIFIED, but 256 MB + 160 MiB is under 500 MB under either reading.

The split is an open default.

### 4.3 Enforcement layers

**(a) V8 heap cap.** The proposed 256 MB old-space cap stops JS allocation (`SPEC.md:313-314`). When V8 hits it, the child aborts. The parent tells this apart from other exits by exit status and stderr. The detection details are UNVERIFIED. Today every exit maps to `ECHILD` with the stderr tail (`src/vm/supervisor.js:131-136`). A heap abort becomes state `stopped: memory limit` with `ENOMEM`. Any other unexpected exit becomes `crashed` with `ECHILD`. The host is unaffected. This cap does not bound wasm memory, because wasm memory is an ArrayBuffer, and V8 heap limits do not cover ArrayBuffers ([worker_threads](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)).

**(b) Wasm memory maximum.** The wasm core spec lets `memory.grow` fail and return -1 ([spec](https://webassembly.github.io/spec/core/exec/instructions.html)). In JS, `Memory.grow` throws `RangeError` past the maximum ([MDN](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/grow)).

Local test, Node v24.15.0 (section 2.5): `new WebAssembly.Memory({initial:1,maximum:2}).grow(5)` throws `RangeError: WebAssembly.Memory.grow(): Maximum memory size exceeded`. Compile and instantiate work under the current child flags (`--permission`, `--disallow-code-generation-from-strings`, `--max-old-space-size=256`). Node 20 is not tested.

The loader sets `maximum` at instantiate, to 2560 pages. If `python.wasm` defines its own memory, the loader must rewrite the declared maximum in the memory section. Whether `python.wasm` imports or defines memory is UNVERIFIED. The rewrite needs a test.

Agent view: CPython raises `MemoryError`. The command exits non-zero with a clear message. The can stays up. Which error the WASI layer surfaces to CPython is UNVERIFIED.

**(c) Parent watchdog.** The parent samples the child every 250 ms. It compares the larger of two values:
- (i) The OS metric it reads for the child's pid. On Windows, `PrivateMemorySize64` equals Private Bytes ([docs](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.privatememorysize64)). `WorkingSet64` includes shared pages ([docs](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.workingset64)), so it is not used. On macOS, `ps -o rss=` units are UNVERIFIED.
- (ii) The last RSS the child reported over IPC. The child reads `process.memoryUsage().rss` about itself. The parent cannot call it for another process ([process](https://nodejs.org/docs/latest-v24.x/api/process.html)).

How Node reads the OS metric without native code (for example by spawning `ps` or PowerShell every 250 ms) is UNVERIFIED, and may be too slow. Section 7 covers it.
- **Soft limit, 450 MB:** new `can_exec` and `can_spawn` calls are refused with `ENOMEM` and a next step. Wording of the next step is a proposal.
- **Hard limit, 500 MB:** the child is killed and the status becomes `stopped: memory limit`. The error text:

  `ENOMEM: can "x" used more than its 500 MB memory limit and was stopped. Its files from the last save are kept. Next: call can_create with the same name and spec to restart it from its last save, then do less at once or split the work across cans.`

**(d) OS hard caps.**
- **Windows:** a Job Object memory limit makes commits fail once exceeded. A completion port receives `JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT` ([docs](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)). Setting it needs native code (`SetInformationJobObject`). The child_process docs document no job-limit option (UNVERIFIED that none exists). libuv already puts each child in a global job with `KILL_ON_JOB_CLOSE` and no memory limit ([libuv](https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/process.c)). Nesting a second job is UNVERIFIED. The native helper is an open decision.
- **macOS:** no primary source documents `RLIMIT_AS` or `RLIMIT_DATA` as a usable memory cap on macOS. One Apple forum thread reports `setrlimit(RLIMIT_DATA)` rejecting values below about 418 GB ([forum](https://developer.apple.com/forums/thread/702803), secondary). Treat macOS as having no usable OS hard cap (UNVERIFIED; needs a test). macOS has no cgroups (UNVERIFIED). The watchdog is the only cap.
- **Linux (later):** cgroup v2 `memory.max` is a hard limit. The kernel OOM-kills inside the cgroup ([kernel docs](https://docs.kernel.org/admin-guide/cgroup-v2.html)).

### 4.4 What the host guarantees

- Each can is a separate process (`SPEC.md:9`). This is design intent: the MCP server should not be affected by a can's memory use. The tests in 4.6 must prove it.
- The child exits itself on IPC disconnect (`src/vm/worker.js:205`). An unexpected exit sets status `crashed` (`src/vm/supervisor.js:157-159`), except a heap abort, which becomes `stopped: memory limit` (4.3(a)). Later calls fail with ECHILD after a crash, or with ENOMEM after a memory-limit stop.
- Other cans are separate processes, so they are unaffected (design intent).

### 4.5 Known gaps

- macOS can overshoot the hard limit by one sample interval's allocation. This follows from sampling (design reasoning, not a sourced fact).
- Host Chrome or Edge processes used by Chromium mode sit outside the budget. Chromium mode drives a host Chrome or Edge through a loopback proxy (README.md:291-317). This is an open decision (section 7).
- There is no CPU cap (`SPEC.md:314-315`).

### 4.6 Tests before ship (proposed, not yet written)

- **Blocks the whole WASI tier, run first:** CPython 3.15.2 `python.wasm` starts under the vendored shim over the can VFS, imports the stdlib and runs a script.
- Allocate past the proposed 256 MB heap cap. Child exits, parent reports `ENOMEM`, host answers.
- Grow past the wasm maximum. Python raises `MemoryError`, exits non-zero, can stays `ready`.
- Check the memory-section rewrite on `python.wasm`. Also confirm whether it imports or defines memory (UNVERIFIED).
- Ramp RSS past 500 MB. Child is killed within one 250 ms sample, state is `stopped: memory limit`.
- Host MCP server answers during and after a limit kill.
- A second can keeps running while the first is killed.
- Re-run the section 2.5 checks on Node 20 (untested).
- Re-run the section 2.5 checks on the exact Node version the installers bundle (BUNDLED_NODE_VERSION).

## 5. Reliability

### 5.1 Principles

- Set up once, and it works.
- Idempotent: the same request gives the same result.
- Nothing left behind: a failed create rolls back, and a startup sweep clears leftovers.
- Every error says what to do next.

### 5.2 can_create as a transaction

Steps:
1. Create the VM under a staging id not visible to tools.
2. Run every environment step: `tools`, `requireTools`, workdir, imports, files, setup (`environment.js:168`).
3. Save.
4. Publish: move staging to the real name.

On any failure: kill the VM, delete staging files and `.tmp` files, release the name, return one error. A failed create leaves nothing behind, so `can_status` on that name returns `ENOENT`.

Verified cached toolchains survive a failed create on purpose. The cache is shared, content-addressed and verified; it is not can state. "Nothing left behind" means no can state, no staging files and no partial downloads.

Current flow: `registry.create` (`registry.js:95-109`) calls `manager.create` (`manager.js:45-67`), which calls `Can.open` (`can.js:58-70`), then `applyEnvironment`, then save. The create-then-save call is `registry.js:103-104`; the `EEXIST` check is `registry.js:98-99`.

Current gaps, both fixed by the transaction:
- **Gap 1:** if `manager.save` throws, the live VM is not destroyed and keeps its name. A retry gets `EEXIST` (`registry.js:98-99`, `manager.js:62`). Today a failed environment step does destroy the can (`manager.js:58-61`). A failed save does not.
- **Gap 2:** if `writeFileSync` or `renameSync` fails, the `.tmp` file stays (`manager.js:91-95`).

### 5.3 Idempotency

| Case | Result | Message |
|---|---|---|
| New name | Created. Result states tools and memory limit | Created, with tools and limit listed |
| Same name, same spec, state ready | Returns the existing can | "already exists with the same spec; reused" |
| Same name, same spec, state crashed or stopped: memory limit | Restarts from its last save. Processes and ports do not come back | "restarted from the save made at `<time>`" |
| Same name, different spec (any state) | No change | `EEXIST` with a next step (5.4, item 8) |
| Concurrent create, same name | The second call waits on a per-name lock, then follows the rows above | As the matching row |

### 5.4 Error format

Form: `CODE: what happened. Next: what to do.` Codes are Node-style (`SPEC.md:17-19`). `EIO`, `EINTEGRITY`, `EEXIST`, `ENOENT`, `ECHILD` and `EPERM` are already used in src/. `ENOMEM`, `EBUSY` and `ENETUNREACH` are new to this code base but are standard Node error codes. Examples are proposed wording.

1. Download failed (`EIO`): `EIO: could not download python 3.15.2 (network error). Next: check the connection and run can_create again.`
2. Checksum or size mismatch (`EINTEGRITY`, as npm uses it, `npm.js:270-281`): `EINTEGRITY: python 3.15.2 failed its size or sha256 check and was discarded. Next: run can_create again once; if it fails again, report the download as corrupt.`
3. Offline, no cached tool (`ENETUNREACH`): `ENETUNREACH: python 3.15.2 is not cached and there is no network. Next: connect, then run can_create again.`
4. Setup step failed (`EIO`, existing wording, `environment.js:215`): `EIO: setup step "pip install requests" failed. Output: <last lines>. Next: fix the step, then run can_create again with the same spec.`
5. Memory limit (`ENOMEM`): the text in 4.3(c). A V8 heap abort also gives this state (4.3(a)).
6. VM crashed (`ECHILD`, `SPEC.md:227-228`), for any unexpected exit other than a heap abort (4.3(a)): `ECHILD: can "x" has crashed. Next: run can_status, then call can_create with the same name and spec to restart it from its last save.`
7. Unknown can (`ENOENT`, replaces `ENOENT: no can "x" (see can_list)`, `registry.js:24`): `ENOENT: no can "x" exists. Next: run can_list, then use the right name.`
8. Name taken, different spec (`EEXIST`): `EEXIST: a can named "x" already exists with a different spec. Next: choose another name, or destroy "x" with can_destroy only if its saved state is not needed. This cannot be undone.`
9. Lock wait timed out (`EBUSY`): `EBUSY: another server is installing python 3.15.2. Next: call can_create again in a minute.`
10. Version matches no lock entry (`ENOTSUP`): `ENOTSUP: no python matching "3.9" in this build. Next: use one of: 3.15.2.`

Policy-blocked internet returns `EPERM` (`src/runtime/builtins.js:417`), as it does today.

Two tool changes:
- `can_exec`: a non-zero exit stays a normal result, with `isError` false, because the command ran. Its first line already reads `exit code: N` (`tools.js:466`). That line is unchanged; only the description changes. `isError` is reserved for "the tool could not do what was asked."
- `can_ci`: same rule as `can_exec`. The pipeline ran, so `isError` stays false, but the first line now states the outcome, e.g. `pipeline: failed at job "test", step "npm test"`. Today a failure is only visible inside the report body (`tools.js:341`); `ok` is computed at `ci.js:204-246`. A setup failure that stops the pipeline from running is `isError: true`.

### 5.5 Startup sweep

At server start, remove staging directories and `.tmp` or partial download files in the store and the toolchain cache, but only when the item's lock file names a pid that is no longer alive, or the item has no lock and is older than 1 hour. Both Claude Code and Claude Desktop register the can MCP server (README.md:24, 52-53), and both use the same store `~/.can/cans` (SPEC.md:15), so two servers can run at once. An item whose lock is held is never removed. The sweep logs what it removed. `can_status` shows the count.

### 5.6 Recovery path

| State | `can_status` shows | Agent does next |
|---|---|---|
| ready | State, memory used, peak, limit | Work normally |
| stopped: memory limit | Peak, limit, last error; saved files kept | Start smaller work or split across cans. Restart with can_create, same name and spec, to restore from the last save. Do not destroy |
| crashed | Crashed state and last error (`ECHILD`) | Call can_create, same name and spec, to restart from the last save. Do not destroy |

A heap abort leaves the can `stopped: memory limit`. Any other unexpected exit leaves it `crashed` (4.3(a)).

There is no separate load or start tool. A saved can that is not running is loaded on demand by any tool call that names it (`src/registry.js:78-88`, `tools.js:196`). For a crashed or memory-stopped can, that call returns the error with its next step.

Never destroy to recover a save. `can_destroy` deletes saved state irreversibly (`tools.js:371`) and removes every trace. A restart from the save keeps the files. Processes and ports do not come back. `can_destroy` works on a crashed can (`src/registry.js:118-123`, `manager.js:79-84`, `src/vm/supervisor.js:111-122`), from reading the code, not a run.

## 6. MCP surface

### 6.1 Principle

Keep the tool count as low as possible. Python and Rust run through `can_exec` and `can_spawn`. No per-language tools are added.

### 6.2 Summary

| Status | Tool | Reason |
|---|---|---|
| Added | `can_status` | One health check replaces separate process and port lists. |
| Changed | `can_create` | Adds `environment.tools`. Transactional. Same-name calls reuse, restart from save, or refuse. |
| Changed | `can_destroy` | Works in every state. Description states the effect plainly. |
| Changed | `can_exec` | Description is wrong about the shell. Non-zero exit stays a normal result. |
| Changed | `can_ci` | First line states pass or fail. A setup failure that stops the run is `isError: true`. |
| Hidden (proposed; question 7) | `can_ps`, `can_ports` | Folded into `can_status`. Not advertised; kept as hidden aliases for one release (see 6.5). |
| Changed if question 8 is accepted | `can_save` | Auto-save runs after each mutating call; `can_save` stays and forces an immediate save. |
| Unchanged | All others | No design change. Listed in 6.6. |

Net count: 34 core tools today (39 with the five host_browser_* tools, which appear only when the user enables the host browser). If question 7 is accepted: 33 core tools advertised (+ `can_status`, - `can_ps`, - `can_ports`). The hidden aliases are not advertised.

### 6.3 Added: `can_status`

Proposed description: "Health check for a can: state, memory against its limits, tool versions and hash checks, processes, ports, and the last error with its next step."

Input schema. It matches the `canProp` used at tools.js:193-197.

```json
{
  "type": "object",
  "properties": {
    "can": {
      "type": "string",
      "minLength": 1,
      "description": "Can name or id, as shown by can_list. A saved can is loaded automatically."
    }
  },
  "required": ["can"],
  "additionalProperties": false
}
```

Example result (values are illustrative):

```
can "app": ready
memory: 212 MB used, 455 MB peak, 450 MB soft limit, 500 MB hard limit
tools:
- python 3.15.2 (wasm32-wasip1): sha256 verified yes
processes:
- pid 4: running  cwd=/app  command=node server.js
ports:
- port 8000
startup sweep: removed 0 staging dirs and 0 .tmp or partial download files; skipped 0 held by a live server (store and toolchain cache)
last error: ENOMEM: exec refused; can "app" was at 455 MB (soft limit 450 MB). Next: wait for pid 4 to exit or can_kill it, then retry.
```

### 6.4 Changed

**`can_create`**
- Current: tools.js:225 says "The can is saved to disk right away." tools.js:229 says "If a step fails, the can is not created." A duplicate name fails with EEXIST (registry.js:98-99). A save failure leaves the VM alive (manager.js:62). A failed write leaves `.tmp` files (manager.js:91-95).
- New: a transaction. A failed create rolls back completely, so no can state remains. Verified cached toolchains stay on purpose (5.2). The error is the only record, and can_status on that name returns ENOENT. The result lists tools and the memory limit. The step order in tools.js:17 becomes: tools, requireTools, workdir, imports, files, setup.
- Same name and same spec, by the state of the existing can:
  - ready: return it ("reused").
  - crashed, or stopped by the memory limit: restart it from its last save. Files come back. Processes and ports do not.
- Same name, different spec: EEXIST with a next step. Concurrent creates wait on a per-name lock.
- Error codes are Node-style only. No codes outside the set in 5.4.
- Schema fragment, added to `ENVIRONMENT_SCHEMA.properties` (tools.js:19-91). `can_ci` shares this schema, so it gets the field too:

```json
"tools": {
  "type": "object",
  "description": "Tools to install, as name: version, such as {\"python\": \"3.15\"}. Each resolves to an exact pinned version in toolchains.lock.json.",
  "additionalProperties": { "type": "string", "minLength": 1 }
}
```

- Example result:

```
created can "app" (id 7). Tools: python 3.15.2 (wasm32-wasip1, sha256 verified). Memory limit 500 MB.
Run commands with can_exec.
```

  Reuse: `can "app" already exists with the same spec; reused.`
  Restart: `can "app" restarted from the save made at 2026-11-22T09:14:03Z. Processes and ports were not restored.`
  Different spec: `EEXIST: can "app" already exists with a different spec. Next: use a new name, or can_destroy "app" and create it again.`
- Why: this fixes gaps 1 and 2 (5.2). A crashed can keeps its files, so restart no longer needs destroy.

**`can_destroy`**
- Current: tools.js:371 reads "Stop a can, kill its processes and delete its saved state. This cannot be undone." The irreversible wording already exists. Destroy works on a crashed can (`src/registry.js:118-123`, `manager.js:79-84`, `src/vm/supervisor.js:111-122`), read from the code, not run.
- New: "Stop a can, kill its processes, and delete its saved state and any staging files. Works in any state: ready, stopped, or crashed. This cannot be undone: the can's files are removed for good. To restart a crashed or stopped can, use can_create with the same name and spec instead."
- Why: destroy is not the recovery path. The current skill tells agents to destroy and reload a crashed can (skills/can/SKILL.md, Errors section), which deletes the save it means to restore. The skill draft fixes this.

**`can_exec`**
- Current: tools.js:444 reads "Not supported: $(...), if/for loops, functions." This is wrong. The shell supports them (shell.js; test/runtime-shell.test.js:26, 109). Non-zero exits return as a normal result (tools.js:466).
- New, replacing tools.js:443-444: "Supports pipes, redirects, $(...), if and loops, functions and heredocs. Not supported: case, ${VAR#pat}, [[ ]], arrays." This follows SPEC.md:324-343. Check the wording against shell.js before merging.
- First line, tools.js:466: unchanged. It already reads `exit code: ${r.exitCode}${note}`. The change is the description only.
- isError stays false for a non-zero exit. The command ran, so the tool did what was asked.

**`can_ci`**
- Current: tools.js:341 returns the report as normal text. A failed pipeline is not an error (ci.js:204-246).
- New: the first line of the result is `pipeline: passed` or `pipeline: failed at job "<job>", step "<step>"`. `isError` stays false when the pipeline ran, the same rule as `can_exec`. When setup fails and no step runs, the handler throws and server.js returns `isError: true` (server.js:214, 223).
- Why: an agent must see the outcome without parsing the report, and `isError` must mean the same thing on every tool: the tool could not do what was asked.

### 6.5 Removed from the advertised list: can_ps and can_ports

- Not advertised after the change. Kept as hidden aliases for one release (section 7, question 7), so existing calls keep working during that release.
- Migration: `can_status` lists processes and ports. Reword pidProp (tools.js:198) and the can_http `port` description (tools.js:677).
- README or SKILL.md references: not checked. Open decision: Question 7.

### 6.6 Unchanged

The following tools are unchanged: can_list, can_mounts, can_spawn, can_logs, can_kill, can_read_file, can_write_file, can_import, can_export, can_list_dir, can_http, can_record_start, can_record_stop; browser_goto, browser_snapshot, browser_click, browser_type, browser_select, browser_submit, browser_text, browser_query, browser_back, browser_evaluate, browser_console, browser_screenshot; computer_screenshot, computer_action; and host_browser_goto, host_browser_text, host_browser_evaluate, host_browser_screenshot, host_browser_close.

## 7. Open decisions for the owner

1. Should Rust code compile inside a can, or only run prebuilt wasm32-wasip1 programs?
   - Options: accept no compile; track rustc on WASI; a later microVM tier.
   - Default: accept no compile for now.
   - Blocks: any Rust build step.
2. Should CPython ship inside the installer (+15.5 MB), or download on first use?
   - Options: bundle it; download and cache on first use.
   - Default: bundle it, so the first run needs no network.
   - Blocks: installer size and the first-run path.
3. Should toolchain files be mirrored on a project-controlled host, or fetched from GitHub?
   - Options: project mirror; GitHub release URLs.
   - Default: mirror. The CPython builds come from an unofficial repo with no checksum files (3.1).
   - Blocks: the URLs in `toolchains.lock.json`.
4. Should Windows get a small native helper that sets a Job Object memory limit?
   - Options: helper for a true hard cap; watchdog sampling only.
   - Default: helper. The child_process docs document no job-limit option (UNVERIFIED that none exists), and nesting a second job is UNVERIFIED.
   - Blocks: the hard cap on Windows.
5. Should macOS accept a watchdog-only cap, which can overshoot by one sample's allocation?
   - Options: accept and document it; wait for a native helper.
   - Default: accept and document it for the first release, since no usable macOS OS hard cap is documented (UNVERIFIED).
   - Blocks: the macOS memory claim.
6. Should Chromium processes count toward a can's 500 MB budget?
   - Options: count them; report them separately.
   - Default: report separately. They run outside the can's child process.
   - Blocks: the meaning of "memory used" in `can_status`.
7. Should `can_ps` and `can_ports` be removed now, or kept as aliases for one release?
   - Options: remove now; keep aliases for one release.
   - Default: keep aliases for one release, so existing clients do not break at once.
   - Blocks: the tool list in 6.5.
8. Should every mutating call auto-save, so `can_save` is no longer needed?
   - Options: keep `can_save` only; auto-save after each mutating call, keeping `can_save` to force an immediate save.
   - Default: auto-save. Restart-from-save (6.4) and crash recovery only keep what was saved. Without auto-save, a crash loses every change since the last `can_save`, which breaks "set up once and it works".
   - Blocks: the `can_save` description and how much a crash loses.
9. Should the WASI shim be vendored from browser_wasi_shim 0.4.2, or written in-house?
   - Options: vendor and pin; write our own.
   - Default: vendor and pin (MIT OR Apache-2.0, no runtime dependencies). Whether it runs CPython is UNVERIFIED.
   - Blocks: the WASI tier.
10. Should Python stay on the 3.15.2 pin, or move to WASI 0.3 when it is available?
   - Options: stay on 3.15.2; move to 3.16 and wasip3.
   - Default: stay on 3.15.2. wasip3 builds are components, which the preview1 shim does not implement (inference).
   - Blocks: the Python pin and update policy.
11. Are the memory defaults right: V8 256 MB, wasm 160 MiB, soft limit 450 MB, hard limit 500 MB?
   - Options: keep these values; change them after the test.
   - Default: keep them until the wasm maximum test runs.
   - Blocks: the numbers in `can_status` and the error text.
12. Who will make the README `chromiumBrowser` fixes, since they are outside this task's files?
   - Options: a separate small change now; fold into the release.
   - Default: a separate change now. README.md:101-102 and 293 say `chromiumBrowser` must be set to true, but Chromium is on by default and `false` opts out (src/mounts.js:50-55, src/mcp/server.js:263-264).
   - Blocks: the accuracy of the docs.
13. Should restarting a crashed or memory-stopped can use can_create with the same name and spec, or a dedicated restart tool?
   - Options: reuse can_create (no new tool, fewer tools); add a can_restart tool.
   - Default: reuse can_create. It keeps the tool count minimal (6.1), and the recovery path in 5.6 already goes through it.
   - Blocks: the can_create description, can_status next-step text, and the skill's Errors section.
14. How should the parent read a child's OS memory metric every 250 ms without native code, or should the native helper (question 4) also report memory?
   - Options: spawn a system tool (for example `ps` or PowerShell) for each sample; use the native helper (question 4) for the metric.
   - Default: none yet. Measure the cost of each option first.
   - Blocks: the watchdog in 4.3(c).
15. Should a can refuse interactive pip and npm installs that are not in a hash lock?
   - Options: allow with registry hash (default, so agents can explore); refuse unless locked (strict).
   - Blocks: the pip and npm commands.

## 8. Sources

- https://peps.python.org/pep-0011/ : WASI tier and the 3.15 = WASI 0.1 / SDK 33 row.
- https://peps.python.org/pep-0816/ : WASI support policy; no 3.15 row.
- https://github.com/brettcannon/cpython-wasi-build/releases : unofficial prebuilt CPython WASI binaries and asset names.
- https://api.github.com/repos/brettcannon/cpython-wasi-build/releases/tags/v3.15.2 : two zip assets, empty body, asset size 15528008 bytes.
- https://github.com/python/cpython/tags : CPython tags v3.15.2 and v3.14.10 exist.
- https://docs.python.org/3/library/intro.html : subprocess, threading and socket limits on WebAssembly.
- https://github.com/python/cpython/blob/main/Platforms/WASI/README.md : default runner needs Wasmtime; no pinned version.
- https://peps.python.org/pep-0783/ : Emscripten-only wheel tags; no WASI wheel tag.
- https://docs.pypi.org/api/json/ : per-file sha256 in the PyPI JSON API.
- https://pypi.org/pypi/pip/json : live example of the PyPI JSON digests.
- https://peps.python.org/pep-0691/ : Simple API hashes field.
- https://packaging.python.org/en/latest/specifications/binary-distribution-format/ : wheel install layout and RECORD.
- https://doc.rust-lang.org/rustc/platform-support.html : Tier 2 wasm32 targets without host tools.
- https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip1.html : wasip1 shipped with rustup, self-contained sysroot.
- https://blog.rust-lang.org/2024/04/09/updates-to-rusts-wasi-targets/ : wasm32-wasi renamed to wasip1, removed in 1.84.
- https://doc.rust-lang.org/nightly/nightly-rustc/src/rustc_target/spec/targets/wasm32_wasip1.rs.html : wasip1 target spec, host_tools false.
- https://github.com/bjorn3/browser_wasi_shim : in-memory WASI shim; rustc demo; MIT OR Apache-2.0. Its syscall list is in src/wasi.ts.
- https://registry.npmjs.org/@bjorn3/browser_wasi_shim : npm metadata; no runtime dependencies.
- https://github.com/oligamiq/rubrc : work-in-progress rustc port.
- https://github.com/WebAssembly/WASI/blob/main/docs/Proposals.md : no process-spawning proposal; sockets at Phase 3.
- https://doc.rust-lang.org/cargo/reference/build-scripts.html : build scripts compile and run on the host.
- https://doc.rust-lang.org/reference/procedural-macros.html : proc macros run with compiler resources.
- https://rust-lang.github.io/rustup/installation/windows.html : MSVC toolchain requires Visual Studio.
- https://doc.rust-lang.org/cargo/commands/cargo-build.html : --offline, --locked and --frozen flags.
- https://doc.rust-lang.org/cargo/reference/registry-index.html : index cksum is a SHA256 of the .crate file.
- https://doc.rust-lang.org/cargo/reference/source-replacement.html : .cargo-checksum.json is not a security mechanism.
- https://forge.rust-lang.org/infra/channel-layout.html : channel manifests carry per-target hashes; the manifests themselves have .sha256 and .asc files.
- https://rust-lang.github.io/rustup/security.html : rustup does not yet validate download signatures.
- https://nodejs.org/docs/latest-v24.x/api/wasi.html : node:wasi is experimental; not a sandbox.
- https://nodejs.org/docs/latest-v24.x/api/permissions.html : permission model; no guarantees against malicious code.
- https://webassembly.github.io/spec/core/exec/instructions.html : memory.grow may fail with -1.
- https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/grow : Memory.grow throws RangeError past maximum.
- https://nodejs.org/docs/latest-v24.x/api/cli.html : --max-old-space-size bounds the V8 old space.
- https://nodejs.org/docs/latest-v24.x/api/worker_threads.html : resourceLimits do not bound ArrayBuffers.
- https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information : Job Object memory limit behaviour.
- https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/process.c : libuv puts children in a kill-on-close job with no memory limit.
- https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.privatememorysize64 : PrivateMemorySize64 equals Private Bytes.
- https://developer.apple.com/forums/thread/702803 : one thread reports setrlimit(RLIMIT_DATA) rejecting values below about 418 GB (secondary).
- https://docs.kernel.org/admin-guide/cgroup-v2.html : cgroup v2 memory.max is a hard limit.
- https://man7.org/linux/man-pages/man2/getrlimit.2.html : RLIMIT_AS makes mmap and brk fail with ENOMEM.
- https://nodejs.org/docs/latest-v24.x/api/process.html : process.memoryUsage is read in the calling process; the parent cannot read a child with it.
- https://developer.apple.com/documentation/virtualization/adding-the-virtualization-entitlement-to-your-project : Virtualization entitlement needed.
- https://github.com/containers/libkrun : libkrun: Linux KVM and macOS ARM64 (HVF); WHP listed as upcoming.
- https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v : Hyper-V not on Windows 11 Home; install steps.
- https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/hypervisor-platform : Windows Hypervisor Platform (default state on Home UNVERIFIED).
- https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/ : Windows Sandbox not on Home.
- https://github.com/cloud-hypervisor/cloud-hypervisor : runs only on Linux KVM/MSHV, kernel 6.8 minimum.
- https://github.com/google/crosvm : lists WHPX; Windows maturity unstated.
- https://github.com/firecracker-microvm/firecracker : uses KVM; can also run under AWS Nitro; no macOS or Windows host support documented.
- https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/SPECIFICATION.md : boot and VMM overhead figures, Linux only.
- https://developer.apple.com/documentation/updates/hypervisor.md : nested virtualisation on Apple silicon.
- https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/user-guide/nested-virtualization : Hyper-V on non-Microsoft hypervisors not supported.

Repository references are to the worktree claude/app-boot-infrastructure-c4e589 as of 2026-11-22, including uncommitted changes.
