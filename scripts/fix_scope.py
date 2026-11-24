#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_scope.py —— 更新 LSPosed DB：修 com.air.skipmodule 的 apk_path + 加 android scope
用法: python fix_scope.py <db路径> <新apk_path>
改完用 putdb.sh 推回设备。
"""
import sqlite3
import sys

db_path = sys.argv[1]
apk_path = sys.argv[2]

c = sqlite3.connect(db_path)

# 1. 更新 apk_path
c.execute("UPDATE modules SET apk_path=? WHERE module_pkg_name='com.air.skipmodule'", (apk_path,))

# 2. 加 android 到 scope（幂等）
c.execute(
    "INSERT OR IGNORE INTO scope(module_pkg_name, app_pkg_name, user_id) VALUES (?,?,0)",
    ("com.air.skipmodule", "system"),
)
# 清掉之前误加的 android（system_server 在 LSPosed 里报 "system"）
c.execute("DELETE FROM scope WHERE module_pkg_name='com.air.skipmodule' AND app_pkg_name='android'")
c.commit()

print("modules:")
for r in c.execute("select * from modules where module_pkg_name='com.air.skipmodule'"):
    print("  ", r)
print("scope:")
for r in c.execute("select * from scope where module_pkg_name='com.air.skipmodule'"):
    print("  ", r)
c.close()
