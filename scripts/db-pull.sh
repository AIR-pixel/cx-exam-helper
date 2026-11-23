#!/system/bin/sh
D=/data/adb/lspd/config
cp $D/modules_config.db /sdcard/mc3.db
cp $D/modules_config.db-wal /sdcard/mc3.db-wal 2>/dev/null
cp $D/modules_config.db-shm /sdcard/mc3.db-shm 2>/dev/null
chmod 666 /sdcard/mc3.db*
ls -l /sdcard/mc3.db*
echo "--- scope/module counts ---"
echo done