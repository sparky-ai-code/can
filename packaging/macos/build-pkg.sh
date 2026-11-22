#!/bin/sh
# Builds the macOS installer (.pkg) from a staged folder (see packaging/stage.mjs).
#   sh packaging/macos/build-pkg.sh <stage dir> <version> <output .pkg>
# Installs to /usr/local/lib/can (bundled node, the app, uninstall.sh) and /usr/local/bin/can, can-mcp.
# The package is not signed or notarized; see README.md for how users open it.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
stage=$1
version=$2
out=$3

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
payload="$work/payload"

mkdir -p "$payload/usr/local/lib/can" "$payload/usr/local/bin"
cp -R "$stage/node" "$stage/app" "$payload/usr/local/lib/can/"
cp "$here/uninstall.sh" "$payload/usr/local/lib/can/uninstall.sh"
cp "$stage/shims/can" "$stage/shims/can-mcp" "$payload/usr/local/bin/"
chmod 755 "$payload/usr/local/lib/can/node/node" "$payload/usr/local/lib/can/uninstall.sh" \
  "$payload/usr/local/bin/can" "$payload/usr/local/bin/can-mcp"
find "$payload" -type d -exec chmod 755 {} +

pkgbuild \
  --root "$payload" \
  --scripts "$here/scripts" \
  --identifier com.sparky-ai-code.can \
  --version "$version" \
  --install-location / \
  "$out"
echo "built $out"
