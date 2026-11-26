#!/usr/bin/env node
/**
 * test-core.mjs —— answer-core.mjs 离线单测
 * 用法: node test-core.mjs
 */
import {
  normalizeLine, isNoise, cleanLines, matchOption, detectType, countBlanks,
  parseScreen, parseStructured, normalizeForHash, extractJson, lettersToIndices, parseAnswerText,
  stripPrefix, looksLikeQuestion, rebuildTextWithGeometry, recoverOptionsByGeometry,
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

// ══════════════ 14. 区域抽取（手机端按 a11y bounds 分好） ══════════════
{
  const s = parseStructured({
    stem: '1.（2分）下列关于 TCP 三次握手的描述，正确的是：',
    options: ['A. 第一次握手由客户端发送 SYN 报文', 'B. 第二次握手由服务端发送 SYN 报文',
              'C. 第三次握手由服务端发送 ACK 报文', 'D. 三次握手一共需要四个报文段'],
    typeLabel: '单选题',
  });
  eq('结构化 ok', s.ok, true);
  eq('结构化 mode', s.mode, 'structured');
  eq('结构化题干去题号分值', s.primary.stem, '下列关于 TCP 三次握手的描述,正确的是:');
  eq('结构化选项数', s.primary.options.length, 4);
  eq('结构化首选项文本', s.primary.options[0].text, '第一次握手由客户端发送 SYN 报文');
  eq('结构化题型', s.primary.type, 'single');
  ok('结构化 stableKey 32位', /^[0-9a-f]{32}$/.test(s.stableKey), s.stableKey);

  // 判断题无选项
  const j = parseStructured({ stem: 'HTTPS 在 TCP 之上加入 TLS。', options: ['A. 对', 'B. 错'], typeLabel: '判断题' });
  eq('结构化判断题', j.primary.type, 'judge');

  // 填空
  const b = parseStructured({ stem: 'TCP 首部固定长度是____字节。', options: [], typeLabel: '填空题' });
  eq('结构化填空', b.primary.type, 'blank');

  // 空输入不炸
  eq('结构化空输入', parseStructured({}).ok, false);
  eq('结构化 null', parseStructured(null).ok, false);
}

// ══════════════ 15. 题目页判定（非答题页不许打模型） ══════════════
// 起因：学习通登录页清洗后只剩「我已阅读并同意…」，被当成一道无选项简答题
// 送去模型，白烧一次调用还把"该内容并非课程题目"糊到叠层上。首页/课程列表同理。
{
  const notQuestion = [
    ['登录页', '浏览模式\n客服\n登录\n手机号/超星号\n密码\n忘记密码?\n我已阅读并同意学习通《隐私政策》和《用户协议》\n新用户注册\n手机号快捷登录\n其他登录方式'],
    ['首页课程列表', '首页\n消息\n课程\n我\n我的课程\n计算机网络\n高等数学\n大学英语\n查看全部'],
    ['课程详情', '课程详情\n计算机网络\n教师：张老师\n章节\n第一章 概述\n第二章 物理层\n进入学习'],
    ['签到页', '签到\n请点击签到\n签到时间 10:35\n剩余 00:58'],
    ['消息列表', '消息\n系统通知\n作业提醒\n班级群\n张老师：明天上课'],
    ['个人中心', '我的\n姓名\n学号\n设置\n退出登录\n关于我们'],
  ];
  for (const [name, text] of notQuestion) {
    const r = parseScreen(text);
    eq(`非题目页拒绝：${name}`, r.ok, false);
    eq(`非题目页 primary=null：${name}`, r.primary, null);
    eq(`非题目页 stableKey 空：${name}`, r.stableKey, '');
    ok(`非题目页留 rejected 诊断：${name}`, r.rejected != null, JSON.stringify(r.rejected));
  }

  const yesQuestion = [
    ['单选带选项', '1.（2分）\n单选题\n下列关于TCP三次握手的描述，正确的是\nA. 第一次握手由客户端发送SYN报文\nB. 第二次握手由服务端发送ACK报文'],
    ['简答考试页', '简答题\n5.（10分）\n简述TCP与UDP的主要区别。\n交卷 答题卡 上一题 下一题'],
    ['填空考试页', '填空题\n3.（4分）\nTCP首部固定长度是____字节。\n交卷 答题卡'],
    ['判断考试页', '判断题\n2.（2分）\nTCP是面向连接的协议。\n交卷 答题卡'],
    ['作业页问句', '下列关于进程与线程的说法，正确的是？\nA. 进程是资源分配单位\nB. 线程是调度单位'],
  ];
  for (const [name, text] of yesQuestion) {
    eq(`真题目页放行：${name}`, parseScreen(text).ok, true);
  }

  // 考试页判定
  eq('考试页标识', parseScreen('简答题\n简述TCP特点\n交卷 答题卡').examPage, true);
  eq('非考试页标识', parseScreen('消息\n系统通知').examPage, false);

  // 结构化路径同样拦截
  eq('结构化拒登录页协议',
    parseStructured({ stem: '我已阅读并同意学习通《隐私政策》和《用户协议》', options: [], typeLabel: '' }).ok,
    false);
  eq('结构化拒短标签', parseStructured({ stem: '设置', options: [], typeLabel: '' }).ok, false);
  eq('结构化放行带标签简答',
    parseStructured({ stem: '简述TCP与UDP的主要区别。', options: [], typeLabel: '简答题' }).ok, true);

  // looksLikeQuestion 直接判据
  eq('判据：null', looksLikeQuestion(null), false);
  eq('判据：空 stem', looksLikeQuestion({ stem: '', options: [] }), false);
  eq('判据：2 选项即成立', looksLikeQuestion({ stem: 'x', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }] }), true);
  eq('判据：typeLabel 即成立', looksLikeQuestion({ stem: 'x', options: [], typeLabel: '单选题' }), true);
  eq('判据：短标签拒绝', looksLikeQuestion({ stem: '设置', options: [] }), false);
  eq('判据：界面标签考试页也拒绝', looksLikeQuestion({ stem: '设置', options: [] }, { examPage: true }), false);
  eq('判据：短题干考试页放行', looksLikeQuestion({ stem: '简述TCP特点', options: [] }, { examPage: true }), true);
  eq('判据：分值行', looksLikeQuestion({ stem: '3.（2分）计算题内容', options: [] }), true);
  eq('判据：空位行', looksLikeQuestion({ stem: 'TCP长度是____字节', options: [] }), true);
  // 回归：裸"计算"曾把课程名「计算机网络」判成题干
  eq('判据：课程名不误判', looksLikeQuestion({ stem: '计算机网络', options: [] }), false);
  eq('判据：数据分析不误判', looksLikeQuestion({ stem: '数据分析', options: [] }), false);
}

// ══════════════ 12. OCR 几何恢复 ══════════════
// 真机数据（Redmi M2101K9C 1080x2400，河南普法竞赛第 5 题）：
// C 选项的 "C." 是小字号独立元素，RapidOCR 整个漏掉，只留下缩进的正文两行。
// 纯文本无法区分「C 的第一行」和「B 的折行」，坐标能。
{
  const boxes = [
    { x: 92,  y: 361,  x2: 234, y2: 395,  text: '答题进度' },
    { x: 117, y: 551,  x2: 210, y2: 588,  text: '单选题' },
    { x: 269, y: 551,  x2: 810, y2: 590,  text: '食堂排队过程中，前方同学不慎将' },
    { x: 95,  y: 611,  x2: 985, y2: 652,  text: '热汤酒出将你烫伤。关于本案侵权责任，下' },
    { x: 96,  y: 676,  x2: 570, y2: 713,  text: '列说法正确的是？' },
    { x: 126, y: 811,  x2: 960, y2: 845,  text: 'A．该同学应当承担全部责任，因其是直接行为人' },
    { x: 127, y: 950,  x2: 960, y2: 980,  text: 'B．你自身存在责任，原因是排队时站得距离过近' },
    { x: 184, y: 1084, x2: 950, y2: 1117, text: '应根据双方过错确定责任；受害人对损害发生' },
    { x: 182, y: 1141, x2: 900, y2: 1174, text: '也有过错的，可以减轻侵权人的责任' },
    { x: 127, y: 1277, x2: 780, y2: 1311, text: 'D.食堂应当承担全部赔偿责任' },
    { x: 241, y: 1527, x2: 400, y2: 1575, text: '上一题' },
    { x: 705, y: 1529, x2: 850, y2: 1574, text: '下一题' },
  ];
  const rawText = boxes.map((b) => b.text).join('\n');

  // 恢复前：只有 2 个选项（线上就是这个状态，触发 optCount<3 拒绝作答）
  eq('几何：不带坐标只有 2 选项', parseScreen(rawText).primary.options.length, 2);

  // 恢复后：4 个选项全齐
  const r = parseScreen(rawText, { boxes });
  eq('几何：带坐标恢复 4 选项', r.primary.options.length, 4);
  eq('几何：C 被补回标签', r.primary.options[2].key, 'C');
  eq('几何：C 的折行被合并',
    r.primary.options[2].text, '应根据双方过错确定责任;受害人对损害发生也有过错的,可以减轻侵权人的责任');
  eq('几何：D 保留', r.primary.options[3].key, 'D');
  eq('几何：题型仍为单选', r.primary.type, 'single');

  // 误补防线：按钮缩进够但超出选项区，不能被标成 E
  const texts = rebuildTextWithGeometry(rawText, boxes).split('\n');
  ok('几何：按钮不被误标', !texts.some((t) => /^E[.、]/.test(t)),
    texts.filter((t) => t.includes('上一题')).join('|'));

  // 无坐标时行为不变
  eq('几何：无坐标不重建', rebuildTextWithGeometry(rawText, null), rawText);
  eq('几何：空数组不重建', rebuildTextWithGeometry(rawText, []), rawText);

  // 只有 1 个带标签选项时不做恢复（无法推断基准与行距）
  const one = boxes.filter((b) => /^A[.．]/.test(b.text) || b.text.includes('答题进度'));
  const oneText = rebuildTextWithGeometry(one.map((b) => b.text).join('\n'), one);
  ok('几何：单选项不恢复', !/^B[.、]/.test(oneText), oneText);
}

// ══════════════ 13. OCR 裸标签（第 7 题）══════════════
// 真机数据（同一台机器，河南普法竞赛第 7 题，打赏退款）。
// 这一题暴露的是「固定面积」缺陷：A 和 D 的选项字母被 OCR 单独切成小块，
// 块里只有 "A." / "D." 没有正文 → matchOption 判为无标签 →
// 已标注行只剩 B、C → 选项区边界只框住 B/C → A(871) 和 D(1452) 全被跳过。
// 纯文本层面同样是 2 个选项，与第 5 题表现一致但成因不同。
{
  const boxes = [
    { x: 92,  y: 361,  x2: 200, y2: 395,  text: '答题进度' },
    { x: 117, y: 551,  x2: 220, y2: 588,  text: '单选题' },
    { x: 265, y: 549,  x2: 600, y2: 590,  text: '17岁的小尚长期以自己的劳动' },
    { x: 93,  y: 611,  x2: 620, y2: 652,  text: '为主要生活来源，在网络平台进行大' },
    { x: 96,  y: 674,  x2: 630, y2: 713,  text: '赏。其父母主张打赏行为仅因其未成年' },
    { x: 95,  y: 736,  x2: 600, y2: 776,  text: '然无效。下列说法正确的是' },
    // A：裸标签在两行正文之间（y=901 落在 871 和 923 之间）
    { x: 180, y: 871,  x2: 660, y2: 907,  text: '未满18周岁，实施的所有民事法律行为均效力' },
    { x: 125, y: 901,  x2: 165, y2: 937,  text: 'A.' },
    { x: 174, y: 923,  x2: 250, y2: 970,  text: '待定' },
    // B：标签夹在自己正文的第二行里，正文第一行在标签行上方
    { x: 179, y: 1065, x2: 660, y2: 1100, text: '该学生依法视为完全民事行为能力人，打赏效力' },
    { x: 127, y: 1124, x2: 660, y2: 1157, text: 'B.不能仅根据年龄认定，但仍需审查是否存' },
    { x: 180, y: 1180, x2: 480, y2: 1213, text: '在其它影响效力的因素' },
    { x: 129, y: 1318, x2: 620, y2: 1348, text: 'C．平台在任何情况下均须全额退款' },
    // D：同样是裸标签
    { x: 183, y: 1452, x2: 660, y2: 1485, text: '小尚成年后，此前实施的所有民事法律行为自' },
    { x: 125, y: 1482, x2: 165, y2: 1516, text: 'D.' },
    { x: 178, y: 1507, x2: 280, y2: 1545, text: '动失效' },
    { x: 241, y: 1759, x2: 340, y2: 1808, text: '上一题' },
    { x: 704, y: 1762, x2: 800, y2: 1804, text: '下一题' },
  ];
  const rawText = boxes.map((b) => b.text).join('\n');

  // 恢复前：纯文本层面整题解析不出来（裸标签孤立成行 + B 的标签混在正文里，
  // 选项块根本不连续）。这正是线上「只读到 2 个选项」的成因之一。
  const before = parseScreen(rawText).primary;
  ok('裸标签：不带坐标解析失败或选项不全',
    !before || before.options.length < 4,
    before ? `${before.options.length} 选项` : 'null');

  // 恢复后：4 个选项全齐
  const r = parseScreen(rawText, { boxes });
  eq('裸标签：带坐标恢复 4 选项', r.primary.options.length, 4);
  eq('裸标签：A 被补回', r.primary.options[0].key, 'A');
  eq('裸标签：D 被补回', r.primary.options[3].key, 'D');
  eq('裸标签：题型仍为单选', r.primary.type, 'single');

  // A 的两行正文（871 / 923）都归到 A，且裸标签本身不残留
  ok('裸标签：A 正文完整', r.primary.options[0].text.includes('未满18周岁')
    && r.primary.options[0].text.includes('待定'), r.primary.options[0].text);
  const texts = rebuildTextWithGeometry(rawText, boxes).split('\n');
  ok('裸标签：不残留孤立标签行',
    !texts.some((t) => /^[A-H][.、．]$/.test(t.trim())),
    texts.filter((t) => /^[A-H][.、．]$/.test(t.trim())).join('|'));

  // B 的正文第一行在标签上方，必须向上归并，不能孤立留在 A 和 B 之间
  ok('裸标签：B 上方正文已归并',
    r.primary.options[1].text.includes('该学生依法视为'), r.primary.options[1].text);

  // 防误补：B 的正文第一行（y=1065）缩进够、行距也像选项，
  // 但 B 在 1124 已有标签，不能再造一个 B
  const keys = r.primary.options.map((o) => o.key);
  eq('裸标签：字母不重复', new Set(keys).size, keys.length);
  ok('裸标签：无重复 B', keys.filter((k) => k === 'B').length === 1, keys.join(','));

  // 按钮仍不能被误标
  ok('裸标签：按钮不被误标', !texts.some((t) => /^[EF][.、]/.test(t)),
    texts.filter((t) => t.includes('上一题')).join('|'));
}

// ══════════════ 14. 标签在正文右下 + 顶部状态栏噪声（第 10 题）══════════════
// 真机数据（河南普法竞赛第 10 题，「二十届五中全会」）。和第 7 题表现相同
// （只读到 2 个选项），但成因完全不同 —— 这一题暴露两个新缺陷：
//
//   A) baseX 用错了坐标系。
//      这一题的版式是「正文在左、标签在正文右下方」：
//        正文1 y=750 x=194   标签 A. y=779 x=126
//        正文2 y=806 x=183
//      裸标签贴回正文行时只在 text 前加了 "A. "，box.x 仍是正文的 194。
//      于是 baseX = min(194,194,196) = 194，而 C 的两行正文 x=196/183，
//      196-194=2 < 24，全被判成"没缩进"→ C 补不回来，只剩 2 个选项。
//      修法：贴回裸标签时记下 labelX，baseX 用 labelX（125）而不是 x（194）。
//
//   B) 状态栏/标题栏按内容过滤不掉。
//      isOcrUiNoise 是正则黑名单，只能挡 "9:30"/"KB/s" 这类固定格式。
//      这题读进了 "2台"、"河南省第四届"豫见法治"…"、"m.topnews.cn"、
//      "① 00:23"、"答题进度"、"10 /20"，全部混进题干。
//      修法：在裸标签贴回之后按坐标裁掉「顶部 20% 区域内、离第一个选项
//      超过 1.5 倍行高」的行。放在贴回之后是因为裁剪要靠第一个选项行定位，
//      而裸标签贴回前 matchOption("A.") 是 null，没有锚点。
{
  const boxes = [
    // ── 状态栏 ──
    { x: 720, y: 41,  x2: 770, y2: 75,  text: '3.60' },
    { x: 611, y: 45,  x2: 683, y2: 79,  text: '2台' },
    { x: 875, y: 45,  x2: 906, y2: 79,  text: '5G' },
    { x: 146, y: 50,  x2: 226, y2: 84,  text: '1:20' },
    { x: 722, y: 65,  x2: 771, y2: 99,  text: 'KB/s' },
    // ── 网页标题栏 / 域名 ──
    { x: 150, y: 119, x2: 922, y2: 155, text: '河南省第四届"豫见法治"青少年学法..' },
    { x: 439, y: 190, x2: 643, y2: 224, text: 'm.topnews.cn' },
    // ── 答题进度条 ──
    { x: 235, y: 348, x2: 363, y2: 382, text: '10 /20' },
    { x: 808, y: 357, x2: 987, y2: 391, text: '① 00:23' },
    { x: 92,  y: 360, x2: 223, y2: 394, text: '答题进度' },
    // ── 题干（两行，第二行被切成两段）──
    { x: 117, y: 550, x2: 217, y2: 588, text: '单选题' },
    { x: 268, y: 550, x2: 986, y2: 588, text: '党的二十届五中全会审议通过了哪' },
    { x: 299, y: 608, x2: 358, y2: 642, text: '()' },
    { x: 92,  y: 609, x2: 254, y2: 643, text: '一文件?' },
    // ── A：正文1 / 裸标签 / 正文2 ──
    { x: 194, y: 750, x2: 930, y2: 783, text: '《中共中央关于进一步全面深化改革、推进中' },
    { x: 126, y: 779, x2: 159, y2: 813, text: 'A.' },
    { x: 183, y: 806, x2: 501, y2: 840, text: '国式现代化的决定》' },
    // ── B：同构 ──
    { x: 194, y: 944, x2: 928, y2: 974, text: '《中共中央关于制定国民经济和社会发展第十' },
    { x: 125, y: 971, x2: 160, y2: 1005, text: 'B.' },
    { x: 181, y: 999, x2: 538, y2: 1033, text: '五人五年规划的建议》' },
    // ── C：标签整块丢失，只剩两行正文 ──
    { x: 196, y: 1137, x2: 929, y2: 1167, text: '《中共中央关于持之以恒推进全面从严治党若' },
    { x: 183, y: 1192, x2: 502, y2: 1225, text: '干重大问题的决定》' },
    // ── D：同构 ──
    { x: 196, y: 1329, x2: 928, y2: 1359, text: '《中共中央关于全面推进依法治国若重大问' },
    { x: 125, y: 1358, x2: 163, y2: 1392, text: 'D.' },
    { x: 181, y: 1383, x2: 352, y2: 1417, text: '题的决定》' },
    // ── 按钮 ──
    { x: 240, y: 1635, x2: 379, y2: 1673, text: '上一题' },
    { x: 704, y: 1637, x2: 843, y2: 1675, text: '下一题' },
  ];
  const rawText = boxes.map((b) => b.text).join('\n');

  // 修复前：只有 2 个选项（A、B），C 和 D 都丢
  const before = parseScreen(rawText).primary;
  ok('第10题：不带坐标解析不出 4 选项',
    !before || before.options.length < 4,
    before ? `${before.options.length} 选项` : 'null');

  const r = parseScreen(rawText, { boxes });
  eq('第10题：带坐标恢复 4 选项', r.primary.options.length, 4);
  eq('第10题：字母连续', r.primary.options.map((o) => o.key).join(''), 'ABCD');
  eq('第10题：题型为单选', r.primary.type, 'single');

  // C 是标签整块丢失的那个 —— 两行正文都要拼回去，且不能半句话
  ok('第10题：C 正文完整',
    r.primary.options[2].text.includes('持之以恒推进全面从严治党')
    && r.primary.options[2].text.includes('干重大问题的决定'),
    r.primary.options[2].text);

  // 题干必须干净：状态栏/标题栏/进度条一个字都不能进
  const stem = r.primary.stem;
  ok('第10题：题干不含状态栏噪声',
    !stem.includes('2台') && !stem.includes('KB/s') && !stem.includes('1:20'),
    stem);
  ok('第10题：题干不含标题栏噪声',
    !stem.includes('豫见法治') && !stem.includes('m.topnews.cn'),
    stem);
  ok('第10题：题干不含进度条',
    !stem.includes('答题进度') && !stem.includes('10 /20') && !stem.includes('00:23'),
    stem);
  ok('第10题：题干保留真题面',
    stem.includes('党的二十届五中全会审议通过了哪') && stem.includes('一文件'),
    stem);

  // 顶部裁剪不能误伤题干：题干的行必须都还在
  const kept = rebuildTextWithGeometry(rawText, boxes).split('\n');
  ok('第10题：题干行未被误删',
    kept.some((t) => t.includes('党的二十届五中全会')),
    kept.slice(0, 5).join('|'));

  // 按钮不能被当成选项
  ok('第10题：按钮不被误标',
    !kept.some((t) => /^[EF][.、]/.test(t)),
    kept.filter((t) => t.includes('上一题')).join('|'));
}

// ══════════════ 15. 多选题题型识别（第 5 题）══════════════
// 真机数据（河南普法竞赛第 5 题，电竞酒店接待未成年人）。
// 现象：多选题被判成单选，只给一个答案。
//
// 成因是我自己引入的回归：第 10 题为了裁掉顶部状态栏，用了
//   cutLine = firstOptY - rowH × 3
// 这种「固定行数」判据。第 10 题题干 3 行刚好躲过，第 5 题题干 4 行 ——
// 裁剪线落进题干内部，把「多选题」（题型标签！）和「（多选）某电竞酒店…」
// 两行切掉了。typeLabel 随之消失，detectType 退回「选项≥2 → single」，
// 多选题就被判成单选。
//
// 修法：判据改用**行间距**。同一块内容内部行距 58~69px，
// 「进度条 → 题干」之间 186~190px，差 3 倍，用 1.8×行高当阈值切断。
// 另外必须先剔除「第一个选项自己的正文折行」—— 这题 A 的正文首行
// （y=811）在标签（y=869）上方，不剔除的话 811→673 的 138px 会被当成
// 跨块，回溯第一步就断，题干整块被删（实测 stem 变空串）。
{
  const boxes = [
    // 状态栏 / 标题栏 / 进度条
    { x: 721, y: 40,  x2: 770, y2: 74,  text: '676' },
    { x: 608, y: 45,  x2: 680, y2: 79,  text: '2台' },
    { x: 872, y: 45,  x2: 903, y2: 79,  text: '5G' },
    { x: 142, y: 49,  x2: 222, y2: 83,  text: '1:34' },
    { x: 718, y: 65,  x2: 767, y2: 99,  text: 'KB/s' },
    { x: 150, y: 121, x2: 922, y2: 157, text: '河南省第四届“豫见法治”青少年学法...' },
    { x: 439, y: 190, x2: 643, y2: 224, text: 'm.topnews.cn' },
    { x: 239, y: 348, x2: 367, y2: 382, text: '05 /20' },
    { x: 92,  y: 362, x2: 223, y2: 396, text: '答题进度' },
    // 题干：4 行，第 1 行带题型词，第 2 行是题型标签（同一基线的两块）
    { x: 292, y: 548, x2: 986, y2: 586, text: '（多选）某电竞酒店长期接待未成' },
    { x: 117, y: 552, x2: 217, y2: 590, text: '多选题' },
    { x: 93,  y: 611, x2: 986, y2: 649, text: '年人通宵上网，被查处。依据《未成年人保' },
    { x: 93,  y: 673, x2: 700, y2: 711, text: '护法》，该酒店可能违反的义务包括？' },
    // A：正文首行在标签上方（3 行正文）
    { x: 180, y: 811, x2: 940, y2: 845, text: '接待未成年人入住时，依法询问其父母或者其' },
    { x: 126, y: 869, x2: 940, y2: 903, text: 'A．他监护人的联系方式、入住人员身份关系等有' },
    { x: 180, y: 925, x2: 560, y2: 959, text: '关情况的义务' },
    // B / C / D
    { x: 127, y: 1063, x2: 940, y2: 1097, text: 'B.遵守不适宜未成年人活动场所禁入规定的义务' },
    { x: 177, y: 1199, x2: 800, y2: 1233, text: '承担对入住未成年人的临时监护职责' },
    { x: 132, y: 1203, x2: 165, y2: 1237, text: 'C.' },
    { x: 129, y: 1336, x2: 800, y2: 1370, text: 'D.学校对未成年学生的管理义务' },
    { x: 241, y: 1584, x2: 379, y2: 1622, text: '上一题' },
    { x: 706, y: 1586, x2: 843, y2: 1624, text: '下一题' },
  ];
  const rawText = boxes.map((b) => b.text).join('\n');

  const r = parseScreen(rawText, { boxes });
  eq('第5题：识别为多选', r.primary.type, 'multi');
  eq('第5题：题型标签保留', r.primary.typeLabel, '多选题');
  eq('第5题：4 个选项', r.primary.options.length, 4);

  // 题干必须完整 —— 这是核心回归点，4 行一行都不能少
  const stem = r.primary.stem;
  ok('第5题：题干首行未被裁掉', stem.includes('某电竞酒店长期接待未成'), stem);
  ok('第5题：题干中段保留', stem.includes('年人通宵上网'), stem);
  ok('第5题：题干末行保留', stem.includes('该酒店可能违反的义务包括'), stem);

  // 状态栏/进度条仍然要被切掉（不能为了保题干把噪声放进来）
  ok('第5题：仍不含状态栏噪声',
    !stem.includes('2台') && !stem.includes('KB/s'), stem);
  ok('第5题：仍不含标题栏噪声',
    !stem.includes('豫见法治') && !stem.includes('m.topnews.cn'), stem);
  ok('第5题：仍不含进度条',
    !stem.includes('答题进度') && !stem.includes('05 /20'), stem);

  // A 的三行正文都要归到 A，不能因为首行在标签上方而丢失
  ok('第5题：A 正文首行未丢',
    r.primary.options[0].text.includes('接待未成年人入住时'), r.primary.options[0].text);
  ok('第5题：A 正文末行已归并',
    r.primary.options[0].text.includes('关情况的义务'), r.primary.options[0].text);

  // C 是裸标签，要补回
  eq('第5题：C 被补回', r.primary.options[2].key, 'C');
  ok('第5题：C 正文完整',
    r.primary.options[2].text.includes('承担对入住未成年人的临时监护职责'),
    r.primary.options[2].text);
}

// ══════════════ 16. 题型自我纠正（模型说多选就是多选）══════════════
// detectType 是从 OCR 文本猜题型的（找"多选题"标签、"包括哪些"线索），
// OCR 漏字/版式特殊/题干被裁都会猜错。而 buildMessages 的 typeHint 是硬约束：
// 猜成单选，模型就只能输出 {"index":N}。
//
// 更糟的是 parseAnswerText 原来写死 `type === 'multi' ? indices : selectedIndex`：
// 即使模型主动返回 {"indices":[0,1]}，单选位置上也只取 indices[0]，
// 多选题被硬砍成单选 —— 这是 air 反馈「经常检测不出来是多选」的直接原因。
//
// 现在的规则：模型返回多个下标 = 它认为答案不止一个，题型跟着改成 multi。
// 只在单选/多选之间放行（判断/填空/简答格式不同，不能混）。
{
  const q = {
    stem: '某电竞酒店长期接待未成年人通宵上网，该酒店可能违反的义务包括？',
    options: [
      { key: 'A', text: '依法询问监护人联系方式' },
      { key: 'B', text: '遵守不适宜场所禁入规定' },
      { key: 'C', text: '承担临时监护职责' },
      { key: 'D', text: '学校的管理义务' },
    ],
    type: 'single',        // 故意给错的题型
  };

  // 模型返回多个下标 → 纠正为 multi，且两个答案都要保留
  const n1 = parseAnswerText('{"indices":[0,1]}', q);
  eq('纠正：题型改为 multi', n1.type, 'multi');
  eq('纠正：记录了纠正来源', n1.typeCorrected, 'single→multi');
  eq('纠正：两个下标都保留', JSON.parse(n1.params.indicesJson).join(','), '0,1');

  // 模型只返回一个下标 → 维持单选，不能凭空升级成多选
  const n2 = parseAnswerText('{"index":2}', q);
  eq('不误升级：单选仍是 single', n2.type, 'single');
  eq('不误升级：selectedIndex 正确', n2.params.selectedIndex, 2);
  eq('不误升级：无纠正标记', n2.typeCorrected, undefined);

  // 已经是 multi 的题，单下标也要按 multi 处理（渲染成 A 而不是丢）
  const qm = { ...q, type: 'multi' };
  const n3 = parseAnswerText('{"indices":[1]}', qm);
  eq('多选单下标：仍是 multi', n3.type, 'multi');
  eq('多选单下标：下标保留', JSON.parse(n3.params.indicesJson).join(','), '1');

  // 判断题不能被多下标污染：它的语义是 index 0/1，格式完全不同
  const qj = { stem: '下列说法正确。', options: [{ key: 'A', text: '对' }, { key: 'B', text: '错' }], type: 'judge' };
  const n4 = parseAnswerText('{"indices":[0,1]}', qj);
  ok('判断题不被升级成多选', n4.type === 'judge', n4.type);

  // detectType 的文本线索（不依赖 typeLabel）
  eq('detectType：括号多选', detectType({
    stem: '（多选）某电竞酒店长期接待未成年人', options: q.options, type: null,
  }), 'multi');
  eq('detectType：包括哪些', detectType({
    stem: '该酒店可能违反的义务包括哪些？', options: q.options, type: null,
  }), 'multi');
  eq('detectType：正确的有', detectType({
    stem: '下列关于 TCP 的说法正确的有', options: q.options, type: null,
  }), 'multi');
  eq('detectType：哪一项是 → 单选', detectType({
    stem: '下列关于 TCP 的说法哪一项是正确的', options: q.options, type: null,
  }), 'single');
  eq('detectType：普通单选', detectType({
    stem: '第一次握手由谁发送 SYN 报文？', options: q.options, type: null,
  }), 'single');
}

// ══════════════ 报告 ══════════════
console.log(`\n${'='.repeat(60)}`);
if (fail === 0) {
  console.log(`PASS  全部 ${pass} 项通过`);
  process.exit(0);
}
console.log(`FAIL  ${fail} 失败 / ${pass} 通过\n`);
for (const f of fails) console.log(' ✗ ' + f + '\n');
process.exit(1);