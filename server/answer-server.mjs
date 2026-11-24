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
    return idx.map((i) => {
      const L = String.fromCharCode(65 + i);
      const t = opts[i] ? ` ${opts[i].text}` : '';
      return L + t;
    }).join(' ; ') || '';
  }
  if (p.selectedIndex != null) {
    const i = Number(p.selectedIndex);
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
 * 图片题兜底：把手机传来的 base64 截图交给 Python OCR 服务识别成文字。
 * @returns {Promise<string>} 识别出的整屏文字；失败返回空串
 */
async function ocrImage(base64) {
  if (!OCR_URL || !base64) return '';
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
 */
async function solve(text, preStructured, ocrText = '') {
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
    // 非题目页（登录页/首页/课程列表/消息页）：不调模型、不入缓存、不糊叠层。
    // 手机端收到 source=none 会显示"未识别到题目"并保持上一题答案不变。
    const r = structured.rejected;
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
  try {
    raw = await engine(q);
  } catch (e) {
    console.error(`[engine] ${engineMode} failed: ${e.message}`);
    return { answer: '引擎错误: ' + e.message, source: 'error', question: q, structured };
  }

  // 3. 归一化
  const normalized = parseAnswerText(raw, q);
  const rendered = renderAnswer(normalized, q);

  // 4. 回写缓存
  if (cache && normalized.type !== 'short') {
    cache.put(q, normalized, (engineMode === 'openai' || engineMode === 'qoder') ? 'ai' : engineMode);
  }

  console.log(`[${engineMode}] ${q.type} q="${String(q.stem).slice(0, 40)}" raw="${raw.slice(0, 60)}" => ${rendered}`);
  return { answer: rendered, source: engineMode, question: q, structured, normalized };
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
      try {
        const j = JSON.parse(body);
        text = j.question || '';
        image = j.image || '';
        structured = j.structured || null;
      } catch { text = body; }
      const t0 = Date.now();
      // 图片题兜底：a11y 没读到题干但手机传了截图 → OCR 补文字
      let ocrText = '';
      if (image) {
        ocrText = await ocrImage(image);
        if (ocrText) text = text ? text + '\n' + ocrText : ocrText;
      }
      const r = await solve(text, structured, ocrText);
      const from = req.socket.remoteAddress || '-';
      console.log(`[answer] ${Date.now() - t0}ms source=${r.source} type=${r.question?.type || '-'} from=${from}`);
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

server.listen(PORT, BIND, () => {
  console.log(`Answer server v2.1 on ${BIND}:${PORT}`);
  console.log(`  engine = ${engineMode}${engineReq !== engineMode ? ` (requested ${engineReq})` : ''}`);
  console.log(`  cache  = ${cache ? cache.path : 'disabled'}`);
});

// 优雅退出，保证 sqlite 句柄释放
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[${sig}] shutting down`);
    try { server.close(); } catch { /* ignore */ }
    try { cache?.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}