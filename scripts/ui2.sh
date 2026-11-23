#!/system/bin/sh
# 验证新浮层：Q1 单选短答案 与 Q5 长简答（高度自适应）
FLAG=/data/data/com.air.mpprobe/files/skip.flag
echo 0 > "$FLAG"; chown u0_a205:u0_a205 "$FLAG"; chmod 644 "$FLAG"

load() {
  am force-stop com.air.mpprobe; sleep 1
  settings put secure accessibility_enabled 1
  settings put secure enabled_accessibility_services com.air.mpprobe/com.air.mpprobe.ReaderService
  sleep 3
}

goto_q() {
  am force-stop com.air.exammock; sleep 1
  am start -n com.air.exammock/.MockExam >/dev/null 2>&1
  sleep 6
  i=1
  while [ "$i" -lt "$1" ]; do
    input tap 540 2320
    sleep 2
    i=$((i+1))
  done
  sleep 4
}

load
for Q in 1 5; do
  logcat -c 2>/dev/null
  goto_q $Q
  echo "===== Q$Q ====="
  logcat -d -s AnsReader 2>/dev/null | grep -E "OVERLAY\[" | tail -2
  screencap -p "/sdcard/ui-q$Q.png"
  Q=$((Q+1))
done
echo DONE