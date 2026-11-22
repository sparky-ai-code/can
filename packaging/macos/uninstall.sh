#!/bin/sh
# Removes Can from this Mac: the can and can-mcp commands, the app, the agent skill and the MCP registration.
# Saved cans in ~/.can are kept. Run with administrator rights:
#   sudo sh /usr/local/lib/can/uninstall.sh
set -u

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo sh /usr/local/lib/can/uninstall.sh"
  exit 1
fi

NODE=/usr/local/lib/can/node/node
SETUP=/usr/local/lib/can/app/scripts/agent-setup.js

user=$(/usr/bin/stat -f%Su /dev/console 2>/dev/null || true)
if [ -z "$user" ] || [ "$user" = root ]; then user=${SUDO_USER:-}; fi
if [ -n "$user" ] && [ "$user" != root ] && [ -x "$NODE" ] && [ -f "$SETUP" ]; then
  /usr/bin/sudo -H -u "$user" "$NODE" "$SETUP" uninstall || echo "Could not remove the agent setup for $user."
fi

rm -f /usr/local/bin/can /usr/local/bin/can-mcp
rm -rf /usr/local/lib/can
pkgutil --forget com.sparky-ai-code.can >/dev/null 2>&1 || true
echo "Can has been removed. Saved cans in ~/.can were kept."
