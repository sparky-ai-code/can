#!/bin/sh
# Builds the guest for the agent spike: canit (distro/canit/canit.c) is PID 1 and serves the host on the virtio port
# named can.agent. busybox is included so that exec requests have commands to run. Static, no shell scripts.
# Usage (in WSL): sh build-initramfs-canit.sh <repo folder> <output folder>
# Needs busybox-static unpacked under /root/vmspike/root (see README.md) and gcc with a static libc.
set -e
REPO=${1:?usage: build-initramfs-canit.sh <repo folder> <output folder>}
OUT=${2:?usage: build-initramfs-canit.sh <repo folder> <output folder>}
R=/root/vmspike/initramfs-canit
rm -rf $R && mkdir -p $R/bin $R/proc $R/sys $R/dev $R/etc $R/tmp $R/home/agent
gcc -O2 -Wall -Wextra -static -o $R/init "$REPO/distro/canit/canit.c"
cp /root/vmspike/root/usr/bin/busybox $R/bin/busybox
chmod 755 $R/bin/busybox
for app in sh echo uname ls cat; do ln -sf busybox $R/bin/$app; done
( cd $R && find . | cpio -o -H newc --quiet | gzip -9 ) > "$OUT/initramfs-canit.cpio.gz"
cp /root/vmspike/root/boot/vmlinuz-7.0.0-44-generic "$OUT/vmlinuz"
ls -la "$OUT/initramfs-canit.cpio.gz"
