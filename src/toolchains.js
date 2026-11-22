// Tools the runtime runs, such as CPython for wasm32-wasip1. The lock file (toolchains.lock.json at the app root) names
// each archive by its sha256. A copy is found in two places, in this order:
//   1. the bundled copy: <app>/toolchains/<sha256>/ (shipped with the installers, or built with `can tools fetch`)
//   2. the cache: ~/.can/toolchains/<sha256>/ (or $CAN_TOOLCHAIN_DIR)
// resolveTool never downloads. Downloads happen only when the user runs a `can tools` command (fetchTools, mirrorTools).
// Each unpacked copy has a manifest (.can-manifest.json) with the sha256 of every file, which `can tools verify` checks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const MANIFEST = '.can-manifest.json';
const SHA256 = /^[0-9a-f]{64}$/;

/** An error whose message has the form `CODE: what happened. Next: what to do.` */
export function toolError(code, message, next) {
  const err = new Error(`${code}: ${message}. Next: ${next}`);
  err.code = code;
  return err;
}

export function lockFilePath() {
  return process.env.CAN_TOOLCHAIN_LOCK || path.join(APP_ROOT, 'toolchains.lock.json');
}

/** The bundled copies: <app>/toolchains (or $CAN_TOOLCHAIN_BUNDLE_DIR). */
export function bundleDir() {
  return process.env.CAN_TOOLCHAIN_BUNDLE_DIR || path.join(APP_ROOT, 'toolchains');
}

/** The cache: ~/.can/toolchains, or $CAN_TOOLCHAIN_DIR. */
export function cacheDir() {
  return process.env.CAN_TOOLCHAIN_DIR || path.join(os.homedir(), '.can', 'toolchains');
}

/** The CLI config: ~/.can/config.json, or $CAN_CONFIG_FILE. */
export function configFilePath() {
  return process.env.CAN_CONFIG_FILE || path.join(os.homedir(), '.can', 'config.json');
}

function validateEntry(e, file, i) {
  const where = `${file} entry ${i}`;
  if (!e || typeof e !== 'object') throw toolError('EINVAL', `${where} is not an object`, 'restore toolchains.lock.json from the repository');
  for (const key of ['name', 'version', 'file']) {
    if (typeof e[key] !== 'string' || e[key] === '') {
      throw toolError('EINVAL', `${where} has no ${key}`, 'restore toolchains.lock.json from the repository');
    }
  }
  if (e.file !== path.basename(e.file) || e.file.includes('/') || e.file.includes('\\')) {
    throw toolError('EINVAL', `${where} file "${e.file}" is not a plain file name`, 'use a file name with no folders');
  }
  if (!Number.isSafeInteger(e.size) || e.size < 0) throw toolError('EINVAL', `${where} has no valid size`, 'restore toolchains.lock.json from the repository');
  if (typeof e.sha256 !== 'string' || !SHA256.test(e.sha256)) {
    throw toolError('EINVAL', `${where} has no valid sha256`, 'restore toolchains.lock.json from the repository');
  }
  if (!e.sources || typeof e.sources !== 'object') e.sources = {};
  return e;
}

/** The entries of toolchains.lock.json: {name, version, file, size, sha256, sources: {github: url}}. */
export function lockEntries() {
  const file = lockFilePath();
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') throw toolError('ENOENT', `${file} is missing`, 'restore toolchains.lock.json from the repository');
    throw toolError('EINVAL', `${file} is not valid JSON`, 'restore toolchains.lock.json from the repository');
  }
  if (!doc || !Array.isArray(doc.entries)) throw toolError('EINVAL', `${file} has no entries list`, 'restore toolchains.lock.json from the repository');
  return doc.entries.map((e, i) => validateEntry(e, file, i));
}

function versionParts(v) {
  return v.split('.').map((n) => Number(n));
}

function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds an installed copy of a tool. `versionSpec` may be exact ("3.15.2") or a prefix ("3.15"). Without a spec,
 * the lock must have one entry for the name. Returns {name, version, dir}. Never downloads.
 */
export async function resolveTool(name, versionSpec) {
  const entries = lockEntries().filter((e) => e.name === name);
  if (entries.length === 0) {
    throw toolError('ENOENT', `no tool named "${name}" is in toolchains.lock.json`, 'run can tools list to see the tools this build knows');
  }
  const want = versionSpec === undefined || versionSpec === null ? null : String(versionSpec);
  const matches = want === null
    ? entries
    : entries.filter((e) => e.version === want || e.version.startsWith(`${want}.`));
  if (matches.length === 0) {
    const have = entries.map((e) => `${e.name} ${e.version}`).join(', ');
    throw toolError('ENOTSUP', `${name} ${want} is not in the lock (available: ${have})`, `ask for one of those versions, such as {"${name}": "${entries[0].version}"}`);
  }
  matches.sort((a, b) => compareVersions(b.version, a.version));
  const entry = matches[0];
  for (const base of [bundleDir(), cacheDir()]) {
    const dir = path.join(base, entry.sha256);
    if (dirExists(dir)) return { name: entry.name, version: entry.version, dir };
  }
  throw toolError('ENOENT', `${entry.name} ${entry.version} is not installed`, `run can tools fetch ${entry.name} (the runtime never downloads tools by itself)`);
}

// ---- source and config -------------------------------------------------------------------------------------------

function readConfig() {
  const file = configFilePath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw toolError('EIO', `cannot read ${file} (${err.code})`, 'check the file permissions');
  }
  try {
    const obj = JSON.parse(text.replace(/^﻿/, '') || '{}');
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
    return obj;
  } catch {
    throw toolError('EINVAL', `${file} is not a JSON object`, 'fix or delete the file');
  }
}

/** Checks a source: "github" or an http(s) mirror base URL. Returns the normalized source. */
export function parseSource(value) {
  if (value === 'github') return 'github';
  if (typeof value === 'string' && /^https?:\/\/[^\s/]+/i.test(value)) return value.replace(/\/+$/, '');
  throw toolError('EINVAL', `source "${value}" is neither github nor an http(s) URL`, 'use can tools source github, or can tools source https://host/path');
}

/** The default source for fetches: toolchainSource in the config file, else github. */
export function configuredSource() {
  const value = readConfig().toolchainSource;
  return value === undefined ? 'github' : parseSource(value);
}

/** Saves the default source to the config file, keeping other keys. */
export function setConfiguredSource(value) {
  const source = parseSource(value);
  const cfg = readConfig();
  cfg.toolchainSource = source;
  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return source;
}

function urlFor(entry, source) {
  if (source === 'github') {
    const url = entry.sources?.github;
    if (!url) throw toolError('EINVAL', `${entry.name} ${entry.version} has no github source in the lock`, 'use a mirror with can tools source <url>');
    return url;
  }
  return `${source}/${entry.file}`;
}

// ---- downloads and archives -------------------------------------------------------------------------------------

const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ECONNABORTED']);

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'the source';
  }
}

function networkError(url, err) {
  const code = err.code || err.message;
  const next = 'check the network or proxy and run the command again, or point at a mirror with can tools source <url>';
  if (NETWORK_CODES.has(err.code)) return toolError('ENETUNREACH', `could not reach ${hostOf(url)} (${code})`, next);
  return toolError('EIO', `download from ${hostOf(url)} failed (${code})`, next);
}

/** Streams url to dest, returning the byte count and sha256. Follows redirects. Refuses more bytes than expected. */
function download(url, dest, expectedSize, redirects = 5) {
  return new Promise((resolve, reject) => {
    let protocol;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return reject(toolError('EINVAL', `${url} is not a URL`, 'use an https:// or http:// source'));
    }
    if (protocol !== 'https:' && protocol !== 'http:') {
      return reject(toolError('EINVAL', `${url} is not http or https`, 'use an https:// or http:// source'));
    }
    const client = protocol === 'https:' ? https : http;
    const req = client.get(url, { headers: { 'user-agent': 'can-toolchains' } }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(toolError('EIO', `too many redirects from ${hostOf(url)}`, 'check the source with can tools source'));
        return download(new URL(res.headers.location, url).href, dest, expectedSize, redirects - 1).then(resolve, reject);
      }
      if (status !== 200) {
        res.resume();
        return reject(toolError('EIO', `${hostOf(url)} answered HTTP ${status} for ${path.basename(dest).replace(/\.part.*$/, '')}`, 'check the file exists on that source, or choose another with can tools source'));
      }
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(dest);
      let bytes = 0;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        res.destroy();
        out.destroy();
        reject(err);
      };
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > expectedSize) {
          fail(toolError('EINTEGRITY', `${hostOf(url)} sent more than the ${expectedSize} bytes the lock expects`, 'do not use this source; check the lock or the mirror'));
          return;
        }
        hash.update(chunk);
      });
      res.on('error', (err) => fail(networkError(url, err)));
      out.on('error', (err) => fail(toolError('EIO', `cannot write ${dest} (${err.code})`, 'check free disk space and the folder permissions')));
      out.on('finish', () => {
        if (!failed) resolve({ size: bytes, sha256: hash.digest('hex') });
      });
      res.pipe(out);
    });
    req.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', (err) => reject(networkError(url, err)));
  });
}

/** Checks a file against a lock entry: size first, then sha256. */
async function checkArchive(file, entry) {
  const size = fs.statSync(file).size;
  if (size !== entry.size) {
    throw toolError('EINTEGRITY', `${entry.file} is ${size} bytes, the lock expects ${entry.size}`, 'the file is damaged or is not the lock\'s file; fetch it again');
  }
  const sha256 = await hashFile(file);
  if (sha256 !== entry.sha256) {
    throw toolError('EINTEGRITY', `${entry.file} has sha256 ${sha256}, the lock expects ${entry.sha256}`, 'the file is damaged or is not the lock\'s file; fetch it again');
  }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function tarBinary() {
  if (process.platform === 'win32') {
    const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(bsdtar)) return bsdtar;
  }
  return 'tar';
}

function runTar(args) {
  return new Promise((resolve, reject) => {
    execFile(tarBinary(), args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr || '') }));
      else resolve(stdout);
    });
  });
}

/** Walks a folder. Returns {files: [{rel, abs}], bad: [rel]} where bad holds links and other special entries. */
function walk(root) {
  const files = [];
  const bad = [];
  const visit = (dir, prefix) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      if (d.isSymbolicLink()) bad.push(rel);
      else if (d.isDirectory()) visit(abs, rel);
      else if (d.isFile()) files.push({ rel, abs });
      else bad.push(rel);
    }
  };
  visit(root, '');
  return { files: files.filter((f) => f.rel !== MANIFEST), bad };
}

/** Unpacks a verified archive into an empty folder and writes the manifest. Refuses links and paths that leave it. */
async function unpack(archive, entry, outDir) {
  let listing;
  try {
    listing = await runTar(['-tf', archive]);
  } catch (err) {
    throw toolError('EIO', `cannot read ${entry.file} as an archive (${(err.stderr || err.message).trim().split('\n')[0]})`, 'the file is not a zip; fetch it again, and check tar.exe or bsdtar is installed');
  }
  for (const name of listing.split(/\r?\n/).filter(Boolean)) {
    const parts = name.split(/[\\/]+/);
    if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || parts.includes('..')) {
      throw toolError('EINVAL', `${entry.file} has an entry "${name}" that leaves its folder`, 'do not use this archive; report it to the lock file owner');
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  try {
    await runTar(['-xf', archive, '-C', outDir]);
  } catch (err) {
    throw toolError('EIO', `cannot unpack ${entry.file} (${(err.stderr || err.message).trim().split('\n')[0]})`, 'check free disk space, then run the command again');
  }
  const { files, bad } = walk(outDir);
  if (bad.length) {
    throw toolError('EINVAL', `${entry.file} contains links or special files (${bad[0]})`, 'do not use this archive; report it to the lock file owner');
  }
  const manifest = { lockVersion: 1, name: entry.name, version: entry.version, sha256: entry.sha256, files: {} };
  for (const f of files) manifest.files[f.rel] = await hashFile(f.abs);
  fs.writeFileSync(path.join(outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Re-hashes an unpacked copy against its manifest. Returns {ok, files, problems}. */
export async function verifyDir(dir, entry) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  } catch {
    return { ok: false, files: 0, problems: ['no readable manifest'] };
  }
  if (manifest.sha256 !== entry.sha256) problems.push('manifest belongs to another archive');
  const { files, bad } = walk(dir);
  for (const rel of bad) problems.push(`${rel} is a link or special file`);
  const seen = new Set();
  for (const f of files) {
    seen.add(f.rel);
    if (!(f.rel in manifest.files)) {
      problems.push(`${f.rel} is not in the manifest`);
      continue;
    }
    if ((await hashFile(f.abs)) !== manifest.files[f.rel]) problems.push(`${f.rel} changed`);
  }
  for (const rel of Object.keys(manifest.files)) {
    if (!seen.has(rel)) problems.push(`${rel} is missing`);
  }
  return { ok: problems.length === 0, files: files.length, problems };
}

// ---- locks ------------------------------------------------------------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLockPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Takes the per-entry lock file (it holds the pid). A lock whose pid is gone is removed. Waits up to timeoutMs,
 * then fails with EBUSY.
 */
async function acquireLock(file, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      return { release: () => fs.rmSync(file, { force: true }) };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const owner = readLockPid(file);
    if (owner !== null && !pidAlive(owner)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (owner === null) {
      // Empty or unreadable: another process may be writing it. Remove it only once it is clearly stale.
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > 10_000) fs.rmSync(file, { force: true });
      } catch {
        // gone already
      }
    }
    if (Date.now() >= deadline) {
      throw toolError('EBUSY', `another can process is fetching ${label} (pid ${owner ?? 'unknown'})`, `wait for it to finish and run the command again; if that process is gone, delete ${file}`);
    }
    await sleep(100);
  }
}

// ---- install, fetch, mirror, verify -----------------------------------------------------------------------------

function rmdirIfEmpty(dir) {
  try {
    fs.rmdirSync(dir);
  } catch {
    // not empty, or missing
  }
}

async function installOne(entry, { source, into, from, lockTimeoutMs }) {
  const finalDir = path.join(into, entry.sha256);
  if (dirExists(finalDir)) return { dir: finalDir, status: 'present' };
  const label = `${entry.name} ${entry.version}`;
  const locks = path.join(into, '.locks');
  const tmp = path.join(into, '.tmp');
  fs.mkdirSync(locks, { recursive: true });
  const lock = await acquireLock(path.join(locks, `${entry.sha256}.lock`), label, lockTimeoutMs);
  const tag = `${entry.sha256.slice(0, 16)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let archive = null;
  let ownArchive = false;
  let work = null;
  try {
    if (dirExists(finalDir)) return { dir: finalDir, status: 'present' };
    fs.mkdirSync(tmp, { recursive: true });
    const local = from ? path.join(from, entry.file) : null;
    if (local && fs.existsSync(local)) {
      archive = local; // a verified copy the user already has (for example from `can tools mirror`)
      await checkArchive(archive, entry);
    } else {
      archive = path.join(tmp, `${tag}.zip`);
      ownArchive = true;
      const part = `${archive}.part`;
      const got = await download(urlFor(entry, source), part, entry.size);
      if (got.size !== entry.size || got.sha256 !== entry.sha256) {
        fs.rmSync(part, { force: true });
        throw toolError('EINTEGRITY', `${entry.file} from ${hostOf(urlFor(entry, source))} is ${got.size} bytes, sha256 ${got.sha256}; the lock expects ${entry.size} bytes, sha256 ${entry.sha256}`, 'the source has a different file; check the source with can tools source, or update toolchains.lock.json');
      }
      fs.renameSync(part, archive);
    }
    work = path.join(tmp, `${tag}.dir`);
    await unpack(archive, entry, work);
    fs.mkdirSync(into, { recursive: true });
    try {
      fs.renameSync(work, finalDir);
    } catch (err) {
      if (!dirExists(finalDir)) throw err; // another process finished first; its copy is complete
    }
    return { dir: finalDir, status: 'fetched' };
  } finally {
    lock.release();
    if (work) fs.rmSync(work, { recursive: true, force: true });
    if (ownArchive) fs.rmSync(archive, { force: true });
    if (ownArchive) fs.rmSync(`${archive}.part`, { force: true });
    rmdirIfEmpty(tmp);
    rmdirIfEmpty(locks);
  }
}

/**
 * Downloads (or reuses from `from`), verifies and unpacks tools into `into` (default: the cache). `source` is
 * "github" or a mirror base URL; a mirror serves each file at <base>/<file>. `names` limits the set.
 * Returns [{name, version, sha256, dir, status: 'fetched' | 'present'}]. Only the CLI calls this.
 */
export async function fetchTools({ source, names, into, from, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
  const src = parseSource(source ?? configuredSource());
  const all = lockEntries();
  let chosen = all;
  if (names && names.length) {
    chosen = names.flatMap((n) => {
      const found = all.filter((e) => e.name === n);
      if (found.length === 0) throw toolError('ENOENT', `no tool named "${n}" is in toolchains.lock.json`, 'run can tools list to see the tools this build knows');
      return found;
    });
  }
  const root = path.resolve(into ?? cacheDir());
  const out = [];
  for (const entry of chosen) {
    const r = await installOne(entry, { source: src, into: root, from: from ? path.resolve(from) : null, lockTimeoutMs });
    out.push({ name: entry.name, version: entry.version, sha256: entry.sha256, dir: r.dir, status: r.status });
  }
  return out;
}

/** Downloads every lock entry, verified, into `dir` as archives, so the user can serve them as a mirror. */
export async function mirrorTools(dir, { source = 'github' } = {}) {
  const src = parseSource(source);
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  const out = [];
  for (const entry of lockEntries()) {
    const dest = path.join(root, entry.file);
    let status = 'fetched';
    try {
      await checkArchive(dest, entry);
      status = 'present';
    } catch {
      const part = `${dest}.${process.pid}.part`;
      try {
        const got = await download(urlFor(entry, src), part, entry.size);
        if (got.size !== entry.size || got.sha256 !== entry.sha256) {
          throw toolError('EINTEGRITY', `${entry.file} from ${hostOf(urlFor(entry, src))} does not match the lock (${got.size} bytes, sha256 ${got.sha256})`, 'the source has a different file; check the source or the lock');
        }
        fs.renameSync(part, dest);
      } finally {
        fs.rmSync(part, { force: true });
      }
    }
    out.push({ name: entry.name, version: entry.version, file: dest, status });
  }
  return out;
}

/** The lock entries with where each copy is: bundled and/or cached. */
export function listTools() {
  return lockEntries().map((entry) => ({
    ...entry,
    bundled: dirExists(path.join(bundleDir(), entry.sha256)),
    cached: dirExists(path.join(cacheDir(), entry.sha256)),
  }));
}

/** Re-hashes every present copy (bundled and cached). Returns [{name, version, where, dir, ok, files, problems}]. */
export async function verifyTools() {
  const out = [];
  for (const entry of lockEntries()) {
    for (const [where, base] of [['bundled', bundleDir()], ['cached', cacheDir()]]) {
      const dir = path.join(base, entry.sha256);
      if (!dirExists(dir)) continue;
      const r = await verifyDir(dir, entry);
      out.push({ name: entry.name, version: entry.version, where, dir, ...r });
    }
  }
  return out;
}
