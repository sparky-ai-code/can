---
name: can
description: Run code and web pages safely in "cans", virtual Linux-like machines with their own files, processes, virtual ports and headless browser. Use when you need to run untrusted or experimental code, start a local web server and check it in a browser, take a screenshot of a page, or read a host folder the user has made available read-only. Also use it to find out what a can can and cannot do.
---

# Cans: safe virtual machines for code and pages

A **can** is a small machine inside a separate process. It has its own filesystem (`/home/agent`, `/app`, `/tmp`), its own processes, its own virtual network ports, a JavaScript runtime with a built-in shell, and a headless browser. Code in a can cannot read or write host files, start host processes, or see host environment variables. Use a can whenever the code is not yours to trust, or whenever you want a clean machine to build and test in.

The tools come from the `can` MCP server (`can_*` and `browser_*`). A host browser (`host_browser_*`) exists only when the user has enabled it.

## Standard workflow

1. **Create or find a can.** `can_create` makes one and saves it. For a project, pass `environment` to set the can up before it starts: `workdir`, `node`, `network`, `imports` (host folders with `exclude` such as `node_modules`), `files`, `requireTools`, and `setup` steps such as `npm install`. A failed step discards the can and returns its output, so read the error. See "Environment" below. `can_list` shows the cans and their status (`running`, `crashed`, `saved`). A saved can is loaded on first use, so you can refer to it by name after a restart.
2. **Put files in.** `can_write_file` for text, or `encoding: "base64"` for binary. `can_import` copies a host file or folder in.
3. **Run commands.** `can_exec` runs a shell line and returns the exit code, stdout and stderr. It times out after 60 seconds unless you pass `timeoutMs`.
4. **Serve and check a web app.** `can_spawn "node server.js"` starts it in the background. `can_ports` shows the port, then `browser_goto http://localhost:<port>/` opens it. `browser_snapshot` lists the page's elements with refs such as `[e3]`, and `browser_click`, `browser_type`, `browser_select` and `browser_submit` take those refs as targets.
5. **Look at the result.** `browser_text`, `browser_query`, `browser_evaluate` and `browser_console` read the page. `browser_screenshot` makes a PNG, and `can_export` moves it to the host's transfer folder.
6. **Keep what matters.** `can_save` writes the state to disk. Processes and ports are not saved, so restart servers after a load. `can_export` copies results out.
7. **Clean up** with `can_destroy` when you are finished with a can you do not need.

## CI pipelines

To check a project the way CI would, use `can_ci {ci: {...}}`. It checks the pipeline in full, makes one fresh can from its `environment` (the same setup as `can_create`), then runs the `jobs` in order, each `steps[].run` as a shell line in the start folder. A step fails on a nonzero exit code or a timeout. The rest of its job is skipped, and so is every later job unless that job has `allowFailure`. The reply names each job and step as passed, failed or skipped, and shows the output of each failing step.

- A failed run keeps its can (`keepCan` defaults to `on-failure`), so inspect it with `can_logs`, `can_exec` and `can_read_file`, then `can_destroy` it. A passing run destroys its can.
- `artifacts` (`canPath` to `hostPath` under the transfer root) are exported only when the whole pipeline passed.
- The same spec runs from the shell with `can ci pipeline.json` (exit 0 passed, 1 failed, 2 bad file).
- Pipelines cannot run `cargo`, Rust, C or other native toolchains, install scripts, or workspaces. Say so when a project needs one, rather than trying.

## Computer use (pointer and keyboard, real Chrome only)

The built-in browser can only be driven by element refs. For a person-style session (see the page, point, click, type, scroll, press keys) the can needs a real browser: the user sets `"chromiumBrowser": true` in the mounts file, and the `computer_*` tools drive that Chrome over the DevTools protocol.

- `computer_screenshot {can, width?, height?}` returns the viewport as a PNG. Coordinates are pixels of that image, top left at 0, 0. Passing width or height changes the viewport.
- `computer_action {can, action, ...}` acts at those coordinates and returns a new screenshot, the URL and title, and whether a page loaded. Actions: `move`; `click`, `double_click`, `right_click`, `middle_click` (with `x`, `y`, optional `modifiers`); `drag` (`x`, `y` to `to_x`, `to_y`); `scroll` (`delta_y` positive is down, optional `x`, `y`); `type` (`text`; a newline presses Enter); `key` (`key` such as `Enter`, `Tab`, `Escape`, `ArrowDown`, `F5` or one character; optional `modifiers` such as `["ctrl"]`); `wait` (`duration_ms`, up to 10 seconds).
- Take a screenshot before the first action and after any scroll or navigation. Coordinates refer to the last viewport size, and a bad coordinate is refused with `EINVAL` before anything reaches the page.
- Actions are filmed into a running recording, so a `can_record_start` run also gets its pointer and keyboard steps on video.
- This is a real browser on the can's network. Pages load through the can's proxy, so `http://localhost:<port>/` reaches the can's own servers.

## Recording a QA session

When the user wants a record of how the testing went, wrap the testing in a recording:

1. `can_record_start {can, name?}` before the first test. From then on every call on that can goes into a timeline, and each browser action that can change the page (`browser_goto`, `_click`, `_type`, `_select`, `_submit`, `_back`, `_evaluate`) films a frame of the page.
2. Test as usual: `can_exec`, `browser_*`, `can_http`, and so on.
3. `can_record_stop {can}` writes two files under the transfer root: `recordings/<name>.mp4` (H.264, when ffmpeg is installed; otherwise `recordings/<name>.apng`, an animated PNG that browsers play) and `recordings/<name>.log.txt`, the timeline. The log has each call with its time, its duration and the first line of its result.

Things to know:
- The video is one frame per browser action, not continuous motion. Each frame stays on screen for 1 to 5 seconds, so the video does not run at real speed. The log has the real times.
- Typed text, file content, `code` and headers are not written to the log. Only their size is. `browser_type` results are logged as "typed text not logged".
- Frames come from the can's own browser, so they show what that browser renders. The default renderer is an approximation (see Layout and screenshots under Limits). With `chromiumBrowser` on, they are real Chrome pages.
- One recording per can. `can_destroy` on a recording can saves the recording first.
- A recording lives in the MCP server process. A clean shutdown of the server writes it out; a crash loses it.

## Limits to plan around

- **Code:** JavaScript (CommonJS and ES modules, including `import.meta`, top-level `await`, and destructured `export const { a } = o`) and the built-in shell. `npm install` and `npm ci` fetch packages from the npm registry, and `pnpm` works for single packages (not workspaces). Install scripts and native addons do not run. Code that generates code from strings (`eval`, `new Function`) is blocked, so a package that relies on it will not load. Express loads, but a request to an Express app crashes the can, so serve with plain `http` for now. `cargo` and other native toolchains do not exist here. The shell supports pipes, redirects, `if`, loops, functions and heredocs. It does not support `case`, `${VAR#pat}` trimming, arrays or `[[ ]]`. Use `can_write_file` to write a file with exact contents.
- **Processes:** a foreground command runs at most 60 seconds. A `can_spawn` process lives while the MCP server runs. A `can_save`'d can restarts with no processes.
- **Browser:** this is a headless virtual DOM, not Chromium. It runs inline `<script>`, external `<script src>`, `type="module"` scripts, `fetch`, `XMLHttpRequest`, `Headers`, `history.pushState` and `replaceState` (with `popstate` on back), `document.write`, and scripts you insert with `createElement` and `appendChild`. `innerHTML` scripts do not run, as in a browser. Bare module names such as `import "lodash"` do not load, so use relative URLs.
- **Layout and screenshots:** block and inline flow, tables, lists, flexbox (rows, columns, wrap, `justify-content`, `align-items`, `gap`, `flex` grow) and grid (`grid-template-columns` with px, %, fr, auto and `repeat()`, `gap`). Not supported: `minmax()`, `auto-fill`, grid spans, positioning, transforms, web fonts, images (drawn as grey boxes with their alt text), italics and `@media`. A screenshot is an approximation, not a pixel-for-pixel browser capture.
- **Internet:** outbound network works from the browser, `curl`, `require('https')` and `npm`, unless the can was made with `network.internet: false`.

## Environment (set up before the can starts)

`can_create`'s `environment` runs these steps in order, after checking the whole spec: `requireTools` (commands that must exist), `workdir` (created; setup runs there), `imports` (host files or folders, with `exclude` names such as `node_modules`, `.git` or `*.log`), `files` (written inline, text or base64), and `setup` (commands with `timeoutMs`; a failing step, unless `optional`, discards the can). Other settings: `env`, `node` (the version the can reports) and `network` (`internet`, `registry`). Example for a Node project on the host:

`{"workdir": "/app", "imports": [{"hostPath": "C:\\work\\app", "canPath": "/app", "exclude": ["node_modules", ".git"]}], "requireTools": ["npm"], "setup": [{"command": "npm install", "timeoutMs": 600000}]}`

Host `node_modules` never comes across usefully (it holds Windows binaries and links), so exclude it and let `npm install` run in the can.

## Host folders (read-only)

The user may list host folders in a mounts file (`%USERPROFILE%\.can\mounts.json`, or `CAN_MOUNTS_FILE`). Call `can_mounts` to see the labels and what each one holds. Labels are the only way in: you cannot name a host path, and a mount never allows a write.

To use one, pass it to `can_create` with a path in the can: `mounts: [{label: "datasets", canPath: "/data"}]`. The folder then appears at `/data` and shows its current contents. Writes there fail with `EROFS`. Copy anything you need into `/app` or `/home/agent` first. A can that has mounts is loaded again with the same mounts, so a label the user has since removed stops the can from loading.

## Host browser (only when the user enables it)

If the mounts file has `"hostBrowser": true`, the `host_browser_*` tools drive the real Chrome or Edge on this machine. This browser is **not** sandboxed. It uses the host network and can reach services on localhost, and it opens only http and https URLs. Use it only when the user has asked for a real browser, and say so when you do. `host_browser_goto` opens a page, `host_browser_text` and `host_browser_evaluate` read it, `host_browser_screenshot` saves a PNG under the transfer root, and `host_browser_close` ends the session.

## Errors

Errors come back as tool results with `isError: true`, with a Node-style code such as `ENOENT`, `EEXIST`, `EROFS`, `EINVAL` or `ETIMEDOUT`. Read the message, fix the cause, and try again. A crashed can (`ECHILD` or status `crashed`) keeps its last saved state, so `can_destroy` it and load it again, or `can_create` a new one.

## Rules of thumb

- Keep untrusted code in a can, not on the host.
- Name cans so you can find them again after a restart.
- Test a server with `browser_goto` on the port it reports, not on the host's own ports.
- Save before you stop work you want to keep. `can_save` writes to disk, and an unsaved crash loses that state.
