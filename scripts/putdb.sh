#!/system/bin/sh
D=/data/adb/lspd/config
set -x
cp /data/local/tmp/mc5.db $D/modules_config.db
rm -f $D/modules_config.db-wal $D/modules_config.db-shm
chown root:root $D/modules_config.db
chmod 660 $D/modules_config.db
set +x
ls -l $D/modules_config.db*