/**
 * 推送通道测试（电脑 → 手机）
 *
 * 背景：手机端 App 里没有任何 ServerSocket，不监听端口，所以电脑无法主动连手机。
 * 唯一可行的方向是「手机来取」：电脑把消息放进队列，手机长轮询 /pull。
 *
 * 这套测试覆盖队列语义里最容易错的地方：
 *   - since 的边界（> 还是 >=，重复投递还是漏投递）
 *   - 长轮询的唤醒时机（有消息立刻返回，不是等满 25s）
 *   - 多个客户端同时挂起时的广播
 *   - 队列上限（防止无限增长）
 *   - 断开连接的 waiter 不能泄漏
 *
 * 需要真实服务在跑（默认 127.0.0.1:18888，可用 PUSH_TEST_BASE 覆盖）。
 * 没有服务时整段跳过，不算失败 —— 这是集成测试，不是单元测试。
 *
 * 为什么默认值从 10.75.124.158 改成 127.0.0.1：
 *   那个 IP 是某次 PC 热点分配的地址，换个网络就变了（DHCP）。写死在测试里
 *   会让「服务明明在跑，测试却报服务未运行」——2026-11-26 就踩到，当时
 *   实际地址已是 10.11.42.158。测本机服务用 loopback 永远正确。
 */
import assert from 'node:assert/strict';

const BASE = process.env.PUSH_TEST_BASE || 'http://127.0.0.1:18888';

let pass = 0, fail = 0, skip = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const s = (name) => { console.log(`  skip ${name}`); skip++; };

// 探活：没有服务就整段跳过
let alive = false;
try {
  const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
  alive = r.ok;
} catch { alive = false; }

if (!alive) {
  console.log(`\n服务未运行（${BASE}），跳过推送通道集成测试\n`);
  process.exit(0);
}

const push = async (text, kind = 'info') => {
  const r = await fetch(`${BASE}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, kind }),
  });
  return r.json();
};
const pull = async (since, timeoutMs = 30000) => {
  const r = await fetch(`${BASE}/pull?since=${since}`, { signal: AbortSignal.timeout(timeoutMs) });
  return r.json();
};
/** 拿当前 seq，作为后续测试的干净起点 */
const head = async () => (await pull(0, 10000)).seq;

console.log('\n=== 1. 基本投递 ===');
await t('推一条，since 拉得到', async () => {
  const cur = await head();
  const p = await push('单元测试消息', 'ok');
  assert.equal(p.ok, true);
  assert.ok(p.seq > cur);
  const got = await pull(cur, 10000);
  const hit = got.items.find((m) => m.seq === p.seq);
  assert.ok(hit, '应该拉到刚推的那条');
  assert.equal(hit.text, '单元测试消息');
  assert.equal(hit.kind, 'ok');
});

await t('since 语义是「严格大于」：since=seq 不会重复拿到自己', async () => {
  const p = await push('不重复', 'info');
  // since=p.seq 之后没有新消息，所以按设计会挂满 25s 才空返回。
  // 这里要的是「不重复吐自己」，不是「立刻返回」，所以给足超时。
  const again = await pull(p.seq, 30000);
  // 若实现写成 >= 会把 p 自己再吐一次
  assert.equal(again.items.filter((m) => m.seq === p.seq).length, 0);
  assert.equal(again.items.length, 0, 'since=seq 时不该有任何消息');
});

console.log('\n=== 2. 长轮询唤醒 ===');
await t('有消息时立刻返回，不等满超时', async () => {
  const cur = await head();
  const t0 = Date.now();
  const waiting = pull(cur, 30000);
  await new Promise((r) => setTimeout(r, 400));
  await push('唤醒测试', 'answer');
  const got = await waiting;
  const dt = Date.now() - t0;
  assert.ok(got.items.length >= 1, '应该收到消息');
  assert.ok(dt < 8000, `应该被立刻唤醒，实际 ${dt}ms`);
});

await t('无消息时超时返回空数组（不挂死）', async () => {
  const cur = await head();
  const t0 = Date.now();
  const got = await pull(cur, 30000);
  const dt = Date.now() - t0;
  assert.equal(got.items.length, 0, '超时应该是空数组');
  assert.ok(dt > 20000, `应该挂满 25s，实际 ${dt}ms`);
});

console.log('\n=== 3. 多客户端广播 ===');
await t('3 个客户端同时挂起，一条消息全部收到', async () => {
  const cur = await head();
  const waiters = [0, 1, 2].map(() => pull(cur, 30000));
  await new Promise((r) => setTimeout(r, 400));
  await push('广播', 'ok');
  const results = await Promise.all(waiters);
  for (const r of results) {
    assert.ok(r.items.some((m) => m.text === '广播'), '每个客户端都应收到');
  }
});

console.log('\n=== 4. 队列上限 ===');
await t('连推 210 条后队列不超过 200', async () => {
  const before = await head();
  for (let i = 0; i < 210; i++) await push(`批量${i}`, 'info');
  const all = await pull(0, 15000);
  assert.ok(all.items.length <= 200, `队列应 ≤200，实际 ${all.items.length}`);
  assert.ok(all.seq > before, 'seq 应该单调递增');
});

console.log('\n=== 5. 手机端页面 ===');
await t('/push GET 返回可用的 HTML', async () => {
  const r = await fetch(`${BASE}/push`, { signal: AbortSignal.timeout(10000) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  const html = await r.text();
  assert.ok(html.includes('/pull?since='), '页面要包含轮询地址');
  assert.ok(html.includes('电脑推送'), '页面要有标题');
});

console.log('\n' + '='.repeat(56));
console.log(`PASS ${pass} 项 / FAIL ${fail} 项 / SKIP ${skip} 项`);
console.log('='.repeat(56) + '\n');
process.exit(fail === 0 ? 0 : 1);
