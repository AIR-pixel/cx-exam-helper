#!/system/bin/sh
V=$(ls -t /data/adb/lspd/log/verbose_*.log | head -1)
echo "verbose=$V"
echo "--- skipmodule ---"
grep -i skipmodule "$V" | tail -10
echo "--- 'Loaded module' / module scan ---"
grep -iE "loaded module|modules: |scan" "$V" | tail -10
echo "--- pkg info fail ---"
grep -i "Failed to find package info" "$V" | tail -10
echo "--- mpprobe ---"
grep -i mpprobe "$V" | tail -10
echo "--- manager view: is db readable by lspd ---"
ls -l /data/adb/lspd/config/modules_config.db