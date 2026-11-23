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
 * 一次性对话（拼 SSE 增量）
 * @param {Array<{role:string, content:string}>} messages
 * @param {{model?:string, signal?:AbortSignal, timeoutMs?:number}} opts
 * @returns {Promise<string>}
 */
export async function qoderChat(messages, opts = {}) {
  const region = opts.region || 'cn';
  const client = await getClient(region);
  const modelKey = opts.model || process.env.QODER_MODEL || 'dfmodel';
  const timeoutMs = opts.timeoutMs ?? 90_000;

  let buf = '';
  let err = null;

  const timer = setTimeout(() => { err = err || new Error(`qoder 超时 ${timeoutMs}ms`); }, timeoutMs);

  try {
    await client.chatStream(_pat, modelKey, messages, {
      userType: opts.userType || 'personal_standard',
      isVl: false,
      isReasoning: false,
      onDelta(delta) {
        if (typeof delta === 'string') { buf += delta; return; }
        if (delta && typeof delta.content === 'string') buf += delta.content;
        else if (delta && typeof delta.text === 'string') buf += delta.text;
      },
      signal: opts.signal,
    });
  } finally {
    clearTimeout(timer);
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
  }
}