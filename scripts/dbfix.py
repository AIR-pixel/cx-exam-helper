import sqlite3, os, shutil, subprocess, sys

SRC = r'C:\Users\air\Documents\deepseek-harness\remote\research\_probe\mc3.db'
OUT = r'C:\Users\air\Documents\deepseek-harness\remote\research\_probe\mc5.db'
MOD = 'com.air.skipmodule'
TARGET = 'com.air.mpprobe'

apk = sys.argv[1] if len(sys.argv) > 1 else '/data/app/PLACEHOLDER/base.apk'

for ext in ('', '-wal', '-shm'):
    if os.path.exists(OUT + ext):
        os.remove(OUT + ext)
shutil.copy(SRC, OUT)

c = sqlite3.connect(OUT)
c.execute('INSERT OR REPLACE INTO modules(module_pkg_name, apk_path) VALUES (?,?)', (MOD, apk))
c.execute('INSERT OR REPLACE INTO modules_state(module_pkg_name, user_id, enabled, scope_request_blocked) VALUES (?,?,1,0)', (MOD, 0))
c.execute('INSERT OR REPLACE INTO scope(module_pkg_name, app_pkg_name, user_id) VALUES (?,?,0)', (MOD, TARGET))
c.commit()

print('modules:')
for r in c.execute('select * from modules'):
    print(' ', r)
print('state:')
for r in c.execute('select * from modules_state'):
    print(' ', r)
print('scope count:', c.execute('select count(*) from scope').fetchone()[0])

c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
c.close()
for ext in ('-wal', '-shm'):
    if os.path.exists(OUT + ext):
        os.remove(OUT + ext)
print('out =', OUT, os.path.getsize(OUT), 'bytes')