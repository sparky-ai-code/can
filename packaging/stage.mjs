#!/usr/bin/env node
// Stages the files an installer packs, from the repository root:
//
//   node packaging/stage.mjs --platform win32|darwin --node <node binary> --out <dir>
//
// Output (the same on both platforms):
//   <out>/node/node[.exe]                the Node runtime the app runs on, bundled so users need none
//   <out>/app/native/win/can-memcap.exe  Windows only: the memory helper (native/win/build.js must run first)
//   <out>/app/bin, app/src, app/skills   the CLI, the MCP server and the runtime, as in the repository
//   <out>/app/package.json, app/README.md, app/toolchains.lock.json
//   <out>/app/toolchains/<sha256>/      the tools the runtime runs (CPython for wasm32-wasip1), fetched from GitHub
//                                        with `can tools fetch` and verified against the lock. Pass --toolchains-from <dir>
//                                        to use an archive folder you already have (for example one from `can tools mirror`).
//   <out>/app/scripts/agent-setup.js     per-user setup: agent skill and MCP registration
//   <out>/cmd/can.cmd, can-mcp.cmd       Windows: command shims; the installer adds cmd/ to the user's PATH
//   <out>/shims/can, can-mcp             macOS: command shims; the .pkg installs them into /usr/local/bin
// Nothing from test/, docs/, .github/, videos or the working copy's own tooling is copied.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_ROOT_MAC = '/usr/local/lib/can';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument: ${key}`);
    opts[key.slice(2)] = argv[i + 1];
  }
  for (const required of ['platform', 'node', 'out']) {
    if (!opts[required]) throw new Error(`missing --${required}`);
  }
  if (!['win32', 'darwin'].includes(opts.platform)) throw new Error(`unsupported --platform ${opts.platform}`);
  return opts;
}

/** Windows: copies the memory helper to where src/vm/memcap.js looks for it. */
function copyMemoryHelper(out) {
  const exe = path.join(repo, 'native', 'win', 'build', 'can-memcap.exe');
  if (!fs.existsSync(exe)) throw new Error(`ENOENT: ${exe} is missing. Next: run node native/win/build.js first.`);
  const dir = path.join(out, 'app', 'native', 'win');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(exe, path.join(dir, 'can-memcap.exe'));
}

/** Windows batch shim: runs the bundled node on the app's CLI, keeping the exit code. */
function cmdShim(script) {
  return [
    '@echo off',
    `"%~dp0..\\node\\node.exe" "%~dp0..\\app\\bin\\${script}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/** macOS shell shim: runs the bundled node on the app's CLI. */
function shShim(script) {
  return `#!/bin/sh\nexec "${INSTALL_ROOT_MAC}/node/node" "${INSTALL_ROOT_MAC}/app/bin/${script}" "$@"\n`;
}

function copyApp(out) {
  const app = path.join(out, 'app');
  fs.mkdirSync(app, { recursive: true });
  for (const dir of ['bin', 'src', 'skills']) {
    fs.cpSync(path.join(repo, dir), path.join(app, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'packaging', 'agent-setup.js'), path.join(app, 'scripts', 'agent-setup.js'));
  for (const file of ['package.json', 'README.md', 'toolchains.lock.json']) {
    fs.copyFileSync(path.join(repo, file), path.join(app, file));
  }
}

/**
 * Bundles the tools into <app>/toolchains. The staged CLI does the download, so the installer holds exactly what
 * `can tools fetch` would put there: the GitHub source, verified by size and sha256 against the lock.
 */
function bundleToolchains(out, fromDir) {
  const args = [path.join(out, 'app', 'bin', 'can.js'), 'tools', 'fetch', '--source', 'github', '--into', path.join(out, 'app', 'toolchains')];
  if (fromDir) args.push('--from', path.resolve(fromDir));
  execFileSync(process.execPath, args, { stdio: 'inherit' });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const out = path.resolve(opts.out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const exe = opts.platform === 'win32' ? 'node.exe' : 'node';
  fs.mkdirSync(path.join(out, 'node'), { recursive: true });
  const nodeTarget = path.join(out, 'node', exe);
  fs.copyFileSync(path.resolve(opts.node), nodeTarget);
  if (opts.platform === 'darwin') fs.chmodSync(nodeTarget, 0o755);

  copyApp(out);
  bundleToolchains(out, opts['toolchains-from']);

  if (opts.platform === 'win32') {
    copyMemoryHelper(out);
    fs.mkdirSync(path.join(out, 'cmd'), { recursive: true });
    fs.writeFileSync(path.join(out, 'cmd', 'can.cmd'), cmdShim('can.js'));
    fs.writeFileSync(path.join(out, 'cmd', 'can-mcp.cmd'), cmdShim('can-mcp.js'));
  } else {
    fs.mkdirSync(path.join(out, 'shims'), { recursive: true });
    for (const [name, script] of [['can', 'can.js'], ['can-mcp', 'can-mcp.js']]) {
      const file = path.join(out, 'shims', name);
      fs.writeFileSync(file, shShim(script));
      fs.chmodSync(file, 0o755);
    }
  }

  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  console.log(`staged Can ${version} for ${opts.platform} at ${out}`);
}

try {
  main();
} catch (err) {
  console.error(`stage: ${err.message}`);
  process.exit(2);
}
