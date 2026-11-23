#!/system/bin/sh
# 不重启，靠 force-stop + 重新绑定服务触发 LSPosed 重新 fork 目标进程
echo 1 > /data/data/com.air.mpprobe/files/skip.flag
chown u0_a205:u0_a205 /data/data/com.air.mpprobe/files/skip.flag
chmod 644 /data/data/com.air.mpprobe/files/skip.flag
am force-stop com.air.mpprobe
sleep 1
settings put secure enabled_accessibility_services ""
sleep 1
settings put secure enabled_accessibility_services com.air.mpprobe/com.air.mpprobe.ReaderService
sleep 5
echo "pid: $(ps -A | grep mpprobe | head -1)"
echo "--- SkipModule ---"
M=$(ls -t /data/adb/lspd/log/modules_*.log | head -1)
grep -h SkipModule "$M" | tail -8