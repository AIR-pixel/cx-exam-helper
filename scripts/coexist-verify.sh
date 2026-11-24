#!/system/bin/sh
LOG=$(ls -t /data/adb/lspd/log/modules_*.log 2>/dev/null | head -1)
echo "=== LSPosed log: VolKey + SkipModule ==="
grep -iE "VolKey|SkipModule" "$LOG" 2>/dev/null | tail -12
echo "=== a11y bound ==="
dumpsys accessibility 2>/dev/null | grep -i "Bound services" | head -1
echo "=== chaoxing root visibility test (from shell context, informational) ==="
ls -lZ /data/adb/magisk 2>/dev/null | head -1
echo DONE