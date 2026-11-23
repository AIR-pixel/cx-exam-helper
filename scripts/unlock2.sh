#!/system/bin/sh
echo "=== try locksettings ==="
locksettings set-disabled true 2>&1
locksettings verify 2>&1 | head -2
sleep 1
echo "=== dismiss again ==="
wm dismiss-keyguard 2>&1
input keyevent 82
sleep 2
dumpsys window 2>/dev/null | grep -i "isKeyguardShowing" | head -1
dumpsys trust 2>/dev/null | grep -i "deviceLocked" | head -1
echo
echo "=== resolve ==="
cmd package resolve-activity --brief -c android.intent.category.LAUNCHER com.air.mpprobe 2>&1 | tail -2