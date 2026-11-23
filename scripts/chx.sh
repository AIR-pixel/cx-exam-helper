#!/system/bin/sh
# 实测：学习通任意页面的 WebView 节点树对 a11y 是否可见
logcat -c 2>/dev/null
am force-stop com.chaoxing.mobile
sleep 1
am start -n com.chaoxing.mobile/.activity.SplashActivity >/dev/null 2>&1
sleep 10
echo "=== 当前窗口 ==="
dumpsys window windows | grep -E "mCurrentFocus|mFocusedApp" | head -2
echo "=== AnsReader 读到什么 ==="
logcat -d -s AnsReader 2>/dev/null | grep -E "attempt#|READ|give up" | tail -8