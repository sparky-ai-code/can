// Builds the QEMU command line for one can, and picks the accelerator. Pure functions: nothing here starts a process,
// so it is tested without QEMU (test/qemu.test.js). The supervisor that spawns QEMU is a later step.
//
// Platform choices (owner decision, 2026-11-23): Windows uses WHPX, macOS uses HVF, Linux uses KVM. Every host may
// fall back to QEMU's software mode (tcg), which is slower and always works. The fallback is a notice, not a silent
// switch: the caller reports the accelerator it ended up with.
//
// UNVERIFIED until the spike runs a real QEMU on each platform (docs/can-vm-design.md section 8):
//   - microvm machine with WHPX on Windows (use machine: 'q35' if it fails), and `-cpu max` under WHPX;
//   - the `pipe` chardev as a named pipe on Windows, and unix sockets as a chardev on macOS;
//   - free-page reporting on the balloon under WHPX and HVF (off by default).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UNIX_SOCKET_MAX = 100; // sun_path is 104 bytes on macOS, 108 on Linux; stay under both

export const AGENT_PORT_NAME = 'can.agent';

function invalid(what, value, next) {
  const err = new Error(`EINVAL: ${what} is ${JSON.stringify(value)}. Next: ${next}.`);
  err.code = 'EINVAL';
  return err;
}

/** The guest architecture for this host. Always the host's own: Can never emulates the other one. */
export function guestArchFor(platform = process.platform, arch = process.arch) {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';
  throw invalid('host architecture', arch, 'run Can on an x64 or arm64 host');
}

/** Accelerators to try, best first. The last is always the software fallback. CAN_VM_ACCEL=tcg forces software mode. */
export function accelCandidates({ platform = process.platform, env = process.env, kvmPresent = false } = {}) {
  const forced = env.CAN_VM_ACCEL;
  if (forced) {
    if (!['whpx', 'hvf', 'kvm', 'tcg'].includes(forced)) throw invalid('CAN_VM_ACCEL', forced, 'use whpx, hvf, kvm or tcg');
    return forced === 'tcg' ? ['tcg'] : [forced, 'tcg'];
  }
  if (platform === 'win32') return ['whpx', 'tcg'];
  if (platform === 'darwin') return ['hvf', 'tcg'];
  if (platform === 'linux') return kvmPresent ? ['kvm', 'tcg'] : ['tcg'];
  throw invalid('platform', platform, 'run Can on Windows, macOS or Linux');
}

/** Where the bundled QEMU, kernel and initramfs are. CAN_QEMU and CAN_GUEST_DIR override (tests, the spike). */
export function vmPaths({ platform = process.platform, arch = guestArchFor(platform), appRoot = APP_ROOT, env = process.env } = {}) {
  const exe = platform === 'win32' ? '.exe' : '';
  const guestDir = env.CAN_GUEST_DIR ?? path.join(appRoot, 'guest');
  return {
    qemu: env.CAN_QEMU ?? path.join(appRoot, 'vmm', `qemu-system-${arch}${exe}`),
    shareDir: path.join(appRoot, 'vmm', 'share'),
    kernel: path.join(guestDir, arch, 'vmlinuz'),
    initrd: path.join(guestDir, arch, 'initrd.img'),
  };
}

/** True when QEMU and the guest files are all installed. */
export function vmInstalled(paths = vmPaths()) {
  return [paths.qemu, paths.kernel, paths.initrd].every((file) => fs.existsSync(file));
}

/** QEMU option values use "," as a separator, so a literal comma is written ",,". */
export function qemuEscape(value) {
  return String(value).replace(/,/g, ',,');
}

/**
 * A host channel QEMU serves and Node connects to, with no host TCP port: a named pipe on Windows, a unix socket
 * elsewhere (kept private to the user by the folder `dir`, which the caller creates with mode 0700).
 */
export function channelEndpoint({ platform = process.platform, dir, name, id }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw invalid('channel name', name, 'use letters, digits, - and _');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw invalid('chardev id', id, 'use letters, digits, - and _');
  if (platform === 'win32') {
    const pipe = `\\\\.\\pipe\\${name}`;
    // QEMU's pipe chardev takes the pipe's name and adds the pipe prefix itself. Passing the full path gives QEMU a
    // pipe that Node cannot reach. Node connects to the full path (`connect`).
    return { chardev: `pipe,id=${id},path=${qemuEscape(name)}`, connect: pipe };
  }
  const sock = path.posix.join(dir, `${name}.sock`);
  if (Buffer.byteLength(sock) > UNIX_SOCKET_MAX) {
    throw invalid('socket path length', Buffer.byteLength(sock), `use a shorter state folder (limit ${UNIX_SOCKET_MAX} bytes)`);
  }
  return { chardev: `socket,id=${id},path=${qemuEscape(sock)},server=on,wait=off`, connect: sock };
}

function cpuFor(accel) {
  return accel === 'hvf' || accel === 'kvm' ? 'host' : 'max';
}

function machineFor(arch, accel, machine) {
  if (arch === 'aarch64') return { name: machine ?? 'virt', bus: 'device', console: 'ttyAMA0', opts: `${machine ?? 'virt'},accel=${accel}` };
  const name = machine ?? 'microvm';
  if (name === 'q35') return { name, bus: 'pci', console: 'ttyS0', opts: `q35,accel=${accel}` };
  return { name, bus: 'device', console: 'ttyS0', opts: `${name},accel=${accel},pit=off,pic=off,rtc=off` };
}

/**
 * The QEMU arguments (without the program) for one can.
 * @param {object} o
 * @param {'x86_64'|'aarch64'} o.arch
 * @param {'whpx'|'hvf'|'kvm'|'tcg'} o.accel
 * @param {string} o.name                 shown in the process list
 * @param {string} o.kernel
 * @param {string} o.initrd
 * @param {number} [o.memMB=256]
 * @param {number} [o.cpus=1]
 * @param {{file:string, format?:string, readonly?:boolean}[]} [o.disks=[]]   virtio-blk disks, in order (vda, vdb, ...)
 * @param {{chardev:string}} o.agent      the agent channel (see channelEndpoint)
 * @param {{chardev:string}} [o.qmp]      control channel, used to power down and (later) snapshot
 * @param {string} [o.serialLog]          file that receives the kernel console
 * @param {boolean} [o.internet=false]    false isolates the guest from the host network and the internet
 * @param {boolean} [o.balloon=true]
 * @param {boolean} [o.freePageReporting=false]   UNVERIFIED on WHPX and HVF, so off until the spike says otherwise
 * @param {string} [o.machine]            override: 'microvm' or 'q35' on x86_64, 'virt' on aarch64
 * @param {string} [o.shareDir]           QEMU data folder (firmware, option ROMs) when the build ships one
 */
export function buildQemuArgs(o) {
  const { arch, accel, name, kernel, initrd, agent } = o;
  if (!['x86_64', 'aarch64'].includes(arch)) throw invalid('arch', arch, 'use x86_64 or aarch64');
  if (!['whpx', 'hvf', 'kvm', 'tcg'].includes(accel)) throw invalid('accel', accel, 'use whpx, hvf, kvm or tcg');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name ?? '')) throw invalid('name', name, 'use letters, digits, - and _');
  const memMB = o.memMB ?? 256;
  const cpus = o.cpus ?? 1;
  if (!Number.isInteger(memMB) || memMB < 64 || memMB > 4096) throw invalid('memMB', memMB, 'use a whole number from 64 to 4096');
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > 16) throw invalid('cpus', cpus, 'use a whole number from 1 to 16');
  if (!kernel || !initrd || !agent?.chardev) throw invalid('kernel, initrd or agent channel', null, 'pass all three');

  const m = machineFor(arch, accel, o.machine);
  const dev = (base) => (m.bus === 'pci' ? `${base}-pci` : `${base}-device`);
  const args = ['-name', `${name},process=${name}`, '-nodefaults', '-no-user-config', '-display', 'none', '-monitor', 'none'];
  if (o.shareDir) args.push('-L', o.shareDir);
  args.push('-M', m.opts, '-cpu', cpuFor(accel), '-m', `${memMB}M`, '-smp', String(cpus));
  args.push('-kernel', kernel, '-initrd', initrd);
  const cmdline = [`console=${m.console}`, 'quiet', 'loglevel=3', 'panic=-1', 'reboot=k', 'random.trust_cpu=on', `can.arch=${arch}`];
  if (m.bus === 'device' && arch === 'x86_64') cmdline.push('pci=off');
  args.push('-append', cmdline.join(' '));
  if (o.serialLog) args.push('-serial', `file:${qemuEscape(o.serialLog)}`);
  else args.push('-serial', 'none');

  args.push('-chardev', agent.chardev, '-device', dev('virtio-serial'));
  args.push('-device', `virtserialport,chardev=${/id=([^,]+)/.exec(agent.chardev)[1]},name=${AGENT_PORT_NAME}`);
  if (o.qmp?.chardev) args.push('-chardev', o.qmp.chardev, '-mon', `chardev=${/id=([^,]+)/.exec(o.qmp.chardev)[1]},mode=control`);

  (o.disks ?? []).forEach((disk, i) => {
    const parts = [`file=${qemuEscape(disk.file)}`, 'if=none', `id=disk${i}`, `format=${disk.format ?? 'raw'}`];
    if (disk.readonly) parts.push('readonly=on');
    args.push('-drive', parts.join(','), '-device', `${dev('virtio-blk')},drive=disk${i}`);
  });

  args.push('-netdev', `user,id=net0,ipv6=off,restrict=${o.internet ? 'off' : 'on'}`, '-device', `${dev('virtio-net')},netdev=net0`);
  args.push('-device', dev('virtio-rng'));
  if (o.balloon ?? true) {
    const extra = o.freePageReporting ? ',deflate-on-oom=on,free-page-reporting=on' : ',deflate-on-oom=on';
    args.push('-device', `${dev('virtio-balloon')}${extra}`);
  }
  args.push('-no-reboot');
  return args;
}
