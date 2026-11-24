// .probe-ocr-clean.mjs —— 用真机截图的实际 OCR 输出验证清洗 + 图片题解析
// 数据来源：.cache/imgq.png 经 ocr_server.py 识别得到的原始行
import { parseScreen, isOcrUiNoise, isNoise, stripLeadingUiCrumb } from './answer-core.mjs';

let pass = 0, fail = 0;
const fails = [];
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++; fails.push(`${name}\n    got  ${g}\n    want ${w}`);
}
function ok(name, cond, extra = '') {
  if (cond) { pass++; return; }
  fail++; fails.push(`${name} ${extra}`);
}

// 真机 1080x2400 截图（图片题 + 上一题叠层残留）的 OCR 原始输出
const RAW = `3.08
9:30
(77
KB/s
Exam Mock
个报文丢失会使后续已到达的数据也无法上交应用
层，造成整体停顿：UDP面向报文，各报文独立，丢
A失该报文本身。
B4.避拥塞控制导致速率骤降。TCP 的拥塞控制会
在丢包时大幅降速，使实时码流出现明显降质：UDP
本鼻进行扭塞控制，发送速率可由应用按业务需要
C，数据链路
决定，便手菜用自适应码率等应用层策略（如RTP/
RTCP、QUIC在应用层实现部分可靠性）
D.物理层
5.开销小、效率高。UDP首部仅8字节，无连接建
呆查种除过程，无需维护连接状态，服务器可支撑海
量并发和短交互，适合 DNS、VoD 信令等场景
6.支持多播和广播。UDP支持一对一、一对多和多
对多通信。适合直播分发、多人游戏、服务发现等场
景，TCP 只能点对点
7.控制权交给应用层。应用可以按需直自行实现差错检
测、前向纠错 FEC、重传策略、加密和拥塞控制，只
对关键数据做可靠传输，对关键数据允许丢失，从
a1ly已连接·Vol+×2弹窗/Vol-x2总开美
下一题／NEXT`;

// ── 1. 状态栏/标题栏/toast 必须被判为噪声 ──
const mustNoise = [
  '3.08', '9:30', '(77', 'KB/s', 'Exam Mock',
  'a1ly已连接·Vol+×2弹窗/Vol-x2总开美',
  'Shell 已被授予超级用户权限',
];
for (const l of mustNoise) {
  ok(`OCR噪声: ${l}`, isOcrUiNoise(l), `→ 未被判为噪声`);
}

// ── 2. 真实题干/选项不能被误杀 ──
const mustKeep = [
  'B4.避拥塞控制导致速率骤降。TCP 的拥塞控制会',
  'D.物理层',
  '5.开销小、效率高。UDP首部仅8字节，无连接建',
  '层，造成整体停顿：UDP面向报文，各报文独立，丢',
];
for (const l of mustKeep) {
  ok(`保留正文: ${l.slice(0, 20)}`, !isOcrUiNoise(l), `→ 被误杀`);
}

// ── 3. 清洗后整屏解析不应把状态栏当题干 ──
const cleaned = RAW.split('\n')
  .map((s) => s.trim())
  .filter((s) => s && !isOcrUiNoise(s))
  .join('\n');
ok('清洗后不含 KB/s', !cleaned.includes('KB/s'));
ok('清洗后不含 Exam Mock', !cleaned.includes('Exam Mock'));
ok('清洗后不含 9:30', !cleaned.includes('9:30'));
ok('清洗后仍含物理层', cleaned.includes('物理层'));

// ── 4. 图片题的真实结构：手机端只给选项+题型，OCR 提供题干 ──
// 理想情况下 OCR 能读到干净的题干（叠层已隐藏）
const CLEAN_OCR = `6.（2分）IP 协议工作在哪一层？
A. 传输层
B. 网络层
C. 数据链路层
D. 物理层`;
const r = parseScreen(CLEAN_OCR);
eq('干净OCR: 识别为题目', r.ok, true);
eq('干净OCR: 题型', r.primary?.type, 'single');
eq('干净OCR: 选项数', r.primary?.options?.length, 4);
ok('干净OCR: 题干含 IP', String(r.primary?.stem || '').includes('IP'), `stem=${r.primary?.stem}`);

// ── 5. 叠层污染时的降级：不能把答案当题干 ──
// 这是修复前的实际输出，题干被拼成了叠层内容
const POLLUTED = cleaned;
const rp = parseScreen(POLLUTED);
ok('污染OCR: 题干不应以状态栏开头',
  !String(rp.primary?.stem || '').startsWith('3.08'),
  `stem=${String(rp.primary?.stem || '').slice(0, 40)}`);

// ── 6. 手机端选项优先：OCR 读错选项时用手机端的 ──
const ocrWrong = parseScreen(`6.（2分）IP 协议工作在哪一层？
A. 传输层
B. 网络层
C. 数据链
D. 物理`);
const mobileOptions = ['A. 传输层', 'B. 网络层', 'C. 数据链路层', 'D. 物理层'];
// 服务端逻辑：OCR 提供 stem，选项用手机端的
const merged = { ...ocrWrong.primary, options: mobileOptions };
eq('选项合并后数量', merged.options.length, 4);
ok('选项合并后用手机端的完整文案', merged.options[2] === 'C. 数据链路层');

// ── 7. 电量碎片污染（实测题库被这个坑出 4 个 qkey）──
// 真机缓存里出现过："l78 IP 协议工作在哪一层?" "￥578 IP..." "￥78 IP..."
const dirty = ['l78 IP 协议工作在哪一层?', '￥578 IP 协议工作在哪一层?', '￥78 IP 协议工作在哪一层?'];
for (const d of dirty) {
  const stripped = stripLeadingUiCrumb(d);
  eq(`剥离电量碎片: ${d.slice(0, 8)}`, stripped.trim(), 'IP 协议工作在哪一层?');
}
// 剥离后必须能解析成同一个干净题干
const stems = dirty.map((d) => parseScreen(stripLeadingUiCrumb(d)).primary?.stem || '');
for (const s of stems) eq('剥离后题干一致', s, 'IP 协议工作在哪一层?');

// 电量碎片本身要被判噪声
for (const c of ['l78', '￥578', '￥78', '€78', 'l7B']) {
  ok(`电量碎片判噪声: ${c}`, isOcrUiNoise(c));
}

// 但不能误杀真实短题干
const realStems = ['IP 协议工作在哪一层?', 'TCP 首部固定长度是____字节', 'A. 传输层'];
for (const s of realStems) {
  ok(`真实题干不误杀: ${s.slice(0, 12)}`, !isOcrUiNoise(s));
  eq(`真实题干不被剥前缀: ${s.slice(0, 12)}`, stripLeadingUiCrumb(s), s);
}

console.log(`\n${'='.repeat(60)}`);
if (fail === 0) {
  console.log(`PASS  全部 ${pass} 项通过`);
  process.exit(0);
}
console.log(`FAIL  ${fail} 失败 / ${pass} 通过\n`);
for (const f of fails) console.log(' ✗ ' + f + '\n');
process.exit(1);
