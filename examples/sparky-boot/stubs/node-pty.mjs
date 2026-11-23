// Stub for a can: node-pty is a native addon, which a can cannot load. Terminals are unavailable.
const fail = () => { throw new Error('node-pty is not available in a can (native addon)'); };
export const spawn = fail;
export default { spawn: fail };
