#!/system/bin/sh
settings put secure enabled_accessibility_services com.air.mpprobe/com.air.mpprobe.ReaderService
settings put secure accessibility_enabled 1
sleep 3
dumpsys accessibility | grep -i "Bound services" | head -1