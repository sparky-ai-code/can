// Environment specs: what an agent may set up before a can boots and gets its first command. The spec is checked in
// full before anything is created, then applied in a fixed order, and any failure destroys the half-built can so
// no agent is left with a can that is missing something it asked for.
//
//   environment: {
//     env:          { NAME: "value" }                       extra environment variables
//     workdir:      "/app"                                  start folder (created); setup commands run here
//     node:         "24" | "24.15.0"                        Node version the can reports (process.version)
//     network:      { internet: true|false, registry: "https://registry.npmjs.org/" }
//     imports:      [{ hostPath, canPath, exclude?: ["node_modules", "*.log"], overwrite? }]
//     files:        [{ path, content, encoding?: "utf8"|"base64", overwrite? }]
//     tools:        { python: "3.15" }                      toolchains resolved from the local cache (never downloaded)
//     requireTools: ["npm", "pnpm"]                         fail unless the can has these commands
//     pip:          ["requests==2.32.3 --hash=sha256:<hex>"]   lock lines installed with pip during setup
//     setup:        [{ command, timeoutMs?, optional?, label? }]   run in order, stop at the first failure
//   }
//
// Steps run in this order: tools, requireTools, workdir, imports, files, pip, setup.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { KernelError } from './kernel/errors.js';
import { importToCan, excludeMatcher } from './transfer.js';
import { normalizePolicy } from './vm/policy.js';
import { lockEntries, resolveTool } from './toolchains.js';

export const LIMITS = Object.freeze({
  env: 100,
  imports: 20,
  files: 50,
  fileBytes: 1024 * 1024,
  requireTools: 20,
  tools: 10,
  pip: 100,
  setup: 20,
  setupTimeoutMs: 600_000,
  setupDefaultTimeoutMs: 300_000,
});

const TOP_KEYS = ['env', 'workdir', 'node', 'network', 'imports', 'files', 'tools', 'requireTools', 'pip', 'setup'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
// One lock line as pip prints it: name==version --hash=sha256:<64 hex digits>. The hash is optional when typed by hand.
const PIP_LOCK_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9.!+_-]+)(?: --hash=sha256:([0-9a-f]{64}))?$/;

/** The last `limit` bytes of text, for error messages. */
const lastBytes = (text, limit) => {
  const buf = Buffer.from(text, 'utf8');
  return buf.length <= limit ? text : `...${buf.subarray(buf.length - limit).toString('utf8')}`;
};

const invalid = (msg) => new KernelError('EINVAL', `EINVAL: ${msg}`);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Refuses unknown keys, so a misspelt setting fails loudly instead of being ignored. */
function checkKeys(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw invalid(`unknown ${where} setting "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

function checkList(value, name, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${name} must be a list`);
  if (value.length > max) throw invalid(`${name} takes at most ${max} entries (got ${value.length})`);
  return value;
}

function checkCanPath(value, where) {
  if (typeof value !== 'string' || !value.startsWith('/')) throw invalid(`${where} needs an absolute path inside the can, such as /app`);
  // Checked on the text as given: normalizing first would turn "/app/../etc" into "/etc" and hide the "..".
  if (value.split('/').includes('..')) throw invalid(`${where} must not contain ".."`);
  const p = path.posix.normalize(value);
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * Checks an environment spec and returns the normalized form. Pure: nothing is created or read on the host here,
 * so an invalid spec costs nothing. Throws EINVAL with the first problem found.
 */
export function normalizeEnvironment(spec) {
  if (spec === undefined || spec === null) return emptyEnvironment();
  if (!isPlainObject(spec)) throw invalid('environment must be an object');
  checkKeys(spec, TOP_KEYS, 'environment');

  const env = {};
  if (spec.env !== undefined) {
    if (!isPlainObject(spec.env)) throw invalid('environment.env must be an object of name: value strings');
    const names = Object.keys(spec.env);
    if (names.length > LIMITS.env) throw invalid(`environment.env takes at most ${LIMITS.env} variables`);
    for (const name of names) {
      if (!ENV_NAME.test(name)) throw invalid(`environment variable name "${name}" must be letters, digits and "_", not starting with a digit`);
      if (typeof spec.env[name] !== 'string') throw invalid(`environment variable ${name} must be a string`);
      if (spec.env[name].length > 4096) throw invalid(`environment variable ${name} is longer than 4096 characters`);
      env[name] = spec.env[name];
    }
  }

  const network = spec.network ?? {};
  if (!isPlainObject(network)) throw invalid('environment.network must be an object');
  checkKeys(network, ['internet', 'registry'], 'network');
  const policy = normalizePolicy({
    ...(network.internet !== undefined ? { internet: network.internet } : {}),
    ...(network.registry !== undefined ? { registry: network.registry } : {}),
    ...(spec.node !== undefined ? { nodeVersion: spec.node } : {}),
  });

  const workdir = spec.workdir === undefined ? null : checkCanPath(spec.workdir, 'workdir');

  const imports = checkList(spec.imports, 'environment.imports', LIMITS.imports).map((item, i) => {
    if (!isPlainObject(item)) throw invalid(`imports[${i}] must be {hostPath, canPath}`);
    checkKeys(item, ['hostPath', 'canPath', 'exclude', 'overwrite'], `imports[${i}]`);
    if (typeof item.hostPath !== 'string' || item.hostPath === '') throw invalid(`imports[${i}] needs a hostPath`);
    if (item.exclude !== undefined && (!Array.isArray(item.exclude) || item.exclude.some((x) => typeof x !== 'string'))) {
      throw invalid(`imports[${i}].exclude must be a list of file or folder names`);
    }
    excludeMatcher(item.exclude ?? []); // refuses entries that are paths, before anything is copied
    return {
      hostPath: item.hostPath,
      canPath: checkCanPath(item.canPath, `imports[${i}].canPath`),
      exclude: item.exclude ?? [],
      overwrite: item.overwrite === true,
    };
  });

  const files = checkList(spec.files, 'environment.files', LIMITS.files).map((item, i) => {
    if (!isPlainObject(item)) throw invalid(`files[${i}] must be {path, content}`);
    checkKeys(item, ['path', 'content', 'encoding', 'overwrite'], `files[${i}]`);
    if (typeof item.content !== 'string') throw invalid(`files[${i}].content must be a string`);
    const encoding = item.encoding ?? 'utf8';
    if (encoding !== 'utf8' && encoding !== 'base64') throw invalid(`files[${i}].encoding must be "utf8" or "base64"`);
    const bytes = encoding === 'base64' ? Buffer.from(item.content, 'base64') : Buffer.from(item.content, 'utf8');
    if (bytes.length > LIMITS.fileBytes) throw invalid(`files[${i}] is larger than ${LIMITS.fileBytes} bytes`);
    return {
      path: checkCanPath(item.path, `files[${i}].path`),
      bytes,
      overwrite: item.overwrite !== false,
    };
  });

  const requireTools = checkList(spec.requireTools, 'environment.requireTools', LIMITS.requireTools).map((name) => {
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) throw invalid(`requireTools entries are command names such as npm (got ${JSON.stringify(name)})`);
    return name;
  });

  const tools = [];
  if (spec.tools !== undefined) {
    if (!isPlainObject(spec.tools)) throw invalid('environment.tools must be an object such as {"python": "3.15"}');
    const names = Object.keys(spec.tools);
    if (names.length > LIMITS.tools) throw invalid(`environment.tools takes at most ${LIMITS.tools} entries`);
    for (const name of names) {
      if (!TOOL_NAME.test(name)) throw invalid(`environment.tools name "${name}" is not a tool name`);
      const version = spec.tools[name];
      if (typeof version !== 'string' || version === '') throw invalid(`environment.tools.${name} must be a version string such as "3.15"`);
      tools.push({ name, version });
    }
  }

  const pip = checkList(spec.pip, 'environment.pip', LIMITS.pip).map((line, i) => {
    if (typeof line !== 'string' || !PIP_LOCK_LINE.test(line.trim())) {
      throw invalid(`pip[${i}] must be a lock line such as "requests==2.32.3 --hash=sha256:<hex>"`);
    }
    return line.trim();
  });

  const setup = checkList(spec.setup, 'environment.setup', LIMITS.setup).map((item, i) => {
    if (!isPlainObject(item) || typeof item.command !== 'string' || item.command.trim() === '') {
      throw invalid(`setup[${i}] must be {command} with a non-empty command`);
    }
    checkKeys(item, ['command', 'timeoutMs', 'optional', 'label'], `setup[${i}]`);
    const timeoutMs = item.timeoutMs ?? LIMITS.setupDefaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.setupTimeoutMs) {
      throw invalid(`setup[${i}].timeoutMs must be a whole number of milliseconds from 1 to ${LIMITS.setupTimeoutMs}`);
    }
    return {
      command: item.command,
      timeoutMs,
      optional: item.optional === true,
      label: typeof item.label === 'string' && item.label !== '' ? item.label.slice(0, 80) : item.command.slice(0, 80),
    };
  });

  return { env, policy, workdir, imports, files, tools, requireTools, pip, setup };
}

function emptyEnvironment() {
  return {
    env: {}, policy: normalizePolicy({}), workdir: null, imports: [], files: [], tools: [], requireTools: [], pip: [], setup: [],
  };
}

/** JSON with sorted keys and no whitespace, so the same value always gives the same text. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v === undefined ? null : v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The identity of a can's creation spec: a hash of the normalized environment and the mounts. Two creates with the
 * same key are the same can (can_create reuses it); a different key is a conflict. Host file contents are hashed
 * for `files`; `imports` are identified by their host path and options, not by their contents.
 */
export function environmentKey(spec, mounts = []) {
  const canonical = {
    env: spec.env,
    policy: spec.policy,
    workdir: spec.workdir,
    imports: spec.imports.map((i) => ({ hostPath: i.hostPath, canPath: i.canPath, exclude: [...i.exclude].sort(), overwrite: i.overwrite })),
    files: spec.files.map((f) => ({
      path: f.path, sha256: createHash('sha256').update(f.bytes).digest('hex'), overwrite: f.overwrite,
    })),
    tools: spec.tools,
    requireTools: spec.requireTools,
    pip: spec.pip,
    setup: spec.setup,
    mounts: mounts.map((m) => ({ label: m.label, canPath: m.canPath })).sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
  };
  return createHash('sha256').update(stableJson(canonical)).digest('hex');
}

const DEFAULT_START = '/home/agent';

/** One argument for the can's shell, in single quotes (a quote inside is written as '\''). */
export function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

/**
 * Applies a normalized environment to a freshly booted can, in this order: required tools, workdir, host imports,
 * inline files, setup commands. Returns a report for the agent. Throws if a step fails; the caller destroys the can.
 * @param {import('./can.js').Can} can
 * @param {ReturnType<typeof normalizeEnvironment>} spec
 */
export async function applyEnvironment(can, spec, { log = () => {} } = {}) {
  const report = {
    policy: spec.policy, toolchains: [], tools: [], workdir: spec.workdir ?? DEFAULT_START, imports: [], files: 0, pip: [], setup: [],
  };

  // Step 1: toolchains. Resolved from the local cache only (src/toolchains.js never downloads); a missing one fails here.
  for (const { name, version } of spec.tools) {
    const found = await resolveTool(name, version);
    const entry = lockEntries().find((e) => e.name === found.name && e.version === found.version);
    report.toolchains.push({ name: found.name, version: found.version, sha256: entry?.sha256 ?? null });
  }

  if (spec.requireTools.length) {
    const missing = [];
    for (const tool of spec.requireTools) {
      const found = await can.exec(`which ${tool}`, { timeout: 10_000 });
      if (found.exitCode === 0) report.tools.push(tool);
      else missing.push(tool);
    }
    if (missing.length) {
      throw new KernelError(
        'ENOENT',
        `ENOENT: this can does not provide ${missing.join(', ')}. A can runs its built-in commands (see "help" in the can): `
          + 'there is no native toolchain, so cargo and other compiled-tool setups cannot run here.',
      );
    }
  }

  if (spec.workdir) {
    await can.mkdir(spec.workdir, { recursive: true });
    await can.setCwd(spec.workdir); // commands that do not name a cwd start here
  }

  for (const item of spec.imports) {
    log(`import ${item.canPath}`);
    const r = await importToCan(can, item.hostPath, item.canPath, { overwrite: item.overwrite, exclude: item.exclude });
    report.imports.push({ canPath: r.canPath, files: r.files, dirs: r.dirs, bytes: r.bytes, skipped: r.skipped.length });
  }

  for (const file of spec.files) {
    if (!file.overwrite && (await can.exists(file.path))) {
      throw new KernelError('EEXIST', `EEXIST: ${file.path} already exists in the can and overwrite is false`);
    }
    await can.mkdir(path.posix.dirname(file.path), { recursive: true });
    await can.writeFile(file.path, file.bytes);
    report.files++;
  }

  for (const line of spec.pip) {
    log(`pip: ${line}`);
    const tokens = line.split(/\s+/).map(shellQuote).join(' ');
    const r = await can.exec(`pip install ${tokens}`, { cwd: report.workdir, timeout: LIMITS.setupDefaultTimeoutMs });
    if (r.exitCode !== 0) {
      const tail = lastBytes(`${r.stdout}${r.stderr}`, 2048);
      throw new KernelError('EIO', `EIO: pip could not install "${line}" (exit ${r.exitCode}). Next: fix the lock line or use a pure-Python package. Output:\n${tail}`);
    }
    report.pip.push(line);
  }

  for (const step of spec.setup) {
    const started = Date.now();
    log(`setup: ${step.label}`);
    const r = await can.exec(step.command, { cwd: report.workdir, timeout: step.timeoutMs });
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    if (r.exitCode !== 0 && !step.optional) {
      const why = r.timedOut || r.exitCode === 124 ? `timed out after ${step.timeoutMs} ms` : `exited with code ${r.exitCode}`;
      const tail = lastBytes(`${r.stdout}${r.stderr}`, 2048);
      throw new KernelError('EIO', `EIO: setup step "${step.label}" ${why}. Output:\n${tail}`);
    }
    report.setup.push({ label: step.label, exitCode: r.exitCode, seconds, optional: step.optional });
  }
  return report;
}

/** The one-paragraph summary an agent reads after creating a can. */
export function describeReport(report) {
  const { policy } = report;
  const lines = [];
  for (const t of report.toolchains) lines.push(`toolchain: ${t.name} ${t.version} (sha256 ${t.sha256 ?? 'unknown'})`);
  if (report.tools.length) lines.push(`tools: ${report.tools.join(', ')}`);
  if (report.pip.length) lines.push(`pip installed ${report.pip.length} lock line(s)`);
  lines.push(`runtime: ${policy.nodeVersion ?? 'default'} (process.version)`);
  lines.push(`network: ${policy.internet ? `internet on, registry ${policy.registry}` : 'internet off'}`);
  for (const i of report.imports) {
    lines.push(`imported ${i.files} file(s) and ${i.dirs} folder(s) (${i.bytes} bytes) to ${i.canPath}${i.skipped ? `, skipped ${i.skipped} excluded entr${i.skipped === 1 ? 'y' : 'ies'}` : ''}`);
  }
  if (report.files) lines.push(`wrote ${report.files} file(s)`);
  for (const s of report.setup) {
    lines.push(`setup "${s.label}": ${s.exitCode === 0 ? 'ok' : `exit ${s.exitCode} (optional)`} in ${s.seconds}s`);
  }
  lines.push(`start folder: ${report.workdir}`);
  return lines.join('\n');
}
