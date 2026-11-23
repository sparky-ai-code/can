#!/bin/sh
# Builds the Phase 0 spike guest: a busybox init that serves the agent protocol on /dev/vport0p1.
# Usage (in WSL): sh build-initramfs.sh /mnt/c/path/to/this/spike/folder
# Expects the kernel and busybox unpacked under /root/vmspike/root (see README.md).
set -e
OUT=${1:?usage: build-initramfs.sh <output folder>}
R=/root/vmspike/initramfs
rm -rf $R && mkdir -p $R/bin $R/proc $R/sys $R/dev $R/etc
cp /root/vmspike/root/usr/bin/busybox $R/bin/busybox
chmod 755 $R/bin/busybox
for app in sh cat echo mount uname ls sleep read printf tr grep poweroff eval; do ln -sf busybox $R/bin/$app; done
cat > $R/init <<'INIT'
#!/bin/busybox sh
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t devtmpfs devtmpfs /dev
echo "CAN-GUEST kernel $(uname -r) up"
exec 3<>/dev/vport0p1
echo "CAN-READY" >&3
while read -r line <&3; do
  case "$line" in
    ping) echo "CAN-REPLY pong" >&3 ;;
    exit) echo "CAN-REPLY bye" >&3; poweroff -f ;;
    *) echo "CAN-REPLY $(eval "$line" 2>&1)" >&3 ;;
  esac
done
INIT
chmod 755 $R/init
( cd $R && find . | cpio -o -H newc --quiet | gzip -9 ) > "$OUT/initramfs.cpio.gz"
cp /root/vmspike/root/boot/vmlinuz-7.0.0-44-generic "$OUT/vmlinuz"
ls -la "$OUT/initramfs.cpio.gz" "$OUT/vmlinuz"
