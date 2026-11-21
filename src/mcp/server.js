// MCP server over stdio, written from scratch. JSON-RPC 2.0 with newline-delimited messages (one JSON
// object per line; JSON.stringify never emits raw newlines). Tools only, no resources or prompts.
// stdout carries protocol messages and nothing else. Logs go to stderr.
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createTools, createHostBrowserTools } from './tools.js';
import { CanRegistry } from '../registry.js';
import { HostBrowser } from '../hostbrowser.js';
import { ChromiumBrowsers } from '../canchromium.js';
import { chromiumBrowserEnabled, hostBrowserEnabled } from '../mounts.js';
import { Recorder } from '../recording.js';

export const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, '2025-03-26', '2024-11-05'];

export const RpcCode = Object.freeze({
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
});

const VERSION = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version;

const INSTRUCTIONS = [
  'Cans are virtual Linux-like machines for running code safely. Each can has its own files, processes,',
  'network ports and headless browser, and cannot touch the host.',
  'Typical flow: can_create, then can_write_file and can_exec. For a server, can_spawn, then can_ports,',
  'then can_http or browser_goto http://localhost:<port>/. Call can_save to keep state across restarts.',
  'Browser tools return page snapshots with refs such as [e3]; pass refs as targets.',
  'To keep a record of a QA run, call can_record_start before testing and can_record_stop after: it writes a video of',
  'the browser and a timeline of the calls.',
].join(' ');

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeMatches(type, value) {
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'null': return value === null;
    default: return true;
  }
}

/**
 * Checks a value against the subset of JSON Schema the tools use: type, enum, anyOf, required,
 * properties, additionalProperties (false or a schema), items, minimum, maximum, minLength.
 * Returns null when valid, or a message naming the first problem.
 */
export function validate(schema, value, at = 'arguments') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(s, value, at) === null);
    if (!ok) return `${at} does not match any allowed form`;
    return null;
  }
  if (schema.type && !typeMatches(schema.type, value)) return `${at} must be ${schema.type}`;
  if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(', ')}`;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be <= ${schema.maximum}`;
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    return `${at} must not be empty`;
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const problem = validate(schema.items, value[i], `${at}[${i}]`);
      if (problem) return problem;
    }
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) return `${at}.${key} is required`;
    }
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined || (v === null && !(schema.required ?? []).includes(key))) continue;
      const sub = schema.properties?.[key];
      if (sub) {
        const problem = validate(sub, v, `${at}.${key}`);
        if (problem) return problem;
      } else if (schema.additionalProperties === false) {
        return `${at}.${key} is not an allowed property`;
      } else if (isObject(schema.additionalProperties)) {
        const problem = validate(schema.additionalProperties, v, `${at}.${key}`);
        if (problem) return problem;
      }
    }
  }
  return null;
}

export class McpServer {
  /**
   * @param {object} opts
   * @param {string} opts.name server name reported in initialize
   * @param {string} opts.version
   * @param {string} [opts.instructions]
   * @param {Array<{name, description, inputSchema, run}>} opts.tools
   * @param {(line: string) => void} [opts.log] writes to stderr
   */
  constructor({ name, version, instructions, tools = [], log = () => {} }) {
    this.serverInfo = { name, version };
    this.instructions = instructions;
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.log = log;
    this.protocolVersion = null;
    this.initialized = false;
  }

  /** Handles one raw line. Resolves to the response object to send, or null when nothing is sent. */
  async handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return this._error(null, RpcCode.ParseError, 'Parse error: the message is not valid JSON');
    }
    if (Array.isArray(msg)) {
      return this._error(null, RpcCode.InvalidRequest, 'Batch requests are not supported in protocol 2025-06-18');
    }
    return this.handleMessage(msg);
  }

  /** Handles one parsed JSON-RPC message. */
  async handleMessage(msg) {
    if (!isObject(msg) || msg.jsonrpc !== '2.0') {
      return this._error(isObject(msg) && 'id' in msg ? msg.id : null, RpcCode.InvalidRequest, 'Invalid Request: expected a JSON-RPC 2.0 object');
    }
    const hasId = Object.hasOwn(msg, 'id');
    if (typeof msg.method !== 'string') {
      // A response to a request we never sent is ignored. Anything else is malformed.
      if (hasId && !('result' in msg) && !('error' in msg)) {
        return this._error(msg.id, RpcCode.InvalidRequest, 'Invalid Request: method must be a string');
      }
      return null;
    }
    if (!hasId) {
      this._notify(msg.method);
      return null; // notifications never get a response
    }
    try {
      const result = await this._dispatch(msg.method, msg.params);
      return { jsonrpc: '2.0', id: msg.id, result };
    } catch (err) {
      if (err instanceof RpcError) return this._error(msg.id, err.code, err.message, err.data);
      this.log(`internal error in ${msg.method}: ${err.stack ?? err}`);
      return this._error(msg.id, RpcCode.InternalError, `Internal error: ${err.message}`);
    }
  }

  _notify(method) {
    if (method === 'notifications/initialized') {
      this.initialized = true;
    } else {
      this.log(`notification ${method} ignored`);
    }
  }

  async _dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return this._initialize(params);
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        };
      case 'tools/call':
        return this._callTool(params);
      default:
        throw new RpcError(RpcCode.MethodNotFound, `Method not found: ${method}`);
    }
  }

  _initialize(params) {
    const requested = isObject(params) ? params.protocolVersion : undefined;
    this.protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
    return {
      protocolVersion: this.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.serverInfo,
      instructions: this.instructions,
    };
  }

  async _callTool(params) {
    if (!isObject(params) || typeof params.name !== 'string') {
      throw new RpcError(RpcCode.InvalidParams, 'tools/call requires a tool name');
    }
    const tool = this.tools.get(params.name);
    if (!tool) throw new RpcError(RpcCode.InvalidParams, `Unknown tool: ${params.name}`);
    // null means "not given" for optional arguments; required ones then fail validation.
    const input = Object.fromEntries(Object.entries(params.arguments ?? {}).filter(([, v]) => v !== null));
    const problem = validate(tool.inputSchema, input);
    if (problem) {
      this.log(`tools/call ${tool.name}: invalid arguments: ${problem}`);
      return toolResult(`Invalid arguments for ${tool.name}: ${problem}`, true);
    }
    try {
      const text = await tool.run(input);
      this.log(`tools/call ${tool.name}: ok`);
      return toolResult(text, false);
    } catch (err) {
      // KernelError messages already start with their code (ENOENT: ...), so the message is logged as is.
      this.log(`tools/call ${tool.name}: ${err.message}`);
      return toolResult(err.message || String(err), true);
    }
  }

  _error(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return { jsonrpc: '2.0', id, error };
  }
}

/**
 * A tool returns a string (one text block), or {text, images: [{data, mimeType}]} for an image result: the text
 * block comes first, then one image block per image (data is base64).
 */
function toolResult(value, isError) {
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }], isError };
  const content = [{ type: 'text', text: value.text }];
  for (const img of value.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  return { content, isError };
}

/**
 * Runs the server on stdin/stdout until stdin closes or SIGINT/SIGTERM arrives. Then running cans
 * are saved and every VM is stopped (see CanRegistry.shutdown). Resolves after shutdown.
 * @param {object} [opts]
 * @param {CanRegistry} [opts.registry]
 * @param {NodeJS.ReadableStream} [opts.input=process.stdin]
 * @param {NodeJS.WritableStream} [opts.output=process.stdout]
 * @param {(line: string) => void} [opts.log] defaults to stderr
 */
export async function startMcpServer({
  registry = new CanRegistry(),
  input = process.stdin,
  output = process.stdout,
  log = (line) => process.stderr.write(`[can-mcp] ${line}\n`),
} = {}) {
  // The host browser exists only when the user enabled it in the mounts file. It starts on first use.
  const hostBrowser = hostBrowserEnabled(registry.manager.mountsFile) ? new HostBrowser() : null;
  // Every can's browser tools drive a real Chrome or Edge (one per can, started on use), unless the mounts file sets
  // "chromiumBrowser": false.
  const chromium = chromiumBrowserEnabled(registry.manager.mountsFile) ? new ChromiumBrowsers() : null;
  // Recordings (can_record_start / can_record_stop). A recording still running at shutdown is written out below.
  const recorder = new Recorder();
  const server = new McpServer({
    name: 'can',
    version: VERSION,
    instructions: INSTRUCTIONS,
    tools: [...createTools(registry, { browsers: chromium, recorder }), ...createHostBrowserTools(hostBrowser)],
    log,
  });
  output.on('error', (err) => log(`stdout error: ${err.message}`));

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const inFlight = new Set();
  let forced = false;
  const write = (response) => {
    if (response) output.write(`${JSON.stringify(response)}\n`);
  };
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    const job = server.handleLine(line)
      .then(write, (err) => log(`failed to handle a message: ${err.stack ?? err}`))
      .finally(() => inFlight.delete(job));
    inFlight.add(job);
  });

  const onSignal = (signal) => {
    log(`${signal}: shutting down`);
    forced = true;
    rl.close();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  await new Promise((resolve) => rl.once('close', resolve));
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  if (!forced) await Promise.allSettled([...inFlight]);

  const recordings = await recorder.stopAll();
  for (const r of recordings.results) log(`saved recording "${r.name}" to ${r.log}`);
  for (const f of recordings.failures) log(`could not save recording "${f.name}": ${f.message}`);
  await hostBrowser?.close();
  await chromium?.closeAll();
  const result = await registry.shutdown();
  for (const name of result.saved) log(`saved can "${name}"`);
  for (const f of result.failed) log(`could not save can "${f.name}": ${f.message}`);
  return result;
}
