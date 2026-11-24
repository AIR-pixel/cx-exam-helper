#!/system/bin/sh
# 生成 LSPosed DB 的一致快照（含 wal），拷到 /data/local/tmp 供 pull
SRC=/data/adb/lspd/config/modules_config.db
DST=/data/local/tmp/mc-live
rm -f ${DST}*
cp $SRC ${DST}.db
cp ${SRC}-wal ${DST}.db-wal 2>/dev/null
cp ${SRC}-shm ${DST}.db-shm 2>/dev/null
chmod 666 ${DST}*
ls -l ${DST}*
echo DONE