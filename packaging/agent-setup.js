#!/usr/bin/env node
// Per-user setup for Can, run by the Windows and macOS installers with the Node runtime they bundle.
//
//   node agent-setup.js install     copy the agent skill to ~/.claude/skills/can, and register the MCP
//                                   server "can" in Claude Code (~/.claude.json) and in Claude Desktop
//                                   (only when Claude Desktop has been set up on this account)
//   node agent-setup.js uninstall   remove what install added: the skill folder and the "can" MCP entries
//   node agent-setup.js status      print what is in place; exit 1 when the skill or Claude Code entry is missing
//
// The MCP entry points at the bundled node and this app's bin/can-mcp.js, so it works without any PATH.
// Only the "can" key of mcpServers is touched; every other setting in those files is kept as it was.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = 'can';
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = path.join(appDir, 'bin', 'can-mcp.js');
const skillSource = path.join(appDir, 'skills', 'can', 'SKILL.md');

const home = os.homedir();
const skillDir = path.join(home, '.claude', 'skills', SERVER);
const skillFile = path.join(skillDir, 'SKILL.md');
const claudeCodeFile = path.join(home, '.claude.json');
const claudeDesktopDir = process.platform === 'win32'
  ? path.join(home, 'AppData', 'Roaming', 'Claude')
  : process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Claude')
    : path.join(home, '.config', 'Claude');
const claudeDesktopFile = path.join(claudeDesktopDir, 'claude_desktop_config.json');

/** The targets that take the MCP entry. Claude Code always does; Claude Desktop only when it is set up here. */
function mcpTargets() {
  return [
    { name: 'Claude Code', file: claudeCodeFile, present: true, stdio: { type: 'stdio', command: process.execPath, args: [serverScript], env: {} } },
    { name: 'Claude Desktop', file: claudeDesktopFile, present: fs.existsSync(claudeDesktopDir), stdio: { command: process.execPath, args: [serverScript] } },
  ];
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Reads a JSON config. A missing or empty file is an empty config; a file that is not a JSON object is an error, never overwritten. */
function readConfig(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (text.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); it was left unchanged`);
  }
  if (!isObject(parsed)) throw new Error(`${file} does not hold a JSON object; it was left unchanged`);
  return parsed;
}

/** Writes the config through a temporary file and a rename, so an interrupted write cannot leave half a file. */
function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function installSkill() {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(skillSource, skillFile);
  return `installed ${skillFile}`;
}

function uninstallSkill() {
  if (!fs.existsSync(skillDir)) return `no skill folder at ${skillDir}`;
  fs.rmSync(skillDir, { recursive: true, force: true });
  // Remove the skills folder too, but only when it is now empty: other skills live there.
  const skillsDir = path.dirname(skillDir);
  if (fs.existsSync(skillsDir) && fs.readdirSync(skillsDir).length === 0) fs.rmdirSync(skillsDir);
  return `removed ${skillDir}`;
}

function installMcp(target) {
  if (!target.present) return `${target.name}: not set up on this account, skipped`;
  const config = readConfig(target.file);
  const servers = isObject(config.mcpServers) ? config.mcpServers : {};
  servers[SERVER] = target.stdio;
  config.mcpServers = servers;
  writeConfig(target.file, config);
  return `${target.name}: registered "${SERVER}" in ${target.file}`;
}

function uninstallMcp(target) {
  if (!fs.existsSync(target.file)) return `${target.name}: no config, nothing to remove`;
  const config = readConfig(target.file);
  if (!isObject(config.mcpServers) || !(SERVER in config.mcpServers)) {
    return `${target.name}: no "${SERVER}" entry`;
  }
  delete config.mcpServers[SERVER];
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  writeConfig(target.file, config);
  return `${target.name}: removed "${SERVER}" from ${target.file}`;
}

function mcpEntryState(target) {
  if (!fs.existsSync(target.file)) return { ok: false, text: 'no config file' };
  const config = readConfig(target.file);
  const entry = isObject(config.mcpServers) ? config.mcpServers[SERVER] : undefined;
  if (!entry) return { ok: false, text: 'not registered' };
  const pointsHere = Array.isArray(entry.args) && entry.args[0] === serverScript && entry.command === process.execPath;
  return { ok: pointsHere, text: pointsHere ? 'registered, points at this install' : `registered, but points at ${entry.command} ${entry.args?.[0] ?? ''}` };
}

/** Runs one target's step. A bad config file is reported and skipped, so the other target still gets its step. */
function perTarget(lines, step, target) {
  try {
    lines.push(step(target));
    return true;
  } catch (err) {
    lines.push(`${target.name}: ${err.message}`);
    return false;
  }
}

function run(command) {
  const lines = [];
  if (command === 'install') {
    lines.push(installSkill());
    let ok = true;
    for (const target of mcpTargets()) ok = perTarget(lines, installMcp, target) && ok;
    lines.push('Restart Claude Code and Claude Desktop so they load the "can" tools and skill.');
    return { lines, ok };
  } else if (command === 'uninstall') {
    lines.push(uninstallSkill());
    let ok = true;
    for (const target of mcpTargets()) ok = perTarget(lines, uninstallMcp, target) && ok;
    return { lines, ok };
  } else if (command === 'status') {
    let ok = fs.existsSync(skillFile);
    lines.push(`skill: ${ok ? `present at ${skillFile}` : `missing (${skillFile})`}`);
    for (const target of mcpTargets()) {
      const state = mcpEntryState(target);
      if (target.name === 'Claude Code' && !state.ok) ok = false;
      if (target.present || state.ok) lines.push(`${target.name}: ${state.text}`);
    }
    return { lines, ok };
  }
  return { lines: ['usage: node agent-setup.js install | uninstall | status'], ok: false };
}

const command = process.argv[2];
let result;
try {
  result = run(command);
} catch (err) {
  console.error(`can setup: ${err.message}`);
  process.exit(1);
}
for (const line of result.lines) console.log(line);
process.exit(result.ok ? 0 : 1);
