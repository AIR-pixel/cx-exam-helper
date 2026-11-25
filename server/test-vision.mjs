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

console.log('\n=== 8. 回归：选项越界索引（review 修复）===');
const renderAnswer = mod.__test_renderAnswer;
const q4 = {
  type: 'single',
  stem: '题干',
  options: [{ text: '传输层' }, { text: '网络层' }, { text: '数据链路层' }, { text: '物理层' }],
};
t('index=0 → A 传输层', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { selectedIndex: 0 } }, q4), 'A 传输层');
});
t('index=3 → D 物理层', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { selectedIndex: 3 } }, q4), 'D 物理层');
});
t('index=5 越界 → 空串（不渲染成 F）', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { selectedIndex: 5 } }, q4), '');
});
t('index=-1 → 空串', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { selectedIndex: -1 } }, q4), '');
});
t('index=1.5 非整数 → 空串', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { selectedIndex: 1.5 } }, q4), '');
});
t('多选 indices 越界被过滤', () => {
  const out = renderAnswer(
    { mode: 'json', params: { indicesJson: '[0,2,7]' } },
    { ...q4, type: 'multi' },
  );
  assert.equal(out, 'A 传输层 ; C 数据链路层');
});
t('多选全越界 → 空串', () => {
  assert.equal(renderAnswer({ mode: 'json', params: { indicesJson: '[9,10]' } }, q4), '');
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

console.log('\n' + '='.repeat(56));
if (fail === 0) console.log(`PASS  ${pass} 项通过，全部`);
else console.log(`FAIL  ${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(56) + '\n');
process.exit(fail === 0 ? 0 : 1);
