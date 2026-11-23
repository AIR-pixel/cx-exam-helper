import sqlite3
p = r"C:\Users\air\Documents\deepseek-harness\remote\research\_probe\verify.db"
c = sqlite3.connect(p)
print("scope:", list(c.execute("SELECT * FROM scope WHERE module_pkg_name='com.air.skipmodule'")))
print("state:", list(c.execute("SELECT * FROM modules_state WHERE module_pkg_name='com.air.skipmodule'")))
print("modules count:", list(c.execute("SELECT count(*) FROM modules"))[0][0])
c.close()
