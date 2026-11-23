# Can

Can is a fully virtual sandbox for AI agents. A **can** is a small machine with its own filesystem, processes,
virtual network ports, JavaScript runtime and headless browser. Code inside a can cannot read or write host files,
start host processes, or see host environment variables. It is built from scratch on Node.js built-ins with zero npm
dependencies.

Each can runs in its own child Node process with Node's Permission Model enabled. The host side is an async RPC
client (`CanManager` and `Can` in `src/`). The agent-facing interfaces are an MCP server and a command line tool.

Requires Node.js 20 or newer. Verified on Node 24.15.0 and Windows 11.

## Install (Windows and macOS)

Download the installer for your system from the Releases page of this repository:

- **Windows:** `Can-<version>-windows-x64-setup.exe`. It installs for your account only, so no administrator rights are needed.
- **macOS:** `Can-<version>-macos-arm64.pkg` on Apple silicon, or `Can-<version>-macos-x64.pkg` on Intel.

The installer bundles Node.js, so nothing else needs to be installed. It sets up three things for agents:

- The `can` and `can-mcp` commands. On Windows the folder is added to your PATH; on macOS they live in `/usr/local/bin`.
- The agent skill, copied to `~/.claude/skills/can/SKILL.md`.
- The `can` MCP server, registered in Claude Code (`~/.claude.json`) and in Claude Desktop when Claude Desktop is set up on the account.

There is no app window or front end. Restart Claude Code or Claude Desktop after installing so they load the tools.

The installers are not code-signed yet, so the system warns on first run. On Windows, choose **More info**, then **Run anyway**. On macOS, open the `.pkg` once, then allow it under **System Settings > Privacy & Security > Open Anyway**.

To uninstall, use **Settings > Apps > Can** on Windows. On macOS run `sudo sh /usr/local/lib/can/uninstall.sh`. Saved cans in `~/.can` are kept either way.

To check or repair the agent setup, run `node <install folder>\app\scripts\agent-setup.js status`, or `... install` to set it up again. The Windows install folder is `%LOCALAPPDATA%\Programs\Can`; on macOS it is `/usr/local/lib/can`, with the bundled Node at `node/node`.

## Quick start

```powershell
cd <path-to-can>
node --test                        # run the test suites (zero dependencies)

node bin\can.js create demo        # create and save a can
node bin\can.js exec demo -- echo "hello from the can"
node bin\can.js exec demo -- "mkdir -p /app && echo 'x' > /app/a.txt"
node bin\can.js cat demo /app/a.txt
node bin\can.js ls
node bin\can.js rm demo
```

## Register with Claude Code

The installers do this for you. To register from a checkout instead:

```powershell
claude mcp add can -- node <path-to-can>\bin\can-mcp.js
```

Claude Code then gets the tools listed below. The MCP server speaks JSON-RPC 2.0 over stdio, protocol version
2025-06-18. It writes protocol messages to stdout only, and logs to stderr.

You can also run it by hand. Every line on stdin is one JSON-RPC message:

```powershell
node bin\can-mcp.js
```

## MCP tools

Each can is named by its name or id. Tool errors come back as results with `isError: true`.

| Tool | What it does |
| --- | --- |
| `can_create` | Create a saved can (optional name; default `can-N`; optional `mounts`, see Host folders; optional `environment`, see Environment) |
| `can_mounts` | List the host folders the user has made available to cans, by label (no host paths) |
| `can_list` | List cans with status `running`, `exited`, `crashed`, `memory-limit` or `saved` |
| `can_destroy` | Stop a can and delete its saved state. Works in any state, and cannot be undone |
| `can_save` | Save filesystem and environment to disk now. Cans are also saved after every call that changes them |
| `can_status` | One can: state, memory against its 700 MB limit, the tools it was created with (name, version, sha256), processes, ports, and the last error with its next step |
| `can_restart` | Start a crashed, stopped or memory-limited can again from its last save. Processes and ports do not come back, and the result says so |
| `can_install` | Install packages with the can's pip (pure-Python wheels only) or npm. pip returns exact lock lines (`name==version --hash=sha256:<hex>`) to pin in `environment.pip` |
| `can_exec` | Run a shell command (60 s limit unless `timeoutMs`); returns exit code, stdout, stderr (capped at about 20 KB) |
| `can_spawn` | Start a background process (e.g. `node server.js`); returns its pid |
| `can_ps` | List processes |
| `can_logs` | Last lines of a process's stdout and stderr |
| `can_kill` | Send a signal to a process |
| `can_read_file` | Read a file; text by default, `encoding: "base64"` for binary |
| `can_write_file` | Create or overwrite a file; text by default, `encoding: "base64"` for binary |
| `can_import` | Copy a host file or directory into the can (binary-safe; see Moving files) |
| `can_export` | Copy a can file or directory to the host, under the transfer root (see Moving files) |
| `can_ci` | Run a CI pipeline in a fresh can: jobs of steps, with each step's result and the output of failures (see CI pipelines) |
| `can_list_dir` | List a directory |
| `can_ports` | List listening virtual ports |
| `can_http` | Send an HTTP request to a port inside the can |
| `browser_goto` | Open a URL, local or on the internet (internet access is on by default); returns the status and a page snapshot |
| `browser_snapshot` | Page outline with element refs such as `[e3]` |
| `browser_click` | Click a link, button or label; returns the new snapshot |
| `browser_type` | Type into an input or textarea |
| `browser_select` | Choose option(s) of a `<select>` |
| `browser_submit` | Submit a form; returns the new snapshot |
| `browser_text` | Visible text of the page or one element |
| `browser_query` | Elements matching a CSS selector, as JSON |
| `browser_back` | Go back one history step; returns the snapshot |
| `browser_links` | The links on the page as JSON `{text, href}`, each href absolute |
| `browser_wait` | Wait up to 60 s, then return the page's url, title and status |
| `browser_cookies` | The cookies in the can's browser as JSON |
| `browser_new_tab` | Open a tab (optionally at a URL) and make it active; tabs are numbered from 0 |
| `browser_select_tab` | Make the tab with this index the active one |
| `browser_close_tab` | Close a tab (the active one by default); closing the last tab opens a blank one |
| `browser_evaluate` | Run JavaScript in the page; returns JSON |
| `browser_console` | Console messages, including script errors |
| `browser_screenshot` | PNG of the page: written into the can, optionally copied to the transfer root, and returned as an image (see Screenshots) |
| `computer_screenshot` | PNG of the can's browser viewport, with the pixel coordinates `computer_action` uses. Needs Chromium, which is the default (see Computer use) |
| `computer_action` | Pointer and keyboard on that browser at pixel coordinates: move, click (single, double, right, middle), drag, scroll, type, key with modifiers, wait. Returns a new screenshot. Needs Chromium, which is the default |
| `can_record_start` | Start recording a QA session on a can: a timeline of its calls and a video of its browser (see Recording a QA session) |
| `can_record_stop` | Stop the recording and write `recordings/<name>.mp4` (or `.apng` without ffmpeg) and `recordings/<name>.log.txt` under the transfer root |
| `host_browser_goto`, `_text`, `_evaluate`, `_screenshot`, `_close` | Opt-in only (see Host folders and the host browser): drive the real Chrome or Edge on this machine |

A typical server session: `can_create`, then `can_write_file` for `server.js`, then `can_spawn "node server.js"`,
then `can_ports` to find the port, then `browser_goto http://localhost:<port>/`. The browser snapshot lists the
fields, and `browser_type` and `browser_click` take their labels or refs as targets.

## CLI

```
can create [name] [--mount label:/canPath]...
                                 create and save a can; --mount mounts a host folder read-only
can mounts                       list the host folders that cans may mount (labels only)
can ls                          list cans
can rm <can>                    destroy a can and delete its saved state
can exec <can> -- <cmd...>      run a command; prints its output, exits with its exit code
can spawn <can> -- <cmd...>     start a background process; prints its pid
can ps <can>                    list processes
can logs <can> <pid>            print a process's stdout and stderr
can kill <can> <pid> [SIGNAL]   signal a process (default SIGTERM)
can cp <hostPath> <can>:<canPath>        import: copy a host file or directory into a can
can cp <can>:<canPath> <hostPath>        export: copy a file or directory out of a can
can import <hostPath> <can>:<canPath>    the same as cp, import direction only
can export <can>:<canPath> <hostPath>    the same as cp, export direction only
can cat <can> <path>                     print a file from a can
can browse <can> <url>                   open a URL in the can's browser and print the page snapshot
can screenshot <can> [--out <name.png>] [--url <url>] [--width N] [--height N] [--full]
                                         PNG of the browser's page, written to the transfer root
can ci <pipeline.json> [--json]          run a CI pipeline in a fresh can (see CI pipelines); exit 0 passed, 1 failed, 2 bad file
can shell <can>                          interactive shell: each line runs in the can
can tools list|fetch|mirror|verify|source   the runtime tools (CPython); downloads only when you run fetch or mirror (see Tools CLI)
can mcp                                  run the MCP server on stdin/stdout
can help                                 show this help
```

Several words after `--` reach the can as separate arguments. `can browse` loads its URL in a fresh VM, so it reaches internet hosts but not a server started in an earlier command. Use `can_http` and `browser_goto` through `can mcp` for local servers. A single word is a whole shell line, for example
`can exec demo -- "echo hi > /app/a.txt"`.

## Tools CLI

The tools a can runs are listed in `toolchains.lock.json` at the app root. Today that is one entry: CPython 3.15.2 for
WASI, with its size and sha256. A tool is used only from a copy that is already on the machine: the bundled copy in
`<app>/toolchains/<sha256>/`, or the cache in `~/.can/toolchains/<sha256>/` (`$CAN_TOOLCHAIN_DIR` changes the cache).
**Downloads are opt-in.** Nothing else fetches a tool, and `can_create` reports a missing tool with the command to run.

```powershell
node bin\can.js tools list                                   # each tool, and whether it is bundled or cached
node bin\can.js tools fetch python                           # download, check, unpack into the cache
node bin\can.js tools fetch --from D:\mirror                 # use <folder>\<file> when it is there
node bin\can.js tools mirror D:\mirror                       # download every archive into a folder to host
node bin\can.js tools verify                                 # re-check each copy against its manifest
node bin\can.js tools source https://tools.example.com/can   # set the default fetch source
```

- **Source.** The default is GitHub, the release URL in the lock file. Set a mirror with `tools source <url>`, or pass
  `--source <url>` to `fetch` or `mirror` for one run. A mirror serves each archive at `<base>/<file>`, with the file name
  from the lock. `tools source github` goes back to GitHub. The setting is kept in `~/.can/config.json`
  (`$CAN_CONFIG_FILE` changes the path).
- **Checks.** A download goes to a temporary file first. Its size and sha256 must match the lock before it is unpacked
  into the cache, and a failed download leaves no temporary file behind.
- **Verify.** Each unpacked copy has a manifest of file hashes. `tools verify` reports any copy that no longer matches,
  with EINTEGRITY. Delete that folder and run `tools fetch` again.
- The installers fetch CPython once, when they are built, and bundle it (`packaging/stage.mjs`). Nothing fetches it at
  install time or on first run.

## Environment: set up a can before it starts

`can_create` takes an `environment` object, and `can create --spec environment.json` does the same from the CLI. The
spec is checked in full before anything boots. Then these steps run in order. If one fails, the can is discarded and
the error carries the step's output.

1. `tools`: names and versions from the lock, such as `{"python": "3.15"}`. Each must already be on the machine (see Tools
   CLI). Nothing is downloaded here.
2. `requireTools`: commands that must exist, such as `["npm"]`. A native toolchain such as `cargo` is not there.
3. `workdir`: a start folder, created if missing. Setup commands run in it.
4. `imports`: host files or folders copied in, with `exclude` to leave out names such as `node_modules`, `.git` or
   `*.log` at any depth.
5. `files`: text or base64 files written into the can.
6. `pip`: lock lines such as `"requests==2.32.3 --hash=sha256:<hex>"`, installed with the can's pip (see Python).
7. `setup`: commands run in order, such as `npm install`, each with a `timeoutMs`. Mark a step `optional` to keep going
   when it fails.

Other settings: `env` (environment variables), `node` (the Node version the can reports, such as `"24"`), and
`network` (`internet: false` turns off the browser, curl, `http`/`https` and npm; `registry` sets the npm registry URL).

```json
{
  "workdir": "/app",
  "node": "24",
  "network": { "internet": true, "registry": "https://registry.npmjs.org/" },
  "imports": [{ "hostPath": "C:\\work\\my-app", "canPath": "/app", "exclude": ["node_modules", ".git", "*.log"] }],
  "requireTools": ["npm"],
  "setup": [{ "command": "npm install", "label": "dependencies", "timeoutMs": 600000 }]
}
```

With that spec the can starts with the project's source and no host `node_modules` (it holds Windows binaries and
links, which do not work in a can). `npm install` then fetches the packages from the registry inside the can, and
`npm run dev` or `npx` finds the package bins in `node_modules/.bin`.

What works: semver ranges, dist-tags, tarballs checked against their integrity, hoisted and nested versions, optional
dependencies (skipped with a warning when they cannot be resolved), and the `pnpm` single-package commands. What does
not: install scripts, native addons, peer dependencies (not installed), workspaces (`pnpm -r`, `--filter`), git and
file specs, and cargo. SPEC.md section 14 has the details.

## CI pipelines

A CI pipeline runs in a can. `can_ci` (MCP) and `can ci pipeline.json` (CLI) take the same spec. The spec is checked in
full first, so a bad one costs nothing. Then one fresh can is made from the `environment` (the same setup as `can_create`),
and the jobs run in order. Each step is a shell line in the start folder. Jobs share the can, so a later job sees what an
earlier one left behind.

```json
{
  "name": "my-app",
  "environment": {
    "workdir": "/app",
    "imports": [{ "hostPath": "C:\\work\\my-app", "canPath": "/app", "exclude": ["node_modules", ".git"] }],
    "setup": [{ "command": "npm ci", "label": "install", "timeoutMs": 600000 }]
  },
  "jobs": [
    { "name": "test", "steps": [{ "run": "npm test", "label": "unit tests" }] },
    { "name": "build", "steps": [{ "run": "npm run build", "label": "build" }] }
  ],
  "artifacts": [{ "canPath": "/app/dist", "hostPath": "my-app/dist" }]
}
```

- **Stopping.** A step fails on a nonzero exit code or a timeout. The rest of its job is skipped, and so is every later job,
  unless the job has `"allowFailure": true`. A single step can be marked `"allowFailure": true` to let its job go on.
- **Steps.** `run` is required. Optional: `label`, `cwd` (absolute, inside the can), `env` (variables for that step), and
  `timeoutMs` (1 to 600000, default 300000).
- **Artifacts** are exported under the transfer root only when the whole pipeline passed, with the rules of `can_export`.
- **Keeping the can.** `keepCan` is `on-failure` by default: a failed run keeps its can, so you can look at it with
  `can_logs`, `can_exec` and `can_read_file`. `always` and `never` change that. A passing run destroys its can.
- **Exit codes** of the CLI: 0 passed, 1 a step failed (or the run stopped), 2 the file is not a valid pipeline.
- **What a pipeline cannot do** is what a can cannot do: no native toolchains (`cargo`, `rustc`, C or C++ compilers), no
  install scripts or native addons, no workspaces, and no matrix over Node versions (`node` only changes what
  `process.version` reports).

## Python (CPython 3.15.2)

A can runs Python 3.15.2, built for WebAssembly (`wasm32-wasip1`, WASI). The build is bundled with the installers, so
`python` works in a fresh can without a download. Python runs in a worker thread of the can's own process, and it reads
and writes the can's files.

- `python script.py args`, `python -c "..."` and `python3` work. A relative script path starts in the can's working
  folder, as it does in a shell.
- `pip install <name>...` and `pip install -r requirements.txt` install pure-Python wheels (`py3-none-any` and
  `py2.py3-none-any`) from PyPI into `/usr/lib/python3.15/site-packages`. Each file is checked against the sha256 that
  PyPI publishes. `pip list` shows what is installed.
- **Lock lines.** pip prints one line per installed file: `name==version --hash=sha256:<hex>`. Put those lines in
  `environment.pip` and every setup installs the same bytes. A hash in the line is checked instead of PyPI's digest.
- **No compiler.** A can runs no compiler, so sdists and platform wheels are refused with `ENOTSUP`. A package with C
  extensions does not install. Rust is not compiled in a can either. A prebuilt `wasm32-wasip1` program does run: any
  command whose path ends in `.wasm` runs with the can's working folder and files.
- **Memory and limits.** A Python or `.wasm` program has the can's memory limit. One that runs past it exits with code 137
  and an ENOMEM message. CPython's WASI build has no subprocess or socket support, and `os.symlink` gives `ENOTSUP`.
- **Version.** `environment.tools` with `"python": "3.15"` selects the bundled copy. The pin stays on 3.15.x.

## Moving files

Files move between the host and a can through `can_import` and `can_export` (MCP) or `can cp`, `can import` and
`can export` (CLI). Both directions copy bytes, so binary files such as PNG and gzip arrive unchanged. The test suite checks
each path with sha256 comparisons (`test/transfer.test.js`).

**Transfer root.** Export writes only under the transfer root: `%USERPROFILE%\.can\transfer` by default (`~/.can/transfer`
elsewhere), or `$CAN_TRANSFER_DIR` if you set it. `hostPath` in an export is resolved against that root. A path that
leaves it is refused: `..`, an absolute path outside the root, or a link inside the root that points out. Import
has no such rule. It reads any host path you name. A relative import path starts in the process's working directory,
so an absolute path is safer.

**Limits per call:** 256 MB per file, 500 MB total and 5000 files. Symbolic links that resolve outside the source
directory are refused on import. Links inside a can are skipped on export. Existing files are kept unless you
pass `overwrite` (MCP argument) or `--overwrite` (CLI). Nothing is written when a check fails before the copy starts.

MCP, from an agent:

```
can_import  {"can":"demo","hostPath":"C:\\Users\\me\\data\\model.bin","canPath":"/app/model.bin"}
            -> imported 1 file(s), 0 directories, 52428800 bytes from C:\Users\me\data\model.bin to /app/model.bin
can_import  {"can":"demo","hostPath":"C:\\Users\\me\\site","canPath":"/app/site"}     (a whole directory)
can_export  {"can":"demo","canPath":"/app/out/report.pdf","hostPath":"reports/report.pdf"}
            -> exported 1 file(s), 0 directories, 183004 bytes from /app/out/report.pdf to C:\Users\me\.can\transfer\reports\report.pdf
can_export  {"can":"demo","canPath":"/app/out","hostPath":"../x"}                    -> error: EPERM ... outside the transfer root
can_write_file {"can":"demo","path":"/app/logo.png","content":"iVBORw0KGgo...","encoding":"base64"}
can_read_file  {"can":"demo","path":"/app/logo.png","encoding":"base64"}             (up to 20 KB of base64)
```

Text stays the default. `can_write_file` and `can_read_file` take `encoding: "base64"` for binary data through the text
channel. A base64 read larger than the 20 KB output cap is refused with a hint to use `can_export`.

CLI, from a shell:

```powershell
node bin\can.js cp C:\Users\me\photo.png demo:/app/photo.png      # host to can
node bin\can.js cp demo:/app/out/report.pdf reports\report.pdf    # can to host, under the transfer root
node bin\can.js import C:\data demo:/app/data                     # a directory
node bin\can.js export demo:/app/data exported                    # into %USERPROFILE%\.can\transfer\exported
node bin\can.js cp demo:/app/data/a.txt exported\a.txt --overwrite   # replace an existing file
```

### Persistence and lifetime

- Saved state lives in `%USERPROFILE%\.can\cans` (`~/.can/cans` elsewhere). Set `CAN_STORE_DIR` to change it.
- A can is saved after every MCP call that changes it (`can_exec`, `can_spawn`, `can_write_file`, `can_import`,
  `can_kill`, `can_install` and `browser_screenshot`), by `can_create` and `can_save` (which forces an immediate save),
  by `can create`, `can exec`, `can spawn`, `can cp`, each shell line, and on a clean shutdown of the MCP server (stdin
  closed, or Ctrl+C). Processes and open ports are not saved.
- `can_create` is all or nothing. If any setup step fails, the can is destroyed and the name is free again, with no
  files left behind. Calling it again with the same name and the same spec returns the existing can (reused) instead
  of an error; a different spec gives EEXIST with a next step.
- Each CLI command is a new process. It loads only the can it names, and that can's VM stops when the command ends.
- **Background processes live only while a long-running host is alive**: `can mcp` or `can shell`. A
  `can spawn` from the CLI stops when the command exits. Use the MCP server for servers.
- Use one host process at a time per can. Two processes saving the same can overwrite each other.

## Host folders and the host browser

Two things reach past the sandbox, and both are off until the user sets them up. Both are configured in one file,
`%USERPROFILE%\.can\mounts.json` (`~/.can/mounts.json` elsewhere), or in the file named by `$CAN_MOUNTS_FILE`:

```json
{
  "mounts": {
    "datasets": { "path": "C:\\data\\research", "description": "Research data, read-only" }
  },
  "hostBrowser": false
}
```

**Read-only host folders.** A can names a mount only by its label, never by a host path. `can_create` (or
`can create demo --mount datasets:/data`) mounts the folder at a path in the can. The can sees the folder's current
contents, and every write under it fails with `EROFS`. The VM process gets read permission for the folder and none for
writing, so the mount stays read-only even if the filesystem check were bypassed. A saved can is mounted again on load,
and fails to load if the user has removed its label. The saved state holds labels and can paths only.

**Host browser (opt-in).** Set `"hostBrowser": true` to add `host_browser_goto`, `host_browser_text`,
`host_browser_evaluate`, `host_browser_screenshot` and `host_browser_close`. They drive a real Chrome or Edge already
installed on this machine (set `CAN_HOST_BROWSER` to the program if it is elsewhere), through the Chrome DevTools
Protocol, with a fresh temporary profile. This browser is not sandboxed. It uses the host network and can reach
services on localhost, and it opens only http and https pages. Screenshots go under the transfer root.

## Real Chromium for cans (on by default)

A can's browser is a real Chrome or Edge, one browser per can, started on first use. The MCP browser tools drive it.
To use Can's own headless virtual DOM instead (see Limits), set `"chromiumBrowser": false` in the mounts file
(`%USERPROFILE%\.can\mounts.json`, or `$CAN_MOUNTS_FILE`):

```json
{ "chromiumBrowser": false }
```

Only an explicit `false` turns it off; any other value, or no setting, leaves Chromium on (`src/mounts.js`).

- **The can's servers are reachable.** The browser sends every request through a proxy on this machine (loopback
  only, `src/canproxy.js`). `http://localhost:<port>/` goes into the can's own network, so a server the can started
  is the page the browser shows. Other hosts are reached from this machine, or refused when the can has no internet.
- **The can stays sandboxed.** The can process starts no browser, opens no socket and listens on nothing. The host
  starts Chrome or Edge (`CAN_HOST_BROWSER` picks the program) with a fresh temporary profile, and closes it when the
  server shuts down or the can is destroyed.
- **Names that point at this machine are refused.** A page cannot reach a service on this machine through the proxy.
- **Supported:** `browser_goto`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select`,
  `browser_submit`, `browser_text`, `browser_query`, `browser_back`, `browser_evaluate`, `browser_console`,
  `browser_screenshot`, `browser_links`, `browser_wait`, `browser_cookies` and the tab tools `browser_new_tab`,
  `browser_select_tab` and `browser_close_tab`. The screenshot is Chromium's own PNG.
- **Not yet:** WebSockets to the can, and the CLI
  commands `can browse` and `can screenshot` use the same browser setting. A can with internet access can
  reach any public host, as before.
- **Trust:** the proxy listens on loopback with no password, so another program on this machine that knows the port
  could use it to reach the can's servers. Only enable this on a machine you trust.

Tests: `test/chromium.test.js`. The browser tests run only when Chrome or Edge is installed. Two of them load real
websites (example.com and Wikipedia); they run only with `CAN_LIVE_TESTS=1`, because they need the internet and the
sites change.

## Computer use (real Chrome)

With Chromium on (the default, see above), an agent can use the can's browser the way a person does:
`computer_screenshot` returns the viewport with its pixel coordinates, and `computer_action` moves the pointer,
clicks (single, double, right, middle), drags, scrolls, types, presses keys with modifiers, or waits. Every action
returns a new screenshot. Input goes through the Chrome DevTools protocol (`Input.dispatchMouseEvent` and
`Input.dispatchKeyEvent`), so pages receive real mouse and keyboard events. Coordinates are checked against the
viewport and refused with `EINVAL` before anything is sent. Actions also appear in a running recording.

The built-in browser (used when `"chromiumBrowser": false`) has no pointer or keyboard: its computer tools fail with `ENOTSUP` and say how to turn Chromium back on.
Scope: this is the can's browser. It does not reach the host desktop, and no other application runs in the can.
Tests: `test/computer.test.js` (skipped when no Chrome or Edge is installed).

## Recording a QA session

`can_record_start {can, name?, width?, height?}` starts a recording on a can. While it runs:

- every tool call on that can goes into a timeline: the arguments, the time and duration of the call, and the first
  line of its result. Typed text, file content, `code`, headers and the environment of `can_create` are shown only
  by their size;
- each browser action that can change the page (`browser_goto`, `_click`, `_type`, `_select`, `_submit`, `_back`,
  `_evaluate`) films one frame of the can's browser.

`can_record_stop {can}` writes two files under the transfer root (`%USERPROFILE%\.can\transfer\recordings` by default):

- `<name>.mp4`: H.264 video, when `ffmpeg` is on the PATH or `CAN_FFMPEG` names it. Without ffmpeg the frames are
  written as `<name>.apng`, an animated PNG that browsers play, so nothing extra is needed. The APNG is written by hand
  (in `src/recording.js`); ffmpeg is used only for the MP4.
- `<name>.log.txt`: the timeline, as described above.

The video has one frame per browser action, not continuous motion: each frame stays on screen for 1 to 5 seconds, so
the video does not run at real speed. The log has the real times. Frames wait in a temp folder until the recording
stops; a server that shuts down cleanly writes out any recording still running. `can_destroy` on a can that is
recording saves the recording first. One recording per can. Tests: `test/recording.test.js`.

## Screenshots

`browser_screenshot` (MCP) and `can screenshot` (CLI) produce a PNG of the page the can's browser is showing.
The PNG is made by Can's own renderer, which runs inside the can's VM process. The host only encodes the bytes
and writes them out.

**This is an approximation, not a browser.** The output does not match Chrome or any engine pixel for pixel.
It is meant for an agent to check roughly what a page shows, not for visual regression against a real browser.

- **Drawn:** block and inline flow with word wrapping; headings at their usual relative sizes; bold; links in
  blue and underlined; simple tables with equal columns and optional grid lines; lists with bullets or numbers;
  `<hr>`; inputs, buttons, selects, textareas and checkboxes as boxes showing their value or label; pictures in PNG,
  JPEG, WebP (lossy, lossless and alpha) and SVG (shapes, paths, styles; text and filters are not drawn), and other
  formats as grey boxes with their alt text; flexbox (rows and columns, wrap, `justify-content`, `align-items`, `align-self`, `gap`,
  `flex-grow`, `flex-basis`, `flex`) and grid (`grid-template-columns` with px, %, fr, auto and `repeat()`, `gap`,
  `row-gap`, `column-gap`); a whitelist of CSS (`color`, `background-color`, `background`, `font-size`,
  `font-weight`, `font-style` (recorded, not drawn slanted), `text-decoration`, `text-align`, `margin`,
  `padding`, `width`, `height`, `border` colour, `visibility`, `white-space`, `display`) from `<style>` blocks and
  `style=""`, with simple selectors and normal specificity.
- **Hidden:** `display:none`, the `hidden` attribute and `visibility:hidden` draw nothing.
- **Not drawn:** grid spans, `minmax()`, `auto-fill`, floats, positioning, transforms, `@media` (those blocks are skipped), web fonts,
  italics, shadows, gradients, rounded corners, opacity, and non-ASCII glyphs (accents are
  dropped and symbols mapped, anything else shows as `?`). The font is a built-in 5x7 bitmap, scaled to the font size.
- **Size:** 1280 x 800 by default. Limits: width up to 3840, height up to 4096, and width times height up to
  8,388,608 pixels. `fullPage` grows the image to the page height, up to 4096 pixels.

**MCP:** `browser_screenshot {can, path?, width?, height?, fullPage?, hostPath?, overwrite?}` writes the PNG into the
can (default `/tmp/screenshots/<timestamp>.png`, relative paths start in `/home/agent`). It returns the can path,
width, height, byte count and the image itself as an image content block (images over 1 MiB are not inlined; read
the file with `can_export`). With `hostPath`, the same PNG is also written under the transfer root with the rules of
`can_export`: relative only, no `..`, no links out, no overwrite unless `overwrite` is true.

**CLI:** `can screenshot <can> [--out <name.png>] [--url <url>] [--width N] [--height N] [--full] [--overwrite]`
writes to the transfer root (default name `screenshot-<timestamp>.png`). `--url` loads a page first. A CLI command
cannot keep a server running in the can, so for a local server use the MCP tool through `can mcp`. Without `--url`,
the screenshot is of a blank page.

The renderer's tests (`test/screenshot.test.js`) check known pixels: a 100 x 50 box lands exactly where the layout
says, link and control colours appear, hidden content is absent, and the PNG decodes back to the same pixels.

## Security model

Can is designed so that code inside a can cannot touch the host. Two layers enforce this.

1. **Separate process with Node's Permission Model (the real boundary).** Each can is a child process started with
   `--permission` and `--allow-fs-read` limited to Can's own `src` directory, plus the toolchain folders and the tool
   lock file (read only). Writes, child processes, addons and the inspector are denied. Worker threads are allowed,
   for WebAssembly programs (see residual risk 8). The child's environment is empty, except `SYSTEMROOT` on Windows,
   which DNS needs (SPEC.md section 10.1a). Its V8 old space is capped at 600 MB, and the whole can at 700 MB (see Limits).
2. **In-process hardening (defence in depth).** A membrane wraps every host value that enters can code. Code
   generation from strings is disabled. Escape hatches such as `process.binding` are removed at boot. Listening on
   a host port (`net`, `http`, `https`, `dgram`) throws `EPERM`, and the refusal cannot be overwritten. Error stacks
   show can frames only, so host paths never reach a can.

The test suites include escape attempts, and they check that layer 1 holds even with layer 2 turned off.

The MCP and CLI layers add no host access by default. Files reach a can only through `can_write_file`, `can_import` or
`cp`, all of which write through RPC. Host files are read only by the import path, and written only by export under the
transfer root. The two exceptions are the ones the user turns on: read-only host folders, which the user lists by label
(see Host folders and the host browser), and the host browser, which is a real browser on this machine and not sandboxed.
Can code never reaches these functions.

### Residual risks

These are stated plainly, from `SPEC.md` section 10.4:

1. **Outbound network is not restricted, and host listening is refused only in-process.** Node 24 has no
   `--allow-net`, so a can can open outbound connections. This is by design: `require('http')` to a non-local host,
   `curl` and the browser all use the real network, and browser internet access is on by default. Listening on a
   host port is refused by the listen guard, which is layer 2. A layer-2 escape that also restored the original
   functions could listen on a host port. Layer 1 cannot refuse a listen on Node 24. Tested with a leaked host `net`.
2. **Layer 2 is best effort.** The membrane covers the surfaces the runtime hands out. It is not a proof. Layer 1 is
   what holds if layer 2 leaks.
3. **The VM can read the project `src` directory** (its own code, no secrets). Keep secrets out of `src`.
4. **Startup window.** libuv's injected variables exist from process creation until `worker.js`'s body runs. No can
   code runs in that window.
5. **Verified on Node 24.15.0 only.** `package.json` still declares `engines: >=20`. The permission flags were not
   tested on other versions.
6. **Memory is capped, CPU is not.** A can past its 700 MB limit is stopped alone, and one past its 600 MB JavaScript heap cap crashes alone. A synchronous infinite loop still
   blocks that can's VM until the stuck watchdog stops the can (see Limits), and destroying the can kills it. Foreground commands time out after 60 s by default.
   Browser page scripts are cut off by `scriptTimeout`. Each can is one OS process.
7. **A crash loses memory state.** A crashed can's unsaved state is gone. A new load restores the last save.
8. **Worker threads are allowed in the can process.** `--allow-worker` is on so that WebAssembly programs run in a worker
   thread. Node's permission model does not cover workers in the same way, so code that escapes layer 2 could start a
   worker that runs outside the membrane. Layer 1 was still tested as denying file reads and child processes inside a
   worker on Node 24 (`test/vm.test.js`). Node 20 is not tested.

## Limits

- **Memory: 700 MB per can, measured on the can's own process.** One limit covers the JavaScript heap and WebAssembly
  memory together. Crossing it stops the can: its status is `memory-limit`, its files from the last save are kept, and
  `can_restart` starts it again. Between 630 MB (the soft limit) and 700 MB, new `can_exec` and `can_spawn` calls are
  refused with ENOMEM, so `can_kill` can free space first. Inside the can process, the JavaScript heap is capped at
  600 MB (V8 old space), and each WebAssembly program at 700 MB.
  - **Windows:** `native/win/can-memcap.exe` puts the can process in a Job Object with the 700 MB limit, and reports its
    private memory every 250 ms. If the helper is missing, Can samples the process every second instead, and
    `can_status` reports the enforcement as `sampled` rather than `job-object`.
  - **macOS:** no hard cap is used. Can samples the process every second with `ps`, and the child reports its own RSS
    every 250 ms; the larger value counts. The limit is therefore approximate: a can can overshoot 700 MB by what it allocates between two samples.
  - **Linux:** `/proc/<pid>/status` (VmRSS) every second, the same as macOS without the child's own report.
  - **Chrome and Edge are not counted.** They are separate host processes, not the can's process.
- **Stuck watchdog.** A can that has requests pending and sends nothing for more than 10 s (or longer than its own timeout
  plus 5 s) is busy-looping. Can stops it with ETIMEDOUT and status `crashed`. Its files from the last save are kept, and
  `can_restart` starts it again.
- **JavaScript, shell and WebAssembly only.** Python and prebuilt `.wasm` programs run as described in Python. Apps run on Can's own runtime (CommonJS and ES modules, with `import.meta`, top-level
  `await` and destructured exports) and built-in shell. The shell has `$(...)`, `if`, loops, functions and heredocs.
  Not supported: `case`, `${VAR#pat}` trimming, arrays and `[[ ]]`. `npm run` and `npm test` read the can's
  `package.json`. `npm install` works against the registry (see Environment), but install scripts and native addons do
  not run, and packages that generate code from strings fail to load. Express 5 works: an app listens, parses JSON and
  form bodies, and answers requests (SPEC.md section 14). Plain `http` servers work. `printf`, `echo -e` and `node -p` work. To write a file with its
  content, use `can_write_file`.
- **Not Chromium, but it boots like one.** Pages get the browser APIs they probe at start-up (matchMedia, observers,
  layout queries, DOM classes, a 2D canvas context, and stubs for WebSocket, Worker, IndexedDB and geolocation) and a page's
  own errors are logged, not fatal. See SPEC.md section 12.2 for what is real and what is a stub. The browser is a headless, virtual DOM. It runs inline and `src` scripts, `type="module"` scripts,
  `fetch`, `XMLHttpRequest`, `history.pushState`, `document.write` and dynamically inserted scripts. It does not run
  scripts that `innerHTML` inserts (as in a browser), and it does not load bare module names. Its screenshots are an
  approximate render (see Screenshots), not browser pixels. For a real browser, see the host browser below.
- **Built-in modules only.** `fs`, `path`, `http`, `https`, `events`, `url`, `util`, `buffer`, `timers`, `os`,
  `process`, `child_process` (routed into the can), `crypto`, `stream`, `querystring`, `string_decoder` and `assert`
  are provided. `net`, `worker_threads`, `dgram`, `vm` and `inspector` throw.
- **Output is capped at about 20 KB** per stream for MCP results. The head and the tail are kept, and the middle is
  marked as omitted.
- **POSIX paths inside a can.** Paths are `/home/agent`, `/app`, `/tmp` and so on. Relative paths start in `/home/agent`.

## Building the installers

The Windows and macOS installers are built by `.github/workflows/installers.yml`. Each one bundles the pinned Node
runtime (`BUNDLED_NODE_VERSION` in that file, checked against nodejs.org's SHA256SUMS), the app, the skill and the
setup script. The workflow installs each package on a clean runner, runs `packaging/smoke.mjs` against it,
and uninstalls it. Pushing a `v*` tag also publishes the installers and `SHA256SUMS.txt` as a release.

To build a Windows installer by hand, with Inno Setup 6 installed:

```powershell
node packaging\stage.mjs --platform win32 --node <path to node.exe> --out dist\stage\windows-x64
iscc /DAppVersion=0.2.0 /DStageDir=<full path>\dist\stage\windows-x64 /DOutDir=<full path>\dist packaging\windows\can.iss
```

Use full paths for `StageDir` and `OutDir`: Inno Setup resolves relative ones against the script folder. On macOS,
run `node packaging/stage.mjs --platform darwin ...` and then `sh packaging/macos/build-pkg.sh <stage dir> <version> <out.pkg>`.

## Layout

```
bin/can.js              CLI
bin/can-mcp.js          MCP server entry point (stdio)
src/registry.js         CanRegistry: live and saved cans, lazy loading
src/manager.js          CanManager: create, load, save, stop, destroy
src/can.js              Can: host-side RPC handle of one can
src/mcp/server.js       JSON-RPC 2.0 MCP server over stdio
src/mcp/tools.js        Tool definitions and text results
src/transfer.js         Host-side import and export (limits, transfer root, link checks)
src/vm/                 Can VM process: supervisor, worker, machine, membrane
src/kernel/             VFS, virtual network, process table, errors
src/runtime/            Shell, builtins, JavaScript runtime, HTTP
src/browser/            Headless browser: HTML parser, selectors, forms, cookies
src/recording.js        Recording a QA session: timeline log, frames, APNG writer, ffmpeg MP4 (see Recording a QA session)
src/browser/render.js   Approximate page renderer for screenshots (see Screenshots)
src/browser/png.js      PNG encoder and decoder, written by hand (zlib from node:zlib)
src/browser/jpeg.js     Baseline JPEG decoder
src/browser/webp.js     WebP container, alpha plane and first animation frame
src/browser/vp8.js      WebP lossy (VP8 key frame) decoder; vp8l.js the lossless decoder
src/browser/svg.js      SVG rasteriser for shapes, paths, styles and <use>
src/browser/image.js    Picks the decoder for an image from its first bytes
src/browser/font.js     The built-in 5x7 bitmap font used by the renderer
src/toolchains.js       Tool lock, resolve (bundled, then cache), fetch and mirror (see Tools CLI)
toolchains.lock.json    The tools: name, version, size, sha256 and source
src/runtime/wasi/       WebAssembly (WASI) runner: worker thread, file bridge, memory limit
src/runtime/pip.js      pip for a can: pure-Python wheels, sha256 checks, lock lines
src/vm/memcap.js        Memory monitor for a can process (Job Object helper, or sampling)
native/win/             Windows memory helper (C#, built by build.js; see its README)
test/                   node --test suites
packaging/              Installers: stage.mjs, agent-setup.js (skill and MCP setup), smoke.mjs,
                        windows/can.iss (Inno Setup), macos/ (pkg build, postinstall, uninstall)
SPEC.md                 Architecture and binding interface spec
```
