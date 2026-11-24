#!/system/bin/sh
echo "=== modules_config tables ==="
su -c "sqlite3 /data/adb/lspd/config/modules_config.db '.tables'" 2>/dev/null || python3 -c "pass"
echo "=== schema ==="
su -c "sqlite3 /data/adb/lspd/config/modules_config.db '.schema'" 2>/dev/null | head -30
echo "=== scope entries ==="
su -c "sqlite3 /data/adb/lspd/config/modules_config.db 'select * from scope'" 2>/dev/null | head -20
echo "=== modules ==="
su -c "sqlite3 /data/adb/lspd/config/modules_config.db 'select mid,module_name,apk_path,enabled from modules'" 2>/dev/null
echo DONE