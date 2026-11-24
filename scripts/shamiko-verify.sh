#!/system/bin/sh
echo "=== uptime ==="
cat /proc/uptime
echo "=== shamiko module files ==="
ls -l /data/adb/modules/zygisk_shamiko/ 2>/dev/null | head -10
echo "=== denylist ==="
magisk --denylist ls
echo "=== denylist enforcement ==="
magisk --sqlite "select value from settings where key='disable_denylist';" 2>/dev/null
echo "=== zygisk enabled ==="
magisk --sqlite "select value from settings where key='zygisk';" 2>/dev/null
echo "=== shamiko in magisk log ==="
grep -i shamiko /cache/magisk.log 2>/dev/null | tail -5
logcat -d 2>/dev/null | grep -i shamiko | tail -5
echo DONE