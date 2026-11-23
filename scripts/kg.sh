#!/system/bin/sh
echo "=== keyguard secure? ==="
dumpsys trust 2>/dev/null | grep -iE "secure|StrongAuth" | head -5
echo "=== lockscreen settings ==="
settings get secure lockscreen.disabled
lockscreensecure=$(dumpsys window 2>/dev/null | grep -c "isKeyguardShowing=true")
echo "keyguard showing count=$lockscreensecure"
echo "=== dismiss ==="
wm dismiss-keyguard 2>&1
sleep 2
dumpsys window 2>/dev/null | grep -i "isKeyguardShowing" | head -1
echo
echo "=== pm resolve now ==="
cmd package resolve-activity --brief -c android.intent.category.LAUNCHER com.air.mpprobe 2>&1 | tail -3
echo
echo "=== pm path / paths ==="
pm path com.air.mpprobe
echo
echo "=== heavy: dump activities filter ==="
dumpsys package com.air.mpprobe 2>/dev/null | grep -c "Activity Resolver"