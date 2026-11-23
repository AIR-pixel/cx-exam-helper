#!/usr/bin/env node
/**
 * e2e-server.mjs —— answer-server v2 端到端离线验证
 *
 * 起一个临时服务（独立端口 + 内存缓存），依次验证：
 *   1. /health 启动正常
 *   2. /parse 把真实 a11y 文本切成结构化题目
 *   3. /answer 首次 → 走引擎，落缓存
 *   4. /answer 同样题（换个标点写法）→ 命中缓存，source=cache
 *   5. /stats 计到 1 道题
 *   6. 判断题 / 填空题 / 多选题 分别走通
 *   7. 无题文本被正确拒绝
 *   8. 落盘缓存的持久化
 *
 * 用法: node e2e-server.mjs
 */
import { spawn } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';

const PORT = 18899;
const DB = `./.tmp-e2e-${Date.now()}.db`;
let child = null;

function cleanup() {
  if (child && !child.killed) { try { child.kill(); } catch { } }
  for (const s of ['', '-wal', '-shm']) { try { unlinkSync(DB + s); } catch { } }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function start() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['answer-server.mjs'], {
      env: { ...process.env, ANSWER_PORT: String(PORT), ANSWER_ENGINE: 'heuristic', ANSWER_CACHE: DB },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (/Answer server v2/.test(out)) resolve(out);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (c) => { if (!/Answer server v2/.test(out)) reject(new Error('server exited ' + c + '\n' + out)); });
    setTimeout(() => reject(new Error('start timeout\n' + out)), 8000);
  });
}

async function api(path, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, opts);
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; }
  catch { return { status: res.status, text }; }
}
const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return; }
  fail++; fails.push(`${name}${detail ? '\n      ' + detail : ''}`);
  console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
}

const SINGLE = `3.（2分）
单选题
下列关于TCP三次握手的说法,正确的是
A. 第一次握手客户端发送SYN
B. 第二次握手服务端发送SYN-ACK
C. 第三次握手客户端发送ACK
D. 以上都正确
标记
上一题
答题卡
下一题`;

const SINGLE_NOISY = `3.（2分）单选题
下列关于 TCP 三次握手的说法。正确的是
A. 第一次握手客户端发送SYN
B. 第二次握手服务端发送SYN-ACK
C. 第三次握手客户端发送ACK
D. 以上都正确`;

const JUDGE = `判断题
UDP 是面向连接的协议
A. 对
B. 错`;

const BLANK = `填空题
TCP 首部最小长度是 ____ 字节,最大是 ____ 字节`;

const MULTI = `【多选】下列哪些属于传输层协议
A. TCP
B. UDP
C. IP
D. ICMP`;

const NOISE_ONLY = `浏览模式
客服
登录
手机号/超星号
密码
忘记密码?
答题卡`;

async function main() {
  console.log('== 启动服务 ==');
  const boot = await start();
  console.log('   ' + boot.trim().split('\n').join('\n   '));

  const h = await api('/health');
  ok('/health ok', h.json?.ok === true, JSON.stringify(h.json));
  ok('/health engine=heuristic', h.json?.engine === 'heuristic', String(h.json?.engine));
  ok('/health 报出缓存路径', typeof h.json?.cache?.path === 'string', JSON.stringify(h.json?.cache));

  console.log('\n== /parse 结构化 ==');
  const p1 = await post('/parse', { question: SINGLE });
  ok('/parse ok=true', p1.json?.ok === true, JSON.stringify(p1.json?.questions));
  ok('/parse 切出 1 题', p1.json?.questions?.length === 1, String(p1.json?.questions?.length));
  ok('/parse 题型 single', p1.json?.primary?.type === 'single', String(p1.json?.primary?.type));
  ok('/parse 4 个选项', p1.json?.primary?.options?.length === 4,
    String(p1.json?.primary?.options?.length));
  ok('/parse 题干干净', !/标记|下一题|答题卡/.test(p1.json?.primary?.stem || ''),
    `stem=${p1.json?.primary?.stem}`);
  ok('/parse 有 screenHash', /^[0-9a-f]{16}$/.test(p1.json?.screenHash || ''),
    String(p1.json?.screenHash));

  console.log('\n== /answer 首次（走引擎 + 落缓存）==');
  const a1 = await post('/answer', { question: SINGLE });
  ok('/answer 有答案', typeof a1.json?.answer === 'string' && a1.json.answer.length > 0,
    JSON.stringify(a1.json));
  ok('/answer source=heuristic', a1.json?.source === 'heuristic', String(a1.json?.source));
  ok('/answer 答案形如 "A ..."', /^A\b/.test(a1.json?.answer || ''), String(a1.json?.answer));
  ok('/answer 带类型', a1.json?.type === 'single', String(a1.json?.type));

  console.log('\n== /answer 第二次（标点不同，应命中缓存）==');
  const a2 = await post('/answer', { question: SINGLE_NOISY });
  ok('/answer 二次 source=cache', a2.json?.source === 'cache', String(a2.json?.source));
  ok('/answer 二次答案一致', a2.json?.answer === a1.json?.answer,
    `${a1.json?.answer} vs ${a2.json?.answer}`);

  console.log('\n== /stats ==');
  const st = await api('/stats');
  ok('/stats total=1（去重生效）', st.json?.total === 1, JSON.stringify(st.json));
  ok('/stats hits>=1', (st.json?.hits || 0) >= 1, JSON.stringify(st.json));
  ok('/stats bySource 有记录', Object.keys(st.json?.bySource || {}).length > 0, JSON.stringify(st.json?.bySource));

  console.log('\n== 其他题型 ==');
  const j = await post('/answer', { question: JUDGE });
  ok('判断题 type=judge', j.json?.type === 'judge', String(j.json?.type));
  ok('判断题有答案', /^A\b/.test(j.json?.answer || ''), String(j.json?.answer));

  const b = await post('/answer', { question: BLANK });
  ok('填空题 type=blank', b.json?.type === 'blank', String(b.json?.type));
  ok('填空题答案用 | 分隔', (b.json?.answer || '').includes('|'), String(b.json?.answer));

  const m = await post('/answer', { question: MULTI });
  ok('多选题 type=multi', m.json?.type === 'multi', String(m.json?.type));
  ok('多选题有答案', (m.json?.answer || '').length > 0, String(m.json?.answer));

  console.log('\n== 无题文本 ==');
  const n = await post('/answer', { question: NOISE_ONLY });
  ok('纯噪音 source=none', n.json?.source === 'none', String(n.json?.source));
  ok('纯噪音 answer 说明文字', /未识别到题目/.test(n.json?.answer || ''), String(n.json?.answer));

  console.log('\n== /recent ==');
  const r = await api('/recent?limit=5');
  ok('/recent 有数据', Array.isArray(r.json?.items) && r.json.items.length > 0, JSON.stringify(r.json));
  ok('/recent stem 截断', (r.json?.items || []).every((x) => x.stem.length <= 80));

  console.log('\n== /cache/clear ==');
  const c = await post('/cache/clear', {});
  ok('clear ok', c.json?.ok === true, JSON.stringify(c.json));
  const st2 = await api('/stats');
  ok('clear 后 total=0', st2.json?.total === 0, JSON.stringify(st2.json));

  console.log('\n== 404 ==');
  const nf = await api('/nope');
  ok('未知路径 404', nf.status === 404, String(nf.status));

  // 收尾
  child.kill();
  await new Promise((r2) => setTimeout(r2, 300));

  console.log('\n== 落盘持久化 ==');
  ok('缓存文件已生成', existsSync(DB), DB);
  const boot2 = await start();
  const st3 = await api('/stats');
  ok('重启后统计可读', typeof st3.json?.total === 'number', JSON.stringify(st3.json));
  const a3 = await post('/answer', { question: JUDGE });
  ok('重启后判断题仍可答', (a3.json?.answer || '').length > 0, JSON.stringify(a3.json));
  child.kill();
  await new Promise((r3) => setTimeout(r3, 300));

  console.log(`\n${'='.repeat(60)}`);
  if (fail === 0) { console.log(`PASS  全部 ${pass} 项通过`); process.exit(0); }
  console.log(`FAIL  ${fail} 失败 / ${pass} 通过\n`);
  for (const f of fails) console.log(' ✗ ' + f.split('\n')[0]);
  process.exit(1);
}

main().catch((e) => { console.error('E2E ERROR: ' + e.stack); cleanup(); process.exit(1); });