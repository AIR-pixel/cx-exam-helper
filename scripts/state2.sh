#!/system/bin/sh
echo "=== chx installed? ==="
pm list packages | grep -i chaoxing
echo "=== SKIP applied recent ==="
M=$(ls -t /data/adb/lspd/log/modules_*.log 2>/dev/null | head -1)
echo "log: $M"
grep -h "SKIP applied" "$M" 2>/dev/null | tail -2
echo "=== flag ==="
cat /data/data/com.air.mpprobe/files/skip.flag