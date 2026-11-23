#!/system/bin/sh
pm dump com.air.mpprobe 2>/dev/null | grep -E "label|versionName" | head -6
echo "---"
# 取应用名（i18n）
dumpsys package com.air.mpprobe 2>/dev/null | grep -A1 "com.air.mpprobe" | grep -i nonLocalizedLabel | head -2