// Memory monitor for one can child process (interface I3 in the implementation plan).
//
//   startMemoryMonitor(pid, {limitBytes, softBytes, onSample, onLimit}) -> {stop(), enforced, report(bytes)}
//
// Readings, by platform:
//   win32   native/win/can-memcap.exe puts the process in a Job Object with ProcessMemoryLimit = limitBytes and
//           reports its private bytes every 250 ms. enforced is 'job-object' once the helper confirms the job.
//           Without the helper (missing, or CAN_MEMCAP_DISABLE_HELPER=1) a PowerShell loop samples
//           PrivateMemorySize64 every second, and enforced is 'sampled'.
//   darwin  `ps -o rss=` every second (KiB). report(bytes) takes the child's own process.memoryUsage().rss; the
//           larger of the two values is used.
//   linux   /proc/<pid>/status VmRSS every second.
//
// softBytes is informational here: the supervisor enforces the soft limit. onLimit fires at most once.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER_SAMPLE_MS = 250;
const SAMPLE_MS = 1000;
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Path of the Windows helper, or null when it is not built or shipped. */
export function helperPath() {
  const candidates = [
    path.join(APP_ROOT, 'native', 'win', 'can-memcap.exe'),
    path.join(APP_ROOT, 'native', 'win', 'build', 'can-memcap.exe'),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

function invalid(what, value) {
  return new Error(`EINVAL: ${what} is ${JSON.stringify(value)}. Next: pass a positive whole number of bytes.`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function startMemoryMonitor(pid, { limitBytes, softBytes, onSample, onLimit } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw invalid('pid', pid);
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) throw invalid('limitBytes', limitBytes);

  const state = { stopped: false, limitFired: false, enforced: 'sampled', reported: 0 };
  let timer = null;
  let helper = null;
  let sampler = null;
  let sampling = false;

  const fireLimit = () => {
    if (state.stopped || state.limitFired) return;
    state.limitFired = true;
    onLimit?.();
  };

  const emit = (bytes) => {
    if (state.stopped || !Number.isFinite(bytes)) return;
    onSample?.(bytes);
    if (bytes >= limitBytes) fireLimit();
  };

  const onParentExit = () => stop();

  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    process.removeListener('exit', onParentExit);
    if (timer) clearInterval(timer);
    timer = null;
    if (helper && helper.exitCode === null) helper.kill();
    if (sampler && sampler.exitCode === null) sampler.kill();
    helper = null;
    sampler = null;
  }

  // Timer or PowerShell fallback: one reading per tick, skipped while a previous reading is still running.
  function startTimer(read) {
    timer = setInterval(async () => {
      if (sampling || state.stopped) return;
      sampling = true;
      try {
        const bytes = await read();
        if (bytes === null) stop(); // the process is gone
        else emit(bytes);
      } catch {
        // A failed reading is skipped; the next tick tries again.
      } finally {
        sampling = false;
      }
    }, SAMPLE_MS);
    timer.unref?.();
  }

  function readPs() {
    return new Promise((resolve, reject) => {
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const kib = Number.parseInt(stdout.trim(), 10);
        if (!Number.isFinite(kib)) return reject(new Error('unreadable ps output'));
        // ps reports RSS in KiB. The larger of ps and the child's own report is used.
        resolve(Math.max(kib * 1024, state.reported));
      });
    });
  }

  async function readProcStatus() {
    let text;
    try {
      text = await fs.promises.readFile(`/proc/${pid}/status`, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(text);
    return match ? Number(match[1]) * 1024 : null;
  }

  function startPowerShellSampler() {
    const script = [
      `$p = ${pid}`,
      'while ($true) {',
      '  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue',
      '  if (-not $proc) { break }',
      '  Write-Output $proc.PrivateMemorySize64',
      `  Start-Sleep -Milliseconds ${SAMPLE_MS}`,
      '}',
    ].join('\n');
    sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let buf = '';
    sampler.stdout.setEncoding('utf8');
    sampler.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (/^\d+$/.test(line)) emit(Number(line));
      }
    });
    sampler.on('error', () => stop());
  }

  function startHelper(exe) {
    helper = spawn(exe, [String(pid), String(limitBytes)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.event === 'ready') state.enforced = msg.job ? 'job-object' : 'sampled';
        else if (msg.event === 'limit') fireLimit();
        else if (typeof msg.private === 'number') emit(msg.private);
      }
    });
    helper.stderr.resume();
    // If the helper fails (cannot start, or dies while the process lives), sample without it.
    const fallBack = () => {
      if (state.stopped || !processAlive(pid)) return;
      state.enforced = 'sampled';
      helper = null;
      startPlatformSampler();
    };
    helper.on('error', fallBack);
    helper.on('exit', (code) => {
      if (code !== 0) fallBack();
    });
  }

  function startPlatformSampler() {
    if (process.platform === 'win32') startPowerShellSampler();
    else if (process.platform === 'darwin') startTimer(readPs);
    else startTimer(readProcStatus);
  }

  process.once('exit', onParentExit);

  const exe = process.platform === 'win32' && process.env.CAN_MEMCAP_DISABLE_HELPER !== '1' ? helperPath() : null;
  if (exe) startHelper(exe);
  else startPlatformSampler();

  return {
    stop,
    get enforced() {
      return state.enforced;
    },
    // The child's own RSS, for macOS (see the header). Ignored on the other platforms.
    report(bytes) {
      if (Number.isFinite(bytes) && bytes >= 0) state.reported = bytes;
    },
  };
}
