#!/usr/bin/env node
// can: command line interface for Can. Each invocation is a new process. A can is loaded from its
// saved state on first use and saved after a change. Background processes live only while a
// long-running host is alive: `can mcp` or `can shell`. When the command that started a process
// exits, the process stops with it.
import fs from 'node:fs';
import readline from 'node:readline';
import { CanRegistry } from '../src/registry.js';
import { startMcpServer } from '../src/mcp/server.js';
import { defaultTransferRoot, exportFromCan, importToCan, writeTransferFile } from '../src/transfer.js';
import { pngSize } from '../src/browser/png.js';
import { listMounts, defaultMountsFile, chromiumBrowserEnabled } from '../src/mounts.js';
import { describeReport } from '../src/environment.js';
import { describeCi, normalizeCi, runCi } from '../src/ci.js';
import { KernelError } from '../src/kernel/errors.js';
import { ChromiumBrowsers } from '../src/canchromium.js';

/**
 * The browser a CLI command uses on one can: a real Chromium (the default), or the can's built-in browser when the
 * mounts file sets "chromiumBrowser": false. `close()` stops the browser and must run before the command ends.
 */
function cliBrowser(reg, can) {
  if (!chromiumBrowserEnabled(reg.manager.mountsFile)) return { b: can, close: async () => {} };
  const browsers = new ChromiumBrowsers();
  return { b: browsers.for(can), close: () => browsers.closeAll() };
}

const USAGE = `usage: can <command> [args]

  can create [name] [--mount label:/canPath]... [--spec environment.json]
                                           create and save a can (default name: can-N). --mount mounts a host
                                           folder from the user's mounts list, read-only, at a path in the can.
                                           --spec sets the environment up before the can starts (env, workdir,
                                           node, network, imports with excludes, files, requireTools, setup)
  can mounts                               list the host folders that cans may mount (labels only)
  can ls                                   list cans
  can rm <can>                             destroy a can and delete its saved state
  can exec <can> -- <cmd...>               run a command; prints its output, exits with its exit code
  can spawn <can> -- <cmd...>              start a background process; prints its pid
  can ps <can>                             list processes
  can logs <can> <pid>                     print a process's stdout and stderr
  can kill <can> <pid> [SIGNAL]            signal a process (default SIGTERM)
  can cp <hostPath> <can>:<canPath>        import: copy a host file or directory into a can
  can cp <can>:<canPath> <hostPath>        export: copy a file or directory out of a can
  can import <hostPath> <can>:<canPath>    same as cp, import direction only
  can export <can>:<canPath> <hostPath>    same as cp, export direction only
  can cat <can> <path>                     print a file from a can
  can browse <can> <url>                   open a URL in the can's browser and print the page snapshot
  can screenshot <can> [--out <name.png>] [--url <url>] [--width N] [--height N] [--full] [--overwrite]
                                           PNG of the browser's page, written to the transfer root
  can shell <can>                          interactive shell: each line runs in the can
  can ci <pipeline.json> [--json]          run a CI pipeline in a fresh can: environment, then jobs of steps.
                                           Exit 0 when it passes, 1 when a step fails, 2 for a bad file.
                                           A failed run's can is kept for inspection (keepCan in the file)
  can prune [--older-than <hours>] [--dry-run]
                                           delete kept CI cans (saved cans named ci-*, created before the age; default 24
                                           hours). A failed run keeps its can for inspection until this removes it.
  can mcp                                  run the MCP server on stdin/stdout
  can help                                 show this help

Transfers are binary-safe. Limits per call: 256 MB per file, 500 MB and 5000 files. Import reads any host
path you name (a relative one starts in the current directory). Export writes only under the transfer root,
$CAN_TRANSFER_DIR or ~/.can/transfer, and a path that leaves it (.., absolute, or a link out) is refused.
Add --overwrite to replace existing files; by default they are kept and the command fails.

Screenshots are approximate renders, not browser output: block and inline layout with a built-in font, simple
CSS, form controls drawn as boxes, images as grey boxes. No flexbox, grid, web fonts or images. Default size 1280x800.

Saved cans live in $CAN_STORE_DIR, or ~/.can/cans. Each command loads only the can it names.
Background processes (spawn, a trailing &) live only while "can mcp" or "can shell" is running.
A can is saved after exec, spawn, cp, import and shell lines; use one host process at a time per can.`;

class UsageError extends Error {}

/** Quotes one argument for the can's shell (POSIX single-quote rules). */
export function shellQuote(arg) {
  if (/^[A-Za-z0-9_/.:=@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command after `--` (or after the can name when there is no `--`). Several words are re-quoted
 * so each reaches the can as one argument. A single word is a whole shell line, so
 * `can exec app -- "echo hi > f.txt"` works as it reads.
 */
function commandFrom(rest) {
  const words = rest.slice(1);
  if (words[0] === '--') words.shift();
  if (words.length === 0) throw new UsageError('a command is required after the can name (can exec <can> -- <cmd...>)');
  if (words.length === 1) return words[0];
  return words.map(shellQuote).join(' ');
}

function need(rest, count, what) {
  if (rest.length < count) throw new UsageError(`missing ${what}`);
}

function parsePid(text) {
  const pid = Number(text);
  if (!Number.isInteger(pid) || pid < 1) throw new UsageError(`invalid pid ${JSON.stringify(text)}`);
  return pid;
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  process.stdout.write(`${[line(headers), ...rows.map(line)].join('\n')}\n`);
}

/** Options and the can name of `can screenshot`. Unknown flags are usage errors. */
function screenshotOptions(rest) {
  const o = { can: undefined, out: undefined, url: undefined, width: undefined, height: undefined, full: false, overwrite: false };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = () => {
      if (i + 1 >= rest.length) throw new UsageError(`${a} needs a value`);
      i++;
      return rest[i];
    };
    if (a === '--out') o.out = value();
    else if (a === '--url') o.url = value();
    else if (a === '--width' || a === '--height') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new UsageError(`${a} must be a positive whole number`);
      o[a.slice(2)] = n;
    } else if (a === '--full') o.full = true;
    else if (a === '--overwrite') o.overwrite = true;
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) {
    throw new UsageError('usage: can screenshot <can> [--out <name.png>] [--url <url>] [--width N] [--height N] [--full]');
  }
  o.can = positional[0];
  return o;
}

/** "<can>:<path>" names a can. A Windows drive path such as C:\x or C:/x is a host path. */
function canRef(arg) {
  if (/^[A-Za-z]:[\\/]/.test(arg)) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,63}):(.+)$/.exec(arg);
  return m ? { can: m[1], path: m[2] } : null;
}

/** cp, import and export. Import reads a host path into a can. Export writes a can path to the transfer root. */
async function transfer(reg, rest, mode) {
  const overwrite = rest.includes('--overwrite');
  const args = rest.filter((a) => a !== '--overwrite');
  need(args, 2, 'source and destination');
  const [src, dst] = args;
  const from = canRef(src);
  const to = canRef(dst);
  if (from && to) throw new UsageError('cannot copy between two cans; export to the transfer root, then import it');
  if (!from && !to) throw new UsageError('one side must be <can>:<path>, e.g. mycan:/app/data.json');
  if (mode === 'import' && !to) throw new UsageError('import is <hostPath> <can>:<canPath>');
  if (mode === 'export' && !from) throw new UsageError('export is <can>:<canPath> <hostPath>');
  if (to) {
    const can = await reg.get(to.can);
    try {
      const r = await importToCan(can, src, to.path, { overwrite });
      process.stdout.write(`copied ${r.bytes} bytes (${r.files} file(s), ${r.dirs} dir(s)) to ${to.can}:${r.canPath}\n`);
    } finally {
      await reg.save(can.id); // a failed import can still have written some files
    }
    return 0;
  }
  const can = await reg.get(from.can);
  const r = await exportFromCan(can, from.path, dst, { overwrite, root: defaultTransferRoot() });
  process.stdout.write(`copied ${r.bytes} bytes (${r.files} file(s), ${r.dirs} dir(s)) from ${from.can}:${r.canPath} to ${r.hostPath}\n`);
  if (r.skipped) process.stderr.write(`note: skipped ${r.skipped} symbolic link(s) inside the can\n`);
  return 0;
}

const commands = {
  async create(reg, rest) {
    const mounts = [];
    const names = [];
    let environment;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--spec') {
        const file = rest[++i];
        if (!file) throw new UsageError('--spec takes a JSON file, such as --spec environment.json');
        try {
          environment = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
        } catch (err) {
          throw new UsageError(`--spec ${file}: ${err.code === 'ENOENT' ? 'no such file' : 'not valid JSON'}`);
        }
        continue;
      }
      if (rest[i] !== '--mount') {
        names.push(rest[i]);
        continue;
      }
      const spec = rest[++i] ?? '';
      const colon = spec.indexOf(':');
      if (colon < 1) throw new UsageError('--mount takes label:/canPath, such as --mount datasets:/data');
      mounts.push({ label: spec.slice(0, colon), canPath: spec.slice(colon + 1) });
    }
    const can = await reg.create(names[0], { mounts, environment });
    const note = mounts.length ? ` with ${mounts.map((m) => `${m.label} at ${m.canPath}`).join(', ')} (read-only)` : '';
    const setup = can.report ? `\n${describeReport(can.report)}` : '';
    process.stdout.write(`created can "${can.name}" (id ${can.id})${note}${setup}\n`);
  },

  async mounts() {
    const rows = listMounts(defaultMountsFile());
    if (rows.length === 0) {
      process.stdout.write('no host folders are available to cans. Add some to the mounts file.\n');
      return 0;
    }
    printTable(['LABEL', 'DESCRIPTION'], rows.map((r) => [r.label, r.description]));
  },

  async ci(reg, rest) {
    let file = null;
    let json = false;
    for (const arg of rest) {
      if (arg === '--json') json = true;
      else if (file === null && !arg.startsWith('--')) file = arg;
      else throw new UsageError(`ci takes one pipeline file and optionally --json (got "${arg}")`);
    }
    if (file === null) throw new UsageError('ci takes a pipeline file, such as: can ci pipeline.json');
    let spec;
    try {
      spec = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      throw new UsageError(`${file}: ${err.code === 'ENOENT' ? 'no such file' : 'not valid JSON'}`);
    }
    try {
      normalizeCi(spec); // a bad pipeline is refused before any can is created
    } catch (err) {
      if (err instanceof KernelError) throw new UsageError(`${file}: ${err.message.replace(/^EINVAL: /, '')}`);
      throw err;
    }
    const report = await runCi(reg, spec, { transferRoot: defaultTransferRoot() });
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${describeCi(report)}\n`);
    return report.ok ? 0 : 1;
  },

  async prune(reg, rest) {
    // Retention for the cans that failed `can ci` runs keep. Only saved cans named ci-* are removed, and never a
    // loaded can. Default age: 24 hours.
    let hours = 24;
    let dryRun = false;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === '--dry-run') dryRun = true;
      else if (a === '--older-than') {
        hours = Number(rest[++k]);
        if (!(hours >= 0) || rest[k] === undefined) throw new UsageError('--older-than takes a number of hours, such as --older-than 24');
      } else throw new UsageError(`prune takes [--older-than <hours>] [--dry-run] (got "${a}")`);
    }
    const removed = reg.prune({ prefix: 'ci-', olderThanMs: hours * 3_600_000, dryRun });
    if (removed.length === 0) {
      process.stdout.write(`no kept CI cans older than ${hours} hours\n`);
      return 0;
    }
    process.stdout.write(`${dryRun ? 'would remove' : 'removed'} ${removed.length} kept CI can(s): ${removed.join(', ')}\n`);
    return 0;
  },

  async ls(reg) {
    const rows = reg.list();
    if (rows.length === 0) {
      process.stdout.write('no cans. Create one with: can create [name]\n');
      return 0;
    }
    printTable(['NAME', 'STATUS', 'ID'], rows.map((r) => [r.name, r.status, r.id]));
  },

  async rm(reg, rest) {
    need(rest, 1, 'can name');
    const name = await reg.destroy(rest[0]);
    process.stdout.write(`removed can "${name}"\n`);
  },

  async exec(reg, rest) {
    need(rest, 2, 'command');
    const command = commandFrom(rest);
    const can = await reg.get(rest[0]);
    const r = await can.exec(command, { timeout: 0 });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    await reg.save(can.id);
    return r.exitCode;
  },

  async spawn(reg, rest) {
    need(rest, 2, 'command');
    const command = commandFrom(rest);
    const can = await reg.get(rest[0]);
    const v = await can.spawn(command, { background: true });
    await reg.save(can.id);
    process.stdout.write(`started pid ${v.pid}: ${command}\n`);
    process.stderr.write(
      'note: this process stops when the command ends. Keep it running with "can mcp" or "can shell".\n',
    );
  },

  async ps(reg, rest) {
    need(rest, 1, 'can name');
    const can = await reg.get(rest[0]);
    const list = await can.ps();
    if (list.length === 0) {
      process.stdout.write('no processes\n');
      return 0;
    }
    printTable(['PID', 'STATUS', 'EXIT', 'COMMAND'], list.map((p) => [
      p.pid, p.status, p.status === 'running' ? '-' : p.exitCode, p.command,
    ]));
  },

  async logs(reg, rest) {
    need(rest, 2, 'pid');
    const can = await reg.get(rest[0]);
    const pid = parsePid(rest[1]);
    process.stdout.write(await can.logs(pid, 'stdout'));
    process.stderr.write(await can.logs(pid, 'stderr'));
  },

  async kill(reg, rest) {
    need(rest, 2, 'pid');
    const can = await reg.get(rest[0]);
    const pid = parsePid(rest[1]);
    const signal = rest[2] ?? 'SIGTERM';
    await can.kill(pid, signal);
    const v = await can.getProcess(pid);
    process.stdout.write(`signalled pid ${pid} with ${signal} (now ${v ? v.status : 'removed'})\n`);
  },

  // cp, import and export share one path. A "<can>:<path>" argument names a can. A Windows drive
  // path such as C:\x is a host path, not a can.
  async cp(reg, rest) {
    return transfer(reg, rest, 'cp');
  },

  async import(reg, rest) {
    return transfer(reg, rest, 'import');
  },

  async export(reg, rest) {
    return transfer(reg, rest, 'export');
  },

  async cat(reg, rest) {
    need(rest, 2, 'path');
    const can = await reg.get(rest[0]);
    process.stdout.write(await can.readFile(rest[1]));
  },

  async browse(reg, rest) {
    need(rest, 2, 'url');
    const can = await reg.get(rest[0]);
    const { b, close } = cliBrowser(reg, can);
    try {
      const s = await b.browse('goto', rest[1]);
      const snapshot = await b.browse('snapshot');
      process.stdout.write(`HTTP status: ${s.status ?? 'none'}\n${snapshot}\n`);
    } finally {
      await close();
    }
  },

  async screenshot(reg, rest) {
    const o = screenshotOptions(rest);
    const can = await reg.get(o.can);
    const { b, close } = cliBrowser(reg, can);
    let png;
    try {
      if (o.url !== undefined) await b.browse('goto', o.url);
      png = await b.screenshot({ fullPage: o.full, width: o.width, height: o.height });
    } finally {
      await close();
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = writeTransferFile(png, o.out ?? `screenshot-${stamp}.png`, { root: defaultTransferRoot(), overwrite: o.overwrite });
    const { width, height } = pngSize(png);
    process.stdout.write(`saved ${width}x${height} PNG (${png.length} bytes) to ${file}\n`);
    return 0;
  },

  async shell(reg, rest) {
    need(rest, 1, 'can name');
    const can = await reg.get(rest[0]);
    let cwd = (await can.exec('pwd')).stdout.trim() || '/home/agent';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    let open = true;
    rl.on('close', () => { open = false; });
    rl.on('SIGINT', () => rl.close());
    const prompt = () => {
      if (!open) return; // piped input can end before the last line is answered
      rl.setPrompt(`${can.name}:${cwd}$ `);
      rl.prompt();
    };
    process.stdout.write(`connected to can "${can.name}". Type exit to leave.\n`);
    prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (line === 'exit' || line === 'quit') break;
      if (line !== '') {
        const cd = /^cd(?:\s+(.+))?$/.exec(line);
        if (cd) {
          const target = (cd[1] ?? '~').trim().replace(/^~(?=\/|$)/, '/home/agent');
          const r = await can.exec(`cd ${shellQuote(target)} && pwd`, { cwd });
          if (r.exitCode === 0) cwd = r.stdout.trim();
          else process.stderr.write(r.stderr || `cd: exit ${r.exitCode}\n`);
        } else {
          const r = await can.exec(line, { cwd, timeout: 0 });
          process.stdout.write(r.stdout);
          process.stderr.write(r.stderr);
          if (r.exitCode !== 0) process.stdout.write(`[exit ${r.exitCode}]\n`);
          await reg.save(can.id);
        }
      }
      prompt();
    }
    rl.close();
    await reg.save(can.id);
  },

  async mcp(reg) {
    await startMcpServer({ registry: reg });
  },

  async help() {
    process.stdout.write(`${USAGE}\n`);
  },
};

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!Object.hasOwn(commands, cmd)) {
    process.stderr.write(`can: unknown command "${cmd}"\n${USAGE}\n`);
    return 2;
  }
  const registry = new CanRegistry();
  try {
    const code = await commands[cmd](registry, rest);
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`can ${cmd}: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`can: ${err.message}\n`);
    return 1;
  } finally {
    // Stops VMs without touching saved state. Commands that change a can have already saved it.
    await registry.shutdown({ save: false });
  }
}

process.exitCode = await main(process.argv.slice(2));
