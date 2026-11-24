// Builds a small Electron app for Windows (x64) inside a guest VM: npm installs the dependencies with their install
// scripts, then electron-packager makes the Windows app. The guest has networking and a tools disk with Node.js (see
// README.md). Output: the packaged app folder inside the guest, and a report on the host.
//
// Usage: node spike/electron-build.mjs [report file]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGuest } from '../src/vm/guest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DISK = process.env.CAN_TOOLS_DISK ?? path.join(here, '..', 'guest', 'tools.img');
const REPORT = process.argv[2] ?? path.join(here, 'electron-report.json');
const APP = '/opt/can/work/notify';
const NODE = '/opt/can/node/bin/node';
const NPM = '/opt/can/node/lib/node_modules/npm/bin/npm-cli.js';
const t0 = Date.now();
const log = (msg) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(5)} s] ${msg}`);

const APP_FILES = {
  'package.json': JSON.stringify({
    name: 'notify',
    productName: 'Notify',
    // No "version" here on purpose. electron-packager infers appVersion from it, and an appVersion makes it edit the
    // Windows executable's version resources, which needs Wine on a non-Windows host. Without it the executable keeps
    // Electron's default version resources, and the build needs no Wine.
    main: 'main.js',
    private: true,
    devDependencies: { electron: 'latest', 'electron-packager': 'latest' },
  }, null, 2) + '\n',
  'main.js': [
    "const { app, BrowserWindow } = require('electron');",
    "app.whenReady().then(() => {",
    "  const win = new BrowserWindow({ width: 640, height: 400 });",
    "  win.loadFile('index.html');",
    "});",
    "app.on('window-all-closed', () => app.quit());",
    '',
  ].join('\n'),
  'index.html': '<!doctype html><title>Notify</title><h1>Notify</h1>\n',
};

// The build, run by /bin/sh inside the guest. Each step stops the build on failure.
const BUILD_SH = [
  'set -e',
  'export HOME=/opt/can/home PATH=/opt/can/node/bin:/bin',
  'mkdir -p "$HOME"',
  `cd ${APP}`,
  `${NODE} ${NPM} install --no-audit --no-fund`,
  `${NODE} node_modules/electron-packager/bin/electron-packager.js . Notify --platform=win32 --arch=x64 --out=dist --overwrite`,
  'echo BUILD-DONE',
  '',
].join('\n');

const guest = await startGuest({
  name: `electron-${process.pid}`,
  dir: fs.mkdtempSync(path.join(os.tmpdir(), 'can-electron-')),
  memMB: 2048,
  internet: true,
  disks: [{ file: DISK }],
  log,
});
log(`guest up with ${guest.accel}`);

const report = { startedAt: new Date().toISOString(), accel: guest.accel, steps: {} };
const run = async (name, argv, timeoutMs = 120000) => {
  const r = await guest.exec(argv, { timeoutMs });
  report.steps[name] = { exitCode: r.exitCode, stdout: r.stdout.slice(-2000), stderr: r.stderr.slice(-2000) };
  log(`${name}: exit ${r.exitCode}`);
  return r;
};

try {
  // The guest's network is not configured by the agent yet. QEMU's user networking gives the guest 10.0.2.15 behind
  // the gateway 10.0.2.2, and its DNS server is 10.0.2.3.
  await run('network-up', ['/bin/busybox', 'ip', 'link', 'set', 'eth0', 'up']);
  await run('address', ['/bin/busybox', 'ip', 'addr', 'add', '10.0.2.15/24', 'dev', 'eth0']);
  await run('route', ['/bin/busybox', 'ip', 'route', 'add', 'default', 'via', '10.0.2.2']);
  await guest.writeFile('/etc/resolv.conf', 'nameserver 10.0.2.3\n');
  // The machine has no real-time clock (rtc=off), so the guest starts at 1970 and every TLS certificate looks not yet
  // valid. Set the clock from the host.
  await run('clock', ['/bin/busybox', 'date', '-s', `@${Math.floor(Date.now() / 1000)}`]);
  await run('mkdir', ['/bin/busybox', 'mkdir', '-p', APP]);
  for (const [file, content] of Object.entries(APP_FILES)) {
    await guest.writeFile(`${APP}/${file}`, content);
  }
  await guest.writeFile('/opt/can/work/build.sh', BUILD_SH, { mode: 0o755 });
  await run('node-version', [NODE, '--version']);

  const id = await guest.spawn(['/bin/sh', '/opt/can/work/build.sh']);
  log(`build started as program ${id}`);
  let lastTail = '';
  let st;
  for (;;) {
    await new Promise((r) => setTimeout(r, 15000));
    st = await guest.status(id);
    const out = await guest.logs(id, 'stdout');
    const err = await guest.logs(id, 'stderr');
    const tail = (out + err).split('\n').filter(Boolean).slice(-3).join(' | ');
    if (tail !== lastTail) { log(`build: ${tail.slice(0, 240)}`); lastTail = tail; }
    if (!st.running) break;
    if (Date.now() - t0 > 45 * 60 * 1000) { await guest.killProgram(id, 9); break; }
  }
  const out = await guest.logs(id, 'stdout');
  const err = await guest.logs(id, 'stderr');
  report.build = { exitCode: st.exitCode, stdout: out.slice(-6000), stderr: err.slice(-6000) };
  log(`build exited ${st.exitCode}`);

  if (st.exitCode === 0) {
    const ls = await run('output', ['/bin/busybox', 'ls', '-la', `${APP}/dist/Notify-win32-x64`]);
    const exe = await run('exe', ['/bin/busybox', 'ls', '-la', `${APP}/dist/Notify-win32-x64/Notify.exe`]);
    report.ok = exe.exitCode === 0;
    report.output = ls.stdout;
    report.exe = exe.stdout.trim();
  } else {
    report.ok = false;
  }
} finally {
  report.finishedAt = new Date().toISOString();
  report.seconds = Math.round((Date.now() - t0) / 1000);
  await guest.poweroff().catch(() => guest.kill());
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  log(`report written to ${REPORT}; ok=${report.ok}`);
}
