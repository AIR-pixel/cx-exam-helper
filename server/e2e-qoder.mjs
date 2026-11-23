#!/usr/bin/env node
/**
 * e2e-qoder.mjs —— answer-server qoder 引擎端到端验证（需要网络 + PAT）
 *
 * 与 e2e-server.mjs 的分工：
 *   e2e-server.mjs  离线，ANSWER_ENGINE=heuristic，验管线与缓存逻辑
 *   本文件           在线，ANSWER_ENGINE=qoder，验真模型链路
 *
 * 验证点：
 *   1. 服务以 qoder 引擎起来（不是 fallback 成 heuristic）
 *   2. 五种题型各答一题，source 都是 qoder，答案形状符合题型
 *   3. 同题二次请求命中缓存，且缓存里 source=ai
 *   4. 简答题返回纯正文，不是 JSON 串
 *
 * 用法: node --import ./dsh-resolve-register.mjs e2e-qoder.mjs
 */
import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';

const PORT = 18902;
const DB = `./.tmp-e2e-qoder-${Date.now()}.db`;
let child = null;

function cleanup() {
  if (child && !child.killed) { try { child.kill(); } catch { } }
  for (const s of ['', '-wal', '-shm']) { try { unlinkSync(DB + s); } catch { } }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function start() {
  return new Promise((resolve, reject) => {
    child = spawn(
      process.execPath,
      ['--import', './dsh-resolve-register.mjs', 'answer-server.mjs'],
      {
        env: {
          ...process.env,
          ANSWER_PORT: String(PORT),
          ANSWER_ENGINE: 'qoder',
          ANSWER_CACHE: DB,
          QODER_MODEL: process.env.QODER_MODEL || 'dfmodel',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (/Answer server v2/.test(out)) resolve(out);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (c) => {
      if (!/Answer server v2/.test(out)) reject(new Error('server exited ' + c + '\n' + out));
    });
    setTimeout(() => reject(new Error('start timeout\n' + out)), 15000);
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
D. 以上都正确`;

const SINGLE_REWORDED = `3.（2分）单选题
下列关于 TCP 三次握手的说法。正确的是
A. 第一次握手客户端发送SYN
B. 第二次握手服务端发送SYN-ACK
C. 第三次握手客户端发送ACK
D. 以上都正确`;

const MULTI = `5.（4分）
多选题
下列哪些属于HTTP请求方法
A. GET
B. POST
C. DELETE
D. SEND`;

const JUDGE = `7.（2分）
判断题
TCP是面向连接的协议。
A. 对
B. 错`;

const BLANK = `9.（4分）
填空题
OSI参考模型共分为______层，TCP/IP模型共分为______层。`;

const SHORT = `11.（10分）
简答题
简述TCP与UDP的主要区别。`;

async function main() {
  console.log('== 启动 qoder 引擎服务 ==');
  const boot = await start();
  console.log('   ' + boot.trim().split('\n').join('\n   '));

  const h = await api('/health');
  ok('/health ok', h.json?.ok === true, JSON.stringify(h.json));
  ok('引擎是 qoder 而不是 fallback', h.json?.engine === 'qoder', String(h.json?.engine));

  console.log('\n== 单选 ==');
  const a1 = await post('/answer', { question: SINGLE });
  ok('单选 source=qoder', a1.json?.source === 'qoder', String(a1.json?.source));
  ok('单选 type=single', a1.json?.type === 'single', String(a1.json?.type));
  ok('单选答案形如 "X ..."', /^[A-H]\b/.test(a1.json?.answer || ''), String(a1.json?.answer));
  ok('单选答对 D', /^D\b/.test(a1.json?.answer || ''), String(a1.json?.answer));
  console.log(`     答案: ${a1.json?.answer}  (${a1.json?.ms}ms)`);

  console.log('\n== 多选 ==');
  const m = await post('/answer', { question: MULTI });
  ok('多选 type=multi', m.json?.type === 'multi', String(m.json?.type));
  ok('多选答案含多个字母', /;/.test(m.json?.answer || ''), String(m.json?.answer));
  const letters = (m.json?.answer || '').match(/\b[A-H]\b/g) || [];
  ok('多选正好 3 个选项', letters.length === 3, `got ${letters.length}: ${m.json?.answer}`);
  console.log(`     答案: ${m.json?.answer}  (${m.json?.ms}ms)`);

  console.log('\n== 判断 ==');
  const j = await post('/answer', { question: JUDGE });
  ok('判断 type=judge', j.json?.type === 'judge', String(j.json?.type));
  ok('判断答对 A 对', /^A\b/.test(j.json?.answer || ''), String(j.json?.answer));
  console.log(`     答案: ${j.json?.answer}  (${j.json?.ms}ms)`);

  console.log('\n== 填空 ==');
  const b = await post('/answer', { question: BLANK });
  ok('填空 type=blank', b.json?.type === 'blank', String(b.json?.type));
  ok('填空答案用 | 分隔两空', /\|/.test(b.json?.answer || ''), String(b.json?.answer));
  ok('填空答对 7 和 4', /7/.test(b.json?.answer || '') && /4/.test(b.json?.answer || ''),
    String(b.json?.answer));
  console.log(`     答案: ${b.json?.answer}  (${b.json?.ms}ms)`);

  console.log('\n== 简答 ==');
  const s = await post('/answer', { question: SHORT });
  ok('简答 type=short', s.json?.type === 'short', String(s.json?.type));
  const ans = s.json?.answer || '';
  ok('简答正文不是 JSON 串', !ans.trim().startsWith('{'), ans.slice(0, 80));
  ok('简答正文够长', ans.length > 60, `len=${ans.length}`);
  ok('简答命中关键词（面向连接/可靠）', /连接|可靠/.test(ans), ans.slice(0, 80));
  console.log(`     答案前 80 字: ${ans.slice(0, 80)}…  (${s.json?.ms}ms)`);

  console.log('\n== 缓存命中（改写标点后仍应命中）==');
  const a2 = await post('/answer', { question: SINGLE_REWORDED });
  ok('二次 source=cache', a2.json?.source === 'cache', String(a2.json?.source));
  ok('二次答案与首次一致', a2.json?.answer === a1.json?.answer,
    `${a1.json?.answer} vs ${a2.json?.answer}`);

  console.log('\n== /stats ==');
  const st = await api('/stats');
  // 5 道题里简答题不落缓存（answer-server 有意跳过 short：没有去重价值，且答案长）
  ok('/stats total=4（简答不入库）', st.json?.total === 4, JSON.stringify(st.json));
  ok('/stats bySource.ai=4', st.json?.bySource?.ai === 4, JSON.stringify(st.json?.bySource));
  ok('/stats hits>=1', (st.json?.hits || 0) >= 1, JSON.stringify(st.json));

  console.log('\n== /models ==');
  const mo = await api('/models');
  ok('/models 有模型列表', Array.isArray(mo.json?.models) && mo.json.models.length > 0,
    JSON.stringify(mo.json)?.slice(0, 200));

  child.kill();
  await new Promise((r) => setTimeout(r, 300));

  console.log(`\n${'='.repeat(60)}`);
  if (fail === 0) { console.log(`PASS  全部 ${pass} 项通过`); process.exit(0); }
  console.log(`FAIL  ${fail} 失败 / ${pass} 通过\n`);
  for (const f of fails) console.log(' ✗ ' + f.split('\n')[0]);
  process.exit(1);
}

main().catch((e) => { console.error('E2E-QODER ERROR: ' + e.stack); cleanup(); process.exit(1); });