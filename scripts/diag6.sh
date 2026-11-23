#!/system/bin/sh
cp /data/adb/lspd/config/modules_config.db /data/local/tmp/now.db
chmod 666 /data/local/tmp/now.db
echo "=== hma config locations ==="
find /data/system /data/misc /data/adb -maxdepth 3 -iname "*hma*" 2>/dev/null | head -20
echo "=== hma data dir ==="
ls -la /data/data/com.tsng.hidemyapplist/files 2>/dev/null | head -10
echo "=== lspd log: skipmodule full chain ==="
V=$(ls -t /data/adb/lspd/log/verbose_*.log | head -1)
grep -n "skipmodule" "$V" | head -20
echo "=== lspd modules.log content (last 40) ==="
M=$(ls -t /data/adb/lspd/log/modules_*.log | head -1)
tail -40 "$M"