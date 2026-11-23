import sqlite3, sys
p = sys.argv[1]
c = sqlite3.connect(p)
for t in ["modules", "modules_state", "scope", "module_configs"]:
    try:
        cols = [r[1] for r in c.execute("PRAGMA table_info(%s)" % t)]
        print("==", t, cols)
        for r in c.execute("select * from %s" % t):
            print("   ", r)
    except Exception as e:
        print(t, "ERR", e)