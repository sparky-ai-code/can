#!/bin/sh
# Builds the tools disk the guest mounts at /opt/can (see distro/canit/canit.c): a 2 GB ext4 image with Node.js and the
# glibc runtime Node links against. canit makes /lib and /lib64 point into the disk, so the loader and libraries resolve.
#
# Usage (in WSL, as root): sh build-tools-disk.sh <node dir> <output image>
#   <node dir>  an extracted Node.js linux-x64 tarball, e.g. /root/node-v24.15.0-linux-x64
#   <output>    the image path, e.g. /mnt/c/Users/you/Downloads/can-spike/guest/tools.img
set -e
NODE_DIR=${1:?usage: build-tools-disk.sh <node dir> <output image>}
OUT=${2:?usage: build-tools-disk.sh <node dir> <output image>}
MNT=/mnt/tools
rm -f "$OUT"
truncate -s "${3:-640M}" "$OUT"
mkfs.ext4 -q -F "$OUT"
mkdir -p "$MNT"
mount -o loop "$OUT" "$MNT"
trap 'umount "$MNT" 2>/dev/null || true' EXIT
cp -a "$NODE_DIR" "$MNT/node"
# The shared libraries Node needs (ldd on the binary lists them). Copied as real files, not links.
mkdir -p "$MNT/lib/x86_64-linux-gnu" "$MNT/lib64"
for f in libc.so.6 libm.so.6 libgcc_s.so.1 libdl.so.2 libpthread.so.0 libstdc++.so.6; do
  cp -L "/usr/lib/x86_64-linux-gnu/$f" "$MNT/lib/x86_64-linux-gnu/"
done
cp -L /lib64/ld-linux-x86-64.so.2 "$MNT/lib/x86_64-linux-gnu/"
cp -L /lib64/ld-linux-x86-64.so.2 "$MNT/lib64/"
sync
ls -la "$OUT"
