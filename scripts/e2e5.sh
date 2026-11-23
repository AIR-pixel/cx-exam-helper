#!/system/bin/sh
# 完整五题型端到端：读题 -> 送 PC -> 拿答案 -> 浮层显示 -> 截图为证
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
Q=1
while [ "$Q" -le 5 ]; do
  logcat -c 2>/dev/null
  goto_q $Q
  echo "===== Q$Q ====="
  logcat -d -s AnsReader 2>/dev/null | grep -E "attempt#.*usable=true|answer src=|OVERLAY\[" | tail -4
  screencap -p "/sdcard/e2e-q$Q.png"
  Q=$((Q+1))
done
echo DONE