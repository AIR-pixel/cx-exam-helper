/**
 * answer-core.mjs —— a11y 线性文本 → 结构化题目
 *
 * 背景：我们走 AccessibilityService 读节点树，拿到的是「整屏文字线性流」，
 * 里面混着导航栏、按钮、装饰文字。14 号报告指出上游 Zygisk 项目用 WebView
 * DOM 查询（div.singleQuesId.ans-cc-exam）能直接拿到题干/选项/题型/qid，
 * 结构化程度远高于 a11y。我们不能注入 JS（暂不 hook WebView），
 * 所以把它的 4 条清洗正则 + 题型判定语义搬到 PC 端，对 a11y 文本做后处理。
 *
 * 导出：
 *   normalizeLine / cleanLines        装饰行剔除
 *   parseScreen(text)                 整屏文本 → { questions: [...] }
 *   detectType(q)                     题型判定
 *   normalizeForHash(q)               归一化 → 去重键
 *   parseAnswerText(aiText)           AI 原始回复 → 归一化答案 { mode, type, params }
 */

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// ─────────────────────────── 装饰行清洗 ───────────────────────────
// 对应 ai_pipeline.h:61-79 AI_JS_EXTRACT_FMT 的 4 条 filter 正则

const NOISE_RES = [
  /^\d+[.、．]?$/,                                    // 纯题号 "3." "12、"
  /^[（(]\s*\d+(\.\d+)?\s*分\s*[)）]$/,               // 纯分值 "（2分）"
  /^\d+[.、．]\s*[（(]\s*\d+(\.\d+)?\s*分\s*[)）]$/,  // 题号+分值 "3.（2分）"
  /^(单选题|多选题|判断题|填空题|简答题|名词解释|论述题|计算题|分析题|综合题|完形填空|阅读理解|连线题|排序题|听力题|材料题|共用选项题|不定项选择题)\s*[（(]?\s*(共\s*\d+\s*题)?[\s,，、]*\d*\.?\d*\s*分?[)）]?$/,
  /^标记$/,                                           // 学习通收藏图标的无障碍文本
  /^\d+\s*\/\s*\d+$/,                                 // 分页 "3/20"
  /^第\s*\d+\s*题$/,                                  // "第3题"
];

// 学习通各页面的固定 UI 文案（导航/工具栏/按钮），整行命中即丢
const UI_CHROME = new Set([
  '浏览模式', '客服', '登录', '注册', '手机号/超星号', '密码', '忘记密码?', '忘记密码？',
  '我已阅读并同意', '新用户注册', '手机号快捷登录', '其他登录方式', '返回', '提交',
  '保存', '下一题', '上一题', '答题卡', '交卷', '退出', '取消', '确定', '关闭',
  '复制', '粘贴', '全屏', '音量', '字体', '夜间模式', '更多', '搜索', '刷新',
  '倒计时', '剩余时间',
]);

const SEPARATORS = /^[\s\-—–_=*·•|/\\]+$/;

// 倒计时类行带动态数字（"剩余时间 12:34"），UI_CHROME 精确匹配不到。
// 这些行每秒变化，若留在题干里会让 stableKey 跟着变 → 滚动/倒计时误判成换题。
const DYNAMIC_CHROME = /^(剩余时间|倒计时|时间|考试用时)[:：\s]*[\d:：分秒]/;
// OCR 会把状态栏裸时间（"10:35"）和置信度碎片（"0.94"）读进来，也滤掉
const OCR_NOISE = /^\d{1,2}:\d{2}(:\d{2})?$|^\d\.\d{2}$/;

// ── 行首前缀：题号 / 分值 / 题型标签（可连续叠加，如 "3.（2分）单选题"）──
const TYPE_WORDS = '单选题|多选题|判断题|填空题|简答题|名词解释|论述题|计算题|分析题|综合题|完形填空|阅读理解|连线题|排序题|听力题|材料题|共用选项题|不定项选择题';

const PREFIX_RES = [
  // "第3题 " / "第3题:"（要在题号规则前面，否则 "第" 会让题号规则失配）
  /^第\s*\d{1,3}\s*题\s*[:：]?\s*/,
  // 题号 "3." "12、" "7）"（≤3 位；剥离后紧跟数字视为小数，跳过）
  /^\d{1,3}\s*[.、．)）]\s*/,
  // 分值 "（2分）" "(2分)" "（共10题，20分）"
  /^[（(]\s*(?:共\s*\d+\s*题\s*[,，、]?\s*)?\d+(?:\.\d+)?\s*分\s*[)）]\s*/,
  // 题型标签，可带 "(共N题,X分)"
  // 不能无脑剥：像 "多选题和单选题有什么区别" 这种，标签其实是题干正文的开头。
  // 判据：标签后面要么是分隔（空白/行尾/分值括号），要么直接接题干；
  //       但紧跟「和/与/或/及/、/的/等/有/是/比/跟」时说明它在句中，不能剥。
  new RegExp(
    `^(?:${TYPE_WORDS})` +
    `(?:[（(]\\s*(?:共\\s*\\d+\\s*题\\s*[,，、]?\\s*)?\\d*(?:\\.\\d+)?\\s*分?\\s*[)）])?` +
    `(?!\\s*(?:和|与|或|及|、|的|等|有|是|比|跟|区|之|与|对))`,
  ),
];

/**
 * 剥掉行首的题号 / 分值 / 题型标签。
 * "3.（2分）单选题 下列关于…" → "下列关于…"
 * "3.（2分）单选题"            → ""（纯装饰，整行丢）
 * @returns {string}
 */
export function stripPrefix(line) {
  return stripPrefixDetailed(line).line;
}

/** 题型标签抽屉：从被剥离的文本里挑出题型词 */
const TYPE_LABEL_RE = new RegExp(`(${TYPE_WORDS})`);

/**
 * 同 stripPrefix，但额外回报被剥掉的题型标签。
 * 题型词往往就藏在被剥的前缀里（"多选题"整行、或 "3.（2分）多选题 题干"），
 * 剥掉后题干里就没有题型线索了，detectType 会误判成单选。所以要把标签捞出来。
 * @returns {{line:string, typeLabel:string|null}}
 */
export function stripPrefixDetailed(line) {
  let s = String(line || '');
  let typeLabel = null;
  for (let round = 0; round < 5; round++) {
    let changed = false;
    for (const re of PREFIX_RES) {
      const m = re.exec(s);
      if (!m) continue;
      // 题号保护的补丁：剥掉后紧跟数字说明是小数，不是题号
      if (re === PREFIX_RES[1] && /^\d/.test(s.slice(m[0].length))) continue;
      const next = s.slice(m[0].length);
      if (next !== s) {
        // 记录本段被剥内容里出现的题型词（取最后一个＝最贴近题干的）
        const tm = TYPE_LABEL_RE.exec(m[0]);
        if (tm) typeLabel = tm[1];
        s = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { line: s.trim(), typeLabel };
}

/** 归一化单行：全角→半角、压缩空白、去不可见字符 */
export function normalizeLine(line) {
  if (line == null) return '';
  let s = String(line)
    .replace(/\u00a0|\u3000/g, ' ')              // NBSP / 全角空格
    .replace(/[\u200b-\u200f\ufeff]/g, '')       // 零宽
    .replace(/[\r\n\t]+/g, ' ');
  // 全角 ASCII → 半角（！ 到 ～ 区间）
  s = s.replace(/[\uff01-\uff5e]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** 是否是装饰行（应丢弃） */
export function isNoise(line) {
  if (!line) return true;
  if (SEPARATORS.test(line)) return true;
  if (UI_CHROME.has(line)) return true;
  if (DYNAMIC_CHROME.test(line) || OCR_NOISE.test(line)) return true;
  for (const re of NOISE_RES) if (re.test(line)) return true;
  // 整行只是题号/分值/题型标签的叠加 → 装饰
  if (stripPrefix(line) === '') return true;
  return false;
}

/** 整屏文本 → 清洗后的行数组 */
/**
 * 清洗整屏文本。
 * @param {string} text
 * @param {{withTypes?:boolean}} [opts] withTypes=true 时返回 {lines, typeLabels}，
 *   typeLabels 是「行下标 → 题型词」的映射，供 splitQuestions 还原题型。
 * @returns {string[]|{lines:string[], typeLabels:Map<number,string>}}
 */
export function cleanLines(text, opts = {}) {
  const out = [];
  const typeLabels = new Map();
  // 被剥下来的题型标签先挂起，等下一行真正的内容出现时一起带走
  // （"多选题"常常自己单独一行，题干在下一行）
  let pendingType = null;

  for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
    let line = normalizeLine(rawLine);
    if (!line) continue;
    if (UI_CHROME.has(line) || SEPARATORS.test(line) || DYNAMIC_CHROME.test(line) || OCR_NOISE.test(line)) continue;

    // 先剥前缀，再判噪音；纯前缀行剥完为空即丢，但题型标签要留下来
    const stripped = stripPrefixDetailed(line);
    if (stripped.typeLabel) pendingType = stripped.typeLabel;
    line = stripped.line;
    if (!line) continue;
    if (isNoise(line)) continue;
    if (out[out.length - 1] === line) continue;   // 相邻去重（a11y 常重复上报）

    if (pendingType) {
      typeLabels.set(out.length, pendingType);
      pendingType = null;
    }
    out.push(line);
  }
  return opts.withTypes ? { lines: out, typeLabels } : out;
}

// ─────────────────────────── 选项识别 ───────────────────────────

// A. xxx / A、xxx / A) xxx / A．xxx / (A) xxx / A xxx
const OPTION_RE = /^(?:[（(]?([A-H])[)）]?)\s*[.、．)）:：]?\s+(.*\S)\s*$/;
// 更宽松的兜底：字母后直接跟分隔符
const OPTION_LOOSE_RE = /^(?:[（(]?([A-H])[)）]?)\s*[.、．)）:：]\s*(.*)$/;

/**
 * 尝试把一行识别为选项。
 * @returns {{key:string,text:string}|null}
 */
export function matchOption(line) {
  let m = OPTION_LOOSE_RE.exec(line);
  if (!m) m = OPTION_RE.exec(line);
  if (!m) return null;
  const text = (m[2] || '').trim();
  // "A." 后面空 / 只有标点的，不算选项
  if (!text || /^[.、．)）：:]$/.test(text)) return null;
  // 排除"A 和 B 都正确"这类被误切的：正文里还有明显中文标点但很短时保留
  return { key: m[1].toUpperCase(), text };
}

const JUDGE_TRUE = /^(对|正确|是|true|T|√|✓)$/i;
const JUDGE_FALSE = /^(错|错误|否|false|F|×|✗)$/i;

// ─────────────────────────── 题型判定 ───────────────────────────

/**
 * 判定题型：single / multi / judge / blank / short
 * @param {{stem:string, options:Array<{key,text}>}} q
 */
export function detectType(q) {
  const opts = q.options || [];
  const stem = q.stem || '';

  // 0. 被剥离的前缀里带出来的题型标签，最权威
  //    （"多选题"整行被 stripPrefix 吃掉后，题干和选项都没有线索）
  if (q.typeLabel) {
    const L = String(q.typeLabel);
    if (/多选|不定项/.test(L)) return 'multi';
    if (/判断/.test(L)) return 'judge';
    if (/填空/.test(L)) return 'blank';
    if (/简答|名词解释|论述|计算|分析|综合|材料|阅读理解|完形|听力|连线|排序|共用选项/.test(L)) return 'short';
    if (/单选/.test(L)) return 'single';
  }

  // 判断题：选项恰好是对/错两族
  if (opts.length === 2 &&
      opts.every((o) => JUDGE_TRUE.test(o.text) || JUDGE_FALSE.test(o.text))) {
    return 'judge';
  }
  // 题干或选项里显式声明
  if (/\[多选\]|【多选】|多选题|不定项/.test(stem)) return 'multi';
  if (/\[判断\]|【判断】|判断题/.test(stem)) return 'judge';
  if (/\[填空\]|【填空】|填空题/.test(stem)) return 'blank';

  if (opts.length >= 2) {
    // 多选题的经典线索：正确答案不止一个 / 少了某个选项
    if (/\b(多选|下列.*正确的有|以下.*包括|正确的是)/.test(stem) &&
        /有$|包括$|是$/.test(stem.replace(/\s+/g, ''))) {
      // 只在题干带"有/包括"这种复数语义时判多选，仍存疑就交给 single
      return 'multi';
    }
    return 'single';
  }
  // 无选项：看有没有空位
  if (/_{2,}|（\s*）|\(\s*\)|\[填空\]|【填空】/.test(stem)) return 'blank';
  return 'short';
}

/** 填空题空位数 */
export function countBlanks(stem) {
  const s = String(stem || '');
  const marks = s.match(/_{2,}|（\s*）|\(\s*\)/g);
  return marks ? marks.length : (s ? 1 : 0);
}

// ─────────────────────────── 整屏切题 ───────────────────────────

/**
 * 从清洗后的行里切出若干道题。
 * a11y 一屏可能只有一题（学习通考试页），也可能一页多题（作业页）。
 * 策略：以「连续选项块」为锚，题干取其前面最近的若干非装饰行。
 */
function splitQuestions(lines, typeLabels = new Map()) {
  /** 题干区间 [from, to) 内有没有被剥下来的题型标签 */
  const typeLabelIn = (from, to) => {
    for (let k = from; k < to; k++) {
      if (typeLabels.has(k)) return typeLabels.get(k);
    }
    return null;
  };

  const blocks = [];          // {optStart, optEnd}
  let i = 0;
  while (i < lines.length) {
    if (matchOption(lines[i])) {
      const start = i;
      let end = i;
      let expect = lines[i] ? matchOption(lines[i]).key : null;
      while (end + 1 < lines.length) {
        const nxt = matchOption(lines[end + 1]);
        if (!nxt) break;
        end++;
        expect = nxt.key;
      }
      // 至少 2 个选项才当成一道题的选项区（单个 "A." 更可能是正文）
      if (end - start + 1 >= 2) {
        blocks.push({ optStart: start, optEnd: end });
        i = end + 1;
        continue;
      }
    }
    i++;
  }

  const questions = [];
  let prevEnd = -1;
  for (const b of blocks) {
    const options = [];
    for (let k = b.optStart; k <= b.optEnd; k++) {
      const o = matchOption(lines[k]);
      if (o) options.push(o);
    }
    // 题干：上一块之后到本块选项之间的行，倒着取，遇到下一题迹象就停
    const cand = [];
    for (let k = b.optStart - 1; k > prevEnd && k >= 0; k--) {
      const line = lines[k];
      // 已经有句末标点且够长，再往上就是上一题的尾巴了
      if (cand.length > 0) {
        const joined = cand.join('');
        if (joined.length > 300) break;
      }
      cand.unshift(line);
    }
    let stem = cand.join(' ').trim();
    if (!stem) {
      // 没题干只剩选项，也保留（可能题干在别的容器里）
      stem = '';
    }
    const q = { stem, options };
    // 被剥掉的前缀里带的题型标签，优先于文本推断
    const label = typeLabelIn(prevEnd + 1, b.optStart);
    if (label) q.typeLabel = label;
    q.type = detectType(q);
    if (q.type === 'blank') q.blankCount = countBlanks(stem);
    questions.push(q);
    prevEnd = b.optEnd;
  }

  // 没有任何选项块 → 整屏当一道无选项题（填空/简答）
  if (questions.length === 0) {
    const text = lines.join(' ').trim();
    if (text) {
      const q = { stem: text, options: [] };
      const label = typeLabelIn(0, lines.length);
      if (label) q.typeLabel = label;
      q.type = detectType(q);
      if (q.type === 'blank') q.blankCount = countBlanks(text);
      questions.push(q);
    }
  }
  return questions;
}

/**
 * 整屏文本 → 结构化结果
 * @param {string} text a11y 拼出来的整屏文字
 * @param {{mode?:string}} [opts]
 * @returns {{ok:boolean, mode:string, questions:Array, primary:object|null, screenHash:string, stableKey:string}}
 */
export function parseScreen(text, opts = {}) {
  const { lines, typeLabels } = cleanLines(text, { withTypes: true });
  const questions = splitQuestions(lines, typeLabels);
  const screenHash = createHash('sha1')
    .update(lines.join('\n'))
    .digest('hex')
    .slice(0, 16);
  // stableKey：题干+选项的稳定哈希，不受滚动/可见节点变化影响。
  // 手机端用它判断"是不是同一道题"，替代整屏 screenHash。
  const stableKey = questions.length ? normalizeForHash(questions[0]) : '';
  return {
    ok: questions.length > 0,
    mode: opts.mode || 'unknown',
    questions,
    primary: questions[0] || null,
    screenHash,
    stableKey,
    lineCount: lines.length,
  };
}

/**
 * 手机端 a11y 区域抽取结果 → 结构化结果。
 * 题干/选项/题型已在手机端按节点 bounds 分好，这里不再靠整屏文本猜，
 * 只做轻量归一化 + 题型判定 + 计算 stableKey。
 * @param {{stem:string, options:string[], typeLabel:string}} s
 * @returns {object} 与 parseScreen 同形状
 */
export function parseStructured(s) {
  // 剥题号/分值/题型前缀，和整屏路径 cleanLines 保持一致
  const stem = stripPrefix(normalizeLine(s?.stem || ''));
  const rawOpts = Array.isArray(s?.options) ? s.options : [];
  const options = rawOpts.map((o) => {
    const m = String(o).trim().match(/^([A-J])[.、)）]\s*(.*)$/);
    return m ? { key: m[1], text: m[2].trim() } : { key: '', text: String(o).trim() };
  }).filter((o) => o.text);
  const typeLabel = String(s?.typeLabel || '').trim();

  const q = { stem, options };
  if (typeLabel) q.typeLabel = typeLabel;
  q.type = detectType(q);
  if (q.type === 'blank') q.blankCount = countBlanks(stem);

  const screenHash = createHash('sha1').update(stem + '|' + options.map((o) => o.text).join('\n'))
    .digest('hex').slice(0, 16);
  const stableKey = normalizeForHash(q);
  return {
    ok: !!stem || options.length > 0,
    mode: 'structured',
    questions: [q],
    primary: q,
    screenHash,
    stableKey,
    lineCount: 1 + options.length,
  };
}

// ─────────────────────────── 去重键 ───────────────────────────

/** 归一化题目 → 稳定哈希（题干去标点空白 + 选项排序） */
export function normalizeForHash(q) {
  const stem = String(q.stem || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：？！,.;:?!'"''""（）()【】\[\]]/g, '')
    .toLowerCase();
  const opts = (q.options || [])
    .map((o) => String(o.text || '').replace(/[\s\u3000]/g, '').toLowerCase())
    .join('|');
  return createHash('sha256').update(stem + '#' + opts).digest('hex').slice(0, 32);
}

// ─────────────────────────── AI 回复归一化 ───────────────────────────

/** 剥 ```json 围栏 / HTTP 前缀 / 说明文字，抓出第一个 JSON 对象 */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // 去掉 "HTTP=200\n" 之类前缀
  s = s.replace(/^[A-Z]+=\d+\s*/i, '');
  // ```json ... ```
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  // 括号配对抓第一个完整对象
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

/** 字母 "B" / "AC" / "A、C" → 0 基索引数组 */
export function lettersToIndices(s) {
  const letters = String(s || '').toUpperCase().match(/[A-H]/g) || [];
  const seen = new Set();
  const out = [];
  for (const L of letters) {
    const idx = L.charCodeAt(0) - 65;
    if (idx >= 0 && idx < 8 && !seen.has(idx)) { seen.add(idx); out.push(idx); }
  }
  return out.sort((a, b) => a - b);
}

/**
 * AI 原始回复 + 题干 → 归一化作答参数
 * @param {string} aiText
 * @param {object} q 结构化题目
 * @returns {{mode:string, type:string, params:object, raw:string}}
 */
export function parseAnswerText(aiText, q) {
  const raw = String(aiText || '').trim();
  const type = (q && q.type) || 'single';
  const j = extractJson(raw);

  if (j) {
    if (Array.isArray(j.answers)) {
      if (type === 'blank') {
        return { mode: 'json', type, params: { answers: j.answers.map(String) }, raw };
      }
      if (type === 'multi') {
        // ["A","C"] → [0,2]；若是数字则直接用
        const idx = j.answers.map((v) =>
          typeof v === 'number' ? v : (lettersToIndices(String(v))[0] ?? NaN));
        const clean = idx.filter((n) => Number.isInteger(n) && n >= 0);
        return { mode: 'json', type, params: { indicesJson: JSON.stringify(clean) }, raw };
      }
      if (type === 'short') {
        // 简答题返回 answers 数组 → 视为分行段落
        return { mode: 'json', type, params: { text: j.answers.map(String).join('\n') }, raw };
      }
      // 单选/判断落到单选题语义，但要求元素确实是字母
      const idx = j.answers.map((v) =>
        typeof v === 'number' ? v : (lettersToIndices(String(v))[0] ?? NaN));
      const clean = idx.filter((n) => Number.isInteger(n) && n >= 0);
      if (clean.length) return { mode: 'json', type, params: { selectedIndex: clean[0] }, raw };
    }
    if (j.answer != null) {
      // 落到下面按文本处理
      return parseAnswerText(String(j.answer), q);
    }
    if (j.text != null) {
      // {"text":"..."} 是简答/论述题的标准形状
      // 模型有时会把 JSON 再套一层字符串（{"text":"{\"text\":\"…\"}"}），这里递归解套
      let t = String(j.text).trim();
      for (let guard = 0; guard < 3; guard++) {
        const inner = extractJson(t);
        if (inner && typeof inner.text === 'string' && inner.text.trim() !== t) {
          t = inner.text.trim();
          continue;
        }
        break;
      }
      return { mode: 'json', type, params: { text: t }, raw };
    }
    if (j.indices || j.index != null) {
      const idx = Array.isArray(j.indices) ? j.indices : [j.index];
      return {
        mode: 'json',
        type,
        params: type === 'multi'
          ? { indicesJson: JSON.stringify(idx.map(Number)) }
          : { selectedIndex: Number(idx[0]) },
        raw,
      };
    }
  }

  // 纯文本
  if (type === 'single' || type === 'multi' || type === 'judge') {
    const idx = lettersToIndices(raw);
    if (type === 'single' || type === 'judge') {
      return { mode: 'text', type, params: { selectedIndex: idx.length ? idx[0] : 0 }, raw };
    }
    return { mode: 'text', type, params: { indicesJson: JSON.stringify(idx) }, raw };
  }
  if (type === 'blank') {
    // 按 | 或 ; 或 换行 分空
    const parts = raw.split(/\s*[|｜;；\n]\s*/).map((s) => s.trim()).filter(Boolean);
    return { mode: 'text', type, params: { answers: parts.length ? parts : [raw] }, raw };
  }
  return { mode: 'text', type, params: { text: raw }, raw };
}

// ─────────────────────────── 调试用 CLI ───────────────────────────
// node answer-core.mjs < file.txt
const _argv1 = process.argv[1];
const _isMain = typeof _argv1 === 'string'
  && import.meta.url === pathToFileURL(_argv1).href;

if (_isMain) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    const r = parseScreen(text);
    console.log(JSON.stringify(r, null, 2));
    if (r.primary) {
      console.log('--- hash ---');
      console.log(normalizeForHash(r.primary));
    }
  });
}