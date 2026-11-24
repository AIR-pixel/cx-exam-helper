/**
 * 图片题 URL 方案测试
 *
 * 覆盖 answer-server.mjs 的 imageToBase64 / textFromSvg：
 *   · data:image/svg+xml（非 base64，URL 编码）→ 抽 <text>
 *   · data:image/png;base64,xxx → 原样取 payload
 *   · http(s) URL → 下载
 *   · 纯 base64（截屏路径）→ 原样返回
 *   · 坏输入 → 空串，不抛
 *
 * 为什么单独测这两个函数：手机端 a11y 的 targetUrl 是 data: 还是 http
 * 取决于真实学习通的实现，两条分支都得能跑。
 */
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// 直接 import 服务端模块会启动 HTTP server，所以这里把两个纯函数
// 复制成等价实现来测逻辑。真正的端到端验证在下面用真服务跑。
// —— 不，更好的做法：把函数从模块里导出来。检查是否已导出。

const mod = await import('./answer-server.mjs').catch(() => null);

console.log('\n=== 1. SVG 抽文字 ===');
if (mod && mod.__test_textFromSvg) {
  const f = mod.__test_textFromSvg;
  t('单个 text', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="20">IP 协议工作在哪一层？</text></svg>`;
    assert.equal(f(svg), 'IP 协议工作在哪一层？');
  });
  t('多个 text 按行拼接', () => {
    const svg = `<svg><text>第一行</text><text>第二行</text></svg>`;
    assert.equal(f(svg), '第一行\n第二行');
  });
  t('带嵌套 tspan', () => {
    const svg = `<svg><text x="1"><tspan>嵌套</tspan>文字</text></svg>`;
    assert.equal(f(svg), '嵌套文字');
  });
  t('HTML 实体反转义', () => {
    const svg = `<svg><text>a &lt; b &amp;&amp; c &gt; d</text></svg>`;
    assert.equal(f(svg), 'a < b && c > d');
  });
  t('空 SVG 返回空串', () => {
    assert.equal(f('<svg></svg>'), '');
  });
  t('非 SVG 文本返回空串', () => {
    assert.equal(f('random garbage'), '');
  });
} else {
  console.log('  skip（模块未导出测试钩子）');
}

console.log('\n=== 2. imageToBase64 归一化 ===');
if (mod && mod.__test_imageToBase64) {
  const f = mod.__test_imageToBase64;

  await ta('data:image/svg+xml（URL 编码）→ __SVG__ 前缀', async () => {
    const svg = `<svg><text>题目</text></svg>`;
    const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const out = await f(uri);
    assert.ok(out.startsWith('__SVG__'), `期望 __SVG__ 前缀，实际 ${out.slice(0, 30)}`);
    assert.ok(out.includes('<text>题目</text>'));
  });

  await ta('data:image/png;base64,xxx → 原样 payload', async () => {
    const out = await f('data:image/png;base64,iVBORw0KGgo=');
    assert.equal(out, 'iVBORw0KGgo=');
  });

  await ta('纯 base64 原样返回（截屏路径）', async () => {
    const out = await f('iVBORw0KGgoAAAANSUhEUg==');
    assert.equal(out, 'iVBORw0KGgoAAAANSUhEUg==');
  });

  await ta('空输入 → 空串', async () => {
    assert.equal(await f(''), '');
    assert.equal(await f(null), '');
  });

  await ta('坏 data URI（无逗号）→ 空串', async () => {
    assert.equal(await f('data:image/png;base64'), '');
  });

  await ta('http 404 → 空串不抛', async () => {
    const out = await f('http://127.0.0.1:9/nope.png');
    assert.equal(out, '');
  });
} else {
  console.log('  skip（模块未导出测试钩子）');
}

console.log('\n=== 3. 端到端：真服务 + SVG URL ===');
const BASE = process.env.ANSWER_URL || 'http://127.0.0.1:18888';
let alive = false;
try {
  const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
  alive = r.ok;
} catch { /* 服务没起 */ }

if (!alive) {
  console.log('  skip（服务未运行）');
} else {
  await ta('SVG data URI 走通，题干由图片接管', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="120">`
      + `<rect width="1000" height="120" fill="#fff"/>`
      + `<text x="20" y="72" font-size="40">77.（2分）URL 方案测试专用题干</text></svg>`;
    const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const body = JSON.stringify({
      question: '77.（2分）URL 方案测试专用题干\nA. 甲\nB. 乙\nC. 丙\nD. 丁',
      image,
    });
    const r = await fetch(`${BASE}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json();
    // /answer 成功时直接返回结果对象，没有 ok 字段（ok 只在 /health）
    assert.ok(j.answer && j.answer.length > 0, `answer 不应为空，实际 ${JSON.stringify(j)}`);
    // 题干必须由图片接管：question.stem 应等于 SVG 里 <text> 的内容
    assert.ok(j.question && j.question.stem, 'question.stem 不应为空');
    assert.ok(j.question.stem.includes('URL 方案测试专用题干'),
      `题干应由图片接管，实际 "${j.question.stem}"`);
    console.log(`       → ${j.answer} (source=${j.source}, stem="${j.question.stem}")`);
  });

  await ta('同一题第二次命中缓存', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>78.（2分）缓存命中测试题</text></svg>`;
    const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const body = JSON.stringify({
      question: '78.（2分）缓存命中测试题\nA. 甲\nB. 乙\nC. 丙\nD. 丁', image,
    });
    const send = () => fetch(`${BASE}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
      signal: AbortSignal.timeout(60000),
    }).then(r => r.json());
    await send();
    const j2 = await send();
    assert.equal(j2.source, 'cache', `第二次应命中缓存，实际 ${j2.source}`);
  });
}

console.log('\n' + '='.repeat(60));
console.log(`PASS  ${pass} 项通过${fail ? `，${fail} 项失败` : '，全部'}`);
if (fail) process.exit(1);
