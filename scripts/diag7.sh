#!/system/bin/sh
cp /data/adb/lspd/config/modules_config.db /data/local/tmp/now2.db
chmod 666 /data/local/tmp/now2.db
echo "=== verbose full boot around skipmodule ==="
V=$(ls -t /data/adb/lspd/log/verbose_*.log | head -1)
wc -l "$V"
grep -nE "skipmodule|Failed to find|module" "$V" | head -40