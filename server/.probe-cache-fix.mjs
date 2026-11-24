// .probe-cache-fix.mjs —— 清理 OCR 电量碎片污染的题库条目
//
// 背景：图片题 OCR 把状态栏电量读成 "l78" / "￥578" / "￥78" 并拼进题干，
// 同一道「IP 协议工作在哪一层?」因此生成了 4 个不同 qkey，其中 3 条是垃圾。
// 本脚本按「题干是否以非中文/非字母碎片开头」识别污染行并删除。
import { DatabaseSync } from 'node:sqlite';

const dbPath = new URL('./answer-cache.db', import.meta.url).pathname.replace(/^\//, '');
const db = new DatabaseSync(dbPath);

const rows = db.prepare('SELECT qkey, stem, type, answer_json, source, hits FROM questions').all();
console.log(`总条目 ${rows.length}\n`);

// 污染判据：题干开头是「符号/数字碎片 + 空白」
const POLLUTED = /^\s*[^\u4e00-\u9fa5A-Za-z]{0,3}[lI|]?\d{1,3}[A-Za-z]?\s+[\u4e00-\u9fa5A-Za-z]/;
// 还有一类：题干里混进了状态栏/叠层文案
const POLLUTED2 = /Exam Mock|a11y\s*已连接|Vol[+＋]?[×x]2|KB\/s/;
// 第三类：题干以考试页导航条开头（修复前 groupNodes 把导航当题干的 bug）
const POLLUTED3 = /^\s*(?:答题卡|上一题|下一题|交卷|保存\s*提交)/;
// 第四类：题干为空（图片题靠选项硬猜时代的产物，没有复现价值）
const POLLUTED4 = (s) => !String(s || '').trim();

const bad = [];
const good = [];
for (const r of rows) {
  const s = String(r.stem || '');
  if (POLLUTED.test(s) || POLLUTED2.test(s) || POLLUTED3.test(s) || POLLUTED4(s)) bad.push(r);
  else good.push(r);
}

console.log(`污染 ${bad.length} 条，保留 ${good.length} 条\n`);
for (const r of bad) {
  console.log(`  [删] ${r.qkey.slice(0, 8)} ${r.type} hits=${r.hits} "${String(r.stem).slice(0, 60)}"`);
}
console.log('');
for (const r of good) {
  console.log(`  [留] ${r.qkey.slice(0, 8)} ${r.type} hits=${r.hits} "${String(r.stem).slice(0, 60)}"`);
}

if (process.argv.includes('--apply')) {
  const del = db.prepare('DELETE FROM questions WHERE qkey = ?');
  let n = 0;
  for (const r of bad) { del.run(r.qkey); n++; }
  console.log(`\n已删除 ${n} 条`);
  console.log(`剩余 ${db.prepare('SELECT COUNT(*) c FROM questions').get().c} 条`);
} else {
  console.log('\n（预览模式，加 --apply 才真删）');
}
