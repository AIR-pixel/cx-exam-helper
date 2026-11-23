import sqlite3, sys

p = r'C:\Users\air\Documents\deepseek-harness\remote\research\_probe\mc3.db'
c = sqlite3.connect(p)
for (n, s) in c.execute("select name,sql from sqlite_master where type='table'"):
    print('==', n)
    print(s)
print()
print('scope rows:', c.execute('select count(*) from scope').fetchone()[0])
for r in c.execute('select * from scope'):
    print(' ', r)