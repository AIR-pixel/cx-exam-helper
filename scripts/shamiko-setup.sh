#!/system/bin/sh
echo "=== current denylist enforcement ==="
magisk --sqlite "select value from settings where key='disable_denylist';" 2>/dev/null
echo "=== disable denylist enforcement (Shamiko takes over) ==="
magisk --sqlite "replace into settings(key,value) values('disable_denylist',1);" 2>/dev/null
echo "=== after ==="
magisk --sqlite "select value from settings where key='disable_denylist';" 2>/dev/null
echo "=== modules now ==="
ls -1 /data/adb/modules
echo "=== shamiko files ==="
ls -l /data/adb/modules/shamiko 2>/dev/null | head
echo DONE