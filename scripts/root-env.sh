#!/system/bin/sh
echo "=== Magisk ==="
magisk -v
echo "=== modules ==="
ls -1 /data/adb/modules 2>/dev/null
echo "=== denylist ==="
magisk --denylist ls 2>/dev/null
echo "=== zygisk ==="
magisk --sqlite "select value from settings where key='zygisk';" 2>/dev/null
echo "=== conn_default ==="
magisk --sqlite "select value from settings where key='disable_denylist';" 2>/dev/null
echo "=== props ==="
getprop ro.build.tags
getprop ro.debuggable
getprop ro.secure
echo "=== su paths visible to shell ==="
for p in /system/bin/su /system/xbin/su /sbin/su /data/local/bin/su; do
  [ -e "$p" ] && echo "FOUND $p"
done
echo DONE