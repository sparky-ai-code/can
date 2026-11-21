// The filesystem and environment every new can starts with. Runs inside the can VM process.
import { VFS } from '../kernel/vfs.js';

export const DEFAULT_ENV = Object.freeze({
  HOME: '/home/agent',
  USER: 'agent',
  SHELL: '/bin/sh',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  TMPDIR: '/tmp',
  LANG: 'C.UTF-8',
});

/** The filesystem a new can starts with. */
export function seedFilesystem(id) {
  const vfs = new VFS({ cwd: '/home/agent' });
  vfs.mkdir('/home/agent', { recursive: true });
  vfs.mkdir('/tmp', { recursive: true });
  vfs.chmod('/tmp', 0o1777);
  vfs.mkdir('/app', { recursive: true });
  vfs.mkdir('/etc', { recursive: true });
  vfs.writeFile('/etc/hostname', `can-${id.slice(0, 8)}\n`);
  return vfs;
}
