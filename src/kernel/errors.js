// Shared error type for kernel modules. Shaped like Node's system errors:
// a `code` such as 'ENOENT', a readable message, and optional extra fields
// (syscall, path, dest, port, pid).

export class KernelError extends Error {
  constructor(code, message, props = {}) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
    Object.assign(this, props);
  }
}

const DESCRIPTIONS = {
  EACCES: 'permission denied',
  EADDRINUSE: 'address already in use',
  ECONNREFUSED: 'connection refused',
  EEXIST: 'file already exists',
  EFBIG: 'file too large',
  EINVAL: 'invalid argument',
  EIO: 'input/output error',
  EISDIR: 'illegal operation on a directory',
  ELOOP: 'too many symbolic links encountered',
  ENOENT: 'no such file or directory',
  ENOTDIR: 'not a directory',
  ENOTEMPTY: 'directory not empty',
  EPERM: 'operation not permitted',
  EROFS: 'read-only file system',
  ESRCH: 'no such process',
  ETIMEDOUT: 'operation timed out',
};

/** Node-style fs error, e.g. "ENOENT: no such file or directory, open '/x'". */
export function fsError(code, syscall, path, dest) {
  const where = dest === undefined ? `'${path}'` : `'${path}' -> '${dest}'`;
  const props = { syscall, path };
  if (dest !== undefined) props.dest = dest;
  return new KernelError(code, `${code}: ${DESCRIPTIONS[code] ?? 'error'}, ${syscall} ${where}`, props);
}
