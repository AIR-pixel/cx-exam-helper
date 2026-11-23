#!/system/bin/sh
# 严格 A/B：每轮都验证卡片确实被绘制（AnsReader OVERLAY 日志），
# 再看 screencap 里有没有像素。避免把「服务没绑定」误判成「SKIP 生效」。
FLAG=/data/data/com.air.mpprobe/files/skip.flag

wait_overlay() {
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if logcat -d -s AnsReader 2>/dev/null | grep -q "OVERLAY\["; then return 0; fi
  done
  return 1
}

run_one() {
  v="$1"; out="$2"
  echo "$v" > "$FLAG"
  chown u0_a205:u0_a205 "$FLAG"; chmod 644 "$FLAG"
  logcat -c 2>/dev/null
  am force-stop com.air.mpprobe
  sleep 1
  settings put secure enabled_accessibility_services ""
  sleep 1
  settings put secure enabled_accessibility_services com.air.mpprobe/com.air.mpprobe.ReaderService
  sleep 3
  am force-stop com.air.exammock
  sleep 1
  am start -n com.air.exammock/.MockExam >/dev/null 2>&1
  sleep 8
  if wait_overlay; then echo "flag=$v overlay=DRAWN"; else echo "flag=$v overlay=MISSING(无效轮次)"; fi
  grep -h "OVERLAY\[" /dev/null 2>/dev/null
  logcat -d -s AnsReader 2>/dev/null | grep "OVERLAY\[" | tail -1
  M=$(ls -t /data/adb/lspd/log/modules_*.log | head -1)
  grep -h "SKIP applied" "$M" | tail -1
  screencap -p "$out"
  echo "flag=$v saved=$out"
}

run_one 1 /sdcard/ab2-skipon.png
echo "====="
run_one 0 /sdcard/ab2-skipoff.png
echo DONE