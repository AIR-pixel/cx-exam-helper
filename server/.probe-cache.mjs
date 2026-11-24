import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(new URL('./answer-cache.db', import.meta.url).pathname.replace(/^\//, ''));
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('tables:', tables.map((t) => t.name).join(', '));
const t = tables[0]?.name;
if (t) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  console.log('cols:', cols.join(', '));
  const rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid DESC LIMIT 15`).all();
  for (const r of rows) {
    console.log('---');
    for (const k of cols) {
      const v = String(r[k] ?? '');
      if (v.length > 80) console.log(`  ${k}: ${v.slice(0, 80)}…`);
      else console.log(`  ${k}: ${v}`);
    }
  }
}
