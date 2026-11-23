// Boots a Sparky-shaped server inside an existing can and checks its UI in the can's own browser.
//
// The can must already hold the server bundle at /app/apps/server/dist/bin.mjs and the web build at
// /app/apps/web/dist (see README.md). This script runs on the host and keeps the can alive while the server runs.
//
// Usage: node boot-driver.mjs <canName> [outDir]
//   Writes <outDir>/driver.log (one line per step) and <outDir>/ui.png (the UI after a click on "New chat").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const [canName, outArg] = process.argv.slice(2);
if (!canName) {
  console.error('usage: node boot-driver.mjs <canName> [outDir]');
  process.exit(2);
}
const outDir = path.resolve(outArg ?? path.join(here, 'out'));
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'driver.log');
fs.writeFileSync(logFile, '');
const log = (...parts) => {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  fs.appendFileSync(logFile, line);
};

const PORT = Number(process.env.SPARKY_PORT ?? 8080);
const { CanRegistry } = await import(pathToFileURL(path.join(repo, 'src/registry.js')).href);
const reg = new CanRegistry();
const can = await reg.get(canName);

const proc = await can.spawn(
  `node /app/apps/server/dist/bin.mjs serve --port ${PORT} --host 127.0.0.1 --base-dir /home/agent/sparky-data --no-browser --log-level info`,
);
log('spawned', { pid: proc.pid });

let ready = false;
for (let i = 0; i < 90 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const r = await can.request({ port: PORT, method: 'GET', path: '/api/session', timeout: 5000 });
    ready = r.status === 200;
  } catch { /* not listening yet */ }
}
log('ready', ready);
if (!ready) {
  log('server stdout tail', String(await can.logs(proc.pid, 'stdout')).slice(-1500));
  log('server stderr tail', String(await can.logs(proc.pid, 'stderr')).slice(-800));
  process.exit(1);
}

await can.browse('goto', `http://localhost:${PORT}/`);
await can.browse('wait', 25000);
const state = await can.browse('state');
log('console', state.consoleLog ?? []);
const root = await can.browse('evaluate', 'document.getElementById("root") ? document.getElementById("root").children.length : -1');
log('root children', root);
const clicked = await can.browse('click', 'New chat');
log('clicked New chat', { url: clicked.url, status: clicked.status });
await can.browse('wait', 4000);
fs.writeFileSync(path.join(outDir, 'ui.png'), await can.screenshot({ width: 1280, height: 800 }));
log('done');

// Keep the can, and so the server, alive until this process is stopped.
setInterval(() => {}, 1 << 30);
