/**
 * 视觉分流测试
 *
 * 覆盖 shouldUseVision / detectImageMime —— 决定「OCR 够了」还是「让模型看图」。
 *
 * 为什么这两个函数必须单测：分流判错的两个方向都很难在真机上察觉。
 *   漏判（该看图却走了 OCR）：模型拿着残缺题干硬猜，答案看着像模像样但是错的，
 *                            比报错更危险 —— 用户不会怀疑。
 *   误判（文字题也去调视觉）：每题多烧 330KB 图片 token，慢 3-7 秒，
 *                            而且对纯文字题没有任何收益。
 *
 * 判据核心是「有效汉字数」而不是总长度：OCR 噪声（时间/电量/KB/s/上一题残留）
 * 都是短碎片，拼起来也不短，但有效信息为零。用长度判断会漏判。
 */
import assert from 'node:assert/strict';

process.env.ANSWER_NO_LISTEN = '1';

const mod = await import('./answer-server.mjs');
const shouldUseVision = mod.__test_shouldUseVision;
const detectImageMime = mod.__test_detectImageMime;

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// 测试期间清掉可能干扰的环境变量
delete process.env.ANSWER_VISION;
delete process.env.ANSWER_VISION_MIN_HAN;

console.log('\n=== 1. 该走视觉：题干根本没读到 ===');
t('q.stem 为空 → 视觉', () => {
  assert.equal(shouldUseVision({ stem: '' }, '随便什么'), true);
});
t('q 为 null → 视觉', () => {
  assert.equal(shouldUseVision(null, 'x'), true);
});
t('stem 只有空白 → 视觉', () => {
  assert.equal(shouldUseVision({ stem: '   ' }, 'x'), true);
});

console.log('\n=== 2. 该走视觉：OCR 有效汉字不足 ===');
t('纯噪声（时间/电量/速率）→ 视觉', () => {
  // 这正是设置页/状态栏的典型 OCR 输出：一堆碎片，零有效信息
  assert.equal(shouldUseVision({ stem: '0.43\n5G\n2:59\nKB/s' }, '0.43\n5G\n2:59\nKB/s'), true);
});
t('图形题只有标注字母和数字 → 视觉', () => {
  // 实测那张无中文的几何题截图，OCR 出来就是这个
  const ocr = 'ABC BC = 90 AC = 3 GBC = 40 AB A5';
  assert.equal(shouldUseVision({ stem: ocr }, ocr), true);
});
t('汉字刚好 7 个（低于默认阈值 8）→ 视觉', () => {
  const ocr = '一二三四五六七 A B C 12 34';
  assert.equal(shouldUseVision({ stem: ocr }, ocr), true);
});
t('汉字 8 个（达到阈值）且无图形词 → 不走视觉', () => {
  const ocr = '一二三四五六七八 A B C';
  assert.equal(shouldUseVision({ stem: ocr }, ocr), false);
});

console.log('\n=== 3. 该走视觉：题干含图形提示词 ===');
for (const kw of ['如图', '下图', '上图', '图中', '图示', '坐标', '曲线', '电路', '结构式', '几何', '阴影', '面积', '周长']) {
  t(`含「${kw}」→ 视觉`, () => {
    const stem = `已知条件充足的一段完整中文题干，${kw}所示求结果`;
    assert.equal(shouldUseVision({ stem }, stem), true);
  });
}
t('「如图所示」完整句子 → 视觉', () => {
  const stem = '如图所示，直角三角形 ABC 中，∠C=90°，求斜边长度';
  assert.equal(shouldUseVision({ stem }, stem), true);
});

console.log('\n=== 4. 不走视觉：纯文字题 ===');
t('正常单选题 → 文本引擎', () => {
  const stem = 'IP 协议工作在哪一层？这是网络分层的基础知识';
  assert.equal(shouldUseVision({ stem }, stem), false);
});
t('长题干简答题 → 文本引擎', () => {
  const stem = '请简述传输控制协议的三次握手过程，并说明每一步的作用与目的';
  assert.equal(shouldUseVision({ stem }, stem), false);
});
t('题干够长且 OCR 也一致 → 文本引擎', () => {
  const ocr = '下列哪一项属于应用层协议，请从选项中选择一个正确答案';
  assert.equal(shouldUseVision({ stem: ocr }, ocr), false);
});

console.log('\n=== 5. 开关与阈值可配 ===');
t('ANSWER_VISION=0 全关', () => {
  process.env.ANSWER_VISION = '0';
  try {
    assert.equal(shouldUseVision(null, 'x'), false);
    assert.equal(shouldUseVision({ stem: '如图' }, '如图'), false);
  } finally { delete process.env.ANSWER_VISION; }
});
t('ANSWER_VISION_MIN_HAN=0 时纯数字也算够', () => {
  process.env.ANSWER_VISION_MIN_HAN = '0';
  try {
    // 汉字 0 个，但阈值 0 → 不算「不足」，也不含图形词 → 不走视觉
    assert.equal(shouldUseVision({ stem: 'ABC 123' }, 'ABC 123'), false);
  } finally { delete process.env.ANSWER_VISION_MIN_HAN; }
});
t('阈值调高到 20 时 10 个汉字也算不足', () => {
  process.env.ANSWER_VISION_MIN_HAN = '20';
  try {
    const ocr = '一二三四五六七八九十';
    assert.equal(shouldUseVision({ stem: ocr }, ocr), true);
  } finally { delete process.env.ANSWER_VISION_MIN_HAN; }
});

console.log('\n=== 6. 图片 MIME 嗅探 ===');
t('PNG', () => {
  assert.equal(detectImageMime('iVBORw0KGgoAAAANSUhEUg'), 'image/png');
});
t('JPEG', () => {
  assert.equal(detectImageMime('/9j/4AAQSkZJRgABAQ'), 'image/jpeg');
});
t('GIF', () => {
  assert.equal(detectImageMime('R0lGODlhAQABAIAAAA'), 'image/gif');
});
t('WebP', () => {
  assert.equal(detectImageMime('UklGRiQAAABXRUJQVlA4'), 'image/webp');
});
t('未知 → 默认 png', () => {
  assert.equal(detectImageMime('AAAAAAAAAAAAAAAA'), 'image/png');
});
t('空串 → 默认 png（不抛）', () => {
  assert.equal(detectImageMime(''), 'image/png');
});

console.log('\n=== 7. 回归：OCR 为空但 stem 完整时不该误判（review 修复）===');
// 场景：a11y 读到了完整题干（文字题），但 OCR 服务没起/超时 → ocrText 为空。
// 修复前只看 ocrText 的汉字数 → 判成「读不出题干」→ 白烧一次图片 token。
t('stem 27 个汉字 + ocrText 空 → 不走视觉', () => {
  const stem = '下列哪一项属于应用层协议，请从四个选项中选择一个正确答案';
  assert.equal(shouldUseVision({ stem }, ''), false);
});
t('stem 27 个汉字 + ocrText 为空串以外的假值 → 不走视觉', () => {
  const stem = '下列哪一项属于应用层协议，请从四个选项中选择一个正确答案';
  assert.equal(shouldUseVision({ stem }, null), false);
});
t('stem 和 ocrText 都短 → 仍走视觉', () => {
  assert.equal(shouldUseVision({ stem: 'AB' }, 'CD'), true);
});
t('stem 短但 ocrText 长 → 取较大者，不走视觉', () => {
  const ocr = '这是一段足够长的识别文本包含很多汉字内容';
  assert.equal(shouldUseVision({ stem: 'AB' }, ocr), false);
});

console.log('\n=== 8. 选项索引渲染（真机实测后修正语义）===');
const renderAnswer = mod.__test_renderAnswer;
const q4 = {
  type: 'single',
  stem: '题干',
  options: [{ text: '传输层' }, { text: '网络层' }, { text: '数据链路层' }, { text: '物理层' }],
};
const q2 = {
  type: 'single',
  stem: '题干',
  options: [{ text: '是在校生，不享有选举权' }, { text: '未满22周岁，不享有选举权' }],
};
t('index=0 → A 传输层', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { selectedIndex: 0 } }, q4), 'A 传输层');
});
t('index=3 → D 物理层', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { selectedIndex: 3 } }, q4), 'D 物理层');
});
t('index=5 超出 4 个选项 → 保留字母并提示核对（不能丢弃）', () => {
  // 真机教训：选项解析不全是常态（WebView 拆散选项、只滚动到一半）。
  // 此时模型给的 D 很可能就是对的，丢掉比给错更糟 —— 给字母 + 提示用户核对。
  assert.equal(renderAnswer({ mode: 'json', params: { selectedIndex: 5 } }, q4), 'F（选项未读全，请核对）');
});
t('index=-1 模型认为选项里没有正确答案 → 提示滚动', () => {
  assert.equal(
    renderAnswer({ mode: 'json', params: { selectedIndex: -1 } }, q4),
    '选项没读全，请滚动让四个选项都露出来后重按',
  );
});
t('index=1.5 非整数 → 空串', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { selectedIndex: 1.5 } }, q4), '');
});
t('index=30 超过 Z → 空串', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { selectedIndex: 30 } }, q4), '');
});
t('2 个选项但模型给 index=2 → 输出 C 并提示（真机高频场景）', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { selectedIndex: 2 } }, q2), 'C（选项未读全，请核对）');
});
t('多选 indices 保留字母，超出部分不丢', () => {
  const out = renderAnswer(
    { mode: 'json', params: { indicesJson: '[0,2,7]' } },
    { ...q4, type: 'multi' },
  );
  assert.equal(out, 'A 传输层 ; C 数据链路层 ; H');
});
t('多选含负数 → 过滤掉负数，保留合法项', () => {
  const out = renderAnswer(
    { mode: 'json', params: { indicesJson: '[-1,1,2]' } },
    { ...q4, type: 'multi' },
  );
  assert.equal(out, 'B 网络层 ; C 数据链路层');
});
t('多选全越界 → 保留字母', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { indicesJson: '[9,10]' } }, q4), 'J ; K');
});
t('多选全非法（负数）→ 空串', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { indicesJson: '[-1,-2]' } }, q4), '');
});

console.log('\n=== 9. 回归：空 stem 图片题不进缓存（review 修复）===');
const core = await import('./answer-core.mjs');
t('空 stem → normalizeForHash 返回 null', () => {
  assert.equal(core.normalizeForHash({ stem: '', options: [] }), null);
});
t('纯标点 stem → 也是 null', () => {
  assert.equal(core.normalizeForHash({ stem: '。，、', options: [] }), null);
});
t('空白 stem → 也是 null', () => {
  assert.equal(core.normalizeForHash({ stem: '   ', options: [] }), null);
});
t('有题干 → 正常返回哈希', () => {
  const k = core.normalizeForHash({ stem: '题目', options: [{ text: 'A' }] });
  assert.equal(typeof k, 'string');
  assert.equal(k.length, 32);
});
t('两张不同图片题（空 stem + 相同选项）不再撞键', () => {
  const a = core.normalizeForHash({ stem: '', options: [{ text: '传输层' }] });
  const b = core.normalizeForHash({ stem: '', options: [{ text: '传输层' }] });
  // 都为 null，且 AnswerCache 会把 null 当「不缓存」而不是「同一个键」
  assert.equal(a, null);
  assert.equal(b, null);
});

console.log('\n=== 10. 回归：占位引擎不污染缓存（真机实测）===');
// 真机踩到：heuristic 把多选题写成 indices:[0]，hits=43。
// 用户看到 "A GET" 以为是真答案，其实是 index:0 的占位。
const cache = new (await import('./answer-cache.mjs')).AnswerCache(':memory:');
t('heuristic 占位答案不该进缓存（由调用方拦截，此处验缓存本身会存）', () => {
  // 缓存层不判断来源，拦截在 solve() 里。这里验证 cache.put 的返回值语义：
  const q = { stem: '占位引擎测试题', options: [{ key: 'A', text: 'x' }] };
  const wrote = cache.put(q, { mode: 'json', type: 'single', params: { selectedIndex: 0 } }, 'heuristic');
  assert.ok(wrote, '缓存层本身允许写入（拦截逻辑在 solve）');
  // 关键：能删掉
  assert.ok(cache.delete(q), 'heuristic 条目必须可删除，否则脏数据永久留着');
  assert.equal(cache.get(q), null, '删掉后不应再命中');
});

console.log('\n=== 11. 回归：选项不足时拒绝作答（真机实测 54s 答错）===');
// 真机踩到：微信 WebView 吃掉 C 选项前缀，4 个选项只读到 2 个。
// 模型对「两个选项都不对」的题会思考 54s，然后硬凑 index:0 答错。
// 服务端 guard 必须在调模型之前就拦住。
const src = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('./answer-server.mjs', import.meta.url), 'utf8'));
t('answer-server 里有选项数 guard（optCount < 3）', () => {
  assert.ok(src.includes('optCount < 3'), '必须存在 optCount < 3 的拦截');
});
t('guard 命中时 source=none，不写缓存也不调模型', () => {
  // 静态检查：guard 的 return 里带 source:'none'
  const i = src.indexOf('optCount < 3');
  const seg = src.slice(i, i + 600);
  assert.ok(seg.includes("source: 'none'"), 'guard 返回必须是 source:none');
  assert.ok(seg.includes('请滚动让选项露全'), '必须给用户可操作的提示');
});
t('guard 在缓存查询之前（避免脏缓存绕过）', () => {
  const guardAt = src.indexOf('optCount < 3');
  const cacheAt = src.indexOf('// 1. 缓存');
  assert.ok(guardAt > 0 && cacheAt > 0);
  assert.ok(guardAt < cacheAt, 'guard 必须早于缓存查询');
});

console.log('\n=== 12. 视觉主路径：整屏交给模型（真机实测三题）===');
// 背景：OCR + 几何恢复那条路一直在跟版式搏斗，第 7/10/5 题各踩一个坑，
// 而且修 A 会踩坏 B。改成「整屏截图直接交给视觉模型，它自己找题目」。
//
// 真机三题实测（都是之前踩过坑的）：
//   第5题(多选) 11258ms type=multi  stem完整 opts=4 indices[0,1] ✓
//   第10题(单选) 3080ms type=single stem完整 opts=4 indices[1]   ✓
//   第7题(单选) 15449ms type=single stem完整 opts=4 indices[1]   ✓
// 而且 OCR 的错字在视觉版里全都没有：
//   「第十五个五年」OCR 读成「第十五人五年」
//   「劳动收入」OCR 读成「劳动」，还漏掉「额」「而当」
const { __test_parseVisionFull: parseVisionFull } = await import('./answer-server.mjs');

t('视觉：正常 JSON 解析', () => {
  const r = parseVisionFull(JSON.stringify({
    type: 'multi',
    stem: '该酒店可能违反的义务包括？',
    options: ['询问监护人联系方式', '遵守禁入规定', '临时监护', '学校管理'],
    indices: [0, 1],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.type, 'multi');
  assert.equal(r.options.length, 4);
  assert.deepEqual(r.indices, [0, 1]);
});

t('视觉：选项带 "A." 前缀要剥掉', () => {
  // 模型偶尔不听话，把编号写进选项原文
  const r = parseVisionFull(JSON.stringify({
    type: 'single', stem: '题', options: ['A. 甲', 'B、乙', '(C) 丙', 'D．丁'], indices: [2],
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.options, ['甲', '乙', '丙', '丁']);
});

t('视觉：```json 围栏能剥', () => {
  const r = parseVisionFull('```json\n{"type":"single","stem":"题","options":["a","b"],"indices":[1]}\n```');
  assert.equal(r.ok, true);
  assert.deepEqual(r.indices, [1]);
});

t('视觉：前后有废话也能抠出 JSON', () => {
  const r = parseVisionFull('好的，答案是：{"type":"single","stem":"题","options":["a","b"],"indices":[0]} 以上。');
  assert.equal(r.ok, true);
  assert.equal(r.type, 'single');
});

t('视觉：判单选却给多个下标 → 改判多选', () => {
  // 同 parseAnswerText 的规则：以 indices 为准
  const r = parseVisionFull(JSON.stringify({
    type: 'single', stem: '题', options: ['a', 'b', 'c'], indices: [0, 2],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.type, 'multi', '多下标必须改判多选，不能砍成一个');
  assert.deepEqual(r.indices, [0, 2]);
});

t('视觉：没读出题干要拒绝', () => {
  const r = parseVisionFull(JSON.stringify({ type: 'single', options: ['a', 'b'], indices: [0] }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /题干/);
});

t('视觉：选项不足 2 个要拒绝', () => {
  const r = parseVisionFull(JSON.stringify({ type: 'single', stem: '题', options: ['只有一个'], indices: [0] }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /选项/);
});

t('视觉：没给下标要拒绝（不能瞎猜）', () => {
  const r = parseVisionFull(JSON.stringify({ type: 'single', stem: '题', options: ['a', 'b'] }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /下标/);
});

t('视觉：非法下标被过滤', () => {
  const r = parseVisionFull(JSON.stringify({
    type: 'multi', stem: '题', options: ['a', 'b', 'c'], indices: [0, -1, 99, 'x', 2],
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.indices, [0, 2], '负数/越界/非数字都要丢掉');
});

t('视觉：非 JSON 返回要拒绝', () => {
  const r = parseVisionFull('我看不清这张图');
  assert.equal(r.ok, false);
});

t('answer-server 里视觉主路径在 OCR 之前', () => {
  const vAt = src.indexOf('VISION_MODE');
  const ocrAt = src.indexOf('const o = await ocrImageEx(image)');
  assert.ok(vAt > 0 && ocrAt > 0, '两处都必须存在');
  assert.ok(vAt < ocrAt, '视觉主路径必须早于 OCR —— 否则先花 5s OCR 再走视觉，白等');
});

t('vision=only 失败时不退回 OCR', () => {
  const i = src.indexOf("visionMode === 'only'");
  assert.ok(i > 0, '必须有 only 的专门分支');
  const seg = src.slice(i, i + 400);
  assert.ok(seg.includes("source: 'error'"), 'only 失败要明确报错，不能静默退回');
});

console.log('\n' + '='.repeat(56));
if (fail === 0) console.log(`PASS  ${pass} 项通过，全部`);
else console.log(`FAIL  ${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(56) + '\n');
process.exit(fail === 0 ? 0 : 1);
