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
import { parseScreen, parseStructured, parseAnswerText, countBlanks, detectType,
         isOcrUiNoise, stripLeadingUiCrumb } from './answer-core.mjs';
import { AnswerCache } from './answer-cache.mjs';
import { qoderAvailable, qoderChat, qoderModels } from './engine-qoder.mjs';

const PORT = Number(process.env.ANSWER_PORT || 18888);
// 监听地址：默认 127.0.0.1（USB reverse）。无线场景设 0.0.0.0 接受局域网/Tailscale 连接。
const BIND = process.env.ANSWER_BIND || '127.0.0.1';
const CACHE_PATH = process.env.ANSWER_CACHE === '' ? ':memory:'
  : (process.env.ANSWER_CACHE || './answer-cache.db');
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

  return [
    {
      role: 'system',
      content: `你是答题助手，回答中国高校在线课程的客观题。\n${typeHint}\n只输出 JSON，不要解释、不要复述题目、不要 markdown 代码块。`,
    },
    { role: 'user', content: optText ? `${q.stem}\n\n${optText}` : String(q.stem || '') },
  ];
}

/** qoder 引擎：走 dsh-connect-qoder 的 cosy 通道 */
async function engineQoder(q) {
  return qoderChat(buildMessages(q), {
    model: process.env.QODER_MODEL || 'dfmodel',
    timeoutMs: Number(process.env.ANSWER_TIMEOUT_MS || 90000),
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
    const valid = idx.filter((i) => Number.isInteger(i) && i >= 0 && (optsLen === 0 || i < optsLen));
    if (valid.length !== idx.length) {
      console.error(`[render] indices 越界 ${JSON.stringify(idx)}（选项 ${optsLen} 个），已过滤`);
    }
    return valid.map((i) => {
      const L = String.fromCharCode(65 + i);
      const t = opts[i] ? ` ${opts[i].text}` : '';
      return L + t;
    }).join(' ; ') || '';
  }
  if (p.selectedIndex != null) {
    const i = Number(p.selectedIndex);
    // 越界保护：视觉模型看图数选项时可能给出超出范围的下标，
    // String.fromCharCode(65+5) 会渲染成 "F" —— 4 个选项的题出现 F 是明显错误。
    if (!Number.isInteger(i) || i < 0 || (opts.length > 0 && i >= opts.length)) {
      console.error(`[render] selectedIndex=${p.selectedIndex} 越界（选项 ${opts.length} 个），丢弃`);
      return '';
    }
    const L = String.fromCharCode(65 + i);
    const t = opts[i] ? ` ${opts[i].text}` : '';
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
  const base64 = await imageToBase64(image);
  if (!base64) return '';

  // SVG 直接抽 <text>，不用 OCR
  if (base64.startsWith('__SVG__')) return textFromSvg(base64.slice(7));

  if (!OCR_URL) return '';
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
      return '';
    }
    console.log(`[ocr] ${j.count} lines, ${j.text.length} chars`);
    return j.text;
  } catch (e) {
    console.warn(`[ocr] unavailable: ${e.message}`);
    return '';
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
 */
async function solve(text, preStructured, ocrText = '', force = false, imageForVision = '') {
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
    structured = parseScreen(cleaned);
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
    structured = parseScreen(text);
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
  try {
    if (useVision) {
      console.log(`[vision] 走视觉模型 model=${process.env.QODER_VL_MODEL || process.env.QODER_MODEL || 'dfmodel'}`);
      raw = await engineQoderVision(q, imageForVision);
    } else {
      raw = await engine(q);
    }
  } catch (e) {
    console.error(`[engine] ${useVision ? 'vision' : engineMode} failed: ${e.message}`);
    // 视觉失败时退回文本引擎，别让整题直接报错
    if (useVision) {
      try {
        console.log('[vision] 失败，退回文本引擎');
        raw = await engine(q);
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
  if (cache && normalized.type !== 'short') {
    const src = useVision ? 'vision' : ((engineMode === 'openai' || engineMode === 'qoder') ? 'ai' : engineMode);
    const wrote = cache.put(q, normalized, src);
    if (!wrote) console.log('[cache] 空题干，跳过缓存写入');
  }

  const srcTag = useVision ? 'vision' : engineMode;
  console.log(`[${srcTag}] ${q.type} q="${String(q.stem).slice(0, 40)}" raw="${raw.slice(0, 60)}" => ${rendered}`);
  return { answer: rendered, source: srcTag, question: q, structured, normalized };
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
      try {
        const j = JSON.parse(body);
        text = j.question || '';
        image = j.image || '';
        structured = j.structured || null;
        // 主动识别（手机端 Vol- 长按 2s）：用户已明确说「读这一屏」，
        // 跳过「这屏是不是答题页」的闸门。非学习通场景没有 交卷/下一题 文案，
        // 不跳过就永远返回 source=none。
        force = j.force === true;
      } catch { text = body; }
      const t0 = Date.now();
      // 图片题兜底：a11y 没读到题干但手机传了截图 → OCR 补文字
      let ocrText = '';
      if (image) {
        ocrText = await ocrImage(image);
        if (ocrText) text = text ? text + '\n' + ocrText : ocrText;
      }
      // 原图同时留给视觉模型：OCR 读不出题干时直接让模型看图
      const r = await solve(text, structured, ocrText, force, image || '');
      const from = req.socket.remoteAddress || '-';
      console.log(`[answer] ${Date.now() - t0}ms source=${r.source} type=${r.question?.type || '-'}`
        + ` force=${force} from=${from}`);
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

if (process.env.ANSWER_NO_LISTEN !== '1') {
  server.listen(PORT, BIND, () => {
    console.log(`Answer server v2.1 on ${BIND}:${PORT}`);
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