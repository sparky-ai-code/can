// Stack traces that reach can code or the agent show can frames only. Frames from Can's own host code
// (file: and node: URLs, Windows drive paths) reveal host paths and the user's name, so they are removed.
//
// Two places apply this: a sandbox-side Error.prepareStackTrace (installed in every can context, so
// `err.stack` is filtered where it is made) and hostFreeStack() for host-realm errors that cross the membrane.
import vm from 'node:vm';

const HOST_FRAME = /(?:\(|^\s*at\s+)(?:file:|node:|[A-Za-z]:[\\/])/;

// Runs inside the can's realm. Frames whose file is a host location are dropped; the rest format as usual.
const FILTER_SOURCE = `(function () {
  const HOST = /^(file:|node:|[A-Za-z]:[\\\\/])/;
  Error.prepareStackTrace = function (err, frames) {
    const lines = [Error.prototype.toString.call(err)];
    for (const frame of frames) {
      const file = frame.getFileName();
      if (typeof file === 'string' && HOST.test(file)) continue;
      lines.push('    at ' + String(frame));
    }
    return lines.join('\\n');
  };
})();`;

/** Makes every error stack formatted inside `context` show can frames only. */
export function installStackFilter(context) {
  vm.runInContext(FILTER_SOURCE, context);
}

/** Removes host frames from an already formatted stack string (for errors that come from host code). */
export function hostFreeStack(stack) {
  if (typeof stack !== 'string') return stack;
  return stack.split('\n').filter((line) => !HOST_FRAME.test(line)).join('\n');
}
