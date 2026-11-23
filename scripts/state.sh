#!/system/bin/sh
echo "=== enabled state ==="
pm list packages -d | grep mpprobe
echo "(empty above = not disabled)"
echo "=== pkg full head ==="
dumpsys package com.air.mpprobe | head -25
echo "=== try enable + resolve ==="
pm enable com.air.mpprobe
cmd package resolve-activity --brief com.air.mpprobe 2>&1 | tail -3