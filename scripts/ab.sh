#!/system/bin/sh
# 一次跑完整 A/B：flag=1 与 flag=0 各一轮，同一题目页
set -e
FLAG=/data/data/com.air.mpprobe/files/skip.flag
mkdir -p /data/data/com.air.mpprobe/files
chown u0_a205:u0_a205 /data/data/com.air.mpprobe/files 2>/dev/null || true
chmod 771 /data/data/com.air.mpprobe/files

run_one() {
  v="$1"; out="$2"
  echo "$v" > "$FLAG"
  chown u0_a205:u0_a205 "$FLAG"
  chmod 644 "$FLAG"
  echo "--- flag=$(cat $FLAG) ---"
  am force-stop com.air.mpprobe
  sleep 1
  settings put secure enabled_accessibility_services com.air.mpprobe/com.air.mpprobe.ReaderService
  sleep 3
  am force-stop com.air.exammock
  sleep 1
  am start -n com.air.exammock/.MockExam >/dev/null 2>&1
  sleep 9
  screencap -p "$out"
  echo "--- reader log ---"
  logcat -d -s AnsReader 2>/dev/null | grep -E "answer |OVERLAY" | tail -3
  echo "--- skipmodule log ---"
  M=$(ls -t /data/adb/lspd/log/modules_*.log | head -1)
  grep -h SkipModule "$M" | tail -3
}

run_one 1 /sdcard/ab-skipon.png
echo "====="
run_one 0 /sdcard/ab-skipoff.png
echo "DONE"