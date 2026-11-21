// Default executor (SPEC.md section 5): runs a command line in the can's built-in shell.
// Every process gets its own shell state (cwd, env); the shell does the rest.
import { makeShell, runShellText } from './shell.js';

export default async function executor(ctx) {
  const sh = makeShell({ can: ctx.can, pid: ctx.pid, cwd: ctx.cwd, env: ctx.env, signal: ctx.signal });
  const io = { stdin: ctx.stdin, stdout: ctx.stdout, stderr: ctx.stderr };
  return runShellText(ctx.command, sh, io, { inlineBackground: true });
}
