#!/system/bin/sh
echo "=== CE storage mounted? ==="
ls /data/user/0/com.air.mpprobe 2>&1 | head -3
echo "--- data/media ---"
ls /data/media/0/ 2>&1 | head -3
echo
echo "=== can we resolve ANY app? ==="
cmd package resolve-activity --brief -c android.intent.category.LAUNCHER com.air.exammock 2>&1 | tail -2
cmd package resolve-activity --brief -c android.intent.category.LAUNCHER com.android.settings 2>&1 | tail -2
echo
echo "=== start settings (builtin) ==="
am start -n com.android.settings/.Settings 2>&1 | head -2