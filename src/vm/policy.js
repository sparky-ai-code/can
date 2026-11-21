// Per-can policy: the network and runtime settings a can was created with. It is set before the can boots
// (see src/environment.js), saved with the can's snapshot and read by the runtime (internet, registry, reported
// Node version). Pure data and checks only, so the VM child and the host can both load it.
import { KernelError } from '../kernel/errors.js';

export const DEFAULT_POLICY = Object.freeze({
  internet: true,
  registry: 'https://registry.npmjs.org/',
  nodeVersion: null, // null: the runtime's default version string (see js.js NODE_VERSION)
});

const VERSION_PATTERN = /^v?(\d{1,3})(?:\.(\d{1,4}))?(?:\.(\d{1,5}))?$/;

/**
 * Returns a complete policy from a partial one. Unknown keys are refused, so a typo in an environment spec
 * fails before the can boots instead of being ignored.
 */
export function normalizePolicy(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new KernelError('EINVAL', 'EINVAL: network and runtime settings must be an object');
  }
  const out = { ...DEFAULT_POLICY };
  for (const [key, value] of Object.entries(input)) {
    if (!(key in DEFAULT_POLICY)) {
      throw new KernelError('EINVAL', `EINVAL: unknown policy setting "${key}" (allowed: ${Object.keys(DEFAULT_POLICY).join(', ')})`);
    }
    if (key === 'internet') {
      if (typeof value !== 'boolean') throw new KernelError('EINVAL', 'EINVAL: network.internet must be true or false');
      out.internet = value;
    } else if (key === 'registry') {
      out.registry = checkRegistry(value);
    } else if (key === 'nodeVersion') {
      out.nodeVersion = value === null ? null : checkNodeVersion(value);
    }
  }
  return out;
}

/** An http or https URL. Stored with a trailing slash, so package paths can be appended. */
export function checkRegistry(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    throw new KernelError('EINVAL', `EINVAL: network.registry must be an http or https URL (got ${JSON.stringify(value)})`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new KernelError('EINVAL', 'EINVAL: network.registry must be an http or https URL');
  }
  const text = u.href;
  return text.endsWith('/') ? text : `${text}/`;
}

/** "24", "24.15", "v24.15.0" and similar. Returned as "v<major>[.<minor>[.<patch>]]". */
export function checkNodeVersion(value) {
  const m = VERSION_PATTERN.exec(String(value).trim());
  if (!m) throw new KernelError('EINVAL', `EINVAL: nodeVersion must look like "24" or "24.15.0" (got ${JSON.stringify(value)})`);
  const major = Number(m[1]);
  if (major < 18) throw new KernelError('EINVAL', `EINVAL: nodeVersion ${value} is too old; the can needs Node 18 or newer`);
  return `v${[m[1], m[2], m[3]].filter((x) => x !== undefined).join('.')}`;
}
