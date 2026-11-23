#!/system/bin/sh
D=/data/adb/lspd/config
echo "--- db files ---"
ls -l $D
echo "--- skipmodule in modules.log ---"
grep -h SkipModule /data/adb/lspd/log/modules_*.log 2>/dev/null | tail -8
echo "--- mpprobe hook activity ---"
grep -h mpprobe /data/adb/lspd/log/modules_*.log 2>/dev/null | tail -5
echo "--- end ---"