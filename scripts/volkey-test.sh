#!/system/bin/sh
logcat -c 2>/dev/null
# 双击 VOLUME_UP
input keyevent 24
sleep 0.2
input keyevent 24
sleep 1
# 双击 VOLUME_DOWN
input keyevent 25
sleep 0.2
input keyevent 25
sleep 2
echo "=== hook + receiver logs ==="
logcat -d 2>/dev/null | grep -iE "VolKey|AnsToggle|mpprobe.TOGGLE" | tail -30
echo "=== LSPosed module log VolKey ==="
LOG=$(ls -t /data/adb/lspd/log/modules_*.log 2>/dev/null | head -1)
grep -i "VolKey" "$LOG" 2>/dev/null | tail -15
echo DONE