#!/system/bin/sh
echo "=== click next -> Q2 multi ==="
input tap 540 2320
sleep 5
logcat -d -s AnsReader 2>/dev/null | grep "STRUCT" | tail -2
echo "=== click next -> Q3 judge ==="
input tap 540 2320
sleep 5
logcat -d -s AnsReader 2>/dev/null | grep "STRUCT" | tail -3
echo DONE