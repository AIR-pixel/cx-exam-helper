#!/system/bin/sh
am force-stop com.air.exammock
sleep 1
am start -n com.air.exammock/.MockExam >/dev/null 2>&1
sleep 5
uiautomator dump /sdcard/exam-tree.xml >/dev/null 2>&1
echo "=== exam a11y tree ==="
cat /sdcard/exam-tree.xml
echo DONE