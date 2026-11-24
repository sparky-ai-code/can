#!/bin/sh
# Builds the guest that src/vm/guest.js starts: canit (distro/canit/canit.c) is PID 1 and serves the host on the virtio
# port named can.agent. busybox is included so exec requests have commands to run. The output has the layout that
# qemu.js expects: <out>/x86_64/vmlinuz and <out>/x86_64/initrd.img.
# Usage (in WSL): sh build-initramfs-canit.sh <repo folder> <output folder>
# Needs busybox-static and the kernel unpacked under /root/vmspike/root (see README.md) and gcc with a static libc.
set -e
REPO=${1:?usage: build-initramfs-canit.sh <repo folder> <output folder>}
OUT=${2:?usage: build-initramfs-canit.sh <repo folder> <output folder>}
R=/root/vmspike/initramfs-canit
rm -rf $R && mkdir -p $R/bin $R/proc $R/sys $R/dev $R/etc $R/tmp $R/home/agent
gcc -O2 -Wall -Wextra -Werror -static -o $R/init "$REPO/distro/canit/canit.c"
cp /root/vmspike/root/usr/bin/busybox $R/bin/busybox
chmod 755 $R/bin/busybox
for app in sh echo uname ls cat mkdir rm stat base64 cp; do ln -sf busybox $R/bin/$app; done
mkdir -p "$OUT/x86_64"
( cd $R && find . | cpio -o -H newc --quiet | gzip -9 ) > "$OUT/x86_64/initrd.img"
cp /root/vmspike/root/boot/vmlinuz-7.0.0-44-generic "$OUT/x86_64/vmlinuz"
ls -la "$OUT/x86_64"
