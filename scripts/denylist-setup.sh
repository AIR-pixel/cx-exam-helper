#!/system/bin/sh
echo "=== before denylist ==="
magisk --denylist ls
echo "=== add chaoxing to denylist ==="
magisk --denylist add com.chaoxing.mobile
echo "=== after ==="
magisk --denylist ls
echo "=== magisk hide (randomize package name) status ==="
magisk --sqlite "select value from settings where key='hide';" 2>/dev/null
echo DONE