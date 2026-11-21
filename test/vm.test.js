// Sandbox escape tests. Code inside a can must never read or write host files, spawn host processes
// or see host environment variables. Each test runs real escape attempts inside a can VM process.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CanManager } from '../src/manager.js';
import { Membrane } from '../src/vm/membrane.js';
import { vmExecArgv, SRC_DIR, VM_HEAP_MB } from '../src/vm/supervisor.js';

const MANIFEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MANIFEST_DIR, '..');

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-vm-'));
const managers = [];
const scratch = [storeDir];

function newManager(opts = {}) {
  const m = new CanManager({ storeDir, ...opts });
  managers.push(m);
  return m;
}
after(async () => {
  for (const m of managers) await m.destroyAll();
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** A host file path that the escape attempts try to create. It must not exist afterwards. */
function hostMarker(label) {
  const dir = path.join(os.tmpdir(), `can-escape-${randomUUID()}`);
  scratch.push(dir);
  fs.mkdirSync(dir);
  return path.join(dir, `${label}.txt`);
}

/** Runs `src` as /home/agent/probe.js inside the can and returns the process result. */
async function runProbe(can, src) {
  await can.writeFile('/home/agent/probe.js', src);
  return can.exec('node probe.js', { timeout: 15_000 });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// A probe that tries every route to a host Function. A reached route reports its host pid.
// Each attempt prints one line: "<name>: contained" or "<name>: REACHED <value>".
const CONSTRUCTOR_ROUTES = `
  const out = [];
  const attempt = (name, fn) => {
    try {
      const v = fn();
      out.push(name + ': ' + (v === undefined ? 'undefined' : 'REACHED ' + String(v)));
    } catch (e) {
      out.push(name + ': contained');
    }
  };
  const tryHostPid = (f) => f('return process.pid')();
  attempt('path.resolve.constructor', () => tryHostPid(require('path').resolve.constructor));
  attempt('Buffer.constructor', () => tryHostPid(Buffer.constructor));
  attempt('process.constructor', () => tryHostPid(process.constructor));
  attempt('setTimeout.constructor', () => tryHostPid(setTimeout.constructor));
  attempt('console.log.constructor', () => tryHostPid(console.log.constructor));
  attempt('proto of module fn', () => tryHostPid(Object.getPrototypeOf(require('path').resolve).constructor));
  attempt('descriptor of constructor', () => tryHostPid(Object.getOwnPropertyDescriptor(require('path').resolve, 'constructor').value));
  attempt('Reflect.get constructor', () => tryHostPid(Reflect.get(require('path').resolve, 'constructor')));
  attempt('events instance', () => tryHostPid(new (require('events'))().constructor));
  attempt('error constructor', () => {
    try { require('path').resolve(5); } catch (e) { return tryHostPid(e.constructor.constructor); }
    return undefined;
  });
  attempt('globalThis constructor', () => tryHostPid(globalThis.constructor.constructor));
  attempt('this constructor', () => tryHostPid(this.constructor.constructor));
  attempt('eval', () => eval('process.pid'));
  attempt('new Function', () => new Function('return process.pid')());
  attempt('legacy __lookupGetter__', () => tryHostPid(require('path').resolve.__lookupGetter__('constructor')));
  attempt('accessor descriptor getter', () => tryHostPid(Object.getOwnPropertyDescriptor(process, 'exitCode').get.constructor));
  console.log(out.join('\\n'));
`;

describe('escape attempts from can code fail (layer 1 and layer 2)', () => {
  let manager;
  let can;

  before(async () => {
    manager = newManager();
    can = await manager.create({ name: 'escape-target' });
  });

  test('the constructor-chain escape that used to read C:/Windows/win.ini is contained', async () => {
    const r = await runProbe(can, `
      try {
        const hostFn = require('path').resolve.constructor;
        const text = hostFn('return process.getBuiltinModule("fs").readFileSync("C:/Windows/win.ini","utf8")')();
        console.log('ESCAPED', text.length);
      } catch (e) { console.log('contained', e.message); }
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /ESCAPED/);
    assert.match(r.stdout, /contained/);
  });

  test('no route from can code reaches the host Function constructor', async () => {
    const r = await runProbe(can, CONSTRUCTOR_ROUTES);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /REACHED/, r.stdout);
    assert.equal(r.stdout.trim().split('\n').length, 16, r.stdout);
  });

  test('writing a host file through an escape fails, and no host file appears', async () => {
    const marker = hostMarker('write');
    const target = marker.replace(/\\/g, '/');
    const r = await runProbe(can, `
      const fs = require('fs');
      const TARGET = ${JSON.stringify(target)};
      try { fs.mkdirSync(TARGET.slice(0, TARGET.lastIndexOf('/')), { recursive: true }); } catch (e) { console.log('mkdir', e.code); }
      try { fs.writeFileSync(TARGET, 'pwned'); console.log('wrote inside the can filesystem only'); } catch (e) { console.log('write', e.code); }
      try { require('path').resolve.constructor('return require("fs")')().writeFileSync(TARGET, 'pwned'); console.log('ESCAPED WRITE'); }
      catch (e) { console.log('escape write contained', e.message.slice(0, 40)); }
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /ESCAPED/);
    assert.equal(fs.existsSync(marker), false, 'the host file must not be created');
  });

  test('spawning host processes fails: child_process is the can shell, and the host is untouched', async () => {
    const marker = hostMarker('spawn');
    const target = marker.replace(/\\/g, '/');
    const r = await runProbe(can, `
      const cp = require('child_process');
      try { cp.execSync('cmd /c echo pwned > "${target}"'); console.log('SPAWNED SYNC'); }
      catch (e) { console.log('execSync status', e.status); }
      try { cp.execSync('C:\\\\Windows\\\\System32\\\\cmd.exe /c echo pwned'); console.log('SPAWNED SYNC'); }
      catch (e) { console.log('execSync host binary status', e.status); }
      cp.exec('cmd.exe /c echo pwned > "${target}"', () => { /* the redirect target is not in the VFS: no host write */ });
      cp.exec('cmd.exe /c echo pwned', (err, out, stderr) => {
        console.log('exec exit', err ? err.code : 0, String(stderr).includes('command not found') ? 'command not found' : 'other');
      });
      try {
        require('path').resolve.constructor('return process.getBuiltinModule("child_process").spawnSync("cmd.exe", ["/c", "echo pwned"])')();
        console.log('ESCAPED SPAWN');
      } catch (e) { console.log('escape spawn contained'); }
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /SPAWNED|ESCAPED/);
    // execSync runs in the can shell. The redirect target resolves inside the can filesystem and fails there (no host
    // write), and a host binary named by its absolute path is not a can command: it exits 127 without running.
    assert.match(r.stdout, /execSync status [1-9]\d*\n/);
    assert.match(r.stdout, /execSync host binary status 127/);
    assert.match(r.stdout, /exec exit 127 command not found/);
    assert.equal(fs.existsSync(marker), false, 'no host process may have written the marker');
  });

  test('host environment variables are not visible, by any route', async () => {
    const r = await runProbe(can, `
      const out = [];
      out.push('USERPROFILE=' + process.env.USERPROFILE);
      out.push('PATH=' + process.env.PATH);
      out.push('keys=' + Object.keys(process.env).sort().join(','));
      try {
        const hostProcess = require('path').resolve.constructor('return process')();
        out.push('host env keys=' + Object.keys(hostProcess.env).length);
      } catch (e) { out.push('host env contained'); }
      console.log(out.join('\\n'));
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /USERPROFILE=undefined/);
    assert.match(r.stdout, /PATH=\/usr\/local\/bin:\/usr\/bin:\/bin/);
    assert.match(r.stdout, /keys=HOME,LANG,PATH,SHELL,TMPDIR,USER/);
    assert.doesNotMatch(r.stdout, /host env keys=/);
    assert.doesNotMatch(r.stdout, /SYSTEMROOT|WINDIR|Lenovo/);
  });

  test('host process internals (binding, dlopen, getBuiltinModule) are absent from can code', async () => {
    const r = await runProbe(can, `
      console.log(typeof process.binding, typeof process.dlopen, typeof process.getBuiltinModule, typeof process._linkedBinding);
    `);
    assert.equal(r.stdout.trim(), 'undefined undefined undefined undefined');
  });

  test('can code cannot read host files with real paths', async () => {
    const r = await runProbe(can, `
      const fs = require('fs');
      for (const p of ['C:/Windows/win.ini', 'C:/Users/Lenovo/.ssh/id_rsa', ${JSON.stringify(path.join(PROJECT_ROOT, 'package.json').replace(/\\/g, '/'))}]) {
        try { fs.readFileSync(p); console.log('READ', p); } catch (e) { console.log('denied', e.code); }
      }
    `);
    assert.doesNotMatch(r.stdout, /READ/);
    assert.equal(r.stdout.trim().split('\n').filter((l) => l === 'denied ENOENT').length, 3);
  });

  test('browser page scripts cannot reach host intrinsics either', async () => {
    const serverSrc = `
      require('http').createServer((req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end('<title>Escape page</title><p id="p">static</p>');
      }).listen(8090);
    `;
    await can.writeFile('/app/escape-page.js', serverSrc);
    await can.spawn('node /app/escape-page.js &', { background: true, cwd: '/app' });
    await until(async () => (await can.listeners()).some((l) => l.port === 8090));
    await can.openBrowser({ internet: false });
    await can.browse('goto', 'http://localhost:8090/');
    const result = await can.browse('evaluate', `(() => {
      const out = [];
      const attempt = (name, fn) => {
        try { const v = fn(); out.push(name + ': ' + (v === undefined ? 'undefined' : 'REACHED ' + String(v))); }
        catch (e) { out.push(name + ': contained'); }
      };
      const hostPid = (f) => f('return process.pid')();
      attempt('document', () => hostPid(document.constructor.constructor));
      attempt('window', () => hostPid(window.constructor.constructor));
      attempt('location', () => hostPid(location.constructor.constructor));
      attempt('console', () => hostPid(console.log.constructor));
      attempt('eval', () => eval('process.pid'));
      attempt('Function', () => new Function('return process.pid')());
      attempt('fetch', () => hostPid(fetch.constructor));
      return out;
    })()`);
    for (const line of result) assert.doesNotMatch(line, /REACHED/, line);
    assert.equal(result.length, 7);
  });
});

describe('membrane (layer 2) unit checks', () => {
  // The membrane is exercised directly here, in the host process, against a fresh vm context.
  const make = () => {
    const sb = Object.create(null);
    const ctx = vm.createContext(sb, { codeGeneration: { strings: false, wasm: false } });
    return { sb, ctx, m: new Membrane(ctx) };
  };

  test('host constructors, accessors and thrown objects never reach sandbox code raw', () => {
    const { sb, ctx, m } = make();
    const ee = new EventEmitter();
    Object.defineProperty(ee, 'x', { get: () => 1, set() {}, enumerable: true });
    sb.ee = m.sandbox(ee);
    sb.path = m.sandbox(path);
    sb.thrower = m.sandbox(() => { throw { code: 'X', secret: { a: 1 } }; });
    const probe = vm.runInContext(`({
      ctor: ee.constructor,
      protoCtor: Object.getPrototypeOf(ee).constructor,
      getterCtor: Object.getOwnPropertyDescriptor(ee, 'x').get.constructor,
      resolveCtor: path.resolve.constructor,
      fromCatch: (() => { try { thrower(); } catch (e) { return [e.code, e.secret.constructor, Object.getPrototypeOf(e) === Object.prototype]; } })(),
    })`, ctx);
    assert.equal(probe.ctor, undefined);
    assert.equal(probe.protoCtor, undefined);
    assert.equal(probe.getterCtor, undefined);
    assert.equal(probe.resolveCtor, undefined);
    // The thrown object's prototype is the sandbox's own Object.prototype, never the host's.
    assert.equal(probe.fromCatch[0], 'X');
    assert.equal(probe.fromCatch[1], undefined);
    assert.equal(probe.fromCatch[2], true);
  });

  test('sandbox subclasses of host classes keep their identity', () => {
    const { sb, ctx, m } = make();
    sb.EE = m.sandbox(EventEmitter);
    const ok = vm.runInContext(`
      class Bus extends EE {}
      const b = new Bus();
      [b instanceof Bus, b instanceof EE, b.constructor === Bus, Object.getPrototypeOf(b) === Bus.prototype]
    `, ctx);
    assert.equal(JSON.stringify(ok), '[true,true,true,true]');
  });

  test('host built-ins are instances of the sandbox built-ins', () => {
    const { sb, ctx, m } = make();
    sb.Buffer = m.sandbox(Buffer);
    sb.buf = m.sandbox(Buffer.from('ab'));
    sb.list = m.sandbox(['x']);
    const ok = vm.runInContext('[buf instanceof Uint8Array, buf instanceof Buffer, Array.isArray(list), list instanceof Array]', ctx);
    assert.equal(JSON.stringify(ok), '[true,true,true,true]');
  });

  test('values that cross to the host and come back keep their identity', () => {
    const { sb, ctx, m } = make();
    const seen = [];
    sb.keep = m.sandbox((v) => { seen.push(v); return v; });
    const ok = vm.runInContext('(() => { const o = { n: 1 }; return keep(o) === o; })()', ctx);
    assert.equal(ok, true);
    assert.equal(typeof seen[0], 'object');
  });
});

describe('layer 1 holds without layer 2 (membrane and codegen flag off)', () => {
  // The membrane and --disallow-code-generation-from-strings are disabled for this can only.
  // Constructor-chain escapes now reach the host realm, so every host action must be refused by
  // the permission model and the empty environment alone.
  let manager;
  let can;

  before(async () => {
    manager = newManager({ layer2: false });
    can = await manager.create({ name: 'layer1-only' });
  });

  test('host Function is reachable here, yet file, process, env and worker access is denied by the OS-level model', async () => {
    const marker = hostMarker('layer1');
    const target = marker.replace(/\\/g, '/');
    const r = await runProbe(can, `
      const H = require('path').resolve.constructor;
      const host = H('return process')();
      const attempt = (name, fn) => {
        try { const v = fn(); console.log(name, 'REACHED', String(v).slice(0, 60)); }
        catch (e) { console.log(name, 'denied', e.code || e.name); }
      };
      console.log('host realm reachable:', typeof host.getBuiltinModule);
      console.log('host env keys:', Object.keys(host.env).length);
      attempt('read win.ini', () => host.getBuiltinModule('fs').readFileSync('C:/Windows/win.ini', 'utf8'));
      attempt('write host file', () => host.getBuiltinModule('fs').writeFileSync('${target}', 'x'));
      attempt('spawn host process', () => host.getBuiltinModule('child_process').spawnSync('cmd.exe', ['/c', 'echo pwned']));
      attempt('exec host shell', () => host.getBuiltinModule('child_process').execSync('echo pwned'));
      attempt('process.binding fs', () => host.binding('fs'));
      attempt('dlopen', () => host.dlopen({ exports: {} }, 'x.node'));
      attempt('worker thread', () => new (host.getBuiltinModule('worker_threads').Worker)('1', { eval: true }));
      attempt('inspector open', () => host.getBuiltinModule('inspector').open(0, '127.0.0.1', false));
    `);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /host realm reachable: function/);
    assert.match(r.stdout, /host env keys: 0/, 'the host process env is scrubbed at boot');
    // On Windows the file exists and the permission model refuses the read. On macOS and Linux there is no
    // C:/Windows/win.ini, so the read fails with ENOENT. Either way the read must not succeed (checked by REACHED above).
    assert.match(r.stdout, /read win\.ini denied (ERR_ACCESS_DENIED|ENOENT)/);
    assert.match(r.stdout, /write host file denied ERR_ACCESS_DENIED/);
    assert.match(r.stdout, /spawn host process denied ERR_ACCESS_DENIED/);
    assert.match(r.stdout, /exec host shell denied ERR_ACCESS_DENIED/);
    assert.match(r.stdout, /process\.binding fs denied ERR_ACCESS_DENIED/);
    assert.match(r.stdout, /dlopen denied ERR_DLOPEN_DISABLED/);
    assert.match(r.stdout, /worker thread denied ERR_ACCESS_DENIED/);
    assert.match(r.stdout, /inspector open denied/);
    assert.doesNotMatch(r.stdout, /REACHED/);
    assert.equal(fs.existsSync(marker), false);
  });
});

describe('the can VM process is started with Node\'s permission model', () => {
  test('the flags allow reads of the project src directory only', () => {
    const flags = vmExecArgv({ layer2: true });
    assert.ok(flags.includes('--permission'));
    assert.deepEqual(flags.filter((f) => f.startsWith('--allow-')), [`--allow-fs-read=${SRC_DIR}`]);
    assert.ok(flags.includes('--disallow-code-generation-from-strings'));
    assert.ok(flags.includes(`--max-old-space-size=${VM_HEAP_MB}`), 'the heap is capped');
    for (const forbidden of ['--allow-fs-write', '--allow-child-process', '--allow-worker', '--allow-addons',
      '--allow-wasi', '--allow-inspector']) {
      assert.equal(flags.some((f) => f.startsWith(forbidden)), false, forbidden);
    }
  });

  test('the running process has exactly those flags (Windows command line check)', { skip: process.platform !== 'win32' }, async () => {
    const manager = newManager();
    const can = await manager.create({ name: 'cmdline' });
    const ps = await new Promise((resolve, reject) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${can.vmPid}").CommandLine`]);
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', reject);
      p.on('close', () => resolve(out.trim()));
    });
    assert.match(ps, /--permission/);
    assert.match(ps, /--allow-fs-read=/);
    assert.match(ps, new RegExp(`--max-old-space-size=${VM_HEAP_MB}`));
    assert.doesNotMatch(ps, /--allow-(fs-write|child-process|worker|addons|wasi|inspector)/);
  });
});

describe('crashes and lifetimes of can VM processes', () => {
  test('a VM that dies is reported to pending and later calls, and can still be destroyed', async () => {
    const manager = newManager();
    const can = await manager.create({ name: 'doomed' });
    const pending = can.exec('node -e "setInterval(() => {}, 1000)"', { timeout: 0 });
    await until(async () => (await can.ps({ status: 'running' })).length === 1);
    process.kill(can.vmPid, 'SIGKILL');

    await assert.rejects(pending, { code: 'ECHILD' });
    await until(() => can.status === 'crashed');
    await assert.rejects(can.exec('echo hi'), { code: 'ECHILD', message: /crashed/ });
    await assert.rejects(can.readFile('/etc/hostname', 'utf8'), { code: 'ECHILD' });
    await manager.destroy('doomed');
    assert.equal(manager.get('doomed'), undefined);
  });

  test('destroy terminates the VM process', async () => {
    const manager = newManager();
    const can = await manager.create({ name: 'gone' });
    const pid = can.vmPid;
    assert.equal(isAlive(pid), true);
    await manager.destroy('gone');
    await until(() => !isAlive(pid));
    assert.equal(can.status, 'destroyed');
  });

  for (const mode of ['clean', 'hard']) {
    test(`a host that exits (${mode}) takes its can VMs with it`, async () => {
      const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-host-'));
      scratch.push(helperDir);
      const helper = path.join(helperDir, 'helper.mjs');
      fs.writeFileSync(helper, `
        import { CanManager } from ${JSON.stringify(pathToFileURL(path.join(SRC_DIR, 'manager.js')).href)};
        const m = new CanManager({ storeDir: process.argv[2] });
        const can = await m.create({ name: 'orphan' });
        // Report the VM pid, then die: cleanly (exit handlers run) or hard (only the IPC disconnect remains).
        process.stdout.write('VMPID ' + can.vmPid + '\\n', () => {
          if (process.argv[3] === 'hard') process.kill(process.pid, 'SIGKILL');
          else process.exit(0);
        });
      `);
      const host = spawn(process.execPath, [helper, storeDir, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      host.stdout.on('data', (d) => { out += d; });
      await new Promise((resolve) => host.on('exit', resolve));
      const vmPid = Number(out.match(/VMPID (\d+)/)?.[1]);
      assert.ok(vmPid > 0, `helper did not report a VM pid: ${out}`);
      await until(() => !isAlive(vmPid), 10_000);
      assert.equal(isAlive(vmPid), false);
    });
  }
});
