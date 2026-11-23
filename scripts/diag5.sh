#!/system/bin/sh
echo "=== User state block ==="
dumpsys package com.air.mpprobe | grep -A8 "User 0:"
echo
echo "=== explicit MAIN/LAUNCHER start ==="
am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.air.mpprobe/.Main 2>&1 | head -4
echo
echo "=== monkey ==="
monkey -p com.air.mpprobe -c android.intent.category.LAUNCHER 1 2>&1 | tail -4
echo
echo "=== component enabled state ==="
cmd package get-component-enabled-setting com.air.mpprobe/.Main 2>&1 | head -3
echo
echo "=== HMA filtering? ==="
logcat -d 2>/dev/null | grep -i "AppsFilter\|hidemyapp" | tail -8