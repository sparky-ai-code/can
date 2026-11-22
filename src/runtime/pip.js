// pip inside a can: installs pure-Python wheels from a PyPI JSON index into the site-packages folder that python
// reads (/usr/lib/python3.15/site-packages in the can VFS). Only py3-none-any and py2.py3-none-any wheels install.
// Sdists and platform wheels are refused with ENOTSUP, since a can runs no compiler and no native code.
//
// Flow: plan first, then write. Every distribution is resolved, downloaded and checked before anything is written,
// so a bad hash or a missing wheel leaves the site-packages folder as it was.
//
// Index: CAN_PIP_INDEX in the can's environment (default https://pypi.org/pypi/). Requests go to the host network
// when the can's network.internet is on, and fail with EPERM when it is off, as npm does.
//
// Wheels are unpacked here with a small zip reader (node:zlib inflateRawSync). Nothing external runs.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { posix } from 'node:path';
import { Buffer } from 'node:buffer';
import { KernelError } from '../kernel/errors.js';

export const SITE_PACKAGES = '/usr/lib/python3.15/site-packages';
export const DEFAULT_INDEX = 'https://pypi.org/pypi/';

const PURE_WHEEL = /-(py3|py2\.py3)-none-any\.whl$/;
const FINAL_VERSION = /^\d+(\.\d+)*$/;
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const MAX_CANDIDATE_VERSIONS = 20;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 60_000;

/** PEP 503 name normalization: lower case, runs of - _ . become one -. */
export const normalizeName = (name) => String(name).toLowerCase().replace(/[-_.]+/g, '-');

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------- requirement specs and markers

/**
 * Parses "name", "name==1.0", "name>=1,<2", "name (>=1.0) ; marker". Extras ("name[x]") are accepted and ignored.
 * Returns {name, specs: [{op, version}], marker: string|null}. Throws EINVAL for anything else.
 */
export function parseRequirement(text, where = 'the command line') {
  const src = String(text).trim();
  const semi = src.indexOf(';');
  const head = (semi === -1 ? src : src.slice(0, semi)).trim();
  const marker = semi === -1 ? null : src.slice(semi + 1).trim();
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(head);
  if (!m || !NAME_RE.test(m[1])) {
    throw new KernelError('EINVAL', `EINVAL: "${src}" is not a package name (from ${where}). Next: use a name, or name==version.`);
  }
  const rest = m[2].replace(/^\(/, '').replace(/\)$/, '').trim();
  const specs = [];
  if (rest) {
    for (const part of rest.split(',')) {
      const s = /^\s*(===|==|!=|~=|>=|<=|>|<)\s*([^\s,]+)\s*$/.exec(part);
      if (!s) {
        throw new KernelError('EINVAL', `EINVAL: unsupported version specifier "${part.trim()}" in "${src}". Next: use name, name==version, or >=, <, <=, >, !=, ~=.`);
      }
      specs.push({ op: s[1], version: s[2] });
    }
  }
  return { name: m[1], specs, marker: marker === '' ? null : marker };
}

const vtuple = (v) => v.split('.').map((x) => Number(x));

function cmpTuples(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** True when a version (a final release such as 1.2.3) meets one specifier. */
export function specifierAllows(version, { op, version: want }) {
  if (op === '===') return version === want;
  if (op === '==' && want.endsWith('.*')) return isPrefix(vtuple(version), vtuple(want.slice(0, -2)));
  if (op === '!=' && want.endsWith('.*')) return !isPrefix(vtuple(version), vtuple(want.slice(0, -2)));
  const c = cmpTuples(vtuple(version), vtuple(want));
  switch (op) {
    case '==': return c === 0;
    case '!=': return c !== 0;
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '~=': {
      const parts = vtuple(want);
      return parts.length >= 2 && c >= 0 && isPrefix(vtuple(version), parts.slice(0, -1));
    }
    default: return false;
  }
}

const isPrefix = (full, prefix) => prefix.every((x, i) => full[i] === x);

/** The environment a can's python reports (CPython 3.15 on wasm32-wasip1). */
const MARKER_ENV = {
  sys_platform: 'wasi',
  os_name: 'posix',
  platform_system: 'WASI',
  platform_machine: 'wasm32',
  platform_python_implementation: 'CPython',
  implementation_name: 'cpython',
  python_version: '3.15',
  python_full_version: '3.15.2',
};
const VERSION_VARS = new Set(['python_version', 'python_full_version']);

function evalClause(clause) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(===|==|!=|<=|>=|<|>)\s*(?:"([^"]*)"|'([^']*)')\s*$/.exec(clause);
  if (!m) return null;
  const [, variable, op, q1, q2] = m;
  const literal = q1 ?? q2;
  if (variable === 'extra') return false; // extras are never installed by default
  if (!(variable in MARKER_ENV)) return null;
  const here = MARKER_ENV[variable];
  if (VERSION_VARS.has(variable) && /^\d+(\.\d+)*$/.test(literal)) {
    const c = cmpTuples(vtuple(here), vtuple(literal));
    return { '==': c === 0, '===': c === 0, '!=': c !== 0, '<=': c <= 0, '>=': c >= 0, '<': c < 0, '>': c > 0 }[op] ?? null;
  }
  if (op === '==' || op === '===') return here === literal;
  if (op === '!=') return here !== literal;
  return null;
}

/**
 * Evaluates a marker for this can. true, false, or null when it cannot be decided (compound parentheses, unknown
 * variables). A null dependency is skipped with a note, never installed on a guess.
 */
export function evalMarker(marker) {
  if (marker === null || marker === undefined) return true;
  if (/[()]/.test(marker)) return null;
  const ors = marker.split(/\s+or\s+/).map((part) => {
    const ands = part.split(/\s+and\s+/).map(evalClause);
    if (ands.includes(false)) return false;
    return ands.every((x) => x === true) ? true : null;
  });
  if (ors.includes(true)) return true;
  return ors.every((x) => x === false) ? false : null;
}

// ---------------------------------------------------------------- METADATA and RECORD

/** Reads Name, Version and the Requires-Dist lines of a METADATA file (RFC 822 headers up to the first blank line). */
export function parseMetadata(text) {
  const meta = { name: null, version: null, requires: [] };
  for (const line of String(text).split(/\r?\n/)) {
    if (line === '') break;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'name' && meta.name === null) meta.name = value;
    else if (key === 'version' && meta.version === null) meta.version = value;
    else if (key === 'requires-dist') meta.requires.push(value);
  }
  return meta;
}

const recordHash = (bytes) => crypto.createHash('sha256').update(bytes).digest('base64url');

// ---------------------------------------------------------------- zip (wheels)

/** Reads the entries of a zip file (stored or deflated, no zip64). Directory entries are skipped. */
export function readZip(buf) {
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new KernelError('EINVAL', 'EINVAL: the wheel is not a zip file. Next: re-download it from the index.');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || p === 0xffffffff) {
      throw new KernelError('ENOTSUP', 'ENOTSUP: the wheel uses zip64, which a can does not unpack. Next: choose another version.');
    }
    const out = [];
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new KernelError('EINVAL', 'EINVAL: the wheel directory is damaged. Next: re-download it.');
      const method = buf.readUInt16LE(p + 10);
      const csize = buf.readUInt32LE(p + 20);
      const usize = buf.readUInt32LE(p + 24);
      const nlen = buf.readUInt16LE(p + 28);
      const xlen = buf.readUInt16LE(p + 30);
      const clen = buf.readUInt16LE(p + 32);
      const loff = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nlen);
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/')) continue;
      const parts = name.split('/');
      if (name.startsWith('/') || name.includes('\\') || parts.includes('..')) {
        throw new KernelError('EINVAL', `EINVAL: refusing wheel entry "${name}": it leaves the site folder. Next: do not install this package.`);
      }
      if (buf.readUInt32LE(loff) !== 0x04034b50) throw new KernelError('EINVAL', 'EINVAL: the wheel data is damaged. Next: re-download it.');
      const start = loff + 30 + buf.readUInt16LE(loff + 26) + buf.readUInt16LE(loff + 28);
      const raw = buf.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else throw new KernelError('ENOTSUP', `ENOTSUP: the wheel uses compression method ${method}. Next: choose another version.`);
      if (data.length !== usize) throw new KernelError('EINVAL', `EINVAL: wheel entry "${name}" has the wrong size. Next: re-download it.`);
      out.push({ name, data: Buffer.from(data) });
    }
    return out;
  } catch (err) {
    if (err instanceof KernelError) throw err;
    throw new KernelError('EINVAL', `EINVAL: the wheel could not be read (${err.message}). Next: re-download it.`);
  }
}

// ---------------------------------------------------------------- network

/** GET over the host network (the same path curl uses for remote hosts). Null on 404. Follows redirects. */
async function httpGet(url, policy, hops = 0) {
  if (policy?.internet === false) {
    throw new KernelError('EPERM', 'EPERM: network access is off for this can (network.internet is false), so pip cannot reach the package index. Next: turn network access on for this can.');
  }
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new KernelError('EINVAL', `EINVAL: the package index must be http or https (got ${u.protocol}). Next: set CAN_PIP_INDEX.`);
  }
  const mod = u.protocol === 'https:' ? https : http;
  const res = await new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: `${u.pathname}${u.search}`,
      headers: { accept: 'application/json, application/octet-stream;q=0.9' },
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('error', reject);
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.on('error', (e) => reject(new KernelError('EIO', `EIO: could not reach ${u.host} (${e.message}). Next: check the network and CAN_PIP_INDEX.`)));
    req.end();
  });
  if (res.status >= 300 && res.status < 400 && res.headers.location) {
    if (hops >= MAX_REDIRECTS) throw new KernelError('ELOOP', `ELOOP: too many redirects from ${url}. Next: check CAN_PIP_INDEX.`);
    return httpGet(new URL(res.headers.location, u).href, policy, hops + 1);
  }
  if (res.status === 404) return null;
  if (res.status !== 200) throw new KernelError('EIO', `EIO: the index answered ${res.status} for ${url}. Next: try again later, or check CAN_PIP_INDEX.`);
  return res.body;
}

async function fetchJson(url, policy) {
  const body = await httpGet(url, policy);
  return body === null ? null : JSON.parse(body.toString('utf8'));
}

// ---------------------------------------------------------------- resolution

/** Picks the pure-Python wheel of one release's file list (py3-none-any first). Null when there is none. */
function pickWheel(files, allowYanked) {
  const usable = files.filter((f) => f && f.packagetype === 'bdist_wheel' && PURE_WHEEL.test(f.filename ?? '') && (allowYanked || !f.yanked));
  usable.sort((a, b) => (a.filename.endsWith('-py3-none-any.whl') ? 0 : 1) - (b.filename.endsWith('-py3-none-any.whl') ? 0 : 1));
  return usable[0] ?? null;
}

/**
 * Finds the release to install: newest first among releases that meet the specifiers and have a pure-Python wheel.
 * An exact pin reads only that version. Returns {version, wheel}.
 */
async function resolveRelease(item, index, policy) {
  const { name, specs } = item;
  const pin = specs.find((s) => (s.op === '==' || s.op === '===') && !s.version.endsWith('.*'));
  const enc = encodeURIComponent;
  let candidates;
  if (pin) {
    const doc = await fetchJson(`${index}${enc(name)}/${enc(pin.version)}/json`, policy);
    if (!doc) throw new KernelError('ENOENT', `ENOENT: no release ${name}==${pin.version} on the index. Next: check the name and version.`);
    candidates = [{ version: pin.version, files: doc.urls ?? [], allowYanked: true }];
  } else {
    const doc = await fetchJson(`${index}${enc(name)}/json`, policy);
    if (!doc) throw new KernelError('ENOENT', `ENOENT: no package named ${name} on the index. Next: check the spelling.`);
    const releases = doc.releases ?? {};
    const versions = Object.keys(releases)
      .filter((v) => FINAL_VERSION.test(v) && specs.every((s) => specifierAllows(v, s)))
      .sort((a, b) => cmpTuples(vtuple(b), vtuple(a)))
      .slice(0, MAX_CANDIDATE_VERSIONS);
    if (versions.length === 0) {
      const wanted = specs.map((s) => `${s.op}${s.version}`).join(',') || 'any version';
      throw new KernelError('ENOENT', `ENOENT: no release of ${name} matches ${wanted}. Next: change the version range.`);
    }
    candidates = versions.map((v) => ({ version: v, files: releases[v] ?? [], allowYanked: false }));
  }
  for (const c of candidates) {
    const wheel = pickWheel(c.files, c.allowYanked);
    if (wheel) return { version: c.version, wheel };
  }
  throw new KernelError('ENOTSUP', `ENOTSUP: ${name} has no pure-Python wheel. Next: choose a pure-Python package.`);
}

// ---------------------------------------------------------------- the installed set

/** The distributions in site-packages: Map<normalized name, {name, version, dir}>. */
export function scanInstalled(vfs) {
  const out = new Map();
  if (!vfs.exists(SITE_PACKAGES)) return out;
  for (const entry of vfs.readdir(SITE_PACKAGES)) {
    if (!entry.endsWith('.dist-info')) continue;
    const dir = posix.join(SITE_PACKAGES, entry);
    const meta = posix.join(dir, 'METADATA');
    if (!vfs.exists(meta)) continue;
    const parsed = parseMetadata(vfs.readFile(meta, 'utf8'));
    if (parsed.name) out.set(normalizeName(parsed.name), { name: parsed.name, version: parsed.version, dir });
  }
  return out;
}

/** Removes an installed distribution: the files its RECORD lists, then its .dist-info folder. */
function uninstall(vfs, dist) {
  const record = posix.join(dist.dir, 'RECORD');
  if (vfs.exists(record)) {
    for (const line of vfs.readFile(record, 'utf8').split('\n')) {
      const file = line.split(',')[0];
      if (!file || file.startsWith('/') || file.split('/').includes('..') || file.endsWith('.dist-info/RECORD')) continue;
      try { vfs.rm(posix.join(SITE_PACKAGES, file), { force: true }); } catch { /* already gone */ }
    }
  }
  vfs.rm(dist.dir, { recursive: true, force: true });
}

/** Writes one unpacked wheel into site-packages, with INSTALLER ("can") and a fresh RECORD. */
function writeDistribution(vfs, dist) {
  const infoEntry = dist.entries.find((e) => /^[^/]+\.dist-info\//.test(e.name));
  if (!infoEntry) throw new KernelError('EINVAL', `EINVAL: ${dist.filename} has no .dist-info folder. Next: choose another version.`);
  const distInfo = infoEntry.name.split('/')[0];
  const prefix = `${distInfo}/`;
  vfs.mkdir(SITE_PACKAGES, { recursive: true });
  const record = [];
  for (const e of dist.entries) {
    if (e.name === `${prefix}RECORD` || e.name === `${prefix}INSTALLER`) continue;
    if (/^[^/]+\.data\//.test(e.name)) continue; // .data scripts and headers are not installed in a can
    const abs = posix.join(SITE_PACKAGES, e.name);
    vfs.mkdir(posix.dirname(abs), { recursive: true });
    vfs.writeFile(abs, e.data);
    record.push(`${e.name},sha256=${recordHash(e.data)},${e.data.length}`);
  }
  const installer = Buffer.from('can\n');
  vfs.writeFile(posix.join(SITE_PACKAGES, `${prefix}INSTALLER`), installer);
  record.push(`${prefix}INSTALLER,sha256=${recordHash(installer)},${installer.length}`);
  record.push(`${prefix}RECORD,,`);
  vfs.writeFile(posix.join(SITE_PACKAGES, `${prefix}RECORD`), `${record.join('\n')}\n`);
}

// ---------------------------------------------------------------- the commands

const USAGE = 'Usage: pip install <name[==version]>... | pip install -r <requirements file> | pip list | pip --version\n'
  + 'Lock lines: name==version --hash=sha256:<hex>. Only pure-Python wheels install.\n';

/** A lock hash ("--hash=sha256:<64 hex>") as the bare hex digest, or a refusal. */
function lockHash(token) {
  const m = /^--hash=sha256:([0-9a-fA-F]{64})$/.exec(token);
  if (!m) throw new KernelError('EINVAL', `EINVAL: "${token}" is not --hash=sha256:<64 hex digits>. Next: copy the lock line from pip install.`);
  return m[1].toLowerCase();
}

/**
 * Reads install arguments: specs from the command line and from -r files. A --hash= word attaches to the spec before
 * it, as in a lock line. Options that are not supported are refused.
 */
function readInstallSpecs(args, cwd, vfs) {
  const specs = [];
  let noDeps = false;
  const addLine = (line, where) => {
    const hashes = [...line.matchAll(/--hash=\S+/g)].map((m) => lockHash(m[0]));
    const text = line.replace(/--hash=\S+/g, '').trim();
    if (text.split(/\s+/).some((t) => t.startsWith('-'))) {
      throw new KernelError('EINVAL', `EINVAL: pip option in "${line}" is not supported in a can. Next: use pip install <name==version>.`);
    }
    if (text === '') {
      if (hashes.length) throw new KernelError('EINVAL', `EINVAL: a hash needs a package on the same line (${where}). Next: write name==version --hash=sha256:<hex>.`);
      return;
    }
    specs.push({ ...parseRequirement(text, where), hashes });
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-r' || a === '--requirement') {
      const file = args[++k];
      if (file === undefined) throw new KernelError('EINVAL', 'EINVAL: -r needs a requirements file. Next: pip install -r requirements.txt.');
      const abs = posix.resolve(cwd, file);
      if (!vfs.exists(abs) || !vfs.stat(abs).isFile()) {
        throw new KernelError('ENOENT', `ENOENT: no requirements file ${file}. Next: check the path (relative to ${cwd}).`);
      }
      for (const raw of vfs.readFile(abs, 'utf8').split(/\r?\n/)) {
        const line = raw.replace(/(^|\s)#.*$/, '').trim();
        if (line) addLine(line, file);
      }
    } else if (a === '--no-deps') {
      noDeps = true;
    } else if (['-q', '--quiet', '--no-input', '--disable-pip-version-check'].includes(a)) {
      // accepted: nothing to change
    } else if (a.startsWith('--hash=')) {
      const last = specs[specs.length - 1];
      if (!last) throw new KernelError('EINVAL', `EINVAL: ${a} needs a package before it. Next: pip install name==version ${a}.`);
      last.hashes.push(lockHash(a));
    } else if (a.startsWith('-')) {
      throw new KernelError('EINVAL', `EINVAL: pip option ${a} is not supported in a can. Next: use pip install <name==version> or -r <file>.`);
    } else {
      addLine(a, 'the command line');
    }
  }
  return { specs, noDeps };
}

/**
 * Runs one pip command.
 * @param {object} o
 * @param {string[]} o.args the arguments after "pip"
 * @param {string} o.cwd the can working folder (absolute)
 * @param {object} o.vfs the can VFS
 * @param {object} o.policy the can's network policy ({internet})
 * @param {string} [o.index] the JSON index base URL (default https://pypi.org/pypi/)
 * @param {(text: string) => void} o.stdout
 * @param {(text: string) => void} o.stderr
 * @returns {Promise<number>} the exit code
 */
export async function runPip({ args, cwd, vfs, policy, index = DEFAULT_INDEX, stdout, stderr }) {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    stdout(USAGE);
    return 0;
  }
  if (cmd === '--version' || cmd === '-V' || cmd === 'version') {
    stdout('pip 24.3.1 from can (pure-Python wheels only) (python 3.15)\n');
    return 0;
  }
  if (cmd === 'list') {
    const rows = [...scanInstalled(vfs).values()].sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name)));
    const w = Math.max(7, ...rows.map((r) => r.name.length));
    stdout(`${'Package'.padEnd(w)} Version\n${'-'.repeat(w)} -------\n`);
    for (const r of rows) stdout(`${r.name.padEnd(w)} ${r.version}\n`);
    return 0;
  }
  if (cmd !== 'install') {
    throw new KernelError('EINVAL', `EINVAL: pip ${cmd} is not supported in a can. Next: use pip install, pip list or pip --version.`);
  }

  const { specs: roots, noDeps } = readInstallSpecs(rest, cwd, vfs);
  if (roots.length === 0) {
    throw new KernelError('EINVAL', 'EINVAL: pip install needs a package name or -r <file>. Next: pip install <name==version>.');
  }

  const installed = scanInstalled(vfs);
  const planned = new Map(); // normalized name -> distribution to write
  const queue = roots.map((r) => ({ ...r }));
  const notes = [];
  while (queue.length > 0) {
    const item = queue.shift();
    const key = normalizeName(item.name);
    if (planned.has(key)) {
      const have = planned.get(key);
      if (!item.specs.every((s) => specifierAllows(have.version, s))) {
        throw new KernelError('EEXIST', `EEXIST: ${item.name} is needed at version ${have.version} and at ${item.specs.map((s) => s.op + s.version).join(',')}. Next: pin one version with name==version.`);
      }
      continue;
    }
    const have = installed.get(key);
    if (have && item.specs.every((s) => specifierAllows(have.version, s))) {
      stdout(`Requirement already satisfied: ${have.name}==${have.version}\n`);
      continue;
    }
    const { version, wheel } = await resolveRelease(item, index, policy);
    const bytes = await httpGet(wheel.url, policy);
    if (bytes === null) throw new KernelError('ENOENT', `ENOENT: ${wheel.filename} is no longer on the index. Next: choose another version.`);
    const sha = sha256Hex(bytes);
    if (item.hashes.length > 0) {
      if (!item.hashes.includes(sha)) {
        throw new KernelError('EINTEGRITY', `EINTEGRITY: ${wheel.filename} has sha256 ${sha}, but the lock line says ${item.hashes.join(' or ')}. Next: check the lock line, or resolve the version again.`);
      }
    } else {
      const published = wheel.digests?.sha256;
      if (!published) throw new KernelError('EINTEGRITY', `EINTEGRITY: the index gives no sha256 for ${wheel.filename}. Next: pin it with a lock line.`);
      if (sha !== published) {
        throw new KernelError('EINTEGRITY', `EINTEGRITY: ${wheel.filename} does not match the index's sha256 (${published}). Next: do not install it; try again or choose another version.`);
      }
    }
    const entries = readZip(bytes);
    const metaEntry = entries.find((e) => /^[^/]+\.dist-info\/METADATA$/.test(e.name));
    if (!metaEntry) throw new KernelError('EINVAL', `EINVAL: ${wheel.filename} has no METADATA. Next: choose another version.`);
    const meta = parseMetadata(metaEntry.data.toString('utf8'));
    const displayName = meta.name ?? item.name;
    planned.set(key, {
      name: displayName, version, filename: wheel.filename, sha256: sha, entries, replaces: have ?? null,
    });
    if (noDeps) continue;
    for (const line of meta.requires) {
      const dep = parseRequirement(line, `the requirements of ${displayName}`);
      const applies = evalMarker(dep.marker);
      if (applies === false) continue;
      if (applies === null) {
        notes.push(`skipped ${dep.name} for ${displayName}: its marker "${dep.marker}" cannot be decided in a can`);
        continue;
      }
      queue.push({ ...dep, hashes: [] });
    }
  }

  for (const note of notes) stderr(`pip NOTE: ${note}\n`);
  for (const dist of planned.values()) {
    if (dist.replaces) uninstall(vfs, dist.replaces);
    writeDistribution(vfs, dist);
  }
  if (planned.size > 0) {
    const names = [...planned.values()].map((d) => `${d.name}-${d.version}`);
    stdout(`Successfully installed ${names.join(' ')}\n`);
    for (const d of planned.values()) stdout(`${d.name}==${d.version} --hash=sha256:${d.sha256}\n`);
  }
  return 0;
}
