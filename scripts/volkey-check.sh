#!/system/bin/sh
LOG=$(ls -t /data/adb/lspd/log/modules_*.log 2>/dev/null | head -1)
echo "=== tail 60 ==="
tail -60 "$LOG" 2>/dev/null
echo "=== error lines ==="
grep -iE "error|fail|skipmodule|volkey|android" "$LOG" 2>/dev/null | tail -20
echo DONE