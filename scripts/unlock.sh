#!/system/bin/sh
input keyevent 82
sleep 1
input swipe 540 1800 540 600 200
sleep 2
echo "--- keyguard now ---"
dumpsys window 2>/dev/null | grep -i "isKeyguardShowing" | head -1
echo "--- start Main ---"
am start -n com.air.mpprobe/.Main 2>&1 | head -3
sleep 2
echo "--- a11y ---"
dumpsys accessibility | grep "Bound services" | head -1