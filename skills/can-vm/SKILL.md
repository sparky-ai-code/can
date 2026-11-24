---
name: can-vm
description: Run a custom Node app in a VM can (a real Linux guest under QEMU): the minimum requirements for an app to boot, the measured boot rate, and what the VM cannot run. Use when deciding whether an app can run in a VM can, or when a VM can app fails to start.
---

# VM cans: what runs and how reliably

A VM can is a real Linux guest (x86_64, QEMU) with its own disk, processes and virtual network. It is separate from the lite can described in the `can` skill: lite cans run JavaScript in a sandbox, while a VM can runs an actual Node 24 process and an actual Chromium. Use a VM can when the app needs a real process, a real browser, or a server that a sandbox cannot host. Create one with `CAN_BACKEND=vm`, or through `CanManager.create({backend: 'vm'})`.

## Measured boot rate

Measured with a script kept outside the repo, `measure-boot.mjs` (10 trials, each creating a fresh VM can, running `node -v`, writing a 6-line Node HTTP server, starting it, and requesting it over the can's port):

| Trial result | Count |
|---|---|
| Guest booted and reported `running` | 10 of 10 |
| `node -v` returned v24.15.0 | 10 of 10 |
| Custom app answered 200 on port 8080 | 10 of 10 |

Timing: boot to running 8.5 to 11.8 s; the app answered about 4.2 s after it was started. Full pass rate for this app: 100% (10 of 10). That is one small app, not a sample of real apps; treat it as the floor, not a promise.

## Minimum requirements for an app to boot

Each item says whether it was measured.

1. **Node.js app with no native addons.** Measured: a plain Node HTTP server runs. The guest ships Node 24.15.0 (`/opt/can/node/bin`). Untested: `npm install` inside the guest (needs `internet: true`), and any package with a native `.node` addon (not measured; these are expected to fail the same way they do in a lite can).
2. **Put Node on the PATH for every command.** Measured and required: the default PATH does not include `/opt/can/node/bin`, so a bare `node` fails with `not found`. Run commands as `PATH=/opt/can/node/bin:$PATH node <file>`, in `can_exec` and `can_spawn` alike.
3. **Any other binary must be static, or use only the libraries the tools disk ships.** The tools disk carries glibc (libc, libm, libgcc_s, libdl, libpthread), libstdc++ and the dynamic loader. A dynamically linked binary that needs another shared library will not start. Untested: running a static ELF binary. Expected to work, not measured.
4. **Listen on `127.0.0.1` (or all interfaces) at a port you pick.** Measured on 8080. Reach it with `can.request({port})` from the host, or from `browser_goto http://localhost:<port>/` inside the can's browser.
5. **Write files to `/opt/can/home` (the default working folder).** Measured: writing `app/server.js` and running it from there works. `/tmp` is not on the can's saved disk, so it does not survive a save and restore. Files on the disk survive save and restore; processes and ports do not.
6. **Memory: 256 MB per VM can by default; 1792 MB for a can with the browser.** Not measured under a real workload. Leave headroom above what the app needs; the guest has no soft limit of its own.
7. **Browser apps need `browser: true` on `can_create`** (MCP) or `create({browser: true})`. Measured: goto, snapshot, click, type, text, evaluate and screenshot pass on a served form. The first browser test took about 24 s in total, including creating the can and starting Chromium; the screenshot after it took about 2 s.
8. **Network.** Measured with the default network setting: the server is reached from the host through the can's port. Untested: the network switched off, and outbound requests from the app (these need `internet: true`).

## What a VM can does not run

- Windows programs. An Electron app is built for Windows inside the guest (measured: `Notify.exe`, 250 MB), but the guest is headless Linux, so the built app cannot be started there.
- Anything that needs a display, a GPU or sound.
- Mounts and environments on the VM backend: `mounts` and `environment` return `ENOTSUP`.
- Memory snapshots (QEMU cannot take them on this host); save and restore work by disk.
- `setCwd`, `stat`, `memoryInfo` and `snapshot` are implemented in PR #17; they are not in `main` until that PR merges.

## If an app fails to start

| Symptom | Likely cause | What to do |
|---|---|---|
| `node: not found` | PATH missing `/opt/can/node/bin` | Use `PATH=/opt/can/node/bin:$PATH node ...` |
| `ERR_DLOPEN_FAILED` or a missing `.so` | A native addon or a shared library the guest does not ship | Remove the addon, or build the binary statically |
| Server never answers | Wrong port, or it bound to a different address | Check the listen address and port; read the app's log with `can_logs` |
| Browser actions fail | Created without `browser: true`, or the browser disk is missing | Recreate with `browser: true`; check `CAN_BROWSER_DISK` |
| Boot does not reach `running` | Guest or QEMU did not start | Check the QEMU and guest files are installed (`vmInstalled`) |
