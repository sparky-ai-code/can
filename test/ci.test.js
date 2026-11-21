// CI pipelines (src/ci.js): the checks that run before anything boots, the order of jobs and steps, how a failure
// stops a job and a pipeline, when a can is kept, timeouts, artifacts under the transfer root, and what the report
// says. Runs real commands in real cans.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanManager } from '../src/manager.js';
import { CI_LIMITS, describeCi, normalizeCi, runCi } from '../src/ci.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'can-ci-'));
const transferRoot = path.join(tmp, 'transfer');
fs.mkdirSync(transferRoot, { recursive: true });
const manager = new CanManager({ storeDir: path.join(tmp, 'store'), mountsFile: path.join(tmp, 'none.json') });
// The same three calls CanRegistry makes, so runCi runs against the real VM stack without a registry on disk.
const registry = {
  create: (name, { environment } = {}) => manager.create({ name, environment }),
  save: (name) => manager.save(name),
  destroy: (name) => manager.destroy(name),
};

after(async () => {
  await manager.destroyAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const invalid = (pattern) => ({ code: 'EINVAL', message: pattern });
const job = (name, steps, extra = {}) => ({ name, steps, ...extra });

describe('pipeline checks (before anything boots)', () => {
  test('a valid pipeline is normalized with its defaults', () => {
    const ci = normalizeCi({ jobs: [job('test', [{ run: 'npm test' }])] });
    assert.equal(ci.keepCan, 'on-failure');
    assert.equal(ci.jobs[0].allowFailure, false);
    assert.deepEqual(ci.jobs[0].steps[0], {
      run: 'npm test', label: 'npm test', cwd: null, env: {}, timeoutMs: CI_LIMITS.defaultStepTimeoutMs, allowFailure: false,
    });
    assert.deepEqual(ci.artifacts, []);
  });

  test('unknown keys are refused at every level, so a misspelling fails loudly', () => {
    assert.throws(() => normalizeCi({ jobs: [job('a', [{ run: 'true' }])], job: 1 }), invalid(/unknown ci setting "job"/));
    assert.throws(() => normalizeCi({ jobs: [job('a', [{ run: 'true' }], { step: 1 })] }), invalid(/unknown jobs\[0\] setting "step"/));
    assert.throws(() => normalizeCi({ jobs: [job('a', [{ run: 'true', timeout: 5 }])] }), invalid(/unknown jobs\[0\].steps\[0\] setting "timeout"/));
  });

  test('bad values are refused with the first problem named', () => {
    const cases = [
      [{ jobs: [] }, /at least one entry/],
      [{ jobs: 'test' }, /must be a list/],
      [{ jobs: [job('a', [{ run: 'true' }]), job('a', [{ run: 'true' }])] }, /job name "a" is used twice/],
      [{ jobs: [job('', [{ run: 'true' }])] }, /needs a name/],
      [{ jobs: [job('a', [])] }, /at least one entry/],
      [{ jobs: [job('a', [{ run: '  ' }])] }, /needs a non-empty run line/],
      [{ jobs: [job('a', [{ run: 'true', timeoutMs: 0 }])] }, /timeoutMs/],
      [{ jobs: [job('a', [{ run: 'true', timeoutMs: CI_LIMITS.stepTimeoutMs + 1 }])] }, /timeoutMs/],
      [{ jobs: [job('a', [{ run: 'true', cwd: 'app' }])] }, /absolute path inside the can/],
      [{ jobs: [job('a', [{ run: 'true', cwd: '/app/../x' }])] }, /must not contain/],
      [{ jobs: [job('a', [{ run: 'true', env: { '1X': 'y' } }])] }, /env name "1X"/],
      [{ jobs: [job('a', [{ run: 'true', env: { X: 1 } }])] }, /env\.X must be a string/],
      [{ jobs: [job('a', [{ run: 'true', allowFailure: 'yes' }])] }, /allowFailure must be true or false/],
      [{ jobs: [job('a', [{ run: 'true' }], { allowFailure: 'yes' })] }, /allowFailure must be true or false/],
      [{ jobs: [job('a', [{ run: 'true' }])], keepCan: 'sometimes' }, /keepCan must be one of/],
      [{ jobs: [job('a', [{ run: 'true' }])], artifacts: [{ canPath: '/app' }] }, /needs a hostPath/],
      [{ jobs: [job('a', [{ run: 'true' }])], artifacts: [{ canPath: 'app', hostPath: 'x' }] }, /absolute path inside the can/],
      [{ jobs: [job('a', [{ run: 'true' }])], environment: { workdir: 'app' } }, /absolute path inside the can/],
      [{ jobs: [job('a', [{ run: 'true' }])], environment: { nope: 1 } }, /unknown environment setting "nope"/],
    ];
    for (const [spec, pattern] of cases) {
      assert.throws(() => normalizeCi(spec), invalid(pattern), JSON.stringify(spec).slice(0, 80));
    }
  });

  test('the job and step limits are enforced', () => {
    const many = Array.from({ length: CI_LIMITS.jobs + 1 }, (_, i) => job(`j${i}`, [{ run: 'true' }]));
    assert.throws(() => normalizeCi({ jobs: many }), invalid(/at most 20 entries/));
    const steps = Array.from({ length: CI_LIMITS.stepsPerJob + 1 }, () => ({ run: 'true' }));
    assert.throws(() => normalizeCi({ jobs: [job('a', steps)] }), invalid(/at most 50 entries/));
  });
});

describe('running a pipeline in a can', () => {
  test('a passing pipeline runs every step in order, shares the can, and exports artifacts', async () => {
    const report = await runCi(registry, {
      name: 'happy',
      environment: {
        workdir: '/app',
        files: [{ path: '/app/greet.js', content: 'console.log("hello " + process.env.WHO);' }],
      },
      jobs: [
        job('build', [{ run: 'mkdir -p dist && echo built > dist/out.txt', label: 'compile' }]),
        job('test', [
          { run: 'node greet.js', label: 'run', env: { WHO: 'ci' } },
          { run: 'cat dist/out.txt', label: 'read output' },
        ]),
      ],
      artifacts: [{ canPath: '/app/dist', hostPath: 'happy/dist' }],
    }, { transferRoot });

    assert.equal(report.ok, true, describeCi(report));
    assert.equal(report.kept, false);
    assert.deepEqual(report.jobs.map((j) => j.status), ['passed', 'passed']);
    assert.deepEqual(report.jobs[1].steps.map((s) => s.label), ['run', 'read output']);
    assert.equal(report.artifacts[0].files, 1);
    assert.equal(fs.readFileSync(path.join(transferRoot, 'happy', 'dist', 'out.txt'), 'utf8'), 'built\n');
    assert.equal(manager.get(report.canName), undefined, 'a passing run destroys its can');
  });

  test('a failing step stops its job, skips the rest, and keeps the can by default', async () => {
    const report = await runCi(registry, {
      jobs: [
        job('test', [
          { run: 'echo first', label: 'one' },
          { run: 'echo broken >&2; exit 2', label: 'two' },
          { run: 'echo unreachable', label: 'three' },
        ]),
        job('deploy', [{ run: 'echo deploying' }]),
      ],
    }, { transferRoot });

    assert.equal(report.ok, false);
    assert.equal(report.kept, true);
    assert.deepEqual(report.jobs.map((j) => j.status), ['failed', 'skipped']);
    const [one, two, three] = report.jobs[0].steps;
    assert.deepEqual([one.status, two.status, three.status], ['passed', 'failed', 'skipped']);
    assert.equal(two.exitCode, 2);
    assert.match(two.output, /broken/);
    assert.ok(manager.get(report.canName), 'the kept can is still live');
    await manager.destroy(report.canName);
  });

  test('allowFailure lets later jobs run, and the pipeline still passes when only allowed steps fail', async () => {
    const report = await runCi(registry, {
      keepCan: 'never',
      jobs: [
        job('lint', [{ run: 'exit 1', label: 'lint' }], { allowFailure: true }),
        job('soft', [{ run: 'exit 4', label: 'soft check', allowFailure: true }, { run: 'echo after soft' }]),
        job('test', [{ run: 'echo tests' }]),
      ],
    }, { transferRoot });

    assert.deepEqual(report.jobs.map((j) => j.status), ['failed', 'passed', 'passed']);
    assert.equal(report.jobs[1].steps[0].status, 'allowed-failure');
    assert.equal(report.ok, true);
    assert.equal(report.kept, false, 'keepCan never destroys the can even when the run failed');
  });

  test('keepCan always keeps a passing can', async () => {
    const report = await runCi(registry, { keepCan: 'always', jobs: [job('a', [{ run: 'true' }])] }, { transferRoot });
    assert.equal(report.ok, true);
    assert.equal(report.kept, true);
    await manager.destroy(report.canName);
  });

  test('a step that runs past its timeout fails as timed out', async () => {
    const report = await runCi(registry, {
      keepCan: 'never',
      jobs: [job('slow', [{ run: 'node -e "setTimeout(() => {}, 60000)"', label: 'sleepy', timeoutMs: 1000 }])],
    }, { transferRoot });
    const step = report.jobs[0].steps[0];
    assert.equal(report.ok, false);
    assert.equal(step.timedOut, true);
    assert.equal(step.status, 'failed');
    assert.match(describeCi(report), /\(timed out\)/);
  });

  test('a failed environment setup gives a report with no can left behind', async () => {
    const report = await runCi(registry, {
      name: 'broken-setup',
      environment: { setup: [{ command: 'exit 7', label: 'install' }] },
      jobs: [job('test', [{ run: 'true' }])],
    }, { transferRoot });
    assert.equal(report.ok, false);
    assert.equal(report.setupFailed, true);
    assert.match(report.error, /setup step "install" exited with code 7/);
    assert.equal(manager.get(report.canName), undefined);
    assert.match(describeCi(report), /^CI "broken-setup" failed: the environment could not be set up/);
  });

  test('an artifact outside the transfer root fails the run, and the can is kept', async () => {
    const report = await runCi(registry, {
      jobs: [job('a', [{ run: 'mkdir -p /app && echo x > /app/x.txt', label: 'make' }])],
      artifacts: [{ canPath: '/app/x.txt', hostPath: '../escape.txt' }],
    }, { transferRoot });
    assert.equal(report.ok, false);
    assert.equal(report.kept, true);
    assert.match(report.artifacts[0].error, /outside the transfer root|must stay|EPERM/);
    assert.equal(fs.existsSync(path.join(tmp, 'escape.txt')), false);
    await manager.destroy(report.canName);
  });

  test('the report text names each job and step, and shows the output of a failing step', () => {
    const text = describeCi({
      ok: false, name: 'demo', canName: 'ci-x', kept: true, seconds: 1.5,
      jobs: [
        { name: 'lint', status: 'failed', allowFailure: true, steps: [{ label: 'eslint', status: 'failed', exitCode: 1, seconds: 0.4, timedOut: false, output: 'a problem\n' }] },
        { name: 'test', status: 'skipped', allowFailure: false, steps: [] },
      ],
      artifacts: [{ canPath: '/app/dist', error: 'nope' }],
    });
    assert.match(text, /^CI "demo" failed in 1.5s \(can ci-x\)/);
    assert.match(text, /job lint: failed \(allowed to fail\)/);
    assert.match(text, /failed\s+eslint exit 1 in 0.4s/);
    assert.match(text, /\| a problem/);
    assert.match(text, /job test: skipped/);
    assert.match(text, /artifact \/app\/dist: nope/);
    assert.match(text, /kept can "ci-x"/);
  });
});
