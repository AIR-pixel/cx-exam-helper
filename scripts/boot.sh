#!/system/bin/sh
# 解锁 + 起服务 + 看模块是否加载
input keyevent KEYCODE_WAKEUP
sleep 1
input swipe 540 2000 540 700 150
sleep 1
input swipe 540 2000 540 700 150
sleep 2
echo "keyguard: $(dumpsys window 2>/dev/null | grep -c 'isKeyguardShowing=true')"
echo "CE: $(ls -d /data/user/0/com.air.mpprobe 2>&1)"
settings put secure accessibility_enabled 1
settings put secure enabled_accessibility_services com.air.mpprobe/com.air.mpprobe.ReaderService
sleep 4
echo "bound: $(dumpsys accessibility | grep 'Bound services' | head -1)"
echo "pid: $(ps -A | grep mpprobe | head -1)"
echo "--- SkipModule log ---"
M=$(ls -t /data/adb/lspd/log/modules_*.log | head -1)
grep -h SkipModule "$M" | tail -6
echo "--- verbose ---"
V=$(ls -t /data/adb/lspd/log/verbose_*.log | head -1)
grep -i "skipmodule" "$V" | tail -6