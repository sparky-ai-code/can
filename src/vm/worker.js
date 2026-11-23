// Can VM entry point. Each can runs as its own child Node process, started by supervisor.js with
//   --permission --allow-fs-read=<src>   (layer 1: no fs writes, no child processes, no workers,
//                                          no addons, no inspector; reads only inside src/)
//   --disallow-code-generation-from-strings   (layer 2: no eval/Function in this process)
// and an empty environment. The host talks to this process only over IPC (protocol.js).
//
// Boot order matters: the environment is scrubbed and the escape hatches removed before any
// can code runs. The imports below are resolved before the body runs, so the body can still use them.
import { Machine, checkSnapshot } from './machine.js';
import { takePage, attachDecoded } from './snapshot-pages.js';
import { VFS } from '../kernel/vfs.js';
import { KernelError } from '../kernel/errors.js';
import { seedFilesystem, DEFAULT_ENV } from './seed.js';
import { hardening } from './membrane.js';
import { encodeError } from './protocol.js';
import { denyHostListening } from './guards.js';

const LAYER2 = !process.argv.includes('--no-layer2');
const send = process.send.bind(process);

// Layer 1, in-process part: libuv copies Windows system variables (USERPROFILE, PATH, ...) into
// every child even when env is {}. Remove them so nothing host-side is left in this process.
// One exception: on Windows, DNS lookups (getaddrinfo) need SYSTEMROOT in the OS environment. Without it every
// lookup fails with ENOTFOUND, which cut the can off from the internet (and so from its npm registry). It is kept
// at the OS level only; the JS process.env object is replaced by an empty one, so host-side code sees no keys.
// SYSTEMROOT names the Windows folder and is not a secret. See SPEC.md section 10.1.
const KEEP_OS_ENV = process.platform === 'win32' ? ['SYSTEMROOT'] : [];
for (const key of Object.keys(process.env)) {
  if (!KEEP_OS_ENV.includes(key)) delete process.env[key];
}
process.env = Object.create(null);

// Layer 2: the real process object still offers host-level escape hatches. Remove them.
hardening.enabled = LAYER2;
if (LAYER2) {
  for (const key of ['binding', 'getBuiltinModule', 'dlopen', '_linkedBinding']) {
    try { delete process[key]; } catch { /* not configurable on this build: layer 1 still refuses */ }
  }
}

// Layer 2b: no host port can be opened from this process, whatever the membrane did. Applied in both
// modes, so the layer-1-only tests can show it holds on its own too (see guards.js).
denyHostListening();

const BROWSER_ACTIONS = new Set([
  'goto', 'reload', 'back', 'forward', 'wait', 'text', 'html', 'links', 'query', 'snapshot',
  'click', 'type', 'select', 'submit', 'evaluate', 'newTab', 'selectTab', 'closeTab', 'cookieList',
  'clearConsole', 'state', 'screenshot',
]);

let machine = null;
let browser = null;
let snapshotPlan = null; // records of the snapshot the host is paging out
let restoreBuild = null; // { head, root } of the snapshot the host is paging in

const need = () => {
  if (!machine) throw new KernelError('EINVAL', 'EINVAL: this can VM has no can yet');
  return machine;
};
// The browser module is loaded the first time a can uses a browser, not at boot: most cans never open one.
let browserModule = null;
const browserClass = async () => {
  browserModule ??= await import('../browser/browser.js');
  return browserModule.Browser;
};
const needBrowser = async () => {
  if (!browser) {
    const Browser = await browserClass();
    browser = new Browser({ can: need(), internet: need().policy.internet });
  }
  return browser;
};
const meta = () => ({
  id: machine.id, name: machine.name, createdAt: machine.createdAt, cwd: machine.vfs.cwd, env: { ...machine.env }, policy: { ...machine.policy },
});
const stat = (s) => ({
  type: s.type, size: s.size, mode: s.mode, mtime: s.mtime.getTime(), ctime: s.ctime.getTime(), birthtime: s.birthtime.getTime(),
});

/** Request handlers. Each receives the args object and returns a JSON-safe value. */
const OPS = {
  create: ({ id, name, env, mounts, policy }) => {
    machine = new Machine({ id, name, vfs: seedFilesystem(id), env: { ...DEFAULT_ENV, ...(env ?? {}) }, policy: policy ?? {} });
    machine.mountAll(mounts ?? []);
    return meta();
  },
  // Paged snapshots (see snapshot-pages.js): the tree moves one page per request, so no message holds all of it.
  // The generation is read in the same turn as the records, so it describes exactly the tree being paged out.
  snapshotHead: () => {
    const m = need();
    snapshotPlan = m.vfs.snapshotRecords();
    return { ...m.snapshotHead(), generation: m.generation() };
  },
  generation: () => need().generation(),
  snapshotPage: ({ from }) => {
    if (!snapshotPlan) throw new KernelError('EINVAL', 'EINVAL: no snapshot is being taken');
    return takePage(snapshotPlan, from);
  },
  snapshotEnd: () => { snapshotPlan = null; return null; },
  restoreHead: ({ head }) => {
    checkSnapshot(head);
    restoreBuild = { head, root: null };
    return null;
  },
  restorePage: ({ records }) => {
    if (!restoreBuild) throw new KernelError('EINVAL', 'EINVAL: no snapshot is being restored');
    restoreBuild.root = attachDecoded(restoreBuild.root, records);
    return null;
  },
  restoreEnd: ({ mounts }) => {
    const build = restoreBuild;
    restoreBuild = null;
    if (!build) throw new KernelError('EINVAL', 'EINVAL: no snapshot is being restored');
    if (!build.root) throw new KernelError('EINVAL', 'EINVAL: the snapshot has no file tree');
    const snap = { ...build.head, vfs: VFS.fromRoot(build.root, { cwd: build.head.vfs.cwd }) };
    if (machine) {
      machine.restore(snap);
      if (browser) { browser.close(); browser = null; }
    } else {
      machine = Machine.fromSnapshot(snap);
    }
    machine.mountAll(mounts ?? []);
    return meta();
  },
  exec: ({ command, opts }) => need().exec(command, opts ?? {}),
  spawn: ({ command, opts }) => need().spawn(command, opts ?? {}),
  ps: ({ status }) => need().proc.list({ status }),
  getProcess: ({ pid }) => need().proc.get(pid) ?? null,
  wait: ({ pid, timeout }) => need().proc.wait(pid, timeout),
  kill: ({ pid, signal }) => need().proc.kill(pid, signal),
  logs: ({ pid, stream }) => need().proc.output(pid, stream).toString('base64'),
  writeStdin: ({ pid, data }) => need().proc.writeStdin(pid, Buffer.from(data, 'base64')),
  endStdin: ({ pid }) => { need().proc.endStdin(pid); return null; },
  readFile: ({ path, encoding }) => {
    const v = need().vfs;
    return encoding ? v.readFile(path, encoding) : v.readFile(path).toString('base64');
  },
  writeFile: ({ path, data, binary, options }) => {
    const bytes = binary ? Buffer.from(data, 'base64') : data;
    need().vfs.writeFile(path, bytes, options ?? {});
    return null;
  },
  listDir: ({ path }) => need().vfs.readdir(path, { withFileTypes: true }).map((e) => ({
    name: e.name,
    ...stat(e),
  })),
  stat: ({ path }) => stat(need().vfs.stat(path)),
  exists: ({ path }) => need().vfs.exists(path),
  mkdir: ({ path, options }) => need().vfs.mkdir(path, options ?? {}) ?? null,
  // The folder a can starts in: the default for exec and spawn. It must already exist (src/environment.js makes it).
  setCwd: ({ path }) => {
    const v = need().vfs;
    if (!v.exists(path) || v.stat(path).type !== 'dir') throw new KernelError('ENOENT', `ENOENT: no folder ${path} in the can`);
    v.cwd = v.resolve(path);
    return null;
  },
  rm: ({ path, options }) => { need().vfs.rm(path, options ?? {}); return null; },
  request: async ({ port, method, path, headers, body, binary, timeout }) => {
    const res = await need().vnet.request({
      port, method, path, headers: headers ?? {},
      body: binary ? Buffer.from(body, 'base64') : body,
      timeout,
    });
    return { status: res.status, headers: res.headers, body: res.body.toString('base64') };
  },
  listeners: () => need().vnet.list(),
  browse: async ({ action, args }) => {
    if (!BROWSER_ACTIONS.has(action)) throw new KernelError('EINVAL', `EINVAL: unknown browser action ${action}`);
    const b = await needBrowser();
    // PNG bytes travel as base64: the reply is JSON. The host decodes them (Can.screenshot).
    if (action === 'screenshot') return b.screenshot(...(args ?? [])).toString('base64');
    if (action === 'state') {
      return {
        url: b.url, status: b.status, title: b.title, history: b.history, tabs: b.tabs, consoleLog: b.consoleLog,
      };
    }
    return b[action](...(args ?? []));
  },
  openBrowser: async ({ options }) => {
    const Browser = await browserClass();
    if (browser) browser.close();
    browser = new Browser({ can: need(), internet: need().policy.internet, ...(options ?? {}) });
    return null;
  },
  shutdown: () => {
    if (browser) browser.close();
    if (machine) machine.destroy();
    machine = null;
    browser = null;
    return null;
  },
};

/** JSON round-trip: nothing but plain data leaves this process. */
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

process.on('message', async (msg) => {
  if (!msg || msg.t !== 'req') return;
  const { id, op, args } = msg;
  const reply = { t: 'res', id };
  let exitAfter = false;
  try {
    const handler = Object.hasOwn(OPS, op) ? OPS[op] : null;
    if (!handler) throw new KernelError('EINVAL', `EINVAL: unknown op ${op}`);
    reply.ok = true;
    reply.value = plain(await handler(args ?? {}));
    exitAfter = op === 'shutdown';
  } catch (err) {
    reply.ok = false;
    reply.error = encodeError(err);
  }
  send(reply, () => { if (exitAfter) process.exit(0); });
});

// The host went away (its IPC channel closed): nothing should outlive it.
process.on('disconnect', () => process.exit(0));

// A page's own promise rejections must not bring the can down (Node would exit on an unhandled rejection). A browser
// reports them in the console and carries on, so this does the same. Errors are not hidden: they reach the console.
process.on('unhandledRejection', (reason) => {
  const text = `Uncaught (in promise) ${reason && reason.message ? `${reason.name ?? 'Error'}: ${reason.message}` : String(reason)}`;
  if (browser) browser._log('error', text);
  else process.stderr.write(`${text}\n`);
});

send({ t: 'ready', pid: process.pid, layer2: LAYER2 });

// Memory report for the host (supervisor.js): this process's resident size every 250 ms. The host compares it with
// its own reading of the child and keeps the larger one. The timer is unref'd so it never keeps this process alive.
const MEMORY_REPORT_MS = 250;
const memoryTimer = setInterval(() => {
  if (process.connected) send({ t: 'mem', rss: process.memoryUsage().rss });
}, MEMORY_REPORT_MS);
memoryTimer.unref();
