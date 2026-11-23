#!/system/bin/sh
echo "=== uninstall for all users ==="
pm uninstall --user 999 com.air.mpprobe 2>&1
echo "=== reinstall ==="
pm install -r -d /data/local/tmp/answer-app.apk 2>&1
sleep 2
echo "=== resolve ==="
cmd package resolve-activity --brief com.air.mpprobe 2>&1 | tail -2
echo "=== users ==="
pm list packages --user 0 | grep mpprobe
pm list packages --user 999 | grep mpprobe
echo "=== start Main ==="
am start -n com.air.mpprobe/.Main 2>&1 | head -3
sleep 3
ps -A | grep mpprobe