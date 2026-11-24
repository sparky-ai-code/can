# Phase 0 VM spike

This reproduces the Phase 0 spike in `docs/can-vm-design.md`: boot a real Linux kernel under QEMU with the WHPX
accelerator on Windows, and talk to a guest agent over a virtio-serial port. It is a feasibility check, not the VM
backend. The guest runs as root with no membrane and no framed protocol.

## What it proves

- QEMU's `microvm` machine boots a Linux kernel under WHPX on Windows.
- The guest exposes a virtio console port (`/dev/vport0p1`) that the host reaches through a named pipe
  (`\\.\pipe\canagent`). No host TCP listener is used, as the design requires.
- The host can exchange commands with the guest and power it off cleanly.

## Prerequisites

- Windows with QEMU (`qemu-system-x86_64.exe`, 11.1.0 used here) installed under `C:/Program Files/qemu`.
- WSL Ubuntu with `apt`, `busybox-static`, `cpio`, `dpkg-deb`, and Node.js 20 or newer for the client.

## Steps

1. In WSL, fetch the kernel and busybox packages and unpack them. Use `apt-get download linux-image-7.0.0-44-generic
   busybox-static` and then `dpkg-deb -x` each `.deb` into `/root/vmspike/root`.
2. Run `build-initramfs.sh` in WSL. It builds `/root/vmspike/initramfs.cpio.gz` and copies `vmlinuz` and the
   initramfs next to `spike-client.mjs` (edit the output path at the end of the script to match your folder).
3. From Windows, run `node spike-client.mjs`. It starts QEMU with WHPX, connects to the agent pipe, runs `ping`,
   `uname -r` and `echo`, sends `exit`, and checks QEMU's exit code. Set `SPIKE_HOLD_MS` to keep the guest up for
   a number of milliseconds after it is ready, for memory sampling.

## Measured on the development machine

Host: Windows 11 Pro, WHPX available. Guest: kernel 7.0.0-44-generic (Ubuntu), 256 MB of RAM.

| Measure | Result |
| --- | --- |
| Guest reaches `/init` (kernel clock) | 1.39 s |
| Named pipe connects after QEMU starts | 129 ms |
| Agent reports ready (wall, from spawning QEMU) | 2.35 s |
| `ping`, `uname -r`, `echo` | all round-trip correctly |
| `exit` powers off | QEMU exits 0 |
| Idle guest, QEMU working set (WHPX, 256 MB guest) | 206 MB |
| Idle guest, QEMU private memory | 300 MB |

The last two rows are the important finding. The guest is 256 MB but the host process costs more than that, so the
cost target in the design (section 4) is not met yet. Lazy memory allocation and ballooning are needed for it.

## Not measured yet

- `savevm` and `loadvm` (park and resume), and the resulting disk size.
- Balloon behaviour: how much host memory is returned after the guest frees memory.
- Guest `free` against the host working set over time.
- Networking, disk overlays, and anything beyond the serial command loop.

## Agent step: canit as PID 1

The second step runs the real agent from `distro/canit/canit.c` as PID 1 in the guest, on the `can.agent` port, and
drives it with `src/vm/guest-protocol.js` (the same framing the tests check).

- Build the guest: `sh build-initramfs-canit.sh <repo folder> <this spike folder>` in WSL.
- Run it: `node canit-client.mjs` from Windows.

Measured on the same host and guest: the agent answers HELLO (canit 0.1, x86_64); `uname -r` and `echo` run as exec
requests and return their exit codes and output; POWEROFF is acknowledged with 0xa0; QEMU exits 0 about 4.6 s after
the client starts. `test/guest-protocol.test.js` and `test/canit.test.js` (which builds and runs `canit` in WSL)
both pass.

The agent handles one request at a time, as its header says. Concurrent exec, spawn, files and ports are the next
step of the backend.
