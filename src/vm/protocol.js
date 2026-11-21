// Wire format between the host (supervisor.js, can.js) and a can VM process (worker.js).
// Messages are JSON over Node IPC:
//   host -> vm:  {t:'req', id, op, args}
//   vm -> host:  {t:'res', id, ok:true, value} | {t:'res', id, ok:false, error:{name, code, message, props}}
//   vm -> host:  {t:'ready', pid} once, after boot
import { KernelError } from '../kernel/errors.js';

/** Flattens an error for IPC. Only primitive own fields travel (pid, port, path, code, ...). */
export function encodeError(err) {
  const props = {};
  for (const [k, v] of Object.entries(err ?? {})) {
    if (v === null || typeof v !== 'object') props[k] = v;
  }
  return {
    name: String(err?.name ?? 'Error'),
    code: typeof err?.code === 'string' ? err.code : null,
    message: String(err?.message ?? err),
    props,
  };
}

/** Rebuilds an error on the host side. Coded errors become KernelError with the same code. */
export function decodeError(e) {
  if (e.code) return new KernelError(e.code, e.message, e.props ?? {});
  const err = new Error(e.message);
  err.name = e.name;
  return err;
}
