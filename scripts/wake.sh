#!/system/bin/sh
echo "=== power state ==="
dumpsys power 2>/dev/null | grep -iE "mWakefulness=|Display Power" | head -3
echo "=== wake ==="
input keyevent KEYCODE_WAKEUP
sleep 1
input keyevent 82
sleep 1
dumpsys power 2>/dev/null | grep -iE "mWakefulness=" | head -1
echo "=== swipe up twice ==="
input swipe 540 2000 540 700 150
sleep 1
input swipe 540 2000 540 700 150
sleep 2
dumpsys window 2>/dev/null | grep -i "isKeyguardShowing" | head -1
dumpsys trust 2>/dev/null | grep -i deviceLocked | head -1
echo "=== CE mount check ==="
ls -d /data/user/0/com.air.mpprobe 2>&1
echo "=== try resolve ==="
cmd package resolve-activity --brief -c android.intent.category.LAUNCHER com.air.mpprobe 2>&1 | tail -2