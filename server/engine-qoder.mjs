/**
 * engine-qoder.mjs —— 复用 dsh-connect-qoder 插件的上游客户端，把 qoder 网关当答题模型用。
 *
 * 为什么走插件而不是重写协议：cosy 签名（自定义 base64 字母表 + n/3 重排 + RSA 包裹
 * 临时 key + AES-CBC 身份载荷 + md5 五段签名）全在插件里，插件已经用它跑通真实
 * 会话；这里只做「把题目变成 messages，把 SSE 增量拼成字符串」。
 *
 * 需要：插件路径存在 + PAT（环境变量 QODER_PAT_CN 或 ~/.dsh/.qoder-accounts.cn.json）
 *
 * 导出：
 *   qoderAvailable()            -> { ok, reason?, pat?, plugin? }
 *   qoderChat(messages, opts)   -> string（完整回答正文）
 *   qoderModels()               -> [{key, display_name, ...}]
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const PLUGIN_DIR = join(
  homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@dmh2002', 'dsh-connect-qoder',
);
const PLUGIN_LIB = join(PLUGIN_DIR, 'lib', 'host-heartbeat-_xDi4sbQ.js');
const ACCOUNTS_CN = join(homedir(), '.dsh', '.qoder-accounts.cn.json');
const ACCOUNTS_GLOBAL = join(homedir(), '.dsh', '.qoder-accounts.global.json');

let _mod = null;
let _client = null;
let _pat = null;

/** 读 PAT：环境变量优先，其次本地 vault */
function loadPat(region = 'cn') {
  const envName = region === 'cn' ? 'QODER_PAT_CN' : 'QODER_PAT_GLOBAL';
  if (process.env[envName]) return process.env[envName];
  if (process.env.QODER_PAT && region === 'cn') return process.env.QODER_PAT;
  const file = region === 'cn' ? ACCOUNTS_CN : ACCOUNTS_GLOBAL;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const acc = (j.accounts || []).find((a) => a && typeof a.pat === 'string');
    if (acc) return acc.pat;
  } catch { /* ignore */ }
  return null;
}

/** 探活：插件在不在、PAT 有没有 */
export function qoderAvailable(region = 'cn') {
  if (!existsSync(PLUGIN_LIB)) {
    return { ok: false, reason: `插件模块不存在: ${PLUGIN_LIB}` };
  }
  const pat = loadPat(region);
  if (!pat) return { ok: false, reason: `未找到 PAT（${region}）`, plugin: PLUGIN_LIB };
  return { ok: true, pat: pat.slice(0, 10) + '…', plugin: PLUGIN_LIB };
}

async function getClient(region = 'cn') {
  if (_client) return _client;
  if (!_mod) {
    _mod = await import(pathToFileURL(PLUGIN_LIB).href);
  }
  const Cls = _mod.b;
  if (typeof Cls !== 'function') throw new Error('插件未导出 QoderUpstreamClient（b）');
  _pat = loadPat(region);
  if (!_pat) throw new Error('未找到 PAT');
  _client = new Cls(region, {
    logger: (m) => console.log('[qoder] ' + m),
  });
  return _client;
}

/** 模型目录 */
export async function qoderModels(region = 'cn') {
  const c = await getClient(region);
  const models = await c.fetchModels(_pat);
  return models.map(({ key, display_name, enable, max_input_tokens, max_output_tokens }) => ({
    key, display_name, enable, max_input_tokens, max_output_tokens,
  }));
}

/**
 * 把图片数组塞进最后一条 user 消息的 content。
 *
 * 插件的 convertIncomingMessage 只认「OpenAI 形状」的 content 数组：
 *   content: [{type:'text', text}, {type:'image_url', image_url:{url}}]
 * 它会调 extractMessageImages 把 image_url.url 抽出来，再调 userMessage(text, images)
 * 转成 Qoder 网关要的 contents 结构。所以这里只需要构造标准 OpenAI 形状。
 *
 * 注意：不能把图片单独发成一条消息 —— extractMessageImages 只看 role==='user'
 * 的那条，而网关要求同一条消息里既有文字又有图。
 *
 * @param {Array} messages
 * @param {string[]} images data:image/...;base64,... 或 http(s) URL
 * @returns {Array} 新数组（不改原 messages）
 */
function attachImages(messages, images) {
  if (!Array.isArray(images) || images.length === 0) return messages;
  const out = messages.map((m) => ({ ...m }));
  const last = out[out.length - 1];
  if (!last || last.role !== 'user') {
    out.push({ role: 'user', content: '' });
  }
  const target = out[out.length - 1];
  const text = typeof target.content === 'string'
    ? target.content
    : (Array.isArray(target.content)
      ? target.content.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('\n')
      : '');
  target.content = [
    { type: 'text', text },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
  return out;
}

/**
 * 一次性对话（拼 SSE 增量）
 * @param {Array<{role:string, content:string|Array}>} messages
 * @param {{model?:string, signal?:AbortSignal, timeoutMs?:number,
 *          isVl?:boolean, images?:string[], isReasoning?:boolean}} opts
 *   images 非空时自动打开 isVl（视觉通道），除非显式给 isVl:false
 * @returns {Promise<string>}
 */
export async function qoderChat(messages, opts = {}) {
  const region = opts.region || 'cn';
  const client = await getClient(region);
  const modelKey = opts.model || process.env.QODER_MODEL || 'dfmodel';
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const hasImages = Array.isArray(opts.images) && opts.images.length > 0;
  const isVl = opts.isVl ?? hasImages;
  const payload = attachImages(messages, opts.images);

  let buf = '';
  let err = null;

  // 超时必须真的中断请求，不能只设一个变量。
  // 原来只写 err，await chatStream 完全不受影响 —— 请求卡住就永久挂起，
  // 外层 HTTP 也没有超时，手机端断开后这个 Promise 永远挂着、内存不释放。
  // 实测踩到过：一次 58s 才返回（from=-，手机早断开了）。
  const ac = new AbortController();
  const timer = setTimeout(() => {
    err = err || new Error(`qoder 超时 ${timeoutMs}ms`);
    try { ac.abort(err); } catch { /* ignore */ }
  }, timeoutMs);

  // 调用方传进来的 signal 也要接上（HTTP 断开时能及时止损）
  const onOuterAbort = () => {
    err = err || new Error('请求被取消');
    try { ac.abort(err); } catch { /* ignore */ }
  };
  if (opts.signal) {
    if (opts.signal.aborted) onOuterAbort();
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    await client.chatStream(_pat, modelKey, payload, {
      userType: opts.userType || 'personal_standard',
      isVl,
      isReasoning: opts.isReasoning === true,
      // 无思考档：上游用 reasoning_effort 控制思考深度，"off" 表示不思考。
      // 为什么需要它：答题场景只要求「看题 → 选字母」，推理链是纯浪费 ——
      // 真机实测第 7 题走默认思考 13.4s，用户等不起（考试场景每题都这么久
      // 根本没法用）。选择题的正确率也不靠长推理，靠的是见过这个知识点。
      // 只有调用方显式给值才传：不传则沿用上游默认，避免影响别的调用路径。
      ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
      onDelta(delta) {
        if (typeof delta === 'string') { buf += delta; return; }
        if (delta && typeof delta.content === 'string') buf += delta.content;
        else if (delta && typeof delta.text === 'string') buf += delta.text;
      },
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
  }
  if (err) throw err;
  return buf.trim();
}

// ───────── CLI 自检 ─────────
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const avail = qoderAvailable('cn');
  console.log('available:', JSON.stringify(avail));
  if (!avail.ok) process.exit(1);

  const mode = process.argv[2] || 'models';

  if (mode === 'models') {
    const list = await qoderModels('cn');
    console.log(`models(${list.length}):`);
    for (const m of list) console.log(`  ${m.key.padEnd(14)} ${m.display_name}`);
  } else if (mode === 'chat') {
    const q = process.argv[3] || '只回复两个字：收到';
    const t0 = Date.now();
    const out = await qoderChat([{ role: 'user', content: q }]);
    console.log(`${Date.now() - t0}ms -> ${out}`);
  } else if (mode === 'vl') {
    // 视觉通道自检：node --import ./dsh-resolve-register.mjs engine-qoder.mjs vl <图片路径>
    // 不给路径就用内置 1x1 红点，验证 isVl 通道能通（不通会抛 provider_error）。
    const imgPath = process.argv[3];
    const url = imgPath
      ? 'data:image/png;base64,' + readFileSync(imgPath).toString('base64')
      : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
        + 'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const t0 = Date.now();
    const out = await qoderChat(
      [{ role: 'user', content: '这张图里有什么？只回一句话。' }],
      { model: process.env.QODER_MODEL || 'dfmodel', images: [url], timeoutMs: 60_000 },
    );
    console.log(`${Date.now() - t0}ms -> ${out}`);
  }
}