#!/system/bin/sh
echo "=== crash / a11y errors ==="
logcat -d 2>/dev/null | grep -iE "mpprobe|AccessibilityService|ReaderService" | tail -30
echo
echo "=== am start Main ==="
am start -n com.air.mpprobe/.Main 2>&1 | head -5
sleep 3
ps -A | grep mpprobe