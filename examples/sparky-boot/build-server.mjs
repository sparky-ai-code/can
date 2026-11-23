// Host-side build of a Sparky-shaped server into ONE ESM file that a can can load.
//
// Usage (on the host, with the app's dependencies already installed):
//   node build-server.mjs <appRoot> <outFile>
//
// <appRoot> is the monorepo root (the folder with pnpm-workspace.yaml). The server entry is
// <appRoot>/apps/server/src/bin.ts. Native addons that a can cannot load are replaced by the stubs in ./stubs:
// node-pty, @ff-labs/fff-node, electron, rcedit, and bun:sqlite (Bun only). Everything else is bundled, so the can
// needs no node_modules. The bundle must sit at <can>/app/apps/server/dist/bin.mjs, with the web build at
// <can>/app/apps/web/dist, because the server finds its UI relative to its own file.
//
// rolldown is loaded from the pnpm store of the app (it is a dependency of vite-plus), so no tool is installed here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [appRoot, outFile] = process.argv.slice(2);
if (!appRoot || !outFile) {
  console.error('usage: node build-server.mjs <appRoot> <outFile>');
  process.exit(2);
}

const rolldownDir = fs.readdirSync(path.join(appRoot, 'node_modules/.pnpm'))
  .filter((name) => /^rolldown@\d/.test(name))
  .sort()
  .pop();
if (!rolldownDir) throw new Error('rolldown is not installed under node_modules/.pnpm; run pnpm install first');
const { rolldown } = await import(pathToFileURL(
  path.join(appRoot, 'node_modules/.pnpm', rolldownDir, 'node_modules/rolldown/dist/index.mjs')).href);

const stubs = path.join(here, 'stubs');
const bundle = await rolldown({
  input: path.join(appRoot, 'apps/server/src/bin.ts'),
  platform: 'node',
  resolve: {
    alias: {
      'node-pty': path.join(stubs, 'node-pty.mjs'),
      '@ff-labs/fff-node': path.join(stubs, 'fff.mjs'),
      electron: path.join(stubs, 'empty.mjs'),
      rcedit: path.join(stubs, 'empty.mjs'),
      'bun:sqlite': path.join(stubs, 'bun-sqlite.mjs'),
    },
  },
  external: (id) => id.startsWith('node:'),
  treeshake: true,
  logLevel: 'warn',
});
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await bundle.write({ file: outFile, format: 'esm', sourcemap: false, banner: '#!/usr/bin/env node\n', inlineDynamicImports: true });
console.log('wrote', outFile);
