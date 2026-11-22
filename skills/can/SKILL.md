---
name: can
description: Run JavaScript, Python and prebuilt WebAssembly programs, serve and test web apps, and take screenshots inside a "can", a sandboxed Linux-like machine on this host. Use when code must not touch the host, or to check a local web app in a browser.
---

# Cans

A can is a small Linux-like machine in its own process, with its own files (`/app`, `/home/agent`, `/tmp`), processes, virtual ports, JavaScript, Python, WebAssembly and headless browser. Code in a can cannot read host files, start host processes or see host environment variables. Exceptions: host folders the user listed (read-only), and files you import or export.

## Create

```
can_create {"name": "api", "environment": {"workdir": "/app", "tools": {"python": "3.15"}, "files": [{"path": "/app/main.py", "content": "print('hi')"}]}}
```

- `environment.tools` pins cached toolchains, such as `{"python": "3.15"}`. Nothing is downloaded. If a tool is missing, creation fails with `ENOENT`: ask the user to run `can tools fetch`.
- `environment.pip` lists lock lines (`name==1.2.3 --hash=sha256:<hex>`) installed during setup. Pure-Python only.
- Creation is all or nothing.
- Same name and spec on a ready can: reused. Same name, different spec: `EEXIST`.
- For a crashed or stopped can, `can_create` does not restart it. Call `can_restart`.

## Use

- **Run:** `can_exec {can, command, timeoutMs?}`. First line: `exit code: N`, then stdout and stderr, each capped at 20 KB. Default timeout 60000 ms, maximum 600000. A non-zero exit is normal: read stderr, fix, retry.
- **Shell:** pipes, `&&`, `||`, redirects, `$(...)`, `if`, loops, functions, heredocs. No `case`, `${VAR#pat}`, `[[ ]]` or arrays.
- **Python:** `python script.py`, `python3`, `pip install`, `pip list`. Pure-Python wheels only.
- **Install:** `can_install {can, manager: "pip" or "npm", packages}` returns exact versions. Copy pip lock lines into `environment.pip` later.
- **WebAssembly:** run a prebuilt wasm32-wasip1 file by path, e.g. `can_exec {can, command: "/app/tool.wasm --help"}`. Never compile Rust or C.
- **Processes:** `can_spawn {can, command, cwd?}` returns a pid. `can_logs {can, pid}` reads output. `can_kill {can, pid, signal?}` (SIGTERM default). `can_ps` lists processes.
- **Servers:** `can_ports {can}` or `can_status` shows ports. `can_http {can, port, path?}` requests one. `browser_goto {can, url: "http://localhost:<port>/"}` opens it.
- **Browser:** `browser_snapshot` returns refs such as `e3`. Pass a ref as `target` to `browser_click`, `browser_type` (with `text`), `browser_select` or `browser_submit`. Read with `browser_text`, `browser_query`, `browser_console` or `browser_evaluate`. `browser_screenshot` writes a PNG; `can_export` copies it out.
- **Files:** `can_write_file {can, path, content, encoding?}` (`base64` for binary), `can_read_file`, `can_list_dir`, `can_import`, `can_export`.

## Check

Run `can_status {can}` before relying on a can and after any error. It shows the state (`ready`, `crashed`, `stopped`, `memory-limit`, or `saved`), memory against the 700 MB limit, toolchain versions, processes, ports and the last error.

## Save and destroy

- Cans are saved after each call that changes them. `can_save {can}` forces a save before a risky step.
- Processes and ports are never saved.
- `can_destroy {can}` deletes the can and its saved state. **It cannot be undone.** Use it only when the user no longer needs the can.

## Restart

`can_restart {can}` starts a crashed, stopped or memory-limit can from its last save. Files, environment variables and toolchains come back. Processes and ports do not: start servers again with `can_spawn`.

## Other tools

- `can_ci {ci}` runs a pipeline in a fresh can. First line: `pipeline: passed` or `pipeline: failed at job "<j>", step "<s>"`.
- `can_list` lists cans. `can_mounts` lists shared host folders; pass a label to `can_create` as `mounts: [{label, canPath}]`.
- `can_record_start` and `can_record_stop` record a QA session as video and a call log.
- `computer_screenshot` and `computer_action` drive pixels. They need Chromium, which is on by default and needs Chrome or Edge on the host. `chromiumBrowser: false` in the mounts file turns it off.
- `host_browser_*` exists only when the user enabled it. It is not sandboxed: use it only for pages the user asked for.

## When a step fails

Errors read `CODE: what happened. Next: what to do.` Do the Next step. Never `can_destroy` to recover.

| Error or state | What to do |
|---|---|
| `ENOENT`, no can | Run `can_list`, use the right name. |
| `ENOENT`, tool not installed | Ask the user to run `can tools fetch`, then retry. |
| `EEXIST` | Use a new name, or `can_destroy` the old can. |
| `EIO` in setup or pip | Fix the spec from the output, call `can_create` again. |
| `EINTEGRITY` | Retry once. If it recurs, report the message. Do not work around it. |
| `EBUSY` | Another process is fetching a tool. Wait a minute, retry. |
| `ENETUNREACH` | Ask the user to fix the connection and run `can tools fetch`. |
| `EPERM`, internet off | Use cached tools or code already in the can. |
| `ENOMEM` on exec or spawn, can still ready | `can_kill` a process you no longer need, then retry. |
| `ENOMEM`, state `memory-limit` | Call `can_restart`. Do less at once, or split across cans. |
| `ECHILD`, state `crashed` | Read `can_status`, then call `can_restart`. |
| `ETIMEDOUT`, can stopped responding | A busy loop was stopped. Call `can_restart`; avoid busy loops. |
| `(timed out and was killed)` | Raise `timeoutMs` (max 600000), or use `can_spawn` and `can_logs`. |
| `EROFS` | Mounts are read-only. Copy files into `/app` first. |
| `ENOTSUP`, pip | No pure-Python wheel. Choose another package, or tell the user. |
| `ENOTSUP`, tool version | Use a version the message lists. |
| `ENOTSUP`, `computer_*` | Use `browser_*`, or ask the user to enable Chromium. |

## What a can cannot do

- Run Docker, containers or VMs. Compile Rust, C or Cargo. Run only prebuilt wasm32-wasip1 programs.
- Python: no C extensions, subprocesses, threads or general sockets. Python cannot listen on ports; use node for servers.
- Create symlinks: `os.symlink` returns `ENOTSUP`.
- npm: no install scripts or native addons.
- Use more than 700 MB. Above 630 MB, new `can_exec` and `can_spawn` calls get `ENOMEM`; above 700 MB the can is stopped. Chrome and Edge processes do not count. There is no CPU cap.
- Use shell `case`, `${VAR#pat}`, `[[ ]]` or arrays.
- Keep processes or ports after a restart or after the MCP server stops.
- Render pages exactly like Chrome. The built-in browser is approximate.
