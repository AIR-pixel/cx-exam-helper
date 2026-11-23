#!/usr/bin/env node
/**
 * test-cache.mjs —— answer-cache.mjs 离线单测
 */
import { unlinkSync } from 'node:fs';
import { AnswerCache } from './answer-cache.mjs';
import { normalizeForHash } from './answer-core.mjs';

let pass = 0, fail = 0;
const fails = [];
function eq(name, a, e) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++; fails.push(`${name}\n   actual:   ${A}\n   expected: ${E}`);
}
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push(`${name}${detail ? '\n   ' + detail : ''}`);
}

const Q1 = {
  stem: '下列关于TCP三次握手的说法,正确的是',
  options: [{ key: 'A', text: '第一次握手发送SYN' }, { key: 'B', text: '第二次发送SYN-ACK' }],
  type: 'single',
};
const Q1_NOISY = {
  stem: '下列关于 TCP 三次握手的说法。正确的是',
  options: [{ key: 'A', text: '第一次握手发送SYN' }, { key: 'B', text: '第二次发送SYN-ACK' }],
  type: 'single',
};
const Q2 = { stem: 'UDP是面向连接的', options: [{ key: 'A', text: '对' }, { key: 'B', text: '错' }], type: 'judge' };

// ══════════ 1. 基本读写 ══════════
{
  const c = new AnswerCache(':memory:');
  eq('空库 get', c.get(Q1), null);

  const key = c.put(Q1, { mode: 'text', type: 'single', params: { selectedIndex: 1 } });
  ok('put 返回 qkey', typeof key === 'string' && key.length === 32);

  const got = c.get(Q1);
  ok('put 后 get 命中', got !== null);
  eq('缓存内容正确', got.answer, { mode: 'text', type: 'single', params: { selectedIndex: 1 } });
  eq('默认 source=ai', got.source, 'ai');

  eq('stats total', c.stats().total, 1);
  c.close();
}

// ══════════ 2. 归一化去重 ══════════
{
  const c = new AnswerCache(':memory:');
  c.put(Q1, { mode: 'text', type: 'single', params: { selectedIndex: 1 } });
  const got = c.get(Q1_NOISY);
  ok('标点/空白差异仍命中同题', got !== null,
    `Q1 key=${normalizeForHash(Q1)}  noisy key=${normalizeForHash(Q1_NOISY)}`);
  eq('去重后库里只有 1 条', c.stats().total, 1);
  c.close();
}

// ══════════ 3. 命中计数 ══════════
{
  const c = new AnswerCache(':memory:');
  c.put(Q1, { params: { selectedIndex: 1 } });
  const h1 = c.get(Q1);
  const h2 = c.get(Q1);
  eq('首次命中 hits=1', h1.hits, 1);
  eq('二次命中 hits=2', h2.hits, 2);
  eq('stats hits 累计', c.stats().hits, 2);
  c.close();
}

// ══════════ 4. 覆盖写 ══════════
{
  const c = new AnswerCache(':memory:');
  c.put(Q1, { params: { selectedIndex: 1 } }, 'ai');
  c.put(Q1, { params: { selectedIndex: 0 } }, 'ocs');
  const got = c.get(Q1);
  eq('覆盖后答案更新', got.answer, { params: { selectedIndex: 0 } });
  eq('覆盖后 source 更新', got.source, 'ocs');
  eq('覆盖不增加条数', c.stats().total, 1);
  c.close();
}

// ══════════ 5. 多题并存 + 按 source 统计 ══════════
{
  const c = new AnswerCache(':memory:');
  c.put(Q1, { params: { selectedIndex: 1 } }, 'ai');
  c.put(Q2, { params: { selectedIndex: 0 } }, 'ocs');
  eq('两题并存', c.stats().total, 2);
  const s = c.stats();
  eq('bySource ai', s.bySource.ai, 1);
  eq('bySource ocs', s.bySource.ocs, 1);
  c.close();
}

// ══════════ 6. delete / clear ══════════
{
  const c = new AnswerCache(':memory:');
  c.put(Q1, { params: {} });
  c.put(Q2, { params: {} });
  c.delete(Q1);
  eq('delete 后只剩 1', c.stats().total, 1);
  eq('delete 的那题查不到', c.get(Q1), null);
  c.clear();
  eq('clear 后为空', c.stats().total, 0);
  c.close();
}

// ══════════ 7. recent / 统计视图 ══════════
{
  const c = new AnswerCache(':memory:');
  c.put(Q1, { params: {} });
  c.put(Q2, { params: {} });
  const r = c.recent(10);
  eq('recent 返回 2 条', r.length, 2);
  ok('recent 有 qkey', r.every((x) => typeof x.qkey === 'string'));
  ok('recent stem 截断', r.every((x) => x.stem.length <= 80));
  c.close();
}

// ══════════ 8. 落盘持久化 ══════════
{
  const tmp = `./.tmp-test-cache-${Date.now()}.db`;
  const c1 = new AnswerCache(tmp);
  c1.put(Q1, { params: { selectedIndex: 1 } });
  c1.close();

  const c2 = new AnswerCache(tmp);
  const got = c2.get(Q1);
  ok('落盘后重开仍命中', got !== null);
  eq('落盘答案一致', got.answer, { params: { selectedIndex: 1 } });
  c2.clear();
  c2.close();

  for (const s of ['', '-wal', '-shm']) { try { unlinkSync(tmp + s); } catch { } }
}

console.log(`\n${'='.repeat(60)}`);
if (fail === 0) { console.log(`PASS  全部 ${pass} 项通过`); process.exit(0); }
console.log(`FAIL  ${fail} 失败 / ${pass} 通过\n`);
for (const f of fails) console.log(' ✗ ' + f + '\n');
process.exit(1);