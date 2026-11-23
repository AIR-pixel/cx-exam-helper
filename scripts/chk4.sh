#!/system/bin/sh
echo "=== users: package per user ==="
for u in 0 999; do
  echo -n "user $u: "
  pm list packages --user $u 2>/dev/null | grep -c skipmodule
done
echo
echo "=== db row check ==="
cp /data/adb/lspd/config/modules_config.db /data/local/tmp/cur.db
chmod 666 /data/local/tmp/cur.db
ls -l /data/local/tmp/cur.db
echo
echo "=== logcat LSPosed boot ==="
logcat -d -s LSPosedFramework LSPosedService 2>/dev/null | head -30
echo
echo "=== mpprobe running? ==="
ps -A | grep mpprobe
echo
echo "=== HMA config dirs ==="
ls -la /data/misc/hma 2>/dev/null || echo "no /data/misc/hma"