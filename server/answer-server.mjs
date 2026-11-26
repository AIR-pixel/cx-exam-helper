/**
 * answer-server.mjs (v2.1) —— 手机 → PC 答题管线
 *
 * 监听 127.0.0.1:18888。手机经 `adb reverse tcp:18888 tcp:18888` 访问。
 *
 * 变化：
 *   1. 收进来的不是裸文本，而是 a11y 线性文本 → answer-core 结构化解析
 *      （清洗 + 题型判定 + 选项切分，对位上游 Zygisk 项目的 DOM 解析）
 *   2. 先查 SQLite 题库缓存（归一化哈希去重），命中直接返回，不打模型
 *   3. 引擎可插拔：auto / qoder / openai / heuristic / echo
 *      auto = qoder 可用就用真模型，否则退回 heuristic
 *   4. 返回结构里带题目结构化信息，手机端可按题型走不同作答路径
 *
 * 端点：
 *   POST /answer  { question }    → { answer, source, type, question, screenHash, ms }
 *   POST /parse   { question }    → 结构化结果（调试，不调模型）
 *   GET  /health                  → { ok, engine, cache, uptime }
 *   GET  /stats                   → 缓存统计
 *   GET  /recent?limit=N          → 最近 N 条题库
 *   GET  /models                  → qoder 可用模型目录
 *   POST /cache/clear             → 清空题库
 *
 * 环境变量：
 *   ANSWER_ENGINE   auto | qoder | openai | heuristic | echo   （默认 auto）
 *   ANSWER_CACHE    缓存文件路径，'' 或 ':memory:' 不落盘（默认 ./answer-cache.db）
 *   ANSWER_PORT     监听端口（默认 18888）
 *   ANSWER_TIMEOUT_MS  单次模型超时（默认 90000）
 *   QODER_MODEL     qoder 模型 key（默认 dfmodel = DeepSeek-Flash）
 *   OPENAI_BASE / OPENAI_KEY / OPENAI_MODEL   openai 引擎用
 *
 * 启动（qoder 引擎必须带 resolve hook）：
 *   node --import ./dsh-resolve-register.mjs answer-server.mjs
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { parseScreen, parseStructured, parseAnswerText, countBlanks, detectType,
         isOcrUiNoise, stripLeadingUiCrumb } from './answer-core.mjs';
import { AnswerCache } from './answer-cache.mjs';
import { qoderAvailable, qoderChat, qoderModels } from './engine-qoder.mjs';

const PORT = Number(process.env.ANSWER_PORT || 18888);

/**
 * 读取 config.json。
 *
 * 为什么必须读：manager.mjs 写 config.json 让用户选监听地址/引擎/模型，
 * 但 answer-server 之前只认环境变量 —— config.json 里的 "bind": "0.0.0.0"
 * 从来没生效过。真机实测（2026-11-25）：手机连 10.75.124.158:18888 直接
 * SocketTimeoutException，因为服务只 bind 在 127.0.0.1，局域网进不来。
 * 用户看到的现象就是「连接失败」，但配置页明明写着 0.0.0.0。
 *
 * 优先级：环境变量 > config.json > 默认值。环境变量优先是为了让
 * 单测和临时调试能覆盖配置文件，不被用户设置干扰。
 */
function loadConfig() {
  const path = process.env.ANSWER_CONFIG || './config.json';
  try {
    // 必须剥 BOM：manager.mjs 用 PowerShell 的 Set-Content 写配置，会带上
    // UTF-8 BOM（EF BB BF），JSON.parse 遇到 BOM 直接抛 "Unexpected token"。
    // 之前整个 try/catch 吞掉异常返回 {}，于是 config.json 里的 bind/engine
    // 从来没生效过 —— 用户在配置页设 0.0.0.0，服务实际还是 127.0.0.1，
    // 手机端表现为「连接失败」（2026-11-25 真机踩到）。
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
const FILE_CONFIG = loadConfig();

// 监听地址：默认 127.0.0.1（USB reverse）。无线场景设 0.0.0.0 接受局域网连接。
const BIND = process.env.ANSWER_BIND || String(FILE_CONFIG.bind || '').trim() || '127.0.0.1';
const CACHE_PATH = process.env.ANSWER_CACHE === '' ? ':memory:'
  : (process.env.ANSWER_CACHE || FILE_CONFIG.cachePath || './answer-cache.db');
// 图片题 OCR：Python RapidOCR 微服务地址，空字符串 = 关闭
const OCR_URL = process.env.OCR_URL || 'http://127.0.0.1:18890/ocr';

// ─────────────────────────── 缓存 ───────────────────────────
let cache = null;
try {
  cache = new AnswerCache(CACHE_PATH);
  console.log(`[cache] ready: ${cache.path}`);
} catch (e) {
  console.error(`[cache] init failed, running without cache: ${e.message}`);
  cache = null;
}

// ─────────────────────────── 引擎 ───────────────────────────

/** 占位引擎：返回可辨识摘要，用于验证链路 */
function engineEcho(q) {
  const stem = String(q.stem || '').replace(/\s+/g, ' ').trim();
  const opts = (q.options || []).map((o) => `${o.key}. ${o.text}`).join(' / ');
  return `ECHO[${q.type}] ${stem.slice(0, 40)}${opts ? ' | ' + opts.slice(0, 60) : ''}`;
}

/** 启发式引擎：不联网，用于管线自测 */
function engineHeuristic(q) {
  // 滚动验证开关：LONG_TEST=1 时 short 题型返回超长段落，验证叠层自动滚动
  if (process.env.LONG_TEST === '1' && q.type === 'short') {
    const long = '这是一段用于验证答案叠层自动滚动能力的超长文本。'
      + '浮层是 NOT_FOCUSABLE|NOT_TOUCHABLE，用户摸不到滚动条，长答案必须由程序自动滚动。'
      + '本段落被故意拉得很长，用来制造 overflow。'
      + ('第 N 段：滚动验证需要超过可视区高度的内容，所以这一段要写得足够长，'
        + '长到 TextView 高度超过 480dp 的上限，长到必须触发滚动，长到第一屏放不下。'
        + '这些句子本身没有语义，只是用来占空间，让布局超出容器高度，从而激活滚动逻辑。'
        + '这里再补一些无意义但必须存在的填充文字，把总长度推过一千个字符。'
        + '实践证明：字数不够，「溢出判断」会认为内容放得下，自动滚动根本不会启动。'
        + '所以这段必须长、长、长，长到 textview 的可视高度装不下为止。').repeat(30);
    return JSON.stringify({ text: long });
  }
  const type = q.type || 'single';
  if (type === 'single' || type === 'judge') return '{"index":0}';
  if (type === 'multi') return '{"indices":[0]}';
  if (type === 'blank') {
    const n = q.blankCount || countBlanks(q.stem) || 1;
    return JSON.stringify({ answers: Array.from({ length: n }, (_, i) => `填空${i + 1}`) });
  }
  return JSON.stringify({ text: '启发式引擎占位答案' });
}

/** 题目 → chat messages（system 给题型约束，user 给题干+选项） */
function buildMessages(q) {
  const typeHint = {
    single: '这是单选题。只输出 JSON：{"index":<0基选项序号>}',
    multi: '这是多选题。只输出 JSON：{"indices":[<0基选项序号>,...]}',
    judge: '这是判断题。只输出 JSON：{"index":0} 表示「对/正确」，{"index":1} 表示「错/错误」',
    blank: `这是填空题，共 ${q.blankCount || 1} 空。只输出 JSON：{"answers":["第1空内容","第2空内容"]}`,
    short: '这是简答题。只输出 JSON：{"text":"答案正文"}',
  }[q.type] || '只输出 JSON。';

  const optText = (q.options || [])
    .map((o, i) => `${String.fromCharCode(65 + i)}. ${o.text}`)
    .join('\n');

  // 题型兜底：让模型在「按题目本身看更像多选」时能自己纠正。
  //
  // 为什么需要：题型是靠 detectType 从 OCR 文本猜的（找"多选题"标签、
  // "包括哪些"这类线索）。OCR 漏字、版式特殊、题干被裁都会让它猜错，
  // 而 typeHint 是硬约束 —— 猜成单选，模型就只能输出 {"index":N}，
  // 多选题直接被答成单选（air 反馈「经常检测不出来是多选」）。
  //
  // 所以给模型一个逃生口：如果按题干语义答案明显不止一个，可以返回
  // {"indices":[...]}，服务端会据此把题型纠正为 multi。
  // 只在单选/多选之间放行 —— 判断/填空/简答的格式完全不同，不能混。
  const canSwitch = q.type === 'single' || q.type === 'multi';
  const switchNote = canSwitch
    ? '\n注意：如果按题干语义正确答案明显不止一个（如「包括哪些」「正确的有」），'
      + '请改输出 {"indices":[序号,...]}；只有一个答案时输出 {"index":序号}。'
    : '';

  return [
    {
      role: 'system',
      content: `你是答题助手，回答中国高校在线课程的客观题。\n${typeHint}${switchNote}\n只输出 JSON，不要解释、不要复述题目、不要 markdown 代码块。`,
    },
    { role: 'user', content: optText ? `${q.stem}\n\n${optText}` : String(q.stem || '') },
  ];
}

/** qoder 引擎：走 dsh-connect-qoder 的 cosy 通道 */
async function engineQoder(q) {
  return qoderChat(buildMessages(q), {
    model: process.env.QODER_MODEL || 'dfmodel',
    // 30s 而不是 90s：正常题 0.6-7s 就回，超过 30s 基本是网络卡死，
    // 再等下去用户早走了。真机实测出现过 58s 才返回的情况（手机已断开）。
    timeoutMs: Number(process.env.ANSWER_TIMEOUT_MS || 30000),
  });
}

/**
 * 快档引擎：牺牲思考深度换响应速度（Vol+ ×2 触发）。
 *
 * 真机实测（同一道第 7 题，2026-11-25）：
 *   dfmodel        默认 2255ms  / minimal 2554ms / off → HTTP 400
 *   gmodel_latest  默认 3072ms  / minimal → HTTP 400
 *   mmodel         默认 1461ms  / minimal 1434ms / off → HTTP 400
 *   kmodel_latest  默认 9484ms  / minimal 4448ms / off 6175ms
 *
 * 所以「无思考」在 Qoder 网关上是伪命题：真正快的三个模型本来就不思考，
 * 给它们 reasoning_effort 只会换来 HTTP 400（只有 kmodel_latest 认 off，
 * 而它默认就要 9.5s，关掉思考仍比 mmodel 慢 4 倍）。
 *
 * 结论：快档 = 换 mmodel + minimal，不是加 off。
 * mmodel 1.4s vs dfmodel 2.3s，实测这道题两者都答对（B）。
 * 仍然显式传 reasoningEffort:'minimal' 而不是省略 —— 省略是「上游默认」，
 * 上游默认随时可能变成思考模式，写死 minimal 才是可复现的快。
 *
 * 如果哪天网关开始支持 off，改 QODER_FAST_EFFORT=off 即可，不用动代码。
 */
async function engineQoderFast(q) {
  return qoderChat(buildMessages(q), {
    model: process.env.QODER_FAST_MODEL || 'mmodel',
    reasoningEffort: process.env.QODER_FAST_EFFORT || 'minimal',
    timeoutMs: Number(process.env.ANSWER_FAST_TIMEOUT_MS || 20000),
  });
}

/**
 * qoder 视觉引擎：把原图直接交给模型看，跳过 OCR。
 *
 * 为什么需要它：RapidOCR 只能抄出文字。遇到几何图（坐标系/电路图/几何证明）、
 * 化学结构式、带下划线的完形填空时，OCR 出来的是一堆散落的标注文字，题干语义
 * 全丢了 —— 模型拿着残渣猜，正确率还不如不答。
 *
 * 而视觉模型能直接理解图里的几何关系。实测同一张 1080x2400 截图，
 * dfmodel/gmodel_latest/mmodel 都能准确读出内容，3-7s 出结果。
 *
 * 代价：一张 1080x2400 的 PNG 转 base64 约 330KB，比 OCR 的纯文本贵得多，
 * 所以只在 OCR 判定「读不出题干」时才走这条路（见 shouldUseVision）。
 */
async function engineQoderVision(q, image) {
  const b64 = await imageToBase64(image);
  if (!b64) throw new Error('图片解码失败');
  if (b64.startsWith('__SVG__')) throw new Error('SVG 应走文本抽取，不需要视觉');

  const mime = detectImageMime(b64);
  const url = `data:${mime};base64,${b64}`;

  const typeHint = {
    single: '这是单选题。只输出 JSON：{"index":<0基选项序号>}',
    multi: '这是多选题。只输出 JSON：{"indices":[<0基选项序号>,...]}',
    judge: '这是判断题。只输出 JSON：{"index":0} 表示「对/正确」，{"index":1} 表示「错/错误」',
    blank: `这是填空题，共 ${q.blankCount || 1} 空。只输出 JSON：{"answers":["第1空内容","第2空内容"]}`,
    short: '这是简答题。只输出 JSON：{"text":"答案正文"}',
  }[q.type] || '只输出 JSON。';

  const optText = (q.options || [])
    .map((o, i) => `${String.fromCharCode(65 + i)}. ${o.text}`)
    .join('\n');

  const ask = [
    '看这张手机截图，回答其中的题目。',
    q.stem ? `题干（OCR 结果，可能不全）：${q.stem}` : '题干在图里，请自己读。',
    optText
      ? `选项：\n${optText}`
      // 图片题常见：a11y 抽不到选项（选项也画在图里）。必须让模型自己数，
      // 否则它会给出一个我们无法映射回字母的下标。
      : '选项也画在图里，请自己读出选项个数，index 从 0 开始按图中 A/B/C/D 顺序计。',
    '如果图里有几何图形、坐标轴、电路图、化学结构式等，请结合图形作答。',
  ].filter(Boolean).join('\n');

  return qoderChat(
    [
      {
        role: 'system',
        content: `你是答题助手，回答中国高校在线课程的客观题。\n${typeHint}\n`
          + '只输出 JSON，不要解释、不要复述题目、不要 markdown 代码块。',
      },
      { role: 'user', content: ask },
    ],
    {
      model: process.env.QODER_VL_MODEL || process.env.QODER_MODEL || 'dfmodel',
      images: [url],
      timeoutMs: Number(process.env.ANSWER_VL_TIMEOUT_MS || 90000),
    },
  );
}

/**
 * 纯视觉引擎：整屏截图交给模型，由模型自己找出题目、选项、题型。
 *
 * ── 为什么需要它 ──
 *
 * 原来的主路径是「OCR 抄文字 → 几何恢复猜版式 → 文本模型作答」。这条路
 * 一直在跟版式搏斗，每遇到一种新排版就踩一个坑：
 *   第 7 题：标签是裸块（只有 "A."）+ 正文首行在标签上方 → 只读到 2 选项
 *   第 10 题：标签在正文右下 → baseX 用错坐标系 → 只读到 2 选项
 *   第 5 题：题干 4 行 → 固定行数裁剪把「多选题」标签切掉 → 多选判成单选
 * 每次修 A 又踩坏 B（第 5 题就是修第 10 题引入的回归）。
 *
 * 而视觉模型根本不需要这些中间层 —— 它直接看图，题目在哪、有几个选项、
 * 是单选还是多选，一眼就知道。实测三题（都是之前踩过坑的）：
 *
 *   第 5 题（多选）  5204ms  type=multi  stem 完整  options 4  indices[0,1] ✓
 *   第 10 题（单选） 8637ms  type=single stem 完整  options 4  indices[1]   ✓
 *   第 7 题（单选） 10580ms  type=single stem 完整  options 4  indices[1]   ✓
 *
 * 而且第 10 题的题干比 OCR 版更准：OCR 读成「通过了哪 () 一文件?」，
 * 视觉读成「通过了哪一文件？（ ）」—— OCR 把一行拆成两段导致语序断裂。
 *
 * ── 代价 ──
 *
 * 一张 1080x2400 PNG 转 base64 约 330KB，比 OCR 的纯文本贵得多，也更慢
 * （5~11s vs OCR 5.5s + 引擎 1~2s）。所以它**不是无条件更好**，而是
 * 「OCR 判不准时更可靠」。默认策略见 VISION_MODE。
 *
 * ── 输出契约 ──
 *
 * 要求模型返回结构化的题干/选项/下标，而不是只给一个字母。这样：
 *   · 选项数以模型读到的为准，不受 OCR 漏字影响
 *   · 浮层能显示选项原文（用户能核对是不是这一题）
 *   · indices 直接映射字母，不需要几何恢复
 */
async function engineQoderVisionFull(image) {
  const b64 = await imageToBase64(image);
  if (!b64) throw new Error('图片解码失败');
  if (b64.startsWith('__SVG__')) throw new Error('SVG 走文本抽取，不需要视觉');

  const mime = detectImageMime(b64);
  const url = `data:${mime};base64,${b64}`;

  const sys = [
    '你是答题助手，回答中国高校在线课程的客观题。',
    '看这张手机截图，自己找出题目和选项。',
    '截图里除了题目还有：状态栏（时间/电量/信号）、网页标题栏、答题进度、',
    '上一题/下一题按钮、以及上一题答案的浮层 —— 这些都不是题目，忽略它们。',
    '',
    '先判断题型，再作答。严格只输出这个 JSON，不要解释、不要 markdown：',
    '{"type":"single|multi|judge|blank|short",',
    ' "stem":"题干原文",',
    ' "options":["A项原文","B项原文",...],',
    ' "indices":[选中项下标，0 基]}',
    '',
    '单选题和判断题只给一个下标；多选题给多个。',
    '选项原文照抄图里的文字，不要改写、不要编号（不要带 "A." 前缀）。',
  ].join('\n');

  return qoderChat(
    [
      { role: 'system', content: sys },
      { role: 'user', content: '看这张截图，作答。' },
    ],
    {
      model: process.env.QODER_VL_MODEL || process.env.QODER_MODEL || 'dfmodel',
      images: [url],
      timeoutMs: Number(process.env.ANSWER_VL_TIMEOUT_MS || 90000),
    },
  );
}

/**
 * 把 engineQoderVisionFull 的返回解析成标准的 solve() 结果。
 *
 * 和文本路径的区别：这里 q 是模型自己读出来的，不是 OCR 拼的。
 * 所以 type / options 都以模型为准，不需要 detectType 再猜一遍。
 *
 * @returns {{ok:boolean, type?:string, stem?:string, options?:Array, indices?:Array, reason?:string}}
 */
function parseVisionFull(raw) {
  const j = extractJsonLoose(raw);
  if (!j) return { ok: false, reason: '视觉返回不是 JSON' };

  const stem = String(j.stem || '').trim();
  const optsRaw = Array.isArray(j.options) ? j.options : [];
  // 选项可能带 "A. " 前缀（模型偶尔不听话），剥掉统一由下游编号
  const options = optsRaw.map((s) => {
    const t = String(s == null ? '' : s).trim();
    const m = t.match(/^[（(]?[A-H][)）]?\s*[.、．)）:：]\s*(.*)$/);
    return m ? m[1].trim() : t;
  }).filter((s) => s.length > 0);

  let indices = Array.isArray(j.indices) ? j.indices : [];
  if (!indices.length && Number.isInteger(j.index)) indices = [j.index];
  indices = indices.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 26);

  if (!stem) return { ok: false, reason: '视觉没读出题干' };
  if (options.length < 2) return { ok: false, reason: `视觉只读到 ${options.length} 个选项` };
  if (!indices.length) return { ok: false, reason: '视觉没给出答案下标' };

  // 题型：优先用模型自己判的，只接受已知值
  const t = String(j.type || '').toLowerCase();
  const type = ['single', 'multi', 'judge', 'blank', 'short'].includes(t) ? t : null;
  // 模型判单选却给了多个下标 → 以 indices 为准改判多选（同 parseAnswerText 的规则）
  const finalType = type === 'multi' || indices.length > 1
    ? 'multi'
    : (type || 'single');

  return { ok: true, type: finalType, stem, options, indices };
}

/** 宽松 JSON 抽取：容忍 ```json 围栏、前后废话 */
function extractJsonLoose(raw) {
  const s = String(raw || '').trim();
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  let v = tryParse(s);
  if (v) return v;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { v = tryParse(fence[1].trim()); if (v) return v; }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    v = tryParse(s.slice(first, last + 1));
    if (v) return v;
  }
  return null;
}

/** 从 base64 头部嗅探图片类型；视觉通道要求 data URI 的 mime 正确 */
function detectImageMime(b64) {
  const head = b64.slice(0, 16);
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('iVBORw0KGgo')) return 'image/png';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  if (head.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

/**
 * 判断该不该走视觉：OCR 出来的东西「不足以当题干」时才走。
 *
 * 判据是「有效中文字数」而不是总长度 —— OCR 噪声（时间、电量、KB/s、
 * 上一题的残留）都是短碎片，加起来也不短，但有效信息为零。
 *
 * 重要：汉字数要在 **stem 和 ocrText 里取较大者**。只看 ocrText 会误判 ——
 * 典型场景是 a11y 已经读到了完整题干（文字题），但 OCR 服务没起/超时，
 * ocrText 为空，于是被判成「读不出题干」白烧一次图片 token。
 */
function shouldUseVision(q, ocrText) {
  if (process.env.ANSWER_VISION === '0') return false;
  if (!q || !q.stem) return true;              // 压根没读到题干

  const countHan = (s) => (String(s || '').match(/[\u4e00-\u9fa5]/g) || []).length;
  const hanStem = countHan(q.stem);
  const hanOcr = countHan(cleanOcrText(ocrText || ''));
  const han = Math.max(hanStem, hanOcr);
  const minHan = Number(process.env.ANSWER_VISION_MIN_HAN || 8);
  if (han < minHan) {
    console.log(`[vision] 有效汉字 ${han}（stem=${hanStem} ocr=${hanOcr}）< ${minHan}，改走视觉`);
    return true;
  }
  // 题干里出现这些词，基本可以确定是图形题，OCR 抄不出图
  const graphicHint = /如图|下图|上图|图中|图示|坐标|曲线|电路|结构式|几何|阴影|面积|周长|求值/;
  if (graphicHint.test(q.stem)) {
    console.log('[vision] 题干含图形提示词，改走视觉');
    return true;
  }
  return false;
}

/** OpenAI 兼容引擎 */
async function engineOpenAI(q) {
  const base = process.env.OPENAI_BASE;
  const key = process.env.OPENAI_KEY || 'EMPTY';
  const model = process.env.OPENAI_MODEL;
  if (!base || !model) throw new Error('OPENAI_BASE / OPENAI_MODEL 未配置');

  const res = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: buildMessages(q),
      max_tokens: 512,
      temperature: 0,
    }),
  });
  const j = await res.json();
  const content = j?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回为空: ' + JSON.stringify(j).slice(0, 200));
  return content.trim();
}

// 引擎选择
const engineReq = (process.env.ANSWER_ENGINE || 'auto').toLowerCase();
let engineMode = engineReq;
let engine;

if (engineReq === 'auto' || engineReq === 'qoder') {
  const avail = qoderAvailable('cn');
  if (avail.ok) {
    engine = engineQoder;
    engineMode = 'qoder';
  } else {
    engine = engineHeuristic;
    engineMode = 'heuristic';
    console.log(`[engine] ${engineReq} -> heuristic (${avail.reason})`);
  }
} else if (engineReq === 'openai') {
  engine = engineOpenAI;
} else if (engineReq === 'echo') {
  engine = engineEcho;
} else {
  engine = engineHeuristic;
  engineMode = 'heuristic';
}

/**
 * 这个引擎的回答能不能当真？
 *
 * heuristic 是纯占位（永远返回 index:0），echo 是回显 —— 两者都只用于验证管线。
 * 真机上它们跑出来的答案看起来和真答案一模一样（"A GET"），用户分辨不出来，
 * 但它跟题目毫无关系。更糟的是它会被写进缓存，从此每次命中都吐同一个错答案。
 *
 * 所以：占位引擎的回答不写缓存、并在浮层上标明「占位」。
 */
const isPlaceholderEngine = engineMode === 'heuristic' || engineMode === 'echo';

// ─────────────────────────── 核心流程 ───────────────────────────

/** 归一化作答参数 → 人可读 / 手机可解析的短字符串 */
function renderAnswer(ans, q) {
  if (!ans) return '';
  if (ans.text) return String(ans.text);

  const p = ans.params || ans;
  const opts = q.options || [];

  // 简答/论述：直接给正文
  if (p.text != null) return String(p.text);

  if (p.indicesJson) {
    let idx = [];
    try { idx = JSON.parse(p.indicesJson); } catch { /* ignore */ }
    if (!Array.isArray(idx)) idx = [];
    const optsLen = opts.length;
    // 只挡真正无意义的下标（负数/非整数/超过 Z）。
    // 不能因为 optsLen 小就丢 —— 选项解析不全是常态（WebView 把选项拆散、
    // 只滚动到一半、图片选项读不出），此时模型给的 3 很可能就是对的 D。
    const valid = idx.filter((i) => Number.isInteger(i) && i >= 0 && i < 26);
    if (valid.length !== idx.length) {
      console.error(`[render] indices 含非法下标 ${JSON.stringify(idx)}，已过滤`);
    }
    if (optsLen && valid.some((i) => i >= optsLen)) {
      console.error(`[render] indices ${JSON.stringify(valid)} 超出已解析选项 ${optsLen} 个，仍按字母输出`);
    }
    return valid.map((i) => {
      const L = String.fromCharCode(65 + i);
      const t = opts[i] ? ` ${opts[i].text}` : '';
      return L + t;
    }).join(' ; ') || '';
  }
  if (p.selectedIndex != null) {
    const i = Number(p.selectedIndex);
    // 负数 = 模型主动表示「这些选项里没有正确答案」。这通常意味着选项没读全
    // （WebView 把选项拆散、只滚动到一半），而不是模型胡说 —— 要告诉用户
    // 「选项没读全，请滚动后重按」，比丢一句「格式异常」有用得多。
    if (Number.isInteger(i) && i < 0) {
      console.error(`[render] selectedIndex=${i} 模型认为选项不含正确答案（选项 ${opts.length} 个）`);
      return '选项没读全，请滚动让四个选项都露出来后重按';
    }
    // 超过 Z 或非整数 = 真正的垃圾输出
    if (!Number.isInteger(i) || i >= 26) {
      console.error(`[render] selectedIndex=${p.selectedIndex} 非法，丢弃`);
      return '';
    }
    const L = String.fromCharCode(65 + i);
    const t = opts[i] ? ` ${opts[i].text}` : '';
    if (opts.length && i >= opts.length) {
      console.error(`[render] selectedIndex=${i} 超出已解析选项 ${opts.length} 个，只输出字母 ${L}`);
      return `${L}（选项未读全，请核对）`;
    }
    return `${L}${t}`;
  }
  if (Array.isArray(p.answers)) return p.answers.join(' | ');
  if (p.answersJson) {
    try { return JSON.parse(p.answersJson).join(' | '); } catch { return String(p.answersJson); }
  }
  return JSON.stringify(p);
}

/**
 * 把手机传来的 image 字段归一成「OCR 服务能吃的 base64」。
 *
 * 手机端有两条路送图：
 *   1. 截屏：直接给 base64（PNG）
 *   2. a11y 的 targetUrl：给 data:... 或 http(s)://...
 *      —— 实测 <img> 节点的 extras 里有 AccessibilityNodeInfo.targetUrl，
 *         跟网页端脚本读 DOM 的 img.src 是同一份信息，比截屏干净得多。
 *
 * @returns {Promise<string>} base64；拿不到返回空串
 */
async function imageToBase64(image) {
  if (!image) return '';
  const s = String(image).trim();

  // data:image/svg+xml;charset=utf-8,%3Csvg... 或 data:image/png;base64,xxx
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',');
    if (comma < 0) return '';
    const meta = s.slice(5, comma);          // image/svg+xml;charset=utf-8 或 image/png;base64
    const payload = s.slice(comma + 1);
    if (/;base64/i.test(meta)) return payload;
    // 非 base64 的 data URI：内容是 URL 编码的文本（SVG 常见）。
    // decodeURIComponent 遇到畸形 % 序列会抛 URIError，必须兜住——
    // 学习通若给出半截编码的 SVG，这里一抛整个 /answer 就 500。
    let decoded;
    try {
      decoded = decodeURIComponent(payload);
    } catch {
      console.warn('[image] bad percent-encoding in data URI, use raw payload');
      decoded = payload;
    }
    const mime = meta.split(';')[0] || 'image/svg+xml';
    console.log(`[image] data URI ${mime}, ${decoded.length} chars decoded`);
    // SVG 走文本提取，不需要 OCR
    if (mime.includes('svg')) return `__SVG__${decoded}`;
    return Buffer.from(decoded, 'binary').toString('base64');
  }

  if (/^https?:\/\//i.test(s)) {
    try {
      const r = await fetch(s, {
        signal: AbortSignal.timeout(Number(process.env.IMAGE_FETCH_TIMEOUT_MS || 15000)),
        // 学习通 CDN 对没有 Referer 的请求偶尔 403，带上站点 Referer 更像正常浏览器
        headers: {
          'user-agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
          referer: 'https://mooc1.chaoxing.com/',
        },
      });
      if (!r.ok) { console.warn(`[image] http ${r.status} ${s.slice(0, 80)}`); return ''; }
      // 体积上限：题干图正常几百 KB，超过 8MB 基本是拿错了地址（比如下载了整个 PDF）
      const MAX_BYTES = Number(process.env.IMAGE_MAX_BYTES || 8 * 1024 * 1024);
      const clen = Number(r.headers.get('content-length') || 0);
      if (clen > MAX_BYTES) {
        console.warn(`[image] too large: ${clen} bytes > ${MAX_BYTES}`);
        return '';
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_BYTES) {
        console.warn(`[image] too large after download: ${buf.length} bytes`);
        return '';
      }
      console.log(`[image] downloaded ${buf.length} bytes from ${s.slice(0, 80)}`);
      return buf.toString('base64');
    } catch (e) {
      console.warn(`[image] download failed: ${e.message}`);
      return '';
    }
  }

  // 已经是 base64
  return s;
}

/**
 * 从 SVG 源码里抽文字。
 *
 * 实测 mock 的图片题用 <text> 画题干，a11y 的 targetUrl 是 data:image/svg+xml
 * 形式的完整源码。这种情况根本不用 OCR —— 直接读 <text> 内容，
 * 零误差、零耗时，比截屏 + RapidOCR 强一个量级。
 * 真实学习通的题干图多为 PNG/JPEG，走不到这条分支。
 */
function textFromSvg(svg) {
  const out = [];
  // 非贪婪匹配 <text>...</text>；不用 .* 避免大 SVG 上的回溯爆炸。
  // [\s\S] 是因为 SVG 里 text 内容可能跨行。
  const re = /<text[^>]*>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = re.exec(svg)) !== null) {
    let t = m[1]
      // CDATA 里的 < > 是字面量（不是标签），必须先换成占位符，
      // 否则后面的剥标签正则会把它们连内容一起吃掉。
      // \u0001 = '<'  \u0002 = '>'  \u0000 = CDATA 边界标记
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) =>
        '\u0000' + inner.replace(/</g, '\u0001').replace(/>/g, '\u0002') + '\u0000')
      .replace(/<[^>]+>/g, '')                        // 去掉嵌套标签（tspan 等）
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => safeFromCode(parseInt(d, 10)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')      // &amp; 必须最后，否则 &amp;lt; 会变成 <
      .replace(/\u0001/g, '<').replace(/\u0002/g, '>')   // 还原 CDATA 里的字面尖括号
      .replace(/\u0000/g, '')                            // 去掉 CDATA 边界标记
      .trim();
    if (t) out.push(t);
  }
  if (out.length) console.log(`[image] svg text: ${out.length} lines, ${out.join(' ').length} chars`);
  return out.join('\n');
}

/** 数字实体转字符；越界码点（>0x10FFFF）直接丢掉，避免 String.fromCodePoint 抛 */
function safeFromCode(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}

/**
 * 图片题兜底：把图片交给 Python OCR 服务识别成文字。
 * @returns {Promise<string>} 识别出的整屏文字；失败返回空串
 */
async function ocrImage(image) {
  const r = await ocrImageEx(image);
  return r.text;
}

/**
 * 同 ocrImage，但把 OCR 的坐标框一起带回来。
 *
 * 坐标不是锦上添花：真实答题页里选项标签（"C."）常是小字号独立元素，
 * OCR 会整个漏掉，只留缩进的正文行。纯文本无法区分「这是 C 的第一行」
 * 还是「B 的折行」—— 坐标能（见 recoverOptionsByGeometry）。
 *
 * @returns {Promise<{text:string, boxes:Array}>} 失败时 {text:'', boxes:[]}
 */
/**
 * @param {string} image base64 / data URI / http URL
 */
async function ocrImageEx(image) {
  const base64 = await imageToBase64(image);
  if (!base64) return { text: '', boxes: [] };

  // SVG 直接抽 <text>，不用 OCR
  if (base64.startsWith('__SVG__')) return { text: textFromSvg(base64.slice(7)), boxes: [] };

  if (!OCR_URL) return { text: '', boxes: [] };
  try {
    const res = await fetch(OCR_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: base64 }),
      signal: AbortSignal.timeout(Number(process.env.OCR_TIMEOUT_MS || 20000)),
    });
    const j = await res.json();
    if (!j.ok || !j.text) {
      console.warn(`[ocr] failed: ${j.error || 'empty'}`);
      return { text: '', boxes: [] };
    }
    const boxes = Array.isArray(j.boxes) ? j.boxes : [];
    console.log(`[ocr] ${j.count} lines, ${j.text.length} chars, ${boxes.length} boxes`);
    return { text: j.text, boxes };
  } catch (e) {
    console.warn(`[ocr] unavailable: ${e.message}`);
    return { text: '', boxes: [] };
  }
}

/**
 * OCR 文本预处理：去掉状态栏/标题栏/toast 碎片，把粘连的选项字母拆开。
 *
 * 实测一张 1080x2400 的图片题截图，RapidOCR 输出长这样：
 *   3.08 / 9:30 / (77 / KB/s / Exam Mock / 个报文丢失会使… / B4.避拥塞控制…
 * 前面几条是状态栏和标题栏，中间是上一题叠层的残留，最后才是真题干。
 * 不清洗会把噪声当题干喂给模型。
 */
function cleanOcrText(ocrText) {
  const lines = String(ocrText || '').split('\n');
  const out = [];
  for (let line of lines) {
    let t = line.trim();
    if (!t) continue;
    if (isOcrUiNoise(t)) continue;
    // 行首可能粘着电量/时间碎片："l78 IP 协议工作在哪一层?" → "IP 协议工作在哪一层?"
    t = stripLeadingUiCrumb(t);
    if (!t) continue;
    // OCR 常把选项字母和正文粘在一起："B4.避拥塞控制导致速率骤降。"
    // 拆成 "B. 4.避拥塞控制…" 交给 matchOption 处理
    const glued = t.match(/^([A-J])(\d{1,2}\s*[.、．)）].*)$/);
    if (glued) t = glued[1] + '. ' + glued[2];
    out.push(t);
  }
  return out.join('\n');
}

/**
 * 一条 a11y 文本 → 答案
 * @param {string} text 整屏 a11y 文本（OCR 结果会被追加到后面）
 * @param {object|null} preStructured 手机端区域抽取结果
 * @param {string} ocrText OCR 识别出的文字（无图题时为空串）
 * @param {boolean} force 主动识别（Vol- 长按），跳过「是不是答题页」闸门
 * @param {string} imageForVision 原图（base64/data URI/http URL），供视觉模型兜底
 * @param {Array} ocrBoxes OCR 的坐标框（可为空）。有坐标时 parseScreen 会用它
 *   做几何恢复：把「标签被 OCR 漏识别」的选项补回来（见 recoverOptionsByGeometry）
 * @param {boolean} fast 快档（Vol+ ×2）：换快模型 + 浅思考，牺牲推理换速度
 */
async function solve(text, preStructured, ocrText = '', force = false, imageForVision = '', ocrBoxes = null, fast = false) {
  // 手机端 a11y 区域抽取优先；没有或解析失败才退回整屏文本解析
  let structured;
  const structStem = String(preStructured?.stem || '').trim();
  const structOpts = (preStructured?.options || []).length;

  // 图片题：手机端抽到了选项和题型，但题干为空 —— 题干是张图。
  // 这时 structured 是个「有选项没题干」的空壳，必须让 OCR 文本接管题干，
  // 否则模型只能拿选项硬猜（实测「IP 在哪一层」靠四个层名猜出 B，纯属运气）。
  const imageStem = !!preStructured && !structStem && structOpts >= 2 && !!preStructured.typeLabel;

  if (imageStem && ocrText) {
    // 用 OCR 文本重新解析，选项以手机端抽到的为准（OCR 可能把选项读错）
    const cleaned = cleanOcrText(ocrText);
    console.log(`[image-question] OCR 清洗后 ${cleaned.length} chars:\n${cleaned.slice(0, 300)}`);
    structured = parseScreen(cleaned, { boxes: ocrBoxes });
    if (structured.ok) {
      // 手机端传的是字符串数组 ["A. 传输层", ...]，而 renderAnswer 要的是
      // [{key:'A', text:'传输层'}, ...]。直接赋值会让 opts[i].text 取到
      // undefined，叠层上只剩一个孤零零的 "C undefined"（实测）。
      structured.primary.options = preStructured.options.map((s, i) => {
        const raw = String(s || '').trim();
        const m = raw.match(/^([A-J])\s*[.、．)）:：]\s*(.*)$/);
        return m
          ? { key: m[1], text: m[2].trim() }
          : { key: String.fromCharCode(65 + i), text: raw };
      });
      structured.primary.typeLabel = preStructured.typeLabel;
      structured.primary.type = detectType(structured.primary);
      console.log(`[image-question] OCR 接管题干: "${String(structured.primary.stem || '').slice(0, 50)}" `
        + `opts=${structured.primary.options.length}（沿用手机端）`);
    } else {
      console.log('[image-question] OCR 文本也没解析出题干，退回选项猜测');
    }
  } else if (preStructured && (structStem || structOpts)) {
    structured = parseStructured(preStructured);
    console.log(`[structured] stem="${String(structured.primary?.stem || '').slice(0, 40)}" `
      + `opts=${structured.primary?.options?.length || 0} type=${structured.primary?.type || '-'}`);
  } else {
    // 整屏文本解析。OCR 来的文本带上坐标，让 parseScreen 先做几何恢复
    // （补回被 OCR 漏掉的选项标签）；纯 a11y 文本没有坐标，行为不变。
    structured = parseScreen(text, { boxes: ocrBoxes });
  }

  if (!structured.ok) {
    // 主动识别（force）：用户按了 Vol- 长按，明确说「读这一屏」。
    // 这时不能因为「没有 交卷/下一题 文案」「不像标准题型」就拒答 ——
    // 陌生 App（雨课堂/问卷星/任意题库）的判据必然不过，拒答等于功能不存在。
    // 处理：把整屏文本当作一道题硬送模型，让模型自己判断这是什么。
    // 走的是同一条 缓存→模型→归一化 流水线，只是把闸门拆掉。
    const raw = String(text || '').trim();
    const ocr = String(ocrText || '').trim();
    // 判据不能用 raw 单独看：纯图片页 / Canvas 自绘页的 a11y 文本是空的，
    // 题干全在像素里（OCR 出来的 ocrText）。只看 raw 会让 force 在这类页面上
    // 完全失效 —— 用户长按了，服务端却回 none，浮层显示「未识别到题目」。
    // 所以 raw 和 ocr 任一够长就放行，stem 优先用 OCR（那才是题干）。
    const forceBody = raw.length >= 4 ? raw : (ocr.length >= 4 ? ocr : '');
    if (force && forceBody) {
      console.log(`[force] gate bypassed, raw=${raw.length} ocr=${ocr.length} chars`);
      const opts = (preStructured?.options || []).map((s, i) => {
        const str = String(s || '').trim();
        const m = str.match(/^([A-J])\s*[.、．)）:：]\s*(.*)$/);
        return m ? { key: m[1], text: m[2].trim() }
                 : { key: String.fromCharCode(65 + i), text: str };
      });
      structured = {
        ...structured,
        ok: true,
        examPage: true,
        forced: true,
        primary: {
          stem: structStem || (ocr.length >= 4 ? ocr : raw),
          options: opts,
          type: 'unknown',
          typeLabel: preStructured?.typeLabel || '',
          blanks: countBlanks(forceBody),
        },
        screenHash: structured.screenHash || '',
        stableKey: '',
      };
    }
  }

  if (!structured.ok) {
    // 非题目页（登录页/首页/课程列表/消息页）：不调模型、不入缓存、不糊叠层。
    // 手机端收到 source=none 会显示"未识别到题目"并保持上一题答案不变。
    const r = structured.rejected;
    // force 却什么都没拿到 —— 用户明确长按了，得说清原因，不能让浮层停在
    // 「正在识别当前页面…」。典型场景：纯图片页 + OCR 服务没配/挂了。
    if (force) {
      console.log(`[none] force requested but nothing usable`
        + ` raw=${String(text || '').trim().length}`
        + ` ocr=${String(ocrText || '').trim().length}`);
      return {
        answer: ocrText ? '这一屏没读到题干，换一题试试' : '这一屏没有文字，图片题需要 OCR 服务（未配置）',
        source: 'none',
        question: null,
        structured,
      };
    }
    console.log(`[none] not a question page examPage=${structured.examPage}`
      + (r ? ` candidate="${String(r.stem || '').slice(0, 40)}"` : ' (empty after clean)'));
    return {
      answer: '未识别到题目（当前页面不是答题页）',
      source: 'none',
      question: null,
      structured,
    };
  }

  const q = structured.primary;

  // 选项不全时不要问模型。
  //
  // 真机实测（m.topnews.cn 微信 WebView）：C 选项的「C.」前缀被 WebView 拆成
  // 独立节点或被 CSS 隐藏，4 个选项只读到 2 个。这时模型的表现是：
  //   - 有时回 index:-1（认得出选项里没有正确答案）→ 白等 30s
  //   - 有时硬凑一个 index:0（"A. 是在校生，不享有选举权"）→ 答错
  //   - 耗时从正常的 1s 涨到 50s+，因为它在那反复权衡两个都不对的选项
  // 三种结果都是浪费用户时间。唯一有用的输出是让用户把选项露全。
  //
  // 阈值取 3：客观题最少 2 个选项（判断题），但判断题走 judge 分支不走这里；
  // 走 single/multi 的题至少 3 个选项才算读全。
  const optCount = (q.options || []).length;
  if ((q.type === 'single' || q.type === 'multi') && optCount < 3) {
    console.error(`[guard] ${q.type} 题只有 ${optCount} 个选项，拒绝作答`);
    return {
      answer: optCount === 0
        ? '没读到选项，请滚动让选项露出来后重按'
        : `只读到 ${optCount} 个选项（应有 4 个），请滚动让选项露全后重按`,
      source: 'none',
      question: q,
      structured,
    };
  }

  // 1. 缓存
  if (cache) {
    const hit = cache.get(q);
    if (hit) {
      console.log(`[cache HIT] ${hit.qkey} hits=${hit.hits} type=${q.type}`);
      return {
        answer: renderAnswer(hit.answer, q),
        source: 'cache',
        question: q,
        structured,
        cached: hit,
      };
    }
  }

  // 2. 模型
  let raw;
  // 图片题分流：OCR 读不出题干（图形题/结构式/OCR 挂了）时，直接把原图交给视觉模型。
  // 必须放在缓存之后 —— 同一题第二次长按时命中缓存，不必再烧一次图片 token。
  const useVision = !!imageForVision && shouldUseVision(q, ocrText);

  /**
   * 调一次引擎，网络类错误重试一次。
   *
   * 超时**不重试** —— 30s 超时 + 重试 = 60s，用户早就走了。
   * 只有「连接立刻失败」（ECONNREFUSED / fetch failed，毫秒级）才值得重试，
   * 那种情况重试一次是几十毫秒的事。超时说明网络慢，重试只会更慢。
   */
  const callEngine = async (fn, label) => {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/超时|timeout/i.test(msg)) throw e;
      const retriable = /ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|ENOTFOUND/i.test(msg);
      if (!retriable) throw e;
      console.error(`[engine] ${label} 第1次失败（${msg}），立刻重试`);
      return await fn();
    }
  };

  try {
    if (useVision) {
      console.log(`[vision] 走视觉模型 model=${process.env.QODER_VL_MODEL || process.env.QODER_MODEL || 'dfmodel'}`);
      raw = await callEngine(() => engineQoderVision(q, imageForVision), 'vision');
    } else if (fast && engineMode === 'qoder') {
      console.log(`[fast] 快档 model=${process.env.QODER_FAST_MODEL || 'mmodel'}`
        + ` effort=${process.env.QODER_FAST_EFFORT || 'minimal'}`);
      raw = await callEngine(() => engineQoderFast(q), 'fast');
    } else {
      raw = await callEngine(() => engine(q), engineMode);
    }
  } catch (e) {
    console.error(`[engine] ${useVision ? 'vision' : engineMode} failed: ${e.message}`);
    // 视觉失败时退回文本引擎，别让整题直接报错
    if (useVision) {
      try {
        console.log('[vision] 失败，退回文本引擎');
        raw = await callEngine(() => engine(q), engineMode);
      } catch (e2) {
        console.error(`[engine] ${engineMode} 也失败: ${e2.message}`);
        return { answer: '引擎错误: ' + e.message, source: 'error', question: q, structured };
      }
    } else if (fast) {
      // 快档失败不能直接报错 —— 快档是"想更快"，不该比正常档更容易失败。
      // 退回默认档：慢一点但能出答案，比让用户看到「引擎错误」好。
      try {
        console.log('[fast] 快档失败，退回默认引擎');
        raw = await callEngine(() => engine(q), engineMode);
      } catch (e2) {
        console.error(`[engine] ${engineMode} 也失败: ${e2.message}`);
        return { answer: '引擎错误: ' + e.message, source: 'error', question: q, structured };
      }
    } else {
      return { answer: '引擎错误: ' + e.message, source: 'error', question: q, structured };
    }
  }

  // 3. 归一化
  const normalized = parseAnswerText(raw, q);
  // 模型自我纠正了题型（单选位置上返回了多个下标 → 判为多选）：
  // 把 q.type 一起改掉，否则下游 renderAnswer / 缓存 / 浮层标签
  // 还按单选显示，用户看到「单选」却有两个答案，会以为程序坏了。
  if (normalized.typeCorrected) {
    console.log(`[type] 模型纠正题型 ${normalized.typeCorrected}（raw=${String(raw).slice(0, 40)}）`);
    q.type = normalized.type;
  }
  const rendered = renderAnswer(normalized, q);

  // 渲染出空串 = 模型给了越界下标之类无法映射的结果。别把空答案交给手机端
  // （浮层会显示空白，用户以为卡住了），明确报出来。
  if (!rendered) {
    console.error(`[render] 空答案 raw="${String(raw).slice(0, 120)}" type=${q.type} opts=${(q.options || []).length}`);
    return {
      answer: '模型回答格式异常，请再按一次',
      source: 'error',
      question: q,
      structured,
      normalized,
    };
  }

  // 4. 回写缓存
  // 注意：图片题（stem 为空）不写缓存 —— normalizeForHash 返回 null，
  // cache.put 直接跳过。否则所有选项相同的图片题会共用一个键、互相污染。
  // source 用实际出答案的通道，不能照抄 engineMode：视觉答案记成 heuristic
  // 会让 /stats 的来源分布失真。
  //
  // 占位引擎（heuristic/echo）的答案一律不写缓存。它们永远返回 index:0，
  // 一旦进缓存就变成「这题的标准答案」，之后每次命中都吐同一个错答案，
  // 而且命中数越高越像「验证过的」，越不可疑。实测踩到过：一条
  // multi 题被 heuristic 写成 [0]，hits=43。
  if (cache && normalized.type !== 'short' && !isPlaceholderEngine) {
    const src = useVision ? 'vision' : ((engineMode === 'openai' || engineMode === 'qoder') ? 'ai' : engineMode);
    const wrote = cache.put(q, normalized, src);
    if (!wrote) console.log('[cache] 空题干，跳过缓存写入');
  } else if (isPlaceholderEngine) {
    console.log('[cache] 占位引擎，跳过缓存写入');
  }

  const srcTag = useVision ? 'vision' : engineMode;
  // 占位引擎要在浮层上明确标出来 —— 否则用户以为那是真答案。
  const shown = isPlaceholderEngine ? `${rendered}（占位，非真实作答）` : rendered;
  console.log(`[${srcTag}] ${q.type} q="${String(q.stem).slice(0, 40)}" raw="${raw.slice(0, 60)}" => ${shown}`);
  return { answer: shown, source: srcTag, question: q, structured, normalized };
}

// ─────────────────────────── HTTP ───────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, obj, code = 200) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(s);
}

// ─────────────────────────── 推送通道（电脑 → 手机）───────────────────────────
//
// 手机端不监听任何端口（App 里没有 ServerSocket），所以电脑无法主动连手机。
// 要「电脑推消息给手机」只能反过来：手机来取。这里做一个队列 + 长轮询：
//
//   POST /push          电脑把消息放进队列（body: {text, kind})
//   GET  /pull?since=N  手机来取（since=上次拿到的序号，长轮询最多挂 25s）
//   GET  /push          手机浏览器直接打开的接收页（SSE 都不用，定时轮询即可）
//
// 为什么用队列而不是直接长轮询单条：长按/多题连发时消息会叠，队列保证不丢。

const PUSH_MAX = 200;
const PUSH_WAIT_MS = 25000;
let pushSeq = 0;
const pushQueue = [];        // {seq, text, kind, at}
const pushWaiters = [];      // {res, since, timer}

function pushAdd(text, kind = 'info') {
  pushSeq += 1;
  const item = { seq: pushSeq, text: String(text ?? ''), kind: String(kind || 'info'), at: Date.now() };
  pushQueue.push(item);
  if (pushQueue.length > PUSH_MAX) pushQueue.splice(0, pushQueue.length - PUSH_MAX);
  // 叫醒所有挂着等消息的长轮询
  for (const w of pushWaiters.slice()) {
    const got = pushQueue.filter((m) => m.seq > w.since);
    if (got.length) pushFlush(w, got);
  }
  return item;
}

function pushFlush(waiter, items) {
  const i = pushWaiters.indexOf(waiter);
  if (i < 0) return;                    // 已经被超时清掉了
  pushWaiters.splice(i, 1);
  if (waiter.timer) clearTimeout(waiter.timer);
  try {
    json(waiter.res, { ok: true, seq: pushSeq, items });
  } catch { /* 手机已经断开，忽略 */ }
}

/** 取出 since 之后的消息；没有就挂最多 PUSH_WAIT_MS */
function pushWait(res, since) {
  const items = pushQueue.filter((m) => m.seq > since);
  if (items.length) {
    json(res, { ok: true, seq: pushSeq, items });
    return;
  }
  const waiter = { res, since, timer: null };
  pushWaiters.push(waiter);
  waiter.timer = setTimeout(() => {
    // 超时返回空数组 —— 手机端拿到空数组就立刻再发一次，形成长轮询
    const i = pushWaiters.indexOf(waiter);
    if (i >= 0) pushWaiters.splice(i, 1);
    try { json(res, { ok: true, seq: pushSeq, items: [] }); } catch { /* ignore */ }
  }, PUSH_WAIT_MS);
  // 手机中途断开时别让 waiter 一直挂着
  res.on('close', () => {
    const i = pushWaiters.indexOf(waiter);
    if (i >= 0) {
      pushWaiters.splice(i, 1);
      if (waiter.timer) clearTimeout(waiter.timer);
    }
  });
}

/** 手机浏览器直接打开的接收页 */
const PUSH_PAGE = `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>电脑推送</title><style>
:root{color-scheme:dark}
body{margin:0;padding:16px;background:#0d1117;color:#e6edf3;
  font:16px/1.6 -apple-system,"Noto Sans SC",sans-serif}
h1{font-size:16px;font-weight:600;margin:0 0 4px;color:#8b949e}
#dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f85149;margin-right:6px}
#dot.on{background:#3fb950}
#list{margin-top:14px;display:flex;flex-direction:column;gap:10px}
.item{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px 14px;
  word-break:break-word;white-space:pre-wrap}
.item .meta{font-size:12px;color:#8b949e;margin-bottom:6px}
.item.ok{border-color:#238636}
.item.err{border-color:#da3633}
.item.answer{font-size:20px;font-weight:600;color:#58a6ff}
</style></head><body>
<h1><span id="dot"></span>电脑推送 · <span id="stat">连接中…</span></h1>
<div id="list"></div>
<script>
let since = 0;
const list = document.getElementById('list');
const dot = document.getElementById('dot');
const stat = document.getElementById('stat');
function add(m){
  const d = document.createElement('div');
  d.className = 'item ' + (m.kind === 'answer' ? 'answer' : m.kind === 'error' ? 'err' : m.kind === 'ok' ? 'ok' : '');
  const t = new Date(m.at).toLocaleTimeString('zh-CN');
  d.innerHTML = '<div class="meta">' + t + ' · #' + m.seq + '</div>';
  const body = document.createElement('div');
  body.textContent = m.text;
  d.appendChild(body);
  list.insertBefore(d, list.firstChild);
  while (list.children.length > 50) list.removeChild(list.lastChild);
  if (navigator.vibrate) navigator.vibrate(60);
}
async function tick(){
  try{
    const r = await fetch('/pull?since=' + since, {cache:'no-store'});
    const j = await r.json();
    dot.className = 'dot on';
    stat.textContent = '已连接';
    if (j.items && j.items.length){
      for (const m of j.items) add(m);
      since = j.seq;
    } else if (j.seq != null && j.seq > since) {
      since = j.seq;
    }
  }catch(e){
    dot.className = 'dot';
    stat.textContent = '断开，重试中';
    await new Promise(r => setTimeout(r, 1500));
  }
  tick();
}
tick();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, {
        ok: true,
        engine: engineMode,
        requested: engineReq,
        vision: {
          enabled: process.env.ANSWER_VISION !== '0',
          model: process.env.QODER_VL_MODEL || process.env.QODER_MODEL || 'dfmodel',
          minHan: Number(process.env.ANSWER_VISION_MIN_HAN || 8),
        },
        ocr: OCR_URL || 'disabled',
        cache: cache ? cache.stats() : null,
        uptime: Math.round(process.uptime()),
      });
    }

    if (req.method === 'GET' && url.pathname === '/stats') {
      return json(res, cache ? cache.stats() : { error: 'cache disabled' });
    }

    if (req.method === 'GET' && url.pathname === '/recent') {
      if (!cache) return json(res, { error: 'cache disabled' }, 503);
      const limit = Number(url.searchParams.get('limit') || 20);
      return json(res, { items: cache.recent(limit) });
    }

    if (req.method === 'GET' && url.pathname === '/models') {
      try {
        const list = await qoderModels('cn');
        return json(res, { engine: 'qoder', count: list.length, models: list });
      } catch (e) {
        return json(res, { error: e.message }, 503);
      }
    }

    if (req.method === 'POST' && url.pathname === '/cache/clear') {
      if (!cache) return json(res, { error: 'cache disabled' }, 503);
      cache.clear();
      return json(res, { ok: true, cleared: true });
    }

    // ── 推送通道：电脑 → 手机 ──
    if (url.pathname === '/push' && req.method === 'POST') {
      const body = await readBody(req);
      let text = '';
      let kind = 'info';
      try {
        const j = JSON.parse(body);
        text = j.text != null ? String(j.text) : String(body);
        kind = j.kind || 'info';
      } catch { text = body; }
      const item = pushAdd(text, kind);
      console.log(`[push] #${item.seq} kind=${item.kind} ${String(text).slice(0, 60)}`);
      return json(res, { ok: true, ...item });
    }
    if (url.pathname === '/push' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(PUSH_PAGE);
    }
    if (url.pathname === '/pull' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0) || 0;
      return pushWait(res, since);
    }

    if (req.method === 'POST' && url.pathname === '/parse') {
      const body = await readBody(req);
      let text = '';
      try { text = JSON.parse(body).question || ''; } catch { text = body; }
      return json(res, parseScreen(text));
    }

    if (req.method === 'POST' && (url.pathname === '/answer' || url.pathname === '/')) {
      const body = await readBody(req);
      let text = '';
      let image = '';
      let structured = null;
      let force = false;
      let fast = false;
      let reqVision = '';
      try {
        const j = JSON.parse(body);
        text = j.question || '';
        image = j.image || '';
        structured = j.structured || null;
        // 主动识别（手机端 Vol- 长按 2s）：用户已明确说「读这一屏」，
        // 跳过「这屏是不是答题页」的闸门。非学习通场景没有 交卷/下一题 文案，
        // 不跳过就永远返回 source=none。
        force = j.force === true;
        // 快档（手机端 Vol+ ×2）：换快模型 + 浅思考。
        // 只在 qoder 通道生效；heuristic/openai/echo 没有思考这个概念，忽略。
        fast = j.fast === true;
        // 视觉模式（手机端可按请求覆盖环境变量）：'' | 'first' | 'only'
        reqVision = typeof j.vision === 'string' ? j.vision : '';
      } catch { text = body; }
      const t0 = Date.now();

      // ── 视觉主路径（VISION_MODE=first）──
      //
      // 整屏截图直接交给模型，由它自己找题目、选项、题型 —— 不做 OCR，
      // 不做几何恢复。这是「AI 自己知道题目在哪」的方案。
      //
      // 为什么值得做成主路径：OCR + 几何恢复这条路一直在跟版式搏斗，
      // 每遇到一种新排版就踩一个坑（第 7/10/5 题各一个），而且修 A 会踩坏 B。
      // 实测三道踩过坑的题，纯视觉全部一次答对，题干还更完整。
      //
      // 但默认仍是 off —— 视觉一张 330KB 图要 5~11s，比 OCR 贵也慢；
      // OCR 在标准版式上 7s 就能出结果。用 AIR 的按钮决定：
      //   · off    （默认）OCR 优先，OCR 判不出才走视觉（原行为）
      //   · first  视觉优先，失败才退回 OCR 路径
      //   · only   只走视觉，不碰 OCR
      //
      // 手机端可以按请求传 vision:"first"/"only" 覆盖，方便对比实测。
      const visionMode = (reqVision || process.env.VISION_MODE || 'off').toLowerCase();
      if (image && visionMode !== 'off' && (engineMode === 'qoder' || engineMode === 'auto')) {
        try {
          console.log(`[vision-first] 整屏交给模型 model=${process.env.QODER_VL_MODEL || process.env.QODER_MODEL || 'dfmodel'}`);
          const vraw = await engineQoderVisionFull(image);
          const v = parseVisionFull(vraw);
          if (v.ok) {
            const vq = {
              stem: v.stem,
              options: v.options.map((t, i) => ({ key: String.fromCharCode(65 + i), text: t })),
              type: v.type,
              typeLabel: '',
            };
            const vnorm = {
              mode: 'json',
              type: v.type,
              params: v.indices.length > 1
                ? { indicesJson: JSON.stringify(v.indices) }
                : { selectedIndex: v.indices[0] },
            };
            const vanswer = renderAnswer(vnorm, vq);
            if (vanswer) {
              console.log(`[vision-first] ${Date.now() - t0}ms type=${v.type} `
                + `opts=${vq.options.length} => ${vanswer.slice(0, 60)}`);
              const vstable = `${v.stem}|${vq.options.map((o) => o.text).join('|')}`;
              const vhash = crypto.createHash('md5').update(vstable).digest('hex');
              pushAdd(
                `${vanswer}\n\n[vision · ${v.type} · ${Date.now() - t0}ms]`,
                'answer',
              );
              return json(res, {
                answer: vanswer,
                source: 'vision',
                type: v.type,
                question: vq,
                screenHash: vhash,
                stableKey: vstable,
                ms: Date.now() - t0,
              });
            }
            console.warn('[vision-first] 渲染空答案，退回 OCR 路径');
          } else {
            console.warn(`[vision-first] 不可用：${v.reason}，退回 OCR 路径`);
          }
        } catch (e) {
          console.warn(`[vision-first] 失败：${e.message}，退回 OCR 路径`);
        }
        // only 模式不退回 OCR —— 用户明确要求只走视觉，退回会让人分不清
        // 到底是哪条路径出的结果。直接报错，信息更明确。
        if (visionMode === 'only') {
          return json(res, {
            answer: '视觉识别失败（VISION_MODE=only，未退回 OCR）',
            source: 'error',
            type: null,
            question: null,
            ms: Date.now() - t0,
          });
        }
      }

      // 图片题兜底：a11y 没读到题干但手机传了截图 → OCR 补文字
      let ocrText = '';
      let ocrBoxes = null;
      if (image) {
        const o = await ocrImageEx(image);
        ocrText = o.text;
        ocrBoxes = o.boxes;
        if (ocrText) text = text ? text + '\n' + ocrText : ocrText;
      }
      // 原图同时留给视觉模型：OCR 读不出题干时直接让模型看图
      const r = await solve(text, structured, ocrText, force, image || '', ocrBoxes, fast);
      const from = req.socket.remoteAddress || '-';
      console.log(`[answer] ${Date.now() - t0}ms source=${r.source} type=${r.question?.type || '-'}`
        + ` force=${force} fast=${fast} from=${from}`);
      // 顺手推一条到推送队列：手机端如果用浏览器看着推送页，能看到同一份答案。
      // 不推 source=none 的空结果（那是「这屏不是答题页」，没信息量）。
      if (r.source !== 'none') {
        pushAdd(
          `${r.answer}\n\n[${r.source} · ${r.question?.type || '-'} · ${Date.now() - t0}ms]`,
          r.source === 'error' ? 'error' : 'answer',
        );
      }
      return json(res, {
        answer: r.answer,
        source: r.source,
        type: r.question?.type || null,
        question: r.question,
        screenHash: r.structured.screenHash,
        // 稳定题目标识：题干+选项哈希，滚动/可见节点变化不影响它。
        // 手机端优先用它去重，避免拖动长题干时被误判成换题。
        stableKey: r.structured.stableKey || '',
        ms: Date.now() - t0,
      });
    }

    json(res, { error: 'not found' }, 404);
  } catch (e) {
    console.error('[http] ' + e.message);
    json(res, { error: e.message }, 500);
  }
});

// 测试钩子：单测 import 这个模块时不要真起服务（会占端口、进程也不退出）。
// 用 ANSWER_NO_LISTEN=1 跳过 listen，只导出纯函数。
export const __test_imageToBase64 = imageToBase64;
export const __test_textFromSvg = textFromSvg;
export const __test_cleanOcrText = cleanOcrText;
export const __test_shouldUseVision = shouldUseVision;
export const __test_detectImageMime = detectImageMime;
export const __test_renderAnswer = renderAnswer;
export const __test_parseVisionFull = parseVisionFull;
export const __test_extractJsonLoose = extractJsonLoose;

if (process.env.ANSWER_NO_LISTEN !== '1') {
  server.listen(PORT, BIND, () => {
    console.log(`Answer server v2.1 on ${BIND}:${PORT}`);
    // 监听地址来源要打出来：手机连不上时第一眼就能判断是 bind 配错还是防火墙。
    const bindSrc = process.env.ANSWER_BIND ? 'env ANSWER_BIND'
      : (FILE_CONFIG.bind ? 'config.json' : 'default');
    if (BIND === '127.0.0.1' || BIND === 'localhost') {
      console.log(`  bind   = ${BIND} (${bindSrc}) —— 只接受本机连接，手机连不上属正常`);
    } else {
      console.log(`  bind   = ${BIND} (${bindSrc})`);
    }
    console.log(`  engine = ${engineMode}${engineReq !== engineMode ? ` (requested ${engineReq})` : ''}`);
    console.log(`  cache  = ${cache ? cache.path : 'disabled'}`);
  });
}

// 优雅退出，保证 sqlite 句柄释放
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[${sig}] shutting down`);
    try { server.close(); } catch { /* ignore */ }
    try { cache?.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}