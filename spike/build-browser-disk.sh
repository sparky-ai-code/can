#!/bin/sh
# Builds the browser disk the guest mounts read-only at /opt/browser (see distro/canit/canit.c): Chrome for Testing and
# the system libraries it needs, found with ldd and copied as real files, plus the system fonts.
#
# Usage (in WSL, as root): sh build-browser-disk.sh <chrome-linux64 dir> <output image> [size]
#   chrome-linux64 dir  an unpacked Chrome for Testing linux64 build (chrome-linux64.zip), e.g. /root/chrome-linux64
#   output image        e.g. /mnt/c/Users/you/Downloads/can-spike/guest/browser.img
#   size                default 1500M
# The system libraries must be installed on the host first, for example libnss3, libnspr4 and libasound2t64 on Ubuntu.
set -e
CHROME_DIR=${1:?usage: build-browser-disk.sh <chrome-linux64 dir> <output image> [size]}
OUT=${2:?usage: build-browser-disk.sh <chrome-linux64 dir> <output image> [size]}
SIZE=${3:-1500M}
MNT=/mnt/browser
rm -f "$OUT"
truncate -s "$SIZE" "$OUT"
mkfs.ext4 -q -F "$OUT"
mkdir -p "$MNT"
mount -o loop "$OUT" "$MNT"
trap 'umount "$MNT" 2>/dev/null || true' EXIT
mkdir -p "$MNT/chrome" "$MNT/lib" "$MNT/fonts"
cp -a "$CHROME_DIR/." "$MNT/chrome/"

# Shared libraries Chrome needs that are not in its own folder. Each pass finds the libraries of the last pass, until
# nothing new turns up.
for pass in 1 2 3 4; do
  found=0
  for elf in "$MNT"/chrome/chrome "$MNT"/chrome/*.so "$MNT"/lib/*.so*; do
    [ -f "$elf" ] || continue
    for lib in $(ldd "$elf" 2>/dev/null | awk '$2=="=>" && index($3,"/")==1 {print $3}'); do
      base=$(basename "$lib")
      case "$lib" in "$MNT"*) continue ;; esac
      if [ ! -f "$MNT/lib/$base" ]; then
        cp -L "$lib" "$MNT/lib/$base"
        found=1
      fi
    done
  done
  [ "$found" = 1 ] || break
done

# The dynamic loader is in the tools disk too; the browser disk needs it only for the paths Chrome names.
[ -d /usr/share/fonts ] && cp -aL /usr/share/fonts/. "$MNT/fonts/" 2>/dev/null || true
# Chrome reads fonts through fontconfig. The guest has no /etc/fonts, so the browser disk carries its own config,
# which the browser is started with (FONTCONFIG_FILE=/opt/browser/fonts.conf).
cat > "$MNT/fonts.conf" <<FCEOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/opt/browser/fonts</dir>
  <cachedir>/tmp/fontconfig-cache</cachedir>
</fontconfig>
FCEOF
sync
ls "$MNT/lib" | wc -l
ls -la "$OUT"
