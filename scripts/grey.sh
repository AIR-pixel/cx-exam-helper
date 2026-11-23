#!/system/bin/sh
# 验证新背板（浅灰透明）：Q1 单选走缓存，不耗额度
FLAG=/data/data/com.air.mpprobe/files/skip.flag
echo 0 > "$FLAG"; chown u0_a205:u0_a205 "$FLAG"; chmod 644 "$FLAG"

am force-stop com.air.mpprobe
sleep 1
settings put secure accessibility_enabled 1
settings put secure enabled_accessibility_services com.air.mpprobe/com.air.mpprobe.ReaderService
sleep 3

am force-stop com.air.exammock
sleep 1
am start -n com.air.exammock/.MockExam >/dev/null 2>&1
sleep 8

echo "=== Q1 ==="
logcat -d -s AnsReader 2>/dev/null | grep -E "OVERLAY\[|answer src=" | tail -3
screencap -p /sdcard/grey-q1.png

# 切到 Q3（判断，也走缓存）
input tap 540 2320; sleep 2
input tap 540 2320; sleep 4
echo "=== Q3 ==="
logcat -d -s AnsReader 2>/dev/null | grep -E "OVERLAY\[|answer src=" | tail -3
screencap -p /sdcard/grey-q3.png
echo DONE