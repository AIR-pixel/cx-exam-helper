#!/system/bin/sh
LOG=$(ls -t /data/adb/lspd/log/verbose_*.log | head -1)
MOD=$(ls -t /data/adb/lspd/log/modules_*.log | head -1)
echo "verbose=$LOG"
echo "modules=$MOD"
echo "--- skipmodule in verbose ---"
grep -i skipmodule "$LOG" | tail -10
echo "--- mpprobe in verbose ---"
grep -i mpprobe "$LOG" | tail -15
echo "--- modules.log tail ---"
tail -20 "$MOD"
echo "--- errors ---"
grep -iE "error|fail|warn" "$LOG" | tail -20