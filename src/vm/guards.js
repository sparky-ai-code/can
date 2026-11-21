// Layer 2b: no host port may ever be opened from inside a can VM. Can's network is virtual (vnet.js), so
// nothing in Can needs a real listening socket. Node 24 has no --allow-net, so layer 1 cannot refuse a
// listen; this module does it in the process itself, at boot, before any can code runs.
//
// It replaces the listen entry points of the real modules with functions that throw EPERM. The replacements
// are non-writable and non-configurable, so ordinary code cannot put the originals back. Outbound
// connections are not affected: net.connect, http.request and https.request still work, which is what
// the browser and curl use for real internet access.
//
// This is defence in depth. If an attacker has a leaked host `net` and code execution in this process,
// they can still reach the sockets, so the real boundary is still layer 1 (see SPEC.md section 10).
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const REFUSAL = 'EPERM: opening a host port is not allowed inside a can; use the can\'s virtual ports (see can_ports)';

function refuse(what) {
  return function refused() {
    const err = new Error(`${what}: ${REFUSAL}`);
    err.code = 'EPERM';
    err.syscall = what;
    throw err;
  };
}

function lock(target, key, value) {
  Object.defineProperty(target, key, { value, writable: false, configurable: false, enumerable: true });
}

/** Installs the guards on this process's real net, dgram, http and https modules. Idempotent. */
export function denyHostListening() {
  if (net.Server.prototype.listen.name === 'refused') return;
  lock(net.Server.prototype, 'listen', refuse('net.Server.listen'));
  lock(dgram.Socket.prototype, 'bind', refuse('dgram.Socket.bind'));
  lock(dgram, 'createSocket', refuse('dgram.createSocket'));
  lock(net, 'createServer', refuse('net.createServer'));
  lock(http, 'createServer', refuse('http.createServer'));
  lock(https, 'createServer', refuse('https.createServer'));
}
