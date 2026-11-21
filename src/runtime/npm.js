// npm inside a can: a small registry client that installs packages from an npm registry (the can's
// network.registry, https://registry.npmjs.org/ by default). It covers what an app's dependencies need:
//   - semver ranges used in package.json (exact, ^, ~, comparators, x-ranges, hyphen ranges, ||) and dist-tags;
//   - the registry's packument and tarballs, checked against their sha512 or sha1 integrity;
//   - a flat node_modules layout with nested copies where versions conflict (like npm, without a lockfile);
//   - node_modules/.bin shims so package scripts can run `vite`, `tsc` and the like.
// Not supported, and reported as warnings or errors: install scripts (postinstall and friends never run), native
// addons (they cannot load in a can), peer dependencies (not installed), git, file and workspace specs.
// Everything here is plain data and functions. The network is reached through the `getBuffer` callback that the
// caller supplies (see runtime/builtins.js), so the planner can be tested without a network.
import zlib from 'node:zlib';
import { posix } from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { KernelError } from '../kernel/errors.js';

// ---------------------------------------------------------------- semver

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** "1.2.3-beta.1" -> {major, minor, patch, pre: ['beta', '1']}, or null when it is not a full version. */
export function parseVersion(text) {
  const m = SEMVER.exec(String(text).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a release is greater than its prereleases
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const x = a[i];
    const y = b[i];
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Orders two parsed versions: negative, zero or positive. */
export function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return comparePre(a.pre, b.pre);
}

// A range is a list of OR-sets; each set is a list of comparators {op, v} with op one of = > >= < <=.
// Partial versions and x-ranges expand into bounds, as npm does (1 -> >=1.0.0 <2.0.0-0, ~1.2 -> >=1.2.0 <1.3.0-0).
const ZERO = { major: 0, minor: 0, patch: 0, pre: [] };
const bound = (op, major, minor = 0, patch = 0, pre = []) => ({ op, v: { major, minor, patch, pre } });
const ceiling = (op, major, minor, patch) => bound(op, major, minor, patch, ['0']);

function parsePartial(text) {
  const m = /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!m) return null;
  const wild = (s) => s === undefined || s === 'x' || s === 'X' || s === '*';
  const pre = m[4] ? m[4].split('.') : [];
  return {
    major: wild(m[1]) ? null : Number(m[1]),
    minor: wild(m[2]) ? null : Number(m[2]),
    patch: wild(m[3]) ? null : Number(m[3]),
    pre,
  };
}

/** Comparators for one token (already without spaces) such as ^1.2.3, ~1, >=2.0, 1.x or 3.1.4. */
function comparatorsFor(token) {
  const m = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(token);
  const op = m[1] ?? '';
  const p = parsePartial(m[2]);
  if (!p) throw new KernelError('EINVAL', `EINVAL: unsupported version range "${token}"`);
  const { major, minor, patch, pre } = p;
  if (major === null) return [bound('>=', 0)]; // "*", "x", ">= *"
  if (op === '' || op === '=') {
    if (minor === null || patch === null) {
      return [bound('>=', major, minor ?? 0, patch ?? 0), minor === null ? ceiling('<', major + 1, 0, 0) : ceiling('<', major, minor + 1, 0)];
    }
    return [bound('=', major, minor, patch, pre)];
  }
  if (op === '^') {
    const lo = bound('>=', major, minor ?? 0, patch ?? 0, pre);
    if (major > 0 || minor === null) return [lo, ceiling('<', major + 1, 0, 0)];
    if (minor > 0 || patch === null) return [lo, ceiling('<', 0, minor + 1, 0)];
    return [lo, ceiling('<', 0, 0, patch + 1)];
  }
  if (op === '~') {
    const lo = bound('>=', major, minor ?? 0, patch ?? 0, pre);
    if (minor === null) return [lo, ceiling('<', major + 1, 0, 0)];
    return [lo, ceiling('<', major, minor + 1, 0)];
  }
  if (op === '>=') return [bound('>=', major, minor ?? 0, patch ?? 0, pre)];
  if (op === '>') {
    if (minor === null) return [bound('>=', major + 1, 0, 0)];
    if (patch === null) return [bound('>=', major, minor + 1, 0)];
    return [bound('>', major, minor, patch, pre)];
  }
  if (op === '<') {
    if (minor === null) return [bound('<', major, 0, 0)];
    if (patch === null) return [bound('<', major, minor, 0)];
    return [bound('<', major, minor, patch, pre)];
  }
  if (op === '<=') {
    if (minor === null) return [ceiling('<', major + 1, 0, 0)];
    if (patch === null) return [ceiling('<', major, minor + 1, 0)];
    return [bound('<=', major, minor, patch, pre)];
  }
  throw new KernelError('EINVAL', `EINVAL: unsupported version range "${token}"`);
}

/** Parses a range into OR-sets of comparators. Throws EINVAL for anything it does not understand. */
export function parseRange(range) {
  const text = String(range ?? '').trim();
  if (text === '' || text === '*' || text === 'x' || text === 'X') return [[bound('>=', 0)]];
  return text.split('||').map((part) => {
    const trimmed = part.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
    if (hyphen) {
      const lo = parsePartial(hyphen[1]);
      const hi = parsePartial(hyphen[2]);
      if (!lo || !hi) throw new KernelError('EINVAL', `EINVAL: unsupported version range "${range}"`);
      const out = [bound('>=', lo.major ?? 0, lo.minor ?? 0, lo.patch ?? 0, lo.pre)];
      if (hi.minor === null || hi.major === null) out.push(ceiling('<', (hi.major ?? 0) + 1, 0, 0));
      else if (hi.patch === null) out.push(ceiling('<', hi.major, hi.minor + 1, 0));
      else out.push(bound('<=', hi.major, hi.minor, hi.patch, hi.pre));
      return out;
    }
    const tokens = trimmed.replace(/(>=|<=|[<>=~^])\s+/g, '$1').split(/\s+/).filter(Boolean);
    return tokens.flatMap(comparatorsFor);
  });
}

const cmpOp = (c, v) => {
  const d = compareVersions(v, c.v);
  switch (c.op) {
    case '=': return d === 0;
    case '>': return d > 0;
    case '>=': return d >= 0;
    case '<': return d < 0;
    case '<=': return d <= 0;
    default: return false;
  }
};

/**
 * True when a version (text) satisfies a range. A prerelease version satisfies a set only when some comparator in
 * that set names a prerelease of the same major.minor.patch, which is npm's rule.
 */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  return parseRange(range).some((set) => {
    if (!set.every((c) => cmpOp(c, v))) return false;
    if (v.pre.length === 0) return true;
    return set.some((c) => c.v.pre.length > 0 && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch);
  });
}

/** The highest release version in a list that satisfies the range, or null. */
export function maxSatisfying(versions, range) {
  let best = null;
  let bestParsed = null;
  for (const text of versions) {
    if (!satisfies(text, range)) continue;
    const p = parseVersion(text);
    if (!bestParsed || compareVersions(p, bestParsed) > 0) {
      best = text;
      bestParsed = p;
    }
  }
  return best;
}

const TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;
/** A dist-tag name such as "latest" or "next" (letters first, no digits-only or range syntax). */
export const isTag = (range) => TAG.test(String(range ?? '')) && !['x', 'X'].includes(range);

// npm's package name rule: an optional @scope/ and then a name of letters, digits and . _ ~ - (at most 214 characters).
// The name becomes a folder under node_modules, so anything that could climb out of it ("..", "/", "\") is refused.
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
export const isPackageName = (name) => typeof name === 'string' && name.length <= 214 && PACKAGE_NAME.test(name);

// ---------------------------------------------------------------- tarballs

const cstr = (buf, start, len) => {
  const end = buf.indexOf(0, start);
  return buf.subarray(start, end === -1 || end > start + len ? start + len : end).toString('utf8');
};

function octal(buf, start, len) {
  const text = cstr(buf, start, len).replace(/[\s\0]+$/g, '').trim();
  if (text === '') return 0;
  const n = Number.parseInt(text, 8);
  if (!Number.isFinite(n)) throw new KernelError('EINVAL', 'EINVAL: corrupt tar header');
  return n;
}

function parsePax(data) {
  const out = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const len = Number.parseInt(data.subarray(at, space).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.subarray(space + 1, at + len - 1).toString('utf8'); // drop the trailing newline
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

/**
 * Reads the regular files and directories of a gzipped tar (an npm tarball). Returns [{path, type, data}] with
 * paths relative to the package root (npm tarballs put everything under one "package/" folder, which is removed).
 * Links and devices are skipped. Paths that leave the package (absolute or containing "..") are refused.
 */
export function readTarball(gzipped) {
  let tar;
  try {
    tar = zlib.gunzipSync(gzipped);
  } catch {
    throw new KernelError('EINVAL', 'EINVAL: the package tarball is not gzip data');
  }
  const out = [];
  let off = 0;
  let pax = null;
  let longName = null;
  while (off + 512 <= tar.length) {
    const hdr = tar.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    let name = cstr(hdr, 0, 100);
    const size = octal(hdr, 124, 12);
    const typeByte = hdr[156];
    const type = typeByte === 0 || typeByte === undefined ? '0' : String.fromCharCode(typeByte);
    if (cstr(hdr, 257, 6).startsWith('ustar')) {
      const prefix = cstr(hdr, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const start = off + 512;
    const data = tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    const full = pax?.path ?? longName ?? name;
    pax = null;
    longName = null;
    if (type !== '0' && type !== '5') continue;
    const parts = full.split('/').filter((p) => p !== '' && p !== '.');
    if (parts.length && (full.startsWith('/') || parts.includes('..'))) {
      throw new KernelError('EPERM', `EPERM: refusing tarball entry "${full}": it leaves the package`);
    }
    if (parts.length <= 1) continue; // the package folder itself
    out.push({ path: parts.slice(1).join('/'), type: type === '5' ? 'dir' : 'file', data: type === '5' ? null : Buffer.from(data) });
  }
  return out;
}

/** Checks a tarball against the registry's integrity (sha512-<base64>) or shasum (sha1 hex). */
export function verifyIntegrity(bytes, dist = {}) {
  if (typeof dist.integrity === 'string') {
    const [algo, b64] = dist.integrity.split(/-(.*)/s);
    if (algo === 'sha512' || algo === 'sha384' || algo === 'sha256') {
      const got = crypto.createHash(algo).update(bytes).digest('base64');
      if (got !== b64) throw new KernelError('EINTEGRITY', `EINTEGRITY: sha512 integrity check failed for ${dist.tarball ?? 'a package'}`);
      return;
    }
  }
  if (typeof dist.shasum === 'string') {
    const got = crypto.createHash('sha1').update(bytes).digest('hex');
    if (got !== dist.shasum) throw new KernelError('EINTEGRITY', `EINTEGRITY: sha1 check failed for ${dist.tarball ?? 'a package'}`);
  }
}

// ---------------------------------------------------------------- resolution

/** npm's os and cpu fields: a list where "!x" excludes x. Returns true when this platform may install it. */
export function platformAllows(list, here) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const deny = list.filter((x) => typeof x === 'string' && x.startsWith('!')).map((x) => x.slice(1));
  const allow = list.filter((x) => typeof x === 'string' && !x.startsWith('!'));
  if (deny.includes(here)) return false;
  return allow.length === 0 || allow.includes(here);
}

/**
 * Splits an npm alias spec into the registry package and its range: "npm:wrap-ansi@^7" -> {real: "wrap-ansi",
 * range: "^7"}, "npm:@scope/pkg" -> {real: "@scope/pkg", range: "latest"}. Null when the spec is not an alias.
 */
export function parseAlias(spec) {
  const m = /^npm:((?:@[^/@\s]+\/)?[^@/\s]+)(?:@(.+))?$/.exec(String(spec ?? ''));
  if (!m) return null;
  return { real: m[1], range: m[2] ?? 'latest' };
}

/** The package path for a placement: node_modules/<name>, nested under the requester's folder when needed. */
const nodeModulesFor = (dir) => (dir ? `${dir}/node_modules` : 'node_modules');

/**
 * Plans the flat-with-nesting layout for a set of root dependencies. Each package's manifest comes from the
 * registry packument (via getPackument, cached per name). Returns Map<path, entry> with entry = {path, nmDir, name,
 * version, manifest, dist, dev, optional, requestedBy}, plus warnings.
 *
 * @param {object} opts
 * @param {Array<{name: string, range?: string, dev?: boolean}>} opts.roots direct dependencies of the project
 * @param {(name: string) => Promise<object>} opts.getPackument returns the registry's document for a package
 */
export async function planTree({ roots, getPackument }) {
  const packuments = new Map();
  const packument = async (name) => {
    if (!packuments.has(name)) packuments.set(name, getPackument(name));
    return packuments.get(name);
  };
  const placed = new Map(); // path -> entry
  const parentOf = new Map(); // package dir -> dir of the package that requested it ('' for the project)
  const warnings = [];
  const queue = roots.map((r) => ({
    name: r.name, range: r.range ?? 'latest', from: '', dev: r.dev === true, optional: false, requestedBy: 'package.json',
  }));

  const pick = async (name, range) => {
    if (typeof range === 'string' && /^(npm:|git|file:|link:|workspace:|https?:|github:|\.{0,2}\/)/.test(range)) {
      throw new KernelError('EUNSUPPORTED', `EUNSUPPORTED: ${name}@${range}: only registry versions, dist-tags and npm: aliases are supported in a can (git, file, link, workspace, URL and path specs are not)`);
    }
    const pk = await packument(name);
    if (!pk || !pk.versions) throw new KernelError('ETARGET', `ETARGET: no registry entry for ${name}`);
    if (isTag(range)) {
      const v = pk['dist-tags']?.[range];
      if (!v || !pk.versions[v]) throw new KernelError('ETARGET', `ETARGET: no version tagged "${range}" for ${name}`);
      return v;
    }
    if (pk.versions[range]) return range;
    const v = maxSatisfying(Object.keys(pk.versions), range);
    if (!v) throw new KernelError('ETARGET', `ETARGET: no version of ${name} satisfies "${range}"`);
    return v;
  };

  const visible = (from, name) => {
    let dir = from;
    for (;;) {
      const p = `${nodeModulesFor(dir)}/${name}`;
      if (placed.has(p)) return placed.get(p);
      if (dir === '') return undefined;
      dir = parentOf.get(dir) ?? '';
    }
  };

  while (queue.length > 0) {
    const item = queue.shift();
    if (!isPackageName(item.name)) {
      throw new KernelError('EINVAL', `EINVAL: ${JSON.stringify(item.name)} is not a valid package name (required by ${item.requestedBy})`);
    }
    // An npm alias ("wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0") is installed from the registry package it names,
    // under the alias name. Everything after this line works on the registry name (`real`) and the range.
    const alias = parseAlias(item.range);
    if (alias && !isPackageName(alias.real)) {
      throw new KernelError('EUNSUPPORTED', `EUNSUPPORTED: ${item.name}@${item.range}: "${alias.real}" is not a valid package name (required by ${item.requestedBy})`);
    }
    const real = alias ? alias.real : item.name;
    const range = alias ? alias.range : item.range;
    let version;
    let pk;
    try {
      version = await pick(real, range);
      pk = await packument(real);
    } catch (err) {
      if (item.optional) {
        warnings.push(`skipped optional ${item.name}@${item.range}: ${err.message}`);
        continue;
      }
      err.message = `${err.message} (required by ${item.requestedBy})`;
      throw err;
    }
    const manifest = pk.versions[version];
    const have = visible(item.from, item.name);
    if (have && (have.version === version || (!isTag(range) && satisfies(have.version, range)))) {
      if (item.dev && !have.dev) have.dev = true;
      continue;
    }

    if (!platformAllows(manifest.os, 'linux') || !platformAllows(manifest.cpu, 'x64')) {
      warnings.push(`skipped ${item.name}@${version}: it does not support this platform (linux x64)`);
      continue;
    }

    // Hoist to the project's node_modules when that name is free; otherwise nest under the requester.
    const rootSlot = `node_modules/${item.name}`;
    const hoisted = !placed.has(rootSlot);
    const path = hoisted ? rootSlot : `${nodeModulesFor(item.from)}/${item.name}`;
    if (placed.has(path)) {
      throw new KernelError('EEXIST', `EEXIST: could not place ${item.name}@${version} at ${path}`);
    }
    const dir = path;
    const entry = {
      path,
      nmDir: hoisted ? 'node_modules' : nodeModulesFor(item.from),
      name: item.name,
      real,
      version,
      manifest,
      dist: manifest.dist ?? {},
      dev: item.dev,
      optional: item.optional,
      requestedBy: item.requestedBy,
    };
    placed.set(path, entry);
    parentOf.set(dir, item.from);

    for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
      queue.push({ name: dep, range, from: dir, dev: item.dev, optional: false, requestedBy: `${item.name}@${version}` });
    }
    for (const [dep, range] of Object.entries(manifest.optionalDependencies ?? {})) {
      queue.push({ name: dep, range, from: dir, dev: item.dev, optional: true, requestedBy: `${item.name}@${version}` });
    }
  }
  return { placed, warnings };
}

/** Shell-free shim for a package bin: it runs the bin script with argv[1] set to the script, as node does. */
export function binShim(target) {
  const literal = JSON.stringify(target);
  return `process.argv.splice(1, 1, ${literal});\nrequire(${literal});\n`;
}

/** Lifecycle scripts a package would run on install. None run in a can. */
export function installScripts(manifest) {
  const s = manifest?.scripts ?? {};
  return ['preinstall', 'install', 'postinstall'].filter((k) => typeof s[k] === 'string');
}

/** Name of a scoped or plain package as it appears in a registry URL (@scope/name -> @scope%2fname). */
export const registryName = (name) => name.replace('/', '%2f');

/** The bins a manifest declares, as [[name, relativePath]]. A string bin takes the package name. */
export function binsOf(manifest) {
  const bin = manifest?.bin;
  let pairs = [];
  if (typeof bin === 'string') pairs = [[manifest.name?.split('/').pop(), bin]];
  else if (bin && typeof bin === 'object') pairs = Object.entries(bin);
  return pairs.filter(([name, rel]) => typeof name === 'string' && /^[A-Za-z0-9@._-]+$/.test(name) && typeof rel === 'string' && !rel.split('/').includes('..'));
}

/**
 * Writes the planned packages into a can filesystem under cwd. Each tarball is fetched with getTarball(url),
 * checked against its integrity and unpacked. Returns {count, warnings}. Packages are written in plan order, so
 * a folder exists before anything nested in it. Existing files are replaced; nothing is pruned.
 * @param {object} opts
 * @param {Map<string, object>} opts.placed from planTree
 * @param {{mkdir: Function, writeFile: Function, exists: Function}} opts.vfs the can filesystem
 * @param {string} opts.cwd absolute can path of the project
 * @param {(url: string) => Promise<Buffer>} opts.getTarball
 */
export async function materialize({ placed, vfs, cwd, getTarball, warnings = [] }) {
  let count = 0;
  for (const entry of placed.values()) {
    const bytes = await getTarball(entry.dist.tarball, entry.name, entry.version);
    verifyIntegrity(bytes, entry.dist);
    const root = posix.join(cwd, entry.path);
    vfs.mkdir(root, { recursive: true });
    for (const f of readTarball(bytes)) {
      const abs = posix.join(root, f.path);
      if (f.type === 'dir') {
        vfs.mkdir(abs, { recursive: true });
      } else {
        vfs.mkdir(posix.dirname(abs), { recursive: true });
        vfs.writeFile(abs, f.data);
      }
    }
    count++;
    const scripts = installScripts(entry.manifest);
    if (scripts.length) warnings.push(`${entry.name}@${entry.version} has ${scripts.join(' and ')} script(s); scripts do not run in a can`);
    for (const [binName, rel] of binsOf(entry.manifest)) {
      const target = posix.join(root, rel);
      if (!vfs.exists(target)) continue;
      const binDir = posix.join(cwd, entry.nmDir, '.bin');
      vfs.mkdir(binDir, { recursive: true });
      vfs.writeFile(posix.join(binDir, binName), binShim(target));
    }
  }
  return { count, warnings };
}


