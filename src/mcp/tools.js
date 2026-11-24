// Agent-facing tools. Each tool resolves a can through CanRegistry, makes one or two calls on it and
// returns plain text. A thrown error becomes an isError result in server.js.
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { KernelError } from '../kernel/errors.js';
import { listMounts } from '../mounts.js';
import { defaultTransferRoot, exportFromCan, importToCan, LIMITS, writeTransferFile } from '../transfer.js';
import { pngSize } from '../browser/png.js';
import { RENDER_LIMITS } from '../browser/render.js';
import { describeReport, LIMITS as ENV_LIMITS, shellQuote } from '../environment.js';
import { CI_LIMITS, describeCi, pipelineLine, runCi } from '../ci.js';
import { describeArgs, Recorder, summarizeResult } from '../recording.js';

/** The environment argument of can_create (checked again by src/environment.js, which is the authority). */
export const ENVIRONMENT_SCHEMA = {
  type: 'object',
  description: 'Set the can up before it starts. Everything is checked first. Steps run in this order: requireTools, '
    + 'workdir, imports, files, setup. The first failing step discards the can.',
  properties: {
    env: {
      type: 'object',
      description: 'Environment variables, name: value. Names are letters, digits and "_".',
      additionalProperties: { type: 'string' },
    },
    workdir: { type: 'string', description: 'Start folder in the can, such as /app. Created if missing; setup runs here.' },
    node: {
      type: 'string',
      description: 'Node version the can reports as process.version, such as "24" or "24.15.0". The can runs the same '
        + 'engine either way, so this changes what the app sees, not what the engine supports.',
    },
    network: {
      type: 'object',
      description: 'Network policy. Default: internet on, registry https://registry.npmjs.org/.',
      properties: {
        internet: { type: 'boolean', description: 'False blocks npm, curl and the browser from reaching the internet.' },
        registry: { type: 'string', description: 'The npm registry to install packages from (http or https URL).' },
      },
      additionalProperties: false,
    },
    imports: {
      type: 'array',
      description: `Host files or folders copied into the can before it starts (up to ${ENV_LIMITS.imports}). `
        + 'exclude names entries to leave out at any depth, such as node_modules, .git, target or *.log.',
      items: {
        type: 'object',
        properties: {
          hostPath: { type: 'string', minLength: 1, description: 'Host file or folder, absolute.' },
          canPath: { type: 'string', minLength: 1, description: 'Destination in the can, absolute, such as /app.' },
          exclude: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Names to leave out.' },
          overwrite: { type: 'boolean', description: 'Replace files that already exist in the can. Default false.' },
        },
        required: ['hostPath', 'canPath'],
        additionalProperties: false,
      },
    },
    files: {
      type: 'array',
      description: `Files to write before the can starts (up to ${ENV_LIMITS.files}).`,
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: 'Absolute path in the can, such as /app/.npmrc.' },
          content: { type: 'string', description: 'File content.' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default utf8.' },
          overwrite: { type: 'boolean', description: 'Default true.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    tools: {
      type: 'object',
      description: 'Toolchains the can is built with, as name: version, such as {"python": "3.15"} (a prefix matches the newest '
        + 'patch release). Resolved from the local toolchain cache when the can is created, and never downloaded: if one is '
        + 'not installed, creation fails with the command that installs it. can_status shows the resolved version and sha256.',
      additionalProperties: { type: 'string', minLength: 1 },
    },
    requireTools: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Commands that must exist in the can, such as ["npm", "pnpm"]. Creation fails with a clear message if one is missing.',
    },
    pip: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Lock lines, such as "requests==2.32.3 --hash=sha256:<hex>" (as can_install prints them), installed with pip '
        + 'during setup, before the setup commands. Pure-Python packages only.',
    },
    setup: {
      type: 'array',
      description: `Commands run in order in the start folder, after everything else (up to ${ENV_LIMITS.setup}). `
        + 'A failing step (unless optional) discards the can and returns its output.',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string', minLength: 1, description: 'A shell line, such as "npm install".' },
          timeoutMs: { type: 'integer', minimum: 1, maximum: ENV_LIMITS.setupTimeoutMs, description: 'Default 300000.' },
          optional: { type: 'boolean', description: 'A failure is reported but does not discard the can.' },
          label: { type: 'string', maxLength: 80, description: 'Shown in the summary.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export const OUTPUT_LIMIT = 20 * 1024;
// computer_action wait: the longest pause a single call may take (src/canchromium.js enforces the same limit).
const WAIT_MAX_MS = 10_000;
// Screenshots larger than this are written to the can but not sent inline as an image block.
export const INLINE_IMAGE_LIMIT = 1024 * 1024;
const ENCODINGS = ['utf8', 'base64'];
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strict base64 decode. Whitespace is ignored. Anything else must be canonical base64: a length that is a multiple
 * of 4, padding only at the end, and the same text back when the bytes are re-encoded (so 'QR==' is refused, since
 * 'QQ==' is the canonical form of that byte). The size is checked on the encoded length before decoding, and
 * again on the decoded bytes, because the padding can make a valid encoding decode to a few bytes more.
 */
export function decodeBase64(text, maxBytes = LIMITS.maxFileBytes) {
  if (typeof text !== 'string') throw new KernelError('EINVAL', 'EINVAL: content must be a string');
  const clean = text.replace(/\s+/g, '');
  const maxChars = Math.ceil(maxBytes / 3) * 4;
  if (clean.length > maxChars) {
    throw new KernelError('EFBIG', `EFBIG: base64 content is ${clean.length} characters; the limit is ${maxChars} characters (${maxBytes} bytes)`);
  }
  const invalid = () => new KernelError('EINVAL', 'EINVAL: content is not valid base64 (use encoding "utf8" for text)');
  if (clean.length % 4 !== 0 || !BASE64_PATTERN.test(clean)) throw invalid();
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.toString('base64') !== clean) throw invalid();
  if (bytes.length > maxBytes) throw new KernelError('EFBIG', `EFBIG: base64 content decodes to ${bytes.length} bytes; the limit is ${maxBytes} bytes`);
  return bytes;
}
const EXEC_TIMEOUT_DEFAULT_MS = 60_000;
const EXEC_TIMEOUT_MAX_MS = 600_000;
const LOG_TAIL_DEFAULT = 100;
const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'];
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** Keeps about `limit` bytes of text, the head and the tail, and says how much was dropped. */
export function capText(text, limit = OUTPUT_LIMIT) {
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length <= limit) return buf.toString('utf8');
  const half = Math.floor(limit / 2);
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(buf.length - half).toString('utf8');
  const omitted = buf.length - 2 * half;
  return `${head}\n...[${omitted} bytes omitted; output is capped at ${limit} bytes]...\n${tail}`;
}

const block = (text) => (text === '' || text === undefined ? '(empty)' : capText(text));

const MB = 1024 * 1024;
const INSTALL_TIMEOUT_MS = 300_000;
const INSTALL_PACKAGES_MAX = 50;
// A lock line as pip prints it: name==version --hash=sha256:<hex>.
const LOCK_LINE = /^[A-Za-z0-9][A-Za-z0-9._-]*==[A-Za-z0-9.!+_-]+ --hash=sha256:[0-9a-f]{64}$/;
// The state names can_status shows (interface I6): running is "ready".
const STATE_LABEL = { running: 'ready', crashed: 'crashed', exited: 'stopped', 'memory-limit': 'memory-limit' };
const MB_LIMIT = 700;
const MB_SOFT = 630;

/** The lines of an installer's output that carry its own CODE: ... Next: ... error, if it printed any. */
function installerError(text) {
  const found = text.split('\n').map((l) => l.trim()).filter((l) => /^[A-Z]{3,}: .*Next: /.test(l));
  return found.length ? found[found.length - 1] : null;
}

/** Package name from a spec such as "lodash", "lodash@4.17.21" or "@scope/pkg@^1". */
function npmPackageName(spec) {
  const m = /^(@[^/]+\/[^@]+|[^@]+)(?:@.*)?$/.exec(spec);
  return m ? m[1] : spec;
}

/** Trailing undefined arguments are dropped, so the VM sees them as absent, not as null. */
const args = (...xs) => {
  const out = [...xs];
  while (out.length && out[out.length - 1] === undefined) out.pop();
  return out;
};

function formatProcess(v) {
  const state = v.status === 'running' ? 'running' : `exited (code ${v.exitCode}${v.signal ? `, signal ${v.signal}` : ''})`;
  return `pid ${v.pid}: ${state}  cwd=${v.cwd}  command=${v.command}`;
}

/**
 * Builds the tool list. `registry` is a CanRegistry (see registry.js).
 * Each tool: {name, description, inputSchema, run(args) -> string}.
 * `transferRoot` is where can_export may write (default: $CAN_TRANSFER_DIR or %USERPROFILE%\.can\transfer).
 */
/**
 * The MCP tools. `browsers` (a ChromiumBrowsers, see src/canchromium.js) replaces each can's built-in browser with a
 * real Chrome or Edge when the user has enabled it; otherwise the browser tools use the can's own browser.
 */
export function createTools(registry, { transferRoot = defaultTransferRoot(), browsers = null, recorder = null } = {}) {
  const browserFor = (can) => (browsers ? browsers.for(can) : can);
  const rec = recorder ?? new Recorder({ transferRoot });
  // Films the can's browser after an action that may have changed the page. Does nothing unless a recording runs.
  const recordFrame = (can) => rec.frame(can.id, (size) => browserFor(can).screenshot(size));
  // While a recording runs on a can, every call on it goes into the timeline (see src/recording.js).
  const TIMELINE_SKIP = new Set(['can_record_start', 'can_record_stop']);
  const withTimeline = (t) => {
    if (TIMELINE_SKIP.has(t.name)) return t;
    return {
      ...t,
      run: async (a) => {
        const session = rec.sessionFor(a?.can);
        if (!session) return t.run(a);
        const began = rec.elapsed(session.canId);
        const call = `${t.name} ${describeArgs(a)}`;
        try {
          const out = await t.run(a);
          // The result of browser_type echoes the typed text, so it is not logged.
          const shown = t.name === 'browser_type' ? 'ok (typed text not logged)' : summarizeResult(out);
          rec.event(session.canId, began, `${call} -> ${shown}`);
          return out;
        } catch (err) {
          rec.event(session.canId, began, `${call} -> ERROR ${err.message}`);
          throw err;
        }
      },
    };
  };
  const canProp = {
    type: 'string',
    minLength: 1,
    description: 'Can name or id, as shown by can_list. A saved can is loaded automatically.',
  };
  const pidProp = { type: 'integer', minimum: 1, description: 'Process id, as returned by can_spawn or can_ps.' };
  const pathProp = (description) => ({ type: 'string', minLength: 1, description });
  const cwdProp = { type: 'string', description: 'Working directory inside the can. Default: /home/agent.' };
  const targetProp = (description) => ({ type: 'string', minLength: 1, description });
  const urlProp = { type: 'string', minLength: 1, description: 'URL. http://localhost:<port>/ reaches a server inside the can.' };
  const encodingProp = {
    type: 'string',
    enum: ENCODINGS,
    description: 'utf8 (default) for text. base64 for binary: content and the result are base64 text.',
  };
  const overwriteProp = { type: 'boolean', description: 'Replace existing files. Default false.' };

  // additionalProperties: false, so an unknown argument (a typo such as overWrite) is rejected by the server, not ignored.
  const tool = (name, description, properties, required, run) => ({
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    run,
  });

  const snapshotOf = async (can) => capText(await browserFor(can).browse('snapshot'));

  // Auto-save (interface I6): a call that changes a can saves it to disk before its result returns. A can that is not
  // running has nothing new to save. A failed save is reported in the result, not hidden.
  const autosave = async (can) => {
    if (can.status !== 'running') return '';
    try {
      await registry.save(can.id);
      return '';
    } catch (err) {
      return `\nauto-save failed: ${err.message}`;
    }
  };

  // can_status: what a can is, from its live VM (or from its save, without booting it, when it is only on disk).
  const statusText = async (ref) => {
    const live = registry.manager.get(ref);
    const saved = live ? null : registry.saved().find((s) => s.id === ref || s.name === ref);
    if (!live && !saved) throw new KernelError('ENOENT', `ENOENT: no can "${ref}". Next: call can_list to see the cans, or can_create to make one.`);
    const name = live ? live.name : saved.name;
    const id = live ? live.id : saved.id;
    const state = live ? STATE_LABEL[live.status] ?? 'stopped' : 'saved';
    const lines = [`can "${name}" (id ${id})`, `state: ${state}${live ? '' : ' (on disk; it loads on first use, or call can_restart)'}`];

    let memory = 'unavailable';
    try {
      const m = live && typeof live.memoryInfo === 'function' ? await live.memoryInfo() : null;
      if (m) {
        memory = `${(m.usedBytes / MB).toFixed(1)} MB used, peak ${(m.peakBytes / MB).toFixed(1)} MB, `
          + `limit ${MB_LIMIT} MB (soft ${MB_SOFT} MB), enforced by ${m.enforced}`;
      }
    } catch {
      memory = 'unavailable';
    }
    lines.push(`memory: ${live ? memory : 'not loaded (no VM)'}`);

    const toolchains = live ? live.toolchains ?? [] : saved.tools ?? [];
    if (toolchains.length === 0) {
      lines.push('tools: none declared in environment.tools');
    } else {
      lines.push('tools:');
      for (const t of toolchains) lines.push(`  ${t.name} ${t.version} sha256 ${t.sha256 ?? 'unknown'}`);
    }

    if (live && live.status === 'running') {
      const procs = await live.ps();
      lines.push(procs.length ? `processes:\n${procs.map((p) => `  ${formatProcess(p)}`).join('\n')}` : 'processes: none');
      const ports = await live.listeners();
      lines.push(ports.length
        ? `ports:\n${ports.map((l) => `  port ${l.port} (listening since ${new Date(l.createdAt).toISOString()})`).join('\n')}`
        : 'ports: none');
    } else {
      lines.push('processes: none (the can is not running)');
      lines.push('ports: none (the can is not running)');
    }

    lines.push(`startup sweep: removed ${registry.swept ?? 0} leftover file(s) from the store when this server started`);

    let last = live ? registry.lastError(live.id) : null;
    if (live && live.status === 'crashed') {
      last = `EIO: the can's VM process exited unexpectedly. Next: call can_restart to start it from its last save.`;
    } else if (live && live.status === 'memory-limit') {
      last = `ENOMEM: can "${name}" used more than its ${MB_LIMIT} MB memory limit and was stopped. Its files from the last save are kept. `
        + 'Next: call can_restart, then do less at once or split the work across cans.';
    }
    lines.push(`last error: ${last ?? 'none'}`);
    if (live && live.status !== 'running' && !last) lines.push('Next: call can_restart to start it again from its last save.');
    return lines.join('\n');
  };

  const list = [
    // ---------------------------------------------------------------- cans
    tool(
      'can_create',
      'Create a new virtual machine (a "can") with its own filesystem, processes, network ports and browser. ' +
        'The can is saved to disk right away. Returns its name and id. Optionally mounts host folders the user ' +
        'has listed (see can_mounts): they are read-only inside the can, and they show their current contents. ' +
        'Pass environment to set the can up before it starts: environment variables, a start folder, network ' +
        'access, host files or folders to copy in (with excludes, such as node_modules), files to write, toolchains ' +
        '(tools, such as {"python": "3.15"}, from the local cache; never downloaded), pip lock lines, commands ' +
        'that must exist, and setup commands such as npm install. If a step fails, the can is not created and nothing ' +
        'is left behind. Calling again with the same name and the same environment is safe: it reuses the can ' +
        '(a can that is not running is reported, and can_restart starts it again). A different environment under the ' +
        'same name is EEXIST. A can that crashed or hit its memory limit is started again with can_restart.',
      {
        name: { type: 'string', description: 'Optional name (letters, digits, "_", "-", "."). Default: can-N.' },
        mounts: {
          type: 'array',
          description: 'Host folders to mount read-only, by label from can_mounts. Default: none.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', minLength: 1, description: 'A label from can_mounts.' },
              canPath: { type: 'string', minLength: 1, description: 'Where the folder appears in the can, such as /data.' },
            },
            required: ['label', 'canPath'],
            additionalProperties: false,
          },
        },
        environment: ENVIRONMENT_SCHEMA,
      },
      [],
      async (a) => {
        const r = await registry.ensure(a.name, { mounts: a.mounts ?? [], environment: a.environment });
        if (r.reused) {
          if (r.state === 'running') return `can "${a.name}" already exists with the same spec; reused (id ${r.id}, state ready).`;
          return `can "${a.name}" already exists with the same spec; not running (state: ${r.state}). `
            + 'Next: call can_restart to start it from its last save.';
        }
        const { can } = r;
        const mounted = (a.mounts ?? []).map((m) => `${m.label} at ${m.canPath}`);
        const note = mounted.length ? ` Mounted read-only: ${mounted.join(', ')}.` : '';
        const setup = can.report ? `\n${describeReport(can.report)}` : '';
        return `created can "${can.name}" (id ${can.id}).${note}${setup}\nRun commands with can_exec.`;
      },
    ),

    tool(
      'can_ci',
      'Run a CI pipeline in a fresh can and report what passed. The environment is set up first (the same as ' +
        'can_create: imports, files, setup commands), then the jobs run in order, each step as a shell line in the ' +
        'start folder. Jobs share the can, so a later job sees what an earlier one left. A step fails on a nonzero ' +
        'exit code or a timeout; the report gives each job and step, and the output of each failing step. Artifacts ' +
        'are exported under the transfer root only when everything passed. A failed run keeps its can by default, ' +
        'so it can be inspected with can_exec, can_logs and can_read_file; keepCan changes that. Pipelines are checked ' +
        'in full before anything runs.',
      {
        ci: {
          type: 'object',
          description: 'The pipeline. Jobs are listed in the order they run.',
          properties: {
            name: { type: 'string', description: 'Optional name for the report.' },
            keepCan: {
              type: 'string',
              enum: ['on-failure', 'always', 'never'],
              description: 'Keep the can after the run. Default on-failure: a failed run keeps its can.',
            },
            environment: ENVIRONMENT_SCHEMA,
            jobs: {
              type: 'array',
              minItems: 1,
              maxItems: CI_LIMITS.jobs,
              description: `Jobs, run in order (up to ${CI_LIMITS.jobs}).`,
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 1, description: 'Unique job name, such as "test".' },
                  allowFailure: { type: 'boolean', description: 'True: a failure here does not stop the later jobs.' },
                  steps: {
                    type: 'array',
                    minItems: 1,
                    maxItems: CI_LIMITS.stepsPerJob,
                    items: {
                      type: 'object',
                      properties: {
                        run: { type: 'string', minLength: 1, description: 'A shell line, such as "npm test".' },
                        label: { type: 'string', description: 'Short name shown in the report.' },
                        cwd: { type: 'string', description: 'Absolute folder inside the can. Default: the start folder.' },
                        env: {
                          type: 'object',
                          description: 'Extra environment variables for this step.',
                          additionalProperties: { type: 'string' },
                        },
                        timeoutMs: {
                          type: 'integer',
                          minimum: 1,
                          maximum: CI_LIMITS.stepTimeoutMs,
                          description: `Step time limit in milliseconds (default ${CI_LIMITS.defaultStepTimeoutMs}).`,
                        },
                        allowFailure: { type: 'boolean', description: 'True: a failure here does not fail the job.' },
                      },
                      required: ['run'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['name', 'steps'],
                additionalProperties: false,
              },
            },
            artifacts: {
              type: 'array',
              maxItems: CI_LIMITS.artifacts,
              description: 'Folders or files from the can to export after a passing run.',
              items: {
                type: 'object',
                properties: {
                  canPath: { type: 'string', minLength: 1, description: 'Path inside the can, such as /app/dist.' },
                  hostPath: { type: 'string', minLength: 1, description: 'Destination relative to the transfer root.' },
                  overwrite: { type: 'boolean', description: 'Replace existing files. Default false.' },
                },
                required: ['canPath', 'hostPath'],
                additionalProperties: false,
              },
            },
          },
          required: ['jobs'],
          additionalProperties: false,
        },
      },
      ['ci'],
      async (a) => {
        const report = await runCi(registry, a.ci, { transferRoot });
        // The first line is the verdict (interface I6). A setup failure means no pipeline ran: an error result.
        const text = `${pipelineLine(report)}\n${describeCi(report)}`;
        if (report.setupFailed) throw new Error(text);
        return text;
      },
    ),

    tool(
      'can_mounts',
      'List the host folders the user has made available to cans, as labels with descriptions. ' +
        'Pass a label to can_create to mount it read-only. Host paths are not shown.',
      {},
      [],
      async () => {
        const rows = listMounts(registry.manager.mountsFile);
        if (rows.length === 0) return 'the user has not made any host folders available to cans.';
        return rows.map((r) => `${r.label}${r.description ? `: ${r.description}` : ''}`).join('\n');
      },
    ),

    tool(
      'can_list',
      'List cans. Status is "running" (loaded in this server), "crashed", or "saved" (on disk, loads on first use).',
      {},
      [],
      async () => {
        const rows = registry.list();
        if (rows.length === 0) return 'no cans. Create one with can_create.';
        return rows.map((r) => `- name=${r.name} status=${r.status} id=${r.id}`).join('\n');
      },
    ),

    tool(
      'can_destroy',
      'Stop a can, kill its processes and delete its saved state. This cannot be undone, and the can\'s files are gone '
        + 'for good. Works in any state: ready, crashed, memory-limit, or saved on disk only.',
      { can: canProp },
      ['can'],
      async (a) => {
        // A recording still running is written out first, so destroying a can does not lose its video.
        const running = rec.sessionFor(a.can);
        let saved = '';
        if (running) {
          const r = await rec.stop(running.canId);
          saved = `\nrecording "${r.name}" was saved first: ${r.videoRel ?? 'no video'} and recordings/${r.name}.log.txt`;
        }
        if (browsers) await browsers.close((await registry.get(a.can)).id);
        return `destroyed can "${await registry.destroy(a.can)}"${saved}`;
      },
    ),

    tool(
      'can_save',
      'Save a can\'s current filesystem and environment to disk now. Cans are already saved automatically after every ' +
        'call that changes them (can_exec, can_spawn, can_write_file, can_import, can_kill, can_install and ' +
        'browser_screenshot), so this is only needed to force a save before a risky step. Processes and open ports are ' +
        'not saved. Running cans are also saved when the server shuts down cleanly.',
      { can: canProp },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        const file = await registry.manager.save(can.id, { force: true });
        return `saved can "${can.name}" to ${file}`;
      },
    ),

    tool(
      'can_status',
      'Show one can: its state (ready, crashed, stopped, memory-limit, or saved on disk), its memory use against the ' +
        '700 MB limit, the toolchains it was created with (name, version, sha256), its processes and ports (as can_ps ' +
        'and can_ports list them), the startup sweep count, and the last error with what to do next. A can that is only ' +
        'on disk is described without starting it.',
      { can: canProp },
      ['can'],
      async (a) => statusText(a.can),
    ),

    tool(
      'can_restart',
      'Start a can again from its last save. Use it for a can that crashed, was stopped, or hit its memory limit (see ' +
        'can_status). A ready can is saved first, then stopped and loaded again. Files, environment variables and ' +
        'toolchains come back from the save; processes and open ports do not, and the result says so.',
      { can: canProp },
      ['can'],
      async (a) => {
        const r = await registry.restart(a.can);
        const iso = r.savedAt ? new Date(r.savedAt).toISOString() : 'an unknown time';
        const was = r.was === 'running' ? ' (it was ready: saved first, then stopped and loaded again)' : ` (it was ${STATE_LABEL[r.was] ?? r.was})`;
        return `can "${r.can.name}" restarted${was} from the save made at ${iso}. Processes and ports were not restored.`;
      },
    ),

    tool(
      'can_install',
      'Install packages in a can with its own pip (pure-Python wheels only) or npm, the same as running "pip install" or ' +
        '"npm install" in can_exec. Returns the exact versions that were installed: pip prints lock lines (name==version ' +
        '--hash=sha256:<hex>) that can be pinned later with environment.pip; npm prints name@version and the integrity ' +
        'from package-lock.json. A failed install is an error with the installer\'s own message. Packages are not ' +
        'refused: any install the can\'s network policy allows runs.',
      {
        can: canProp,
        manager: { type: 'string', enum: ['pip', 'npm'], description: 'pip or npm.' },
        packages: {
          type: 'array',
          minItems: 1,
          maxItems: INSTALL_PACKAGES_MAX,
          items: { type: 'string', minLength: 1, description: 'A package name or spec, such as "requests==2.32.3" or "lodash@4".' },
          description: `Packages to install (1 to ${INSTALL_PACKAGES_MAX}).`,
        },
      },
      ['can', 'manager', 'packages'],
      async (a) => {
        if (a.packages.length < 1 || a.packages.length > INSTALL_PACKAGES_MAX) {
          throw new KernelError('EINVAL', `EINVAL: packages takes 1 to ${INSTALL_PACKAGES_MAX} entries (got ${a.packages.length}). Next: split the list.`);
        }
        if (a.packages.some((p) => /[\r\n]/.test(p))) {
          throw new KernelError('EINVAL', 'EINVAL: a package name must not contain a line break. Next: pass one package per entry.');
        }
        const can = await registry.get(a.can);
        const quoted = a.packages.map(shellQuote).join(' ');
        const command = `${a.manager} install ${quoted}`;
        const r = await can.exec(command, { timeout: INSTALL_TIMEOUT_MS });
        const note = await autosave(can);
        const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
        if (r.timedOut) {
          throw new KernelError('ETIMEDOUT', `ETIMEDOUT: ${a.manager} install did not finish within ${INSTALL_TIMEOUT_MS} ms. Next: install fewer packages at once.`);
        }
        if (r.exitCode !== 0) {
          const own = installerError(output);
          if (own) throw new KernelError('EIO', own);
          throw new KernelError(
            'EIO',
            `EIO: ${a.manager} install exited with code ${r.exitCode}. Next: check the package names and versions. Output:\n${capText(output, 2048)}`,
          );
        }
        if (a.manager === 'pip') {
          const locks = [...new Set(output.split('\n').map((l) => l.trim()).filter((l) => LOCK_LINE.test(l)))];
          const body = locks.length ? locks.join('\n') : 'pip printed no lock lines; run "pip list" in can_exec to see the versions';
          return `installed with pip in can "${can.name}":\n${body}${note}`;
        }
        const cwd = (await can.exec('pwd')).stdout.trim() || '/home/agent';
        const rows = [];
        let lock = null;
        try {
          lock = JSON.parse(String(await can.readFile(path.posix.join(cwd, 'package-lock.json'), 'utf8')));
        } catch {
          lock = null; // no lock file: versions come from node_modules below
        }
        for (const spec of a.packages) {
          const name = npmPackageName(spec);
          const entry = lock?.packages?.[`node_modules/${name}`];
          if (entry?.version) {
            rows.push(`${name}@${entry.version} ${entry.integrity ?? '(no integrity recorded)'}`);
            continue;
          }
          try {
            const pkg = JSON.parse(String(await can.readFile(path.posix.join(cwd, 'node_modules', name, 'package.json'), 'utf8')));
            rows.push(`${name}@${pkg.version} (no integrity recorded)`);
          } catch {
            rows.push(`${name}: installed, version not found`);
          }
        }
        return `installed with npm in can "${can.name}":\n${rows.join('\n')}${note}`;
      },
    ),

    tool(
      'can_record_start',
      'Start recording a QA session on a can. From now on every tool call on this can goes into a timeline log, and ' +
        'each browser action (browser_goto, _click, _type, _select, _submit, _back, _evaluate) films the page into a ' +
        'video. Run the tests as usual, then call can_record_stop. It writes recordings/<name>.mp4 (an animated PNG ' +
        'when ffmpeg is not installed) and recordings/<name>.log.txt under the transfer root. Typed text, file content ' +
        'and headers are not written to the log. One recording per can at a time.',
      {
        can: canProp,
        name: { type: 'string', minLength: 1, description: 'File name of the recording (letters, digits, "_", "-", "."). Default: <can>-<time>.' },
        width: { type: 'integer', minimum: 1, maximum: RENDER_LIMITS.maxWidth, description: 'Viewport width of the video. Default 1280.' },
        height: { type: 'integer', minimum: 1, maximum: RENDER_LIMITS.maxHeight, description: 'Viewport height of the video. Default 800.' },
      },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        const r = rec.start(can, { name: a.name, width: a.width, height: a.height });
        return `recording "${r.name}" started on can "${r.canName}" (${r.width}x${r.height}). ` +
          'Calls on this can are logged, and browser actions are filmed. Call can_record_stop when the QA is done.';
      },
    ),

    tool(
      'can_record_stop',
      'Stop the recording on a can and write it under the transfer root: the video (recordings/<name>.mp4, or .apng ' +
        'without ffmpeg) and the timeline log (recordings/<name>.log.txt). Returns both host paths and the frame count.',
      { can: canProp },
      ['can'],
      async (a) => {
        const session = rec.sessionFor(a.can);
        if (!session) throw new KernelError('ENOENT', `ENOENT: no recording is running on can "${a.can}" (start one with can_record_start)`);
        const r = await rec.stop(session.canId);
        const seconds = (r.durationMs / 1000).toFixed(1);
        const video = r.video ? `video: ${r.video}\n(${r.encoder})` : 'video: none (no browser frames were taken)';
        const note = r.note ? `\n${r.note}` : '';
        return `recording "${r.name}" stopped on can "${r.canName}": ${r.frames} browser frame(s), ${seconds} s.\n` +
          `${video}\nlog: ${r.log}${note}`;
      },
    ),

    // ---------------------------------------------------------------- commands and processes
    tool(
      'can_exec',
      'Run a shell command in the can and wait for it to finish. Supports pipes, &&, ||, redirects (> >> <), ' +
        '$VAR, $(...), globs, NAME=value prefixes, if/then/else, for and while loops, functions and heredocs. ' +
        'Not supported: case, ${VAR#pat} and other parameter expansions, [[ ]], and arrays. ' +
        'Returns the exit code, stdout and stderr (each capped at 20 KB). The can is saved after the command. ' +
        'For a long-running server use can_spawn instead.',
      {
        can: canProp,
        command: { type: 'string', minLength: 1, description: 'The command line, e.g. "node app.js" or "ls -la /app".' },
        cwd: cwdProp,
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: EXEC_TIMEOUT_MAX_MS,
          description: `Kill the command after this many ms. Default ${EXEC_TIMEOUT_DEFAULT_MS}.`,
        },
      },
      ['can', 'command'],
      async (a) => {
        const can = await registry.get(a.can);
        const r = await can.exec(a.command, {
          cwd: a.cwd,
          timeout: a.timeoutMs ?? EXEC_TIMEOUT_DEFAULT_MS,
        });
        const note = r.timedOut ? ' (timed out and was killed)' : r.signal ? ` (signal ${r.signal})` : '';
        const saved = await autosave(can);
        return `exit code: ${r.exitCode}${note}\n--- stdout ---\n${block(r.stdout)}\n--- stderr ---\n${block(r.stderr)}${saved}`;
      },
    ),

    tool(
      'can_spawn',
      'Start a long-running command in the background, e.g. a server: "node server.js". Returns its pid at once. ' +
        'The process runs while this server (or `can shell`) stays alive. Use can_logs to read its output and can_kill to stop it.',
      { can: canProp, command: { type: 'string', minLength: 1, description: 'The command line to run.' }, cwd: cwdProp },
      ['can', 'command'],
      async (a) => {
        const can = await registry.get(a.can);
        const v = await can.spawn(a.command, { cwd: a.cwd, background: true });
        const saved = await autosave(can);
        return `started ${formatProcess(v)}${saved}`;
      },
    ),

    tool(
      'can_ps',
      'List the processes of a can with their pid, status, exit code and command.',
      { can: canProp },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        const list = await can.ps();
        if (list.length === 0) return 'no processes';
        return list.map(formatProcess).join('\n');
      },
    ),

    tool(
      'can_logs',
      'Read the last lines of a process\'s stdout and stderr.',
      {
        can: canProp,
        pid: pidProp,
        tail: { type: 'integer', minimum: 1, maximum: 100000, description: `Lines to return from the end. Default ${LOG_TAIL_DEFAULT}.` },
      },
      ['can', 'pid'],
      async (a) => {
        const can = await registry.get(a.can);
        const lines = (buf) => {
          const all = buf.toString('utf8').split('\n');
          if (all.at(-1) === '') all.pop();
          return all.slice(-(a.tail ?? LOG_TAIL_DEFAULT)).join('\n');
        };
        const out = lines(await can.logs(a.pid, 'stdout'));
        const err = lines(await can.logs(a.pid, 'stderr'));
        return `--- stdout ---\n${block(out)}\n--- stderr ---\n${block(err)}`;
      },
    ),

    tool(
      'can_kill',
      'Send a signal to a process in the can (default SIGTERM).',
      { can: canProp, pid: pidProp, signal: { type: 'string', enum: SIGNALS, description: 'Default SIGTERM.' } },
      ['can', 'pid'],
      async (a) => {
        const can = await registry.get(a.can);
        await can.kill(a.pid, a.signal ?? 'SIGTERM');
        const v = await can.getProcess(a.pid);
        const saved = await autosave(can);
        return `signalled ${v ? formatProcess(v) : `pid ${a.pid}`}${saved}`;
      },
    ),

    // ---------------------------------------------------------------- files
    tool(
      'can_read_file',
      'Read a file from the can. Relative paths start in /home/agent. Text by default (encoding utf8). ' +
        'With encoding base64 the file comes back as base64 text, for binary data. Output is capped at 20 KB; ' +
        'use can_export for larger files.',
      {
        can: canProp,
        path: pathProp('File path inside the can, e.g. /app/server.js.'),
        encoding: encodingProp,
      },
      ['can', 'path'],
      async (a) => {
        const can = await registry.get(a.can);
        if (a.encoding === 'base64') {
          const text = (await can.readFile(a.path)).toString('base64');
          if (text.length > OUTPUT_LIMIT) {
            throw new Error(
              `base64 output of ${a.path} is ${text.length} characters; the limit is ${OUTPUT_LIMIT}. ` +
                'Use can_export to copy the file to the host.',
            );
          }
          return text;
        }
        return block(await can.readFile(a.path, 'utf8'));
      },
    ),

    tool(
      'can_write_file',
      'Create or overwrite a file in the can. Parent directories must exist (use can_exec "mkdir -p"). ' +
        'Text by default (encoding utf8); the text must be well-formed Unicode, so a lone surrogate is an error. ' +
        'With encoding base64, content is strict base64 (canonical padding) and is written as binary bytes; ' +
        'the 256 MB limit is checked on the encoded length before decoding.',
      {
        can: canProp,
        path: pathProp('File path inside the can.'),
        content: { type: 'string', description: 'Full file content: UTF-8 text, or base64 text when encoding is base64.' },
        encoding: encodingProp,
      },
      ['can', 'path', 'content'],
      async (a) => {
        const can = await registry.get(a.can);
        if (a.encoding === 'base64') {
          const bytes = decodeBase64(a.content);
          await can.writeFile(a.path, bytes);
          return `wrote ${bytes.length} bytes to ${a.path}${await autosave(can)}`;
        }
        // UTF-8 cannot hold a lone surrogate; writing it would silently store U+FFFD instead.
        if (!a.content.isWellFormed()) {
          throw new KernelError('EINVAL', 'EINVAL: content is not well-formed Unicode (a lone surrogate); use encoding "base64" for binary data');
        }
        await can.writeFile(a.path, a.content);
        return `wrote ${Buffer.byteLength(a.content)} bytes to ${a.path}${await autosave(can)}`;
      },
    ),

    tool(
      'can_import',
      'Copy a file or a whole directory from the host into a can. Binary-safe. hostPath is read on the host: ' +
        'use an absolute path (a relative one starts in the server\'s working directory). ' +
        'Limits: 256 MB per file, 500 MB and 5000 files per call. Symbolic links that resolve outside the source ' +
        'directory are refused. Parent directories are created. Existing files are kept unless overwrite is true; ' +
        'with overwrite false, two imports to one path cannot both succeed (the second gets EEXIST). ' +
        'Returns the number of files and bytes copied.',
      {
        can: canProp,
        hostPath: pathProp('Host file or directory to read, e.g. C:\\Users\\me\\data\\model.bin.'),
        canPath: pathProp('Destination inside the can, e.g. /app/data. For a directory, this directory is created and filled.'),
        overwrite: overwriteProp,
      },
      ['can', 'hostPath', 'canPath'],
      async (a) => {
        const can = await registry.get(a.can);
        let r;
        let saved = '';
        try {
          r = await importToCan(can, a.hostPath, a.canPath, { overwrite: a.overwrite === true });
        } finally {
          saved = await autosave(can); // a failed import can still have written some files
        }
        return `imported ${r.files} file(s), ${r.dirs} director${r.dirs === 1 ? 'y' : 'ies'}, ${r.bytes} bytes ` +
          `from ${r.hostPath} to ${r.canPath}${saved}`;
      },
    ),

    tool(
      'can_export',
      'Copy a file or a whole directory from a can to the host. Binary-safe. hostPath is relative to the transfer ' +
        `root (${transferRoot}) and must stay inside it: ".." , absolute paths outside the root and links out of ` +
        'the root are refused. Limits: 256 MB per file, 500 MB and 5000 files per call. Symbolic links inside a directory ' +
        'are skipped and counted; a canPath that is itself a link is refused. Names Windows cannot hold (device names ' +
        'such as NUL or COM1, a colon, a trailing dot or space) and names that differ only by case are refused before ' +
        'any write. Existing files are kept unless overwrite is true. Returns the host path and the counts.',
      {
        can: canProp,
        canPath: pathProp('File or directory inside the can, e.g. /app/out/report.pdf.'),
        hostPath: pathProp('Destination relative to the transfer root, e.g. reports/report.pdf.'),
        overwrite: overwriteProp,
      },
      ['can', 'canPath', 'hostPath'],
      async (a) => {
        const can = await registry.get(a.can);
        const r = await exportFromCan(can, a.canPath, a.hostPath, {
          overwrite: a.overwrite === true,
          root: transferRoot,
        });
        const skipped = r.skipped ? `; skipped ${r.skipped} symbolic link(s)` : '';
        return `exported ${r.files} file(s), ${r.dirs} director${r.dirs === 1 ? 'y' : 'ies'}, ${r.bytes} bytes ` +
          `from ${r.canPath} to ${r.hostPath}${skipped}`;
      },
    ),

    tool(
      'can_list_dir',
      'List the entries of a directory in the can.',
      { can: canProp, path: pathProp('Directory path inside the can, e.g. /app.') },
      ['can', 'path'],
      async (a) => {
        const can = await registry.get(a.can);
        const entries = await can.listDir(a.path);
        if (entries.length === 0) return '(empty directory)';
        return entries
          .map((e) => (e.type === 'dir' || e.type === 'directory' ? `dir   ${e.name}/` : `${e.type.padEnd(5)} ${e.size} B  ${e.name}`))
          .join('\n');
      },
    ),

    // ---------------------------------------------------------------- network
    tool(
      'can_ports',
      'List the TCP ports that processes in the can are listening on. Use one of them with can_http or http://localhost:<port>/ in the browser tools.',
      { can: canProp },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        const list = await can.listeners();
        if (list.length === 0) return 'no listening ports';
        return list.map((l) => `port ${l.port} (listening since ${new Date(l.createdAt).toISOString()})`).join('\n');
      },
    ),

    tool(
      'can_http',
      'Send an HTTP request to a server inside the can and return the status, headers and body (capped at 20 KB).',
      {
        can: canProp,
        port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Port the server listens on (see can_ports).' },
        method: { type: 'string', enum: HTTP_METHODS, description: 'Default GET.' },
        path: { type: 'string', description: 'Request path with query string. Default /.' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Request headers.' },
        body: { type: 'string', description: 'Request body (text).' },
      },
      ['can', 'port'],
      async (a) => {
        const can = await registry.get(a.can);
        const res = await can.request({
          port: a.port,
          method: a.method ?? 'GET',
          path: a.path ?? '/',
          headers: a.headers ?? {},
          body: a.body,
        });
        const headers = Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
        return `HTTP ${res.status}\n${headers}\n\n${block(res.body.toString('utf8'))}`;
      },
    ),

    // ---------------------------------------------------------------- browser
    tool(
      'browser_goto',
      'Open a URL in the can\'s headless browser (the active tab). Returns the HTTP status and a page snapshot. ' +
        'Inside the can, use http://localhost:<port>/ for servers. The snapshot lists elements with refs like [e3] for click, type and select.',
      { can: canProp, url: urlProp },
      ['can', 'url'],
      async (a) => {
        const can = await registry.get(a.can);
        const s = await browserFor(can).browse('goto', a.url);
        await recordFrame(can);
        return `HTTP status: ${s.status ?? 'none'}\n${await snapshotOf(can)}`;
      },
    ),

    tool(
      'browser_snapshot',
      'Return the current page as an outline: title, URL, and the interactive elements with refs such as [e3]. Use refs as targets.',
      { can: canProp },
      ['can'],
      async (a) => snapshotOf(await registry.get(a.can)),
    ),

    tool(
      'browser_click',
      'Click a link, button, checkbox or label. Target: a snapshot ref (e.g. "e3"), a CSS selector, or the visible text of the element. ' +
        'Follows links and submits forms. Returns the page snapshot afterwards.',
      { can: canProp, target: targetProp('Ref such as e3, CSS selector, or visible text.') },
      ['can', 'target'],
      async (a) => {
        const can = await registry.get(a.can);
        const s = await browserFor(can).browse('click', a.target);
        await recordFrame(can);
        return `navigated: ${s.navigated ? 'yes' : 'no'}\nHTTP status: ${s.status ?? 'none'}\n${await snapshotOf(can)}`;
      },
    ),

    tool(
      'browser_type',
      'Type text into an input or textarea (replaces its value). Target: ref, CSS selector, or the field\'s label or name.',
      {
        can: canProp,
        target: targetProp('Ref such as e5, CSS selector, or field label.'),
        text: { type: 'string', description: 'The new value.' },
      },
      ['can', 'target', 'text'],
      async (a) => {
        const can = await registry.get(a.can);
        const r = await browserFor(can).browse('type', a.target, a.text);
        await recordFrame(can);
        return `typed into ${a.target}; value is now ${JSON.stringify(r.value)}`;
      },
    ),

    tool(
      'browser_select',
      'Choose option(s) of a <select> by value or visible text.',
      {
        can: canProp,
        target: targetProp('Ref, CSS selector, or the select\'s label.'),
        value: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Option value or text, or an array of them for a multiple select.',
        },
      },
      ['can', 'target', 'value'],
      async (a) => {
        const can = await registry.get(a.can);
        const r = await browserFor(can).browse('select', a.target, a.value);
        await recordFrame(can);
        return `selected in ${a.target}; value is now ${JSON.stringify(r.value)}`;
      },
    ),

    tool(
      'browser_submit',
      'Submit a form the way a user would (fires submit, sends the fields). Target: a form ref or selector; without one, the first form on the page. ' +
        'Returns the page snapshot afterwards.',
      { can: canProp, target: targetProp('Form ref or selector. Default: the first form.') },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        const s = await browserFor(can).browse('submit', ...args(a.target));
        await recordFrame(can);
        return `navigated: ${s.navigated ? 'yes' : 'no'}\nHTTP status: ${s.status ?? 'none'}\n${await snapshotOf(can)}`;
      },
    ),

    tool(
      'browser_text',
      'Return the visible text of the page, or of one element if a target is given.',
      { can: canProp, target: targetProp('Optional ref or selector.') },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        return block(await browserFor(can).browse('text', ...args(a.target)));
      },
    ),

    tool(
      'browser_query',
      'Find elements on the page by CSS selector. Returns a JSON list of {tag, text, attrs}.',
      { can: canProp, selector: { type: 'string', minLength: 1, description: 'CSS selector, e.g. "h1", "a.nav", "[data-id]".' } },
      ['can', 'selector'],
      async (a) => {
        const can = await registry.get(a.can);
        return block(JSON.stringify(await browserFor(can).browse('query', a.selector), null, 2));
      },
    ),

    tool(
      'browser_links',
      'List the links on the page as a JSON list of {text, href}. Each href is an absolute URL.',
      { can: canProp },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        return block(JSON.stringify(await browserFor(can).browse('links'), null, 2));
      },
    ),

    tool(
      'browser_wait',
      'Wait for a number of milliseconds (at most 60000) so that page scripts can finish, then return the page\'s url, title and status as JSON.',
      { can: canProp, ms: { type: 'integer', minimum: 0, maximum: 60000, description: 'How long to wait, in milliseconds.' } },
      ['can', 'ms'],
      async (a) => {
        const can = await registry.get(a.can);
        return block(JSON.stringify(await browserFor(can).browse('wait', a.ms), null, 2));
      },
    ),

    tool(
      'browser_cookies',
      'List the cookies in the can\'s browser as JSON: name, value, domain, path, secure, httpOnly and expires (ms, or null for a session cookie).',
      { can: canProp },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        return block(JSON.stringify(await browserFor(can).browse('cookieList'), null, 2));
      },
    ),

    tool(
      'browser_new_tab',
      'Open a new tab in the can\'s browser and make it the active tab. With a url, the tab loads it. Returns the tab list as JSON; tabs are numbered from 0.',
      { can: canProp, url: { type: 'string', description: 'Optional http or https address to open in the new tab.' } },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        const s = await browserFor(can).browse('newTab', a.url);
        await recordFrame(can);
        return block(JSON.stringify(s, null, 2));
      },
    ),

    tool(
      'browser_select_tab',
      'Make the tab with this index the active one. Returns the tab list as JSON.',
      { can: canProp, index: { type: 'integer', minimum: 0, description: 'The tab number, from 0.' } },
      ['can', 'index'],
      async (a) => {
        const can = await registry.get(a.can);
        const s = await browserFor(can).browse('selectTab', a.index);
        await recordFrame(can);
        return block(JSON.stringify(s, null, 2));
      },
    ),

    tool(
      'browser_close_tab',
      'Close a tab (the active one when no index is given). Closing the last tab opens a blank one. Returns the tab list as JSON.',
      { can: canProp, index: { type: 'integer', minimum: 0, description: 'The tab number to close. Default: the active tab.' } },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        const s = await browserFor(can).browse('closeTab', a.index);
        await recordFrame(can);
        return block(JSON.stringify(s, null, 2));
      },
    ),

    tool(
      'browser_back',
      'Go back one step in the active tab\'s history. Returns the page snapshot afterwards.',
      { can: canProp },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        const s = await browserFor(can).browse('back');
        await recordFrame(can);
        return `HTTP status: ${s.status ?? 'none'}\n${await snapshotOf(can)}`;
      },
    ),

    tool(
      'browser_evaluate',
      'Run JavaScript in the current page (its scripts and DOM). The result is returned as JSON. ' +
        'Sandboxed: page code cannot reach the host.',
      { can: canProp, code: { type: 'string', minLength: 1, description: 'Expression or statements to run in the page.' } },
      ['can', 'code'],
      async (a) => {
        const can = await registry.get(a.can);
        const value = await browserFor(can).browse('evaluate', a.code);
        await recordFrame(can);
        return block(value === undefined ? 'undefined' : JSON.stringify(value, null, 2));
      },
    ),

    tool(
      'browser_console',
      'Return the browser console messages (log, warn, error) for the active tab, including script errors.',
      { can: canProp },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        const state = await browserFor(can).browse('state');
        if (!state.consoleLog?.length) return 'no console messages';
        return block(state.consoleLog.map((m) => `[${m.level}] ${m.text}`).join('\n'));
      },
    ),

    tool(
      'browser_screenshot',
      'Take a PNG screenshot of the page the can\'s browser is showing. The PNG is written into the can (default ' +
        '/tmp/screenshots/<timestamp>.png) and, with hostPath, copied to the transfer root with the same rules as ' +
        'can_export. Returns the paths, width, height and byte count, and the image itself. The renderer is an ' +
        'approximation: block and inline layout with a built-in font; no flexbox or grid, no web fonts, images are ' +
        'grey boxes. See README, "Screenshots".',
      {
        can: canProp,
        path: pathProp('Where to write the PNG inside the can. Relative paths start in /home/agent. ' +
          'Default /tmp/screenshots/<timestamp>.png.'),
        width: { type: 'integer', minimum: 1, maximum: RENDER_LIMITS.maxWidth, description: 'Viewport width in pixels. Default 1280.' },
        height: { type: 'integer', minimum: 1, maximum: RENDER_LIMITS.maxHeight, description: 'Viewport height in pixels. Default 800.' },
        fullPage: { type: 'boolean', description: 'Grow the image to the page height, up to 4096 px. Default false.' },
        hostPath: pathProp(`Also copy the PNG to this path relative to the transfer root (${transferRoot}), e.g. shots/home.png.`),
        overwrite: overwriteProp,
      },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        const png = await browserFor(can).screenshot({ fullPage: a.fullPage === true, width: a.width, height: a.height });
        const { width, height } = pngSize(png);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const canPath = path.posix.resolve('/home/agent', a.path ?? `/tmp/screenshots/${stamp}.png`);
        await can.mkdir(path.posix.dirname(canPath), { recursive: true });
        await can.writeFile(canPath, png);
        const saved = await autosave(can);
        let host = '';
        if (a.hostPath !== undefined) {
          const file = writeTransferFile(png, a.hostPath, { root: transferRoot, overwrite: a.overwrite === true });
          host = `\nhost: ${file}`;
        }
        const text = `canPath: ${canPath}\nwidth: ${width}\nheight: ${height}\nbytes: ${png.length}${host}${saved}`;
        if (png.length > INLINE_IMAGE_LIMIT) {
          return `${text}\nimage not included inline (over ${INLINE_IMAGE_LIMIT} bytes); read the file with can_export`;
        }
        return { text, images: [{ data: png.toString('base64'), mimeType: 'image/png' }] };
      },
    ),
    // ---------------------------------------------------------------- computer use (real Chromium only)
    tool(
      'computer_screenshot',
      'Screenshot of the can\'s browser viewport, the surface that computer_action points at. Coordinates are pixels ' +
        'of this image (top left is 0, 0). Passing width or height changes the viewport size. Uses the can\'s Chromium ' +
        'browser, the default; the built-in browser has no pointer or keyboard.',
      {
        can: canProp,
        width: { type: 'integer', minimum: 1, maximum: RENDER_LIMITS.maxWidth, description: 'Viewport width. Default: the current size (1280).' },
        height: { type: 'integer', minimum: 1, maximum: RENDER_LIMITS.maxHeight, description: 'Viewport height. Default: the current size (800).' },
      },
      ['can'],
      async (a) => {
        const can = await registry.get(a.can);
        const r = await computerBrowser(can).computer('screenshot', { width: a.width, height: a.height });
        return computerResult(r, 'screenshot');
      },
    ),

    tool(
      'computer_action',
      'Act on the can\'s browser the way a person does, at pixel coordinates from computer_screenshot (take one first). ' +
        'action: move (pointer to x, y); click, double_click, right_click or middle_click at x, y (modifiers: alt, ctrl, ' +
        'meta, shift); drag from x, y to to_x, to_y; scroll with the wheel by delta_x and delta_y (pixels, positive ' +
        'down) at x, y, or the middle of the viewport; type text into the focused field (a newline presses Enter); key ' +
        'presses one key (Enter, Tab, Escape, Backspace, ArrowDown, F5, or one character) with optional modifiers; wait ' +
        'waits duration_ms. Returns a new screenshot, the page URL and title, and whether the action loaded a page. ' +
        'Uses the can\'s Chromium browser.',
      {
        can: canProp,
        action: {
          type: 'string',
          enum: ['move', 'click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll', 'type', 'key', 'wait'],
          description: 'What to do.',
        },
        x: { type: 'integer', minimum: 0, description: 'Pixel x in the viewport.' },
        y: { type: 'integer', minimum: 0, description: 'Pixel y in the viewport.' },
        to_x: { type: 'integer', minimum: 0, description: 'End x for drag.' },
        to_y: { type: 'integer', minimum: 0, description: 'End y for drag.' },
        delta_x: { type: 'integer', description: 'Horizontal wheel amount in pixels for scroll (positive is right).' },
        delta_y: { type: 'integer', description: 'Vertical wheel amount in pixels for scroll (positive is down), e.g. 400.' },
        text: { type: 'string', description: 'Text to type (type action), up to 10,000 characters.' },
        key: { type: 'string', minLength: 1, description: 'A key name (Enter, Tab, Escape, ArrowDown, F5) or one character (key action).' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] },
          description: 'Modifier keys held during a click or key press, such as ["ctrl"] with key "a".',
        },
        duration_ms: { type: 'integer', minimum: 0, maximum: WAIT_MAX_MS, description: 'How long to wait (wait action).' },
      },
      ['can', 'action'],
      async (a) => {
        const can = await registry.get(a.can);
        const b = computerBrowser(can);
        const { action, can: _can, ...args } = a;
        const r = await b.computer(action, args);
        await recordFrame(can);
        return computerResult(r, action);
      },
    ),
  ];
  // Each failed call is noted on its can, so can_status can show the last error (see CanRegistry.noteError).
  const noteErrors = (t) => ({
    ...t,
    run: async (a) => {
      try {
        return await t.run(a);
      } catch (err) {
        const id = typeof a?.can === 'string' ? registry.manager.get(a.can)?.id : undefined;
        if (id) registry.noteError(id, err.message);
        throw err;
      }
    },
  });
  return list.map(withTimeline).map(noteErrors);

  /** Computer use needs real pointer and keyboard input, which only the Chromium backend has. */
  function computerBrowser(can) {
    const b = browserFor(can);
    if (typeof b.computer !== 'function') {
      throw new KernelError(
        'ENOTSUP',
        'ENOTSUP: computer use needs Chromium, but this can uses the built-in browser, which has no pointer or ' +
          'keyboard input. Remove "chromiumBrowser": false from the mounts file to use Chromium.',
      );
    }
    return b;
  }

  /** Text and the screenshot of one computer action. The image is left out when it is over the inline limit. */
  function computerResult(r, action) {
    const { width, height } = r.viewport;
    const text = `${action}: done. viewport ${width}x${height}\nURL: ${r.url}\nTitle: ${r.title}` +
      (r.navigated ? `\nthe action loaded a page (HTTP status ${r.status ?? 'none'})` : '');
    if (r.png.length > INLINE_IMAGE_LIMIT) return `${text}\nscreenshot not included inline (over ${INLINE_IMAGE_LIMIT} bytes)`;
    return { text, images: [{ data: r.png.toString('base64'), mimeType: 'image/png' }] };
  }
}

/**
 * Tools for the opt-in host browser (src/hostbrowser.js). They exist only when the user has enabled the host browser,
 * and they drive a real browser on this machine, outside any can.
 */
export function createHostBrowserTools(hostBrowser, { transferRoot = defaultTransferRoot() } = {}) {
  if (!hostBrowser) return [];
  const tool = (name, description, properties, required, run) => ({
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    run,
  });
  return [
    tool(
      'host_browser_goto',
      'Open an http or https page in the host browser: a real Chrome or Edge on this machine, not inside a can. ' +
        'It uses the host network and can reach services on this machine. Returns the page title and URL.',
      { url: { type: 'string', minLength: 1, description: 'An http or https URL.' } },
      ['url'],
      async (a) => {
        const s = await hostBrowser.goto(a.url);
        return `${s.title}\n${s.url}`;
      },
    ),
    tool(
      'host_browser_text',
      'Visible text of the page open in the host browser.',
      {},
      [],
      async () => capText(await hostBrowser.text()),
    ),
    tool(
      'host_browser_evaluate',
      'Run JavaScript in the host browser page and return its JSON-compatible result.',
      { code: { type: 'string', minLength: 1, description: 'JavaScript to run in the page.' } },
      ['code'],
      async (a) => {
        const value = await hostBrowser.evaluate(a.code);
        return capText(JSON.stringify(value ?? null, null, 2));
      },
    ),
    tool(
      'host_browser_screenshot',
      'PNG of the host browser page, saved under the transfer root (the same rules as can_export). ' +
        'Use can_export or the user to fetch it.',
      {
        path: { type: 'string', minLength: 1, description: 'File name under the transfer root, such as shot.png.' },
        overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' },
        fullPage: { type: 'boolean', description: 'Capture beyond the visible viewport. Default false.' },
      },
      ['path'],
      async (a) => {
        await hostBrowser.screenshot(a.path, { overwrite: a.overwrite ?? false, fullPage: a.fullPage ?? false, root: transferRoot });
        return `saved ${a.path} under the transfer root`;
      },
    ),
    tool(
      'host_browser_close',
      'Close the host browser and delete its temporary profile. It starts again on the next host_browser_ call.',
      {},
      [],
      async () => {
        await hostBrowser.close();
        return 'host browser closed';
      },
    ),
  ];
}
