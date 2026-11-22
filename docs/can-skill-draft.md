---
name: can
description: Run JavaScript, Python or prebuilt WebAssembly programs, serve and test a web app, or screenshot a page inside a "can", a sandboxed Linux-like machine on this host. Use when code must not touch the host, or to check a local server in a browser.
---
<!-- DRAFT for review: describes the design in docs/can-runtime-design.md, not the current build. -->

# Cans

## What a can is

A can is a small Linux-like machine in its own process, with its own files, processes, ports and headless browser. Code in a can cannot reach host files, processes or environment variables, except host folders the user shared (read-only) and files you import or export.

## Create

```
can_create {"name": "api", "environment": {"workdir": "/app", "tools": {"python": "3.15"}, "files": [{"path": "/app/main.py", "content": "print('hi')"}]}}
```

- `tools` pins versions, installed before the can starts. `"3.15"` resolves to an exact version that `can_status` reports. Then `python` and `pip` work in the shell.
- Calling `can_create` again with the same name and spec reuses a ready can, or restarts a crashed or memory-stopped one from its last save. Files come back; processes and ports do not, so start servers again with `can_spawn`.
- Same name, different spec: `EEXIST`. Choose a new name, or `can_destroy` the old can.

## Use

- **Run:** `can_exec {can, command}` puts `exit code: N` on the first line. A non-zero exit is normal: read stderr, fix, retry. Timeout: `timeoutMs` (default 60000, max 600000).
- **Serve:** `can_spawn {can, command}` returns a pid. `can_logs {can, pid}` reads its output. `can_kill {can, pid, signal?}` stops it (SIGTERM by default).
- **Check a server:** take the port from `can_status`, then `can_http {can, port, path}` or `browser_goto {can, url: "http://localhost:<port>/"}`.
- **Browser:** `browser_snapshot` lists elements as refs, e.g. `e3`. Pass a ref as `target` to `browser_click`, `browser_type` (with `text`), `browser_select` or `browser_submit`. Read results with `browser_text`, `browser_query`, `browser_console` or `browser_evaluate`. `browser_screenshot` writes a PNG; `can_export` copies it out.
- **Files:** `can_write_file {can, path, content}` (`encoding: "base64"` for binary), `can_read_file`, `can_list_dir`, `can_import`, `can_export`.
- **Python:** `pip install` takes pure-Python packages only. For environments, list packages as `name==1.2.3 --hash=sha256:<hex>`. An interactive `pip install` prints that line to copy.
- **Rust:** run a `.wasm` file by its path as a command, e.g. `can_exec {can, command: "/app/tool.wasm --help"}`.

## Check

Call `can_status {can}` before relying on a can and after any error. Healthy: `state: ready`. Check memory, processes, ports and the last error.

## Save and destroy

- Files are saved automatically after each call (proposed default; see the design spec). `can_save {can}` forces a save now. Processes and ports are never saved.
- `can_destroy {can}` deletes the can and its saved state. It **cannot be undone**; use it only when the user no longer needs the can.

## Other tools

- `can_ci {ci}` runs a pipeline in a fresh can. The first line says passed or failed.
- `can_record_start` / `can_record_stop` record a QA session as video and a call log.
- `can_mounts` lists host folders the user shared; pass them to `can_create` as `mounts` (read-only).
- `computer_screenshot` / `computer_action` drive the page by pixels (Chromium only).
- `host_browser_*` tools exist only when the user enabled them.

## When a step fails

Errors read `CODE: what happened. Next: what to do.` Do the Next step. Never `can_destroy` to recover.

| Error or state | What to do |
|---|---|
| `ENOENT` | Unknown can. Run `can_list`, use the right name. |
| `EEXIST` | Same name, different spec. Use a new name, or destroy the old can. |
| `EIO` (setup step) | Read the step output, fix the spec, call `can_create` again. Nothing was left behind. |
| `EIO` (disk full, or a file could not be moved into `~/.can`) | Free disk space or fix permissions on `~/.can`, then call `can_create` again. |
| `EIO` (download failed) | Retry once. If it recurs, report the URL and message. Do not work around it. |
| `EINTEGRITY` (checksum or size mismatch) | Retry once. If it recurs, report the URL and message. Do not work around it. |
| `EBUSY` | Another server is installing a tool. Wait a minute, then call `can_create` again. |
| `ENOTSUP` from `can_create` | No tool version matches. Use a version the message lists. |
| `ENOTSUP` from `pip install` | The package needs C code or a build step. Use a pure-Python package or tell the user. |
| `ENETUNREACH` (offline, tool not cached) | Reconnect and retry. Cached tools need no network. |
| `EPERM` (internet off by policy) | Use only cached or in-can tools, or ask the user to change the policy. |
| `ENOMEM` on `can_exec` or `can_spawn` (can still ready) | `can_kill` a process you no longer need, then retry. |
| `ENOMEM`, state `stopped: memory limit` | `can_create` with the same name and spec restarts from the last save. Files come back; processes and ports do not, so start servers again with `can_spawn`. Then do less at once, or split across cans. |
| `ECHILD`, or `crashed` | Run `can_status`, read the last error, then `can_create` with the same name and spec. Files come back; processes and ports do not, so start servers again with `can_spawn`. |
| Command timed out (noted in the result) | The first line reads `exit code: N (timed out and was killed)`. Raise `timeoutMs` (up to 600000), or use `can_spawn` and read `can_logs`. |
| `can_ci` first line says failed | Read the failing step's output. |
| `can_ci` returns an error | Setup failed and nothing ran. Read the error and fix the cause. |
| `EROFS` | Mounted host folders are read-only. Copy files into `/app` or `/home/agent` first. |
| `ENOTSUP` (computer tools) | Needs Chrome or Edge on the host, or Chromium turned off (`chromiumBrowser: false`). Use `browser_*` tools, or tell the user. |

## What a can cannot do

- Run Docker, containers or VMs.
- Python: pure-Python wheels only. No C extensions, subprocesses, threads or general sockets.
- Python cannot listen on ports or serve HTTP. Use node for servers.
- Rust: prebuilt `.wasm` programs only. No Rust compile, no Cargo.
- npm: no install scripts or native addons.
- Use more than 500 MB: new work is refused near the limit, then the can is stopped. No CPU cap, so stop loops with `can_kill`.
- Use shell `case`, `${VAR#pat}`, arrays or `[[ ]]`.
- Keep processes or ports after the MCP server stops.
- Render pages exactly like Chrome. Without Chrome or Edge on the host, layout is approximate.
