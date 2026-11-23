#!/system/bin/sh
# 滚动验证：LONG_TEST 超长文本 → 连拍三张，比对 overlay 区域文字是否在动
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
sleep 7
# 切到 Q5（简答）：点「下一题」4 次
i=1
while [ "$i" -le 4 ]; do
  input tap 540 2320
  sleep 2
  i=$((i+1))
done
sleep 5

echo "=== OVERLAY ==="
logcat -d -s AnsReader 2>/dev/null | grep -E "OVERLAY\[" | tail -3

# 连拍三张：间隔 2.5s，滚动中文字位置应变化
screencap -p /sdcard/scroll-a.png
sleep 2
screencap -p /sdcard/scroll-b.png
sleep 2
screencap -p /sdcard/scroll-c.png
echo "=== shot done ==="
ls -l /sdcard/scroll-*.png