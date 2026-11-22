// Layer 2 (in-process hardening): a membrane between the host realm and one vm context.
//
// Every host value that enters can code (module objects, `process`, timers, console, DOM bridge
// objects) is handed over as a Proxy or a wrapper function. Every sandbox value that enters host
// code is unwrapped first. Property names that lead to host intrinsics (`constructor`, `__proto__`,
// the legacy accessors) are hidden. Host errors are rebuilt as errors of the sandbox realm.
//
// This is best-effort. Layer 1 (a separate permission-restricted process, see supervisor.js) is the
// real boundary; this layer makes the common escape routes fail earlier and with a clearer error.
import vm from 'node:vm';
import { hostFreeStack } from './stacks.js';

/** Set to false only by the VM worker when started with --no-layer2 (layer-1-only test mode). */
export const hardening = { enabled: true };

/** Property names whose values lead to host intrinsics or accessors that reach them. */
export const BLOCKED_KEYS = new Set([
  'constructor', '__proto__', 'caller', 'callee', 'arguments',
  '__lookupGetter__', '__lookupSetter__', '__defineGetter__', '__defineSetter__',
]);

const isObj = (v) => v !== null && (typeof v === 'object' || typeof v === 'function');

const INTRINSIC_NAMES = [
  'Object', 'Function', 'Array', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Symbol',
  'ArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array', 'Uint8ClampedArray', 'Uint16Array', 'Int16Array',
  'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
];

/** The object in `obj`'s prototype chain that owns `key` (obj itself, or a prototype), or undefined. */
function ownerOf(obj, key) {
  for (let o = obj; o; o = Reflect.getPrototypeOf(o)) {
    if (Object.prototype.hasOwnProperty.call(o, key)) return o;
  }
  return undefined;
}

export class Membrane {
  /** @param {object} context the contextified object of the vm context this membrane serves */
  constructor(context) {
    this.SandboxError = vm.runInContext('Error', context);
    // instanceof for membrane functions. The host's own check would walk raw host prototypes and miss
    // the membrane proxies in a sandbox subclass's chain, so the walk runs in the sandbox realm.
    this.hasInstance = vm.runInContext(`(function (value) {
      if (typeof this !== 'function') return false;
      const proto = this.prototype;
      if (proto === null || (typeof proto !== 'object' && typeof proto !== 'function')) return false;
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
      for (let o = Object.getPrototypeOf(value); o !== null; o = Object.getPrototypeOf(o)) {
        if (o === proto) return true;
      }
      return false;
    })`, context);
    this.toSb = new WeakMap(); // host value -> sandbox-side proxy
    this.proxyRaw = new WeakMap(); // sandbox-side proxy -> host value
    this.wrapOf = new WeakMap(); // sandbox function -> host-side wrapper
    this.unwrapOf = new WeakMap(); // host-side wrapper -> sandbox function
    this.native = new WeakSet(); // sandbox-realm objects that have been handed to host code
    this.reproto = new WeakSet(); // proxy targets whose prototype sandbox code replaced (see _objProxy)
    // Host built-in prototypes map to the sandbox's own, so `buf instanceof Uint8Array` and
    // `arr instanceof Array` hold for host values. The mapped objects are sandbox-realm, hence native.
    this.protoMap = new Map();
    for (const name of INTRINSIC_NAMES) {
      if (typeof globalThis[name] !== 'function') continue;
      const ctxProto = vm.runInContext(name, context).prototype;
      this.protoMap.set(globalThis[name].prototype, ctxProto);
      this.native.add(ctxProto);
    }
  }

  /** Host value -> the value sandbox code sees. */
  sandbox(v) {
    if (!hardening.enabled || !isObj(v)) return v;
    if (this.unwrapOf.has(v)) return this.unwrapOf.get(v);
    if (this.proxyRaw.has(v) || this.native.has(v)) return v;
    let p = this.toSb.get(v);
    if (!p) {
      p = typeof v === 'function' ? this._fnProxy(v) : this._objProxy(v);
      this.toSb.set(v, p);
      this.proxyRaw.set(p, v);
    }
    return p;
  }

  /** Sandbox value -> the value host code sees. */
  host(v) {
    if (!hardening.enabled || !isObj(v)) return v;
    if (this.proxyRaw.has(v)) return this.proxyRaw.get(v);
    if (this.unwrapOf.has(v)) return v;
    if (this.wrapOf.has(v)) return this.wrapOf.get(v);
    // A sandbox-realm array can hold membrane proxies (say, the data chunks a stream gave it). Host code reads
    // elements directly and checks their internal type (Buffer.concat does), which a proxy fails. Such an array goes
    // to the host as a copy with each element unwrapped. Arrays without proxies keep their identity.
    if (Array.isArray(v) && v.some((e) => isObj(e) && (this.proxyRaw.has(e) || this.unwrapOf.has(e)))) {
      return v.map((e) => this.host(e));
    }
    if (this.native.has(v)) return v; // sandbox-realm value that already crossed: keep its identity
    if (typeof v === 'function') {
      const w = this._hostWrapper(v);
      this.wrapOf.set(v, w);
      this.unwrapOf.set(w, v);
      return w;
    }
    this.native.add(v);
    return v;
  }

  /**
   * What the sandbox sees of a thrown value. Host errors are rebuilt as sandbox-realm errors (copying
   * primitive fields). Other host objects go through the membrane like any other value.
   */
  error(e) {
    if (!(e instanceof Error)) return this.sandbox(e);
    const copy = new this.SandboxError(String(e.message));
    copy.name = e.name;
    copy.stack = hostFreeStack(e.stack);
    for (const k of Object.keys(e)) {
      const v = e[k];
      if (v === null || typeof v !== 'object') copy[k] = v;
    }
    return copy;
  }

  // ---- internals ----------------------------------------------------------

  _try(fn) {
    try {
      return fn();
    } catch (e) {
      throw this.error(e);
    }
  }

  _guard(fn) {
    return this.sandbox(this._try(fn));
  }

  /**
   * A host object as the sandbox sees it. Its prototype can be replaced by sandbox code with a sandbox-realm object
   * (Object.setPrototypeOf, as Express does to its request and response objects). The proxy target then holds that
   * prototype. A name the host object owns still reads from the host object; any other name the sandbox prototype
   * chain defines reads from there. A host prototype is still refused, so the sandbox never gains a path to host
   * intrinsics.
   */
  _objProxy(raw) {
    const target = Array.isArray(raw) ? [] : {};
    const traps = this._traps(raw);
    const baseGet = traps.get;
    const baseGetPrototypeOf = traps.getPrototypeOf;
    const reproto = this.reproto;
    const baseHas = traps.has;
    traps.get = (t, key, receiver) => {
      // The host object's own properties keep precedence over the sandbox prototype's members.
      if (reproto.has(t) && !BLOCKED_KEYS.has(key) && !Object.hasOwn(raw, key) && key in t) {
        // A getter that a host prototype defines (Readable's `readable`, say) reads host state. It must run on the
        // host object: with the proxy as receiver it sees no state and answers wrongly. Its result is still wrapped.
        const owner = ownerOf(t, key);
        const desc = owner && this.proxyRaw.has(owner) ? Reflect.getOwnPropertyDescriptor(owner, key) : undefined;
        if (desc && desc.get) return desc.get.call(raw);
        return Reflect.get(t, key, receiver);
      }
      return baseGet(t, key, receiver);
    };
    traps.has = (t, key) => (reproto.has(t) && key in t) || baseHas(t, key);
    traps.getPrototypeOf = (t) => (reproto.has(t) ? Reflect.getPrototypeOf(t) : baseGetPrototypeOf(t));
    traps.setPrototypeOf = (t, proto) => {
      if (proto !== null && !isObj(proto)) return false;
      if (proto !== null && this.proxyRaw.has(proto)) return false; // a host prototype: refused, as before
      Reflect.setPrototypeOf(t, proto);
      reproto.add(t);
      return true;
    };
    return new Proxy(target, traps);
  }

  _fnProxy(raw) {
    const traps = this._traps(raw);
    const baseGet = traps.get;
    traps.get = (t, key, receiver) => (key === Symbol.hasInstance ? this.hasInstance : baseGet(t, key, receiver));
    let proxy;
    traps.apply = (_t, thisArg, args) => this._guard(
      () => Reflect.apply(raw, this.host(thisArg), args.map((a) => this.host(a))),
    );
    traps.construct = (_t, args, newTarget) => this._guard(() => {
      let nt = newTarget === proxy ? raw : (this.proxyRaw.get(newTarget) ?? newTarget);
      if (nt !== raw) {
        // A sandbox subclass (class X extends host.Class). Its prototype reaches the host through the
        // new object, so it must keep its identity when it comes back: mark it sandbox-native.
        this.native.add(nt);
        if (isObj(nt.prototype)) this.native.add(nt.prototype);
      }
      return Reflect.construct(raw, args.map((a) => this.host(a)), nt);
    });
    // A bound function has no own `prototype`, so no proxy invariant can clash with it.
    proxy = new Proxy((function () {}).bind(null), traps);
    return proxy;
  }

  _traps(raw) {
    const m = this;
    const blocked = (k) => BLOCKED_KEYS.has(k);
    const keepLength = Array.isArray(raw);
    // A blocked key yields only sandbox-realm values (e.g. the constructor of a sandbox subclass),
    // never a host intrinsic.
    const blockedGet = (key) => {
      let v;
      try { v = Reflect.get(raw, key); } catch { return undefined; }
      return m.native.has(v) ? v : undefined;
    };
    return {
      get: (_t, key) => (blocked(key) ? blockedGet(key) : m._guard(() => Reflect.get(raw, key))),
      set: (_t, key, value) => (blocked(key) ? false : m._try(() => Reflect.set(raw, key, m.host(value)))),
      has: (_t, key) => (blocked(key) ? blockedGet(key) !== undefined : Reflect.has(raw, key)),
      deleteProperty: (_t, key) => m._try(() => Reflect.deleteProperty(raw, key)),
      ownKeys: () => Reflect.ownKeys(raw).filter((k) => !blocked(k)),
      getOwnPropertyDescriptor: (_t, key) => {
        if (blocked(key)) return undefined;
        return m._try(() => {
          const d = Reflect.getOwnPropertyDescriptor(raw, key);
          if (!d) return undefined;
          if ('value' in d) d.value = m.sandbox(d.value);
          if ('get' in d) d.get = m.sandbox(d.get);
          if ('set' in d) d.set = m.sandbox(d.set);
          // Only an array's own `length` exists on the proxy target, so only it may stay non-configurable.
          if (!(keepLength && key === 'length')) d.configurable = true;
          return d;
        });
      },
      defineProperty: (_t, key, desc) => {
        if (blocked(key)) return false;
        return m._try(() => {
          const d = { ...desc };
          if ('value' in d) d.value = m.host(d.value);
          if ('get' in d) d.get = m.host(d.get);
          if ('set' in d) d.set = m.host(d.set);
          return Reflect.defineProperty(raw, key, d);
        });
      },
      getPrototypeOf: () => m._try(() => {
        const p = Reflect.getPrototypeOf(raw);
        return m.protoMap.has(p) ? m.protoMap.get(p) : m.sandbox(p);
      }),
      setPrototypeOf: () => false,
      preventExtensions: () => false,
    };
  }

  _hostWrapper(fn) {
    const m = this;
    return function hostWrapper(...args) {
      const sbArgs = args.map((a) => m.sandbox(a));
      const sbThis = m.sandbox(this);
      let out;
      try {
        out = new.target
          ? Reflect.construct(fn, sbArgs, fn)
          : Reflect.apply(fn, sbThis, sbArgs);
      } catch (err) {
        // process.exit() inside a callback that host code runs (a stream 'end', a socket event) has already
        // finished the program. Its unwinding error must stop here: host code would otherwise treat it as an
        // uncaught exception and take the whole can VM down with it.
        if (err?.name === 'ProcessExit') return undefined;
        throw err;
      }
      return m.host(out);
    };
  }
}
