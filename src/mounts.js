// Host folders a can may mount, read-only. The host owns the list: a JSON file the user writes, by default
// %USERPROFILE%\.can\mounts.json (~/.can/mounts.json elsewhere), or $CAN_MOUNTS_FILE. A can (and an agent) names a
// mount only by its label. It never names a host path, so no agent can choose a folder the user did not list.
//
// File format:
//   { "mounts": { "datasets": { "path": "C:\\data\\sets", "description": "Research data, read-only" } } }
import fs from 'node:fs';
import os from 'node:os';
import path, { posix } from 'node:path';
import { KernelError } from './kernel/errors.js';

const LABEL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function defaultMountsFile() {
  return process.env.CAN_MOUNTS_FILE || path.join(os.homedir(), '.can', 'mounts.json');
}

/** Reads the allowlist. A missing file means no mounts. Returns Map label -> {hostDir, description}. */
export function readMountConfig(file = defaultMountsFile()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw new KernelError('EIO', `EIO: cannot read the mounts file (${err.code})`);
  }
  let obj;
  try {
    obj = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new KernelError('EINVAL', 'EINVAL: the mounts file is not valid JSON');
  }
  const out = new Map();
  for (const [label, entry] of Object.entries(obj?.mounts ?? {})) {
    if (!LABEL_PATTERN.test(label)) throw new KernelError('EINVAL', `EINVAL: mount label "${label}" must be letters, digits, "_" or "-"`);
    if (typeof entry?.path !== 'string' || entry.path === '') {
      throw new KernelError('EINVAL', `EINVAL: mount "${label}" needs a "path"`);
    }
    out.set(label, { hostDir: path.resolve(entry.path), description: String(entry.description ?? '') });
  }
  return out;
}

/** True when the user has enabled the host browser ("hostBrowser": true in the mounts file). Off by default. */
export function hostBrowserEnabled(file = defaultMountsFile()) {
  return flagEnabled(file, 'hostBrowser');
}

/**
 * True when cans use a real Chrome or Edge as their browser (src/canchromium.js). This is the default. The user
 * turns it off with "chromiumBrowser": false in the mounts file, which selects the can's built-in browser instead.
 */
export function chromiumBrowserEnabled(file = defaultMountsFile()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))?.chromiumBrowser !== false;
  } catch {
    return true;
  }
}

function flagEnabled(file, key) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))?.[key] === true;
  } catch {
    return false;
  }
}

/** The labels a can may mount, with descriptions. Host paths are left out. */
export function listMounts(file = defaultMountsFile()) {
  return [...readMountConfig(file)].map(([label, { description }]) => ({ label, description }));
}

/** Canonical can path of a requested mount point: absolute, normalized, not "/", no ".." left over. */
function canonicalCanPath(raw, label) {
  if (typeof raw !== 'string' || !raw.startsWith('/')) {
    throw new KernelError('EINVAL', `EINVAL: mount "${label}" needs an absolute canPath such as /data`);
  }
  const p = posix.normalize(raw).replace(/\/+$/, '') || '/';
  if (p === '/') throw new KernelError('EINVAL', `EINVAL: mount "${label}" cannot be mounted on /`);
  return p;
}

/**
 * Checks requested mounts [{label, canPath}] against the allowlist and the host. Returns
 * [{label, canPath, hostDir}] with hostDir resolved (real path). Errors name labels and can paths, never host paths.
 */
export function resolveMounts(requested = [], file = defaultMountsFile()) {
  if (!Array.isArray(requested)) throw new KernelError('EINVAL', 'EINVAL: mounts must be a list of {label, canPath}');
  if (requested.length === 0) return [];
  const config = readMountConfig(file);
  const out = [];
  for (const item of requested) {
    if (!item || typeof item !== 'object') throw new KernelError('EINVAL', 'EINVAL: each mount is {label, canPath}');
    const label = item.label;
    const entry = config.get(label);
    if (!entry) {
      throw new KernelError('ENOENT', `ENOENT: no mount "${label}" in the mounts file (labels: ${[...config.keys()].join(', ') || 'none'})`);
    }
    const canPath = canonicalCanPath(item.canPath, label);
    let hostDir;
    try {
      const st = fs.statSync(entry.hostDir);
      if (!st.isDirectory()) throw new KernelError('ENOTDIR', `ENOTDIR: mount "${label}" is not a folder`);
      hostDir = fs.realpathSync(entry.hostDir);
    } catch (err) {
      if (err instanceof KernelError) throw err;
      throw new KernelError(err.code === 'ENOENT' ? 'ENOENT' : 'EIO', `${err.code ?? 'EIO'}: mount "${label}" cannot be opened`);
    }
    for (const prev of out) {
      if (prev.canPath === canPath || canPath.startsWith(`${prev.canPath}/`) || prev.canPath.startsWith(`${canPath}/`)) {
        throw new KernelError('EINVAL', `EINVAL: mount "${label}" at ${canPath} overlaps the mount at ${prev.canPath}`);
      }
    }
    out.push({ label, canPath, hostDir });
  }
  return out;
}
