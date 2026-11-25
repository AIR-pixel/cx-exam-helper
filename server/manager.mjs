/**
 * manager.mjs —— cx-exam-helper PC 端可视化管理后端
 *
 * 职责：
 *   1. 静态托管同目录的 index.html（管理页）
 *   2. 读写 config.json（引擎 / API / DSH 参数，持久化）
 *   3. 启动/停止 answer-server.mjs 子进程，实时收集日志
 *   4. 反向代理 /health /stats /recent /models /parse /answer 到子进程
 *
 * 启动：node server/manager.mjs
 * 默认管理页：http://127.0.0.1:18889
 * 答题服务：http://127.0.0.1:18888（由管理页控制启停）
 *
 * 设计要点：
 *   - 不改 answer-server.mjs 一行业务逻辑；所有参数都通过环境变量传入子进程
 *   - qoder(DSH) 引擎需要 --import ./dsh-resolve-register.mjs，本管理器代劳
 *   - 配置存 config.json，和 manager 同目录，不进 git（见 .gitignore）
 */

import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, 'config.json');
const SERVER_SCRIPT = join(HERE, 'answer-server.mjs');
const RESOLVE_HOOK = './dsh-resolve-register.mjs';
const INDEX_HTML = join(HERE, 'index.html');

const MANAGER_PORT = Number(process.env.MANAGER_PORT || 18889);
const SERVER_PORT = Number(process.env.ANSWER_PORT || 18888);
const NODE_BIN = process.execPath; // 用同一个 node 跑子进程，避免 PATH 找不到

// ─────────────────────────── 配置 ───────────────────────────

/** 默认配置：所有字段都对应 answer-server.mjs 认识的环境变量 */
const DEFAULT_CONFIG = {
  engine: 'auto',           // auto | qoder | openai | heuristic | echo
  port: SERVER_PORT,
  bind: '127.0.0.1',        // 127.0.0.1=仅本机USB；0.0.0.0=接受局域网/Tailscale 无线连接
  // DSH / qoder
  qoderModel: 'dfmodel',
  qoderPat: '',             // 留空 = 用 ~/.dsh/.qoder-accounts.cn.json
  qoderRegion: 'cn',        // cn | global
  timeoutMs: 90000,
  // 图片题视觉兜底：OCR 读不出题干时把原图直接交给视觉模型
  vision: true,             // false = 只走 OCR，不调视觉模型
  vlModel: '',              // 留空 = 用 qoderModel；实测 dfmodel/gmodel_latest/mmodel 都支持看图
  visionMinHan: 8,          // OCR 有效汉字低于这个数就判为「读不出题干」
  visionTimeoutMs: 90000,
  // OpenAI 兼容 API
  openaiBase: '',
  openaiKey: '',
  openaiModel: '',
  // 缓存
  cachePath: './answer-cache.db',
  // 自测
  longTest: false,
};

let config = loadConfig();

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(next) {
  config = { ...config, ...next };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return config;
}

/** 配置 → answer-server 子进程环境变量 */
function buildEnv() {
  const env = { ...process.env };
  env.ANSWER_ENGINE = config.engine;
  env.ANSWER_PORT = String(config.port);
  env.ANSWER_BIND = config.bind || '127.0.0.1';
  env.ANSWER_TIMEOUT_MS = String(config.timeoutMs);
  env.ANSWER_CACHE = config.cachePath || ':memory:';
  if (config.qoderModel) env.QODER_MODEL = config.qoderModel;
  if (config.qoderPat) {
    if (config.qoderRegion === 'global') env.QODER_PAT_GLOBAL = config.qoderPat;
    else { env.QODER_PAT_CN = config.qoderPat; env.QODER_PAT = config.qoderPat; }
  }
  // 视觉兜底：这三项必须显式传，否则子进程只能吃 DEFAULT_CONFIG 里的值，
  // 而 DEFAULT_CONFIG 是 manager 自己的常量，改了不生效。
  env.ANSWER_VISION = config.vision === false ? '0' : '1';
  if (config.vlModel) env.QODER_VL_MODEL = config.vlModel;
  if (config.visionMinHan != null) env.ANSWER_VISION_MIN_HAN = String(config.visionMinHan);
  if (config.visionTimeoutMs) env.ANSWER_VL_TIMEOUT_MS = String(config.visionTimeoutMs);
  if (config.openaiBase) env.OPENAI_BASE = config.openaiBase;
  if (config.openaiKey) env.OPENAI_KEY = config.openaiKey;
  if (config.openaiModel) env.OPENAI_MODEL = config.openaiModel;
  env.LONG_TEST = config.longTest ? '1' : '0';
  return env;
}

// ─────────────────────────── 子进程管理 ───────────────────────────

let child = null;
let logs = [];
let lastClientIp = '';
const MAX_LOGS = 500;

function log(line) {
  const t = new Date().toISOString().slice(11, 19);
  logs.push(`[${t}] ${line}`);
  // 从 answer-server 的 "[answer] ... from=<ip>" 行提取手机来源 IP
  const m = String(line).match(/\[answer\].*from=([^\s]+)/);
  if (m) lastClientIp = m[1];
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
}

function childState() {
  return {
    running: !!child && child.exitCode === null && !child.killed,
    pid: child?.pid || null,
    startedAt: child?._startedAt || null,
    engine: config.engine,
    port: config.port,
  };
}

function startServer() {
  if (child && child.exitCode === null && !child.killed) {
    return { ok: false, error: '答题服务已在运行', ...childState() };
  }
  const env = buildEnv();
  // qoder / auto 引擎需要 resolve hook（ESM 包解析补丁）
  const needsHook = config.engine === 'qoder' || config.engine === 'auto';
  const args = needsHook ? ['--import', RESOLVE_HOOK, SERVER_SCRIPT] : [SERVER_SCRIPT];

  logs = [];
  log(`启动: ${NODE_BIN} ${args.join(' ')}`);
  log(`引擎=${config.engine} 端口=${config.port} 缓存=${config.cachePath}`);

  const proc = spawn(NODE_BIN, args, {
    cwd: HERE,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc._startedAt = new Date().toISOString();
  child = proc;

  proc.stdout.on('data', (b) => String(b).split(/\r?\n/).filter(Boolean).forEach(log));
  proc.stderr.on('data', (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => log('ERR ' + l)));
  proc.on('exit', (code, sig) => {
    log(`进程退出 pid=${proc.pid} code=${code} sig=${sig || '-'}`);
    // 关键：旧进程的 exit 是异步事件，可能在新进程已经赋值给 child 之后才到。
    // 只有退出的正是「当前 child」才清空，否则会把新进程误杀成 null。
    if (child === proc) child = null;
  });
  proc.on('error', (e) => log(`进程错误: ${e.message}`));

  return { ok: true, ...childState() };
}

function stopServer() {
  if (!child || child.exitCode !== null || child.killed) {
    return { ok: false, error: '答题服务未运行' };
  }
  const pid = child.pid;
  log(`停止: kill pid=${pid}`);
  child.kill('SIGTERM');
  child = null;
  return { ok: true, pid };
}

// ─────────────────────────── HTTP ───────────────────────────

function send(res, obj, code = 200, type = 'application/json; charset=utf-8') {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

/** 把管理页的请求原样转发到答题子进程（带 query） */
function proxy(req, res, pathname, search) {
  if (!child || child.exitCode !== null || child.killed) {
    return send(res, { error: '答题服务未运行' }, 503);
  }
  const target = `http://127.0.0.1:${config.port}${pathname}${search || ''}`;
  const opts = {
    method: req.method,
    headers: { 'content-type': 'application/json' },
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // body 由调用方透传：这里直接 pipe
    const upstream = http.request(target, opts, (up) => {
      res.writeHead(up.statusCode || 502, { 'Content-Type': up.headers['content-type'] || 'application/json; charset=utf-8' });
      up.pipe(res);
    });
    upstream.on('error', (e) => send(res, { error: '代理失败: ' + e.message }, 502));
    req.pipe(upstream);
    return;
  }
  const upstream = http.get(target, opts, (up) => {
    let data = '';
    up.on('data', (c) => data += c);
    up.on('end', () => {
      res.writeHead(up.statusCode || 502, { 'Content-Type': up.headers['content-type'] || 'application/json; charset=utf-8' });
      res.end(data);
    });
  });
  upstream.on('error', (e) => send(res, { error: '代理失败: ' + e.message }, 502));
}

const PROXY_PATHS = new Set(['/health', '/stats', '/recent', '/models', '/parse', '/answer', '/cache/clear']);

const manager = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${MANAGER_PORT}`);

  try {
    // 静态页
    if (u.pathname === '/' || u.pathname === '/index.html') {
      if (!existsSync(INDEX_HTML)) return send(res, 'index.html 不存在', 404, 'text/plain; charset=utf-8');
      return send(res, readFileSync(INDEX_HTML, 'utf8'), 200, 'text/html; charset=utf-8');
    }

    // 状态
    if (u.pathname === '/api/status') {
      return send(res, { ...childState(), logs: logs.slice(-80), config: publicConfig() });
    }

    // 本机网络地址：管理页据此告诉用户"手机端该填哪个 IP"
    if (u.pathname === '/api/network') {
      const addrs = [];
      const ifs = os.networkInterfaces();
      for (const [name, list] of Object.entries(ifs)) {
        for (const a of list || []) {
          if (a.family === 'IPv4' && !a.internal) {
            addrs.push({ ip: a.address, iface: name,
              // Tailscale 网卡通常是 100.x / utun / Tailscale
              kind: /^100\./.test(a.address) || /tailscale|utun/i.test(name) ? 'tailscale' : 'lan' });
          }
        }
      }
      // 最近一次 /answer 的来源 IP（手机是否连上的证据）
      const lastClient = lastClientIp;
      return send(res, { addrs, port: config.port, bind: config.bind, lastClient });
    }

    // 配置读（脱敏）
    if (u.pathname === '/api/config' && req.method === 'GET') {
      return send(res, publicConfig());
    }

    // 配置写
    if (u.pathname === '/api/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const wasRunning = childState().running;
      if (wasRunning) stopServer();
      const saved = saveConfig(body);
      return send(res, { ok: true, config: publicConfig(), restarted: wasRunning ? startServer() : null });
    }

    // 启停
    if (u.pathname === '/api/start' && req.method === 'POST') return send(res, startServer());
    if (u.pathname === '/api/stop' && req.method === 'POST') return send(res, stopServer());

    // 日志
    if (u.pathname === '/api/logs') return send(res, { logs });

    // 代理到答题服务
    if (PROXY_PATHS.has(u.pathname)) return proxy(req, res, u.pathname, u.search);

    send(res, { error: 'not found' }, 404);
  } catch (e) {
    send(res, { error: e.message }, 500);
  }
});

/** 对外返回的配置：key 类字段只显示是否已设置，不回传明文 */
function publicConfig() {
  return {
    ...config,
    qoderPat: config.qoderPat ? '••••••••（已设置）' : '',
    openaiKey: config.openaiKey ? '••••••••（已设置）' : '',
    _hasQoderPat: !!config.qoderPat,
    _hasOpenaiKey: !!config.openaiKey,
  };
}

manager.listen(MANAGER_PORT, '127.0.0.1', () => {
  console.log(`cx-exam-helper 管理页: http://127.0.0.1:${MANAGER_PORT}`);
  console.log(`答题服务由页面控制启停（默认端口 ${SERVER_PORT}）`);
  console.log(`配置文件: ${CONFIG_PATH}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    process.exit(0);
  });
}
