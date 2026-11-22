#!/usr/bin/env node
// Node equivalent of build.cmd: compiles CanMemcap.cs into native/win/build/can-memcap.exe.
// Run on Windows: node native/win/build.js
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const systemRoot = process.env.SystemRoot || 'C:\Windows';
const csc = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

if (process.platform !== 'win32') {
  console.error('ENOTSUP: the memory helper is Windows-only. Next: skip the helper; the sampling monitor runs on this OS.');
  process.exit(1);
}
if (!fs.existsSync(csc)) {
  console.error(`ENOENT: csc.exe not found at ${csc}. Next: enable the .NET Framework 4.8 feature in Windows Features, then rerun.`);
  process.exit(1);
}

const outDir = path.join(here, 'build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'can-memcap.exe');
const result = spawnSync(csc, ['/nologo', '/optimize', '/platform:x64', '/target:exe', `/out:${out}`, path.join(here, 'CanMemcap.cs')], {
  stdio: 'inherit',
  windowsHide: true,
});
if (result.status !== 0) {
  console.error('EINVAL: csc.exe failed on CanMemcap.cs. Next: read the compiler errors above and fix the source.');
  process.exit(1);
}
console.log(`built ${out}`);
