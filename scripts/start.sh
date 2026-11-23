#!/system/bin/sh
settings put secure accessibility_enabled 1
settings put secure enabled_accessibility_services com.air.mpprobe/com.air.mpprobe.ReaderService
sleep 4
echo "--- bound ---"
dumpsys accessibility | grep -A2 "Bound services" | head -4
echo "--- mpprobe pid ---"
ps -A | grep mpprobe
echo "--- SkipModule in modules.log ---"
M=$(ls -t /data/adb/lspd/log/modules_*.log | head -1)
grep -h SkipModule "$M" | tail -8