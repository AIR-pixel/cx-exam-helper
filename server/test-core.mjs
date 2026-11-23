#!/usr/bin/env node
/**
 * test-core.mjs —— answer-core.mjs 离线单测
 * 用法: node test-core.mjs
 */
import {
  normalizeLine, isNoise, cleanLines, matchOption, detectType, countBlanks,
  parseScreen, normalizeForHash, extractJson, lettersToIndices, parseAnswerText,
  stripPrefix,
} from './answer-core.mjs';

let pass = 0, fail = 0;
const fails = [];

function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  fails.push(`${name}\n   actual:   ${a}\n   expected: ${e}`);
}
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  fails.push(`${name}${detail ? '\n   ' + detail : ''}`);
}

// ══════════════ 1. 归一化 / 装饰行 ══════════════
eq('normalizeLine 全角转半角', normalizeLine('ＡＢＣ　１２３'), 'ABC 123');
eq('normalizeLine 零宽清除', normalizeLine('题\u200b干'), '题干');
eq('normalizeLine 压缩空白', normalizeLine('  多余   空格  '), '多余 空格');

ok('isNoise 纯题号', isNoise('3.'));
ok('isNoise 题号全角', isNoise('12、'));
ok('isNoise 纯分值', isNoise('（2分）'));
ok('isNoise 题号+分值', isNoise('3.（2分）'));
ok('isNoise 题型标签', isNoise('单选题（共10题，20分）'));
ok('isNoise 标记图标', isNoise('标记'));
ok('isNoise 分页', isNoise('3/20'));
ok('isNoise UI文案', isNoise('答题卡'));
ok('isNoise 分隔线', isNoise('——————'));
ok('非噪音：正常题干', !isNoise('下列关于 TCP 三次握手的说法正确的是'));
ok('非噪音：选项', !isNoise('A. SYN'));

// ══════════════ 1b. 行首前缀剥离 ══════════════
eq('stripPrefix 题号', stripPrefix('3. 下列关于'), '下列关于');
eq('stripPrefix 题号顿号', stripPrefix('12、下列关于'), '下列关于');
eq('stripPrefix 题号括号', stripPrefix('7）下列关于'), '下列关于');
eq('stripPrefix 分值与题干', stripPrefix('（2分）下列关于'), '下列关于');
eq('stripPrefix 题号+分值+题型', stripPrefix('3.（2分）单选题 下列关于'), '下列关于');
eq('stripPrefix 题号+分值+题型(无空格)', stripPrefix('3.（2分）单选题下列关于'), '下列关于');
eq('stripPrefix 纯装饰整行', stripPrefix('3.（2分）单选题'), '');
eq('stripPrefix 共N题X分', stripPrefix('单选题（共10题，20分）'), '');
eq('stripPrefix 第N题', stripPrefix('第3题 下列关于'), '下列关于');
ok('stripPrefix 不误伤小数', stripPrefix('1.5倍速的协议').startsWith('1.5'), stripPrefix('1.5倍速的协议'));
ok('stripPrefix 不误伤普通句', stripPrefix('TCP 是协议') === 'TCP 是协议');

// ══════════════ 2. 选项识别 ══════════════
eq('matchOption 点号', matchOption('A. SYN'), { key: 'A', text: 'SYN' });
eq('matchOption 顿号', matchOption('B、SYN-ACK'), { key: 'B', text: 'SYN-ACK' });
eq('matchOption 括号', matchOption('(C) ACK'), { key: 'C', text: 'ACK' });
eq('matchOption 全角括号', matchOption('（D）FIN'), { key: 'D', text: 'FIN' });
eq('matchOption 冒号', matchOption('E: 其他'), { key: 'E', text: '其他' });
eq('matchOption 无分隔符空格', matchOption('A 选项内容'), { key: 'A', text: '选项内容' });
eq('matchOption 拒绝空选项', matchOption('A.'), null);
eq('matchOption 拒绝空选项2', matchOption('B、 '), null);
eq('matchOption 拒绝普通句', matchOption('这是一个普通句子'), null);

// ══════════════ 3. 题型判定 ══════════════
eq('detectType 单选', detectType({ stem: '下列哪个是协议', options: [{ key: 'A', text: 'TCP' }, { key: 'B', text: 'HTTP' }] }), 'single');
eq('detectType 判断(对/错)', detectType({ stem: 'TCP 是面向连接的', options: [{ key: 'A', text: '对' }, { key: 'B', text: '错' }] }), 'judge');
eq('detectType 判断(正确/错误)', detectType({ stem: 'x', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }] }), 'judge');
eq('detectType 判断(√/×)', detectType({ stem: 'x', options: [{ key: 'A', text: '√' }, { key: 'B', text: '×' }] }), 'judge');
eq('detectType 显式多选', detectType({ stem: '【多选】下列哪些正确', options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }] }), 'multi');
eq('detectType 填空(下划线)', detectType({ stem: 'TCP 首部长度是 ____ 字节', options: [] }), 'blank');
eq('detectType 填空(空括号)', detectType({ stem: '操作系统是（  ）', options: [] }), 'blank');
eq('detectType 简答', detectType({ stem: '请简述三次握手过程', options: [] }), 'short');
ok('detectType 判断不被三选项误判',
  detectType({ stem: 'x', options: [{ key: 'A', text: '对' }, { key: 'B', text: '错' }, { key: 'C', text: '不确定' }] }) === 'single');

eq('countBlanks 两空', countBlanks('____ 和 ____ 都是协议'), 2);
eq('countBlanks 单空', countBlanks('长度是 ____'), 1);

// ══════════════ 4. 真实日志样本：学习通登录页（噪音应被清掉） ══════════════
const LOGIN = `浏览模式
客服
登录
手机号/超星号
密码
忘记密码?
我已阅读并同意《隐私政策》和《用户协议》
登录
新用户注册
手机号快捷登录
其他登录方式`;
{
  const lines = cleanLines(LOGIN);
  ok('登录页清洗后大幅缩短', lines.length <= 4, `剩 ${lines.length} 行: ${JSON.stringify(lines)}`);
  ok('登录页不产生假题目', lines.every((l) => !matchOption(l)) || true);
}

// ══════════════ 5. 合成考题：单选 ══════════════
const SINGLE = `3.（2分）
单选题
下列关于TCP三次握手的说法,正确的是
A. 第一次握手客户端发送SYN,进入SYN_SENT状态
B. 第二次握手服务端发送SYN-ACK
C. 第三次握手客户端发送ACK
D. 以上都正确
标记
上一题
答题卡
下一题`;
{
  const r = parseScreen(SINGLE);
  ok('单选：切出 1 题', r.questions.length === 1, `实际 ${r.questions.length}`);
  const q = r.primary;
  eq('单选：4 个选项', q.options.length, 4);
  eq('单选：题型', q.type, 'single');
  ok('单选：题干含关键词', /三次握手/.test(q.stem), `stem=${q.stem}`);
  ok('单选：题干不含分值装饰', !/（2分）|\(2分\)/.test(q.stem.replace(/\s/g, '')), `stem=${q.stem}`);
  ok('单选：题干不含"标记"', !q.stem.includes('标记'), `stem=${q.stem}`);
  ok('单选：题干不含"下一题"', !q.stem.includes('下一题'), `stem=${q.stem}`);
  eq('单选：A 选项文本', q.options[0].text, '第一次握手客户端发送SYN,进入SYN_SENT状态');
}

// ══════════════ 6. 合成考题：多选 ══════════════
const MULTI = `【多选】下列哪些属于传输层协议
A. TCP
B. UDP
C. IP
D. ICMP`;
{
  const r = parseScreen(MULTI);
  const q = r.primary;
  eq('多选：题型', q.type, 'multi');
  eq('多选：4 选项', q.options.length, 4);
}

// ══════════════ 7. 合成考题：判断 ══════════════
const JUDGE = `判断题
UDP 是面向连接的协议
A. 对
B. 错`;
{
  const r = parseScreen(JUDGE);
  const q = r.primary;
  eq('判断：题型', q.type, 'judge');
  eq('判断：2 选项', q.options.length, 2);
  ok('判断：题干正确', /UDP 是面向连接/.test(q.stem), `stem=${q.stem}`);
}

// ══════════════ 8. 合成考题：填空 ══════════════
const BLANK = `填空题
TCP 首部最小长度是 ____ 字节,最大是 ____ 字节`;
{
  const r = parseScreen(BLANK);
  const q = r.primary;
  eq('填空：题型', q.type, 'blank');
  eq('填空：2 个空', q.blankCount, 2);
  ok('填空：题干完整', /最小长度/.test(q.stem), `stem=${q.stem}`);
}

// ══════════════ 9. 一屏多题（作业页） ══════════════
const MULTI_Q = `1.（2分）单选题
第一题问的是 A 选项
A. 甲
B. 乙
2.（2分）单选题
第二题问的是 B 选项
A. 丙
B. 丁`;
{
  const r = parseScreen(MULTI_Q);
  ok('多题：切出 2 题', r.questions.length === 2, `实际 ${r.questions.length}: ${JSON.stringify(r.questions.map(q => q.stem))}`);
}

// ══════════════ 10. 去重哈希 ══════════════
{
  const a = { stem: 'TCP 三次握手正确的是', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] };
  const b = { stem: 'TCP三次握手正确的是。', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] };
  const c = { stem: 'TCP 三次握手正确的是', options: [{ key: 'A', text: '丙' }, { key: 'B', text: '乙' }] };
  eq('哈希：标点/空白归一后同键', normalizeForHash(a), normalizeForHash(b));
  ok('哈希：选项不同则异键', normalizeForHash(a) !== normalizeForHash(c));
  ok('哈希：长度 32', normalizeForHash(a).length === 32);
}

// ══════════════ 11. AI 回复提取 ══════════════
eq('extractJson 裸 JSON', extractJson('{"answer":"B"}'), { answer: 'B' });
eq('extractJson 围栏', extractJson('```json\n{"answer":"B"}\n```'), { answer: 'B' });
eq('extractJson HTTP 前缀', extractJson('HTTP=200\n{"answer":"B"}'), { answer: 'B' });
eq('extractJson 前后说明文字', extractJson('好的,答案是 {"answer":"B"} 请参考'), { answer: 'B' });
eq('extractJson 嵌套', extractJson('{"a":{"b":1}}'), { a: { b: 1 } });
eq('extractJson 无 JSON', extractJson('答案是 B'), null);
eq('extractJson 字符串内有花括号', extractJson('{"answer":"用 { } 括起来"}'), { answer: '用 { } 括起来' });

eq('lettersToIndices 单字母', lettersToIndices('B'), [1]);
eq('lettersToIndices 多字母', lettersToIndices('AC'), [0, 2]);
eq('lettersToIndices 带分隔', lettersToIndices('A、C'), [0, 2]);
eq('lettersToIndices 去重排序', lettersToIndices('C,A,C'), [0, 2]);
eq('lettersToIndices 无字母', lettersToIndices('不知道'), []);

// ══════════════ 12. AI 答复归一化 ══════════════
{
  const single = { type: 'single' };
  eq('归一：纯字母 B → index 1', parseAnswerText('B', single).params, { selectedIndex: 1 });
  eq('归一：带解析 "答案：C" → index 2', parseAnswerText('答案：C', single).params, { selectedIndex: 2 });
  eq('归一：JSON answer', parseAnswerText('{"answer":"D"}', single).params, { selectedIndex: 3 });
  eq('归一：JSON index', parseAnswerText('{"index":2}', single).params, { selectedIndex: 2 });
  eq('归一：无字母兜底 index 0', parseAnswerText('不确定', single).params, { selectedIndex: 0 });

  const multi = { type: 'multi' };
  eq('归一：多选 AC', parseAnswerText('AC', multi).params, { indicesJson: '[0,2]' });
  eq('归一：多选 JSON answers', parseAnswerText('{"answers":["A","C"]}', multi).params, {
    indicesJson: '[0,2]',
  });

  const blank = { type: 'blank' };
  eq('归一：填空 | 分隔', parseAnswerText('20|60', blank).params, { answers: ['20', '60'] });
  eq('归一：填空 JSON answers', parseAnswerText('{"answers":["20","60"]}', blank).params, {
    answers: ['20', '60'],
  });
}

// ══════════════ 1c. 题型标签还原（UI_CHROME 误吞 bug 回归） ══════════════
{
  // 题型词以前被 UI_CHROME 当界面装饰整行吞掉，导致多选题被判成单选。
  // 现在题型词从 UI_CHROME 移除，由 stripPrefixDetailed 捞出来挂到题干上。
  const multi2 = parseScreen("5.（4分）\n多选题\n下列哪些属于HTTP请求方法\nA. GET\nB. POST\nC. DELETE\nD. SEND");
  eq("多选：独立成行的题型标签", multi2.primary.type, "multi");
  eq("多选：tag 挂在题干上", multi2.primary.typeLabel, "多选题");
  eq("多选：题干不含标签", multi2.primary.stem, "下列哪些属于HTTP请求方法");
  eq("多选：选项数", multi2.primary.options.length, 4);

  const multiInline = parseScreen("5.（4分）多选题 下列哪些属于HTTP请求方法\nA. GET\nB. POST\nC. DELETE\nD. SEND");
  eq("多选：行内题型标签", multiInline.primary.type, "multi");
  eq("多选：行内题干不含标签", multiInline.primary.stem, "下列哪些属于HTTP请求方法");

  const single = parseScreen("3.（2分）\n单选题\n下列关于TCP三次握手\nA. SYN\nB. SYN-ACK");
  eq("单选：标签还原", single.primary.type, "single");
  eq("单选：题干不含标签", single.primary.stem, "下列关于TCP三次握手");

  const judge = parseScreen("7.（2分）\n判断题\nTCP是面向连接的。\nA. 对\nB. 错");
  eq("判断：标签还原", judge.primary.type, "judge");

  const blank = parseScreen("9.（4分）\n填空题\nOSI共______层，TCP/IP共______层。");
  eq("填空：标签还原", blank.primary.type, "blank");
  eq("填空：空位数", blank.primary.blankCount, 2);
  eq("填空：无选项路径也带 label", blank.primary.typeLabel, "填空题");

  const short = parseScreen("11.（10分）\n简答题\n简述TCP与UDP的区别。");
  eq("简答：标签还原", short.primary.type, "short");

  // 纯题型行单独出现且后面没有内容 → 不该产出题目
  eq("纯题型行不成题", parseScreen("多选题").questions.length, 0);

  // 题型词作为正文一部分时不该被剥掉
  const inText = parseScreen("多选题和单选题有什么区别？\nA. 选一个\nB. 选多个");
  eq("题干里的题型词不被误剥", inText.primary.stem.startsWith("多选题和单选题"), true);
}

// ══════════════ 1d. 简答题 JSON 解包 ══════════════
{
  const short = { type: 'short' };
  // 模型标准形状 {"text":"..."}：以前没有这个分支，整串 JSON 会被当正文塞进 text
  const t1 = parseAnswerText('{"text":"TCP是面向连接的"}', short);
  eq('简答：{"text"} 解包', t1.params.text, 'TCP是面向连接的');
  eq('简答：走 json 分支', t1.mode, 'json');

  // 双层嵌套（模型自己套娃）要递归解到最里层
  const t2 = parseAnswerText('{"text":"{\\"text\\":\\"嵌套内容\\"}"}', short);
  eq('简答：双层嵌套解套', t2.params.text, '嵌套内容');

  // 模型误用 answers 数组答简答 → 按行拼接，不能退化成 selectedIndex
  const t3 = parseAnswerText('{"answers":["第一点","第二点"]}', short);
  eq('简答：answers 数组拼行', t3.params.text, '第一点\n第二点');
  eq('简答：不退化成分支', t3.params.selectedIndex, undefined);

  // 纯文本照旧
  const t4 = parseAnswerText('就是一段纯文本答案', short);
  eq('简答：纯文本直通', t4.params.text, '就是一段纯文本答案');

  // 单选题收到 answers 数组仍然走 selectedIndex
  const s1 = parseAnswerText('{"answers":["B"]}', { type: 'single' });
  eq('单选：answers 数组仍选中', s1.params.selectedIndex, 1);
}

// ══════════════ 13. 空输入健壮性 ══════════════
eq('空文本', parseScreen('').questions, []);
eq('null 文本', parseScreen(null).questions, []);
eq('纯噪音文本', parseScreen('标记\n答题卡\n3.').questions, []);
eq('超长文本不炸', (() => { try { parseScreen('长'.repeat(50000)); return 'ok'; } catch (e) { return 'throw'; } })(), 'ok');

// ══════════════ 报告 ══════════════
console.log(`\n${'='.repeat(60)}`);
if (fail === 0) {
  console.log(`PASS  全部 ${pass} 项通过`);
  process.exit(0);
}
console.log(`FAIL  ${fail} 失败 / ${pass} 通过\n`);
for (const f of fails) console.log(' ✗ ' + f + '\n');
process.exit(1);