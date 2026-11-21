// CI: a pipeline run inside a can. The pipeline is checked in full first, then run in one fresh can: its environment
// (see src/environment.js) is applied, then the jobs run in order. Each step is a shell line run in the start folder.
// Jobs share the can, so a later job sees what an earlier one left behind. The result says which jobs and steps
// passed, failed or were skipped, with the output of each failing step. Artifacts are exported only when the whole
// pipeline passed.
//
//   ci: {
//     name:        "my-app"                                 optional, for the report
//     keepCan:     "on-failure" | "always" | "never"        default "on-failure": a failed run's can stays for inspection
//     environment: { ...see src/environment.js }            optional: env, workdir, node, network, imports, files, setup
//     jobs: [{
//       name:         "test",                                unique within the pipeline
//       allowFailure: false,                                 true: a failure here does not stop the later jobs
//       steps: [{
//         run:          "npm test",                          a shell line
//         label?:       "unit tests",
//         cwd?:         "/app/packages/x",                   absolute path inside the can (default: the start folder)
//         env?:         { NAME: "value" },                   extra variables for this step
//         timeoutMs?:   300000,                              1 to 600000
//         allowFailure?: false                               true: a failure here does not fail the job
//       }]
//     }],
//     artifacts?: [{ canPath: "/app/dist", hostPath: "build/dist", overwrite?: false }]
//   }
//
// A step passes with exit code 0. A step that times out fails. Nothing on the host is touched except artifact export,
// which writes under the transfer root with the rules of can_export (src/transfer.js).
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { KernelError } from './kernel/errors.js';
import { normalizeEnvironment } from './environment.js';
import { exportFromCan } from './transfer.js';

export const CI_LIMITS = Object.freeze({
  jobs: 20,
  stepsPerJob: 50,
  artifacts: 10,
  stepTimeoutMs: 600_000,
  defaultStepTimeoutMs: 300_000,
  outputTailBytes: 2048,
  keepCan: ['on-failure', 'always', 'never'],
});

const TOP_KEYS = ['name', 'keepCan', 'environment', 'jobs', 'artifacts'];
const JOB_KEYS = ['name', 'allowFailure', 'steps'];
const STEP_KEYS = ['run', 'label', 'cwd', 'env', 'timeoutMs', 'allowFailure'];
const ARTIFACT_KEYS = ['canPath', 'hostPath', 'overwrite'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const invalid = (msg) => new KernelError('EINVAL', `EINVAL: ${msg}`);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkKeys(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw invalid(`unknown ${where} setting "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

function checkList(value, name, max) {
  if (!Array.isArray(value)) throw invalid(`${name} must be a list`);
  if (value.length === 0) throw invalid(`${name} must have at least one entry`);
  if (value.length > max) throw invalid(`${name} takes at most ${max} entries (got ${value.length})`);
  return value;
}

function checkCanPath(value, where) {
  if (typeof value !== 'string' || !value.startsWith('/')) throw invalid(`${where} needs an absolute path inside the can, such as /app`);
  if (value.split('/').includes('..')) throw invalid(`${where} must not contain ".."`);
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function checkTimeout(value, where) {
  const ms = value ?? CI_LIMITS.defaultStepTimeoutMs;
  if (!Number.isInteger(ms) || ms < 1 || ms > CI_LIMITS.stepTimeoutMs) {
    throw invalid(`${where}.timeoutMs must be a whole number of milliseconds from 1 to ${CI_LIMITS.stepTimeoutMs}`);
  }
  return ms;
}

/**
 * Checks a pipeline and returns its normalized form. Pure: nothing is created or read on the host. Throws EINVAL
 * with the first problem found. The environment is checked with the same rules as can_create.
 */
export function normalizeCi(spec) {
  if (!isPlainObject(spec)) throw invalid('ci must be an object with jobs');
  checkKeys(spec, TOP_KEYS, 'ci');

  const name = spec.name === undefined ? null : String(spec.name).slice(0, 80);
  const keepCan = spec.keepCan ?? 'on-failure';
  if (!CI_LIMITS.keepCan.includes(keepCan)) throw invalid(`ci.keepCan must be one of ${CI_LIMITS.keepCan.join(', ')}`);

  // Checked here so a bad environment costs nothing; the raw spec is what the registry receives, since it has its own normalized form.
  if (spec.environment !== undefined) normalizeEnvironment(spec.environment);

  const jobNames = new Set();
  const jobs = checkList(spec.jobs, 'ci.jobs', CI_LIMITS.jobs).map((job, j) => {
    if (!isPlainObject(job)) throw invalid(`jobs[${j}] must be an object with a name and steps`);
    checkKeys(job, JOB_KEYS, `jobs[${j}]`);
    if (typeof job.name !== 'string' || job.name.trim() === '') throw invalid(`jobs[${j}] needs a name`);
    if (job.name.length > 80) throw invalid(`jobs[${j}].name is longer than 80 characters`);
    if (jobNames.has(job.name)) throw invalid(`job name "${job.name}" is used twice`);
    jobNames.add(job.name);
    if (job.allowFailure !== undefined && typeof job.allowFailure !== 'boolean') throw invalid(`jobs[${j}].allowFailure must be true or false`);

    const steps = checkList(job.steps, `jobs[${j}].steps`, CI_LIMITS.stepsPerJob).map((step, s) => {
      const where = `jobs[${j}].steps[${s}]`;
      if (!isPlainObject(step)) throw invalid(`${where} must be an object with a run line`);
      checkKeys(step, STEP_KEYS, where);
      if (typeof step.run !== 'string' || step.run.trim() === '') throw invalid(`${where} needs a non-empty run line`);
      if (step.run.length > 4096) throw invalid(`${where}.run is longer than 4096 characters`);
      if (step.allowFailure !== undefined && typeof step.allowFailure !== 'boolean') throw invalid(`${where}.allowFailure must be true or false`);
      const env = {};
      if (step.env !== undefined) {
        if (!isPlainObject(step.env)) throw invalid(`${where}.env must be an object of name: value strings`);
        for (const [key, value] of Object.entries(step.env)) {
          if (!ENV_NAME.test(key)) throw invalid(`${where}.env name "${key}" must be letters, digits and "_"`);
          if (typeof value !== 'string') throw invalid(`${where}.env.${key} must be a string`);
          env[key] = value;
        }
      }
      return {
        run: step.run,
        label: typeof step.label === 'string' && step.label !== '' ? step.label.slice(0, 80) : step.run.slice(0, 80),
        cwd: step.cwd === undefined ? null : checkCanPath(step.cwd, `${where}.cwd`),
        env,
        timeoutMs: checkTimeout(step.timeoutMs, where),
        allowFailure: step.allowFailure === true,
      };
    });
    return { name: job.name, allowFailure: job.allowFailure === true, steps };
  });

  const artifacts = (spec.artifacts === undefined ? [] : checkList(spec.artifacts, 'ci.artifacts', CI_LIMITS.artifacts))
    .map((item, i) => {
      if (!isPlainObject(item)) throw invalid(`artifacts[${i}] must be {canPath, hostPath}`);
      checkKeys(item, ARTIFACT_KEYS, `artifacts[${i}]`);
      if (typeof item.hostPath !== 'string' || item.hostPath === '') throw invalid(`artifacts[${i}] needs a hostPath relative to the transfer root`);
      return {
        canPath: checkCanPath(item.canPath, `artifacts[${i}].canPath`),
        hostPath: item.hostPath,
        overwrite: item.overwrite === true,
      };
    });

  return { name, keepCan, environment: spec.environment, jobs, artifacts };
}

const tailOf = (text) => {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= CI_LIMITS.outputTailBytes) return text;
  return `...${buf.subarray(buf.length - CI_LIMITS.outputTailBytes).toString('utf8')}`;
};

/** Runs one step. A timeout counts as a failure, and so does any nonzero exit code. */
async function runStep(can, step, workdir) {
  const started = Date.now();
  const r = await can.exec(step.run, {
    cwd: step.cwd ?? workdir,
    env: step.env,
    timeout: step.timeoutMs,
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const timedOut = r.timedOut === true;
  const passed = !timedOut && r.exitCode === 0;
  const out = {
    label: step.label,
    run: step.run,
    exitCode: r.exitCode,
    timedOut,
    seconds,
    allowFailure: step.allowFailure,
    status: passed ? 'passed' : step.allowFailure ? 'allowed-failure' : 'failed',
  };
  if (!passed) out.output = tailOf(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return out;
}

/**
 * Runs a pipeline in a new can from `registry` (a CanRegistry). Returns the report:
 *   { ok, name, kept, canName, seconds, jobs: [{name, status, allowFailure, steps: [...]}], artifacts: [...], error? }
 * ok is false when a job that does not allow failure fails, when an artifact cannot be exported, or when the
 * environment cannot be set up (then `error` says why and no can exists).
 */
export async function runCi(registry, rawSpec, { transferRoot, canName } = {}) {
  const ci = normalizeCi(rawSpec);
  const started = Date.now();
  const name = canName ?? `ci-${randomBytes(4).toString('hex')}`;
  const report = {
    ok: false, name: ci.name, canName: name, kept: false, seconds: 0, jobs: [], artifacts: [],
  };

  let can;
  try {
    can = await registry.create(name, { environment: ci.environment });
  } catch (err) {
    report.setupFailed = true;
    report.error = `the environment could not be set up: ${err.message}`;
    report.seconds = Math.round((Date.now() - started) / 100) / 10;
    return report;
  }

  const workdir = can.report?.workdir ?? '/home/agent';
  let blocked = false;
  let ok = true;
  try {
    for (const job of ci.jobs) {
      if (blocked) {
        report.jobs.push({ name: job.name, status: 'skipped', allowFailure: job.allowFailure, steps: [] });
        continue;
      }
      const steps = [];
      let jobFailed = false;
      for (const step of job.steps) {
        if (jobFailed) {
          steps.push({ label: step.label, run: step.run, status: 'skipped', allowFailure: step.allowFailure });
          continue;
        }
        const result = await runStep(can, step, workdir);
        steps.push(result);
        if (result.status === 'failed') jobFailed = true;
      }
      const status = jobFailed ? 'failed' : 'passed';
      report.jobs.push({ name: job.name, status, allowFailure: job.allowFailure, steps });
      if (jobFailed && !job.allowFailure) {
        blocked = true;
        ok = false;
      }
    }

    if (ok) {
      for (const a of ci.artifacts) {
        try {
          const r = await exportFromCan(can, a.canPath, a.hostPath, { overwrite: a.overwrite, root: transferRoot });
          report.artifacts.push({ canPath: r.canPath, hostPath: r.hostPath, files: r.files, bytes: r.bytes });
        } catch (err) {
          report.artifacts.push({ canPath: a.canPath, hostPath: a.hostPath, error: err.message });
          ok = false;
        }
      }
    }
  } catch (err) {
    // The VM went away mid-run (a crash or a destroyed can). The report says so; the can is kept if it still exists.
    ok = false;
    report.error = `the run stopped: ${err.message}`;
  } finally {
    report.ok = ok;
    const keep = ci.keepCan === 'always' || (ci.keepCan === 'on-failure' && !ok);
    if (keep) {
      try {
        await registry.save(name);
        report.kept = true;
      } catch {
        report.kept = false;
      }
    } else {
      await registry.destroy(name).catch(() => {});
    }
    report.seconds = Math.round((Date.now() - started) / 100) / 10;
  }
  return report;
}

/** The text an agent or a terminal reads: one line per job, one per step, and the output of each failing step. */
export function describeCi(report) {
  const lines = [];
  const title = report.name ? `"${report.name}"` : 'pipeline';
  if (report.setupFailed) {
    lines.push(`CI ${title} failed: ${report.error}`);
    return lines.join('\n');
  }
  lines.push(`CI ${title} ${report.ok ? 'passed' : 'failed'} in ${report.seconds}s (can ${report.canName})`);
  if (report.error) lines.push(report.error);
  for (const job of report.jobs) {
    lines.push(`job ${job.name}: ${job.status}${job.allowFailure && job.status === 'failed' ? ' (allowed to fail)' : ''}`);
    for (const step of job.steps) {
      const detail = step.status === 'skipped'
        ? ''
        : ` exit ${step.exitCode}${step.timedOut ? ' (timed out)' : ''} in ${step.seconds}s`;
      lines.push(`  ${step.status.padEnd(16)} ${step.label}${detail}`);
      if (step.output !== undefined && step.output !== '') {
        lines.push(...step.output.trimEnd().split('\n').map((l) => `      | ${l}`));
      }
    }
  }
  for (const a of report.artifacts) {
    lines.push(a.error ? `artifact ${a.canPath}: ${a.error}` : `artifact ${a.canPath} -> ${a.hostPath} (${a.files} file(s), ${a.bytes} bytes)`);
  }
  if (report.kept) lines.push(`kept can "${report.canName}" for inspection (can_exec, can_logs, can_read_file); destroy it when done`);
  return lines.join('\n');
}
