# Booting a Sparky-shaped app in a can

This folder is the recipe that boots the Sparky desktop app's server and web UI inside a can, and checks the UI in the
can's own headless browser. It is a worked example, not part of the can runtime.

## What was verified

- Sparky's server (`apps/server`, bundled to one file) starts in a can: migrations run, the HTTP server listens,
  `/api/session` returns 200, and the WebSocket RPC (`/ws`) opens.
- Sparky's web UI (`apps/web`, built with Vite on the host) loads in the can's browser. Its sidebar renders
  ("New chat", "Threads", "Settings"), and a click on "New chat" routes to a new draft thread.
- The browser console is empty after load.

Limits (by design, see SPEC.md section 12): the browser renderer has no flexbox or grid and no icon fonts, so the
layout is plain. Terminals (node-pty), file search (fff) and Electron are stubbed out, so those features are off.
Git and provider CLIs are not present in a can.

## Steps

Run each command from this folder. Paths are for Windows PowerShell; adjust the host paths.

1. Install the app's dependencies on the host, from the app's monorepo root (Node 24 and pnpm 11 as the app requires):

   ```powershell
   pnpm install --frozen-lockfile
   ```

2. Build the web UI on the host, and drop its source maps (they are large and not needed to run):

   ```powershell
   cd <app>\apps\web
   vp build
   ```

3. Bundle the server into one file on the host:

   ```powershell
   node <can>\examples\sparky-boot\build-server.mjs <app> <staging>\app\apps\server\dist\bin.mjs
   ```

4. Create a can that runs Node 24.15.0 (its saved policy), and copy the two builds in:

   ```powershell
   node <can>\bin\can.js create spk-app --spec <spec-with-node-24.json>
   node <can>\bin\can.js cp <staging>\app\apps\server\dist\bin.mjs spk-app:/app/apps/server/dist/bin.mjs
   node <can>\bin\can.js cp <app>\apps\web\dist spk-app:/app/apps/web/dist
   ```

   The spec file is `{"node": "24.15.0"}`. Without it a can reports the default Node version, which must be 24.x for
   Sparky's `node:sqlite` requirement.

5. Boot the server and check the UI:

   ```powershell
   node <can>\examples\sparky-boot\boot-driver.mjs spk-app <staging>\out
   ```

   It writes `driver.log` and `ui.png` into the output folder, then keeps the server up until you stop the process.

## Gotchas found while booting

- The host path must be short. Windows limits paths to 260 characters, and pnpm's patch step fails on long scratch
  paths (`ENAMETOOLONG`). Copy the app to a short folder such as `C:\sp` first.
- A can saves its policy at creation. Changing the default in the runtime does not change an existing can; create a
  new one.
- Git Bash rewrites arguments that start with `/` (for example `/app/...`) into Windows paths. Set
  `MSYS_NO_PATHCONV=1` for can commands.
