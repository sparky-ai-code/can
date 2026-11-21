// Environment specs (src/environment.js): the checks that run before anything boots, the steps that run before
// the first command, host imports with excludes, the network policy and the Node version a can reports, and what
// a failed step leaves behind (nothing: the can is discarded).
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';
import { normalizeEnvironment, describeReport } from '../src/environment.js';
import { excludeMatcher } from '../src/transfer.js';
import { normalizePolicy, checkNodeVersion, checkRegistry } from '../src/vm/policy.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-env-'));
const mountsFile = path.join(tmp, 'mounts.json'); // absent: no host mounts
const manager = new CanManager({ storeDir: path.join(tmp, 'store'), mountsFile });
let counter = 0;
const nameFor = (label) => `env-${label}-${++counter}`;

after(async () => {
  await manager.destroyAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const refusal = (code, pattern) => ({ code, message: pattern });

describe('environment spec checks (before anything boots)', () => {
  test('a missing spec gives the defaults', () => {
    const spec = normalizeEnvironment(undefined);
    assert.deepEqual(spec.policy, { internet: true, registry: 'https://registry.npmjs.org/', nodeVersion: null });
    assert.deepEqual([spec.env, spec.imports, spec.files, spec.setup, spec.requireTools], [{}, [], [], [], []]);
    assert.equal(spec.workdir, null);
  });

  test('unknown settings are refused, at every level', () => {
    assert.throws(() => normalizeEnvironment({ enviroment: 1 }), refusal('EINVAL', /unknown environment setting "enviroment"/));
    assert.throws(() => normalizeEnvironment({ network: { proxy: 'x' } }), refusal('EINVAL', /unknown network setting "proxy"/));
    assert.throws(() => normalizeEnvironment({ setup: [{ command: 'true', timout: 5 }] }), refusal('EINVAL', /unknown setup\[0\] setting "timout"/));
    assert.throws(() => normalizeEnvironment({ files: [{ path: '/a', content: '', mode: 1 }] }), refusal('EINVAL', /unknown files\[0\] setting "mode"/));
  });

  test('bad values are refused before anything is created', () => {
    const cases = [
      [{ env: { '1BAD': 'x' } }, /environment variable name "1BAD"/],
      [{ env: { OK: 3 } }, /OK must be a string/],
      [{ node: 'twenty' }, /nodeVersion must look like/],
      [{ node: '16' }, /too old/],
      [{ network: { registry: 'ftp://mirror.example/' } }, /http or https URL/],
      [{ network: { internet: 'yes' } }, /must be true or false/],
      [{ workdir: 'app' }, /absolute path inside the can/],
      [{ workdir: '/app/../etc' }, /must not contain/],
      [{ imports: [{ hostPath: 'C:\\x', canPath: '/a', exclude: ['src/a'] }] }, /one file or folder name/],
      [{ imports: [{ canPath: '/a' }] }, /needs a hostPath/],
      [{ files: [{ path: '/a', content: 'x', encoding: 'latin1' }] }, /"utf8" or "base64"/],
      [{ requireTools: ['bad name!'] }, /command names/],
      [{ setup: [{ command: '   ' }] }, /non-empty command/],
      [{ setup: [{ command: 'true', timeoutMs: 0 }] }, /timeoutMs/],
      [{ setup: [{ command: 'true', timeoutMs: 999999999 }] }, /timeoutMs/],
    ];
    for (const [spec, pattern] of cases) {
      assert.throws(() => normalizeEnvironment(spec), refusal('EINVAL', pattern), JSON.stringify(spec));
    }
  });

  test('valid values are normalized', () => {
    const spec = normalizeEnvironment({
      node: '24',
      network: { registry: 'https://mirror.example/npm' },
      workdir: '/app/',
      files: [{ path: '/app/blob', content: 'AAEC', encoding: 'base64' }],
      imports: [{ hostPath: 'C:\\proj', canPath: '/app' }],
      setup: [{ command: 'npm install' }],
    });
    assert.equal(spec.policy.nodeVersion, 'v24');
    assert.equal(spec.policy.registry, 'https://mirror.example/npm/');
    assert.equal(spec.workdir, '/app');
    assert.deepEqual([...spec.files[0].bytes], [0, 1, 2]);
    assert.equal(spec.files[0].overwrite, true, 'files overwrite by default (a fresh can)');
    assert.equal(spec.imports[0].overwrite, false, 'imports keep existing files by default');
    assert.equal(spec.setup[0].timeoutMs, 300_000);
    assert.equal(spec.setup[0].label, 'npm install');
  });

  test('policy helpers check the Node version and the registry', () => {
    assert.equal(checkNodeVersion('v24.15.0'), 'v24.15.0');
    assert.equal(checkNodeVersion('24.15'), 'v24.15');
    assert.equal(checkRegistry('https://r.example'), 'https://r.example/');
    assert.throws(() => normalizePolicy({ registry: 'http://' }), /http or https URL/);
    assert.throws(() => normalizePolicy({ bogus: true }), /unknown policy setting "bogus"/);
  });
});

describe('excludes for host imports', () => {
  test('names match at any depth, * matches inside one name, paths are refused', () => {
    const skip = excludeMatcher(['node_modules', '*.log', '.env*']);
    assert.equal(skip('node_modules'), true);
    assert.equal(skip('debug.log'), true);
    assert.equal(skip('.env.local'), true);
    assert.equal(skip('src'), false);
    assert.equal(skip('logs'), false);
    assert.equal(skip('x.logs'), false);
    assert.throws(() => excludeMatcher(['a/b']), /one file or folder name/);
    assert.throws(() => excludeMatcher(['..']), /one file or folder name/);
  });
});

describe('applying an environment to a can', () => {
  test('env, workdir, node version and files are in place before the first command', async () => {
    const name = nameFor('basics');
    const can = await manager.create({
      name,
      environment: {
        env: { GREETING: 'hi' },
        workdir: '/home/agent/app',
        node: '24.15.0',
        files: [
          { path: '/home/agent/app/cfg.json', content: '{"a":1}\n' },
          { path: '/home/agent/app/blob.bin', content: Buffer.from([0, 255, 16]).toString('base64'), encoding: 'base64' },
        ],
        setup: [{ command: 'pwd > /home/agent/where.txt' }],
      },
    });
    assert.equal(can.report.workdir, '/home/agent/app');
    assert.equal(await can.readFile('/home/agent/where.txt', 'utf8'), '/home/agent/app\n', 'setup runs in the workdir');
    assert.equal((await can.exec('pwd')).stdout, '/home/agent/app\n', 'commands start in the workdir by default');
    assert.equal(await can.readFile('/home/agent/app/cfg.json', 'utf8'), '{"a":1}\n');
    assert.deepEqual([...(await can.readFile('/home/agent/app/blob.bin'))], [0, 255, 16]);
    const r = await can.exec('echo $GREETING && node -p process.version');
    assert.equal(r.stdout, 'hi\nv24.15.0\n');
  });

  test('without a node setting the can reports the runtime default', async () => {
    const can = await manager.create({ name: nameFor('default-node') });
    assert.equal((await can.exec('node -p process.version')).stdout, 'v20.11.0\n');
  });

  test('a host folder is copied in without its excluded entries', async () => {
    const host = path.join(tmp, 'project');
    fs.mkdirSync(path.join(host, 'src'), { recursive: true });
    fs.mkdirSync(path.join(host, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(host, '.git'), { recursive: true });
    fs.writeFileSync(path.join(host, 'src', 'app.js'), 'console.log("app")\n');
    fs.writeFileSync(path.join(host, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n');
    fs.writeFileSync(path.join(host, '.git', 'HEAD'), 'ref\n');
    fs.writeFileSync(path.join(host, 'debug.log'), 'noise\n');
    const can = await manager.create({
      name: nameFor('import'),
      environment: {
        imports: [{ hostPath: host, canPath: '/home/agent/proj', exclude: ['node_modules', '.git', '*.log'] }],
      },
    });
    assert.equal(await can.readFile('/home/agent/proj/src/app.js', 'utf8'), 'console.log("app")\n');
    assert.equal(await can.exists('/home/agent/proj/node_modules'), false);
    assert.equal(await can.exists('/home/agent/proj/.git'), false);
    assert.equal(await can.exists('/home/agent/proj/debug.log'), false);
    assert.equal(can.report.imports[0].skipped, 3);
  });

  test('required tools: a missing one discards the can with a clear reason', async () => {
    const ok = await manager.create({ name: nameFor('tools-ok'), environment: { requireTools: ['npm', 'node'] } });
    assert.deepEqual(ok.report.tools, ['npm', 'node']);
    const name = nameFor('tools-missing');
    await assert.rejects(
      manager.create({ name, environment: { requireTools: ['npm', 'cargo'] } }),
      refusal('ENOENT', /does not provide cargo.*no native toolchain/s),
    );
    assert.equal(manager.get(name), undefined, 'the can is not kept');
  });

  test('a failing setup step discards the can and returns its output', async () => {
    const name = nameFor('setup-fails');
    await assert.rejects(
      manager.create({ name, environment: { setup: [{ command: 'echo boom && exit 3', label: 'broken step' }] } }),
      refusal('EIO', /setup step "broken step" exited with code 3[\s\S]*boom/),
    );
    assert.equal(manager.get(name), undefined);
  });

  test('an optional failing step is reported and the can is kept', async () => {
    const can = await manager.create({
      name: nameFor('setup-optional'),
      environment: { setup: [{ command: 'exit 2', optional: true, label: 'nice to have' }, { command: 'echo next' }] },
    });
    assert.equal(can.report.setup[0].exitCode, 2);
    assert.equal(can.report.setup[1].exitCode, 0, 'later steps still run');
  });

  test('a setup step that runs past its timeout is stopped and fails', async () => {
    const name = nameFor('setup-timeout');
    await assert.rejects(
      manager.create({ name, environment: { setup: [{ command: 'sleep 5', timeoutMs: 300 }] } }),
      refusal('EIO', /timed out/),
    );
    assert.equal(manager.get(name), undefined);
  });

  test('the policy is saved with the can: a reloaded can keeps its Node version and offline setting', async () => {
    const name = nameFor('persist');
    const can = await manager.create({ name, environment: { node: '24', network: { internet: false } } });
    await manager.save(can.id);
    await manager.stop(can.id);
    const again = await manager.load(can.id);
    assert.equal((await again.exec('node -p process.version')).stdout, 'v24\n');
    const r = await again.exec('curl -s https://example.com/');
    assert.equal(r.exitCode, 7);
    assert.match(r.stderr, /network access is off/);
  });

  test('internet off also stops code inside the can from opening outbound connections', async () => {
    const can = await manager.create({ name: nameFor('offline-js'), environment: { network: { internet: false } } });
    const r = await can.exec(`node -e "require('https').get('https://example.com/', () => {}).on('error', e => console.log('ERR', e.code))"`);
    assert.match(r.stdout, /ERR EPERM/);
  });

  test('the report reads as a short summary for the agent', async () => {
    const can = await manager.create({
      name: nameFor('report'),
      environment: { node: '24', network: { internet: false }, requireTools: ['npm'], files: [{ path: '/home/agent/a', content: 'x' }] },
    });
    const text = describeReport(can.report);
    assert.match(text, /tools: npm/);
    assert.match(text, /runtime: v24/);
    assert.match(text, /network: internet off/);
    assert.match(text, /wrote 1 file/);
    assert.match(text, /start folder: \/home\/agent/);
  });
});
