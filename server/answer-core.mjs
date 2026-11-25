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

// 状态栏 / 标题栏 / 系统 toast 的 OCR 碎片。
// 实测一张 1080x2400 截图，RapidOCR 前几行全是这些东西：
//   "3.08"（电量小数）、"9:30"（时间）、"(77"（电量图标）、"KB/s"（网速）、
//   "Exam Mock"（Activity 标题）、"a11y 已连接·Vol+×2弹窗"（叠层底栏）。
// 它们位置在题干上方，会被当成题干的开头拼进去，必须逐条滤掉。
const OCR_UI_NOISE = [
  /^\d{1,2}[:：]\d{2}$/,                       // 9:30
  /^\d{1,2}\.\d{1,2}$/,                        // 3.08
  /^[（(]?\d{1,3}[）)]?$/,                     // (77 / 77 —— 电量、信号
  /^(?:KB|MB|GB)\/s$/i,                        // 网速
  /^\d+(?:\.\d+)?\s*(?:KB|MB|GB)\/s$/i,
  /^(?:5G|4G|3G|LTE|VoLTE|WiFi|WLAN)$/i,       // 网络制式
  /^(?:Exam Mock|答案助手|答案)$/,               // Activity 标题
  /a11y\s*已连接/,                              // 叠层底栏
  /Vol[+＋]?\s*[×x]\s*2/,                       // 叠层提示
  /超级用户权限/,                                // Magisk toast
  /^(?:Shell|su)\s*(?:已|获得)/,
  /^[·．.\-—_=~]{2,}$/,                         // 纯符号
  // 电量/信号图标被 OCR 读成的数字串："l78" "￥578" "￥78" "€78" "l7B"
  // 实测同一道图片题因此生成了 4 个不同 qkey（l78 / ￥578 / ￥78 / 干净版），
  // 缓存命中率被这堆碎片拉低，还会污染题库。
  // 注意 l/I/1/| 是电量图标竖条，不是字母，必须一起算进碎片。
  /^[^\u4e00-\u9fa5A-Za-z]{0,2}[lI|]?\d{1,3}[A-Za-z]?$/,
];

/**
 * 行首的状态栏碎片剥离（不是整行丢弃）。
 *
 * OCR 常把电量/时间粘在题干前面："l78 IP 协议工作在哪一层?"
 * 整行丢会丢掉真题干，所以这里只剥前缀。
 */
const LEADING_UI_CRUMB = /^\s*(?:[^\u4e00-\u9fa5A-Za-z0-9]{0,3}[lI|]?\d{1,3}[A-Za-z]?|\d{1,2}[:：]\d{2})\s+(?=[\u4e00-\u9fa5A-Za-z])/;

/** 该行是不是状态栏/标题栏/toast 噪声（OCR 专用） */
export function isOcrUiNoise(line) {
  const t = String(line || '').trim();
  if (!t) return true;
  if (OCR_NOISE.test(t)) return true;
  for (const re of OCR_UI_NOISE) if (re.test(t)) return true;
  return false;
}

/** 剥掉行首粘住的状态栏碎片（"l78 IP 协议…" → "IP 协议…"） */
export function stripLeadingUiCrumb(line) {
  return String(line || '').replace(LEADING_UI_CRUMB, '');
}

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
  if (isOcrUiNoise(line)) return true;
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

// ─────────────────────────── 题目页判定 ───────────────────────────

/**
 * 考试页界面元素。出现任意一个，说明当前这一屏确实是考试/作业答题页，
 * 题干判据可以放宽（考试页里不可能有"登录""客服"这类页面）。
 */
const EXAM_CHROME_RE = /(交卷|答题卡|上一题|下一题|剩余时间|倒计时|保存[^\n]{0,6}提交|提交试卷|共\s*\d+\s*题)/;

/**
 * 纯界面标签（导航项/按钮/菜单）。这些词在考试页里也可能出现
 * （右上角"设置"、底部"退出登录"），不能因为"当前是考试页"就当题干。
 */
const UI_LABEL_RE = /^(设置|退出登录|关于我们|个人中心|我的|首页|消息|课程|返回|更多|分享|收藏|举报|帮助|客服|反馈|版本|隐私|协议|通知|公告|搜索|筛选|排序|编辑|删除|确认|取消|关闭|完成|提交|保存|上传|下载|刷新|重试|登录|注册)$/;
const QUESTION_HINTS = [
  /[?？]\s*$/,                                                    // 问句
  /(下列|以下|如下|下面)[^\n]{0,16}(哪|什|怎|是否|属于|正确|错误|符合|包括|不属于)/,
  /(关于|对于)[^\n]{0,24}(说法|描述|表述|叙述|理解|解释|判断|概念)[^\n]{0,8}(正确|错误|是|的是|有)/,
  // 题干动词只收「不可能出现在课程名/导航里的」。
  // 裸"计算/分析/比较/说明/解释"会把「计算机网络」「数据分析」这类课程名
  // 误判成题干（实测踩过：首页课程列表里的"计算机网络"命中裸"计算"）。
  /(简述|简答|试述|论述|阐述|名词解释|问答|默写|背诵)/,
  /(计算|分析|比较|说明|解释|判断|求解|证明|推导)(并|下列|以下|下题|该|此|其|：|:)/,
  /(单选题|多选题|判断题|填空题|简答题|不定项)/,
  /[（(]\s*\d+(\.\d+)?\s*分\s*[)）]/,                              // 带分值
  /_{2,}|（\s{2,}）|\(\s{2,}\)/,                                   // 填空空位
  /^\s*第\s*\d{1,3}\s*题/,
];

/**
 * 整屏无选项时，判断「这一屏」像不像一道题。
 *
 * 关键：splitQuestions 在无选项时会把**整屏所有行**用空格拼成一个 stem。
 * 首页/课程列表/课程详情页拼出来有几十个字，长度判据完全失效
 * （实测"首页 消息 课程 我 我的课程 计算机网络…"被判成简答题）。
 *
 * 所以不能看拼接后的总长度，要看**单行**：真正的一道题，题干本身
 * （或题干被拆成的某一行）会命中问句/分值/空位/题干动词；
 * 而导航页的每一行都是 2–6 字的界面标签，一行都不命中。
 *
 * @param {string} stem 拼接后的 stem
 * @param {boolean} examPage 当前屏是否带考试界面元素
 * @returns {boolean}
 */
function stemLooksLikeQuestion(stem, examPage) {
  const s = String(stem || '').trim();
  if (!s) return false;

  // 题干被 a11y 拆成多行、再用空格拼回来，所以按「多字词块」逐段检查
  const segments = s.split(/\s+/).filter((x) => x.length >= 4);
  const probe = segments.length ? segments : [s];

  // 1. 任意一段命中题干特征 → 是题
  //    阈值放到 4 字：中文题干被 a11y 拆行后，"简述TCP特点"这种 7 字段很常见，
  //    用 8 字门槛会把真题漏掉；而导航标签（"计算机网络""课程详情"）虽也 4–6 字，
  //    但一个题干特征都命中不了，靠下面的特征正则排除。
  for (const seg of probe) {
    if (seg.length < 4) continue;
    for (const re of QUESTION_HINTS) if (re.test(seg)) return true;
  }

  // 2. 考试页：有实质内容就算题（考试页不可能出现导航列表）
  if (examPage) {
    // 纯界面标签不算（考试页右上角也有"设置"，底部也有"退出登录"）
    if (UI_LABEL_RE.test(s)) return false;
    const substantive = segments.filter((x) => x.length >= 4).length;
    return substantive > 0 || s.length >= 12;
  }
  return false;
}

/**
 * 这一屏到底是不是一道题（而不是登录页 / 首页 / 课程列表 / 消息页）。
 *
 * 为什么必须判：a11y 会把当前前台应用的**任意**页面都读进来。学习通登录页
 * 清洗后还剩一行「我已阅读并同意学习通《隐私政策》和《用户协议》」，被
 * splitQuestions 当成一道无选项简答题送去模型 —— 白烧一次调用，还把
 * "该内容并非课程题目"这种废话糊到叠层上。首页、课程列表、消息页同理。
 *
 * 判据按可信度从高到低：
 *   1. 有 ≥2 个选项        → 选择题，一定是题
 *   2. 有题型标签          → 题型标签只出现在题目页
 *   3. 页面带考试界面元素  → 考试页，放宽到"有内容就算题"
 *   4. 题干命中问句/分值/空位等特征
 *
 * @param {{stem?:string, options?:Array, typeLabel?:string}} q
 * @param {{examPage?:boolean}} [opts]
 * @returns {boolean}
 */
export function looksLikeQuestion(q, opts = {}) {
  if (!q) return false;
  const stem = String(q.stem || '').trim();
  const options = Array.isArray(q.options) ? q.options : [];

  if (options.length >= 2) return true;
  if (q.typeLabel) return true;
  if (!stem) return false;

  // 逐行/逐段判，不看拼接总长（导航页拼起来也很长）
  return stemLooksLikeQuestion(stem, opts.examPage);
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

  // 题目页判定：不是题就把 questions 清空，让上层走 source=none，
  // 不去调模型、不污染缓存、不在叠层上糊废话。
  const examPage = EXAM_CHROME_RE.test(String(text == null ? '' : text));
  const isQuestion = questions.length > 0 && looksLikeQuestion(questions[0], { examPage });
  const kept = isQuestion ? questions : [];

  return {
    ok: kept.length > 0,
    mode: opts.mode || 'unknown',
    questions: kept,
    primary: kept[0] || null,
    screenHash,
    stableKey: kept.length ? stableKey : '',
    lineCount: lines.length,
    // 诊断用：被判定为非题目时保留候选，方便排查误杀
    rejected: isQuestion ? null : (questions[0] || null),
    examPage,
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

  // 结构化路径同样要判：手机端区域抽取在非题目页也会抽到一行"stem"
  // （比如登录页的协议声明），照旧送模型就白烧额度。
  const examPage = !!s?.examPage;
  const isQuestion = looksLikeQuestion(q, { examPage });
  const kept = isQuestion ? [q] : [];

  return {
    ok: kept.length > 0,
    mode: 'structured',
    questions: kept,
    primary: kept[0] || null,
    screenHash,
    stableKey: kept.length ? stableKey : '',
    lineCount: 1 + options.length,
    rejected: isQuestion ? null : q,
    examPage,
  };
}

// ─────────────────────────── 去重键 ───────────────────────────

/**
 * 归一化题目 → 稳定哈希（题干去标点空白 + 选项排序）
 *
 * 图片题的坑：题干在像素里，a11y 抽不到，`q.stem` 是空串。此时哈希只剩选项，
 * 于是「所有选项相同的图片题」共用一个键 —— 缓存会把 A 题的答案喂给 B 题。
 * 实测两个不同的空 stem 题（4 选项完全相同）哈希完全一致。
 *
 * 所以图片题（stem 归一化后为空）不能进缓存：没有题干就没有去重依据。
 * 返回 null 表示「不可缓存」，调用方（AnswerCache.get/put）必须跳过。
 */
export function normalizeForHash(q) {
  const stem = String(q.stem || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：？！,.;:?!'"''""（）()【】\[\]]/g, '')
    .toLowerCase();
  // 空题干 = 图片题/OCR 失败，没有可去重的语义，禁止入缓存
  if (!stem) return null;
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