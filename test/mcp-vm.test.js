// The MCP tools on the VM backend: a CanRegistry with backend 'vm' (CAN_BACKEND=vm in the server) creates VM cans, and
// the tools run in them. Needs the VM files and the tools disk (spike/README.md); without them the tests are skipped.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanRegistry } from '../src/registry.js';
import { createTools } from '../src/mcp/tools.js';
import { vmInstalled, vmPaths } from '../src/vm/qemu.js';

const paths = vmPaths();
const SKIP = vmInstalled(paths) && fs.existsSync(paths.tools) ? false : 'the VM or the tools disk is not installed';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-mcp-vm-'));
const registry = new CanRegistry({ storeDir: dir, backend: 'vm', vmDir: path.join(dir, 'vm') });
const tools = createTools(registry, { transferRoot: path.join(dir, 'transfer') });
const tool = (name) => tools.find((t) => t.name === name);
const text = (out) => JSON.stringify(out);

after(async () => {
  for (const can of registry.list()) await registry.destroy(can.name).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the MCP tools on the VM backend', { skip: SKIP }, () => {
  test('create, exec, write and read a file, list, and destroy a VM can through the tools', { timeout: 300000 }, async () => {
    await tool('can_create').run({ name: 'mcpvm' });
    const ran = await tool('can_exec').run({ can: 'mcpvm', command: 'echo from mcp' });
    assert.match(text(ran), /from mcp/);
    await tool('can_write_file').run({ can: 'mcpvm', path: 'hello.txt', content: 'hi from the tools' });
    const read = await tool('can_read_file').run({ can: 'mcpvm', path: 'hello.txt' });
    assert.match(text(read), /hi from the tools/);
    const listed = await tool('can_list').run({});
    assert.match(text(listed), /mcpvm/);
    await tool('can_destroy').run({ can: 'mcpvm' });
    await assert.rejects(() => registry.get('mcpvm'), (err) => err.code === 'ENOENT');
  });
});
