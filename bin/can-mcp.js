#!/usr/bin/env node
// MCP server for Can over stdio. Register with Claude Code:
//   claude mcp add can -- node C:\Users\Lenovo\Downloads\can\bin\can-mcp.js
// Protocol messages go to stdout; logs go to stderr. Saved cans live in $CAN_STORE_DIR or ~/.can/cans.
import { startMcpServer } from '../src/mcp/server.js';
import { CanRegistry } from '../src/registry.js';

// Returns once stdin closes or a signal arrives and every can is saved and stopped.
await startMcpServer({ registry: new CanRegistry() });
