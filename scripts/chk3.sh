#!/system/bin/sh
echo "--- users ---"
pm list users
echo "--- skipmodule per user ---"
pm list packages --user 0 | grep skipmodule
echo "--- locspoof apk pull for manifest compare ---"
cp /data/app/~~G43NcRQld-TErzW_hdNjPw==/com.air.locspoof-_LtoVtyHvSIAAwMZNgkC2Q==/base.apk /sdcard/locspoof.apk
chmod 666 /sdcard/locspoof.apk
cp /data/app/~~caD8jy3XqJHjM9hRLSQTqg==/com.air.skipmodule-VCsWxL6mUXdDj0ZHEhG-fA==/base.apk /sdcard/skipmodule.apk
chmod 666 /sdcard/skipmodule.apk
ls -l /sdcard/*.apk