// The `net` built-in: TCP-style sockets and servers on the can's own virtual network. A server listens on a
// virtual port; a socket connects to one. Connections are in-memory duplex streams (see kernel/vnet.js), so they
// never reach a host socket. Any host other than the can's own loopback (localhost, 127.0.0.1, ::1, 0.0.0.0) is
// refused with ENOTSUP. Outbound network for a can goes through http, https and fetch, which apply the can's
// internet policy.
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';

const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:.]*:[0-9a-fA-F:.]*$/;

const isLocalHost = (host) => host === undefined || host === null || LOCAL_HOSTS.has(String(host).toLowerCase());
const isIPv4 = (s) => IPV4.test(String(s));
const isIPv6 = (s) => IPV6.test(String(s)) && String(s).includes(':');

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** `net` for one program. Sockets and servers take the program's runtime for its ports and timers. */
export function makeNetModule(rt) {
  /** A socket: a Duplex whose bytes go to and from a virtual-network stream (the peer). */
  class Socket extends Duplex {
    constructor(options) {
      super({ allowHalfOpen: Boolean(options?.allowHalfOpen) });
      this._peer = null;
      this.connecting = false;
      this.localAddress = '127.0.0.1';
      this.localFamily = 'IPv4';
      this.localPort = undefined;
      this.remoteAddress = '127.0.0.1';
      this.remoteFamily = 'IPv4';
      this.remotePort = undefined;
      this.bytesRead = 0;
      this.bytesWritten = 0;
    }

    /** Attaches the virtual-network stream that carries this socket's bytes. */
    _wire(peer) {
      this._peer = peer;
      peer.on('data', (chunk) => {
        this.bytesRead += chunk.length;
        if (!this.push(chunk)) peer.pause();
      });
      peer.on('end', () => this.push(null));
      peer.on('close', () => { if (!this.destroyed) this.destroy(); });
      peer.on('error', (err) => this.destroy(err));
    }

    _read() {
      if (this._peer) this._peer.resume();
    }

    _write(chunk, encoding, callback) {
      if (!this._peer) {
        callback(codedError('This socket is closed', 'ERR_SOCKET_CLOSED'));
        return;
      }
      this.bytesWritten += chunk.length;
      this._peer.write(chunk, encoding, callback);
    }

    _final(callback) {
      if (this._peer) this._peer.end();
      callback();
    }

    _destroy(err, callback) {
      if (this._peer) this._peer.destroy();
      callback(err);
    }

    address() {
      return { address: this.localAddress, family: this.localFamily, port: this.localPort };
    }

    setTimeout(_ms, callback) { if (callback) this.once('timeout', callback); return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { return this; }
    unref() { return this; }
  }

  /** A listening server on a virtual port. Each accepted connection is a Socket. */
  class Server extends EventEmitter {
    constructor(options, connectionListener) {
      super();
      if (typeof options === 'function') {
        connectionListener = options;
        options = {};
      }
      this._options = options ?? {};
      this._listener = null;
      if (connectionListener) this.on('connection', connectionListener);
    }

    get listening() { return this._listener !== null; }

    listen(...args) {
      const cb = args.find((a) => typeof a === 'function');
      const first = args[0];
      let port = 0;
      if (first !== null && typeof first === 'object') {
        port = first.port ?? 0;
      } else if (typeof first === 'number') {
        port = first;
      } else if (typeof first === 'string' && /^\d+$/.test(first)) {
        port = Number(first);
      }
      if (this._listener) throw codedError('Listen method has been called more than once without closing.', 'ERR_SERVER_ALREADY_LISTEN');
      let listener;
      try {
        // A net server's port has no HTTP meaning. A request to it gets an explanation, not a silent hang.
        listener = rt.vnet.listen(port, () => ({
          status: 502,
          headers: { 'content-type': 'text/plain' },
          body: 'This port is served by a net server, not an HTTP server.\n',
        }));
      } catch (err) {
        rt.addTimer('timeout', () => this.emit('error', err), 0, []);
        return this;
      }
      this._listener = listener;
      rt.addPort(listener.port);
      listener.on('connection', (peer) => {
        const sock = new Socket();
        sock.localPort = listener.port;
        sock._wire(peer);
        rt.trackRequest(new Promise((resolve) => sock.once('close', resolve)));
        this.emit('connection', sock);
      });
      rt.addTimer('timeout', () => {
        this.emit('listening');
        if (cb) cb();
      }, 0, []);
      return this;
    }

    address() {
      if (!this._listener) return null;
      return { address: '127.0.0.1', family: 'IPv4', port: this._listener.port };
    }

    close(cb) {
      if (this._listener) {
        const port = this._listener.port;
        this._listener = null;
        rt.vnet.close(port);
        rt.removePort(port);
      }
      rt.addTimer('timeout', () => {
        this.emit('close');
        if (cb) cb();
      }, 0, []);
      return this;
    }

    ref() { return this; }
    unref() { return this; }
  }

  /** Opens a client socket to a virtual port on the can's own loopback. Other hosts are refused. */
  function openClient(args) {
    const [first, second, third] = args;
    let port;
    let host;
    let cb;
    if (first !== null && typeof first === 'object') {
      port = first.port;
      host = first.host;
      cb = typeof second === 'function' ? second : undefined;
    } else {
      port = first;
      host = typeof second === 'string' ? second : undefined;
      cb = typeof second === 'function' ? second : (typeof third === 'function' ? third : undefined);
    }
    const sock = new Socket();
    sock.remotePort = Number(port);
    if (!isLocalHost(host)) {
      rt.addTimer('timeout', () => sock.destroy(codedError(
        `net: connecting to ${host} is not available in this can (only the can's own ports are reachable)`,
        'ENOTSUP',
      )), 0, []);
      return sock;
    }
    let peer;
    try {
      peer = rt.vnet.connect(Number(port));
    } catch (err) {
      rt.addTimer('timeout', () => sock.destroy(err), 0, []);
      return sock;
    }
    sock._wire(peer);
    sock.connecting = true;
    rt.trackRequest(new Promise((resolve) => sock.once('close', resolve)));
    rt.addTimer('timeout', () => {
      sock.connecting = false;
      sock.emit('connect');
      sock.emit('ready');
      if (cb) cb();
    }, 0, []);
    return sock;
  }

  return {
    Socket,
    Server,
    createServer: (options, connectionListener) => new Server(options, connectionListener),
    createConnection: (...args) => openClient(args),
    connect: (...args) => openClient(args),
    isIP: (s) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0),
    isIPv4,
    isIPv6,
  };
}
